import { utilityProcess } from "electron";
import { spawn } from "child_process";
import { EventEmitter } from "events";
import fs from "fs";
import path from "path";

// Runs the fact server in its own process and restarts it after a crash, a hang or a stuck polling loop,
// waiting longer after each failure so a lasting problem doesn't spin (DESKTOP-APP.md: Self-healing)

export type ServerState = "stopped" | "starting" | "running" | "restarting" | "failing";

export interface Health {
  status: string;
  /** Holding bubbles back (Pause bubbles) */
  paused?: boolean;
  /** "StreamerSongList", "StreamElements", "Now playing file" or a preset's name ("Streamling"); older servers leave it out */
  songSource?: string;
  currentSong: string | null;
  eventsConnected: boolean;
  /** How songs arrive, under the Songs light ("Hearing your queue live"); older servers leave it out */
  listening?: string;
  obsClients: number;
  clients: Array<{ addr: string; ua: string }>;
  lastQueueFetchAgeMs: number | null;
  /** Why status is degraded or unauthorized; OUTAGE_REASON means fetches are failing */
  degradedReason?: string;
  /** ms since the last try at fetching the song list, worked or not; older servers leave it out */
  lastPollAttemptAgeMs?: number | null;
  /** ms between polls of the song source; older servers leave it out */
  pollIntervalMs?: number;
  facts: Record<string, unknown>;
}

export interface Status {
  state: ServerState;
  health: Health | null;
  message: string;
  restarts: number;
  port: number;
}

const HEALTH_EVERY_MS = 5_000;              // ms between health checks
const MISSES_BEFORE_RESTART = 4;            // unanswered checks (20 s) before a restart
const MODEL_LOAD_GRACE_MS = 3 * 60_000;     // ms of silence read as "AI still loading" (2 GB off a cold disk), not a crash
const DEGRADED_BEFORE_RESTART_MS = 120_000; // ms degraded before a restart
/** The server's degradedReason (server.ts) when fetches fail: no internet, or the song service is down */
export const OUTAGE_REASON = "no successful queue fetch recently";
const MAX_BACKOFF_MS = 60_000;              // longest wait between restarts
const FAILING_AFTER = 5;                    // restarts within the window below before "failing"
const RESTART_WINDOW_MS = 10 * 60_000;
const STEADY_HEALTH_MS = 5 * 60_000;        // ms healthy before the crash history is forgotten
const LOG_LINES_KEPT = 800;                 // lines kept in memory for reports
const PORT_SEARCH = 10;                     // ports tried above the chosen one
const EXIT_WAIT_MS = 10_000;                // longest wait for a killed server to exit before starting anyway

/** The running fact server, however it was started */
interface ServerProcess {
  kill(): void;
  /** Resolves once the process has really exited */
  exited: Promise<void>;
  send(message: Record<string, unknown>): void;
}

export class Supervisor extends EventEmitter {
  private child: ServerProcess | null = null;
  private env: Record<string, string> = {};
  private stopping = false;
  private healthTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private misses = 0;
  private degradedSince: number | null = null;
  private restartTimes: number[] = [];
  /** Start of the current run of good health checks; null while unhealthy */
  private healthySince: number | null = null;
  private portConflict = false;
  private modelLoaded = false;
  private launchedAt = 0;
  /** The server logged "Listening" */
  private listening = false;
  /** The chosen port; automatic moves search upward from here */
  private basePort = 0;
  /** UTC date of the log file being written; a new date prunes old logs */
  private logDay = "";
  private logStream: fs.WriteStream | null = null;
  private logsFlushed: Promise<void> = Promise.resolve();
  readonly lines: string[] = [];
  status: Status = { state: "stopped", health: null, message: "", restarts: 0, port: 3000 };

  /** `runtime`: a Node.js to run the server with instead of Electron's (Linux) */
  constructor(private readonly serverScript: string, private readonly logDir: string, private readonly runtime: string | null = null) {
    super();
  }

