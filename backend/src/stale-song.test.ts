import { carriedOnForMs, STALE_MINUTES_DEFAULT, STALE_NOTICE, staleAfterMs, staleMinutes, StaleSongWatch } from "./stale-song";

const MINUTE = 60 * 1000;
const STALE_AFTER_MS = STALE_MINUTES_DEFAULT * MINUTE;
import { SSLQueueItem } from "./types";

const entry = (title: string, durationSeconds: number | null = null): SSLQueueItem => ({
  id: 1, songId: null, song: { title, artist: "The Made Up Band", durationSeconds }, nonlistSong: null, note: null, streamerId: 0, createdAt: "", requests: null,
});

describe("staleMinutes (the STALE_SONG_MINUTES setting)", () => {
  it("is 10 minutes when nothing is set", () => {
    expect(STALE_MINUTES_DEFAULT).toBe(10);
    for (const unset of [undefined, null, "", "  "]) expect(staleMinutes(unset)).toBe(10);
  });

  it("takes the streamer's own value from 5 to 60", () => {
    expect(staleMinutes("5")).toBe(5);
    expect(staleMinutes(" 25 ")).toBe(25);
    expect(staleMinutes(60)).toBe(60);
  });

  it("falls back to the default for a bad value, never to an end of the range", () => {
    for (const bad of ["4", "61", "0", "-10", "12.5", "ten", "1e9", NaN, Infinity]) expect(staleMinutes(bad)).toBe(10);
  });
});

describe("staleAfterMs", () => {
  it("allows the default time when nothing is set and the source doesn't know the track's length", () => {
    expect(staleAfterMs(entry("Paper Lanterns"))).toBe(STALE_AFTER_MS);
    expect(staleAfterMs(entry("Paper Lanterns", 0))).toBe(STALE_AFTER_MS);
  });

  it("allows the streamer's own time, and the default for a bad one", () => {
    expect(staleAfterMs(entry("Paper Lanterns"), 25)).toBe(25 * MINUTE);
    expect(staleAfterMs(entry("Paper Lanterns"), 5)).toBe(5 * MINUTE);
    expect(staleAfterMs(entry("Paper Lanterns"), 500)).toBe(STALE_AFTER_MS);
  });

  it("allows a long track its own length twice over, so a long piece isn't cut off", () => {
    expect(staleAfterMs(entry("A Very Long Medley", 30 * 60))).toBe(62 * MINUTE);
    expect(staleAfterMs(entry("A Very Long Medley", 30 * 60), 5)).toBe(62 * MINUTE);
  });

  it("never cuts in earlier than the streamer's setting because a track is short", () => {
    expect(staleAfterMs(entry("A Short One", 60))).toBe(STALE_AFTER_MS);
    expect(staleAfterMs(entry("A Short One", 60), 30)).toBe(30 * MINUTE);
    expect(staleAfterMs(entry("A Short One", 60), 5)).toBe(5 * MINUTE);
  });

  it("puts no time in the notice, since the streamer sets it", () => {
    expect(STALE_NOTICE).not.toMatch(/\d|minute/);
  });
});

describe("StaleSongWatch", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("calls a song stale once it has been on longer than a song plausibly lasts", () => {
    const stale: string[] = [];
    const watch = new StaleSongWatch((e) => stale.push(e.song.title));
    watch.follow(entry("Paper Lanterns"));
    jest.advanceTimersByTime(STALE_AFTER_MS - 1);
    expect(watch.stale).toBe(false);
    jest.advanceTimersByTime(1);
    expect(watch.stale).toBe(true);
    expect(stale).toEqual(["Paper Lanterns"]);
  });

  it("picks up again by itself on the next song", () => {
    const stale: string[] = [];
    const watch = new StaleSongWatch((e) => stale.push(e.song.title));
    watch.follow(entry("Paper Lanterns"));
    jest.advanceTimersByTime(STALE_AFTER_MS);
    watch.follow(entry("Second Song"));
    expect(watch.stale).toBe(false);
    jest.advanceTimersByTime(STALE_AFTER_MS - 1);
    expect(stale).toEqual(["Paper Lanterns"]);
  });

  it("keeps the clock running when the same entry is given again, as on Resume", () => {
    const watch = new StaleSongWatch(() => {});
    const same = entry("Paper Lanterns");
    watch.follow(same);
    jest.advanceTimersByTime(STALE_AFTER_MS - 1000);
    watch.follow(same);
    jest.advanceTimersByTime(1000);
    expect(watch.stale).toBe(true);
    watch.follow(same);
    expect(watch.stale).toBe(true);
  });

  it("doesn't count time paused: a song lined up, paused over and then played is still current", () => {
    const stale: string[] = [];
    const watch = new StaleSongWatch((e) => stale.push(e.song.title));
    watch.follow(entry("Paper Lanterns"));
    jest.advanceTimersByTime(60 * 1000);
    watch.pause();
    jest.advanceTimersByTime(STALE_AFTER_MS * 3);
    expect(watch.stale).toBe(false);
    expect(watch.onForMs()).toBe(60 * 1000);
    expect(watch.resume()).toBe(false);
    jest.advanceTimersByTime(STALE_AFTER_MS - 60 * 1000 - 1);
    expect(watch.stale).toBe(false);
    jest.advanceTimersByTime(1);
    expect(watch.stale).toBe(true);
    expect(stale).toEqual(["Paper Lanterns"]);
  });

  it("starts the clock at Resume for a song that came on while paused", () => {
    const watch = new StaleSongWatch(() => {});
    watch.pause();
    watch.follow(entry("Paper Lanterns"));
    jest.advanceTimersByTime(STALE_AFTER_MS * 2);
    expect(watch.stale).toBe(false);
    watch.resume();
    jest.advanceTimersByTime(STALE_AFTER_MS);
    expect(watch.stale).toBe(true);
  });

  it("takes a stale song as current again on Resume, timed afresh, and says so once", () => {
    const stale: string[] = [];
    const watch = new StaleSongWatch((e) => stale.push(e.song.title));
    watch.follow(entry("Paper Lanterns"));
    jest.advanceTimersByTime(STALE_AFTER_MS);
    expect(watch.stale).toBe(true);
    watch.pause();
    jest.advanceTimersByTime(STALE_AFTER_MS);
    expect(watch.stale).toBe(true);
    expect(watch.resume()).toBe(true);
    expect(watch.stale).toBe(false);
    expect(watch.resume()).toBe(false);
    jest.advanceTimersByTime(STALE_AFTER_MS - 1);
    expect(watch.stale).toBe(false);
    jest.advanceTimersByTime(1);
    expect(stale).toEqual(["Paper Lanterns", "Paper Lanterns"]);
  });

  it("keeps the clock of a song that was on before a restart, stale at once when its time is up", () => {
    const stale: string[] = [];
    const watch = new StaleSongWatch((e) => stale.push(e.song.title));
    watch.follow(entry("Paper Lanterns"), { onForMs: STALE_AFTER_MS - 1000 });
    expect(watch.stale).toBe(false);
    jest.advanceTimersByTime(1000);
    expect(watch.stale).toBe(true);
    watch.follow(entry("Second Song"), { onForMs: STALE_AFTER_MS + 5000 });
    expect(watch.stale).toBe(true);
    expect(stale).toEqual(["Paper Lanterns", "Second Song"]);
    watch.follow(entry("Third Song"));
    expect(watch.stale).toBe(false);
  });

  it("never calls an empty list stale, and forgets the song that left", () => {
    const stale: string[] = [];
    const watch = new StaleSongWatch((e) => stale.push(e.song.title));
    watch.follow(entry("Paper Lanterns"));
    watch.follow(null);
    jest.advanceTimersByTime(STALE_AFTER_MS * 2);
    expect(watch.stale).toBe(false);
    expect(stale).toEqual([]);
  });
});

