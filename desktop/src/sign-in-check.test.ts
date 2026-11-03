import { RECHECK_MS, SignInCheck, TokenCheck, VALIDATE_URL, validateToken } from "./sign-in-check";

const answer = (status: number, body?: unknown, bad = false) =>
  jest.fn().mockResolvedValue({ status, ok: status < 400, json: async () => (bad ? Promise.reject(new SyntaxError("not JSON")) : body) }) as unknown as typeof fetch;

describe("asking StreamerSongList whether the sign-in holds (issue #182)", () => {
  it("asks the validate address with the token as a Bearer token", async () => {
    const f = answer(200, { client_id: "made-up-client", expires_in: 3000 });
    expect(await validateToken("tok-1", f)).toBe("valid");
    const [url, init] = (f as unknown as jest.Mock).mock.calls[0];
    expect(url).toBe(VALIDATE_URL);
    expect(init.headers).toMatchObject({ Authorization: "Bearer tok-1" });
  });

  it("calls only a plain 401 expired", async () => {
    expect(await validateToken("t", answer(401, { status: 401, message: "invalid access token" }))).toBe("expired");
    expect(await validateToken("t", answer(401, undefined, true))).toBe("expired");
  });

  it("can't tell from an outage, a refusal of another kind, or an unknown answer", async () => {
    expect(await validateToken("t", answer(500, {}))).toBe("unknown");
    expect(await validateToken("t", answer(503, {}))).toBe("unknown");
    expect(await validateToken("t", answer(403, {}))).toBe("unknown");
    expect(await validateToken("t", answer(429, {}))).toBe("unknown");
    expect(await validateToken("t", answer(404, {}))).toBe("unknown");
    // A 200 that isn't a JSON object: a maintenance page, say.
    expect(await validateToken("t", answer(200, undefined, true))).toBe("unknown");
    expect(await validateToken("t", answer(200, "ok"))).toBe("unknown");
    expect(await validateToken("t", answer(200, ["x"]))).toBe("unknown");
    const offline = jest.fn().mockRejectedValue(new TypeError("fetch failed")) as unknown as typeof fetch;
    expect(await validateToken("t", offline)).toBe("unknown");
  });
});

describe("what a check leads to", () => {
  function setup(results: TokenCheck[]) {
    let now = 1_000_000;
    const validate = jest.fn(async () => results.shift() ?? "valid");
    const refresh = jest.fn(async () => undefined);
    const down = jest.fn();
    const lines: string[] = [];
    const check = new SignInCheck({ validate, refresh, log: (l) => lines.push(l), songListDown: down, now: () => now });
    return { check, validate, refresh, down, lines, later: (ms: number) => (now += ms) };
  }

  it("refreshes an access token called expired, instead of asking the musician to sign in", async () => {
    const t = setup(["expired"]);
    await t.check.check("start", "old-token");
    expect(t.refresh).toHaveBeenCalledTimes(1);
  });

  it("does nothing more when it can't tell", async () => {
    const t = setup(["unknown"]);
    await t.check.check("queue", "tok");
    expect(t.refresh).not.toHaveBeenCalled();
    expect(t.down).toHaveBeenCalledWith(false);
  });

  it("says StreamerSongList is down, not the sign-in, when the queue fails and the sign-in holds", async () => {
    const t = setup(["valid"]);
    await t.check.check("queue", "tok");
    expect(t.down).toHaveBeenLastCalledWith(true);
    expect(t.refresh).not.toHaveBeenCalled();
  });

  it("asks rarely while the queue keeps failing", async () => {
    const t = setup([]);
    await t.check.check("queue", "tok");
    await t.check.check("queue", "tok");
    t.later(RECHECK_MS - 1);
    await t.check.check("queue", "tok");
    expect(t.validate).toHaveBeenCalledTimes(1);
    t.later(1);
    await t.check.check("queue", "tok");
    expect(t.validate).toHaveBeenCalledTimes(2);
  });

  it("stops trusting the check when a just-refreshed token is called expired too", async () => {
    const t = setup(["expired", "expired"]);
    await t.check.check("refresh", "new-token");
    expect(t.refresh).not.toHaveBeenCalled();
    await t.check.check("queue", "new-token");
    await t.check.check("start", "new-token");
    expect(t.validate).toHaveBeenCalledTimes(1);
  });

  it("never writes the token in the log", async () => {
    const t = setup(["expired", "valid", "unknown"]);
    await t.check.check("start", "secret-token-123");
    await t.check.check("refresh", "secret-token-456");
    t.later(RECHECK_MS);
    await t.check.check("queue", "secret-token-456");
    expect(t.lines.length).toBeGreaterThan(0);
    expect(t.lines.join("\n")).not.toMatch(/secret-token/);
  });
});
