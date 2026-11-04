// A second source for fun (2026-11): one article rarely holds a fact chat would repeat. When the
// reference has few fun sentences (`sentenceFun`), the sections of a related article that tell how
// the music was made (Background, Recording, Composition, Writing, Production, Inspiration) are read
// for sentences that name this very song or its album, and the most fun few join the reference on
// a line of their own, labelled with that article's title like a companion article's line (issue
// #48): a caption from them is credited and linked to it, and Wrong blocks that page. The writer is
// not told to retell them; they are only more text to write from. A sentence about the whole album
// brings a prompt rule to make the album the caption's subject (`ALBUM_SENTENCE_RULE`).
import { config } from "./config";
import { setCapped } from "./capped-map";
import { FUN_SENTENCE_MIN, sentenceFun, sourceRisk } from "./fact-ranking";
import { articleText, isPerformerArticle, mentionsName, normalizeTitle, performerPages, referenceSentences, resolveGameAndTrack, wikiExtract, wikitextOf, withoutVideoSections } from "./fact-verifier";
import { SSLSong } from "./types";

/** A reference with fewer fun sentences than this is thin, and a second article is read. */
export const FUN_THIN = 2;
/** At most this many sentences, and characters, from second articles. */
const MAX_PICKS = 3;
const MAX_CHARS = 600;
/** Sections that tell how the music was made. */
const MAKING_HEADING = /background|recording|composition|writing|songwriting|production|inspiration|development|origin|conception|music|lyrics|history/i;
/** Sections with nothing to retell, even under a making heading. */
const SKIP_HEADING = /track listing|personnel|credits|chart|certification|reception|review|accolade|award|release|music video|live|cover|legacy|references|notes|external|see also|bibliography|further reading/i;
/** A subject the sentence doesn't name, left behind in its paragraph: "He recorded it ...". */
const PRONOUN_START = /^(?:it|its|they|their|them|he|his|she|her|this|these|those|that|such|both|the two|the pair|the band|the group|the album|the song|the track)\b/i;
/** Release, edition and chart news: dry, and what second articles mostly say about a song (test lists, 2026-11). */
const RELEASE_NEWS = /\b(?:released|re-?released|reissued?|editions?|remaster\w*|charted|charts?|number[- ]one|certified|platinum|anniversary|singles?)\b/i;
/** A sentence comparing the album with another record: "its first number-one album since Some Album". */
const OTHER_ALBUM = /\b(?:since|than|follow-up to|successor to|predecessor|previous album|next album|debut album)\b/i;
/** Titles too common to find a song by: "Intro", "Theme". */
const GENERIC = /^(?:intro|outro|interlude|theme|main theme|overture|prologue|epilogue|title|untitled|reprise|opening|ending|credits)$/;

