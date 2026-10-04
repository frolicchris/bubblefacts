import { config } from "./config";
import { SSLSong } from "./types";
import { blockedArticles } from "./wrong-facts";
import { topic } from "./topic";
import { escapeRe } from "./text";

/**
 * Grounding and screening.
 *
 * Grounding fetches the song's Wikipedia article so the model restates a
 * source instead of recalling from memory. Screening then drops any sentence
 * whose names, years or platforms the source does not contain. Every check
 * is a string comparison: no second model, no added latency.
 */

const WIKI_API = "https://en.wikipedia.org/w/api.php";
export const USER_AGENT =
  `bubblefacts/1.0 (${process.env.WIKIPEDIA_CONTACT || "https://github.com/frolicchris/bubblefacts"})`;

const MAX_CONTEXT_CHARS = 3000;
/** Shorter extracts are stubs; the entry's own data beats restating one. */
const MIN_CONTEXT_CHARS = 600;
/** Longest fact that fits a bubble. */
const MAX_FACT_CHARS = 160;
/** How long "no article" is trusted before the lookup is retried. */
const NEGATIVE_TTL_MS = 10 * 60 * 1000;

const STOPWORDS = new Set(["the", "and", "of", "a", "an", "in", "on", "for", "to"]);

/** Wikipedia throttled us: the article may exist, so the miss is never cached. */
class RateLimited extends Error {}

/**
 * Articles found through the game are shared by every track from it;
 * articles found through the track, and misses, belong to that song only.
 */
const groundingCache = new Map<string, { text: string; at: number }>();

// --- Title parsing -----------------------------------------------------

/** A trailing parenthetical that marks a variant rather than naming the game. */
const VARIANT_MARKER =
  /^\s*(arr\b|arr\.|arrange|arranged|arrangement|remix|cover|medley|reprise|remaster|remastered|ost\b|ver\b|ver\.|version|act\s*\d|part\s*\d|\d{4}\b|live\b|acoustic\b|piano\b|vocal\b|instrumental\b|jazzy\b)/i;
/** "(Day)" and "(Night)" are variants only on their own; "(Night in the Woods)" is a game. */
const VARIANT_WORD = /^\s*(day|night)\s*$/i;

/**
 * "Separate Ways (Worlds Apart) [Instrumental]" is the song "Separate Ways
 * (Worlds Apart)": a tag at the end that says how it's played (instrumental,
 * piano, a cover, a live version) describes the performance, not the work,
 * and searching with it finds nothing. Song lists add these often.
 */
export function dropVersionTags(title: string): string {
  let t = title;
  for (let m; (m = /^(.+?)\s*[([]([^)\]]*)[)\]]\s*$/.exec(t)) && VARIANT_MARKER.test(m[2]); ) t = m[1];
  return t;
}

/** Split "Game: Track", "Game - Track" or "Track (Game)". */
export function splitGameAndTrack(title: string): { game: string; track: string } {
  const clean = title.trim();

  const paren = clean.match(/^(.+?)\s*[([]([^)\]]{2,})[)\]]\s*$/);
  if (paren && !VARIANT_MARKER.test(paren[2]) && !VARIANT_WORD.test(paren[2])) {
    return { game: paren[2].trim(), track: paren[1].trim() };
  }

  const sep = clean.match(/^(.+?)\s*(?::|\s[-–—]\s)\s*(.+)$/);
  if (sep) return { game: sep[1].trim(), track: sep[2].trim() };

  return { game: clean, track: clean };
}

/**
 * Song lists usually put the game in the artist field and the track in the
 * title. When the title's own "Game:" prefix extends the artist ("Super
 * Mario" -> "Super Mario 64"), the title is more specific and wins.
 */
export function resolveGameAndTrack(song: SSLSong): { game: string; track: string } {
  const artist = song.artist?.trim();
  const title = dropVersionTags(song.title.trim());

  if (!artist || /^unknown$/i.test(artist) || artist.toLowerCase() === title.toLowerCase()) {
    return splitGameAndTrack(title);
  }

  const split = splitGameAndTrack(title);
  if (split.game !== title) {
    const a = artist.toLowerCase();
    const g = split.game.toLowerCase();
    if (g === a) return { game: artist, track: split.track };
    if (g.startsWith(a + " ")) return split;
  }
  return { game: artist, track: title };
}

/**
 * The names to look for in a credit, whole credit first: "Earth, Wind & Fire"
 * stays whole, and "Lil Nas X, Jack Harlow" also tries its lead, "Lil Nas X".
 * Only commas and "feat." split a credit: "&", "and" and "x" are often part
 * of a name.
 */
export function artistNames(artist: string): string[] {
  const lead = artist.split(/\s*,\s*|\s+(?:feat\.?|ft\.?|featuring)\s+/i)[0] ?? "";
  // Two full names joined by "and": an article may name each alone. Only when
  // both sides are full names, so "Simon and Garfunkel" stays one.
  const pair = artist.split(/\s+(?:and|&)\s+/i);
  const people = pair.length === 2 && pair.every((p) => p.trim().split(/\s+/).length >= 2) ? pair : [];
  // "Simon and Garfunkel" is written "Simon & Garfunkel" in its articles, and the other way round.
  const joined = [lead.replace(/\s+and\s+/gi, " & "), lead.replace(/\s+&\s+/g, " and ")];
  return [...new Set([artist, lead, ...people, ...joined].map(normalizeTitle).filter(Boolean))];
}

/** Whether normalized text names one of these as whole words: "Sia" isn't in "Asia". */
export function mentionsName(normalizedText: string, names: string[]): boolean {
  const padded = ` ${normalizedText} `;
  return names.some((n) => padded.includes(` ${n} `));
}

// --- Article relevance -------------------------------------------------

/** Wikipedia disambiguators meaning "a musical work or what it comes from". */
const MUSICAL_QUALIFIER =
  /video game|game\b|series|soundtrack|album|franchise|film|score|song|single|composition|opera|ballet|suite|sonata|symphony|concerto|musical|anime|television|tv series|novel/i;
/** Disambiguators for people and groups: right only when we searched for one. */
const PERFORMER_QUALIFIER = /band|singer|musician|composer|pianist|rapper|duo|group|orchestra/i;
/** Words marking a different kind of work under the same name. */
/** An article's opening that describes a performer or a recording. */
const PERFORMER_LEAD = /\b(band|singer|rapper|musician|group|duo|trio|songwriter|record(ing)? artist|vocalist|album|song|single|DJ|producer)\b/i;
/** Disambiguators that can't be a performer. */
const NOT_A_PERFORMER = /\((?:[^)]*\b)?(video game|game|film|television|tv series|novel|manga|anime)\)\s*$/i;
const MEDIUM_SHIFT = /\b(movie|film|musical|discography|anime|manga|novel|list|awards|tour|concert)\b/i;

const KNOWN_ARTIST =
  /\b(beethoven|mozart|bach|chopin|debussy|liszt|ravel|satie|tchaikovsky|schubert|brahms|rachmaninoff|beatles|queen|abba|elton john|billy joel|radiohead|coldplay|adele|taylor swift|joe hisaishi|ryuichi sakamoto|hans zimmer|john williams|ennio morricone|yiruma|ludovico einaudi)\b/i;

const ROMAN: Record<string, string> = {
  i: "1", ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8",
  ix: "9", x: "10", xi: "11", xii: "12", xiii: "13", xiv: "14", xv: "15",
};

/**
 * Lowercase, strip accents and a trailing "(qualifier)", drop punctuation.
 * "X-2" becomes "x2" so a sequel's number isn't read as a separate token.
 */
export function normalizeTitle(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    // Trailing tags in brackets or parentheses: "(Worlds Apart)", "[Instrumental]", "(Live) (Remastered)".
    .replace(/(?:\s*(?:\([^)]*\)|\[[^\]]*\]))+\s*$/, "")
    .toLowerCase()
    .replace(/(\p{L})-(\d)/gu, "$1$2")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Content words plus every numeral, roman numerals normalized to arabic. */
function significantTokens(s: string): string[] {
  const words = s.split(" ").filter((t) => t && !STOPWORDS.has(t));
  const kept = words.filter((t) => t.length >= 2 || /\d/.test(t) || t in ROMAN);
  return (kept.length ? kept : words).map((t) => ROMAN[t] ?? t);
}

/** "Firstname Lastname", or a well-known composer or band. */
export function looksLikeArtistName(subject: string): boolean {
  if (!subject) return false;
  if (KNOWN_ARTIST.test(subject)) return true;
  return (
    /^\p{Lu}[\p{Ll}'’-]+(?:\s+\p{Lu}[\p{Ll}'’-]+){1,2}$/u.test(subject.trim()) &&
    !/\b(the|of|and|a|an)\b/i.test(subject)
  );
}

/** A page qualifier that says what kind of work it is: "(Flight Facilities song)", "(album)". */
const WORK_TYPE = /\b(song|single|album|soundtrack|composition|video|game|series|film|instrumental|suite)\b/i;

/**
 * True when a page's disambiguator names an artist that is not the subject:
 * "Clair de Lune (Flight Facilities song)" when we wanted Debussy.
 *
 * `track` is the title as requested. A bracket it shares with the page is
 * part of the song's name, not a disambiguator: "Separate Ways (Worlds Apart)".
 * With `bareSubtitlesOk`, a bracket that names no kind of work is taken as a
 * subtitle too; the caller must then check the article names the artist.
 */
export function qualifierNamesAnotherArtist(pageTitle: string, subject: string, track = "", bareSubtitlesOk = false): boolean {
  const qualifier = /\(([^)]*)\)\s*$/.exec(pageTitle)?.[1];
  if (!qualifier) return false;
  const fold = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (track && ` ${fold(track)} `.includes(` ${fold(qualifier)} `)) return false;
  if (bareSubtitlesOk && !WORK_TYPE.test(qualifier)) return false;

  const named = qualifier
    .split(/\s+/)
    .filter((w) => !/^(song|single|album|soundtrack|composition|video|game|series|film|instrumental|suite)$/i.test(w))
    .join(" ");
  const qualifierTokens = normalizeTitle(named).split(" ").filter(Boolean);
  const subjectTokens = new Set(normalizeTitle(subject).split(" ").filter(Boolean));
  if (!qualifierTokens.length || !subjectTokens.size) return false;

  return !qualifierTokens.some((t) => subjectTokens.has(t));
}

/**
 * Is this article about the subject we searched for?
 *
 * Wikipedia search always returns a best fuzzy match, never "no result", so
 * this guard is what stops a song with no article from being grounded on
 * something merely similar.
 */
export function isRelevantArticle(subject: string, pageTitle: string, subjectIsArtist = false): boolean {
  const want = normalizeTitle(subject);
  const got = normalizeTitle(pageTitle);
  const wantTokens = significantTokens(want);
  const gotTokens = significantTokens(got);
  if (!want || !got || !wantTokens.length || !gotTokens.length) return false;

  // "Nier series" is the series' own article: "Nier (series)", or "Star Trek" itself.
  // Never a single installment: "Nier (video game)" isn't the series.
  const series = /^(.+) (?:series|franchise)$/.exec(want);
  if (series) {
    const q = /\(([^)]*)\)\s*$/.exec(pageTitle)?.[1];
    if (significantTokens(series[1]).join(" ") === gotTokens.join(" ")) return !q || /\b(series|franchise)\b/i.test(q);
  }

  // A leading "The" is part of a band's name: "The Midnight" is not "Midnight
  // Club" or "Wangan Midnight", though dropping "the" would leave only "midnight".
  if (/^the\s/.test(want) && !/^the\s/.test(got)) return false;

  const qualifier = /\(([^)]*)\)\s*$/.exec(pageTitle)?.[1];
  if (qualifier) {
    // A work dated in the future (an announced remake) is not what's on air.
    const year = /\b(20\d{2})\b/.exec(qualifier)?.[1];
    if (year && Number(year) > new Date().getFullYear()) return false;

    // Capitalized disambiguators are attributions ("Clair de Lune (Debussy)");
    // lowercase ones are categories and must be musical.
    const isPerformer = PERFORMER_QUALIFIER.test(qualifier);
    const properNoun = /^\p{Lu}/u.test(qualifier.trim()) && !isPerformer;
    if (!MUSICAL_QUALIFIER.test(qualifier) && !(isPerformer && subjectIsArtist) && !properNoun) return false;
  }

  // Installment numbers decide sequels: "Final Fantasy X" is neither
  // "Final Fantasy" nor "Final Fantasy XII".
  const wantNums = wantTokens.filter((t) => /^\d+$/.test(t));
  const gotNums = gotTokens.filter((t) => /^\d+$/.test(t));
  if (wantNums.length && !wantNums.some((n) => gotNums.includes(n))) return false;

  const wantSeq = wantTokens.join(" ");
  const gotSeq = gotTokens.join(" ");

  // The article extends the subject on a token boundary: "Celeste" -> "Celeste (video game)".
  if (gotSeq.startsWith(wantSeq + " ")) {
    // A possessive names another work: "Michael Jackson's This Is It" isn't about Michael Jackson's songs.
    if (got.startsWith(want + " s ")) return false;
    return !(MEDIUM_SHIFT.test(got) && !MEDIUM_SHIFT.test(want));
  }
  // The article truncates the subject: safe only at a subtitle break ("Ys VIII:
  // Lacrimosa of Dana" -> "Ys VIII") and if no numeral was lost. "Everybody
  // Dance Now" is not "Everybody Dance".
  if (wantSeq.startsWith(gotSeq + " ")) {
    const head = significantTokens(normalizeTitle(subject.split(/:|\s[-–—]\s/)[0])).join(" ");
    // An installment number is a subtitle break too: "Ys II The Final Chapter" -> "Ys II".
    const atBreak = head === gotSeq || /^\d+$/.test(gotTokens[gotTokens.length - 1]);
    return atBreak && wantNums.every((n) => gotNums.includes(n));
  }

  // Longer titles that merely contain the subject are about something else:
  // "Queen" -> "Long Live the Queen (video game)".
  if (got.split(" ").length > want.split(" ").length + 1) return false;
  if (gotSeq === wantSeq) return true;
  // A set named in the plural: "Hungarian Dance" is one of the "Hungarian Dances (Brahms)".
  if (gotSeq === wantSeq + "s" && wantTokens.length >= 2) return true;

  const gotSet = new Set(gotTokens);
  const ratio = wantTokens.filter((t) => gotSet.has(t)).length / wantTokens.length;
  if (wantTokens.length >= 3) return ratio >= 0.85;
  // A short subject must be the whole title, in any order: "The Midnight" is
  // not "Wangan Midnight".
  const wantSet = new Set(wantTokens);
  return ratio === 1 && gotTokens.every((t) => wantSet.has(t));
}

// --- Wikipedia lookup --------------------------------------------------

/**
 * Search terms, most likely first. A bare track name ("Overture", "Main
 * Theme") is only worth searching when the subject is a person or band; for
 * a game it finds a generic article.
 */
