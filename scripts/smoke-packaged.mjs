// Smoke test for an INSTALLED BubbleFacts, run with the app's own runtime:
//   ELECTRON_RUN_AS_NODE=1 <path to BubbleFacts executable> scripts/smoke-packaged.mjs <resources dir> [model.gguf | --lite]
// Starts the packaged server as the app does, then (given a model) loads the built-in AI; --lite checks for no AI engine
// Covers what unit tests can't: installed files, native AI binaries, the system's own libraries
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [resources, second] = process.argv.slice(2);
const lite = second === "--lite";
const modelPath = lite ? undefined : second;
// app.asar on Windows and macOS; a plain folder on Linux, whose server runs under Node.js
const appDir = fs.existsSync(path.join(resources, "app.asar")) ? "app.asar" : "app";
const server = path.join(resources, appDir, "dist", "backend", "server.js");
// As the app does: its bundled Node.js if it ships one, else its own runtime
const bundled = path.join(resources, "runtime", "node");
const runtime = fs.existsSync(bundled) ? bundled : process.execPath;
const PORT = "3999";
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

function start(env) {
  const child = spawn(runtime, [server], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      SSL_STREAMER_NAME: "smoketest",
      SSL_ACCESS_TOKEN: "not-a-real-token",
      PORT,
      HOST: "127.0.0.1",
      BUBBLEFACTS_LOG_DIR: process.env.RUNNER_TEMP || ".",
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
    // Wait until it's really gone, so the next server can have the port
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

// 1. The server starts from the installed files and serves the overlay
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

// 1b. The right edition: Lite says so and has no AI engine anywhere; the full app isn't a renamed Lite
{
  const pkg = JSON.parse(fs.readFileSync(path.join(resources, appDir, "package.json"), "utf8"));
  const edition = pkg.bubblefacts?.edition === "lite" ? "lite" : "full";
  if (edition !== (lite ? "lite" : "full")) fail(`expected the ${lite ? "Lite" : "full"} app, but its package.json says ${edition}`);
  if (lite) {
    if (pkg.dependencies?.["node-llama-cpp"]) fail("Lite's package.json still lists node-llama-cpp");
    const found = [];
    const walk = (dir) => {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (/llama|ggml/i.test(e.name)) found.push(p);
        // app.asar: a file to the system, a folder to Electron's runtime; both searched
        else if (e.isDirectory() || e.name.endsWith(".asar")) walk(p);
      }
    };
    walk(resources);
    if (found.length) fail(`Lite has AI engine files:\n${found.slice(0, 20).join("\n")}`);
    console.log("PASS: Lite says it's Lite and has no AI engine files");
  }
}

// 2. The built-in AI loads. "auto" (GPU if any) failing only warns on Windows and Linux, where the app
// retries processor-only, which must work; Macs ship Metal builds only, so there "auto" must work
async function loads(gpu) {
  const s = start({ AI_PROVIDER: "builtin", MODEL_PATH: modelPath, LLAMA_GPU: gpu });
  const until = Date.now() + 10 * 60_000;
  let result;
  while (!result && Date.now() < until) {
    if (/Built-in model loaded/.test(s.log())) result = { ok: true, line: s.log().match(/Built-in model loaded[^\n]*/)[0] };
    else if (/Built-in model failed to load/.test(s.log()) || s.exited()) result = { ok: false, log: s.log() };
    else await new Promise((r) => setTimeout(r, 1000));
  }
  // 3. Write and screen captions for two songs at once (a quick song change), through the turn-taking queue
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
