import { buildInfo, editionOf, versionLabel } from "./build";

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

  it("names Lite after the version, and nothing for the full app", () => {
    const release = buildInfo({ bubblefacts: { build: { commit: "c4ee826", kind: "release" } } });
    expect(versionLabel("2.2.0", release, "lite")).toBe("2.2.0 Lite (c4ee826)");
    expect(versionLabel("2.2.0", buildInfo({}), "lite")).toBe("2.2.0 Lite (dev)");
    expect(versionLabel("2.2.0", release, "full")).toBe("2.2.0 (c4ee826)");
  });
});

describe("edition", () => {
  it("is Lite only when the build says so, and the full app otherwise", () => {
    expect(editionOf({ bubblefacts: { edition: "lite" } })).toBe("lite");
    expect(editionOf({ bubblefacts: { edition: "full" } })).toBe("full");
    expect(editionOf({ bubblefacts: { edition: "LITE" } })).toBe("full");
    expect(editionOf({ bubblefacts: {} })).toBe("full");
    expect(editionOf({})).toBe("full");
  });
});
