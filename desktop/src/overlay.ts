import fs from "fs";
import path from "path";

/** The file OBS loads; dragged in, its name becomes the source's name */
export const OVERLAY_FILE = "BubbleFacts.html";
/** The vertical overlay for phone-shaped streams (1080x1920): same script and styles, its own spots and size */
export const VERTICAL_OVERLAY_FILE = "BubbleFacts Vertical.html";

/** Bubble size per overlay, so both can run at once */
export interface OverlaySizes {
  scale: number;
  verticalScale: number;
}

/**
 * Copy both overlays to the data folder (a path OBS can keep; DESKTOP-APP.md: Overlay file) with the port
 * and bubble sizes written in; the vertical one too, so a vertical scene works as soon as it's added
 */
export function installOverlay(sourceDir: string, targetDir: string, port: number, sizes: Partial<OverlaySizes> = {}): string {
  const { scale = 1, verticalScale = 1 } = sizes;
  fs.mkdirSync(targetDir, { recursive: true });
  const copy = (from: string, to: string, edit = (text: string) => text) =>
    fs.writeFileSync(path.join(targetDir, to), edit(fs.readFileSync(path.join(sourceDir, from), "utf8")));
  // OBS keeps a Browser source's script and styles; a new query on each write makes a reload of the source take the new ones.
  const fresh = (text: string) => text.replace(/(src|href)="(obs-overlay\.(?:js|css))"/g, `$1="$2?v=${Date.now()}"`);
  copy("obs-overlay.html", OVERLAY_FILE, fresh);
  copy("obs-overlay-vertical.html", VERTICAL_OVERLAY_FILE, fresh);
  copy("obs-overlay.css", "obs-overlay.css", (text) =>
    text.replace(/--bf-scale: [\d.]+;/, `--bf-scale: ${scale};`).replace(/--bf-vertical-scale: [\d.]+;/, `--bf-vertical-scale: ${verticalScale};`)
  );
  copy("obs-overlay.js", "obs-overlay.js", (text) => text.replace(/const SERVER = "[^"]*";/, `const SERVER = "127.0.0.1:${port}";`));
  // Earlier versions wrote the page under its source name
  fs.rmSync(path.join(targetDir, "obs-overlay.html"), { force: true });
  return path.join(targetDir, OVERLAY_FILE);
}