  private start(env: Record<string, string>): void {
    this.env = env;
    this.basePort = Number(env.PORT);
    this.status.port = this.basePort;
    this.stopping = false;
    this.launch("Starting");
  }

  /** Apply new settings: a clean restart, not counted as a failure */
  restart(env: Record<string, string>): void {
    this.stop();
    this.restartTimes = [];
    this.start(env);
  }

  /** Settings the running server was told some other way, kept for later restarts */
  setEnv(patch: Record<string, string>): void {
    this.env = { ...this.env, ...patch };
  }

  /** Hand the running server a new StreamerSongList token, kept for later restarts */
  updateToken(token: string): void {
    this.env = { ...this.env, SSL_ACCESS_TOKEN: token };
    this.child?.send({ type: "ssl-token", token });
  }

  /** Tell the running server something; lost between runs, so nothing may depend on it arriving */
  tell(message: Record<string, unknown>): void {
    this.child?.send(message);
  }

  stop(): void {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.restartTimer = this.healthTimer = null;
    this.child?.kill();
    this.child = null;
    void this.endLog();
    this.set("stopped", "");
  }

  private set(state: ServerState, message: string): void {
    this.status = { ...this.status, state, message };
    this.emit("status", this.status);
  }

  private launch(verb: string): void {
    this.misses = 0;
    this.degradedSince = null;
    this.healthySince = null;
    this.portConflict = false;
    this.modelLoaded = false;
    this.listening = false;
    this.launchedAt = Date.now();
    this.set(this.status.state === "failing" ? "failing" : "starting", `${verb} the fact server`);

    const env = { ...process.env, ...this.env };
    const output = (d: Buffer | string) => this.log(String(d));
    const fromServer = (message: unknown) => this.emit("server-message", message);
    let child: ServerProcess;
    if (this.runtime) {
      // Linux: shipped Node.js, spawned not forked (DESKTOP-APP.md: Linux fact server)
      const proc = spawn(this.runtime, [this.serverScript], { env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
      proc.stdout?.on("data", output);
      proc.stderr?.on("data", output);
      proc.on("error", (err) => this.log(`[App] Couldn't start the fact server: ${err.message}`));
      proc.on("message", fromServer);
      proc.on("exit", (code) => onExit(code));
      child = { kill: () => proc.kill(), exited: new Promise((resolve) => proc.once("exit", () => resolve())), send: (m) => void (proc.connected && proc.send(m)) };
    } else {
      const proc = utilityProcess.fork(this.serverScript, [], { env, stdio: "pipe", serviceName: "BubbleFacts server" });
      proc.stdout?.on("data", output);
      proc.stderr?.on("data", output);
      proc.on("message", fromServer);
      proc.on("exit", (code) => onExit(code));
      child = { kill: () => void proc.kill(), exited: new Promise((resolve) => proc.once("exit", () => resolve())), send: (m) => proc.postMessage(m) };
    }
    this.child = child;
    const onExit = (code: number | null) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.stopping) return;
      if (this.portConflict) return this.movePort();
      // Only a crash between "Listening" and the model loading points at the AI; earlier is a setup problem
      if (this.env.AI_PROVIDER === "builtin" && this.listening && !this.modelLoaded) return this.modelFailed("crashed while loading");
      this.scheduleRestart("The fact server stopped unexpectedly", `exit code ${code}`);
    };

    if (!this.healthTimer) this.healthTimer = setInterval(() => void this.checkHealth(), HEALTH_EVERY_MS);
  }

  /** Another program has the port: try the next one */
  private movePort(): void {
    const next = this.status.port + 1;
    if (next > this.basePort + PORT_SEARCH) {
      this.status.port = this.basePort;
      this.env = { ...this.env, PORT: String(this.basePort) };
      return this.scheduleRestart("Other programs are using the ports BubbleFacts tries. Choose another Port in Settings, under Advanced", `ports ${this.basePort} to ${next - 1} are all in use`);
    }
    this.log(`[App] Port ${this.status.port} is in use; trying ${next}`);
    this.status.port = next;
    this.env = { ...this.env, PORT: String(next) };
    this.emit("port", next);
    this.launch("Restarting");
  }

