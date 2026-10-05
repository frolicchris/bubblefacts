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

  // The swap script is bash, run by macOS: there's no /bin/bash to run it with on Windows.
  (process.platform === "win32" ? describe.skip : describe)("when the disk image won't open (a tester's update, canceled half a second in)", () => {
    // The script, run for real, with stand-ins for the macOS tools it calls.
    let dir: string;
    const run = (hdiutilFails: number, interrupt = false) => {
      const bin = path.join(dir, "bin");
      fs.mkdirSync(bin, { recursive: true });
      const stub = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
      // hdiutil fails its first `hdiutilFails` attaches; every call is recorded.
      // With `interrupt`, its first attach also sends the script the signals that could end it partway.
      const signal = interrupt ? `[ "$n" = 1 ] && kill -TERM $PPID && kill -INT $PPID && kill -HUP $PPID;` : "";
      stub("hdiutil", `echo "hdiutil $1" >> "${dir}/calls"; [ "$1" = attach ] || exit 0; n=$(grep -c "hdiutil attach" "${dir}/calls"); ${signal} [ "$n" -gt ${hdiutilFails} ]`);
      stub("diskutil", `echo "diskutil $1 $2" >> "${dir}/calls"; exit 1`);
      stub("open", `echo "open $1" >> "${dir}/calls"`);
      stub("ditto", "exit 1");
      const script = path.join(dir, "swap.sh");
      fs.writeFileSync(script, MAC_SWAP_SCRIPT, { mode: 0o700 });
      const app = path.join(dir, "BubbleFacts.app");
      fs.mkdirSync(app, { recursive: true });
      // 999999: a process id that isn't running, so the script doesn't wait.
      require("child_process").execFileSync("/bin/bash", [script, "999999", path.join(dir, "u.dmg"), app, path.join(dir, "log")], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BF_RETRY_DELAY: "0" },
      });
      return { calls: fs.readFileSync(path.join(dir, "calls"), "utf8"), log: fs.readFileSync(path.join(dir, "log"), "utf8"), app };
    };
    beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-swap-"))));
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it("tries three times, with diskutil as a second choice, then reopens the old app", () => {
      let err: unknown = null;
      let out = { calls: "", log: "", app: "" };
      try {
        out = run(99);
      } catch (e) {
        err = e;
        out = { calls: fs.readFileSync(path.join(dir, "calls"), "utf8"), log: fs.readFileSync(path.join(dir, "log"), "utf8"), app: path.join(dir, "BubbleFacts.app") };
      }
      expect(err).not.toBeNull(); // exit 1
      expect(out.calls.match(/hdiutil attach/g)).toHaveLength(3);
      expect(out.calls.match(/diskutil image attach/g)).toHaveLength(3);
      expect(out.log).toContain("could not open the disk image (try 3 of 3)");
      expect(out.calls).toContain(`open ${out.app}`);
      expect(fs.existsSync(out.app)).toBe(true);
    });

    it("carries on when a later try opens it", () => {
      let out = { calls: "", log: "" };
      try {
        out = run(2);
      } catch {
        out = { calls: fs.readFileSync(path.join(dir, "calls"), "utf8"), log: fs.readFileSync(path.join(dir, "log"), "utf8") };
      }
      expect(out.calls.match(/hdiutil attach/g)).toHaveLength(3);
      expect(out.log).toContain("try 2 of 3");
      expect(out.log).not.toContain("try 3 of 3");
      // The stand-in image holds no app, so the check after opening it stops the swap, and the app reopens.
      expect(out.log).toContain("not BubbleFacts");
      expect(out.calls).toMatch(/open .*BubbleFacts\.app/);
    });

    it("isn't stopped by an interrupt while it works, and still reopens the app", () => {
      try {
        run(99, true);
      } catch {
        // exit 1: the image never opened
      }
      const calls = fs.readFileSync(path.join(dir, "calls"), "utf8");
      expect(calls.match(/hdiutil attach/g)).toHaveLength(3);
      expect(calls).toContain(`open ${path.join(dir, "BubbleFacts.app")}`);
    });
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
    const r = await newerRelease("2.0.0-beta.4", "beta", pick);
    expect(r?.download).toEqual({ name: "BubbleFacts-2.0.0-beta.5-mac-arm64.dmg", url: `${base}a.dmg`, size: 10, sumsUrl: `${base}SHA256SUMS.txt` });
  });

  it("falls back to the download page without a checksum list, or for a file from anywhere else", async () => {
    mockFetch.mockResolvedValueOnce(release([["BubbleFacts-2.0.0-beta.5-mac-arm64.dmg", `${base}a.dmg`]]));
    expect((await newerRelease("2.0.0-beta.4", "beta", pick))?.download).toBeUndefined();
    mockFetch.mockResolvedValueOnce(release([["BubbleFacts-2.0.0-beta.5-mac-arm64.dmg", "https://evil.example/a.dmg"], ["SHA256SUMS.txt", `${base}SHA256SUMS.txt`]]));
    const r = await newerRelease("2.0.0-beta.4", "beta", pick);
    expect(r).toMatchObject({ version: "2.0.0-beta.5" });
    expect(r?.download).toBeUndefined();
  });
});
