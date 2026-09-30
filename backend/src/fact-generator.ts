import * as fs from "fs";
import * as path from "path";
import { config } from "./config";
import { Fact, SSLQueueItem, SSLSong } from "./types";
import { curatedFacts, fetchGrounding, resolveGameAndTrack, screenClaims } from "./fact-verifier";
import { buildStatFacts, isOriginal } from "./stat-facts";
import { topic } from "./topic";
import { blockArticle, songKey } from "./wrong-facts";

/**
 * Turns a song into timed fact bubbles.
 *
 *   live learn  -> no facts (the overlay shows a banner)
 *   original    -> facts from the queue entry, no lookup
 *   article     -> model restates it, screening filters the result
 *   no article  -> entry facts + topic packs, no model call
 *   failure     -> entry facts + topic packs
 */

/** Ask for a few spares; screening drops some. */
const OVERGENERATE = 2;
const MAX_TOKENS = 512;
/** Hosted reasoning models, such as Groq's free gpt-oss, spend part of their budget thinking. */
const HOSTED_MAX_TOKENS = 2048;

/**
 * Bubble slots as CSS percentages of a 1920x1080 overlay. Laid out to avoid a
 * song-queue panel top-left, a camera top-right, goal widgets bottom-right and
 * the song banner bottom-center. `left` is the bubble's left edge; keep it
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

/** Songs with no usable facts are retried after this long; others are kept. */
const RETRY_MS = 10 * 60 * 1000;
const factCache = new Map<string, { facts: Fact[]; expires: number }>();
/** The Wikipedia article each cached song's facts came from, for "Wrong". */
const sources = new Map<string, string>();
const inFlight = new Map<string, Promise<Fact[]>>();
const songsLog = () => path.join(config.logDir, "songs.log");
const SONGS_LOG_LABEL: Record<Outcome, string> = {
  grounded: "article",
  original: "original",
  liveLearn: "livelearn",
  noReference: "curated",
  nothingSurvived: "curated",
  generationFailed: "curated",
};

/** Count the outcome and append a line to logs/songs.log: time, title, artist field, outcome, count. */
function record(song: SSLSong, outcome: Outcome, count: number): void {
  factStats[outcome]++;
  factStats.lastOutcome = outcome;
  if (process.env.NODE_ENV === "test") return;
  const clean = (v: string) => (v ?? "").replace(/\s+/g, " ");
  const line = [new Date().toISOString(), clean(song.title), clean(song.artist), SONGS_LOG_LABEL[outcome], count];
  fs.mkdir(config.logDir, { recursive: true }, () =>
    fs.appendFile(songsLog(), line.join("\t") + "\n", () => undefined)
  );
}

