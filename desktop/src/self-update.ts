import fs from "fs";
import path from "path";
import { newerRelease, Release } from "./checks";
import type { PlainOptions } from "./plain-errors";
import type { Settings } from "./settings";
import { assetName, downloadUpdate, startInstall } from "./updater";

// Updating itself: the check for a newer release, its download and its install, with their window
// messages, so main.ts only calls `registerSelfUpdate`. updater.ts holds the steps; this holds the state

/** The in-app update: idle, downloading, checked and ready, or failed (then the download page is offered) */
interface Updating {
  stage: "idle" | "downloading" | "ready" | "failed";
  progress: number;
  file: string;
  error: string;
}

/** From main.ts: its checked `handle`, and what the app knows */
export interface SelfUpdateDeps {
  handle: (channel: string, listener: (e: unknown, ...args: unknown[]) => unknown) => void;
  version: () => string;
  updateChannel: () => Settings["updateChannel"];
  /** A copy run from source has no installer to download: a newer release is offered from the website */
  packaged: boolean;
  /** The Store updates a Store app: no check, no download, no install */
  storeApp: () => boolean;
  dataDir: string;
  logsDir: string;
  /** Something the window shows changed */
  changed: () => void;
  /** A failure in plain words for the window; the technical side goes in the log */
  shown: (where: string, err: unknown, opts?: PlainOptions) => string;
  note: (line: string) => void;
  /** Quit so the installer can run; `relaunch`: the new app to open afterward (Linux) */
  quitForInstall: (relaunch?: string) => void;
}

export interface SelfUpdate {
  /** At start, and when Stable or Beta is picked, so the dashboard notice matches at once */
  check: () => Promise<void>;
  /** What the window's state says about updating */
  forWindow: () => { update: Release | null; updating: Pick<Updating, "stage" | "progress" | "error"> };
}

/** Wires the update in (window messages); call `check` once the app is ready */
export function registerSelfUpdate(deps: SelfUpdateDeps): SelfUpdate {
  let update: Release | null = null;
  let updating: Updating = { stage: "idle", progress: 0, file: "", error: "" };
  let updateChecks = 0;

  async function check(): Promise<void> {
    // The Store updates a Store app: no check, so no banner.
    if (deps.storeApp()) return;
    const mine = ++updateChecks;
    const found = await newerRelease(deps.version(), deps.updateChannel(), deps.packaged ? (v) => assetName(v, process.platform, process.arch, Boolean(process.env.APPIMAGE)) : () => null);
    // Only the newest check counts, and a download under way finishes
    if (mine !== updateChecks || updating.stage === "downloading") return;
    if (found?.version !== update?.version) updating = { stage: "idle", progress: 0, file: "", error: "" };
    update = found;
    deps.changed();
  }

  deps.handle("download-update", async () => {
    if (deps.storeApp() || !update?.download || updating.stage === "downloading") return;
    updating = { stage: "downloading", progress: 0, file: "", error: "" };
    deps.changed();
    let last = 0;
    try {
      const file = await downloadUpdate(update.download, path.join(deps.dataDir, "updates"), (fraction) => {
        // A few a second is plenty for a progress line
        if (Date.now() - last < 300) return;
        last = Date.now();
        updating.progress = fraction;
        deps.changed();
      });
      updating = { stage: "ready", progress: 1, file, error: "" };
    } catch (err) {
      updating = { stage: "failed", progress: 0, file: "", error: deps.shown("Update download", err, { fallback: "The download didn't finish." }) };
    }
    deps.changed();
  });

  deps.handle("install-update", () => {
    if (deps.storeApp() || updating.stage !== "ready") return;
    fs.mkdirSync(deps.logsDir, { recursive: true });
    const result = startInstall(updating.file, { pid: process.pid, logFile: path.join(deps.logsDir, "update.log"), scriptDir: path.join(deps.dataDir, "updates") });
    if (!result.started) {
      deps.note(`[App] Update install: ${result.reason}${result.detail ? ` (${result.detail})` : ""}`);
      updating = { stage: "failed", progress: 0, file: "", error: result.reason };
      deps.changed();
      return;
    }
    // The installer waits for this app to close; on Linux the app reopens the new AppImage itself
    deps.quitForInstall(result.relaunch);
  });

  return {
    check,
    forWindow: () => ({ update, updating: { stage: updating.stage, progress: updating.progress, error: updating.error } }),
  };
}
