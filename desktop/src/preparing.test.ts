import fs from "fs";
import os from "os";
import path from "path";
import { MODEL, MODEL_HIGH } from "./model";
import { batteryFromPmset, batteryFromSysfs, batteryFromWin32, Conditions, linuxOnBattery, reusedFor, systemOnBattery, isObsProcess, obsInProcessList, PrepareDriver, prepareEnv, registerPreparing, waitReason } from "./preparing";

describe("prepareEnv (issue #296)", () => {
  const all = () => true;
  it("has the Standard model prepare the first pass when Larger AI is chosen and Standard is downloaded", () => {
    expect(prepareEnv({ ai: "builtin", aiQuality: "high" }, "/models", all)).toEqual({ PREPARE_MODEL_PATH: path.join("/models", MODEL.file) });
  });

  it("adds nothing with Standard chosen, without the Standard model, or with another AI", () => {
    expect(prepareEnv({ ai: "builtin", aiQuality: "standard" }, "/models", all)).toEqual({});
    expect(prepareEnv({ ai: "builtin", aiQuality: "high" }, "/models", (m) => m === MODEL_HIGH)).toEqual({});
    expect(prepareEnv({ ai: "ollama", aiQuality: "high" }, "/models", all)).toEqual({});
  });
});

describe("telling OBS is open (issue #295)", () => {
  it("knows OBS's own program on Windows, a Mac and Linux, and nothing else", () => {
    for (const name of ["obs64.exe", "OBS64.EXE", "obs32.exe", "/Applications/OBS.app/Contents/MacOS/OBS", "obs", "/usr/bin/obs", "C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe"]) {
      expect(isObsProcess(name)).toBe(true);
    }
    for (const name of ["obs-browser-page.exe", "obs-ffmpeg-mux", "jobs", "robsapp", "notepad.exe", ""]) expect(isObsProcess(name)).toBe(false);
  });

  it("reads Windows' tasklist and ps", () => {
    expect(obsInProcessList('"explorer.exe","1200","Console","1","90,000 K"\r\n"obs64.exe","5120","Console","1","300,000 K"\r\n')).toBe(true);
    expect(obsInProcessList('"explorer.exe","1200","Console","1","90,000 K"\r\n')).toBe(false);
    expect(obsInProcessList("/sbin/launchd\n/Applications/OBS.app/Contents/MacOS/OBS\n")).toBe(true);
    expect(obsInProcessList("bash\nobs-browser-page\n")).toBe(false);
  });
});

const free: Conditions = { enabled: true, setupDone: true, ai: "local", serverUp: true, onBattery: false, overlays: 0 };

describe("waitReason (issue #295)", () => {
  it("waits while it's off, there's no AI on this computer, the server is down, on battery, or an overlay is connected", () => {
    expect(waitReason(free)).toBe("");
    expect(waitReason({ ...free, enabled: false })).toBe("off");
    expect(waitReason({ ...free, setupDone: false })).toBe("setup");
    expect(waitReason({ ...free, ai: "online" })).toBe("online-ai");
    expect(waitReason({ ...free, ai: "none" })).toBe("no-ai");
    expect(waitReason({ ...free, serverUp: false })).toBe("server");
    expect(waitReason({ ...free, onBattery: true })).toBe("battery");
    expect(waitReason({ ...free, overlays: 1 })).toBe("overlay");
  });
});

