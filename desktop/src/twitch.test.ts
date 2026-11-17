process.env.BUBBLEFACTS_TWITCH_CLIENT_ID = "test-client";

import fs from "fs";
import path from "path";
import { answerAbout, BUBBLE_CHARS, factsFromAbout, finishDeviceCode, getCategory, getChannel, refreshTwitch, startDeviceCode, TwitchSession, TwitchSignIn, TwitchSignInExpired, twitchLoginFrom } from "./twitch";

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

describe("answerAbout", () => {
  const channel = { id: "101", login: "marlowkeys", displayName: "MarlowKeys", description: "Marlow writes piano loops." };

  it("asks Twitch nothing until connected and checked", async () => {
    const read = jest.fn();
    expect((await answerAbout("marlowkeys", 135, false, read)).state).toBe("off");
    expect(read).not.toHaveBeenCalled();
  });

  it("answers with the channel's name and its About, cut to the room left", async () => {
    const answer = await answerAbout("marlowkeys", 20, true, async () => channel);
    expect(answer).toMatchObject({ state: "found", name: "MarlowKeys", category: "" });
    expect(await answerAbout("marlowkeys", 135, true, async () => ({ ...channel, category: "Music" }))).toMatchObject({ category: "Music" });
    expect((answer.facts as string[])[0].length).toBeLessThanOrEqual(20);
  });

  it("abstains on no channel, an empty About or a bad login, and a failure is only a failure", async () => {
    expect((await answerAbout("marlowkeys", 135, true, async () => null)).state).toBe("none");
    expect((await answerAbout("marlowkeys", 135, true, async () => ({ ...channel, description: "  " }))).state).toBe("none");
    const read = jest.fn();
    expect((await answerAbout("not a login", 135, true, read)).state).toBe("none");
    expect(read).not.toHaveBeenCalled();
    expect((await answerAbout("marlowkeys", 135, true, async () => { throw new TwitchSignInExpired("ended"); })).state).toBe("failed");
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
      .mockResolvedValueOnce(json(200, { login: "janeplayskeys" }));
    const code = await startDeviceCode();
    expect(code.userCode).toBe("ABCD-EFGH");
    const done = finishDeviceCode(code);
    await jest.advanceTimersByTimeAsync(2500);
    await expect(done).resolves.toMatchObject({ accessToken: "at", refreshToken: "rt", login: "janeplayskeys" });
    // No client secret is ever sent: the app is a public client
    for (const [, init] of mockFetch.mock.calls) expect(String(init?.body ?? "")).not.toMatch(/client_secret/);
    jest.useRealTimers();
  });

  it("stops at once when cancelled, and never signs in after", async () => {
    const stop = new AbortController();
    mockFetch.mockResolvedValue(json(200, { access_token: "at", refresh_token: "rt" }));
    const done = finishDeviceCode({ deviceCode: "d", userCode: "u", verificationUri: "", interval: 1, expiresAt: Date.now() + 60_000 }, stop.signal);
    stop.abort();
    await expect(done).rejects.toThrow(/abort/i);
    expect(mockFetch).not.toHaveBeenCalled();
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
    mockFetch.mockResolvedValueOnce(json(200, { data: [{ id: "101", login: "janeplayskeys", display_name: "JanePlaysKeys", description: "Pianist." }] }));
    await expect(getChannel("janeplayskeys", "at")).resolves.toEqual({ id: "101", login: "janeplayskeys", displayName: "JanePlaysKeys", description: "Pianist." });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("users?login=janeplayskeys");
    expect(init.headers).toMatchObject({ Authorization: "Bearer at", "Client-Id": "test-client" });
  });

  it("reads the category a channel last streamed in, and any trouble is only \"unknown\"", async () => {
    mockFetch.mockResolvedValueOnce(json(200, { data: [{ broadcaster_id: "101", game_name: "Music" }] }));
    await expect(getCategory("101", "at")).resolves.toBe("Music");
    expect(mockFetch.mock.calls[0][0]).toContain("channels?broadcaster_id=101");
    mockFetch.mockResolvedValueOnce(json(500, {}));
    await expect(getCategory("101", "at")).resolves.toBe("");
    mockFetch.mockRejectedValueOnce(new Error("offline"));
    await expect(getCategory("101", "at")).resolves.toBe("");
    mockFetch.mockResolvedValueOnce(json(401, {}));
    await expect(getCategory("101", "at")).rejects.toThrow("Connect Twitch again");
  });

  it("returns nothing for a channel that doesn't exist", async () => {
    mockFetch.mockResolvedValueOnce(json(200, { data: [] }));
    await expect(getChannel("nobodyhere", "at")).resolves.toBeNull();
  });
});

