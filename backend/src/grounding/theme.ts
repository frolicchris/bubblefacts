import type { SSLSong } from "../types";
import { hasNoArtist } from "../text";
import { isPersonPage } from "../wikidata";
import { MAX_CONTEXT_CHARS, MIN_CONTEXT_CHARS } from "../fact-limits";
import { dropVersionTags, normalizeTitle } from "./titles";
import { significantTokens, withoutQualifier } from "./relevance";
import { wikiExtract, wikiResolveTitles } from "./wikipedia";
import { writingText } from "./covers";
import { GENERIC_TRACK } from "./summary";
import { NEGATIVE_TTL_MS, ownArticleExtract } from "./readings";
import { isPerformerArticle } from "./work-match";
import { performerPages } from "./performer-name";

/**
 * "Some Name Theme" that every reading missed: the article of what the theme
 * is named for, cut to its lead and its own music sections.
 */

/** "Some Name Theme", "Some Name Main Theme", "Theme from Some Name": the name the theme is named for, or "" (one word or none). */
export function themeOf(title: string): string {
  const t = dropVersionTags(title.trim());
  const name = (/^(.+?)\s+(?:main\s+)?theme$/i.exec(t)?.[1] ?? /^theme\s+from\s+(.+)$/i.exec(t)?.[1] ?? "").replace(/\s*[-–—:]$/, "").trim();
  // Two words or more: "Love Theme" and "Halloween Theme" name an everyday word's article, not a work's.
  const n = normalizeTitle(name);
  return significantTokens(n).length >= 2 && !GENERIC_TRACK.test(n) ? name : "";
}

/** A section about the subject's own music: "Song", "Music", "Theme song", "Soundtrack". */
const OWN_MUSIC_HEADING = /^(?:the )?(?:songs?|music|theme(?: songs?| music| tune)?|soundtracks?|score|jingles?|music and sound)$/i;
/** A word in the lead for music the subject has: "merged a Japanese denpa song with an animated cat". */
const OWN_MUSIC_WORD = /\b(?:songs?|tunes?|themes?|melod(?:y|ies)|jingles?|music)\b/i;
/** A person's lead: "(born 1967)", "(1900–1980)". */
const LIFE_DATES = /\((?:[^()]*\b)?(?:born|died|née)\b|\(\s*(?:c\.\s*)?\d{3,4}\s*[–-]\s*\d{3,4}\s*\)/;

/**
 * The lead and the sections about the subject's own music, subsections and all, or "" when the
 * article has no such section or its lead never says the subject has music (`themeGrounding`).
 */
export function ownMusicParts(full: string): string {
  const [lead, ...rest] = full.split(/\n(?===)/);
  if (!OWN_MUSIC_WORD.test(lead)) return "";
  const kept: string[] = [];
  let under = 0;
  for (const chunk of rest) {
    const h = /^(=+)\s*([^=\n]+?)\s*=+/.exec(chunk);
    if (!h) continue;
    const level = h[1].length;
    if (under && level <= under) under = 0;
    if (!under && OWN_MUSIC_HEADING.test(h[2])) under = level;
    if (under) kept.push(chunk.trim());
  }
  return kept.length ? [lead.trim(), ...kept].join("\n\n") : "";
}

export const themeCache = new Map<string, { text: string; at: number }>();

/**
 * For "Some Name Theme" that every reading missed: the "Some Name" article, when it isn't a
 * person's and says the subject has music of its own (`ownMusicParts`), cut to its lead and those
 * sections. The artist may be an arranger the article never names ("Nyan Cat Theme" by a chiptune
 * artist is the Nyan Cat video's song). Never when a performer has the artist's name, or "".
 */
export async function themeGrounding(song: SSLSong, usable: (title: string) => boolean): Promise<string> {
  const name = themeOf(song.title);
  if (!name || song.artistUncertain) return "";
  const artist = (song.artist ?? "").trim();
  const key = `${normalizeTitle(name)}\0${normalizeTitle(artist)}`;
  const hit = themeCache.get(key);
  if (hit && (hit.text || Date.now() - hit.at < NEGATIVE_TTL_MS)) return hit.text && usable(hit.text.split("\n")[0]) ? hit.text : "";
  const refuse = (why: string) => {
    console.log(`[Grounding] "${song.title}": ${why}, not taking it for the theme`);
    themeCache.set(key, { text: "", at: Date.now() });
    return "";
  };
  try {
    if (artist && !hasNoArtist(artist) && (await performerPages(artist.replace(/\s*\([^)]*\)\s*$/, ""), song.title)).performer) return refuse(`a performer is called "${artist}"`);
    const found = (await wikiResolveTitles([name])).get(name);
    if (!found || found.fragment || !usable(found.page) || normalizeTitle(withoutQualifier(found.page)) !== normalizeTitle(name)) return refuse(`no article is called "${name}"`);
    const page = found.page;
    const full = await wikiExtract(page);
    if (!full) return refuse(`"${page}" can't be read`);
    if (isPerformerArticle(page, full) || LIFE_DATES.test(full.slice(0, 400)) || (await isPersonPage(page))) return refuse(`"${page}" is a person's article`);
    const parts = ownMusicParts(full);
    if (!parts) return refuse(`"${page}" never says it has music of its own`);
    const budget = MAX_CONTEXT_CHARS - page.length - 1;
    const extract = ownArticleExtract(parts, budget, [name]);
    if (extract.length < MIN_CONTEXT_CHARS) return refuse(`"${page}" is too short to write from (${extract.length} chars)`);
    const text = `${page}\n${writingText(parts, extract, budget, [name])}`;
    console.log(`[Grounding] "${song.title}" -> ${page} (${text.length} chars, the article of what the theme is named for: its lead and music only)`);
    themeCache.set(key, { text, at: Date.now() });
    return text;
  } catch {
    // Throttled or unreachable: nothing is remembered, and it's asked again next time.
    return "";
  }
}
