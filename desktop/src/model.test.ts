import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { ChecksumMismatch, downloadModel, MODEL, modelPath, modelReady, Progress } from "./model";

// A small stand-in for the 2 GB file.
const data = crypto.randomBytes(300_000);
Object.assign(MODEL, { bytes: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex") });

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
