import { STALE_AFTER_MS, staleAfterMs, StaleSongWatch } from "./stale-song";
import { SSLQueueItem } from "./types";

const entry = (title: string, durationSeconds: number | null = null): SSLQueueItem => ({
  id: 1, songId: null, song: { title, artist: "The Made Up Band", durationSeconds }, nonlistSong: null, note: null, streamerId: 0, createdAt: "", requests: null,
});

describe("staleAfterMs", () => {
  it("allows a fixed time when the source doesn't know the track's length", () => {
    expect(staleAfterMs(entry("Paper Lanterns"))).toBe(STALE_AFTER_MS);
    expect(staleAfterMs(entry("Paper Lanterns", 0))).toBe(STALE_AFTER_MS);
  });

  it("allows a long track its own length twice over, so a long piece isn't cut off", () => {
    expect(staleAfterMs(entry("A Very Long Medley", 30 * 60))).toBe(62 * 60 * 1000);
    expect(staleAfterMs(entry("A Short One", 60))).toBe(4 * 60 * 1000);
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
