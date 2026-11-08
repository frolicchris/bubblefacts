import type { SSLSong } from "../types";
import { artistNames, mentionsName, normalizeTitle } from "./titles";
import { looksLikeArtistName, qualifierOf, withoutQualifier } from "./relevance";
import { articleTexts } from "./wikipedia";
import { CHART_RECORD } from "../screening/frames";
import { sectionExtract, sectionSelection, selectSections } from "./sections";

// Covers, and whether the article fits the request at all (`articleMisfit`)

// --- Covers ---

// COVER_SCOPE=off reads a covered song's article whole, as before
export const coverScope = { on: process.env.COVER_SCOPE !== "off" };

// Not for a cover from the original's article: release, charts, sales, video, the band's own moves
const ORIGINALS_RECORD = /\b(?:charts?|charted|peak(?:ed|s)?|number(?:-| )(?:one|\d+)|No\. ?\d+|top (?:\d+|ten|forty)|Hot 100|Billboard|certifi\w+|platinum|gold|sold|sales|copies|single|singles|released|release|reissue\w*|B-side|music video|video|award\w*|Grammy|nominat\w+|performed|performance|tour\w*|live|concert|the (?:band|group|duo|trio|singer)|(?:their|his|her) (?:album|version|recording))\b/i;

/** Whether the request covers the article's song: it says "cover", or the lead never names the artist (only further down) */
export function isCoverOf(page: string, full: string, artist: string, title: string): boolean {
  if (!coverScope.on || !full || !artist.trim()) return false;
  if (/\bcover(?:ed)?\b/i.test(title)) return true;
  if (!isPieceArticle(page, full)) return false;
  const names = artistNames(artist.replace(/\s*\([^)]*\)\s*$/, ""));
  const lead = normalizeTitle(full.split(/\n==/)[0]);
  return names.length > 0 && !mentionsName(lead, names) && mentionsName(normalizeTitle(full), names);
}

const sentencesOf = (text: string) => text.split(/\n+/).flatMap((line) => line.split(/(?<=[.!?]["”]?)\s+(?=["“]?\p{Lu})/u).map((s) => s.trim()));

// Another recording's heading: "Cover versions", "Gary Jules version", "Other recordings"
const VERSION_HEADING = /\b(?:versions?|covers?|recordings?|renditions?|remakes?|remix(?:es)?)\b/i;
// About a version: "a cover by...", "the 2001 version by..."
const VERSION_SENTENCE = /\b(?:covers?|covered|versions?|renditions?|remakes?)\b/i;

// No performer in the heading: "Cover versions", "Other recordings"
const LIST_OF_VERSIONS = /^(?:(?:other|notable|cover|later|selected|alternative|alternate)\s+)*(?:versions?|covers?|recordings?|renditions?|remakes?|remix(?:es)?)$/i;

/** Each version section with subsections: whether its heading names the artist (`own`), or no performer (`list`) */
function versionSections(full: string, names: string[]): Array<{ body: string; own: boolean; list: boolean }> {
  const out: Array<{ level: number; body: string; own: boolean; list: boolean }> = [];
  let open: { level: number; body: string; own: boolean; list: boolean } | null = null;
  for (const [, marks, heading, body] of full.matchAll(/\n(==+)\s*([^=\n]+?)\s*==+\n([\s\S]*?)(?=\n==|$)/g)) {
    const level = marks.length;
    if (open && level > open.level) {
      // A subsection named for a performer is theirs, whatever the section
      if (mentionsName(normalizeTitle(heading), names)) out.push({ level, body, own: true, list: false });
      else open.body += `\n${body}`;
      continue;
    }
    open = VERSION_HEADING.test(heading) ? { level, body, own: mentionsName(normalizeTitle(heading), names), list: LIST_OF_VERSIONS.test(heading.trim()) } : null;
    if (open) out.push(open);
  }
  return out;
}

/** Sentences on another performer's version that would read as this one's; plain "covered by" lines stay */
export function otherVersionsRecord(full: string, artist: string): Set<string> {
  const names = artistNames(artist.replace(/\s*\([^)]*\)\s*$/, ""));
  if (!coverScope.on || !names.length) return new Set();
  const own = (s: string) => mentionsName(normalizeTitle(s), names);
  const drop = versionSections(full, names).filter((v) => !v.own).flatMap((v) => sentencesOf(v.body).filter((s) => !own(s) && (!v.list || CHART_RECORD.test(s))));
  const stated = sentencesOf(full.replace(/^==+.*==+$/gm, "")).filter((s) => VERSION_SENTENCE.test(s) && CHART_RECORD.test(s) && !own(s));
  return new Set([...drop, ...stated]);
}

