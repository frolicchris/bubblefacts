import { compareVersions, newerRelease } from "./checks";

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;
const releases = (...list: Array<[string, boolean?]>) => ({
  ok: true,
  json: async () => list.map(([tag, prerelease = false]) => ({ tag_name: tag, draft: false, prerelease })),
});

describe("compareVersions", () => {
  it.each([
    ["2.0.0", "1.9.9", 1],
    ["2.0.0", "2.0.0", 0],
    ["2.0.0-beta.1", "2.0.0", -1],
    ["2.0.0-beta.2", "2.0.0-beta.1", 1],
    ["2.0.0-beta.10", "2.0.0-beta.9", 1],
    ["2.0.0-rc.1", "2.0.0-beta.3", 1],
    ["v2.1.0", "2.0.0-beta.1", 1],
  ])("%s vs %s", (a, b, want) => expect(compareVersions(a, b)).toBe(want));
});

describe("newerRelease", () => {
  afterEach(() => mockFetch.mockReset());

  it("tells a beta tester about the next beta", async () => {
    mockFetch.mockResolvedValueOnce(releases(["v2.0.0-beta.2", true], ["v2.0.0-beta.1", true], ["v1.0.0"]));
    await expect(newerRelease("2.0.0-beta.1")).resolves.toMatchObject({ version: "2.0.0-beta.2" });
  });

  it("doesn't offer betas to someone on a full release", async () => {
    mockFetch.mockResolvedValueOnce(releases(["v2.1.0-beta.1", true], ["v2.0.0"]));
    await expect(newerRelease("2.0.0")).resolves.toBeNull();
  });

  it("stays quiet when offline", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(newerRelease("2.0.0")).resolves.toBeNull();
  });
});
