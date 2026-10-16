import { attributed, cleanSource, holderOf, isOpinion, sourceCleaning, withoutPuffery } from "./source-cleaner";

const song = [
  "Glass Harbor (song)",
  "From the people who made it: Mira Tolvet said she wrote the chorus on a ferry.",
  "",
  "How it was received: It reached number 4 on the Pell Hot 100.",
  "",
  "Background: The song was recorded at Gray Hill Studio. Its demo was cut in a day.",
  "",
  "With duo Fernway: Tolvet joined the duo in 2011. It toured the north coast twice.",
  "",
  "\"Glass Harbor\" is a song by Mira Tolvet. It was released in 2014. It is said that the bridge came last.",
].join("\n");

describe("source cleaner: naming the subject", () => {
  afterEach(() => Object.assign(sourceCleaning, { decontextualize: true, attributeOpinions: true }));

  it("names the song where the article's subject is certain", () => {
    sourceCleaning.attributeOpinions = false;
    const out = cleanSource(song, { track: "Glass Harbor", ownSong: true });
    expect(out).toContain("How it was received: \"Glass Harbor\" reached number 4 on the Pell Hot 100.");
    expect(out).toContain("Background: \"Glass Harbor\" was recorded at Gray Hill Studio. \"Glass Harbor\"'s demo was cut in a day.");
    expect(out).toContain("\"Glass Harbor\" was released in 2014.");
    // An "it" that stands for no one stays.
    expect(out).toContain("It is said that the bridge came last.");
  });

  it("marks a section about something else, and leaves its 'it' alone", () => {
    sourceCleaning.attributeOpinions = false;
    const out = cleanSource(song, { track: "Glass Harbor", ownSong: true });
    expect(out).toContain("About With duo Fernway: Tolvet joined the duo in 2011. It toured the north coast twice.");
  });

  it("names no subject when the lead doesn't open with the title", () => {
    sourceCleaning.attributeOpinions = false;
    const loose = ["Glass Harbor (song)", "Background: It was recorded in Pell.", "", "Released in 2014, it is a song by Mira Tolvet. It was her first single."].join("\n");
    const out = cleanSource(loose, { track: "Glass Harbor", ownSong: true });
    expect(out).toContain("Background: It was recorded in Pell.");
    expect(out).toContain("It was her first single.");
  });

  it("names the track a heading names in a game's article", () => {
    sourceCleaning.attributeOpinions = false;
    const game = ["Lantern Keep", "Music: The score was written by Oda Senn.", "", "Night Market theme: It was written in one night.", "", "Lantern Keep is a 2003 video game. The game was released for the Orbit console."].join("\n");
    const out = cleanSource(game, { track: "Night Market", ownSong: false });
    expect(out).toContain("Night Market theme: \"Night Market\" was written in one night.");
    expect(out).toContain("Lantern Keep was released for the Orbit console.");
    // "The score" isn't an opener the cleaner resolves.
    expect(out).toContain("Music: The score was written by Oda Senn.");
  });

  it("leaves out a lifted sentence or a section opener it can't resolve", () => {
    sourceCleaning.attributeOpinions = false;
    const game = ["Lantern Keep", "From the people who made it: The album was mixed by Oda Senn in Tokyo.", "", "Legacy titles: These titles sold well in Europe. Oda Senn said they were rushed.", "", "Lantern Keep is a 2003 video game."].join("\n");
    const out = cleanSource(game, { track: "Night Market", ownSong: false });
    expect(out).not.toContain("The album was mixed");
    expect(out).not.toContain("These titles");
    expect(out).toContain("Oda Senn said they were rushed.");
  });
});

