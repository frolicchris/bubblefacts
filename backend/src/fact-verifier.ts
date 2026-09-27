import { config } from "./config";
import { SSLSong } from "./types";
import { topic } from "./topic";

/**
 * Fact grounding + screening.
 *
 * The overlay's accuracy problem is that a small local model writes video
 * game trivia from memory and invents composers, years and hardware. The
 * fix is to stop asking it to recall anything:
 *
 *   1. GROUNDING  — pull real reference text about the game (and especially
 *                   its music) from Wikipedia, so the generation step is a
 *                   restatement task rather than a recall task.
 *   2. SCREENING  — deterministic rejection of claims the reference does not
 *                   visibly support. Every check here is a string comparison
 *                   against the reference: no model, no latency, no second
 *                   opinion that can itself be wrong.
 *
 * There is deliberately no LLM verification pass. Asking the same 3B model
 * to grade its own output added latency, dropped song-specific facts on a
 * coin flip, and pushed the overlay toward generic filler. Accuracy is now
 * the prompt's job (be explicit enough that there is nothing to check) and
 * this module's job (check the things a regex can actually check).
 *
 * When grounding finds nothing the model is NOT asked to free-associate
 * instead, because nothing could check that output. The fallbacks, in order:
 * facts built from the song list entry itself (play counts, the streamer's
 * own note, requesters — see stat-facts.ts), then CURATED_FACTS. Both are
 * true by construction. A partial grounded result is never padded.
 *
 * The repertoire spans video game music, film and musical soundtracks,
 * classical, pop, and the streamer's own compositions — so nothing here may
 * assume a game. Originals skip grounding entirely: they have no article and
 * searching for them lands on whatever is vaguely similar.
 */

// --- Layer 1: grounding ------------------------------------------------

const WIKI_SEARCH = "https://en.wikipedia.org/w/api.php";
const MAX_CONTEXT_CHARS = 2400;
/**
 * Shortest extract worth treating as a reference.
 *
 * The old floor of 80 characters let stubs through, and a stub is worse than
 * nothing: "Song of Storms" grounded on a 247-character article about the
 * 2026 Ocarina REMAKE and the overlay announced an "upcoming" game
 * "scheduled for release on November 5, 2026" under a 1998 track, while four
 * of seven lines were dropped as near-duplicates because there was nothing
 * else to say. "K.K. Bossa" grounded on a 191-character page about a studio
 * called Bossa Games. Falling through to the song entry's own play counts is
 * strictly better than restating a stub.
 */
const MIN_CONTEXT_CHARS = 600;
// Wikimedia asks API clients to identify themselves and to contact them
// rather than hammer anonymously; a descriptive agent also gets a more
// forgiving rate-limit bucket. Note the requests deliberately do NOT pass
// `origin=*` — that is a browser-CORS parameter, useless from Node, and it
// drops the caller into the strictest anonymous bucket.
// Wikimedia asks for a contact in the UA. Set WIKIPEDIA_CONTACT to your
// channel or repo URL so they can reach you if something misbehaves.
const USER_AGENT = `stream-facts-overlay/1.0 (${process.env.WIKIPEDIA_CONTACT || "https://github.com/frolicchris/stream-facts-overlay"}; OBS overlay) node-fetch`;

/**
 * Grounding results keyed by game, so a stream working through six tracks
 * from one soundtrack does one lookup instead of six. The per-song fact cache
 * upstream does not help there — different tracks, same game.
 *
 * Entries carry a timestamp because NEGATIVE entries must expire. A negative
 * with no TTL is an absorbing state: over a four-hour stream the number of
 * songs that reach the model can only fall, never recover.
 */
interface GroundingEntry {
  text: string;
  at: number;
}
const groundingCache = new Map<string, GroundingEntry>();

/**
 * How long to trust "this game has no article". Long enough to spare a
 * soundtrack repeated lookups, short enough that a bad minute does not
 * silence the rest of the set.
 */
const NEGATIVE_TTL_MS = 10 * 60 * 1000;

/** Distinguishes "Wikipedia throttled us" from "this game has no article". */
class RateLimited extends Error {}

/**
 * Any other reason the lookup could not complete: timeout, DNS, TLS, 5xx.
 *
 * This distinction is the difference between "we asked and there is nothing"
 * and "we never got to ask". Only the former may be cached. Conflating them
 * is how a single network blip took an entire soundtrack off the air for a
 * whole broadcast, while logging a line that read like correct behaviour.
 */
class LookupFailed extends Error {}

/**
 * Split a queue title into the game and the track.
 *
 * StreamerSongList entries for video game music are overwhelmingly written
 * as "Game: Track", "Game - Track", or "Track (Game)". Getting the game out
 * matters twice over: Wikipedia has an article for the game and almost never
 * for an individual track, and the generation prompt is far more accurate
 * when it can name the game explicitly instead of echoing a raw title.
 */
const VARIANT_MARKER =
  /^\s*(arr\b|arrange|arranged|arrangement|remix|cover|live|acoustic|piano|ost|medley|reprise|reprise|vocal|instrumental|version|ver\b|act\s*\d|day|night|part\s*\d|\d{4}|remaster)/i;

