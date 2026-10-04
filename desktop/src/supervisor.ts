import { app, utilityProcess } from "electron";
import { fork } from "child_process";
import { EventEmitter } from "events";
import fs from "fs";
import path from "path";

/**
 * Runs the fact server in its own process and keeps it healthy without the
 * musician's help: it restarts the server after a crash, after it stops
 * answering, or after the song-list connection stalls, waiting a little
 * longer after each failure so a persistent problem doesn't spin.
 */

export type ServerState = "stopped" | "starting" | "running" | "restarting" | "failing";

export interface Health {
  status: string;
  /** Whether the server is holding bubbles back (Pause bubbles). */
  paused?: boolean;
  /** "StreamerSongList" or "StreamElements"; older servers leave it out. */
  songSource?: string;
  currentSong: string | null;
  eventsConnected: boolean;
  obsClients: number;
  clients: Array<{ addr: string; ua: string }>;
  lastQueueFetchAgeMs: number | null;
  facts: Record<string, unknown>;
}

export interface Status {
  state: ServerState;
  health: Health | null;
  message: string;
  restarts: number;
  port: number;
}

const HEALTH_EVERY_MS = 5_000;
const MISSES_BEFORE_RESTART = 4; // 20 seconds without an answer
/**
 * Loading the built-in AI can hold the server up for a while, most of all the
 * first time, when the 2 GB file comes off a cold disk. Silence during this
 * window means "still loading", not "crashed".
 */
const MODEL_LOAD_GRACE_MS = 3 * 60_000;
const DEGRADED_BEFORE_RESTART_MS = 120_000;
const MAX_BACKOFF_MS = 60_000;
const FAILING_AFTER = 5; // restarts within the window below
const RESTART_WINDOW_MS = 10 * 60_000;
const LOG_LINES_KEPT = 800;
const PORT_SEARCH = 10;

/** The running fact server, however it was started. */
interface ServerProcess {
  kill(): void;
  send(message: { type: string; token: string }): void;
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
  private portConflict = false;
  private modelLoaded = false;
  private launchedAt = 0;
  /** The server logged "Listening": a crash after this isn't the AI's fault by default. */
  private listening = false;
  /** The port the musician chose; automatic moves search upward from here. */
  private basePort = 0;
  readonly lines: string[] = [];
  status: Status = { state: "stopped", health: null, message: "", restarts: 0, port: 3000 };

  /** `runtime`: a Node.js to run the server with instead of Electron's (Linux). */
  constructor(private readonly serverScript: string, private readonly logDir: string, private readonly runtime: string | null = null) {
    super();
  }

  start(env: Record<string, string>): void {
    this.env = env;
    this.basePort = Number(env.PORT);
    this.status.port = this.basePort;
    this.stopping = false;
    this.launch("Starting");
  }

  /** Apply new settings: a clean restart that doesn't count as a failure. */
  restart(env: Record<string, string>): void {
    this.stop();
    this.restartTimes = [];
    this.start(env);
  }

  /** Settings the running server was told some other way, kept for any later restart. */
  setEnv(patch: Record<string, string>): void {
    this.env = { ...this.env, ...patch };
  }

  /** Hand the running server a new StreamerSongList token, and use it for any later restart. */
  updateToken(token: string): void {
    this.env = { ...this.env, SSL_ACCESS_TOKEN: token };
    this.child?.send({ type: "ssl-token", token });
  }

  stop(): void {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.restartTimer = this.healthTimer = null;
    this.child?.kill();
    this.child = null;
    this.set("stopped", "");
  }

  private set(state: ServerState, message: string): void {
    this.status = { ...this.status, state, message };
    this.emit("status", this.status);
  }

