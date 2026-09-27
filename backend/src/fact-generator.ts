import { config } from "./config";
import * as fs from "fs";
import * as path from "path";
import { PopUpFact, SSLSong } from "./types";
import { fetchGrounding, resolveGameAndTrack, screenClaims, topUp } from "./fact-verifier";
import { SSLQueueItem } from "./types";
import { buildStatFacts, isOriginal, ORIGINALS_FACTS } from "./stat-facts";

// Lazy-init Anthropic client only when needed
let anthropic: import("@anthropic-ai/sdk").default | null = null;

function getAnthropicClient(): import("@anthropic-ai/sdk").default {
  if (!anthropic) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Anthropic = require("@anthropic-ai/sdk").default;
    anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
  }
  return anthropic!;
}

// Cache to avoid regenerating facts for the same song
const factCache = new Map<string, PopUpFact[]>();

/**
 * Ask for a couple more lines than we display. Screening drops some, and
 * over-generating is far cheaper than a second round trip — or than padding
 * the result with generic filler.
 */
const OVERGENERATE = 2;

/**
 * Outcome counters, surfaced on /health.
 *
 * The central question during a stream is "are viewers seeing facts about
 * the song, or generic filler?" — and until now the only way to answer it
 * was to watch the terminal, which a performing pianist cannot do. These
 * count the branches that already exist and are already logged.
 */
export const factStats = {
  grounded: 0,
  original: 0,
  liveLearn: 0,
  noReference: 0,
  generationFailed: 0,
  nothingSurvived: 0,
  cacheHits: 0,
  lastDurationMs: 0 as number,
  lastEndpoint: "" as string,
  lastOutcome: "" as string,
};

function songKey(song: SSLSong): string {
  return `${song.artist ?? "Unknown"}:::${song.title}`.toLowerCase();
}