export function splitGameAndTrack(title: string): { game: string; track: string } {
  const clean = title.trim();

  const parenthetical = clean.match(/^(.+?)\s*[([]([^)\]]{2,})[)\]]\s*$/);
  // "One-Winged Angel (Final Fantasy VII)" names the game. But a trailing
  // parenthetical is far more often an ARRANGEMENT or variant marker —
  // "(Arr Arcana Shift)", "(Act 1)", "(Day)" — and treating that as the game
  // sent every Ys VIII arrangement to the bare "Ys (series)" article.
  if (parenthetical && !VARIANT_MARKER.test(parenthetical[2])) {
    return { game: parenthetical[2].trim(), track: parenthetical[1].trim() };
  }

  const separated = clean.match(/^(.+?)\s*(?::|\s[-–—]\s)\s*(.+)$/);
  if (separated) {
    return { game: separated[1].trim(), track: separated[2].trim() };
  }

  // No separator — the whole title is the best guess at both.
  return { game: clean, track: clean };
}

/**
 * Work out which game is being played and which track.
 *
 * Many song lists put the **game in the artist field** and the track
 * in the title — the opposite of how the field names read. That is the
 * authoritative signal when it's there, and getting it wrong is expensive:
 * searching Wikipedia for a bare track name like "Sunshine Coastline" finds
 * nothing, so the song silently falls through to generic facts.
 *
 * Entries typed as "Game: Track" in the title alone are still handled, as a
 * fallback, by splitGameAndTrack.
 */
export function resolveGameAndTrack(song: SSLSong): { game: string; track: string } {
  const artist = song.artist?.trim();
  const title = song.title.trim();

  if (artist && !/^unknown$/i.test(artist) && artist.toLowerCase() !== title.toLowerCase()) {
    // The artist field often names only the SERIES ("Super Mario") while the
    // title names the actual game ("Super Mario 64: Dire Dire Docks"). When
    // the title's game part extends the artist, it is strictly more specific
    // — using the bare series grounded a Super Mario 64 track on the Super
    // Mario Galaxy soundtrack. When it merely repeats the artist
    // ("Billy Joel: Piano Man"), keep the artist and take the clean track.
    const split = splitGameAndTrack(title);
    if (split.game !== title) {
      const a = artist.toLowerCase();
      const g = split.game.toLowerCase();
      if (g === a) return { game: artist, track: split.track };
      if (g.startsWith(a + " ")) return { game: split.game, track: split.track };
    }
    return { game: artist, track: title };
  }
  return splitGameAndTrack(title);
}

/**
 * Search terms, ordered most-likely-to-land-on-the-right-article first.
 *
 * The repertoire is not only video game music: pop songs, film and musical
 * soundtracks, classical repertoire, and the streamer's own compositions all appear.
 * Each needs a different framing to find its article — "Clair de Lune video
 * game" finds nothing useful — so the qualifiers are tried in the order that
 * matches the likeliest work type, then the bare subject as a catch-all.
 *
 * Bare-subject search is what actually covers classical and pop: Wikipedia
 * has "Clair de Lune" and "Bohemian Rhapsody" under their own names.
 */
function searchTerms(song: SSLSong): string[] {
  const { game: subject, track } = resolveGameAndTrack(song);
  const terms: string[] = [];

  const trackTerms: string[] = [];
  if (track && track !== subject) {
    trackTerms.push(`${track} ${subject}`.trim());
    trackTerms.push(track);
  }

  const subjectTerms: string[] = [];
  if (subject) {
    // "<subject> video game" is a strong hint for game music and actively
    // harmful otherwise: searching "Queen video game" returns
    // "Long Live the Queen (video game)" for a Queen song. Only ask that
    // question when the subject isn't obviously a person or band.
    if (!looksLikeArtistName(subject)) {
      subjectTerms.push(`${subject} video game`);
    }
    subjectTerms.push(`${subject} soundtrack`);
    subjectTerms.push(subject);
  }

  // For pop and classical the track is the thing with its own article and
  // the subject is a person, so lead with the track. For game music the
  // work is the subject, and the track name alone rarely has an article.
  if (looksLikeArtistName(subject)) {
    terms.push(...trackTerms, ...subjectTerms);
  } else {
    terms.push(...subjectTerms, ...trackTerms);
  }

  return [...new Set(terms.filter(Boolean))];
}


/** Lowercase, drop a trailing "(video game)"-style qualifier and punctuation. */
function normalizeTitle(s: string): string {
  return s
    .replace(/\s*\([^)]*\)\s*$/, "")
    .toLowerCase()
    // Unicode-aware: an ASCII-only class empties a fully CJK/Hangul/Cyrillic
    // title, which then fails to match even a character-perfect article.
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOPWORDS = new Set(["the", "and", "of", "a", "an", "in", "on", "for", "to"]);

/**
 * Parenthetical qualifiers that mean "this article is about a piece of music
 * or the work it comes from".
 *
 * Wikipedia uses these to disambiguate exactly the collisions that matter:
 * "Journey (2012 video game)" vs "Journey (band)", "Braid (video game)" vs
 * "Braid (hairstyle)". The repertoire spans games, film and musical
 * soundtracks, pop songs and classical works, so the list has to cover all of
 * them — restricting it to game-only qualifiers would reject
 * "Clair de Lune (Debussy)" and "Yesterday (Beatles song)".
 *
 * A performer qualifier like "(band)" is deliberately NOT here: it is what
 * distinguishes the rock band Journey from the game, and a fact about a band
 * when the streamer is playing the game's theme is the wrong-work failure.
 * It is admitted only when the subject genuinely looks like an artist —
 * see `isRelevantArticle`.
 */
const MUSICAL_QUALIFIER =
  /video game|game\b|series|soundtrack|album|franchise|film|score|song|single|composition|opera|ballet|suite|sonata|symphony|concerto|musical|anime|television|tv series|novel/i;

/**
 * Qualifiers for people and groups. Legitimate when the thing we searched for
 * IS a person or band (classical composer, pop artist), wrong when we were
 * looking for a work.
 */
