import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { MODEL, ModelFile, modelPath } from "./model";
import type { Settings } from "./settings";

// Prepare my songs in the app (#293 to #297): the server prepares, this decides when (#295) and holds
// the window's messages, so main.ts only calls `registerPreparing` (ARCHITECTURE.md: Prepared songs)

/** Server settings for preparing: with Larger AI chosen and Standard downloaded, Standard writes the first pass (#296) */
export function prepareEnv(s: Pick<Settings, "ai" | "aiQuality">, modelsDir: string, ready: (model: ModelFile) => boolean): Record<string, string> {
  if (s.ai !== "builtin" || s.aiQuality !== "high" || !ready(MODEL)) return {};
  return { PREPARE_MODEL_PATH: modelPath(modelsDir, MODEL) };
}

// --- Is the computer free? ---

/** OBS itself as a process list names it (obs64.exe, OBS, obs), not its helpers */
export function isObsProcess(name: string): boolean {
  const base = path.posix.basename(name.trim().replace(/\\/g, "/")).replace(/\.exe$/i, "");
  return /^obs(?:32|64)?$/i.test(base);
}

/** OBS in a process list's text: `tasklist /FO CSV /NH` on Windows, `ps -A -o comm=` elsewhere */
export function obsInProcessList(text: string): boolean {
  return text.split(/\r?\n/).some((line) => {
    const csv = /^"([^"]*)"/.exec(line);
    return isObsProcess(csv ? csv[1] : line);
  });
}

