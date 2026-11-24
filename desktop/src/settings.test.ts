import fs from "fs";
import os from "os";
import path from "path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bubblefacts-settings-"));
const keychain = { available: true, broken: false };
const running = { version: "2.0.0" };

jest.mock("electron", () => ({
  app: { getPath: () => dir, getVersion: () => running.version },
  safeStorage: {
    isEncryptionAvailable: () => keychain.available,
    encryptString: (s: string) => Buffer.from("x" + s),
    decryptString: (b: Buffer) => {
      if (keychain.broken) throw new Error("keychain changed");
      return b.toString().slice(1);
    },
  },
}));

import { checkStyleLook, readStyleFile } from "./style-file";
import { customFactsProblem, EDITABLE, ENUM_KEYS, shareUrlProblem, DEFAULTS, Settings, fromWindow, loadSettings, secretsUnprotected, secretsWaiting, unlockSecrets, sanitize, saveSettings, secretsOf, songSourceReady, styleEnv, topicList, toServerEnv, writeMyPack, serverSettingsSignature, styleFileName, styleFileOf, VERTICAL_BUBBLE_SCALE } from "./settings";

const file = path.join(dir, "settings.json");
const paths = { modelsDir: "/models", logDir: "/logs", topicsDir: "/facts", clientId: "client-1" };

afterEach(() => {
  keychain.available = true;
  keychain.broken = false;
  running.version = "2.0.0";
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("toServerEnv documents folder", () => {
  it("passes the system's Documents folder to the server when the app knows it", () => {
    expect(toServerEnv(DEFAULTS, { ...paths, documentsDir: "/Redirected/Documents" }).BUBBLEFACTS_DOCUMENTS_DIR).toBe("/Redirected/Documents");
    expect(toServerEnv(DEFAULTS, paths)).not.toHaveProperty("BUBBLEFACTS_DOCUMENTS_DIR");
  });
});

describe("loadSettings", () => {
  it("starts from the defaults on first run", () => {
    expect(loadSettings()).toEqual(DEFAULTS);
  });

  it("checks Twitch for unknown artists by default, and the box never restarts the server", () => {
    expect(DEFAULTS.twitchAbout).toBe(true);
    expect(fromWindow({ twitchAbout: false })).toEqual({ twitchAbout: false });
    expect(toServerEnv({ ...DEFAULTS, twitchAbout: false }, paths)).toEqual(toServerEnv(DEFAULTS, paths));
  });

  it("round-trips, keeping secrets encrypted on disk", () => {
    saveSettings({ ...DEFAULTS, channel: "jane", token: "secret-token", refreshToken: "refresh-1" });
    const disk = fs.readFileSync(file, "utf8");
    expect(disk).not.toContain("secret-token");
    expect(disk).not.toContain("refresh-1");
    expect(loadSettings()).toMatchObject({ channel: "jane", token: "secret-token", refreshToken: "refresh-1" });
  });

  it("keeps settings a newer version saved, and drops retired ones", () => {
    fs.writeFileSync(file, JSON.stringify({ channel: "jane", fromAFutureVersion: "kept", topics: ["general"], settingsVersion: 2 }));
    saveSettings({ ...loadSettings(), displayName: "Jane Composer" });
    const disk = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(disk).toMatchObject({ channel: "jane", displayName: "Jane Composer", fromAFutureVersion: "kept", settingsVersion: 2 });
    expect(disk).not.toHaveProperty("topics");
  });

  it("lists every setting held to a list of values, so going back a version keeps a newer choice for each", () => {
    const source = fs.readFileSync(path.join(__dirname, "settings.ts"), "utf8");
    const held = [...source.matchAll(/^\s+(\w+): oneOf\(s\.\1,/gm)].map((m) => m[1]);
    expect(held.length).toBeGreaterThan(5);
    expect([...ENUM_KEYS].sort()).toEqual([...new Set(held)].sort());
  });

  it("keeps a choice only a newer version knows, using a safe default meanwhile", () => {
    fs.writeFileSync(file, JSON.stringify({ channel: "jane", ai: "gemini-next", bubbleSize: "huge", settingsVersion: 2 }));
    const loaded = loadSettings();
    expect(loaded).toMatchObject({ ai: "builtin", bubbleSize: "standard" });
    saveSettings({ ...loaded, displayName: "Jane Composer" });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ ai: "gemini-next", bubbleSize: "huge", displayName: "Jane Composer" });
    // Choosing something else in Settings replaces it
    saveSettings({ ...loaded, ai: "groq" });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ ai: "groq", bubbleSize: "huge" });
  });

  it("loads a settings file from an early 2.0 beta without losing anything it had", () => {
    // Saved by 2.0.0-beta.3: no song source, no update channel, no newer settings
    fs.writeFileSync(file, JSON.stringify({ setupComplete: true, channel: "jane", displayName: "Jane Composer", myFacts: ["I play by ear."], factsPerSong: 4, port: 3000, topics: ["video-game"] }));
    const s = loadSettings();
    expect(s).toMatchObject({ setupComplete: true, channel: "jane", displayName: "Jane Composer", myFacts: ["I play by ear."], factsPerSong: 4, songSource: "streamersonglist" });
    expect(["stable", "beta"]).toContain(s.updateChannel);
    saveSettings(s);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).settingsVersion).toBe(1);
  });

  it("keeps the StreamElements token encrypted on disk too", () => {
    saveSettings({ ...DEFAULTS, songSource: "streamelements", seChannel: "janeplays", seJwt: "eyJhbGciOi.secret-jwt" });
    const disk = fs.readFileSync(file, "utf8");
    expect(disk).not.toContain("secret-jwt");
    expect(loadSettings()).toMatchObject({ songSource: "streamelements", seChannel: "janeplays", seJwt: "eyJhbGciOi.secret-jwt" });
  });

  it("falls back to plain storage where there's no keychain", () => {
    keychain.available = false;
    saveSettings({ ...DEFAULTS, token: "secret-token" });
    expect(loadSettings().token).toBe("secret-token");
  });

  it("keeps the rest of the settings when a secret can't be decrypted", () => {
    saveSettings({ ...DEFAULTS, setupComplete: true, channel: "jane", token: "secret-token" });
    keychain.broken = true;
    const s = loadSettings();
    expect(s).toMatchObject({ setupComplete: true, channel: "jane", token: "" });
  });

  it("fills in settings added since an older version", () => {
    fs.writeFileSync(file, JSON.stringify({ setupComplete: true, channel: "jane", tokenKind: "streamer" }));
    const s = loadSettings();
    expect(s).toMatchObject({ setupComplete: true, channel: "jane", tokenKind: "streamer", myFacts: [], liveLearns: true });
  });

  it("loads a file with or without the retired instrument setting, and never sends it to the server", () => {
    fs.writeFileSync(file, JSON.stringify({ setupComplete: true, channel: "jane", displayName: "Jane Composer" }));
    expect(loadSettings()).toMatchObject({ setupComplete: true, channel: "jane", displayName: "Jane Composer" });
    fs.writeFileSync(file, JSON.stringify({ setupComplete: true, channel: "jane", instrument: "kazoo" }));
    const s = loadSettings();
    expect(s).toMatchObject({ setupComplete: true, channel: "jane" });
    expect(s).not.toHaveProperty("instrument");
    expect(toServerEnv(s, paths)).not.toHaveProperty("INSTRUMENT");
  });

  it("ignores example packs an older version saved, and keeps the musician's own facts", () => {
    fs.writeFileSync(file, JSON.stringify({ songSource: "streamersonglist", topics: ["video-game", "piano"], myFacts: ["I've played since I was six."] }));
    const s = loadSettings();
    expect(s).not.toHaveProperty("topics");
    expect(s.myFacts).toEqual(["I've played since I was six."]);
    expect(toServerEnv(s, paths).TOPIC).toBe("my-facts");
    saveSettings(s);
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(saved).not.toHaveProperty("topics");
    expect(saved.myFacts).toEqual(["I've played since I was six."]);
  });

  it("never takes example packs from the window", () => {
    expect(fromWindow({ topics: ["video-game"], myFacts: ["Mine."] })).toEqual({ myFacts: ["Mine."] });
  });

  it("replaces values of the wrong type with the default", () => {
    fs.writeFileSync(file, JSON.stringify({ channel: 42, myFacts: [1, 2], port: "3000", liveLearns: false }));
    const s = loadSettings();
    expect(s).toMatchObject({ channel: "", myFacts: [], port: 3000, liveLearns: false });
  });

  it("keeps an unreadable file aside and starts fresh", () => {
    fs.writeFileSync(file, "{not json");
    expect(loadSettings()).toEqual(DEFAULTS);
    expect(fs.existsSync(file + ".unreadable")).toBe(true);
  });
});

