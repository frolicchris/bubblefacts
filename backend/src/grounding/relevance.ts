import { foldSymbols, normalizeTitle } from "./titles";

// Whether an article is about the requested song (title and artist matching), and shared name helpers

export const STOPWORDS = new Set(["the", "and", "of", "a", "an", "in", "on", "for", "to"]);

// --- Article relevance ---

// Disambiguators for a musical work or what it comes from
const MUSICAL_QUALIFIER =
  /video game|game\b|series|soundtrack|album|franchise|film|score|song|single|composition|opera|ballet|suite|sonata|symphony|concerto|musical|anime|television|tv series|novel/i;
// People and groups: right only when we searched for one
export const PERFORMER_QUALIFIER = /band|singer|musician|composer|pianist|rapper|duo|group|orchestra/i;
// An opening describing a performer or a recording
export const PERFORMER_LEAD = /\b(band|singer|rapper|musician|group|duo|trio|songwriter|record(ing)? artist|vocalist|album|song|single|DJ|producer)\b/i;
// Disambiguators that can't be a performer
export const NOT_A_PERFORMER = /\((?:[^)]*\b)?(video game|game|film|television|tv series|novel|manga|anime)\)\s*$/i;
// Another kind of work under the same name
const MEDIUM_SHIFT = /\b(movie|film|musical|discography|anime|manga|novel|list|awards|tour|concert)\b/i;

const KNOWN_ARTIST =
  /\b(beethoven|mozart|bach|chopin|debussy|liszt|ravel|satie|tchaikovsky|schubert|brahms|rachmaninoff|beatles|queen|abba|elton john|billy joel|radiohead|coldplay|adele|taylor swift|joe hisaishi|ryuichi sakamoto|hans zimmer|john williams|ennio morricone|yiruma|ludovico einaudi)\b/i;

export const ROMAN: Record<string, string> = {
  i: "1", ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8",
  ix: "9", x: "10", xi: "11", xii: "12", xiii: "13", xiv: "14", xv: "15",
};

/** A page's trailing qualifier: "song" for "Let It Be (song)", or undefined */
export function qualifierOf(title: string): string | undefined {
  return /\(([^)]*)\)\s*$/.exec(title)?.[1];
}

/** A title minus its trailing qualifier: "Let It Be (song)" is "Let It Be" */
export function withoutQualifier(title: string): string {
  return title.replace(/\s*\([^)]*\)\s*$/, "");
}

/** Content words and every numeral, roman as arabic */
export function significantTokens(s: string): string[] {
  const words = s.split(" ").filter((t) => t && !STOPWORDS.has(t));
  const kept = words.filter((t) => t.length >= 2 || /\d/.test(t) || t in ROMAN);
  return (kept.length ? kept : words).map((t) => ROMAN[t] ?? t);
}

// Installment numbers and how each is written: "Some Game V" gives ["5:roman"]
function numeralForms(normalized: string): string[] {
  return normalized
    .split(" ")
    .filter((t) => t && !STOPWORDS.has(t) && (/^\d+$/.test(t) || t in ROMAN))
    .map((t) => (t in ROMAN ? `${ROMAN[t]}:roman` : `${Number(t)}:arabic`));
}

/** Same number written two ways ("Some Game 5", "Some Game V"): may be two games; only Wikipedia's redirect joins them */
export function numeralStyleDiffers(a: string, b: string): boolean {
  const fa = numeralForms(normalizeTitle(a));
  const fb = numeralForms(normalizeTitle(b));
  const value = (f: string) => f.split(":")[0];
  const clash = (x: string[], y: string[]) => x.some((f) => y.some((g) => value(g) === value(f)) && !y.includes(f));
  return clash(fa, fb) || clash(fb, fa);
}

// A version with its own credits and year; on normalized titles ("director s cut")
const EDITION_WORDS =
  /\b(royal|golden|reload|remastered|remaster|remake|definitive edition|complete edition|special edition|anniversary edition|director s cut|final mix|hd|dx|deluxe|portable|cd)\b/g;

