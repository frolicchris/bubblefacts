// Smoke test for an INSTALLED BubbleFacts, run with the app's own runtime:
//   ELECTRON_RUN_AS_NODE=1 <path to BubbleFacts executable> scripts/smoke-packaged.mjs <resources dir> [model.gguf]
// Starts the packaged fact server the way the app does, checks it answers and
// serves the overlay, then (given a model) checks the built-in AI loads on
// the processor. This is the path the unit tests can't reach: the installed
// files, the native AI binaries and the operating system's own libraries.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [resources, modelPath] = process.argv.slice(2);
// Packed into app.asar on Windows and macOS; a plain folder on Linux, whose server runs under Node.js.
const appDir = fs.existsSync(path.join(resources, "app.asar")) ? "app.asar" : "app";
const server = path.join(resources, appDir, "dist", "backend", "server.js");
// Run the server the way the app does: with its bundled Node.js if it ships one, else its own runtime.
const bundled = path.join(resources, "runtime", "node");
const runtime = fs.existsSync(bundled) ? bundled : process.execPath;
const PORT = "3999";
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

function start(env) {
  // SMOKE_RUNTIME=node runs the server under this Node.js instead of the app's own runtime (diagnostics).
  const child = spawn(runtime, [server], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      SSL_STREAMER_NAME: "smoketest",
      SSL_ACCESS_TOKEN: "not-a-real-token",
      PORT,
      HOST: "127.0.0.1",
      STREAM_FACTS_LOG_DIR: process.env.RUNNER_TEMP || ".",
      ...env,
    },
  });
  let log = "";
  let exited = false;
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const done = new Promise((r) =>
    child.on("exit", (code, signal) => {
      exited = true;
      log += `\n[smoke] server exited: code=${code} signal=${signal}\n`;
      r();
    })
  );
  return {
    log: () => log,
    exited: () => exited,
    // Wait until it's really gone, so the next server can have the port.
    stop: () => (child.kill(), done),
  };
}

async function waitFor(check, ms, what, s) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (s?.exited()) fail(`the server stopped while waiting for ${what}:\n${s.log()}`);
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  fail(`timed out waiting for ${what}`);
}

const get = (p) => fetch(`http://127.0.0.1:${PORT}${p}`, { signal: AbortSignal.timeout(3000) });

// 1. The server starts from the installed files and serves the overlay.
{
  const s = start({ AI_PROVIDER: "none" });
  await waitFor(async () => (await get("/health")).ok, 60_000, "the server to answer /health", s);
  const page = await get("/obs/obs-overlay.html");
  if (!page.ok || !(await page.text()).includes("obs-overlay.js")) fail("the overlay page isn't served");
  const script = await (await get("/obs/obs-overlay.js")).text();
  if (!script.includes('location.hostname === "absolute"')) fail("the overlay lacks the OBS Local-file fix");
  console.log("PASS: server starts, answers /health and serves the overlay (with the Local-file fix)");
  await s.stop();
}

// 2. The built-in AI's native files load on this system. The app first starts
// it with "auto" (GPU if there is one). If that crashes or fails, the app
// retries processor-only, so on Windows and Linux "auto" failing is only a
// warning and processor-only must work. Macs ship Metal builds only, with no
// processor-only build, so there "auto" must work.
async function loads(gpu) {
  const s = start({ AI_PROVIDER: "builtin", MODEL_PATH: modelPath, LLAMA_GPU: gpu });
  const until = Date.now() + 10 * 60_000;
  let result;
  while (!result && Date.now() < until) {
    if (/Built-in model loaded/.test(s.log())) result = { ok: true, line: s.log().match(/Built-in model loaded[^\n]*/)[0] };
    else if (/Built-in model failed to load/.test(s.log()) || s.exited()) result = { ok: false, log: s.log() };
    else await new Promise((r) => setTimeout(r, 1000));
  }
  // 3. Loading isn't enough: write and screen captions for two songs at once,
  // as a quick song change would, through the turn-taking queue.
  if (result?.ok) {
    const ask = (variant) =>
      fetch(`http://127.0.0.1:${PORT}/control/selftest`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BubbleFacts": "1" },
        body: JSON.stringify({ variant }),
        signal: AbortSignal.timeout(5 * 60_000),
      }).then((r) => r.json());
    const runs = await Promise.all([ask(0), ask(1)]).catch((err) => [{ error: err.message }]);
    const bad = runs.find((r) => r.error || !(r.kept?.length >= 1));
    result = bad
      ? { ok: false, log: `captions didn't come through: ${JSON.stringify(runs)}\n${s.log()}` }
      : { ...result, line: `${result.line}; wrote and kept ${runs.map((r) => `${r.kept.length}/${r.generated} captions in ${(r.ms / 1000).toFixed(0)}s`).join(" and ")}` };
  }
  await s.stop();
  return result ?? { ok: false, log: `timed out\n${s.log()}` };
}

if (modelPath) {
  const auto = await loads("auto");
  if (auto.ok) console.log(`PASS (LLAMA_GPU=auto): ${auto.line}`);
  else if (process.platform === "darwin") fail(`the built-in AI didn't load:\n${auto.log}`);
  else console.log(`WARN (LLAMA_GPU=auto): didn't load, so the app would retry processor-only. Log:\n${auto.log}`);
  if (process.platform !== "darwin") {
    const cpu = await loads("off");
    if (!cpu.ok) fail(`the processor-only fallback didn't load either:\n${cpu.log}`);
    console.log(`PASS (LLAMA_GPU=off, the app's fallback): ${cpu.line}`);
  }
}

process.exit(0);
