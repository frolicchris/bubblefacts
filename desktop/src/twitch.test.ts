process.env.BUBBLEFACTS_TWITCH_CLIENT_ID = "test-client";

import { factsFromAbout, finishDeviceCode, getChannel, refreshTwitch, startDeviceCode, TwitchSignInExpired, twitchLoginFrom } from "./twitch";

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;
afterEach(() => mockFetch.mockReset());
const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });

describe("twitchLoginFrom", () => {
  it("finds the channel in the link or a handle in the artist field", () => {
    expect(twitchLoginFrom("", "twitch.tv/JanePlaysKeys")).toBe("janeplayskeys");
    expect(twitchLoginFrom("", "https://www.twitch.tv/janeplayskeys/about")).toBe("janeplayskeys");
    expect(twitchLoginFrom("Jane (@janeplayskeys)", "")).toBe("janeplayskeys");
    expect(twitchLoginFrom("@janeplayskeys", "")).toBe("janeplayskeys");
  });

  it("finds nothing in an ordinary artist or another site's link", () => {
    expect(twitchLoginFrom("Jane Composer", "")).toBe("");
    expect(twitchLoginFrom("Final Fantasy VI", "youtube.com/@janeplayskeys")).toBe("");
    expect(twitchLoginFrom("@abc", "")).toBe(""); // too short for a Twitch login
  });
});

describe("factsFromAbout", () => {
  it("keeps whole sentences, each short enough for a bubble, at most three", () => {
    const about = "Pianist from Lisbon. I play video game music and my own pieces. " +
      "Streaming since 2019, every Tuesday and Thursday night, with requests from chat all evening long. " +
      "Sheet music on my website. Thanks for stopping by! Business inquiries by email only.";
    const facts = factsFromAbout(about);
    expect(facts.length).toBeLessThanOrEqual(3);
    expect(facts[0]).toBe("Pianist from Lisbon. I play video game music and my own pieces.");
    for (const f of facts) expect(f.length).toBeLessThanOrEqual(160);
  });

  it("gives nothing for an empty About", () => {
    expect(factsFromAbout("   ")).toEqual([]);
  });

  it("shortens one very long sentence at a word", () => {
    const [f] = factsFromAbout("word ".repeat(60).trim());
    expect(f.endsWith("…")).toBe(true);
    expect(f.length).toBeLessThanOrEqual(160);
  });
});

describe("the device code sign-in", () => {
  it("starts, waits while Twitch says it's pending, then signs in", async () => {
    jest.useFakeTimers();
    mockFetch
      .mockResolvedValueOnce(json(200, { device_code: "dev", user_code: "ABCD-EFGH", verification_uri: "https://www.twitch.tv/activate?device-code=ABCD-EFGH", interval: 1, expires_in: 60 }))
      .mockResolvedValueOnce(json(400, { status: 400, message: "authorization_pending" }))
      .mockResolvedValueOnce(json(200, { access_token: "at", refresh_token: "rt", expires_in: 14400 }))
      .mockResolvedValueOnce(json(200, { login: "frolicchris" }));
    const code = await startDeviceCode();
    expect(code.userCode).toBe("ABCD-EFGH");
    const done = finishDeviceCode(code);
    await jest.advanceTimersByTimeAsync(2500);
    await expect(done).resolves.toMatchObject({ accessToken: "at", refreshToken: "rt", login: "frolicchris" });
    // No client secret is ever sent: the app is a public client.
    for (const [, init] of mockFetch.mock.calls) expect(String(init?.body ?? "")).not.toMatch(/client_secret/);
    jest.useRealTimers();
  });

  it("says the code ran out when Twitch does", async () => {
    jest.useFakeTimers();
    mockFetch.mockResolvedValueOnce(json(400, { status: 400, message: "invalid device code" }));
    const done = finishDeviceCode({ deviceCode: "d", userCode: "u", verificationUri: "", interval: 1, expiresAt: Date.now() + 60_000 });
    const check = expect(done).rejects.toThrow(/ran out/);
    await jest.advanceTimersByTimeAsync(1500);
    await check;
    jest.useRealTimers();
  });
});

describe("renewing and reading a channel", () => {
  it("asks for a new connection when Twitch won't renew", async () => {
    mockFetch.mockResolvedValueOnce(json(400, { status: 400, message: "Invalid refresh token" }));
    await expect(refreshTwitch("old")).rejects.toBeInstanceOf(TwitchSignInExpired);
  });

  it("reads a channel's About with the app's client ID", async () => {
    mockFetch.mockResolvedValueOnce(json(200, { data: [{ login: "janeplayskeys", display_name: "JanePlaysKeys", description: "Pianist." }] }));
    await expect(getChannel("janeplayskeys", "at")).resolves.toEqual({ login: "janeplayskeys", displayName: "JanePlaysKeys", description: "Pianist." });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("users?login=janeplayskeys");
    expect(init.headers).toMatchObject({ Authorization: "Bearer at", "Client-Id": "test-client" });
  });

  it("returns nothing for a channel that doesn't exist", async () => {
    mockFetch.mockResolvedValueOnce(json(200, { data: [] }));
    await expect(getChannel("nobodyhere", "at")).resolves.toBeNull();
  });
});
