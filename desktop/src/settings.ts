import { app, safeStorage } from "electron";
import fs from "fs";
import path from "path";
import { writeFileAtomic } from "./atomic-write";
import { shareAddress } from "./checks";
import type { Edition } from "./build";
import { AiQuality, modelFor, modelPath } from "./model";

/** Everything the musician can change; secrets encrypted on disk with the system keychain */
export interface Settings {
  setupComplete: boolean;
  /** Where song requests come from */
  songSource: "streamersonglist" | "streamelements" | "nowplaying";
  /** StreamerSongList channel name */
  channel: string;
  token: string;
  /** "oauth": the app's own sign-in; the rest: tokens pasted by hand */
  tokenKind: "oauth" | "streamer" | "user" | "bearer";
  refreshToken: string;
  /** When the signed-in token runs out, ms since 1970 */
  tokenExpiresAt: number;
  streamerId: number;
  /** Connect Twitch (optional, #47): reads music content creators' public About text */
  twitchToken: string;
  twitchRefreshToken: string;
  twitchTokenExpiresAt: number;
  twitchLogin: string;
  /** Unknown song by an artist named exactly like a channel: a fact from its About */
  twitchAbout: boolean;
  /** StreamElements channel, filled in from the token when tested */
  seChannel: string;
  /** StreamElements JWT: dashboard, Account, Channels, Show secrets */
  seJwt: string;
  /** "streamling" or "nightbot": that app's own file or folder; "none": `nowPlayingFile` */
  nowPlayingPreset: "streamling" | "nightbot" | "none";
  /** Text file another app writes the song to, from the file picker */
  nowPlayingFile: string;
  /** Its line: "Artist - Title", or the title alone */
  nowPlayingFormat: "artist-title" | "title";
  displayName: string;
  /** Unused, never sent; kept so files that have it still load */
  instrument: string;
  /** From setup: "I play my own compositions", "I do live learns" */
  originals: boolean;
  liveLearns: boolean;
  /** Prepare my songs (#293, #295): facts written ahead, while OBS is closed and plugged in; off by default */
  prepareSongs: boolean;
  /** NOW PLAYING bubble on a song change */
  nowPlaying: boolean;
  /** Credit bubble (where facts come from, how to report one): first, then about every 5 songs; off = once a stream */
  creditBubble: boolean;
  liveLearnBanner: boolean;
  /** Share song facts with other apps (off by default): song and facts go to `shareUrl` (server's share-song-facts.ts) */
  shareFacts: boolean;
  /** https, or http on this computer */
  shareUrl: string;
  /** Channel the key belongs to */
  shareChannel: string;
  shareKey: string;
  /** Custom facts, one per line in Settings */
  myFacts: string[];
  myOriginals: string[];
  /** "builtin": the built-in AI, or no AI in Lite */
  ai: "builtin" | "groq" | "anthropic" | "ollama";
  /** Built-in model: the small default, or the bigger one (model.ts) */
  aiQuality: AiQuality;
  groqKey: string;
  anthropicKey: string;
  ollamaUrl: string;
  ollamaModel: string;
  /** Bubble size on stream (BUBBLE_SCALE) */
  bubbleSize: "standard" | "large" | "larger";
  /** Part of the screen bubbles keep to */
  bubbleArea:
    | "anywhere" | "top" | "bottom" | "left" | "right"
    | "top-left" | "top-center" | "top-right" | "bottom-left" | "bottom-center" | "bottom-right";
  /** Vertical overlay (phone-shaped streams): its own size and spots */
  verticalBubbleSize: "standard" | "large" | "larger";
  verticalArea: "top" | "above-chat";
  /** The look (#177), both overlays */
  bubbleStyle: BubbleStyle;
  /** Icon at each bubble's left; "style" = the Style's own */
  bubbleIcon: BubbleIcon;
  /** Own accent and background over the Style, each #rrggbb; text color picked for contrast */
  customColors: boolean;
  accentColor: string;
  backgroundColor: string;
  /** Bubbles per song, 1 to 12 */
  factsPerSong: number;
  /** Seconds between bubbles, 3 to 300 */
  intervalSeconds: number;
  /** Minimum seconds on screen, 2 to 120 */
  durationSeconds: number;
  /** Hands-free Wrong: a key from a foot pedal or Stream Deck, or "off" */
  wrongKey: WrongKey;
  /** The server's port on this computer, 1024 to 65535 */
  port: number;
  startAtLogin: boolean;
  /** Updates offered: full releases only, or betas and release candidates too */
  updateChannel: "stable" | "beta";
  /** Set by the app when the built-in AI's GPU build fails here */
  forceCpu: boolean;
  /** Version whose "What's new" was seen (or skipped on a new install); the app's, not the window's */
  lastVersionSeen: string;
}

