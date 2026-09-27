/** Shapes from the StreamerSongList API and the overlay's WebSocket protocol. */

/** The song as the overlay sees it. */
export interface SSLSong {
  title: string;
  artist: string;
  /** Off-list request: the overlay shows a banner and no facts. */
  liveLearn?: boolean;
  requestedBy?: string;
}

/** API `QueueSong`. Its id lives on the entry as `songId`. */
export interface SSLQueueSong {
  title: string;
  artist: string;
  comment?: string | null;
  duration?: number | null;
  durationSeconds?: number | null;
  timesPlayed?: number;
  lastPlayed?: string | null;
  attributes?: Array<{ name?: string }> | null;
}

/** API `Request`. */
export interface SSLRequest {
  id: number;
  name: string;
  source?: string;
  user?: { username: string; platform: string };
}

/** API `QueueDetails` (an entry in `items`) or `NowPlayingDetails` (the `playing` slot). */
export interface SSLQueueItem {
  id: number;
  songId: number | null;
  song: SSLQueueSong;
  /** Typed-in title for an off-list request. */
  nonlistSong: string | null;
  note: string | null;
  streamerId: number;
  createdAt: string;
  requests: SSLRequest[] | null;
  position?: number;
  nowPlayingStartedAt?: string | null;
}

/** `GET /queue` */
export interface SSLQueueResponse {
  items: SSLQueueItem[] | null;
  playing?: SSLQueueItem | null;
  total: number;
}

/** `GET /streamers`, only the fields used here. */
export interface SSLStreamerInfo {
  id: number;
  requestsActive: boolean;
  promoteQueueToPlaying?: boolean;
}

/** One bubble. `position` values are CSS percentages. */
export interface PopUpFact {
  id: string;
  text: string;
  appearAtSecond: number;
  durationSeconds: number;
  position: { top: string; left: string };
}

/** Server-to-overlay WebSocket message. */
export interface FactsPayload {
  type: "new_song" | "facts_ready" | "clear";
  song?: SSLSong;
  facts?: PopUpFact[];
}
