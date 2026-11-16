import { config } from "../config";
import type { SSLSong } from "../types";
import { escapeRe } from "../text";
import { creditsSong } from "../musicbrainz";
import { MAX_CONTEXT_CHARS, MIN_CONTEXT_CHARS } from "../fact-limits";
import { artistNames, mentionsName, normalizeTitle } from "./titles";
import { isRelevantArticle, looksLikeArtistName, qualifierNamesAnotherArtist } from "./relevance";
import { ownArticleExtract, wikiExtract, wikiGet, wikiResolveTitles, wikiSearch } from "./wikipedia";
import { wikitextOf } from "./work-scope";
import { openingSays, writingText } from "./covers";
import { GENERIC_TRACK, isMusicArticleFor, namesPiece } from "./summary";
import type { Reading } from "./readings";
import { isNonMusicWork, isPerformerArticle, NON_MUSIC_WORK, PERFORMER_WORDS } from "./work-match";
import { companionLine } from "./companion";

/**
 * A performer's name shared with a film or a book: finding the performer's
 * own article, and a track's own article from a listing.
 */

// --- A performer's name shared with a film or a book ------------------------

/** An artist field's own bracket saying it is a performer: "Some Band (British)", "Some Name (singer)". */
const PERFORMER_BRACKET =
  /\((?:[^)]*\s)?(?:band|singer|rapper|musician|group|duo|trio|DJ|British|English|American|Canadian|Australian|Irish|Scottish|Welsh|Swedish|Norwegian|Finnish|Danish|German|French|Italian|Spanish|Dutch|UK|US)\)\s*$/i;

/** A film or video of a performance or about performers: "a 2025 concert documentary film", "(live video)". */
const CONCERT_FILM =
  /\b(?:concert (?:films?|documentar(?:y|ies)|videos?|movies?|specials?)|documentar(?:y|ies)|rockumentar(?:y|ies)|live (?:films?|videos?|video albums?|DVDs?)|video albums?|tour films?|music films?)\b/i;

/**
 * Whether an article is about a concert film, a documentary or a live
 * video, by its brackets or its first sentence. Its lead names the band
 * because it is about them; its facts are still the film's.
 */
export function isConcertFilm(page: string, full: string): boolean {
  const qualifier = /\(([^)]*)\)\s*$/.exec(page)?.[1];
  return CONCERT_FILM.test(qualifier ?? "") || CONCERT_FILM.test(openingSays(full));
}

/**
 * Whether an article's lead names the performer as one, not just as its own
 * title: "a film about the British rock band Some Band" does, "Some Band is a
 * 1963 film" doesn't.
 */
export function leadNamesPerformer(page: string, full: string, artist: string): boolean {
  const lead = normalizeTitle(full.split(/\n==/)[0]);
  const own = normalizeTitle(page);
  const names = artistNames(artist);
  if (!names.includes(own)) return mentionsName(lead, names);
  const as = String.raw`(?:band|singer|rapper|musician|group|duo|by|performed by|recorded by)`;
  return names.some((n) => new RegExp(String.raw`(?:^| )${as} (?:the )?${escapeRe(n)}(?: |$)|(?:^| )${escapeRe(n)} s? ?(?:frontman|singer|members?|album|song|single)(?: |$)`).test(lead));
}

interface PerformerPages {
  /** The performer's own article: the plain name, or "(band)", "(singer)" and so on. */
  performer: string | null;
  /** The song's own article, "<Title> (<Artist> song)", or "<Title> (song)" when its description names the artist. */
  song: string | null;
}
export const performerPagesCache = new Map<string, PerformerPages>();

/**
 * One title lookup with Wikipedia's short descriptions: the performer's own
 * article and the song's disambiguated one, when they exist.
 */
