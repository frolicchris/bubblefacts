import { config } from "./config";
import { CentrifugoStream } from "./centrifugo-client";
import { SongSource } from "./song-source";
import { SSLQueueItem, SSLQueueResponse, SSLSong, SSLStreamerInfo } from "./types";

type SongChangeCallback = (current: SSLQueueItem | null) => void;

/**
 * StreamerSongList client: REST for data, Centrifugo for change
 * notifications, polling as a safety net. Every event triggers the same
 * action, a queue refetch, so no state is ever rebuilt from event payloads.
 */

/** Collapse a burst of events into one refetch. */
const REFETCH_DEBOUNCE_MS = 250;
/** While realtime events arrive, polling is only a backstop; poll less to stay under the rate limit. */
const POLL_WITH_EVENTS_MS = 60_000;
const AUTH_SCHEME = { streamer: "Streamer", user: "User", bearer: "Bearer" } as const;

/** Replaced while running when the desktop app refreshes its sign-in; OAuth tokens last an hour. */
let accessToken = config.sslAccessToken;
export function setAccessToken(token: string): void {
  accessToken = token;
}

export class SongListClient implements SongSource {
  readonly name = "StreamerSongList";
  private streamerId: number | null = null;
  private stream: CentrifugoStream | null = null;
  private currentSong: SSLQueueItem | null = null;
  private onSongChange: SongChangeCallback | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private refetchTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private refreshAgain = false;
  private lastSuccessfulFetchAt: number | null = null;
  private stopped = false;
  private rejected = false;
  /** Set from Retry-After when StreamerSongList says to slow down (429) or is down for maintenance (503). */
  private backoffUntil = 0;

  onCurrentSongChange(callback: SongChangeCallback): void {
    this.onSongChange = callback;
  }

  getCurrentSong(): SSLQueueItem | null {
    return this.currentSong;
  }

  lastSuccessfulFetchAgeMs(): number | null {
    return this.lastSuccessfulFetchAt === null ? null : Date.now() - this.lastSuccessfulFetchAt;
  }

  /** StreamerSongList turned the token down on the last request: waiting won't fix it. */
  authRejected(): boolean {
    return this.rejected;
  }

  backingOff(): boolean {
    return Date.now() < this.backoffUntil;
  }

  /** How often the queue is polled right now; health allows three misses. */
  pollIntervalMs(): number {
    return this.isEventStreamConnected() ? Math.max(config.sslPollIntervalMs, POLL_WITH_EVENTS_MS) : config.sslPollIntervalMs;
  }

  isEventStreamConnected(): boolean {
    return this.stream?.isConnected() ?? false;
  }

  /**
   * Polling starts before anything that can fail, so a failed startup (API
   * down, network not up yet) recovers on the next poll. Still rethrows so
   * the caller doesn't report success.
   */
  async connect(): Promise<void> {
    this.stopped = false;
    this.schedulePoll();
    await this.resolveStreamer();
    await this.refresh();
    this.connectEvents();
  }

