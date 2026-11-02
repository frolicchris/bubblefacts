#!/usr/bin/env node
// Builds BubbleFacts Lite, the installers with no AI engine: `npm run dist:lite -- --mac --arm64`.
// Takes the same arguments as `npm run dist` (electron-builder's), including -c.* options.
//
// Lite is the full app's package.json with three changes (liteManifest below): no node-llama-cpp
// or its native builds, installers named with "-lite" and built into release-lite/, and
// "edition": "lite" written into the app's package.json, which the app reads (desktop/src/build.ts).
// electron-builder only takes its file list from package.json, so package.json is swapped
// for the Lite one while it runs, then put back exactly as it was, whatever happens.
// Lite ships its own THIRD-PARTY-NOTICES.md (liteNotices below): the full app's, less the AI
// engine, the packages only it needs, the AI models and the Linux app's own Node.js.
import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/** The AI engine: the package and its prebuilt native builds. */
const ENGINE = /node-llama-cpp/;
/** Where the Lite notices are written for the build, and removed after. */
const NOTICES_DIR = "build-lite";
const NOTICES = "THIRD-PARTY-NOTICES.md";

/** The full package.json made into Lite's. Pure, so the tests can check it. */
export function liteManifest(pkg) {
  const lite = structuredClone(pkg);
  // Not a dependency, so electron-builder leaves it and everything only it needs out of the app.
  delete lite.dependencies["node-llama-cpp"];
  lite.bubblefacts = { ...lite.bubblefacts, edition: "lite" };
  const build = lite.build;
  build.directories = { ...build.directories, output: "release-lite" };
  // And never copied in by a pattern, even if the dependency comes back by another route.
  build.files = [...build.files.filter((f) => !ENGINE.test(f) && f !== NOTICES), "!node_modules/node-llama-cpp{,/**/*}", "!node_modules/@node-llama-cpp{,/**/*}"];
  // Lite's own notices, under the same name the app opens.
  build.files.push({ from: NOTICES_DIR, to: ".", filter: [NOTICES] });
  build.asarUnpack = (build.asarUnpack ?? []).filter((f) => !ENGINE.test(f));
  if (!build.asarUnpack.length) delete build.asarUnpack;
  build.mac.artifactName = "BubbleFacts-${version}-lite-mac-${arch}.${ext}";
  build.win.artifactName = "BubbleFacts-${version}-lite-windows-${arch}.${ext}";
  build.appImage.artifactName = "BubbleFacts-${version}-lite-linux-x86_64.${ext}";
  build.deb.artifactName = "bubblefacts-lite_${version}_amd64.${ext}";
  // The Linux app ships its own Node.js only because the AI engine crashes under Electron's
  // runtime there (desktop/src/supervisor.ts). With no engine, the server runs under Electron's.
  delete build.linux.extraResources;
  return lite;
}

/**
 * The npm packages Lite ships: everything `npm ls --all --json` reaches from the app's
 * dependencies without going through the AI engine. A package the engine shares with another
 * dependency stays.
 */
export function liteKeep(tree) {
  // npm lists a package's own dependencies only where it first prints it ("deduped" elsewhere),
  // and that may be under the engine: so each package's dependencies are gathered from wherever
  // they are printed, then followed from the app's own dependencies.
  const childrenOf = new Map();
  const gather = (deps = {}) => {
    for (const [name, dep] of Object.entries(deps)) {
      const key = `${name}@${dep.version}`;
      const children = Object.entries(dep.dependencies ?? {});
      if (children.length) childrenOf.set(key, [...(childrenOf.get(key) ?? []), ...children]);
      gather(dep.dependencies);
    }
  };
  gather(tree.dependencies);
  const keep = new Set();
  const walk = (deps) => {
    for (const [name, dep] of deps) {
      const key = `${name}@${dep.version}`;
      if (ENGINE.test(name) || keep.has(key)) continue;
      keep.add(key);
      walk(childrenOf.get(key) ?? []);
    }
  };
  walk(Object.entries(tree.dependencies ?? {}));
  return new Set([...keep].map((k) => k.slice(0, k.lastIndexOf("@"))));
}

/** Lines in "Not from npm" that are only true of the full app. */
const FULL_ONLY = /^- \*\*(?:Node\.js|llama\.cpp|Llama [\d.]+ [\w ]+)\*\*/;

/**
 * The full app's THIRD-PARTY-NOTICES.md made into Lite's: only the npm packages named in `keep`,
 * with the count to match, and without the AI engine, the AI models or the Linux app's own
 * Node.js. Package sections are found outside code blocks, since license texts have headings too.
 */
export function liteNotices(full, keep) {
  const out = [];
  let inCode = false;
  let skipping = false;
  let kept = 0;
  for (const line of full.split("\n")) {
    if (!inCode && line.startsWith("### ")) {
      const name = line.slice(4).split(" ")[0];
      skipping = !keep.has(name);
      if (!skipping) kept++;
    } else if (!inCode && line.startsWith("## ")) skipping = false;
    if (line.startsWith("```")) inCode = !inCode;
    if (skipping || (!inCode && FULL_ONLY.test(line))) continue;
    out.push(line);
  }
  return out
    .join("\n")
    .replace(/^## npm packages \(\d+\)$/m, `## npm packages (${kept})`)
    .replace("It is built on the open source software below.", "This is BubbleFacts Lite: it has no AI engine and downloads no AI model. It is built on the open source software below.")
    .replace(" Packages built for one system, such as the AI engine's binaries, differ between the Mac, Windows and Linux apps; their licenses are the same.", "");
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const file = path.join(root, "package.json");
  const original = fs.readFileSync(file, "utf8");
  const pkg = JSON.parse(original);
  if (pkg.bubblefacts?.edition === "lite") throw new Error("package.json is already the Lite one: put the full one back first (git checkout package.json)");
  const restore = () => fs.writeFileSync(file, original);
  const onSignal = (signal) => {
    restore();
    process.kill(process.pid, signal);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, onSignal);
  let status = 1;
  const noticesDir = path.join(root, NOTICES_DIR);
  try {
    const tree = JSON.parse(execFileSync("npm", ["ls", "--omit=dev", "--all", "--json"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
    fs.mkdirSync(noticesDir, { recursive: true });
    fs.writeFileSync(path.join(noticesDir, NOTICES), liteNotices(fs.readFileSync(path.join(root, NOTICES), "utf8"), liteKeep(tree)));
    fs.writeFileSync(file, JSON.stringify(liteManifest(pkg), null, 2) + "\n");
    const bin = path.join(root, "node_modules", "electron-builder", "cli.js");
    status = spawnSync(process.execPath, [bin, "--publish", "never", ...process.argv.slice(2)], { cwd: root, stdio: "inherit" }).status ?? 1;
  } finally {
    restore();
    fs.rmSync(noticesDir, { recursive: true, force: true });
  }
  process.exit(status);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
