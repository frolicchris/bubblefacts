import { EDITABLE, fromWindow, Settings } from "./settings";

/**
 * A backup of what the streamer made: their settings, their facts, their
 * facts for particular songs and the sources they marked Wrong. Never the
 * sign-in or keys, and nothing that says which song list it came from, so a
 * backup restores onto another computer or a new sign-in.
 */
export const BACKUP_FORMAT = "bubblefacts-backup";

/** Left out: secrets, and the sign-in a backup must not carry to another account. */
const NOT_BACKED_UP = new Set<keyof Settings>(["token", "seJwt", "groqKey", "anthropicKey", "songSource", "channel", "seChannel", "setupComplete"]);
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