/** Hands-free Wrong keys (Electron accelerators): rare combinations only, as a global shortcut takes the key from every app */
export const WRONG_KEYS = {
  off: null,
  "ctrl-alt-w": "Control+Alt+W",
  "ctrl-alt-shift-w": "Control+Alt+Shift+W",
  f13: "F13",
} as const;
export type WrongKey = keyof typeof WRONG_KEYS;

/** Built-in Styles, as the overlay's CSS names them (server's bubble-style.ts); Classic is the dark blue */
export const BUBBLE_STYLES = ["classic", "light", "minimal", "retro", "high-contrast"] as const;
export type BubbleStyle = (typeof BUBBLE_STYLES)[number];

/** Bubble icons, as the server's BUBBLE_ICONS; "style" = each Style's own */
export const BUBBLE_ICONS = ["style", "notes", "heart", "star", "moon", "diamond"] as const;
export type BubbleIcon = (typeof BUBBLE_ICONS)[number];

export const DEFAULTS: Settings = {
  setupComplete: false,
  songSource: "streamersonglist",
  channel: "",
  token: "",
  tokenKind: "streamer",
  refreshToken: "",
  tokenExpiresAt: 0,
  streamerId: 0,
  twitchToken: "",
  twitchRefreshToken: "",
  twitchTokenExpiresAt: 0,
  twitchLogin: "",
  twitchAbout: true,
  seChannel: "",
  seJwt: "",
  nowPlayingPreset: "streamling",
  nowPlayingFile: "",
  nowPlayingFormat: "artist-title",
  displayName: "",
  instrument: "",
  originals: false,
  liveLearns: true,
  prepareSongs: false,
  nowPlaying: true,
  creditBubble: true,
  liveLearnBanner: true,
  shareFacts: false,
  shareUrl: "",
  shareChannel: "",
  shareKey: "",
  myFacts: [],
  myOriginals: [],
  ai: "builtin",
  aiQuality: "standard",
  groqKey: "",
  anthropicKey: "",
  ollamaUrl: "http://localhost:11434",
  ollamaModel: "llama3.2",
  bubbleSize: "standard",
  bubbleArea: "anywhere",
  verticalBubbleSize: "standard",
  verticalArea: "top",
  bubbleStyle: "classic",
  bubbleIcon: "style",
  customColors: false,
  // Classic's own, so custom colors start from the look already on stream
  accentColor: "#5b6ee1",
  backgroundColor: "#0a0a3c",
  factsPerSong: 5,
  intervalSeconds: 15,
  durationSeconds: 8,
  wrongKey: "off",
  port: 3000,
  startAtLogin: false,
  updateChannel: "stable",
  forceCpu: false,
  lastVersionSeen: "",
};

const SECRET_KEYS = ["token", "refreshToken", "seJwt", "groqKey", "anthropicKey", "shareKey", "twitchToken", "twitchRefreshToken"] as const;
const file = () => path.join(app.getPath("userData"), "settings.json");


function encrypt(value: string): string {
  if (!value) return "";
  return safeStorage.isEncryptionAvailable()
    ? "enc:" + safeStorage.encryptString(value).toString("base64")
    : "plain:" + value;
}

/** Blank for a secret that can't be read (keychain changed, say); the other settings survive */
function decrypt(stored: string): string {
  if (!stored) return "";
  try {
    if (stored.startsWith("enc:")) return safeStorage.decryptString(Buffer.from(stored.slice(4), "base64"));
  } catch {
    return "";
  }
  return stored.startsWith("plain:") ? stored.slice(6) : "";
}

