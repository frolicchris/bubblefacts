import { compareVersions, newerRelease, testStreamElements } from "./checks";

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;
const LONG_AGO = "2026-01-01T00:00:00Z";
const releases = (...list: Array<[string, boolean?, string?]>) => ({
  ok: true,
  json: async () => list.map(([tag, prerelease = false, published_at = LONG_AGO]) => ({ tag_name: tag, draft: false, prerelease, published_at })),
});

describe("compareVersions", () => {
  it.each([
    ["2.0.0", "1.9.9", 1],
    ["2.0.0", "2.0.0", 0],
    ["2.0.0-beta.1", "2.0.0", -1],
    ["2.0.0-beta.2", "2.0.0-beta.1", 1],
    ["2.0.0-beta.10", "2.0.0-beta.9", 1],
    ["2.0.0-rc.1", "2.0.0-beta.3", 1],
    ["2.0.0-rc.1", "2.0.0-beta.12", 1],
    ["2.0.0-rc.2", "2.0.0-rc.1", 1],
    ["2.0.0", "2.0.0-rc.2", 1],
    ["v2.1.0", "2.0.0-beta.1", 1],
  ])("%s vs %s", (a, b, want) => expect(compareVersions(a, b)).toBe(want));
});

describe("newerRelease", () => {
  afterEach(() => mockFetch.mockReset());

  it("offers a new full release to Beta at once and to Stable three days later", async () => {
    const out = "2026-11-01T12:00:00Z";
    const day = 24 * 60 * 60 * 1000;
    const at = (days: number) => Date.parse(out) + days * day;
    mockFetch.mockResolvedValueOnce(releases(["v2.0.1", false, out], ["v2.0.0"]));
    await expect(newerRelease("2.0.0", "beta", () => null, at(0.1))).resolves.toMatchObject({ version: "2.0.1" });
    mockFetch.mockResolvedValueOnce(releases(["v2.0.1", false, out], ["v2.0.0"]));
    await expect(newerRelease("2.0.0", "stable", () => null, at(1))).resolves.toBeNull();
    mockFetch.mockResolvedValueOnce(releases(["v2.0.1", false, out], ["v2.0.0"]));
    await expect(newerRelease("2.0.0", "stable", () => null, at(3))).resolves.toMatchObject({ version: "2.0.1" });
  });
  const offered = async (current: string, channel: "stable" | "beta", ...list: Array<[string, boolean?]>) => {
    mockFetch.mockResolvedValueOnce(releases(...list));
    return (await newerRelease(current, channel))?.version ?? null;
  };

  it("tells a beta tester about the next beta", async () => {
    await expect(offered("2.0.0-beta.1", "beta", ["v2.0.0-beta.2", true], ["v2.0.0-beta.1", true], ["v1.0.0"])).resolves.toBe("2.0.0-beta.2");
  });

  it("takes a beta tester from beta.12 to the release candidate, then to the full release", async () => {
    await expect(offered("2.0.0-beta.12", "beta", ["v2.0.0-rc.1", true], ["v2.0.0-beta.12", true], ["v2.0.0-beta.11", true])).resolves.toBe("2.0.0-rc.1");
    await expect(offered("2.0.0-rc.1", "beta", ["v2.0.0"], ["v2.0.0-rc.1", true])).resolves.toBe("2.0.0");
  });

  it("takes someone on an older beta straight to the full release once it's out", async () => {
    await expect(offered("2.0.0-beta.9", "beta", ["v2.0.0"], ["v2.0.0-rc.1", true], ["v2.0.0-beta.12", true], ["v2.0.0-beta.9", true])).resolves.toBe("2.0.0");
  });

  it("offers Beta the newest of betas and full releases alike", async () => {
    await expect(offered("2.0.0", "beta", ["v2.1.0-beta.1", true], ["v2.0.0"])).resolves.toBe("2.1.0-beta.1");
    await expect(offered("2.0.0-rc.2", "beta", ["v2.0.1"], ["v2.0.0"], ["v2.0.0-rc.2", true])).resolves.toBe("2.0.1");
  });

  it("offers Stable only full releases", async () => {
    await expect(offered("2.0.0", "stable", ["v2.1.0-beta.1", true], ["v2.0.0"])).resolves.toBeNull();
    await expect(offered("2.0.0", "stable", ["v2.1.0-beta.2", true], ["v2.0.1"], ["v2.1.0-beta.1", true])).resolves.toBe("2.0.1");
    // A tag with a "-" counts as a prerelease even when GitHub wasn't told.
    await expect(offered("2.0.0", "stable", ["v2.1.0-rc.1", false])).resolves.toBeNull();
  });

  it("never goes back a version after switching to Stable", async () => {
    await expect(offered("2.1.0-beta.2", "stable", ["v2.1.0-beta.2", true], ["v2.1.0-beta.1", true], ["v2.0.0"])).resolves.toBeNull();
    await expect(offered("2.1.0-beta.2", "stable", ["v2.1.0"], ["v2.1.0-rc.1", true], ["v2.1.0-beta.2", true], ["v2.0.0"])).resolves.toBe("2.1.0");
  });

  it("stays quiet when offline", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(newerRelease("2.0.0", "beta")).resolves.toBeNull();
  });
});

describe("testStreamElements", () => {
  const res = (status: number, body: unknown = {}) => ({ ok: status < 300, status, json: async () => body });
  afterEach(() => mockFetch.mockReset());

  it("finds the token's channel and checks it can read the song requests", async () => {
    mockFetch
      .mockResolvedValueOnce(res(200, { _id: "5b2e2007760aeb7729487dab", username: "JanePlays" }))
      .mockResolvedValueOnce(res(404))
      .mockResolvedValueOnce(res(200, { state: "paused" }));
    await expect(testStreamElements("janeplays", " jwt-1 ")).resolves.toEqual({ ok: true, channel: "JanePlays", id: "5b2e2007760aeb7729487dab" });
    expect(mockFetch.mock.calls[0][0]).toMatch(/\/channels\/me$/);
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe("Bearer jwt-1");
    expect(mockFetch.mock.calls[1][0]).toMatch(/\/songrequest\/5b2e2007760aeb7729487dab\/playing$/);
    expect(mockFetch.mock.calls[2][0]).toMatch(/\/player$/);
  });

  it("explains each failure in plain words", async () => {
    await expect(testStreamElements("jane", "")).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/Paste/) });

    mockFetch.mockResolvedValueOnce(res(401));
    await expect(testStreamElements("jane", "bad")).resolves.toMatchObject({ reason: expect.stringMatching(/didn't accept/) });

    mockFetch.mockResolvedValueOnce(res(200, { _id: "id", username: "someoneelse" }));
    await expect(testStreamElements("jane", "jwt")).resolves.toMatchObject({ reason: expect.stringMatching(/"someoneelse", not "jane"/) });

    mockFetch.mockResolvedValueOnce(res(200, { _id: "id", username: "jane" })).mockResolvedValueOnce(res(200)).mockResolvedValueOnce(res(403));
    await expect(testStreamElements("", "jwt")).resolves.toMatchObject({ reason: expect.stringMatching(/can't read your song requests/) });

    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(testStreamElements("jane", "jwt")).resolves.toMatchObject({ reason: expect.stringMatching(/Couldn't reach/) });
  });
});
