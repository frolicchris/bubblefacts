import crypto from "crypto";
import fs from "fs";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import type { ReadableStream as WebReadableStream } from "stream/web";
import path from "path";
import { plainWithDetail } from "./plain-errors";

// The built-in AI's model files and their download (DESKTOP-APP.md: AI)

/** A model file: where it comes from, its exact size and SHA-256, and its license */
export interface ModelFile {
  file: string;
  url: string;
  bytes: number;
  sha256: string;
  license: string;
}

/** Standard: Llama 3.2 3B Instruct, 4-bit; pinned to a commit and checked by SHA-256, so a cut or tampered file is never used */
export const MODEL: ModelFile = {
  file: "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
  url: "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/5ab33fa94d1d04e903623ae72c95d1696f09f9e8/Llama-3.2-3B-Instruct-Q4_K_M.gguf",
  bytes: 2_019_377_696,
  sha256: "6c1a2b41161032677be168d354123594c0e6e67d2b9227c84f296ad037c728ff",
  license: "https://www.llama.com/llama3_2/license/",
};

/** Larger AI: Llama 3.1 8B Instruct, 4-bit; 5 GB, needs 16 GB of memory, writes 1.5 to 2 times slower, so opt-in */
export const MODEL_HIGH: ModelFile = {
  file: "Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf",
  url: "https://huggingface.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF/resolve/bf5b95e96dac0462e2a09145ec66cae9a3f12067/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf",
  bytes: 4_920_739_232,
  sha256: "7b064f5842bf9532c91456deda288a1b672397a54fa729aa665952863033557c",
  license: "https://www.llama.com/llama3_1/license/",
};

export type AiQuality = "standard" | "high";

/** The model for a quality setting; anything unknown gets Standard */
export const modelFor = (quality: string): ModelFile => (quality === "high" ? MODEL_HIGH : MODEL);

export interface Progress {
  received: number;
  total: number;
  phase: "downloading" | "checking" | "done";
}

/** Not the file this version expects; not retried on its own, as it would most likely fetch the same file */
export class ChecksumMismatch extends Error {
  constructor() {
    super("The file didn't match the one BubbleFacts expects, so it was deleted. Click Try again later. Until then, songs get facts from music databases and your own facts.");
  }
}

export const modelPath = (dir: string, model: ModelFile = MODEL) => path.join(dir, model.file);

/** Present and the right size; the full checksum runs after each download, not on every start */
export function modelReady(dir: string, model: ModelFile = MODEL): boolean {
  try {
    return fs.statSync(modelPath(dir, model)).size === model.bytes;
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

const SPARE_BYTES = 500 * 1024 * 1024; // bytes to leave free beyond the file
/** "about 2.5 GB" (3B) or "about 5.5 GB" (8B): file plus spare room, to the nearest half GB */
export function diskNeeded(model: ModelFile): string {
  const gb = Math.max(0.5, Math.round(((model.bytes + SPARE_BYTES) / 1e9) * 2) / 2);
  return `about ${gb} GB`;
}
const noSpace = (model: ModelFile) => `There isn't enough free disk space. The AI needs ${diskNeeded(model)}. Free up some space and it will try again.`;

function freeBytes(dir: string): number | null {
  try {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

export async function downloadModel(dir: string, onProgress: (p: Progress) => void, signal: AbortSignal, model: ModelFile = MODEL): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  const part = modelPath(dir, model) + ".part";
  let received = fs.existsSync(part) ? fs.statSync(part).size : 0;
  if (received > model.bytes) {
    fs.unlinkSync(part);
    received = 0;
  }

  if (received < model.bytes) {
    const free = freeBytes(dir);
    if (free !== null && free < model.bytes - received + SPARE_BYTES) throw new Error(noSpace(model));
    const res = await fetch(model.url, {
      headers: received ? { Range: `bytes=${received}-` } : {},
      redirect: "follow",
      signal,
    });
    if (!res.ok || !res.body) throw plainWithDetail("The download site isn't answering right now. BubbleFacts tries again on its own.", `HTTP ${res.status} ${res.statusText}`);
    if (received && res.status !== 206) received = 0; // the server ignored the resume request

    let lastReport = 0;
    const count = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        received += chunk.length;
        if (Date.now() - lastReport > 250) {
          lastReport = Date.now();
          onProgress({ received, total: model.bytes, phase: "downloading" });
        }
        done(null, chunk);
      },
    });
    try {
      // pipeline passes disk errors (a full disk) back here instead of crashing the app
      await pipeline(
        Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>),
        count,
        fs.createWriteStream(part, { flags: received ? "a" : "w" }),
        { signal }
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOSPC") throw new Error(noSpace(model));
      throw err;
    }
  }

  onProgress({ received: model.bytes, total: model.bytes, phase: "checking" });
  if ((await sha256(part)) !== model.sha256) {
    fs.unlinkSync(part);
    throw new ChecksumMismatch();
  }
  fs.renameSync(part, modelPath(dir, model));
  onProgress({ received: model.bytes, total: model.bytes, phase: "done" });
}