export async function performerPages(artist: string, track: string): Promise<PerformerPages> {
  const key = `${normalizeTitle(artist)}\0${normalizeTitle(track)}`;
  const hit = performerPagesCache.get(key);
  if (hit) return hit;
  const forms = ["", " (band)", " (singer)", " (musician)", " (rapper)", " (group)"].map((q) => artist + q);
  const songs = [`${track} (${artist} song)`, `${track} (song)`];
  const names = [...forms, ...songs];
  const data = await wikiGet<{
    query?: {
      normalized?: Array<{ from: string; to: string }>;
      redirects?: Array<{ from: string; to: string }>;
      pages?: Record<string, { title?: string; missing?: string; invalid?: string; description?: string }>;
    };
  }>(`action=query&redirects=1&prop=description&titles=${encodeURIComponent(names.join("|"))}`, config.groundingTimeoutMs, "titles");
  const q = data.query ?? {};
  const pages = new Map(
    Object.values(q.pages ?? {})
      .filter((p) => p.title && p.missing === undefined && p.invalid === undefined)
      .map((p) => [p.title!, p.description ?? ""])
  );
  const resolve = (name: string) => {
    const title = q.normalized?.find((n) => n.from === name)?.to ?? name;
    const page = q.redirects?.find((r) => r.from === title)?.to ?? title;
    return pages.has(page) ? { page, description: pages.get(page)! } : null;
  };
  const who = artistNames(artist);
  const performer =
    forms.map(resolve).find((r) => r && PERFORMER_WORDS.test(r.description) && !NON_MUSIC_WORK.test(r.description))?.page ?? null;
  // Named for the track, not a redirect to the album or the artist: "Some Song (Some Band song)" -> "Some Album" isn't the song's.
  const ofTrack = (r: { page: string; description: string } | null) =>
    r && normalizeTitle(r.page) === normalizeTitle(track) ? r : null;
  const [byArtist, plain] = songs.map(resolve).map(ofTrack);
  const song =
    (byArtist && !NON_MUSIC_WORK.test(byArtist.description) ? byArtist.page : null) ??
    (plain && /\b(song|single)\b/i.test(plain.description) && mentionsName(normalizeTitle(plain.description), who) ? plain.page : null);
  const out = { performer, song };
  performerPagesCache.set(key, out);
  return out;
}

/**
 * For a performer's song, what to do with the subject's article a search
 * found: null to keep it; the song's own article when Wikipedia has one;
 * the performer's article, or "reject", for a film, a show or a book that
 * only shares the performer's name ("Some Band (1963 film)").
 *
 * The artist is a performer when the request says so (a music video, a
 * bracket like "(British)", a person's name) or Wikipedia has a performer's
 * article under the name. Games keep the usual lookup: game music lists put
 * the game in the artist field. A film that names the requested track (its
 * own score) is kept too.
 *
 * An article that never names the piece as music (`namesPiece`) may be
 * another work that only shares the name, even a game's or an album's:
 * "Heart of Darkness (video game)" for Heart's "Alone", Elton John's "The
 * Muse" for Muse's "Space Dementia". Then the song's own article wins
 * wherever it's found, and an album or a soundtrack gives way to a
 * performer's article under the name. A game's article stays (a band may
 * share a game's name) unless MusicBrainz credits the song to a performer
 * who has an article under that name.
 */
export async function performerArticle(
  song: SSLSong,
  reading: Reading,
  page: string,
  full: string,
  usable: (title: string) => boolean
): Promise<{ page: string; subject: boolean; music?: boolean } | "reject" | null> {
  const { game, track } = reading;
  const aGame = /game\)$/i.test(page) || /\b(?:video )?games?\b/i.test(openingSays(full));
  const unnamed = !namesPiece(full, track);
  const concert = !aGame && isConcertFilm(page, full);
  const nonMusic = !aGame && (isNonMusicWork(page, full) || concert);
  const told = !!song.performer || !!reading.aPerformer || looksLikeArtistName(game) || PERFORMER_BRACKET.test(game);
  if (aGame ? !unnamed : !nonMusic && !told && !unnamed) return null;
  const artist = game.replace(/\s*\([^)]*\)\s*$/, "").trim();
  const found = await performerPages(artist, track);
  if (found.song && found.song !== page && usable(found.song)) return { page: found.song, subject: false };
  if (aGame) {
    const band = found.performer && found.performer !== page && usable(found.performer) ? found.performer : null;
    return band && (await creditsSong(track, artist)) ? { page: band, subject: true } : null;
  }
  // Only to another page: a person's own article stays even when the opening doesn't call them a performer.
  const otherMusic = !nonMusic && unnamed && !!found.performer && found.performer !== page && !isPerformerArticle(page, full);
  if (!otherMusic && (!nonMusic || !(told || found.performer))) return null;
  const name = normalizeTitle(track);
  // A concert film or documentary names the band throughout: only its lead naming the track keeps it.
  if (concert) {
    if (name.length >= 5 && mentionsName(normalizeTitle(full.split(/\n==/)[0]), [name])) return null;
  } else if (!otherMusic && (leadNamesPerformer(page, full, artist) || (name.length >= 5 && mentionsName(normalizeTitle(full), [name])))) return null;
  if (found.performer && found.performer !== page && usable(found.performer)) return { page: found.performer, subject: true };
  // No performer of the name: a show's or a film's music article whose track listing has the track ("Music of Some Show").
  const music = nonMusic && !concert && !song.performer && !reading.aPerformer ? await listingMusicArticle(artist, track, usable) : null;
  if (music && music !== page) return { page: music, subject: true, music: true };
  return "reject";
}

