import { CLIENT_ID } from "./signin";

/**
 * Asking StreamerSongList whether the app's sign-in still holds (issue #182),
 * so "StreamerSongList is down or slow" can be told from "your sign-in
 * expired" without waiting for a queue request to fail.
 *
 * GET https://id.streamersonglist.com/oauth2/validate, announced in
 * StreamerSongList's 2026-09-22 changelog ("For integrators"). Its response
 * couldn't be checked from where this was written (see docs/ARCHITECTURE.md,
 * "Checking the sign-in"), so it is read defensively: only a plain 401 means
 * expired, a 200 with a JSON object means the sign-in holds, and anything
 * else (no answer, a timeout, 5xx, another shape) means "can't tell", which
 * changes nothing. Only the app's own sign-in is checked: a pasted Streamer or
 * User token was never issued by id.streamersonglist.com.
 */

export const VALIDATE_URL = "https://id.streamersonglist.com/oauth2/validate";
/** Long enough for a slow answer, short enough that a hung one doesn't hold anything up. */
const VALIDATE_TIMEOUT_MS = 10_000;
/**
 * At most one check this often for a failing queue. StreamerSongList's rate
 * limits mostly enforce sensible use, so the app asks rarely: at start, after
 * each refresh, and when the queue keeps failing, once per this long.
 */
export const RECHECK_MS = 5 * 60_000;

export type TokenCheck = "valid" | "expired" | "unknown";

/** What StreamerSongList says about an access token. Never logs or returns the token. */
export async function validateToken(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<TokenCheck> {
  let res: Response;
  try {
    res = await fetchImpl(VALIDATE_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, ...(CLIENT_ID ? { "Client-Id": CLIENT_ID } : {}), Accept: "application/json" },
      signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
    });
  } catch {
    return "unknown";
  }
  if (res.status === 401) return "expired";
  if (res.status !== 200) return "unknown";
  const body = (await Promise.resolve().then(() => res.json()).catch(() => null)) as unknown;
  return body !== null && typeof body === "object" && !Array.isArray(body) ? "valid" : "unknown";
}

/** Why a check is asked for. */
export type CheckReason = "start" | "refresh" | "queue";

export interface SignInCheckDeps {
  validate: (token: string) => Promise<TokenCheck>;
  /** Swap the refresh token for a new access token; the refresh shows the "sign in again" notice when that fails for good. */
  refresh: () => Promise<void>;
  log: (line: string) => void;
  /** StreamerSongList is down or slow, but the sign-in holds (true), or that's no longer known (false). */
  songListDown: (down: boolean) => void;
  now?: () => number;
}

/**
 * When to ask, and what an answer leads to. A 401 for the access token is
 * fixed by a refresh, not by asking the musician: the refresh token may still
 * be good (a computer that slept past the hour, say). When the refresh token
 * is gone too, the refresh itself shows "Sign in to StreamerSongList again".
 * A 401 again right after a refresh means the endpoint isn't telling this
 * app's tokens apart: it's not asked again this session, and the queue
 * decides, as before.
 */
export class SignInCheck {
  private lastQueueCheck = 0;
  private lastToken = "";
  private trusted = true;
  private running: Promise<void> | null = null;

  constructor(private readonly deps: SignInCheckDeps) {}

  /** Checks `token`; queue checks at most once per RECHECK_MS for the same token, one at a time. */
  check(reason: CheckReason, token: string): Promise<void> {
    if (!this.trusted || !token) return Promise.resolve();
    const now = (this.deps.now ?? Date.now)();
    if (reason === "queue") {
      if (this.running || (token === this.lastToken && now - this.lastQueueCheck < RECHECK_MS)) return this.running ?? Promise.resolve();
      this.lastQueueCheck = now;
    }
    this.lastToken = token;
    const run = this.run(reason, token).finally(() => {
      if (this.running === run) this.running = null;
    });
    this.running = run;
    return run;
  }

  private async run(reason: CheckReason, token: string): Promise<void> {
    const result = await this.deps.validate(token);
    this.deps.log(`[App] StreamerSongList sign-in check (${reason}): ${result === "valid" ? "still signed in" : result === "expired" ? "expired" : "can't tell"}`);
    this.deps.songListDown(reason === "queue" && result === "valid");
    if (result !== "expired") return;
    if (reason === "refresh") {
      this.trusted = false;
      this.deps.log("[App] A just-refreshed sign-in was called expired: not checking again this session; the queue decides");
      return;
    }
    await this.deps.refresh();
  }
}
