import { config } from "./config";
import { AstroStream } from "./astro-client";
import { SongSource } from "./song-source";
import { SongListClient } from "./songlist-client";
import { SSLQueueItem, SSLSong } from "./types";
import { isTopicChannel, parseVideoTitle } from "./youtube-title";
import { songFromYouTube, YouTubeSong } from "./youtube-metadata";

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
/** How long a song may be playing, per the live events, without being followed before health says so. */
const FOLLOW_GRACE_MS = 30_000;
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
  /**
   * What the live events last said: "playing" after play or a song change,
   * "paused" after pause. The REST player state can stay "paused" after the
   * streamer resumes, which left every later song unfollowed until the player
   * was restarted, so a live event wins over it.
   */
  private eventState: "playing" | "paused" | null = null;
  /** Since when /playing has named a song that isn't being followed (0 = it hasn't). */
  private unfollowedSince = 0;
  private lastRestState: string | undefined = "";
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

  /** StreamElements asked us to wait (Retry-After): not hearing from it is expected, not stale. */
  backingOff(): boolean {
    return Date.now() < this.backoffUntil;
  }

  /** The live events' word, only while they're connected: a stale event must not outlive its socket. */
  private liveState(): "playing" | "paused" | null {
    return this.isEventStreamConnected() ? this.eventState : null;
  }

  /**
   * StreamElements said a song started, but for half a minute no song has
   * been followed (issue #16: the dashboard stayed green while nothing was).
   */
  followingProblem(): string | null {
    // Only while StreamElements still names a song: an empty queue at the end isn't a problem.
    const stuck = this.liveState() === "playing" && this.unfollowedSince > 0 && Date.now() - this.unfollowedSince > FOLLOW_GRACE_MS;
    return stuck ? "StreamElements says a song is playing, but BubbleFacts can't see which one" : null;
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
  static toEntry(song: SESong, exact: YouTubeSong | null = null): SSLQueueItem {
    // An auto-generated upload's own metadata beats reading its title.
    const parsed = exact ? { ...exact, confident: true, performer: true } : parseVideoTitle(song.title ?? "", song.channel);
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
          await this.apply(player?.state, playing);
        } catch (err) {
          console.error(`[SE] Error fetching the song request player: ${err instanceof Error ? err.message : err}`);
        }
      } while (this.refreshAgain && !this.stopped);
      this.inFlight = null;
    })();
    return this.inFlight;
  }

  private async apply(restState: string | undefined, playing: SESong | null): Promise<void> {
    if (restState !== this.lastRestState) {
      console.log(`[SE] Player state: ${restState ?? "(none)"}${this.eventState ? ` (last event: ${this.eventState})` : ""}`);
      this.lastRestState = restState;
    }
    // A live event is fresher than the REST state; see eventState.
    const state = this.liveState() ?? restState;
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
      // Paused keeps the song that was on, even if /playing briefly answers nothing;
      // any other state means /playing is only the next song up.
      if (state === "paused" && (key === null || key === this.currentKey)) {
        this.unfollowedSince = 0;
        return;
      }
      next = key !== null && key === this.currentKey ? song : null;
    }
    const nextKey = next && StreamElementsClient.key(next);
    // StreamElements names a song that isn't followed: see followingProblem().
    if (song && !next) this.unfollowedSince ||= Date.now();
    else this.unfollowedSince = 0;
    if (nextKey === this.currentKey) return;
    // Only auto-generated uploads carry exact metadata; asking for any other video costs quota and time.
    const exact = next && isTopicChannel(next.channel) ? await songFromYouTube(next.videoId) : null;
    const entry = next && StreamElementsClient.toEntry(next, exact);
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
      (e) => this.handleEvent(e.event),
      // Events may have been missed while disconnected: let the REST state decide again.
      () => {
        this.eventState = null;
        this.handleEvent();
      }
    );
    this.stream.start();
  }

  /** Every event (play, pause, skip, queue changes) and every reconnect means "fetch again". */
  private handleEvent(event = ""): void {
    if (event) {
      const name = event.replace(/^songrequest\./, "");
      if (/^(play|song\.next|song\.previous|song\.skip)$/.test(name)) {
        this.eventState = "playing";
      }
      else if (name === "pause") this.eventState = "paused";
      if (!/^(volume|queue\.|history\.|song\.position|song\.voteskip|settings\.)/.test(name)) console.log(`[SE] Event: ${name}`);
    }
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
