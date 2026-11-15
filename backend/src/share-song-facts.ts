import { isNotMusic } from "./not-music";
import { namesRequester } from "./stat-facts";
import { Fact, SSLSong } from "./types";

/**
 * "Share song facts with other apps": hands the song on now and its facts to
 * the address the streamer set, as context that app may use when chat asks
 * about the song. Off unless the streamer turns it on with their own address
 * and key. It sits beside the overlay, never in
 * front of it: `update` returns at once, a failure is logged by reason only,
 * and it's tried again with the next change or refresh. The key is never logged.
 *
 * The song goes out as soon as it starts, saying it has no checked facts yet,
 * and again as its facts arrive or are taken off. Only the song and its facts
 * are sent, never who requested it. See "Sharing song facts with other apps"
 * in docs/ARCHITECTURE.md.
 */

/** The longest `data.content` that is sent. */
export const CONTENT_LIMIT = 1000;
/** Names this app's snapshot, so each update replaces only it. */
export const SOURCE_ID = "bubblefacts";
/**
 * Seconds a snapshot lasts unless it's sent again. Short on purpose: if this app stops for any
 * reason (quit, a crash, the computer asleep), the other app forgets the song by itself.
 */
export const SHARE_TTL_SECONDS = 150;
/**
 * How often the song on now is sent again: well inside the lifetime, so one missed send doesn't
 * drop it, and an app that started late or started over has the song within a minute.
 */
const REFRESH_MS = 60_000;
/** Sent again for this long after the last change: a song left on the queue doesn't send all night. */
const REFRESH_FOR_MS = 60 * 60 * 1000;
/** Lets the changes around a new song land as one request. */
const SETTLE_MS = 400;
const TIMEOUT_MS = 5000;
const NAME_LIMIT = 150;

/** The sources whose facts were checked against them, by how each fact's `source` starts. */
const CHECKED_SOURCES = ["Wikipedia", "Wikidata", "MusicBrainz"] as const;
const TWITCH_ABOUT = "Twitch About: ";
const INTRO_STREAMER = "From the streamer:";
/** Facts only from what is given; an opinion of the other app's own is fine, as long as it reads as one. */
const OPINIONS = "Your own opinions are welcome, said as yours.";
const CLOSING = `State facts about this song only from these, and add none. ${OPINIONS}`;
const CLOSING_CREDIT = `State facts about this song only from these, add none, and credit BubbleFacts. ${OPINIONS}`;
const NO_FACTS = `BubbleFacts has no checked facts for this song right now. Say what's playing if asked, and don't make up facts about it. ${OPINIONS}`;

const listOf = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names.join(""));
const introChecked = (sources: string[]) => `Facts from BubbleFacts, checked against ${listOf(sources)}:`;
/** Room is kept for the longest lead-in, so the one used can name just the sources of the facts that fit. */
const INTRO_CHECKED_ROOM = introChecked([...CHECKED_SOURCES]).length;

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

const checkedSource = (fact: Fact) => CHECKED_SOURCES.find((s) => new RegExp(`^${s}\\b`).test(fact.source ?? ""));
/** The artist's own words from their Twitch About: neither checked nor the streamer's. Its text says where it's from. */
const fromTwitchAbout = (fact: Fact) => (fact.source ?? "").startsWith(TWITCH_ABOUT);

/**
 * The text for a song: what's playing, then its facts (whole facts only), or that it has none
 * yet. "" when there's nothing to share: no song title, or a track that isn't music (a
 * commercial, a jingle) with no facts of its own, which the overlay doesn't announce either.
 */
