import * as fs from "fs";
import * as path from "path";
import { config } from "./config";
import { PopUpFact, SSLQueueItem, SSLSong } from "./types";
import { fetchGrounding, resolveGameAndTrack, screenClaims, topUp } from "./fact-verifier";
import { buildStatFacts, isOriginal } from "./stat-facts";
import { topic } from "./topic";

/**
 * Turns a song into timed fact bubbles.
 *
 *   live learn  -> no facts (the overlay shows a banner)
 *   original    -> facts from the queue entry, no lookup
 *   article     -> model restates it, screening filters the result
 *   no article  -> entry facts + topic pack, no model call
 */

/** Ask for a few spares; screening drops some. */
const OVERGENERATE = 2;
const MAX_TOKENS = 512;

/**
 * Bubble slots as CSS percentages of a 1920x1080 overlay. Laid out to avoid a
 * song-queue panel top-left, a camera top-right, goal widgets bottom-right and
 * the song banner bottom-centre. `left` is the bubble's left edge; keep it
 * under ~66% so a 560px bubble stays on screen. Edit for your own scene.
 */
const POSITIONS = [
  { top: "8%", left: "33%" },
  { top: "57%", left: "9%" },
  { top: "26%", left: "33%" },
  { top: "57%", left: "40%" },
  { top: "42%", left: "33%" },
  { top: "70%", left: "9%" },
  { top: "16%", left: "34%" },
  { top: "70%", left: "40%" },
];

type Outcome = "grounded" | "original" | "liveLearn" | "noReference" | "nothingSurvived" | "generationFailed";

/** Per-session counts, reported on /health. */
export const factStats = {
  grounded: 0,
  original: 0,
  liveLearn: 0,
  noReference: 0,
  generationFailed: 0,
  nothingSurvived: 0,
  cacheHits: 0,
  lastDurationMs: 0,
  lastEndpoint: "",
  lastOutcome: "",
};

const factCache = new Map<string, PopUpFact[]>();
const SONGS_LOG = path.resolve(__dirname, "../../logs/songs.log");
const SONGS_LOG_LABEL: Record<Outcome, string> = {
  grounded: "article",
  original: "original",
  liveLearn: "livelearn",
  noReference: "curated",
  nothingSurvived: "curated",
  generationFailed: "curated",
};

/** Count the outcome and append a line to logs/songs.log (time, title, game, outcome, count). */
function record(song: SSLSong, outcome: Outcome, count: number): void {
  factStats[outcome]++;
  factStats.lastOutcome = outcome;
  if (process.env.NODE_ENV === "test") return;
  const clean = (v: string) => (v ?? "").replace(/\s+/g, " ");
  const line = [new Date().toISOString(), clean(song.title), clean(song.artist), SONGS_LOG_LABEL[outcome], count];
  fs.mkdir(path.dirname(SONGS_LOG), { recursive: true }, () =>
    fs.appendFile(SONGS_LOG, line.join("\t") + "\n", () => undefined)
  );
}

function linesToFacts(lines: string[]): PopUpFact[] {
  const stamp = Date.now();
  return lines.map((text, i) => ({
    id: `fact_${stamp}_${i}_${Math.random().toString(36).slice(2, 8)}`,
    text,
    appearAtSecond: i * config.factIntervalSeconds,
    durationSeconds: config.factDurationSeconds,
    position: POSITIONS[i % POSITIONS.length],
  }));
}

// --- Prompts -----------------------------------------------------------

function subjectLine(song: SSLSong): { game: string; intro: string } {
  const { game, track } = resolveGameAndTrack(song);
  const work = track && track !== game ? `"${track}" from ${game}` : `"${track || game}"`;
  const doing = config.instrument ? `playing ${work} on ${config.instrument}` : `performing ${work}`;
  return {
    game,
    intro: `You are writing short trivia captions for a live music stream overlay. The streamer, ${config.streamerDisplayName}, is ${doing} right now.`,
  };
}

/**
 * Written for a 3B model: the source comes first, and every rule is a test
 * the model can apply to its own sentence rather than "be accurate".
 */
