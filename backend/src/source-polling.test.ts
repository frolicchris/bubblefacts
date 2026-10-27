import { debounce, pollLoop, retryAfterMs, singleFlight } from "./source-polling";

describe("retryAfterMs", () => {
  it("waits as long as Retry-After says, at most ten minutes", () => {
    expect(retryAfterMs({ status: 429, headers: new Headers({ "retry-after": "30" }) })).toBe(30_000);
    expect(retryAfterMs({ status: 503, headers: new Headers({ "retry-after": "5000" }) })).toBe(600_000);
  });
  it("falls back to a minute for 429 and two for 503", () => {
    expect(retryAfterMs({ status: 429 })).toBe(60_000);
    expect(retryAfterMs({ status: 503, headers: new Headers() })).toBe(120_000);
  });
  it("is zero for any other status", () => {
    expect(retryAfterMs({ status: 500, headers: new Headers({ "retry-after": "30" }) })).toBe(0);
  });
});

describe("singleFlight", () => {
  it("fetches once more after a call made while one was running", async () => {
    let calls = 0;
    const run = singleFlight(async () => {
      calls++;
      await Promise.resolve();
    }, () => false);
    const first = run();
    void run();
    void run();
    await first;
    expect(calls).toBe(2);
  });
  it("doesn't fetch again once stopped", async () => {
    let calls = 0;
    const run = singleFlight(async () => void calls++, () => true);
    const first = run();
    void run();
    await first;
    expect(calls).toBe(1);
  });
});

describe("debounce", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  it("turns a burst into one call, and cancel drops it", () => {
    const fn = jest.fn();
    const d = debounce(250, fn);
    d.run();
    d.run();
    jest.advanceTimersByTime(250);
    expect(fn).toHaveBeenCalledTimes(1);
    d.run();
    d.cancel();
    jest.advanceTimersByTime(250);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("pollLoop attempts", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  const make = (tick: () => Promise<void>) =>
    pollLoop({ isStopped: () => false, intervalMs: () => 15_000, backoffUntil: () => 0, tick });

  it("has no attempt until it is set going", () => {
    expect(make(async () => {}).lastAttemptAgeMs()).toBeNull();
  });

  it("keeps the age small while every fetch fails", async () => {
    const loop = make(async () => {
      // pollOnce handles its own errors, so a failed fetch is a tick that ends quietly.
    });
    loop.schedule();
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(loop.lastAttemptAgeMs()).toBeLessThanOrEqual(15_000);
    loop.cancel();
  });

  it("lets the age grow when a tick never finishes", async () => {
    const loop = make(() => new Promise<void>(() => {}));
    loop.schedule();
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(loop.lastAttemptAgeMs()).toBeGreaterThan(9 * 60_000);
    loop.cancel();
  });
});
