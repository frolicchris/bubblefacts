import { setCapped } from "../capped-map";
import { normalizeTitle } from "./titles";
import { withoutQualifier } from "./relevance";
import { CREATOR_CUE, creatorSentences, CRITIC, cutOff, olderVersionFailures, OPINION, setOlderVersionFailures, TOLD_SOMEONE, wikiExtract, wikiResolveTitles, withoutVideoSections } from "./wikipedia";
import { wikitextOf } from "./work-scope";
import { articleText } from "./covers";
import { GENERIC_TRACK, isMusicArticleFor } from "./summary";
import { groundingCache, NEGATIVE_TTL_MS } from "./readings";

/**
 * A companion article (issue #48, step 2): the game's music article or the
 * album's adds its sentences about the track when the track's own says little.
 */

// --- A companion article (issue #48, step 2) ----------------------------------
//
// A track's own article often says little about how it was made, while the
// game's music article or the album's says more: one track's page had two such
// sentences, its series' "Music of" page six. When the reference's article has
// fewer than MIN_MAKING_SENTENCES, the companion's sentences about this very
// track join the reference on a line of their own, labelled with the
// companion's title, so a caption from them is credited and linked to it (and
// Wrong blocks that page). Never the companion's general soundtrack facts.

/** Fewer sentences than this from the makers in the article: a companion article is read for more. */
export const MIN_MAKING_SENTENCES = 3;
const MAX_COMPANION_SENTENCES = 4;
const MAX_COMPANION_CHARS = 800;
/** The label of a companion article's line in a reference: `From the article "Music of Some Game": ...`. */
export const COMPANION_LABEL = /^From the article "([^"\n]+)": /;
const companionLabel = (page: string) => `From the article "${page}": `;
/** Sections of a companion with nothing to retell: lists, credits, references. */
const COMPANION_SKIP_HEADING = /track listing|personnel|credits|chart|certification|references|notes|external|see also|bibliography|further reading/i;

/** Companion articles found per article and subject, a miss kept NEGATIVE_TTL_MS. */
export const companionCache = new Map<string, { page: string; full: string } | { page: ""; at: number }>();
const MAX_COMPANIONS = 100;