const PERFORMER_QUALIFIER = /band|singer|musician|composer|pianist|rapper|duo|group|orchestra/i;

/**
 * Does the page's parenthetical attribute the work to someone OTHER than the
 * subject we searched for?
 *
 * Titles collide across genres far more than they collide within one:
 * "Clair de Lune (Flight Facilities song)" is a 2012 electronic track whose
 * name matches Debussy's exactly. Matching on the track alone accepted it,
 * and the model then wrote five faithful facts about the wrong piece.
 *
 * Wikipedia's convention is the tell: when a disambiguator names an artist
 * ("(Flight Facilities song)", "(Beatles song)", "(Debussy)"), that artist
 * should overlap the subject we were looking for.
 */
export function qualifierNamesAnotherArtist(pageTitle: string, subject: string): boolean {
  const qualifier = /\(([^)]*)\)\s*$/.exec(pageTitle)?.[1];
  if (!qualifier) return false;

  // Bare category qualifiers name nobody: "(video game)", "(song)".
  const words = qualifier
    .split(/\s+/)
    .filter((w) => !/^(song|single|album|soundtrack|composition|video|game|series|film|instrumental|suite)$/i.test(w));
  if (words.length === 0) return false;

  const subjectTokens = new Set(normalizeTitle(subject).split(" ").filter(Boolean));
  if (subjectTokens.size === 0) return false;

  // Something artist-like is named — require it to overlap the subject.
  const qualifierTokens = normalizeTitle(words.join(" ")).split(" ").filter(Boolean);
  if (qualifierTokens.length === 0) return false;

  return !qualifierTokens.some((t) => subjectTokens.has(t));
}

/** Well-known composers and artists whose own article is the right reference. */
const KNOWN_ARTIST_HINT =
  /\b(beethoven|mozart|bach|chopin|debussy|liszt|ravel|satie|tchaikovsky|schubert|brahms|rachmaninoff|beatles|queen|abba|elton john|billy joel|radiohead|coldplay|adele|taylor swift|joe hisaishi|ryuichi sakamoto|hans zimmer|john williams|ennio morricone|yiruma|ludovico einaudi)\b/i;

/**
 * Does the subject look like a person or band rather than a work?
 *
 * Used to decide whether a "(band)" / "(composer)" article is the right
 * answer or the wrong-work trap. A song list entry for classical or pop
 * frequently puts the composer or artist where a game title would go, and
 * for those the artist's own article is a legitimate reference.
 */
export function looksLikeArtistName(subject: string): boolean {
  if (!subject) return false;
  if (KNOWN_ARTIST_HINT.test(subject)) return true;
  // "Firstname Lastname" with no work-ish words in it.
  return (
    /^[A-Z][a-z'’-]+(?:\s+[A-Z][a-z'’-]+){1,2}$/.test(subject.trim()) &&
    !/\b(the|of|and|a|an)\b/i.test(subject)
  );
}

const ROMAN_TO_ARABIC: Record<string, string> = {
  i: "1", ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8",
  ix: "9", x: "10", xi: "11", xii: "12", xiii: "13", xiv: "14", xv: "15",
};

/**
 * Installment numbers are the ONLY thing distinguishing most sequels, and
 * they are exactly what a naive token filter throws away for being short.
 * Normalising roman to arabic also makes "Final Fantasy VI" and
 * "Final Fantasy 6" comparable.
 */
function normalizeToken(t: string): string {
  return ROMAN_TO_ARABIC[t] ?? t;
}

/** Tokens that actually carry identity: content words plus every numeral. */
function significantTokens(s: string): string[] {
  const words = s.split(" ").filter((t) => t.length > 0 && !STOPWORDS.has(t));
  // Two characters is the floor, not three. "Ys" is a whole series and core
  // repertoire here, and a >2 filter dropped it entirely — not just when it
  // stood alone, but whenever the title had any other qualifying token, so
  // "Ys" could not even match "Ys I". Every Ys track in a live set missed
  // grounding because of this. One-character tokens still need to be a
  // numeral or a roman numeral to count.
  const significant = words.filter(
    (t) => t.length >= 2 || /\d/.test(t) || t in ROMAN_TO_ARABIC
  );

  // Last-resort fallback for a title that is all stopwords or punctuation.
  return (significant.length > 0 ? significant : words).map(normalizeToken);
}

/**
 * Words that mark a DIFFERENT kind of work built on the same name.
 * "Super Mario" legitimately prefixes "The Super Mario Galaxy Movie", but
 * the film's soundtrack article is not a reference for a Super Mario 64
 * track.
 */
const MEDIUM_SHIFT = /\b(movie|film|musical|discography|anime|manga|novel|list|awards|tour|concert)\b/i;

/**
 * Is this article actually about the game we searched for?
 *
 * Wikipedia's search API returns a best fuzzy match and never "no result", so
 * a song with no article does not fail — it silently resolves to whatever is
 * vaguely similar. Searching for an original song by the streamer
 * returned "The Last of Us season 1", and the model then wrote five perfectly
 * faithful facts about the wrong work. Screening cannot catch that: the facts
 * do match the reference. The reference is the thing that's wrong, so it has
 * to be rejected here.
 */
