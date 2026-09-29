import crypto from "crypto";
import fs from "fs";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import type { ReadableStream as WebReadableStream } from "stream/web";
import path from "path";

/**
 * The built-in AI model: Meta's Llama 3.2 3B Instruct, 4-bit, from Hugging Face.
 * Downloaded once, resumable, and checked against the SHA-256 Hugging Face
 * publishes for the file, so a truncated or tampered download is never used.
 */
export const MODEL = {
  file: "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
  url: "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf",
  bytes: 2_019_377_696,
  sha256: "6c1a2b41161032677be168d354123594c0e6e67d2b9227c84f296ad037c728ff",
  license: "https://www.llama.com/llama3_2/license/",
};

export interface Progress {
  received: number;
  total: number;
  phase: "downloading" | "checking" | "done";
}

export const modelPath = (dir: string) => path.join(dir, MODEL.file);

/** Present and the right size. The full checksum runs after each download, not on every start. */
export function modelReady(dir: string): boolean {
  try {
    return fs.statSync(modelPath(dir)).size === MODEL.bytes;
  } catch {
    return false;
  }
}

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file).on("data", (d) => hash.update(d)).on("end", () => resolve(hash.digest("hex"))).on("error", reject);
  });
}

/** Room to leave free beyond the file itself. */
const SPARE_BYTES = 500 * 1024 * 1024;
const NO_SPACE = "There isn't enough free disk space. The AI needs about 2.5 GB. Free up some space and it will try again";

function freeBytes(dir: string): number | null {
  try {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

export async function downloadModel(dir: string, onProgress: (p: Progress) => void, signal: AbortSignal): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  const part = modelPath(dir) + ".part";
  let received = fs.existsSync(part) ? fs.statSync(part).size : 0;
  if (received > MODEL.bytes) {
    fs.unlinkSync(part);
    received = 0;
  }

  if (received < MODEL.bytes) {
    const free = freeBytes(dir);
    if (free !== null && free < MODEL.bytes - received + SPARE_BYTES) throw new Error(NO_SPACE);
    const res = await fetch(MODEL.url, {
      headers: received ? { Range: `bytes=${received}-` } : {},
      redirect: "follow",
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
    if (received && res.status !== 206) received = 0; // The server ignored the resume request.

    let lastReport = 0;
    const count = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        received += chunk.length;
        if (Date.now() - lastReport > 250) {
          lastReport = Date.now();
          onProgress({ received, total: MODEL.bytes, phase: "downloading" });
        }
        done(null, chunk);
      },
    });
    try {
      // pipeline passes disk errors (a full disk, say) back here instead of crashing the app.
      await pipeline(
        Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>),
        count,
        fs.createWriteStream(part, { flags: received ? "a" : "w" }),
        { signal }
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOSPC") throw new Error(NO_SPACE);
      throw err;
    }
  }

  onProgress({ received: MODEL.bytes, total: MODEL.bytes, phase: "checking" });
  if ((await sha256(part)) !== MODEL.sha256) {
    fs.unlinkSync(part);
    throw new Error("The downloaded file didn't match its checksum and was deleted. Please try again.");
  }
  fs.renameSync(part, modelPath(dir));
  onProgress({ received: MODEL.bytes, total: MODEL.bytes, phase: "done" });
}
