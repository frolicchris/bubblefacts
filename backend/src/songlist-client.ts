import { config } from "./config";
import { buildProfile, setListProfile } from "./list-profile";
import { CentrifugoStream } from "./centrifugo-client";
import { SongSource } from "./song-source";
import { SSLQueueItem, SSLQueueResponse, SSLSong, SSLStreamerInfo } from "./types";
import { cleanRequestText } from "./text";
import { displayTitle, toSong } from "./song-mapping";
import { ListedSong, ListSong, searchSongs } from "./song-search";
import { debounce, pollLoop, retryAfterMs, singleFlight } from "./source-polling";

type SongChangeCallback = (current: SSLQueueItem | null) => void;

// StreamerSongList: REST for data, Centrifugo events mean "fetch the queue again", polling as backstop
// (ARCHITECTURE.md: Song sources and YouTube titles)

const REFETCH_DEBOUNCE_MS = 250; // ms an event burst waits to become one re-read
const AUTH_SCHEME = { streamer: "Streamer", user: "User", bearer: "Bearer" } as const;

/** Replaced when the desktop app refreshes its sign-in; OAuth tokens last an hour */
let accessToken = config.sslAccessToken;
export function setAccessToken(token: string): void {
  accessToken = token;
}

export const MAX_LIST_PAGES = 300; // pages of 100 songs read once at start; long careers mean lists of 20,000 and more
const LIST_RETRY_MS = 60_000; // ms between retries of a failed list read, made when the musician searches

/** `GET /songs` items, only the fields used here */
type ListItem = { id?: number; title?: string | null; artist?: string | null; timesPlayed?: number | null };

export class SongListClient implements SongSource {
  readonly name = "StreamerSongList";
  private streamerId: number | null = null;
  private stream: CentrifugoStream | null = null;
  private currentSong: SSLQueueItem | null = null;
  private onSongChange: SongChangeCallback | null = null;
  private readonly poll = pollLoop({
    isStopped: () => this.stopped,
    intervalMs: () => this.pollIntervalMs(),
    backoffUntil: () => this.backoffUntil,
    tick: () => this.pollOnce(),
  });
  /** Every event and reconnect means "fetch again"; a burst becomes one */
  private readonly refetch = debounce(REFETCH_DEBOUNCE_MS, () => void this.refresh());
  private readonly fetchOneAtATime = singleFlight(() => this.fetchQueue(), () => this.stopped);
  private lastSuccessfulFetchAt: number | null = null;
  private stopped = false;
  private rejected = false;
  /** Set from Retry-After on a 429 (slow down) or 503 (down for maintenance) */
  private backoffUntil = 0;
  /** The song list read at start, for the song facts editor's search; null until read */
  private listSongs: ListSong[] | null = null;
  /** Plays by song ID: "most requested first" when preparing (#293) */
  private listPlays = new Map<number, number>();
  private listFailedAt = 0;
  private listReading = false;

  onCurrentSongChange(callback: SongChangeCallback): void {
    this.onSongChange = callback;
  }

  getCurrentSong(): SSLQueueItem | null {
    return this.currentSong;
  }

  lastPollAttemptAgeMs(): number | null {
    return this.poll.lastAttemptAgeMs();
  }

  lastSuccessfulFetchAgeMs(): number | null {
    return this.lastSuccessfulFetchAt === null ? null : Date.now() - this.lastSuccessfulFetchAt;
  }

  /** The token was turned down on the last request: waiting won't fix it */
  authRejected(): boolean {
    return this.rejected;
  }

  backingOff(): boolean {
    return Date.now() < this.backoffUntil;
  }

  /** Same with events connected: polling caps the wait when one is lost (in 2.0 none came) */
  pollIntervalMs(): number {
    return config.sslPollIntervalMs;
  }

  isEventStreamConnected(): boolean {
    return this.stream?.isConnected() ?? false;
  }

