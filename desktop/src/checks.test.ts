import { compareVersions, newerRelease, testStreamElements } from "./checks";

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
