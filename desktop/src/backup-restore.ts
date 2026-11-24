import type { MessageBoxOptions, MessageBoxReturnValue, OpenDialogOptions, OpenDialogReturnValue, SaveDialogOptions, SaveDialogReturnValue } from "electron";
import fs from "fs";
import path from "path";
import { writeFileAtomic } from "./atomic-write";
import { autoBackup, backupFileName, makeBackup, readBackup, restoresFacts, wrongLogLines } from "./backup";
import type { AskChannel } from "./ipc-channels";
import type { PlainOptions } from "./plain-errors";
import { factsAreWhole, factsSaveProblem, factsWhole, sanitize, saveSettings, Settings } from "./settings";

// Back up… and Restore… from the window, and the automatic copy after every change, so main.ts only
// calls `registerBackups`. backup.ts holds what a backup contains and how many automatic copies are kept

/** A file in the data folder as JSON; null when it's missing or can't be read */
export function readDataJson(dataDir: string, name: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, name), "utf8"));
  } catch {
    return null;
  }
}

/** From main.ts: its checked `handle`, the folders, the settings, and the window's dialogs */
export interface BackupDeps {
  handle: (channel: AskChannel, listener: (e: unknown, ...args: unknown[]) => unknown) => void;
  dataDir: string;
  backupsDir: string;
  /** Where Back up… suggests saving */
  documentsDir: () => string;
  version: () => string;
  settings: () => Settings;
  /** The restored settings, to use from now on */
  useSettings: (settings: Settings) => void;
  /** After a restore is written: make it take effect (the server reads its files at start) */
  restored: () => void;
  dialogs: {
    save: (options: SaveDialogOptions) => Promise<SaveDialogReturnValue>;
    open: (options: OpenDialogOptions) => Promise<OpenDialogReturnValue>;
    ask: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>;
  };
  /** A failure in plain words for the window; the technical side goes in the log */
  shown: (where: string, err: unknown, opts?: PlainOptions) => string;
}

export interface Backups {
  /** After any change to facts or settings: a copy the streamer never has to think about */
  now: () => void;
}

/** Wires Back up… and Restore… in (window messages) */
export function registerBackups(deps: BackupDeps): Backups {
  const readJson = (name: string) => readDataJson(deps.dataDir, name);
  const readWrongLog = (): unknown[] => {
    try {
      return wrongLogLines(fs.readFileSync(path.join(deps.dataDir, "wrong-log.jsonl"), "utf8"));
    } catch {
      return [];
    }
  };

  // Facts left out while own-facts.json couldn't be read: the boxes then aren't the streamer's facts (#193)
  const currentBackup = () => makeBackup(deps.settings(), { songFacts: readJson("song-facts.json"), wrongFacts: readJson("wrong-facts.json"), wrongLog: readWrongLog(), ...(factsWhole() ? {} : { facts: "unread" as const }) }, deps.version());
  const now = () => void autoBackup(deps.backupsDir, currentBackup());

  deps.handle("save-backup", async () => {
    const options = { defaultPath: path.join(deps.documentsDir(), backupFileName()), filters: [{ name: "BubbleFacts backup", extensions: ["json"] }] };
    const { canceled, filePath } = await deps.dialogs.save(options);
    if (canceled || !filePath) return { ok: false, message: "" };
    try {
      writeFileAtomic(filePath, JSON.stringify(currentBackup(), null, 2));
    } catch (err) {
      return { ok: false, message: deps.shown("Back up", err, { fallback: "BubbleFacts couldn't save the backup there. Choose another folder, then try again." }) };
    }
    return { ok: true, message: `Saved to ${path.basename(filePath)}.` };
  });

  deps.handle("restore-backup", async () => {
    // Opens at the automatic backups, so the newest is a click away
    const options = { defaultPath: deps.backupsDir, properties: ["openFile" as const], filters: [{ name: "BubbleFacts backup", extensions: ["json"] }] };
    const { canceled, filePaths } = await deps.dialogs.open(options);
    if (canceled || !filePaths[0]) return { ok: false, message: "" };
    let backup;
    try {
      backup = readBackup(fs.readFileSync(filePaths[0], "utf8"));
    } catch (err) {
      return { ok: false, message: deps.shown("Restore", err, { fallback: "That file couldn't be read." }) };
    }
    const when = backup.createdAt ? new Date(backup.createdAt).toLocaleDateString() : "an earlier day";
    const confirm = {
      type: "question" as const,
      buttons: ["Restore", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: `Restore the backup from ${when}?`,
      detail: "This replaces your settings, your facts, your facts for particular songs and the sources you marked Wrong on this computer. Your sign-in and your AI choice stay as they are.",
    };
    const { response } = await deps.dialogs.ask(confirm);
    if (response !== 0) return { ok: false, message: "" };
    // Back up first, so a restore can be undone
    now();
    const settings = sanitize({ ...deps.settings(), ...backup.settings });
    deps.useSettings(settings);
    // The backup's facts are the whole boxes: they replace the stored ones, even while they wait in settings.json (#193).
    // One taken while the facts couldn't be read has none, and leaves them as they are
    if (restoresFacts(backup)) factsAreWhole();
    saveSettings(settings);
    const factsProblem = factsSaveProblem();
    if (backup.songFacts) writeFileAtomic(path.join(deps.dataDir, "song-facts.json"), JSON.stringify(backup.songFacts, null, 2));
    if (backup.wrongFacts) writeFileAtomic(path.join(deps.dataDir, "wrong-facts.json"), JSON.stringify(backup.wrongFacts, null, 2));
    if (backup.wrongLog?.length) writeFileAtomic(path.join(deps.dataDir, "wrong-log.jsonl"), backup.wrongLog.map((l) => JSON.stringify(l)).join("\n") + "\n", { mode: 0o600 });
    deps.restored();
    // Said as a failed save is; the rest of the backup is restored
    if (factsProblem) return { ok: false, message: `Restored. ${factsProblem}` };
    return { ok: true, message: "Restored." };
  });

  return { now };
}