describe("a settings file that can't be read right now (antivirus or OneDrive lock)", () => {
  /** Reading settings.json fails with `code` for the first `times` reads (default all) */
  const lockFile = (code: string, times = Infinity) => {
    const real = fs.readFileSync;
    let left = times;
    return jest.spyOn(fs, "readFileSync").mockImplementation(((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (String(p) === file && left-- > 0) throw Object.assign(new Error(`${code}: resource busy or locked`), { code });
      return (real as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.readFileSync);
  };
  beforeEach(() => {
    jest.spyOn(Atomics, "wait").mockReturnValue("timed-out");
    jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it.each(["EBUSY", "EPERM", "EACCES"])("%s keeps the file, uses defaults and doesn't save over it", (code) => {
    saveSettings({ ...DEFAULTS, channel: "jane", token: "secret-token" });
    const before = fs.readFileSync(file, "utf8");
    const spy = lockFile(code);
    const s = loadSettings();
    expect(s).toEqual(DEFAULTS);
    expect(spy.mock.calls.filter(([p]) => String(p) === file)).toHaveLength(4); // the first try and three more
    expect(fs.existsSync(file + ".unreadable")).toBe(false);
    saveSettings({ ...s, displayName: "Someone Else" });
    spy.mockRestore();
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(loadSettings()).toMatchObject({ channel: "jane", token: "secret-token" });
  });

  it("reads the file when the lock lifts within the retries", () => {
    saveSettings({ ...DEFAULTS, channel: "jane", token: "secret-token" });
    lockFile("EBUSY", 2);
    expect(loadSettings()).toMatchObject({ channel: "jane", token: "secret-token" });
    expect(fs.existsSync(file + ".unreadable")).toBe(false);
  });

  it("saves again once a later load can read the file", () => {
    saveSettings({ ...DEFAULTS, channel: "jane" });
    const spy = lockFile("EBUSY");
    loadSettings();
    spy.mockRestore();
    saveSettings({ ...DEFAULTS, channel: "other" });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).channel).toBe("jane");
    saveSettings({ ...loadSettings(), channel: "other" });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).channel).toBe("other");
  });

  it("still sets aside a file that reads but isn't a settings object", () => {
    fs.writeFileSync(file, "42");
    expect(loadSettings()).toEqual(DEFAULTS);
    expect(fs.existsSync(file + ".unreadable")).toBe(true);
    fs.writeFileSync(file, "null");
    expect(loadSettings()).toEqual(DEFAULTS);
  });
});

describe("update channel", () => {
  it("is Stable for a new install of a full release", () => {
    expect(loadSettings().updateChannel).toBe("stable");
  });

  it("is Beta for a new install of a beta, whose musician downloaded it to test", () => {
    running.version = "2.0.0-beta.12";
    expect(loadSettings().updateChannel).toBe("beta");
  });

  it("puts testers already on a beta on Beta, and keeps that after they update to a full release", () => {
    fs.writeFileSync(file, JSON.stringify({ setupComplete: true, channel: "jane" }));
    running.version = "2.0.0-beta.11";
    expect(loadSettings()).toMatchObject({ setupComplete: true, channel: "jane", updateChannel: "beta" });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ channel: "jane", updateChannel: "beta" });
    running.version = "2.0.0";
    expect(loadSettings().updateChannel).toBe("beta");
  });

  it("puts existing installs of a full release on Stable", () => {
    fs.writeFileSync(file, JSON.stringify({ setupComplete: true }));
    expect(loadSettings().updateChannel).toBe("stable");
  });

  it("keeps the musician's own choice whatever version runs", () => {
    saveSettings({ ...DEFAULTS, updateChannel: "stable" });
    running.version = "2.1.0-beta.1";
    expect(loadSettings().updateChannel).toBe("stable");
    saveSettings({ ...DEFAULTS, updateChannel: "beta" });
    running.version = "2.0.0";
    expect(loadSettings().updateChannel).toBe("beta");
  });

  it("takes only Stable or Beta from the window", () => {
    expect(fromWindow({ updateChannel: "beta" })).toEqual({ updateChannel: "beta" });
    expect(fromWindow({ updateChannel: 1 })).toEqual({});
    expect(sanitize({ ...DEFAULTS, updateChannel: "nightly" as "beta" }).updateChannel).toBe("stable");
    fs.writeFileSync(file, JSON.stringify({ updateChannel: "nightly" }));
    expect(loadSettings().updateChannel).toBe("stable");
  });
});