function searchTerms(game: string, track: string, artist: boolean, notGame = false): string[] {
  const hasTrack = track && track !== game;
  const trackTerms = hasTrack ? [`${track} ${game}`, ...(artist ? [track] : [])] : [];
  const subjectTerms = game ? [...(artist || notGame ? [] : [`${game} video game`]), `${game} soundtrack`, game] : [];
  const terms = artist ? [...trackTerms, ...subjectTerms] : [...subjectTerms, ...trackTerms];
  return [...new Set(terms.map((t) => t.trim()).filter(Boolean))];
}

async function wikiGet<T>(params: string, timeoutMs: number, what: string): Promise<T> {
  const res = await fetch(`${WIKI_API}?${params}&format=json`, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "User-Agent": USER_AGENT },
  });
  if (res.status === 429) throw new RateLimited(what);
  if (!res.ok) throw new Error(`${what} HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function wikiSearch(term: string): Promise<string[]> {
  const data = await wikiGet<{ query?: { search?: Array<{ title: string }> } }>(
    `action=query&list=search&srlimit=5&srsearch=${encodeURIComponent(term)}`,
    config.groundingTimeoutMs,
    "search"
  );
  return (data.query?.search ?? []).map((h) => h.title);
}

/** A search's hits and, when Wikipedia thinks the term is misspelled, its suggested spelling. */
async function wikiSearchSuggestion(term: string): Promise<{ titles: string[]; suggestion: string }> {
  const data = await wikiGet<{ query?: { search?: Array<{ title: string }>; searchinfo?: { suggestion?: string } } }>(
    `action=query&list=search&srlimit=5&srprop=&srinfo=suggestion&srsearch=${encodeURIComponent(term)}`,
    config.groundingTimeoutMs,
    "search"
  );
  return { titles: (data.query?.search ?? []).map((h) => h.title), suggestion: data.query?.searchinfo?.suggestion ?? "" };
}

/**
 * Where Wikipedia files each of these exact titles: the page itself, the
 * page it redirects to (with `fragment` when the redirect points into a
 * section of it), or nothing when no page has that title.
 */
async function wikiResolveTitles(names: string[]): Promise<Map<string, { page: string; redirected: boolean; fragment: boolean }>> {
  const data = await wikiGet<{
    query?: {
      normalized?: Array<{ from: string; to: string }>;
      redirects?: Array<{ from: string; to: string; tofragment?: string }>;
      pages?: Record<string, { title: string; missing?: string; invalid?: string }>;
    };
  }>(`action=query&redirects=1&titles=${encodeURIComponent(names.join("|"))}`, config.groundingTimeoutMs, "titles");
  const q = data.query ?? {};
  const existing = new Set(Object.values(q.pages ?? {}).filter((p) => p.missing === undefined && p.invalid === undefined).map((p) => p.title));
  const out = new Map<string, { page: string; redirected: boolean; fragment: boolean }>();
  for (const name of names) {
    const title = q.normalized?.find((n) => n.from === name)?.to ?? name;
    const redirect = q.redirects?.find((r) => r.from === title);
    const page = redirect?.to ?? title;
    if (existing.has(page)) out.set(name, { page, redirected: !!redirect, fragment: !!redirect?.tofragment });
  }
  return out;
}

const MUSIC_HEADING = /music|soundtrack|audio|score|style/i;
const BACKGROUND_HEADING = /development|production|career|works|discography/i;

/**
 * Up to `budget` characters of article text: music sections first (with
 * their subsections), then background, then the lead, which holds the
 * release year and platform that screening checks against. The tail of a
 * long context is what a small model reads least carefully.
 */
/** A creator talking about the work: "said", "recalled", "was inspired by". */
const CREATOR_CUE =
  /\b(said|says|stated|recalled|recalls|explained|explains|remembered|described (?:how|the|it|writing|recording)|according to|in an interview|inspired by|inspiration|influenc\w+|based (?:it )?on|modell?ed (?:it )?(?:on|after)|drew (?:on|from)|borrow\w+|homage|tribute to|was written (?:after|while|when|during|in (?:about|just|under))|wrote (?:it|the song|the piece|the track|the music) (?:after|while|when|during|in)|came up with|originally (?:titled|entitled|intended|written|called|planned|composed|named|meant)|intended|wanted|decided|felt that|took (?:only|about|just))\b/i;
/** "Astley told the Los Angeles Times": told, then a name. */
const TOLD_SOMEONE = /\btold (?:the |an? )?\p{Lu}/u;
/** The sentence is about the music, not the business around it. */
const ABOUT_MUSIC = /\b(music|songs?|tracks?|themes?|score|melody|melodies|soundtrack|compos\w+|record\w*|lyrics?|riff|chords?|album|tune|piece|arrang\w+|vocals?|piano|guitar|demo|title)\b/i;
/** Sections where creators' comments about the music live. */
const MAKING_HEADING = /recording|composition|production|development|conception|background|writing|music|creation|origin|inspiration/i;
/** Sections that are other people's opinions, later uses, or lists. */
const NOT_THE_MAKERS_HEADING =
  /reception|review|accolade|chart|certification|track listing|personnel|credits|legacy|impact|music video|cover|version|popular culture|media|usage|use in|adaptation|sampl|reference|see also|external|release|commercial|performance/i;
/** Critics, the press and scholars: their views aren't the makers'. */
const CRITIC_WORDS =
  /\b(critics?|reviewers?|magazine|publication|newspaper|journalist|correspondent|writer|musicologist|scholar|author|biograph\w+|documentary|interpreted|ranked|listed|review(?:ed|s)?|praised|called it|charts?|streamed|copies|sold)\b/i;
const CRITIC_NAMES =
  /\b(IGN|GameSpot|GameSpy|GamePro|Game Informer|Nintendo Power|Edge|1UP|Destructoid|Tom's Guide|AllMusic|Pitchfork|Rolling Stone|Billboard|NME|Kotaku|Polygon|RPGFan|Eurogamer|Famitsu|Stereogum|MTV|NPR|BBC|USA Today|Variety|Melody Maker|[A-Z]\w+ (?:Times|News|Post|Tribune|Herald|Guardian|Telegraph))\b/;
const CRITIC = { test: (s: string) => CRITIC_WORDS.test(s) || CRITIC_NAMES.test(s) };
/** A sentence that leans on the one before it can't be retold on its own. */
const LEANS_BACK = /^["“]?(?:I|We|He|She|They|It|His|Her|Their|This|These|That|Those|Hence|However|Instead|Meanwhile|Therefore|The same|A similar|Despite|Asked|When asked)\b/;
const MAX_COLOR_SENTENCES = 5;
const MAX_COLOR_CHARS = 900;

/**
 * The article's sentences where the people who made the music say something
 * about it, in article order (issue #48). Articles summarize interviews in
 * their Recording, Composition and Development sections, usually far past
 * the lead, where a character budget never reached them.
 *
 * A sentence needs a cue ("said", "recalled", "inspired by"), to be about the
 * music, and to stand on its own: someone named, no leaning on the sentence
 * before, no quotation cut off by the sentence split. Then it's scored:
 * naming the track or artist and sitting in a section about making the music
 * count for it; reception and later-use sections, critics and the press, and
 * great length count against it. It needs one point in its favor to be kept.
 */
/** Plainly about music: for an article on a whole game or artist, where "title" and "piece" could mean anything. */
const PLAINLY_MUSIC = /\b(music|songs?|tracks?|soundtrack|score|melody|melodies|compos\w+|lyrics?|theme song|main theme)\b/i;

export function creatorSentences(full: string, names: string[] = [], ownArticle = true): string[] {
  const wanted = names.map((n) => normalizeTitle(n)).filter(Boolean);
  const scored: Array<{ text: string; score: number; at: number }> = [];
  let at = 0;
  const sections = [["", full.split(/\n==/)[0]], ...[...full.matchAll(/\n==+\s*([^=\n]+?)\s*==+\n([\s\S]*?)(?=\n==|$)/g)].map((m) => [m[1], m[2]])];
  for (const [heading, body] of sections) {
    const making = MAKING_HEADING.test(heading);
    const others = NOT_THE_MAKERS_HEADING.test(heading);
    for (const raw of body.split(/(?<=[.!?]["”]?)\s+(?=["“]?\p{Lu})|\n+/u)) {
      const text = raw.trim();
      at++;
      if (text.length < 40 || !(CREATOR_CUE.test(text) || TOLD_SOMEONE.test(text))) continue;
      const namesTrack = wanted.length > 0 && mentionsName(normalizeTitle(text), wanted);
      // In an article about the whole game or artist, only what names the track, or is plainly about the music.
      if (!namesTrack && !(ownArticle ? ABOUT_MUSIC.test(text) : PLAINLY_MUSIC.test(text) && making)) continue;
      // Leaning on the sentence before, or cut by the split: an open quotation, a trailing colon, a stray initial.
      if (cutOff(text)) continue;
      // Someone has to be named.
      if (!/\b\p{Lu}\p{L}+/u.test(text.slice(1))) continue;
      let score = 3;
      if (namesTrack) score += 2;
      if (making) score += 1;
      if (others) score -= 3;
      if (CRITIC.test(text)) score -= 3;
      if (text.length > 300) score -= 2;
      if (score >= 4) scored.push({ text, score, at });
    }
  }
  const best = scored.sort((a, b) => b.score - a.score || a.at - b.at).slice(0, MAX_COLOR_SENTENCES);
  const kept: string[] = [];
  let used = 0;
  for (const s of best.sort((a, b) => a.at - b.at)) {
    if (used + s.text.length > MAX_COLOR_CHARS) continue;
    kept.push(s.text);
    used += s.text.length + 1;
  }
  return kept;
}

/** How the work did, in things that can be counted: charts, awards, certifications, sales. */
const RECEIVED_CUE =
  /\b(number[- ]one|number \d+|No\. ?\d+|top (?:ten|five|\d+)|topped|peaked|reached|charted|won|winning|awarded|nominat\w+|Grammy|Academy Award|Oscar|BAFTA|Golden Globe|certified|platinum|gold|diamond|best[- ]selling|million|billion|inducted|Hall of Fame|National Recording Registry|first (?:video game|song|single|piece)\b.{0,40}\bto)\b/i;
const RECEIVED_HEADING = /reception|commercial|chart|accolade|award|legacy|release|impact/i;
const MAX_RECEIVED_SENTENCES = 3;
const MAX_RECEIVED_CHARS = 450;

/** Whether a split left the sentence unable to stand alone. */
const brokenBySplit = (text: string) =>
  (text.match(/["“”]/g)?.length ?? 0) % 2 === 1 || /[:;,]$/.test(text) || /\b\p{Lu}\.$/u.test(text);
const cutOff = (text: string) => LEANS_BACK.test(text) || brokenBySplit(text);

/**
 * The article's sentences on how the work was received, as things that can be
 * counted: chart peaks, awards, certifications and sales. They sit in the
 * lead and in Reception, Charts and Accolades sections, which the music-first
 * ordering skipped. Critics' opinions are left out: screening drops those.
 */
export function receptionSentences(full: string): string[] {
  const sections = [["", full.split(/\n==/)[0]], ...[...full.matchAll(/\n==+\s*([^=\n]+?)\s*==+\n([\s\S]*?)(?=\n==|$)/g)].map((m) => [m[1], m[2]])];
  const kept: string[] = [];
  let used = 0;
  for (const [heading, body] of sections) {
    if (heading && !RECEIVED_HEADING.test(heading)) continue;
    for (const raw of body.split(/(?<=[.!?]["”]?)\s+(?=["“]?\p{Lu})|\n+/u)) {
      const text = raw.trim();
      // "It reached number one" is fine here: in the song's own article, "it" is the song.
      if (text.length < 40 || text.length > 260 || !RECEIVED_CUE.test(text) || OPINION.test(text) || brokenBySplit(text)) continue;
      if (LEANS_BACK.test(text) && !/^It\b/.test(text)) continue;
      if (kept.length >= MAX_RECEIVED_SENTENCES || used + text.length > MAX_RECEIVED_CHARS) return kept;
      kept.push(text);
      used += text.length + 1;
    }
  }
  return kept;
}

/** How the music is built: key, tempo, meter, harmony, form. */
const THEORY_CUE =
  /\b(key of|[A-G](?:[-♭♯ ](?:flat|sharp))? (?:major|minor)|in (?:a )?(?:major|minor)|tempo|beats per minute|bpm|time signature|\d\/\d time|common time|chord progression|chords?|arpeggi\w+|ostinato|leitmotifs?|modulat\w+|syncopat\w+|counterpoint|riff|scale|Dorian|Phrygian|Lydian|Mixolydian|pentatonic|octaves?|vocal range|spans|bars?\b|measures|verse[- ]chorus|bridge|coda|waltz)\b/i;
const THEORY_HEADING = /composition|music|structure|analysis|style|lyrics|form|theme/i;
const MAX_THEORY_SENTENCES = 3;
const MAX_THEORY_CHARS = 450;

/** The article's sentences on how the music is built, from its Composition or Structure sections. */
export function theorySentences(full: string): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const [, heading, body] of full.matchAll(/\n==+\s*([^=\n]+?)\s*==+\n([\s\S]*?)(?=\n==|$)/g)) {
    if (!THEORY_HEADING.test(heading) || NOT_THE_MAKERS_HEADING.test(heading)) continue;
    for (const raw of body.split(/(?<=[.!?]["”]?)\s+(?=["“]?\p{Lu})|\n+/u)) {
      const text = raw.trim();
      if (text.length < 40 || text.length > 240 || !THEORY_CUE.test(text) || OPINION.test(text) || cutOff(text)) continue;
      if (kept.length >= MAX_THEORY_SENTENCES || used + text.length > MAX_THEORY_CHARS) return kept;
      kept.push(text);
      used += text.length + 1;
    }
  }
  return kept;
}

/** A section about the music video, or what's worn in it. Not "video game". */
const VIDEO_HEADING = /\b(?:videos?(?!\s*games?)|fashion|visuals?)\b/i;

/**
 * The article without its music-video sections and their subsections (plot,
 * production, fashion). Told as facts, a video's story reads as if it
 * happened ("Papa Emeritus III takes a paper from a hawker"), and a shoot's
 * details as if they were the recording's ("wore a Gucci bathing suit").
 */
export function withoutVideoSections(full: string): string {
  const out: string[] = [];
  let skipBelow = 0; // Skipping while inside a video section of this level.
  for (const line of full.split("\n")) {
    const h = /^(==+)\s*(.+?)\s*==+\s*$/.exec(line);
    if (h) {
      const level = h[1].length;
      if (skipBelow && level > skipBelow) continue;
      skipBelow = VIDEO_HEADING.test(h[2]) ? level : 0;
      if (skipBelow) continue;
    } else if (skipBelow) continue;
    out.push(line);
  }
  return out.join("\n");
}

/** Cut text back to its last whole sentence, so the model never copies half of one. */
function wholeSentences(text: string): string {
  if (/[.!?]["”)]?$/.test(text)) return text;
  const end = Math.max(text.lastIndexOf(". "), text.lastIndexOf('." '), text.lastIndexOf(".\n"));
  // Only when little is lost: text with few sentence breaks is left as it is.
  return end > text.length * 0.7 ? text.slice(0, end + 1) : text;
}

/**
 * `ownArticle` is false when the article is about the whole game or the
 * artist, not this song: then only what's plainly about the music is lifted,
 * and no reception, which would be the game's or the artist's, not the song's.
 */
export function orderExtract(full: string, budget: number, names: string[] = [], ownArticle = true, primaryHeading: RegExp = MUSIC_HEADING): string {
  full = withoutVideoSections(full);
  // What the makers said goes first: it's the part worth retelling, and a small model reads the top best.
  const color = creatorSentences(full, names, ownArticle);
  const theory = ownArticle ? theorySentences(full).filter((s) => !color.includes(s)) : [];
  const received = ownArticle ? receptionSentences(full).filter((s) => !color.includes(s) && !theory.includes(s)) : [];
  const colorBlock = [
    color.length ? `From the people who made it: ${color.join(" ")}` : "",
    theory.length ? `How the music is built: ${theory.join(" ")}` : "",
    received.length ? `How it was received: ${received.join(" ")}` : "",
  ].filter(Boolean).join("\n\n");
  if (colorBlock) budget = Math.max(0, budget - colorBlock.length - 2);
  const primary: string[] = [];
  const secondary: string[] = [];
  // A subsection inherits the bucket of the section it sits under.
  let parent: { level: number; bucket: string[] | null } = { level: 0, bucket: null };
  for (const [, marks, heading, body] of full.matchAll(/\n(==+)\s*([^=\n]+?)\s*==+\n([\s\S]*?)(?=\n==|$)/g)) {
    const level = marks.length;
    let bucket = primaryHeading.test(heading) ? primary : BACKGROUND_HEADING.test(heading) ? secondary : null;
    if (level > parent.level && parent.bucket) bucket ??= parent.bucket;
    else parent = { level, bucket };
    if (bucket && body.trim()) bucket.push(`${heading}: ${body.trim()}`);
  }

  const lead = wholeSentences(full.split(/\n==/)[0].trim().slice(0, Math.floor(budget * 0.35)));
  const rest = wholeSentences([...primary, ...secondary].join("\n\n").slice(0, Math.max(0, budget - lead.length - 2)));
  return [colorBlock, rest, lead].filter(Boolean).join("\n\n");
}

/** The article's full plain text, or null for a disambiguation page. */
async function wikiExtract(pageTitle: string): Promise<string | null> {
  // exsectionformat=wiki keeps the "==" headings orderExtract relies on.
  const data = await wikiGet<{ query?: { pages?: Record<string, { extract?: string }> } }>(
    `action=query&prop=extracts&explaintext=1&exsectionformat=wiki&titles=${encodeURIComponent(pageTitle)}`,
    config.groundingExtractTimeoutMs,
    "extract"
  );
  const full = Object.values(data.query?.pages ?? {})[0]?.extract;
  if (full) rememberArticle(pageTitle, full);
  return full && !/may refer to:/i.test(full.slice(0, 200)) ? full : null;
}

// --- Does the article fit the request? -----------------------------------

/**
 * Articles read recently, whole, by title. A reference is cut down to a few
 * thousand characters; whether it fits the request is judged on the whole
 * article: its opening, and every name it mentions.
 */
const articleTexts = new Map<string, string>();
const MAX_ARTICLE_TEXTS = 40;

export function rememberArticle(page: string, full: string): void {
  articleTexts.delete(page);
  articleTexts.set(page, full);
  if (articleTexts.size > MAX_ARTICLE_TEXTS) articleTexts.delete(articleTexts.keys().next().value as string);
}

/** An article's whole text, when it was read this session, or "". */
export function articleText(page: string): string {
  const known = articleTexts.get(page);
  if (known) return known;
  // A game's articles are kept for all its tracks, longer than the list above.
  for (const a of gameArticles.values()) {
    if (a.page === page) return a.full;
    if (a.music?.page === page) return a.music.full;
  }
  return "";
}

/**
 * What an article's opening says its subject is, when that is something a
 * song can come from or be: a song, a record, a performer, a composer, a
 * soundtrack, a game, a film or a show. "Jezebel was a Phoenician princess"
 * and "YouTube is an online video-sharing platform" are neither, and facts
 * written from them are true but about the wrong thing.
 */
const MUSIC_OR_WORK =
  /\b(songs?|singles?|albums?|EPs?|mixtapes?|records?|recordings?|bands?|groups?|duo|trio|quartet|singers?|singer-songwriters?|rappers?|musicians?|composers?|pianists?|guitarists?|drummers?|bassists?|violinists?|cellists?|organists?|songwriters?|DJs?|disc jockey|producers?|vocalists?|lyricists?|conductors?|orchestras?|ensembles?|choirs?|idols?|YouTuber|entertainers?|performers?|soundtracks?|scores?|instrumentals?|compositions?|pieces?|suites?|sonatas?|symphon(?:y|ies)|concert[oi]s?|operas?|operettas?|ballets?|musicals?|hymns?|anthems?|ballads?|carols?|march(?:es)?|waltz(?:es)?|rhapsod(?:y|ies)|[eé]tudes?|nocturnes?|preludes?|fugues?|serenades?|overtures?|requiems?|cantatas?|arias?|tunes?|melod(?:y|ies)|tangos?|games?|films?|movies?|television|TV|series|shows?|sitcoms?|anime|manga|novels?|franchises?)\b/i;

/** The article's opening: its first two sentences, or its first 400 characters. */
function openingOf(full: string): string {
  const lead = full.split(/\n==/)[0].trim();
  const sentences = lead.split(/(?<=[.!?])\s+(?=\p{Lu})/u);
  return sentences.slice(0, 2).join(" ").slice(0, 400);
}

/** Whether an article's opening says it is about music, a performer, a game, a film or a show. */
export function opensAboutMusicOrWork(full: string): boolean {
  return MUSIC_OR_WORK.test(openingOf(full));
}

/** Words in a bracket or a subtitle that name nothing in particular. */
const GENERIC_NAME_WORDS = new Set([
  "theme", "themes", "main", "opening", "ending", "op", "ed", "no", "ost", "original", "song", "music", "track", "bgm",
  "intro", "outro", "edit", "mix", "version", "from", "the", "of", "a", "an", "and", "in", "on", "s", "free", "full",
]);

/**
 * Names the request gives that its article has to mention: the character a
 * bracket says the theme is for ("Killer (Yoshikage Kira's Theme)") and the
 * subtitle of the work in the artist field ("Star Wars: Rogue One"). Each
 * comes back normalized, generic words dropped.
 */
export function requestNames(song: SSLSong): string[] {
  const out: string[] = [];
  const add = (raw: string) => {
    const words = normalizeTitle(raw.replace(/['’]s\b/g, "")).split(" ").filter((w) => w && !GENERIC_NAME_WORDS.has(w) && !/^\d+$/.test(w));
    if (words.join("").length >= 4) out.push(words.join(" "));
  };
  // Only a bracket naming whose theme it is: "(Wild Canyon)" is a stage the game's article may never name.
  for (const m of song.title.matchAll(/[([]([^)\]]{2,})[)\]]/g)) {
    const whose = /^(.+?)['’]s\s+(?:theme|song|motif)$/i.exec(m[1].trim())?.[1] ?? /^(?:theme|motif) (?:of|for) (.+)$/i.exec(m[1].trim())?.[1];
    if (whose) add(whose);
  }
  // A person's article needn't name a translated title: "Debajo Las Estrellas (Under The Stars)".
  const artist = (song.artist ?? "").trim();
  const subtitle = /^[^:]{2,}:\s*(.{3,})$/.exec(artist)?.[1];
  if (subtitle && !looksLikeArtistName(artist)) add(subtitle);
  return [...new Set(out)];
}

/** Requests that are a slot in the queue, not a song: "Off-List YouTube Request < 5 Min (Free)". */
const PLACEHOLDER_TITLE = /\boff[- ]?list\b|<\s*\d+\s*min|\(\s*free\s*\)|\b(?:yt|youtube|song|any|open|custom|viewers?['’]?s?|paid|free)\s+requests?\b/i;
const PLACEHOLDER_ARTIST = /^(?:youtube|yt|twitch|spotify|requests?|off[- ]?list|tbd|various|n\/?a)$/i;

/** Whether a request is a placeholder for whatever a viewer asks for, rather than a song. */
export function isPlaceholderRequest(song: SSLSong): boolean {
  return PLACEHOLDER_TITLE.test(song.title) || PLACEHOLDER_ARTIST.test((song.artist ?? "").trim());
}

/**
 * Why a found reference doesn't fit the request, or "" when it does. The
 * whole article is read when it was fetched this session; otherwise only
 * the reference itself.
 * - Its opening must say it is about music, a performer, a game, a film or a show.
 * - Each name in the request's brackets or subtitle must be in the article, unless the
 *   artist is a person: then a bracket may be a translation or the film it's from.
 */
export function articleMisfit(song: SSLSong, text: string): string {
  const page = text.split("\n")[0];
  const full = articleText(page);
  if (full && !opensAboutMusicOrWork(full)) return "doesn't open like an article about a song, a performer or a work";
  const own = page.replace(/\s*\([^)]*\)\s*$/, "");
  const haystack = ` ${normalizeTitle(own)} ${normalizeTitle(full || text)} `;
  // "Reprise (Spirited Away)" by Joe Hisaishi: for a person's piece, the bracket may be a film, a translation or a nickname.
  if (looksLikeArtistName((song.artist ?? "").trim())) return "";
  const missing = requestNames(song).find((name) => !haystack.includes(` ${name} `));
  return missing ? `never mentions "${missing}"` : "";
}

/** Reference text for the song, or "" when no relevant article exists. */
/** Game tracks already found to have no article of their own. */
const noOwnArticle = new Set<string>();

/**
 * A game's article and, when Wikipedia has one, its music article ("Music of
 * Final Fantasy VIII", "Undertale Soundtrack"). Kept whole, so each of the
 * game's tracks gets a reference built around that track without another
 * download (issue #48).
 */
export interface GameArticles {
  page: string;
  full: string;
  /** `series`: about the whole series, so only used for a track it names. */
  music: { page: string; full: string; series?: boolean } | null;
}
const gameArticles = new Map<string, GameArticles>();

/** Track names too common to search an article for: every game has a "Title Theme". */
const GENERIC_TRACK = /^(opening|ending|theme|main theme|title|title theme|title screen|credits|intro|menu|boss|battle|overworld|prologue|epilogue|finale|stage \d+|level \d+|act \d+|\d+ ?[ap]m)$/i;
const MAX_TRACK_SENTENCES = 4;
const MAX_TRACK_CHARS = 800;

/** The article's sentences that name this track: the only ones certainly about it. */
export function trackSentences(full: string, track: string): string[] {
  const name = normalizeTitle(track);
  if (name.length < 5 || GENERIC_TRACK.test(name)) return [];
  const kept: string[] = [];
  let used = 0;
  for (const raw of full.split(/(?<=[.!?]["”]?)\s+(?=["“]?\p{Lu})|\n+/u)) {
    const text = raw.trim();
    if (text.length < 30 || text.length > 320 || /^=+/.test(text) || brokenBySplit(text)) continue;
    if (!mentionsName(normalizeTitle(text), [name])) continue;
    if (kept.length >= MAX_TRACK_SENTENCES || used + text.length > MAX_TRACK_CHARS) break;
    kept.push(text);
    used += text.length + 1;
  }
  return kept;
}

/** Whether a title is the music article for this game or its series. */
export function isMusicArticleFor(title: string, game: string): boolean {
  const g = normalizeTitle(game);
  const of = /^Music of (?:the )?(.+?)(?: series)?$/i.exec(title);
  if (of) {
    const subject = normalizeTitle(of[1]);
    // The game itself, or the series it belongs to: "Sonic the Hedgehog" for "Sonic the Hedgehog 3".
    return subject.length >= 2 && (g === subject || g.startsWith(`${subject} `));
  }
  const album = /^(.+?)(?: Original)? Soundtrack$|^(.+?) \(soundtrack\)$/i.exec(title);
  return Boolean(album && normalizeTitle(album[1] ?? album[2]) === g);
}

/** Whether a music article is about this very game, not the series it belongs to. */
const isThisGames = (title: string, game: string) =>
  normalizeTitle(title.replace(/^Music of (?:the )?/i, "").replace(/ series$| (?:Original )?Soundtrack$| \(soundtrack\)$/i, "")) === normalizeTitle(game);

/**
 * The game's music article, or null. One search. The game's own article is
 * taken as it is; a series-wide one ("Music of the Final Fantasy series")
 * only when it names this track, since most of it is about other games.
 */
async function findMusicArticle(game: string, usable: (title: string) => boolean): Promise<GameArticles["music"]> {
  const fits = (t: string) => usable(t) && isMusicArticleFor(t, game);
  let titles = (await wikiSearch(`Music of ${game}`)).filter(fits);
  if (!titles.length) titles = (await wikiSearch(`${game} soundtrack`)).filter(fits);
  // The game's own article first, then its series'.
  for (const page of [...titles.filter((t) => isThisGames(t, game)), ...titles.filter((t) => !isThisGames(t, game))].slice(0, 2)) {
    const full = await wikiExtract(page);
    if (!full || full.length < MIN_CONTEXT_CHARS) continue;
    // "Sonic the Hedgehog (soundtrack)" is the 2020 film's album, not the game's music.
    const lead = full.slice(0, 500);
    if (/\b(film|movie|television series|TV series)\b/i.test(lead) && !/\bvideo games?\b/i.test(lead)) continue;
    return { page, full, series: !isThisGames(page, game) };
  }
  return null;
}

/** Section headings that are a kind of section, not the name of a part of a soundtrack. */
const GENERIC_SECTION =
  /^(?:background|development|composition|production|recording|releases?|reception|critical|commercial|legacy|references|notes|external|see also|track listings?|personnel|credits|charts?|certifications?|awards?|accolades|overview|history|music|soundtracks?|albums?|singles|eps|other|musicology|instrumentation|motifs?|themes?|style|influences?|bibliography|further|sales|live|concerts?|creation|concept|writing|lyrics|cast|plot|synopsis|gameplay|setting|story|characters|marketing|reviews?|impact|cover|versions?|remix(?:es)?|formats?|editions?|arrangements?)\b/i;

/** The sections of an article: heading, level, and the lines it runs over, subsections included. */
function sectionsOf(lines: string[]): Array<{ heading: string; quoted: boolean; level: number; from: number; to: number }> {
  const heads = lines.flatMap((line, i) => {
    const h = /^(==+)\s*(.+?)\s*==+\s*$/.exec(line);
    const quoted = h ? /^["“].*["”]$/.test(h[2]) : false;
    return h ? [{ heading: h[2].replace(/^["“](.*)["”]$/, "$1"), quoted, level: h[1].length, from: i, to: lines.length }] : [];
  });
  for (const [n, h] of heads.entries()) {
    const next = heads.slice(n + 1).find((o) => o.level <= h.level);
    if (next) h.to = next.from;
  }
  return heads;
}

/**
 * The part of a soundtrack article a track belongs to, when the track names
 * it: "Fontaine: Remuria" is from the Fontaine section of "Music of Genshin
 * Impact". Returns the article cut to its lead and that section, and the
 * article's other parts ("Mondstadt", "Liyue"), which a caption for this track
 * must not name. Null unless the track names one part and the article has at
 * least two others.
 */
export function soundtrackPart(full: string, track: string): { heading: string; text: string; others: string[] } | null {
  const lines = withoutVideoSections(full).split("\n");
  const parts = sectionsOf(lines).filter((s) => !GENERIC_SECTION.test(s.heading) && s.heading.split(/\s+/).length <= 5);
  const name = ` ${normalizeTitle(track)} `;
  const matched = parts
    .filter((s) => normalizeTitle(s.heading).length >= 4 && name.includes(` ${normalizeTitle(s.heading)} `))
    .sort((a, b) => b.heading.length - a.heading.length)[0];
  if (!matched) return null;
  // Its own subsections and the sections it sits in aren't other parts.
  // A quoted heading is one track ("Main Theme"), which any part's caption may mention.
  const others = parts.filter((s) => !s.quoted && !(s.from >= matched.from && s.to <= matched.to) && !(s.from <= matched.from && s.to >= matched.to));
  if (others.length < 2) return null;
  const lead = lines.slice(0, lines.findIndex((l) => /^==/.test(l))).join("\n").trim();
  const section = lines.slice(matched.from, matched.to).join("\n");
  return { heading: matched.heading, text: `${lead}\n\n${section}`, others: [...new Set(others.map((s) => s.heading))] };
}

/** The other parts of the soundtrack a reference was cut from, which captions for this track mustn't name. */
export function otherParts(text: string, track: string): string[] {
  const full = articleText(text.split("\n")[0]);
  return full ? (soundtrackPart(full, track)?.others ?? []) : [];
}

/** Any section that isn't a list of tracks, credits or references. */
const NOT_A_LIST = /^(?!.*(track listing|personnel|credits|chart|certification|reference|external|see also|notes)).+$/i;
/** In a music article, how the music was made comes before the lists of albums and releases. */
const MAKING_OF_MUSIC = /creation|development|concept|influence|composition|writing|recording|background|overview|production|style|themes/i;

/**
 * The reference for one track of a game: what the article says about this
 * very track first, then the usual ordering. Built from the music article
 * when there is one, since the game's article is mostly about the game.
 */
export function gameTrackText(a: GameArticles, track: string, usable: (title: string) => boolean = () => true): string {
  const fits = a.music && usable(a.music.page) && (!a.music.series || trackSentences(a.music.full, track).length > 0);
  const base = fits && a.music ? a.music : a;
  // "Liyue: Relaxation in Liyue" from "Music of Genshin Impact": the lead and the Liyue section, nothing about Mondstadt.
  const part = soundtrackPart(base.full, track);
  const full = part ? part.text : withoutVideoSections(base.full);
  const about = trackSentences(full, track);
  const block = about.length ? `About this piece: ${about.join(" ")}\n\n` : "";
  const budget = MAX_CONTEXT_CHARS - base.page.length - 1 - block.length;
  if (part) return `${base.page}\n${block}${orderExtract(full, budget, [track], true, NOT_A_LIST)}`;
  let body = orderExtract(base.full, budget, [track], base !== a, base !== a ? MAKING_OF_MUSIC : MUSIC_HEADING);
  // A music article with no section on how the music was made: take its other sections, bar the lists.
  if (base !== a && body.length < MIN_CONTEXT_CHARS * 2) body = orderExtract(base.full, budget, [track], true, NOT_A_LIST);
  return `${base.page}\n${block}${body}`;
}

// --- Other readings of a request -----------------------------------------

/**
 * One way to look a request up: the subject (`game`: a game, film, show,
 * series or artist) and the piece (`track`).
 * - `songAlone`: a song by no one in particular, looked up by its title alone.
 * - `notGame`: the subject is a film or a show, never a video game.
 * - `trackOnly`: only the piece's own article will do, never the subject's:
 *   the name may be an arranger's or a fellow musician's.
 * - `page`: Wikipedia said which article the subject's name means; no other
 *   article about the subject will do.
 */
export interface Reading {
  game: string;
  track: string;
  page?: string;
  songAlone?: boolean;
  notGame?: boolean;
  trackOnly?: boolean;
}

/** An artist field naming a kind of work: "Star Trek TV", "NieR Series", "Super Mario Franchise". */
const CATEGORY_ARTIST = /^(.+?)\s+(series|franchise|games|tv|tv series|tv shows?|movies|films)$/i;
/** Films and shows: their works are never video games. */
const SCREEN_CATEGORY = /^(tv|tv series|tv shows?|movies|films)$/i;
/** Artist fields that name no one: "Traditional", "Italian Folk Song", "Anonymous". */
const NO_ONE = /^(?:traditional|trad\.?|anonymous|anon\.?|unknown|(?:\p{L}+\s+)?folk(?:\s+(?:song|tune|melody))?)$/iu;
/** "Elton John arr. Brent Edstrom", "Arr. Handel Halvorsen": who arranged a piece isn't who wrote it. */
const ARRANGER = /^\s*arr(?:\.|anged by)?\s+|\s+(?:arr(?:\.|anged by)?|arrangement by)\s+.*$/i;
/** Words naming a work's music rather than the work: "Picard Season 1 Theme". */
const THEME_WORDS = /\s+((?:season\s+\d+\s+)?(?:(?:main|opening|ending|end|title|love)\s+)?theme)$/i;

/**
 * "Star Trek II. The Wrath of Khan: Battle At The Mutara Nebula" from "Star
 * Trek Movies": the work is in the title. The title read whole as the work
 * (theme words dropped), then split at a dash or a second colon.
 */
function worksInTitle(franchise: string, title: string, notGame: boolean): Reading[] {
  const m = new RegExp(`^${escapeRe(franchise)}(?=[\\s:])(.*)$`, "i").exec(title);
  if (!m) return [];
  // "II. The Wrath of Khan" is "II: The Wrath of Khan". A tag in brackets names the arrangement, not the work.
  const rest = m[1].replace(/^\s+([IVXL]+|\d+)\.\s+/i, " $1: ").replace(/\s*\[[^\]]*\]\s*$/, "");
  const whole = (franchise + rest).trim();
  const out: Reading[] = [];
  const add = (work: string, track: string) => {
    let w = work.trim();
    let t = track.trim();
    const theme = THEME_WORDS.exec(w);
    if (theme) {
      w = w.slice(0, theme.index);
      t ||= theme[1].replace(/^season\s+\d+\s+/i, "");
    }
    w = w.replace(/\s+season\s+\d+$/i, "").replace(/\s*[-–—:]$/, "").trim();
    // Without a track name of its own, the work's music is "Theme": generic, so nothing in the
    // work's article is taken to be about this one piece.
    if (w && !out.some((r) => r.game === w)) out.push({ game: w, track: t || "Theme", notGame });
  };
  add(whole, "");
  const split = /^(.+?)\s[-–—]\s(.+)$/.exec(whole) ?? /^(.+?:.+?):\s*(.+)$/.exec(whole);
  if (split) add(split[1], split[2]);
  return out;
}

/**
 * The ways to look a request up, most likely first. Usually just the one
 * `resolveGameAndTrack` gives. Song lists also write:
 * - a category for the artist ("Star Trek TV", "NieR Series"): the work named
 *   in the title, then the franchise's own article, never a single installment;
 * - an arranger or a second name ("Elton John arr. Brent Edstrom",
 *   "Frederic Chopin/ButtonPresser7"): each name on its own;
 * - no one ("Traditional", "Italian Folk Song"): the title alone, as a song.
 */
export function readings(song: SSLSong): Reading[] {
  const artist = song.artist?.trim() ?? "";
  const first = resolveGameAndTrack(song);
  if (song.performer || song.artistUncertain) return [first];
  const title = dropVersionTags(song.title.trim());

  const category = CATEGORY_ARTIST.exec(artist);
  if (category) {
    const franchise = category[1];
    const notGame = SCREEN_CATEGORY.test(category[2]);
    const inTitle = worksInTitle(franchise, title, notGame);
    // "Wild World - The Roost" from "Animal Crossing Series" is from "Animal Crossing: Wild World".
    const sep = /^(.+?)\s*(?::|\s[-–—]\s)\s*(.+)$/.exec(title);
    const installment = !inTitle.length && sep ? [{ game: `${franchise}: ${sep[1]}`, track: sep[2], notGame }] : [];
    // "Aquatic Ambiance (Donkey Kong Country)" from "Super Mario Franchise": a name in brackets
    // may be the game it's really from, so the franchise's article could be the wrong one.
    const series = /\([^)]*\)\s*$/.test(title) ? [] : [{ game: `${franchise} series`, track: title, notGame }];
    return [...inTitle, ...installment, ...series];
  }

  if (NO_ONE.test(artist)) {
    // "Unknown" has long meant "read the title": that comes first.
    return [...(/^unknown$/i.test(artist) ? [first] : []), { game: "", track: title, songAlone: true }];
  }

  const names = [...new Set(artist.split(/\s*\/\s*/).map((p) => p.replace(ARRANGER, "").trim()).filter(Boolean))];
  const others = names.filter((n) => n.toLowerCase() !== artist.toLowerCase());
  return [
    first,
    ...others.map((name) => ({
      ...resolveGameAndTrack({ ...song, artist: name }),
      // One of several names may be anyone's: only an artist's name is looked up on its own.
      trackOnly: names.length > 1 && !looksLikeArtistName(name),
    })),
  ];
}

/** Edit distance: how many letters to add, drop or change to turn one string into the other. */
export function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** Installment numbers in a title, roman numerals as arabic: "Star Trek II" has 2. */
const numerals = (s: string) => significantTokens(normalizeTitle(s)).filter((t) => /\d/.test(t));

/**
 * The same name spelled differently: a letter or two, in one word, or only
 * the spacing ("Full Metal" and "Fullmetal"). "Eric Satie" and "Erik Satie",
 * but not "Windy Harper" and "Wendy Harmer", two words apart.
 */
export function isRespelling(name: string, page: string): boolean {
  const a = normalizeTitle(name);
  const b = normalizeTitle(page);
  if (!a || !b || a === b) return false;
  const d = editDistance(a.replace(/ /g, ""), b.replace(/ /g, ""));
  if (d > 2 || d > a.replace(/ /g, "").length * 0.2) return false;
  if (numerals(name).join(" ") !== numerals(page).join(" ")) return false;
  const wa = a.split(" ");
  const wb = b.split(" ");
  if (wa.length !== wb.length) return d === 0;
  return wa.filter((w, i) => w !== wb[i]).length <= 1;
}

/**
 * Whether a redirect leads to the same thing under its proper name: "Star Wars:
 * The Phantom Menace" to "Star Wars: Episode I – The Phantom Menace", "Red
 * Alert 3" to "Command & Conquer: Red Alert 3". Not to a list, an album or
 * one of several: "Johann Strauss" leads to "Johann Strauss II", and "Honkai
 * Impact" to "Honkai Impact 3rd". A number the request didn't give is only
 * accepted inside the name ("Episode I"), never as its last word.
 */
export function isSameWorkRedirect(from: string, to: string): boolean {
  if (/^List of\b/i.test(to) || /\((?:[^)]*\b)?(album|soundtrack|EP|discography|filmography)\)$/i.test(to)) return false;
  // "Poirot" leads to "Hercule Poirot" and "Ponce de León" to "Juan Ponce de León": a surname
  // given a first name is one person of that name. A title before a colon is a series name:
  // "Red Alert 3" in "Command & Conquer: Red Alert 3".
  const f = normalizeTitle(from);
  const t = normalizeTitle(to);
  if (t.endsWith(` ${f}`)) {
    const head = to.replace(/\s*\([^)]*\)\s*$/, "");
    if (!/[:–—]\s*$/.test(head.slice(0, Math.max(0, head.length - from.length)))) return false;
  }
  const fromNumbers = numerals(from);
  const toWords = significantTokens(normalizeTitle(to));
  if (/\d/.test(toWords[toWords.length - 1] ?? "") && !fromNumbers.includes(toWords[toWords.length - 1])) return false;
  const fromWords = new Set(significantTokens(normalizeTitle(from)).filter((t) => !/\d/.test(t)));
  return significantTokens(normalizeTitle(to)).some((t) => fromWords.has(t)) || isRespelling(from, to);
}

const wikipediaNames = new Map<string, string | null>();

/**
 * A series' own article, as Wikipedia files it: "Kirby (series)", "Nier
 * (series)" (which leads to "Drakengard and Nier"), "Star Trek (franchise)"
 * (which leads to "Star Trek"). Null when it has none under these titles.
 */
async function seriesPage(name: string): Promise<string | null> {
  const key = `\0series\0${name}`;
  const known = wikipediaNames.get(key);
  if (known !== undefined) return known;
  // Titles are case-sensitive: "NieR" is filed as "Nier".
  const cased = name.replace(/\p{L}+/gu, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  const forms = [...new Set([name, cased])].flatMap((n) => ["series", "franchise", "media franchise"].map((q) => `${n} (${q})`));
  const resolved = await wikiResolveTitles(forms);
  let found: string | null = null;
  for (const f of forms) {
    const hit = resolved.get(f);
    // "(series)" already says which: a series filed under a longer name still shares its name's words.
    const shares = significantTokens(normalizeTitle(hit?.page ?? "")).some((w) => significantTokens(normalizeTitle(name)).includes(w));
    if (hit && !hit.fragment && !/^List of\b/i.test(hit.page) && (!hit.redirected || shares)) {
      found = hit.page;
      break;
    }
  }
  wikipediaNames.set(key, found);
  return found;
}

/**
 * Wikipedia's own name for a name it files under another one, or null. Its
 * help, not ours: a redirect with that exact title ("Pirates of the Carribean"),
 * else the search's spelling suggestion ("Genshsin Impact" -> "genshin
 * impact"), taken only when it is a respelling, names an article, and that
 * article was among the search's hits (or the search found nothing at all).
 */
async function wikipediaName(name: string): Promise<string | null> {
  if (normalizeTitle(name).length < 3) return null;
  const known = wikipediaNames.get(name);
  if (known !== undefined) return known;
  let found: string | null = null;
  // Titles are case-sensitive: "Manuel da Falla", not "Manuel Da Falla".
  const lowered = name.replace(/(?<=\s)\p{Lu}\p{Ll}{0,2}(?=\s|$)/gu, (w) => w.toLowerCase());
  const variants = [...new Set([name, lowered])];
  const direct = await wikiResolveTitles(variants);
  for (const v of variants) {
    const hit = direct.get(v);
    if (hit?.redirected && !hit.fragment && isSameWorkRedirect(name, hit.page)) {
      found = hit.page;
      break;
    }
  }
  // A page or redirect with this very name: Wikipedia knows it, so it isn't misspelled.
  if (!found && !direct.size) {
    const { titles, suggestion } = await wikiSearchSuggestion(name);
    const wanted = normalizeTitle(name);
    if (suggestion && !titles.some((t) => normalizeTitle(t) === wanted)) {
      const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
      // The suggestion comes in lowercase: cased like the request's words first ("Pirates of the Caribbean").
      const words = name.split(/\s+/);
      const asWritten = suggestion.split(" ").map((w, i) => (/^\p{Lu}/u.test(words[i] ?? "") ? upper(w) : w)).join(" ");
      const forms = [...new Set([upper(asWritten), upper(suggestion), suggestion.split(" ").map(upper).join(" ")])];
      const resolved = await wikiResolveTitles(forms);
      for (const f of forms) {
        const hit = resolved.get(f);
        if (hit && !hit.fragment && isRespelling(name, hit.page) && (!titles.length || titles.includes(hit.page))) {
          found = hit.page;
          break;
        }
      }
    }
  }
  wikipediaNames.set(name, found);
  if (found) console.log(`[Grounding] Wikipedia calls "${name}" "${found}"`);
  return found;
}

/**
 * The song's own article, read for a reference. When its sections have names
 * the usual ordering doesn't look for ("Origin", "Form"), it would keep little
 * more than the lead: then every section but the lists is read instead.
 */
function ownArticleExtract(full: string, budget: number, names: string[]): string {
  const extract = orderExtract(full, budget, names);
  return extract.length >= MIN_CONTEXT_CHARS ? extract : orderExtract(full, budget, names, true, NOT_A_LIST);
}

/** What a song is, in its article's opening: "a traditional English folk song". */
const A_SONG = /\b(song|ballad|hymn|carol|tune|melody|lullaby|anthem|folk ?song|canzone|chanson)s?\b/i;

/**
 * A song by no one in particular ("Traditional", "Italian Folk Song"): its
 * own article, found by its title alone, and only when the article opens by
 * calling it a song. "Santa Lucia" is also a town and a saint.
 */
async function groundSongAlone(song: SSLSong, title: string, usable: (title: string) => boolean): Promise<Grounded> {
  const key = `\0alone\0${normalizeTitle(title)}`;
  const hit = groundingCache.get(key);
  if (hit && (hit.text || Date.now() - hit.at < NEGATIVE_TTL_MS) && (!hit.text || usable(hit.text.split("\n")[0]))) return { text: hit.text, unreachable: false };
  const tried = new Set<string>();
  try {
    for (const term of [`${title} song`, title]) {
      const titles = (await wikiSearch(term)).filter((t) => usable(t) && !tried.has(t) && isRelevantArticle(title, t));
      // "Santa Lucia (song)" before "Santa Lucia".
      for (const page of [...titles.filter((t) => /\((?:[^)]*\b)?song\)$/i.test(t)), ...titles.filter((t) => !/\((?:[^)]*\b)?song\)$/i.test(t))]) {
        tried.add(page);
        const full = await wikiExtract(page);
        if (!full || !A_SONG.test(full.slice(0, 300))) {
          console.log(`[Grounding] "${page}" isn't about a song, skipping`);
          continue;
        }
        const extract = ownArticleExtract(full, MAX_CONTEXT_CHARS - page.length - 1, [title]);
        if (extract.length < MIN_CONTEXT_CHARS) continue;
        const text = `${page}\n${extract}`;
        console.log(`[Grounding] "${song.title}" -> ${page} (${extract.length} chars, the song by its title alone)`);
        groundingCache.set(key, { text, at: Date.now() });
        return { text, unreachable: false };
      }
    }
  } catch (err) {
    if (err instanceof RateLimited) return { text: "", unreachable: true };
    console.warn(`[Grounding] Lookup failed for "${title}": ${err instanceof Error ? err.message : err}`);
    return { text: "", unreachable: true };
  }
  console.log(`[Grounding] No reference for "${song.title}" by its title alone`);
  groundingCache.set(key, { text: "", at: Date.now() });
  return { text: "", unreachable: false };
}

