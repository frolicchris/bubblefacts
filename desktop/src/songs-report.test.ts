import fs from "fs";
import path from "path";

type Coverage = { total: number; ready: number; noFacts: number; left: number; requestsCovered: number | null; finish: { at: string } | { hours: number } | null };
type Report = {
  readyLine(c: Coverage | null, now?: number): string;
  requestsLine(c: Coverage | null): string;
  stateLine(waiting: string, server: Record<string, unknown> | null): string;
  whenSaid(at: string, now: number): string;
};

const renderer = path.join(__dirname, "..", "renderer");
const read = (f: string) => fs.readFileSync(path.join(renderer, f), "utf8");

/** The screen's sentences are a plain browser script; run it with a stand-in window. */
function load(): Report {
  const win: { SongsReport?: Report } = {};
  new Function("window", read("songs-report.js"))(win);
  return win.SongsReport!;
}
const report = load();
// A Monday evening, local time.
const now = new Date(2026, 10, 2, 20, 0).getTime();
const base: Coverage = { total: 5000, ready: 1240, noFacts: 60, left: 3700, requestsCovered: 0.62, finish: null };

describe("Your songs (issue #294)", () => {
  it("says how many songs are ready and when the rest will be, by the pace on this computer", () => {
    const thursday = new Date(2026, 10, 5, 9, 0).toISOString();
    expect(report.readyLine({ ...base, finish: { at: thursday } }, now)).toBe("1,240 of 5,000 songs ready. The rest by about Thursday.");
    expect(report.readyLine({ ...base, finish: { at: new Date(2026, 10, 2, 23, 0).toISOString() } }, now)).toMatch(/ The rest later today\.$/);
    expect(report.readyLine({ ...base, finish: { at: new Date(2026, 10, 3, 8, 0).toISOString() } }, now)).toMatch(/by about tomorrow\.$/);
    expect(report.readyLine({ ...base, finish: { at: new Date(2026, 10, 20, 8, 0).toISOString() } }, now)).toMatch(/by about 20 November\.$/);
    expect(report.readyLine({ ...base, finish: { hours: 1 } }, now)).toMatch(/about an hour of preparing\.$/);
    expect(report.readyLine({ ...base, finish: { hours: 30 } }, now)).toMatch(/about 30 hours of preparing\.$/);
    expect(report.readyLine(base, now)).toMatch(/Once a few songs are done/);
    expect(report.readyLine({ ...base, left: 0 }, now)).toBe("1,240 of 5,000 songs ready. Every song has been prepared.");
    expect(report.readyLine(null)).toMatch(/^No songs to prepare yet/);
  });

  it("gives the share of requests already covered, or nothing when none are known", () => {
    expect(report.requestsLine(base)).toBe("Ready songs make up 62% of the requests so far.");
    expect(report.requestsLine({ ...base, requestsCovered: null })).toBe("");
  });

  it("says why it waits, in plain words, or what it's doing", () => {
    expect(report.stateLine("obs", null)).toBe("Waiting: OBS is open. Preparing carries on when you close it.");
    expect(report.stateLine("battery", null)).toBe("Waiting: plug your computer in.");
    expect(report.stateLine("off", null)).toMatch(/^Prepare my songs is off\./);
    expect(report.stateLine("", { running: true, current: { title: "Harbor Lights" } })).toBe("Preparing now: Harbor Lights.");
    expect(report.stateLine("", { running: false, finished: true })).toMatch(/^Every song is prepared\./);
    for (const reason of ["setup", "online-ai", "no-ai", "server", "overlay"]) expect(report.stateLine(reason, null)).not.toBe("");
  });

  it("asks nothing of the streamer: no review, approve or check buttons on the screen (issue #258)", () => {
    const html = read("index.html");
    const screen = html.slice(html.indexOf('id="view-songs"'), html.indexOf("</section>", html.indexOf('id="view-songs"')));
    expect(screen).not.toMatch(/approve|review|confirm|risky/i);
    expect([...screen.matchAll(/<button\b[^>]*>([^<]*)</g)].map((m) => m[1])).toEqual(["Prepare my songs is in Settings"]);
    expect(html.indexOf("songs-report.js")).toBeLessThan(html.indexOf("app.js"));
  });
});
