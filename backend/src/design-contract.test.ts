import fs from "fs";
import path from "path";

const root = path.join(__dirname, "..", "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
const css = read("frontend/obs/obs-overlay.css");
const design = read("docs/DESIGN.md");
const preview = read("frontend/obs/design-preview.html");

describe("docs/DESIGN.md", () => {
  it("lists every --bf- setting the overlay stylesheet defines", () => {
    const names = [...new Set([...css.matchAll(/(--bf-[a-z0-9-]+)\s*:/g)].map((m) => m[1]))];
    expect(names.length).toBeGreaterThan(20);
    const missing = names.filter((n) => !design.includes(`\`${n}\``));
    expect(missing).toEqual([]);
  });

  it("names the selectors it promises to keep", () => {
    for (const sel of [".popup-bubble", ".song-toast", ".song-toast .toast-label", ".song-toast.live-learn"]) {
      expect(design).toContain(`\`${sel}\``);
      expect(css).toContain(sel);
    }
  });
});

describe("--bf-icon", () => {
  it("replaces the rotating icon when a look sets it", () => {
    expect(css).toContain("content: var(--bf-icon, var(--bubble-icon,");
  });

  it("is set by every Style except Classic, to a plain character that isn't an emoji", () => {
    expect(css).not.toMatch(/:where\(:root\) \{[^}]*--bf-icon/);
    for (const style of ["light", "minimal", "retro", "high-contrast"]) {
      const block = new RegExp(`:where\\(html\\[data-style="${style}"\\]\\) \\{([^}]*)\\}`).exec(css)?.[1] ?? "";
      const icon = /--bf-icon:\s*"\\([0-9A-F]{4})"/.exec(block)?.[1];
      expect(icon).toBeDefined();
      // Plain symbols only: music notes, geometric shapes and dingbats, which take the text color.
      expect(parseInt(icon ?? "0", 16)).toBeGreaterThanOrEqual(0x2190);
      expect(parseInt(icon ?? "0", 16)).toBeLessThan(0x2800);
    }
  });
});

describe("frontend/obs/design-preview.html", () => {
  it("loads the overlay's own stylesheet and offers every built-in Style", () => {
    expect(preview).toContain('href="obs-overlay.css"');
    const styles = [...css.matchAll(/data-style="([a-z-]+)"/g)].map((m) => m[1]);
    for (const s of new Set(["classic", ...styles])) expect(preview).toContain(`value="${s}"`);
  });

  it("runs from the file: no network, no external scripts", () => {
    expect(preview).not.toMatch(/https?:\/\//);
    expect(preview).not.toMatch(/<script[^>]+src=/);
  });
});
