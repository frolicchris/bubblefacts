import fs from "fs";
import path from "path";
jest.mock("electron", () => ({ app: { getPath: () => "", getVersion: () => "0.0.0" }, safeStorage: {} }));
import { DEFAULTS, sanitize, type Settings } from "./settings";

const renderer = path.join(__dirname, "..", "renderer");
const read = (f: string) => fs.readFileSync(path.join(renderer, f), "utf8");

describe("setup headings", () => {
  it("take focus for screen readers without drawing a focus ring", () => {
    // The app focuses these h1s when a screen opens; Chromium would outline them.
    expect(read("index.html")).toMatch(/<h1 tabindex="-1">/);
    expect(read("app.css")).toMatch(/h1\[tabindex="-1"\]:focus\s*\{\s*outline:\s*none;\s*\}/);
  });
});

describe("dashboard", () => {
  it("makes Add facts for this song the filled button and for another song the plain one", () => {
    const html = read("index.html");
    expect(html).toMatch(/<button id="song-facts-open" class="primary"/);
    expect(html).toMatch(/<button id="song-facts-other" class="ghost"/);
  });

  it("gives each green banner title its own second line", () => {
    const js = read("app.js");
    for (const line of [
      "BubbleFacts will show facts when your next song starts.",
      "This song's facts pop up on your stream while it plays.",
      "No bubbles for this song. The note below says why.",
      "Looking up facts for this song. They appear in a few seconds.",
    ]) expect(js).toContain(line);
    expect(js).not.toContain("BubbleFacts is connected and waiting.");
    // With facts off, a live learn or a failure there are no bubbles, but calling it "normal" would be wrong.
    expect(js).not.toContain("No reliable facts for this song, so no bubbles. That's normal.\"");
  });
});

describe("setup's bubble spot question", () => {
  it("offers the corners, top and bottom as a picture of the screen, with nothing picked for them", () => {
    const html = read("index.html");
    expect(html).toContain("Where's clear on your stream?");
    const picker = html.slice(html.indexOf('class="screen-pick"'), html.indexOf("</div>", html.indexOf('class="screen-pick"')));
    const values = [...picker.matchAll(/name="setup-area" value="([a-z-]+)"/g)].map((m) => m[1]);
    expect(values.sort()).toEqual(["bottom", "bottom-left", "bottom-right", "top", "top-left", "top-right"]);
    // Every one is a spot the app accepts, and none is chosen before the musician picks.
    for (const v of values) expect(sanitize({ ...DEFAULTS, bubbleArea: v as Settings["bubbleArea"] }).bubbleArea).toBe(v);
    expect(picker).not.toContain("checked");
    // A new install still starts at Anywhere until then, and Settings keeps its hint.
    expect(DEFAULTS.bubbleArea).toBe("anywhere");
    expect(html).toContain("keep them clear of your camera, keyboard or chat");
  });

  it("saves the musician's pick, and shows an existing choice only when it's one of these", () => {
    const js = read("app.js");
    expect(js).toContain('api.saveSettings({ bubbleArea: radio.value })');
    expect(js).toContain("r.checked = r.value === state.settings.bubbleArea");
  });
});