export function isRelevantArticle(
  subject: string,
  pageTitle: string,
  subjectLooksLikeArtist = false
): boolean {
  const want = normalizeTitle(subject);
  const got = normalizeTitle(pageTitle);
  if (!want || !got) return false;

  const wantTokens = significantTokens(want);
  const gotTokens = significantTokens(got);
  if (wantTokens.length === 0 || gotTokens.length === 0) return false;

  // A parenthetical is Wikipedia disambiguating for us. Stripping it (as an
  // earlier version did) throws away the single most reliable signal and lets
  // "Journey (band)" and "Braid (hairstyle)" through.
  const qualifier = /\(([^)]*)\)\s*$/.exec(pageTitle)?.[1];
  // "The Legend of Zelda: Ocarina of Time (2026 video game)" is the remake,
  // not the game whose track is being played. A work dated in the future
  // cannot be the reference for music on air today.
  const qualYear = qualifier && /\b(20\d{2})\b/.exec(qualifier)?.[1];
  if (qualYear && Number(qualYear) > new Date().getFullYear()) return false;
  if (qualifier) {
    // A performer article is the right answer only when we were looking for
    // a performer — a classical composer or a band. Otherwise "Journey
    // (band)" is precisely the wrong-work trap.
    const isPerformerQualifier = PERFORMER_QUALIFIER.test(qualifier);
    const performerOk = isPerformerQualifier && subjectLooksLikeArtist;

    // Wikipedia's own convention does most of the work here: common-noun
    // disambiguators are lowercase ("(video game)", "(band)", "(hairstyle)")
    // while proper-noun ones are capitalised — and for classical repertoire
    // the proper noun is the composer, as in "Clair de Lune (Debussy)".
    // So a capitalised qualifier is treated as an attribution rather than a
    // category, which is what lets classical works ground at all.
    const properNoun = /^[A-Z]/.test(qualifier.trim()) && !isPerformerQualifier;

    if (!MUSICAL_QUALIFIER.test(qualifier) && !performerOk && !properNoun) return false;
  }

  // Installment numbers decide sequels. If both titles carry one and they
  // disagree, this is a franchise sibling — the failure mode that produces
  // perfectly faithful facts about the wrong game.
  const wantNums = wantTokens.filter((t) => /^\d+$/.test(t));
  const gotNums = gotTokens.filter((t) => /^\d+$/.test(t));
  if (wantNums.length > 0 && gotNums.length > 0) {
    if (!wantNums.some((n) => gotNums.includes(n))) return false;
  }

  // Compare token SEQUENCES, not raw substrings: "ys" is a substring of
  // "system shock", but not a leading token of it.
  const wantSeq = wantTokens.join(" ");
  const gotSeq = gotTokens.join(" ");

  // A subject that carries an installment number must not match an article
  // without one. "Final Fantasy" is a prefix of "Final Fantasy X", so the
  // prefix rule alone accepted the FF1 article for an FFX track — the
  // franchise-sibling failure again, in parent/child form rather than
  // sibling/sibling. Same for "Marvel vs Capcom 2" -> "Marvel vs. Capcom".
  // The reverse (series subject -> numbered installment) stays allowed:
  // "Animal Crossing" -> "Animal Crossing: New Leaf" is a fair reference.
  if (wantNums.length > 0 && gotNums.length === 0) return false;

  // "Celeste" -> "Celeste (video game)", "Ys VIII" -> "Ys VIII: Lacrimosa…"
  // A genuine opening of the longer title, on a token boundary. Only in the
  // direction where the ARTICLE extends the SUBJECT — the other direction is
  // how an installment gets dropped.
  if (gotSeq.startsWith(wantSeq + " ")) {
    // ...unless what it adds changes the medium. "Super Mario" prefixes
    // "The Super Mario Galaxy Movie (soundtrack)", which is a different work.
    if (MEDIUM_SHIFT.test(got) && !MEDIUM_SHIFT.test(want)) return false;
    return true;
  }
  if (wantSeq.startsWith(gotSeq + " ")) {
    // The article is a truncation of the subject. Safe only when nothing
    // identifying was lost — no numerals on either side.
    return wantNums.every((n) => gotNums.includes(n));
  }

  // Length guard. Without it, "want" being a mere SUBSET of "got" was enough,
  // and Wikipedia is full of titles that embed a name inside something else:
  //   Queen           -> "Long Live the Queen (video game)"
  //   Claude Debussy  -> "The Seduction of Claude Debussy"   (an album)
  //   Frédéric Chopin -> "Heart of Frédéric Chopin"          (the organ)
  //   Aurora Drift    -> "SY Aurora's drift"                 (a ship)
  // Every one of those shares all of the subject's tokens while being about
  // something else entirely. Count raw tokens, not significant ones, so the
  // filler words that pad these titles still register.
  const rawWant = want.split(" ").filter(Boolean);
  const rawGot = got.split(" ").filter(Boolean);
  if (rawGot.length > rawWant.length + 1) return false;

  if (gotSeq === wantSeq) return true;

  // Otherwise demand near-complete overlap. The old 0.5 threshold meant one
  // shared token sufficed for any two-token title, which is how
  // "Chrono Trigger" matched "Chrono Cross".
  const gotSet = new Set(gotTokens);
  const shared = wantTokens.filter((t) => gotSet.has(t)).length;
  const ratio = shared / wantTokens.length;
  return wantTokens.length >= 3 ? ratio >= 0.85 : ratio >= 1;
}

/**
 * Search, then return the first hit that is actually about the game.
 *
 * Taking only the top hit made a single rejection terminal for the whole
 * term: Wikipedia frequently ranks a franchise overview or a "List of…"
 * page above the specific game, and the real article sits at position two
 * or three. Asking for five costs the same round trip and the same
 * rate-limit budget.
 */
