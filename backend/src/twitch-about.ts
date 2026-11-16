import { setCapped } from "./capped-map";
import { MAX_FACT_CHARS } from "./fact-verifier";
import { hasNoArtist } from "./text";

// A channel's public Twitch About for a song no source knows (#47), asked of the app, which holds the sign-in
// Without the app nothing is asked (ARCHITECTURE.md: The life of one song, step 9)

// In front of every bubble: an About is usually first person, which would read as the streamer's
export const ABOUT_CREDIT = "From their Twitch About: ";
const WAIT_MS = 2_000; // ms a song waits for Twitch; a later answer is kept for the artist's next song
const GIVE_UP_MS = 45_000; // ms before an unanswered question is dropped; longer than the app's slowest try (renewal, then request)
const KEPT_MS = 60 * 60_000; // ms a channel, or none, is kept
const FAILED_KEPT_MS = 5 * 60_000; // ms a failure is kept: briefly, so an outage can't slow every song
const MAX_KEPT = 500; // logins remembered

// A login: letters, digits, underscores; five or more, as Twitch's four-letter ones are mostly words
const LOGIN = /^(?=.*[a-z])[a-z0-9_]{5,25}$/i;
// One-word credits that are a word first, a name second: a channel by that name is likely a stranger
const COMMON_WORDS = new Set([
  "angel", "artist", "artists", "band", "brass", "choir", "chorus", "composer", "cover", "covers", "dragon", "dream", "drums",
  "ensemble", "folk", "friends", "games", "ghost", "group", "guitar", "guest", "harmony", "legend", "legends", "live",
  "melody", "music", "musician", "nintendo", "orchestra", "original", "originals", "phoenix", "piano", "player", "shadow",
  "singer", "soundtrack", "storm", "strings", "studio", "thunder", "various", "violin", "vocals",
]);
// Sentences about the channel rather than the person: not facts for a song
const CHANNEL_TALK = /\b(?:follow|subscribe|subs?|donat\w*|tips?|discord|schedule|inquir\w*|enquir\w*|welcome|sponsor\w*|merch)\b/i;

export const aboutIsChannelTalk = (text: string): boolean => CHANNEL_TALK.test(text);

/** The login to try for an artist, or "" unless the artist is a single, unusual name */
export function loginForArtist(artist: string): string {
  const name = artist.trim();
  if (hasNoArtist(name) || !LOGIN.test(name)) return "";
  const login = name.toLowerCase();
  return COMMON_WORDS.has(login) ? "" : login;
}

export interface TwitchAbout {
  name: string;
  facts: string[];
}

/** From the app; an empty About is "none", never `found` */
interface Answer {
  type: "twitch-about";
  login: string;
  state: "found" | "none" | "failed" | "off";
  name?: string;
  facts?: string[];
}

type Send = (message: { type: "twitch-about"; login: string; chars: number }) => void;

let send: Send | null = null;
const known = new Map<string, { about: TwitchAbout | null; expires: number }>();
const asking = new Map<string, { done: (about: TwitchAbout | null) => void; answer: Promise<TwitchAbout | null> }>();

/** Set by the server when it runs under the app */
export function connectAboutAsker(sender: Send | null): void {
  send = sender;
}

/** Whether the app is there to ask */
export const canAskAbout = (): boolean => send !== null;

/** Turned off or Twitch disconnected: forget everything, and open questions don't count */
export function forgetAbouts(): void {
  known.clear();
  for (const a of asking.values()) a.done(null);
  asking.clear();
}

/** The app's answer; anything unexpected counts as no answer */
export function onAboutAnswer(data: unknown): void {
  const a = data as Partial<Answer>;
  const open = typeof a?.login === "string" ? asking.get(a.login) : undefined;
  if (!open || !a.login) return;
  asking.delete(a.login);
  const facts = Array.isArray(a.facts) ? a.facts.filter((f): f is string => typeof f === "string" && Boolean(f.trim())) : [];
  const about = a.state === "found" && typeof a.name === "string" && a.name && facts.length ? { name: a.name, facts } : null;
  // "Off" isn't kept: connecting Twitch or checking the box works from the next song on
  if (a.state !== "off") setCapped(known, a.login, { about, expires: Date.now() + (a.state === "failed" ? FAILED_KEPT_MS : KEPT_MS) }, MAX_KEPT);
  open.done(about);
}

/** A channel's About, or null (no channel, empty About, Twitch off, slow or failing); never throws */
export async function twitchAbout(login: string): Promise<TwitchAbout | null> {
  const kept = known.get(login);
  if (kept && Date.now() < kept.expires) return kept.about;
  if (!send) return null;
  let open = asking.get(login);
  if (!open) {
    let done: (about: TwitchAbout | null) => void = () => undefined;
    const answer = new Promise<TwitchAbout | null>((resolve) => (done = resolve));
    const mine = { done, answer };
    open = mine;
    asking.set(login, mine);
    setTimeout(() => {
      if (asking.get(login) !== mine) return;
      asking.delete(login);
      mine.done(null);
    }, GIVE_UP_MS).unref();
    try {
      send({ type: "twitch-about", login, chars: MAX_FACT_CHARS - ABOUT_CREDIT.length });
    } catch {
      asking.delete(login);
      return null;
    }
  }
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), WAIT_MS)));
  return Promise.race([open.answer, late]).finally(() => clearTimeout(timer));
}