function generateFactId(): string {
  return `fact_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * One line per song to logs/songs.log for a post-stream readout:
 *   <ISO time>\t<title>\t<game>\t<outcome>\t<fact count>
 * Outcome is article / curated / original / livelearn. Fire-and-forget and
 * never throws; skipped under jest so tests do not write into the repo.
 */
const SONGS_LOG = path.resolve(__dirname, "../../logs/songs.log");
function logSong(song: SSLSong, outcome: string, count: number): void {
  if (process.env.NODE_ENV === "test") return;
  const clean = (v: string) => (v ?? "").replace(/[\t\r\n]+/g, " ");
  const line = [new Date().toISOString(), clean(song.title), clean(song.artist), outcome, count].join("\t");
  fs.mkdir(path.dirname(SONGS_LOG), { recursive: true }, () => {
    fs.appendFile(SONGS_LOG, line + "\n", () => {});
  });
}

/**
 * Bubble placement. `left` is the bubble's LEFT EDGE, and a bubble can be up
 * to --bubble-max-width (560px ≈ 29% of a 1920 canvas, ~130px tall at three
 * lines), so left must stay under ~66% or the bubble runs off the right edge.
 *
 * These slots were laid out around one real stream scene (1920x1080, overlay
 * at 0,0 / scale 1.0) and are a reasonable default for a typical layout with
 * a song-queue panel top-left, a camera or capture top-right, and goal
 * widgets bottom-right. Edit them for your own scene. The sources that
 * scene had, which bubbles must not cover:
 *
 *   Source                          Canvas area (px)
 *   Song queue (SSL browser)        x 0-600,     y 0-380
 *   Camera / capture (top right)    x 1233-1920, y 0-~600
 *   Sub goal + Follower goal        x 1406-1920, y 855-1080
 *   Channel logo                    x 0-150,     y 827-977
 *   Song toast (this overlay)       bottom-centre, y ~970-1020
 *
 * That leaves two clear regions:
 *   A: centre strip above the captures — left 32-36%, top 6-44%
 *   B: band between captures and goals/logo — left 9-40%, top 56-72%
 *
 * With FACT_INTERVAL_SECONDS (15) > FACT_DURATION_SECONDS (8) only one
 * bubble is on screen at a time, so slots need not avoid each other.
 */
const POSITIONS = [
  { top: "8%",  left: "33%" },
  { top: "57%", left: "9%"  },
  { top: "26%", left: "33%" },
  { top: "57%", left: "40%" },
  { top: "42%", left: "33%" },
  { top: "70%", left: "9%"  },
  { top: "16%", left: "34%" },
  { top: "70%", left: "40%" },
];

/**
 * The grounded prompt.
 *
 * This is written as a *restatement* task, not a trivia-recall task: the
 * reference comes first, the model is told it is the only permitted source,
 * and every rule is a concrete test the model can apply to its own sentence
 * ("does this name appear in the SOURCE?") rather than a vague instruction
 * to be accurate. That framing is what a small model can actually follow —
 * "be accurate" is not, and "don't hallucinate" is not.
 *
 * Rule 2 matters most in practice. Told only to avoid inventing composers,
 * the model would still name one; told what to write *instead*, it writes
 * that instead.
 */
/** "playing X on piano" when INSTRUMENT is set, otherwise "performing X". */
function performing(attribution: string): string {
  return config.instrument ? `playing ${attribution} on ${config.instrument}` : `performing ${attribution}`;
}

function buildGamePrompt(song: SSLSong, context: string, want: number): string {
  const { game, track } = resolveGameAndTrack(song);
  // Deliberately neutral about genre. The setlist spans video game music,
  // film and musical soundtracks, classical repertoire, pop, and the streamer's
  // own compositions — telling the model it is "a video game music expert" made
  // it force a gaming angle onto a Chopin nocturne. The SOURCE decides what
  // kind of work this is; the prompt only has to stop the model guessing.
  const attribution = track && track !== game ? `"${track}" from ${game}` : `"${track || game}"`;
  return `You are writing short trivia captions for a live music stream overlay. The streamer, ${config.streamerDisplayName}, is ${performing(attribution)} right now.

Everything you write must come from the SOURCE below. It is the only information you are allowed to use.

SOURCE
"""
${context}
"""

Write exactly ${want} trivia lines about ${game} or its music.

Follow every rule:
1. Use ONLY the SOURCE. Every person, year, number, platform, studio, and title you write must appear in the SOURCE, spelled the same way.
1b. Match the SOURCE's subject. If it describes a song, film, or classical work rather than a video game, write about that — never force a gaming angle onto music that has nothing to do with games.
2. Each line restates ONE statement from the SOURCE. Never merge two statements, and never move a name from one statement into another — if the SOURCE says someone composed the music, do not say they wrote the story or designed the game.
3. If the SOURCE does not name a composer, do NOT name a composer — write about a different detail the SOURCE does give.
4. Do not mention awards, sales, chart positions, or review scores unless the SOURCE uses those words.
5. Prefer details about the music: the composer or songwriter, the instruments, how it was recorded, arranged or first performed. If the SOURCE has none, write about the work itself.
6. Never mention the SOURCE, this prompt, Wikipedia, or anything you could not find. Write finished facts only.
7. One sentence per line, under 120 characters, gamer-friendly like a loading-screen tip.
8. No numbering, bullets, quotes, or headings. Output exactly ${want} lines and nothing else.`;
}

/**
 * The from-memory prompt, used ONLY when FACT_VERIFICATION=off.
 *
 * This is the documented kill switch: no lookup, no screening, the model
 * writes about the song from its own knowledge. It is fast and it is wrong a
 * lot — a 3B model asked to recall video game trivia will confidently credit
 * Final Fantasy VII to the wrong composer. Nothing here can prevent that,
 * which is the whole reason the switch defaults to on.
 */
function buildUnverifiedPrompt(song: SSLSong, want: number): string {
  const { game, track } = resolveGameAndTrack(song);

  const attribution = track && track !== game ? `"${track}" from ${game}` : `"${track || game}"`;
  return `You are writing short trivia captions for a live music stream overlay. The streamer, ${config.streamerDisplayName}, is ${performing(attribution)} right now.

Write exactly ${want} trivia lines about ${game} or its music.

Follow every rule:
1. Write only things you are confident are true. If you are unsure who composed the music, do not name a composer.
2. Do not mention awards, sales, chart positions, or review scores.
3. Never mention this prompt or say what you could not find. Write finished facts only.
4. One sentence per line, under 120 characters, gamer-friendly like a loading-screen tip.
5. No numbering, bullets, quotes, or headings. Output exactly ${want} lines and nothing else.`;
}

/**
 * Parse every non-empty line. Deliberately does NOT truncate: trimming here
 * spent slots on preamble the model emits ("Here are 7 trivia lines about…")
 * and discarded good lines past the limit without ever screening them, which
 * made OVERGENERATE effectively 1 instead of 2. screenAndTrim does the only
 * trim, after screening.
 */
function parseFactLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function linesToFacts(lines: string[]): PopUpFact[] {
  return lines.map((text, i) => ({
    id: generateFactId(),
    text,
    appearAtSecond: i * config.factIntervalSeconds,
    durationSeconds: config.factDurationSeconds,
    position: POSITIONS[i % POSITIONS.length],
  }));
}

/**
 * Generate facts using the Anthropic Claude API.
 */
async function askAnthropic(prompt: string): Promise<string> {
  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: config.anthropicModel,
    max_tokens: 512,
    messages: [{ role: "user", content: prompt }],
  });

  return response.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/**
 * Any OpenAI-compatible chat-completions endpoint: Groq, OpenRouter, Gemini's
 * compat endpoint, LM Studio, vLLM. One code path covers every hosted free
 * tier, which is what makes the overlay usable without a local GPU.
 */
async function askOpenAICompatible(prompt: string): Promise<string> {
  const startedAt = Date.now();
  const res = await fetch(`${config.openaiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.openaiApiKey}`,
    },
    signal: AbortSignal.timeout(config.openaiTimeoutMs),
    body: JSON.stringify({
      model: config.openaiModel,
      messages: [{ role: "user", content: prompt }],
      temperature: config.ollamaTemperature,
      max_tokens: 512,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${config.openaiBaseUrl} request failed: ${res.status} ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = data.choices?.[0]?.message?.content ?? "";
  factStats.lastDurationMs = Date.now() - startedAt;
  factStats.lastEndpoint = `${config.openaiBaseUrl} (${config.openaiModel})`;
  return text;
}

async function ollamaRequest(baseUrl: string, prompt: string): Promise<string> {
  const url = `${baseUrl}/api/generate`;

  // Bound the request: a sleeping/unreachable host would otherwise hang
  // indefinitely and the fallback would never fire.
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(config.ollamaTimeoutMs),
    body: JSON.stringify({
      model: config.ollamaModel,
      prompt,
      stream: false,
      // Songs run 3-6 minutes and gaps between generations are longer still,
      // so Ollama's 5-minute idle default unloaded the model before nearly
      // every request — meaning most generations paid a full cold load first.
      // A strong candidate for the 19s-41s variance seen on the mini.
      keep_alive: config.ollamaKeepAlive,
      options: {
        // Restating a reference is a copying task, not a creative one.
        // High temperature is precisely what makes the model wander off the
        // source and invent names.
        temperature: config.ollamaTemperature,
        num_predict: 512,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama request failed (${baseUrl}): ${res.status} ${body}`);
  }

  const data = (await res.json()) as { response: string };
  return data.response;
}