  /** Polling starts first, so a failed startup recovers on the next poll; still rethrows so it isn't reported as success */
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
    this.poll.cancel();
    this.refetch.cancel();
  }

  toSong(item: SSLQueueItem): SSLSong {
    return toSong(item);
  }

  displayTitle(item: SSLQueueItem): string {
    return displayTitle(item);
  }

  // --- Change detection --------------------------------------------------

  /** Content, not just id: editing an entry's artist mid-song should regenerate */
  private static identity(item: SSLQueueItem | null): string | null {
    return item && [item.id, item.nonlistSong ?? "", item.nonlistTitle ?? "", item.nonlistArtist ?? "", item.song?.title ?? "", item.song?.artist ?? ""].join("\0");
  }

  // --- REST --------------------------------------------------------------

  private async getJSON<T>(path: string, what: string, extra: Record<string, string> = {}): Promise<T> {
    const query = new URLSearchParams({
      ...(config.sslStreamerId
        ? { streamer_id: String(config.sslStreamerId) }
        : { streamer_name: config.sslStreamerName, platform: config.sslPlatform }),
      ...extra,
    });
    const headers: Record<string, string> = {
      Authorization: `${AUTH_SCHEME[config.sslTokenKind]} ${accessToken}`,
      Accept: "application/json",
    };
    // Only with the app's own sign-in: a Client-Id that doesn't match the token is rejected
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
    const wait = retryAfterMs(res);
    if (wait) this.backoffUntil = Date.now() + wait;
    if (!res.ok) {
      // Errors come as application/problem+json; "detail" says what went wrong in plain words
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
    // Tests drive this themselves: here it would take their mocked replies
    if (process.env.NODE_ENV !== "test") void this.learnListFormat();
  }

  /** Reads the whole list once to learn how titles and artists are written (list-profile.ts); never fatal */
  async learnListFormat(): Promise<void> {
    if (this.listReading) return;
    this.listReading = true;
    try {
      const titles: ListItem[] = [];
      let after = "";
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const body = await this.getJSON<{ items?: ListItem[] | null; token?: string }>(
          "/songs", "song list", { limit: "100", ...(after ? { after } : {}) }
        );
        titles.push(...(body.items ?? []));
        if (!body.token || !(body.items ?? []).length) break;
        after = body.token;
      }
      // Cleaned like a queue entry, so a picked song reads as the dashboard shows it
      this.listSongs = titles.flatMap((s) => {
        const title = cleanRequestText(s.title ?? "");
        return typeof s.id === "number" && s.id > 0 && title ? [{ id: s.id, title, artist: cleanRequestText(s.artist ?? "") }] : [];
      });
      this.listPlays = new Map(titles.flatMap((s) => (typeof s.id === "number" && typeof s.timesPlayed === "number" && s.timesPlayed > 0 ? [[s.id, s.timesPlayed] as const] : [])));
      this.listFailedAt = 0;
      const profile = buildProfile(titles);
      setListProfile(profile);
      const dash = profile.dash === "source-first" ? '"Game - Track"' : profile.dash === "track-first" ? '"Track - Source"' : "no dash habit";
      console.log(`[SSL] Read ${titles.length} songs to learn the list's format: ${dash}, ${profile.parenSources.size} sources named in brackets`);
    } catch (err) {
      this.listFailedAt = Date.now();
      console.warn(`[SSL] Couldn't read the song list to learn its format: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.listReading = false;
    }
  }

  /** Songs on the list matching what was typed; null until the list is read */
  searchSongs(query: string, limit: number): ListSong[] | null {
    // The read at start failed (network not up yet, say): a search is a good moment to retry
    if (this.listFailedAt && Date.now() - this.listFailedAt > LIST_RETRY_MS && !this.backingOff()) void this.learnListFormat();
    return this.listSongs && searchSongs(this.listSongs, query, limit);
  }

  /** Every song on the list with its plays, for preparing (#293); null until the list is read */
  listedSongs(): ListedSong[] | null {
    return this.listSongs && this.listSongs.map((s) => ({ ...s, plays: this.listPlays.get(s.id) ?? 0 }));
  }

  /** Fetches the queue and applies it, one request at a time (singleFlight) */
  private refresh(): Promise<void> {
    if (this.backingOff()) return Promise.resolve();
    return this.fetchOneAtATime();
  }

  private async fetchQueue(): Promise<void> {
    try {
      const queue = await this.getJSON<SSLQueueResponse>("/queue", "queue");
      this.lastSuccessfulFetchAt = Date.now();
      // Streamers without the now-playing feature work down the queue instead
      this.applyNowPlaying(queue.playing ?? queue.items?.[0] ?? null);
    } catch (err) {
      console.error(`[SSL] Error fetching queue: ${err instanceof Error ? err.message : err}`);
    }
  }

  private applyNowPlaying(next: SSLQueueItem | null): void {
    if (SongListClient.identity(this.currentSong) === SongListClient.identity(next)) return;
    const label = (s: SSLQueueItem | null) => (s ? displayTitle(s) : "none");
    console.log(`[SSL] Song changed: "${label(this.currentSong)}" -> "${label(next)}"`);
    this.currentSong = next;
    this.onSongChange?.(next);
  }

  // --- Realtime and polling ----------------------------------------------

  private connectEvents(): void {
    if (this.streamerId === null || this.stream) return;
    // Both channels, so an upstream rename can't silently stop events; the debounce absorbs duplicates
    const channels = [`streamer:${this.streamerId}`, `streamer:${this.streamerId}-queue`];
    this.stream = new CentrifugoStream(
      config.sslEventsUrl,
      channels,
      () => this.handleEvent(),
      () => this.handleEvent()
    );
    this.stream.start();
  }

  /** Every event and reconnect means "fetch again": some come with no data at all */
  private handleEvent(): void {
    this.refetch.run();
  }

  private schedulePoll(): void {
    this.poll.schedule();
  }

  private async pollOnce(): Promise<void> {
    if (this.streamerId === null) {
      try {
        await this.resolveStreamer();
        this.connectEvents();
      } catch {
        // Still unreachable; try again next poll
      }
    }
    await this.refresh();
  }
}
