// Ready-made looks: Style files that come with the app (desktop/looks), read through the same check
// as a shared one. The window names one from this list; it never gives a path.
import fs from "fs";
import path from "path";
import { readStyleFile, STYLE_FILE_MAX_BYTES, StyleFileResult } from "./style-file";

/** File names (without .json) in desktop/looks, in the order the list shows them */
export const READY_LOOKS = ["stage-lights", "record-sleeve", "neon-booth"] as const;

export function readReadyLook(dir: string, id: unknown, appVersion?: string): StyleFileResult {
  const missing: StyleFileResult = { ok: false, reason: "That look isn't in this BubbleFacts." };
  if (typeof id !== "string" || !(READY_LOOKS as readonly string[]).includes(id)) return missing;
  let text: string;
  try {
    const file = path.join(dir, `${id}.json`);
    if (fs.statSync(file).size > STYLE_FILE_MAX_BYTES) return missing;
    text = fs.readFileSync(file, "utf8");
  } catch {
    return missing;
  }
  return readStyleFile(text, appVersion);
}
