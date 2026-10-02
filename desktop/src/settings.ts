import { app, safeStorage } from "electron";
import fs from "fs";
import path from "path";

/** Everything the musician can change. Secrets are encrypted on disk with the system keychain. */
export interface Settings {
  setupComplete: boolean;
  /** Where song requests come from. StreamerSongList is the default. */
  songSource: "streamersonglist" | "streamelements";
  /** StreamerSongList channel name. */
  channel: string;
  token: string;
  /** "oauth" is the app's own sign-in; the others are tokens pasted by hand. */
  tokenKind: "oauth" | "streamer" | "user" | "bearer";
  refreshToken: string;
  /** When the signed-in access token runs out, in milliseconds since 1970. */
  tokenExpiresAt: number;
  streamerId: number;
  /** StreamElements channel name, filled in from the token when it's tested. */
  seChannel: string;
  /** StreamElements JWT token, from the dashboard's Account, Channels, Show secrets. */
  seJwt: string;
  displayName: string;
  instrument: string;
  topics: string[];
  /** "I play my own compositions" and "I do live learns", from setup. */
  originals: boolean;
  liveLearns: boolean;
  /** The musician's own custom facts, one per line in Settings. */
  myFacts: string[];
  myOriginals: string[];
  ai: "builtin" | "groq" | "anthropic" | "ollama";
  groqKey: string;
  anthropicKey: string;
  ollamaUrl: string;
  ollamaModel: string;
  /** How big the bubbles are on stream. */
  bubbleSize: "standard" | "large" | "larger";
  factsPerSong: number;
  intervalSeconds: number;
  durationSeconds: number;
  port: number;
  startAtLogin: boolean;
  /** Set automatically when the GPU build of the built-in AI fails on this computer. */
  forceCpu: boolean;
}

export const DEFAULTS: Settings = {
  setupComplete: false,
  songSource: "streamersonglist",
  channel: "",
  token: "",
  tokenKind: "streamer",
  refreshToken: "",
  tokenExpiresAt: 0,
  streamerId: 0,
  seChannel: "",
  seJwt: "",
  displayName: "",
  instrument: "",
  // The example packs are opt-in: without them, a song with no source shows nothing (issue #18).
  topics: [],
  originals: false,
  liveLearns: true,
  myFacts: [],
  myOriginals: [],
  ai: "builtin",
  groqKey: "",
  anthropicKey: "",
  ollamaUrl: "http://localhost:11434",
  ollamaModel: "llama3.2",
  bubbleSize: "standard",
  factsPerSong: 5,
  intervalSeconds: 15,
  durationSeconds: 8,
  port: 3000,
  startAtLogin: false,
  forceCpu: false,
};

const SECRET_KEYS = ["token", "refreshToken", "seJwt", "groqKey", "anthropicKey"] as const;
const file = () => path.join(app.getPath("userData"), "settings.json");


function encrypt(value: string): string {
  if (!value) return "";
  return safeStorage.isEncryptionAvailable()
    ? "enc:" + safeStorage.encryptString(value).toString("base64")
    : "plain:" + value;
}

/** A secret that can't be read (the keychain changed, say) comes back blank; the rest of the settings survive. */
function decrypt(stored: string): string {
  if (!stored) return "";
  try {
    if (stored.startsWith("enc:")) return safeStorage.decryptString(Buffer.from(stored.slice(4), "base64"));
  } catch {
    return "";
  }
  return stored.startsWith("plain:") ? stored.slice(6) : "";
}

export function loadSettings(): Settings {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(file(), "utf8"));
    if (!raw || typeof raw !== "object") throw new Error("not an object");
  } catch (err) {
    // Keep an unreadable file for a problem report instead of overwriting it.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      try {
        fs.renameSync(file(), file() + ".unreadable");
      } catch {
        // Nothing more to do: start from the defaults.
      }
    }
    return { ...DEFAULTS };
  }
  const settings: Settings = { ...DEFAULTS };
  const target = settings as unknown as Record<string, unknown>;
  // Each value must have the type its default has; anything else falls back to the default.
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const value = raw[key];
    const ok = Array.isArray(fallback)
      ? Array.isArray(value) && value.every((v) => typeof v === "string")
      : typeof value === typeof fallback;
    if (ok) target[key] = value;
  }
  // Before 2.0.0-beta.3 every install started with these example packs checked.
  // Left unchanged, they're dropped: the examples are opt-in now (issue #18).
  // Only for settings saved before beta.3 (no songSource yet), so a streamer who checks these later keeps them.
  if (!("songSource" in raw) && settings.topics.join(",") === OLD_DEFAULT_TOPICS) settings.topics = [];
  for (const key of SECRET_KEYS) settings[key] = decrypt(typeof raw[key] === "string" ? (raw[key] as string) : "");
  return sanitize(settings);
}