function groundedPrompt(song: SSLSong, context: string, want: number): string {
  const { game, intro } = subjectLine(song);
  return `${intro}

Everything you write must come from the SOURCE below. It is the only information you are allowed to use.

SOURCE
"""
${context}
"""

Write exactly ${want} trivia lines about ${game} or its music.

Follow every rule:
1. Use ONLY the SOURCE. Every person, year, number, platform, studio, and title you write must appear in the SOURCE, spelled the same way.
2. Match the SOURCE's subject. If it describes a song, film, or classical work rather than a video game, write about that — never force a gaming angle onto music that has nothing to do with games.
3. Each line restates ONE statement from the SOURCE. Never merge two statements, and never move a name from one statement into another — if the SOURCE says someone composed the music, do not say they wrote the story or designed the game.
4. If the SOURCE does not name a composer, do NOT name a composer — write about a different detail the SOURCE does give.
5. Do not mention awards, sales, chart positions, or review scores unless the SOURCE uses those words.
6. Prefer details about the music: the composer or songwriter, the instruments, how it was recorded, arranged or first performed. If the SOURCE has none, write about the work itself.
7. Never mention the SOURCE, this prompt, Wikipedia, or anything you could not find. Write finished facts only.
8. One sentence per line, under 120 characters, friendly like a loading-screen tip.
9. No numbering, bullets, quotes, or headings. Output exactly ${want} lines and nothing else.`;
}

/** Used only with FACT_VERIFICATION=off: fast, from memory, often wrong. */
function unverifiedPrompt(song: SSLSong, want: number): string {
  const { game, intro } = subjectLine(song);
  return `${intro}

Write exactly ${want} trivia lines about ${game} or its music.

Follow every rule:
1. Write only things you are confident are true. If you are unsure who composed the music, do not name a composer.
2. Do not mention awards, sales, chart positions, or review scores.
3. Never mention this prompt or say what you could not find. Write finished facts only.
4. One sentence per line, under 120 characters, friendly like a loading-screen tip.
5. No numbering, bullets, quotes, or headings. Output exactly ${want} lines and nothing else.`;
}

// --- Providers ---------------------------------------------------------

let anthropic: import("@anthropic-ai/sdk").default | undefined;

async function askAnthropic(prompt: string): Promise<string> {
  if (!anthropic) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
  }
  const res = await anthropic.messages.create({
    model: config.anthropicModel,
    max_tokens: MAX_TOKENS,
    temperature: config.temperature,
    messages: [{ role: "user", content: prompt }],
  });
  return res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

async function postJSON<T>(url: string, body: unknown, timeoutMs: number, headers = {}): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${url} returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

/** Groq, OpenRouter, Gemini, LM Studio, vLLM: anything speaking chat completions. */
async function askOpenAICompatible(prompt: string): Promise<string> {
  const data = await postJSON<{ choices?: Array<{ message?: { content?: string } }> }>(
    `${config.openaiBaseUrl}/chat/completions`,
    {
      model: config.openaiModel,
      messages: [{ role: "user", content: prompt }],
      temperature: config.temperature,
      max_tokens: MAX_TOKENS,
    },
    config.openaiTimeoutMs,
    { Authorization: `Bearer ${config.openaiApiKey}` }
  );
  return data.choices?.[0]?.message?.content ?? "";
}

