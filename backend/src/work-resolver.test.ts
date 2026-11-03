jest.mock("./config", () => ({
  config: { groundingTimeoutMs: 5000, groundingExtractTimeoutMs: 15000, dataDir: process.env.BUBBLEFACTS_DATA_DIR, topic: "general" },
}));

import { candidateProfile, holdsForEveryVersion, matchLine, referenceDecision, requestProfile, resolveWork, scoredLevel } from "./work-resolver";

// Made-up bands, songs, games and shows: one case per kind of wrong match the scored match is for (issue #172).
const song = (title: string, artist: string) => ({ title, artist });
/** A request whose artist MusicBrainz credits with the song. */
const credited = (title: string, artist: string) => requestProfile(song(title, artist), song(title, artist), true);
const plain = (title: string, artist: string) => requestProfile(song(title, artist), song(title, artist));
const LONG = " It was made by a small team over three years.".repeat(10);

describe("the scored match", () => {
  it("is sure of a song's own article that names its artist", () => {
    const pick = candidateProfile("Paper Lanterns", `"Paper Lanterns" is a 1974 song by English singer Dana Reyes.${LONG}`, "", 0);
    const m = resolveWork(credited("Paper Lanterns", "Dana Reyes"), pick);
    expect(m.decision).toBe("sure");
    expect(matchLine(m, "Paper Lanterns")).toMatch(/^\[Grounding\] match: sure \d+ for "Paper Lanterns" on "Paper Lanterns" \(title exact \+4, kind song \+3, performer named \+3, top hit \+1\)$/);
  });

  it("abstains on a remake for the original game's track", () => {
    const pick = candidateProfile("Orbit: Reforged", `Orbit: Reforged is a 2025 shooter video game, a remake of Orbit: First Light.${LONG}`);
    expect(resolveWork(plain("Hangar Bay", "Orbit: First Light"), pick).decision).toBe("abstain");
  });

  it("abstains on a game named like the band", () => {
    const pick = candidateProfile("Glass Harbor (video game)", `Glass Harbor is a 2008 puzzle video game for the Wii.${LONG}`);
    const rival = candidateProfile("Glass Harbor (band)");
    expect(resolveWork(credited("Night Drive", "Glass Harbor"), pick, [rival]).decision).toBe("abstain");
  });

  it("abstains on a same-named game for a show's theme", () => {
    const pick = candidateProfile("Harbor Patrol (video game)", `Harbor Patrol is a 1994 action video game.${LONG}`);
    expect(resolveWork(plain("Opening Theme", "Harbor Patrol (TV)"), pick).decision).toBe("abstain");
    // The same game for a game's track is the track's game.
    expect(resolveWork(plain("Opening Theme", "Harbor Patrol (SNES)"), pick).decision).toBe("sure");
  });

  it("gives no captions for a stage musical's song of the same name as the singer's", () => {
    const pick = candidateProfile("Starlight Avenue (song)", `"Starlight Avenue" is a song from the 1951 musical Night Train, written by Al Brandt and Rue Moss.${LONG}`);
    expect(resolveWork(credited("Starlight Avenue", "Jo Pell"), pick).decision).toBe("data-only");
  });

  it("gives no captions for the original's article when the request is a cover", () => {
    const pick = candidateProfile("Cherry Fields (Tom Orchard song)", `"Cherry Fields" is a 2019 song by Tom Orchard.${LONG}`);
    expect(resolveWork(credited("Cherry Fields", "Mira Vale"), pick).decision).toBe("data-only");
  });

  it("abstains on a concert film or a biopic named after the band", () => {
    const film = candidateProfile("Glass Harbor: Live in Oslo", `Glass Harbor: Live in Oslo is a 2025 concert film by the band Glass Harbor.${LONG}`);
    expect(resolveWork(credited("Night Drive", "Glass Harbor"), film).decision).toBe("abstain");
    const biopic = candidateProfile("Night Drive: The Mae Corrin Story", `Night Drive: The Mae Corrin Story is a 1989 film about the singer Mae Corrin.${LONG}`);
    expect(resolveWork(credited("Night Drive", "Mae Corrin"), biopic).decision).toBe("abstain");
  });

  it("abstains on the series' article for a sequel's track it never names", () => {
    const pick = candidateProfile("Rocket Drift (series)", `Rocket Drift is a series of racing video games.${LONG}`);
    expect(resolveWork(plain("Area 2", "Rocket Drift 2"), pick).decision).toBe("abstain");
  });

  it("keeps a composer's piece sure, and drops a later recording's year from data", () => {
    const pick = candidateProfile("Nocturne (Kessler)", `The Nocturne in E-flat major is a piece for solo piano by Anna Kessler, composed in 1931.${LONG}`);
    const m = resolveWork(plain("Nocturne in E-flat major", "Anna Kessler"), pick);
    expect(m.decision).toBe("sure");
    expect(m.top.parts.map(([n]) => n)).not.toContain("another performer");
    expect(holdsForEveryVersion('"Nocturne in E-flat major" was composed by Anna Kessler.')).toBe(true);
    expect(holdsForEveryVersion('"Nocturne in E-flat major" came out in 2024 and is on the album Night Pieces.')).toBe(false);
  });

  it("abstains when the request's year and performer both point elsewhere", () => {
    const pick = candidateProfile("Cold Engines (Rust Parade song)", `"Cold Engines" is a 2010 song by Rust Parade.${LONG}`);
    const m = resolveWork(credited("Cold Engines (1987)", "Velvet Static"), pick);
    expect(m.decision).toBe("abstain");
    expect(m.top.parts).toContainEqual(["year 2010", -3]);
  });

  it("gives no captions when two works of one name are a close call", () => {
    const pick = candidateProfile("Orbit Run (1990 video game)", `Orbit Run is a 1990 arcade video game.${LONG}`);
    const rival = candidateProfile("Orbit Run (1992 video game)");
    const m = resolveWork(plain("Stage 1", "Orbit Run"), pick, [rival]);
    expect(m.decision).toBe("data-only");
    expect(m.runnerUp?.page).toBe("Orbit Run (1992 video game)");
  });

  it("doesn't count the artist's own article and their song's as rivals", () => {
    const pick = candidateProfile("Dana Reyes", `Dana Reyes (born 1950) is an English singer.${LONG}`, "", 0);
    const others = [candidateProfile("Paper Lanterns (Dana Reyes song)"), candidateProfile("Dana Reyes (album)")];
    expect(resolveWork(credited("Paper Lanterns", "Dana Reyes"), pick, others).decision).toBe("sure");
  });

  it("reads a band named after its leader, a shared credit and initials as the performer", () => {
    const leader = candidateProfile("Sam Doyle", `Sam Doyle (born 1960) is an American drummer.${LONG}`);
    expect(resolveWork(plain("The Windup", "Sam Doyle Band"), leader).decision).toBe("sure");
    expect(resolveWork(plain("Late Bus", "Kim Arden / Sam Doyle"), leader).decision).toBe("sure");
    const band = candidateProfile("Our Paper Kites", `Our Paper Kites is a Canadian rock band.${LONG}`);
    expect(resolveWork(plain("4am", "OPK"), band).decision).toBe("sure");
  });
});

describe("referenceDecision and scoredLevel", () => {
  it("never makes the rules surer, only less sure", () => {
    const remake = "Orbit: Reforged\nOrbit: Reforged is a 2025 shooter video game, a remake of Orbit: First Light.";
    const m = referenceDecision(song("Hangar Bay", "Orbit: First Light"), remake);
    expect(scoredLevel({ level: "sure", reason: "the work's own article" }, m)).toMatchObject({ level: "unsure", reason: expect.stringContaining("scored match") });
    expect(scoredLevel({ level: "unsure", reason: "a series' article" }, m)).toEqual({ level: "unsure", reason: "a series' article" });
    const own = "Paper Lanterns\n\"Paper Lanterns\" is a 1974 song by English singer Dana Reyes.";
    expect(scoredLevel({ level: "unsure", reason: "x" }, referenceDecision(song("Paper Lanterns", "Dana Reyes"), own)).level).toBe("unsure");
  });
});
