import type { SSLSong } from "../types";
import { escapeRe, hasNoArtist } from "../text";
import { setCapped } from "../capped-map";
import { MAX_CONTEXT_CHARS, MIN_CONTEXT_CHARS } from "../fact-limits";
import { dropVersionTags, isVariantTag, normalizeTitle, resolveGameAndTrack } from "./titles";
import { COMPANY, initialsDiffer, isRelevantArticle, looksLikeArtistName, numeralStyleDiffers, ROMAN, significantTokens, STOPWORDS, withoutQualifier } from "./relevance";
import { orderExtract, RateLimited, wikiExtract, wikiResolveTitles, wikiSearch, wikiSearchSuggestion } from "./wikipedia";
import { writingText } from "./covers";
import { GENERIC_TRACK, NOT_A_LIST } from "./summary";

// Other readings of a request (the same text as another game, track or artist), and the grounding cache

export const NEGATIVE_TTL_MS = 10 * 60 * 1000; // ms "no article" is trusted before retrying

// Found through the game: shared by its tracks. Through the track, or a miss: that song's only
export const groundingCache = new Map<string, { text: string; at: number }>();
export const MAX_GROUNDING = 300;

// --- Other readings of a request ---

/**
 * One way to look a request up: the subject (`game`: a game, film, show, series or artist) and the piece (`track`).
 * - `songAlone`: a song by no one in particular, by its title alone
 * - `notGame`: the subject is a film or show, never a video game
 * - `trackOnly`: only the piece's own article (the name may be an arranger's or fellow musician's)
 * - `page`: the article Wikipedia said the subject's name means, and no other
 * - `aPerformer`: one of several credited names: its article must be a performer's ("Black Caviar")
 * - `fromTitle`: the work read from the title ("Gerudo Valley - Ocarina of Time" by a remixer): a game, film or show
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
  /** Read with the list's notes dropped (`lookupForm`): cached apart from the listed reading */
  cleaned?: boolean;
}

// An artist field naming a kind of work: "Star Trek TV", "NieR Series", "Super Mario Franchise"
export const CATEGORY_ARTIST = /^(.+?)\s+(series|franchise|games|tv|tv series|tv shows?|movies|films)$/i;
// Films and shows: never video games
const SCREEN_CATEGORY = /^(tv|tv series|tv shows?|movies|films)$/i;
// Artist fields naming no one: "Traditional", "Italian Folk Song", "Anonymous"
export const NO_ONE = /^(?:traditional|trad\.?|anonymous|anon\.?|unknown|(?:\p{L}+\s+)?folk(?:\s+(?:song|tune|melody))?)$/iu;
// "Elton John arr. Brent Edstrom": who arranged a piece isn't who wrote it
const ARRANGER = /^\s*arr(?:\.|anged by)?\s+|\s+(?:arr(?:\.|anged by)?|arrangement by)\s+.*$/i;
// Joins names in one credit: "A - B", "A / B", "A ft. B", "A x B"
export const CREDIT_JOIN = /\s+[-–—]\s+|\s*\/\s*|\s+(?:[Ff]eat\.?|[Ff]t\.?|[Ff]eaturing)\s+|\s+x\s+/;
// A list's own mark after the names ("Some Singer - AB"), never looked up
const LIST_TAG = /^\p{Lu}{1,2}$/u;
// A work's music, not the work: "Picard Season 1 Theme"
const THEME_WORDS = /\s+((?:season\s+\d+\s+)?(?:(?:main|opening|ending|end|title|love)\s+)?theme)$/i;

/** Work in the title ("Star Trek II. The Wrath of Khan: ..." from "Star Trek Movies"): whole, then split at a dash or 2nd colon */
function worksInTitle(franchise: string, title: string, notGame: boolean): Reading[] {
  const m = new RegExp(`^${escapeRe(franchise)}(?=[\\s:])(.*)$`, "i").exec(title);
  if (!m) return [];
  // "II. The Wrath of Khan" is "II: The Wrath of Khan"; a bracket tag names the arrangement, not the work
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
    // No track name: "Theme", generic, so nothing in the work's article is taken as about this piece
    if (w && !out.some((r) => r.game === w)) out.push({ game: w, track: t || "Theme", notGame });
  };
  add(whole, "");
  const split = /^(.+?)\s[-–—]\s(.+)$/.exec(whole) ?? /^(.+?:.+?):\s*(.+)$/.exec(whole);
  if (split) add(split[1], split[2]);
  return out;
}