describe("source cleaner: opinions", () => {
  it("finds who holds a view", () => {
    expect(holderOf("Rook Weekly's Ana Ruiz praised the chorus.")?.name).toBe("Rook Weekly's Ana Ruiz");
    expect(holderOf("The song was praised by Rook Weekly for its chorus.")?.name).toBe("Rook Weekly");
    expect(holderOf("Brightline gave it 8 out of 10, calling it \"a quiet triumph\".")?.name).toBe("Brightline");
    expect(holderOf("Critics praised the chorus.")).toBeNull();
    expect(holderOf("It has been described as a lost classic.")).toBeNull();
  });

  it("knows an opinion from a count", () => {
    expect(isOpinion("The album is widely regarded as her best.", "")).toBe(true);
    expect(isOpinion("It is one of the greatest songs of the decade.", "")).toBe(true);
    expect(isOpinion("The game sold two million copies.", "Reception")).toBe(false);
    expect(isOpinion("Reviews were mostly positive.", "Critical reception")).toBe(true);
    expect(isOpinion("Tolvet met her best friend in Pell.", "")).toBe(false);
    expect(isOpinion("The team considered adding a second disc.", "")).toBe(false);
    // Wikipedia's "Words to watch": puffery, and "hit" or "popular" only without a number.
    expect(isOpinion("Tolvet is a renowned harpist from Pell.", "")).toBe(true);
    expect(isOpinion("It is widely regarded as a turning point.", "")).toBe(true);
    expect(isOpinion("The single was a popular hit in Pell.", "")).toBe(true);
    expect(isOpinion("The single was a hit, reaching number 3 in Pell.", "")).toBe(false);
    expect(isOpinion("It won Best Original Score at the Pell Awards.", "")).toBe(false);
    expect(isOpinion("A legendary run of shows is listed here.", "Track listing")).toBe(false);
  });

  it("takes puff words out of a statement", () => {
    expect(withoutPuffery("Tolvet is a renowned harpist from Pell.")).toBe("Tolvet is a harpist from Pell.");
    expect(withoutPuffery("Velmora is an innovative and influential band.")).toBe("Velmora is an influential band.");
    expect(withoutPuffery("Glass Harbor and Low Tide are popular 2014 singles.")).toBe("Glass Harbor and Low Tide are 2014 singles.");
    expect(withoutPuffery("It was a popular single, reaching number 3 in Pell.")).toBe("It was a popular single, reaching number 3 in Pell.");
    expect(withoutPuffery("Ruiz called it \"a brilliant record\" and a remarkable debut.")).toBe("Ruiz called it \"a brilliant record\" and a debut.");
    expect(withoutPuffery("Tolvet met her best friend in Pell.")).toBe("Tolvet met her best friend in Pell.");
    expect(withoutPuffery("It is among the most popular Pell singles.")).toBe("It is among the most popular Pell singles.");
    expect(withoutPuffery("The game is notable for its harp score.")).toBe("The game is notable for its harp score.");
  });

  it("puts the holder up front", () => {
    const s = "Ana Ruiz wrote that the chorus is the band's best.";
    expect(attributed(s, holderOf(s)!)).toBe("According to Ana Ruiz, the chorus is the band's best.");
    const t = "Senn stated in 2001 that he considered the score his finest work.";
    expect(attributed(t, holderOf(t)!)).toBe("According to Senn in 2001, he considered the score his finest work.");
    const q = "Rook Weekly applauded the album, saying, \"Tolvet never sounded better.\"";
    expect(attributed(q, holderOf(q)!)).toBe("According to Rook Weekly, \"Tolvet never sounded better.\"");
    const kept = "Rook Weekly praised the chorus.";
    expect(attributed(kept, holderOf(kept)!)).toBe(kept);
  });

  it("drops a view nobody holds and attributes the rest", () => {
    const ctx = ["Glass Harbor (song)", "Critical reception: Reviews were mostly positive. Ana Ruiz wrote that the chorus is the band's best. It reached number 4 on the Pell Hot 100.", "", "\"Glass Harbor\" is a song by Mira Tolvet. It is regarded as one of the finest songs of 2014."].join("\n");
    const out = cleanSource(ctx, { track: "Glass Harbor", ownSong: true });
    expect(out).not.toContain("mostly positive");
    expect(out).not.toContain("finest songs");
    expect(out).toContain("According to Ana Ruiz, the chorus is the band's best.");
    expect(out).toContain("\"Glass Harbor\" reached number 4 on the Pell Hot 100.");
  });
});
