// Unsigned builds only: give the Mac app an ad-hoc signature. Without one, Apple
// silicon Macs report the downloaded app as "damaged" instead of unverified.
// Remove this once builds are signed with an Apple Developer ID.
const { execFileSync } = require("child_process");
const path = require("path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin" || process.env.CSC_LINK) return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  // Finder and iCloud metadata on copied files makes codesign refuse the bundle.
  execFileSync("xattr", ["-cr", app]);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
};
