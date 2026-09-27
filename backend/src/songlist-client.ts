import { config } from "./config";
import { CentrifugoStream, SSLEvent } from "./centrifugo-client";
import { SSLQueueItem, SSLQueueResponse, SSLSong, SSLStreamerInfo } from "./types";

type SongChangeCallback = (current: SSLQueueItem | null) => void;

/**
 * StreamerSongList client: REST for data, Centrifugo for change
 * notifications, polling as a safety net. Every event triggers the same
 * action, a queue refetch, so no state is ever rebuilt from event payloads.
 */

const QUEUE_EVENTS = new Set([
  "now_playing_update",
  "queue_update",
  "queue_add",
  "queue_remove",
  "queue_clear",
  "queue_reorder",
  "play_history_add",
]);

/** Collapse a burst of events into one refetch. */
const REFETCH_DEBOUNCE_MS = 250;
const AUTH_SCHEME = { streamer: "Streamer", user: "User", bearer: "Bearer" } as const;

export class SongListClient {
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

  onCurrentSongChange(callback: SongChangeCallback): void {
    this.onSongChange = callback;
  }

  getCurrentSong(): SSLQueueItem | null {
    return this.currentSong;
  }

  lastSuccessfulFetchAgeMs(): number | null {
    return this.lastSuccessfulFetchAt === null ? null : Date.now() - this.lastSuccessfulFetchAt;
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

  // --- Song mapping ------------------------------------------------------

  static displayTitle(item: SSLQueueItem): string {
    return item.nonlistSong || item.song?.title || "Unknown";
  }

  /** An off-list request: the API sets `nonlistSong` to the typed-in title. */
  static isLiveLearn(item: SSLQueueItem): boolean {
    return Boolean(item.nonlistSong?.trim());
  }

  static requesterName(item: SSLQueueItem): string | undefined {
    const r = item.requests?.[0];
    return r?.name || r?.user?.username || undefined;
  }

  /** The song object broadcast to the overlay. */
  static toSong(item: SSLQueueItem): SSLSong {
    const song: SSLSong = { title: SongListClient.displayTitle(item), artist: item.song?.artist ?? "Unknown" };
    if (SongListClient.isLiveLearn(item)) song.liveLearn = true;
    const by = SongListClient.requesterName(item);
    if (by) song.requestedBy = by;
    return song;
  }

  /** Content, not just id: editing an entry's artist mid-song should regenerate. */
  private static identity(item: SSLQueueItem | null): string | null {
    return item && [item.id, item.nonlistSong ?? "", item.song?.title ?? "", item.song?.artist ?? ""].join("\0");
  }

  // --- REST --------------------------------------------------------------

  private async getJSON<T>(path: string, what: string): Promise<T> {
    const query = new URLSearchParams({ streamer_name: config.sslStreamerName, platform: config.sslPlatform });
    const res = await fetch(`${config.sslApiBase}${path}?${query}`, {
      headers: {
        Authorization: `${AUTH_SCHEME[config.sslTokenKind]} ${config.sslAccessToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(config.sslRequestTimeoutMs),
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Failed to fetch ${what}: ${res.status} ${res.statusText}. Check SSL_ACCESS_TOKEN and SSL_TOKEN_KIND: ` +
          `the token must belong to ${config.sslStreamerName} (Settings > Access) or a user who administrates that channel.`
      );
    }
    if (!res.ok) throw new Error(`Failed to fetch ${what}: ${res.status} ${res.statusText}`);
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
   * while one is running fetches again afterwards, because the running
   * request may have started before the change it was asked about.
   */
  private refresh(): Promise<void> {
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
    this.stream = new CentrifugoStream(config.sslEventsUrl, channels, (_channel, event) => this.handleEvent(event));
    this.stream.start();
  }

  private handleEvent(event: SSLEvent): void {
    if (!QUEUE_EVENTS.has(event.type) || this.refetchTimer) return;
    this.refetchTimer = setTimeout(() => {
      this.refetchTimer = null;
      void this.refresh();
    }, REFETCH_DEBOUNCE_MS);
  }

  /** Self-rescheduling, so a slow response never stacks polls behind it. */
  private schedulePoll(): void {
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
    }, config.sslPollIntervalMs);
  }
}
