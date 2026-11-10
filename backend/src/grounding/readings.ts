import type { SSLSong } from "../types";
import { escapeRe, hasNoArtist } from "../text";
import { setCapped } from "../capped-map";
import { MAX_CONTEXT_CHARS, MIN_CONTEXT_CHARS } from "../fact-limits";
import { dropVersionTags, isVariantTag, normalizeTitle, resolveGameAndTrack } from "./titles";
import { COMPANY, initialsDiffer, isRelevantArticle, looksLikeArtistName, numeralStyleDiffers, ROMAN, significantTokens, STOPWORDS, withoutQualifier } from "./relevance";
import { orderExtract, RateLimited, wikiExtract, wikiResolveTitles, wikiSearch, wikiSearchSuggestion } from "./wikipedia";
import { writingText } from "./covers";
import { GENERIC_TRACK, NOT_A_LIST } from "./summary";

/**
 * Other readings of a request: the same text read as a different game,
 * track or artist, and the grounding cache.
 */

/** How long "no article" is trusted before the lookup is retried. */
export const NEGATIVE_TTL_MS = 10 * 60 * 1000;

/**
 * Articles found through the game are shared by every track from it;
 * articles found through the track, and misses, belong to that song only.
 */
export const groundingCache = new Map<string, { text: string; at: number }>();
export const MAX_GROUNDING = 300;

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
 * - `aPerformer`: one of several names in the credit: the subject's own
 *   article must be a performer's ("Black Caviar" is a racehorse too).
 * - `fromTitle`: the work was read from the title, the artist being someone
 *   else ("Gerudo Valley - Ocarina of Time" by a remixer): the subject's
 *   article must be a game's, a film's or a show's, never a person's or a song's.
 */
export interface Reading {
  game: string;
  track: string;
  page?: string;
  songAlone?: boolean;
  notGame?: boolean;
  trackOnly?: boolean;
  fromTitle?: boolean;
  aPerformer?: boolean;
  /** Read from the song with its list notes dropped (`lookupForm`): cached apart from the reading as listed. */
  cleaned?: boolean;
}

/** An artist field naming a kind of work: "Star Trek TV", "NieR Series", "Super Mario Franchise". */
export const CATEGORY_ARTIST = /^(.+?)\s+(series|franchise|games|tv|tv series|tv shows?|movies|films)$/i;
/** Films and shows: their works are never video games. */
const SCREEN_CATEGORY = /^(tv|tv series|tv shows?|movies|films)$/i;
/** Artist fields that name no one: "Traditional", "Italian Folk Song", "Anonymous". */
export const NO_ONE = /^(?:traditional|trad\.?|anonymous|anon\.?|unknown|(?:\p{L}+\s+)?folk(?:\s+(?:song|tune|melody))?)$/iu;
/** "Elton John arr. Brent Edstrom", "Arr. Handel Halvorsen": who arranged a piece isn't who wrote it. */
const ARRANGER = /^\s*arr(?:\.|anged by)?\s+|\s+(?:arr(?:\.|anged by)?|arrangement by)\s+.*$/i;
/** What joins several names in one credit: "A - B", "A / B", "A ft. B", "A x B". */
export const CREDIT_JOIN = /\s+[-–—]\s+|\s*\/\s*|\s+(?:[Ff]eat\.?|[Ff]t\.?|[Ff]eaturing)\s+|\s+x\s+/;
/** A short tag after the names, a list's own mark ("Some Singer - AB"): never a name to look up. */
const LIST_TAG = /^\p{Lu}{1,2}$/u;
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
  const out = listedReadings(song);
  // "Some Song (from Some Show)": the song's own article under the show first. Only that article
  // will do (`trackOnly`), so the usual reading still follows, and its performer's article with it.
  const from = workFromTitle(dropVersionTags(song.title.trim()).replace(TITLE_ARRANGER, ""));
  const at = from ? out.findIndex((r) => r.trackOnly && r.game === from.work && r.track === from.track) : -1;
  return at > 0 ? [out[at], ...out.slice(0, at), ...out.slice(at + 1)] : out;
}

