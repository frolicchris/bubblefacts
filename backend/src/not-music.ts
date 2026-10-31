import { SSLSong } from "./types";

/**
 * Tracks that aren't music: commercials (real or fake), station idents, jingles.
 * A DJ's player reports them like songs, and only their words can tell them apart, so
 * the rule is narrow. A real song losing its facts is worse than a commercial getting
 * looked up, and a track with none of these words is not caught: the "No facts" switches
 * cover it, or a tag in its title. See "Tracks that aren't music" in docs/ARCHITECTURE.md.
 */

const WORD = "commercial|advert|advertisement|jingle|ident|bumper|sweeper|liner|psa";

/** Phrases no song title leans on, anywhere in the title or artist field. */
const PHRASE = /\b(?:(?:fake|mock|parody|radio|tv|television)[ -](?:commercial|advert|ad)s?|(?:commercial|ad)[ -]break|station[ -](?:id|ident|identification|jingle|promo|imaging)|radio[ -](?:imaging|jingle|liner|sweeper)|ident)\b/i;
/** A tag in brackets, on its own: "(Commercial)", not "(Commercial Version)". "(Promo)" is a promo copy of a song. */
const TAG = new RegExp(`[(\\[{]\\s*(?:${WORD}|ad)\\s*[)\\]}]`, "i");
/** The artist field used as a folder: "Commercials". */
const FOLDER = new RegExp(`^(?:${WORD}|ad)s?$`, "i");
/** With no artist to say otherwise, a title ending in the word: "Moonbrew Cola Commercial", "Jingle 03". */
const TITLE_END = new RegExp(`\\b(?:${WORD})(?:\\s*#?\\d+)?$`, "i");

const noArtist = (artist: string) => !artist.trim() || /^unknown$/i.test(artist.trim());

/** Whether this track looks like something other than music. Never a live learn: someone asked for it. */
export function isNotMusic(song: Pick<SSLSong, "title" | "artist" | "liveLearn">): boolean {
  if (song.liveLearn) return false;
  const title = song.title.trim();
  const artist = (song.artist ?? "").trim();
  return PHRASE.test(title) || PHRASE.test(artist) || TAG.test(title) || FOLDER.test(artist) || (noArtist(artist) && TITLE_END.test(title));
}
