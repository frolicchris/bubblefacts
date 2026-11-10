import { AsyncLocalStorage } from "async_hooks";
import { config } from "../config";
import { withinStandard } from "../content-standard";
import { htmlToText } from "../wiki-html";
import { foldSymbols, mentionsName, normalizeTitle } from "./titles";

// Reading Wikipedia: search, extracts, wikitext, and an article's settled older version

export const WIKI_API = "https://en.wikipedia.org/w/api.php";
export const USER_AGENT =
  `bubblefacts/1.0 (${process.env.WIKIPEDIA_CONTACT || "https://github.com/frolicchris/bubblefacts"})`;

/** Wikipedia throttled us: the article may exist, so the miss is never cached */
export class RateLimited extends Error {}

// --- Wikipedia lookup ---

/** Search terms, most likely first. A bare track name ("Overture") only for a person or band: for a game it finds a generic article */
export function searchTerms(game: string, track: string, artist: boolean, notGame = false): string[] {
  const hasTrack = track && track !== game;
  const trackTerms = hasTrack ? [`${track} ${game}`, `${track} ${foldSymbols(game)}`, ...(artist ? [track] : [])] : [];
  const subjectTerms = game ? [...(artist || notGame ? [] : [`${game} video game`]), `${game} soundtrack`, game] : [];
  const terms = artist ? [...trackTerms, ...subjectTerms] : [...subjectTerms, ...trackTerms];
  return [...new Set(terms.map((t) => t.trim()).filter(Boolean))];
}

export async function wikiGet<T>(params: string, timeoutMs: number, what: string): Promise<T> {
  const res = await fetch(`${WIKI_API}?${params}&format=json`, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "User-Agent": USER_AGENT },
  });
  if (res.status === 429) throw new RateLimited(what);
  if (!res.ok) throw new Error(`${what} HTTP ${res.status}`);
  return (await res.json()) as T;
}

// Search results a lookup saw, in order, for the scored match (work-resolver.ts)
const searchLog = new AsyncLocalStorage<string[][]>();

/** Runs a lookup; returns what it found and every search result list it saw */
export async function withSearches<T>(lookup: () => Promise<T>): Promise<{ found: T; searches: string[][] }> {
  const searches: string[][] = [];
  const found = await searchLog.run(searches, lookup);
  return { found, searches };
}

export async function wikiSearch(term: string): Promise<string[]> {
  const data = await wikiGet<{ query?: { search?: Array<{ title: string }> } }>(
    `action=query&list=search&srlimit=5&srsearch=${encodeURIComponent(term)}`,
    config.groundingTimeoutMs,
    "search"
  );
  const titles = (data.query?.search ?? []).map((h) => h.title);
  searchLog.getStore()?.push(titles);
  return titles;
}

/** A search's hits, and Wikipedia's suggested spelling when it thinks the term misspelled */
export async function wikiSearchSuggestion(term: string): Promise<{ titles: string[]; suggestion: string }> {
  const data = await wikiGet<{ query?: { search?: Array<{ title: string }>; searchinfo?: { suggestion?: string } } }>(
    `action=query&list=search&srlimit=5&srprop=&srinfo=suggestion&srsearch=${encodeURIComponent(term)}`,
    config.groundingTimeoutMs,
    "search"
  );
  const titles = (data.query?.search ?? []).map((h) => h.title);
  searchLog.getStore()?.push(titles);
  return { titles, suggestion: data.query?.searchinfo?.suggestion ?? "" };
}

