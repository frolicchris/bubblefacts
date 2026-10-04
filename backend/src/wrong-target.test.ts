import { Fact, SSLSong } from "./types";
import { sameSong, wrongTarget } from "./wrong-target";

const fact = (text: string): Fact => ({ text, delaySeconds: 0, durationSeconds: 8, position: { top: "8%", left: "33%" } });
const A: SSLSong = { title: "Night Drive", artist: "Tag Artist", songId: 7 };
const B: SSLSong = { title: "Storm Song", artist: "Someone" };

describe("wrongTarget", () => {
  // A, B, A: the same song on again, with its first play's facts under Earlier songs.
  const now = { song: A, facts: [fact("Second play."), fact("Both plays.")] };
  const earlier = [{ song: B, facts: [fact("From B.")] }, { song: A, facts: [fact("First play."), fact("Both plays.")] }];

  it("takes a fact off the stream only from the On stream now list", () => {
    expect(wrongTarget({ text: "Second play.", song: A, live: true }, now, earlier)).toMatchObject({ song: A, playing: true });
    expect(wrongTarget({ text: "Both plays.", song: A, live: true }, now, earlier)).toMatchObject({ playing: true });
  });

  it("marks the earlier play when Wrong is clicked under Earlier songs, though the same song is on again", () => {
    // From review: the song alone decided, so this took the live bubble off.
    expect(wrongTarget({ text: "Both plays.", song: A, live: false }, now, earlier)).toMatchObject({ song: A, playing: false });
    expect(wrongTarget({ text: "First play.", song: A, live: false }, now, earlier)).toMatchObject({ playing: false });
    // Not on the earlier play: nothing to mark, and the live bubble stays.
    expect(wrongTarget({ text: "Second play.", song: A, live: false }, now, earlier)).toBeNull();
    expect(wrongTarget({ text: "From B.", song: B, live: false }, now, earlier)).toMatchObject({ song: B, playing: false });
  });

  it("finds a live click's fact under Earlier songs once the song has moved on", () => {
    const moved = { song: B, facts: [fact("From B, again.")] };
    expect(wrongTarget({ text: "First play.", song: A, live: true }, moved, earlier)).toMatchObject({ song: A, playing: false });
    expect(wrongTarget({ text: "Gone.", song: A, live: true }, moved, earlier)).toBeNull();
  });

  it("matches songs by title, artist and ID", () => {
    expect(sameSong(A, { ...A })).toBe(true);
    expect(sameSong(A, { ...A, songId: 8 })).toBe(false);
    expect(sameSong(B, { ...B, videoId: "abc" })).toBe(false);
    expect(sameSong(null, A)).toBe(false);
  });
});