/** Ways to look a request up, most likely first (ARCHITECTURE.md: choosing the article) */
export function readings(song: SSLSong): Reading[] {
  const out = listedReadings(song);
  // "Some Song (from Some Show)": its own article under the show first, `trackOnly`, so the usual reading still follows
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
    // "Wild World - The Roost" from "Animal Crossing Series" is from "Animal Crossing: Wild World"
    const sep = /^(.+?)\s*(?::|\s[-–—]\s)\s*(.+)$/.exec(title);
    const installment = !inTitle.length && sep ? [{ game: `${franchise}: ${sep[1]}`, track: sep[2], notGame }] : [];
    // A name in brackets may be its real game ("Aquatic Ambiance (Donkey Kong Country)"): no series article
    const series = /\([^)]*\)\s*$/.test(title) ? [] : [{ game: `${franchise} series`, track: title, notGame }];
    return [...inTitle, ...installment, ...series];
  }

  if (hasNoArtist(artist) || NO_ONE.test(artist)) {
    // "Unknown" has long meant "read the title": that first
    return [...(/^unknown$/i.test(artist) ? [first] : []), { game: "", track: title, songAlone: true }];
  }

  const parts = [...new Set(artist.split(CREDIT_JOIN).map((p) => p.replace(ARRANGER, "").trim()).filter(Boolean))];
  const names = parts.some((p) => !LIST_TAG.test(p)) && parts.length > 1 ? parts.filter((p) => !LIST_TAG.test(p)) : parts;
  // "Some Singer - AB" is Some Singer's
  const alone = names.length === 1 && names[0].toLowerCase() !== artist.toLowerCase() && parts.length > 1;
  const start = alone ? [{ ...resolveGameAndTrack({ ...song, artist: names[0] }), trackOnly: false }] : [first];
  const others = alone ? [] : names.filter((n) => n.toLowerCase() !== artist.toLowerCase());
  if (names.length <= 1) {
    return [...start, ...others.map((name) => ({ ...resolveGameAndTrack({ ...song, artist: name }), trackOnly: false })), ...namedInTitle(title, start[0])];
  }
  // Several names: the song's own article under any ("Can You Feel the Love Tonight" under its third name
  // beats the first name's band), then the title's work, then a person-like name's performer article
  return [
    ...start,
    ...others.map((name) => ({ ...resolveGameAndTrack({ ...song, artist: name }), trackOnly: true })),
    ...namedInTitle(title, start[0]),
    ...others.filter(looksLikeArtistName).map((name) => ({ ...resolveGameAndTrack({ ...song, artist: name }), trackOnly: false, aPerformer: true })),
  ];
}

