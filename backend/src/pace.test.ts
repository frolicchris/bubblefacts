import { busyThreads, CALM_SAMPLES, CpuWatch, cpuTimes, LATE_MS, ON_TIME_MS, othersCpuShare, PaceKeeper, paceLine, QUICK_PROBE_EVERY, RECOVER_SONGS, shorterContext, wordsPerSecond } from "./pace";

/** Plays a song whose AI facts came after `ms` */
function onTime(p: PaceKeeper, ms: number): void {
  p.songStarted();
  p.ready(ms);
}

describe("keeping up with a slow computer (issue #314)", () => {
  it("asks for everything while facts come in time", () => {
    const p = new PaceKeeper();
    for (let i = 0; i < 5; i++) onTime(p, 20_000);
    expect(p.pace()).toBe("full");
    expect(p.aiThisSong()).toBe(true);
    expect(p.ask()).toBe("full");
  });

  it("asks for less once facts are late on average over the last few songs", () => {
    const p = new PaceKeeper();
    onTime(p, LATE_MS + 30_000);
    // One long song may have been a long article
    expect(p.pace()).toBe("full");
    onTime(p, LATE_MS + 30_000);
    expect(p.pace()).toBe("short");
    expect(p.ask()).toBe("short");
    expect(p.aiThisSong()).toBe(true);
  });

  it("isn't thrown by one late song among quick ones", () => {
    const p = new PaceKeeper();
    onTime(p, 10_000);
    onTime(p, 10_000);
    onTime(p, LATE_MS + 20_000);
    expect(p.pace()).toBe("full");
  });

  it("shows quick facts only once a song ended before its AI facts came", () => {
    const p = new PaceKeeper();
    p.songStarted();
    p.missed(3 * 60_000);
    expect(p.pace()).toBe("quick");
    p.songStarted();
    expect(p.aiThisSong()).toBe(false);
  });

  it("doesn't count a song skipped before its facts could have been late", () => {
    const p = new PaceKeeper();
    p.songStarted();
    p.missed(LATE_MS - 1);
    expect(p.pace()).toBe("full");
  });

  it("tries the AI every few songs in quick mode, and steps up when it was on time", () => {
    const p = new PaceKeeper();
    p.missed(3 * 60_000);
    const tries: boolean[] = [];
    for (let i = 0; i < QUICK_PROBE_EVERY; i++) {
      p.songStarted();
      tries.push(p.aiThisSong());
    }
    expect(tries).toEqual([...Array(QUICK_PROBE_EVERY - 1).fill(false), true]);
    // The try is asked the short way
    expect(p.ask()).toBe("short");
    p.ready(40_000);
    expect(p.pace()).toBe("short");
  });

  it("waits for the next try when a try was late but before the song ended", () => {
    const p = new PaceKeeper();
    p.missed(3 * 60_000);
    for (let i = 0; i < QUICK_PROBE_EVERY; i++) p.songStarted();
    p.ready(LATE_MS + 10_000);
    expect(p.pace()).toBe("quick");
    p.songStarted();
    expect(p.aiThisSong()).toBe(false);
  });

  it("recovers fully after a few on-time songs", () => {
    const p = new PaceKeeper();
    onTime(p, 90_000);
    onTime(p, 90_000);
    expect(p.pace()).toBe("short");
    for (let i = 0; i < RECOVER_SONGS - 1; i++) onTime(p, ON_TIME_MS);
    expect(p.pace()).toBe("short");
    onTime(p, ON_TIME_MS);
    expect(p.pace()).toBe("full");
  });

  it("needs the on-time songs in a row to recover", () => {
    const p = new PaceKeeper();
    onTime(p, 90_000);
    onTime(p, 90_000);
    for (let i = 0; i < RECOVER_SONGS - 1; i++) onTime(p, 10_000);
    onTime(p, ON_TIME_MS + 5_000);
    onTime(p, 10_000);
    expect(p.pace()).toBe("short");
  });

  it("says so on the dashboard in plain words", () => {
    expect(paceLine("full")).toBe("");
    expect(paceLine("short")).toBe("Your computer is busy, so fewer facts");
    expect(paceLine("quick")).toBe("Your computer is busy, so quick facts only");
  });
});

describe("the shorter part of the article", () => {
  const sentence = "Wren Halloway wrote the song on a ferry in one night. ";
  const article = `Slow Ferry\n${sentence.repeat(60)}`;

  it("is the title line and whole sentences from the start", () => {
    const short = shorterContext(article, 300);
    expect(short.length).toBeLessThanOrEqual(300);
    expect(short.startsWith("Slow Ferry\n")).toBe(true);
    expect(short.endsWith("one night.")).toBe(true);
  });

  it("is the whole article when it's short already", () => {
    expect(shorterContext("Slow Ferry\nOne sentence.", 300)).toBe("Slow Ferry\nOne sentence.");
  });
});

describe("how busy the computer is", () => {
  const core = (user: number, idle: number) => ({ times: { user, nice: 0, sys: 0, idle, irq: 0 } });

  it("counts other programs' share, leaving out BubbleFacts' own", () => {
    const before = cpuTimes([core(0, 0), core(0, 0)]);
    const after = cpuTimes([core(900, 100), core(900, 100)]);
    expect(othersCpuShare(before, after, 0)).toBeCloseTo(0.9);
    // Half of the busy time was the AI's own work
    expect(othersCpuShare(before, after, 900)).toBeCloseTo(0.45);
  });

  it("is never below nothing or above everything", () => {
    const t = cpuTimes([core(100, 100)]);
    expect(othersCpuShare(t, t, 0)).toBe(0);
    expect(othersCpuShare(cpuTimes([core(0, 0)]), cpuTimes([core(100, 0)]), 500)).toBe(0);
  });

  it("makes room at once and gives it back only after a calm while", () => {
    const w = new CpuWatch();
    expect(w.read(0.4)).toBe(false);
    expect(w.read(0.9)).toBe(true);
    for (let i = 0; i < CALM_SAMPLES - 1; i++) expect(w.read(0.2)).toBe(true);
    expect(w.read(0.2)).toBe(false);
  });

  it("starts the calm while over when the CPU gets busy again", () => {
    const w = new CpuWatch();
    w.read(0.9);
    for (let i = 0; i < CALM_SAMPLES - 1; i++) w.read(0.2);
    // Between calm and busy: not calm
    w.read(0.6);
    expect(w.read(0.2)).toBe(true);
  });

  it("leaves the AI at least one thread", () => {
    expect(busyThreads(8)).toBe(2);
    expect(busyThreads(2)).toBe(1);
  });

  it("measures the model's speed in words a second", () => {
    expect(wordsPerSecond("one two three four", 2000)).toBe(2);
    expect(wordsPerSecond("", 2000)).toBeNull();
  });
});