describe("the last version whose What's new was seen", () => {
  it("is blank until the app records one, and survives a save", () => {
    expect(loadSettings().lastVersionSeen).toBe("");
    saveSettings({ ...DEFAULTS, lastVersionSeen: "2.0.0-beta.12" });
    expect(loadSettings().lastVersionSeen).toBe("2.0.0-beta.12");
  });

  it("falls back to blank when the file holds something else", () => {
    fs.writeFileSync(file, JSON.stringify({ lastVersionSeen: 12 }));
    expect(loadSettings().lastVersionSeen).toBe("");
  });

  it("belongs to the app: the window and a backup can't set it", () => {
    expect(fromWindow({ lastVersionSeen: "9.9.9" })).toEqual({});
  });
});

describe("sharing song facts with other apps", () => {
  const on = { ...DEFAULTS, channel: "jane", token: "t", shareFacts: true, shareUrl: "https://share.example.com/events", shareChannel: "madeupchannel", shareKey: "made-up-key-12345" };

  it("is off by default", () => {
    expect(DEFAULTS.shareFacts).toBe(false);
    expect(toServerEnv({ ...DEFAULTS, channel: "jane", token: "t" }, paths)).not.toHaveProperty("SHARE_FACTS_URL");
  });

  it("goes to the server only when switched on with a channel and a key", () => {
    expect(toServerEnv(on, paths)).toMatchObject({ SHARE_FACTS_URL: "https://share.example.com/events", SHARE_FACTS_CHANNEL: "madeupchannel", SHARE_FACTS_KEY: "made-up-key-12345" });
    for (const missing of [{ shareFacts: false }, { shareUrl: "" }, { shareChannel: "" }, { shareKey: "" }]) {
      const env = toServerEnv({ ...on, ...missing }, paths);
      expect(env).not.toHaveProperty("SHARE_FACTS_URL");
      expect(env).not.toHaveProperty("SHARE_FACTS_KEY");
    }
  });

  it("keeps the key encrypted on disk and out of reports", () => {
    saveSettings(on);
    expect(fs.readFileSync(file, "utf8")).not.toContain("made-up-key-12345");
    expect(loadSettings()).toMatchObject({ shareFacts: true, shareKey: "made-up-key-12345" });
    expect(secretsOf(on)).toContain("made-up-key-12345");
  });

  it("refuses an address that isn't https, except on this computer", () => {
    expect(shareUrlProblem({ shareUrl: "http://share.example.com/events" })).toMatch(/https/);
    expect(shareUrlProblem({ shareUrl: "http://localhost:8123/events" })).toBeNull();
    expect(sanitize({ ...on, shareUrl: "http://share.example.com/events" }).shareUrl).toBe("");
  });

  it("tidies a pasted channel name", () => {
    expect(sanitize({ ...on, shareChannel: " @madeupchannel " }).shareChannel).toBe("madeupchannel");
  });
});

describe("toServerEnv", () => {
  it("passes the app's sign-in as a bearer token with the client and channel IDs", () => {
    const env = toServerEnv({ ...DEFAULTS, channel: "jane", token: "t", tokenKind: "oauth", streamerId: 42 }, paths);
    expect(env).toMatchObject({ SSL_TOKEN_KIND: "bearer", SSL_CLIENT_ID: "client-1", SSL_STREAMER_ID: "42", SSL_ACCESS_TOKEN: "t" });
  });

  it("passes a pasted token without sign-in details", () => {
    const env = toServerEnv({ ...DEFAULTS, token: "t", tokenKind: "streamer" }, paths);
    expect(env.SSL_TOKEN_KIND).toBe("streamer");
    expect(env.SSL_CLIENT_ID).toBeUndefined();
    expect(env.SSL_STREAMER_ID).toBeUndefined();
  });

  it("maps the musician's choices", () => {
    expect(toServerEnv({ ...DEFAULTS, nowPlaying: false }, paths).NOW_PLAYING).toBe("off");
    expect(toServerEnv(DEFAULTS, paths).CREDIT_BUBBLE).toBe("on");
    expect(toServerEnv({ ...DEFAULTS, creditBubble: false }, paths).CREDIT_BUBBLE).toBe("off");
    expect(fromWindow({ creditBubble: false })).toEqual({ creditBubble: false });
    expect(fromWindow({ creditBubble: "off" })).toEqual({});
    expect(toServerEnv(DEFAULTS, paths).LIVE_LEARN_BANNER).toBe("on");
    expect(toServerEnv({ ...DEFAULTS, liveLearnBanner: false }, paths).LIVE_LEARN_BANNER).toBe("off");
    expect(toServerEnv({ ...DEFAULTS, bubbleArea: "left" }, paths).BUBBLE_AREA).toBe("left");
    expect(sanitize({ ...DEFAULTS, bubbleArea: "middle" as "left" }).bubbleArea).toBe("anywhere");
    for (const spot of ["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"] as const) {
      expect(sanitize({ ...DEFAULTS, bubbleArea: spot }).bubbleArea).toBe(spot);
      expect(toServerEnv({ ...DEFAULTS, bubbleArea: spot }, paths).BUBBLE_AREA).toBe(spot);
    }
    expect(sanitize({ ...DEFAULTS, bubbleArea: "center" as "left" }).bubbleArea).toBe("anywhere");
    // The vertical overlay's own choices (#175), apart from the landscape ones
    expect(toServerEnv(DEFAULTS, paths).VERTICAL_AREA).toBe("top");
    expect(toServerEnv({ ...DEFAULTS, bubbleArea: "left", verticalArea: "above-chat" }, paths)).toMatchObject({ BUBBLE_AREA: "left", VERTICAL_AREA: "above-chat" });
    expect(sanitize({ ...DEFAULTS, verticalArea: "left" as "top" }).verticalArea).toBe("top");
    expect(sanitize({ ...DEFAULTS, verticalBubbleSize: "huge" as "large" }).verticalBubbleSize).toBe("standard");
    expect(fromWindow({ verticalArea: "above-chat", verticalBubbleSize: "larger" })).toEqual({ verticalArea: "above-chat", verticalBubbleSize: "larger" });
    // Setup asks new installs where bubbles go; existing ones keep their spot, or Anywhere
    fs.writeFileSync(file, JSON.stringify({ setupComplete: true, channel: "jane", bubbleArea: "right" }));
    expect(loadSettings().bubbleArea).toBe("right");
    fs.writeFileSync(file, JSON.stringify({ setupComplete: true, channel: "jane" }));
    expect(loadSettings().bubbleArea).toBe("anywhere");
    expect(sanitize({ ...DEFAULTS, ollamaUrl: "file:///etc/passwd" }).ollamaUrl).toBe(DEFAULTS.ollamaUrl);
    expect(sanitize({ ...DEFAULTS, ollamaUrl: "http://studio-pc:11434" }).ollamaUrl).toBe("http://studio-pc:11434");
    expect(fromWindow({ nowPlaying: false })).toEqual({ nowPlaying: false });
    expect(fromWindow({ nowPlaying: "no" })).toEqual({});
    expect(fromWindow({ liveLearnBanner: false })).toEqual({ liveLearnBanner: false });
    const env = toServerEnv({ ...DEFAULTS, originals: true, liveLearns: false, myFacts: ["Mine."] }, paths);
    expect(env).toMatchObject({ ORIGINALS: "on", LIVE_LEARNS: "off", NOW_PLAYING: "on", BUBBLEFACTS_TOPICS_DIR: "/facts", HOST: "127.0.0.1" });
    expect(env.TOPIC).toBe("my-facts");
    expect(toServerEnv({ ...DEFAULTS }, paths).TOPIC).toBe("none");
  });

  it("points the built-in AI at the model and honors the processor-only fallback", () => {
    const env = toServerEnv({ ...DEFAULTS, ai: "builtin", forceCpu: true }, paths);
    expect(env).toMatchObject({ AI_PROVIDER: "builtin", MODEL_PATH: path.join("/models", "Llama-3.2-3B-Instruct-Q4_K_M.gguf"), LLAMA_GPU: "off" });
  });

  it("keeps the legacy online AIs and Ollama for anyone who chose one", () => {
    expect(toServerEnv({ ...DEFAULTS, ai: "groq", groqKey: "k" }, paths)).toMatchObject({ AI_PROVIDER: "openai", OPENAI_API_KEY: "k" });
    expect(toServerEnv({ ...DEFAULTS, ai: "ollama" }, paths).AI_PROVIDER).toBe("ollama");
    expect(toServerEnv({ ...DEFAULTS, ai: "anthropic", anthropicKey: "k" }, paths).AI_PROVIDER).toBe("anthropic");
    // A former Lite user's saved "builtin" is the built-in AI once they install the full app.
    expect(toServerEnv({ ...DEFAULTS, ai: "builtin" }, paths).AI_PROVIDER).toBe("builtin");
  });

  it("points the built-in AI at the model for the chosen quality", () => {
    expect(DEFAULTS.aiQuality).toBe("standard");
    expect(toServerEnv({ ...DEFAULTS, aiQuality: "high" }, paths).MODEL_PATH).toBe(path.join("/models", "Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf"));
    expect(toServerEnv({ ...DEFAULTS, ai: "groq", groqKey: "k", aiQuality: "high" }, paths).MODEL_PATH).toBeUndefined();
  });

  it("keeps the AI quality to standard or high, falling back to standard", () => {
    expect(sanitize({ ...DEFAULTS, aiQuality: "high" }).aiQuality).toBe("high");
    expect(sanitize({ ...DEFAULTS, aiQuality: "ultra" as never }).aiQuality).toBe("standard");
    expect(sanitize({ ...DEFAULTS, aiQuality: undefined as never }).aiQuality).toBe("standard");
    expect(fromWindow({ aiQuality: "high" })).toEqual({ aiQuality: "high" });
    expect(fromWindow({ aiQuality: 2 })).toEqual({});
  });
});

