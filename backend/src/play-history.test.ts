jest.mock("./config", () => ({ config: { dataDir: process.env.BUBBLEFACTS_DATA_DIR } }));

import fs from "fs";
import os from "os";
import path from "path";
import { PlayHistory } from "./play-history";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bubblefacts-history-"));
const file = path.join(dir, "play-history.json");
const history = (max?: number) => new PlayHistory(() => file, max);
const at = (minutes: number) => new Date(Date.parse("2026-11-02T20:00:00Z") + minutes * 60_000);

beforeEach(() => fs.rmSync(file, { force: true }));

describe("PlayHistory (issue #297)", () => {
  it("keeps each song seen on stream on this computer, with how often it played, never who asked for it", () => {
    const h = history();
    const request = { title: "Night Drive", artist: "Glass Choir", videoId: "abc123", requestedBy: "viewer_one", performer: true };
    h.record(request, at(0));
    h.record(request, at(30));
    const saved = history().all()["yt:abc123"];
    expect(saved).toEqual({ song: { title: "Night Drive", artist: "Glass Choir", videoId: "abc123", performer: true }, plays: 2, lastAt: at(30).toISOString() });
    expect(fs.readFileSync(file, "utf8")).not.toContain("viewer_one");
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("counts a song seen again within minutes (a pause, a restart) as the same play", () => {
    const h = history();
    const song = { title: "Paper Kites", artist: "Marlo Venn" };
    h.record(song, at(0));
    h.record(song, at(3));
    expect(h.all()["marlo venn:::paper kites"].plays).toBe(1);
  });

  it("keeps the most recently played songs when it's full", () => {
    const h = history(2);
    h.record({ title: "One", artist: "Quiet Pines" }, at(0));
    h.record({ title: "Two", artist: "Quiet Pines" }, at(20));
    h.record({ title: "Three", artist: "Quiet Pines" }, at(40));
    expect(Object.values(history(2).all()).map((p) => p.song.title).sort()).toEqual(["Three", "Two"]);
  });

  it("starts empty from a broken file and skips a blank title", () => {
    fs.writeFileSync(file, "nope");
    const h = history();
    expect(h.all()).toEqual({});
    h.record({ title: "  ", artist: "Nobody" }, at(0));
    expect(h.all()).toEqual({});
  });
});
