import fs from "fs";
import os from "os";
import path from "path";
import { isStoreApp, loginItemSettings, storeDataFolder, STORE_UPDATES_LINE } from "./store-app";
import { assetName, startInstall } from "./updater";

describe("a Store app", () => {
  it("is false by default, and for anything but a packaged Store app", () => {
    expect(isStoreApp()).toBe(false);
    expect(isStoreApp({})).toBe(false);
    expect(isStoreApp({ windowsStore: false })).toBe(false);
    expect(isStoreApp({ windowsStore: true })).toBe(true);
  });

  it("keeps its data in the BubbleFacts folder in Documents", () => {
    const docs = path.join("C:", "Users", "jane", "Documents");
    expect(storeDataFolder(docs)).toBe(path.join(docs, "BubbleFacts"));
  });

  it("leaves the login items alone, and sets them as before everywhere else", () => {
    expect(loginItemSettings(true, true)).toBeNull();
    expect(loginItemSettings(false, true)).toBeNull();
    expect(loginItemSettings(true, false)).toEqual({ openAtLogin: true, args: ["--hidden"] });
    expect(loginItemSettings(false, false)).toEqual({ openAtLogin: false, args: ["--hidden"] });
  });

  it("never launches an installer", () => {
    const original = Object.getOwnPropertyDescriptor(process, "windowsStore");
    Object.defineProperty(process, "windowsStore", { value: true, configurable: true });
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-store-"));
      const result = startInstall(path.join(dir, "BubbleFacts-9.9.9-windows-x64.exe"), { pid: 1, logFile: path.join(dir, "update.log"), scriptDir: dir });
      expect(result).toEqual({ started: false, reason: STORE_UPDATES_LINE });
      expect(fs.readdirSync(dir)).toEqual([]);
      fs.rmSync(dir, { recursive: true, force: true });
    } finally {
      if (original) Object.defineProperty(process, "windowsStore", original);
      else delete (process as { windowsStore?: boolean }).windowsStore;
    }
  });
});

describe("the in-app updater's file picker", () => {
  it("can never pick a Store package", () => {
    for (const platform of ["win32", "darwin", "linux"] as const) {
      for (const edition of ["full", "lite"] as const) {
        expect(assetNameFor(platform, edition)).not.toMatch(/\.(msix|appx)$/);
      }
    }
  });
});

function assetNameFor(platform: NodeJS.Platform, edition: "full" | "lite"): string {
  return assetName("2.2.1", platform, "x64", true, edition) ?? "";
}

// main.ts can't be loaded in a test (it needs Electron), so its order of steps is checked in the source.
describe("main.ts for a Store app", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.ts"), "utf8");

  it("moves the data folder before the single-instance lock and before anything reads it", () => {
    const move = main.indexOf('app.setPath("userData"');
    expect(move).toBeGreaterThan(0);
    expect(main.indexOf('app.setPath("sessionData"')).toBeLessThan(move);
    expect(move).toBeLessThan(main.indexOf("app.requestSingleInstanceLock()"));
    expect(move).toBeLessThan(main.indexOf('app.getPath("userData")'));
  });

  it("skips the update check and the app identity", () => {
    const check = main.indexOf("async function checkForUpdate()");
    expect(main.slice(check, check + 200)).toContain("if (isStoreApp()) return;");
    expect(main).toContain('if (!isStoreApp()) app.setAppUserModelId(');
  });
});
