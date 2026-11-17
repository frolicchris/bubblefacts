import fs from "fs";
import path from "path";
import { writeFileAtomic } from "./atomic-write";
import { EDITABLE, fromWindow, Settings } from "./settings";

// Backups of what the streamer made: settings, facts, song facts, Wrong marks and the Wrong log
// Never sign-ins, keys or the song source, so a backup restores onto another computer or sign-in
export const BACKUP_FORMAT = "bubblefacts-backup";

// Left out: secrets and sign-ins; the AI and sharing, so a shared backup can't send songs to someone's server;
// AI quality (a 5 GB download on a smaller computer), Prepare my songs, the song source and file: this computer's
const NOT_BACKED_UP = new Set<keyof Settings>([
  "token", "seJwt", "groqKey", "anthropicKey", "shareKey", "shareFacts", "shareUrl", "shareChannel", "songSource", "channel", "seChannel", "nowPlayingPreset", "nowPlayingFile", "nowPlayingFormat", "setupComplete", "ai", "aiQuality", "ollamaUrl", "ollamaModel", "prepareSongs",
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
  /** The lines of `wrong-log.jsonl`; absent before 2.1 */
  wrongLog?: unknown[] | null;
}

/** Everything in the data folder that "Remove my data" deletes */
export const REMOVED_WITH_DATA = ["models", "overlay", "logs", "facts", "settings.json", "settings.json.unreadable", "wrong-facts.json", "wrong-log.jsonl", "aired-facts.json", "prepared-facts.json", "play-history.json", "song-facts.json", "song-facts.before-switches.json", "session.json", "backups", "updates", "THIRD-PARTY-NOTICES.md"];

/** The whole records in a wrong-log file's text, newest 500 at most */
export function wrongLogLines(text: string): unknown[] {
  const lines: unknown[] = [];
  for (const l of text.split("\n")) {
    try {
      const v: unknown = JSON.parse(l);
      if (v && typeof v === "object" && !Array.isArray(v)) lines.push(v);
    } catch {
      // A blank or cut-short line
    }
  }
  return lines.slice(-500);
}

export function makeBackup(settings: Settings, files: { songFacts: unknown; wrongFacts: unknown; wrongLog?: unknown[] | null }, appVersion: string, now = new Date()): Backup {
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
    wrongLog: files.wrongLog?.length ? files.wrongLog : null,
  };
}

/** A backup file read back; throws a message for the streamer when it isn't one */
export function readBackup(text: string): Backup {
  let raw: Partial<Backup>;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("That file isn't a BubbleFacts backup.");
  }
  if (!raw || raw.format !== BACKUP_FORMAT) throw new Error("That file isn't a BubbleFacts backup.");
  if (raw.formatVersion !== 1) throw new Error("That backup is from a newer BubbleFacts. Update BubbleFacts, then try again.");
  // Each value typed as its setting; secrets and the sign-in never come in from a file
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
    wrongLog: Array.isArray(raw.wrongLog) ? raw.wrongLog.filter((v) => v && typeof v === "object" && !Array.isArray(v)).slice(-500) : null,
  };
}

/** "BubbleFacts backup 2026-10-02.json" */
export const backupFileName = (now = new Date()) => `BubbleFacts backup ${now.toISOString().slice(0, 10)}.json`;

/** Automatic backups kept: a few weeks of changes for most streamers */
export const AUTO_KEEP = 20;
const AUTO_NAME = /^auto \d{4}-\d\d-\d\d \d\d-\d\d-\d\d\.json$/;
// What a backup holds, minus when and which version, so backups of the same facts compare equal
const contents = (b: Backup) => JSON.stringify([b.settings, b.songFacts, b.wrongFacts, b.wrongLog ?? null]);

/** Save `backup` in `dir` if it differs from the newest automatic one, keeping `keep`; the file, or "". Never throws */
export function autoBackup(dir: string, backup: Backup, keep = AUTO_KEEP): string {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const autos = fs.readdirSync(dir).filter((f) => AUTO_NAME.test(f)).sort();
    const newest = autos[autos.length - 1];
    if (newest) {
      try {
        if (contents(readBackup(fs.readFileSync(path.join(dir, newest), "utf8"))) === contents(backup)) return "";
      } catch {
        // An unreadable newest backup: write a fresh one
      }
    }
    // Local time, so "the one from last night" is easy to find
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
