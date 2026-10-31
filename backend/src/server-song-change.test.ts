import fs from "fs";
import path from "path";

/**
 * server.ts starts listening when it loads, so it isn't imported here. A song change that
 * throws with no .catch is an unhandled rejection, which Node turns into a crash: every call
 * of onSongChange must catch and log, as the song source's own callback does.
 */
const SOURCE = fs.readFileSync(path.resolve(__dirname, "server.ts"), "utf8");

describe("song changes in the server", () => {
  it("catches and logs every failed song change", () => {
    const calls = SOURCE.split("\n").filter((l) => /\bonSongChange\(/.test(l) && !/function onSongChange\(/.test(l));
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const line of calls) expect(line).toMatch(/onSongChange\([^)]*\)\)?\.catch\(\(err\) => console\.error\("\[Server\] Song change failed:", err\)\)/);
  });
});
