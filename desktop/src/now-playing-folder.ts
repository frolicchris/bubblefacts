import { app } from "electron";
import fs from "fs";
import os from "os";
import path from "path";

/** Documents as the system names it (it follows a redirect the home path doesn't); the home path if Electron can't say. */
function documentsDir(home: string): string {
  try {
    return app.getPath("documents") || path.join(home, "Documents");
  } catch {
    return path.join(home, "Documents");
  }
}

/**
 * Where a now-playing preset's folder is, given its path inside Documents. Apps write to Documents, which on Windows is often
 * redirected into OneDrive, so the system's Documents folder is looked at first, then "~/Documents/<folder>", then
 * the same folder in each OneDrive the computer names (OneDrive, OneDriveConsumer,
 * OneDriveCommercial). When none of them exists yet, the system's Documents folder is returned, so a log line
 * and a "no song yet" still name a folder that makes sense.
 *
 * The same rule as backend/src/now-playing-folder.ts, which the server uses; keep them alike.
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

/**
 * What the picker says a preset reads: nothing (the window's own text stands) when the usual
 * Documents folder is the one in use, else the folder actually found, which is where the server looks too.
 */
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

/** What the picker names for each preset: Streamling's file, Nightbot's folder; "" where the usual Documents folder is in use. */
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
