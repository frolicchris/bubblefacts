/**
 * Connect Twitch (optional): lets BubbleFacts read another music content creator's public
 * About text, for their originals (issue #47). Twitch's device code sign-in,
 * the flow for apps that can't keep a secret: Twitch's page opens with a short
 * code filled in, which the streamer checks against the app's and authorizes. No scopes: a channel's description is public, and any
 * sign-in may read it. Access tokens last 4 hours; for this kind of app each
 * refresh token works once, and lapses after 30 days unused.
 */

import { setTimeout as sleep } from "timers/promises";
import { cantReach, errorDetail, plainError, plainWithDetail } from "./plain-errors";

/** Public client ID from dev.twitch.tv (client type Public). Not a secret. */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require("../../package.json") as { bubblefacts?: { twitchClientId?: string } };
export const TWITCH_CLIENT_ID = process.env.BUBBLEFACTS_TWITCH_CLIENT_ID || pkg.bubblefacts?.twitchClientId || "";
const ID = "https://id.twitch.tv/oauth2";
const HELIX = "https://api.twitch.tv/helix";

export interface TwitchSignIn {
  accessToken: string;
  refreshToken: string;
  /** Milliseconds since 1970. */
  expiresAt: number;
  login: string;
}

/** Twitch won't renew the sign-in: the streamer connects again. */
export class TwitchSignInExpired extends Error {}
/** Twitch turned this access token down; a renewal may fix it. */
class TwitchUnauthorized extends Error {}

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  /** The page to approve on, with the code already in it. */
  verificationUri: string;
  /** Seconds between checks, as Twitch asks. */
  interval: number;
  expiresAt: number;
}

const ENDED = "Your Twitch connection ended. Connect Twitch again in Settings.";
const RAN_OUT = "That code ran out. Click Connect Twitch to get a new one.";

/** One request to Twitch, with plain-words errors for the streamer. */
async function call(url: string, init: RequestInit, timeoutMs = 15_000, cancel?: AbortSignal): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    return await fetch(url, { ...init, signal: cancel ? AbortSignal.any([cancel, timeout]) : timeout });
  } catch (err) {
    if (cancel?.aborted) throw err;
    throw new Error(plainError(err, { service: "Twitch", fallback: cantReach("Twitch") }), { cause: err });
  }
}
const post = (fields: Record<string, string>) => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});
const failed = (res: Response) => plainWithDetail("Twitch isn't answering right now. Try again in a minute.", `HTTP ${res.status}`);

/** The tokens in a successful answer, checked before anything is saved. */
async function tokens(res: Response): Promise<Omit<TwitchSignIn, "login">> {
  const b = (await res.json().catch(() => ({}))) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
  if (typeof b.access_token !== "string" || typeof b.refresh_token !== "string") throw new Error("Twitch sent an answer BubbleFacts can't read. Try again.");
  return { accessToken: b.access_token, refreshToken: b.refresh_token, expiresAt: Date.now() + (typeof b.expires_in === "number" ? b.expires_in : 14400) * 1000 };
}

export async function startDeviceCode(): Promise<DeviceCode> {
  if (!TWITCH_CLIENT_ID) throw new Error("Connecting Twitch isn't available in this version.");
  const res = await call(`${ID}/device`, post({ client_id: TWITCH_CLIENT_ID, scopes: "" }));
  if (!res.ok) throw failed(res);
  const b = (await res.json()) as { device_code: string; user_code: string; verification_uri: string; interval?: number; expires_in?: number };
  return {
    deviceCode: b.device_code,
    userCode: b.user_code,
    verificationUri: b.verification_uri,
    interval: Math.max(1, b.interval ?? 5),
    expiresAt: Date.now() + (b.expires_in ?? 1800) * 1000,
  };
}