/** Whether a sentence names the track in quotation marks, as Wikipedia sets a song's title: "Some Track". */
function quotesTrack(sentence: string, track: string): boolean {
  const name = normalizeTitle(track);
  return [...sentence.matchAll(/["“]([^"“”\n]{1,120})["”]/g)].some((m) => normalizeTitle(m[1]) === name);
}

/**
 * The companion article's sentences about this track, in article order: those
 * that name it in quotation marks, and those in a section headed with its name
 * that name no other title. What the makers said comes first when the budget
 * is short. Each must stand alone, carry no critic's opinion, and not be
 * in `already` (the reference's own article).
 */
export function companionSentences(full: string, track: string, already = ""): string[] {
  const name = normalizeTitle(track);
  if (name.length < 3 || GENERIC_TRACK.test(name)) return [];
  const seen = already.replace(/\s+/g, " ");
  const found: Array<{ text: string; at: number; cue: boolean }> = [];
  let at = 0;
  const sections = [["", full.split(/\n==/)[0]], ...[...full.matchAll(/\n==+\s*([^=\n]+?)\s*==+\n([\s\S]*?)(?=\n==|$)/g)].map((m) => [m[1], m[2]])];
  for (const [heading, body] of sections) {
    if (COMPANION_SKIP_HEADING.test(heading)) continue;
    const ofTrack = normalizeTitle(heading.replace(/^["“](.*)["”]$/, "$1")) === name;
    for (const raw of body.split(/(?<=[.!?]["”]?)\s+(?=["“]?\p{Lu})|\n+/u)) {
      const text = raw.trim();
      at++;
      if (text.length < 40 || text.length > 320 || cutOff(text) || OPINION.test(text) || CRITIC.test(text)) continue;
      const quoted = /["“][^"“”\n]{1,120}["”]/.test(text);
      if (!(quotesTrack(text, track) || (ofTrack && !quoted))) continue;
      if (seen.includes(text.replace(/\s+/g, " "))) continue;
      found.push({ text, at, cue: CREATOR_CUE.test(text) || TOLD_SOMEONE.test(text) });
    }
  }
  const kept: typeof found = [];
  let used = 0;
  for (const s of [...found].sort((a, b) => Number(b.cue) - Number(a.cue) || a.at - b.at)) {
    if (kept.length >= MAX_COMPANION_SENTENCES || used + s.text.length > MAX_COMPANION_CHARS) continue;
    kept.push(s);
    used += s.text.length + 1;
  }
  return kept.sort((a, b) => a.at - b.at).map((s) => s.text);
}

/** "[[Music of Some Game]]", "| album = ''[[Some Album]]''": linked page titles, the infobox's album first. */
function companionLinks(wikitext: string): { album: string | null; links: string[] } {
  const title = (link: string) => {
    const t = link.replace(/_/g, " ").replace(/\s+/g, " ").trim();
    return t.charAt(0).toUpperCase() + t.slice(1);
  };
  const albumField = /^\s*\|\s*album\s*=\s*(.*)$/im.exec(wikitext)?.[1] ?? "";
  const album = /\[\[([^|\]#]+)/.exec(albumField)?.[1];
  const links = [...wikitext.matchAll(/\[\[([^|\]#:]+)(?:#[^|\]]*)?(?:\|[^\]]*)?\]\]/g)].map((m) => title(m[1]));
  return { album: album ? title(album) : null, links: [...new Set(links)] };
}

/**
 * The companion article for `page` and its subject `game` (a game or an artist), or null: the
 * album the article's infobox names, a "Music of" or soundtrack page it links to, or, for a game's
 * track, the game's "Music of" page under its usual names. One title lookup and one article read,
 * both remembered; the article's wikitext is the infobox facts' own. Never a blocked page.
 */
async function findCompanion(page: string, game: string, track: string, usable: (title: string) => boolean, gameTrack: boolean): Promise<{ page: string; full: string } | null> {
  const key = `${page}\0${normalizeTitle(game)}`;
  const hit = companionCache.get(key);
  if (hit && (hit.page || Date.now() - (hit as { at: number }).at < NEGATIVE_TTL_MS)) return hit.page && usable(hit.page) ? (hit as { page: string; full: string }) : null;
  const failedBefore = olderVersionFailures;
  try {
    const { album, links } = companionLinks(await wikitextOf(page));
    const music = links.filter((t) => isMusicArticleFor(t, game));
    const guessed = gameTrack ? [`Music of ${game}`, `Music of the ${game} series`] : [];
    const candidates = [...new Set(gameTrack ? [...music, ...(album ? [album] : []), ...guessed] : [...(album ? [album] : []), ...music])].slice(0, 8);
    const miss = () => {
      setCapped(companionCache, key, { page: "", at: Date.now() }, MAX_COMPANIONS);
      return null;
    };
    if (!candidates.length) return miss();
    const resolved = await wikiResolveTitles(candidates);
    for (const name of candidates) {
      const found = resolved.get(name);
      // A title with quotation marks couldn't be read back from its label: Wrong must block the very page.
      if (!found || found.fragment || found.page === page || found.page.includes('"') || !usable(found.page)) continue;
      // A title track's album: every sentence about the album would name the track.
      if (normalizeTitle(withoutQualifier(found.page)) === normalizeTitle(track)) continue;
      const fromAlbum = name === album && !isMusicArticleFor(found.page, game);
      if (!fromAlbum && !isMusicArticleFor(found.page, game)) continue;
      const full = articleText(found.page) || (await wikiExtract(found.page));
      if (!full) continue;
      const lead = full.slice(0, 500);
      // An album's page must open as a record's; a game's track never takes a film's soundtrack.
      if (fromAlbum && !/\b(album|soundtrack|EP|mixtape|score)\b/i.test(lead)) continue;
      if (gameTrack && /\b(film|movie|television series|TV series)\b/i.test(lead) && !/\bvideo games?\b/i.test(lead)) continue;
      const out = { page: found.page, full };
      setCapped(companionCache, key, out, MAX_COMPANIONS);
      return out;
    }
    return miss();
  } catch {
    // Throttled, unreachable, or an older version that couldn't be read: the article serves alone,
    // and the song isn't kept off Wikipedia for its companion's sake. Nothing is remembered.
    setOlderVersionFailures(failedBefore);
    return null;
  }
}

/**
 * The companion line for a reference built from `page` (`full`), or "" when the
 * article has MIN_MAKING_SENTENCES or more from the makers, or no companion
 * says anything about the track. Never throws.
 */
export async function companionLine(page: string, full: string, game: string, track: string, usable: (title: string) => boolean, gameTrack: boolean): Promise<string> {
  if (!track || normalizeTitle(track) === normalizeTitle(game)) return "";
  const making = creatorSentences(withoutVideoSections(full), [track, game], true).length;
  if (making >= MIN_MAKING_SENTENCES) return "";
  const companion = await findCompanion(page, game, track, usable, gameTrack);
  if (!companion) return "";
  const sentences = companionSentences(withoutVideoSections(companion.full), track, full);
  if (!sentences.length) return "";
  console.log(`[Grounding] "${page}" has ${making} sentences from the makers: ${sentences.length} more about "${track}" from "${companion.page}"`);
  return `${companionLabel(companion.page)}${sentences.join(" ")}`;
}

/** The companion articles a reference quotes, by title. */
export function companionPages(context: string): string[] {
  return context.split("\n").flatMap((line) => COMPANION_LABEL.exec(line)?.[1] ?? []);
}

/** The companion article a reference sentence comes from, or "" when it is the reference's own article's. */
export function companionOf(sentence: string, context: string): string {
  const want = sentence.replace(/…$/, "").trim();
  if (!want) return "";
  for (const line of context.split("\n")) {
    const m = COMPANION_LABEL.exec(line);
    if (m && line.slice(m[0].length).includes(want)) return m[1];
  }
  return "";
}

/** A reference without the lines of companion articles that are now blocked for the song. */
export function withoutBlockedCompanions(text: string, usable: (title: string) => boolean): string {
  if (!companionPages(text).some((p) => !usable(p))) return text;
  return text
    .split("\n")
    .filter((line) => {
      const m = COMPANION_LABEL.exec(line);
      return !m || usable(m[1]);
    })
    .join("\n")
    .replace(/^(.*)\n\n/, "$1\n");
}

/**
 * What the grounding cache holds under a key, if it can be used: the reference, "" for a
 * recent miss, or undefined when there's nothing (a blocked article, an expired miss).
 */
export function cachedGrounding(key: string, usable: (title: string) => boolean): string | undefined {
  const hit = groundingCache.get(key);
  if (!hit) return undefined;
  if (hit.text) return usable(hit.text.split("\n")[0]) ? withoutBlockedCompanions(hit.text, usable) : undefined;
  return Date.now() - hit.at < NEGATIVE_TTL_MS ? "" : undefined;
}
