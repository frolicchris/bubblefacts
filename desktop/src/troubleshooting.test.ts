import fs from "fs";
import path from "path";

const root = path.join(__dirname, "..", "..");
const page = fs.readFileSync(path.join(root, "site", "troubleshooting.html"), "utf8");
const settings = fs.readFileSync(path.join(root, "desktop", "renderer", "index.html"), "utf8");

/** The table's rows: what you see, then the cells' text */
const rows = [...page.matchAll(/<tr>\s*<th scope="row">([\s\S]*?)<\/th>([\s\S]*?)<\/tr>/g)].map((m) => ({ see: m[1].trim(), rest: m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ") }));

describe("the troubleshooting page (the app's Help and troubleshooting opens it)", () => {
  it("has a row for bubbles that stop partway through a long song, naming the setting as Settings words it", () => {
    const row = rows.find((r) => r.see === "Bubbles stopped partway through a long song or medley");
    expect(row).toBeDefined();
    const label = /<label for="s-stale">([^<]+?)\s*</.exec(settings)?.[1];
    expect(label).toBe("Take a song as over after (minutes)");
    expect(row?.rest).toContain(label as string);
    expect(row?.rest).toMatch(/Settings, then Bubbles/);
    // Nothing to click mid-song
    expect(row?.rest).toMatch(/start again with your next song/);
  });
});
