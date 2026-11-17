import { config } from "./config";
import { AstroStream } from "./astro-client";
import { SongSource } from "./song-source";
import { displayTitle, toSong } from "./song-mapping";
import { SSLQueueItem, SSLSong } from "./types";
import { isTopicChannel, ParsedTitle, parseVideoTitle } from "./youtube-title";
import { settleTitleOrder } from "./musicbrainz";
import { songFromYouTube, YouTubeSong } from "./youtube-metadata";
import { debounce, pollLoop, retryAfterMs, singleFlight } from "./source-polling";

// StreamElements song requests (Media Request): REST for data, Astro events mean "fetch again", polling as backstop
// /playing may be the next song up, so a song counts only while the player says "playing"
// (ARCHITECTURE.md: Song sources and YouTube titles)

/** A StreamElements song request, only the fields used here */
export interface SESong {
  _id?: string;
  videoId?: string;
  title?: string;
  /** YouTube channel that uploaded the video */
  channel?: string;
  /** Seconds */
  duration?: number;
  user?: { username?: string; providerId?: string } | null;
}

interface SEChannel {
  _id: string;
  username?: string;
}

const REFETCH_DEBOUNCE_MS = 250; // ms an event burst waits to become one re-read
const FOLLOW_GRACE_MS = 30_000; // ms a named song may go unfollowed before health says so
const POLL_WITH_EVENTS_MS = 30_000; // ms between polls while live events arrive (only a backstop)
const SONG_TOPIC = "channel.songrequest";
const CHANNEL_ID = /^[0-9a-f]{24}$/i; // StreamElements channel IDs: 24 hex characters

export class StreamElementsClient implements SongSource {
  readonly name = "StreamElements";
  private channelId: string | null = null;
  private stream: AstroStream | null = null;
  private currentSong: SSLQueueItem | null = null;
  private currentKey: string | null = null;
  private onSongChange: ((current: SSLQueueItem | null) => void) | null = null;
  private readonly poll = pollLoop({
    isStopped: () => this.stopped,
    intervalMs: () => this.pollIntervalMs(),
    backoffUntil: () => this.backoffUntil,
    tick: () => this.pollOnce(),
  });
  /** Every event and reconnect means "fetch again"; a burst becomes one */
  private readonly refetch = debounce(REFETCH_DEBOUNCE_MS, () => void this.refresh());
  private readonly fetchOneAtATime = singleFlight(() => this.fetchPlayer(), () => this.stopped);
  private lastSuccessfulFetchAt: number | null = null;
  private stopped = false;
  private rejected = false;
  private warnedNoState = false;
  /** Last live event's state; wins over REST, which can stay "paused" after a resume (#16) */
  private eventState: "playing" | "paused" | null = null;
  /** Since when /playing has named an unfollowed song (0: it hasn't) */
  private unfollowedSince = 0;
  /** Song /playing named when this pause was first seen; another one under "paused" means a stale state */
  private pausedOn: string | null = null;
  /** /playing moved on while REST, the only word, still said "paused" */
  private movedWhilePaused = false;
  private lastRestState: string | undefined = "";
  /** Set from Retry-After on a 429 (slow down) or 503 (down) */
  private backoffUntil = 0;

  onCurrentSongChange(callback: (current: SSLQueueItem | null) => void): void {
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

  authRejected(): boolean {
    return this.rejected;
  }

  /** StreamElements asked us to wait (Retry-After): silence is expected, not stale */
  backingOff(): boolean {
    return Date.now() < this.backoffUntil;
  }

  /** The live events' word, only while connected: a stale event must not outlive its socket */
  private liveState(): "playing" | "paused" | null {
    return this.isEventStreamConnected() ? this.eventState : null;
  }

  /** Why a song StreamElements names went unfollowed for 30 s (#16), or null; a long pause never counts */
  followingProblem(): string | null {
    // Only while a song is named: an empty queue at the end isn't a problem
    const unfollowed = this.unfollowedSince > 0 && Date.now() - this.unfollowedSince > FOLLOW_GRACE_MS;
    if (unfollowed && this.liveState() === "playing") return "StreamElements says a song is playing, but BubbleFacts can't see which one";
    if (unfollowed && this.movedWhilePaused && !this.isEventStreamConnected()) {
      return "StreamElements says the player is paused, but its song changed, and its live events aren't connected";
    }
    return null;
  }

  pollIntervalMs(): number {
    return this.isEventStreamConnected() ? Math.max(config.sePollIntervalMs, POLL_WITH_EVENTS_MS) : config.sePollIntervalMs;
  }

  isEventStreamConnected(): boolean {
    return this.stream?.isConnected() ?? false;
  }

  toSong(item: SSLQueueItem): SSLSong {
    // No live learns on StreamElements: never the off-list fields
    const song = toSong(item);
    return {
      ...song,
      ...(item.song?.performer ? { performer: true } : {}),
      ...(item.song?.artistUncertain ? { artistUncertain: true } : {}),
      ...(item.song?.videoId ? { videoId: item.song.videoId } : {}),
    };
  }

  displayTitle(item: SSLQueueItem): string {
    return displayTitle(item);
  }

  /** Polling starts first, so a failed startup recovers on the next poll */
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
    this.poll.cancel();
    this.refetch.cancel();
  }

