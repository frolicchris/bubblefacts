import dotenv from "dotenv";
import os from "os";
import path from "path";
import { presetFolder } from "./now-playing-folder";
import { shareAddress } from "./share-song-facts";
import { styleFrom } from "./bubble-style";

// Every setting, from .env or the environment. docs/CONFIG.md explains each one (config.test.ts checks)
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

function requireEnv(name: string, hint = ""): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required setting ${name}.${hint ? " " + hint : ""}`);
  return value;
}

/** A whole number from min to max; anything else stops startup with the bad value named. */
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
// Where songs come from. A source's settings are required only when it's the one chosen
const songSource = oneOf("SONG_SOURCE", ["streamersonglist", "streamelements", "nowplaying"] as const, "streamersonglist");
const onSSL = songSource === "streamersonglist";
const onSE = songSource === "streamelements";
const onFile = songSource === "nowplaying";
const sslHost = oneOf("SSL_ENV", ["production", "staging"] as const, "production") === "staging"
  ? "staging.streamersonglist.com"
  : "streamersonglist.com";
const trimSlash = (s: string) => s.replace(/\/+$/, "");

// Apps that write the playing song to a text file: their folder in Documents (maybe in OneDrive),
// the file name ("" = follow the newest .txt there) and how the line reads
export const NOW_PLAYING_PRESETS = {
  // nowplaying-minimal.txt: one "Artist - Song" line, UTF-8 (Streamling v1.5 release notes). It can be a YouTube title too
  streamling: { name: "Streamling", folder: ["streamling", "livetext"], file: "nowplaying-minimal.txt", format: "youtube-title" },
  // Nightbot's desktop app: a YouTube title; its docs name neither the file nor the line
  nightbot: { name: "Nightbot", folder: ["Nightbot"], file: "", format: "youtube-title" },
} as const;
const nowPlayingPreset = oneOf("NOW_PLAYING_PRESET", ["none", "streamling", "nightbot"] as const, "none");

// The now-playing file. A name or relative path starts from the preset's folder (else the
// overlay folder, like .env); a full path or ~/... is used as written
function nowPlayingFile(): string {
  const raw = process.env.NOW_PLAYING_FILE?.trim() || "";
  const preset = nowPlayingPreset === "none" ? null : NOW_PLAYING_PRESETS[nowPlayingPreset];
  if (!raw) {
    if (!onFile) return "";
    // A preset with no file name follows its folder instead (nowPlayingFolder)
    if (preset) return preset.file ? path.join(presetFolder(preset.folder), preset.file) : "";
    throw new Error("Missing required setting NOW_PLAYING_FILE. Set it to the full path of the text file your now-playing app writes.");
  }
  if (raw === "~" || /^~[\\/]/.test(raw)) return path.join(os.homedir(), raw.slice(1));
  if (path.isAbsolute(raw)) return raw;
  return preset ? path.join(presetFolder(preset.folder), raw) : path.resolve(__dirname, "../..", raw);
}

// The folder whose newest .txt is the song: a preset with no file name, and no file given
function nowPlayingFolder(): string {
  const preset = nowPlayingPreset === "none" ? null : NOW_PLAYING_PRESETS[nowPlayingPreset];
  if (!onFile || !preset || preset.file || process.env.NOW_PLAYING_FILE?.trim()) return "";
  return presetFolder(preset.folder);
}

// The streamer's name for stats and logs: the StreamerSongList channel, or with StreamElements
// its channel (SE_CHANNEL), unless SSL_STREAMER_NAME is set too
const streamerName = onSSL ? requireEnv("SSL_STREAMER_NAME") : process.env.SSL_STREAMER_NAME || process.env.SE_CHANNEL?.trim() || "";

export const config = {
  port: intEnv("PORT", 3000, 1, 65535),
  host: process.env.HOST || "127.0.0.1",                      // this computer only: the server has no sign-in

  songSource,

  // --- Performer and content ---
  // Named for StreamerSongList, but holds the StreamElements channel too (streamerName)
  sslStreamerName: streamerName,
  streamerDisplayName: process.env.STREAMER_DISPLAY_NAME || streamerName || "the streamer",
  // Topic packs for songs no source knows. Empty = none (the desktop app's default)
  topic: process.env.TOPIC ?? "video-game,classical,film,pop,general",
  // Songs tagged "Originals" or credited to the streamer: facts from the song entry, no lookup
  originals: oneOf("ORIGINALS", ["on", "off"] as const, "on") === "on",
  // Off-list requests: a LIVE LEARN banner and no facts. Off = ordinary songs
  liveLearns: oneOf("LIVE_LEARNS", ["on", "off"] as const, "on") === "on",
  // Where bubbles go: a part of the screen, or one fixed spot
  bubbleArea: oneOf("BUBBLE_AREA", ["anywhere", "top", "bottom", "left", "right", "top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"] as const, "anywhere"),
  // Where bubbles go on the vertical overlay (phone-shaped streams)
  verticalArea: oneOf("VERTICAL_AREA", ["top", "above-chat"] as const, "top"),
  // NOW PLAYING bubble on a new song. Off if your own overlay shows the song
  nowPlaying: oneOf("NOW_PLAYING", ["on", "off"] as const, "on") === "on",
  // Where-the-facts-come-from bubble: first, then every 5 songs. Off = once a stream (#278)
  creditBubble: oneOf("CREDIT_BUBBLE", ["on", "off"] as const, "on") === "on",
  liveLearnBanner: oneOf("LIVE_LEARN_BANNER", ["on", "off"] as const, "on") === "on",
  // The bubbles' look (#177): a Style, maybe the streamer's own colors. Never a startup error:
  // an unknown Style or a mistyped color falls back to Classic
  bubbleStyle: styleFrom(process.env.BUBBLE_STYLE, process.env.BUBBLE_ACCENT, process.env.BUBBLE_BACKGROUND, (line) => console.warn(`[Config] ${line}`), {
    icon: process.env.BUBBLE_ICON,
    scale: process.env.BUBBLE_SCALE,
    verticalScale: process.env.BUBBLE_VERTICAL_SCALE,
  }),
  // The streamer's own packs, checked before the examples. The desktop app sets it
  topicsDir: process.env.BUBBLEFACTS_TOPICS_DIR || "",

  // --- StreamerSongList ---
  sslPlatform: (process.env.SSL_PLATFORM || "twitch").toLowerCase(),
  sslAccessToken: onSSL
    ? requireEnv("SSL_ACCESS_TOKEN", `Create a Streamer Access Token at https://${sslHost} under Settings > Access.`)
    : "",
  sslTokenKind: oneOf("SSL_TOKEN_KIND", ["streamer", "user", "bearer"] as const, "streamer"),
  // The OAuth client a bearer token came from, sent as Client-Id
  sslClientId: process.env.SSL_CLIENT_ID || "",
  // Find the channel by ID instead of name (0 = by name)
  sslStreamerId: intEnv("SSL_STREAMER_ID", 0, 0, 2147483647),
  sslApiBase: trimSlash(process.env.SSL_API_BASE || `https://api.${sslHost}`),
  sslEventsUrl: process.env.SSL_EVENTS_URL || `wss://events.${sslHost}/connection/uni_websocket`,
  sslPollIntervalMs: intEnv("SSL_POLL_INTERVAL_MS", 15000, 2000, 300000),
  sslRequestTimeoutMs: intEnv("SSL_REQUEST_TIMEOUT_MS", 5000, 500, 60000),

  // --- StreamElements (its Media Request player) ---
  // A channel name or 24-character ID; blank = the JWT's own channel
  seChannel: process.env.SE_CHANNEL?.trim() || "",
  seJwt: onSE
    ? requireEnv("SE_JWT", "Copy the JWT token from your StreamElements dashboard: Account, then Channels, then Show secrets.")
    : "",
  seApiBase: trimSlash(process.env.SE_API_BASE || "https://api.streamelements.com/kappa/v2"),
  seEventsUrl: process.env.SE_EVENTS_URL || "wss://astro.streamelements.com",
  // Optional: exact artist and track for YouTube's auto-generated uploads
  youtubeApiKey: (process.env.YOUTUBE_API_KEY || "").trim(),
  sePollIntervalMs: intEnv("SE_POLL_INTERVAL_MS", 15000, 5000, 300000),
  seRequestTimeoutMs: intEnv("SE_REQUEST_TIMEOUT_MS", 5000, 500, 60000),

  // --- Now playing file: one line a music app keeps up to date ---
  nowPlayingPreset,
  nowPlayingFile: nowPlayingFile(),
  nowPlayingFolder: nowPlayingFolder(),
  // "artist-title": Artist - Title; "title": the whole line; "youtube-title": a video title,
  // "Artist - Song (Official Video)", as Nightbot writes it
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
  // The built-in AI's downloaded model file (AI_PROVIDER=builtin)
  modelPath: aiProvider === "builtin" ? requireEnv("MODEL_PATH") : "",
  // Prepare my songs (#296): Standard writes the first pass even with Larger AI, several times
  // faster. Set only when Standard is downloaded
  prepareModelPath: aiProvider === "builtin" ? process.env.PREPARE_MODEL_PATH || "" : "",
  // off = processor only, where the graphics build fails
  llamaGpu: oneOf("LLAMA_GPU", ["auto", "off"] as const, "auto"),
  // songs.log goes here; the desktop app uses its data folder
  logDir: process.env.BUBBLEFACTS_LOG_DIR || path.resolve(__dirname, "../../logs"),
  // Wrong marks, the session and the like; the desktop app uses its data folder
  dataDir: process.env.BUBBLEFACTS_DATA_DIR || path.resolve(__dirname, "../../data"),
  // 0 to 2. 0: retelling an article, the likeliest wording is the most faithful (and repeatable)
  temperature: numberEnv("TEMPERATURE", 0, 0, 2),
  ollamaBaseUrl: trimSlash(process.env.OLLAMA_BASE_URL || "http://localhost:11434"),
  ollamaFallbackUrl: trimSlash(process.env.OLLAMA_FALLBACK_URL || ""),
  ollamaModel: process.env.OLLAMA_MODEL || "llama3.2",
  ollamaTimeoutMs: intEnv("OLLAMA_TIMEOUT_MS", 90000, 1000, 600000),
  // Ollama's own 5 minutes is shorter than the gap between songs
  ollamaKeepAlive: process.env.OLLAMA_KEEP_ALIVE || "4h",
  openaiApiKey: aiProvider === "openai" ? requireEnv("OPENAI_API_KEY") : "",
  openaiBaseUrl: trimSlash(process.env.OPENAI_BASE_URL || "https://api.groq.com/openai/v1"),
  openaiModel: process.env.OPENAI_MODEL || "openai/gpt-oss-20b",
  openaiTimeoutMs: intEnv("OPENAI_TIMEOUT_MS", 30000, 1000, 600000),
  anthropicApiKey: aiProvider === "anthropic" ? requireEnv("ANTHROPIC_API_KEY") : "",
  // No temperature is sent: Anthropic's API (2026-10-21) rejects it
  anthropicModel: process.env.ANTHROPIC_MODEL || "claude-haiku-5-5",

  // --- Finding the song's article and checking facts against it ---
  factVerification: oneOf("FACT_VERIFICATION", ["on", "off"] as const, "on") === "on",
  groundingTimeoutMs: intEnv("GROUNDING_TIMEOUT_MS", 5000, 500, 60000),
  // Longer: this one downloads the whole article
  groundingExtractTimeoutMs: intEnv("GROUNDING_EXTRACT_TIMEOUT_MS", 15000, 1000, 120000),
  // No article found: follow MusicBrainz's Wikidata link to the song's or artist's (#245)
  mbLink: oneOf("MB_LINK", ["on", "off"] as const, "on") === "on",
  // Article may be about another work: facts from data only, no AI captions (#255)
  abstain: oneOf("ABSTAIN", ["on", "off"] as const, "on") === "on",
  // Is the article this song's? "rules"; "shadow" also scores and logs disagreements;
  // "scored" lets the score hold facts back, never add them (#172, work-resolver.ts)
  match: oneOf("MATCH", ["rules", "shadow", "scored"] as const, "scored"),
  // Hold back captions from risky sentences, rank the rest by interest (fact-ranking.ts)
  sourceRisk: oneOf("SOURCE_RISK", ["on", "off"] as const, "on") === "on",
  // Classical pieces: find the work in Wikidata by composer, catalog number or nickname (#260)
  classicalLookup: oneOf("CLASSICAL_LOOKUP", ["on", "off"] as const, "on") === "on",

  // --- Bubbles ---
  factsPerSong: intEnv("FACTS_PER_SONG", 5, 1, 12),                    // bubbles per song
  factIntervalSeconds: intEnv("FACT_INTERVAL_SECONDS", 15, 3, 300),    // seconds from one bubble to the next
  factDurationSeconds: intEnv("FACT_DURATION_SECONDS", 8, 2, 120),     // seconds each bubble stays up, at least (long ones longer)
} as const;
