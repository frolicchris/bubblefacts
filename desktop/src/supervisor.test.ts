import { EventEmitter } from "events";

jest.mock("electron", () => ({ utilityProcess: { fork: jest.fn() } }));
const forks: FakeProc[] = [];
class FakeProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  connected = true;
  kill = jest.fn();
  send = jest.fn();
}
jest.mock("child_process", () => ({
  fork: jest.fn(() => {
    const p = new FakeProc();
    forks.push(p);
    return p;
  }),
}));

import fs from "fs";
import os from "os";
import path from "path";
import { Supervisor, Health } from "./supervisor";

const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "bubblefacts-supervisor-"));
afterAll(() => fs.rmSync(logDir, { recursive: true, force: true }));

const health = (over: Record<string, unknown> = {}): Health =>
  ({ status: "ok", currentSong: null, eventsConnected: true, obsClients: 0, clients: [], lastQueueFetchAgeMs: 1000, facts: {}, ...over }) as Health;

let answer: () => Health | Error;
let sup: Supervisor;

beforeEach(() => {
  jest.useFakeTimers();
  forks.length = 0;
  answer = () => health();
  global.fetch = jest.fn(async () => {
    const a = answer();
    if (a instanceof Error) throw a;
    return { json: async () => a } as Response;
  }) as unknown as typeof fetch;
  sup = new Supervisor("server.js", logDir, "node");
  sup.restart({ PORT: "3000", AI_PROVIDER: "none" });
});
afterEach(() => {
  sup.stop();
  jest.useRealTimers();
});

const run = (ms: number) => jest.advanceTimersByTimeAsync(ms);
/** The server answers one health check, then dies. */
const crashAfterGoodCheck = async () => {
  await run(5_000);
  forks[forks.length - 1].emit("exit", 1);
};

describe("crash restarts (restart history)", () => {
  it("backs off and reaches failing when the server crashes after each good health check", async () => {
    for (let i = 0; i < 4; i++) {
      await crashAfterGoodCheck();
      await run(70_000); // longer than the longest backoff, so it has relaunched
    }
    expect(sup.status.state).toBe("running");
    await crashAfterGoodCheck(); // the 5th within ten minutes
    expect(sup.status.state).toBe("failing");
  });

  it("waits longer after each crash instead of restarting every 2 seconds", async () => {
    await crashAfterGoodCheck(); // 1st: 1 s
    await run(1_000);
    expect(forks).toHaveLength(2);
    await crashAfterGoodCheck(); // 2nd: 2 s
    await run(1_900);
    expect(forks).toHaveLength(2);
    await run(100);
    expect(forks).toHaveLength(3);
    await crashAfterGoodCheck(); // 3rd: 4 s
    await run(3_900);
    expect(forks).toHaveLength(3);
    await run(100);
    expect(forks).toHaveLength(4);
  });

  it("forgets earlier crashes after several minutes of steady health", async () => {
    for (let i = 0; i < 3; i++) {
      await crashAfterGoodCheck();
      await run(10_000);
    }
    await run(6 * 60_000); // steady
    forks[forks.length - 1].emit("exit", 1);
    const before = forks.length;
    await run(1_000); // back to the first, 1 second wait
    expect(forks).toHaveLength(before + 1);
  });
});

describe("a degraded song-list connection", () => {
  const degraded = (poll: number | null | undefined, degradedReason = "no successful queue fetch recently") => () =>
    health({ status: "degraded", degradedReason, lastPollAttemptAgeMs: poll, pollIntervalMs: 15_000 });

  it("keeps the server running through an outage while the server keeps trying", async () => {
    answer = degraded(4_000);
    await run(10 * 60_000);
    expect(forks).toHaveLength(1);
    expect(sup.status.state).toBe("running");
    expect(sup.status.message).toMatch(/Reconnecting/);
  });

  it("restarts the server when its polling loop has stopped trying", async () => {
    answer = degraded(200_000);
    await run(3 * 60_000);
    expect(sup.status.restarts).toBe(1);
  });

  it("allows slow polling three misses before calling the loop stuck", async () => {
    answer = () => health({ status: "degraded", degradedReason: "no successful queue fetch recently", lastPollAttemptAgeMs: 400_000, pollIntervalMs: 300_000 });
    await run(10 * 60_000);
    expect(sup.status.restarts).toBe(0);
  });

  it("still restarts for a problem that isn't an outage, such as a song not followed", async () => {
    answer = degraded(4_000, "StreamElements is playing a song that isn't being followed");
    await run(3 * 60_000);
    expect(sup.status.restarts).toBe(1);
  });

  it("still restarts a server that doesn't report its attempts", async () => {
    answer = degraded(undefined);
    await run(3 * 60_000);
    expect(sup.status.restarts).toBe(1);
  });
});
