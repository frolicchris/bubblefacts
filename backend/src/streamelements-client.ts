import { config } from "./config";
import { AstroStream } from "./astro-client";
import { SongSource } from "./song-source";
import { SongListClient } from "./songlist-client";
import { SSLQueueItem, SSLSong } from "./types";
import { parseVideoTitle } from "./youtube-title";

/**
 * StreamElements song requests ("Media Request"): REST for data, Astro for
 * change notifications, polling as a safety net. Like the StreamerSongList
 * client, every event means the same thing, "fetch again", so nothing is
 * rebuilt from event payloads.
 *
 * `/songrequest/{id}/playing` returns the playing song or, when none is
 * playing, the next one ready to play. So `/player` decides: a song counts as
 * playing only while the player's state is "playing". A pause keeps the song
 * that was already on; anything else clears it.
 */

/** A song request as StreamElements returns it; only the fields used here. */
export interface SESong {
  _id?: string;
  videoId?: string;
  title?: string;
  /** The YouTube channel that uploaded the video. */
  channel?: string;
  /** Seconds. */
  duration?: number;
  user?: { username?: string; providerId?: string } | null;
}

interface SEChannel {
  _id: string;
  username?: string;
}

const REFETCH_DEBOUNCE_MS = 250;
/** While realtime events arrive, polling is only a backstop. */
const POLL_WITH_EVENTS_MS = 30_000;
const SONG_TOPIC = "channel.songrequest";
/** StreamElements channel IDs are 24 hex characters. */
const CHANNEL_ID = /^[0-9a-f]{24}$/i;

export class StreamElementsClient implements SongSource {
  readonly name = "StreamElements";
  private channelId: string | null = null;
  private stream: AstroStream | null = null;
  private currentSong: SSLQueueItem | null = null;
  private currentKey: string | null = null;
  private onSongChange: ((current: SSLQueueItem | null) => void) | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private refetchTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private refreshAgain = false;
  private lastSuccessfulFetchAt: number | null = null;
  private stopped = false;
  private rejected = false;
  private warnedNoState = false;
  /** Set from Retry-After when StreamElements says to slow down (429) or is down (503). */
  private backoffUntil = 0;

  onCurrentSongChange(callback: (current: SSLQueueItem | null) => void): void {
    this.onSongChange = callback;
  }

  getCurrentSong(): SSLQueueItem | null {
    return this.currentSong;
  }

  lastSuccessfulFetchAgeMs(): number | null {
    return this.lastSuccessfulFetchAt === null ? null : Date.now() - this.lastSuccessfulFetchAt;
  }

  authRejected(): boolean {
    return this.rejected;
  }

  pollIntervalMs(): number {
    return this.isEventStreamConnected() ? Math.max(config.sePollIntervalMs, POLL_WITH_EVENTS_MS) : config.sePollIntervalMs;
  }

  isEventStreamConnected(): boolean {
    return this.stream?.isConnected() ?? false;
  }

  toSong(item: SSLQueueItem): SSLSong {
    // No live learns on StreamElements: an entry never has the off-list fields.
    const song = SongListClient.toSong(item);
    return item.song?.performer ? { ...song, performer: true } : song;
  }

  displayTitle(item: SSLQueueItem): string {
    return SongListClient.displayTitle(item);
  }

