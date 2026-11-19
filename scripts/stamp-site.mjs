#!/usr/bin/env node
// Restamps every site page's stylesheet and script links after site.css or
// site.js changes (`npm run stamp-site`). `npm run check` fails until it's run.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { bumpSiteAssets, siteAssetStamps } from "./bump-version.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stamps = siteAssetStamps(root);
for (const page of fs.readdirSync(path.join(root, "site")).filter((f) => f.endsWith(".html")).sort()) {
  const full = path.join(root, "site", page);
  const before = fs.readFileSync(full, "utf8");
  const after = bumpSiteAssets(before, stamps);
  if (after !== before) {
    fs.writeFileSync(full, after);
    console.log(`stamped  site/${page}`);
  }
}
