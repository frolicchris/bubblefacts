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
