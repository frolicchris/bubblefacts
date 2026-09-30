import dotenv from "dotenv";
import path from "path";

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
// Where song requests come from. StreamerSongList settings are only required when it's the source.
const songSource = oneOf("SONG_SOURCE", ["streamersonglist", "streamelements"] as const, "streamersonglist");
const onSSL = songSource === "streamersonglist";
const sslHost = oneOf("SSL_ENV", ["production", "staging"] as const, "production") === "staging"
  ? "staging.streamersonglist.com"
  : "streamersonglist.com";
const trimSlash = (s: string) => s.replace(/\/+$/, "");

export const config = {
  port: intEnv("PORT", 3000, 1, 65535),
  // Loopback only by default: the server has no authentication.
  host: process.env.HOST || "127.0.0.1",

  songSource,

  // Performer and content. With StreamElements, the channel name stands in for the streamer's name.
  sslStreamerName: onSSL ? requireEnv("SSL_STREAMER_NAME") : process.env.SSL_STREAMER_NAME || process.env.SE_CHANNEL?.trim() || "",
  streamerDisplayName:
    process.env.STREAMER_DISPLAY_NAME ||
    (onSSL ? requireEnv("SSL_STREAMER_NAME") : process.env.SSL_STREAMER_NAME || process.env.SE_CHANNEL?.trim() || "the streamer"),
  instrument: (process.env.INSTRUMENT || "").trim(),
  // Empty means no backup facts: a song with no source gets none (the desktop app's default).
  topic: process.env.TOPIC ?? "video-game,classical,film,pop,general",
  // Songs tagged "Originals" or credited to the streamer get facts from the song entry, not a lookup.
  originals: oneOf("ORIGINALS", ["on", "off"] as const, "on") === "on",
  // Off-list requests get a LIVE LEARN banner and no facts. Off treats them as ordinary songs.
  liveLearns: oneOf("LIVE_LEARNS", ["on", "off"] as const, "on") === "on",
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
  seJwt: onSSL
    ? ""
    : requireEnv("SE_JWT", "Copy the JWT token from your StreamElements dashboard: Account, then Channels, then Show secrets."),
  seApiBase: trimSlash(process.env.SE_API_BASE || "https://api.streamelements.com/kappa/v2"),
  seEventsUrl: process.env.SE_EVENTS_URL || "wss://astro.streamelements.com",
  // YouTube Data API key, for the exact artist and track of auto-generated uploads. Optional.
  youtubeApiKey: (process.env.YOUTUBE_API_KEY || "").trim(),
  sePollIntervalMs: intEnv("SE_POLL_INTERVAL_MS", 15000, 5000, 300000),
  seRequestTimeoutMs: intEnv("SE_REQUEST_TIMEOUT_MS", 5000, 500, 60000),

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
  temperature: numberEnv("TEMPERATURE", 0.2, 0, 2),
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

  // Display
  factsPerSong: intEnv("FACTS_PER_SONG", 5, 1, 12),
  factIntervalSeconds: intEnv("FACT_INTERVAL_SECONDS", 15, 3, 300),
  factDurationSeconds: intEnv("FACT_DURATION_SECONDS", 8, 2, 120),
} as const;