/**
 * Ask Ollama. Tries the primary endpoint first (e.g. Mac mini), then falls
 * back to the fallback URL (e.g. localhost) if configured.
 */
async function askOllama(prompt: string): Promise<string> {
  // Timings are logged because endpoint latency is the difference between a
  // fact landing on the song it describes and landing on the next one. The
  // mini has been measured anywhere from 19s to 41s for one batch.
  const startedAt = Date.now();
  try {
    const out = await ollamaRequest(config.ollamaBaseUrl, prompt);
    factStats.lastDurationMs = Date.now() - startedAt;
    factStats.lastEndpoint = config.ollamaBaseUrl;
    console.log(
      `[FactGen] Generated via primary ${config.ollamaBaseUrl} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`
    );
    return out;
  } catch (primaryErr) {
    const failedAfter = ((Date.now() - startedAt) / 1000).toFixed(1);
    if (!config.ollamaFallbackUrl) {
      console.warn(
        `[FactGen] Primary Ollama (${config.ollamaBaseUrl}) failed after ${failedAfter}s, no fallback configured`
      );
      throw primaryErr;
    }

    console.warn(
      `[FactGen] Primary Ollama (${config.ollamaBaseUrl}) failed after ${failedAfter}s ` +
        `(${primaryErr instanceof Error ? primaryErr.message : primaryErr}), ` +
        `trying fallback (${config.ollamaFallbackUrl})`
    );
    const fallbackStart = Date.now();
    const out = await ollamaRequest(config.ollamaFallbackUrl, prompt);
    factStats.lastDurationMs = Date.now() - fallbackStart;
    factStats.lastEndpoint = `${config.ollamaFallbackUrl} (fallback)`;
    console.log(
      `[FactGen] Generated via fallback ${config.ollamaFallbackUrl} in ${((Date.now() - fallbackStart) / 1000).toFixed(1)}s`
    );
    return out;
  }
}

