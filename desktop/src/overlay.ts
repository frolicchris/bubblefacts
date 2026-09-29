import fs from "fs";
import path from "path";

/** The file OBS loads. Dragged into OBS, its name becomes the source's name. */
export const OVERLAY_FILE = "BubbleFacts.html";

/**
 * OBS loads the overlay as a local file, so it needs a path that never moves.
 * The app's own files move on updates (and on Linux the AppImage mounts
 * somewhere new each run), so the overlay is copied to the data folder on
 * every start, with the server's port and the bubble size written in.
 */
export function installOverlay(sourceDir: string, targetDir: string, port: number, scale = 1): string {
  fs.mkdirSync(targetDir, { recursive: true });
  const copy = (from: string, to: string, edit = (text: string) => text) =>
    fs.writeFileSync(path.join(targetDir, to), edit(fs.readFileSync(path.join(sourceDir, from), "utf8")));
  copy("obs-overlay.html", OVERLAY_FILE);
  copy("obs-overlay.css", "obs-overlay.css", (text) => text.replace(/--bf-scale: [\d.]+;/, `--bf-scale: ${scale};`));
  copy("obs-overlay.js", "obs-overlay.js", (text) => text.replace(/const SERVER = "[^"]*";/, `const SERVER = "127.0.0.1:${port}";`));
  // Earlier versions wrote the page under its source name.
  fs.rmSync(path.join(targetDir, "obs-overlay.html"), { force: true });
  return path.join(targetDir, OVERLAY_FILE);
}
