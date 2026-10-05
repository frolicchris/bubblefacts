import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { ChecksumMismatch, diskNeeded, downloadModel, MODEL, MODEL_HIGH, modelFor, modelPath, modelReady, Progress } from "./model";

// The real descriptors, before the stand-ins below replace their sizes.
const real = { standard: { ...MODEL }, high: { ...MODEL_HIGH } };

// Small stand-ins for the 2 GB and 5 GB files.
const data = crypto.randomBytes(300_000);
Object.assign(MODEL, { bytes: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex") });
const highData = crypto.randomBytes(400_000);
Object.assign(MODEL_HIGH, { bytes: highData.length, sha256: crypto.createHash("sha256").update(highData).digest("hex") });

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;
const serve = (body: Buffer, status = 200) => new Response(new Uint8Array(body), { status });

let dir: string;
beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "bubblefacts-model-"))));
afterEach(() => {
  mockFetch.mockReset();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("downloadModel", () => {
  it("downloads, checks and installs the model, reporting each phase", async () => {
    mockFetch.mockResolvedValueOnce(serve(data));
    const phases: string[] = [];
    await downloadModel(dir, (p: Progress) => phases.push(p.phase), new AbortController().signal);
    expect(modelReady(dir)).toBe(true);
    expect(fs.readFileSync(modelPath(dir)).equals(data)).toBe(true);
    expect(phases.slice(-2)).toEqual(["checking", "done"]);
  });

  it("resumes where a stopped download left off", async () => {
    fs.writeFileSync(modelPath(dir) + ".part", data.subarray(0, 100_000));
    mockFetch.mockResolvedValueOnce(serve(data.subarray(100_000), 206));
    await downloadModel(dir, () => {}, new AbortController().signal);
    expect(mockFetch.mock.calls[0][1].headers).toEqual({ Range: "bytes=100000-" });
    expect(fs.readFileSync(modelPath(dir)).equals(data)).toBe(true);
  });

  it("starts over when the server ignores the resume request", async () => {
    fs.writeFileSync(modelPath(dir) + ".part", data.subarray(0, 100_000));
    mockFetch.mockResolvedValueOnce(serve(data, 200));
    await downloadModel(dir, () => {}, new AbortController().signal);
    expect(fs.readFileSync(modelPath(dir)).equals(data)).toBe(true);
  });

  it("deletes a download that fails its checksum", async () => {
    const bad = Buffer.from(data);
    bad[5] ^= 0xff;
    mockFetch.mockResolvedValueOnce(serve(bad));
    await expect(downloadModel(dir, () => {}, new AbortController().signal)).rejects.toThrow(ChecksumMismatch);
    expect(fs.existsSync(modelPath(dir) + ".part")).toBe(false);
    expect(modelReady(dir)).toBe(false);
  });

  it("explains a server error", async () => {
    mockFetch.mockResolvedValueOnce(serve(Buffer.alloc(0), 503));
    const err = await downloadModel(dir, () => {}, new AbortController().signal).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/isn't answering/);
    expect((err as Error).message).not.toMatch(/503/);
    expect((err as Error).cause).toMatch(/503/);
  });

  it("stops when canceled, keeping what it has for next time", async () => {
    const abort = new AbortController();
    abort.abort();
    mockFetch.mockImplementationOnce((_url, init) =>
      init.signal.aborted ? Promise.reject(new DOMException("aborted", "AbortError")) : Promise.resolve(serve(data))
    );
    await expect(downloadModel(dir, () => {}, abort.signal)).rejects.toThrow();
    expect(modelReady(dir)).toBe(false);
  });
});

describe("the two built-in models", () => {
  it("picks the model for each quality, with standard for anything unknown", () => {
    expect(modelFor("standard")).toBe(MODEL);
    expect(modelFor("high")).toBe(MODEL_HIGH);
    expect(modelFor("ultra")).toBe(MODEL);
    expect(modelFor("")).toBe(MODEL);
  });

  it("keeps the standard model pinned as before", () => {
    expect(real.standard).toEqual({
      file: "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
      url: "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/5ab33fa94d1d04e903623ae72c95d1696f09f9e8/Llama-3.2-3B-Instruct-Q4_K_M.gguf",
      bytes: 2_019_377_696,
      sha256: "6c1a2b41161032677be168d354123594c0e6e67d2b9227c84f296ad037c728ff",
      license: "https://www.llama.com/llama3_2/license/",
    });
  });

  it("pins the high quality model to one commit, size and checksum", () => {
    expect(real.high).toEqual({
      file: "Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf",
      url: "https://huggingface.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF/resolve/bf5b95e96dac0462e2a09145ec66cae9a3f12067/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf",
      bytes: 4_920_739_232,
      sha256: "7b064f5842bf9532c91456deda288a1b672397a54fa729aa665952863033557c",
      license: "https://www.llama.com/llama3_1/license/",
    });
    expect(real.high.url).toContain(real.high.file);
  });

  it("says how much disk space each model needs", () => {
    expect(diskNeeded(real.standard)).toBe("about 2.5 GB");
    expect(diskNeeded(real.high)).toBe("about 5.5 GB");
  });

  it("downloads the high quality model to its own file, leaving the standard one alone", async () => {
    mockFetch.mockResolvedValueOnce(serve(data));
    await downloadModel(dir, () => {}, new AbortController().signal);
    mockFetch.mockResolvedValueOnce(serve(highData));
    const totals = new Set<number>();
    await downloadModel(dir, (p) => totals.add(p.total), new AbortController().signal, MODEL_HIGH);
    expect(mockFetch.mock.calls[1][0]).toBe(MODEL_HIGH.url);
    expect([...totals]).toEqual([MODEL_HIGH.bytes]);
    expect(modelPath(dir, MODEL_HIGH)).not.toBe(modelPath(dir, MODEL));
    expect(fs.readFileSync(modelPath(dir, MODEL_HIGH)).equals(highData)).toBe(true);
    expect(modelReady(dir, MODEL_HIGH)).toBe(true);
    expect(modelReady(dir, MODEL)).toBe(true);
  });

  it("isn't ready when only the other model is there", async () => {
    mockFetch.mockResolvedValueOnce(serve(data));
    await downloadModel(dir, () => {}, new AbortController().signal);
    expect(modelReady(dir, MODEL_HIGH)).toBe(false);
  });

  it("resumes the high quality model from its own partial file", async () => {
    fs.writeFileSync(modelPath(dir, MODEL_HIGH) + ".part", highData.subarray(0, 150_000));
    mockFetch.mockResolvedValueOnce(serve(highData.subarray(150_000), 206));
    await downloadModel(dir, () => {}, new AbortController().signal, MODEL_HIGH);
    expect(mockFetch.mock.calls[0][1].headers).toEqual({ Range: "bytes=150000-" });
    expect(fs.readFileSync(modelPath(dir, MODEL_HIGH)).equals(highData)).toBe(true);
  });

  it("deletes a high quality download that fails its checksum", async () => {
    const bad = Buffer.from(highData);
    bad[9] ^= 0xff;
    mockFetch.mockResolvedValueOnce(serve(bad));
    await expect(downloadModel(dir, () => {}, new AbortController().signal, MODEL_HIGH)).rejects.toThrow(ChecksumMismatch);
    expect(fs.existsSync(modelPath(dir, MODEL_HIGH) + ".part")).toBe(false);
    expect(modelReady(dir, MODEL_HIGH)).toBe(false);
  });

  it("names the chosen model's size when the disk is too full", async () => {
    const statfs = jest.spyOn(fs, "statfsSync").mockReturnValue({ bavail: 1, bsize: 1 } as fs.StatsFs);
    try {
      Object.assign(MODEL_HIGH, { bytes: real.high.bytes });
      await expect(downloadModel(dir, () => {}, new AbortController().signal, MODEL_HIGH)).rejects.toThrow(/about 5\.5 GB/);
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      Object.assign(MODEL_HIGH, { bytes: highData.length });
      statfs.mockRestore();
    }
  });
});