/**
 * The edition the request names and the title doesn't ("royal" for "Some Game Royal" from "Some Game"), or
 * null: its infobox credits and year are the original's. Never the first word ("Golden Sun")
 */
export function editionNotInTitle(subject: string, pageTitle: string): string | null {
  const want = normalizeTitle(subject);
  const got = ` ${normalizeTitle(pageTitle)} `;
  const rest = want.split(" ").slice(1).join(" ");
  for (const m of rest.matchAll(EDITION_WORDS)) if (!got.includes(` ${m[1]} `)) return m[1];
  return null;
}

/** "Firstname Lastname", or a well-known composer or band */
export function looksLikeArtistName(subject: string): boolean {
  if (!subject) return false;
  if (KNOWN_ARTIST.test(subject)) return true;
  return (
    /^\p{Lu}[\p{Ll}'’-]+(?:\s+\p{Lu}[\p{Ll}'’-]+){1,2}$/u.test(subject.trim()) &&
    !/\b(the|of|and|a|an)\b/i.test(subject)
  );
}

// A qualifier saying the kind of work: "(Flight Facilities song)", "(album)"
const WORK_TYPE = /\b(song|single|album|soundtrack|composition|video|game|series|film|instrumental|suite)\b/i;

/**
 * Whether the disambiguator names another artist: "Clair de Lune (Flight Facilities song)" for Debussy.
 * A bracket shared with `track` is the name ("Separate Ways (Worlds Apart)"). `bareSubtitlesOk`: a bracket
 * naming no kind of work is a subtitle too; the caller then checks the article names the artist
 */
export function qualifierNamesAnotherArtist(pageTitle: string, subject: string, track = "", bareSubtitlesOk = false): boolean {
  const qualifier = qualifierOf(pageTitle);
  if (!qualifier) return false;
  const fold = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (track && ` ${fold(track)} `.includes(` ${fold(qualifier)} `)) return false;
  if (bareSubtitlesOk && !WORK_TYPE.test(qualifier)) return false;

  const named = qualifier
    .split(/\s+/)
    .filter((w) => !/^(song|single|album|soundtrack|composition|video|game|series|film|instrumental|suite)$/i.test(w))
    .join(" ");
  const qualifierTokens = normalizeTitle(named).split(" ").filter(Boolean);
  const subjectTokens = new Set([subject, foldSymbols(subject)].flatMap((s) => normalizeTitle(s).split(" ")).filter(Boolean));
  if (!qualifierTokens.length || !subjectTokens.size) return false;

  return !qualifierTokens.some((t) => subjectTokens.has(t));
}