  /** The built-in AI couldn't start: retry on the processor (avoids GPU driver problems), then tell the app */
  private modelFailed(how: string): void {
    // Macs ship Metal builds only: no processor-only build to retry with
    if (this.env.LLAMA_GPU !== "off" && process.platform !== "darwin") {
      this.log(`[App] The built-in AI ${how} using the GPU; retrying on the processor.`);
      this.env = { ...this.env, LLAMA_GPU: "off" };
      this.emit("gpu-off");
      // The old server may still hold the port and the model file: relaunch once it has gone
      const old = this.child;
      this.child = null;
      old?.kill();
      if (this.stopping || this.restartTimer) return;
      const relaunch = () => {
        if (!this.restartTimer) return;
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
        this.launch("Restarting");
      };
      this.restartTimer = setTimeout(relaunch, old ? EXIT_WAIT_MS : 0);
      void old?.exited.then(relaunch);
      return;
    }
    this.log(`[App] The built-in AI ${how}${process.platform === "darwin" ? "" : " on the processor too"}.`);
    this.emit("builtin-failed");
  }

  /** `reason` is shown in the window; `detail` goes in the log only */
  private scheduleRestart(reason: string, detail = ""): void {
    if (this.stopping || this.restartTimer) return;
    this.child?.kill();
    this.child = null;
    const now = Date.now();
    this.healthySince = null;
    this.restartTimes = [...this.restartTimes.filter((t) => now - t < RESTART_WINDOW_MS), now];
    const count = this.restartTimes.length;
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (count - 1));
    this.status.restarts++;
    this.log(`[App] ${reason}${detail ? ` (${detail})` : ""}. Restarting in ${Math.round(delay / 1000)}s.`);
    this.set(count >= FAILING_AFTER ? "failing" : "restarting", reason);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.launch("Restarting");
    }, delay);
  }

  private async checkHealth(): Promise<void> {
    if (!this.child || this.stopping) return;
    try {
      const res = await fetch(`http://127.0.0.1:${this.status.port}/health`, { signal: AbortSignal.timeout(3000) });
      const health = (await res.json()) as Health;
      this.misses = 0;
      this.status.health = health;
      if (health.status === "unauthorized") {
        // A restart can't fix a rejected sign-in; the app asks for a new one
        this.degradedSince = null;
        this.restartTimes = [];
        this.set("running", `${health.songSource ?? "StreamerSongList"} didn't accept your sign-in`);
        return;
      }
      if (health.status === "degraded") {
        this.degradedSince ??= Date.now();
        // An outage: restart only if the polling loop stopped (ARCHITECTURE.md: Song sources and YouTube titles)
        const outage = health.degradedReason === OUTAGE_REASON;
        if (Date.now() - this.degradedSince > DEGRADED_BEFORE_RESTART_MS && (!outage || pollLoopStuck(health))) {
          return this.scheduleRestart("The song-list connection stalled");
        }
      } else {
        this.degradedSince = null;
      }
      // A server that crashes on its first song answers fine until then: only a steady stretch clears
      // the history, so a crash loop still backs off and reaches "failing"
      this.healthySince ??= Date.now();
      if (Date.now() - this.healthySince >= STEADY_HEALTH_MS) this.restartTimes = [];
      this.set("running", health.status === "degraded" ? `Reconnecting to ${health.songSource ?? "StreamerSongList"}` : "");
    } catch {
      const loading = this.env.AI_PROVIDER === "builtin" && !this.modelLoaded;
      if (loading && Date.now() - this.launchedAt < MODEL_LOAD_GRACE_MS) {
        this.set(this.status.state === "failing" ? "failing" : "starting", "Loading the built-in AI");
        return;
      }
      if (++this.misses < MISSES_BEFORE_RESTART) return;
      if (loading) this.modelFailed("stopped responding while loading");
      else this.scheduleRestart("The fact server stopped responding");
    }
  }

  /** A line from the app itself, logged with the server's so reports carry it too */
  note(line: string): void {
    this.log(line);
  }

  private log(chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (/EADDRINUSE/.test(line)) this.portConflict = true;
      if (/Built-in model loaded/.test(line)) {
        this.modelLoaded = true;
        // Which file, so main.ts can delete a model it switched from
        this.emit("model-loaded", this.env.MODEL_PATH ?? "");
      }
      if (/\[Server\] Listening on/.test(line)) this.listening = true;
      if (/Built-in model failed to load/.test(line)) this.modelFailed("failed to load");
      this.lines.push(line);
      if (this.lines.length > LOG_LINES_KEPT) this.lines.shift();
      this.writeLog(line + "\n");
    }
  }

  /** One buffered stream per day's log file, not a reopen per line */
  private writeLog(text: string): void {
    try {
      const day = new Date().toISOString().slice(0, 10);
      if (!this.logStream || day !== this.logDay) {
        void this.endLog();
        fs.mkdirSync(this.logDir, { recursive: true });
        // A stream can run for days: prune when the date changes, not only at startup
        pruneLogs(this.logDir);
        const stream = fs.createWriteStream(path.join(this.logDir, `bubblefacts-${day}.log`), { flags: "a" });
        // Logging must never take the app down: a failed write only drops lines
        stream.on("error", () => {
          if (this.logStream === stream) this.logStream = null;
        });
        this.logStream = stream;
        this.logDay = day;
      }
      this.logStream.write(text);
    } catch {
      // Never let logging take the app down
    }
  }

  /** Close the log stream, flushing what it holds */
  private endLog(): Promise<void> {
    const stream = this.logStream;
    this.logStream = null;
    if (stream) this.logsFlushed = Promise.all([this.logsFlushed, new Promise<void>((resolve) => stream.end(resolve))]).then(() => undefined);
    return this.logsFlushed;
  }

  /** Resolves when every closed log stream has finished writing (tests, a clean quit) */
  whenLogsWritten(): Promise<void> {
    return this.logsFlushed;
  }
}