/** Where Wikipedia files each exact title: the page, its redirect target (`fragment`: into a section), or nothing */
export async function wikiResolveTitles(names: string[]): Promise<Map<string, { page: string; redirected: boolean; fragment: boolean }>> {
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

export const MUSIC_HEADING = /music|soundtrack|audio|score|style/i;
const BACKGROUND_HEADING = /development|production|career|works|discography/i;

// A creator talking about the work: "said", "recalled", "was inspired by"
export const CREATOR_CUE =
  /\b(said|says|stated|recalled|recalls|explained|explains|remembered|described (?:how|the|it|writing|recording)|according to|in an interview|inspired by|inspiration|influenc\w+|based (?:it )?on|modell?ed (?:it )?(?:on|after)|drew (?:on|from)|borrow\w+|homage|tribute to|was written (?:after|while|when|during|in (?:about|just|under))|wrote (?:it|the song|the piece|the track|the music) (?:after|while|when|during|in)|came up with|originally (?:titled|entitled|intended|written|called|planned|composed|named|meant)|intended|wanted|decided|felt that|took (?:only|about|just))\b/i;
// "Astley told the Los Angeles Times": told, then a name
export const TOLD_SOMEONE = /\btold (?:the |an? )?\p{Lu}/u;
// About the music, not the business around it
export const ABOUT_MUSIC = /\b(music|songs?|tracks?|themes?|score|melody|melodies|soundtrack|compos\w+|record\w*|lyrics?|riff|chords?|album|tune|piece|arrang\w+|vocals?|piano|guitar|demo|title)\b/i;
// Sections holding the makers' comments on the music
const MAKING_HEADING = /recording|composition|production|development|conception|background|writing|music|creation|origin|inspiration/i;
// Others' opinions, later uses, lists
const NOT_THE_MAKERS_HEADING =
  /reception|review|accolade|chart|certification|track listing|personnel|credits|legacy|impact|music video|cover|version|popular culture|media|usage|use in|adaptation|sampl|reference|see also|external|release|commercial|performance/i;
// Critics, the press, scholars: not the makers
const CRITIC_WORDS =
  /\b(critics?|reviewers?|magazine|publication|newspaper|journalist|correspondent|writer|musicologist|scholar|author|biograph\w+|documentary|interpreted|ranked|listed|review(?:ed|s)?|praised|called it|charts?|streamed|copies|sold)\b/i;
export const CRITIC_NAMES =
  /\b(IGN|GameSpot|GameSpy|GamePro|Game Informer|Nintendo Power|Edge|1UP|Destructoid|Tom's Guide|AllMusic|Pitchfork|Rolling Stone|Billboard|NME|Kotaku|Polygon|RPGFan|Eurogamer|Famitsu|Stereogum|MTV|NPR|BBC|USA Today|Variety|Melody Maker|[A-Z]\w+ (?:Times|News|Post|Tribune|Herald|Guardian|Telegraph))\b/;
export const CRITIC = { test: (s: string) => CRITIC_WORDS.test(s) || CRITIC_NAMES.test(s) };
// Leans on the sentence before: can't be retold alone
const LEANS_BACK = /^["“]?(?:I|We|He|She|They|It|His|Her|Their|This|These|That|Those|Hence|However|Instead|Meanwhile|Therefore|The same|A similar|Despite|Asked|When asked)\b/;
const MAX_COLOR_SENTENCES = 5;  // makers' sentences lifted, at most
const MAX_COLOR_CHARS = 900;    // chars for all of them

// For a whole game's or artist's article, where "title" and "piece" could mean anything
const PLAINLY_MUSIC = /\b(music|songs?|tracks?|soundtrack|score|melody|melodies|compos\w+|lyrics?|theme song|main theme)\b/i;

/** The makers' words on the music, the best few in article order: often far past the lead (#48) */
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
      // Whole game or artist: only what names the track or is plainly music
      if (!namesTrack && !(ownArticle ? ABOUT_MUSIC.test(text) : PLAINLY_MUSIC.test(text) && making)) continue;
      // Leans back, or cut by the split: open quote, trailing colon, stray initial
      if (cutOff(text)) continue;
      // Someone has to be named
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

// How the work did, countably: charts, awards, certifications, sales
const RECEIVED_CUE =
  /\b(number[- ]one|number \d+|No\. ?\d+|top (?:ten|five|\d+)|topped|peaked|reached|charted|won|winning|awarded|nominat\w+|Grammy|Academy Award|Oscar|BAFTA|Golden Globe|certified|platinum|gold|diamond|best[- ]selling|million|billion|inducted|Hall of Fame|National Recording Registry|first (?:video game|song|single|piece)\b.{0,40}\bto)\b/i;
const RECEIVED_HEADING = /reception|commercial|chart|accolade|award|legacy|release|impact/i;
const MAX_RECEIVED_SENTENCES = 3;
const MAX_RECEIVED_CHARS = 450;

/** Whether a split left the sentence unable to stand alone */
export const brokenBySplit = (text: string) =>
  (text.match(/["“”]/g)?.length ?? 0) % 2 === 1 || /[:;,]$/.test(text) || /\b\p{Lu}\.$/u.test(text);
export const cutOff = (text: string) => LEANS_BACK.test(text) || brokenBySplit(text);

/** Countable reception (chart peaks, awards, sales) from the lead and Reception-like sections; never opinions */
export function receptionSentences(full: string): string[] {
  const sections = [["", full.split(/\n==/)[0]], ...[...full.matchAll(/\n==+\s*([^=\n]+?)\s*==+\n([\s\S]*?)(?=\n==|$)/g)].map((m) => [m[1], m[2]])];
  const kept: string[] = [];
  let used = 0;
  for (const [heading, body] of sections) {
    if (heading && !RECEIVED_HEADING.test(heading)) continue;
    for (const raw of body.split(/(?<=[.!?]["”]?)\s+(?=["“]?\p{Lu})|\n+/u)) {
      const text = raw.trim();
      // "It reached number one" is fine: in the song's article "it" is the song
      if (text.length < 40 || text.length > 260 || !RECEIVED_CUE.test(text) || OPINION.test(text) || brokenBySplit(text)) continue;
      if (LEANS_BACK.test(text) && !/^It\b/.test(text)) continue;
      if (kept.length >= MAX_RECEIVED_SENTENCES || used + text.length > MAX_RECEIVED_CHARS) return kept;
      kept.push(text);
      used += text.length + 1;
    }
  }
  return kept;
}

// How the music is built: key, tempo, meter, harmony, form
const THEORY_CUE =
  /\b(key of|[A-G](?:[-♭♯ ](?:flat|sharp))? (?:major|minor)|in (?:a )?(?:major|minor)|tempo|beats per minute|bpm|time signature|\d\/\d time|common time|chord progression|chords?|arpeggi\w+|ostinato|leitmotifs?|modulat\w+|syncopat\w+|counterpoint|riff|scale|Dorian|Phrygian|Lydian|Mixolydian|pentatonic|octaves?|vocal range|spans|bars?\b|measures|verse[- ]chorus|bridge|coda|waltz)\b/i;
const THEORY_HEADING = /composition|music|structure|analysis|style|lyrics|form|theme/i;
const MAX_THEORY_SENTENCES = 3;
const MAX_THEORY_CHARS = 450;

/** Sentences on how the music is built, from Composition or Structure sections */
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

// The music video or what's worn in it, not "video game"
const VIDEO_HEADING = /\b(?:videos?(?!\s*games?)|fashion|visuals?)\b/i;

/** Minus music-video sections: a video's story reads as real, a shoot's details as the recording's ("wore a Gucci bathing suit") */
export function withoutVideoSections(full: string): string {
  const out: string[] = [];
  let skipBelow = 0; // level of the video section being skipped
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

/** Cut back to the last whole sentence, so the model never copies half of one */
export function wholeSentences(text: string): string {
  if (/[.!?]["”)]?$/.test(text)) return text;
  const end = Math.max(text.lastIndexOf(". "), text.lastIndexOf('." '), text.lastIndexOf(".\n"));
  // Only when little is lost; few sentence breaks: left as is
  return end > text.length * 0.7 ? text.slice(0, end + 1) : text;
}

/**
 * Up to `budget` chars: makers' words, music sections, background, then the lead (year and platform for
 * screening; a small model reads a long context's tail least). `ownArticle` false: plainly music only, no reception
 */
export function orderExtract(full: string, budget: number, names: string[] = [], ownArticle = true, primaryHeading: RegExp = MUSIC_HEADING): string {
  full = withoutVideoSections(full);
  // Makers' words first: worth retelling, and a small model reads the top best
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
  // A subsection takes its parent's bucket
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

// Age before a version is read (#242): vandalism goes in hours, three days means its watchers saw it
export const STABLE_AGE_MS = 72 * 60 * 60 * 1000;

// Older versions read this session, as text, by revision number
const stableTexts = new Map<number, string>();
const MAX_STABLE_TEXTS = 40;
// Older versions that couldn't be read: `fetchGrounding` then skips Wikipedia for the song
export let olderVersionFailures = 0;

/** Restores the count after a lookup whose failure shouldn't keep the song off Wikipedia */
export function setOlderVersionFailures(count: number): void {
  olderVersionFailures = count;
}

/** Newest version at least `STABLE_AGE_MS` old, or null; throws when unreadable (Wikipedia skipped this time) */
async function stableVersionText(pageTitle: string, now: number): Promise<string | null> {
  const before = new Date(now - STABLE_AGE_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
  const data = await wikiGet<{ query?: { pages?: Record<string, { revisions?: Array<{ revid?: number; timestamp?: string }> }> } }>(
    `action=query&prop=revisions&rvlimit=1&rvdir=older&rvstart=${encodeURIComponent(before)}&rvprop=ids%7Ctimestamp&titles=${encodeURIComponent(pageTitle)}`,
    config.groundingTimeoutMs,
    "older version"
  );
  const rev = Object.values(data.query?.pages ?? {})[0]?.revisions?.[0];
  if (!rev?.revid) return null;
  const known = stableTexts.get(rev.revid);
  if (known !== undefined) return known;
  const parsed = await wikiGet<{ parse?: { text?: string } }>(
    `action=parse&oldid=${rev.revid}&prop=text&formatversion=2&disableeditsection=1&disablelimitreport=1&disabletoc=1`,
    config.groundingExtractTimeoutMs,
    "older version"
  );
  if (typeof parsed.parse?.text !== "string") throw new Error("older version HTTP 200 without text");
  const text = htmlToText(parsed.parse.text);
  stableTexts.set(rev.revid, text);
  if (stableTexts.size > MAX_STABLE_TEXTS) stableTexts.delete(stableTexts.keys().next().value as number);
  return text;
}

/**
 * The revision a lookup reads now (newest at least `STABLE_AGE_MS` old), or null. One small request:
 * the preparer checks whether a prepared song's article changed (#292). Throws when it can't ask
 */
export async function settledRevision(pageTitle: string, now = Date.now()): Promise<number | null> {
  const before = new Date(now - STABLE_AGE_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
  const data = await wikiGet<{ query?: { pages?: Record<string, { revisions?: Array<{ revid?: number }> }> } }>(
    `action=query&prop=revisions&rvlimit=1&rvdir=older&rvstart=${encodeURIComponent(before)}&rvprop=ids&redirects=1&titles=${encodeURIComponent(pageTitle)}`,
    config.groundingTimeoutMs,
    "revision"
  );
  return Object.values(data.query?.pages ?? {})[0]?.revisions?.[0]?.revid ?? null;
}

/**
 * The article's text the model may read, or null (disambiguation, nothing old enough). Settled version only
 * (throws if unreadable); the content standard applies here, so nothing downstream sees what it leaves out
 */
export async function wikiExtract(pageTitle: string): Promise<string | null> {
  // exsectionformat=wiki keeps the "==" headings orderExtract relies on
  const data = await wikiGet<{ query?: { pages?: Record<string, { extract?: string; revisions?: Array<{ timestamp?: string }> }> } }>(
    `action=query&prop=extracts%7Crevisions&rvprop=timestamp&explaintext=1&exsectionformat=wiki&titles=${encodeURIComponent(pageTitle)}`,
    config.groundingExtractTimeoutMs,
    "extract"
  );
  const page = Object.values(data.query?.pages ?? {})[0];
  let raw = page?.extract;
  const now = Date.now();
  const edited = Date.parse(page?.revisions?.[0]?.timestamp ?? "");
  // No date counts as a fresh edit: never read unchecked
  if (raw && !(now - edited >= STABLE_AGE_MS)) {
    try {
      raw = (await stableVersionText(pageTitle, now)) ?? undefined;
    } catch (err) {
      olderVersionFailures++;
      throw err;
    }
    console.log(`[Grounding] "${pageTitle}" was edited in the last 72 hours: ${raw ? "reading the version from before" : "no older version, skipping it"}`);
  }
  if (!raw) return null;
  const kept = withinStandard(raw, pageTitle);
  if (kept.dropped || kept.sections) {
    console.log(`[Standard] "${pageTitle}": left out ${kept.dropped} of ${kept.sentences} sentences (${kept.sections} sections)`);
  }
  const full = kept.text.trim() ? kept.text : "";
  if (full) rememberArticle(pageTitle, full);
  return full && !isDisambiguation(full) ? full : null;
}

/** A disambiguation or list page, even one opening with its main meaning ("2 A.M. is a time ... may also refer to:") */
export function isDisambiguation(full: string): boolean {
  return /\b(?:may|can) (?:also )?refer to\b/i.test(full.slice(0, 300));
}

// --- Does the article fit the request? ---

// Recent articles, whole, by title: fit is judged on the whole (opening, every name), not the cut reference
export const articleTexts = new Map<string, string>();
export const MAX_ARTICLE_TEXTS = 40;

export function rememberArticle(page: string, full: string): void {
  articleTexts.delete(page);
  articleTexts.set(page, full);
  if (articleTexts.size > MAX_ARTICLE_TEXTS) articleTexts.delete(articleTexts.keys().next().value as string);
}

// Dropped even when sourced: opinions read as fact, undercutting real facts (#21); viewers already see the video (#20)
export const OPINION = /\b(considered (?:one|to be|as|by|a|an|among|the (?:best|greatest|finest|most|top))|(?:among|some of) the (?:best|greatest|finest|most)|instantly recognizable|regarded|praised|acclaimed|hailed|lauded|critics?|critically|masterpiece|greatest|iconic|beloved|celebrated|described as|one of the (best|finest|most))\b/i;
