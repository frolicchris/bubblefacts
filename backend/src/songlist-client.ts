import { config } from "./config";
import { CentrifugoStream, SSLEvent } from "./centrifugo-client";
import { SSLQueueItem, SSLQueueResponse, SSLStreamerInfo, SSLSong } from "./types";

type SongChangeCallback = (current: SSLQueueItem | null, previous: SSLQueueItem | null) => void;

/**
 * Realtime events that mean "what's playing may have changed". Anything
 * else on the channel (songs, settings, learn list) is ignored.
 *
 * Every one of these is handled the same way — refetch `GET /queue` — so we
 * never have to reconstruct queue state from event payloads, and a missed or
 * unrecognised event costs us at most one poll interval.
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

/** Collapse bursts of events (a reorder can emit several) into one refetch. */
const REFETCH_DEBOUNCE_MS = 250;

/**
 * Client for the rebuilt StreamerSongList API (August 2026).
 *
 * REST for data, Centrifugo for realtime. Note that unlike the old platform,
 * *every* endpoint requires an Authorization header — there is no public
 * read access, so `SSL_ACCESS_TOKEN` is mandatory.
 */
export class SongListClient {
  private streamerId: number | null = null;
  private stream: CentrifugoStream | null = null;
  private currentSong: SSLQueueItem | null = null;
  private onSongChange: SongChangeCallback | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private refetchTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  /** Set while a queue fetch is in flight, so two callers cannot overlap. */
  private inFlight: Promise<void> | null = null;

  /**
   * Monotonically increasing per fetch. Two uncoordinated callers — the
   * debounced event refetch and the poll timer — could otherwise interleave
   * such that an older response landed last and was applied as a fresh song
   * change, flipping the overlay back to the previous song for a poll
   * interval. Responses older than the newest already applied are ignored.
   */
  private fetchSeq = 0;
  private appliedSeq = 0;

  /** When the queue was last read successfully — the basis for "degraded". */
  private lastSuccessfulFetchAt: number | null = null;
  private eventsConnected = false;

  /** Register a callback for when the current song changes */
  onCurrentSongChange(callback: SongChangeCallback): void {
    this.onSongChange = callback;
  }

  /** Get the currently playing song */
  getCurrentSong(): SSLQueueItem | null {
    return this.currentSong;
  }

  /** Milliseconds since the queue was last read successfully, or null. */
  lastSuccessfulFetchAgeMs(): number | null {
    return this.lastSuccessfulFetchAt === null ? null : Date.now() - this.lastSuccessfulFetchAt;
  }

  /** Whether the realtime stream believes it is connected. */
  isEventStreamConnected(): boolean {
    return this.eventsConnected;
  }

  /**
   * Initialize: resolve streamer ID, fetch initial queue, subscribe to events.
   *
   * Polling starts UNCONDITIONALLY, before anything that can throw. The
   * previous ordering was strictly sequential — streamer info, then queue,
   * then events, then polling — so a single failed request at startup (the
   * API briefly down, the laptop's wifi not up yet) skipped the last two
   * steps permanently. `pollInterval` stayed null and nothing ever retried,
   * while the server logged "Will retry on next poll cycle...", which was
   * false about its own code. There is exactly one caller of connect().
   */
  async connect(): Promise<void> {
    // Polling first, and outside the try: whatever happens below, the client
    // must be left in a state that can recover on its own.
    this.startPollingFallback();

    try {
      await this.resolveStreamer();
    } catch (err) {
      console.log(
        `[SSL] Startup failed; polling every ${config.sslPollIntervalMs}ms and will retry there`
      );
      // Rethrow rather than swallow. Recovery is now handled by the poll
      // loop, but the caller still needs to know this did not succeed —
      // otherwise the server logs "Connected to StreamerSongList" after a
      // failure, which is exactly the kind of false reassurance that made
      // the last outage hard to diagnose.
      throw err;
    }

    await this.fetchAndUpdateQueue();
    this.connectEvents();
  }

  /** Resolve the numeric streamer id. Safe to call repeatedly. */
  private async resolveStreamer(): Promise<void> {
    const info = await this.fetchStreamerInfo();
    this.streamerId = info.id;
    console.log(`[SSL] Resolved streamer "${config.sslStreamerName}" -> ID ${this.streamerId}`);
    if (info.promoteQueueToPlaying === false) {
      console.log(
        "[SSL] promoteQueueToPlaying is off — if the now-playing slot is left " +
          "empty, facts will track the top of the queue instead"
      );
    }
  }