describe("carriedOnForMs: a song's clock across a restart", () => {
  const now = 1_800_000_000_000;

  it("saved while playing, the song played on since the save", () => {
    expect(carriedOnForMs({ playedMs: 3 * MINUTE, savedAt: now - MINUTE }, STALE_AFTER_MS, now)).toBe(4 * MINUTE);
    expect(carriedOnForMs({ playedMs: STALE_AFTER_MS, playedPaused: false, savedAt: now - 15 * MINUTE }, STALE_AFTER_MS, now)).toBe(STALE_AFTER_MS + 15 * MINUTE);
  });

  it("saved while paused, neither the pause nor the time the server was down counts", () => {
    expect(carriedOnForMs({ playedMs: 6 * MINUTE, playedPaused: true, savedAt: now - 5 * MINUTE }, STALE_AFTER_MS, now)).toBe(6 * MINUTE);
    expect(carriedOnForMs({ playedMs: 6 * MINUTE, playedPaused: true, savedAt: now - 300 * MINUTE }, STALE_AFTER_MS, now)).toBe(6 * MINUTE);
  });

  it("starts afresh when that isn't known, or the song is so far past its time that it's likely a new play", () => {
    expect(carriedOnForMs(undefined, STALE_AFTER_MS, now)).toBe(0);
    expect(carriedOnForMs(null, STALE_AFTER_MS, now)).toBe(0);
    expect(carriedOnForMs({ playedMs: NaN, savedAt: now }, STALE_AFTER_MS, now)).toBe(0);
    expect(carriedOnForMs({ playedMs: -5, savedAt: now }, STALE_AFTER_MS, now)).toBe(0);
    expect(carriedOnForMs({ playedMs: MINUTE, savedAt: now + 1000 }, STALE_AFTER_MS, now)).toBe(0);
    expect(carriedOnForMs({ playedMs: MINUTE, savedAt: now - 30 * MINUTE }, STALE_AFTER_MS, now)).toBe(0);
  });

  it("takes a session from before 2.3.0-beta.2, which kept a time of day, as a fresh start", () => {
    const old = { onSince: now - 4 * MINUTE, savedAt: now - MINUTE } as Parameters<typeof carriedOnForMs>[0];
    expect(carriedOnForMs(old, STALE_AFTER_MS, now)).toBe(0);
  });
});

describe("StaleSongWatch after a restart while paused", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("a song paused part way carries on from there on Resume, however long the pause", () => {
    const stale: string[] = [];
    const watch = new StaleSongWatch((e) => stale.push(e.song.title));
    watch.pause();
    watch.follow(entry("Paper Lanterns"), { onForMs: STALE_AFTER_MS - MINUTE });
    jest.advanceTimersByTime(STALE_AFTER_MS);
    expect(watch.stale).toBe(false);
    expect(watch.resume()).toBe(false);
    jest.advanceTimersByTime(MINUTE - 1);
    expect(watch.stale).toBe(false);
    jest.advanceTimersByTime(1);
    expect(stale).toEqual(["Paper Lanterns"]);
  });

  it("a song that was stale is stale, and Resume starts it again", () => {
    const stale: string[] = [];
    const watch = new StaleSongWatch((e) => stale.push(e.song.title));
    watch.pause();
    watch.follow(entry("Paper Lanterns"), { onForMs: STALE_AFTER_MS });
    expect(watch.stale).toBe(true);
    expect(watch.resume()).toBe(true);
    expect(watch.stale).toBe(false);
    expect(stale).toEqual([]);
    jest.advanceTimersByTime(STALE_AFTER_MS);
    expect(stale).toEqual(["Paper Lanterns"]);
  });
});