export function shareContent(song: SSLSong, facts: Fact[]): string {
  // In quotes, so a title is read as a title: "Stand by Me" by Some Singer.
  const title = oneLine(song.title, NAME_LIMIT).replace(/"/g, "'");
  const artist = oneLine(song.artist, NAME_LIMIT);
  const known = artist && artist !== "Unknown";
  const head = `Now playing: "${title}"${known ? ` by ${artist}` : ""}.`;
  // Who asked for the song stays on the overlay: the entry fact that names them is never sent.
  const shared = facts.filter((f) => !namesRequester(f.text));
  if (!title || (!shared.length && isNotMusic(song))) return "";

  let room = CONTENT_LIMIT - head.length - 1 - CLOSING_CREDIT.length;
  const take = (list: Fact[], introRoom: number): string[] => {
    const lines: string[] = [];
    for (const fact of list) {
      const text = oneLine(fact.text, CONTENT_LIMIT);
      const cost = text.length + 1 + (lines.length || !introRoom ? 0 : introRoom + 1);
      if (!text || cost > room) continue;
      room -= cost;
      lines.push(text);
    }
    return lines;
  };
  const checked = shared.filter(checkedSource);
  const taken = new Set(take(checked, INTRO_CHECKED_ROOM));
  const sources = CHECKED_SOURCES.filter((s) => checked.some((f) => checkedSource(f) === s && taken.has(oneLine(f.text, CONTENT_LIMIT))));
  const about = take(shared.filter(fromTwitchAbout), 0);
  const own = take(shared.filter((f) => !checkedSource(f) && !fromTwitchAbout(f)), INTRO_STREAMER.length);
  const parts = [
    taken.size ? `${introChecked(sources)} ${[...taken].join(" ")}` : "",
    about.join(" "),
    own.length ? `${INTRO_STREAMER} ${own.join(" ")}` : "",
  ].filter(Boolean);
  if (!parts.length) return `${head} ${NO_FACTS}`;
  return [head, ...parts, taken.size ? CLOSING_CREDIT : CLOSING].join(" ");
}

export interface ShareOptions {
  url: string;
  apiKey: string;
  channel: string;
  /** Shorter in tests. */
  settleMs?: number;
  refreshMs?: number;
  timeoutMs?: number;
  log?: (line: string) => void;
}

export class SongFactSharer {
  private wanted = "";
  /** What the other app holds as far as this app knows. */
  private held = "";
  private sending = false;
  private settle: NodeJS.Timeout | null = null;
  private refresh: NodeJS.Timeout | null = null;
  private refreshUntil = 0;
  private refused = false;
  private stopped = false;
  private lastProblem = "";

  constructor(private readonly options: ShareOptions) {}

  /** The song on now and its facts (none yet is fine), or null when nothing is. Returns at once. */
  update(song: SSLSong | null, facts: Fact[]): void {
    if (this.refused) return;
    const content = song ? shareContent(song, facts) : "";
    if (content === this.wanted) return;
    this.wanted = content;
    if (content) this.refreshUntil = Date.now() + REFRESH_FOR_MS;
    this.clearTimer("refresh");
    this.clearTimer("settle");
    this.settle = setTimeout(() => void this.send(), this.options.settleMs ?? SETTLE_MS);
    this.settle.unref?.();
  }

  /** Nothing more is sent or said: a request already on its way ends quietly. */
  stop(): void {
    this.stopped = true;
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
    const content = this.wanted;
    if (!force && content === this.held) return;
    this.sending = true;
    const problem = await this.post(content);
    this.sending = false;
    if (problem) this.note(problem);
    else {
      this.held = content;
      this.lastProblem = "";
    }
    if (this.refused) return;
    // It changed while that was on its way.
    if (this.wanted !== content) return void this.send();
    if (content) this.scheduleRefresh();
  }

  /** The same snapshot again before it runs out, whether or not the last send got through. */
  private scheduleRefresh(): void {
    const wait = this.options.refreshMs ?? REFRESH_MS;
    if (Date.now() + wait > this.refreshUntil) return;
    this.clearTimer("refresh");
    this.refresh = setTimeout(() => void this.send(true), wait);
    this.refresh.unref?.();
  }

  /** The reason it failed, or "". Empty content clears this app's snapshot. */
  private async post(content: string): Promise<string> {
    const data = { channelName: this.options.channel, sourceId: SOURCE_ID, content, ...(content ? { ttl: SHARE_TTL_SECONDS } : {}) };
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
      if (res.status === 400 || res.status === 422) return "the event was refused";
      return res.ok ? "" : `HTTP ${res.status}`;
    } catch (err) {
      return (err as Error)?.name === "TimeoutError" ? "timed out" : "no connection";
    }
  }

  private note(problem: string): void {
    if (this.stopped || problem === this.lastProblem) return;
    this.lastProblem = problem;
    (this.options.log ?? console.warn)(`[Share] Song facts not shared: ${problem}`);
  }
}
