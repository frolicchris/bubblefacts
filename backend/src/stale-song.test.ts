import { STALE_MINUTES_DEFAULT, STALE_NOTICE, staleAfterMs, staleMinutes, StaleSongWatch } from "./stale-song";

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