describe("How sure a fact must be (#542)", () => {
  it("defaults to standard and then starts the server exactly as before: no FACT_CERTAINTY at all", () => {
    expect(DEFAULTS.factCertainty).toBe("standard");
    expect(toServerEnv(DEFAULTS, paths)).not.toHaveProperty("FACT_CERTAINTY");
  });

  it("sends the other two levels", () => {
    expect(toServerEnv({ ...DEFAULTS, factCertainty: "surest" }, paths).FACT_CERTAINTY).toBe("surest");
    expect(toServerEnv({ ...DEFAULTS, factCertainty: "more" }, paths).FACT_CERTAINTY).toBe("more");
    // A new level restarts the server, as any setting it reads does
    const sig = (s: Settings) => serverSettingsSignature(toServerEnv(s, paths), s);
    expect(sig({ ...DEFAULTS, factCertainty: "more" })).not.toBe(sig(DEFAULTS));
  });

  it("holds to the three levels, an unknown or missing one being standard", () => {
    expect(sanitize({ ...DEFAULTS, factCertainty: "more" }).factCertainty).toBe("more");
    expect(sanitize({ ...DEFAULTS, factCertainty: "most" as never }).factCertainty).toBe("standard");
    expect(sanitize({ ...DEFAULTS, factCertainty: undefined as never }).factCertainty).toBe("standard");
    expect(fromWindow({ factCertainty: "surest" })).toEqual({ factCertainty: "surest" });
    expect(fromWindow({ factCertainty: 1 })).toEqual({});
    expect(ENUM_KEYS).toContain("factCertainty");
  });
});

