/**
 * Which build this is: the commit it was built from, and whether it's a
 * release (a v* tag) or a test build (Run workflow). The Release workflow
 * writes both into package.json for that build only, like the YouTube key;
 * anything else (npm run app, a local npm run dist) is "dev". The version
 * number itself never changes for a test build: the updater compares it.
 */
export interface BuildInfo {
  commit: string;
  kind: "release" | "test" | "dev";
}

export function buildInfo(pkg: { bubblefacts?: { build?: { commit?: unknown; kind?: unknown } } }): BuildInfo {
  const b = pkg.bubblefacts?.build;
  const commit = typeof b?.commit === "string" && /^[0-9a-f]{7,40}$/.test(b.commit) ? b.commit.slice(0, 7) : "";
  if (!commit) return { commit: "", kind: "dev" };
  return { commit, kind: b?.kind === "release" ? "release" : "test" };
}

/**
 * Which installer this is. "full" has the built-in AI; "lite" is BubbleFacts
 * Lite, built without the AI engine (scripts/dist-lite.mjs writes "lite" into
 * its package.json). Lite never downloads a model: songs get facts that need
 * no AI, unless the streamer chooses an online AI or their own Ollama, which Lite offers.
 */
export type Edition = "full" | "lite";

export function editionOf(pkg: { bubblefacts?: { edition?: unknown } }): Edition {
  return pkg.bubblefacts?.edition === "lite" ? "lite" : "full";
}

/**
 * What the app shows and reports: "2.0.0-beta.12 (c4ee826)", "2.0.0-beta.12 test build (c4ee826)",
 * or "2.0.0-beta.12 (dev)", with "Lite" after the version for Lite: "2.0.0-beta.12 Lite (c4ee826)".
 */
export function versionLabel(version: string, build: BuildInfo, edition: Edition = "full"): string {
  const named = edition === "lite" ? `${version} Lite` : version;
  if (build.kind === "dev") return `${named} (dev)`;
  return `${named}${build.kind === "test" ? " test build" : ""} (${build.commit})`;
}