/** Beta for a beta or release candidate copy (whoever runs one is testing), else Stable */
const firstChannel = (): Settings["updateChannel"] => (app.getVersion().includes("-") ? "beta" : "stable");

/** Saved secrets not read yet (`loadSettings(false)`); nothing is saved meanwhile, or they'd be stored blank */
let secretsPending = false;
export const secretsWaiting = () => secretsPending;

/** A saved value has its default's type: a list of strings, or the same primitive */
const sameType = (value: unknown, fallback: unknown): boolean =>
  Array.isArray(fallback) ? Array.isArray(value) && value.every((v) => typeof v === "string") : typeof value === typeof fallback;

const READ_RETRIES = 3;    // retries when the file is locked (antivirus, OneDrive), not missing
const READ_RETRY_MS = 150; // ms between them

/** File couldn't be read (locked): defaults stand in and nothing is saved over it */
let readFailed = false;

/** Saved settings text, retried while locked; null with no file */
function readSettingsFile(): string | null {
  for (let attempt = 0; ; attempt++) {
    try {
      return fs.readFileSync(file(), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (attempt >= READ_RETRIES) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, READ_RETRY_MS);
    }
  }
}

/** Saved settings; `readSecrets` false leaves secrets for `unlockSecrets`, as reading them brings macOS's prompt */
export function loadSettings(readSecrets = true): Settings {
  let raw: Record<string, unknown>;
  let text: string | null;
  try {
    text = readSettingsFile();
  } catch (err) {
    // Locked, not broken: defaults for now, file and sign-in left for the next load, not renamed away
    readFailed = true;
    console.error(`[App] Couldn't read settings.json (${(err as NodeJS.ErrnoException).code ?? err}); using defaults for now and not saving.`);
    return { ...DEFAULTS, updateChannel: firstChannel() };
  }
  readFailed = false;
  if (text === null) return { ...DEFAULTS, updateChannel: firstChannel() };
  try {
    raw = JSON.parse(text);
    if (!raw || typeof raw !== "object") throw new Error("not an object");
  } catch {
    // Read but isn't settings: kept for a problem report, not overwritten
    try {
      fs.renameSync(file(), file() + ".unreadable");
    } catch {
      // Start from the defaults
    }
    return { ...DEFAULTS, updateChannel: firstChannel() };
  }
  const settings: Settings = { ...DEFAULTS };
  const target = settings as unknown as Record<string, unknown>;
  // A value of the wrong type keeps the default
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const value = raw[key];
    const ok = sameType(value, fallback);
    if (ok) target[key] = value;
  }
  if (!("updateChannel" in raw)) {
    // Saved before update channels: someone running a beta is a tester and stays on Beta
    settings.updateChannel = firstChannel();
    // Written now, so it survives updating to a full release before any save
    try {
      writeFileAtomic(file(), JSON.stringify({ ...raw, updateChannel: settings.updateChannel }, null, 2), { mode: 0o600 });
    } catch {
      // Worked out again next time
    }
  }
  const saved = (key: string) => (typeof raw[key] === "string" ? (raw[key] as string) : "");
  secretsPending = !readSecrets && SECRET_KEYS.some((key) => saved(key).startsWith("enc:"));
  for (const key of SECRET_KEYS) settings[key] = secretsPending ? "" : decrypt(saved(key));
  return sanitize(settings);
}

/** Reads the secrets `loadSettings(false)` left; waits on macOS's keychain prompt */
export function unlockSecrets(settings: Settings): Settings {
  if (!secretsPending) return settings;
  secretsPending = false;
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(file(), "utf8"));
  } catch {
    // File gone since: secrets stay blank
  }
  const out = { ...settings };
  for (const key of SECRET_KEYS) out[key] = decrypt(typeof raw[key] === "string" ? (raw[key] as string) : "");
  return sanitize(out);
}

const clamp = (n: number, min: number, max: number, fallback: number) =>
  Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
