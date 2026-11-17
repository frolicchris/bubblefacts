import type { Request, Response } from "express";
import type { SongSource } from "./song-source";
import { foldCase } from "./text";

// Song search for the song facts editor: the musician picks the song, so facts match it by StreamerSongList ID

/** One song on the streamer's list, as the list writes it */
export interface ListSong {
  id: number;
  title: string;
  artist: string;
}

/** A list song with its plays, for preparing the most requested first */
export interface ListedSong extends ListSong {
  plays: number;
}

const DEFAULT_SEARCH_LIMIT = 8; // songs returned
const MAX_SEARCH_LIMIT = 20; // songs returned, at most
const MAX_QUERY = 100; // characters of the query read

// Case and accents don't count ("cafe" finds "Café"); punctuation does, unlike `songIdentity`, to match the list's spelling
const fold = (s: string) => foldCase(s).replace(/\s+/g, " ").trim();

/** Songs holding every word typed: title starts with it, then title contains it, then the rest; list order within each */
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
    // Enough top matches: nothing later can beat them
    if (ranked[0].length >= max) break;
  }
  return ranked.flat().slice(0, max);
}

/** POST /control/songs/search {query, limit?}; `available` false: no list, so the editor lets the musician type */
export function songSearchRoute(source: Pick<SongSource, "searchSongs">) {
  return (req: Request, res: Response): void => {
    const query = typeof req.body?.query === "string" ? req.body.query : "";
    const limit = Number(req.body?.limit) || DEFAULT_SEARCH_LIMIT;
    // No list (StreamElements), or not read yet
    const songs = source.searchSongs ? source.searchSongs(query, limit) : null;
    res.json(songs ? { available: true, songs } : { available: false, songs: [] });
  };
}
