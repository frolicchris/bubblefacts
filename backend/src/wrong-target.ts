import { Fact, SSLSong } from "./types";

/** The same song play: title and artist (as `sameRequest`), song ID and video ID; one title, two videos are two songs */
export const sameSong = (a: SSLSong | null | undefined, b: SSLSong | null | undefined) =>
  !!a && !!b && a.title === b.title && a.artist === b.artist && (a.songId ?? null) === (b.songId ?? null) && (a.videoId ?? null) === (b.videoId ?? null);

/** Which fact a Wrong click means: only an On stream now click (`live`) touches the stream (ARCHITECTURE.md: Wrong and Undo) */
export function wrongTarget(
  click: { text: string; song: SSLSong | null; live: boolean },
  now: { song: SSLSong | null; facts: Fact[] },
  earlier: Array<{ song: SSLSong; facts: Fact[] }>
): { song: SSLSong; fact: Fact; playing: boolean } | null {
  if (click.live && now.song && (!click.song || sameSong(click.song, now.song))) {
    const fact = now.facts.find((f) => f.text === click.text);
    if (fact) return { song: now.song, fact, playing: true };
  }
  // The song moved on since the list was drawn: its facts are under Earlier songs now
  if (!click.song) return null;
  const play = earlier.find((e) => sameSong(e.song, click.song));
  const fact = play?.facts.find((f) => f.text === click.text);
  return play && fact ? { song: play.song, fact, playing: false } : null;
}