function listedReadings(song: SSLSong): Reading[] {
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

  if (hasNoArtist(artist) || NO_ONE.test(artist)) {
    // "Unknown" has long meant "read the title": that comes first.
    return [...(/^unknown$/i.test(artist) ? [first] : []), { game: "", track: title, songAlone: true }];
  }

  const parts = [...new Set(artist.split(CREDIT_JOIN).map((p) => p.replace(ARRANGER, "").trim()).filter(Boolean))];
  const names = parts.some((p) => !LIST_TAG.test(p)) && parts.length > 1 ? parts.filter((p) => !LIST_TAG.test(p)) : parts;
  // "Some Singer - AB" is Some Singer's: a list's own tag is no part of the name.
  const alone = names.length === 1 && names[0].toLowerCase() !== artist.toLowerCase() && parts.length > 1;
  const start = alone ? [{ ...resolveGameAndTrack({ ...song, artist: names[0] }), trackOnly: false }] : [first];
  const others = alone ? [] : names.filter((n) => n.toLowerCase() !== artist.toLowerCase());
  if (names.length <= 1) {
    return [...start, ...others.map((name) => ({ ...resolveGameAndTrack({ ...song, artist: name }), trackOnly: false })), ...namedInTitle(title, start[0])];
  }
  // Several names: the song's own article under any of them first ("Can You Feel the Love Tonight"
  // under its third name beats the first name's band), then the work in the title, and only then
  // a name's own article, for a name that reads like a person's and an article about a performer.
  return [
    ...start,
    ...others.map((name) => ({ ...resolveGameAndTrack({ ...song, artist: name }), trackOnly: true })),
    ...namedInTitle(title, start[0]),
    ...others.filter(looksLikeArtistName).map((name) => ({ ...resolveGameAndTrack({ ...song, artist: name }), trackOnly: false, aPerformer: true })),
  ];
}

