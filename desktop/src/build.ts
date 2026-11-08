// Which build this is: release (v* tag), test build (Run workflow) or dev (npm run app, a local dist).
// The Release workflow writes commit and kind into package.json for that build only; the version never
// changes for a test build, as the updater compares it

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

/** Which installer: "full", or "lite" (no AI engine; retired, being removed) */
export type Edition = "full" | "lite";

export function editionOf(pkg: { bubblefacts?: { edition?: unknown } }): Edition {
  return pkg.bubblefacts?.edition === "lite" ? "lite" : "full";
}

/** "2.0.0-beta.12 (c4ee826)", "2.0.0-beta.12 test build (c4ee826)", "2.0.0-beta.12 (dev)"; Lite adds "Lite" after the version */
export function versionLabel(version: string, build: BuildInfo, edition: Edition = "full"): string {
  const named = edition === "lite" ? `${version} Lite` : version;
  if (build.kind === "dev") return `${named} (dev)`;
  return `${named}${build.kind === "test" ? " test build" : ""} (${build.commit})`;
}
