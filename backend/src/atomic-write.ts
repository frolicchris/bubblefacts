import fs from "fs";
import path from "path";

/**
 * Write via a temp file and one rename: a crash leaves the old file or the new, never half
 * (a half-written session.json once replayed the bubbles after a restart). `mode`: the
 * permissions; without it an existing file keeps its own
 * The desktop app has its own copy (desktop/src/atomic-write.ts): the two are compiled separately
 */
export function writeFileAtomic(file: string, data: string, options: { mode?: number } = {}): void {
  let mode = options.mode;
  if (mode === undefined) {
    try {
      mode = fs.statSync(file).mode & 0o777;
    } catch {
      // A new file: default permissions
    }
  }
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    const fd = fs.openSync(temp, "wx", mode ?? 0o666);
    try {
      // Opening applies the umask; set exactly the mode asked for or kept
      if (mode !== undefined && process.platform !== "win32") fs.fchmodSync(fd, mode);
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    renameOver(temp, file);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

/** Windows: a virus scanner or indexer may hold the old file a moment, so retry briefly */
function renameOver(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || attempt >= 5 || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
    }
  }
}