/** Single entrypoint to whichever provider is configured. */
function askModel(prompt: string): Promise<string> {
  switch (config.aiProvider) {
    case "anthropic":
      return askAnthropic(prompt);
    case "openai":
      return askOpenAICompatible(prompt);
    default:
      return askOllama(prompt);
  }
}

/**
 * Generate Pop Up Video-style fun facts about a song using AI.
 * Automatically uses the configured provider (Anthropic or Ollama).
 */
export async function generateFacts(
  song: SSLSong,
  entry: SSLQueueItem | null = null
): Promise<PopUpFact[]> {
  const key = songKey(song);

  // Return cached facts if available
  const cached = factCache.get(key);
  if (cached) {
    factStats.cacheHits++;
    console.log(`[FactGen] Cache hit for "${song.title}" by ${song.artist}`);
    return cached;
  }

  console.log(
    `[FactGen] Generating facts for "${song.title}" by ${song.artist ?? "Unknown"} via ${config.aiProvider}`
  );

  try {
    // A Live Learn is a request for something not on the list. There is
    // nothing to ground, and curated filler is the wrong content for that
    // segment — the overlay shows a persistent banner instead (new_song
    // still goes out; see server.ts). Not cached: the empty result is free.
    if (song.liveLearn) {
      factStats.liveLearn++;
      factStats.lastOutcome = "livelearn";
      console.log(`[FactGen] "${song.title}" is a live learn, skipping facts`);
      logSong(song, "livelearn", 0);
      return [];
    }

    // Originals never have a Wikipedia article and never will, so skip the
    // lookup entirely. It is not merely wasted: searching for them lands on
    // whatever is vaguely similar — "Laura's Wedding" returned "Luke and
    // Laura", "The Wedding Singer" and "Four Weddings and a Funeral" — and
    // the model would then write five faithful facts about a soap opera.
    // The entry's own data is song-specific and true without any of that.
    const original = isOriginal(entry, config.sslStreamerName);
    if (original) {
      const stats = buildStatFacts(entry, {
        streamerName: config.sslStreamerName,
        isOriginalSong: true,
      });
      const lines = [...stats, ...ORIGINALS_FACTS].slice(0, config.factsPerSong);
      factStats.original++;
      factStats.lastOutcome = "original";
      console.log(`[FactGen] "${song.title}" is an original — using entry data (${lines.length} facts)`);
      logSong(song, "original", lines.length);
      const facts = linesToFacts(lines);
      factCache.set(key, facts);
      return facts;
    }

    // 1. Ground: fetch real reference text so the model restates a source
    //    instead of recalling from memory.
    const context = config.factVerification ? await fetchGrounding(song) : "";

    // No reference means there is nothing to restate, and asking the model to
    // free-associate instead is where the remaining errors came from — it
    // credited Final Fantasy VII to Yoko Shimomura, and with no reference
    // there is nothing for screening to catch that against. So skip the model
    // and use facts that are true by construction.
    if (config.factVerification && !context) {
      // Prefer the entry's own data over generic curated trivia: play counts
      // and the streamer's own note are specific to THIS song and cannot be
      // wrong, where a Tetris fact under an unrelated piece is a non-sequitur.
      const stats = buildStatFacts(entry, { streamerName: config.sslStreamerName });
      const lines = [...stats, ...topUp(stats, config.factsPerSong)].slice(
        0,
        config.factsPerSong
      );
      factStats.noReference++;
      factStats.lastOutcome = "no-reference";
      logSong(song, "curated", lines.length);
      console.log(
        `[FactGen] No reference for "${song.title}" — ${stats.length} from the song entry, ` +
          `${lines.length - stats.length} curated`
      );
      // Deliberately NOT cached: this outcome reflects a lookup that failed
      // or found nothing, and grounding may well succeed on the next attempt
      // once its own negative TTL expires. Caching it here would reintroduce
      // the absorbing state that B1 removed, one level up.
      return linesToFacts(lines);
    }

    // 2. Generate against that reference, asking for a few spares.
    const want = config.factsPerSong + (config.factVerification ? OVERGENERATE : 0);
    const prompt = context
      ? buildGamePrompt(song, context, want)
      : buildUnverifiedPrompt(song, want);

    const lines = parseFactLines(await askModel(prompt));

    const shown = config.factVerification
      ? screenAndTrim(lines, context, song.title)
      : lines.slice(0, config.factsPerSong);

    // Nothing survived — better a curated true fact than an empty overlay.
    if (shown.length === 0) {
      factStats.nothingSurvived++;
      factStats.lastOutcome = "nothing-survived";
      logSong(song, "curated", config.factsPerSong);
      console.warn(`[FactGen] No usable facts for "${song.title}", using curated pool`);
      return getFallbackFacts(song);
    }

    const facts = linesToFacts(shown);
    factCache.set(key, facts);
    factStats.grounded++;
    factStats.lastOutcome = "grounded";
    logSong(song, "article", facts.length);
    console.log(`[FactGen] Generated ${facts.length} facts for "${song.title}"`);
    return facts;
  } catch (err) {
    factStats.generationFailed++;
    factStats.lastOutcome = "generation-failed";
    logSong(song, "curated", config.factsPerSong);
    console.error("[FactGen] Error generating facts:", err);
    return getFallbackFacts(song);
  }
}

