import * as fs from "fs";
import * as path from "path";
import { config } from "./config";
import { Fact, SSLQueueItem, SSLSong } from "./types";
import { artistNames, curatedFacts, explainMusicTerms, fetchGrounding, mentionsName, normalizeTitle, resolveGameAndTrack, restatesRequest, screenClaims, supportingSentence, tooSimilar } from "./fact-verifier";
import { buildStatFacts, isOriginal, isOwnOriginal } from "./stat-facts";
import { parseVideoTitle } from "./youtube-title";
import { readings } from "./list-profile";
import { topic } from "./topic";
import { musicbrainzFacts } from "./musicbrainz";
import { wikidataFacts } from "./wikidata";
import { findSongFacts, songFactLines } from "./song-facts";
import { blockArticle, blockedArticles, songKey, unblockArticle } from "./wrong-facts";

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
const OVERGENERATE = 3;
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

type Outcome = "grounded" | "wikidata" | "musicbrainz" | "songFacts" | "original" | "liveLearn" | "noReference" | "nothingSurvived" | "generationFailed";

/** Per-session counts, reported on /health. */
export const factStats = {
  grounded: 0,
  wikidata: 0,
  musicbrainz: 0,
  songFacts: 0,
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
/** Stands for Wikidata and MusicBrainz in the blocklist, alongside Wikipedia article titles. */
export const STRUCTURED = "Wikidata and MusicBrainz";
/** The Wikidata or MusicBrainz sentences each song was given, to tell which source a wrong fact came from. */
const structuredShown = new Map<string, Set<string>>();
/** Which database each structured sentence came from, for the dashboard. */
const structuredLabel = new Map<string, string>();
/** The Wikipedia article each cached song's facts came from, for "Wrong". */
const sources = new Map<string, string>();
/**
 * Facts already written for earlier songs this session. Songs by the same
 * artist often share the artist's article, and the same facts twice in a row
 * look broken (issue #19).
 */
const RECENT_KEPT = 80;
const recentFacts: string[] = [];
const inFlight = new Map<string, Promise<Fact[]>>();
/** A streamer's handle as the artist: "@janeplayskeys", "Jane (@janeplayskeys)". */
const STREAMER_HANDLE = /(?:^|[\s(])@([A-Za-z0-9_]{3,25})\)?\s*$/;
const songsLog = () => path.join(config.logDir, "songs.log");
const SONGS_LOG_LABEL: Record<Outcome, string> = {
  grounded: "article",
  wikidata: "wikidata",
  musicbrainz: "musicbrainz",
  songFacts: "yours",
  original: "original",
  liveLearn: "livelearn",
  noReference: "curated",
  nothingSurvived: "curated",
  generationFailed: "curated",
};

/** How each song's facts last turned out, so the dashboard can tell "nothing reliable" from "failed". */
const outcomes = new Map<string, Outcome>();
export const outcomeFor = (song: SSLSong): string => outcomes.get(songKey(song)) ?? "";

/** Count the outcome and append a line to logs/songs.log: time, title, artist field, outcome, count. */
function record(song: SSLSong, outcome: Outcome, count: number): void {
  factStats[outcome]++;
  factStats.lastOutcome = outcome;
  outcomes.set(songKey(song), outcome);
  if (process.env.NODE_ENV === "test") return;
  const clean = (v: string) => (v ?? "").replace(/\s+/g, " ");
  const line = [new Date().toISOString(), clean(song.title), clean(song.artist), SONGS_LOG_LABEL[outcome], count];
  fs.mkdir(config.logDir, { recursive: true }, () =>
    fs.appendFile(songsLog(), line.join("\t") + "\n", () => undefined)
  );
}

/** Where each kind of fact comes from, as the dashboard labels it. */
export const SOURCE = {
  yours: "Your facts for this song",
  songList: "Your song list",
  custom: "Your custom facts",
  wikidata: "Wikidata",
  musicbrainz: "MusicBrainz",
} as const;

/** Facts the streamer typed in go up as written; everything else must tell viewers something new. */
const WRITTEN_BY_STREAMER: ReadonlySet<string | undefined> = new Set([SOURCE.yours, SOURCE.custom]);

function toFacts(
  song: SSLSong,
  lines: string[],
  sourceOf: (text: string) => string | undefined = () => undefined,
  /** The Wikipedia reference the captions were written from, to show the streamer what each rests on. */
  context = ""
): Fact[] {
  const told = lines.filter((text) => {
    if (WRITTEN_BY_STREAMER.has(sourceOf(text)) || !restatesRequest(text, song)) return true;
    console.log(`[Screen] DROP (repeats the request): ${text.slice(0, 90)}`);
    return false;
  });
  const page = context.split("\n")[0];
  return told.map((text, i) => {
    const source = sourceOf(text);
    const fromArticle = Boolean(page) && source === `Wikipedia: ${page}`;
    const evidence = fromArticle ? supportingSentence(text, context) : "";
    return {
      text,
      source,
      ...(fromArticle ? { url: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.replace(/ /g, "_"))}` } : {}),
      ...(evidence ? { evidence } : {}),
      delaySeconds: i * config.factIntervalSeconds,
      durationSeconds: config.factDurationSeconds,
      position: POSITIONS[i % POSITIONS.length],
    };
  });
}

// --- Prompts -----------------------------------------------------------

function subjectLine(song: SSLSong): { game: string; intro: string } {
  const { game, track } = resolveGameAndTrack(song);
  const work = track && track !== game ? `"${track}" from ${game}` : `"${track || game}"`;
  // Nothing about the streamer goes in: an online AI gets the song and the article, no more (final QA #7).
  return {
    game,
    intro: `You are writing short trivia captions for a live music stream overlay. The song playing right now is ${work}.`,
  };
}

/**
 * Written for a 3B model: the source comes first, and every rule is a test
 * the model can apply to its own sentence rather than "be accurate".
 */
/**
 * The prompt, laid out as CROSS: Context, Role, Objective, Source, Scope.
 * PROMPT_STYLE=rules switches back to the numbered rule list below.
 */
function crossPrompt(song: SSLSong, context: string, want: number): string {
  const { game, track } = resolveGameAndTrack(song);
  const work = track && track !== game ? `"${track}" from ${game}` : `"${track || game}"`;
  return `CONTEXT
A musician is playing ${work} live on a stream right now. Short captions about the song pop up on screen, one at a time, in small bubbles. The readers are the viewers in chat: music fans of every level, not experts.

ROLE
Act as a music trivia writer for live streams, who knows what makes a chat say "wait, really?".

OBJECTIVE
Write ${want} captions about ${game} or its music that chat would find surprising, funny or fascinating. In order of preference: what the people who made it said or did, who or what influenced it, how the music is built, and how it was received (charts, awards, sales). Do not add praise or opinions of your own.

SOURCE
Use only the text between the triple quotes. Every person, year, number and title you write must appear in it, spelled the same way. Each line retells ONE statement from the text: never join two statements, and never move a name or a detail from one statement into another. If the text does not say something, leave it out.
"""
${context}
"""

SCOPE
Exactly ${want} lines. One sentence per line, under 120 characters, in plain words anyone can follow. No numbering, bullets, headings or wrapping quotes. Nothing about the music video. Skip release dates, record labels, catalog numbers and formats unless the text has nothing better. Never mention the text, this prompt or what you could not find.`;
}

function groundedPrompt(song: SSLSong, context: string, want: number): string {
  // CROSS is the default: in trials it followed the rules better and gave more reception facts (issue #48).
  if (process.env.PROMPT_STYLE !== "rules") return crossPrompt(song, context, want);
  const { game, intro } = subjectLine(song);
  return `${intro}

Everything you write must come from the SOURCE below. It is the only information you are allowed to use.

SOURCE
"""
${context}
"""

Write exactly ${want} trivia lines about ${game} or its music. Your readers are the stream's chat: pick what they would find surprising, funny or fascinating, the kind of thing someone repeats to a friend. Skip dry details (labels, catalog numbers, release formats) unless the SOURCE has nothing better.

Follow every rule:
1. Use ONLY the SOURCE. Every person, year, number, platform, studio, and title you write must appear in the SOURCE, spelled the same way.
2. Match the SOURCE's subject. If it describes a song, film, or classical work rather than a video game, write about that — never force a gaming angle onto music that has nothing to do with games.
3. Each line restates ONE statement from the SOURCE. Never merge two statements, and never move a name from one statement into another — if the SOURCE says someone composed the music, do not say they wrote the story or designed the game.
4. If the SOURCE does not name a composer, do NOT name a composer — write about a different detail the SOURCE does give.
5. Do not mention awards, sales, chart positions, or review scores unless the SOURCE uses those words.
   Never write opinions or praise ("considered", "acclaimed", "one of the greatest"), even if the SOURCE quotes them.
   Never describe the music video: viewers are watching it. Write about the song itself.
6. Prefer what the people who made the music said or did. If the SOURCE says someone "said", "recalled" or was "inspired by" something, retell that in your own words and keep their name. Then who or what influenced it, how the music is built (key, tempo, chords, form), and how it was received (a chart position, award, certification or sales), when the SOURCE gives them. Then the instruments and how it was recorded, arranged or first performed.
7. Never mention the SOURCE, this prompt, Wikipedia, or anything you could not find. Write finished facts only.
8. One sentence per line, under 120 characters, friendly like a loading-screen tip, in plain words anyone can follow.
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

/** Longest the built-in model may write for one song before it's stopped. */
const BUILTIN_TIMEOUT_MS = 90_000;
let builtinQueue: Promise<unknown> = Promise.resolve();

/** A song that's no longer on stream: its queued or running AI work is dropped. */
class Obsolete extends Error {}
/** The song on stream now, set by the server; null when unknown (tests, the self-test). */
let currentKey: string | null = null;
let running: { key: string | null; stop: AbortController } | null = null;

/**
 * The server says which song is on stream. Work for any other song is no
 * longer wanted: the running generation stops now, and queued ones are skipped
 * when their turn comes, so skipping songs quickly can't build a backlog in
 * front of the current one.
 */
export function setCurrentSong(song: SSLSong | null): void {
  currentKey = song ? songKey(song) : null;
  if (running?.key && running.key !== currentKey) running.stop.abort();
}
const obsolete = (key: string | null) => key !== null && currentKey !== null && key !== currentKey;

/**
 * The desktop app's built-in model. There is one chat session, so songs take
 * turns: resetting the history and prompting happen together, inside the
 * queue, or a song that changes mid-generation would inherit the previous
 * song's conversation. Each turn is cut off after BUILTIN_TIMEOUT_MS; what
 * was written so far is still screened like any other output.
 */
function askBuiltin(prompt: string, key: string | null = null): Promise<string> {
  const run = async () => {
    if (obsolete(key)) throw new Obsolete();
    const { session } = await loadBuiltin();
    session.resetChatHistory();
    const stop = new AbortController();
    running = { key, stop };
    try {
      const text = (await session.prompt(prompt, {
        temperature: config.temperature,
        maxTokens: MAX_TOKENS,
        signal: AbortSignal.any([AbortSignal.timeout(BUILTIN_TIMEOUT_MS), stop.signal]),
        stopOnAbortSignal: true,
      })) as string;
      if (stop.signal.aborted) throw new Obsolete();
      return text;
    } finally {
      running = null;
    }
  };
  const turn = builtinQueue.then(run, run);
  builtinQueue = turn.catch(() => undefined);
  return turn;
}

async function askModel(prompt: string, key: string | null = null): Promise<string> {
  const started = Date.now();
  let text: string;
  let endpoint: string;
  if (config.aiProvider === "builtin") {
    text = await askBuiltin(prompt, key);
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

/** Plain facts about the song itself: Wikidata first, then MusicBrainz, unless marked wrong for it. */
/** `as` is the reading of the song to look up; the bookkeeping stays with the song as requested. */
async function structuredFacts(song: SSLSong, as: SSLSong = song): Promise<string[]> {
  if (blockedArticles(song).has(STRUCTURED)) return [];
  const data = await wikidataFacts(as);
  const facts = data.length ? data : await musicbrainzFacts(as);
  structuredShown.set(songKey(song), new Set(facts));
  for (const f of facts) structuredLabel.set(f, data.length ? SOURCE.wikidata : SOURCE.musicbrainz);
  return facts;
}

/** Remember facts as shown, keeping only the last RECENT_KEPT. */
function remember(shown: string[]): void {
  recentFacts.push(...shown);
  recentFacts.splice(0, Math.max(0, recentFacts.length - RECENT_KEPT));
}

/** Whether the reference is the song's own article, rather than its artist's or game's. */
function aboutTheSong(song: SSLSong, context: string): boolean {
  const { game, track } = resolveGameAndTrack(song);
  if (!track || track === game) return true;
  return mentionsName(normalizeTitle(context.split("\n")[0]), [normalizeTitle(track)]);
}

/** Facts from the queue entry, topped up from the topic packs. True by construction. */
function entryFacts(entry: SSLQueueItem | null, want: number): string[] {
  const stats = buildStatFacts(entry, { streamerName: config.sslStreamerName }).slice(0, want);
  for (const s of stats) statLines.add(s);
  return [...stats, ...curatedFacts(want - stats.length)];
}

/** Lines built from the song list, so the dashboard can tell them from custom facts. */
const statLines = new Set<string>();
const entrySource = (t: string) => (statLines.has(t) ? SOURCE.songList : SOURCE.custom);

/**
 * The streamer's custom facts tagged for this song: "[Song of Storms] ...",
 * "[Chopin] ...", "[Undertale] ...". The tag is the title, the artist or the
 * game, compared without case, accents or punctuation.
 */
export function taggedFactsFor(song: SSLSong): string[] {
  if (!topic.taggedFacts?.length) return [];
  const { game, track } = resolveGameAndTrack(song);
  const names = new Set(
    [song.title, track, game, `${song.artist} ${song.title}`, ...artistNames(song.artist ?? "")].map((s) => normalizeTitle(s ?? "")).filter(Boolean)
  );
  return topic.taggedFacts.filter((f) => names.has(normalizeTitle(f.tag.replace(/\s+[-–—]\s+/, " ")))).map((f) => f.text);
}

/** The streamer's tagged facts first, as written, then the usual facts in the slots left. */
async function generate(song: SSLSong, entry: SSLQueueItem | null): Promise<{ facts: Fact[]; ttlMs: number }> {
  const want = config.factsPerSong;
  const mine = findSongFacts(song) ? [] : taggedFactsFor(song).slice(0, want);
  if (!mine.length) return generateRest(song, entry, want);
  console.log(`[FactGen] "${song.title}": ${mine.length} of the streamer's own facts are for this song`);
  const rest = mine.length < want ? await generateRest(song, entry, want - mine.length) : { facts: [], ttlMs: Infinity };
  const others = rest.facts.filter((f) => !mine.includes(f.text));
  // Re-spaced as one list, so the bubbles keep their rhythm and positions.
  const lines = [...mine, ...others.map((f) => f.text)];
  // Labeled as custom facts: that's where the streamer edits them.
  const sourceOf = (t: string) => (mine.includes(t) ? SOURCE.custom : others.find((f) => f.text === t)?.source);
  // Re-spacing rebuilds each fact, so the article link and source sentence are carried across.
  const sourced = new Map(others.map((f) => [f.text, f]));
  const facts = toFacts(song, lines, sourceOf).map((f) => {
    const was = sourced.get(f.text);
    return was ? { ...f, ...(was.url ? { url: was.url } : {}), ...(was.evidence ? { evidence: was.evidence } : {}) } : f;
  });
  return { facts, ttlMs: rest.ttlMs };
}

/**
 * What to look up for a live learn: the request as typed, or, when no artist
 * was given, the artist and title read from it the way a YouTube title is
 * read ("Rick Astley - Never Gonna Give You Up (Official Video)"). Null when
 * no artist can be told: a bare title is too easy to mismatch.
 */
export function liveLearnLookup(song: SSLSong): SSLSong | null {
  const artist = (song.artist ?? "").trim();
  if (artist && !/^unknown$/i.test(artist)) return { title: song.title, artist };
  const parsed = parseVideoTitle(song.title);
  if (!parsed.artist || !parsed.title) return null;
  return { title: parsed.title, artist: parsed.artist, ...(parsed.performer ? { performer: true } : {}), ...(parsed.confident ? {} : { artistUncertain: true }) };
}

/** `sourcedOnly`: facts from a source or none; never song-list or custom facts (a live learn's look-up). */
async function generateRest(song: SSLSong, entry: SSLQueueItem | null, want: number, sourcedOnly = false): Promise<{ facts: Fact[]; ttlMs: number }> {
  const keep = { facts: [] as Fact[], ttlMs: Infinity };

  // Facts the streamer wrote for this very song come first, exactly as written,
  // with no lookup, even for a live learn: often another streamer's off-list original.
  const yours = findSongFacts(song);
  if (yours) {
    const lines = songFactLines(yours, want);
    console.log(`[FactGen] "${song.title}": ${lines.length} of the streamer's own facts for this song`);
    record(song, "songFacts", lines.length);
    // Not cached: an edit in the app applies the next time it plays.
    return { facts: toFacts(song, lines, () => SOURCE.yours), ttlMs: 0 };
  }

  if (song.liveLearn) {
    // The LIVE LEARN banner still shows. A well-known song gets its facts too (issue #45);
    // one no source knows gets none, never filler.
    const lookup = config.factVerification && config.aiProvider !== "none" ? liveLearnLookup(song) : null;
    const found = lookup ? await generateRest(lookup, null, want, true) : keep;
    if (found.facts.length) {
      console.log(`[FactGen] "${song.title}" is a live learn: ${found.facts.length} facts, looked up as "${lookup?.title}" by ${lookup?.artist}`);
      return found;
    }
    console.log(`[FactGen] "${song.title}" is a live learn with nothing to look up or find, so no facts`);
    record(song, "liveLearn", 0);
    return { facts: [], ttlMs: found.ttlMs };
  }
  const none = { facts: [] as Fact[], ttlMs: RETRY_MS };

  try {
    const names = [config.sslStreamerName, config.streamerDisplayName];
    if (config.originals && isOriginal(entry, names)) {
      const stats = buildStatFacts(entry, { streamerName: config.sslStreamerName, isOriginalSong: true, names });
      // The streamer's notes about their own compositions go first, but only with their own pieces.
      // Two per play, picked at random, so the same notes don't fill every original.
      const notes = isOwnOriginal(entry, names) ? [...topic.originalsFacts].sort(() => Math.random() - 0.5) : [];
      const statSet = new Set(stats);
      const lines = [...notes.slice(0, 2), ...stats, ...notes.slice(2)];
      const facts = toFacts(song, lines, (t) => (statSet.has(t) ? SOURCE.songList : SOURCE.custom)).slice(0, want);
      console.log(`[FactGen] "${song.title}" is an original: ${facts.length} facts from the song entry`);
      record(song, "original", facts.length);
      // Not cached: requester and play count change, and this path is free.
      return { facts, ttlMs: 0 };
    }

    // No AI available (the desktop app's fallback when its model can't run):
    // song-list and hand-picked facts only, with no lookup.
    // Streamers write their lists differently ("Game - Track" with the composer as artist,
    // "Track (Film)"...). Each reading is tried until one finds an article; `read` is that one.
    let context = "";
    let read = song;
    // "Jane (@janeplayskeys)": a fellow streamer's piece. No encyclopedia knows it, so nothing is looked up.
    const handle = STREAMER_HANDLE.exec(song.artist ?? "")?.[1];
    if (handle) console.log(`[FactGen] "${song.title}" is credited to a streamer (@${handle}): not looked up`);
    if (config.aiProvider !== "none" && config.factVerification && !handle) {
      for (const reading of readings(song)) {
        const found = await fetchGrounding(reading);
        if (!found) continue;
        // The artist's life story is the weakest find: kept, but another reading may find the song or its game.
        const onlyTheArtist = artistNames(reading.artist ?? "").includes(normalizeTitle(found.split("\n")[0]));
        if (context && onlyTheArtist) continue;
        context = found;
        read = reading;
        if (!onlyTheArtist) break;
      }
      if (read !== song) console.log(`[FactGen] "${song.title}" read as "${read.title}" from ${read.artist}`);
    }
    if (config.aiProvider === "none" || (config.factVerification && !context)) {
      // No article: plain facts from Wikidata, then MusicBrainz, need no AI (issue #23).
      const data = config.factVerification && !handle ? await structuredFacts(song, read) : [];
      const shownData = data.filter((f) => !recentFacts.includes(f) && !restatesRequest(f, song)).slice(0, want);
      if (shownData.length) {
        remember(shownData);
        record(song, structuredLabel.get(shownData[0]) === SOURCE.musicbrainz ? "musicbrainz" : "wikidata", shownData.length);
        return { facts: toFacts(song, shownData, (t) => structuredLabel.get(t)), ttlMs: Infinity };
      }
      if (sourcedOnly) return none;
      const lines = entryFacts(entry, want);
      console.log(`[FactGen] No reference for "${song.title}": using ${lines.length} entry and curated facts`);
      record(song, "noReference", lines.length);
      // Retried after the grounding negative cache expires.
      return { facts: toFacts(song, lines, entrySource), ttlMs: RETRY_MS };
    }

    // An article about the artist or game, not the song itself: facts about
    // the song come first when Wikidata or MusicBrainz has any ("describe the
    // song, then tell about it").
    const songFacts = context && !aboutTheSong(read, context) ? await structuredFacts(song, read) : [];

    const prompt = context ? groundedPrompt(read, context, want + OVERGENERATE) : unverifiedPrompt(song, want);
    const lines = (await askModel(prompt, songKey(song))).split("\n").map((l) => l.trim()).filter(Boolean);
    const { kept, rejected } = screenClaims(lines, context);
    for (const r of rejected) console.log(`[Screen] DROP (${r.reason}): ${r.text.slice(0, 90)}`);
    // Music terms get a few fixed plain words, so any viewer can follow.
    const fresh = kept.filter((f) => !recentFacts.some((r) => tooSimilar(r, f))).map(explainMusicTerms);
    if (fresh.length < kept.length) console.log(`[Screen] DROP ${kept.length - fresh.length} already shown for an earlier song`);
    // A spare takes the place of a line that only repeats the title and artist.
    const shown = [...songFacts.filter((f) => !recentFacts.includes(f)), ...fresh].filter((f) => !restatesRequest(f, song)).slice(0, want);
    remember(shown);
    console.log(`[Screen] "${song.title}": ${lines.length} generated, ${rejected.length} dropped, ${shown.length} shown`);

    if (shown.length) {
      record(song, "grounded", shown.length);
      sources.set(songKey(song), context.split("\n")[0]);
      const article = `Wikipedia: ${context.split("\n")[0]}`;
      return { facts: toFacts(song, shown, (t) => structuredLabel.get(t) ?? article, context), ttlMs: Infinity };
    }
    if (sourcedOnly) return none;
    const fallback = entryFacts(entry, want);
    console.warn(`[FactGen] Nothing usable for "${song.title}", using ${fallback.length} entry and curated facts`);
    record(song, "nothingSurvived", fallback.length);
    return { facts: toFacts(song, fallback, entrySource), ttlMs: RETRY_MS };
  } catch (err) {
    if (err instanceof Obsolete) {
      // Not cached: the song may come back, and then it deserves a real try.
      console.log(`[FactGen] Dropped "${song.title}": the song changed before its facts were written`);
      return { facts: [], ttlMs: 0 };
    }
    if (sourcedOnly) return none;
    const fallback = entryFacts(entry, want);
    console.error(`[FactGen] Generation failed for "${song.title}":`, err);
    record(song, "generationFailed", fallback.length);
    return { facts: toFacts(song, fallback, entrySource), ttlMs: RETRY_MS };
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
  const rev = revisions.get(key) ?? 0;
  let pending = inFlight.get(key);
  if (!pending) {
    pending = generate(song, entry)
      .then(({ facts, ttlMs }) => {
        // A generation started before the song's facts changed may not overwrite them.
        if ((revisions.get(key) ?? 0) === rev) factCache.set(key, { facts, expires: Date.now() + ttlMs });
        // What viewers see, so a stream's log can be read back for quality, not just counts.
        for (const f of facts) console.log(`[Shown] "${song.title}" (${f.source ?? "no source"}): ${f.text}`);
        return facts;
      })
      .finally(() => {
        if (inFlight.get(key) === pending) inFlight.delete(key);
      });
    inFlight.set(key, pending);
  }
  // Superseded while it ran (the streamer saved facts for this song): start over.
  return pending.then((facts) => ((revisions.get(key) ?? 0) === rev ? facts : generateFacts(song, entry)));
}

/** Bumped when a song's facts change; a generation from an older revision is discarded. */
const revisions = new Map<string, number>();

export function clearFactCache(): void {
  factCache.clear();
  recentFacts.length = 0;
  inFlight.clear();
  sources.clear();
  structuredShown.clear();
}

/**
 * The streamer marked one of this song's facts wrong. Its source is blocked
 * for the song: the Wikipedia article, or Wikidata and MusicBrainz when the
 * fact came from them. The song's cached facts are dropped and forgotten as
 * "already shown", so the next time it plays BubbleFacts looks again.
 * Returns what was blocked, or null for custom, song-list or the streamer's own song facts.
 */
export function markWrong(song: SSLSong, text: string): string | null {
  const key = songKey(song);
  const source = structuredShown.get(key)?.has(text) ? STRUCTURED : (sources.get(key) ?? null);
  if (source) blockArticle(song, source);
  const dropped = new Set((factCache.get(key)?.facts ?? []).map((f) => f.text));
  for (let i = recentFacts.length - 1; i >= 0; i--) if (dropped.has(recentFacts[i])) recentFacts.splice(i, 1);
  factCache.delete(key);
  sources.delete(key);
  structuredShown.delete(key);
  console.log(`[WrongFact] "${song.title}": ${source ? `won't use ${source === STRUCTURED ? source : `"${source}"`} again` : "not from a lookup"}`);
  return source;
}

/**
 * Writes captions for a made-up song from a fixed reference and screens
 * them, as a real song would be. The packaged-app smoke test runs two at once
 * to check the built-in model, the screening and the turn-taking queue
 * together (review: loading the model alone proved too little).
 */
export async function selfTest(variant = 0): Promise<{ generated: number; kept: string[]; ms: number }> {
  const started = Date.now();
  const title = variant ? "Starfall Nocturne" : "Starfall Overture";
  const context = `${title}\n${title} is a 2019 piece of video game music composed by Mia Chen for the game Starfall. ` +
    "It was recorded with a string quartet in Lisbon. The game was directed by John Smith and released for the Nintendo Switch.";
  const song: SSLSong = { title, artist: "Starfall" };
  const lines = (await askModel(groundedPrompt(song, context, 4))).split("\n").map((l) => l.trim()).filter(Boolean);
  const { kept } = screenClaims(lines, context);
  return { generated: lines.length, kept, ms: Date.now() - started };
}

/** Forget a song's cached facts, so its next generation starts over (after its own facts change). */
export function forgetSong(song: SSLSong): void {
  const key = songKey(song);
  revisions.set(key, (revisions.get(key) ?? 0) + 1);
  factCache.delete(key);
  inFlight.delete(key);
  // Its old sources too: Wrong on the new facts must not block an article from before.
  sources.delete(key);
  structuredShown.delete(key);
}

/** Undo "Wrong": the source may be used for the song again. */
export function unmarkWrong(song: SSLSong, source: string): void {
  unblockArticle(song, source);
  console.log(`[WrongFact] "${song.title}": "${source}" allowed again`);
}