/** Whether it's about the subject searched for: search never says "no result" (ARCHITECTURE.md: choosing the article) */
export function isRelevantArticle(subject: string, pageTitle: string, subjectIsArtist = false): boolean {
  const want = normalizeTitle(subject);
  const got = normalizeTitle(pageTitle);
  const wantTokens = significantTokens(want);
  const gotTokens = significantTokens(got);
  if (!want || !got || !wantTokens.length || !gotTokens.length) return false;
  // Single letters aren't significant tokens: "Luis F. Rodriguez" would match "Luis J. Rodriguez"
  if (initialsDiffer(subject, withoutQualifier(pageTitle))) return false;

  // "Nier series" is "Nier (series)" or "Star Trek" itself, never "Nier (video game)"
  const series = /^(.+) (?:series|franchise)$/.exec(want);
  if (series) {
    const q = qualifierOf(pageTitle);
    if (significantTokens(series[1]).join(" ") === gotTokens.join(" ")) return !q || /\b(series|franchise)\b/i.test(q);
  }

  // A leading "The" is part of a band's name: "The Midnight" isn't "Midnight Club"
  if (/^the\s/.test(want) && !/^the\s/.test(got)) return false;

  const qualifier = qualifierOf(pageTitle);
  if (qualifier) {
    // Dated in the future (an announced remake): not what's on air
    const year = /\b(20\d{2})\b/.exec(qualifier)?.[1];
    if (year && Number(year) > new Date().getFullYear()) return false;

    // Capitalized: an attribution ("Clair de Lune (Debussy)"); lowercase: a category, must be musical
    const isPerformer = PERFORMER_QUALIFIER.test(qualifier);
    const properNoun = /^\p{Lu}/u.test(qualifier.trim()) && !isPerformer;
    if (!MUSICAL_QUALIFIER.test(qualifier) && !(isPerformer && subjectIsArtist) && !properNoun) return false;
  }

  // Numbers decide sequels: "Final Fantasy X" is neither "Final Fantasy" nor "Final Fantasy XII"
  const wantNums = wantTokens.filter((t) => /^\d+$/.test(t));
  const gotNums = gotTokens.filter((t) => /^\d+$/.test(t));
  if (wantNums.length && !wantNums.some((n) => gotNums.includes(n))) return false;
  // "Some Game 5" isn't "Some Game V": the lookup follows Wikipedia's redirect, never a guess
  if (numeralStyleDiffers(subject, pageTitle)) return false;

  const wantSeq = wantTokens.join(" ");
  const gotSeq = gotTokens.join(" ");

  // Extends the subject at a word: "Celeste" -> "Celeste (video game)"
  if (gotSeq.startsWith(wantSeq + " ")) {
    // A possessive is another work: "Michael Jackson's This Is It"
    if (got.startsWith(want + " s ")) return false;
    // "Overwatch and pornography" is another subject; "Pokémon Red and Blue" is a pair of games
    if (got.startsWith(want + " and ") && /\sand\s+\p{Ll}/u.test(pageTitle)) return false;
    // "Qumu Corporation" isn't the musician "Qumu"
    if (COMPANY.test(withoutQualifier(pageTitle)) && !COMPANY.test(subject)) return false;
    return !(MEDIUM_SHIFT.test(got) && !MEDIUM_SHIFT.test(want));
  }
  // Shortens the subject: only at a subtitle break ("Ys VIII: Lacrimosa of Dana" -> "Ys VIII"), no numeral
  // lost. "Everybody Dance Now" isn't "Everybody Dance"
  if (wantSeq.startsWith(gotSeq + " ")) {
    const head = significantTokens(normalizeTitle(subject.split(/:|\s[-–—]\s/)[0])).join(" ");
    // A number is a subtitle break too: "Ys II The Final Chapter" -> "Ys II"
    const atBreak = head === gotSeq || /^\d+$/.test(gotTokens[gotTokens.length - 1]);
    return atBreak && wantNums.every((n) => gotNums.includes(n));
  }

  // Merely containing the subject: "Queen" isn't "Long Live the Queen (video game)"
  if (got.split(" ").length > want.split(" ").length + 1) return false;
  if (gotSeq === wantSeq) return true;
  // A set in the plural: "Hungarian Dance" is one of the "Hungarian Dances (Brahms)"
  if (gotSeq === wantSeq + "s" && wantTokens.length >= 2) return true;

  const gotSet = new Set(gotTokens);
  const ratio = wantTokens.filter((t) => gotSet.has(t)).length / wantTokens.length;
  if (wantTokens.length >= 3) return ratio >= 0.85;
  // A short subject must be the whole title, any order: "The Midnight" isn't "Wangan Midnight"
  const wantSet = new Set(wantTokens);
  return ratio === 1 && gotTokens.every((t) => wantSet.has(t));
}

/** Initials differ in the same place: "Luis F. Rodriguez" and "Luis J. Rodriguez" are two people */
export function initialsDiffer(a: string, b: string): boolean {
  const wa = normalizeTitle(a).split(" ");
  const wb = normalizeTitle(b).split(" ");
  return wa.length === wb.length && wa.some((w, i) => w !== wb[i] && w.length === 1 && wb[i].length === 1);
}

// "Qumu Corporation", "Some Records", "Some Studios Inc."
export const COMPANY = /\s(?:corporation|corp\.?|inc\.?|incorporated|company|co\.|ltd\.?|limited|llc|plc|gmbh|records|studios|entertainment|holdings)$/i;
