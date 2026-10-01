import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";

/**
 * The app's own updater. The standard one for Electron needs a Mac app
 * signed with an Apple Developer ID, which BubbleFacts doesn't have yet, so
 * this does the same job by hand: download the release's installer, check it
 * against the release's SHA256SUMS.txt, then swap the app and reopen it.
 * Nothing is installed until the musician clicks: never mid-stream.
 */

export interface Download {
  name: string;
  url: string;
  size: number;
  /** The release's SHA256SUMS.txt. */
  sumsUrl: string;
}

/** The installer this copy of the app can update itself from, or null (a .deb, or an unknown system). */
export function assetName(version: string, platform = process.platform, arch = process.arch, appImage = Boolean(process.env.APPIMAGE)): string | null {
  if (platform === "darwin") return `BubbleFacts-${version}-mac-${arch === "arm64" ? "arm64" : "x64"}.dmg`;
  if (platform === "win32") return `BubbleFacts-${version}-windows-x64.exe`;
  if (platform === "linux" && appImage) return `BubbleFacts-${version}-linux-x86_64.AppImage`;
  return null;
}

/** The checksum SHA256SUMS.txt lists for a file ("<64 hex>  <name>"), or null. */
export function expectedSum(sums: string, name: string): string | null {
  for (const line of sums.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (m && m[2].trim() === name) return m[1].toLowerCase();
  }
  return null;
}

export function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file).on("data", (d) => hash.update(d)).on("end", () => resolve(hash.digest("hex"))).on("error", reject);
  });
}

/**
 * Download the installer into `dir` and check it. Resolves to the file's
 * path only when its SHA-256 is the one the release lists; otherwise the
 * file is deleted and this throws.
 */
export async function downloadUpdate(d: Download, dir: string, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  // Earlier downloads are never reused: a half-written file would fail its check anyway.
  for (const old of fs.readdirSync(dir)) fs.rmSync(path.join(dir, old), { force: true, recursive: true });
  const sums = await fetch(d.sumsUrl, { signal });
  if (!sums.ok) throw new Error("couldn't read the release's checksums");
  const want = expectedSum(await sums.text(), d.name);
  if (!want) throw new Error("the release has no checksum for this file");

  const file = path.join(dir, d.name);
  const res = await fetch(d.url, { signal });
  if (!res.ok || !res.body) throw new Error(`the download failed (${res.status})`);
  const out = fs.createWriteStream(file);
  let got = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      got += chunk.length;
      if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
      onProgress(d.size ? Math.min(1, got / d.size) : 0);
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    if ((await sha256(file)) !== want) throw new Error("the download didn't match the release's checksum");
  } catch (err) {
    out.destroy();
    fs.rmSync(file, { force: true });
    throw err;
  }
  return file;
}

/** The .app bundle this process runs from, or null when it isn't a normal install that can be replaced. */
export function macBundle(execPath = process.execPath): string | null {
  const bundle = path.resolve(execPath, "../../..");
  if (!bundle.endsWith(".app")) return null;
  // Opened straight from the disk image, or run from Gatekeeper's read-only copy.
  if (bundle.startsWith("/Volumes/") || bundle.includes("/AppTranslocation/")) return null;
  try {
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
    fs.accessSync(bundle, fs.constants.W_OK);
  } catch {
    return null;
  }
  return bundle;
}

/**
 * The script that swaps the Mac app once this process has quit. It checks
 * the disk image really holds BubbleFacts, copies it beside the old app,
 * swaps the two, and reopens. If anything fails, the old app is put back
 * and reopened.
 */
export const MAC_SWAP_SCRIPT = `#!/bin/bash
PID="$1"; DMG="$2"; APP="$3"; LOG="$4"
exec >>"$LOG" 2>&1
echo "--- update $(date)"
while kill -0 "$PID" 2>/dev/null; do sleep 0.5; done
MNT="$(mktemp -d /tmp/bubblefacts-update.XXXXXX)"
reopen() { hdiutil detach "$MNT" -quiet 2>/dev/null; rmdir "$MNT" 2>/dev/null; open "$APP"; }
# hdiutil warns that it's deprecated on the newest macOS but still works; its replacement isn't on older ones.
hdiutil attach -nobrowse -readonly -mountpoint "$MNT" "$DMG" >/dev/null || { echo "could not open the disk image"; reopen; exit 1; }
NEW="$MNT/BubbleFacts.app"
ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$NEW/Contents/Info.plist" 2>/dev/null)"
[ "$ID" = "org.frolic.bubblefacts" ] || { echo "not BubbleFacts: $ID"; reopen; exit 1; }
STAGE="$APP.update"; OLD="$APP.old"
rm -rf "$STAGE" "$OLD"
ditto "$NEW" "$STAGE" || { echo "copy failed"; rm -rf "$STAGE"; reopen; exit 1; }
mv "$APP" "$OLD" || { echo "could not move the old app"; rm -rf "$STAGE"; reopen; exit 1; }
if mv "$STAGE" "$APP"; then rm -rf "$OLD"; echo "updated"; else echo "swap failed, restoring"; mv "$OLD" "$APP"; fi
rm -f "$DMG"
reopen
`;

export type InstallResult = { started: true } | { started: false; reason: string };

/**
 * Start installing a checked download. On success the caller must quit the
 * app right away: the installer (or the swap script) is waiting for it.
 */
export function startInstall(file: string, opts: { pid: number; logFile: string; scriptDir: string }): InstallResult {
  const detached = (cmd: string, args: string[]) => spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  if (process.platform === "darwin") {
    const bundle = macBundle();
    if (!bundle) return { started: false, reason: "BubbleFacts isn't in a folder it can update itself in" };
    const script = path.join(opts.scriptDir, "swap.sh");
    fs.writeFileSync(script, MAC_SWAP_SCRIPT, { mode: 0o700 });
    detached("/bin/bash", [script, String(opts.pid), file, bundle, opts.logFile]);
    return { started: true };
  }
  if (process.platform === "win32") {
    // The installer replaces the app and opens it again when it's done.
    detached(file, []);
    return { started: true };
  }
  const appImage = process.env.APPIMAGE;
  if (process.platform === "linux" && appImage) {
    try {
      const staged = `${appImage}.update`;
      fs.copyFileSync(file, staged);
      fs.chmodSync(staged, 0o755);
      fs.renameSync(staged, appImage);
      fs.rmSync(file, { force: true });
    } catch (err) {
      return { started: false, reason: `couldn't replace the AppImage (${err instanceof Error ? err.message : err})` };
    }
    // Reopened once this process is gone.
    detached("/bin/sh", ["-c", `while kill -0 ${opts.pid} 2>/dev/null; do sleep 0.5; done; exec "${appImage.replace(/"/g, '\\"')}"`]);
    return { started: true };
  }
  return { started: false, reason: "this kind of install updates through your system" };
}
