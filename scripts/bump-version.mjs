#!/usr/bin/env node
// Sets a new version everywhere a release needs it: `npm run bump -- 2.0.0-beta.12`.
// package.json and package-lock.json (through npm version), the overlay's header,
// the beta test form's version list and the bug form's example, and a dated
// changelog entry to fill in. Safe to run again: what's already done is left alone.
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const VERSION_IN_TEXT = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?`;

export function checkVersion(version) {
  if (!SEMVER.test(version ?? "")) throw new Error(`"${version ?? ""}" isn't a version like 2.0.0-beta.12`);
  return version;
}

/** The overlay's header names its version on a line like " * v2.0.0-beta.11". */
export function bumpOverlay(text, version) {
  const re = new RegExp(String.raw`^( \* )v${VERSION_IN_TEXT}[ \t]*$`, "m");
  if (!re.test(text)) throw new Error("obs-overlay.js has no version line in its header");
  return text.replace(re, `$1v${version}`);
}

/** Adds the version at the top of the beta form's version list, once. */
export function bumpBetaForm(text, version) {
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const field = lines.findIndex((l) => /^\s+id: version\s*$/.test(l));
  const options = lines.findIndex((l, i) => i > field && /^\s+options:\s*$/.test(l));
  if (field < 0 || options < 0) throw new Error("beta_test.yml has no version list");
  const first = options + 1;
  const indent = /^(\s+)- /.exec(lines[first])?.[1];
  if (!indent) throw new Error("beta_test.yml's version list is empty");
  let end = first;
  while (end < lines.length && lines[end].startsWith(`${indent}- `)) end++;
  if (lines.slice(first, end).some((l) => l.trim() === `- ${version}`)) return text;
  lines.splice(first, 0, `${indent}- ${version}`);
  return lines.join(nl);
}

/** The bug form's version example: "for example 2.0.0-beta.11." */
export function bumpBugForm(text, version) {
  const re = new RegExp(String.raw`(for example )${VERSION_IN_TEXT}(?=\.)`);
  if (!re.test(text)) throw new Error("bug_report.yml has no version example");
  return text.replace(re, `$1${version}`);
}

/** The changelog's anchor for a version: v2 (2.0.0), v2-1 (2.1.0), v2-0-1, v2-beta12, v2-rc1. */
export function changelogId(version) {
  const [core, pre] = version.split(/-(.*)/s);
  const [major, minor, patch] = core.split(".");
  const base = patch !== "0" ? `v${major}-${minor}-${patch}` : minor !== "0" ? `v${major}-${minor}` : `v${major}`;
  return pre ? `${base}-${pre.replace(/\./g, "")}` : base;
}

export function changelogDate(date) {
  return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

/** A dated entry at the top of the changelog, with its lines marked FILL IN, unless the version has one. */
export function addChangelogStub(html, version, date) {
  const id = changelogId(version);
  if (html.includes(`id="${id}"`) || html.includes(`>Version ${version} <`)) return html;
  const marker = '        <article class="rpg release"';
  const at = html.indexOf(marker);
  if (at < 0) throw new Error("changelog.html has no release entries to go above");
  const kind = /-rc/.test(version) ? "Release candidate, " : /-/.test(version) ? "Beta, " : "";
  const nl = html.includes("\r\n") ? "\r\n" : "\n";
  const stub = [
    `        <article class="rpg release" aria-labelledby="${id}">`,
    `          <h2 id="${id}">Version ${version} <span class="tag">${kind}${changelogDate(date)}</span></h2>`,
    "          <p>FILL IN: what this version is about, in one line.</p>",
    "          <ul>",
    "            <li>New: FILL IN</li>",
    "            <li>Improved: FILL IN</li>",
    "            <li>Fixed: FILL IN</li>",
    "          </ul>",
    "        </article>",
    "",
    "",
  ].join(nl);
  return html.slice(0, at) + stub + html.slice(at);
}

function main() {
  const version = checkVersion(process.argv[2]);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const edit = (file, change) => {
    const full = path.join(root, file);
    const before = fs.readFileSync(full, "utf8");
    const after = change(before);
    if (after !== before) fs.writeFileSync(full, after);
    console.log(`${after !== before ? "updated" : "already done"}  ${file}`);
  };
  // npm version also updates package-lock.json. --allow-same-version keeps a second run from failing.
  execFileSync("npm", ["version", version, "--no-git-tag-version", "--allow-same-version"], { cwd: root, stdio: "ignore", shell: process.platform === "win32" });
  console.log(`set ${version}  package.json, package-lock.json`);
  edit("frontend/obs/obs-overlay.js", (t) => bumpOverlay(t, version));
  edit(".github/ISSUE_TEMPLATE/beta_test.yml", (t) => bumpBetaForm(t, version));
  edit(".github/ISSUE_TEMPLATE/bug_report.yml", (t) => bumpBugForm(t, version));
  edit("site/changelog.html", (t) => addChangelogStub(t, version, new Date()));
  console.log("Next: fill in the FILL IN lines in site/changelog.html, then run npm run check.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
