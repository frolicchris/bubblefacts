import fs from "fs";
import os from "os";
import path from "path";
import { installOverlay, OVERLAY_FILE, VERTICAL_OVERLAY_FILE } from "./overlay";

const source = path.resolve(__dirname, "../../frontend/obs");

describe("installOverlay", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-overlay-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("writes the server's port and the bubble size into the real overlay files", () => {
    const file = installOverlay(source, dir, 3005, { scale: 1.5 });
    expect(file).toBe(path.join(dir, OVERLAY_FILE));
    expect(fs.existsSync(file)).toBe(true);
    // If either line in frontend/obs changes shape, the copy would keep the defaults without saying so.
    expect(fs.readFileSync(path.join(dir, "obs-overlay.js"), "utf8")).toContain('const SERVER = "127.0.0.1:3005";');
    expect(fs.readFileSync(path.join(dir, "obs-overlay.css"), "utf8")).toContain("--bf-scale: 1.5;");
  });

  it("writes the vertical overlay beside it, with its own bubble size (issue #175)", () => {
    installOverlay(source, dir, 3000, { scale: 1.25, verticalScale: 1.5 });
    const page = fs.readFileSync(path.join(dir, VERTICAL_OVERLAY_FILE), "utf8");
    // Dragged into OBS, the file's name becomes the source's name.
    expect(VERTICAL_OVERLAY_FILE).toBe("BubbleFacts Vertical.html");
    expect(page).toContain('data-layout="vertical"');
    // The same styles and script as the landscape page, so the port and sizes reach it too.
    expect(page).toContain('href="obs-overlay.css"');
    expect(page).toContain('src="obs-overlay.js"');
    const css = fs.readFileSync(path.join(dir, "obs-overlay.css"), "utf8");
    expect(css).toContain("--bf-scale: 1.25;");
    expect(css).toContain("--bf-vertical-scale: 1.5;");
  });

  it("removes the page an earlier version wrote under its source name", () => {
    fs.writeFileSync(path.join(dir, "obs-overlay.html"), "old");
    installOverlay(source, dir, 3000);
    expect(fs.existsSync(path.join(dir, "obs-overlay.html"))).toBe(false);
    const css = fs.readFileSync(path.join(dir, "obs-overlay.css"), "utf8");
    expect(css).toContain("--bf-scale: 1;");
    expect(css).toContain("--bf-vertical-scale: 1;");
  });
});
