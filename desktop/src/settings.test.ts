import fs from "fs";
import os from "os";
import path from "path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bubblefacts-settings-"));
const keychain = { available: true, broken: false };

jest.mock("electron", () => ({
  app: { getPath: () => dir },
  safeStorage: {
    isEncryptionAvailable: () => keychain.available,
    encryptString: (s: string) => Buffer.from("x" + s),
    decryptString: (b: Buffer) => {
      if (keychain.broken) throw new Error("keychain changed");
      return b.toString().slice(1);
    },
  },
}));

import { DEFAULTS, loadSettings, saveSettings, topicList, toServerEnv, writeMyPack } from "./settings";

const file = path.join(dir, "settings.json");
const paths = { modelPath: "/m.gguf", logDir: "/logs", topicsDir: "/facts", clientId: "client-1" };

afterEach(() => {
  keychain.available = true;
  keychain.broken = false;
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("loadSettings", () => {
  it("starts from the defaults on first run", () => {
    expect(loadSettings()).toEqual(DEFAULTS);
  });

  it("round-trips, keeping secrets encrypted on disk", () => {
    saveSettings({ ...DEFAULTS, channel: "jane", token: "secret-token", refreshToken: "refresh-1" });
    const disk = fs.readFileSync(file, "utf8");
    expect(disk).not.toContain("secret-token");
    expect(disk).not.toContain("refresh-1");
    expect(loadSettings()).toMatchObject({ channel: "jane", token: "secret-token", refreshToken: "refresh-1" });
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

  it("replaces values of the wrong type with the default", () => {
    fs.writeFileSync(file, JSON.stringify({ channel: 42, topics: "pop", myFacts: [1, 2], port: "3000", liveLearns: false }));
    const s = loadSettings();
    expect(s).toMatchObject({ channel: "", topics: DEFAULTS.topics, myFacts: [], port: 3000, liveLearns: false });
  });

  it("keeps an unreadable file aside and starts fresh", () => {
    fs.writeFileSync(file, "{not json");
    expect(loadSettings()).toEqual(DEFAULTS);
    expect(fs.existsSync(file + ".unreadable")).toBe(true);
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
    const env = toServerEnv({ ...DEFAULTS, originals: true, liveLearns: false, myFacts: ["Mine."] }, paths);
    expect(env).toMatchObject({ ORIGINALS: "on", LIVE_LEARNS: "off", BUBBLEFACTS_TOPICS_DIR: "/facts", HOST: "127.0.0.1" });
    expect(env.TOPIC.split(",")[0]).toBe("my-facts");
  });

  it("points the built-in AI at the model and honors the processor-only fallback", () => {
    const env = toServerEnv({ ...DEFAULTS, ai: "builtin", forceCpu: true }, paths);
    expect(env).toMatchObject({ AI_PROVIDER: "builtin", MODEL_PATH: "/m.gguf", LLAMA_GPU: "off" });
  });
});

describe("the musician's own facts", () => {
  it("adds their pack only when they've written something", () => {
    expect(topicList({ ...DEFAULTS })).toEqual(DEFAULTS.topics);
    expect(topicList({ ...DEFAULTS, myOriginals: ["About my song."] })[0]).toBe("my-facts");
  });

  it("writes a pack the server can read", () => {
    const facts = path.join(dir, "facts");
    writeMyPack({ ...DEFAULTS, myFacts: ["One."], myOriginals: ["Two."] }, facts);
    const pack = JSON.parse(fs.readFileSync(path.join(facts, "my-facts.json"), "utf8"));
    expect(pack).toMatchObject({ id: "my-facts", curatedFacts: ["One."], originalsFacts: ["Two."] });
  });
});
