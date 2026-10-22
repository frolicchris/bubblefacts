import fs from "fs";
import os from "os";
import path from "path";

/**
 * Where a now-playing preset's folder is, given its path inside Documents. Apps write to Documents, which on Windows is often
 * redirected into OneDrive, so the usual place is looked at first ("~/Documents/<folder>"), then
 * the same folder in each OneDrive the computer names (OneDrive, OneDriveConsumer,
 * OneDriveCommercial). When none of them exists yet, the usual place is returned, so a log line
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
  }
): string {
  const usual = path.join(home, "Documents", ...folder);
  const drives = [env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial].map((d) => d?.trim()).filter((d): d is string => !!d);
  const candidates = [usual, ...drives.map((d) => path.join(d, "Documents", ...folder))];
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
  isDir?: (p: string) => boolean
): string {
  const found = presetFolder(folder, env, home, isDir);
  return found === path.join(home, "Documents", ...folder) ? "" : found;
}

/** What the picker names for each preset: Streamling's file, Nightbot's folder; "" where the usual Documents folder is in use. */
export function presetFoldersShown(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
  isDir?: (p: string) => boolean
): { streamling: string; nightbot: string } {
  const streamling = folderShownInstead(["streamling", "livetext"], env, home, isDir);
  return {
    streamling: streamling && path.join(streamling, "nowplaying-minimal.txt"),
    nightbot: folderShownInstead(["Nightbot"], env, home, isDir),
  };
}