const OLD_DEFAULT_TOPICS = "video-game,classical,film,pop,general";

const clamp = (n: number, min: number, max: number, fallback: number) =>
  Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
const oneOf = <T>(value: T, allowed: readonly T[], fallback: T) => (allowed.includes(value) ? value : fallback);
export const TOPICS = ["video-game", "classical", "film", "pop", "piano", "general"];

/** Keep every value in a range the server accepts, so no setting can stop it from starting. */
export function sanitize(s: Settings): Settings {
  const lines = (list: string[]) => list.map((l) => l.trim()).filter(Boolean).slice(0, 500);
  return {
    ...s,
    songSource: oneOf(s.songSource, ["streamersonglist", "streamelements"] as const, "streamersonglist"),
    tokenKind: oneOf(s.tokenKind, ["oauth", "streamer", "user", "bearer"] as const, "streamer"),
    ai: oneOf(s.ai, ["builtin", "groq", "anthropic", "ollama"] as const, "builtin"),
    bubbleSize: oneOf(s.bubbleSize, ["standard", "large", "larger"] as const, "standard"),
    topics: s.topics.filter((t) => TOPICS.includes(t)),
    myFacts: lines(s.myFacts),
    myOriginals: lines(s.myOriginals),
    factsPerSong: clamp(s.factsPerSong, 1, 12, DEFAULTS.factsPerSong),
    intervalSeconds: clamp(s.intervalSeconds, 3, 300, DEFAULTS.intervalSeconds),
    durationSeconds: clamp(s.durationSeconds, 2, 120, DEFAULTS.durationSeconds),
    port: clamp(s.port, 1024, 65525, DEFAULTS.port),
    channel: s.channel.trim(),
    seChannel: s.seChannel.trim(),
    seJwt: s.seJwt.trim(),
  };
}

/** What the window may change. Sign-in details and automatic fallbacks belong to the app. */
export const EDITABLE: ReadonlyArray<keyof Settings> = [
  "setupComplete", "songSource", "channel", "token", "seChannel", "seJwt", "displayName", "instrument", "topics", "originals", "liveLearns",
  "myFacts", "myOriginals", "ai", "groqKey", "anthropicKey", "ollamaUrl", "ollamaModel",
  "bubbleSize", "factsPerSong", "intervalSeconds", "durationSeconds", "port", "startAtLogin",
];

/** The window's changes, keeping only editable keys whose values have the right type. */
export function fromWindow(changes: Record<string, unknown>): Partial<Settings> {
  const out: Record<string, unknown> = {};
  for (const key of EDITABLE) {
    if (!(key in changes)) continue;
    const value = changes[key];
    const fallback = DEFAULTS[key];
    const ok = Array.isArray(fallback)
      ? Array.isArray(value) && value.every((v) => typeof v === "string")
      : typeof value === typeof fallback;
    if (ok) out[key] = value;
  }
  return out as Partial<Settings>;
}

export function saveSettings(settings: Settings): void {
  const stored: Record<string, unknown> = { ...settings };
  for (const key of SECRET_KEYS) stored[key] = encrypt(settings[key]);
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(stored, null, 2), { mode: 0o600 });
}

/** True when secrets can only be stored unencrypted (some Linux desktops without a keyring). */
/**
 * Whether saved secrets lack real protection. On Linux, Electron can "encrypt"
 * with a fixed built-in password when no keyring (GNOME Keyring, KWallet) is
 * running: the basic_text backend. isEncryptionAvailable() is still true
 * then, so the backend has to be checked too (review).
 * https://www.electronjs.org/docs/latest/api/safe-storage
 */