describe("TwitchSession", () => {
  const expired: TwitchSignIn = { accessToken: "old-at", refreshToken: "rt-1", expiresAt: Date.now() - 1000, login: "janeplayskeys" };
  const store = (start: TwitchSignIn | null) => {
    let saved = start;
    const session = new TwitchSession(() => saved, (t) => { saved = t; });
    return { session, get: () => saved };
  };

  it("renews once for two requests at the same moment: each refresh token works once", async () => {
    const { session, get } = store(expired);
    mockFetch.mockResolvedValueOnce(json(200, { access_token: "new-at", refresh_token: "rt-2", expires_in: 14400 }));
    await expect(Promise.all([session.token(), session.token()])).resolves.toEqual(["new-at", "new-at"]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(get()).toMatchObject({ accessToken: "new-at", refreshToken: "rt-2", login: "janeplayskeys" });
  });

  it("never saves a renewal that finishes after Disconnect", async () => {
    const { session, get } = store(expired);
    let finish: (v: unknown) => void = () => undefined;
    mockFetch.mockReturnValueOnce(new Promise((r) => { finish = r; }));
    const renewing = session.token();
    mockFetch.mockResolvedValue(json(200, {})); // the revoke during Disconnect
    const out = session.disconnect();
    finish(json(200, { access_token: "late-at", refresh_token: "late-rt" }));
    await expect(renewing).rejects.toBeInstanceOf(TwitchSignInExpired);
    await out;
    expect(get()).toBeNull();
  });

  it("renews once and retries when Twitch turns a token down early", async () => {
    const live: TwitchSignIn = { ...expired, expiresAt: Date.now() + 3_600_000 };
    const { session } = store(live);
    mockFetch
      .mockResolvedValueOnce(json(401, {}))
      .mockResolvedValueOnce(json(200, { access_token: "new-at", refresh_token: "rt-2" }))
      .mockResolvedValueOnce(json(200, { data: [{ login: "janeplayskeys", display_name: "JanePlaysKeys", description: "Pianist." }] }));
    await expect(session.withToken((t) => getChannel("janeplayskeys", t))).resolves.toMatchObject({ description: "Pianist." });
  });

  it("flags a connection that ended by itself, and not one the streamer disconnected", async () => {
    const { session, get } = store(expired);
    expect(session.ended).toBe(false);
    mockFetch.mockResolvedValueOnce(json(400, {}));
    await expect(session.token()).rejects.toBeInstanceOf(TwitchSignInExpired);
    expect(get()).toBeNull();
    expect(session.ended).toBe(true);
    const chosen = store(expired);
    mockFetch.mockResolvedValue(json(200, {}));
    await chosen.session.disconnect();
    expect(chosen.session.ended).toBe(false);
    await session.disconnect();
    expect(session.ended).toBe(false);
  });

  it("forgets an ended connection when the streamer turns Twitch About off, with no reconnect", async () => {
    let saved: TwitchSignIn | null = expired;
    let flag = false;
    const make = () => new TwitchSession(() => saved, (t) => { saved = t; }, undefined, { get: () => flag, set: (v) => { flag = v; } });
    mockFetch.mockResolvedValueOnce(json(400, {}));
    await expect(make().token()).rejects.toBeInstanceOf(TwitchSignInExpired);
    expect(make().ended).toBe(true);
    make().forgetEnded();
    expect(make().ended).toBe(false);
    expect(flag).toBe(false);
    expect(saved).toBeNull();
  });

  it("remembers an ended connection across a restart until Twitch is connected again or disconnected", async () => {
    let saved: TwitchSignIn | null = expired;
    let flag = false; // stands in for the settings file
    const make = () => new TwitchSession(() => saved, (t) => { saved = t; }, undefined, { get: () => flag, set: (v) => { flag = v; } });
    mockFetch.mockResolvedValueOnce(json(400, {}));
    await expect(make().token()).rejects.toBeInstanceOf(TwitchSignInExpired);
    expect(make().ended).toBe(true); // a new session, as after a restart
    // Disconnect clears it
    mockFetch.mockResolvedValue(json(200, {}));
    await make().disconnect();
    expect(make().ended).toBe(false);
    // Connecting clears it
    flag = true;
    mockFetch
      .mockResolvedValueOnce(json(200, { device_code: "d", user_code: "ABCD", verification_uri: "https://twitch.tv/activate", interval: 1, expires_in: 60 }))
      .mockResolvedValueOnce(json(200, { access_token: "at", refresh_token: "rt", expires_in: 14400 }))
      .mockResolvedValueOnce(json(200, { data: [{ login: "janeplayskeys" }] }));
    const connected = new Promise<void>((done) => { void make().connect(() => undefined, done); });
    await connected;
    expect(flag).toBe(false);
  });

  it("keeps the bubble length the same as the fact checker's", () => {
    const verifier = fs.readFileSync(path.join(__dirname, "../../backend/src/fact-limits.ts"), "utf8");
    expect(Number(/const MAX_FACT_CHARS = (\d+)/.exec(verifier)?.[1])).toBe(BUBBLE_CHARS);
  });
});
