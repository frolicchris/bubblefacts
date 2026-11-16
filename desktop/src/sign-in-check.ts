import { CLIENT_ID } from "./signin";

// Asks StreamerSongList whether the app's own sign-in holds (#182), telling "down or slow" from "expired"
// Unconfirmed response, read defensively: only 401 is expired (ARCHITECTURE.md: Checking the sign-in)

export const VALIDATE_URL = "https://id.streamersonglist.com/oauth2/validate";
// ms: long enough for a slow answer, short enough that a hung one holds nothing up
const VALIDATE_TIMEOUT_MS = 10_000;
/** ms between checks for a failing queue; rare, as StreamerSongList's rate limits police sensible use */
export const RECHECK_MS = 5 * 60_000;

export type TokenCheck = "valid" | "expired" | "unknown";

/** What StreamerSongList says about an access token; never logs or returns it */
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

/** Why a check is asked for */
export type CheckReason = "start" | "refresh" | "queue";

export interface SignInCheckDeps {
  validate: (token: string) => Promise<TokenCheck>;
  /** Swap the refresh token for a new access token; shows "sign in again" when that fails for good */
  refresh: () => Promise<void>;
  log: (line: string) => void;
  /** true: StreamerSongList is down or slow but the sign-in holds; false: no longer known */
  songListDown: (down: boolean) => void;
  now?: () => number;
}

/**
 * When to ask and what an answer leads to. Expired means refresh first (the refresh token may still be good);
 * expired right after a refresh means the endpoint can't tell our tokens apart: stop asking this session
 */
export class SignInCheck {
  private lastQueueCheck = 0;
  private lastToken = "";
  private trusted = true;
  private running: Promise<void> | null = null;

  constructor(private readonly deps: SignInCheckDeps) {}

  /** Checks `token`; queue checks at most once per RECHECK_MS per token, one at a time */
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