/** The titles in an article's {{Track listing}} templates, without links, refs or bold. */
export function listedTracks(wikitext: string): string[] {
  const out: string[] = [];
  for (const m of wikitext.matchAll(/\{\{\s*track ?listing\b/gi)) {
    // To the template's own closing braces, past the ones nested in it.
    let depth = 0;
    let end = m.index;
    while (end < wikitext.length) {
      if (wikitext.startsWith("{{", end)) (depth++, (end += 2));
      else if (wikitext.startsWith("}}", end)) {
        end += 2;
        if (--depth === 0) break;
      } else end++;
    }
    const block = wikitext
      .slice(m.index, end)
      .replace(/<ref[^>]*\/>|<ref[^>]*>[\s\S]*?<\/ref>/gi, "")
      .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, "$1")
      .replace(/'{2,}/g, "");
    for (const t of block.matchAll(/\|\s*title\d+\s*=([^|\n]*)/gi)) if (t[1].trim()) out.push(t[1].trim());
  }
  return out;
}

/**
 * A show's or a film's own music article ("Music of Some Show", "Some Show
 * (soundtrack)") that names the track as music or lists it on one of its
 * albums, or null. Its prose may never name a short cue that its track
 * listings do ("Green Bird" | "Cowboy Bebop").
 */
async function listingMusicArticle(work: string, track: string, usable: (title: string) => boolean): Promise<string | null> {
  const name = normalizeTitle(track);
  if (!work || name.length < 3 || GENERIC_TRACK.test(name)) return null;
  const named = await wikiResolveTitles([`Music of ${work}`, `${work} (soundtrack)`]);
  for (const page of new Set([...named.values()].filter((r) => !r.fragment).map((r) => r.page))) {
    if (!usable(page) || !isMusicArticleFor(page, work)) continue;
    const full = await wikiExtract(page);
    if (!full) continue;
    const listed = listedTracks(await wikitextOf(page)).some((t) => normalizeTitle(t) === name);
    if (listed || namesPiece(full, track)) return page;
  }
  return null;
}

/**
 * A game's track with an article of its own ("Megalovania", "Baba Yetu"): the reference, or "" when
 * it has none, or null when Wikipedia couldn't be asked (throttled or unreachable).
 */
export async function trackOwnArticle(song: SSLSong, game: string, track: string, usable: (title: string) => boolean): Promise<string | null> {
  try {
    const own = (await wikiSearch(`${track} ${game}`)).find(
      (t) => usable(t) && isRelevantArticle(track, t) && !qualifierNamesAnotherArtist(t, game, track, true)
    );
    const full = own ? await wikiExtract(own) : null;
    // It has to be an article about a piece of music: "Dragonborn" from Skyrim is also an expansion pack.
    const aboutMusic = full && /\b(song|theme|piece|composition|instrumental|track|single|anthem|aria|soundtrack)\b/i.test(full.slice(0, 400));
    const extract = full && aboutMusic && mentionsName(normalizeTitle(full), artistNames(game)) ? ownArticleExtract(full, MAX_CONTEXT_CHARS - own!.length - 1, [track, game]) : "";
    if (own && full && extract && extract.length >= MIN_CONTEXT_CHARS) {
      console.log(`[Grounding] "${song.title}" -> ${own} (${extract.length} chars, the track's own article)`);
      // Few words from its makers: a sentence or two more about it from the game's music article (issue #48).
      const companion = await companionLine(own, full, game, track, usable, true);
      const budget = MAX_CONTEXT_CHARS - own.length - 1 - (companion ? companion.length + 2 : 0);
      const body = writingText(full, companion ? ownArticleExtract(full, budget, [track, game]) : extract, budget, [track, game]);
      return `${own}\n${companion ? `${companion}\n\n` : ""}${body}`;
    }
    return "";
  } catch {
    return null;
  }
}