async function wikiSearchBest(term: string, accept: (title: string) => boolean): Promise<string | null> {
  const url =
    `${WIKI_SEARCH}?action=query&list=search&srsearch=${encodeURIComponent(term)}` +
    `&srlimit=5&format=json`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(config.groundingTimeoutMs),
    headers: { "User-Agent": USER_AGENT },
  });
  // A 429 is not "this game has no article". Distinguishing them matters:
  // a throttled miss must not be cached as a permanent negative.
  if (res.status === 429) throw new RateLimited("search");
  if (!res.ok) throw new LookupFailed(`search HTTP ${res.status}`);

  const data = (await res.json()) as {
    query?: { search?: Array<{ title: string }> };
  };
  const hits = data.query?.search ?? [];

  for (const hit of hits) {
    // Wikipedia always returns *something*; make sure it's the right thing.
    if (accept(hit.title)) return hit.title;
  }

  if (hits.length > 0) {
    console.log(`[Grounding] No relevant match among: ${hits.map((h) => h.title).join(", ")}`);
  }
  return null;
}

/**
 * Fetch article text. The REST summary endpoint returns only the lead
 * paragraph, which for a game article almost never mentions the soundtrack
 * or composer — exactly the details we need. So pull the plaintext extract
 * and put the sections that discuss music first, since the tail of a long
 * context is what a small model pays least attention to.
 */
async function wikiExtract(pageTitle: string): Promise<string | null> {
  // exsectionformat MUST be `wiki`. With `plain` the API strips the `==`
  // heading markers, the section regex below silently matches nothing, and
  // every song is grounded on the lead paragraph alone — which on a game
  // article is plot and credits, never the composer.
  const url =
    `${WIKI_SEARCH}?action=query&prop=extracts&explaintext=1&exsectionformat=wiki` +
    `&titles=${encodeURIComponent(pageTitle)}&format=json`;
  const res = await fetch(url, {
    // Deliberately a larger budget than the search call. This downloads the
    // FULL plaintext article — 50-150KB on a major game page — to keep 2400
    // characters, on a machine that is also encoding video. Sharing the
    // search timeout here made transient failures the expected outcome.
    signal: AbortSignal.timeout(config.groundingExtractTimeoutMs),
    headers: { "User-Agent": USER_AGENT },
  });
  if (res.status === 429) throw new RateLimited("extract");
  if (!res.ok) throw new LookupFailed(`extract HTTP ${res.status}`);

  const data = (await res.json()) as {
    query?: { pages?: Record<string, { extract?: string }> };
  };
  const pages = data.query?.pages ?? {};
  const full = Object.values(pages)[0]?.extract;
  if (!full || full.length < 80) return null;
  if (/may refer to:/i.test(full.slice(0, 200))) return null; // disambiguation

  const lead = full.split(/\n==/)[0].trim();

  // Order matters more than it looks. The result is truncated to
  // MAX_CONTEXT_CHARS, and on a Wikipedia game article "Development" comes
  // before "Music" in document order — keeping that order spends the whole
  // budget on producer and director credits and cuts the composer off the
  // end, so the overlay fills with staff lists instead of music trivia.
  //
  // The same two buckets serve composer articles, where the useful sections
  // are "Musical style", "Career" and "Works" rather than "Music" and
  // "Development".
  const primary: string[] = [];
  const secondary: string[] = [];
  const sectionRe = /\n==+\s*([^=\n]+?)\s*==+\n([\s\S]*?)(?=\n==|$)/g;
  let m: RegExpExecArray | null;
  while ((m = sectionRe.exec(full)) !== null) {
    const body = `${m[1].trim()}: ${m[2].trim()}`;
    if (/music|soundtrack|audio|score|style/i.test(m[1])) primary.push(body);
    else if (/development|production|career|works|discography/i.test(m[1])) secondary.push(body);
  }

  // The lead is placed SECOND, not last, and given a reserved budget.
  // Appending it after Music + Development meant it was always truncated
  // away on a real article — and the lead is exactly where the release year
  // and launch platform live, which are the two things screening checks
  // claims against. Music still leads, because the tail of a long context is
  // what a small model attends to least.
  const leadBudget = Math.min(lead.length, Math.floor(MAX_CONTEXT_CHARS * 0.35));
  const leadPart = lead.slice(0, leadBudget);
  const rest = [...primary, ...secondary].join("\n\n");
  const restBudget = MAX_CONTEXT_CHARS - leadPart.length - 2;

  return [rest.slice(0, Math.max(0, restBudget)), leadPart]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, MAX_CONTEXT_CHARS);
}

/**
 * Fetch reference text about the game being played. Returns "" when nothing
 * useful is found — the caller must then NOT ask the model to improvise,
 * because there is nothing left to check its output against.
 *
 * The article's Music section is what makes the composer facts possible, so
 * "about the game" and "about the game's composer" are the same lookup.
 */