  private launch(verb: string): void {
    this.misses = 0;
    this.degradedSince = null;
    this.portConflict = false;
    this.modelLoaded = false;
    this.listening = false;
    this.launchedAt = Date.now();
    this.set(this.status.state === "failing" ? "failing" : "starting", `${verb} the fact server`);

    const env = { ...process.env, ...this.env };
    const output = (d: Buffer | string) => this.log(String(d));
    let child: ServerProcess;
    if (this.runtime) {
      // Linux: the fact server runs under a standard Node.js shipped with the app, because the
      // built-in AI crashes (illegal instruction) under Electron's own runtime there.
      const proc = fork(this.serverScript, [], { execPath: this.runtime, env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
      proc.stdout?.on("data", output);
      proc.stderr?.on("data", output);
      proc.on("error", (err) => this.log(`[App] Couldn't start the fact server: ${err.message}`));
      proc.on("exit", (code) => onExit(code));
      child = { kill: () => proc.kill(), send: (m) => void (proc.connected && proc.send(m)) };
    } else {
      const proc = utilityProcess.fork(this.serverScript, [], { env, stdio: "pipe", serviceName: "BubbleFacts server" });
      proc.stdout?.on("data", output);
      proc.stderr?.on("data", output);
      proc.on("exit", (code) => onExit(code));
      child = { kill: () => void proc.kill(), send: (m) => proc.postMessage(m) };
    }
    this.child = child;
    const onExit = (code: number | null) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.stopping) return;
      if (this.portConflict) return this.movePort();
      // Only a crash between "Listening" and the model loading points at the AI; an earlier one is a setup problem.
      if (this.env.AI_PROVIDER === "builtin" && this.listening && !this.modelLoaded) return this.modelFailed("crashed while loading");
      this.scheduleRestart("The fact server stopped unexpectedly", `exit code ${code}`);
    };

    if (!this.healthTimer) this.healthTimer = setInterval(() => void this.checkHealth(), HEALTH_EVERY_MS);
  }

  /** Another program has the port: try the next one. The overlay file is rewritten to match. */
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

  /**
   * The built-in AI couldn't start. Retry on the processor only, which avoids
   * GPU driver problems; if that fails too, tell the app so it can offer an
   * online option. Facts keep appearing from the song list meanwhile.
   */
  private modelFailed(how: string): void {
    // Macs ship Metal builds of the AI only, so there's no processor-only build to retry with.
    if (this.env.LLAMA_GPU !== "off" && process.platform !== "darwin") {
      this.log(`[App] The built-in AI ${how} using the GPU; retrying on the processor.`);
      this.env = { ...this.env, LLAMA_GPU: "off" };
      this.emit("gpu-off");
      this.child?.kill();
      this.child = null;
      if (!this.stopping) this.launch("Restarting");
      return;
    }
    this.log(`[App] The built-in AI ${how}${process.platform === "darwin" ? "" : " on the processor too"}.`);
    // The app restarts the server without the AI; it still shows song-list and custom facts.
    this.emit("builtin-failed");
  }

  /** `reason` is shown in the window; `detail`, if any, goes in the log only. */
  private scheduleRestart(reason: string, detail = ""): void {
    if (this.stopping || this.restartTimer) return;
    this.child?.kill();
    this.child = null;
    const now = Date.now();
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
        // A restart can't fix a rejected sign-in; the app asks the musician to sign in again.
        this.degradedSince = null;
        this.restartTimes = [];
        this.set("running", `${health.songSource ?? "StreamerSongList"} didn't accept your sign-in`);
        return;
      }
      if (health.status === "degraded") {
        this.degradedSince ??= Date.now();
        if (Date.now() - this.degradedSince > DEGRADED_BEFORE_RESTART_MS) {
          return this.scheduleRestart("The song-list connection stalled");
        }
      } else {
        this.degradedSince = null;
      }
      if (this.status.state !== "running") this.restartTimes = this.restartTimes.slice(-1);
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

  /** A line from the app itself, kept with the server's so reports and log files carry it too. */
  note(line: string): void {
    this.log(line);
  }

  private log(chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (/EADDRINUSE/.test(line)) this.portConflict = true;
      if (/Built-in model loaded/.test(line)) this.modelLoaded = true;
      if (/\[Server\] Listening on/.test(line)) this.listening = true;
      if (/Built-in model failed to load/.test(line)) this.modelFailed("failed to load");
      this.lines.push(line);
      if (this.lines.length > LOG_LINES_KEPT) this.lines.shift();
      this.emit("line", line);
      try {
        fs.mkdirSync(this.logDir, { recursive: true });
        fs.appendFileSync(path.join(this.logDir, `bubblefacts-${new Date().toISOString().slice(0, 10)}.log`), line + "\n");
      } catch {
        // Logging must never take the app down.
      }
    }
  }
}

/** Keep the last week of daily log files. */
export function pruneLogs(logDir: string, keep = 7): void {
  try {
    const files = fs.readdirSync(logDir).filter((f) => /^bubblefacts-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.unlinkSync(path.join(logDir, f));
  } catch {
    // Nothing to prune yet.
  }
}

export const appVersion = () => app.getVersion();
