import crypto from "crypto";
import http from "http";

/**
 * "Sign in with StreamerSongList": OAuth 2 authorization code with PKCE, the
 * flow for apps that can't keep a secret. The browser returns to a small
 * one-time server on this computer. Access tokens last an hour; the app
 * refreshes them, and each refresh hands back a new refresh token.
 */

/**
 * Public client ID from dev.streamersonglist.com, kept in package.json under
 * "bubblefacts". Not a secret: apps that can't keep one use PKCE instead.
 * Empty until the app is registered, which hides the sign-in button.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require("../../package.json") as { bubblefacts?: { sslClientId?: string } };
export const CLIENT_ID = process.env.BUBBLEFACTS_SSL_CLIENT_ID || pkg.bubblefacts?.sslClientId || "";
const ID_BASE = "https://id.streamersonglist.com";
const API_BASE = "https://api.streamersonglist.com";
/** Must match the redirect URI registered for the app exactly. */
export const REDIRECT_PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
const SCOPES = "openid offline_access streamer.queue.read streamer.settings.read";
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

export interface SignIn {
  accessToken: string;
  refreshToken: string;
  /** Milliseconds since 1970. */
  expiresAt: number;
  channel: string;
  streamerId: number;
}

/** A refresh StreamerSongList turned down for good: the musician has to sign in again. */
export class SignInExpired extends Error {}

const base64url = (b: Buffer) => b.toString("base64url");

const PAGE = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:17px -apple-system,Segoe UI,sans-serif;background:#0b0d1f;color:#eef0ff;display:grid;place-items:center;height:90vh;text-align:center">` +
  `<div><h1 style="color:#ffd700">${title}</h1><p>${body}</p></div>`;

/** Open the StreamerSongList sign-in page and wait for the musician to finish. */
export async function signIn(openBrowser: (url: string) => void, signal?: AbortSignal): Promise<SignIn> {
  if (!CLIENT_ID) throw new Error("Sign-in isn't available in this version. Paste a token instead.");
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  const state = base64url(crypto.randomBytes(16));

  const code = await new Promise<string>((resolve, reject) => {
    const finish = (err: Error | null, value = "") => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // A browser that kept its connection open would otherwise reach this finished server on the next sign-in.
      server.close();
      server.closeIdleConnections();
      if (err) reject(err);
      else resolve(value);
    };
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", REDIRECT_URI);
      if (url.pathname !== "/callback") {
        res.writeHead(404, { Connection: "close" }).end();
        return;
      }
      const error = url.searchParams.get("error");
      const got = url.searchParams.get("code");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", Connection: "close" });
      if (url.searchParams.get("state") !== state) {
        res.end(PAGE("Something went wrong", "Go back to BubbleFacts and click Sign in again."));
        return; // A stray or forged request: keep waiting for the real one.
      }
      if (error || !got) {
        res.end(PAGE("Sign-in canceled", "Go back to BubbleFacts to try again."));
        finish(new Error(error === "access_denied" ? "Sign-in was canceled." : "StreamerSongList didn't finish the sign-in."));
        return;
      }
      res.end(PAGE("You're signed in", "You can close this tab and go back to BubbleFacts."));
      finish(null, got);
    });
    const timer = setTimeout(() => finish(new Error("Sign-in timed out. Click Sign in to try again.")), SIGN_IN_TIMEOUT_MS);
    const onAbort = () => finish(new Error("Sign-in was canceled."));
    signal?.addEventListener("abort", onAbort);
    server.on("error", (err: NodeJS.ErrnoException) =>
      finish(new Error(err.code === "EADDRINUSE"
        ? "Another sign-in is already open. Finish or close it, then try again."
        : "Couldn't start the sign-in. Try again."))
    );
    server.listen(REDIRECT_PORT, "127.0.0.1", () => {
      const q = new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: "code",
        redirect_uri: REDIRECT_URI,
        scope: SCOPES,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      openBrowser(`${ID_BASE}/oauth2/auth?${q}`);
    });
  });

  const tokens = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: verifier });
  const who = await whoIs(tokens.accessToken);
  return { ...tokens, ...who };
}

/** Swap the refresh token for new tokens. Persist the result at once: the old refresh token stops working. */
export async function refresh(refreshToken: string): Promise<Pick<SignIn, "accessToken" | "refreshToken" | "expiresAt">> {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
}

async function tokenRequest(params: Record<string, string>) {
  let res: Response;
  try {
    res = await fetch(`${ID_BASE}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ client_id: CLIENT_ID, ...params }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Couldn't reach StreamerSongList. Check your internet connection.");
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    if (body.error === "invalid_grant" || body.error === "invalid_client") {
      throw new SignInExpired("Your StreamerSongList sign-in has ended. Sign in again.");
    }
    throw new Error(`StreamerSongList answered with an error (${res.status}). Try again in a minute.`);
  }
  if (typeof body.access_token !== "string" || typeof body.refresh_token !== "string") {
    throw new Error("StreamerSongList sent an incomplete sign-in. Try again.");
  }
  const lifetime = typeof body.expires_in === "number" ? body.expires_in : 3600;
  return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: Date.now() + lifetime * 1000 };
}

/** Which channel the token reaches. */
async function whoIs(accessToken: string): Promise<Pick<SignIn, "channel" | "streamerId">> {
  const res = await fetch(`${API_BASE}/oauth2/validate`, {
    headers: { Authorization: `Bearer ${accessToken}`, "Client-Id": CLIENT_ID, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`StreamerSongList answered with an error (${res.status}). Try again in a minute.`);
  const body = (await res.json()) as { username?: string; streamer_id?: number };
  if (!body.streamer_id) {
    throw new Error("That StreamerSongList account doesn't have a channel yet. Set one up at streamersonglist.com first.");
  }
  return { channel: body.username || "", streamerId: body.streamer_id };
}