interface Grounded {
  text: string;
  /** Throttled or unreachable: the miss says nothing, so no other reading is tried. */
  unreachable: boolean;
}

/**
 * Reference text for the song, or "" when no relevant article exists.
 * `skip`: articles already found not to fit this request (`articleMisfit`), passed over like blocked ones.
 */
export async function fetchGrounding(song: SSLSong, skip: ReadonlySet<string> = new Set()): Promise<string> {
  // Articles the streamer marked wrong for this song are never used for it again.
  const blocked = new Set([...blockedArticles(song), ...skip]);
  const usable = (title: string) => !blocked.has(title);
  const tried = new Set<string>();
  const attempt = async (reading: Reading): Promise<Grounded> => {
    const key = `${reading.songAlone ? "alone" : ""}\0${normalizeTitle(reading.game)}\0${normalizeTitle(reading.track)}`;
    if (tried.has(key)) return { text: "", unreachable: false };
    tried.add(key);
    if (tried.size > 1) console.log(`[Grounding] "${song.title}": trying ${reading.songAlone ? "the title alone" : `"${reading.track}" from "${reading.game}"`}`);
    return reading.songAlone ? groundSongAlone(song, reading.track, usable) : groundReading(song, reading, blocked);
  };
  for (let reading of readings(song)) {
    if (/ series$/.test(reading.game)) {
      try {
        const page = await seriesPage(reading.game.slice(0, -" series".length));
        if (page) reading = { ...reading, page };
      } catch (err) {
        if (err instanceof RateLimited) return "";
      }
    }
    const first = await attempt(reading);
    if (first.text || first.unreachable) return first.text;
    // Wikipedia's own name for what the request misspells or calls otherwise:
    // "Eric Satie" is "Erik Satie", "Star Wars: The Phantom Menace" is "Star Wars: Episode I – The Phantom Menace".
    if (reading.songAlone || reading.game.endsWith(" series") || song.performer || song.artistUncertain || !reading.game) continue;
    let { game, track } = reading;
    try {
      game = (await wikipediaName(game)) ?? game;
      // A piece by a composer or performer: "The Beautiful Blue Danube" is "The Blue Danube".
      if (track !== reading.game && looksLikeArtistName(game)) track = (await wikipediaName(track)) ?? track;
    } catch (err) {
      if (err instanceof RateLimited) return "";
      continue;
    }
    if (game === reading.game && track === reading.track) continue;
    // The renamed subject is the very page Wikipedia gave, not whatever a search for it finds:
    // "Pirates of the Caribbean" is the franchise, not "Pirates of the Caribbean (video game)".
    const renamed = await attempt({ ...reading, game, track, page: game === reading.game ? reading.page : game });
    if (renamed.text || renamed.unreachable) return renamed.text;
  }
  return "";
}