  /** Polling starts before anything that can fail, so a failed startup recovers on the next poll. */
  async connect(): Promise<void> {
    this.stopped = false;
    this.schedulePoll();
    await this.resolveChannel();
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

  /**
   * A song request as the queue entry the fact pipeline reads. The title and
   * artist come from the YouTube title; the requester and length carry over.
   * There's no play count or note on StreamElements, so no facts use them.
   */
  static toEntry(song: SESong): SSLQueueItem {
    const parsed = parseVideoTitle(song.title ?? "", song.channel);
    const requester = song.user?.username?.trim();
    return {
      id: 0,
      songId: null,
      song: {
        title: parsed.title || "Unknown",
        artist: parsed.artist || "Unknown",
        ...(parsed.performer ? { performer: true } : {}),
        durationSeconds: typeof song.duration === "number" ? song.duration : null,
      },
      nonlistSong: null,
      note: null,
      streamerId: 0,
      createdAt: "",
      requests: requester ? [{ id: 0, name: requester }] : null,
    };
  }

  /** The request itself, so the same video requested twice in a row still counts as a change. */
  private static key(song: SESong): string {
    return [song._id ?? "", song.videoId ?? "", song.title ?? ""].join("\0");
  }

  // --- REST --------------------------------------------------------------

  private async getJSON<T>(path: string, what: string): Promise<T | null> {
    const res = await fetch(`${config.seApiBase}${path}`, {
      headers: { Authorization: `Bearer ${config.seJwt}`, Accept: "application/json" },
      signal: AbortSignal.timeout(config.seRequestTimeoutMs),
    });
    this.rejected = res.status === 401 || res.status === 403;
    if (this.rejected) {
      throw new Error(
        `Failed to fetch ${what}: ${res.status} ${res.statusText}. Check SE_JWT: copy the JWT token again from the ` +
          "StreamElements dashboard (Account, then Channels, then Show secrets)."
      );
    }
    if (res.status === 429 || res.status === 503) {
      const wait = Number(res.headers?.get("retry-after")) || (res.status === 429 ? 60 : 120);
      this.backoffUntil = Date.now() + Math.min(wait, 600) * 1000;
    }
    // No song requests yet.
    if (res.status === 404) return null;
    if (!res.ok) {
      const problem = (await Promise.resolve().then(() => res.json()).catch(() => null)) as { message?: string } | null;
      const detail = typeof problem?.message === "string" ? ` (${problem.message})` : "";
      throw new Error(`Failed to fetch ${what}: ${res.status} ${res.statusText}${detail}`);
    }
    const text = await res.text();
    return text.trim() ? (JSON.parse(text) as T) : null;
  }

  private async resolveChannel(): Promise<void> {
    const wanted = config.seChannel;
    if (CHANNEL_ID.test(wanted)) {
      this.channelId = wanted;
      return;
    }
    const path = wanted ? `/channels/${encodeURIComponent(wanted)}` : "/channels/me";
    const info = await this.getJSON<SEChannel>(path, "channel");
    if (!info?._id) throw new Error(`StreamElements has no channel named "${wanted}"`);
    this.channelId = info._id;
    console.log(`[SE] Resolved channel "${info.username ?? wanted}" -> ID ${info._id}`);
  }

  /** One request pair at a time; a refresh asked for meanwhile fetches again afterward. */
  private refresh(): Promise<void> {
    if (Date.now() < this.backoffUntil || this.channelId === null) return Promise.resolve();
    if (this.inFlight) {
      this.refreshAgain = true;
      return this.inFlight;
    }
    this.inFlight = (async () => {
      do {
        this.refreshAgain = false;
        try {
          const id = encodeURIComponent(this.channelId as string);
          // One after the other, so a refused token on either one is what authRejected() reports.
          const player = await this.getJSON<{ state?: string }>(`/songrequest/${id}/player`, "player");
          const playing = await this.getJSON<SESong>(`/songrequest/${id}/playing`, "playing song");
          this.lastSuccessfulFetchAt = Date.now();
          this.apply(player?.state, playing);
        } catch (err) {
          console.error(`[SE] Error fetching the song request player: ${err instanceof Error ? err.message : err}`);
        }
      } while (this.refreshAgain && !this.stopped);
      this.inFlight = null;
    })();
    return this.inFlight;
  }

  private apply(state: string | undefined, playing: SESong | null): void {
    const song = playing?.title ? playing : null;
    const key = song && StreamElementsClient.key(song);
    let next: SESong | null;
    if (state === undefined) {
      // A player answer with no state: trust /playing rather than never showing anything.
      if (!this.warnedNoState) console.warn("[SE] The player didn't say whether it's playing; following the current song");
      this.warnedNoState = true;
      next = song;
    } else if (state === "playing") {
      next = song;
    } else {
      // Paused on the same song keeps it; otherwise /playing is only the next song up.
      next = key !== null && key === this.currentKey ? song : null;
    }
    const nextKey = next && StreamElementsClient.key(next);
    if (nextKey === this.currentKey) return;
    const entry = next && StreamElementsClient.toEntry(next);
    console.log(
      `[SE] Song changed: "${this.currentSong ? this.displayTitle(this.currentSong) : "none"}" -> ` +
        `"${entry ? this.displayTitle(entry) : "none"}"` +
        (next ? ` (video title "${next.title}", uploaded by "${next.channel ?? ""}")` : "")
    );
    this.currentKey = nextKey;
    this.currentSong = entry;
    this.onSongChange?.(entry);
  }

  // --- Realtime and polling ----------------------------------------------

  private connectEvents(): void {
    if (this.channelId === null || this.stream) return;
    this.stream = new AstroStream(
      config.seEventsUrl,
      SONG_TOPIC,
      this.channelId,
      () => config.seJwt,
      () => this.handleEvent(),
      () => this.handleEvent()
    );
    this.stream.start();
  }

  /** Every event (play, pause, skip, queue changes) and every reconnect means "fetch again". */
  private handleEvent(): void {
    if (this.refetchTimer) return;
    this.refetchTimer = setTimeout(() => {
      this.refetchTimer = null;
      void this.refresh();
    }, REFETCH_DEBOUNCE_MS);
  }

  private schedulePoll(): void {
    const delay = Math.max(this.pollIntervalMs(), this.backoffUntil - Date.now());
    this.pollTimer = setTimeout(async () => {
      if (this.stopped) return;
      if (this.channelId === null) {
        try {
          await this.resolveChannel();
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