const oneOf = <T>(value: T, allowed: readonly T[], fallback: T) => (allowed.includes(value) ? value : fallback);
/** #rrggbb (as a color picker gives it), lowercased, else fallback; same rule as hexColor in bubble-style.ts: keep alike */
const hexColor = (value: string, fallback: string) => (/^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim().toLowerCase() : fallback);

/** Every value within what the server accepts, so no setting can stop it starting */
export function sanitize(s: Settings): Settings {
  const lines = (list: string[]) => list.map((l) => l.trim()).filter(Boolean).slice(0, 500);
  return {
    ...s,
    songSource: oneOf(s.songSource, ["streamersonglist", "streamelements", "nowplaying"] as const, "streamersonglist"),
    nowPlayingPreset: oneOf(s.nowPlayingPreset, ["streamling", "nightbot", "none"] as const, "streamling"),
    nowPlayingFormat: oneOf(s.nowPlayingFormat, ["artist-title", "title"] as const, "artist-title"),
    nowPlayingFile: s.nowPlayingFile.trim(),
    tokenKind: oneOf(s.tokenKind, ["oauth", "streamer", "user", "bearer"] as const, "streamer"),
    ai: oneOf(s.ai, ["builtin", "groq", "anthropic", "ollama"] as const, "builtin"),
    aiQuality: oneOf(s.aiQuality, ["standard", "high"] as const, "standard"),
    bubbleSize: oneOf(s.bubbleSize, ["standard", "large", "larger"] as const, "standard"),
    bubbleArea: oneOf(s.bubbleArea, ["anywhere", "top", "bottom", "left", "right", "top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"] as const, "anywhere"),
    verticalBubbleSize: oneOf(s.verticalBubbleSize, ["standard", "large", "larger"] as const, "standard"),
    verticalArea: oneOf(s.verticalArea, ["top", "above-chat"] as const, "top"),
    bubbleStyle: oneOf(s.bubbleStyle, BUBBLE_STYLES, "classic"),
    bubbleIcon: oneOf(s.bubbleIcon, BUBBLE_ICONS, "style"),
    accentColor: hexColor(s.accentColor, DEFAULTS.accentColor),
    backgroundColor: hexColor(s.backgroundColor, DEFAULTS.backgroundColor),
    myFacts: lines(s.myFacts),
    myOriginals: lines(s.myOriginals),
    factsPerSong: clamp(s.factsPerSong, 1, 12, DEFAULTS.factsPerSong),
    intervalSeconds: clamp(s.intervalSeconds, 3, 300, DEFAULTS.intervalSeconds),
    durationSeconds: clamp(s.durationSeconds, 2, 120, DEFAULTS.durationSeconds),
    wrongKey: oneOf(s.wrongKey, Object.keys(WRONG_KEYS) as WrongKey[], "off"),
    updateChannel: oneOf(s.updateChannel, ["stable", "beta"] as const, "stable"),
    port: clamp(s.port, 1024, 65535, DEFAULTS.port),
    channel: s.channel.trim(),
    seChannel: s.seChannel.trim(),
    seJwt: s.seJwt.trim(),
    shareUrl: shareAddress(s.shareUrl) ?? "",
    shareChannel: s.shareChannel.trim().replace(/^@/, ""),
    shareKey: s.shareKey.trim(),
    ollamaUrl: webAddress(s.ollamaUrl) ?? DEFAULTS.ollamaUrl,
  };
}

export const CUSTOM_FACT_LENGTH = 300; // characters, as for song facts (SONG_FACT_LIMITS in song-facts.ts)
/** Only the text after a [tag] shows, so only it counts: "[Song of Storms] It plays in a windmill." */
const bubbleText = (line: string) => line.trim().replace(/^\[[^\]]+\]\s*/, "");

/**
 * Why custom facts can't be saved as typed (refused, never trimmed), or null. Only lists in `changes`
 * are checked, so an older save's long line blocks nothing else
 */