describe("Now playing file", () => {
  const streamling = { ...DEFAULTS, songSource: "nowplaying" as const, nowPlayingPreset: "streamling" as const };
  const other = { ...DEFAULTS, songSource: "nowplaying" as const, nowPlayingPreset: "none" as const, nowPlayingFile: "/music/now-playing.txt", nowPlayingFormat: "title" as const };

  it("round-trips the source, preset, file and format", () => {
    saveSettings(other);
    expect(loadSettings()).toMatchObject({ songSource: "nowplaying", nowPlayingPreset: "none", nowPlayingFile: "/music/now-playing.txt", nowPlayingFormat: "title" });
    expect(fs.readFileSync(file, "utf8")).toContain("/music/now-playing.txt");
  });

  it("defaults to Streamling's preset and the Artist - Title format", () => {
    expect(DEFAULTS).toMatchObject({ nowPlayingPreset: "streamling", nowPlayingFile: "", nowPlayingFormat: "artist-title" });
  });

  it("starts the server on Streamling's file with nothing typed", () => {
    const env = toServerEnv({ ...streamling, nowPlayingFile: "/left/over.txt", nowPlayingFormat: "title" }, paths);
    expect(env).toMatchObject({ SONG_SOURCE: "nowplaying", NOW_PLAYING_PRESET: "streamling", NOW_PLAYING_FORMAT: "youtube-title" });
    expect(env.NOW_PLAYING_FILE).toBeUndefined();
    expect(env.SSL_ACCESS_TOKEN).toBeUndefined();
    expect(env.SE_JWT).toBeUndefined();
  });

  it("starts the server on Nightbot's folder, read as YouTube titles, with nothing typed", () => {
    const env = toServerEnv({ ...streamling, nowPlayingPreset: "nightbot", nowPlayingFile: "/left/over.txt", nowPlayingFormat: "title" }, paths);
    expect(env).toMatchObject({ SONG_SOURCE: "nowplaying", NOW_PLAYING_PRESET: "nightbot", NOW_PLAYING_FORMAT: "youtube-title" });
    expect(env.NOW_PLAYING_FILE).toBeUndefined();
    expect(env.SSL_ACCESS_TOKEN).toBeUndefined();
  });

  it("starts the server on the chosen file and format for another app", () => {
    const env = toServerEnv(other, paths);
    expect(env).toMatchObject({ SONG_SOURCE: "nowplaying", NOW_PLAYING_PRESET: "none", NOW_PLAYING_FILE: "/music/now-playing.txt", NOW_PLAYING_FORMAT: "title" });
    expect(env.SSL_STREAMER_NAME).toBeUndefined();
  });

  it("restarts the server when the file or format changes", () => {
    const sig = (s: Settings) => serverSettingsSignature(toServerEnv(s, paths), s);
    expect(sig({ ...other, nowPlayingFile: "/music/other.txt" })).not.toBe(sig(other));
    expect(sig({ ...other, nowPlayingFormat: "artist-title" })).not.toBe(sig(other));
  });

  it("starts the server on What's Now Playing's file, read as Artist - Title, with nothing typed", () => {
    const env = toServerEnv({ ...streamling, nowPlayingPreset: "whatsnowplaying", nowPlayingFile: "/left/over.txt", nowPlayingFormat: "title" }, paths);
    expect(env).toMatchObject({ SONG_SOURCE: "nowplaying", NOW_PLAYING_PRESET: "whatsnowplaying", NOW_PLAYING_FORMAT: "artist-title" });
    expect(env.NOW_PLAYING_FILE).toBeUndefined();
    expect(sanitize({ ...DEFAULTS, nowPlayingPreset: "whatsnowplaying" }).nowPlayingPreset).toBe("whatsnowplaying");
  });

  it("is ready with Streamling, Nightbot or What's Now Playing, or once a file is chosen", () => {
    expect(songSourceReady(streamling)).toBe(true);
    expect(songSourceReady({ ...streamling, nowPlayingPreset: "whatsnowplaying" })).toBe(true);
    expect(songSourceReady({ ...streamling, nowPlayingPreset: "nightbot" })).toBe(true);
    expect(songSourceReady({ ...other, nowPlayingFile: "" })).toBe(false);
    expect(songSourceReady(other)).toBe(true);
    // A sign-in saved for another source doesn't matter, and doesn't make an unchosen file ready
    expect(songSourceReady({ ...other, nowPlayingFile: "", channel: "jane", token: "t" })).toBe(false);
  });

  it("takes the choices from the window with the right types only", () => {
    expect(fromWindow({ songSource: "nowplaying", nowPlayingPreset: "none", nowPlayingFile: "/a.txt", nowPlayingFormat: "title" })).toEqual({
      songSource: "nowplaying",
      nowPlayingPreset: "none",
      nowPlayingFile: "/a.txt",
      nowPlayingFormat: "title",
    });
    expect(fromWindow({ nowPlayingFile: 3, nowPlayingPreset: true })).toEqual({});
  });

  it("falls back to safe values for anything unknown", () => {
    expect(fromWindow({ nowPlayingPreset: "nightbot" })).toEqual({ nowPlayingPreset: "nightbot" });
    expect(sanitize({ ...DEFAULTS, nowPlayingPreset: "nightbot" }).nowPlayingPreset).toBe("nightbot");
    expect(sanitize({ ...DEFAULTS, nowPlayingPreset: "lanternplayer" as never, nowPlayingFormat: "json" as never, nowPlayingFile: "  /a.txt  " })).toMatchObject({
      nowPlayingPreset: "streamling",
      nowPlayingFormat: "artist-title",
      nowPlayingFile: "/a.txt",
    });
  });
});

describe("StreamElements", () => {
  it("starts the server with only the StreamElements settings", () => {
    const env = toServerEnv({ ...DEFAULTS, songSource: "streamelements", seChannel: "janeplays", seJwt: "jwt-1", channel: "old", token: "old-token" }, paths);
    expect(env).toMatchObject({ SONG_SOURCE: "streamelements", SE_CHANNEL: "janeplays", SE_JWT: "jwt-1" });
    expect(env.SSL_ACCESS_TOKEN).toBeUndefined();
    expect(env.SSL_STREAMER_NAME).toBeUndefined();
  });

  it("leaves the StreamerSongList setup as it was", () => {
    const env = toServerEnv({ ...DEFAULTS, channel: "jane", token: "t", seJwt: "unused" }, paths);
    expect(env).toMatchObject({ SSL_STREAMER_NAME: "jane", SSL_ACCESS_TOKEN: "t", SSL_TOKEN_KIND: "streamer" });
    expect(env.SONG_SOURCE).toBeUndefined();
    expect(env.SE_JWT).toBeUndefined();
  });

  it("is ready to start with either source connected", () => {
    expect(songSourceReady({ ...DEFAULTS })).toBe(false);
    expect(songSourceReady({ ...DEFAULTS, channel: "jane", token: "t" })).toBe(true);
    expect(songSourceReady({ ...DEFAULTS, songSource: "streamelements" })).toBe(false);
    expect(songSourceReady({ ...DEFAULTS, songSource: "streamelements", seJwt: "jwt" })).toBe(true);
  });

  it("takes the source and token from the window, with the right types only", () => {
    expect(fromWindow({ songSource: "streamelements", seChannel: "janeplays", seJwt: "jwt", streamerId: 5 })).toEqual({
      songSource: "streamelements",
      seChannel: "janeplays",
      seJwt: "jwt",
    });
    expect(fromWindow({ seJwt: 42, songSource: 1 })).toEqual({});
    expect(sanitize({ ...DEFAULTS, songSource: "spotify" as never, seChannel: " jane " })).toMatchObject({
      songSource: "streamersonglist",
      seChannel: "jane",
    });
  });

  it("keeps the token out of problem reports", () => {
    expect(secretsOf({ ...DEFAULTS, seJwt: "eyJhbGciOi.secret-jwt" })).toContain("eyJhbGciOi.secret-jwt");
  });
});

