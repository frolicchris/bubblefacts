import { isNotMusic } from "./not-music";
import { namesRequester } from "./stat-facts";
import { Fact, SSLSong } from "./types";

// "Share song facts with other apps" (off by default): the song on now, as it starts, then its facts, never its
// requester, go to the streamer's address as context for chat answers (ARCHITECTURE.md). Beside the overlay, never
// in front: `update` returns at once, a failure logs its reason only and waits for the next change or refresh,
// the key is never logged

export const CONTENT_LIMIT = 1000; // characters of `data.content`, at most
export const SOURCE_ID = "bubblefacts"; // names this app's snapshot, so each update replaces only it
export const SHARE_TTL_SECONDS = 150; // seconds a snapshot lasts unsent; short so the other app forgets the song if this one stops (quit, crash, asleep)

const REFRESH_MS = 60_000; // ms between resends: well inside the lifetime, and a late-started app has the song within a minute
const REFRESH_FOR_MS = 60 * 60 * 1000; // ms of resending after the last change, so a song left on the queue doesn't send all night
const SETTLE_MS = 400; // ms for the changes around a new song to land as one request
const TIMEOUT_MS = 5000; // ms per request
const NAME_LIMIT = 150; // characters of a title or artist

// Sources facts were checked against, by how each fact's `source` starts
const CHECKED_SOURCES = ["Wikipedia", "Wikidata", "MusicBrainz"] as const;
const TWITCH_ABOUT = "Twitch About: ";
const INTRO_STREAMER = "From the streamer:";
// Facts only from what's given; the other app's own opinion is fine if it reads as one
const OPINIONS = "Your own opinions are welcome, said as yours.";
const CLOSING = `State facts about this song only from these, and add none. ${OPINIONS}`;
const CLOSING_CREDIT = `State facts about this song only from these, add none, and credit BubbleFacts. ${OPINIONS}`;
/** The list has shown this song longer than a song lasts (stale-song.ts): the last song known, and no facts about it */
const staleText = (named: string) => `BubbleFacts isn't sure what's playing right now. The song list still shows ${named}, but it has been on so long that the song may have changed. If asked what's playing, say you're not sure, and state no facts about that song.`;
const NO_FACTS = `BubbleFacts has no checked facts for this song right now. Say what's playing if asked, and don't make up facts about it. ${OPINIONS}`;

const listOf = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names.join(""));
const introChecked = (sources: string[]) => `Facts from BubbleFacts, checked against ${listOf(sources)}:`;
// Room for the longest lead-in, so the one used can name just the sources of the facts that fit
const INTRO_CHECKED_ROOM = introChecked([...CHECKED_SOURCES]).length;

/** The address if https, or http on this computer only, with no sign-in in it; else null */
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

// Titles can come from viewers' requests: one line, no control characters, a fair length
const oneLine = (text: string, limit: number) => text.replace(/[\p{Cc}\s]+/gu, " ").trim().slice(0, limit).trim();

const checkedSource = (fact: Fact) => CHECKED_SOURCES.find((s) => new RegExp(`^${s}\\b`).test(fact.source ?? ""));
// The artist's own words from their Twitch About: neither checked nor the streamer's; its text says where it's from
const fromTwitchAbout = (fact: Fact) => (fact.source ?? "").startsWith(TWITCH_ABOUT);

export interface ShareMore {
  /** The song list hasn't moved in longer than a song lasts: say so, and share no facts for it */
  stale?: boolean;
  /** The next song in the queue, when the source has one (#448): only its title and artist are read */
  next?: Pick<SSLSong, "title" | "artist"> | null;
}

