/** Which settings are required depends on where song requests come from. */

const SAVED = { ...process.env };
const KEYS = ["SONG_SOURCE", "SSL_STREAMER_NAME", "SSL_ACCESS_TOKEN", "SE_CHANNEL", "SE_JWT", "STREAMER_DISPLAY_NAME", "AI_PROVIDER"];

function load(env: Record<string, string>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, { AI_PROVIDER: "none" }, env);
  let config: typeof import("./config").config | undefined;
  jest.isolateModules(() => {
    // dotenv never overrides what's already set, and the tests set everything they read.
    jest.doMock("dotenv", () => ({ config: () => ({}) }));
    config = require("./config").config;
  });
  return config!;
}

afterAll(() => {
  process.env = SAVED;
});

describe("config song source", () => {
  it("defaults to StreamerSongList and requires its settings", () => {
    expect(() => load({})).toThrow(/SSL_STREAMER_NAME/);
    const c = load({ SSL_STREAMER_NAME: "jane", SSL_ACCESS_TOKEN: "t" });
    expect(c).toMatchObject({ songSource: "streamersonglist", sslStreamerName: "jane", streamerDisplayName: "jane", seJwt: "" });
  });

  it("needs only the StreamElements token with SONG_SOURCE=streamelements", () => {
    expect(() => load({ SONG_SOURCE: "streamelements" })).toThrow(/SE_JWT/);
    const c = load({ SONG_SOURCE: "streamelements", SE_JWT: "jwt", SE_CHANNEL: "janeplays" });
    expect(c).toMatchObject({
      songSource: "streamelements",
      seJwt: "jwt",
      seChannel: "janeplays",
      sslAccessToken: "",
      // The channel name stands in for the streamer's name, for originals.
      sslStreamerName: "janeplays",
      streamerDisplayName: "janeplays",
    });
    expect(load({ SONG_SOURCE: "streamelements", SE_JWT: "jwt", STREAMER_DISPLAY_NAME: "Jane" }).streamerDisplayName).toBe("Jane");
  });

  it("refuses an unknown source", () => {
    expect(() => load({ SONG_SOURCE: "spotify" })).toThrow(/SONG_SOURCE must be one of/);
  });
});
