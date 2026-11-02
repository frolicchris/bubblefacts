import path from "path";
import { MODEL, MODEL_HIGH } from "./model";
import { Conditions, isObsProcess, obsInProcessList, PrepareDriver, prepareEnv, registerPreparing, waitReason } from "./preparing";

describe("prepareEnv (issue #296)", () => {
  const all = () => true;
  it("has the Standard model prepare the first pass when High quality is chosen and Standard is downloaded", () => {
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
    // Nothing was running, but a stop is cheap and makes sure.
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