/** Primary Ollama host, then the fallback host if one is configured. */
async function askOllama(prompt: string): Promise<string> {
  const hosts = [config.ollamaBaseUrl, config.ollamaFallbackUrl].filter(Boolean);
  let lastError: unknown;
  for (const host of hosts) {
    try {
      const data = await postJSON<{ response: string }>(
        `${host}/api/generate`,
        {
          model: config.ollamaModel,
          prompt,
          stream: false,
          keep_alive: config.ollamaKeepAlive,
          options: { temperature: config.temperature, num_predict: MAX_TOKENS },
        },
        config.ollamaTimeoutMs
      );
      factStats.lastEndpoint = host;
      return data.response;
    } catch (err) {
      lastError = err;
      console.warn(`[FactGen] Ollama at ${host} failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  throw lastError;
}

async function askModel(prompt: string): Promise<string> {
  const started = Date.now();
  let text: string;
  if (config.aiProvider === "anthropic") {
    text = await askAnthropic(prompt);
    factStats.lastEndpoint = `anthropic (${config.anthropicModel})`;
  } else if (config.aiProvider === "openai") {
    text = await askOpenAICompatible(prompt);
    factStats.lastEndpoint = `${config.openaiBaseUrl} (${config.openaiModel})`;
  } else {
    text = await askOllama(prompt);
  }
  factStats.lastDurationMs = Date.now() - started;
  console.log(`[FactGen] ${factStats.lastEndpoint} answered in ${(factStats.lastDurationMs / 1000).toFixed(1)}s`);
  return text;
}

// --- Pipeline ----------------------------------------------------------

/** Performer credit plus curated facts, for when generation produced nothing usable. */
function fallbackFacts(song: SSLSong): PopUpFact[] {
  return linesToFacts([
    `"${song.title}" is being performed live by ${config.streamerDisplayName}!`,
    ...topUp([], config.factsPerSong - 1),
  ]);
}

export async function generateFacts(song: SSLSong, entry: SSLQueueItem | null = null): Promise<PopUpFact[]> {
  const key = `${song.artist ?? ""}:::${song.title}`.toLowerCase();
  const cached = factCache.get(key);
  if (cached) {
    factStats.cacheHits++;
    return cached;
  }

  if (song.liveLearn) {
    console.log(`[FactGen] "${song.title}" is a live learn, skipping facts`);
    record(song, "liveLearn", 0);
    return [];
  }

  const want = config.factsPerSong;
  try {
    if (isOriginal(entry, config.sslStreamerName)) {
      const stats = buildStatFacts(entry, { streamerName: config.sslStreamerName, isOriginalSong: true });
      const facts = linesToFacts([...stats, ...topic.originalsFacts].slice(0, want));
      console.log(`[FactGen] "${song.title}" is an original: ${facts.length} facts from the song entry`);
      record(song, "original", facts.length);
      factCache.set(key, facts);
      return facts;
    }

    const context = config.factVerification ? await fetchGrounding(song) : "";

    if (config.factVerification && !context) {
      // Not cached: grounding may succeed once its negative cache expires.
      const stats = buildStatFacts(entry, { streamerName: config.sslStreamerName });
      const lines = [...stats, ...topUp(stats, want)].slice(0, want);
      console.log(`[FactGen] No reference for "${song.title}": ${stats.length} entry facts, ${lines.length - stats.length} curated`);
      record(song, "noReference", lines.length);
      return linesToFacts(lines);
    }

    const prompt = context
      ? groundedPrompt(song, context, want + OVERGENERATE)
      : unverifiedPrompt(song, want);
    const lines = (await askModel(prompt)).split("\n").map((l) => l.trim()).filter(Boolean);

    let shown = lines.slice(0, want);
    if (context) {
      const { kept, rejected } = screenClaims(lines, context);
      for (const r of rejected) console.log(`[Screen] DROP (${r.reason}): ${r.text.slice(0, 90)}`);
      shown = kept.slice(0, want);
      console.log(`[Screen] "${song.title}": ${lines.length} generated, ${rejected.length} dropped, ${shown.length} shown`);
    }

    if (!shown.length) {
      console.warn(`[FactGen] Nothing usable for "${song.title}", using curated facts`);
      record(song, "nothingSurvived", want);
      return fallbackFacts(song);
    }

    const facts = linesToFacts(shown);
    factCache.set(key, facts);
    record(song, "grounded", facts.length);
    return facts;
  } catch (err) {
    console.error(`[FactGen] Generation failed for "${song.title}":`, err);
    record(song, "generationFailed", want);
    return fallbackFacts(song);
  }
}

export function clearFactCache(): void {
  factCache.clear();
}