/** The polling loop stopped trying; an older server or no loop yet counts as stuck; slow polling gets three intervals */
function pollLoopStuck(health: Health): boolean {
  const age = health.lastPollAttemptAgeMs;
  if (typeof age !== "number") return true;
  return age > Math.max(DEGRADED_BEFORE_RESTART_MS, 3 * (health.pollIntervalMs ?? 0));
}

const SONGS_LOG_MAX_BYTES = 1_000_000; // bytes before songs.log is moved aside
const SONGS_LOG_KEPT = 3;              // old songs.log files kept

/** Keep the last week of daily logs, and move a songs.log over 1 MB aside (songs.1.log newest to songs.3.log) */
export function pruneLogs(logDir: string, keep = 7): void {
  rotateSongsLog(logDir);
  try {
    const files = fs.readdirSync(logDir).filter((f) => /^bubblefacts-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.unlinkSync(path.join(logDir, f));
  } catch {
    // Nothing to prune yet
  }
}

function rotateSongsLog(logDir: string): void {
  try {
    const live = path.join(logDir, "songs.log");
    if (fs.statSync(live).size <= SONGS_LOG_MAX_BYTES) return;
    // The server appends by path, so its next line starts a fresh songs.log
    for (let i = SONGS_LOG_KEPT; i >= 1; i--) {
      const from = i === 1 ? live : path.join(logDir, `songs.${i - 1}.log`);
      if (fs.existsSync(from)) fs.renameSync(from, path.join(logDir, `songs.${i}.log`));
    }
  } catch {
    // No songs.log yet
  }
}
