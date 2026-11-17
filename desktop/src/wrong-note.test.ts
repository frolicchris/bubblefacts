import fs from "fs";
import path from "path";

/* The window's script (desktop/renderer/app.js) run with a stand-in page: enough to press its
   buttons and send it what the app sends, without a browser (#430). */

type Handler = (...args: unknown[]) => unknown;

/** Anything the script reads off the page: takes any call, holds what is set on it, and loops over as empty */
function standIn(own: Record<string | symbol, unknown> = {}): any {
  return new Proxy(function () {}, {
    get(_t, key) {
      if (key in own) return own[key];
      if (key === "then") return undefined;
      if (key === Symbol.iterator) return function* () {};
      if (key === Symbol.toPrimitive) return () => "";
      return (own[key] = standIn());
    },
    set(_t, key, value) {
      own[key] = value;
      return true;
    },
    apply: () => standIn(),
  });
}

function openWindow(appState: Record<string, unknown>) {
  const elements = new Map<string, any>();
  const clicks = new Map<string, Handler>();
  const element = (sel: string) => {
    if (!elements.has(sel)) {
      elements.set(
        sel,
        standIn({
          hidden: true,
          textContent: "",
          value: "",
          addEventListener: (type: string, fn: Handler) => {
            if (type === "click") clicks.set(sel, fn);
          },
        })
      );
    }
    return elements.get(sel);
  };
  const fromApp = new Map<string, Handler>();
  const calls: Record<string, unknown[][]> = {};
  const answers: Record<string, unknown> = {
    getState: appState,
    recent: { facts: [], earlier: [], ready: true },
    unwrongFact: { restored: true },
  };
  const api = new Proxy(
    {},
    {
      get(_t, name: string) {
        if (name === "on") return (channel: string, fn: Handler) => fromApp.set(channel, fn);
        return (...args: unknown[]) => {
          (calls[name] ||= []).push(args);
          return Promise.resolve(name in answers ? answers[name] : {});
        };
      },
    }
  );
  const document = standIn({
    querySelector: (sel: string) => element(sel),
    getElementById: (id: string) => element("#" + id),
    querySelectorAll: () => [],
    addEventListener: () => undefined,
  });
  const window = standIn({ bubbleFacts: api, requestAnimationFrame: () => 0 });
  const code = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
  new Function("window", "document", "setInterval", "setTimeout", code)(window, document, () => 0, () => 0);
  const settle = () => new Promise((done) => setImmediate(done));
  return {
    calls,
    element,
    settle,
    /** What the app sends the window */
    send: async (channel: string, payload: unknown) => {
      await fromApp.get(channel)!(payload);
      await settle();
    },
    click: async (sel: string) => {
      await clicks.get(sel)!();
      await settle();
    },
  };
}

const appState = () => ({
  version: "0.0.0",
  versionLabel: "0.0.0",
  paused: false,
  unlocking: false,
  status: { lights: [] },
  notices: [],
  settings: { setupComplete: true },
});
const song = { title: "Test Song", artist: "Test Band" };
const marked = { removed: true, live: true, text: "A made-up fact.", article: "Test Song (song)", song };

describe("the Wrong note's Undo and Report it", () => {
  it("work right after hands-free Wrong", async () => {
    const win = openWindow(appState());
    await win.settle();
    await win.send("wrong-key", marked);
    expect(win.element("#wrong-note").hidden).toBe(false);
    expect(win.element("#wrong-report").hidden).toBe(false);
    await win.click("#wrong-undo");
    expect(win.calls.unwrongFact).toEqual([["Test Song (song)", song]]);
  });

  it("still work after the app refreshes the window (#430)", async () => {
    const win = openWindow(appState());
    await win.settle();
    await win.send("wrong-key", marked);
    // Pausing, a status change, an update check and connecting Twitch all send a whole new state
    await win.send("state", { ...appState(), paused: true });
    await win.click("#wrong-report");
    expect(win.calls.reportFact).toEqual([["Test Song — Test Band", "A made-up fact."]]);
    await win.click("#wrong-undo");
    expect(win.calls.unwrongFact).toEqual([["Test Song (song)", song]]);
    expect(win.element("#wrong-note-text").textContent).toMatch(/^Undone\./);
  });

  it("offers neither when hands-free Wrong marked nothing", async () => {
    const win = openWindow(appState());
    await win.settle();
    await win.send("wrong-key", marked);
    await win.send("wrong-key", { removed: false, reason: "no-song" });
    expect(win.element("#wrong-undo").hidden).toBe(true);
    expect(win.element("#wrong-report").hidden).toBe(true);
    await win.click("#wrong-report");
    expect(win.calls.reportFact).toBeUndefined();
  });
});