describe("the musician's own facts", () => {
  it("uses only their pack, and only when they've written something", () => {
    expect(topicList({ ...DEFAULTS })).toEqual([]);
    expect(topicList({ ...DEFAULTS, myFacts: ["Mine."] })).toEqual(["my-facts"]);
    expect(topicList({ ...DEFAULTS, myOriginals: ["About my song."] })).toEqual(["my-facts"]);
  });

  it("writes a pack the server can read", () => {
    const facts = path.join(dir, "facts");
    writeMyPack({ ...DEFAULTS, myFacts: ["One."], myOriginals: ["Two."] }, facts);
    const pack = JSON.parse(fs.readFileSync(path.join(facts, "my-facts.json"), "utf8"));
    expect(pack).toMatchObject({ id: "my-facts", curatedFacts: ["One."], originalsFacts: ["Two."] });
  });

  it("refuses a fact longer than a song's own facts may be, saying which, instead of trimming it", () => {
    const long = "x".repeat(301);
    expect(customFactsProblem({ myFacts: ["Fine.", "x".repeat(300)] })).toBeNull();
    expect(customFactsProblem({ myFacts: ["Fine.", "", long] })).toBe("Your own facts: fact 2 is 301 characters. Shorten it to 300 or fewer to save.");
    expect(customFactsProblem({ myOriginals: [long] })).toMatch(/^About your own compositions: fact 1 is 301 characters/);
    // The [song] tag never goes on stream, so it doesn't count
    expect(customFactsProblem({ myFacts: ["[Song of Storms] " + "x".repeat(300)] })).toBeNull();
    // Settings that don't touch facts still save with an older long one there
    expect(customFactsProblem({})).toBeNull();
  });

  it("saves settings.json for the musician only, replacing it whole", () => {
    saveSettings({ ...DEFAULTS, myFacts: ["One."] });
    saveSettings({ ...DEFAULTS, myFacts: ["Two."] });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).myFacts).toEqual(["Two."]);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("an imported look (issue #402)", () => {
  const look = { name: "Sunset Set", author: "A Made-Up Maker", madeFor: "2.3.0", values: { "--bf-bg-1": "#2a0a3c", "--bf-bg-2": "#2a0a3c", "--bf-text": "#ffffff" } };

  it("starts with none, and isn't something the window can save with the other settings", () => {
    expect(DEFAULTS.styleLook).toBeNull();
    expect(fromWindow({ styleLook: look })).not.toHaveProperty("styleLook");
  });

  it("goes live to the running server, never restarting it, and leaves the Style and colors set under it", () => {
    const withLook = sanitize({ ...DEFAULTS, bubbleStyle: "retro", styleLook: look });
    expect(withLook.styleLook).toEqual(look);
    expect(withLook.bubbleStyle).toBe("retro");
    expect(JSON.parse(styleEnv(withLook).BUBBLE_STYLE_FILE)).toEqual(look);
    const env = (s: typeof DEFAULTS) => ({ AI_PROVIDER: "none", ...styleEnv(s) });
    expect(serverSettingsSignature(env(withLook), withLook)).toBe(serverSettingsSignature(env(DEFAULTS), DEFAULTS));
  });

  it("keeps a look with an icon through Use this look, the settings file and the next start", () => {
    const read = readStyleFile(JSON.stringify({ bubblefacts: "style", name: "Sunset Set", madeFor: "2.3.0", values: { ...look.values, "--bf-icon": "♪" } }), "2.3.0");
    if (!read.ok) throw new Error(read.reason);
    const used = checkStyleLook(read.look, "2.3.0");
    if (!used.ok) throw new Error(used.reason);
    saveSettings(sanitize({ ...DEFAULTS, styleLook: used.look }));
    const loaded = loadSettings();
    expect(loaded.styleLook).toEqual(read.look);
    expect(loaded.styleLook?.values["--bf-icon"]).toBe("♪");
    expect(JSON.parse(styleEnv(loaded).BUBBLE_STYLE_FILE).values["--bf-icon"]).toBe("♪");
  });

  it("drops a saved look that no longer passes the checks, so a hand-edited settings file can't break the bubbles", () => {
    const bad = [
      { ...look, values: { ...look.values, "--bf-bg-1": "url(https://example.com/a.png)" } },
      { ...look, values: { ...look.values, "--bf-scale": "3" } },
      { ...look, values: { "--bf-text": "#2a0a3c", "--bf-bg-1": "#2a0a3c" } },
      { ...look, madeFor: "2.2.0" },
      "classic",
      [],
    ];
    for (const styleLook of bad) expect(sanitize({ ...DEFAULTS, styleLook: styleLook as never }).styleLook).toBeNull();
  });
});

describe("bubble Styles and your own colors (issue #177)", () => {
  it("starts on the classic dark blue, with its own colors ready for the pickers", () => {
    expect(DEFAULTS).toMatchObject({ bubbleStyle: "classic", customColors: false, accentColor: "#5b6ee1", backgroundColor: "#0a0a3c" });
    expect(styleEnv(DEFAULTS)).toEqual({ BUBBLE_STYLE: "classic", BUBBLE_ICON: "style", BUBBLE_ACCENT: "", BUBBLE_BACKGROUND: "", BUBBLE_SCALE: "1", BUBBLE_VERTICAL_SCALE: "1", BUBBLE_STYLE_FILE: "" });
  });

  it("sends a new bubble size to the running server, never restarting it", () => {
    const larger = { ...DEFAULTS, bubbleSize: "larger" as const, verticalBubbleSize: "large" as const };
    expect(styleEnv(larger)).toMatchObject({ BUBBLE_SCALE: "1.5", BUBBLE_VERTICAL_SCALE: String(VERTICAL_BUBBLE_SCALE.large) });
    const env = (s: typeof DEFAULTS) => ({ AI_PROVIDER: "none", ...styleEnv(s) });
    expect(serverSettingsSignature(env(larger), larger)).toBe(serverSettingsSignature(env(DEFAULTS), DEFAULTS));
  });

  it("sends a new icon to the running server, never restarting it", () => {
    const heart = { ...DEFAULTS, bubbleIcon: "heart" as const };
    expect(styleEnv(heart)).toMatchObject({ BUBBLE_ICON: "heart" });
    expect(JSON.stringify(styleEnv(heart))).not.toBe(JSON.stringify(styleEnv(DEFAULTS)));
    const env = (s: typeof DEFAULTS) => ({ AI_PROVIDER: "none", ...styleEnv(s) });
    expect(serverSettingsSignature(env(heart), heart)).toBe(serverSettingsSignature(env(DEFAULTS), DEFAULTS));
  });

  it("gives a settings file from before icons the Style's own, and never keeps an unknown icon", () => {
    const { bubbleIcon: _gone, ...old } = DEFAULTS;
    expect(sanitize(old as typeof DEFAULTS).bubbleIcon).toBe("style");
    expect(sanitize({ ...DEFAULTS, bubbleIcon: "skull" as "heart" }).bubbleIcon).toBe("style");
    for (const icon of ["style", "notes", "heart", "star", "moon", "diamond"] as const) expect(sanitize({ ...DEFAULTS, bubbleIcon: icon }).bubbleIcon).toBe(icon);
  });

  it("keeps each built-in Style, and an unknown one falls back to classic", () => {
    for (const style of ["classic", "light", "minimal", "retro", "high-contrast"] as const) expect(sanitize({ ...DEFAULTS, bubbleStyle: style }).bubbleStyle).toBe(style);
    expect(sanitize({ ...DEFAULTS, bubbleStyle: "neon" as "retro" }).bubbleStyle).toBe("classic");
  });

  it("takes colors only as #rrggbb", () => {
    expect(sanitize({ ...DEFAULTS, accentColor: "#FF8800", backgroundColor: " #ffffff " })).toMatchObject({ accentColor: "#ff8800", backgroundColor: "#ffffff" });
    for (const bad of ["red", "#f80", "#ff880", "#ff88000", "ff8800", "#gg8800", "rgb(1, 2, 3)", "#ff8800; color: red", ""]) {
      expect(sanitize({ ...DEFAULTS, accentColor: bad }).accentColor).toBe(DEFAULTS.accentColor);
      expect(sanitize({ ...DEFAULTS, backgroundColor: bad }).backgroundColor).toBe(DEFAULTS.backgroundColor);
    }
  });

  it("tells the server the Style always, and the colors only while they're turned on", () => {
    const mine = { ...DEFAULTS, bubbleStyle: "minimal" as const, accentColor: "#ff8800", backgroundColor: "#ffffff" };
    expect(toServerEnv(mine, paths)).toMatchObject({ BUBBLE_STYLE: "minimal", BUBBLE_ACCENT: "", BUBBLE_BACKGROUND: "" });
    expect(toServerEnv({ ...mine, customColors: true }, paths)).toMatchObject({ BUBBLE_STYLE: "minimal", BUBBLE_ACCENT: "#ff8800", BUBBLE_BACKGROUND: "#ffffff" });
  });

  it("can be changed from the window", () => {
    const changes = { bubbleStyle: "light", customColors: true, accentColor: "#ff8800", backgroundColor: "#ffffff" };
    expect(fromWindow(changes)).toEqual(changes);
    expect(fromWindow({ customColors: "yes", accentColor: 7 })).toEqual({});
  });

  it("keeps a Style only a newer version knows in the file, as for other choices", () => {
    fs.writeFileSync(file, JSON.stringify({ channel: "jane", bubbleStyle: "neon", settingsVersion: 1 }));
    const loaded = loadSettings();
    expect(loaded.bubbleStyle).toBe("classic");
    saveSettings({ ...loaded, displayName: "Jane Composer" });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).bubbleStyle).toBe("neon");
  });
});