export function customFactsProblem(changes: Partial<Pick<Settings, "myFacts" | "myOriginals">>): string | null {
  const lists = [["Your own facts", changes.myFacts], ["About your own compositions", changes.myOriginals]] as const;
  for (const [name, list] of lists) {
    const lines = (list ?? []).map((l) => l.trim()).filter(Boolean);
    const long = lines.findIndex((l) => bubbleText(l).length > CUSTOM_FACT_LENGTH);
    if (long >= 0) return `${name}: fact ${long + 1} is ${bubbleText(lines[long]).length} characters. Shorten it to ${CUSTOM_FACT_LENGTH} or fewer to save.`;
  }
  return null;
}

/** Why the sharing address can't be saved as typed, or null; refused, as `sanitize` would blank it */
export function shareUrlProblem(changes: Partial<Pick<Settings, "shareUrl">>): string | null {
  if (!changes.shareUrl || shareAddress(changes.shareUrl)) return null;
  return "The sharing address must start with https:// (http:// is fine only on this computer).";
}

/** An http or https address, or null: Ollama is only reached over those */
function webAddress(s: string): string | null {
  try {
    const url = new URL(s.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? s.trim() : null;
  } catch {
    return null;
  }
}

/** What the window may change; sign-in details and automatic fallbacks are the app's */
export const EDITABLE: ReadonlyArray<keyof Settings> = [
  "setupComplete", "songSource", "channel", "token", "seChannel", "seJwt", "nowPlayingPreset", "nowPlayingFile", "nowPlayingFormat", "displayName", "instrument", "originals", "liveLearns", "prepareSongs", "twitchAbout", "nowPlaying", "creditBubble", "liveLearnBanner", "shareFacts", "shareUrl", "shareChannel", "shareKey",
  "myFacts", "myOriginals", "ai", "aiQuality", "groqKey", "anthropicKey", "ollamaUrl", "ollamaModel",
  "bubbleSize", "bubbleArea", "verticalBubbleSize", "verticalArea", "bubbleStyle", "bubbleIcon", "customColors", "accentColor", "backgroundColor", "factsPerSong", "intervalSeconds", "durationSeconds", "wrongKey", "port", "startAtLogin",
  "updateChannel",
];

/** The window's changes: editable keys with the right type only */
export function fromWindow(changes: Record<string, unknown>): Partial<Settings> {
  const out: Record<string, unknown> = {};
  for (const key of EDITABLE) {
    if (!(key in changes)) continue;
    const value = changes[key];
    const fallback = DEFAULTS[key];
    const ok = sameType(value, fallback);
    if (ok) out[key] = value;
  }
  return out as Partial<Settings>;
}

/** settings.json format; raise when a later version must convert older files */
export const SETTINGS_VERSION = 1;
/** Old keys not carried forward: "topics" held example packs, now custom facts only */
const RETIRED_KEYS = new Set(["topics"]);

/** Settings `sanitize` holds to a list of values */
export const ENUM_KEYS = ["songSource", "nowPlayingPreset", "nowPlayingFormat", "tokenKind", "ai", "aiQuality", "bubbleSize", "bubbleArea", "bubbleStyle", "bubbleIcon", "verticalBubbleSize", "verticalArea", "wrongKey", "updateChannel"] as const;

export function saveSettings(settings: Settings): void {
  if (secretsPending || readFailed) return;
  // Keys a newer version saved are kept: back a version and forward again loses nothing
  let kept: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(fs.readFileSync(file(), "utf8")) as Record<string, unknown>;
    kept = Object.fromEntries(Object.entries(raw).filter(([k]) => !(k in DEFAULTS) && !RETIRED_KEYS.has(k)));
    // A newer version's choice ("ai": "gemini") is a safe default in memory; while it still is, the saved one stays
    for (const key of ENUM_KEYS) {
      const saved = raw[key];
      if (typeof saved !== "string") continue;
      const safe = sanitize({ ...settings, [key]: saved })[key];
      if (safe !== saved && settings[key] === safe) kept[key] = saved;
    }
  } catch {
    // No file yet, or unreadable: nothing to keep
  }
  // A newer version's higher number stays: the file may hold what only it understands
  const version = Math.max(SETTINGS_VERSION, typeof kept.settingsVersion === "number" ? kept.settingsVersion : 0);
  const stored: Record<string, unknown> = { ...settings, ...kept, settingsVersion: version };
  for (const key of SECRET_KEYS) stored[key] = encrypt(settings[key]);
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  writeFileAtomic(file(), JSON.stringify(stored, null, 2), { mode: 0o600 });
}