/** One reading of the request, looked up the usual way. */
async function groundReading(song: SSLSong, reading: Reading, blocked: Set<string>): Promise<Grounded> {
  const { game, track } = reading;
  // A subject pinned to one page is remembered apart: another song's search may have found another page for the name.
  const gameKey = normalizeTitle(game) + (reading.page ? `\0${reading.page}` : "");
  const songKey = `${gameKey}\0${normalizeTitle(track)}`;

  // A game's tracks share one lookup. An artist's songs never share: each may
  // have its own article. The artist test is a heuristic, and guessing
  // "artist" for a game only costs extra lookups, never wrong facts.
  // A music video's artist counts as one too (issue: "Muse - Starlight" must
  // search for Starlight, not reuse Muse's article cached for another song).
  const artist = looksLikeArtistName(game) || !!song.performer;
  const usable = (title: string) => !blocked.has(title);
  // A game's track with an article of its own ("Megalovania", "Baba Yetu") is
  // far richer than the game's article, so it's tried first: one search per
  // track, remembered either way (issue #48).
  // A generic name ("Theme") has no article of its own: "Theme from Star Trek" is another show's.
  const generic = GENERIC_TRACK.test(normalizeTitle(track));
  if (!artist && track && track !== game && !generic && !song.artistUncertain && !noOwnArticle.has(songKey) && !groundingCache.get(songKey)?.text) {
    try {
      const own = (await wikiSearch(`${track} ${game}`)).find(
        (t) => usable(t) && isRelevantArticle(track, t) && !qualifierNamesAnotherArtist(t, game, track, true)
      );
      const full = own ? await wikiExtract(own) : null;
      // It has to be an article about a piece of music: "Dragonborn" from Skyrim is also an expansion pack.
      const aboutMusic = full && /\b(song|theme|piece|composition|instrumental|track|single|anthem|aria|soundtrack)\b/i.test(full.slice(0, 400));
      const extract = full && aboutMusic && mentionsName(normalizeTitle(full), artistNames(game)) ? ownArticleExtract(full, MAX_CONTEXT_CHARS - own!.length - 1, [track, game]) : "";
      if (own && extract && extract.length >= MIN_CONTEXT_CHARS) {
        const text = `${own}\n${extract}`;
        console.log(`[Grounding] "${song.title}" -> ${own} (${extract.length} chars, the track's own article)`);
        groundingCache.set(songKey, { text, at: Date.now() });
        return { text, unreachable: false };
      }
      noOwnArticle.add(songKey);
    } catch {
      // Throttled or unreachable: the game's article below still serves, and this is tried again next time.
    }
  }
  const ownHit = groundingCache.get(songKey);
  if (!artist && ownHit?.text && usable(ownHit.text.split("\n")[0])) return { text: ownHit.text, unreachable: false };
  // A game already looked up: this track's reference is built from the kept articles.
  const kept = !song.performer && track !== game ? gameArticles.get(gameKey) : undefined;
  if (kept && usable(kept.page)) {
    const text = gameTrackText(kept, track, usable);
    groundingCache.set(songKey, { text, at: Date.now() });
    return { text, unreachable: false };
  }
  for (const key of artist ? [songKey] : [gameKey, songKey]) {
    const hit = key && groundingCache.get(key);
    if (hit && hit.text && !usable(hit.text.split("\n")[0])) continue;
    if (hit && (hit.text || Date.now() - hit.at < NEGATIVE_TTL_MS)) return { text: hit.text, unreachable: false };
  }

  // Which way an article matched decides how widely it may be shared. A
  // track article must not be attributed to another artist, and its text
  // must mention the game or artist: "Overture" alone is a generic article.
  // A music video's artist is a band or singer, never a game or film of the same name.
  // An artist that's only a guess from the uploader's channel is never looked up
  // as the subject: an uploader called "Apollo" isn't the god (issue from review).
  // "Ecco the Dolphin CD" is the game "Ecco the Dolphin": an edition word isn't part of its name.
  const edition = game.replace(/\s+(?:CD|HD|DX|Remastered|Remaster|Deluxe|Definitive Edition|Complete Edition)$/i, "");
  const matchedGame = (title: string) =>
    !song.artistUncertain &&
    // Only the piece's own article for a name that may be an arranger's or a fellow musician's.
    !reading.trackOnly &&
    // A film or a show is never a video game of the same name.
    !(reading.notGame && /\((?:[^)]*\b)?games?\b[^)]*\)\s*$/i.test(title)) &&
    // The page Wikipedia gave for the name, and only that one.
    (reading.page
      ? title === reading.page
      : isRelevantArticle(game, title, artist || !!song.performer) || (edition !== game && isRelevantArticle(edition, title, artist || !!song.performer))) &&
    !(song.performer && NOT_A_PERFORMER.test(title));
  // A longer title than the subject: "Final Fantasy" -> "Final Fantasy VII".
  const gameTokens = significantTokens(normalizeTitle(game)).length;
  const extendsGame = (title: string) => significantTokens(normalizeTitle(title)).length > gameTokens;
  const matchedTrack = (title: string) =>
    track !== game &&
    !generic && isRelevantArticle(track, title) && !qualifierNamesAnotherArtist(title, game, track);

  // "Lil Nas X, Jack Harlow": a song's article may name only its lead artist.
  const names = artistNames(game);
  const terms = song.artistUncertain && track !== game
    ? [track]
    : searchTerms(game, track, artist || !!song.performer, reading.notGame);
  // The page Wikipedia named is searched for by its own title; a series also by its bare name ("Star Trek").
  const series = /^(.+) (?:series|franchise)$/i.exec(game)?.[1];
  for (const extra of [reading.page, series]) {
    if (extra && !terms.includes(extra)) terms.splice(terms.includes(game) ? terms.indexOf(game) : terms.length, 0, extra);
  }
  // A music video's artist may share a name with a game or film; ask for the performer.
  if (song.performer && !looksLikeArtistName(game) && game.trim()) {
    const at = terms.indexOf(game);
    terms.splice(at < 0 ? terms.length : at, 0, `${game} band`);
  }
  let unreachable = "";

  for (const term of terms) {
    try {
      const titles = await wikiSearch(term);
      // For an artist, the song's own article beats the artist's, wherever it ranks:
      // "Industry Baby" over "Lil Nas X".
      // The same for a game's track that has an article of its own: "Megalovania" over "Undertale".
      // Among articles named for the track, the song's beats the album's: "Let It Be (song)" over "Let It Be (album)".
      const ofTrack = titles.filter((t) => usable(t) && matchedTrack(t));
      const page =
        ofTrack.find((t) => /\((?:[^)]*\b)?(song|composition|instrumental|theme)\)$/i.test(t)) ??
        ofTrack.find((t) => !/\((?:[^)]*\b)?(album|EP|soundtrack|film|musical)\)$/i.test(t)) ??
        ofTrack[0] ??
        titles.find((t) => usable(t) && matchedGame(t));
      if (!page) {
        if (titles.length) console.log(`[Grounding] No relevant match among: ${titles.join(", ")}`);
        continue;
      }
      const byGame = matchedGame(page);
      const full = await wikiExtract(page);
      // An installment or spin-off is only right when it's the song's own game: it must name the track.
      const installment = byGame && extendsGame(page) && track !== game && !reading.page;
      // A generic name ("Main Theme") is in every installment's article, so it names none of them.
      if (installment && full && (GENERIC_TRACK.test(normalizeTitle(track)) || !mentionsName(normalizeTitle(full), [normalizeTitle(track)]))) {
        console.log(`[Grounding] "${page}" never mentions "${track}", skipping`);
        continue;
      }
      // A performer's name alone can be an everyday word: "Milestone" is about road markers.
      if (byGame && song.performer && !/\(/.test(page) && full && !PERFORMER_LEAD.test(full.slice(0, 400))) {
        console.log(`[Grounding] "${page}" isn't about a performer, skipping`);
        continue;
      }
      // "Passacaglia (Handel/Halvorsen)" names its composers in its title.
      const qualifier = /\(([^)]*)\)\s*$/.exec(page)?.[1] ?? "";
      if (!byGame && full && !mentionsName(`${normalizeTitle(full)} ${normalizeTitle(qualifier)}`, names)) {
        console.log(`[Grounding] "${page}" never mentions "${game}", skipping`);
        continue;
      }
      // The song's own article, or one about the whole game or artist?
      const ownArticle = !byGame || track === game || matchedTrack(page);
      const extract = full && (ownArticle && !byGame
        ? ownArticleExtract(full, MAX_CONTEXT_CHARS - page.length - 1, [track, game])
        : orderExtract(full, MAX_CONTEXT_CHARS - page.length - 1, ownArticle ? [track, game] : [track], ownArticle));
      if (!extract || extract.length < MIN_CONTEXT_CHARS) {
        console.log(`[Grounding] "${page}" is too short to write from (${extract?.length ?? 0} chars)`);
        continue;
      }
      let text = `${page}\n${extract}`;
      // "Chrono Trigger" and "Kingdom Hearts" read like people's names, so the article decides: is it a game's?
      const aGame = !artist || /game\)$/i.test(page) || /\b(video|role-playing|platform|action|adventure|puzzle|rhythm|fighting|racing|strategy|simulation)[- ](?:[\w-]+ )?games?\b/i.test(full?.slice(0, 600) ?? "");
      if (byGame && aGame && !song.performer && !ownArticle && !installment && full) {
        let music: GameArticles["music"] = null;
        try {
          music = await findMusicArticle(game, usable);
        } catch {
          // Throttled or unreachable: the game's article serves on its own.
        }
        const articles = { page, full, music };
        // Shared by the game's tracks, unless this track has blocked articles of its own.
        if (!blocked.size) gameArticles.set(gameKey, articles);
        text = gameTrackText(articles, track, usable);
        if (music) console.log(`[Grounding] "${game}" has a music article: ${music.page}${music.series ? " (series-wide: used for tracks it names)" : ""}`);
      }
      console.log(`[Grounding] "${song.title}" -> ${text.split("\n")[0]} (${text.length} chars)`);
      // Shared by the game's tracks, unless this track has blocked articles of its own.
      groundingCache.set(byGame && !artist && !blocked.size && !installment ? gameKey : songKey, { text, at: Date.now() });
      return { text, unreachable: false };
    } catch (err) {
      unreachable = err instanceof RateLimited ? "rate-limited" : "lookup failed";
      if (!(err instanceof RateLimited)) {
        console.warn(`[Grounding] Lookup failed for "${term}": ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  console.log(
    `[Grounding] No reference for "${song.title}"` +
      (unreachable ? ` (${unreachable}, not cached)` : "") +
      ` — tried: ${terms.join(" | ")}`
  );
  // A miss caused by this song's blocked articles says nothing about the game's other tracks.
  if (!unreachable) groundingCache.set(artist || blocked.size ? songKey : gameKey, { text: "", at: Date.now() });
  return { text: "", unreachable: !!unreachable };
}

export function clearGroundingCache(): void {
  noOwnArticle.clear();
  wikipediaNames.clear();
  gameArticles.clear();
  groundingCache.clear();
}

// --- Screening ---------------------------------------------------------

/** Whole-word, whole-phrase containment. */
const hasWord = (needle: string, haystack: string, flags = "i") =>
  new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(needle)}([^\\p{L}\\p{N}]|$)`, flags + "u").test(haystack);

/** Claims that are easy to get wrong and obvious when wrong. */
const RISKY_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\b(won|winner|awarded|nominated)\b/i, label: "award claim" },
  { re: /\b(grammy|bafta|game award|tga)\b/i, label: "award name" },
  { re: /(#\s?\d+\b|\bnumber one\b|\bno\.\s?\d+\b|\btopped the chart|\bbillboard\b)/i, label: "chart position" },
  { re: /\b\d[\d.,]*\s*(million|billion|thousand)\b/i, label: "sales/quantity figure" },
  { re: /\bsold\s+[\d,]+/i, label: "sales figure" },
  { re: /\b(certified\s+(gold|platinum))\b/i, label: "certification claim" },
  { re: /\b(first ever|only game|best-selling|highest-\w+)\b/i, label: "superlative" },
];

/**
 * Dropped even when the source says so. Critics' opinions read as facts on
 * stream and make the real facts harder to trust (issue #21), and the music
 * video's plot or look is what viewers are already watching (issue #20).
 */
const OPINION = /\b(considered (?:one|to be|as|by|a|an|among|the (?:best|greatest|finest|most|top))|(?:among|some of) the (?:best|greatest|finest|most)|instantly recognizable|regarded|praised|acclaimed|hailed|lauded|critics?|critically|masterpiece|greatest|iconic|beloved|celebrated|described as|one of the (best|finest|most))\b/i;
/**
 * Things no song fact contains, whatever the source says: a link, a chat
 * command or an @mention. A crafted request title or a vandalized article is
 * the only way one gets into a caption.
 */
const NOT_FOR_STREAM: Array<{ re: RegExp; label: string }> = [
  { re: /\bhttps?:|\bwww\.|\b[a-z0-9-]+\.(com|net|org|tv|gg|io|ly|co|me|be|xyz|link)\b/i, label: "a link" },
  { re: /(^|\s)![a-z]/i, label: "a chat command" },
  { re: /(^|\s)@\w/, label: "an @mention" },
];

/**
 * The music video, or its shoot: "the original video", "after filming stopped",
 * "the video shoot". Never "the video game" or "in the video game".
 */
const ABOUT_THE_VIDEO =
  /\b(?:music videos?|video clips?|(?:in )?the (?:(?:original|first|second|third|official|accompanying|later|new|lyric) )?videos?(?!\s*games?\b)|filming|(?:video |photo )?shoots?(?!\s*['’]?em\b|-em))\b/i;

/** The model reasoning about its source instead of stating a fact. */
const META_PATTERNS: RegExp[] = [
  /\b(reference material|the reference|source text|provided (text|reference)|according to the (text|reference))\b/i,
  /\b(I (couldn't|could not|cannot|can't|am not|'m not)\b|I don't (know|have))/i,
  /\b(is|are|was|were) not (credited|mentioned|listed|stated|confirmed)\b/i,
  /\b(does|do|did) not (appear|mention|state|specify)\b/i,
  /\b(unconfirmed|unverified|unclear from|no information)\b/i,
  /^(note|disclaimer|caveat|here are|here is|sure[,!])/i,
];

const YEAR = /\b(1\d{3}|20\d{2})\b/g;
/** Capitalized words, including "McCartney"; two or more, or a single Mc- surname. */
/** "DeVoe", "LaBelle" and "YouTube" are one word each. */
const NAME_WORD = String.raw`(?:Mc\p{Lu}\p{Ll}+|\p{Lu}[\p{Ll}'’-]+(?:\p{Lu}[\p{Ll}'’-]+)*)`;
const NAME = new RegExp(String.raw`(?<!\p{L})(?:${NAME_WORD}(?:\s+${NAME_WORD})+|Mc\p{Lu}\p{Ll}+)`, "gu");

const PLATFORM_PATTERN =
  /\b(NES|SNES|Nintendo 64|N64|GameCube|Wii U|Wii|Switch|Game Boy(?: Advance| Colou?r)?|Nintendo DS|3DS|PlayStation(?: [2-5]| Portable| Vita)?|PSone|PS1|PS2|PS3|PS4|PS5|PSP|Vita|Xbox(?: 360| One| Series [SX])?|Sega Genesis|Mega Drive|Dreamcast|Saturn|Master System|Game Gear|Atari(?: 2600)?|Amiga|Commodore 64|C64|MS-?DOS|TurboGrafx-16|PC Engine|Neo Geo|Steam Deck|arcade|YM2612|SPC700|2A03|Ricoh)\b/gi;

/** Names for the same hardware. Each name corroborates every other in its group. */
const PLATFORM_ALIASES = new Map<string, string[]>();
for (const group of [
  ["nes", "nintendo entertainment system", "famicom"],
  ["snes", "super nintendo", "super famicom", "super nintendo entertainment system"],
  ["n64", "nintendo 64"],
  ["ps1", "psone", "playstation"],
  ["ps2", "playstation 2"],
  ["ps3", "playstation 3"],
  ["ps4", "playstation 4"],
  ["ps5", "playstation 5"],
  ["mega drive", "genesis", "sega genesis"],
  ["game boy", "gameboy"],
  ["c64", "commodore 64"],
  ["pc engine", "turbografx-16", "turbografx"],
]) {
  for (const name of group) PLATFORM_ALIASES.set(name, group.filter((n) => n !== name));
}

/** Console names that are also ordinary words; only the capital tells them apart in the source. */
const AMBIGUOUS_PLATFORMS = new Set(["switch", "saturn", "genesis", "vita"]);

/** Does the reference name this platform, or another name for it? */
export function platformSupported(platform: string, context: string): boolean {
  const p = platform.toLowerCase();
  const direct = AMBIGUOUS_PLATFORMS.has(p)
    ? namesPlatform(p[0].toUpperCase() + p.slice(1), context, "")
    : namesPlatform(p, context);
  return direct || (PLATFORM_ALIASES.get(p) ?? []).some((a) => namesPlatform(a, context));
}

/** What turns one console's name into its sibling's: "Wii U", "PlayStation 4", "Game Boy Advance". */
const SIBLING_SUFFIX = /^[\s-]+(?:U|[2-5]|360|One|Series|Advance|Colou?r|Portable|Vita|Pocket|DSi?|XL|Lite)(?![\p{L}\p{N}])/iu;

/**
 * The platform named on its own, not only as part of a sibling's name: a
 * source about the Wii U doesn't support "came out on the Wii" (review).
 */
function namesPlatform(name: string, context: string, flags = "i"): boolean {
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(name)}(?![\\p{L}\\p{N}])`, `g${flags}u`);
  for (const m of context.matchAll(re)) {
    if (!SIBLING_SUFFIX.test(context.slice((m.index ?? 0) + m[0].length))) return true;
  }
  return false;
}

/** Leading words that make a capitalized run look like a name when it isn't one. */
const NAME_STOPWORDS = new Set([
  "the", "a", "an", "this", "that", "these", "those", "it", "its", "in", "on",
  "at", "for", "to", "of", "and", "but", "or", "so", "when", "while", "after",
  "before", "during", "although", "however", "both", "each", "every", "many",
  "most", "some", "several", "one", "two", "three", "first", "second", "third",
  "original", "new", "final", "main", "early", "later", "modern", "classic",
  "his", "her", "their", "they", "he", "she", "we", "you", "i",
  "nintendo", "sega", "sony", "microsoft", "capcom", "konami", "square",
  "atlus", "falcom", "bandai", "namco", "enix", "ubisoft", "activision",
  "japanese", "american", "european", "english", "german", "french",
  // "influenced by Western action movies": a place or people, not a person.
  "western", "eastern", "northern", "southern", "british", "irish", "scottish", "italian",
  "spanish", "russian", "chinese", "korean", "asian", "african", "latin", "celtic",
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
]);

/**
 * The first capitalized name in the fact that the reference doesn't contain.
 * Each word must appear as a whole word, which tolerates "Koshiro" alone or a
 * different romanization of the given name, but not "Ed" inside "played".
 */
/**
 * Kinds of credit, and the words that state each. A fact giving someone a
 * credit needs a sentence in the source that names them with the same kind
 * of credit: "John Smith directed the game" doesn't support "John Smith wrote
 * the soundtrack" (issue from review). Writing music counts as composing.
 */
const ROLES: Array<{ fact: RegExp; source: RegExp; musicOnly?: boolean }> = [
  // "Matsuno wrote the story" is no composing credit: "wrote" counts only next to music ("wrote the score", "music was written by").
  { fact: /\b(compos\w*|scored|wr[io]te\s+the\s+(music|score|soundtrack)|written\s+the\s+(music|score|soundtrack)|music\s+(was\s+)?(written|composed)\s+by)\b/i, source: /\b(compos\w*|scored|wr[io]te|written|writer)\b/i, musicOnly: true },
  { fact: /\b(wr[io]te|written|penned|lyrics?)\b/i, source: /\b(wr[io]te|written|writ\w*|lyric\w*|penned|songwrit\w*|compos\w*)\b/i },
  { fact: /\bproduc\w*/i, source: /\bproduc\w*/i },
  { fact: /\bdirect\w*/i, source: /\bdirect\w*/i },
  { fact: /\b(performed|sang|sung|sings|vocals?|recorded)\b/i, source: /\b(perform\w*|sang|sung|sing\w*|vocal\w*|record\w*|band|singer|rapper|musician)\b/i },
  { fact: /\b(designed|developed)\b/i, source: /\b(design\w*|develop\w*)\b/i },
];
/** What "wrote" must be followed by to mean composing: "wrote the music", "wrote its score". */
const MUSIC_OBJECT = /^(music|musical|score|scores|soundtrack|soundtracks|theme|themes|songs?|melod\w*|tunes?|pieces?|instrumentals?)$/;
/** "Adele composed", "Mia Chen and Toby Fox wrote": a capitalized name right before a credit verb. */
const ACTIVE_NAME = /((?:Mc)?\p{Lu}[\p{L}'’.-]*(?:\s+(?:Mc)?\p{Lu}[\p{L}'’.-]*){0,3})\s+(?:also\s+|later\s+|originally\s+)?(?:composed|wrote|produced|directed|performed|sang|recorded|designed|developed|scored|penned)\b/gu;
/** Words between a name and its role word, at most, for the source to count as stating that role. */
const ROLE_REACH = 6;
/** The performing family: "Coldplay are a British rock band" is stated loosely, and a mix-up there is harmless. */
const LOOSE_ROLE = /perform/;
/** Any credit verb: a name right before one is that verb's subject, not the end of an earlier list. */
const CREDIT_VERB = /^(composed|wrote|produced|directed|performed|sang|recorded|designed|developed|scored|penned|arranged|published)$/i;
/** "music by", "lyrics by": a noun that credits whoever follows "by". */
const BY_NOUN: Array<{ noun: RegExp; means: RegExp }> = [
  { noun: /^(music|score|soundtrack)$/i, means: /compos/ },
  { noun: /^lyrics?$/i, means: /lyric/ },
];
const NAME_PARTICLE = /^(de|van|von|da|del|la|le|and|&|,)$/i;
/** Words that describe whoever follows "by": "by singer-songwriters", "by the band", "by producer". */
const DESCRIPTOR = /^(?:[\p{L}-]*(?:er|ers|or|ors|ist|ists|ian|ians)|the|band|bands|duo|group|trio|team|his|her|their)$/u;

/**
 * Whether one source sentence gives this person this kind of credit. Being
 * near a role word isn't enough: "John Smith directed, while Mia Chen
 * composed the music" credits Smith with directing only (final QA #1). The
 * sentence has to tie the two together one of three ways:
 *
 *   active   "Smith [and Chen] directed", "Smith directed the game and composed its music"
 *            (only plain words in between: no comma, no other name, and the verb isn't "... by" someone)
 *   passive  "composed [and arranged] by [Chen and] Smith", "music by Smith"
 *            (Smith isn't the subject of a verb that follows)
 *   title    "composer [Mia] Chen"
 *
 * Anything else is ambiguous, and an ambiguous credit is dropped.
 */
function statesRole(sentence: string, surname: string, role: { source: RegExp; musicOnly?: boolean }): boolean {
  const tokens = sentence.match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*|[,;]/gu) ?? [];
  const lower = tokens.map((t) => t.toLowerCase().replace(/['’]s$/, "").replace(/\.+$/, ""));
  const isName = (i: number) => /^\p{Lu}/u.test(tokens[i]) && !NAME_STOPWORDS.has(lower[i]);
  /** In a list of credited names, any capitalized word counts: "Falcom Sound Team jdk". */
  const noCaps = sentence === sentence.toLowerCase(); // Lowercased text can't show where a name ends.
  const isCap = (i: number) => noCaps || /^\p{Lu}/u.test(tokens[i] ?? "");
  const isRole = (i: number) =>
    role.source.test(lower[i]) &&
    !(role.musicOnly && /^(wr[io]te|written|writer)$/.test(lower[i]) && ![...lower.slice(Math.max(0, i - 3), i), ...lower.slice(i + 1, i + 4)].some((w) => MUSIC_OBJECT.test(w)));
  const at = lower.flatMap((w, i) => (w === surname ? [i] : []));
  if (!at.length) return false;
  if (LOOSE_ROLE.test(role.source.source)) return lower.some((_, j) => isRole(j) && at.some((i) => Math.abs(i - j) <= ROLE_REACH));

  return at.some((i) => {
    for (let j = 0; j < tokens.length; j++) {
      const byNoun = BY_NOUN.some((b) => b.noun.test(lower[j]) && b.means.test(role.source.source) && lower[j + 1] === "by");
      if (!isRole(j) && !byNoun) continue;
      if (j > i) {
        // Active: the rest of a name list, then plain words, then the verb.
        if (j - i - 1 > ROLE_REACH || lower[j + 1] === "by" || lower[j + 2] === "by") continue;
        let k = i + 1;
        while (k < j && (isName(k) || NAME_PARTICLE.test(lower[k]))) k++;
        if (lower[k - 1] === "," && lower[k] === "who") k++; // "Chen, who composed"
        else if (lower[k - 1] === "," && k < j) continue;
        let plain = true;
        for (; k < j; k++) if (isName(k) || /^[,;]$/.test(tokens[k]) || /^(while|whereas|but|although)$/.test(lower[k])) plain = false;
        if (plain) return true;
      } else if (j < i) {
        const span = lower.slice(j + 1, i);
        const by = span.indexOf("by");
        if (by === -1) {
          // Title: "composer Mia Chen".
          if (/(er|or|ist)$/.test(lower[j]) && span.every((_, n) => isCap(j + 1 + n))) return true;
          continue;
        }
        // Passive: a few plain words, "by", then only names up to this one.
        const before = span.slice(0, by);
        const list = span.slice(by + 1);
        if (before.length > 3 || before.some((w) => /^[,;]$/.test(w))) continue;
        // "written by singer-songwriters Eugene Wilde and Albert Manno": a descriptor may come first.
        let d = 0;
        while (d < 2 && d < list.length - 1 && DESCRIPTOR.test(list[d]) && !/^\p{Lu}/u.test(tokens[j + 2 + by + d])) d++;
        if (!list.slice(d).every((w, n) => isCap(j + 2 + by + d + n) || NAME_PARTICLE.test(w))) continue;
        if (CREDIT_VERB.test(lower[i + 1] ?? "") && lower[i + 2] !== "by") continue; // "... and Smith directed"
        return true;
      }
    }
    return false;
  });
}

/**
 * The source's sentences for the credit and award checks. A middle initial
 * ends no sentence: "produced by Barry J. Eastmond" stays whole.
 */
const sourceSentences = (context: string) => context.split(/(?<!(?:^|[^\p{L}])\p{Lu}\.)(?<=[.!?])\s+|\n+/u);

/** "by Adele", "by Nobuo Uematsu": a capitalized name after "by". */
const BY_NAME = /\bby\s+((?:Mc)?\p{Lu}[\p{L}'’.-]*(?:\s+(?:(?:Mc)?\p{Lu}[\p{L}'’.-]*|de|van|von|da|del|la|le))*)/gu;

/** A credit shared "with" others: "co-wrote the song with A and B". */
const WITH_NAMES =
  /\b(?:co-?)?(?:wr[io]te|written|composed|produced|penned)\b[^.;]*?\b(?:with|alongside)\s+((?:Mc)?\p{Lu}[\p{L}'’.-]*(?:(?:\s+|\s*,\s*)(?:(?:Mc)?\p{Lu}[\p{L}'’.-]*|and|&|de|van|von))*)/gu;

/** The names a fact credits: a name after "by", right before a credit verb, or sharing the credit "with" them. */
function creditedNames(fact: string): string[] {
  const names = new Set<string>();
  for (const m of fact.matchAll(BY_NAME)) names.add(m[1].trim().replace(/[.'’-]+$/, ""));
  for (const m of fact.matchAll(ACTIVE_NAME)) {
    const words = m[1].trim().split(/\s+/).filter((w) => !NAME_STOPWORDS.has(w.toLowerCase()));
    if (words.length) names.add(words.join(" "));
  }
  // "Babyface wrote it with L.A. Reid and Daryl Simmons": the partners get the same credit.
  for (const m of fact.matchAll(WITH_NAMES)) {
    for (const n of m[1].split(/\s*,\s*|\s+(?:and|&)\s+/)) if (/^\p{Lu}/u.test(n.trim())) names.add(n.trim().replace(/[.'’-]+$/, ""));
  }
  // Only names in a credit's own grammar count: "by Name", "Name composed". Any
  // other capitalized pair in the sentence is usually a game or a place: "composed
  // the music for Chrono Trigger" doesn't credit Chrono Trigger. On a live stream
  // that rule dropped true facts on most game tracks (October 1 log).
  return [...names];
}

/**
 * A credit the source doesn't give: a named person in a role (composed,
 * wrote, produced, directed, performed, designed) with no source sentence
 * naming them in that kind of role. Returns the name, or null.
 */
export function unsupportedCredit(fact: string, context: string): string | null {
  let roles = ROLES.filter((r) => r.fact.test(fact));
  // "wrote the music" is a composing credit: the plain writing role would accept "wrote the story".
  if (roles.includes(ROLES[0]) && !/\b(lyric\w*|words)\b/i.test(fact)) roles = roles.filter((r) => r !== ROLES[1]);
  if (!roles.length) return null;
  const sentences = sourceSentences(context);
  for (const name of creditedNames(fact)) {
    const words = name.split(/\s+/);
    const surname = (words.pop() ?? name).toLowerCase();
    // "Paul Williams composed the score" isn't supported by "John Williams composed the score".
    // The name just before the surname: "Michael" in "Narada Michael Walden", "Jimmy" in "Engineer Jimmy Douglass".
    const given = words.filter((w) => !NAME_STOPWORDS.has(w.toLowerCase()) && !/^\p{Lu}\.$/u.test(w)).pop();
    const stated = sentences.some((sentence) => roles.some((r) => statesRole(sentence, surname, r)) && sameGivenName(sentence, surname, given));
    if (!stated) return name;
  }
  return null;
}

/**
 * Whether a source sentence names this surname for the same person: with
 * the fact's given name (or its initial), or bare ("Koshiro composed",
 * which a different romanization of the given name still matches), but not
 * with another given name.
 */
function sameGivenName(sentence: string, surname: string, given: string | undefined): boolean {
  if (!given) return true;
  const g = given.replace(/\.$/, "").toLowerCase();
  // A middle initial between them is skipped: "Barry J. Eastmond".
  const re = new RegExp(`(?:([\\p{L}.'’-]+)\\s+)?(?:\\p{Lu}\\.\\s+)?${escapeRe(surname)}(?![\\p{L}])`, "giu");
  for (const m of sentence.matchAll(re)) {
    const before = (m[1] ?? "").replace(/\.$/, "");
    if (!/^\p{Lu}/u.test(before) || NAME_STOPWORDS.has(before.toLowerCase())) return true;
    const b = before.toLowerCase();
    if (b === g || (b.length === 1 && g.startsWith(b)) || (g.length === 1 && b.startsWith(g))) return true;
  }
  return false;
}

/** "Audrey Hepburn won", "Mancini received": a capitalized name right before winning something. */
const WINNER = /((?:Mc)?\p{Lu}[\p{L}'’.-]*(?:\s+(?:Mc)?\p{Lu}[\p{L}'’.-]*){0,3})\s+(?:also\s+|later\s+)?(?:won|received|earned|was awarded)\b/gu;
const WON = { source: /^(won|wins|winning|awarded|received|earned|winner)$/i };

/**
 * A named winner the source doesn't name as the winner. "The song won an
 * Academy Award" doesn't make its singer the winner (seen replaying a
 * stream: Moon River and Audrey Hepburn). The work itself, named as the
 * article is titled, is left to the award checks.
 */
export function unsupportedWinner(fact: string, context: string): string | null {
  const article = normalizeTitle(context.split("\n")[0]);
  const sentences = sourceSentences(context);
  for (const m of fact.matchAll(WINNER)) {
    const words = m[1].trim().split(/\s+/).map((w) => w.replace(/['’]s?$/, "")).filter((w) => w && !NAME_STOPWORDS.has(w.toLowerCase()));
    if (!words.length) continue;
    const name = words.join(" ");
    if (article && mentionsName(article, [normalizeTitle(name)])) continue;
    const surname = words[words.length - 1].toLowerCase();
    if (!sentences.some((s) => statesRole(s, surname, WON))) return name;
  }
  return null;
}

export function unsupportedName(fact: string, context: string): string | null {
  // A single-word name after "by" or before a credit verb ("composed by Adele",
  // "Adele composed") must be there too.
  for (const m of [...fact.matchAll(BY_NAME), ...fact.matchAll(ACTIVE_NAME)]) {
    const words = m[1].trim().split(/\s+/).map((w) => w.replace(/[.'’-]+$/, "")).filter((w) => w && !NAME_STOPWORDS.has(w.toLowerCase()));
    if (words.length && !words.every((w) => hasWord(w, context))) return words.join(" ");
  }
  for (const candidate of fact.match(NAME) ?? []) {
    // "Colonel Abrams' track": the possessive isn't part of the name.
    const words = candidate.split(/\s+/).map((w) => w.replace(/['’]s?$/, ""));
    while (words.length && NAME_STOPWORDS.has(words[0].toLowerCase())) words.shift();
    const isName = words.length >= 2 || /^Mc/.test(words[0] ?? "");
    if (!isName || words.every((w) => NAME_STOPWORDS.has(w.toLowerCase()))) continue;
    if (words.every((w) => hasWord(w, context))) continue;
    return words.join(" ");
  }
  return null;
}

/** The reference's sentences, without its own labels, for matching a caption to the one it retells. */
function bodySentences(context: string): string[] {
  const body = context.split("\n").slice(1).join("\n").replace(/^(About this piece|From the people who made it|How the music is built|How it was received): /gm, "");
  return body.split(/(?<!(?:^|[^\p{L}])\p{Lu}\.)(?<=[.!?]["”]?)\s+(?=["“]?\p{Lu})|\n+/u).map((s) => s.trim()).filter((s) => s.length >= 20 && !/^==/.test(s));
}

/** How much of a caption's content one sentence holds. */
function share(fact: string, sentence: string): number {
  const want = contentTokens(fact.replace(/\s*\([^)]*\)/g, ""));
  if (!want.size) return 0;
  const have = contentTokens(sentence);
  let shared = 0;
  for (const t of want) if (have.has(t)) shared++;
  return shared / want.size;
}

/**
 * The sentences a caption most likely retells: the best match, and any
 * nearly as good. None when even the best holds under a quarter of it.
 */
function retoldSentences(fact: string, context: string): string[] {
  const scored = bodySentences(context).map((s) => ({ s, share: share(fact, s) }));
  const best = Math.max(0, ...scored.map((x) => x.share));
  return best < 0.25 ? [] : scored.filter((x) => x.share >= best - 0.1).map((x) => x.s);
}

/** How well the reference supports a caption: the share of its words in the best-matching sentence. */
const support = (fact: string, context: string) => Math.max(0, ...bodySentences(context).map((s) => share(fact, s)));

/**
 * Words that join two statements into a cause, an order, an intention or a
 * count. Names and years in a merged caption are all in the source, so only
 * the joining word is new: "Marth and Roy appeared in Melee due to the success
 * of Advance Wars" when the source says the two together "led to" a
 * localization. Each is kept only when the sentence the caption retells has
 * a word of the same kind.
 */
const NUMBER_WORDS = ["two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty", "fifty", "hundred", "dozen"];
const ORDINALS = ["second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
const CONNECTIVES: Array<{ label: string; fact: RegExp; source: RegExp }> = [
  { label: "a cause", fact: /\b(due to|because|owing to|thanks to|as a result)\b/i, source: /\b(due to|because|owing to|thanks to|as a result|since|so|as (?:he|she|they|it|the|a|his|her|their))\b/i },
  { label: "a consequence", fact: /\b(led to|leading to|lead to|resulted in|prompted|caused)\b/i, source: /\b(led|lead|leading|result\w*|prompt\w*|caus\w*)\b/i },
  { label: "an order", fact: /\bafter\b/i, source: /\b(after|following|afterwards?|previously|when|once|upon|then|subsequently)\b/i },
  { label: "an order", fact: /\bbefore\b/i, source: /\b(before|prior|earlier|previously|until|first|originally)\b/i },
  { label: "a first", fact: /\b(?:for )?the first time\b|\bfirst[- ]ever\b/i, source: /\bfirst\b|\bdebut/i },
  { label: "an intention", fact: /\boriginally (?:intended|meant|planned|supposed)|\b(?:was|were) (?:intended|meant|supposed|planned) to\b/i, source: /\b(originally|intend\w*|meant|plann?\w*|suppos\w*|initially)\b/i },
  { label: "a count", fact: /\b(twice|thrice|again|\w+ times)\b/i, source: /\b(twice|thrice|again|\w+ times|re-\w+|re(?:issued|released|recorded|turned|appeared|entered))\b/i },
];
const DIGIT_OF: Record<string, string> = Object.fromEntries([...NUMBER_WORDS.slice(0, 19).map((w, i) => [w, String(i + 2)]), ["thirty", "30"], ["forty", "40"], ["fifty", "50"], ...ORDINALS.map((w, i) => [w, `${i + 2}`])]);

/**
 * A joining word or a number the sentence the caption retells doesn't have,
 * or null. Numbers (words or figures, not years) must be in that sentence too:
 * "reached number one twice", "the collection's three pieces" when it has five.
 */
export function unsupportedConnective(fact: string, context: string): string | null {
  const used = CONNECTIVES.filter((c) => c.fact.test(fact));
  const numbers = [
    // Lowercase only: "Two Worlds" is a title.
    ...(fact.match(new RegExp(`\\b(${[...NUMBER_WORDS, ...ORDINALS].join("|")})\\b`, "g")) ?? []),
    // A figure: not a year, and not part of a name ("Expedition 33", "Hot 100", "No. 3").
    ...[...fact.matchAll(/(?<![\p{L}\d.,$])\d{1,3}(?:,\d{3})*(?![\d\p{L}])/gu)]
      .filter((m) => !/(?:\p{Lu}[\p{L}.'’-]*|No\.|Op\.|K\.)\s+$/u.test(fact.slice(0, m.index)) && !/^\s+\p{Lu}/u.test(fact.slice((m.index ?? 0) + m[0].length)))
      .map((m) => m[0]),
  ];
  if (!used.length && !numbers.length) return null;
  const retold = retoldSentences(fact, context);
  if (!retold.length) return used[0]?.fact.exec(fact)?.[0] ?? numbers[0];
  for (const c of used) {
    if (retold.some((s) => c.source.test(s))) continue;
    if (c.fact.source === "\\bafter\\b" && afterFollowsSource(fact, context)) continue;
    return c.fact.exec(fact)?.[0] ?? c.label;
  }
  // A number may sit in any sentence the caption draws on, not only the closest: "their third film together".
  const related = bodySentences(context).filter((s) => share(fact, s) >= 0.3);
  for (const n of numbers) {
    const forms = [n, DIGIT_OF[n], ...Object.entries(DIGIT_OF).filter(([, d]) => d === n).map(([w]) => w)].filter(Boolean) as string[];
    // "second" is also "2nd"; a figure may be written "1,000" or "1000".
    if (![...retold, ...related].some((s) => forms.some((f) => hasWord(f, s) || hasWord(f.replace(/,/g, ""), s.replace(/(\d),(\d)/g, "$1$2")) || (/^\d+$/.test(f) && hasWord(`${f}${f === "2" ? "nd" : f === "3" ? "rd" : "th"}`, s))))) return n;
  }
  return null;
}

/**
 * "A after B" told from two sentences next to each other, B's first: the
 * article's order is the story's ("threatened to leave. Sakaguchi suggested
 * he score it" is "suggested it after he threatened to leave"). Not when B
 * comes later, or both halves come from one sentence that says otherwise
 * ("The band fell apart, and a few years later, Gleason decided...").
 */
function afterFollowsSource(fact: string, context: string): boolean {
  const [a, b] = fact.split(/\bafter\b/i);
  if (!a || !b) return false;
  const sentences = bodySentences(context);
  const bestIndex = (part: string) => {
    let at = -1;
    let best = 0.5;
    sentences.forEach((s, i) => {
      const sh = share(part, s);
      if (sh >= best) [at, best] = [i, sh];
    });
    return at;
  };
  const ia = bestIndex(a);
  const ib = bestIndex(b);
  return ia > 0 && ib >= 0 && ib < ia && ia - ib <= 2;
}

/**
 * Words for how two people are related, or what someone plays. A small model
 * invents them ("Leon Ware is T-Boy Ross's older brother", "guitarist
 * Furuholmen", "their self-titled album"). The source must have the word in a
 * sentence that also names the caption's subject and the person the word sits
 * next to.
 */
const RELATION =
  /(?<![\p{L}-])(brothers?|sisters?|siblings?|sons?|daughters?|father|mother|parents?|wife|husband|spouse|married|girlfriend|boyfriend|fianc[eé]e?|cousins?|uncle|aunt|nephew|niece|grand(?:son|daughter|father|mother)|partners?|self-titled|eponymous|guitarist|keyboardist|keyboard player|drummer|bassist|pianist|violinist|saxophonist|trumpeter|voice actress|voice actor)\b/gu;
const NAME_RUN = /(?:Mc)?\p{Lu}[\p{L}'’.-]*(?:\s+(?:Mc)?\p{Lu}[\p{L}'’.-]*)*/gu;

export function unsupportedRelation(fact: string, context: string): string | null {
  const sentences = sourceSentences(context);
  const runs = [...fact.matchAll(NAME_RUN)]
    .map((m) => ({ at: m.index ?? 0, end: (m.index ?? 0) + m[0].length, words: m[0].split(/\s+/).map((w) => w.replace(/['’]s?$/, "")).filter((w) => w && !NAME_STOPWORDS.has(w.toLowerCase())) }))
    .filter((r) => r.words.length);
  for (const m of fact.matchAll(RELATION)) {
    const word = m[0].toLowerCase();
    const at = m.index ?? 0;
    const root = word.replace(/s$/, "").replace(/^(fianc)[eé]e?$/, "$1");
    // The subject, and the name nearest the word: "[Leon Ware] is [T-Boy Ross]'s older brother".
    const nearest = [...runs].sort((a, b) => Math.min(Math.abs(a.end - at), Math.abs(a.at - at - word.length)) - Math.min(Math.abs(b.end - at), Math.abs(b.at - at - word.length)))[0];
    // "a new drummer position": a word not next to anyone describes no one in particular.
    const gap = nearest ? fact.slice(Math.min(nearest.end, at + word.length), Math.max(nearest.at, at)).trim().split(/\s+/).filter(Boolean).length : Infinity;
    if (runs.length && gap > 3) continue;
    const people = [...new Set([runs[0], nearest].filter(Boolean))];
    const stated = sentences.some((s) => new RegExp(`\\b${escapeRe(root)}`, "i").test(s) && people.every((p) => p.words.some((w) => hasWord(w, s))));
    if (!stated) return m[0];
  }
  return null;
}

/** Strip "Fact 1:", bullets, numbering and wrapping quotes. */
function stripPrefix(fact: string): string {
  return fact
    .replace(/^\s*(fact|trivia|tip|line)\s*\d*\s*[:.\-—]\s*/i, "")
    .replace(/^\s*[-*•]\s*/, "")
    .replace(/^\s*\d+\s*[.)]\s*/, "")
    .trim()
    // Quotes around the whole line go; a quoted title at the start stays whole.
    .replace(/^["“]([^"“”]*)["”]$/, "$1")
    .replace(/^'(.*)'$/, "$1")
    .trim();
}

function contentTokens(s: string): Set<string> {
  return new Set(
    s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((t) => t.length > 2 && !STOPWORDS.has(t))
  );
}

/**
 * Words that only say what the request already shows: that it's a song, who
 * it's by or what it's from, and how it was made in general terms. Genre and
 * nationality words count too: "a song by English rock band Coldplay" tells
 * a viewer nothing the request didn't.
 */
const RESTATES = new Set(
  (
    "is was are were be been a an the this that it its one here now so just " +
    "song songs track tracks single tune piece music musical instrumental theme composition compositions original originals cover " +
    "by from of in on for and with to as " +
    "written wrote writes composed composer performed performer recorded sung sings sang released credited " +
    "artist band group singer songwriter duo trio musician rapper " +
    "video game games soundtrack ost score album " +
    "you youre re hearing listening playing straight person who " +
    "english british american canadian australian irish scottish welsh japanese korean swedish french german " +
    "rock pop hip hop rap country folk indie jazz electronic dance metal punk alternative soul r b"
  ).split(" ")
);

/**
 * A caption that only repeats what viewers already see: the title, the artist
 * or game, and filler. "\"Clocks\" was written by Coldplay" says nothing when the
 * request read "Coldplay - Clocks"; "\"Clocks\" was written by Chris Martin" or
 * "came out in 2002" adds something and stays.
 */
export function restatesRequest(fact: string, song: SSLSong): boolean {
  const { game, track } = resolveGameAndTrack(song);
  const known = new Set(
    // Apostrophes go on both sides, so "Laura's" in the title is "Lauras" in the caption too.
    [song.title, song.artist, game, track].flatMap((s) => normalizeTitle((s ?? "").replace(/['’]/g, "")).split(" ")).filter(Boolean)
  );
  const left = normalizeTitle(fact.replace(/['’]/g, ""))
    .split(" ")
    .filter((t) => t && !known.has(t) && !RESTATES.has(t));
  return left.length === 0;
}

/** Jaccard or containment overlap; containment catches a restatement that adds words. */
export function tooSimilar(a: string, b: string): boolean {
  const ta = contentTokens(a);
  const tb = contentTokens(b);
  if (!ta.size || !tb.size) return false;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared) >= 0.5 || shared / Math.min(ta.size, tb.size) >= 0.7;
}

const MAX_QUOTE_WORDS = 12;
const plainQuotes = (s: string) => s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, " ").toLowerCase();

/**
 * Words in quotation marks are someone's own words, so they must be in the
 * source exactly, and short: a quote of three or more words that the source
 * doesn't contain, or one over twelve words, is returned. One- and two-word
 * quotes are titles and nicknames, which the name checks cover.
 */
export function alteredQuote(fact: string, context: string): string | null {
  const source = plainQuotes(context);
  for (const m of plainQuotes(fact).matchAll(/"([^"]+)"/g)) {
    const words = m[1].replace(/[.,!?;:]+$/, "").trim();
    const count = words.split(" ").length;
    if (count < 3) continue;
    if (count > MAX_QUOTE_WORDS || !source.includes(words)) return words;
  }
  return null;
}

/** Music terms a viewer may not know, each with a few plain words. Fixed text: the model never explains them itself. */
const PLAIN_WORDS: Array<[RegExp, string]> = [
  [/\barpeggi(?:o|os|ated)\b/i, "a chord's notes played one at a time"],
  [/\bostinato\b/i, "a short pattern repeated over and over"],
  [/\bleitmotifs?\b/i, "a tune tied to a character or idea"],
  [/\bcounterpoint\b/i, "two melodies at once"],
  [/\bsyncopat(?:ed|ion)\b/i, "accents off the beat"],
  [/\bmodulat(?:es|ed|ion)\b/i, "a change of key"],
  [/\bpentatonic\b/i, "a five-note scale"],
  [/\b(?:Dorian|Phrygian|Lydian|Mixolydian)\b/, "an old kind of scale"],
  [/\bchord progression\b/i, "the order of the chords"],
  [/\btime signature\b/i, "how the beats are counted"],
  [/\bcoda\b/i, "a closing section"],
  [/\bbeats per minute\b/i, "how fast it goes"],
];

/** Add a few plain words after the first music term in a caption, when they fit in the bubble (issue #48). */
export function explainMusicTerms(fact: string): string {
  for (const [term, plain] of PLAIN_WORDS) {
    const m = term.exec(fact);
    if (!m || fact.includes(plain)) continue;
    const at = m.index + m[0].length;
    const explained = `${fact.slice(0, at)} (${plain})${fact.slice(at)}`;
    return explained.length <= MAX_FACT_CHARS ? explained : fact;
  }
  return fact;
}

/**
 * The sentence in the reference a caption was most likely written from, so
 * the streamer can see what it rests on. The one sharing the most of the
 * caption's content words, when it shares at least half; otherwise none:
 * showing a poor match as "the source" would mislead.
 */
export function supportingSentence(fact: string, context: string): string {
  // The plain-word explanations in brackets are ours, not the article's.
  const want = contentTokens(fact.replace(/\s*\([^)]*\)/g, ""));
  if (!want.size) return "";
  let best = "";
  let bestShare = 0;
  const body = context.split("\n").slice(1).join("\n").replace(/^(From the people who made it|How the music is built|How it was received): /gm, "");
  for (const raw of body.split(/(?<=[.!?]["”]?)\s+(?=["“]?\p{Lu})|\n+/u)) {
    const sentence = raw.trim();
    if (sentence.length < 20) continue;
    const have = contentTokens(sentence);
    let shared = 0;
    for (const t of want) if (have.has(t)) shared++;
    const share = shared / want.size;
    if (share > bestShare) [best, bestShare] = [sentence, share];
  }
  return bestShare >= 0.5 ? (best.length > 320 ? `${best.slice(0, 317)}…` : best) : "";
}

export interface ScreenResult {
  kept: string[];
  rejected: Array<{ text: string; reason: string }>;
}

/**
 * Keep only facts the reference visibly supports. With no reference (only
 * when FACT_VERIFICATION=off) the source checks are skipped but formatting,
 * meta-commentary, risky claims, length and duplicates are still screened.
 */
export function screenClaims(facts: string[], rawContext: string, opts: { otherParts?: string[] } = {}): ScreenResult {
  const result: ScreenResult = { kept: [], rejected: [] };
  // "Wagner‐influenced" with U+2010 is "Wagner-influenced": the name checks compare plain hyphens.
  const plainHyphens = (t: string) => t.replace(/[\u2010\u2011\u2012]/g, "-");
  const context = plainHyphens(rawContext);

  const reasonToDrop = (fact: string): string | null => {
    const unsafe = NOT_FOR_STREAM.find(({ re }) => re.test(fact));
    if (unsafe) return unsafe.label;
    if (META_PATTERNS.some((re) => re.test(fact))) return "meta-commentary";
    if (fact.length < 20) return "too short";
    if (OPINION.test(fact)) return "opinion";
    // "GameSpy called the music incredible": a review outlet's verdict is an opinion too.
    if (CRITIC_NAMES.test(fact) && /\b(called|wrote|said|described|praised|named|ranked|listed|rated|felt|thought|noted)\b/i.test(fact)) return "a critic's view";
    // "He combined two words": a viewer can't tell who.
    if (/^(He|She|They|His|Her|Their)\b/.test(fact)) return "doesn't say who";
    if (ABOUT_THE_VIDEO.test(fact)) return "about the music video";
    // A Mondstadt fact under a Liyue track: true, but about another part of the soundtrack.
    const other = (opts.otherParts ?? []).find((p) => hasWord(p, fact, ""));
    if (other) return `about another part of the soundtrack ("${other}")`;
    for (const { re, label } of RISKY_PATTERNS) {
      const m = fact.match(re);
      if (m && !hasWord(m[0].trim(), context)) return label;
    }
    if (context) {
      const year = (fact.match(YEAR) ?? []).find((y) => !hasWord(y, context));
      if (year) return `unsupported year ${year}`;
      const platform = (fact.match(PLATFORM_PATTERN) ?? []).find((p) => !platformSupported(p, context));
      if (platform) return `unsupported platform "${platform}"`;
      const name = unsupportedName(fact, context);
      if (name) return `unsupported name "${name}"`;
      const credit = unsupportedCredit(fact, context);
      if (credit) return `unsupported credit for "${credit}"`;
      const winner = unsupportedWinner(fact, context);
      if (winner) return `award not given to "${winner}" in the source`;
      const quote = alteredQuote(fact, context);
      if (quote) return `quote not in the source: "${quote}"`;
      const joined = unsupportedConnective(fact, context);
      if (joined) return `"${joined}" isn't in the sentence it retells`;
      const relation = unsupportedRelation(fact, context);
      if (relation) return `"${relation}" isn't stated for them in the source`;
    }
    if (fact.length > MAX_FACT_CHARS) return `too long (${fact.length} chars)`;
    return null;
  };

  for (const raw of facts) {
    const fact = plainHyphens(stripPrefix(raw));
    const reason = reasonToDrop(fact);
    if (reason) {
      result.rejected.push({ text: fact, reason });
      continue;
    }
    // Of two near-duplicates, the one closer to its source sentence stays: "resembles" over "was inspired by".
    const twin = result.kept.findIndex((k) => tooSimilar(k, fact));
    if (twin < 0) result.kept.push(fact);
    else if (context && support(fact, context) > support(result.kept[twin], context)) {
      result.rejected.push({ text: result.kept[twin], reason: "near-duplicate of a closer retelling" });
      result.kept[twin] = fact;
    } else result.rejected.push({ text: fact, reason: "near-duplicate of an earlier fact" });
  }
  return result;
}

// --- Curated pool ------------------------------------------------------

/** `count` hand-verified facts from the topic packs, shuffled. */
export function curatedFacts(count: number): string[] {
  const pool = [...topic.curatedFacts];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.max(0, count));
}