describe("serverSettingsSignature (issue #55)", () => {
  const paths = { modelsDir: "/m", logDir: "/l", topicsDir: "/facts", clientId: "c" };
  const base = { ...DEFAULTS, channel: "jane", token: "t1", tokenKind: "oauth" as const, streamerId: 1 };
  const sig = (s: typeof base) => serverSettingsSignature(toServerEnv(s, paths), s);

  it("doesn't change for saves the server never sees", () => {
    expect(sig({ ...base, setupComplete: true })).toBe(sig(base));
    expect(sig({ ...base, startAtLogin: true })).toBe(sig(base));
    expect(sig({ ...base, bubbleSize: "large" })).toBe(sig(base));
    expect(sig({ ...base, token: "t2-refreshed" })).toBe(sig(base));
    // A new look reaches the running server without a restart (#177)
    expect(sig({ ...base, bubbleStyle: "retro" })).toBe(sig(base));
    expect(sig({ ...base, customColors: true, accentColor: "#ff8800", backgroundColor: "#ffffff" })).toBe(sig(base));
  });

  it("changes when the server would behave differently", () => {
    expect(sig({ ...base, factsPerSong: 7 })).not.toBe(sig(base));
    expect(sig({ ...base, myFacts: ["A new fact."] })).not.toBe(sig(base));
    expect(sig({ ...base, originals: true })).not.toBe(sig(base));
    expect(sig({ ...base, ai: "groq", groqKey: "k" })).not.toBe(sig(base));
    expect(sig({ ...base, aiQuality: "high" })).not.toBe(sig(base));
  });
});

describe("a sign-in with no username (a beta tester's first run)", () => {
  const paths = { modelsDir: "/m", logDir: "/l", topicsDir: "/facts", clientId: "c" };
  const signedIn = { ...DEFAULTS, channel: "", token: "t", tokenKind: "oauth" as const, streamerId: 7 };

  it("is ready to start: the channel is followed by its ID", () => {
    expect(songSourceReady(signedIn)).toBe(true);
    expect(songSourceReady({ ...signedIn, streamerId: 0 })).toBe(false);
    expect(songSourceReady({ ...signedIn, tokenKind: "streamer" as const })).toBe(false);
    expect(songSourceReady({ ...signedIn, token: "" })).toBe(false);
  });

  it("still gives the server a name and the ID", () => {
    const env = toServerEnv(signedIn, paths);
    expect(env.SSL_STREAMER_NAME).toBe("The streamer");
    expect(env.SSL_STREAMER_ID).toBe("7");
    expect(toServerEnv({ ...signedIn, displayName: "Jane" }, paths).SSL_STREAMER_NAME).toBe("Jane");
  });
});

describe("reading the saved sign-in after the window is up (issue #62)", () => {
  it("leaves the secrets unread, saves nothing meanwhile, then reads them", () => {
    keychain.available = true;
    saveSettings({ ...DEFAULTS, setupComplete: true, channel: "jane", token: "streamer-token-123" });
    const first = loadSettings(false);
    expect(first).toMatchObject({ channel: "jane", token: "" });
    expect(secretsWaiting()).toBe(true);
    // A save now would store the sign-in blank
    saveSettings({ ...first, channel: "changed" });
    const unlocked = unlockSecrets(first);
    expect(unlocked.token).toBe("streamer-token-123");
    expect(secretsWaiting()).toBe(false);
    expect(loadSettings()).toMatchObject({ channel: "jane", token: "streamer-token-123" });
  });

  it("has nothing to wait for when no sign-in is saved", () => {
    saveSettings({ ...DEFAULTS });
    loadSettings(false);
    expect(secretsWaiting()).toBe(false);
  });
});

