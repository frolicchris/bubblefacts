import fs from "fs";
import path from "path";

type Light = { kind: string; text: string };
type A11y = {
  lightAnnouncement(prev: Light | undefined, next: Light, label: string): string;
  counterStep(wasOver: boolean, length: number, max: number, message: string): { over: boolean; announce: string };
};

const renderer = path.join(__dirname, "..", "renderer");
const read = (f: string) => fs.readFileSync(path.join(renderer, f), "utf8");

/** The renderer's helper is a plain browser script; run it with a stand-in window. */
function load(): A11y {
  const win: { A11y?: A11y } = {};
  new Function("window", read("a11y.js"))(win);
  return win.A11y!;
}
const { lightAnnouncement, counterStep } = load();

describe("status light announcements", () => {
  it("announces a change into a warning or problem, once", () => {
    const warn = { kind: "warn", text: "Reconnecting" };
    expect(lightAnnouncement({ kind: "ok", text: "Connected" }, warn, "Songs")).toBe("Songs: Reconnecting");
    expect(lightAnnouncement(warn, warn, "Songs")).toBe("");
    expect(lightAnnouncement(warn, { kind: "bad", text: "Sign in again" }, "Songs")).toBe("Songs: Sign in again");
  });

  it("stays quiet for ok and neutral lights", () => {
    expect(lightAnnouncement(undefined, { kind: "ok", text: "Ready" }, "Facts")).toBe("");
    expect(lightAnnouncement({ kind: "warn", text: "x" }, { kind: "", text: "Starting" }, "Facts")).toBe("");
  });
});

describe("fact length counter", () => {
  it("announces once on crossing the limit, then again only after dropping back under", () => {
    let over = false;
    const say: string[] = [];
    for (const n of [190, 201, 205, 230, 199, 202]) {
      const s = counterStep(over, n, 200, `over at ${n}`);
      over = s.over;
      if (s.announce) say.push(s.announce);
    }
    expect(say).toEqual(["over at 201", "over at 202"]);
  });
});

describe("renderer wiring", () => {
  const js = read("app.js");
  const html = read("index.html");

  it("loads the helper before the app", () => {
    expect(html.indexOf("a11y.js")).toBeGreaterThan(-1);
    expect(html.indexOf("a11y.js")).toBeLessThan(html.indexOf("app.js"));
  });

  it("makes the header and main inert while the sign-in scrim shows", () => {
    expect(html).toContain('id="app-header"');
    expect(html).toContain('id="app-main"');
    expect(js).toMatch(/\$\("#app-header"\)\.inert = !!on/);
    expect(js).toMatch(/\$\("#app-main"\)\.inert = !!on/);
  });

  it("gives each view heading focus on a switch", () => {
    for (const h of ['id="status-title" tabindex="-1"', '<h1 tabindex="-1">Settings', '<h1 tabindex="-1">BubbleFacts']) {
      expect(html).toContain(h);
    }
    expect(js).toContain("VIEW_HEADINGS[view]");
  });

  it("does not make the counter a live region that speaks on every keystroke", () => {
    expect(js).not.toContain('count.setAttribute("aria-live"');
  });
});

describe("overlay reduced motion", () => {
  it("stops sparkle, float and the endless blink, keeping transform and opacity only", () => {
    const css = fs.readFileSync(path.join(__dirname, "..", "..", "frontend", "obs", "obs-overlay.css"), "utf8");
    const block = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(block).toMatch(/\.popup-bubble::after\s*\{[^}]*animation:\s*none/);
    expect(block).toMatch(/\.sparkle\s*\{[^}]*animation:\s*none/);
    expect(block).toMatch(/\.popup-bubble\.idle\s*\{[^}]*animation:\s*popIn[^;]*;/);
    expect(block).not.toContain("gameFloat");
  });
});