/**
 * Saved secrets lack real protection: on Linux with no keyring, Electron "encrypts" with a fixed password
 * (basic_text) while isEncryptionAvailable() stays true (electronjs.org/docs/latest/api/safe-storage)
 */
export function secretsUnprotected(): boolean {
  // Only Linux can lack a keyring; on a Mac asking reads the keychain, which after an update prompts before the window can explain (#62)
  if (process.platform !== "linux") return false;
  if (!safeStorage.isEncryptionAvailable()) return true;
  const backend = (safeStorage as { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend?.();
  return !backend || backend === "basic_text" || backend === "unknown";
}

/** The settings as the server's environment variables */
export function toServerEnv(
  s: Settings,
  paths: { modelsDir: string; logDir: string; topicsDir: string; clientId: string; documentsDir?: string; edition?: Edition }
): Record<string, string> {
  const env: Record<string, string> = {
    // Own pack only, never topics/; "none", as an empty variable can get lost and a missing one means the examples
    TOPIC: topicList(s).join(",") || "none",
    BUBBLEFACTS_TOPICS_DIR: paths.topicsDir,
    ORIGINALS: s.originals ? "on" : "off",
    LIVE_LEARNS: s.liveLearns ? "on" : "off",
    NOW_PLAYING: s.nowPlaying ? "on" : "off",
    CREDIT_BUBBLE: s.creditBubble ? "on" : "off",
    LIVE_LEARN_BANNER: s.liveLearnBanner ? "on" : "off",
    BUBBLE_AREA: s.bubbleArea,
    VERTICAL_AREA: s.verticalArea,
    ...styleEnv(s),
    FACTS_PER_SONG: String(s.factsPerSong),
    FACT_INTERVAL_SECONDS: String(s.intervalSeconds),
    FACT_DURATION_SECONDS: String(s.durationSeconds),
    PORT: String(s.port),
    HOST: "127.0.0.1",
    BUBBLEFACTS_LOG_DIR: paths.logDir,
    NODE_ENV: "production",
  };
  // The system's Documents, for the Streamling and Nightbot presets: tried before the home folder's
  if (paths.documentsDir) env.BUBBLEFACTS_DOCUMENTS_DIR = paths.documentsDir;
  if (s.songSource === "streamelements") {
    Object.assign(env, { SONG_SOURCE: "streamelements", SE_JWT: s.seJwt });
    if (s.seChannel) env.SE_CHANNEL = s.seChannel;
  } else if (s.songSource === "nowplaying") {
    env.SONG_SOURCE = "nowplaying";
    if (s.nowPlayingPreset === "streamling") {
      // Known folder, "Artist - Song" or a YouTube title: nothing to choose
      Object.assign(env, { NOW_PLAYING_PRESET: "streamling", NOW_PLAYING_FORMAT: "youtube-title" });
    } else if (s.nowPlayingPreset === "nightbot") {
      // Known folder, but file name and line are the streamer's: the newest .txt, read as a YouTube title
      Object.assign(env, { NOW_PLAYING_PRESET: "nightbot", NOW_PLAYING_FORMAT: "youtube-title" });
    } else {
      Object.assign(env, { NOW_PLAYING_PRESET: "none", NOW_PLAYING_FILE: s.nowPlayingFile, NOW_PLAYING_FORMAT: s.nowPlayingFormat });
    }
  } else {
    Object.assign(env, {
      // A name to talk about the streamer; signed in, the ID is what it follows
      SSL_STREAMER_NAME: s.channel || s.displayName || "The streamer",
      SSL_ACCESS_TOKEN: s.token,
      SSL_TOKEN_KIND: s.tokenKind === "oauth" ? "bearer" : s.tokenKind,
    });
    if (s.tokenKind === "oauth") Object.assign(env, { SSL_CLIENT_ID: paths.clientId, SSL_STREAMER_ID: String(s.streamerId) });
  }
  if (s.shareFacts && s.shareUrl && s.shareChannel && s.shareKey) Object.assign(env, { SHARE_FACTS_URL: s.shareUrl, SHARE_FACTS_CHANNEL: s.shareChannel, SHARE_FACTS_KEY: s.shareKey });
  if (s.displayName) env.STREAMER_DISPLAY_NAME = s.displayName;
  // Lite has no AI engine: no AI, no model loaded
  if (s.ai === "builtin" && paths.edition === "lite") env.AI_PROVIDER = "none";
  else if (s.ai === "builtin") Object.assign(env, { AI_PROVIDER: "builtin", MODEL_PATH: modelPath(paths.modelsDir, modelFor(s.aiQuality)), LLAMA_GPU: s.forceCpu ? "off" : "auto" });
  if (s.ai === "groq") Object.assign(env, { AI_PROVIDER: "openai", OPENAI_API_KEY: s.groqKey });
  if (s.ai === "anthropic") Object.assign(env, { AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: s.anthropicKey });
  if (s.ai === "ollama") Object.assign(env, { AI_PROVIDER: "ollama", OLLAMA_BASE_URL: s.ollamaUrl, OLLAMA_MODEL: s.ollamaModel });
  return env;
}

/** The chosen song source has what it needs to start */
export function songSourceReady(s: Settings): boolean {
  if (s.songSource === "streamelements") return !!s.seJwt;
  // The server knows where Streamling's and Nightbot's files are; another app's needs one chosen
  if (s.songSource === "nowplaying") return s.nowPlayingPreset !== "none" || !!s.nowPlayingFile;
  // The app's own sign-in follows the channel by ID, so no name is needed
  return !!s.token && (!!s.channel || (s.tokenKind === "oauth" && s.streamerId > 0));
}

/** Values never to appear in a report */
export const secretsOf = (s: Settings) => SECRET_KEYS.map((k) => s[k]).filter((v) => v.length >= 6);

/** The musician's own pack: a topic file the server reads first */
export const MY_PACK = "my-facts";

export function topicList(s: Settings): string[] {
  return s.myFacts.length || s.myOriginals.length ? [MY_PACK] : [];
}

/** The look as the server reads it; colors blank when custom colors are off, so the server reverts to the Style's */
export function styleEnv(s: Settings): { BUBBLE_STYLE: string; BUBBLE_ICON: string; BUBBLE_ACCENT: string; BUBBLE_BACKGROUND: string; BUBBLE_SCALE: string; BUBBLE_VERTICAL_SCALE: string } {
  return {
    BUBBLE_STYLE: s.bubbleStyle,
    BUBBLE_ICON: s.bubbleIcon,
    BUBBLE_ACCENT: s.customColors ? s.accentColor : "",
    BUBBLE_BACKGROUND: s.customColors ? s.backgroundColor : "",
    // Size goes live too: no Refresh in OBS
    BUBBLE_SCALE: String(BUBBLE_SCALE[s.bubbleSize]),
    BUBBLE_VERTICAL_SCALE: String(VERTICAL_BUBBLE_SCALE[s.verticalBubbleSize]),
  };
}

/** All the server reads at start (environment, own facts pack) as one string; not the token, handed over live */
export function serverSettingsSignature(env: Record<string, string>, s: Settings): string {
  // The look goes live (POST /control/style), so a new one never restarts the server
  const { SSL_ACCESS_TOKEN: _token, BUBBLE_STYLE: _style, BUBBLE_ICON: _icon, BUBBLE_ACCENT: _accent, BUBBLE_BACKGROUND: _background, BUBBLE_SCALE: _scale, BUBBLE_VERTICAL_SCALE: _verticalScale, ...rest } = env;
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

/** Bubble size, as a multiple of Standard */
export const BUBBLE_SCALE: Record<Settings["bubbleSize"], number> = { standard: 1, large: 1.25, larger: 1.5 };
/** Same, vertical: smaller steps, as Standard is already phone-sized and the clear area short */
export const VERTICAL_BUBBLE_SCALE: Record<Settings["verticalBubbleSize"], number> = { standard: 1, large: 1.15, larger: 1.3 };