export async function fetchGrounding(song: SSLSong): Promise<string> {
  const { game } = resolveGameAndTrack(song);
  const cacheKey = normalizeTitle(game);

  const cached = cacheKey ? groundingCache.get(cacheKey) : undefined;
  if (cached) {
    // Positives are kept for the process lifetime; negatives expire, so a
    // transient miss cannot silence a soundtrack for the whole stream.
    const expired = cached.text === "" && Date.now() - cached.at > NEGATIVE_TTL_MS;
    if (!expired) {
      if (cached.text) {
        console.log(`[Grounding] Cached reference for "${game}" (${cached.text.length} chars)`);
      }
      return cached.text;
    }
    groundingCache.delete(cacheKey!);
  }

  // An article is acceptable if it is about the work OR about the track.
  // For classical and pop the track is usually the only thing with its own
  // article ("Clair de Lune", "Bohemian Rhapsody"), while the "subject" is a
  // composer or band — so matching either is what makes non-VGM repertoire
  // ground at all.
  const { track } = resolveGameAndTrack(song);
  const artistLike = looksLikeArtistName(game);
  const accept = (pageTitle: string) => {
    if (isRelevantArticle(game, pageTitle, artistLike)) return true;
    // A track-name match is only trustworthy if the page isn't attributed to
    // a different artist — song titles collide across genres constantly.
    if (track !== game && isRelevantArticle(track, pageTitle, false)) {
      if (qualifierNamesAnotherArtist(pageTitle, game)) {
        console.log(`[Grounding] "${pageTitle}" is attributed to someone else — skipping`);
        return false;
      }
      return true;
    }
    return false;
  };

  // Track WHY we came up empty. Only a clean "asked and found nothing" is
  // cacheable; anything else means we never got an answer.
  let throttled = false;
  let lookupFailed = false;
  const termsTried: string[] = [];

  for (const term of searchTerms(song)) {
    termsTried.push(term);
    try {
      const page = await wikiSearchBest(term, accept);
      if (!page) continue;

      const extract = await wikiExtract(page);
      if (extract && extract.length < MIN_CONTEXT_CHARS) {
        console.log(
          `[Grounding] "${page}" is only ${extract.length} chars — too thin to write from, skipping`
        );
        continue;
      }
      if (extract) {
        const text = `${page}\n${extract}`.slice(0, MAX_CONTEXT_CHARS);
        console.log(`[Grounding] "${song.title}" -> ${page} (${extract.length} chars)`);
        if (cacheKey) groundingCache.set(cacheKey, { text, at: Date.now() });
        return text;
      }
    } catch (err) {
      if (err instanceof RateLimited) {
        throttled = true;
      } else {
        lookupFailed = true;
        // Logged individually: this line is what makes a quiet stream
        // diagnosable afterwards instead of indistinguishable from a
        // genuine "no article".
        console.warn(
          `[Grounding] Lookup failed for "${term}": ` +
            `${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`
        );
      }
    }
  }

  if (throttled || lookupFailed) {
    // We could not ask. The article may well exist — never record a negative.
    console.warn(
      `[Grounding] No reference for "${song.title}" — ` +
        `${throttled ? "rate-limited" : "lookup failed"}, not cached (terms: ${termsTried.join(" | ")})`
    );
    return "";
  }

  console.log(
    `[Grounding] No reference found for "${song.title}" (terms: ${termsTried.join(" | ")})`
  );
  if (cacheKey) groundingCache.set(cacheKey, { text: "", at: Date.now() });
  return "";
}

// --- Layer 2: deterministic claim screening ---------------------------

/**
 * Claim shapes that are highly falsifiable AND highly visible when wrong.
 * These are exactly the ones the model invented in testing ("won Best
 * Original Soundtrack at the 2016 Tokyo Game Awards").
 */
