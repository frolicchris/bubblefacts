import * as os from "os";
import * as path from "path";
import { config } from "./config";
import { busyThreads, cpuTimes, CpuWatch, CPU_SAMPLE_MS, othersCpuShare, wordsPerSecond } from "./pace";
import { preparing } from "./prep-context";
import { NO_TODAY_DATE } from "./builtin-chat";
import { templateThinks } from "./thinking";

// The one way to the AI (issue #226): a prompt in, the reply's text out, one adapter per provider. The system prompt,
// temperature, token limits and the built-in model's turn queue live here. What the stream adds (pace, which song
// is on, the timing log) stays in fact-generator.ts (ARCHITECTURE.md: The life of one song)

const MAX_TOKENS = 512;
const HOSTED_MAX_TOKENS = 2048;  // hosted reasoning models (Groq's gpt-oss) spend part on thinking

// Song off stream: its AI work is dropped
export class Obsolete extends Error {}

// Built-in model: last speed, GPU, making room for the stream, threads
const builtinInfo: { wordsPerSecond: number | null; gpu: string | null; makingRoom: boolean; threads: number | null } = { wordsPerSecond: null, gpu: null, makingRoom: false, threads: null };
const cpuWatch = new CpuWatch();

/** The built-in model's last speed, GPU, making room and threads, and other programs' latest CPU share, for /health */
export const builtinState = (): Readonly<typeof builtinInfo> & { othersCpu: number | null } => ({ ...builtinInfo, othersCpu: cpuWatch.latestShare });

/** Same for every provider; without one, node-llama-cpp adds its own (ARCHITECTURE.md: The life of one song) */
export const SYSTEM_PROMPT =
  "You write short trivia captions for a live music stream. You use only the reference text you are given, and you follow the instructions exactly.";

let anthropic: import("@anthropic-ai/sdk").default | undefined;