  disconnect(): void {
    this.stopped = true;
    this.stream?.stop();
    this.stream = null;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.refetchTimer) clearTimeout(this.refetchTimer);
    this.pollTimer = this.refetchTimer = null;
  }

  toSong(item: SSLQueueItem): SSLSong {
    return SongListClient.toSong(item);
  }

  displayTitle(item: SSLQueueItem): string {
    return SongListClient.displayTitle(item);
  }

  // --- Song mapping ------------------------------------------------------

  static displayTitle(item: SSLQueueItem): string {
    return item.nonlistTitle?.trim() || item.nonlistSong || item.song?.title || "Unknown";
  }

  /** An off-list request: the API sets `nonlistSong` to the typed-in title. */
  static isLiveLearn(item: SSLQueueItem): boolean {
    return Boolean(item.nonlistSong?.trim() || item.nonlistTitle?.trim());
  }

  static requesterName(item: SSLQueueItem): string | undefined {
    const r = item.requests?.[0];
    return r?.name || r?.user?.username || undefined;
  }

  /** The song object broadcast to the overlay. */
  static toSong(item: SSLQueueItem): SSLSong {
    const song: SSLSong = {
      title: SongListClient.displayTitle(item),
      artist: (SongListClient.isLiveLearn(item) && item.nonlistArtist?.trim()) || item.song?.artist || "Unknown",
    };
    if (SongListClient.isLiveLearn(item) && config.liveLearns) song.liveLearn = true;
    const by = SongListClient.requesterName(item);
    if (by) song.requestedBy = by;
    if (typeof item.songId === "number" && item.songId > 0) song.songId = item.songId;
    return song;
  }

  /** Content, not just id: editing an entry's artist mid-song should regenerate. */
  private static identity(item: SSLQueueItem | null): string | null {
    return item && [item.id, item.nonlistSong ?? "", item.song?.title ?? "", item.song?.artist ?? ""].join("\0");
  }

  // --- REST --------------------------------------------------------------

  private async getJSON<T>(path: string, what: string): Promise<T> {
    const query = new URLSearchParams(
      config.sslStreamerId
        ? { streamer_id: String(config.sslStreamerId) }
        : { streamer_name: config.sslStreamerName, platform: config.sslPlatform }
    );
    const headers: Record<string, string> = {
      Authorization: `${AUTH_SCHEME[config.sslTokenKind]} ${accessToken}`,
      Accept: "application/json",
    };
    // Only with the app's own sign-in: a Client-Id that doesn't match the token is rejected.
    if (config.sslClientId && config.sslTokenKind === "bearer") headers["Client-Id"] = config.sslClientId;
    const res = await fetch(`${config.sslApiBase}${path}?${query}`, {
      headers,
      signal: AbortSignal.timeout(config.sslRequestTimeoutMs),
    });
    this.rejected = res.status === 401 || res.status === 403;
    if (this.rejected) {
      throw new Error(
        `Failed to fetch ${what}: ${res.status} ${res.statusText}. Check SSL_ACCESS_TOKEN and SSL_TOKEN_KIND: ` +
          `the token must belong to ${config.sslStreamerName} (Settings > Access) or a user who administrates that channel.`
      );
    }
    if (res.status === 429 || res.status === 503) {
      const wait = Number(res.headers?.get("retry-after")) || (res.status === 429 ? 60 : 120);
      this.backoffUntil = Date.now() + Math.min(wait, 600) * 1000;
    }
    if (!res.ok) {
      // Errors come as application/problem+json; its "detail" says what went wrong in plain words.
      const problem = (await Promise.resolve().then(() => res.json()).catch(() => null)) as { detail?: string } | null;
      const detail = typeof problem?.detail === "string" ? ` (${problem.detail})` : "";
      throw new Error(`Failed to fetch ${what}: ${res.status} ${res.statusText}${detail}`);
    }
    return (await res.json()) as T;
  }

  private async resolveStreamer(): Promise<void> {
    const info = await this.getJSON<SSLStreamerInfo>("/streamers", "streamer info");
    this.streamerId = info.id;
    console.log(`[SSL] Resolved streamer "${config.sslStreamerName}" -> ID ${info.id}`);
    if (info.promoteQueueToPlaying === false) {
      console.log("[SSL] promoteQueueToPlaying is off: facts follow the top of the queue when nothing is playing");
    }
  }

  /**
   * Fetch the queue and apply it, one request at a time. A refresh asked for
   * while one is running fetches again afterward, because the running
   * request may have started before the change it was asked about.
   */
  private refresh(): Promise<void> {
    if (Date.now() < this.backoffUntil) return Promise.resolve();
    if (this.inFlight) {
      this.refreshAgain = true;
      return this.inFlight;
    }
    this.inFlight = (async () => {
      do {
        this.refreshAgain = false;
        try {
          const queue = await this.getJSON<SSLQueueResponse>("/queue", "queue");
          this.lastSuccessfulFetchAt = Date.now();
          // Streamers without the now-playing feature work down the queue instead.
          this.applyNowPlaying(queue.playing ?? queue.items?.[0] ?? null);
        } catch (err) {
          console.error(`[SSL] Error fetching queue: ${err instanceof Error ? err.message : err}`);
        }
      } while (this.refreshAgain && !this.stopped);
      this.inFlight = null;
    })();
    return this.inFlight;
  }

  private applyNowPlaying(next: SSLQueueItem | null): void {
    if (SongListClient.identity(this.currentSong) === SongListClient.identity(next)) return;
    const label = (s: SSLQueueItem | null) => (s ? SongListClient.displayTitle(s) : "none");
    console.log(`[SSL] Song changed: "${label(this.currentSong)}" -> "${label(next)}"`);
    this.currentSong = next;
    this.onSongChange?.(next);
  }

  // --- Realtime and polling ----------------------------------------------

  private connectEvents(): void {
    if (this.streamerId === null || this.stream) return;
    // Both the bare and the "-queue" channel, so a category rename upstream
    // cannot silently stop notifications. The debounce absorbs duplicates.
    const channels = [`streamer:${this.streamerId}`, `streamer:${this.streamerId}-queue`];
    this.stream = new CentrifugoStream(
      config.sslEventsUrl,
      channels,
      () => this.handleEvent(),
      () => this.handleEvent()
    );
    this.stream.start();
  }

  /** Every event, and every reconnect, means "refetch": the docs send some with no data at all. */
  private handleEvent(): void {
    if (this.refetchTimer) return;
    this.refetchTimer = setTimeout(() => {
      this.refetchTimer = null;
      void this.refresh();
    }, REFETCH_DEBOUNCE_MS);
  }

  /** Self-rescheduling, so a slow response never stacks polls behind it. */
  private schedulePoll(): void {
    const delay = Math.max(this.pollIntervalMs(), this.backoffUntil - Date.now());
    this.pollTimer = setTimeout(async () => {
      if (this.stopped) return;
      if (this.streamerId === null) {
        try {
          await this.resolveStreamer();
          this.connectEvents();
        } catch {
          // Still unreachable; try again next poll.
        }
      }
      await this.refresh();
      if (!this.stopped) this.schedulePoll();
    }, delay);
  }
}
