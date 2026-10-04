import { buildInfo, versionLabel } from "./build";

describe("build ID", () => {
  it("labels a release, a test build and a dev build", () => {
    const release = buildInfo({ bubblefacts: { build: { commit: "c4ee826", kind: "release" } } });
    const test = buildInfo({ bubblefacts: { build: { commit: "c4ee8261f00dbeef", kind: "test" } } });
    const dev = buildInfo({ bubblefacts: {} });
    expect(versionLabel("2.0.0-beta.12", release)).toBe("2.0.0-beta.12 (c4ee826)");
    expect(versionLabel("2.0.0-beta.12", test)).toBe("2.0.0-beta.12 test build (c4ee826)");
    expect(versionLabel("2.0.0-beta.12", dev)).toBe("2.0.0-beta.12 (dev)");
  });

  it("treats anything unexpected as a test build or dev, never a release", () => {
    expect(buildInfo({ bubblefacts: { build: { commit: "c4ee826", kind: "something" } } }).kind).toBe("test");
    expect(buildInfo({ bubblefacts: { build: { commit: "not a commit", kind: "release" } } }).kind).toBe("dev");
    expect(buildInfo({}).kind).toBe("dev");
  });
});