// "(1979)": when it came out or was added, not its name
const YEAR_TAG = /\s*[([]\s*(?:19|20)\d\d\s*[)\]]/g;
// "(feat. Some Singer)": another reading's job, not the name
const FEATURED_TAG = /\s*[([]\s*(?:feat|ft|featuring)\b[^)\]]*[)\]]/gi;
// A note after the name, closed or not: "(Australian)", "(Cherokee/Irish)", "(LGBTQ+"
const TRAILING_NOTE = /\s*[([][^)\]]*(?:[)\]]|$)\s*$/;
// "(from Some Show)", "(From "Some Film")"
const FROM_TAG = /\s*[([]\s*from\s+["“'‘]?([^)\]]*?)["”'’]?\s*[)\]]/i;
// "Some Song from Some Long Show": 2+ capitalized words, so "The Girl from Ipanema" stays whole
const FROM_WORK = /^(.+?)\s+[Ff]rom\s+((?:the\s+)?\p{Lu}[\p{L}'’.]*(?:\s+(?:of|the|and|in|on|a|an|to|for|&|\p{Lu}[\p{L}'’.]*|\d+))*\s+\p{Lu}[\p{L}'’.]*(?:\s+\d+)?)\s*$/u;
// "Some Song arr. Some Pianist", "Some Song arranged by Some Pianist"
const TITLE_ARRANGER = /\s+(?:arr\.|arranged by|arrangement by)\s+\S.*$/i;
// "14. Some Song"; the period spares "1979", "7 AM", "99 Luftballons"
const TRACK_NUMBER = /^\d{1,3}\.\s+(?=\p{L})/u;
// "Some Pianist (arr) Some Composer" is Some Composer's piece
const ARRANGED_BY_FIRST = /^.*?\S\s*[([]\s*arr(?:\.|anged|anger)?\s*[)\]]\s*(\p{L}.*)$/iu;

/** The work after "from", bracketed or not, or null: "Some Song (from Some Show)" */
export function workFromTitle(title: string): { track: string; work: string } | null {
  const tag = FROM_TAG.exec(title);
  const bare = tag ? null : FROM_WORK.exec(title.trim());
  const found = tag
    ? { track: (title.slice(0, tag.index) + title.slice(tag.index + tag[0].length)).trim(), work: tag[1].replace(/\s+/g, " ").trim() }
    : bare && { track: bare[1].trim(), work: bare[2].trim() };
  // "Theme from Some Show" names no piece: the theme rule's (themeOf)
  if (!found || !found.track || !found.work || GENERIC_TRACK.test(normalizeTitle(found.track)) || /\btheme$/i.test(found.track)) return null;
  return found;
}

/**
 * The song minus the list's notes ("Some Band (Australian)", year, feat.), or null if none. Tried after the
 * song as listed, so what works stays; the song itself is never altered. "(Don't Fear) The Reaper" stays
 */
export function lookupForm(song: SSLSong): SSLSong | null {
  let artist = (song.artist ?? "").trim();
  for (let m: RegExpExecArray | null; (m = TRAILING_NOTE.exec(artist)) && /\p{L}/u.test(artist.slice(0, m.index)); ) {
    artist = artist.slice(0, m.index).trim();
  }
  // Who arranged it isn't who wrote it
  artist = ARRANGED_BY_FIRST.exec(artist)?.[1].trim() ?? artist;
  if (/\p{L}/u.test(artist.replace(ARRANGER, ""))) artist = artist.replace(ARRANGER, "").trim();
  let title = song.title.replace(YEAR_TAG, "").replace(FEATURED_TAG, "").trim();
  // Title notes: track number, arranger, the work it's from (another reading's job)
  title = title.replace(TRACK_NUMBER, "").replace(TITLE_ARRANGER, "").trim();
  title = workFromTitle(title)?.track ?? title;
  if (!/\p{L}|\p{N}/u.test(title.replace(/[()[\]]/g, "")) || (title === song.title.trim() && artist === (song.artist ?? "").trim())) return null;
  return { ...song, title, artist };
}

/** What the title names besides the piece when the artist is a remixer or cover band: in brackets, or across a dash */
function namedInTitle(title: string, first: { game: string; track: string }): Reading[] {
  // The usual reading already took the work from the title
  if (first.track !== title) return [];
  // "Some Song (from Some Show)": the show is the work, like a game in the artist field
  const from = workFromTitle(title.replace(TITLE_ARRANGER, ""));
  if (from) return [{ game: from.work, track: from.track, trackOnly: true }];
  const bracket = /^(.+?)\s*\(([^)]+)\)$/.exec(title);
  if (bracket) return isVariantTag(bracket[2]) ? [] : [{ game: bracket[2].trim(), track: bracket[1].trim(), trackOnly: true }];
  const dash = /^(.+)\s[-–—]\s(.+)$/.exec(title);
  if (!dash || /\s[-–—]\s/.test(dash[1])) return [];
  const [left, right] = [dash[1].trim(), dash[2].trim()];
  return [
    { game: right, track: left, fromTitle: true },
    { game: left, track: right, fromTitle: true },
  ];
}

/** Letters to add, drop or change to turn one string into the other */
export function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

// Installment numbers, roman as arabic: "Star Trek II" has 2
const numerals = (s: string) => significantTokens(normalizeTitle(s)).filter((t) => /\d/.test(t));

/** Same name respelled: a letter or two in one word, or spacing ("Full Metal"). Not "Windy Harper" for "Wendy Harmer" */
export function isRespelling(name: string, page: string): boolean {
  const a = normalizeTitle(name);
  const b = normalizeTitle(page);
  if (!a || !b || a === b) return false;
  if (initialsDiffer(a, b)) return false;
  // "Memes" isn't a misspelled "Meme": a plural names many
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
 * Whether a redirect is the same thing under its proper name, not a list, album or one of several. An ungiven
 * number only inside the name ("Episode I"), never last: "Honkai Impact" isn't "Honkai Impact 3rd"
 */
export function isSameWorkRedirect(from: string, to: string): boolean {
  if (/^List of\b/i.test(to) || /\((?:[^)]*\b)?(album|soundtrack|EP|discography|filmography)\)$/i.test(to)) return false;
  // "FFVII" is "Final Fantasy VII": initials carry the installment number
  if (isInitials(from, to)) return true;
  // "Qumu" leads to "Qumu Corporation": a company isn't a musician or a work
  if (COMPANY.test(to) && !COMPANY.test(from)) return false;
  // A surname given a first name is one person of it ("Poirot" to "Hercule Poirot"); before
  // a colon is a series name ("Red Alert 3" to "Command & Conquer: Red Alert 3")
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

/** Whether a name is a title's initials, number kept ("FF7"). Only for Wikipedia's own redirects, never a guess */
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

/** A series' own article: "Kirby (series)", "Nier (series)" (to "Drakengard and Nier"), "Star Trek (franchise)"; or null */
export async function seriesPage(name: string): Promise<string | null> {
  const key = `\0series\0${name}`;
  const known = wikipediaNames.get(key);
  if (known !== undefined) return known;
  // Titles are case-sensitive: "NieR" is filed as "Nier"
  const cased = name.replace(/\p{L}+/gu, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  const forms = [...new Set([name, cased])].flatMap((n) => ["series", "franchise", "media franchise"].map((q) => `${n} (${q})`));
  const resolved = await wikiResolveTitles(forms);
  let found: string | null = null;
  for (const f of forms) {
    const hit = resolved.get(f);
    // "(series)" says which; one filed under a longer name still shares its words
    const shares = significantTokens(normalizeTitle(hit?.page ?? "")).some((w) => significantTokens(normalizeTitle(name)).includes(w));
    if (hit && !hit.fragment && !/^List of\b/i.test(hit.page) && (!hit.redirected || shares)) {
      found = hit.page;
      break;
    }
  }
  wikipediaNames.set(key, found);
  return found;
}

/** Wikipedia's own name for a name (its redirect, else spelling suggestion, gated), or null (ARCHITECTURE.md: choosing the article) */
export async function wikipediaName(name: string): Promise<string | null> {
  if (normalizeTitle(name).length < 3) return null;
  const known = wikipediaNames.get(name);
  if (known !== undefined) return known;
  let found: string | null = null;
  // Titles are case-sensitive: "Manuel da Falla", not "Manuel Da Falla"
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
  // A page or redirect has this very name: not misspelled
  if (!found && !direct.size) {
    const { titles, suggestion } = await wikiSearchSuggestion(name);
    const wanted = normalizeTitle(name);
    if (suggestion && !titles.some((t) => normalizeTitle(t) === wanted)) {
      const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
      // The suggestion is lowercase: cased like the request first ("Pirates of the Caribbean")
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

/** The song's own article as a reference; sections the usual order ignores ("Origin", "Form"): all but the lists */
export function ownArticleExtract(full: string, budget: number, names: string[]): string {
  const extract = orderExtract(full, budget, names);
  return extract.length >= MIN_CONTEXT_CHARS ? extract : orderExtract(full, budget, names, true, NOT_A_LIST);
}

// A song, in its article's opening: "a traditional English folk song"
const SONG_WORDS = /\b(song|ballad|hymn|carol|tune|melody|lullaby|anthem|folk ?song|canzone|chanson)s?\b/i;

/** A song by no one ("Traditional"): its own article by title alone, opening as a song ("Santa Lucia" is a town too) */
export async function groundSongAlone(song: SSLSong, title: string, usable: (title: string) => boolean): Promise<Grounded> {
  const key = `\0alone\0${normalizeTitle(title)}`;
  const hit = groundingCache.get(key);
  if (hit && (hit.text || Date.now() - hit.at < NEGATIVE_TTL_MS) && (!hit.text || usable(hit.text.split("\n")[0]))) return { text: hit.text, unreachable: false };
  const tried = new Set<string>();
  try {
    for (const term of [`${title} song`, title]) {
      const titles = (await wikiSearch(term)).filter((t) => usable(t) && !tried.has(t) && isRelevantArticle(title, t));
      // "Santa Lucia (song)" before "Santa Lucia"
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
  /** Throttled or unreachable: the miss says nothing, so no other reading is tried */
  unreachable: boolean;
}