const RISKY_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\b(won|winner|awarded|nominated)\b/i, label: "award claim" },
  { re: /\b(grammy|bafta|game award|tga)\b/i, label: "award name" },
  { re: /\b(#\s?\d+|number one|no\.\s?\d+|topped the chart|billboard)\b/i, label: "chart position" },
  { re: /\b\d[\d.,]*\s*(million|billion|thousand)\b/i, label: "sales/quantity figure" },
  { re: /\bsold\s+[\d,]+/i, label: "sales figure" },
  { re: /\b(certified\s+(gold|platinum))\b/i, label: "certification claim" },
  { re: /\b(first ever|only game|best-selling|highest-\w+)\b/i, label: "superlative" },
];

/**
 * Hardware and platform names. A small model reaches for these constantly
 * and gets them wrong — attributing a PlayStation 2 game to the SNES, or
 * inventing a sound chip. When we have a reference, any console named in a
 * fact must also appear in that reference.
 */
const PLATFORM_PATTERN =
  /\b(NES|SNES|Nintendo 64|N64|GameCube|Wii U|Wii|Switch|Game Boy|Nintendo DS|3DS|PlayStation|PSone|PS1|PS2|PS3|PS4|PS5|PSP|Vita|Xbox(?: 360| One| Series [SX])?|Sega Genesis|Mega Drive|Dreamcast|Saturn|Master System|Game Gear|Atari(?: 2600)?|Amiga|Commodore 64|C64|MS-?DOS|TurboGrafx-16|PC Engine|Neo Geo|Steam Deck|arcade|YM2612|SPC700|2A03|Ricoh)\b/gi;

/**
 * Meta-commentary the model leaks when it is reasoning about the reference
 * instead of stating a fact. Showing "…is not credited in the provided
 * reference material" on stream is worse than showing nothing, so these are
 * rejected outright rather than repaired.
 */
const META_PATTERNS: RegExp[] = [
  /\b(reference material|the reference|source text|provided (text|reference)|according to the (text|reference))\b/i,
  /\b(I (couldn't|could not|cannot|can't|am not|'m not)\b|I don't (know|have))/i,
  /\b(is|are|was|were) not (credited|mentioned|listed|stated|confirmed)\b/i,
  /\b(does|do|did) not (appear|mention|state|specify)\b/i,
  /\b(unconfirmed|unverified|unclear from|no information)\b/i,
  /^(note|disclaimer|caveat|here are|sure[,!])/i,
];

/** Strip labelling prefixes the model sometimes emits despite instructions. */
function stripPrefix(fact: string): string {
  return fact
    .replace(/^\s*(fact|trivia|tip|line)\s*\d*\s*[:.\-—]\s*/i, "")
    .replace(/^\s*[-*•]\s*/, "")
    .replace(/^\s*\d+\s*[.)]\s*/, "")
    .replace(/^["'“”]|["'“”]$/g, "")
    .trim();
}

export interface ScreenResult {
  kept: string[];
  rejected: Array<{ text: string; reason: string }>;
}

/**
 * Drop facts making claims the grounding text does not visibly support.
 *
 * The year and platform checks only run when we actually have reference
 * text. With no reference the prompt asks for general, well-known video
 * game music facts, and those legitimately contain years and console names
 * that no reference backs up — screening them there would reject
 * everything and leave the overlay blank.
 */
/**
 * Platforms that are the same machine under different names. Without these
 * a reference saying "Nintendo 64" rejected a fact saying "N64", and one
 * saying "Sega Genesis" rejected "Mega Drive" — correct facts thrown away
 * for naming the same hardware differently.
 */
const PLATFORM_ALIASES: Record<string, string[]> = {
  nes: ["nintendo entertainment system", "famicom"],
  snes: ["super nintendo", "super famicom", "super nintendo entertainment system"],
  n64: ["nintendo 64"],
  "nintendo 64": ["n64"],
  ps1: ["playstation"],
  psone: ["playstation"],
  ps2: ["playstation 2"],
  ps3: ["playstation 3"],
  ps4: ["playstation 4"],
  ps5: ["playstation 5"],
  "mega drive": ["genesis", "sega genesis"],
  "sega genesis": ["mega drive"],
  "game boy": ["gameboy"],
  c64: ["commodore 64"],
  "commodore 64": ["c64"],
  "pc engine": ["turbografx-16", "turbografx"],
  "turbografx-16": ["pc engine"],
};

/**
 * Does the reference actually corroborate this platform?
 *
 * A bare substring test is wrong in both directions: "NES" was corroborated
 * by the word "kindness" (and, far more commonly on a game article, by
 * "Genesis"), while "N64" was rejected by a reference that said
 * "Nintendo 64". Word boundaries fix the false accepts, aliases the false
 * rejects.
 */
export function platformSupported(platform: string, context: string): boolean {
  const p = platform.toLowerCase();
  const lower = context.toLowerCase();

  const boundary = (needle: string, haystack: string, flags: string) =>
    new RegExp(
      `(^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`,
      flags
    ).test(haystack);

  // Some platform names are also ordinary English words: "you can switch
  // between party members", "a saturnine mood", "the genesis of the project".
  // For these the capital letter is the only thing separating the console
  // from the noun, so match case-sensitively against the original text.
  if (AMBIGUOUS_PLATFORMS.has(p)) {
    const proper = platform[0].toUpperCase() + platform.slice(1);
    if (boundary(proper, context, "")) return true;
  } else if (boundary(p, lower, "i")) {
    return true;
  }

  return (PLATFORM_ALIASES[p] ?? []).some((a) => boundary(a, lower, "i"));
}

/** Platform names that are also common English words. */
const AMBIGUOUS_PLATFORMS = new Set(["switch", "saturn", "genesis", "vita", "arcade"]);

/**
 * Words that begin a sentence or head a title and would otherwise look like
 * the first half of a person's name.
 */
const NAME_STOPWORDS = new Set([
  "the", "a", "an", "this", "that", "these", "those", "it", "its", "in", "on",
  "at", "for", "to", "of", "and", "but", "or", "so", "when", "while", "after",
  "before", "during", "although", "however", "both", "each", "every", "many",
  "most", "some", "several", "one", "two", "three", "first", "second", "third",
  "original", "new", "final", "main", "early", "later", "modern", "classic",
  "他", "his", "her", "their", "they", "he", "she", "we", "you", "i",
  "nintendo", "sega", "sony", "microsoft", "capcom", "konami", "square",
  "atlus", "falcom", "bandai", "namco", "enix", "ubisoft", "activision",
  "japanese", "american", "european", "english", "german", "french",
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
]);

/**
 * Find a person-shaped name in the fact that the reference does not contain.
 *
 * Composer attribution is the most visible error this overlay can make on a
 * video game music stream, and it was the documented reason this module
 * exists ("it invented three different wrong composers for Ys VIII across
 * runs"). Yet years and platforms were checked and names were not — a fact
 * reading "written by Yuzo Koshiro and Nobuo Uematsu" passed untouched
 * against a reference naming only Falcom Sound Team jdk.
 *
 * This is the same deterministic shape as the platform check: extract
 * capitalised multi-word sequences and require them to appear in the
 * reference. No model, no latency, nothing that can itself be wrong in a
 * new way.
 */
export function unsupportedName(fact: string, ctxLower: string): string | null {
  // Two or more consecutive capitalised words: "Yuzo Koshiro",
  // "Falcom Sound Team". Single capitalised words are far too noisy —
  // sentence starts, game titles, and instruments all qualify.
  const candidates = fact.match(/\b[A-Z][a-z'’-]+(?:\s+[A-Z][a-z'’-]+)+\b/g) ?? [];

  for (const candidate of candidates) {
    const words = candidate.split(/\s+/);

    // A sequence that merely starts a sentence ("The Legend Of...") is not a
    // person. Drop leading stopwords and re-check we still have two words.
    while (words.length > 0 && NAME_STOPWORDS.has(words[0].toLowerCase())) {
      words.shift();
    }
    if (words.length < 2) continue;
    if (words.every((w) => NAME_STOPWORDS.has(w.toLowerCase()))) continue;

    const name = words.join(" ");
    if (ctxLower.includes(name.toLowerCase())) continue;

    // Accept a partial match too: the reference may write "Koshiro" alone,
    // or use different given-name romanisation. Require every word of the
    // candidate to appear somewhere in the reference.
    if (words.every((w) => ctxLower.includes(w.toLowerCase()))) continue;

    return name;
  }

  return null;
}

export function screenClaims(facts: string[], context: string): ScreenResult {
  const ctx = context.toLowerCase();
  const grounded = context.length > 0;
  const kept: string[] = [];
  const rejected: Array<{ text: string; reason: string }> = [];

  for (const raw of facts) {
    const fact = stripPrefix(raw);

    // Meta-commentary is never salvageable — drop before anything else.
    if (META_PATTERNS.some((re) => re.test(fact))) {
      rejected.push({ text: fact, reason: "meta-commentary" });
      continue;
    }

    // Too short to be a real fact once prefixes are stripped.
    if (fact.length < 20) {
      rejected.push({ text: fact, reason: "too short" });
      continue;
    }

    let bad: string | null = null;

    for (const { re, label } of RISKY_PATTERNS) {
      const m = fact.match(re);
      if (!m) continue;
      // Corroborated if the matched phrase itself shows up in the reference.
      if (ctx.includes(m[0].toLowerCase())) continue;
      bad = label;
      break;
    }

    if (!bad && grounded) {
      // Every year, not just the first: "released in 2016 and remastered in
      // 2021" was passing on the strength of 2016 alone.
      const years = fact.match(/\b(1[89]\d{2}|20\d{2})\b/g) ?? [];
      const unsupportedYear = years.find((y) => !ctx.includes(y));
      if (unsupportedYear) bad = `unsupported year ${unsupportedYear}`;
    }

    if (!bad && grounded) {
      const platforms = fact.match(PLATFORM_PATTERN) ?? [];
      const unsupported = platforms.find((p) => !platformSupported(p, context));
      if (unsupported) bad = `unsupported platform "${unsupported}"`;
    }

    if (!bad && grounded) {
      const invented = unsupportedName(fact, ctx);
      if (invented) bad = `unsupported name "${invented}"`;
    }

    if (bad) {
      rejected.push({ text: fact, reason: bad });
      continue;
    }

    // Length cap. Nothing downstream truncates: the overlay renders the raw
    // string into a fixed-width bubble, so an over-long line overflows it.
    if (fact.length > MAX_FACT_CHARS) {
      rejected.push({ text: fact, reason: `too long (${fact.length} chars)` });
      continue;
    }

    // Near-duplicate rejection. Every check above evaluates a fact in
    // isolation, so five faithful restatements of the same source sentence
    // all pass individually — which at temperature 0.2 restating a short
    // reference is the model's natural failure mode, and on screen reads as
    // the overlay repeating itself.
    const dupeOf = kept.find((k) => tooSimilar(k, fact));
    if (dupeOf) {
      rejected.push({ text: fact, reason: "near-duplicate of an earlier fact" });
      continue;
    }

    kept.push(fact);
  }

  return { kept, rejected };
}

/** Longest fact that fits the bubble without overflowing it. */
const MAX_FACT_CHARS = 160;

function contentTokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t))
  );
}

