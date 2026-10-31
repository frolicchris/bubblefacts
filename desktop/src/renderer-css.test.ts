import fs from "fs";
import path from "path";

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