/** `Up next: "Title" by Artist.`, or "" with no next song, no title, or a track that isn't music */
function nextLine(next: ShareMore["next"]): string {
  if (!next) return "";
  // Built from the title and artist alone: who requested the next song is never read (privacy)
  const title = oneLine(next.title ?? "", NAME_LIMIT).replace(/"/g, "'");
  const artist = oneLine(next.artist ?? "", NAME_LIMIT);
  if (!title || isNotMusic({ title, artist })) return "";
  return `Up next: "${title}"${artist && artist !== "Unknown" ? ` by ${artist}` : ""}.`;
}

/**
 * What's playing, then its facts (whole only) or that it has none yet. "" with no title, or for a
 * track that isn't music (a commercial, a jingle) with no facts, which the overlay skips too
 */
export function shareContent(song: SSLSong, facts: Fact[], more: ShareMore = {}): string {
  return shareSnapshot(song, facts, more).content;
}

/** The content with what the log says about it (#452): the title as sent, and how many facts went with it */
export function shareSnapshot(song: SSLSong, facts: Fact[], more: ShareMore = {}): { content: string; title: string; facts: number; stale?: boolean } {
  // Quoted, so a title reads as one: "Stand by Me" by Some Singer
  const title = oneLine(song.title, NAME_LIMIT).replace(/"/g, "'");
  const artist = oneLine(song.artist, NAME_LIMIT);
  const known = artist && artist !== "Unknown";
  const named = `"${title}"${known ? ` by ${artist}` : ""}`;
  // What's next rides with the song on now: its name only, and its facts when it starts (#448)
  const upNext = nextLine(more.next);
  const head = `Now playing: ${named}.${upNext ? ` ${upNext}` : ""}`;
  // Who asked for the song stays on the overlay: the entry fact naming them is never sent
  const shared = facts.filter((f) => !namesRequester(f.text));
  if (!title || (!shared.length && isNotMusic(song))) return { content: "", title: "", facts: 0 };
  if (more.stale) return { content: staleText(named), title, facts: 0, stale: true };

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
  if (!parts.length) return { content: `${head} ${NO_FACTS}`, title, facts: 0 };
  return { content: [head, ...parts, taken.size ? CLOSING_CREDIT : CLOSING].join(" "), title, facts: taken.size + about.length + own.length };
}

/** The log's line for a snapshot the other app took: the song and how many facts, never the key or the address */
function sharedLine(content: string, about: { title: string; facts: number; stale: boolean }): string {
  if (!content) return "[Share] Cleared: no song is shared now";
  if (about.stale) return `[Share] Shared that "${about.title}" may be over`;
  return `[Share] Shared "${about.title}": ${about.facts ? `${about.facts} fact${about.facts === 1 ? "" : "s"}` : "no facts yet"}`;
}

export interface ShareOptions {
  url: string;
  apiKey: string;
  channel: string;
  /** Shorter in tests */
  settleMs?: number;
  refreshMs?: number;
  timeoutMs?: number;
  log?: (line: string) => void;
}

/** The last snapshot the other app took: for Settings' "Last shared" line */
export interface LastShared {
  title: string;
  /** ms since 1970 */
  at: number;
}

export class SongFactSharer {
  private wanted = "";
  /** What `wanted` says, for the log */
  private wantedAbout = { title: "", facts: 0, stale: false };
  private shared: LastShared | null = null;
  /** What the other app holds, as far as this app knows */
  private held = "";
  private sending = false;
  private settle: NodeJS.Timeout | null = null;
  private refresh: NodeJS.Timeout | null = null;
  private refreshUntil = 0;
  private refused = false;
  private stopped = false;
  private lastProblem = "";

  constructor(private readonly options: ShareOptions) {}

  /** The song on now and its facts (none yet is fine), or null when nothing is; returns at once */
  update(song: SSLSong | null, facts: Fact[], more: ShareMore = {}): void {
    if (this.refused) return;
    const snapshot = song ? shareSnapshot(song, facts, more) : { content: "", title: "", facts: 0 };
    const content = snapshot.content;
    if (content === this.wanted) return;
    this.wanted = content;
    this.wantedAbout = { title: snapshot.title, facts: snapshot.facts, stale: Boolean(snapshot.stale) };
    if (content) this.refreshUntil = Date.now() + REFRESH_FOR_MS;
    this.clearTimer("refresh");
    this.clearTimer("settle");
    this.settle = setTimeout(() => void this.send(), this.options.settleMs ?? SETTLE_MS);
    this.settle.unref?.();
  }

  /** The song of the last snapshot the other app took, and when; null before the first */
  get lastShared(): LastShared | null {
    return this.shared;
  }

  /** Nothing more is sent or said; a request on its way ends quietly */
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
    const about = this.wantedAbout;
    if (!force && content === this.held) return;
    this.sending = true;
    const problem = await this.post(content);
    this.sending = false;
    if (problem) this.note(problem);
    else {
      // One line per change the other app took (#452), not per one-minute resend of the same snapshot
      if (content !== this.held) this.say(sharedLine(content, about));
      if (content) this.shared = { title: about.title, at: Date.now() };
      this.held = content;
      this.lastProblem = "";
    }
    if (this.refused) return;
    // It changed while that was on its way
    if (this.wanted !== content) return void this.send();
    if (content) this.scheduleRefresh();
  }

  /** The same snapshot again before it runs out, whether or not the last send got through */
  private scheduleRefresh(): void {
    const wait = this.options.refreshMs ?? REFRESH_MS;
    if (Date.now() + wait > this.refreshUntil) return;
    this.clearTimer("refresh");
    this.refresh = setTimeout(() => void this.send(true), wait);
    this.refresh.unref?.();
  }

  /** The reason it failed, or ""; empty content clears this app's snapshot */
  private async post(content: string): Promise<string> {
    const data = { channelName: this.options.channel, sourceId: SOURCE_ID, content, ...(content ? { ttl: SHARE_TTL_SECONDS } : {}) };
    try {
      const res = await fetch(this.options.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.options.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ eventType: "INTEGRATION_STATE", data }),
        // Only ever the address the streamer set
        redirect: "error",
        signal: AbortSignal.timeout(this.options.timeoutMs ?? TIMEOUT_MS),
      });
      if (res.status === 401 || res.status === 403) {
        // Stays refused until the key or channel changes, which restarts the server
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

  private say(line: string): void {
    if (!this.stopped) (this.options.log ?? console.log)(line);
  }
}
