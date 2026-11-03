import { execFile } from "child_process";
import path from "path";
import { MODEL, ModelFile, modelPath } from "./model";
import type { Settings } from "./settings";

/**
 * "Prepare my songs" in the app (issues #293 to #297). The server prepares;
 * this file decides when (issue #295), and holds the window's messages about
 * it, so main.ts only wires it in (`registerPreparing`).
 */

/**
 * The server's settings for preparing: the Standard model writes the first pass when High
 * quality is chosen and Standard is downloaded too, being several times faster (issue #296).
 * Songs it wrote are written again by High quality once every song has its first pass.
 */
export function prepareEnv(s: Pick<Settings, "ai" | "aiQuality">, modelsDir: string, ready: (model: ModelFile) => boolean): Record<string, string> {
  if (s.ai !== "builtin" || s.aiQuality !== "high" || !ready(MODEL)) return {};
  return { PREPARE_MODEL_PATH: modelPath(modelsDir, MODEL) };
}

// --- Is the computer free? ---------------------------------------------

/** OBS's own program, as a process list names it: obs64.exe on Windows, OBS on a Mac, obs on Linux. Not its helpers. */
export function isObsProcess(name: string): boolean {
  const base = path.posix.basename(name.trim().replace(/\\/g, "/")).replace(/\.exe$/i, "");
  return /^obs(?:32|64)?$/i.test(base);
}

/** Whether OBS is in a process list's text: `tasklist /FO CSV /NH` on Windows, `ps -A -o comm=` elsewhere. */
export function obsInProcessList(text: string): boolean {
  return text.split(/\r?\n/).some((line) => {
    const csv = /^"([^"]*)"/.exec(line);
    return isObsProcess(csv ? csv[1] : line);
  });
}

/** The running programs' names. One cheap call, about once a second while preparing. */
export function listProcesses(platform: NodeJS.Platform = process.platform): Promise<string> {
  const [cmd, args] = platform === "win32" ? ["tasklist", ["/FO", "CSV", "/NH"]] : ["ps", ["-A", "-o", "comm="]];
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 2000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/** Why preparing waits, in the order checked; "" when the computer is free and it may run. */
export type WaitReason = "" | "off" | "setup" | "online-ai" | "no-ai" | "server" | "battery" | "overlay" | "obs" | "obs-unknown";

export interface Conditions {
  /** Prepare my songs is on, and setup is done. */
  enabled: boolean;
  setupDone: boolean;
  /** Which AI writes: one on this computer, an online one (never used for preparing), or none ready. */
  ai: "local" | "online" | "none";
  serverUp: boolean;
  onBattery: boolean;
  /** Overlays connected to the server: OBS showing BubbleFacts. */
  overlays: number;
}

/** Why preparing must wait now, without the process list; "" when only OBS is left to check. */
export function waitReason(c: Conditions): WaitReason {
  if (!c.enabled) return "off";
  if (!c.setupDone) return "setup";
  if (c.ai === "online") return "online-ai";
  if (c.ai === "none") return "no-ai";
  if (!c.serverUp) return "server";
  if (c.onBattery) return "battery";
  if (c.overlays > 0) return "overlay";
  return "";
}

export interface DriverDeps {
  conditions: () => Conditions;
  obsRunning: () => Promise<boolean>;
  /** Asks the server (`/control/<path>`); null when it didn't answer. */
  control: (pathname: string, body?: unknown) => Promise<Record<string, unknown> | null>;
  now?: () => number;
}

/** How often a run that has nothing left to do is started again: the list or the history may have grown. */
const RECHECK_MS = 10 * 60_000;

/**
 * Starts and stops preparing as the computer becomes free or busy. `tick` runs about once a
 * second: a stream starting stops preparing within a second. The cheap checks come first; the
 * process list is read only when everything else says go, or while preparing runs.
 */
export class PrepareDriver {
  private asked: "run" | "stop" | null = null;
  private askedAt = 0;
  private serverRunning = false;
  private busy = false;
  reason: WaitReason = "off";
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: DriverDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(everyMs = 1000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), everyMs);
    this.timer.unref?.();
  }

  stopLoop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    // A slow process list never piles up ticks.
    if (this.busy) return;
    this.busy = true;
    try {
      let reason = waitReason(this.deps.conditions());
      // A process list that fails says nothing about OBS, so it waits: OBS can be open before its overlay connects.
      if (!reason) reason = await this.deps.obsRunning().then((open) => (open ? "obs" : ""), () => "obs-unknown" as const);
      this.reason = reason;
      if (reason) {
        // Stop whenever it may be running: asked to run, or the server last said it was.
        if (this.asked !== "stop" || this.serverRunning) await this.ask(false);
        return;
      }
      // Asked again now and then: a run that finished starts over if the list or the history grew.
      const due = this.asked !== "run" || this.now() - this.askedAt >= RECHECK_MS;
      if (due) await this.ask(true);
    } finally {
      this.busy = false;
    }
  }

  /** The server started over (a settings change, a crash): what it was asked no longer holds, so it's asked again on the next tick. */
  serverRestarted(): void {
    this.asked = null;
    this.serverRunning = false;
  }

  private async ask(run: boolean): Promise<void> {
    this.asked = run ? "run" : "stop";
    this.askedAt = this.now();
    const answer = await this.deps.control("prepare", { run });
    // No answer (the server is restarting): ask again next tick.
    if (!answer) {
      this.asked = null;
      return;
    }
    this.serverRunning = answer.running === true;
  }
}

/** What main.ts gives this file: its checked `handle`, the server, and what the app knows. */
export interface PreparingDeps {
  handle: (channel: string, listener: (e: unknown, ...args: unknown[]) => unknown) => void;
  control: DriverDeps["control"];
  conditions: () => Conditions;
}

/**
 * Wire Prepare my songs into the app: the window's messages, and the loop that starts and stops
 * it. Call `start` once the app is ready.
 */
export function registerPreparing(deps: PreparingDeps): PrepareDriver {
  const driver = new PrepareDriver({ conditions: deps.conditions, obsRunning: async () => obsInProcessList(await listProcesses()), control: deps.control });
  // Where preparing stands, for the window.
  deps.handle("prepare-status", async () => ({ waiting: driver.reason, server: await deps.control("prepare/status") }));
  return driver;
}
