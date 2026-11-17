import fs from "fs";
import path from "path";
import { READY_LOOKS, readReadyLook } from "./ready-looks";
import { readStyleFile, shownValues, STYLE_FILE_SETTINGS } from "./style-file";

/** The looks that come with the app (desktop/looks): Style files like any shared one */
const ROOT = path.resolve(__dirname, "../..");
const DIR = path.join(ROOT, "desktop/looks");
const STYLES = ["classic", "light", "minimal", "retro", "high-contrast"];

const look = (id: string) => {
  const r = readReadyLook(DIR, id, "2.3.0");
  if (!r.ok) throw new Error(`${id}: ${r.reason}`);
  return r.look;
};

describe("ready-made looks", () => {
  it("are exactly the files in desktop/looks, each in the Settings list and in the packaged app", () => {
    expect(fs.readdirSync(DIR).sort()).toEqual(READY_LOOKS.map((id) => `${id}.json`).sort());
    const html = fs.readFileSync(path.join(ROOT, "desktop/renderer/index.html"), "utf8");
    const list = html.slice(html.indexOf('<select id="look-ready">'), html.indexOf("</select>", html.indexOf('<select id="look-ready">')));
    expect([...list.matchAll(/value="([^"]+)"/g)].map((m) => m[1])).toEqual([...READY_LOOKS]);
    for (const id of READY_LOOKS) expect(list).toContain(`>${look(id).name} (`);
    expect(JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).build.files).toContain("desktop/looks/*.json");
  });

  it.each(READY_LOOKS)("%s passes the check a shared look must, as written, and sets every look setting", (id) => {
    const text = fs.readFileSync(path.join(DIR, `${id}.json`), "utf8");
    const read = readStyleFile(text, "2.3.0");
    if (!read.ok) throw new Error(read.reason);
    const file = JSON.parse(text);
    // Nothing the check had to rewrite, and nobody's name
    expect(read.look.values).toEqual(file.values);
    expect(Object.keys(file)).toEqual(["bubblefacts", "format", "name", "madeFor", "values"]);
    expect(Object.keys(file.values).sort()).toEqual([...STYLE_FILE_SETTINGS].sort());
    expect(read.look.name).toBe(file.name);
  });

  it("look clearly different from each other and from every built-in Style", () => {
    const all = [...READY_LOOKS.map((id) => look(id).values), ...STYLES.map((style) => shownValues({ style, icon: "style" }))];
    for (const key of ["--bf-bg-1", "--bf-accent", "--bf-font", "--bf-radius", "--bf-icon"]) {
      const ready = all.slice(0, READY_LOOKS.length).map((v) => v[key]);
      expect(new Set(ready).size).toBe(ready.length);
      for (const value of ready) expect(all.slice(READY_LOOKS.length).map((v) => v[key])).not.toContain(value);
    }
  });

  it("is chosen by name from the list, never by a path", () => {
    for (const id of ["../looks/neon-booth", "neon-booth.json", "/etc/passwd", "", 3, null]) expect(readReadyLook(DIR, id).ok).toBe(false);
  });
});