/** For a cover: the original's sentences that would read as the cover's; the artist's own version section stays */
export function originalsRecord(full: string, artist = ""): Set<string> {
  const names = artist ? artistNames(artist.replace(/\s*\([^)]*\)\s*$/, "")) : [];
  const own = new Set(versionSections(full, names).filter((v) => names.length && v.own).flatMap((v) => sentencesOf(v.body)));
  return new Set(sentencesOf(full).filter((s) => ORIGINALS_RECORD.test(s) && !own.has(s)));
}

/** Every sentence `selectSections` keeps, unbudgeted */
export function selectedText(full: string, names: string[] = []): string {
  return selectSections(full, names).flatMap((p) => p.sentences).join("\n");
}

// What the AI reads: the section selection when on and it keeps 2+ sentences, else `fallback`.
// Length is still judged on `fallback`, so the same articles are used either way
export function writingText(full: string, fallback: string, budget: number, names: string[]): string {
  if (!sectionSelection.on) return fallback;
  return sectionExtract(full, budget, names) || fallback;
}

/** An article's whole text if read this session, or "" */
export function articleText(page: string): string {
  const known = articleTexts.get(page);
  if (known) return known;
  // A game's articles are kept for all its tracks, longer than articleTexts
  for (const a of gameArticles.values()) {
    if (a.page === page) return a.full;
    if (a.music?.page === page) return a.music.full;
  }
  return "";
}

// Subjects a song can come from or be; "Jezebel was a Phoenician princess" isn't one, and its facts are true but off
const MUSIC_OR_WORK =
  /\b(songs?|singles?|albums?|EPs?|mixtapes?|records?|recordings?|bands?|groups?|duo|trio|quartet|singers?|singer-songwriters?|rappers?|musicians?|composers?|pianists?|guitarists?|drummers?|bassists?|violinists?|cellists?|organists?|songwriters?|DJs?|disc jockey|producers?|vocalists?|lyricists?|conductors?|orchestras?|ensembles?|choirs?|idols?|YouTuber|entertainers?|performers?|soundtracks?|scores?|instrumentals?|compositions?|pieces?|suites?|sonatas?|symphon(?:y|ies)|concert[oi]s?|operas?|operettas?|ballets?|musicals?|hymns?|anthems?|ballads?|carols?|march(?:es)?|waltz(?:es)?|rhapsod(?:y|ies)|[eé]tudes?|nocturnes?|preludes?|fugues?|minuets?|mazurkas?|polonaises?|gavottes?|sarabandes?|gigues?|impromptus?|bagatelles?|ballades?|scherz(?:o|os|i)|rondos?|variations|dances?|lullab(?:y|ies)|works? for|serenades?|overtures?|requiems?|cantatas?|arias?|tunes?|melod(?:y|ies)|tangos?|games?|films?|movies?|television|TV|series|shows?|sitcoms?|anime|manga|novels?|franchises?)\b/i;

/** First two sentences, at most 400 characters */
function openingOf(full: string): string {
  const lead = full.split(/\n==/)[0].trim();
  const sentences = lead.split(/(?<=[.!?])\s+(?=\p{Lu})/u);
  return sentences.slice(0, 2).join(" ").slice(0, 400);
}

/** Whether the opening says it's about music, a performer, a game, a film or a show */
export function opensAboutMusicOrWork(full: string): boolean {
  return MUSIC_OR_WORK.test(openingOf(full));
}

// Bracket or subtitle words that name nothing in particular
const GENERIC_NAME_WORDS = new Set([
  "theme", "themes", "main", "opening", "ending", "op", "ed", "no", "ost", "original", "song", "music", "track", "bgm",
  "intro", "outro", "edit", "mix", "version", "from", "the", "of", "a", "an", "and", "in", "on", "s", "free", "full",
]);