function toFacts(lines: string[]): Fact[] {
  return lines.map((text, i) => ({
    text,
    delaySeconds: i * config.factIntervalSeconds,
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
      max_tokens: HOSTED_MAX_TOKENS,
    },
    config.openaiTimeoutMs,
    { Authorization: `Bearer ${config.openaiApiKey}` }
  );
  return data.choices?.[0]?.message?.content ?? "";
}

/** Primary Ollama host, then the fallback host if one is configured. Returns the text and the host that answered. */
async function askOllama(prompt: string): Promise<[string, string]> {
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
      return [data.response, host];
    } catch (err) {
      lastError = err;
      console.warn(`[FactGen] Ollama at ${host} failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  throw lastError;
}

// node-llama-cpp is an ES module. A plain import() would be compiled to require()
// under CommonJS and fail, so the import is kept out of the compiler's reach.
const importModule = new Function("specifier", "return import(specifier)") as (s: string) => Promise<any>;

/** The loaded model and one reusable chat session. Loading takes a few seconds, so it happens once. */
let builtin: Promise<{ session: any }> | undefined;

function loadBuiltin(): Promise<{ session: any }> {
  builtin ??= (async () => {
    const { getLlama, LlamaChatSession } = await importModule("node-llama-cpp");
    const llama = await getLlama(config.llamaGpu === "off" ? { gpu: false } : undefined);
    const model = await llama.loadModel({ modelPath: config.modelPath });
    const context = await model.createContext({ contextSize: 4096 });
    const session = new LlamaChatSession({ contextSequence: context.getSequence() });
    console.log(`[FactGen] Built-in model loaded (${llama.gpu || "cpu"})`);
    return { session };
  })().catch((err) => {
    builtin = undefined; // Let the next song retry the load.
    throw err;
  });
  return builtin;
}

/**
 * Load the built-in model at start-up rather than on the first song, so the
 * first song isn't slowed by loading and a load failure shows immediately.
 * The desktop app watches for the two log lines below.
 */
export async function warmUpBuiltin(): Promise<void> {
  if (config.aiProvider !== "builtin") return;
  try {
    await loadBuiltin();
  } catch (err) {
    console.error(`[FactGen] Built-in model failed to load: ${err instanceof Error ? err.message : err}`);
  }
}

/** The desktop app's built-in model. Each song starts from an empty chat history. */
async function askBuiltin(prompt: string): Promise<string> {
  const { session } = await loadBuiltin();
  session.resetChatHistory();
  return session.prompt(prompt, { temperature: config.temperature, maxTokens: MAX_TOKENS });
}

async function askModel(prompt: string): Promise<string> {
  const started = Date.now();
  let text: string;
  let endpoint: string;
  if (config.aiProvider === "builtin") {
    text = await askBuiltin(prompt);
    endpoint = "built-in model";
  } else if (config.aiProvider === "anthropic") {
    text = await askAnthropic(prompt);
    endpoint = `anthropic (${config.anthropicModel})`;
  } else if (config.aiProvider === "openai") {
    text = await askOpenAICompatible(prompt);
    endpoint = `${config.openaiBaseUrl} (${config.openaiModel})`;
  } else {
    [text, endpoint] = await askOllama(prompt);
  }
  factStats.lastEndpoint = endpoint;
  factStats.lastDurationMs = Date.now() - started;
  console.log(`[FactGen] ${endpoint} answered in ${(factStats.lastDurationMs / 1000).toFixed(1)}s`);
  return text;
}

// --- Pipeline ----------------------------------------------------------

/** Facts from the queue entry, topped up from the topic packs. True by construction. */
function entryFacts(entry: SSLQueueItem | null, want: number): string[] {
  const stats = buildStatFacts(entry, { streamerName: config.sslStreamerName }).slice(0, want);
  return [...stats, ...curatedFacts(want - stats.length)];
}

async function generate(song: SSLSong, entry: SSLQueueItem | null): Promise<{ facts: Fact[]; ttlMs: number }> {
  const want = config.factsPerSong;
  const keep = { facts: [] as Fact[], ttlMs: Infinity };

  if (song.liveLearn) {
    console.log(`[FactGen] "${song.title}" is a live learn, skipping facts`);
    record(song, "liveLearn", 0);
    return keep;
  }

  try {
    if (config.originals && isOriginal(entry, [config.sslStreamerName, config.streamerDisplayName])) {
      const stats = buildStatFacts(entry, { streamerName: config.sslStreamerName, isOriginalSong: true });
      const facts = toFacts([...stats, ...topic.originalsFacts].slice(0, want));
      console.log(`[FactGen] "${song.title}" is an original: ${facts.length} facts from the song entry`);
      record(song, "original", facts.length);
      // Not cached: requester and play count change, and this path is free.
      return { facts, ttlMs: 0 };
    }

    // No AI available (the desktop app's fallback when its model can't run):
    // song-list and hand-picked facts only, with no lookup.
    const context = config.aiProvider === "none" ? "" : config.factVerification ? await fetchGrounding(song) : "";
    if (config.aiProvider === "none" || (config.factVerification && !context)) {
      const lines = entryFacts(entry, want);
      console.log(`[FactGen] No reference for "${song.title}": using ${lines.length} entry and curated facts`);
      record(song, "noReference", lines.length);
      // Retried after the grounding negative cache expires.
      return { facts: toFacts(lines), ttlMs: RETRY_MS };
    }

    const prompt = context ? groundedPrompt(song, context, want + OVERGENERATE) : unverifiedPrompt(song, want);
    const lines = (await askModel(prompt)).split("\n").map((l) => l.trim()).filter(Boolean);
    const { kept, rejected } = screenClaims(lines, context);
    for (const r of rejected) console.log(`[Screen] DROP (${r.reason}): ${r.text.slice(0, 90)}`);
    const shown = kept.slice(0, want);
    console.log(`[Screen] "${song.title}": ${lines.length} generated, ${rejected.length} dropped, ${shown.length} shown`);

    if (shown.length) {
      record(song, "grounded", shown.length);
      sources.set(songKey(song), context.split("\n")[0]);
      return { facts: toFacts(shown), ttlMs: Infinity };
    }
    const fallback = entryFacts(entry, want);
    console.warn(`[FactGen] Nothing usable for "${song.title}", using ${fallback.length} entry and curated facts`);
    record(song, "nothingSurvived", fallback.length);
    return { facts: toFacts(fallback), ttlMs: RETRY_MS };
  } catch (err) {
    const fallback = entryFacts(entry, want);
    console.error(`[FactGen] Generation failed for "${song.title}":`, err);
    record(song, "generationFailed", fallback.length);
    return { facts: toFacts(fallback), ttlMs: RETRY_MS };
  }
}

/**
 * Facts for a song. Results are cached, and concurrent callers (several
 * overlays, a reconnect mid-generation) share one generation.
 */
export function generateFacts(song: SSLSong, entry: SSLQueueItem | null = null): Promise<Fact[]> {
  const key = songKey(song);
  const cached = factCache.get(key);
  if (cached && Date.now() < cached.expires) {
    factStats.cacheHits++;
    return Promise.resolve(cached.facts);
  }
  let pending = inFlight.get(key);
  if (!pending) {
    pending = generate(song, entry)
      .then(({ facts, ttlMs }) => {
        factCache.set(key, { facts, expires: Date.now() + ttlMs });
        return facts;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return pending;
}

export function clearFactCache(): void {
  factCache.clear();
  inFlight.clear();
  sources.clear();
}

/**
 * The streamer marked one of this song's facts wrong. The article it came
 * from is blocked for the song, and the cached facts are dropped, so the
 * next time it plays BubbleFacts looks again. Returns the blocked article,
 * or null when the facts didn't come from one (backup or song-list facts).
 */
export function markWrong(song: SSLSong): string | null {
  const key = songKey(song);
  const article = sources.get(key) ?? null;
  if (article) blockArticle(song, article);
  factCache.delete(key);
  sources.delete(key);
  console.log(`[WrongFact] "${song.title}": ${article ? `won't use "${article}" again` : "not from an article"}`);
  return article;
}