/** Running programs' names; one cheap call, about once a second while preparing */
export function listProcesses(platform: NodeJS.Platform = process.platform): Promise<string> {
  const [cmd, args] = platform === "win32" ? ["tasklist", ["/FO", "CSV", "/NH"]] : ["ps", ["-A", "-o", "comm="]];
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 2000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

// Electron said "plugged in" on battery (Electron 44, macOS, 2026-11-02), so each system is asked too; each rejects when unsure

/** Mac on battery, from `pmset -g batt`'s first line ("Now drawing from 'Battery Power'"); null when neither */
export function batteryFromPmset(text: string): boolean | null {
  const first = text.split(/\r?\n/)[0] ?? "";
  if (/'Battery Power'/.test(first)) return true;
  if (/'(AC|UPS) Power'/.test(first)) return false;
  return null;
}

/** Windows on battery, from BatteryStatus per battery (none on a desktop): 1, 4, 5 (discharging, low, critical) only on battery */
export function batteryFromWin32(text: string): boolean | null {
  const values = text.split(/[\s,]+/).filter(Boolean);
  if (values.some((v) => !/^\d+$/.test(v))) return null;
  return values.some((v) => ["1", "4", "5"].includes(v));
}

/** A Linux /sys/class/power_supply entry: its `type`, and `online` or `status` where it has them */
export interface PowerSupply {
  type: string;
  online?: string;
  status?: string;
}

/** Linux on battery: no charger (Mains, USB) online, and a battery discharging or a charger offline; no battery = not */
export function batteryFromSysfs(supplies: PowerSupply[]): boolean {
  const chargers = supplies.filter((s) => /^(Mains|USB.*)$/.test(s.type));
  if (chargers.some((s) => s.online === "1")) return false;
  const batteries = supplies.filter((s) => s.type === "Battery");
  if (batteries.some((b) => b.status === "Discharging")) return true;
  return chargers.length > 0 && batteries.length > 0;
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // First Get-CimInstance on a cold or busy machine can take over 10 s (seen on CI); answers are reused, so a long limit costs little
    execFile(cmd, args, { timeout: 20_000, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

const sure = (answer: boolean | null, what: string): boolean => {
  if (answer === null) throw new Error(`${what} said neither battery nor plugged in`);
  return answer;
};

export async function macOnBattery(): Promise<boolean> {
  return sure(batteryFromPmset(await run("pmset", ["-g", "batt"])), "pmset");
}

export async function windowsOnBattery(): Promise<boolean> {
  const script = "(Get-CimInstance -ClassName Win32_Battery | ForEach-Object { $_.BatteryStatus }) -join ','";
  return sure(batteryFromWin32(await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script])), "Win32_Battery");
}

export async function linuxOnBattery(root = "/sys/class/power_supply"): Promise<boolean> {
  const read = (file: string) => fs.promises.readFile(file, "utf8").then((t) => t.trim(), () => undefined);
  const names = await fs.promises.readdir(root).catch((err: NodeJS.ErrnoException) => {
    // No power supplies at all: a desktop or a virtual machine.
    if (err.code === "ENOENT") return [] as string[];
    throw err;
  });
  const supplies = await Promise.all(names.map(async (name) => ({
    type: (await read(path.join(root, name, "type"))) ?? "",
    online: await read(path.join(root, name, "online")),
    status: await read(path.join(root, name, "status")),
  })));
  return batteryFromSysfs(supplies);
}

/** The same answer for `ms`, for a check too slow for every second (PowerShell takes about half a second to start) */
export function reusedFor<T>(ms: number, ask: () => Promise<T>, now: () => number = Date.now): () => Promise<T> {
  let last: { at: number; answer: Promise<T> } | null = null;
  return () => {
    if (!last || now() - last.at >= ms) {
      const answer = ask();
      last = { at: now(), answer };
      // A failed answer is asked again next time, not kept
      answer.catch(() => (last = null));
    }
    return last.answer;
  };
}

/** This system's own battery answer for the driver: every second, every 10 s on Windows */
export function systemOnBattery(platform: NodeJS.Platform = process.platform): (() => Promise<boolean>) | undefined {
  if (platform === "darwin") return macOnBattery;
  if (platform === "win32") return reusedFor(10_000, windowsOnBattery);
  if (platform === "linux") return () => linuxOnBattery();
  return undefined;
}

/** Why preparing waits, in the order checked; "" when the computer is free */
export type WaitReason = "" | "off" | "setup" | "online-ai" | "no-ai" | "server" | "battery" | "power-unknown" | "overlay" | "obs" | "obs-unknown";

export interface Conditions {
  /** The setting is on, and setup is done */
  enabled: boolean;
  setupDone: boolean;
  /** Which AI writes: on this computer, online (never used for preparing), or none ready */
  ai: "local" | "online" | "none";
  serverUp: boolean;
  onBattery: boolean;
  /** Overlays connected: OBS showing BubbleFacts */
  overlays: number;
}

/** Why preparing waits now, short of the process list; "" when only OBS is left to check */
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
  /** The system's own battery answer (systemOnBattery), as the app's (`conditions().onBattery`) can be wrong */
  onBattery?: () => Promise<boolean>;
  /** Asks the server (`/control/<path>`); null on no answer */
  control: (pathname: string, body?: unknown) => Promise<Record<string, unknown> | null>;
  now?: () => number;
}

const RECHECK_MS = 10 * 60_000; // ms before a run with nothing left starts again: the list or history may grow

/** Starts and stops preparing as the computer frees up or gets busy, ticking about once a second */
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
    // A slow process list never piles up ticks
    if (this.busy) return;
    this.busy = true;
    try {
      let reason = waitReason(this.deps.conditions());
      // Battery before an overlay, so the window says the same either way; not knowing waits too
      if ((!reason || reason === "overlay") && this.deps.onBattery) {
        const battery = await this.deps.onBattery().then((on) => (on ? "battery" : null), () => "power-unknown" as const);
        if (battery) reason = battery;
      }
      // A failed process list says nothing about OBS, which can be open before its overlay connects: wait
      if (!reason) reason = await this.deps.obsRunning().then((open) => (open ? "obs" : ""), () => "obs-unknown" as const);
      this.reason = reason;
      if (reason) {
        // Stop whenever it may be running: asked to run, or the server last said so
        if (this.asked !== "stop" || this.serverRunning) await this.ask(false);
        return;
      }
      // Asked again now and then: a finished run starts over if the list or history grew
      const due = this.asked !== "run" || this.now() - this.askedAt >= RECHECK_MS;
      if (due) await this.ask(true);
    } finally {
      this.busy = false;
    }
  }

  /** The server started over (settings change, crash): ask again on the next tick */
  serverRestarted(): void {
    this.asked = null;
    this.serverRunning = false;
  }

  private async ask(run: boolean): Promise<void> {
    this.asked = run ? "run" : "stop";
    this.askedAt = this.now();
    const answer = await this.deps.control("prepare", { run });
    // No answer (server restarting): ask again next tick
    if (!answer) {
      this.asked = null;
      return;
    }
    this.serverRunning = answer.running === true;
  }
}

/** From main.ts: its checked `handle`, the server, and what the app knows */
export interface PreparingDeps {
  handle: (channel: string, listener: (e: unknown, ...args: unknown[]) => unknown) => void;
  control: DriverDeps["control"];
  conditions: () => Conditions;
}

/** Wires Prepare my songs in (window messages, start-stop loop); call `start` once the app is ready */
export function registerPreparing(deps: PreparingDeps): PrepareDriver {
  const driver = new PrepareDriver({
    conditions: deps.conditions,
    obsRunning: async () => obsInProcessList(await listProcesses()),
    onBattery: systemOnBattery(),
    control: deps.control,
  });
  // Where preparing stands, for the window
  deps.handle("prepare-status", async () => ({ waiting: driver.reason, server: await deps.control("prepare/status") }));
  return driver;
}