/** Wait for the streamer to approve the code on Twitch. */
export async function finishDeviceCode(code: DeviceCode, signal?: AbortSignal): Promise<TwitchSignIn> {
  let interval = code.interval;
  while (Date.now() < code.expiresAt) {
    await sleep(interval * 1000, undefined, { signal });
    const res = await call(`${ID}/token`, post({
      client_id: TWITCH_CLIENT_ID,
      scopes: "",
      device_code: code.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }), 15_000, signal);
    if (res.ok) {
      const t = await tokens(res);
      return { ...t, login: await loginOf(t.accessToken) };
    }
    const message = (((await res.json().catch(() => ({}))) as { message?: string }).message ?? "").toLowerCase();
    if (message.includes("authorization_pending")) continue;
    if (message.includes("slow_down")) { interval += 5; continue; }
    throw new Error(message.includes("expired") || message.includes("invalid device code") ? RAN_OUT : "Twitch didn't approve the connection. Try again.");
  }
  throw new Error(RAN_OUT);
}

/** Which Twitch account this is, for "Connected as …". Asked once, when connecting. */
async function loginOf(accessToken: string): Promise<string> {
  const res = await call(`${ID}/validate`, { headers: { Authorization: `OAuth ${accessToken}` } }).catch(() => null);
  return res?.ok ? (((await res.json()) as { login?: string }).login ?? "") : "";
}

export async function refreshTwitch(refreshToken: string): Promise<Omit<TwitchSignIn, "login">> {
  const res = await call(`${ID}/token`, post({ client_id: TWITCH_CLIENT_ID, grant_type: "refresh_token", refresh_token: refreshToken }));
  if (res.status === 400 || res.status === 401) throw new TwitchSignInExpired(ENDED);
  if (!res.ok) throw failed(res);
  return tokens(res);
}

/** Twitch forgets the sign-in too. Best effort, and quick: the app forgets it either way. */
export async function revokeTwitch(accessToken: string): Promise<void> {
  if (accessToken) await call(`${ID}/revoke`, post({ client_id: TWITCH_CLIENT_ID, token: accessToken }), 5_000).catch(() => undefined);
}

export interface TwitchChannel {
  login: string;
  displayName: string;
  description: string;
}

export async function getChannel(login: string, accessToken: string): Promise<TwitchChannel | null> {
  const res = await call(`${HELIX}/users?login=${encodeURIComponent(login)}`, { headers: { Authorization: `Bearer ${accessToken}`, "Client-Id": TWITCH_CLIENT_ID } });
  if (res.status === 401) throw new TwitchUnauthorized(ENDED);
  if (!res.ok) throw failed(res);
  const u = ((await res.json()) as { data?: Array<{ login: string; display_name: string; description: string }> }).data?.[0];
  return u ? { login: u.login, displayName: u.display_name, description: u.description ?? "" } : null;
}

/**
 * The streamer's Twitch connection: connecting with a code, renewing and
 * disconnecting, one at a time. `saved` reads the stored sign-in; `save`
 * stores one (null clears it). Newer always wins: work still running for an
 * older sign-in never saves over a Disconnect or a new connection.
 */
export class TwitchSession {
  private connecting: AbortController | null = null;
  private renewing: Promise<string> | null = null;
  /** The code to show while waiting for approval. */
  userCode = "";
  error = "";

  /** `log`: where the technical side of a failed connection goes. */
  constructor(
    private readonly saved: () => TwitchSignIn | null,
    private readonly save: (t: TwitchSignIn | null) => void,
    private readonly log: (line: string) => void = () => undefined
  ) {}

  private failed(err: unknown): void {
    this.log(`[App] Connect Twitch: ${errorDetail(err)}`);
    this.error = plainError(err, { service: "Twitch" });
  }

  /** Start connecting; `onDone` runs once it's settled, approved or not. */
  async connect(openPage: (url: string) => void, onDone: () => void): Promise<void> {
    this.connecting?.abort();
    const mine = new AbortController();
    this.connecting = mine;
    this.error = "";
    this.userCode = "";
    try {
      const code = await startDeviceCode();
      if (mine.signal.aborted) return;
      this.userCode = code.userCode;
      openPage(code.verificationUri);
      void finishDeviceCode(code, mine.signal)
        .then((t) => { if (!mine.signal.aborted) this.save(t); })
        .catch((err) => { if (!mine.signal.aborted) this.failed(err); })
        .finally(() => {
          if (this.connecting === mine) { this.connecting = null; this.userCode = ""; }
          onDone();
        });
    } catch (err) {
      if (!mine.signal.aborted) this.failed(err);
    }
  }