  /** Disconnect from the event stream and stop polling */
  disconnect(): void {
    if (this.stream) {
      this.stream.stop();
      this.stream = null;
    }
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.stopped = true;
    if (this.refetchTimer) {
      clearTimeout(this.refetchTimer);
      this.refetchTimer = null;
    }
  }

  /**
   * Every request carries the token. The scheme word differs by token type:
   * `Streamer` / `User` / `Bearer`.
   */
  private authHeaders(): Record<string, string> {
    const scheme =
      config.sslTokenKind === "user"
        ? "User"
        : config.sslTokenKind === "bearer"
          ? "Bearer"
          : "Streamer";
    return {
      Authorization: `${scheme} ${config.sslAccessToken}`,
      Accept: "application/json",
    };
  }

  /**
   * The streamer is identified by query parameters now, not a path segment:
   * `?streamer_name=…&platform=twitch`.
   */
  private streamerQuery(): string {
    const params = new URLSearchParams({
      streamer_name: config.sslStreamerName,
      platform: config.sslPlatform,
    });
    return params.toString();
  }

  private async getJSON<T>(path: string, what: string): Promise<T> {
    const url = `${config.sslApiBase}${path}${path.includes("?") ? "&" : "?"}${this.streamerQuery()}`;
    // Bounded well under the poll interval so two poll iterations can never
    // overlap by construction. Without this, undici's 300s default applies
    // and a stalled request outlives many poll cycles.
    const res = await fetch(url, {
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(config.sslRequestTimeoutMs),
    });

    if (!res.ok) {
      // Auth failures are the single most likely first-run problem now that
      // the API has no public endpoints, so say what to do about them.
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `Failed to fetch ${what}: ${res.status} ${res.statusText}. ` +
            "Check SSL_ACCESS_TOKEN and SSL_TOKEN_KIND — the token must belong to " +
            `${config.sslStreamerName} (Settings > Access) or to a user who administrates that channel.`
        );
      }
      throw new Error(`Failed to fetch ${what}: ${res.status} ${res.statusText}`);
    }

    return (await res.json()) as T;
  }

  private fetchStreamerInfo(): Promise<SSLStreamerInfo> {
    return this.getJSON<SSLStreamerInfo>("/streamers", "streamer info");
  }

  async fetchQueue(): Promise<SSLQueueResponse> {
    return this.getJSON<SSLQueueResponse>("/queue", "queue");
  }

  /**
   * Resolve what is actually being performed right now.
   *
   * The rebuilt API has a dedicated now-playing slot, so `playing` is the
   * answer whenever it is set. Streamers who don't use that feature leave it
   * null and simply work down the queue — for them the head of `items` is
   * still the best available signal, which is also what the old API forced
   * us to assume.
   */
  private resolveNowPlaying(queue: SSLQueueResponse): SSLQueueItem | null {
    if (queue.playing) return queue.playing;
    return queue.items?.[0] ?? null;
  }

  /**
   * Fetch the queue and apply it, at most one at a time.
   *
   * Two uncoordinated callers reach this: the 250ms-debounced event refetch
   * (which debounces events against each other only) and the poll timer.
   * Without a single-flight guard they interleave, and because
   * handlePotentialSongChange fires on any identity difference in EITHER
   * direction, a late stale response was applied as a fresh song change —
   * broadcasting new_song, clearing the overlay and re-running the whole
   * pipeline for the previous song, then flipping back one poll later.
   */
  private fetchAndUpdateQueue(): Promise<void> {
    if (this.inFlight) return this.inFlight;

    const seq = ++this.fetchSeq;
    this.inFlight = (async () => {
      try {
        const queue = await this.fetchQueue();
        // A newer fetch already landed; this response is stale.
        if (seq < this.appliedSeq) {
          console.log(`[SSL] Ignoring stale queue response #${seq}`);
          return;
        }
        this.appliedSeq = seq;
        this.lastSuccessfulFetchAt = Date.now();
        this.handlePotentialSongChange(this.resolveNowPlaying(queue));
      } catch (err) {
        console.error(
          `[SSL] Error fetching queue: ${err instanceof Error ? `${err.name}: ${err.message}` : err}`
        );
      } finally {
        this.inFlight = null;
      }
    })();

    return this.inFlight;
  }

  /** Title as it should be displayed: off-list requests override the song row. */
  static displayTitle(item: SSLQueueItem): string {
    return item.nonlistSong || item.song?.title || "Unknown";
  }

  /**
   * A Live Learn is a request for something not on the song list. The
   * rebuilt API (`QueueDetails` / `NowPlayingDetails`) marks these with
   * `nonlistSong` set to the typed-in title and `songId: null`; there is no
   * separate boolean. `nonlistSong` is the field used here — `songId` alone
   * is not, because an entry can carry a null id transiently while the list
   * is being edited.
   */
  static isLiveLearn(item: SSLQueueItem): boolean {
    return typeof item.nonlistSong === "string" && item.nonlistSong.trim() !== "";
  }

  /** First requester's display name, if the entry carries one. */
  static requesterName(item: SSLQueueItem): string | undefined {
    const r = item.requests?.[0];
    return r?.name || r?.user?.username || undefined;
  }

  /** The song object the server broadcasts to the overlay. */
  static toSong(item: SSLQueueItem): SSLSong {
    const song: SSLSong = {
      title: SongListClient.displayTitle(item),
      artist: item.song?.artist ?? "Unknown",
    };
    if (SongListClient.isLiveLearn(item)) song.liveLearn = true;
    const by = SongListClient.requesterName(item);
    if (by) song.requestedBy = by;
    return song;
  }

  /**
   * Identity for change detection.
   *
   * Not the id alone: every consumer downstream is keyed on CONTENT (the fact
   * cache, the overlay's song guard, the grounding cache), so correcting the
   * artist field mid-song — the field grounding depends on entirely — had no
   * effect until the next song. That matters because "fix the metadata and
   * watch it work" is the natural mid-stream recovery when a song is
   * grounding badly.
   */
  private static identity(item: SSLQueueItem | null): string | null {
    if (!item) return null;
    return [
      item.id,
      item.nonlistSong ?? "",
      item.song?.title ?? "",
      item.song?.artist ?? "",
    ].join("\u0000");
  }

  private handlePotentialSongChange(newCurrent: SSLQueueItem | null): void {
    const currentKey = SongListClient.identity(this.currentSong);
    const newKey = SongListClient.identity(newCurrent);

    if (currentKey !== newKey) {
      const previous = this.currentSong;
      this.currentSong = newCurrent;
      console.log(
        `[SSL] Song changed: "${previous ? SongListClient.displayTitle(previous) : "none"}" -> ` +
          `"${newCurrent ? SongListClient.displayTitle(newCurrent) : "none"}"`
      );
      this.onSongChange?.(newCurrent, previous);
    }
  }

  private connectEvents(): void {
    if (this.streamerId === null) return;

    // Public channels — no auth needed. The bare `streamer:{id}` channel and
    // the `-queue` category overlap; subscribing to both means a category
    // rename upstream can't silently stop song changes from being noticed,
    // and the debounce absorbs the duplicate events.
    const channels = [`streamer:${this.streamerId}`, `streamer:${this.streamerId}-queue`];

    this.stream = new CentrifugoStream(config.sslEventsUrl, channels, (_channel, event) =>
      this.handleEvent(event)
    );
    this.stream.start();
    this.eventsConnected = true;
  }

  private handleEvent(event: SSLEvent): void {
    if (!QUEUE_EVENTS.has(event.type)) return;

    console.log(`[SSL] Event: ${event.type}`);
    if (this.refetchTimer) return;
    this.refetchTimer = setTimeout(() => {
      this.refetchTimer = null;
      this.fetchAndUpdateQueue();
    }, REFETCH_DEBOUNCE_MS);
  }

  /**
   * Fallback polling in case events are missed or the stream is down. 15s
   * keeps the worst-case song-change lag tolerable on stream while staying
   * light on the API.
   */
  private startPollingFallback(): void {
    const tick = async () => {
      if (this.stopped) return;

      // Lazily resolve the streamer if startup couldn't. This is what makes
      // a failed startup recoverable rather than terminal.
      if (this.streamerId === null) {
        try {
          await this.resolveStreamer();
          this.connectEvents();
        } catch {
          // Still down; try again next tick.
        }
      }

      await this.fetchAndUpdateQueue();

      // Self-rescheduling rather than setInterval: the next delay starts
      // after this iteration finishes, so a slow response can never queue
      // iterations up behind it.
      if (!this.stopped) {
        this.pollTimer = setTimeout(tick, config.sslPollIntervalMs);
      }
    };

    this.pollTimer = setTimeout(tick, config.sslPollIntervalMs);
  }
}