/** Whether a sentence names `track` in quotation marks, as Wikipedia sets a song's title. */
function quotes(sentence: string, track: string): boolean {
  const name = normalizeTitle(track);
  return [...sentence.matchAll(/["“]([^"“”\n]{1,120})["”]/g)].some((m) => normalizeTitle(m[1]) === name);
}

/** An article's sections as [heading path, body], the lead first with an empty heading. */
function sections(full: string): Array<[string, string]> {
  const out: Array<[string, string]> = [["", full.split(/\n==/)[0]]];
  const path: string[] = [];
  for (const m of full.matchAll(/\n(==+)\s*([^=\n]+?)\s*==+\n([\s\S]*?)(?=\n==|$)/g)) {
    const level = m[1].length - 2;
    path.splice(level, path.length, m[2]);
    out.push([path.join(" / "), m[3]]);
  }
  return out;
}

/**
 * The most fun sentences of an article's making sections (with `anySection`, for a performer's
 * article whose sections are the years of a career, any but lists, reception and the like)
 * that name `track` in quotation marks, or, given the song's `album`, that name the album by its
 * title and quote no song (`album: true`, about the whole album), best first: each 40 to 320
 * characters, standing alone (no "He ..." left from its paragraph), not one the safety screen
 * would hold back, scoring at least FUN_SENTENCE_MIN, and not in `already` (the reference).
 * Pure: the article's text in, sentences out.
 */
export function funSourceSentences(full: string, track: string, already = "", n = MAX_PICKS, anySection = false, album = ""): Array<{ text: string; score: number; album: boolean }> {
  const name = normalizeTitle(track);
  if (name.length < 3 || GENERIC.test(name)) return [];
  const albumName = normalizeTitle(album.replace(/\s*\([^)]*\)$/, ""));
  const ofAlbum = (text: string) =>
    albumName.length >= 4 && albumName !== name && mentionsName(normalizeTitle(text), [albumName]) && !/["“][^"“”\n]{1,120}["”]/.test(text) && !OTHER_ALBUM.test(text);
  const seen = already.replace(/\s+/g, " ");
  const found: Array<{ text: string; score: number; at: number; album: boolean }> = [];
  let at = 0;
  for (const [heading, body] of sections(withoutVideoSections(full))) {
    if (!heading || (!anySection && !MAKING_HEADING.test(heading)) || SKIP_HEADING.test(heading)) continue;
    for (const raw of body.split(/(?<=[.!?]["”]?)\s+(?=["“]?\p{Lu})|\n+/u)) {
      const text = raw.trim();
      at++;
      if (text.length < 40 || text.length > 320 || !/[.!?]["”]?$/.test(text) || PRONOUN_START.test(text)) continue;
      if (RELEASE_NEWS.test(text)) continue;
      const song = quotes(text, track);
      if (!(song || ofAlbum(text)) || seen.includes(text.replace(/\s+/g, " "))) continue;
      if (sourceRisk(text, text, false).some((f) => f !== "compressed under half")) continue;
      const score = sentenceFun(text);
      if (score >= FUN_SENTENCE_MIN) found.push({ text, score, at, album: !song });
    }
  }
  return found
    .sort((a, b) => b.score - a.score || a.at - b.at)
    .slice(0, Math.max(0, n))
    .map(({ text, score, album: whole }) => ({ text, score, album: whole }));
}

/** Sentences about a whole album that a reference was given (`withFunSource`). */
const albumSentences = new Map<string, true>();
const MAX_ALBUM_SENTENCES = 600;

/**
 * Whether the reference has a second article's sentence about the song's whole album: the
 * prompt then says to name the album in such a caption and never write it as about the song.
 */
export function hasAlbumSentence(context: string): boolean {
  if (!albumSentences.size || !/^From the article "/m.test(context)) return false;
  return [...albumSentences.keys()].some((s) => context.includes(s));
}

/** The prompt's rule for a second article's sentence about the album (`hasAlbumSentence`). */
export const ALBUM_SENTENCE_RULE = ` A statement about the album the song is on is about the whole album: make the album the subject of your caption and name it, like "Its album TITLE was ...", with the real title from the text. Never write it as if it were about the song playing now.`;

/** Whether a reference is thin on fun: fewer than FUN_THIN sentences that score FUN_SENTENCE_MIN. */
export function thinOnFun(context: string): boolean {
  return referenceSentences(context).filter((s) => sentenceFun(s) >= FUN_SENTENCE_MIN).length < FUN_THIN;
}

/** "| album = ''[[Some Album]]''": the album a song's infobox links. */
export function infoboxAlbum(wikitext: string): string | null {
  const field = /^\s*\|\s*album\s*=\s*(.*)$/im.exec(wikitext)?.[1] ?? "";
  const link = /\[\[([^|\]#]+)/.exec(field)?.[1]?.replace(/_/g, " ").trim();
  return link ? link.charAt(0).toUpperCase() + link.slice(1) : null;
}

/**
 * Articles that may say more about the song than the reference `page`: for the song's own
 * article, its album's (from the infobox) and its performer's; for a game's or a work's
 * article, its "Music of" article and the work's own. Never the performer's article when
 * it is the reference already.
 */
async function secondPages(page: string, full: string, song: SSLSong, game: string, track: string): Promise<Array<{ page: string; performer: boolean; album?: string }>> {
  if (isPerformerArticle(page, full)) return [];
  const own = mentionsName(normalizeTitle(page), [normalizeTitle(track)]);
  if (!own) return [`Music of ${game}`, game].map((p) => ({ page: p, performer: false }));
  const album = infoboxAlbum(await wikitextOf(page));
  const performer = song.artist ? (await performerPages(song.artist, track)).performer : null;
  return [
    ...(album ? [{ page: album, performer: false, album }] : []),
    ...(performer ? [{ page: performer, performer: true }] : []),
    { page: `Music of ${game}`, performer: false },
  ];
}

/** Second-article lines found per reference and track. */
const cache = new Map<string, string>();
const MAX_CACHED = 200;

/**
 * The reference with up to MAX_PICKS fun sentences about the song from a second article, on
 * lines labelled `From the article "Title": ` right after the title line; the reference as it
 * is when it already has fun to tell, nothing else names the song, or Wikipedia can't be asked.
 * `usable` keeps out the articles the streamer marked wrong for the song.
 */
export async function withFunSource(context: string, song: SSLSong, usable: (title: string) => boolean): Promise<string> {
  if (!config.funSource || !context || !thinOnFun(context)) return context;
  const page = context.split("\n")[0];
  const { game, track } = resolveGameAndTrack(song);
  if (!track || normalizeTitle(track) === normalizeTitle(game)) return context;
  const key = `${page}\0${normalizeTitle(game)}\0${normalizeTitle(track)}`;
  let lines = cache.get(key);
  if (lines === undefined) {
    try {
      const picks: Array<{ page: string; text: string; score: number; album: boolean }> = [];
      const full = articleText(page) || context;
      const read = new Set<string>([page]);
      for (const { page: other, performer, album } of await secondPages(page, full, song, game, track)) {
        if (read.has(other) || other.includes('"') || !other.trim()) continue;
        read.add(other);
        const text = articleText(other) || (await wikiExtract(other));
        if (!text) continue;
        picks.push(...funSourceSentences(text, track, context, MAX_PICKS, performer, album).map((s) => ({ page: other, ...s })));
      }
      const kept: typeof picks = [];
      let used = 0;
      for (const p of picks.sort((a, b) => b.score - a.score)) {
        if (kept.length >= MAX_PICKS || used + p.text.length > MAX_CHARS || kept.some((k) => k.text === p.text)) continue;
        kept.push(p);
        used += p.text.length + 1;
        if (p.album) setCapped(albumSentences, p.text, true, MAX_ALBUM_SENTENCES);
      }
      const byPage = new Map<string, string[]>();
      for (const p of kept) byPage.set(p.page, [...(byPage.get(p.page) ?? []), p.text]);
      lines = [...byPage].map(([title, texts]) => `From the article "${title}": ${texts.join(" ")}`).join("\n");
      setCapped(cache, key, lines, MAX_CACHED);
      if (lines) console.log(`[FunSource] "${page}" is thin on fun: ${kept.length} sentences about "${track}" or its album from ${[...byPage.keys()].map((t) => `"${t}"`).join(", ")}`);
    } catch {
      // Throttled or unreachable: the reference serves alone, and nothing is remembered.
      return context;
    }
  }
  const usableLines = lines
    .split("\n")
    .filter((line) => {
      const title = /^From the article "([^"\n]+)": /.exec(line)?.[1];
      return title && usable(title);
    });
  if (!usableLines.length) return context;
  const [title, ...rest] = context.split("\n");
  return `${title}\n${usableLines.join("\n")}\n\n${rest.join("\n")}`;
}
