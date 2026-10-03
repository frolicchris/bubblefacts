import fs from "fs";
import path from "path";
import vm from "vm";

/**
 * The overlay is a plain script OBS loads in a Browser source. Run it with a
 * stand-in page and record where it tries to connect.
 */
const SCRIPT = fs.readFileSync(path.resolve(__dirname, "../../frontend/obs/obs-overlay.js"), "utf8");

function connectionsFrom(href: string, failFirst = 0): string[] {
  const url = new URL(href);
  const urls: string[] = [];
  const timers: Array<() => void> = [];
  const element = () => ({ classList: { add() {}, remove() {} }, appendChild() {}, append() {}, style: {} });
  class FakeSocket {
    onopen?: () => void;
    onclose?: () => void;
    onerror?: () => void;
    onmessage?: () => void;
    constructor(target: string) {
      urls.push(target);
      // Refuse the first few, like ports nothing listens on.
      if (urls.length <= failFirst) timers.push(() => this.onclose?.());
    }
    close() {}
  }
  vm.runInNewContext(SCRIPT, {
    location: { href, protocol: url.protocol, hostname: url.hostname, host: url.host, search: url.search },
    document: { getElementById: element, createElement: element, body: element() },
    WebSocket: FakeSocket,
    setTimeout: (fn: () => void) => timers.push(fn),
    clearTimeout: () => {},
    console,
  });
  while (timers.length && urls.length < 20) timers.shift()!();
  return urls;
}

describe("where the overlay connects", () => {
  it("reaches the app's server when OBS loads it as a Local file", () => {
    // OBS serves local files from http://absolute/<path>, never file://.
    const urls = connectionsFrom("http://absolute/Users/jane/Library/Application%20Support/BubbleFacts/overlay/BubbleFacts.html");
    expect(urls[0]).toBe("ws://127.0.0.1:3000/ws");
  });

  it("does the same when a browser opens the file directly", () => {
    expect(connectionsFrom("file:///Users/jane/BubbleFacts.html")[0]).toBe("ws://127.0.0.1:3000/ws");
  });

  it("follows the server when the app had to move to another port", () => {
    const urls = connectionsFrom("http://absolute/Users/jane/BubbleFacts.html", 2);
    expect(urls.slice(0, 3)).toEqual(["ws://127.0.0.1:3000/ws", "ws://127.0.0.1:3001/ws", "ws://127.0.0.1:3002/ws"]);
  });

  it("uses the page's own server when loaded from a URL", () => {
    expect(connectionsFrom("http://127.0.0.1:3005/obs/obs-overlay.html")[0]).toBe("ws://127.0.0.1:3005/ws");
  });
});

/** Runs the overlay against a fake page and returns the texts of bubbles it shows. */
function overlay() {
  const shown: string[] = [];
  const hidden: string[] = [];
  const timers: Array<() => void> = [];
  let socket: { onmessage?: (e: { data: string }) => void; onopen?: () => void } = {};
  const element = () => {
    const el: Record<string, unknown> = {
      classList: { add(c: string) { if (c === "hiding") hidden.push(String(el.text)); }, remove() {} },
      dataset: {},
      style: { setProperty() {} },
      appendChild() {},
      append(t: unknown) { if (typeof t === "string") { el.text = t; shown.push(t); } },
      addEventListener() {},
      remove() {},
      offsetWidth: 0,
    };
    return el;
  };
  class FakeSocket {
    constructor() { socket = this as typeof socket; }
    close() {}
  }
  vm.runInNewContext(SCRIPT, {
    location: { href: "http://absolute/x.html", protocol: "http:", hostname: "absolute", host: "absolute", search: "" },
    document: { getElementById: element, createElement: element, body: element() },
    WebSocket: FakeSocket,
    setTimeout: (fn: () => void) => timers.push(fn),
    clearTimeout: () => {},
    requestAnimationFrame: (fn: () => void) => fn(),
    console,
  });
  const song = { title: "Lost Boy", artist: "The Midnight" };
  const fact = (text: string, position: object = { top: "0%", left: "0%" }) => ({ text, delaySeconds: 0, durationSeconds: 5, position });
  const send = (msg: object) => socket.onmessage?.({ data: JSON.stringify(msg) });
  const run = () => { while (timers.length) timers.shift()!(); };
  /** Fires only the timers already waiting: each fact's turn, in order, before any bubble's own time runs out. */
  const step = (n: number) => timers.splice(0, n).forEach((fn) => fn());
  socket.onopen?.();
  send({ type: "new_song", song });
  // The Now Playing banner's timers: out of the way, so `step` reaches the bubbles.
  run();
  return { shown, hidden, send, run, step, song, fact };
}

describe("taking a fact off the stream", () => {
  it("never shows a fact marked wrong before its turn", () => {
    const o = overlay();
    o.send({ type: "facts_ready", song: o.song, facts: [o.fact("Right."), o.fact("Wrong.")] });
    o.send({ type: "remove_fact", song: o.song, text: "Wrong." });
    o.run();
    expect(o.shown).toContain("Right.");
    expect(o.shown).not.toContain("Wrong.");
  });

  it("stays removed when the batch is sent again", () => {
    const o = overlay();
    o.send({ type: "facts_ready", song: o.song, facts: [o.fact("Wrong.")] });
    o.send({ type: "remove_fact", song: o.song, text: "Wrong." });
    o.send({ type: "facts_ready", song: o.song, facts: [o.fact("Wrong.")] });
    o.run();
    expect(o.shown).not.toContain("Wrong.");
  });
});

describe("bubbles in one fixed spot", () => {
  const spot = { bottom: "5%", right: "3%" };

  it("replaces the bubble still showing there, so they never stack", () => {
    const o = overlay();
    o.send({ type: "facts_ready", song: o.song, facts: [o.fact("First.", spot), o.fact("Second.", spot)] });
    o.step(1);
    expect(o.hidden).toEqual([]);
    o.step(1);
    expect(o.shown).toEqual(["First.", "Second."]);
    expect(o.hidden).toEqual(["First."]);
  });

  it("leaves bubbles in other spots alone", () => {
    const o = overlay();
    o.send({ type: "facts_ready", song: o.song, facts: [o.fact("Left.", { top: "6%", left: "3%" }), o.fact("Right.", { top: "6%", right: "3%" })] });
    o.step(2);
    expect(o.hidden).toEqual([]);
  });

  it("puts the test bubble in the spot too, replacing what's there", () => {
    const o = overlay();
    o.send({ type: "facts_ready", song: o.song, facts: [o.fact("Showing.", spot)] });
    o.step(1);
    o.send({ type: "test_bubble", song: { title: "BubbleFacts test", artist: "" }, facts: [o.fact("Test.", spot)] });
    expect(o.hidden).toEqual(["Showing."]);
  });

  it("still takes the right fact off when one is marked wrong", () => {
    const o = overlay();
    o.send({ type: "facts_ready", song: o.song, facts: [o.fact("First.", spot), o.fact("Second.", spot), o.fact("Third.", spot)] });
    o.step(2);
    o.send({ type: "remove_fact", song: o.song, text: "Second." });
    o.send({ type: "remove_fact", song: o.song, text: "First." });
    expect(o.hidden).toEqual(["First.", "Second."]);
    o.run();
    expect(o.shown).toEqual(["First.", "Second.", "Third."]);
    // Each hides once, however many reasons it had to go.
    expect(o.hidden).toEqual(["First.", "Second.", "Third."]);
  });
});
