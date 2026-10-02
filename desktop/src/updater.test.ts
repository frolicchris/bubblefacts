import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { newerRelease } from "./checks";
import { assetName, downloadUpdate, expectedSum, macBundle, MAC_SWAP_SCRIPT } from "./updater";

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;
afterEach(() => mockFetch.mockReset());

const body = (bytes: Buffer) => ({
  ok: true,
  status: 200,
  body: (async function* () {
    yield bytes.subarray(0, 3);
    yield bytes.subarray(3);
  })(),
});
const text = (t: string) => ({ ok: true, status: 200, text: async () => t });

describe("assetName", () => {
  it("names the installer each kind of install updates from", () => {
    expect(assetName("2.0.0-beta.5", "darwin", "arm64")).toBe("BubbleFacts-2.0.0-beta.5-mac-arm64.dmg");
    expect(assetName("2.0.0-beta.5", "darwin", "x64")).toBe("BubbleFacts-2.0.0-beta.5-mac-x64.dmg");
    expect(assetName("2.0.0", "win32", "x64")).toBe("BubbleFacts-2.0.0-windows-x64.exe");
    expect(assetName("2.0.0", "linux", "x64", true)).toBe("BubbleFacts-2.0.0-linux-x86_64.AppImage");
  });

  it("leaves a .deb install to the system's own updates", () => {
    expect(assetName("2.0.0", "linux", "x64", false)).toBeNull();
  });
});

describe("expectedSum", () => {
  const sums = `${"a".repeat(64)}  BubbleFacts-2.0.0-mac-arm64.dmg\n${"b".repeat(64)}  bubblefacts.zip\n`;
  it("finds a file's checksum by its exact name", () => {
    expect(expectedSum(sums, "bubblefacts.zip")).toBe("b".repeat(64));
    expect(expectedSum(sums, "BubbleFacts-2.0.0-mac-x64.dmg")).toBeNull();
    expect(expectedSum(sums, "facts.zip")).toBeNull();
  });
});

describe("downloadUpdate", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-update-"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bytes = Buffer.from("the new installer");
  const sum = crypto.createHash("sha256").update(bytes).digest("hex");
  const d = { name: "BubbleFacts-9.9.9-mac-arm64.dmg", url: "https://x/installer", size: bytes.length, sumsUrl: "https://x/sums" };

  it("keeps a download whose checksum the release lists", async () => {
    mockFetch.mockResolvedValueOnce(text(`${sum}  ${d.name}\n`)).mockResolvedValueOnce(body(bytes));
    const progress: number[] = [];
    const file = await downloadUpdate(d, dir, (f) => progress.push(f));
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
    expect(progress[progress.length - 1]).toBe(1);
  });

  it("deletes a download that doesn't match, and says so", async () => {
    mockFetch.mockResolvedValueOnce(text(`${"0".repeat(64)}  ${d.name}\n`)).mockResolvedValueOnce(body(bytes));
    await expect(downloadUpdate(d, dir, () => undefined)).rejects.toThrow(/didn't match/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("reports a disk that can't be written to, and leaves nothing behind", async () => {
    mockFetch.mockResolvedValueOnce(text(`${sum}  ${d.name}\n`)).mockResolvedValueOnce(body(bytes));
    const full = Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    const open = fs.promises.open;
    const spy = jest.spyOn(fs.promises, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      handle.writeFile = () => Promise.reject(full);
      return handle;
    });
    await expect(downloadUpdate(d, dir, () => undefined)).rejects.toThrow(/free disk space/);
    spy.mockRestore();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("refuses when the release lists no checksum for the file", async () => {
    mockFetch.mockResolvedValueOnce(text(`${sum}  something-else.dmg\n`));
    await expect(downloadUpdate(d, dir, () => undefined)).rejects.toThrow(/no checksum/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("macBundle", () => {
  it("only updates a normal install, never one opened from the disk image", () => {
    expect(macBundle("/Volumes/BubbleFacts/BubbleFacts.app/Contents/MacOS/BubbleFacts")).toBeNull();
    expect(macBundle("/private/var/folders/x/AppTranslocation/ABC/d/BubbleFacts.app/Contents/MacOS/BubbleFacts")).toBeNull();
    expect(macBundle("/usr/local/bin/node")).toBeNull();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bf-app-"));
    const bundle = path.join(home, "BubbleFacts.app");
    fs.mkdirSync(path.join(bundle, "Contents/MacOS"), { recursive: true });
    expect(macBundle(path.join(bundle, "Contents/MacOS/BubbleFacts"))).toBe(bundle);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("checks the disk image holds BubbleFacts, and puts the old app back if the swap fails", () => {
    expect(MAC_SWAP_SCRIPT).toContain('[ "$ID" = "org.frolic.bubblefacts" ]');
    expect(MAC_SWAP_SCRIPT).toContain('mv "$OLD" "$APP"');
  });
});

describe("newerRelease with an installer", () => {
  const release = (assets: Array<[string, string]>) => ({
    ok: true,
    json: async () => [{ tag_name: "v2.0.0-beta.5", draft: false, prerelease: true, assets: assets.map(([name, url]) => ({ name, browser_download_url: url, size: 10 })) }],
  });
  const base = "https://github.com/frolicchris/bubblefacts/releases/download/v2.0.0-beta.5/";
  const pick = (v: string) => assetName(v, "darwin", "arm64");

  it("offers the installer for this computer, with the checksum list", async () => {
    mockFetch.mockResolvedValueOnce(release([["BubbleFacts-2.0.0-beta.5-mac-arm64.dmg", `${base}a.dmg`], ["SHA256SUMS.txt", `${base}SHA256SUMS.txt`]]));
    const r = await newerRelease("2.0.0-beta.4", pick);
    expect(r?.download).toEqual({ name: "BubbleFacts-2.0.0-beta.5-mac-arm64.dmg", url: `${base}a.dmg`, size: 10, sumsUrl: `${base}SHA256SUMS.txt` });
  });

  it("falls back to the download page without a checksum list, or for a file from anywhere else", async () => {
    mockFetch.mockResolvedValueOnce(release([["BubbleFacts-2.0.0-beta.5-mac-arm64.dmg", `${base}a.dmg`]]));
    expect((await newerRelease("2.0.0-beta.4", pick))?.download).toBeUndefined();
    mockFetch.mockResolvedValueOnce(release([["BubbleFacts-2.0.0-beta.5-mac-arm64.dmg", "https://evil.example/a.dmg"], ["SHA256SUMS.txt", `${base}SHA256SUMS.txt`]]));
    const r = await newerRelease("2.0.0-beta.4", pick);
    expect(r).toMatchObject({ version: "2.0.0-beta.5" });
    expect(r?.download).toBeUndefined();
  });
});
