import dotenv from "dotenv";
import os from "os";
import path from "path";
import { presetFolder } from "./now-playing-folder";
import { shareAddress } from "./share-song-facts";
import { styleFrom } from "./bubble-style";

// Every setting, from .env or the environment; each explained in docs/CONFIG.md
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

function requireEnv(name: string, hint = ""): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required setting ${name}.${hint ? " " + hint : ""}`);
  return value;
}

/** Whole number from min to max, else a startup error naming the value. */
function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}, got "${raw}"`);
  }
  return value;
}

function numberEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number from ${min} to ${max}, got "${raw}"`);
  }
  return value;
}

function oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(`${name} must be one of ${allowed.join(", ")}, got "${raw}"`);
  }
  return raw as T;
}

const aiProvider = oneOf(
  "AI_PROVIDER",
  ["builtin", "ollama", "openai", "anthropic", "none"] as const,
  process.env.ANTHROPIC_API_KEY ? "anthropic" : process.env.OPENAI_API_KEY ? "openai" : "ollama"
);
// Where songs come from; only the chosen source's settings are required
const songSource = oneOf("SONG_SOURCE", ["streamersonglist", "streamelements", "nowplaying"] as const, "streamersonglist");
const onSSL = songSource === "streamersonglist";
const onSE = songSource === "streamelements";
const onFile = songSource === "nowplaying";
const sslHost = oneOf("SSL_ENV", ["production", "staging"] as const, "production") === "staging"
  ? "staging.streamersonglist.com"
  : "streamersonglist.com";
const trimSlash = (s: string) => s.replace(/\/+$/, "");

// Apps that write the playing song to a file: folder in Documents, file ("" = newest .txt), line format
export const NOW_PLAYING_PRESETS = {
  // One "Artist - Song" line, UTF-8, or a YouTube title (Streamling v1.5 release notes)
  streamling: { name: "Streamling", folder: ["streamling", "livetext"], file: "nowplaying-minimal.txt", format: "youtube-title" },
  // A YouTube title; Nightbot's docs name neither file nor line
  nightbot: { name: "Nightbot", folder: ["Nightbot"], file: "", format: "youtube-title" },
} as const;
const nowPlayingPreset = oneOf("NOW_PLAYING_PRESET", ["none", "streamling", "nightbot"] as const, "none");

// Relative to the preset's folder (else the overlay folder); full paths and ~/ as written
function nowPlayingFile(): string {
  const raw = process.env.NOW_PLAYING_FILE?.trim() || "";
  const preset = nowPlayingPreset === "none" ? null : NOW_PLAYING_PRESETS[nowPlayingPreset];
  if (!raw) {
    if (!onFile) return "";
    // No file name: follow the folder instead (nowPlayingFolder)
    if (preset) return preset.file ? path.join(presetFolder(preset.folder), preset.file) : "";
    throw new Error("Missing required setting NOW_PLAYING_FILE. Set it to the full path of the text file your now-playing app writes.");
  }
  if (raw === "~" || /^~[\\/]/.test(raw)) return path.join(os.homedir(), raw.slice(1));
  if (path.isAbsolute(raw)) return raw;
  return preset ? path.join(presetFolder(preset.folder), raw) : path.resolve(__dirname, "../..", raw);
}

// Folder whose newest .txt is the song, when no file is named
function nowPlayingFolder(): string {
  const preset = nowPlayingPreset === "none" ? null : NOW_PLAYING_PRESETS[nowPlayingPreset];
  if (!onFile || !preset || preset.file || process.env.NOW_PLAYING_FILE?.trim()) return "";
  return presetFolder(preset.folder);
}

// Streamer's name for logs: the StreamerSongList or StreamElements channel
const streamerName = onSSL ? requireEnv("SSL_STREAMER_NAME") : process.env.SSL_STREAMER_NAME || process.env.SE_CHANNEL?.trim() || "";

export const config = {
  port: intEnv("PORT", 3000, 1, 65535),
  host: process.env.HOST || "127.0.0.1",                      // this computer only: no sign-in

  songSource,

  // --- Performer and content ---
  // Also holds the StreamElements channel
  sslStreamerName: streamerName,
  streamerDisplayName: process.env.STREAMER_DISPLAY_NAME || streamerName || "the streamer",
  // Topic packs for unknown songs; empty = none (the app's default)
  topic: process.env.TOPIC ?? "video-game,classical,film,pop,general",
  // Streamer's own songs: facts from the song entry, no lookup
  originals: oneOf("ORIGINALS", ["on", "off"] as const, "on") === "on",
  // Off-list requests: LIVE LEARN banner, no facts
  liveLearns: oneOf("LIVE_LEARNS", ["on", "off"] as const, "on") === "on",
  // Part of the screen, or one fixed spot
  bubbleArea: oneOf("BUBBLE_AREA", ["anywhere", "top", "bottom", "left", "right", "top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"] as const, "anywhere"),
  // Same, on the vertical overlay
  verticalArea: oneOf("VERTICAL_AREA", ["top", "above-chat"] as const, "top"),
  // NOW PLAYING bubble on a new song
  nowPlaying: oneOf("NOW_PLAYING", ["on", "off"] as const, "on") === "on",
  // Credit bubble: first, then every 5 songs; off = once a stream (#278)
  creditBubble: oneOf("CREDIT_BUBBLE", ["on", "off"] as const, "on") === "on",
  liveLearnBanner: oneOf("LIVE_LEARN_BANNER", ["on", "off"] as const, "on") === "on",
  // Look (#177). Bad values fall back to Classic, never a startup error
  bubbleStyle: styleFrom(process.env.BUBBLE_STYLE, process.env.BUBBLE_ACCENT, process.env.BUBBLE_BACKGROUND, (line) => console.warn(`[Config] ${line}`), {
    icon: process.env.BUBBLE_ICON,
    scale: process.env.BUBBLE_SCALE,
    verticalScale: process.env.BUBBLE_VERTICAL_SCALE,
  }),
  // Streamer's own packs, checked before the examples
  topicsDir: process.env.BUBBLEFACTS_TOPICS_DIR || "",

  // --- StreamerSongList ---
  sslPlatform: (process.env.SSL_PLATFORM || "twitch").toLowerCase(),
  sslAccessToken: onSSL
    ? requireEnv("SSL_ACCESS_TOKEN", `Create a Streamer Access Token at https://${sslHost} under Settings > Access.`)
    : "",
  sslTokenKind: oneOf("SSL_TOKEN_KIND", ["streamer", "user", "bearer"] as const, "streamer"),
  // Sent as Client-Id with a bearer token
  sslClientId: process.env.SSL_CLIENT_ID || "",
  // 0 = find the channel by name
  sslStreamerId: intEnv("SSL_STREAMER_ID", 0, 0, 2147483647),
  sslApiBase: trimSlash(process.env.SSL_API_BASE || `https://api.${sslHost}`),
  sslEventsUrl: process.env.SSL_EVENTS_URL || `wss://events.${sslHost}/connection/uni_websocket`,
  sslPollIntervalMs: intEnv("SSL_POLL_INTERVAL_MS", 15000, 2000, 300000),
  sslRequestTimeoutMs: intEnv("SSL_REQUEST_TIMEOUT_MS", 5000, 500, 60000),

  // --- StreamElements (its Media Request player) ---
  // Name or 24-character ID; blank = the JWT's channel
  seChannel: process.env.SE_CHANNEL?.trim() || "",
  seJwt: onSE
    ? requireEnv("SE_JWT", "Copy the JWT token from your StreamElements dashboard: Account, then Channels, then Show secrets.")
    : "",
  seApiBase: trimSlash(process.env.SE_API_BASE || "https://api.streamelements.com/kappa/v2"),
  seEventsUrl: process.env.SE_EVENTS_URL || "wss://astro.streamelements.com",
  // Optional: exact artist and track for auto-generated uploads
  youtubeApiKey: (process.env.YOUTUBE_API_KEY || "").trim(),
  sePollIntervalMs: intEnv("SE_POLL_INTERVAL_MS", 15000, 5000, 300000),
  seRequestTimeoutMs: intEnv("SE_REQUEST_TIMEOUT_MS", 5000, 500, 60000),

  // --- Now playing file: one line a music app keeps up to date ---
  nowPlayingPreset,
  nowPlayingFile: nowPlayingFile(),
  nowPlayingFolder: nowPlayingFolder(),
  // "Artist - Title", the whole line, or a YouTube title as Nightbot writes it
  nowPlayingFormat: oneOf(
    "NOW_PLAYING_FORMAT",
    ["artist-title", "title", "youtube-title"] as const,
    nowPlayingPreset === "none" ? "artist-title" : NOW_PLAYING_PRESETS[nowPlayingPreset].format
  ),

  // --- Share song facts with other apps: off unless all three are set ---
  shareFactsUrl: shareAddress(process.env.SHARE_FACTS_URL || "") ?? "",
  shareFactsKey: process.env.SHARE_FACTS_KEY || "",
  shareFactsChannel: process.env.SHARE_FACTS_CHANNEL || "",

  // --- AI ---
  aiProvider,
  // Built-in AI's model file
  modelPath: aiProvider === "builtin" ? requireEnv("MODEL_PATH") : "",
  // Prepare my songs: Standard writes the first pass, being faster (#296)
  prepareModelPath: aiProvider === "builtin" ? process.env.PREPARE_MODEL_PATH || "" : "",
  // off = processor only
  llamaGpu: oneOf("LLAMA_GPU", ["auto", "off"] as const, "auto"),
  // songs.log
  logDir: process.env.BUBBLEFACTS_LOG_DIR || path.resolve(__dirname, "../../logs"),
  // Wrong marks, session and other saved state
  dataDir: process.env.BUBBLEFACTS_DATA_DIR || path.resolve(__dirname, "../../data"),
  // 0 to 2; 0 = most faithful retelling, and repeatable
  temperature: numberEnv("TEMPERATURE", 0, 0, 2),
  ollamaBaseUrl: trimSlash(process.env.OLLAMA_BASE_URL || "http://localhost:11434"),
  ollamaFallbackUrl: trimSlash(process.env.OLLAMA_FALLBACK_URL || ""),
  ollamaModel: process.env.OLLAMA_MODEL || "llama3.2",
  ollamaTimeoutMs: intEnv("OLLAMA_TIMEOUT_MS", 90000, 1000, 600000),
  // Ollama's 5-minute default is shorter than a song gap
  ollamaKeepAlive: process.env.OLLAMA_KEEP_ALIVE || "4h",
  openaiApiKey: aiProvider === "openai" ? requireEnv("OPENAI_API_KEY") : "",
  openaiBaseUrl: trimSlash(process.env.OPENAI_BASE_URL || "https://api.groq.com/openai/v1"),
  openaiModel: process.env.OPENAI_MODEL || "openai/gpt-oss-20b",
  openaiTimeoutMs: intEnv("OPENAI_TIMEOUT_MS", 30000, 1000, 600000),
  anthropicApiKey: aiProvider === "anthropic" ? requireEnv("ANTHROPIC_API_KEY") : "",
  // No temperature: Anthropic's API (2026-10-21) rejects it
  anthropicModel: process.env.ANTHROPIC_MODEL || "claude-haiku-5-5",

  // --- Finding and checking against the song's article ---
  factVerification: oneOf("FACT_VERIFICATION", ["on", "off"] as const, "on") === "on",
  groundingTimeoutMs: intEnv("GROUNDING_TIMEOUT_MS", 5000, 500, 60000),
  // Longer: downloads the whole article
  groundingExtractTimeoutMs: intEnv("GROUNDING_EXTRACT_TIMEOUT_MS", 15000, 1000, 120000),
  // No article: try MusicBrainz's Wikidata link (#245)
  mbLink: oneOf("MB_LINK", ["on", "off"] as const, "on") === "on",
  // Unsure article: data facts only, no AI captions (#255)
  abstain: oneOf("ABSTAIN", ["on", "off"] as const, "on") === "on",
  // Article match: "shadow" logs where score and rules disagree; "scored" may only hold back (#172)
  match: oneOf("MATCH", ["rules", "shadow", "scored"] as const, "scored"),
  // Skip risky sentences, rank the rest (fact-ranking.ts)
  sourceRisk: oneOf("SOURCE_RISK", ["on", "off"] as const, "on") === "on",
  // Classical: find the work by composer, catalog number or nickname (#260)
  classicalLookup: oneOf("CLASSICAL_LOOKUP", ["on", "off"] as const, "on") === "on",

  // --- Bubbles ---
  factsPerSong: intEnv("FACTS_PER_SONG", 5, 1, 12),                    // bubbles per song
  factIntervalSeconds: intEnv("FACT_INTERVAL_SECONDS", 15, 3, 300),    // seconds between bubbles
  factDurationSeconds: intEnv("FACT_DURATION_SECONDS", 8, 2, 120),     // minimum seconds on screen
} as const;