/**
 * Screen, then trim to the display count. Deliberately does NOT pad a short
 * result from the curated pool: five facts about the game being played beats
 * four plus one about Tetris.
 */
function screenAndTrim(lines: string[], context: string, songTitle: string): string[] {
  const { kept, rejected } = screenClaims(lines, context);
  for (const r of rejected) {
    console.log(`[Screen] DROP (${r.reason}): ${r.text.slice(0, 90)}`);
  }

  console.log(
    `[Screen] "${songTitle}": ${lines.length} generated, ${rejected.length} dropped, ` +
      `${Math.min(kept.length, config.factsPerSong)} shown` +
      (context ? "" : " (no reference — general facts only)")
  );
  return kept.slice(0, config.factsPerSong);
}

/**
 * Fallback facts if AI generation fails entirely, or if nothing it produced
 * survived screening. Drawn from the curated (hand-verified) pool — the
 * previous hardcoded set contained errors, e.g. it credited Koji Kondo with
 * writing the Mario theme in a day, which conflates it with the Zelda
 * overworld theme story.
 */
function getFallbackFacts(song: SSLSong): PopUpFact[] {
  const fallbacks = [
    `"${song.title}" is being performed live by ${config.streamerDisplayName}!`,
    ...topUp([], config.factsPerSong - 1),
  ];

  return linesToFacts(fallbacks);
}

/** Clear the fact cache (useful for testing) */
export function clearFactCache(): void {
  factCache.clear();
}