async function askAnthropic(prompt: string): Promise<string> {
  if (!anthropic) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
  }
  const res = await anthropic.messages.create({
    model: config.anthropicModel,
    max_tokens: MAX_TOKENS,
    // No temperature: Anthropic's API (2026-10-21) rejects it
    system: SYSTEM_PROMPT,
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

const GROQ_FALLBACK_MODEL = "openai/gpt-oss-20b";

function isModelGone(err: unknown): boolean {
  return err instanceof Error && /returned (404|400):/.test(err.message) && /model_not_found|model_decommissioned|decommissioned|does not exist/i.test(err.message);
}

/** Any chat-completions AI; on Groq a retired hand-set model falls back once, not failing every song */
export async function askOpenAICompatible(prompt: string): Promise<string> {
  const send = async (model: string) => {
    const data = await postJSON<{ choices?: Array<{ message?: { content?: string } }> }>(
      `${config.openaiBaseUrl}/chat/completions`,
      {
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        temperature: config.temperature,
        max_tokens: HOSTED_MAX_TOKENS,
      },
      config.openaiTimeoutMs,
      { Authorization: `Bearer ${config.openaiApiKey}` }
    );
    return data.choices?.[0]?.message?.content ?? "";
  };
  try {
    return await send(config.openaiModel);
  } catch (err) {
    if (!isGroqUrl(config.openaiBaseUrl) || config.openaiModel === GROQ_FALLBACK_MODEL || !isModelGone(err)) throw err;
    console.warn(`Groq no longer has the model "${config.openaiModel}"; using ${GROQ_FALLBACK_MODEL} instead.`);
    return send(GROQ_FALLBACK_MODEL);
  }
}

// The host, not the name anywhere in the URL
function isGroqUrl(url: string): boolean {
  try {
    return new URL(url).hostname === "api.groq.com";
  } catch {
    return false;
  }
}

// Main host, then the fallback; returns text and the host that answered
async function askOllama(prompt: string): Promise<[string, string]> {
  const hosts = [config.ollamaBaseUrl, config.ollamaFallbackUrl].filter(Boolean);
  let lastError: unknown;
  for (const host of hosts) {
    try {
      const data = await postJSON<{ response: string }>(
        `${host}/api/generate`,
        {
          model: config.ollamaModel,
          system: SYSTEM_PROMPT,
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

// node-llama-cpp is ESM: tsc would turn a plain import() into a failing require()
const importModule = new Function("specifier", "return import(specifier)") as (s: string) => Promise<any>;

/** A loaded model and one reusable chat session. Loading takes a few seconds, so it happens once. */
/** `thinks`: a thinking model, answered with reasoning off (see `thinking.ts`). Unset in tests. */
type Loaded = { session: any; thinks?: boolean; dispose?: () => Promise<void> };
let builtin: Promise<Loaded> | undefined;
// Prep model, when not the stream's (config.prepareModelPath)
let prepBuiltin: Promise<Loaded> | undefined;
let llamaRuntime: Promise<any> | undefined;

// On the one shared runtime. `stream`: sets builtinInfo and starts the CPU watch (#314); the prep model (#296) doesn't
async function loadModelFile(modelPath: string, stream: boolean): Promise<Loaded> {
  const { getLlama, LlamaChatSession, JinjaTemplateChatWrapper, resolveChatWrapper } = await importModule("node-llama-cpp");
  // Shipped binaries only: never compile llama.cpp on a musician's computer
  const runtime = (llamaRuntime ??= getLlama({ build: "never", ...(config.llamaGpu === "off" ? { gpu: false } : {}) }));
  // Drop only a runtime that failed; a failed model load keeps it, so the CPU watch still governs both
  const llama = await runtime.catch((err: unknown) => {
    if (llamaRuntime === runtime) llamaRuntime = undefined;
    throw err;
  });
  const model = await llama.loadModel({ modelPath });
  const context = await model.createContext({ contextSize: 4096 });
  const template = model.fileInfo?.metadata?.tokenizer?.chat_template;
  const thinks = templateThinks(template);
  const session = new LlamaChatSession({
    contextSequence: context.getSequence(),
    systemPrompt: SYSTEM_PROMPT,
    // A thinking model answers through its own template with reasoning switched off (issue #198).
    // Any other gets the template the library would pick, without today's date (issue #431, builtin-chat.ts).
    chatWrapper: thinks ? new JinjaTemplateChatWrapper({ template, reasoning: false }) : resolveChatWrapper(model, { customWrapperSettings: NO_TODAY_DATE }),
  });
  console.log(`[FactGen] Built-in model loaded (${llama.gpu || "cpu"}${thinks ? ", thinking off" : ""})`);
  if (stream) {
    builtinInfo.gpu = llama.gpu || "cpu";
    watchCpu(llama, context.idealThreads as number);
  }
  return {
    session,
    thinks,
    dispose: async () => {
      await context.dispose();
      await model.dispose();
    },
  };
}

function loadBuiltin(): Promise<Loaded> {
  builtin ??= loadModelFile(config.modelPath, true).catch((err) => {
    builtin = undefined; // next song retries
    throw err;
  });
  return builtin;
}

// Standard prepares while Larger AI is on stream (#296)
const usesPrepModel = () => Boolean(config.prepareModelPath) && config.prepareModelPath !== config.modelPath;

function loadPrepBuiltin(): Promise<Loaded> {
  if (!usesPrepModel()) return loadBuiltin();
  prepBuiltin ??= loadModelFile(config.prepareModelPath, false).catch((err) => {
    prepBuiltin = undefined;
    throw err;
  });
  return prepBuiltin;
}

/** Frees the prep-only model after its last turn. Never throws */
export async function releasePrepModel(): Promise<void> {
  const loaded = prepBuiltin;
  prepBuiltin = undefined;
  if (!loaded) return;
  await builtinQueue.catch(() => undefined);
  await loaded.then((l) => l.dispose?.()).catch(() => undefined);
}

/** The model preparing now, for the store; "" for no AI */
export function prepModelName(): string {
  if (config.aiProvider === "builtin") return path.basename((usesPrepModel() ? config.prepareModelPath : config.modelPath) ?? "");
  if (config.aiProvider === "anthropic") return `anthropic:${config.anthropicModel}`;
  if (config.aiProvider === "openai") return `openai:${config.openaiModel}`;
  if (config.aiProvider === "ollama") return `ollama:${config.ollamaModel}`;
  return "";
}

/** Same naming; it rewrites the prep model's songs, last (#296) */
export const streamModelName = (): string => (config.aiProvider === "builtin" ? path.basename(config.modelPath ?? "") : prepModelName());

let cpuTimer: NodeJS.Timeout | undefined;

// Fewer threads and low priority while other programs fill the CPU (#314; ARCHITECTURE.md: A slow or busy computer)
function watchCpu(llama: { maxThreads: number }, usualThreads: number): void {
  if (cpuTimer) return;
  const usualMax = llama.maxThreads;
  let priority: number | null = null;
  try {
    priority = os.getPriority();
  } catch {
    // unknown: left as is
  }
  let before = cpuTimes();
  let ownBefore = process.cpuUsage();
  cpuTimer = setInterval(() => {
    const after = cpuTimes();
    const own = process.cpuUsage(ownBefore);
    const share = othersCpuShare(before, after, (own.user + own.system) / 1000);
    before = after;
    ownBefore = process.cpuUsage();
    const busy = cpuWatch.read(share);
    if (busy === builtinInfo.makingRoom) return;
    builtinInfo.makingRoom = busy;
    builtinInfo.threads = busy ? busyThreads(usualThreads) : null;
    // From the next evaluation on; 0 (GPU default) = no limit
    llama.maxThreads = busy ? busyThreads(usualThreads) : usualMax;
    try {
      if (busy) os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);
      else if (priority !== null) os.setPriority(priority);
    } catch {
      // Raising it back needs rights on Linux and macOS: stays low
    }
    console.log(
      busy
        ? `[Pace] Other programs use ${Math.round(share * 100)}% of the CPU: the AI uses ${busyThreads(usualThreads)} threads at low priority`
        : "[Pace] The CPU is calm again: the AI uses all its threads"
    );
  }, CPU_SAMPLE_MS);
  cpuTimer.unref();
}

type FakeSession = { prompt: (text: string, options: { signal: AbortSignal }) => Promise<string>; resetChatHistory: () => void };

/** Tests only: fake chat sessions for the stream and prep models */
export function useBuiltinSession(session: FakeSession, prepSession?: FakeSession): void {
  builtin = Promise.resolve({ session });
  prepBuiltin = prepSession ? Promise.resolve({ session: prepSession }) : undefined;
}

/** Loads at start-up: first song not slowed, failure shown at once. The desktop app watches both log lines */
export async function warmUpBuiltin(): Promise<void> {
  if (config.aiProvider !== "builtin") return;
  try {
    await loadBuiltin();
  } catch (err) {
    console.error(`[FactGen] Built-in model failed to load: ${err instanceof Error ? err.message : err}`);
  }
}

const BUILTIN_TIMEOUT_MS = 90_000; // ms per song before it's stopped
let builtinQueue: Promise<unknown> = Promise.resolve();

/** One request's ties to the stream, set by the caller: `key` names the song, `obsolete` says it went off stream,
 * `waitedForLoad` hears how long loading the built-in model took (not counted as the computer's writing time) */
export interface Turn {
  key: string | null;
  obsolete: () => boolean;
  waitedForLoad: (ms: number) => void;
}

let running: { key: string | null; stop: AbortController; prep: boolean } | null = null;

/** The built-in model's turn writing now, so a song change can stop it; null when none */
export const runningTurn = (): Readonly<{ key: string | null; stop: AbortController; prep: boolean }> | null => running;

// One chat session, songs in turn (ARCHITECTURE.md); output cut off at the timeout is still screened
function askBuiltin(prompt: string, turn: Turn): Promise<string> {
  // Preparing: stopping the run stops its turn; may use its own model
  const prep = preparing();
  const run = async () => {
    if (turn.obsolete() || prep?.signal.aborted) throw new Obsolete();
    const loadStarted = Date.now();
    const { session, thinks } = await (prep && !prep.streamModel ? loadPrepBuiltin() : loadBuiltin());
    // Loading the model (a first load, or after a switch) says nothing about how fast the computer writes facts:
    // the wait viewers are timed on starts after it, and a song that changed meanwhile isn't written for.
    const loadedMs = Date.now() - loadStarted;
    if (!prep) turn.waitedForLoad(loadedMs);
    if (turn.obsolete() || prep?.signal.aborted) throw new Obsolete();
    session.resetChatHistory();
    const stop = new AbortController();
    running = { key: turn.key, stop, prep: Boolean(prep) };
    const writing = Date.now();
    try {
      const text = (await session.prompt(prompt, {
        temperature: config.temperature,
        maxTokens: MAX_TOKENS,
        // No token goes to thinking: the 512 are for captions (issue #198). Only set for a thinking model.
        ...(thinks ? { budgets: { thoughtTokens: 0 } } : {}),
        signal: AbortSignal.any([AbortSignal.timeout(BUILTIN_TIMEOUT_MS), stop.signal, ...(prep ? [prep.signal] : [])]),
        stopOnAbortSignal: true,
      })) as string;
      if (stop.signal.aborted || prep?.signal.aborted) throw new Obsolete();
      // Stream model's speed only (#314)
      if (!prep) builtinInfo.wordsPerSecond = wordsPerSecond(text, Date.now() - writing) ?? builtinInfo.wordsPerSecond;
      return text;
    } finally {
      running = null;
    }
  };
  const queued = builtinQueue.then(run, run);
  builtinQueue = queued.catch(() => undefined);
  return queued;
}

/** The configured AI's reply to `prompt`, and which endpoint gave it */
export async function askAI(prompt: string, turn: Turn): Promise<{ text: string; endpoint: string }> {
  if (config.aiProvider === "builtin") return { text: await askBuiltin(prompt, turn), endpoint: "built-in model" };
  if (config.aiProvider === "anthropic") return { text: await askAnthropic(prompt), endpoint: `anthropic (${config.anthropicModel})` };
  if (config.aiProvider === "openai") return { text: await askOpenAICompatible(prompt), endpoint: `${config.openaiBaseUrl} (${config.openaiModel})` };
  const [text, endpoint] = await askOllama(prompt);
  return { text, endpoint };
}
