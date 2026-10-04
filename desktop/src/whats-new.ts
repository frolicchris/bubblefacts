import fs from "fs";
import { compareVersions } from "./checks";

/**
 * "What's new" after an update: a few highlights for each version, shipped
 * with the app in desktop/renderer/whats-new.json (never from the network).
 * The release process adds the new version's lines (docs/RELEASING.md).
 */
export type WhatsNewNotes = Record<string, string[]>;

export interface WhatsNew {
  version: string;
  highlights: string[];
}

export const CHANGELOG_URL = "https://bubblefacts.frolic.org/changelog.html";
/** At most this many lines show: a quick look, not the changelog. */
export const MAX_HIGHLIGHTS = 4;

/** The notes file, or nothing if it's missing or unreadable: the app works the same without it. */
export function readWhatsNew(file: string): WhatsNewNotes {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: WhatsNewNotes = {};
    for (const [version, lines] of Object.entries(raw as Record<string, unknown>)) {
      if (!Array.isArray(lines)) continue;
      const kept = lines.filter((l): l is string => typeof l === "string" && l.trim() !== "").map((l) => l.trim());
      if (kept.length) out[version] = kept.slice(0, MAX_HIGHLIGHTS);
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * What to do when the app opens. `show` is the notice for this version, or
 * null. `remember` means save this version as seen now, with nothing shown:
 * a first install (setup hasn't finished), going back to an older version,
 * or a version with no highlights. A shown notice is remembered when the
 * musician dismisses it.
 */
export function whatsNewOnStart(current: string, lastSeen: string, setupComplete: boolean, notes: WhatsNewNotes): { show: WhatsNew | null; remember: boolean } {
  if (lastSeen === current) return { show: null, remember: false };
  // A new install: setup is the welcome, and this version is already "seen".
  if (!setupComplete) return { show: null, remember: true };
  // Blank means it was updated from a version before this notice existed.
  if (lastSeen && compareVersions(current, lastSeen) < 0) return { show: null, remember: true };
  const highlights = notes[current];
  if (!highlights?.length) return { show: null, remember: true };
  return { show: { version: current, highlights }, remember: false };
}
