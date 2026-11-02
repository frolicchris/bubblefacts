#!/usr/bin/env node
// Builds BubbleFacts Lite, the installers with no AI engine: `npm run dist:lite -- --mac --arm64`.
// Takes the same arguments as `npm run dist` (electron-builder's), including -c.* options.
//
// Lite is the full app's package.json with three changes (liteManifest below): no node-llama-cpp
// or its native builds, installers named with "-lite" and built into release-lite/, and
// "edition": "lite" written into the app's package.json, which the app reads (desktop/src/build.ts).
// electron-builder only takes its file list from package.json, so package.json is swapped
// for the Lite one while it runs, then put back exactly as it was, whatever happens.
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/** The AI engine: the package and its prebuilt native builds. */
const ENGINE = /node-llama-cpp/;

/** The full package.json made into Lite's. Pure, so the tests can check it. */
export function liteManifest(pkg) {
  const lite = structuredClone(pkg);
  // Not a dependency, so electron-builder leaves it and everything only it needs out of the app.
  delete lite.dependencies["node-llama-cpp"];
  lite.bubblefacts = { ...lite.bubblefacts, edition: "lite" };
  const build = lite.build;
  build.directories = { ...build.directories, output: "release-lite" };
  // And never copied in by a pattern, even if the dependency comes back by another route.
  build.files = [...build.files.filter((f) => !ENGINE.test(f)), "!node_modules/node-llama-cpp{,/**/*}", "!node_modules/@node-llama-cpp{,/**/*}"];
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
  try {
    fs.writeFileSync(file, JSON.stringify(liteManifest(pkg), null, 2) + "\n");
    const bin = path.join(root, "node_modules", "electron-builder", "cli.js");
    status = spawnSync(process.execPath, [bin, "--publish", "never", ...process.argv.slice(2)], { cwd: root, stdio: "inherit" }).status ?? 1;
  } finally {
    restore();
  }
  process.exit(status);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
