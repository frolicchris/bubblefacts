import fs from "fs";
import { compareVersions } from "./checks";

// "What's new" after an update: a few highlights per version from desktop/renderer/whats-new.json,
// shipped with the app, never from the network (RELEASING.md adds each version's lines)
export type WhatsNewNotes = Record<string, string[]>;

export interface WhatsNew {
  version: string;
  highlights: string[];
}

export const CHANGELOG_URL = "https://bubblefacts.frolic.org/changelog.html";
/** Lines shown at most: a quick look, not the changelog */
export const MAX_HIGHLIGHTS = 4;

/** The notes file, or {} if missing or unreadable: the app works the same without it */
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
 * What to do at start: `show` this version's notice (remembered when dismissed), or `remember` it as seen
 * with nothing shown (a first install, an older version, no highlights)
 */
export function whatsNewOnStart(current: string, lastSeen: string, setupComplete: boolean, notes: WhatsNewNotes): { show: WhatsNew | null; remember: boolean } {
  if (lastSeen === current) return { show: null, remember: false };
  // A new install: setup is the welcome
  if (!setupComplete) return { show: null, remember: true };
  // Blank lastSeen: updated from a version before this notice existed
  if (lastSeen && compareVersions(current, lastSeen) < 0) return { show: null, remember: true };
  const highlights = notes[current];
  if (!highlights?.length) return { show: null, remember: true };
  return { show: { version: current, highlights }, remember: false };
}
