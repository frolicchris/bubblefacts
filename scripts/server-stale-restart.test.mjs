// The compiled server, restarted while bubbles are paused (a settings save does that), with a short stale
// limit (STALE_SONG_TEST_MS): the song's clock is time played, so neither the pause nor the time the server
// was down counts, and Resume on a stale song starts it again as it does without a restart.
// Run after `npm run build`. Kept off the internet, like server-stale.test.mjs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIMIT_MS = 4000;
const OFFLINE = `data:text/javascript,const f=globalThis.fetch;globalThis.fetch=(u,o)=>/^https?:\\/\\/(127\\.0\\.0\\.1|localhost)[:\\/]/.test(String(u?.url??u))?f(u,o):Promise.reject(new TypeError("offline in this test"));`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bubblefacts-stale-restart-"));
const file = path.join(dir, "now-playing.txt");
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
const health = async () => (await fetch(`http://127.0.0.1:${port}/health`)).json();
const pause = (paused) => fetch(`http://127.0.0.1:${port}/control/pause`, { method: "POST", headers: { "X-BubbleFacts": "1", "Content-Type": "application/json" }, body: JSON.stringify({ paused }) });
const isStale = async () => Boolean((await health()).songStale);
const session = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "data", "session.json"), "utf8"));
  } catch {
    return null;
  }
};

function overlay() {
  const got = [];
  const ws = new globalThis.WebSocket(`ws://127.0.0.1:${port}/ws`);
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(String(e.data));
    if (msg.type !== "style" && msg.type !== "bubble_style") got.push(msg.song?.title ? `${msg.type}:${msg.song.title}` : msg.type);
  });
  return { got, open: new Promise((r) => ws.addEventListener("open", r)), close: () => ws.close() };
}

async function start(paused) {
  child = spawn(process.execPath, ["--import", OFFLINE, path.join(root, "dist", "backend", "server.js")], {
    env: {
      PATH: process.env.PATH, NODE_ENV: "test", SONG_SOURCE: "nowplaying", NOW_PLAYING_FILE: file, AI_PROVIDER: "none",
      PORT: String(port), HOST: "127.0.0.1", STREAMER_DISPLAY_NAME: "madeupchannel",
      BUBBLEFACTS_LOG_DIR: dir, BUBBLEFACTS_DATA_DIR: path.join(dir, "data"), BUBBLEFACTS_TOPICS_DIR: path.join(dir, "topics"),
      STALE_SONG_TEST_MS: String(LIMIT_MS), ...(paused ? { BUBBLEFACTS_PAUSED: "1" } : {}),
    },
  });
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  await until(async () => (await health().catch(() => null))?.currentSong, 30_000, "the server to follow the file");
}
async function stop() {
  const gone = new Promise((r) => child.once("exit", r));
  child.kill();
  await gone;
}

before(async () => {
  port = await freePort();
  fs.writeFileSync(file, "The Made Up Band - Paper Lanterns");
  await start(false);
});

after(async () => {
  child?.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("paused, restarted and resumed later than the limit: the song is still current, on the clock it had", async () => {
  await until(() => typeof session()?.playedMs === "number", 3000, "the song's facts to be ready");
  await pause(true);
  await until(() => session()?.playedPaused === true, 2000, "the paused clock to be saved");
  const played = session().playedMs;
  assert.ok(played < LIMIT_MS, `paused before the limit, at ${played} ms`);
  await stop();
  await sleep(LIMIT_MS + 500); // down, and paused, for longer than a song may be on
  await start(true);
  assert.equal((await health()).paused, true);
  assert.equal(await isStale(), false, "not stale while paused after the restart");

  const o = overlay();
  await o.open;
  await pause(false);
  await sleep(400);
  assert.equal(await isStale(), false, "not stale on Resume: time paused and time down don't count");
  await until(() => o.got.some((m) => m.endsWith(":Paper Lanterns")), 3000, "the overlay to get the song on Resume");
  // The clock carried on from where Pause stopped it: stale once the rest of its time has passed, not a full limit later
  const resumed = Date.now();
  await until(isStale, LIMIT_MS + 2000, "it to go stale once it has really been on that long");
  assert.ok(Date.now() - resumed < LIMIT_MS - played + 1500, "the time played before the restart counted");
  o.close();
});

test("stale, paused and restarted: Resume starts the song again, as it does without a restart", async () => {
  assert.equal(await isStale(), true);
  await pause(true);
  await until(() => session()?.playedPaused === true && session().playedMs >= LIMIT_MS, 2000, "the stale clock to be saved");
  await stop();
  await start(true);

  const o = overlay();
  await o.open;
  await pause(false);
  await until(() => o.got.includes("new_song:Paper Lanterns"), 3000, "the song to start again on the overlay");
  assert.equal(await isStale(), false);
  // Timed afresh from the Resume
  await sleep(LIMIT_MS - 1500);
  assert.equal(await isStale(), false, "a full limit, not what was left");
  await until(isStale, 4000, "it to go stale again when left on");
  o.close();
});
