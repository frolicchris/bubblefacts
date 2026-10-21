/**
 * Shapes shared across the backend: the queue entry every song source hands
 * over (StreamerSongList's API shape; StreamElements and the now playing file
 * fill it in as far as they can, see song-source.ts), and the overlay's
 * WebSocket protocol (`Fact`, `FactsPayload`). Fields marked "API shape, not
 * read" are filled in or kept to match the API, but nothing reads them.
 */

// --- The song, as the sources and the overlay share it -------------------

/** The song as the overlay sees it. */
export interface SSLSong {
  title: string;
  artist: string;
  /** Off-list request: the overlay shows a banner and no facts. */
  liveLearn?: boolean;
  requestedBy?: string;
  /**
   * The artist field names a performer, as in a music video's title, so an
   * article about a band or singer of that name is a match.
   */
  performer?: boolean;
  /** The artist is only a guess from the uploader's channel, which may be a cover channel. */
  artistUncertain?: boolean;
  /** StreamerSongList's song ID, when the song is on the list. Matches the streamer's own facts for it. */
  songId?: number;
  /** The YouTube video ID of a StreamElements request. */
  videoId?: string;
}

// --- Queue shapes: StreamerSongList's API, filled by StreamElements and the now playing file too ---

/** API `QueueSong`. Its id lives on the entry as `songId`. */
export interface SSLQueueSong {
  title: string;
  artist: string;
  /** Set by StreamElements from a music video's title. See `SSLSong.performer`. */
  performer?: boolean;
  /** Set by StreamElements. See `SSLSong.artistUncertain`. */
  artistUncertain?: boolean;
  /** Set by StreamElements: the request's YouTube video ID. */
  videoId?: string;
  comment?: string | null;
  /** API shape, not read. */
  duration?: number | null;
  /** Filled by StreamElements (the video's length) and left null by the now playing file. API shape, not read. */
  durationSeconds?: number | null;
  timesPlayed?: number;
  /** API shape, not read. */
  lastPlayed?: string | null;
  attributes?: Array<{ name?: string }> | null;
}

/** API `Request`. */
export interface SSLRequest {
  /** API shape, not read. */
  id: number;
  name: string;
  /** `platform` is API shape, not read. */
  user?: { username: string; platform: string };
}

/** API `QueueDetails` (an entry in `items`) or `NowPlayingDetails` (the `playing` slot). */
export interface SSLQueueItem {
  id: number;
  songId: number | null;
  song: SSLQueueSong;
  /** Typed-in title for an off-list request. */
  nonlistSong: string | null;
  /** Newer live-learn fields; either can be null. */
  nonlistTitle?: string | null;
  nonlistArtist?: string | null;
  note: string | null;
  /** API shape, not read. */
  streamerId: number;
  /** API shape, not read. */
  createdAt: string;
  requests: SSLRequest[] | null;
}

/** `GET /queue` */
export interface SSLQueueResponse {
  items: SSLQueueItem[] | null;
  playing?: SSLQueueItem | null;
  /** API shape, not read. */
  total: number;
}

/** `GET /streamers`, only the fields used here. */
export interface SSLStreamerInfo {
  id: number;
  promoteQueueToPlaying?: boolean;
}

// --- Overlay shapes --------------------------------------------------------

/** One bubble. Shown `delaySeconds` after the batch arrives; `position` is CSS percentages. */
export interface Fact {
  text: string;
  /** Where it came from, for the dashboard: "Wikipedia: <article>", "Wikidata", "Your facts for this song"... */
  source?: string;
  /** For the dashboard: the article to open, and the sentence in it the fact was written from. */
  url?: string;
  evidence?: string;
  delaySeconds: number;
  durationSeconds: number;
  /**
   * `top`, or `bottom` for a bubble that sits on the bottom edge and grows upward.
   * `left`, or `right` for one measured from the right edge; neither centers it.
   */
  position: { top?: string; bottom?: string; left?: string; right?: string };
}

/** Server-to-overlay WebSocket message. `remove_fact` takes one fact, by `text`, off the current song. */
export interface FactsPayload {
  /** `test_bubble`: one bubble shown on top of whatever's playing, which carries on untouched. */
  type: "new_song" | "facts_ready" | "clear" | "remove_fact" | "test_bubble";
  song?: SSLSong;
  facts?: Fact[];
  text?: string;
  /** On new_song: the same song resuming after a pause, so no NOW PLAYING banner. */
  quiet?: boolean;
  /** On new_song: the streamer turned NOW PLAYING off. A LIVE LEARN banner is never hidden. */
  noBanner?: boolean;
  /**
   * On facts_ready: more of the song's facts, after the ones sent earlier (the AI's captions after
   * the facts from data). The bubble on screen stays; these replace the ones still to come.
   */
  keep?: boolean;
}