export function secretsUnprotected(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return true;
  if (process.platform !== "linux") return false;
  const backend = (safeStorage as { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend?.();
  return !backend || backend === "basic_text" || backend === "unknown";
}

/** The settings as the server's environment variables. */
export function toServerEnv(
  s: Settings,
  paths: { modelPath: string; logDir: string; topicsDir: string; clientId: string }
): Record<string, string> {
  const env: Record<string, string> = {
    // "none", not an empty value: an empty variable can get lost on the way, and a missing one means the example packs.
    TOPIC: topicList(s).join(",") || "none",
    BUBBLEFACTS_TOPICS_DIR: paths.topicsDir,
    ORIGINALS: s.originals ? "on" : "off",
    LIVE_LEARNS: s.liveLearns ? "on" : "off",
    FACTS_PER_SONG: String(s.factsPerSong),
    FACT_INTERVAL_SECONDS: String(s.intervalSeconds),
    FACT_DURATION_SECONDS: String(s.durationSeconds),
    PORT: String(s.port),
    HOST: "127.0.0.1",
    BUBBLEFACTS_LOG_DIR: paths.logDir,
    NODE_ENV: "production",
  };
  if (s.songSource === "streamelements") {
    Object.assign(env, { SONG_SOURCE: "streamelements", SE_JWT: s.seJwt });
    if (s.seChannel) env.SE_CHANNEL = s.seChannel;
  } else {
    Object.assign(env, {
      // The server needs a name to talk about the streamer; the ID, when signed in, is what it follows.
      SSL_STREAMER_NAME: s.channel || s.displayName || "The streamer",
      SSL_ACCESS_TOKEN: s.token,
      SSL_TOKEN_KIND: s.tokenKind === "oauth" ? "bearer" : s.tokenKind,
    });
    if (s.tokenKind === "oauth") Object.assign(env, { SSL_CLIENT_ID: paths.clientId, SSL_STREAMER_ID: String(s.streamerId) });
  }
  if (s.displayName) env.STREAMER_DISPLAY_NAME = s.displayName;
  if (s.instrument) env.INSTRUMENT = s.instrument;
  if (s.ai === "builtin") Object.assign(env, { AI_PROVIDER: "builtin", MODEL_PATH: paths.modelPath, LLAMA_GPU: s.forceCpu ? "off" : "auto" });
  if (s.ai === "groq") Object.assign(env, { AI_PROVIDER: "openai", OPENAI_API_KEY: s.groqKey });
  if (s.ai === "anthropic") Object.assign(env, { AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: s.anthropicKey });
  if (s.ai === "ollama") Object.assign(env, { AI_PROVIDER: "ollama", OLLAMA_BASE_URL: s.ollamaUrl, OLLAMA_MODEL: s.ollamaModel });
  return env;
}

/** The chosen song source has what it needs to start. */
export function songSourceReady(s: Settings): boolean {
  if (s.songSource === "streamelements") return !!s.seJwt;
  // The app's own sign-in follows the channel by its ID, so a missing name doesn't hold it up.
  return !!s.token && (!!s.channel || (s.tokenKind === "oauth" && s.streamerId > 0));
}

/** Values that must never appear in a report. */
export const secretsOf = (s: Settings) => SECRET_KEYS.map((k) => s[k]).filter((v) => v.length >= 6);

/** The musician's own pack, saved as a topic file the server reads first. */
export const MY_PACK = "my-facts";

export function topicList(s: Settings): string[] {
  return s.myFacts.length || s.myOriginals.length ? [MY_PACK, ...s.topics] : s.topics;
}

/**
 * Everything the server reads at start, as one string: its environment and
 * the streamer's own facts (written to a pack it loads once). The sign-in
 * token is left out: a refreshed token is handed to the running server.
 */
export function serverSettingsSignature(env: Record<string, string>, s: Settings): string {
  const { SSL_ACCESS_TOKEN: _token, ...rest } = env;
  return JSON.stringify([Object.entries(rest).sort(([a], [b]) => a.localeCompare(b)), s.myFacts, s.myOriginals]);
}

export function writeMyPack(s: Settings, dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const pack = {
    id: MY_PACK,
    name: "My facts",
    description: "Written by BubbleFacts from the facts in Settings. Edit them there.",
    curatedFacts: s.myFacts,
    originalsFacts: s.myOriginals,
  };
  fs.writeFileSync(path.join(dir, `${MY_PACK}.json`), JSON.stringify(pack, null, 2));
}

export const BUBBLE_SCALE: Record<Settings["bubbleSize"], number> = { standard: 1, large: 1.25, larger: 1.5 };
