import fs from "fs";
import path from "path";
import { buildProfile, otherReadings, readings } from "./list-profile";

const titles = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/song-list-titles.json"), "utf8")) as Record<string, string[]>;
const profile = (id: string) => buildProfile(titles[id].map((title) => ({ title })));
const read = (title: string, artist: string, p = buildProfile([])) => otherReadings({ title, artist }, p).map((s) => `${s.title} | ${s.artist}`);

describe("buildProfile, on seven real song lists", () => {
  it("finds the list that writes Game - Track with the composer as artist", () => {
    expect(profile("B").dash).toBe("source-first");
  });

  it("finds the list that writes Track - Show with the performer as artist", () => {
    expect(profile("D").dash).toBe("track-first");
  });

  it("sees no dash habit where the artist field holds the game, or the list is mixed", () => {
    for (const id of ["A", "C", "E", "F", "G"]) expect(profile(id).dash).toBeNull();
  });

  it("never takes a version or a note to requesters for a source", () => {
    for (const id of ["A", "B", "C", "D", "E", "F", "G"]) {
      for (const name of profile(id).parenSources) expect(name).not.toMatch(/remix|live|act \d|night|day|specify|aircheck|original/);
    }
  });

  it("takes a bracket that recurs across a list for a source", () => {
    const p = buildProfile([
      { title: "Departure to the West (Princess Mononoke)" }, { title: "The Legend of Ashitaka (Princess Mononoke)" },
      { title: "Ashitaka and San (Princess Mononoke)" }, { title: "One Summer's Day (Spirited Away)" }, { title: "Clocks (Live)" },
      { title: "Clocks (Live)" }, { title: "Clocks (Live)" },
    ]);
    expect([...p.parenSources]).toEqual(["princess mononoke"]);
  });
});

describe("otherReadings", () => {
  it("reads a dash the way the list uses it", () => {
    expect(read("Final Fantasy VI - Kefka", "Nobuo Uematsu", profile("B"))).toEqual(["Kefka | Final Fantasy VI"]);
    expect(read("Into the Unknown - Frozen 2", "Aurora and Idina Menzel", profile("D"))).toEqual(["Into the Unknown | Frozen 2"]);
  });

  it("offers both ways round when the list has no habit", () => {
    expect(read("Last Surprise - Persona 5", "Lyn")).toEqual(["Persona 5 | Last Surprise", "Last Surprise | Persona 5"]);
  });

  it("always reads Track from Source", () => {
    expect(read("The Perfect Year from Sunset Boulevard", "Andrew Lloyd Webber")).toEqual(["The Perfect Year | Sunset Boulevard"]);
    expect(read("Mack the Knife from The Three Penny Opera", "Kurt Weill")).toEqual(["Mack the Knife | The Three Penny Opera"]);
    expect(read("Far from home", "Someone")).toEqual([]);
  });

  it("reads a bracket as the source only when the list repeats it", () => {
    const p = buildProfile([{ title: "A (Princess Mononoke)" }, { title: "B (Princess Mononoke)" }, { title: "C (Princess Mononoke)" }]);
    expect(read("Departure to the West (Princess Mononoke)", "Joe Hisaishi", p)).toEqual(["Departure to the West | Princess Mononoke"]);
    expect(read("Undone (Sweater Song)", "Weezer", p)).toEqual([]);
  });

  it("adds nothing when the artist field already names the source, or there's no source in the title", () => {
    expect(read("Chrono Trigger - Frog's Theme", "Chrono Trigger", profile("B"))).toEqual([]);
    expect(read("Kefka", "Final Fantasy VI")).toEqual([]);
  });
});

describe("readings", () => {
  it("tries a plain reading first, and a guess after the song as written", () => {
    const song = { title: "Final Fantasy VI - Kefka", artist: "Nobuo Uematsu" };
    expect(readings(song, profile("B")).map((s) => s.artist)).toEqual(["Final Fantasy VI", "Nobuo Uematsu"]);
    expect(readings(song, buildProfile([])).map((s) => s.artist)).toEqual(["Nobuo Uematsu", "Final Fantasy VI", "Kefka"]);
    expect(readings({ title: "Kefka", artist: "Final Fantasy VI" })).toHaveLength(1);
  });
});
