import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * AI provider:
 * - "ollama":    Local Ollama (free, private, no key). The default.
 * - "openai":    Any OpenAI-compatible chat endpoint — Groq, OpenRouter,
 *                Gemini's compat endpoint, LM Studio, vLLM… (OPENAI_API_KEY)
 * - "anthropic": Claude API (ANTHROPIC_API_KEY)
 */
type AIProvider = "anthropic" | "ollama" | "openai";

function resolveAIProvider(): AIProvider {
  const explicit = process.env.AI_PROVIDER?.toLowerCase();
  if (explicit === "ollama") return "ollama";
  if (explicit === "anthropic") return "anthropic";
  if (explicit === "openai") return "openai";
  if (explicit) throw new Error(`AI_PROVIDER must be ollama, openai or anthropic, got "${explicit}"`);
  // Auto-detect from whichever key is present; otherwise Ollama.
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  return "ollama";
}

// --- StreamerSongList (rebuilt platform, August 2026) --------------------

/**
 * The rebuilt StreamerSongList runs two environments with parallel host
 * names. Staging exists for testing before/around the cutover; production
 * is the default. Each host is individually overridable because the
 * production `events.` host is inferred from the `api.` host and had not
 * been brought up yet when this was written.
 */
type SSLEnv = "production" | "staging";

function resolveSSLEnv(): SSLEnv {
  const explicit = process.env.SSL_ENV?.toLowerCase();
  return explicit === "staging" ? "staging" : "production";
}

const sslEnv = resolveSSLEnv();
const sslHostSuffix = sslEnv === "staging" ? "staging.streamersonglist.com" : "streamersonglist.com";

/**
 * Auth token kind. Every endpoint on the new API requires authorization —
 * there are no public read endpoints any more, so the overlay cannot run
 * without one of these.
 *
 * - "streamer": Settings > Access on the streamer's own channel. Simplest
 *               for a single-channel overlay. Sent as `Authorization: Streamer`.
 * - "user":     Profile > API Access. Spans every channel the user owns or
 *               administrates. Sent as `Authorization: User`.
 * - "bearer":   An OAuth2 access token. Sent as `Authorization: Bearer`.
 */
type SSLTokenKind = "streamer" | "user" | "bearer";

function resolveSSLTokenKind(): SSLTokenKind {
  const explicit = process.env.SSL_TOKEN_KIND?.toLowerCase();
  if (explicit === "user") return "user";
  if (explicit === "bearer") return "bearer";
  return "streamer";
}

function requireSSLToken(): string {
  const value = process.env.SSL_ACCESS_TOKEN;
  if (!value) {
    throw new Error(
      "Missing required environment variable: SSL_ACCESS_TOKEN.\n" +
        "The rebuilt StreamerSongList API requires authorization on every request, " +
        "including reading the queue. Create a Streamer Access Token at " +
        `https://${sslHostSuffix} under Settings > Access, then set ` +
        "SSL_ACCESS_TOKEN in .env (see .env.example)."
    );
  }
  return value;
}

/**
 * Parse a numeric env var, or fail loudly at startup.
 *
 * `parseInt` silently accepts a suffixed value: `SSL_POLL_INTERVAL_MS=15s`
 * becomes 15, which `setInterval` then runs as a 15ms loop against an
 * authenticated partner API, forever, with nothing logged. A typo should
 * stop the process with a message naming the value, not quietly turn into a
 * request flood.
 */
function intEnv(
  name: string,
  fallback: number,
  { min, max }: { min: number; max: number }
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;

  const value = Number(raw.trim());
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${name} must be a whole number, got "${raw}"`);
  }
  if (value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}, got ${value}`);
  }
  return value;
}

const aiProvider = resolveAIProvider();