describe("PrepareDriver (issue #295)", () => {
  function driver(state: { conditions: Conditions; obs: boolean }, now = () => 0) {
    const calls: unknown[] = [];
    const obsChecks = jest.fn(async () => state.obs);
    const d = new PrepareDriver({
      conditions: () => state.conditions,
      obsRunning: obsChecks,
      control: async (_p, body) => {
        calls.push(body);
        return { running: (body as { run: boolean }).run };
      },
      now,
    });
    return { d, calls, obsChecks };
  }

  it("starts preparing when the computer is free, and stops on the next tick once OBS opens", async () => {
    const state = { conditions: free, obs: false };
    const { d, calls } = driver(state);
    await d.tick();
    expect(calls).toEqual([{ run: true }]);
    await d.tick();
    expect(calls).toHaveLength(1);
    state.obs = true;
    await d.tick();
    expect(calls).toEqual([{ run: true }, { run: false }]);
    expect(d.reason).toBe("obs");
  });

  it("reads macOS's own answer on battery, from pmset -g batt", () => {
    expect(batteryFromPmset("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t62%; discharging; (no estimate) present: true\n")).toBe(true);
    expect(batteryFromPmset("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t60%; charging; 1:29 remaining present: true\n")).toBe(false);
    // A desktop Mac has no battery line at all
    expect(batteryFromPmset("Now drawing from 'AC Power'\n")).toBe(false);
    expect(batteryFromPmset("Now drawing from 'UPS Power'\n")).toBe(false);
    expect(batteryFromPmset("")).toBeNull();
  });

  it("reads Windows' own answer on battery, from Win32_Battery's BatteryStatus", () => {
    expect(batteryFromWin32("1\r\n")).toBe(true);
    expect(batteryFromWin32("2\r\n")).toBe(false);
    expect(batteryFromWin32("6")).toBe(false);
    expect(batteryFromWin32("2,1")).toBe(true);
    // A desktop has no battery
    expect(batteryFromWin32("\r\n")).toBe(false);
    expect(batteryFromWin32("Get-CimInstance : Access denied")).toBeNull();
  });

  it("reads Linux's own answer on battery, from /sys/class/power_supply", async () => {
    const plugged = [{ type: "Mains", online: "1" }, { type: "Battery", status: "Charging" }];
    const unplugged = [{ type: "Mains", online: "0" }, { type: "Battery", status: "Discharging" }];
    expect(batteryFromSysfs(plugged)).toBe(false);
    expect(batteryFromSysfs(unplugged)).toBe(true);
    // Charger out, battery status unhelpful: on battery
    expect(batteryFromSysfs([{ type: "Mains", online: "0" }, { type: "Battery", status: "Unknown" }])).toBe(true);
    // USB-C charging
    expect(batteryFromSysfs([{ type: "USB", online: "1" }, { type: "Battery", status: "Not charging" }])).toBe(false);
    // A desktop, or a virtual machine
    expect(batteryFromSysfs([])).toBe(false);
    expect(batteryFromSysfs([{ type: "Mains", online: "1" }])).toBe(false);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bubblefacts-power-"));
    for (const [name, files] of Object.entries({ AC: { type: "Mains", online: "0" }, BAT0: { type: "Battery", status: "Discharging" } })) {
      fs.mkdirSync(path.join(root, name));
      for (const [file, value] of Object.entries(files)) fs.writeFileSync(path.join(root, name, file), `${value}\n`);
    }
    await expect(linuxOnBattery(root)).resolves.toBe(true);
    await expect(linuxOnBattery(path.join(root, "missing"))).resolves.toBe(false);
  });

  it("reuses a slow check's answer for a while, and asks again after a failure", async () => {
    let clock = 0;
    let asked = 0;
    let fail = false;
    const check = reusedFor(10_000, async () => {
      asked++;
      if (fail) throw new Error("no answer");
      return true;
    }, () => clock);
    await check();
    clock = 9_000;
    await check();
    expect(asked).toBe(1);
    clock = 10_000;
    fail = true;
    await expect(check()).rejects.toThrow();
    fail = false;
    await expect(check()).resolves.toBe(true);
    expect(asked).toBe(3);
  });

  // Runs this system's real check: CI does this on macOS, Windows and Linux
  it("gets an answer from this computer's own system", async () => {
    const own = systemOnBattery();
    if (!own) return;
    await expect(own()).resolves.toEqual(expect.any(Boolean));
  }, 30_000); // Windows PowerShell can take well over 10 s on a busy runner beside the other test workers

  it("stops on battery when the system says so, though the app's own check says plugged in", async () => {
    let battery = false;
    const calls: unknown[] = [];
    const d = new PrepareDriver({
      conditions: () => free,
      obsRunning: async () => false,
      onBattery: async () => battery,
      control: async (_p, body) => (calls.push(body), { running: (body as { run: boolean }).run }),
    });
    await d.tick();
    expect(calls).toEqual([{ run: true }]);
    battery = true;
    await d.tick();
    expect(d.reason).toBe("battery");
    expect(calls).toEqual([{ run: true }, { run: false }]);
    // Said before an overlay, as the app's own check does
    const withOverlay = new PrepareDriver({ conditions: () => ({ ...free, overlays: 1 }), obsRunning: async () => false, onBattery: async () => true, control: async () => ({ running: false }) });
    await withOverlay.tick();
    expect(withOverlay.reason).toBe("battery");
  });

  it("waits when the system can't say whether it's on battery", async () => {
    const d = new PrepareDriver({ conditions: () => free, obsRunning: async () => false, onBattery: async () => Promise.reject(new Error("pmset failed")), control: async () => ({ running: false }) });
    await d.tick();
    expect(d.reason).toBe("power-unknown");
  });

  it("waits when the process list fails, instead of taking that for OBS being closed", async () => {
    const state = { conditions: free, obs: false };
    const { d, calls, obsChecks } = driver(state);
    await d.tick();
    expect(calls).toEqual([{ run: true }]);
    obsChecks.mockRejectedValueOnce(new Error("ps timed out"));
    await d.tick();
    expect(calls).toEqual([{ run: true }, { run: false }]);
    expect(d.reason).toBe("obs-unknown");
    // The next good check frees it again
    await d.tick();
    expect(d.reason).toBe("");
    expect(calls).toEqual([{ run: true }, { run: false }, { run: true }]);
  });

  it("stops when the computer goes on battery or an overlay connects, and never reads the process list then", async () => {
    const state = { conditions: free, obs: false };
    const { d, calls, obsChecks } = driver(state);
    await d.tick();
    obsChecks.mockClear();
    state.conditions = { ...free, onBattery: true };
    await d.tick();
    expect(calls.at(-1)).toEqual({ run: false });
    expect(obsChecks).not.toHaveBeenCalled();
    state.conditions = { ...free, overlays: 2 };
    await d.tick();
    expect(d.reason).toBe("overlay");
  });

  it("never starts while it's turned off, and stops once turned off", async () => {
    const state = { conditions: { ...free, enabled: false }, obs: false };
    const { d, calls } = driver(state);
    await d.tick();
    // Nothing was running, but a stop is cheap and makes sure
    expect(calls).toEqual([{ run: false }]);
    await d.tick();
    expect(calls).toHaveLength(1);
    state.conditions = free;
    await d.tick();
    state.conditions = { ...free, enabled: false };
    await d.tick();
    expect(calls).toEqual([{ run: false }, { run: true }, { run: false }]);
  });

  it("asks again now and then, so a run that finished picks up songs added since", async () => {
    let clock = 0;
    const { d, calls } = driver({ conditions: free, obs: false }, () => clock);
    await d.tick();
    clock += 9 * 60_000;
    await d.tick();
    expect(calls).toHaveLength(1);
    clock += 2 * 60_000;
    await d.tick();
    expect(calls).toHaveLength(2);
  });

  it("asks a server that started over at once, rather than waiting its usual while", async () => {
    const { d, calls } = driver({ conditions: free, obs: false });
    await d.tick();
    await d.tick();
    expect(calls).toHaveLength(1);
    d.serverRestarted();
    await d.tick();
    expect(calls).toEqual([{ run: true }, { run: true }]);
  });

  it("asks again when the server didn't answer", async () => {
    let answer: Record<string, unknown> | null = null;
    const calls: unknown[] = [];
    const d = new PrepareDriver({ conditions: () => free, obsRunning: async () => false, control: async (_p, body) => (calls.push(body), answer) });
    await d.tick();
    answer = { running: true };
    await d.tick();
    expect(calls).toEqual([{ run: true }, { run: true }]);
  });
});

describe("registerPreparing", () => {
  it("registers its window message through the handle() it's given", async () => {
    const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
    const control = jest.fn(async () => ({ running: false }));
    registerPreparing({ handle: (c, l) => void handlers.set(c, l), control, conditions: () => free });
    expect([...handlers.keys()]).toEqual(["prepare-status"]);
    expect(await handlers.get("prepare-status")!(null)).toEqual({ waiting: "off", server: { running: false } });
  });
});
