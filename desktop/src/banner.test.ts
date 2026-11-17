import fs from "fs";
import path from "path";

type View = Record<string, unknown>;
type Banner = {
  bannerFor(v: View): { kind: string; title: string; detail: string };
  twitchButtons(t: { connected?: boolean; ended?: boolean }): { connect: boolean; disconnect: boolean; disconnectText: string };
};

const renderer = path.join(__dirname, "..", "renderer");
const read = (name: string) => fs.readFileSync(path.join(renderer, name), "utf8");

function load(): Banner {
  const win: { Banner?: Banner } = {};
  new Function("window", read("banner.js"))(win);
  return win.Banner!;
}
const banner = load();

const STALE = "Your song list has shown the same song for a long time.";
/** A dashboard with a song on and bubbles showing; each test changes what it is about */
const view = (more: View = {}): View => ({
  status: { state: "running", message: "" }, health: { currentSong: "Paper Lanterns" }, obs: true, obsGrace: false, downloading: "", rejected: false,
  paused: false, source: "streamersonglist", songListDown: false, sharing: false, twitch: { ended: false, about: true, connected: false }, showing: 3, ready: true, ...more,
});
const title = (more?: View) => banner.bannerFor(view(more)).title;

describe("the dashboard banner", () => {
  it("says facts are showing when all is well", () => {
    expect(banner.bannerFor(view())).toMatchObject({ kind: "ok", title: "Showing facts" });
    expect(title({ health: {} })).toBe("Ready for your next song");
    expect(title({ showing: 0 })).toBe("Following your songs");
    expect(title({ showing: 0, ready: false })).toBe("Finding facts");
  });

  it("puts what stops bubbles first", () => {
    const all = { rejected: true, paused: true, obs: false, health: { songStale: STALE }, twitch: { ended: true, about: true, connected: false } };
    expect(banner.bannerFor(view({ ...all, status: { state: "failing", message: "It stopped" } }))).toMatchObject({ kind: "bad", title: "Something's wrong" });
    expect(title({ ...all, status: { state: "restarting", message: "It stopped" } })).toBe("Fixing a problem");
    expect(title(all)).toBe("Reconnect your song list");
    expect(title({ ...all, rejected: false, status: { state: "stopped" } })).toBe("Connect your songs");
    expect(title({ ...all, rejected: false })).toBe("Bubbles are paused");
    expect(title({ obs: false, obsGrace: true })).toBe("Connecting to OBS");
    expect(title({ obs: false })).toBe("Add BubbleFacts to OBS");
    expect(title({ status: { state: "running", message: "Reconnecting to your song list" } })).toBe("Reconnecting");
    expect(banner.bannerFor(view({ health: { songStale: STALE } }))).toMatchObject({ kind: "warn", title: "Waiting for your next song", detail: STALE });
  });
});

describe("the Twitch connection ended notice", () => {
  const ended = { ended: true, about: true, connected: false };

  it("shows for a streamer who has Twitch About turned on, and says both ways out", () => {
    const b = banner.bannerFor(view({ twitch: ended }));
    expect(b).toMatchObject({ kind: "warn", title: "Your Twitch connection ended" });
    expect(b.detail).toMatch(/Connect Twitch again in Settings/);
    expect(b.detail).toMatch(/turn Twitch About off/);
  });

  it("never replaces Showing facts for a streamer with Twitch About turned off", () => {
    expect(title({ twitch: { ...ended, about: false } })).toBe("Showing facts");
  });

  it("goes once connected again", () => {
    expect(title({ twitch: { ...ended, connected: true } })).toBe("Showing facts");
  });

  it("stays below every notice that means bubbles aren't showing", () => {
    expect(title({ twitch: ended, paused: true })).toBe("Bubbles are paused");
    expect(title({ twitch: ended, obs: false })).toBe("Add BubbleFacts to OBS");
    expect(title({ twitch: ended, status: { state: "running", message: "Reconnecting to your song list" } })).toBe("Reconnecting");
    expect(title({ twitch: ended, health: { songStale: STALE } })).toBe("Waiting for your next song");
    expect(title({ twitch: ended, rejected: true })).toBe("Reconnect your song list");
  });

  it("can be cleared in Settings without connecting: the Disconnect button stays, worded as staying disconnected", () => {
    expect(banner.twitchButtons({ connected: true })).toEqual({ connect: false, disconnect: true, disconnectText: "Disconnect" });
    expect(banner.twitchButtons({ connected: false })).toEqual({ connect: true, disconnect: false, disconnectText: "Stay disconnected" });
    expect(banner.twitchButtons({ connected: false, ended: true })).toEqual({ connect: true, disconnect: true, disconnectText: "Stay disconnected" });
  });
});

describe("the window", () => {
  it("loads banner.js before app.js, which leaves the banner's words to it", () => {
    const html = read("index.html");
    expect(html.indexOf('src="banner.js"')).toBeGreaterThan(-1);
    expect(html.indexOf('src="banner.js"')).toBeLessThan(html.indexOf('src="app.js"'));
    expect(read("app.js")).toContain("window.Banner.bannerFor(");
  });

  it("keeps the banner a live region for screen readers", () => {
    expect(read("index.html")).toMatch(/id="status-banner"[^>]*(role="status"|aria-live="polite")/);
  });
});