  // --- Song mapping ------------------------------------------------------

  /** A request as a queue entry (title, artist, requester, length); `read`: the title already read, order settled */
  static toEntry(song: SESong, exact: YouTubeSong | null = null, read: ParsedTitle | null = null): SSLQueueItem {
    // An auto-generated upload's own metadata beats reading its title
    const parsed = exact ? { ...exact, confident: true, performer: true } : (read ?? parseVideoTitle(song.title ?? "", song.channel));
    const requester = song.user?.username?.trim();
    return {
      id: 0,
      songId: null,
      song: {
        title: parsed.title || "Unknown",
        artist: parsed.artist || "Unknown",
        ...(parsed.performer ? { performer: true } : {}),
        ...(!parsed.confident && parsed.artist ? { artistUncertain: true } : {}),
        ...(song.videoId ? { videoId: song.videoId } : {}),
        durationSeconds: typeof song.duration === "number" ? song.duration : null,
      },
      nonlistSong: null,
      note: null,
      streamerId: 0,
      createdAt: "",
      requests: requester ? [{ id: 0, name: requester }] : null,
    };
  }

  /** Per request, so the same video twice in a row still counts as a change */
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
    const wait = retryAfterMs(res);
    if (wait) this.backoffUntil = Date.now() + wait;
    // No song requests yet
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

  /** One request pair at a time; a refresh asked for meanwhile runs afterward (singleFlight) */
  private refresh(): Promise<void> {
    if (this.backingOff() || this.channelId === null) return Promise.resolve();
    return this.fetchOneAtATime();
  }

  private async fetchPlayer(): Promise<void> {
    try {
      const id = encodeURIComponent(this.channelId as string);
      // In turn, so a refused token on either is what authRejected() reports
      const player = await this.getJSON<{ state?: string }>(`/songrequest/${id}/player`, "player");
      const playing = await this.getJSON<SESong>(`/songrequest/${id}/playing`, "playing song");
      this.lastSuccessfulFetchAt = Date.now();
      await this.apply(player?.state, playing);
    } catch (err) {
      console.error(`[SE] Error fetching the song request player: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async apply(restState: string | undefined, playing: SESong | null): Promise<void> {
    if (restState !== this.lastRestState) {
      console.log(`[SE] Player state: ${restState ?? "(none)"}${this.eventState ? ` (last event: ${this.eventState})` : ""}`);
      this.lastRestState = restState;
    }
    // A live event beats the REST state (see eventState)
    const state = this.liveState() ?? restState;
    const song = playing?.title ? playing : null;
    const key = song && StreamElementsClient.key(song);
    // Pause began on the first song named, or the followed one if /playing named none
    this.pausedOn = state === "paused" ? (this.pausedOn ?? key ?? this.currentKey) : null;
    this.movedWhilePaused = state === "paused" && this.liveState() === null && key !== null && key !== this.pausedOn && key !== this.currentKey;
    let next: SESong | null;
    if (state === undefined) {
      // No state in the answer: trust /playing rather than never show anything
      if (!this.warnedNoState) console.warn("[SE] The player didn't say whether it's playing; following the current song");
      this.warnedNoState = true;
      next = song;
    } else if (state === "playing") {
      next = song;
    } else {
      // Paused keeps the song on, even if /playing briefly answers nothing;
      // any other state: /playing is only the next song up
      if (state === "paused" && (key === null || key === this.currentKey)) {
        this.unfollowedSince = 0;
        return;
      }
      next = key !== null && key === this.currentKey ? song : null;
    }
    const nextKey = next && StreamElementsClient.key(next);
    // A named song isn't followed: see followingProblem()
    if (song && !next) this.unfollowedSince ||= Date.now();
    else this.unfollowedSince = 0;
    if (nextKey === this.currentKey) return;
    // Only auto-generated uploads carry exact metadata; asking about others costs quota and time
    const exact = next && isTopicChannel(next.channel) ? await songFromYouTube(next.videoId) : null;
    // "X - Y" from a fan's or label's channel: MusicBrainz may say which side is the artist
    const read = next && !exact ? await settleTitleOrder(parseVideoTitle(next.title ?? "", next.channel)) : null;
    const entry = next && StreamElementsClient.toEntry(next, exact, read);
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
      // Events may have been missed while disconnected: let REST decide again
      () => {
        this.eventState = null;
        this.handleEvent();
      }
    );
    this.stream.start();
  }

  /** Notes the live state from an event, then fetches again */
  private handleEvent(event = ""): void {
    if (event) {
      const name = event.replace(/^songrequest\./, "");
      if (/^(play|song\.next|song\.previous|song\.skip)$/.test(name)) {
        this.eventState = "playing";
      }
      else if (name === "pause") this.eventState = "paused";
      if (!/^(volume|queue\.|history\.|song\.position|song\.voteskip|settings\.)/.test(name)) console.log(`[SE] Event: ${name}`);
    }
    this.refetch.run();
  }

  private schedulePoll(): void {
    this.poll.schedule();
  }

  private async pollOnce(): Promise<void> {
    if (this.channelId === null) {
      try {
        await this.resolveChannel();
        this.connectEvents();
      } catch {
        // Still unreachable; try again next poll
      }
    }
    await this.refresh();
  }
}
