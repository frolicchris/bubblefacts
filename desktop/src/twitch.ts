/**
 * Connect Twitch (optional): lets BubbleFacts read another streamer's public
 * About text, for their originals (issue #47). Twitch's device code sign-in,
 * the flow for apps that can't keep a secret: the streamer types a short code
 * at twitch.tv/activate. No scopes: a channel's description is public, and any
 * sign-in may read it. Access tokens last 4 hours; for this kind of app each
 * refresh token works once, and lapses after 30 days unused.
 */

/** Public client ID from dev.twitch.tv (client type Public). Not a secret. */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require("../../package.json") as { bubblefacts?: { twitchClientId?: string } };
export const TWITCH_CLIENT_ID = process.env.BUBBLEFACTS_TWITCH_CLIENT_ID || pkg.bubblefacts?.twitchClientId || "";
const ID = "https://id.twitch.tv/oauth2";
const HELIX = "https://api.twitch.tv/helix";
const TIMEOUT = () => AbortSignal.timeout(15_000);

export interface TwitchSignIn {
  accessToken: string;
  refreshToken: string;
  /** Milliseconds since 1970. */
  expiresAt: number;
  login: string;
}

/** A sign-in Twitch won't renew: the streamer connects again. */
export class TwitchSignInExpired extends Error {}

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  /** The page to approve on, with the code already in it. */
  verificationUri: string;
  /** Seconds between checks, as Twitch asks. */
  interval: number;
  expiresAt: number;
}

const form = (fields: Record<string, string>) => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
  signal: TIMEOUT(),
});

export async function startDeviceCode(): Promise<DeviceCode> {
  if (!TWITCH_CLIENT_ID) throw new Error("Connecting Twitch isn't available in this version.");
  const res = await fetch(`${ID}/device`, form({ client_id: TWITCH_CLIENT_ID, scopes: "" }));
  if (!res.ok) throw new Error(`Twitch answered with an error (${res.status}). Try again in a minute.`);
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
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, interval * 1000);
      signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("Cancelled.")); }, { once: true });
    });
    const res = await fetch(`${ID}/token`, form({
      client_id: TWITCH_CLIENT_ID,
      scopes: "",
      device_code: code.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }));
    if (res.ok) return withLogin(await tokens(res));
    const message = (((await res.json().catch(() => ({}))) as { message?: string }).message ?? "").toLowerCase();
    if (message.includes("authorization_pending")) continue;
    if (message.includes("slow_down")) { interval += 5; continue; }
    throw new Error(message.includes("expired") || message.includes("invalid device code")
      ? "That code ran out. Click Connect Twitch to get a new one."
      : "Twitch didn't approve the connection. Try again.");
  }
  throw new Error("That code ran out. Click Connect Twitch to get a new one.");
}

export async function refreshTwitch(refreshToken: string): Promise<TwitchSignIn> {
  const res = await fetch(`${ID}/token`, form({ client_id: TWITCH_CLIENT_ID, grant_type: "refresh_token", refresh_token: refreshToken }));
  if (res.status === 400 || res.status === 401) throw new TwitchSignInExpired("Your Twitch connection ended. Connect Twitch again in Settings.");
  if (!res.ok) throw new Error(`Twitch answered with an error (${res.status}). Try again in a minute.`);
  return withLogin(await tokens(res));
}

async function tokens(res: Response): Promise<Omit<TwitchSignIn, "login">> {
  const b = (await res.json()) as { access_token: string; refresh_token: string; expires_in?: number };
  return { accessToken: b.access_token, refreshToken: b.refresh_token, expiresAt: Date.now() + (b.expires_in ?? 14400) * 1000 };
}

/** Which Twitch account this is, for "Connected as …". */
async function withLogin(t: Omit<TwitchSignIn, "login">): Promise<TwitchSignIn> {
  const res = await fetch(`${ID}/validate`, { headers: { Authorization: `OAuth ${t.accessToken}` }, signal: TIMEOUT() });
  const b = res.ok ? ((await res.json()) as { login?: string }) : {};
  return { ...t, login: b.login ?? "" };
}

/** On Disconnect: Twitch forgets the sign-in too. Best effort; the app forgets it either way. */
export async function revokeTwitch(accessToken: string): Promise<void> {
  if (!accessToken) return;
  await fetch(`${ID}/revoke`, form({ client_id: TWITCH_CLIENT_ID, token: accessToken })).catch(() => undefined);
}

export interface TwitchChannel {
  login: string;
  displayName: string;
  description: string;
}

export async function getChannel(login: string, accessToken: string): Promise<TwitchChannel | null> {
  const res = await fetch(`${HELIX}/users?login=${encodeURIComponent(login)}`, {
    headers: { Authorization: `Bearer ${accessToken}`, "Client-Id": TWITCH_CLIENT_ID },
    signal: TIMEOUT(),
  });
  if (res.status === 401) throw new TwitchSignInExpired("Your Twitch connection ended. Connect Twitch again in Settings.");
  if (!res.ok) throw new Error(`Twitch answered with an error (${res.status}). Try again in a minute.`);
  const u = ((await res.json()) as { data?: Array<{ login: string; display_name: string; description: string }> }).data?.[0];
  return u ? { login: u.login, displayName: u.display_name, description: u.description ?? "" } : null;
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

/** About 160 characters fit in a bubble. */
const BUBBLE_CHARS = 160;

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
