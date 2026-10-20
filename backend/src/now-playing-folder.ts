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
 * desktop/src/now-playing-folder.ts holds the same rule for the app's picker text; keep them alike.
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
