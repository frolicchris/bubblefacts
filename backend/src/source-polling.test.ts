import { debounce, retryAfterMs, singleFlight } from "./source-polling";

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