export const config = {
  port: intEnv("PORT", 3000, { min: 1, max: 65535 }),
  nodeEnv: process.env.NODE_ENV || "development",
  aiProvider,

  // Which topics/<id>.json supplies the fallback facts.
  topic: process.env.TOPIC || "video-game-music",

  // How the prompt and fallback facts refer to the performer. Defaults to the
  // StreamerSongList name. INSTRUMENT is optional ("piano", "guitar"); when
  // empty the prompt just says the streamer is performing the piece.
  streamerDisplayName: process.env.STREAMER_DISPLAY_NAME || requireEnv("SSL_STREAMER_NAME"),
  instrument: (process.env.INSTRUMENT || "").trim(),

  // Anthropic (only required if aiProvider is "anthropic")
  anthropicApiKey: aiProvider === "anthropic" ? requireEnv("ANTHROPIC_API_KEY") : "",
  anthropicModel: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",

  // OpenAI-compatible endpoint (only required if aiProvider is "openai").
  // Default base URL is Groq's free tier; OpenRouter is
  // https://openrouter.ai/api/v1, Gemini is
  // https://generativelanguage.googleapis.com/v1beta/openai.
  openaiApiKey: aiProvider === "openai" ? requireEnv("OPENAI_API_KEY") : "",
  openaiBaseUrl: (process.env.OPENAI_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/+$/, ""),
  openaiModel: process.env.OPENAI_MODEL || "llama-3.1-8b-instant",
  openaiTimeoutMs: intEnv("OPENAI_TIMEOUT_MS", 30000, { min: 1000, max: 600000 }),

  // Ollama (remote or local AI)
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
  ollamaFallbackUrl: process.env.OLLAMA_FALLBACK_URL || "",
  ollamaModel: process.env.OLLAMA_MODEL || "llama3.2",
  ollamaTimeoutMs: intEnv("OLLAMA_TIMEOUT_MS", 20000, { min: 1000, max: 600000 }),
  /**
   * How long Ollama keeps the model resident. The default is 5 minutes,
   * which is shorter than the typical gap between generations, so the model
   * was being unloaded and cold-loaded again for almost every song.
   */
  ollamaKeepAlive: process.env.OLLAMA_KEEP_ALIVE || "4h",
  /**
   * Low by default. Fact writing here is a *copying* task — restate what the
   * grounding reference says — not a creative one, and a small model at high
   * temperature drifts off the reference into invention. 0.2 keeps it close
   * to the source text.
   */
  ollamaTemperature: parseFloat(process.env.OLLAMA_TEMPERATURE || "0.2"),

  // Fact grounding + screening. On by default: without a reference to write
  // from, a small local model invents composers, awards and chart positions
  // that are embarrassing on stream.
  // Set FACT_VERIFICATION=off to bypass (faster, much less accurate).
  factVerification: (process.env.FACT_VERIFICATION || "on").toLowerCase() !== "off",
  groundingTimeoutMs: intEnv("GROUNDING_TIMEOUT_MS", 5000, { min: 500, max: 60000 }),
  /**
   * Separate, larger budget for the article fetch. It downloads the full
   * plaintext article (50-150KB on a major game page) to keep 2400 chars,
   * on a machine also encoding video — sharing the search timeout made
   * transient failures the expected outcome rather than the exception.
   */
  groundingExtractTimeoutMs: intEnv("GROUNDING_EXTRACT_TIMEOUT_MS", 15000, {
    min: 1000,
    max: 120000,
  }),

  // StreamerSongList
  sslEnv,
  sslStreamerName: requireEnv("SSL_STREAMER_NAME"),
  sslPlatform: (process.env.SSL_PLATFORM || "twitch").toLowerCase(),
  sslAccessToken: requireSSLToken(),
  sslTokenKind: resolveSSLTokenKind(),
  sslApiBase: (process.env.SSL_API_BASE || `https://api.${sslHostSuffix}`).replace(/\/+$/, ""),
  sslEventsUrl:
    process.env.SSL_EVENTS_URL || `wss://events.${sslHostSuffix}/connection/uni_websocket`,
  sslPollIntervalMs: intEnv("SSL_POLL_INTERVAL_MS", 15000, { min: 2000, max: 300000 }),
  sslRequestTimeoutMs: intEnv("SSL_REQUEST_TIMEOUT_MS", 5000, { min: 500, max: 60000 }),

  // Fact generation settings
  factsPerSong: intEnv("FACTS_PER_SONG", 5, { min: 1, max: 12 }),
  factIntervalSeconds: intEnv("FACT_INTERVAL_SECONDS", 15, { min: 3, max: 300 }),
  factDurationSeconds: intEnv("FACT_DURATION_SECONDS", 8, { min: 2, max: 120 }),
} as const;
