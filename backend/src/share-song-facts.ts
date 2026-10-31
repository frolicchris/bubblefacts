import { Fact, SSLSong } from "./types";

/**
 * "Share song facts with other apps": hands the song on now and its facts to
 * the address the streamer set, as context that app may use when chat asks
 * about the song. Off unless the streamer turns it on with their own address
 * and key. It sits beside the overlay, never in
 * front of it: `update` returns at once, a failure is logged by reason only,
 * and nothing is retried until the next change. The key is never logged.
 *
 * Only the song and its facts are sent, not who requested it.
 */

/** The longest `data.content` that is sent. */
export const CONTENT_LIMIT = 1000;
/** Names this app's snapshot, so each update replaces only it. */
export const SOURCE_ID = "bubblefacts";

/** Used when the song source doesn't say how long a song is. */
const DEFAULT_SONG_SECONDS = 390;
const TTL_MARGIN_SECONDS = 30;
const MAX_TTL_SECONDS = 3600;
/** Snapshots expire, so a long song is sent again, up to this long: a song left on the queue doesn't send all night. */
const REFRESH_FOR_MS = 60 * 60 * 1000;
/** Lets the changes around a new song land as one request. */
const SETTLE_MS = 400;
const TIMEOUT_MS = 5000;
const NAME_LIMIT = 150;

const INTRO_CHECKED = "Checked facts from Wikipedia, Wikidata and MusicBrainz:";
const INTRO_STREAMER = "From the streamer:";
const CLOSING = "Answer questions about this song only from these facts and add nothing.";

/** https, or plain http on this computer only, with no sign-in in the address. The address, or null. */
export function shareAddress(text: string): string | null {
  try {
    const url = new URL(text.trim());
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || !(url.protocol === "https:" || (url.protocol === "http:" && local))) return null;
    return text.trim();
  } catch {
    return null;
  }
}

/** Titles can come from viewers' requests: one line, no control characters, and a fair length. */
const oneLine = (text: string, limit: number) => text.replace(/[\p{Cc}\s]+/gu, " ").trim().slice(0, limit).trim();

const isChecked = (fact: Fact) => /^(Wikipedia|Wikidata|MusicBrainz)\b/.test(fact.source ?? "");

/** The text for a song and its facts, whole facts only, or "" when there are none to share. */
export function shareContent(song: SSLSong, facts: Fact[]): string {
  const title = oneLine(song.title, NAME_LIMIT);
  const artist = oneLine(song.artist, NAME_LIMIT);
  const known = artist && artist !== "Unknown";
  const head = `Now playing: ${title}${known ? ` by ${artist}` : ""}.`;
  const checked = facts.filter(isChecked);
  const own = facts.filter((f) => !isChecked(f));
  let length = head.length + CLOSING.length + 1;
  const take = (intro: string, list: Fact[]): string => {
    const lines: string[] = [];
    for (const fact of list) {
      const text = oneLine(fact.text, CONTENT_LIMIT);
      const cost = text.length + 1 + (lines.length ? 0 : intro.length + 1);
      if (!text || length + cost > CONTENT_LIMIT) continue;
      length += cost;
      lines.push(text);
    }
    return lines.length ? `${intro} ${lines.join(" ")}` : "";
  };
  const parts = [take(INTRO_CHECKED, checked), take(INTRO_STREAMER, own)].filter(Boolean);
  return parts.length ? [head, ...parts, CLOSING].join(" ") : "";
}

/** Seconds the snapshot stays: about the song's length. */
export function shareTtl(songSeconds?: number | null): number {
  const seconds = songSeconds && songSeconds > 0 ? songSeconds : DEFAULT_SONG_SECONDS;
  return Math.min(MAX_TTL_SECONDS, Math.round(seconds) + TTL_MARGIN_SECONDS);
}

export interface ShareOptions {
  url: string;
  apiKey: string;
  channel: string;
  /** Shorter in tests. */
  settleMs?: number;
  timeoutMs?: number;
  log?: (line: string) => void;
}

export class SongFactSharer {
  private wanted = { content: "", ttl: 0 };
  /** What the other app holds as far as this app knows. */
  private held = "";
  private sending = false;
  private settle: NodeJS.Timeout | null = null;
  private refresh: NodeJS.Timeout | null = null;
  private refreshUntil = 0;
  private refused = false;
  private lastProblem = "";

  constructor(private readonly options: ShareOptions) {}

  /** The song on now and its facts, or null when nothing is. Returns at once. */
  update(song: SSLSong | null, facts: Fact[], songSeconds?: number | null): void {
    if (this.refused) return;
    const content = song ? shareContent(song, facts) : "";
    if (content === this.wanted.content) return;
    this.wanted = { content, ttl: shareTtl(songSeconds) };
    if (content) this.refreshUntil = Date.now() + REFRESH_FOR_MS;
    this.clearTimer("refresh");
    this.clearTimer("settle");
    this.settle = setTimeout(() => void this.send(), this.options.settleMs ?? SETTLE_MS);
    this.settle.unref?.();
  }

  stop(): void {
    this.refused = true;
    this.clearTimer("settle");
    this.clearTimer("refresh");
  }

  private clearTimer(which: "settle" | "refresh"): void {
    const timer = this[which];
    if (timer) clearTimeout(timer);
    this[which] = null;
  }

  private async send(force = false): Promise<void> {
    if (this.sending || this.refused) return;
    const { content, ttl } = this.wanted;
    if (!force && content === this.held) return;
    this.sending = true;
    const problem = await this.post(content, ttl);
    this.sending = false;
    if (problem) this.note(problem);
    else {
      this.held = content;
      this.lastProblem = "";
    }
    if (this.refused) return;
    // It changed while that was on its way.
    if (this.wanted.content !== content) return void this.send();
    if (content) this.scheduleRefresh(ttl);
  }

  private scheduleRefresh(ttl: number): void {
    const wait = (ttl - TTL_MARGIN_SECONDS) * 1000;
    if (Date.now() + wait > this.refreshUntil) return;
    this.refresh = setTimeout(() => void this.send(true), wait);
    this.refresh.unref?.();
  }

  /** The reason it failed, or "". Empty content clears this app's snapshot. */
  private async post(content: string, ttl: number): Promise<string> {
    const data = { channelName: this.options.channel, sourceId: SOURCE_ID, content, ...(content ? { ttl } : {}) };
    try {
      const res = await fetch(this.options.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.options.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ eventType: "INTEGRATION_STATE", data }),
        // Never to another address than the one the streamer set.
        redirect: "error",
        signal: AbortSignal.timeout(this.options.timeoutMs ?? TIMEOUT_MS),
      });
      if (res.status === 401 || res.status === 403) {
        // It won't get better until the key or channel changes, and that restarts the server.
        this.refused = true;
        return "the key or channel was refused";
      }
      if (res.status === 422) return "the event was refused";
      return res.ok ? "" : `HTTP ${res.status}`;
    } catch (err) {
      return (err as Error)?.name === "TimeoutError" ? "timed out" : "no connection";
    }
  }

  private note(problem: string): void {
    if (problem === this.lastProblem) return;
    this.lastProblem = problem;
    (this.options.log ?? console.warn)(`[Share] Song facts not shared: ${problem}`);
  }
}
