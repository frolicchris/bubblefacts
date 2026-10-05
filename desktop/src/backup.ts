import fs from "fs";
import path from "path";
import { writeFileAtomic } from "./atomic-write";
import { EDITABLE, fromWindow, Settings } from "./settings";

/**
 * A backup of what the streamer made: their settings, their facts, their
 * facts for particular songs and the sources they marked Wrong. Never the
 * sign-in or keys, and nothing that says which song list it came from, so a
 * backup restores onto another computer or a new sign-in.
 */
export const BACKUP_FORMAT = "bubblefacts-backup";

/**
 * Left out: secrets, the sign-in a backup must not carry to another account,
 * and which AI writes the facts, so a backup someone shares can't send every
 * song to their own server. The built-in AI's quality belongs to the computer
 * too: restored onto a smaller one, it would start a 5 GB download.
 */
const NOT_BACKED_UP = new Set<keyof Settings>([
  "token", "seJwt", "groqKey", "anthropicKey", "songSource", "channel", "seChannel", "setupComplete", "ai", "aiQuality", "ollamaUrl", "ollamaModel",
]);
const BACKED_UP = EDITABLE.filter((k) => !NOT_BACKED_UP.has(k));

export interface Backup {
  format: typeof BACKUP_FORMAT;
  formatVersion: 1;
  appVersion: string;
  createdAt: string;
  settings: Partial<Settings>;
  songFacts: unknown[] | null;
  wrongFacts: Record<string, unknown> | null;
}

export function makeBackup(settings: Settings, files: { songFacts: unknown; wrongFacts: unknown }, appVersion: string, now = new Date()): Backup {
  const picked: Record<string, unknown> = {};
  for (const key of BACKED_UP) picked[key] = settings[key];
  return {
    format: BACKUP_FORMAT,
    formatVersion: 1,
    appVersion,
    createdAt: now.toISOString(),
    settings: picked as Partial<Settings>,
    songFacts: Array.isArray(files.songFacts) ? files.songFacts : null,
    wrongFacts: files.wrongFacts && typeof files.wrongFacts === "object" && !Array.isArray(files.wrongFacts) ? (files.wrongFacts as Record<string, unknown>) : null,
  };
}

/** A backup file read back. Throws a message for the streamer when it isn't one. */
export function readBackup(text: string): Backup {
  let raw: Partial<Backup>;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("That file isn't a BubbleFacts backup.");
  }
  if (!raw || raw.format !== BACKUP_FORMAT) throw new Error("That file isn't a BubbleFacts backup.");
  if (raw.formatVersion !== 1) throw new Error("That backup is from a newer BubbleFacts. Update BubbleFacts, then try again.");
  // Each value must have the right type for its setting; secrets and the sign-in never come in from a file.
  const settings = fromWindow((raw.settings ?? {}) as Record<string, unknown>);
  for (const key of NOT_BACKED_UP) delete settings[key];
  return {
    format: BACKUP_FORMAT,
    formatVersion: 1,
    appVersion: typeof raw.appVersion === "string" ? raw.appVersion : "",
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    settings,
    songFacts: Array.isArray(raw.songFacts) ? raw.songFacts : null,
    wrongFacts: raw.wrongFacts && typeof raw.wrongFacts === "object" && !Array.isArray(raw.wrongFacts) ? raw.wrongFacts : null,
  };
}

/** "BubbleFacts backup 2026-10-02.json" */
export const backupFileName = (now = new Date()) => `BubbleFacts backup ${now.toISOString().slice(0, 10)}.json`;

/** Automatic backups kept: about the last few weeks of changes for most streamers. */
export const AUTO_KEEP = 20;
const AUTO_NAME = /^auto \d{4}-\d\d-\d\d \d\d-\d\d-\d\d\.json$/;
/** What a backup holds, without when and by which version: two backups of the same facts compare equal. */
const contents = (b: Backup) => JSON.stringify([b.settings, b.songFacts, b.wrongFacts]);

/**
 * Save `backup` in `dir` when it differs from the newest automatic one, and
 * keep only the last `keep`. Never throws: a backup that can't be written
 * mustn't stop the app. Returns the file written, or "" when nothing changed.
 */
export function autoBackup(dir: string, backup: Backup, keep = AUTO_KEEP): string {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const autos = fs.readdirSync(dir).filter((f) => AUTO_NAME.test(f)).sort();
    const newest = autos[autos.length - 1];
    if (newest) {
      try {
        if (contents(readBackup(fs.readFileSync(path.join(dir, newest), "utf8"))) === contents(backup)) return "";
      } catch {
        // An unreadable newest backup: write a fresh one.
      }
    }
    // Named in the streamer's own time, so "the one from last night" is easy to find.
    const d = new Date(backup.createdAt);
    const two = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}-${two(d.getMinutes())}-${two(d.getSeconds())}`;
    const file = path.join(dir, `auto ${stamp}.json`);
    writeFileAtomic(file, JSON.stringify(backup, null, 2));
    for (const old of [...autos, path.basename(file)].sort().slice(0, -keep)) fs.rmSync(path.join(dir, old), { force: true });
    return file;
  } catch {
    return "";
  }
}