describe("the keychain isn't touched to draw the window (issue #62)", () => {
  const platform = process.platform;
  afterEach(() => Object.defineProperty(process, "platform", { value: platform }));

  it("doesn't ask whether secrets are protected on a Mac or Windows", () => {
    for (const p of ["darwin", "win32"]) {
      Object.defineProperty(process, "platform", { value: p });
      keychain.available = false; // would say "unprotected" if it were asked
      expect(secretsUnprotected()).toBe(false);
    }
  });

  it("still warns on Linux without a keyring", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    keychain.available = false;
    expect(secretsUnprotected()).toBe(true);
  });
});

describe("port", () => {
  it("keeps any port the Settings field allows, up to 65535 (#165)", () => {
    expect(sanitize({ ...DEFAULTS, port: 65535 }).port).toBe(65535);
    expect(sanitize({ ...DEFAULTS, port: 80 }).port).toBe(1024);
  });
});

describe("how long a song may stay on the list before it's taken as over (#451)", () => {
  const env = (s: typeof DEFAULTS) => toServerEnv({ ...s, channel: "jane", token: "t" }, paths);

  it("is 10 minutes until the streamer changes it", () => {
    expect(DEFAULTS.staleMinutes).toBe(10);
    expect(sanitize({ ...DEFAULTS }).staleMinutes).toBe(10);
    expect(env(DEFAULTS)).toMatchObject({ STALE_SONG_MINUTES: "10" });
  });

  it("keeps the streamer's own value from 5 to 60, and hands it to the server", () => {
    for (const minutes of [5, 25, 60]) expect(sanitize({ ...DEFAULTS, staleMinutes: minutes }).staleMinutes).toBe(minutes);
    expect(env(sanitize({ ...DEFAULTS, staleMinutes: 25 }))).toMatchObject({ STALE_SONG_MINUTES: "25" });
    expect(EDITABLE).toContain("staleMinutes");
  });

  it("goes back to 10 for a bad value, never to an end of the range", () => {
    for (const bad of [0, 4, 61, 600, -10, NaN, Infinity, "ten" as unknown as number, undefined as unknown as number]) {
      expect(sanitize({ ...DEFAULTS, staleMinutes: bad }).staleMinutes).toBe(10);
    }
  });
});

describe("Save my Style as a file", () => {
  const personal = {
    channel: "made_up_channel", seChannel: "made_up_se", token: "tok-secret-123", refreshToken: "ref-secret-456", seJwt: "jwt-secret-789", groqKey: "gsk-secret", anthropicKey: "sk-ant-secret",
    shareKey: "share-secret", shareUrl: "https://example.test/facts", nowPlayingFile: "/Users/made-up-person/Music/now-playing.txt", myFacts: ["Made-Up Song | A private fact"], twitchLogin: "made_up_twitch",
  };
  const mine = sanitize({ ...DEFAULTS, ...personal, bubbleStyle: "retro", bubbleIcon: "moon", customColors: true, accentColor: "#ff8800", backgroundColor: "#101030" } as Settings);

  it("holds the look and nothing personal: no channel, account, key, path or other setting", () => {
    const saved = styleFileOf(mine, "Night Set", "", "2.3.0");
    if (!saved.ok) throw new Error(saved.reason);
    const file = JSON.parse(saved.text);
    expect(Object.keys(file)).toEqual(["bubblefacts", "format", "name", "madeFor", "values"]);
    expect(Object.keys(file.values).every((key) => key.startsWith("--bf-"))).toBe(true);
    for (const value of [...Object.values(personal).flat(), os.homedir(), os.userInfo().username, os.hostname()]) expect(saved.text).not.toContain(String(value));
    expect(saved.text).not.toMatch(/https?:|[\\/]Users[\\/]|@/);
    // The same file whoever saves it
    expect(styleFileOf({ ...DEFAULTS, bubbleStyle: "retro", bubbleIcon: "moon", customColors: true, accentColor: "#ff8800", backgroundColor: "#101030" }, "Night Set", "", "2.3.0")).toEqual(saved);
  });

  it("round trip: the saved file imports, and shows the colors, font, corners and icon that were on stream", () => {
    const saved = styleFileOf(mine, "Night Set", "A Made-Up Maker", "2.3.0");
    if (!saved.ok) throw new Error(saved.reason);
    const read = readStyleFile(saved.text, "2.3.0");
    if (!read.ok) throw new Error(read.reason);
    expect(read.look).toMatchObject({ name: "Night Set", author: "A Made-Up Maker", madeFor: "2.3.0" });
    expect(read.look.values).toMatchObject({ "--bf-bg-1": "#101030", "--bf-accent": "#ff8800", "--bf-text": "#ffffff", "--bf-radius": "0px", "--bf-icon": "☾" });
    expect(read.look.values["--bf-font"]).toContain("monospace");
    // Used, then saved again: the same values
    const using = sanitize({ ...DEFAULTS, styleLook: read.look });
    const again = styleFileOf(using, "Night Set", "A Made-Up Maker", "2.3.0");
    expect(again.ok && again.look).toEqual(read.look);
  });

  it("leaves own colors out when Use my own colors is off", () => {
    const saved = styleFileOf({ ...mine, customColors: false }, "x", "", "2.3.0");
    expect(saved.ok && saved.look.values["--bf-bg-1"]).toBe("rgba(0, 0, 0, 0.94)");
  });

  it("saves an imported look as it is shown: its own values, not the Style under it, with the Icon setting on top", () => {
    const look = { name: "Sunset Set", author: "A Made-Up Maker", madeFor: "2.3.0", values: { "--bf-bg-1": "#2a0a3c", "--bf-bg-2": "#2a0a3c", "--bf-text": "#ffffff", "--bf-icon": "♪" } };
    const asIs = styleFileOf(sanitize({ ...mine, bubbleIcon: "style", styleLook: look }), "Sunset Set", "", "2.3.0");
    if (!asIs.ok) throw new Error(asIs.reason);
    expect(asIs.look.values).toEqual(look.values);
    // The maker's name isn't carried along unless the streamer adds one
    expect(asIs.look.author).toBe("");
    const withIcon = styleFileOf(sanitize({ ...mine, bubbleIcon: "diamond", styleLook: look }), "Sunset Set", "", "2.3.0");
    expect(withIcon.ok && withIcon.look.values).toEqual({ ...look.values, "--bf-icon": "◆" });
    const rotating = styleFileOf(sanitize({ ...mine, bubbleIcon: "notes", styleLook: look }), "Sunset Set", "", "2.3.0");
    expect(rotating.ok && rotating.look.values).not.toHaveProperty("--bf-icon");
  });

  it("names the file from the look's name, in plain characters", () => {
    expect(styleFileName("Night Set!")).toBe("night-set.json");
    expect(styleFileName("../../etc/passwd")).toBe("etc-passwd.json");
    expect(styleFileName("夜")).toBe("my-style.json");
  });
});
