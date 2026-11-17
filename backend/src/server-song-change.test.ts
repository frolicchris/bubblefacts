import fs from "fs";
import path from "path";

// server.ts listens when loaded, so it's read here, not imported. An onSongChange with no .catch
// crashes Node (unhandled rejection): every call must catch and log, like the song source's callback
const SOURCE = fs.readFileSync(path.resolve(__dirname, "server.ts"), "utf8");

describe("song changes in the server", () => {
  it("catches and logs every failed song change", () => {
    const calls = SOURCE.split("\n").filter((l) => /\bonSongChange\(/.test(l) && !/function onSongChange\(/.test(l));
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const line of calls) expect(line).toMatch(/onSongChange\([^)]*\)\)?\.catch\(\(err\) => console\.error\("\[Server\] Song change failed:", err\)\)/);
  });
});

describe("preparing songs in the server (issues #293 and #295)", () => {
  it("stops preparing as soon as an overlay connects", () => {
    const connection = SOURCE.slice(SOURCE.indexOf('wss.on("connection"'));
    expect(connection.slice(0, connection.indexOf("songList.getCurrentSong()"))).toMatch(/if \(preparer\.running\) \{[^}]*preparer\.stop\(\);/);
  });

  it("refuses to start while an overlay is connected or there's no AI", () => {
    const cant = SOURCE.slice(SOURCE.indexOf("function cantPrepare("), SOURCE.indexOf("function remember("));
    expect(cant).toContain('if (clients.size) return "overlay";');
    expect(cant).toContain('if (config.aiProvider === "none") return "no-ai";');
    const route = SOURCE.slice(SOURCE.indexOf('control.post("/prepare"'));
    expect(route.slice(0, route.indexOf("});"))).toMatch(/cantPrepare\(\)[\s\S]*!refused\) preparer\.start\(\);[\s\S]*else preparer\.stop\(\);/);
  });
});

describe("a song list that wasn't advanced (issue #451)", () => {
  it("follows every song change, so a stale song clears by itself on the next one", () => {
    const change = SOURCE.slice(SOURCE.indexOf("async function onSongChange("));
    expect(change.slice(0, change.indexOf("if (!current)"))).toContain("staleSong.follow(current);");
  });

  it("sends a stale song's bubbles to no overlay, and tells the sharer", () => {
    expect(SOURCE).toContain('if ((paused || staleSong.stale) && payload.type !== "clear") return;');
    expect(SOURCE).toContain("if (!current || paused || staleSong.stale) return;");
    expect(SOURCE).toContain("if (paused || staleSong.stale) return null;");
    expect(SOURCE).toMatch(/sharer\?\.update\([^\n]*stale: staleSong\.stale/);
  });
});

describe("sharing the next song in the queue (issue #448)", () => {
  it("hands the sharer the next song's title and artist only, never the entry or who requested it", () => {
    const name = SOURCE.slice(SOURCE.indexOf("function nextSongName("), SOURCE.indexOf("// The list nobody advanced"));
    expect(name).toContain("const { title, artist } = songList.toSong(entry);");
    expect(name).toContain("return { title, artist };");
    expect(name).not.toMatch(/requestedBy|requests|note/);
    expect(SOURCE).toMatch(/sharer\?\.update\([^\n]*next: nextSongName\(\)/);
  });

  it("tells a source without a queue (not known) from a queue with nothing waiting", () => {
    const name = SOURCE.slice(SOURCE.indexOf("function nextSongName("), SOURCE.indexOf("// The list nobody advanced"));
    expect(name).toContain("if (!songList.getNextSong) return undefined;");
    expect(name).toContain("if (!entry) return null;");
  });

  it("shares again when only the queue behind the current song changes", () => {
    expect(SOURCE).toContain("songList.onNextSongChange?.(() => shareNow());");
  });
});