/**
 * Content-word overlap. Containment is checked as well as Jaccard because a
 * restatement often adds words ("the game's music comes from X" vs "the music
 * was composed by X"): the shared content is nearly all of the shorter fact,
 * but Jaccard alone is dragged below threshold by the extra tokens.
 */
export function tooSimilar(a: string, b: string): boolean {
  const ta = contentTokens(a);
  const tb = contentTokens(b);
  if (ta.size === 0 || tb.size === 0) return false;

  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;

  const union = ta.size + tb.size - shared;
  const jaccard = shared / union;
  const containment = shared / Math.min(ta.size, tb.size);

  return jaccard >= 0.5 || containment >= 0.7;
}

// --- Curated pool ------------------------------------------------------

/**
 * Hand-verified, genuinely true video game music facts.
 *
 * Used whenever there is nothing song-specific to say: no article was found
 * for the song, generation failed, or nothing survived screening. Asking the
 * model for "general video game music facts" instead produced confident
 * errors — it put Yoko Shimomura on Final Fantasy VII — and with no reference
 * there is nothing for screening to catch that against, so these are written
 * by hand.
 *
 * They are deliberately NOT used to pad a *partial* song-specific result:
 * four facts about the game being played beats four plus one about Tetris.
 *
 * Keep every entry independently checkable, and keep the pool comfortably
 * larger than FACTS_PER_SONG or every unknown song shows the same bubbles.
 */
/**
 * The fallback pool comes from the selected topic pack (topics/<TOPIC>.json).
 * Kept under this name because every consumer and test refers to it.
 */
export const CURATED_FACTS: string[] = topic.curatedFacts;

/** Clear the per-game grounding cache (useful for testing). */
export function clearGroundingCache(): void {
  groundingCache.clear();
}

/** Pick curated facts not already present, avoiding near-duplicates. */
export function topUp(existing: string[], want: number): string[] {
  const have = new Set(existing.map((f) => f.toLowerCase().slice(0, 40)));
  const out: string[] = [];
  // Fisher-Yates. `sort(() => Math.random() - 0.5)` is not a shuffle: over
  // 20k draws against this pool the first entry came up 1.66x uniform and the
  // tail 0.83x, so the same few curated facts dominated every unknown song —
  // exactly what a varied pool is supposed to prevent.
  const pool = [...CURATED_FACTS];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  for (const fact of pool) {
    if (out.length >= want) break;
    if (have.has(fact.toLowerCase().slice(0, 40))) continue;
    out.push(fact);
  }
  return out;
}
