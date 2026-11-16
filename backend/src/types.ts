// Shapes shared across the backend: the queue entry every song source fills (StreamerSongList's API;
// see song-source.ts) and the overlay's WebSocket protocol. "API shape, not read": kept for the API, unused

// --- The song, as sources and overlay share it ---

/** The song as the overlay sees it */
export interface SSLSong {
  title: string;
  artist: string;
  /** Off-list request: a banner, no facts */
  liveLearn?: boolean;
  requestedBy?: string;
  /** Artist field names a performer (as in a music video title), so a band or singer article matches */
  performer?: boolean;
  /** Artist only guessed from the uploader's channel, maybe a cover channel */
  artistUncertain?: boolean;
  /** Now playing line named no artist: it may be looked up by title (`artistByTitle` in musicbrainz.ts) */
  titleOnly?: boolean;
  /** Artist found by title alone: the article may not be this song's, so data facts only */
  artistFromTitle?: boolean;
  /** StreamerSongList song ID, when listed; matches the streamer's own facts */
  songId?: number;
  /** YouTube video ID of a StreamElements request */
  videoId?: string;
}

// --- Queue shapes: StreamerSongList's API, also filled by StreamElements and the now playing file ---

/** API `QueueSong`; its id is the entry's `songId` */
export interface SSLQueueSong {
  title: string;
  artist: string;
  /** Set by StreamElements from a video title; see `SSLSong.performer` */
  performer?: boolean;
  /** Set by StreamElements; see `SSLSong.artistUncertain` */
  artistUncertain?: boolean;
  /** Set by StreamElements */
  videoId?: string;
  comment?: string | null;
  /** API shape, not read */
  duration?: number | null;
  /** StreamElements: the video's length; now playing file: null. API shape, not read */
  durationSeconds?: number | null;
  timesPlayed?: number;
  /** API shape, not read */
  lastPlayed?: string | null;
  attributes?: Array<{ name?: string }> | null;
}

/** API `Request` */
export interface SSLRequest {
  /** API shape, not read */
  id: number;
  name: string;
  /** `platform`: API shape, not read */
  user?: { username: string; platform: string };
}

/** API `QueueDetails` (in `items`) or `NowPlayingDetails` (the `playing` slot) */
export interface SSLQueueItem {
  id: number;
  songId: number | null;
  song: SSLQueueSong;
  /** Typed-in title of an off-list request */
  nonlistSong: string | null;
  /** Newer live-learn fields; either can be null */
  nonlistTitle?: string | null;
  nonlistArtist?: string | null;
  note: string | null;
  /** API shape, not read */
  streamerId: number;
  /** API shape, not read */
  createdAt: string;
  requests: SSLRequest[] | null;
}

/** `GET /queue` */
export interface SSLQueueResponse {
  items: SSLQueueItem[] | null;
  playing?: SSLQueueItem | null;
  /** API shape, not read */
  total: number;
}

/** `GET /streamers`, only the fields used here */
export interface SSLStreamerInfo {
  id: number;
  promoteQueueToPlaying?: boolean;
}

// --- Overlay shapes ---

/** One bubble, shown `delaySeconds` after the batch arrives; `position` in CSS percentages */
export interface Fact {
  text: string;
  /** Source, for the dashboard: "Wikipedia: <article>", "Wikidata", "Your facts for this song"... */
  source?: string;
  /** For the dashboard: the article, and the sentence the fact was written from */
  url?: string;
  evidence?: string;
  delaySeconds: number;
  durationSeconds: number;
  /** `top`, or `bottom` (on the bottom edge, grows up); `left`, or `right` (from the right edge); neither centers */
  position: Spot;
  /** Its spot on the vertical overlay (1080x1920), same rules */
  vertical?: Spot;
  /** Companion article fact: the article it came through ("Wikipedia: <article>"), so Wrong on that takes it too */
  via?: string;
}

/** Where a bubble sits, as CSS lengths */
export type Spot = { top?: string; bottom?: string; left?: string; right?: string };

/** Server-to-overlay WebSocket message; `remove_fact` takes one fact (by `text`) off the current song */
export interface FactsPayload {
  /** `test_bubble`: one bubble over whatever's playing, which carries on untouched */
  type: "new_song" | "facts_ready" | "clear" | "remove_fact" | "test_bubble";
  song?: SSLSong;
  facts?: Fact[];
  text?: string;
  /** new_song: same song resuming after a pause, so no NOW PLAYING banner */
  quiet?: boolean;
  /** new_song: NOW PLAYING turned off; LIVE LEARN is never hidden */
  noBanner?: boolean;
  /** facts_ready: more facts after earlier ones (AI captions after data facts); the bubble up stays, these replace the rest */
  keep?: boolean;
}
