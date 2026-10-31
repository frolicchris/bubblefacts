import dotenv from "dotenv";
import os from "os";
import path from "path";
import { presetFolder } from "./now-playing-folder";

/** All settings come from .env; .env.example and docs/CONFIG.md document each one. */
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

function requireEnv(name: string, hint = ""): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required setting ${name}.${hint ? " " + hint : ""}`);
  return value;
}

/** Whole number within bounds, or a startup error naming the bad value. */
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
// Where songs come from. Each source's settings are only required when it's the source.
const songSource = oneOf("SONG_SOURCE", ["streamersonglist", "streamelements", "nowplaying"] as const, "streamersonglist");
const onSSL = songSource === "streamersonglist";
const onSE = songSource === "streamelements";
const onFile = songSource === "nowplaying";
const sslHost = oneOf("SSL_ENV", ["production", "staging"] as const, "production") === "staging"
  ? "staging.streamersonglist.com"
  : "streamersonglist.com";
const trimSlash = (s: string) => s.replace(/\/+$/, "");

/**
 * Apps that write the playing song to a text file, the folder they write it in
 * (inside Documents, which may be in OneDrive: see presetFolder),
 * the file's name (empty: the app's page doesn't name one, so the newest .txt
 * in the folder is followed) and how its line reads.
 */
export const NOW_PLAYING_PRESETS = {
  // Streamling's author recommends nowplaying-minimal.txt: one "Artist - Song" line, UTF-8 (v1.5 release notes).
  // The line can also be a YouTube title ("Song - Official Music Video"), so it is read the way Nightbot's is.
  streamling: { name: "Streamling", folder: ["streamling", "livetext"], file: "nowplaying-minimal.txt", format: "youtube-title" },
  // Nightbot's desktop app (Windows and Mac) writes the current song, a YouTube video, into this folder;
  // its docs name neither the file nor the line, which is customizable.
  nightbot: { name: "Nightbot", folder: ["Nightbot"], file: "", format: "youtube-title" },
} as const;
const nowPlayingPreset = oneOf("NOW_PLAYING_PRESET", ["none", "streamling", "nightbot"] as const, "none");

/**
 * The file a now-playing app writes. A preset's folder is the starting point for a
 * name or relative path (otherwise the overlay folder, like .env); a full path, or one
 * starting with ~, is used as written.
 */
function nowPlayingFile(): string {
  const raw = process.env.NOW_PLAYING_FILE?.trim() || "";
  const preset = nowPlayingPreset === "none" ? null : NOW_PLAYING_PRESETS[nowPlayingPreset];
  if (!raw) {
    if (!onFile) return "";
    // A preset with no file name follows its whole folder instead (see nowPlayingFolder).
    if (preset) return preset.file ? path.join(presetFolder(preset.folder), preset.file) : "";
    throw new Error("Missing required setting NOW_PLAYING_FILE. Set it to the full path of the text file your now-playing app writes.");
  }
  if (raw === "~" || /^~[\\/]/.test(raw)) return path.join(os.homedir(), raw.slice(1));
  if (path.isAbsolute(raw)) return raw;
  return preset ? path.join(presetFolder(preset.folder), raw) : path.resolve(__dirname, "../..", raw);
}

/** The folder whose newest .txt is the song, for a preset that doesn't name its file and no file given. */
function nowPlayingFolder(): string {
  const preset = nowPlayingPreset === "none" ? null : NOW_PLAYING_PRESETS[nowPlayingPreset];
  if (!onFile || !preset || preset.file || process.env.NOW_PLAYING_FILE?.trim()) return "";
  return presetFolder(preset.folder);
}

/**
 * The streamer's name for stats and logs. With StreamerSongList it is the
 * StreamerSongList channel; with StreamElements, the StreamElements channel
 * stands in for it (SE_CHANNEL, unless SSL_STREAMER_NAME is also set).
 */
const streamerName = onSSL ? requireEnv("SSL_STREAMER_NAME") : process.env.SSL_STREAMER_NAME || process.env.SE_CHANNEL?.trim() || "";

export const config = {
  port: intEnv("PORT", 3000, 1, 65535),
  // Loopback only by default: the server has no authentication.
  host: process.env.HOST || "127.0.0.1",

  songSource,

  // Performer and content. The name keeps its StreamerSongList field name, but also holds the StreamElements channel (see streamerName).
  sslStreamerName: streamerName,
  streamerDisplayName: process.env.STREAMER_DISPLAY_NAME || streamerName || "the streamer",
  instrument: (process.env.INSTRUMENT || "").trim(),
  // Empty means no custom facts: a song with no source gets none (the desktop app's default).
  topic: process.env.TOPIC ?? "video-game,classical,film,pop,general",
  // Songs tagged "Originals" or credited to the streamer get facts from the song entry, not a lookup.
  originals: oneOf("ORIGINALS", ["on", "off"] as const, "on") === "on",
  // Off-list requests get a LIVE LEARN banner and no facts. Off treats them as ordinary songs.
  liveLearns: oneOf("LIVE_LEARNS", ["on", "off"] as const, "on") === "on",
  // The part of the screen bubbles keep to, or one spot they always use.
  bubbleArea: oneOf("BUBBLE_AREA", ["anywhere", "top", "bottom", "left", "right", "top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"] as const, "anywhere"),
  // Where bubbles go in the vertical overlay (BubbleFacts Vertical.html), for phone-shaped streams.
  verticalArea: oneOf("VERTICAL_AREA", ["top", "above-chat"] as const, "top"),
  // The NOW PLAYING bubble on a song change. Off for streamers whose own overlay already shows the song.
  nowPlaying: oneOf("NOW_PLAYING", ["on", "off"] as const, "on") === "on",
  // One credit bubble before the first song's facts and about every 5 songs with facts (issue #278).
  creditBubble: oneOf("CREDIT_BUBBLE", ["on", "off"] as const, "on") === "on",
  liveLearnBanner: oneOf("LIVE_LEARN_BANNER", ["on", "off"] as const, "on") === "on",
  // A folder of the streamer's own packs, checked before the built-in examples. The desktop app sets it.
  topicsDir: process.env.BUBBLEFACTS_TOPICS_DIR || "",

  // StreamerSongList
  sslPlatform: (process.env.SSL_PLATFORM || "twitch").toLowerCase(),
  sslAccessToken: onSSL
    ? requireEnv("SSL_ACCESS_TOKEN", `Create a Streamer Access Token at https://${sslHost} under Settings > Access.`)
    : "",
  sslTokenKind: oneOf("SSL_TOKEN_KIND", ["streamer", "user", "bearer"] as const, "streamer"),
  // The OAuth client a bearer token was issued to. StreamerSongList wants it as a Client-Id header.
  sslClientId: process.env.SSL_CLIENT_ID || "",
  // Look the channel up by its StreamerSongList ID rather than its name, when known (0 = by name).
  sslStreamerId: intEnv("SSL_STREAMER_ID", 0, 0, 2147483647),
  sslApiBase: trimSlash(process.env.SSL_API_BASE || `https://api.${sslHost}`),
  sslEventsUrl: process.env.SSL_EVENTS_URL || `wss://events.${sslHost}/connection/uni_websocket`,
  sslPollIntervalMs: intEnv("SSL_POLL_INTERVAL_MS", 15000, 2000, 300000),
  sslRequestTimeoutMs: intEnv("SSL_REQUEST_TIMEOUT_MS", 5000, 500, 60000),

  // StreamElements (SONG_SOURCE=streamelements): its song request player, "Media Request".
  // SE_CHANNEL is a channel name or its 24-character ID; blank means the JWT's own channel.
  seChannel: process.env.SE_CHANNEL?.trim() || "",
  seJwt: onSE
    ? requireEnv("SE_JWT", "Copy the JWT token from your StreamElements dashboard: Account, then Channels, then Show secrets.")
    : "",
  seApiBase: trimSlash(process.env.SE_API_BASE || "https://api.streamelements.com/kappa/v2"),
  seEventsUrl: process.env.SE_EVENTS_URL || "wss://astro.streamelements.com",
  // YouTube Data API key, for the exact artist and track of auto-generated uploads. Optional.
  youtubeApiKey: (process.env.YOUTUBE_API_KEY || "").trim(),
  sePollIntervalMs: intEnv("SE_POLL_INTERVAL_MS", 15000, 5000, 300000),
  seRequestTimeoutMs: intEnv("SE_REQUEST_TIMEOUT_MS", 5000, 500, 60000),

  // Now playing file (SONG_SOURCE=nowplaying): one line a now-playing app keeps up to date.
  nowPlayingPreset,
  nowPlayingFile: nowPlayingFile(),
  nowPlayingFolder: nowPlayingFolder(),
  // "artist-title" reads "Artist - Title"; "title" reads the whole line as the title;
  // "youtube-title" reads a YouTube video's title ("Artist - Song (Official Video)"), as Nightbot writes it.
  nowPlayingFormat: oneOf(
    "NOW_PLAYING_FORMAT",
    ["artist-title", "title", "youtube-title"] as const,
    nowPlayingPreset === "none" ? "artist-title" : NOW_PLAYING_PRESETS[nowPlayingPreset].format
  ),

  // Model
  aiProvider,
  // The desktop app's built-in model: a GGUF file it downloaded (AI_PROVIDER=builtin).
  modelPath: aiProvider === "builtin" ? requireEnv("MODEL_PATH") : "",
  // "off" runs the built-in model on the processor only, for computers where the GPU build fails.
  llamaGpu: oneOf("LLAMA_GPU", ["auto", "off"] as const, "auto"),
  // Where songs.log goes. The desktop app points this at its data folder.
  logDir: process.env.BUBBLEFACTS_LOG_DIR || path.resolve(__dirname, "../../logs"),
  // Where facts marked wrong are remembered. The desktop app points this at its data folder.
  dataDir: process.env.BUBBLEFACTS_DATA_DIR || path.resolve(__dirname, "../../data"),
  // 0: the model retells a reference, so its likeliest wording is the most faithful one (and runs repeat).
  temperature: numberEnv("TEMPERATURE", 0, 0, 2),
  ollamaBaseUrl: trimSlash(process.env.OLLAMA_BASE_URL || "http://localhost:11434"),
  ollamaFallbackUrl: trimSlash(process.env.OLLAMA_FALLBACK_URL || ""),
  ollamaModel: process.env.OLLAMA_MODEL || "llama3.2",
  ollamaTimeoutMs: intEnv("OLLAMA_TIMEOUT_MS", 90000, 1000, 600000),
  // Ollama unloads idle models after 5 minutes, less than the gap between songs.
  ollamaKeepAlive: process.env.OLLAMA_KEEP_ALIVE || "4h",
  openaiApiKey: aiProvider === "openai" ? requireEnv("OPENAI_API_KEY") : "",
  openaiBaseUrl: trimSlash(process.env.OPENAI_BASE_URL || "https://api.groq.com/openai/v1"),
  openaiModel: process.env.OPENAI_MODEL || "openai/gpt-oss-20b",
  openaiTimeoutMs: intEnv("OPENAI_TIMEOUT_MS", 30000, 1000, 600000),
  anthropicApiKey: aiProvider === "anthropic" ? requireEnv("ANTHROPIC_API_KEY") : "",
  anthropicModel: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",

  // Grounding
  factVerification: oneOf("FACT_VERIFICATION", ["on", "off"] as const, "on") === "on",
  groundingTimeoutMs: intEnv("GROUNDING_TIMEOUT_MS", 5000, 500, 60000),
  // Larger: the extract call downloads the full article text.
  groundingExtractTimeoutMs: intEnv("GROUNDING_EXTRACT_TIMEOUT_MS", 15000, 1000, 120000),
  // When no article is found, follow MusicBrainz's own Wikidata link to the song's or artist's article (issue #245).
  mbLink: oneOf("MB_LINK", ["on", "off"] as const, "on") === "on",
  // When the article may be about another work, show only facts from data, never AI captions (issue #255).
  abstain: oneOf("ABSTAIN", ["on", "off"] as const, "on") === "on",
  // Hold back AI captions whose source sentence is risky to retell, and rank the rest by interest (fact-ranking.ts).
  sourceRisk: oneOf("SOURCE_RISK", ["on", "off"] as const, "on") === "on",
  // Classical pieces: find the work through Wikidata by its composer, catalog number or nickname (issue #260).
  classicalLookup: oneOf("CLASSICAL_LOOKUP", ["on", "off"] as const, "on") === "on",

  // Display
  factsPerSong: intEnv("FACTS_PER_SONG", 5, 1, 12),
  factIntervalSeconds: intEnv("FACT_INTERVAL_SECONDS", 15, 3, 300),
  factDurationSeconds: intEnv("FACT_DURATION_SECONDS", 8, 2, 120),
} as const;
