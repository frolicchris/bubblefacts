import fs from "fs";
import os from "os";
import path from "path";

/**
 * A preset's folder from its path inside Documents: the usual place, then each OneDrive (Windows often moves Documents there)
 * None yet: the usual place, so logs still name a sensible folder. Keep alike with desktop/src/now-playing-folder.ts
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
  // From the app: the system's Documents folder, which follows a redirect the home path doesn't
  const documents = env.BUBBLEFACTS_DOCUMENTS_DIR?.trim() || path.join(home, "Documents");
  const usual = path.join(documents, ...folder);
  const drives = [env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial].map((d) => d?.trim()).filter((d): d is string => !!d);
  const candidates = [usual, path.join(home, "Documents", ...folder), ...drives.map((d) => path.join(d, "Documents", ...folder))];
  return candidates.find((c) => isDir(c)) ?? usual;
}
