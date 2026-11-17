// The compiled server, run for real on a now playing file with a short stale limit (STALE_SONG_TEST_MS):
// what an overlay and an app that takes shared facts see when the song list isn't advanced (#451), across
// Pause and Resume. server.ts listens when loaded, so jest can't import it. Run after `npm run build`.
// The server is kept off the internet (no lookups): only the stale behavior is under test.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIMIT_MS = 2500;
const POLL_MS = 2000; // how often the server reads the file
const OFFLINE = `data:text/javascript,const f=globalThis.fetch;globalThis.fetch=(u,o)=>/^https?:\\/\\/(127\\.0\\.0\\.1|localhost)[:\\/]/.test(String(u?.url??u))?f(u,o):Promise.reject(new TypeError("offline in this test"));`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bubblefacts-stale-"));
const file = path.join(dir, "now-playing.txt");
const play = (line) => fs.writeFileSync(file, line);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});
async function until(check, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(50);
  }
  assert.fail(`timed out waiting for ${what}\n${log}`);
}

let port, child, log = "";
/** What the other app was sent, newest last */
const shared = [];
const lastShared = () => shared[shared.length - 1] ?? "";
const standIn = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    shared.push(JSON.parse(raw).data.content);
    res.end();
  });
});

/** An overlay: the messages it got, by type, style left out */
function overlay() {
  const got = [];
  // Node 22 has a WebSocket client built in
  const ws = new globalThis.WebSocket(`ws://127.0.0.1:${port}/ws`);
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(String(e.data));
    if (msg.type !== "style" && msg.type !== "bubble_style") got.push(msg.song?.title ? `${msg.type}:${msg.song.title}` : msg.type);
  });
  return { got, open: new Promise((r) => ws.addEventListener("open", r)), close: () => ws.close() };
}
const health = async () => (await fetch(`http://127.0.0.1:${port}/health`)).json();
const pause = (paused) => fetch(`http://127.0.0.1:${port}/control/pause`, { method: "POST", headers: { "X-BubbleFacts": "1", "Content-Type": "application/json" }, body: JSON.stringify({ paused }) });
const isStale = async () => Boolean((await health()).songStale);

before(async () => {
  port = await freePort();
  await new Promise((r) => standIn.listen(0, "127.0.0.1", r));
  play("The Made Up Band - Paper Lanterns");
  child = spawn(process.execPath, ["--import", OFFLINE, path.join(root, "dist", "backend", "server.js")], {
    env: {
      PATH: process.env.PATH, NODE_ENV: "test", SONG_SOURCE: "nowplaying", NOW_PLAYING_FILE: file, AI_PROVIDER: "none",
      PORT: String(port), HOST: "127.0.0.1", STREAMER_DISPLAY_NAME: "madeupchannel",
      BUBBLEFACTS_LOG_DIR: dir, BUBBLEFACTS_DATA_DIR: path.join(dir, "data"), BUBBLEFACTS_TOPICS_DIR: path.join(dir, "topics"),
      STALE_SONG_TEST_MS: String(LIMIT_MS),
      SHARE_FACTS_URL: `http://127.0.0.1:${standIn.address().port}/events`, SHARE_FACTS_KEY: "made-up-key-12345", SHARE_FACTS_CHANNEL: "madeupchannel",
    },
  });
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  await until(async () => (await health().catch(() => null))?.currentSong, 30_000, "the server to follow the file");
});

after(async () => {
  child?.kill();
  standIn.closeAllConnections();
  standIn.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a song left on the list goes stale: overlays are cleared, a new overlay gets nothing, and the next song starts as usual", async () => {
  const first = overlay();
  await first.open;
  await until(() => first.got.includes("new_song:Paper Lanterns"), 5000, "the overlay to get the song");
  await until(() => lastShared().startsWith('Now playing: "Paper Lanterns"'), 5000, "the song to be shared");

  await until(isStale, LIMIT_MS + 3000, "the song to go stale");
  await until(() => first.got.at(-1) === "clear", 2000, "the overlay to be cleared");
  await until(() => lastShared().startsWith("BubbleFacts isn't sure what's playing"), 3000, "the other app to be told");
  assert.match(lastShared(), /Next song: not known/);
  assert.match((await health()).songStale, /isn't sure/);

  const late = overlay();
  await late.open;
  await sleep(700);
  assert.deepEqual(late.got, [], "an overlay that connects while the song is stale gets no song");

  play("Someone Else - Second Song");
  await until(() => first.got.includes("new_song:Second Song") && late.got.includes("new_song:Second Song"), POLL_MS + 3000, "the next song on both overlays");
  assert.equal(await isStale(), false);
  await until(() => lastShared().startsWith('Now playing: "Second Song"'), 3000, "the next song to be shared");
  first.close();
  late.close();
});

test("Resume on a stale song takes it as playing again: bubbles and sharing restart", async () => {
  const o = overlay();
  await o.open;
  await until(isStale, LIMIT_MS + 3000, "the second song to go stale");
  await pause(true);
  o.got.length = 0;
  await pause(false);
  await until(() => o.got.includes("new_song:Second Song"), 3000, "the song to start again on the overlay");
  assert.equal(await isStale(), false);
  await until(() => lastShared().startsWith('Now playing: "Second Song"'), 3000, "the song to be shared again");
  // And it is timed afresh from the Resume
  await until(isStale, LIMIT_MS + 3000, "it to go stale again when left on");
  o.close();
});

test("time paused doesn't count: a song lined up, paused over and resumed is still current", async () => {
  const o = overlay();
  await o.open;
  play("A Third Group - Third Song");
  await until(async () => (await health()).currentSong?.includes("Third Song"), POLL_MS + 3000, "the third song");
  await pause(true);
  await sleep(LIMIT_MS + 1000);
  assert.equal(await isStale(), false, "not stale while paused, however long");
  o.got.length = 0;
  await pause(false);
  await sleep(300);
  assert.equal(await isStale(), false, "not stale on Resume");
  assert.ok(o.got.some((m) => m.endsWith(":Third Song")), `the overlay gets the song on Resume, got ${JSON.stringify(o.got)}`);
  await until(() => lastShared().startsWith('Now playing: "Third Song"'), 3000, "the song to be shared on Resume");
  // The clock carried on from where Pause stopped it
  await until(isStale, LIMIT_MS + 3000, "it to go stale once it has really been on that long");
  // What a restart needs to keep the clock: when the song came on
  const session = JSON.parse(fs.readFileSync(path.join(dir, "data", "session.json"), "utf8"));
  assert.equal(typeof session.onSince, "number");
  o.close();
});