  async disconnect(): Promise<void> {
    this.connecting?.abort();
    this.connecting = null;
    this.userCode = "";
    this.error = "";
    const was = this.saved();
    this.save(null);
    if (!was) return;
    // A token that has run out can't be revoked: renew it once so Twitch forgets the live one.
    const live = was.expiresAt > Date.now() ? was.accessToken : await refreshTwitch(was.refreshToken).then((t) => t.accessToken, () => "");
    await revokeTwitch(live);
  }

  /** A live access token: renewed when it's about to run out, or when `force`d. One renewal at a time. */
  token(force = false): Promise<string> {
    const s = this.saved();
    if (!s) return Promise.reject(new TwitchSignInExpired("Connect Twitch in Settings first."));
    if (!force && s.expiresAt - Date.now() > 60_000) return Promise.resolve(s.accessToken);
    this.renewing ??= refreshTwitch(s.refreshToken)
      .then((t) => {
        if (this.saved()?.refreshToken !== s.refreshToken) throw new TwitchSignInExpired(ENDED);
        this.save({ ...t, login: s.login });
        return t.accessToken;
      })
      .catch((err) => {
        if (err instanceof TwitchSignInExpired && this.saved()?.refreshToken === s.refreshToken) this.save(null);
        throw err;
      })
      .finally(() => { this.renewing = null; });
    return this.renewing;
  }

  /** Run a request with a live token. A token Twitch turns down early (revoked, say) gets one renewal. */
  async withToken<T>(request: (accessToken: string) => Promise<T>): Promise<T> {
    try {
      return await request(await this.token());
    } catch (err) {
      if (!(err instanceof TwitchUnauthorized)) throw err;
      return request(await this.token(true));
    }
  }
}

/** A Twitch login is 4 to 25 letters, digits or underscores. */
const LOGIN = /^[a-z0-9_]{4,25}$/i;

/**
 * The Twitch channel a song's artist or link points to: "Jane (@janeplayskeys)",
 * "@janeplayskeys", or a link like twitch.tv/janeplayskeys. Empty when neither does.
 */
export function twitchLoginFrom(artist: string, link: string): string {
  const fromLink = /(?:^|\/\/|\.)twitch\.tv\/([A-Za-z0-9_]+)/i.exec(link.trim())?.[1] ?? "";
  if (LOGIN.test(fromLink)) return fromLink.toLowerCase();
  const fromArtist = /(?:^|[\s(])@([A-Za-z0-9_]+)\)?\s*$/.exec(artist.trim())?.[1] ?? "";
  return LOGIN.test(fromArtist) ? fromArtist.toLowerCase() : "";
}

/** About 160 characters fit in a bubble: the fact checker's MAX_FACT_CHARS in backend/src/fact-verifier.ts. */
export const BUBBLE_CHARS = 160;

/**
 * Their About text as fact boxes for the streamer to review: whole sentences,
 * each short enough for a bubble, at most three. Empty when there's nothing.
 */
export function factsFromAbout(description: string): string[] {
  const text = description.replace(/\s+/g, " ").trim();
  if (!text) return [];
  const sentences = text.split(/(?<=[.!?])\s+/);
  const facts: string[] = [];
  let current = "";
  for (const s of sentences) {
    if (current && (current + " " + s).length > BUBBLE_CHARS) { facts.push(current); current = ""; }
    current = current ? `${current} ${s}` : s;
  }
  if (current) facts.push(current);
  return facts.map((f) => (f.length > BUBBLE_CHARS ? `${f.slice(0, BUBBLE_CHARS - 1).replace(/\s+\S*$/, "")}…` : f)).slice(0, 3);
}
