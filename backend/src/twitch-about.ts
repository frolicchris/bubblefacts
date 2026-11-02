import { setCapped } from "./capped-map";
import { MAX_FACT_CHARS } from "./fact-verifier";
import { hasNoArtist } from "./text";

/**
 * A channel's public Twitch About for a song no source knows (issue #47). The
 * Twitch sign-in stays in the desktop app, so the server asks the app over the
 * channel the app already uses to hand it a new song list token: one question,
 * one answer, by login. The app says "off" until Twitch is connected and the
 * box in Settings is checked. Run without the app, nothing is ever asked.
 */

/** Goes in front of every bubble: an About is usually in the first person, which would read as the streamer's. */
export const ABOUT_CREDIT = "From their Twitch About: ";
/** How long a song waits for Twitch. A later answer is kept for the next song by that artist. */
const WAIT_MS = 2_000;
/** Longer than the app's slowest try (a renewal, then the request), so a question it never answered is given up on. */
const GIVE_UP_MS = 45_000;
/** A channel, or none, is kept this long; a failure only briefly, so an outage can't slow every song. */
const KEPT_MS = 60 * 60_000;
const FAILED_KEPT_MS = 5 * 60_000;
const MAX_KEPT = 500;

/**
 * A login: letters, digits or underscores, so spaces, "A, B", "A & B" and "A feat. B"
 * are never one. Twitch allows four characters; most four-letter names are words, so
 * those abstain. Spaces aren't taken out: "Blue Moon" is a band far more often than
 * it's the channel bluemoon.
 */
const LOGIN = /^(?=.*[a-z])[a-z0-9_]{5,25}$/i;
/** One-word credits that are a word first and a name second: a channel by that name is likely a stranger. */
const COMMON_WORDS = new Set([
  "angel", "artist", "artists", "band", "brass", "choir", "chorus", "composer", "cover", "covers", "dragon", "dream", "drums",
  "ensemble", "folk", "friends", "games", "ghost", "group", "guitar", "guest", "harmony", "legend", "legends", "live",
  "melody", "music", "musician", "nintendo", "orchestra", "original", "originals", "phoenix", "piano", "player", "shadow",
  "singer", "soundtrack", "storm", "strings", "studio", "thunder", "various", "violin", "vocals",
]);
/** Sentences about the channel rather than the person: not facts for a song. */
const CHANNEL_TALK = /\b(?:follow|subscribe|subs?|donat\w*|tips?|discord|schedule|inquir\w*|enquir\w*|welcome|sponsor\w*|merch)\b/i;

export const aboutIsChannelTalk = (text: string): boolean => CHANNEL_TALK.test(text);

/** The login to try for an artist, or "" when it can't safely be one: only an artist that is a single, unusual name. */
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

/** From the app. `found` with no facts doesn't happen: an empty About is "none". */
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

/** The server sets this when it runs under the app. */
export function connectAboutAsker(sender: Send | null): void {
  send = sender;
}

/** The app turned this off or disconnected Twitch: nothing kept, and questions still open don't count. */
export function forgetAbouts(): void {
  known.clear();
  for (const a of asking.values()) a.done(null);
  asking.clear();
}

/** The app's answer. Anything unexpected counts as no answer. */
export function onAboutAnswer(data: unknown): void {
  const a = data as Partial<Answer>;
  const open = typeof a?.login === "string" ? asking.get(a.login) : undefined;
  if (!open || !a.login) return;
  asking.delete(a.login);
  const facts = Array.isArray(a.facts) ? a.facts.filter((f): f is string => typeof f === "string" && Boolean(f.trim())) : [];
  const about = a.state === "found" && typeof a.name === "string" && a.name && facts.length ? { name: a.name, facts } : null;
  // "Off" isn't kept: connecting Twitch or checking the box works from the next song on.
  if (a.state !== "off") setCapped(known, a.login, { about, expires: Date.now() + (a.state === "failed" ? FAILED_KEPT_MS : KEPT_MS) }, MAX_KEPT);
  open.done(about);
}

/** A channel's About, or null: no such channel, an empty About, Twitch off, slow or failing. Never throws. */
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
