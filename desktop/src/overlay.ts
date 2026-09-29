import fs from "fs";
import path from "path";

/**
 * OBS loads the overlay as a local file, so it needs a path that never moves.
 * The app's own files move on updates (and on Linux the AppImage mounts
 * somewhere new each run), so the overlay is copied to the data folder on
 * every start, with the server's port written in.
 */
export function installOverlay(sourceDir: string, targetDir: string, port: number): string {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const f of ["obs-overlay.html", "obs-overlay.css", "obs-overlay.js"]) {
    let text = fs.readFileSync(path.join(sourceDir, f), "utf8");
    if (f === "obs-overlay.js") {
      text = text.replace(/const SERVER = "[^"]*";/, `const SERVER = "127.0.0.1:${port}";`);
    }
    fs.writeFileSync(path.join(targetDir, f), text);
  }
  return path.join(targetDir, "obs-overlay.html");
}
