import crypto from "crypto";
import http from "http";

process.env.BUBBLEFACTS_SSL_CLIENT_ID = "client-1";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { refresh, signIn, SignInExpired } = require("./signin") as typeof import("./signin");

/** The browser coming back to the app. Plain http, since fetch is mocked below. */
function visit(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve(body));
    }).on("error", reject);
  });
}

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

afterEach(() => mockFetch.mockReset());

describe("signIn", () => {
  it("runs the PKCE flow, ignores a stray callback, and finds the channel", async () => {
    mockFetch
      .mockResolvedValueOnce(json(200, { access_token: "a1", refresh_token: "r1", expires_in: 3600 }))
      .mockResolvedValueOnce(json(200, { username: "jane", streamer_id: 42 }));

    let authUrl = "";
    const result = await signIn((url) => {
      authUrl = url;
      const state = new URL(url).searchParams.get("state");
      void (async () => {
        const stray = await visit("http://127.0.0.1:53682/callback?state=forged&code=evil");
        expect(stray).toContain("Something went wrong");
        await visit(`http://127.0.0.1:53682/callback?state=${state}&code=c1`);
      })();
    });

    expect(result).toMatchObject({ accessToken: "a1", refreshToken: "r1", channel: "jane", streamerId: 42 });
    expect(result.expiresAt).toBeGreaterThan(Date.now() + 3500_000);

    const auth = new URL(authUrl).searchParams;
    expect(auth.get("client_id")).toBe("client-1");
    expect(auth.get("code_challenge_method")).toBe("S256");
    expect(auth.get("scope")).toContain("offline_access");

    const body = new URLSearchParams(mockFetch.mock.calls[0][1].body as URLSearchParams);
    expect(body.get("code")).toBe("c1");
    expect(body.get("grant_type")).toBe("authorization_code");
    const challenge = crypto.createHash("sha256").update(body.get("code_verifier") ?? "").digest("base64url");
    expect(challenge).toBe(auth.get("code_challenge"));

    const [validateUrl, validate] = mockFetch.mock.calls[1];
    expect(validateUrl).toContain("/oauth2/validate");
    expect(validate.headers).toMatchObject({ Authorization: "Bearer a1", "Client-Id": "client-1" });
  });

  it("reports a canceled sign-in plainly", async () => {
    await expect(
      signIn((url) => {
        const state = new URL(url).searchParams.get("state");
        void visit(`http://127.0.0.1:53682/callback?state=${state}&error=access_denied`);
      })
    ).rejects.toThrow("Sign-in was canceled.");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("explains an account with no channel", async () => {
    mockFetch
      .mockResolvedValueOnce(json(200, { access_token: "a1", refresh_token: "r1", expires_in: 3600 }))
      .mockResolvedValueOnce(json(200, { username: "viewer" }));
    await expect(
      signIn((url) => {
        const state = new URL(url).searchParams.get("state");
        void visit(`http://127.0.0.1:53682/callback?state=${state}&code=c1`);
      })
    ).rejects.toThrow(/doesn't have a channel/);
  });

  it("stops waiting when the app cancels", async () => {
    const abort = new AbortController();
    const pending = signIn(() => abort.abort(), abort.signal);
    await expect(pending).rejects.toThrow("Sign-in was canceled.");
  });
});

describe("refresh", () => {
  it("returns the rotated tokens", async () => {
    mockFetch.mockResolvedValueOnce(json(200, { access_token: "a2", refresh_token: "r2", expires_in: 3600 }));
    await expect(refresh("r1")).resolves.toMatchObject({ accessToken: "a2", refreshToken: "r2" });
    const body = new URLSearchParams(mockFetch.mock.calls[0][1].body as URLSearchParams);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("r1");
  });

  it("says when the musician has to sign in again", async () => {
    mockFetch.mockResolvedValueOnce(json(400, { error: "invalid_grant" }));
    await expect(refresh("r1")).rejects.toBeInstanceOf(SignInExpired);
  });

  it("treats a network failure as temporary", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    const err = await refresh("r1").catch((e) => e);
    expect(err).not.toBeInstanceOf(SignInExpired);
    expect(err.message).toMatch(/internet connection/);
  });
});
