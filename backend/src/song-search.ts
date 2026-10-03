import type { Request, Response } from "express";
import type { SongSource } from "./song-source";

/**
 * Song search for the song facts editor: typing the title exactly as the
 * song list has it is hard, so the musician picks it instead, and the facts
 * then match that song by its StreamerSongList ID.
 */

/** One song on the streamer's list, as the list writes it. */
export interface ListSong {
  id: number;
  title: string;
  artist: string;
}

export const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 20;
const MAX_QUERY = 100;

/** Case and accents don't count: "cafe" finds "Café". */
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Songs whose title or artist contains every word typed, best first: title
 * starts with what was typed, then title contains it, then the rest (words
 * split across title and artist, or only in the artist). List order within each.
 */
export function searchSongs(songs: readonly ListSong[], query: string, limit = DEFAULT_SEARCH_LIMIT): ListSong[] {
  const q = fold(query.slice(0, MAX_QUERY));
  const max = Math.min(Math.max(Math.floor(limit) || DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);
  if (!q) return [];
  const words = q.split(" ");
  const ranked: ListSong[][] = [[], [], []];
  for (const song of songs) {
    const title = fold(song.title);
    const both = `${title} ${fold(song.artist)}`;
    if (!words.every((w) => both.includes(w))) continue;
    const rank = title.startsWith(q) ? 0 : title.includes(q) ? 1 : 2;
    ranked[rank].push(song);
    // Enough top matches: nothing later can beat them.
    if (ranked[0].length >= max) break;
  }
  return ranked.flat().slice(0, max);
}

/**
 * POST /control/songs/search {query, limit?}. `available` is false when the
 * song source has no list (StreamElements) or hasn't read it yet, so the
 * editor just lets the musician type instead of saying nothing matches.
 */
export function songSearchRoute(source: Pick<SongSource, "searchSongs">) {
  return (req: Request, res: Response): void => {
    const query = typeof req.body?.query === "string" ? req.body.query : "";
    const limit = Number(req.body?.limit) || DEFAULT_SEARCH_LIMIT;
    // No list (StreamElements), or not read yet: the editor just lets the musician type.
    const songs = source.searchSongs ? source.searchSongs(query, limit) : null;
    res.json(songs ? { available: true, songs } : { available: false, songs: [] });
  };
}
