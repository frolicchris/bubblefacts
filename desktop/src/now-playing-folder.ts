import { app } from "electron";
import fs from "fs";
import os from "os";
import path from "path";

// Documents as the system names it (it follows a redirect the home path doesn't), else ~/Documents
function documentsDir(home: string): string {
  try {
    return app.getPath("documents") || path.join(home, "Documents");
  } catch {
    return path.join(home, "Documents");
  }
}

/**
 * A now-playing preset's folder, given its path inside Documents (often redirected into OneDrive on Windows)
 * Tries the system's Documents, ~/Documents, then each OneDrive; none yet: the system's, so messages name a sensible folder
 * Same rule as backend/src/now-playing-folder.ts; keep them alike
 */
export function presetFolder(
  folder: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
  isDir: (p: string) => boolean = (p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  documents: string = documentsDir(home)
): string {
  const usual = path.join(documents, ...folder);
  const drives = [env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial].map((d) => d?.trim()).filter((d): d is string => !!d);
  const candidates = [usual, path.join(home, "Documents", ...folder), ...drives.map((d) => path.join(d, "Documents", ...folder))];
  return candidates.find((c) => isDir(c)) ?? usual;
}

/** The folder the picker names for a preset (where the server looks too), or "" when the usual Documents one is in use */
export function folderShownInstead(
  folder: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
  isDir?: (p: string) => boolean,
  documents: string = documentsDir(home)
): string {
  const found = presetFolder(folder, env, home, isDir, documents);
  return found === path.join(documents, ...folder) || found === path.join(home, "Documents", ...folder) ? "" : found;
}

/** What the picker names per preset: Streamling's file, Nightbot's folder; "" for the usual Documents folder */
export function presetFoldersShown(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
  isDir?: (p: string) => boolean,
  documents: string = documentsDir(home)
): { streamling: string; nightbot: string } {
  const streamling = folderShownInstead(["streamling", "livetext"], env, home, isDir, documents);
  return {
    streamling: streamling && path.join(streamling, "nowplaying-minimal.txt"),
    nightbot: folderShownInstead(["Nightbot"], env, home, isDir, documents),
  };
}
