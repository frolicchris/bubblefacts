jest.mock("electron", () => ({ app: { getPath: () => "/tmp" }, safeStorage: { isEncryptionAvailable: () => false } }));

import { WrongKeyListener } from "./handsfree";
import { DEFAULTS, fromWindow, sanitize } from "./settings";
import { makeBackup, readBackup } from "./backup";

/** A stand-in for Electron's globalShortcut; `taken` are keys another app already has. */
function fakeShortcuts(taken: string[] = []) {
  const held = new Map<string, () => void>();
  return {
    held,
    register: (key: string, fn: () => void) => {
      if (taken.includes(key) || held.has(key)) return false;
      held.set(key, fn);
      return true;
    },
    unregister: (key: string) => void held.delete(key),
  };
}

describe("hands-free Wrong, the setting", () => {
  it("is off unless the musician turns it on", () => {
    expect(DEFAULTS.wrongKey).toBe("off");
  });

  it("only takes one of the offered keys from the window", () => {
    expect(fromWindow({ wrongKey: "f13" })).toEqual({ wrongKey: "f13" });
    expect(fromWindow({ wrongKey: 13 })).toEqual({});
    expect(sanitize({ ...DEFAULTS, wrongKey: "Alt+F4" as never }).wrongKey).toBe("off");
    expect(sanitize({ ...DEFAULTS, wrongKey: "ctrl-alt-w" }).wrongKey).toBe("ctrl-alt-w");
  });

  it("goes along in a backup and comes back from one", () => {
    const backup = makeBackup({ ...DEFAULTS, wrongKey: "ctrl-alt-shift-w" }, { songFacts: null, wrongFacts: null }, "2.0.0");
    expect(readBackup(JSON.stringify(backup)).settings.wrongKey).toBe("ctrl-alt-shift-w");
  });
});

describe("hands-free Wrong, the key", () => {
  it("listens for nothing while off", () => {
    const shortcuts = fakeShortcuts();
    expect(new WrongKeyListener(shortcuts, () => {}).use("off")).toBe("");
    expect(shortcuts.held.size).toBe(0);
  });

  it("listens for the chosen key and calls back when it's pressed", () => {
    const shortcuts = fakeShortcuts();
    const pressed = jest.fn();
    new WrongKeyListener(shortcuts, pressed).use("ctrl-alt-w");
    shortcuts.held.get("Control+Alt+W")!();
    expect(pressed).toHaveBeenCalledTimes(1);
  });

  it("lets go of the old key when another is chosen, and of any when turned off", () => {
    const shortcuts = fakeShortcuts();
    const listener = new WrongKeyListener(shortcuts, () => {});
    listener.use("ctrl-alt-w");
    listener.use("f13");
    expect([...shortcuts.held.keys()]).toEqual(["F13"]);
    listener.use("off");
    expect(shortcuts.held.size).toBe(0);
  });

  it("says so plainly when another app has the key, and tries again on the next save", () => {
    const taken = ["F13"];
    const shortcuts = fakeShortcuts(taken);
    const listener = new WrongKeyListener(shortcuts, () => {});
    expect(listener.use("f13")).toMatch(/Another app is already using that key/);
    expect(listener.problem).not.toBe("");
    taken.length = 0;
    expect(listener.use("f13")).toBe("");
    expect(shortcuts.held.has("F13")).toBe(true);
  });

  it("treats a key Electron refuses outright like a taken one", () => {
    const listener = new WrongKeyListener({ register: () => { throw new Error("bad"); }, unregister: () => {} }, () => {});
    expect(listener.use("ctrl-alt-w")).not.toBe("");
  });
});

describe("hands-free Wrong, a held or bouncing pedal", () => {
  it("counts presses close together once", () => {
    const keys = fakeShortcuts();
    let presses = 0;
    let t = 10_000;
    const listener = new WrongKeyListener(keys, () => presses++, () => t);
    listener.use("f13");
    const press = [...keys.held.values()][0];
    press();
    t += 200;
    press();
    t += 1000;
    press();
    expect(presses).toBe(1);
    t += 2000;
    press();
    expect(presses).toBe(2);
  });
});