/** A year in brackets, "(1979)": when the song came out or was added, not part of its name. */
const YEAR_TAG = /\s*[([]\s*(?:19|20)\d\d\s*[)\]]/g;
/** A featured credit in brackets, "(feat. Some Singer)": another reading's job, not the song's name. */
const FEATURED_TAG = /\s*[([]\s*(?:feat|ft|featuring)\b[^)\]]*[)\]]/gi;
/** A note after the name, closed or not: "(Australian)", "(Cherokee/Irish)", "(LGBTQ+". */
const TRAILING_NOTE = /\s*[([][^)\]]*(?:[)\]]|$)\s*$/;
/** The work a song is from, in brackets: "(from Some Show)", "(From "Some Film")". */
const FROM_TAG = /\s*[([]\s*from\s+["“'‘]?([^)\]]*?)["”'’]?\s*[)\]]/i;
/**
 * The work after "from" with no brackets: "Some Song from Some Long Show". Two capitalized words
 * at least, so "Pennies from Heaven" and "The Girl from Ipanema" stay whole.
 */
const FROM_WORK = /^(.+?)\s+[Ff]rom\s+((?:the\s+)?\p{Lu}[\p{L}'’.]*(?:\s+(?:of|the|and|in|on|a|an|to|for|&|\p{Lu}[\p{L}'’.]*|\d+))*\s+\p{Lu}[\p{L}'’.]*(?:\s+\d+)?)\s*$/u;
/** An arranger after the title: "Some Song arr. Some Pianist", "Some Song arranged by Some Pianist". */
const TITLE_ARRANGER = /\s+(?:arr\.|arranged by|arrangement by)\s+\S.*$/i;
/** A track number before the title: "14. Some Song". "1979", "7 AM" and "99 Luftballons" have no period after the number. */
const TRACK_NUMBER = /^\d{1,3}\.\s+(?=\p{L})/u;
/** An arranger's mark between two names: "Some Pianist (arr) Some Composer" is Some Composer's piece. */
const ARRANGED_BY_FIRST = /^.*?\S\s*[([]\s*arr(?:\.|anged|anger)?\s*[)\]]\s*(\p{L}.*)$/iu;

/** The work a title names after "from", bracketed or not, or "": "Some Song (from Some Show)" is from "Some Show". */
export function workFromTitle(title: string): { track: string; work: string } | null {
  const tag = FROM_TAG.exec(title);
  const bare = tag ? null : FROM_WORK.exec(title.trim());
  const found = tag
    ? { track: (title.slice(0, tag.index) + title.slice(tag.index + tag[0].length)).trim(), work: tag[1].replace(/\s+/g, " ").trim() }
    : bare && { track: bare[1].trim(), work: bare[2].trim() };
  // "Theme from Some Show" names no piece of its own: the show's article is another rule's (themeOf).
  if (!found || !found.track || !found.work || GENERIC_TRACK.test(normalizeTitle(found.track)) || /\btheme$/i.test(found.track)) return null;
  return found;
}

/**
 * The song as a lookup can read it once a song list's own notes are dropped:
 * brackets after the artist ("Some Band (Australian)"), a year tag or a
 * featured credit in the title. Null when nothing is dropped. Only a lookup
 * tries this, and after the song as listed, so what works today is unchanged;
 * the song itself, shown and kept as listed, is never altered. A bracket that
 * starts a name or sits inside one stays: "(Don't Fear) The Reaper".
 */
export function lookupForm(song: SSLSong): SSLSong | null {
  let artist = (song.artist ?? "").trim();
  for (let m: RegExpExecArray | null; (m = TRAILING_NOTE.exec(artist)) && /\p{L}/u.test(artist.slice(0, m.index)); ) {
    artist = artist.slice(0, m.index).trim();
  }
  // Who arranged it isn't who wrote it: "Some Show arr. Some Pianist", "Some Pianist (arr) Some Composer".
  artist = ARRANGED_BY_FIRST.exec(artist)?.[1].trim() ?? artist;
  if (/\p{L}/u.test(artist.replace(ARRANGER, ""))) artist = artist.replace(ARRANGER, "").trim();
  let title = song.title.replace(YEAR_TAG, "").replace(FEATURED_TAG, "").trim();
  // A list's own notes in the title: a track number, an arranger, the work it's from (another reading's job).
  title = title.replace(TRACK_NUMBER, "").replace(TITLE_ARRANGER, "").trim();
  title = workFromTitle(title)?.track ?? title;
  if (!/\p{L}|\p{N}/u.test(title.replace(/[()[\]]/g, "")) || (title === song.title.trim() && artist === (song.artist ?? "").trim())) return null;
  return { ...song, title, artist };
}

/**
 * What a title names besides the piece, when the artist is someone else (a
 * remixer, a cover band):
 * - the original artist or the work in brackets, "Baby (Justin Bieber)",
 *   "Wind (Naruto)": only the piece's own article, which must name it;
 * - the work after or before a dash, "Gerudo Valley - Ocarina of Time",
 *   "Fire Emblem: Three Houses - Main Theme": the piece's own article, or
 *   the work's, which must be a game's, a film's or a show's.
 */
function namedInTitle(title: string, first: { game: string; track: string }): Reading[] {
  // The usual reading already took the work from the title.
  if (first.track !== title) return [];
  // "Some Song (from Some Show)", "Some Song from Some Long Show": the show is the work, as a game in the artist field is.
  const from = workFromTitle(title.replace(TITLE_ARRANGER, ""));
  if (from) return [{ game: from.work, track: from.track, trackOnly: true }];
  const bracket = /^(.+?)\s*\(([^)]+)\)$/.exec(title);
  if (bracket) return isVariantTag(bracket[2]) ? [] : [{ game: bracket[2].trim(), track: bracket[1].trim(), trackOnly: true }];
  // "Don Henley: Hotel California": a person's name before a colon is a credit the list added, not part of the song's name.
  const credit = /^(.+?):\s+(.+)$/.exec(title);
  if (credit && looksLikeArtistName(credit[1].trim()) && !/:/.test(credit[2])) return [{ game: credit[1].trim(), track: credit[2].trim(), trackOnly: true }];
  const dash = /^(.+)\s[-–—]\s(.+)$/.exec(title);
  if (!dash || /\s[-–—]\s/.test(dash[1])) return [];
  const [left, right] = [dash[1].trim(), dash[2].trim()];
  return [
    { game: right, track: left, fromTitle: true },
    { game: left, track: right, fromTitle: true },
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
  if (initialsDiffer(a, b)) return false;
  // "Memes" isn't a misspelled "Meme": a plural names many, the article one.
  if (a === `${b}s` || b === `${a}s`) return false;
  const d = editDistance(a.replace(/ /g, ""), b.replace(/ /g, ""));
  if (d > 2 || d > a.replace(/ /g, "").length * 0.2) return false;
  if (numerals(name).join(" ") !== numerals(page).join(" ") || numeralStyleDiffers(name, page)) return false;
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
  // "FFVII" is "Final Fantasy VII": the initials carry the installment number.
  if (isInitials(from, to)) return true;
  // "Qumu" leads to "Qumu Corporation": a company named the same isn't a musician or a work.
  if (COMPANY.test(to) && !COMPANY.test(from)) return false;
  // "Poirot" leads to "Hercule Poirot" and "Ponce de León" to "Juan Ponce de León": a surname
  // given a first name is one person of that name. A title before a colon is a series name:
  // "Red Alert 3" in "Command & Conquer: Red Alert 3".
  const f = normalizeTitle(from);
  const t = normalizeTitle(to);
  if (t.endsWith(` ${f}`)) {
    const head = withoutQualifier(to);
    if (!/[:–—]\s*$/.test(head.slice(0, Math.max(0, head.length - from.length)))) return false;
  }
  const fromNumbers = numerals(from);
  const toWords = significantTokens(normalizeTitle(to));
  if (/\d/.test(toWords[toWords.length - 1] ?? "") && !fromNumbers.includes(toWords[toWords.length - 1])) return false;
  const fromWords = new Set(significantTokens(normalizeTitle(from)).filter((t) => !/\d/.test(t)));
  return significantTokens(normalizeTitle(to)).some((t) => fromWords.has(t)) || isRespelling(from, to);
}

/**
 * Whether a name is the initials of a title, its installment number kept:
 * "FFVII" and "FF7" are "Final Fantasy VII". Only for a redirect Wikipedia
 * itself keeps, so the abbreviation is its, not a guess.
 */
export function isInitials(short: string, long: string): boolean {
  const s = normalizeTitle(short).replace(/ /g, "");
  if (s.length < 2 || /\s/.test(short.trim())) return false;
  const words = normalizeTitle(long).split(" ").filter(Boolean);
  const forms = (keep: (w: string) => boolean) => {
    const kept = words.filter(keep);
    const num = (w: string) => /^\d+$/.test(w) || w in ROMAN;
    return [kept.map((w) => (num(w) ? w : w[0])).join(""), kept.map((w) => (num(w) ? (ROMAN[w] ?? w) : w[0])).join("")];
  };
  return [...forms(() => true), ...forms((w) => !STOPWORDS.has(w))].includes(s);
}

export const wikipediaNames = new Map<string, string | null>();

/**
 * A series' own article, as Wikipedia files it: "Kirby (series)", "Nier
 * (series)" (which leads to "Drakengard and Nier"), "Star Trek (franchise)"
 * (which leads to "Star Trek"). Null when it has none under these titles.
 */
export async function seriesPage(name: string): Promise<string | null> {
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
export async function wikipediaName(name: string): Promise<string | null> {
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
export function ownArticleExtract(full: string, budget: number, names: string[]): string {
  const extract = orderExtract(full, budget, names);
  return extract.length >= MIN_CONTEXT_CHARS ? extract : orderExtract(full, budget, names, true, NOT_A_LIST);
}

/** What a song is, in its article's opening: "a traditional English folk song". */
const SONG_WORDS = /\b(song|ballad|hymn|carol|tune|melody|lullaby|anthem|folk ?song|canzone|chanson)s?\b/i;

/**
 * A song by no one in particular ("Traditional", "Italian Folk Song"): its
 * own article, found by its title alone, and only when the article opens by
 * calling it a song. "Santa Lucia" is also a town and a saint.
 */
export async function groundSongAlone(song: SSLSong, title: string, usable: (title: string) => boolean): Promise<Grounded> {
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
        if (!full || !SONG_WORDS.test(full.slice(0, 300))) {
          console.log(`[Grounding] "${page}" isn't about a song, skipping`);
          continue;
        }
        const extract = ownArticleExtract(full, MAX_CONTEXT_CHARS - page.length - 1, [title]);
        if (extract.length < MIN_CONTEXT_CHARS) continue;
        const text = `${page}\n${writingText(full, extract, MAX_CONTEXT_CHARS - page.length - 1, [title])}`;
        console.log(`[Grounding] "${song.title}" -> ${page} (${extract.length} chars, the song by its title alone)`);
        setCapped(groundingCache, key, { text, at: Date.now() }, MAX_GROUNDING);
        return { text, unreachable: false };
      }
    }
  } catch (err) {
    if (err instanceof RateLimited) return { text: "", unreachable: true };
    console.warn(`[Grounding] Lookup failed for "${title}": ${err instanceof Error ? err.message : err}`);
    return { text: "", unreachable: true };
  }
  console.log(`[Grounding] No reference for "${song.title}" by its title alone`);
  setCapped(groundingCache, key, { text: "", at: Date.now() }, MAX_GROUNDING);
  return { text: "", unreachable: false };
}

export interface Grounded {
  text: string;
  /** Throttled or unreachable: the miss says nothing, so no other reading is tried. */
  unreachable: boolean;
}