/** Names the article must mention, normalized: a "(Name's Theme)" character, the artist field's subtitle ("Star Wars: Rogue One") */
export function requestNames(song: SSLSong): string[] {
  const out: string[] = [];
  const add = (raw: string) => {
    const words = normalizeTitle(raw.replace(/['’]s\b/g, "")).split(" ").filter((w) => w && !GENERIC_NAME_WORDS.has(w) && !/^\d+$/.test(w));
    if (words.join("").length >= 4) out.push(words.join(" "));
  };
  // Only whose theme it is: "(Wild Canyon)" is a stage the game's article may never name
  for (const m of song.title.matchAll(/[([]([^)\]]{2,})[)\]]/g)) {
    const whose = /^(.+?)['’]s\s+(?:theme|song|motif)$/i.exec(m[1].trim())?.[1] ?? /^(?:theme|motif) (?:of|for) (.+)$/i.exec(m[1].trim())?.[1];
    if (whose) add(whose);
  }
  // A person's article needn't name a translated title: "Debajo Las Estrellas (Under The Stars)"
  const artist = (song.artist ?? "").trim();
  const subtitle = /^[^:]{2,}:\s*(.{3,})$/.exec(artist)?.[1];
  if (subtitle && !looksLikeArtistName(artist)) add(subtitle);
  return [...new Set(out)];
}

// A queue slot, not a song: "Off-List YouTube Request < 5 Min (Free)"
const PLACEHOLDER_TITLE = /\boff[- ]?list\b|<\s*\d+\s*min|\(\s*free\s*\)|\b(?:yt|youtube|song|any|open|custom|viewers?['’]?s?|paid|free)\s+requests?\b/i;
const PLACEHOLDER_ARTIST = /^(?:youtube|yt|twitch|spotify|requests?|off[- ]?list|tbd|various|n\/?a)$/i;

/** Whether a request is a placeholder for whatever a viewer asks for */
export function isPlaceholderRequest(song: SSLSong): boolean {
  return PLACEHOLDER_TITLE.test(song.title) || PLACEHOLDER_ARTIST.test((song.artist ?? "").trim());
}

/** Why a reference doesn't fit the request, or "" (ARCHITECTURE.md: choosing the article) */
export function articleMisfit(song: SSLSong, text: string): string {
  const page = text.split("\n")[0];
  const full = articleText(page);
  if (full && !opensAboutMusicOrWork(full)) return "doesn't open like an article about a song, a performer or a work";
  const own = withoutQualifier(page);
  const haystack = ` ${normalizeTitle(own)} ${normalizeTitle(full || text)} `;
  // A person's piece: the bracket may be a film, a translation or a nickname ("Reprise (Spirited Away)")
  if (looksLikeArtistName((song.artist ?? "").trim())) return "";
  const missing = requestNames(song).find((name) => !haystack.includes(` ${name} `));
  return missing ? `never mentions "${missing}"` : "";
}

/** A game's article and its music article if any, kept whole: each track's reference without another download (#48) */
export interface GameArticles {
  page: string;
  full: string;
  /** `series`: the whole series', used only for a track it names */
  music: { page: string; full: string; series?: boolean } | null;
}
export const gameArticles = new Map<string, GameArticles>();

/** What the first sentence calls the subject, up to who made it: "a 1997 role-playing video game" */
export function openingSays(full: string): string {
  // Brackets out: "Some Name (born 1982), known as Some Rapper, is an American rapper"
  const opening = full.slice(0, 600).replace(/\s*\([^()]*\)/g, "");
  const says = /\b(?:is|was|are|were)\s+((?:an?|the|one)\b[^.]*)/.exec(opening)?.[1] ?? "";
  return says.split(/,|;|\s(?:by|developed|directed|created|produced|published|written|released|that|which|who|based|starring|featuring|from|for|in)\b/)[0];
}

// A piece of music, in its brackets or first sentence
const PIECE_WORDS = /\b(song|single|ballad|anthem|theme|instrumental|track|piece|composition|aria|hymn|tune|jingle)s?\b/i;

/** Whether an article is about a piece of music: "(Some Band song)", "a song from the film Aladdin" */
export function isPieceArticle(page: string, full: string): boolean {
  const qualifier = qualifierOf(page);
  if (qualifier && PIECE_WORDS.test(qualifier)) return true;
  return PIECE_WORDS.test(openingSays(full));
}
