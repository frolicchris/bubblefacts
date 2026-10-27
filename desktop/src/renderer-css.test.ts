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
