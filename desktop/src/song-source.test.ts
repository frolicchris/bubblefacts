import fs from "fs";
import path from "path";

type Changes = Record<string, string | boolean>;
type SongSource = { fieldShown(name: string, source: string, preset: string): boolean; sourceChanges(c: Changes): Changes };

/** The renderer's helper is a plain browser script; run it with a stand-in window. */
function load(): SongSource {
  const code = fs.readFileSync(path.join(__dirname, "..", "renderer", "song-source.js"), "utf8");
  const win: { SongSource?: SongSource } = {};
  new Function("window", code)(win);
  return win.SongSource!;
}
const { fieldShown, sourceChanges } = load();

const form: Changes = {
  channel: "tester",
  token: "t-123",
  tokenKind: "streamer",
  seChannel: "se-tester",
  seJwt: "jwt-456",
  nowPlayingPreset: "none",
  nowPlayingFile: "/Music/song.txt",
  nowPlayingFormat: "title",
  displayName: "Tester",
};

describe("which song source fields are saved", () => {
  it("keeps only a file's own fields with Another app's file, plus everything outside the song list", () => {
    expect(sourceChanges({ ...form, songSource: "nowplaying" })).toEqual({
      songSource: "nowplaying",
      nowPlayingPreset: "none",
      nowPlayingFile: "/Music/song.txt",
      nowPlayingFormat: "title",
      displayName: "Tester",
    });
  });

  it("drops a path typed under Another app's file once Streamling or Nightbot is picked", () => {
    for (const preset of ["streamling", "nightbot"]) {
      const out = sourceChanges({ ...form, songSource: "nowplaying", nowPlayingPreset: preset });
      expect(out.nowPlayingPreset).toBe(preset);
      expect(out).not.toHaveProperty("nowPlayingFile");
      expect(out).not.toHaveProperty("nowPlayingFormat");
      expect(out).not.toHaveProperty("token");
      expect(out).not.toHaveProperty("seJwt");
    }
  });

  it("saves no file card, path or other source's fields with StreamerSongList or StreamElements", () => {
    const ssl = sourceChanges({ ...form, songSource: "streamersonglist" });
    expect(Object.keys(ssl).sort()).toEqual(["channel", "displayName", "songSource", "token", "tokenKind"]);
    const se = sourceChanges({ ...form, songSource: "streamelements" });
    expect(Object.keys(se).sort()).toEqual(["displayName", "seChannel", "seJwt", "songSource"]);
  });

  it("does not change what it is given", () => {
    const before = { ...form, songSource: "streamelements" };
    sourceChanges(before);
    expect(before).toEqual({ ...form, songSource: "streamelements" });
  });
});

describe("which song source fields are shown", () => {
  it("shows the picked source's fields and none of another's", () => {
    expect(fieldShown("token", "streamersonglist", "none")).toBe(true);
    expect(fieldShown("token", "streamelements", "none")).toBe(false);
    expect(fieldShown("seJwt", "streamelements", "none")).toBe(true);
    expect(fieldShown("seJwt", "nowplaying", "none")).toBe(false);
    expect(fieldShown("nowPlayingPreset", "streamersonglist", "none")).toBe(false);
  });

  it("shows the file and its format only for Another app's file", () => {
    expect(fieldShown("nowPlayingFile", "nowplaying", "none")).toBe(true);
    expect(fieldShown("nowPlayingFormat", "nowplaying", "none")).toBe(true);
    expect(fieldShown("nowPlayingFile", "nowplaying", "streamling")).toBe(false);
    expect(fieldShown("nowPlayingFormat", "nowplaying", "nightbot")).toBe(false);
  });

  it("always shows fields outside the song list", () => {
    expect(fieldShown("displayName", "streamelements", "none")).toBe(true);
  });
});

describe("Settings wiring for song sources", () => {
  const read = (f: string) => fs.readFileSync(path.join(__dirname, "..", "renderer", f), "utf8");
  it("loads the helper before the app, and shows a card's file only when that card is picked", () => {
    const html = read("index.html");
    expect(html.indexOf('src="song-source.js"')).toBeGreaterThan(-1);
    expect(html.indexOf('src="song-source.js"')).toBeLessThan(html.indexOf('src="app.js"'));
    // Each preset card's folder sits in a part that starts hidden.
    for (const card of ["streamling", "nightbot"]) {
      expect(html).toMatch(new RegExp(`data-np-card="${card}" hidden>[^]*?data-np-folder="${card}"`));
    }
    const js = read("app.js");
    expect(js).toContain("c.hidden = c.dataset.npCard !== form.elements.nowPlayingPreset.value");
    expect(js).toContain("return window.SongSource.sourceChanges(changes);");
  });
});
