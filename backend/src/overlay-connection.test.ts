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
