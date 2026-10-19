jest.mock("./config", () => ({
  config: { groundingTimeoutMs: 5000, groundingExtractTimeoutMs: 15000, dataDir: process.env.BUBBLEFACTS_DATA_DIR, topic: "general", mbLink: false, classicalLookup: true },
}));

import fs from "fs";
import path from "path";
import { config } from "./config";
import {
  clearGroundingCache,
  fetchGrounding,
  movementSection,
  namesOneWork,
  notForAPiece,
  parseClassicalTitle,
  pickWork,
  pieceSection,
  workFits,
  workMatchConfidence,
  workQueries,
} from "./fact-verifier";
import { classicalPace, pickPerson, WorkItem } from "./wikidata";

// Issue #260. Every composer, performer and piece here is made up.

describe("parseClassicalTitle", () => {
  it("reads catalog numbers, the number and the key, however a list spells them", () => {
    expect(parseClassicalTitle("Nocturne in E-flat major, Op. 12, No. 3")).toMatchObject({ name: "Nocturne", catalogs: ["Op. 12"], numbers: ["12", "3"], key: "E-flat major", classical: true });
    expect(parseClassicalTitle("Nocturne Op. 12 No. 3")).toMatchObject({ name: "Nocturne", catalogs: ["Op. 12"], numbers: ["12", "3"], key: "" });
    expect(parseClassicalTitle("Nocturne in Eb major").key).toBe("E-flat major");
    expect(parseClassicalTitle("Nocturne in E♭ major").key).toBe("E-flat major");
    expect(parseClassicalTitle("Prelude in C# minor").key).toBe("C-sharp minor");
    expect(parseClassicalTitle("Canon in D")).toMatchObject({ name: "Canon", key: "D" });
    expect(parseClassicalTitle("Piano Sonata No. 9 in A major, K. 412")).toMatchObject({ name: "Piano Sonata", catalogs: ["K. 412"], numbers: ["412", "9"], key: "A major" });
    for (const [title, catalog] of [["BWV 2207 Prelude", "BWV 2207"], ["Impromptu D. 935", "D. 935"], ["Sonata Hob. XVI:61", "Hob. XVI:61"], ["Concerto RV 812", "RV 812"], ["Suite HWV 512", "HWV 512"], ["Etude S. 141", "S. 141"], ["Minuet WoO 77", "WoO 77"], ["Reverie L. 68", "L. 68"], ["Rondo KV 511", "K. 511"]]) {
      expect(parseClassicalTitle(title).catalogs).toEqual([catalog]);
    }
  });

  it("keeps the movement as a hint, out of the name", () => {
    expect(parseClassicalTitle("Lighthouse Sonata (3rd Movement)")).toMatchObject({ name: "Lighthouse Sonata", movement: { n: 3 } });
    expect(parseClassicalTitle("Harbor Sonata 2nd mvt")).toMatchObject({ name: "Harbor Sonata", movement: { n: 2 } });
    expect(parseClassicalTitle("Symphony No. 3: IV. Presto")).toMatchObject({ name: "Symphony", numbers: ["3"], movement: { n: 4, name: "Presto" } });
    expect(parseClassicalTitle("Rhapsody on a Theme of Someone Variation 12")).toMatchObject({ name: "Rhapsody on a Theme of Someone", movement: { n: 12 } });
  });

  it("keeps another name in brackets, and leaves pop titles alone", () => {
    expect(parseClassicalTitle("Thaw (Il disgelo)")).toMatchObject({ name: "Thaw", alias: "Il disgelo", classical: false });
    expect(parseClassicalTitle("Air on the G String")).toMatchObject({ name: "Air on the G String", key: "", classical: false });
    expect(parseClassicalTitle("Paper Lanterns")).toMatchObject({ classical: false, catalogs: [], numbers: [] });
  });

  it("finds a bare form word too vague to name one work", () => {
    expect(namesOneWork(parseClassicalTitle("Prelude"))).toBe(false);
    expect(namesOneWork(parseClassicalTitle("Prelude No. 4"))).toBe(true);
    expect(namesOneWork(parseClassicalTitle("Lighthouse Sonata"))).toBe(true);
  });
});

const work = (over: Partial<WorkItem>): WorkItem => ({ id: "Q1", label: "", names: [], catalogs: [], composers: [], parents: [], page: "", ...over });

describe("workFits and pickWork", () => {
  const sonata4 = work({ id: "Q4", label: "Piano Sonata No. 4", names: ["Piano Sonata No. 4", "Piano Sonata No. 4 in C-sharp minor, Op. 21", "Lighthouse Sonata"], page: "Piano Sonata No. 4 (Marrow)" });
  const sonata5 = work({ id: "Q5", label: "Piano Sonata No. 5", names: ["Piano Sonata No. 5", "Piano Sonata No. 5 in G minor, Op. 30"] });

  it("matches a nickname among the aliases, and the numbers and key a request gives", () => {
    expect(workFits(sonata4, parseClassicalTitle("Lighthouse Sonata"))).toBe("exact");
    expect(workFits(sonata4, parseClassicalTitle("Sonata No. 4 in C# minor"))).toBe("name");
    expect(workFits(sonata5, parseClassicalTitle("Piano Sonata No. 4"))).toBe("");
    // The key decides between two preludes: "Prelude in C# minor" isn't the one in G minor.
    expect(workFits(work({ names: ["Prelude in G minor"] }), parseClassicalTitle("Prelude in C# minor"))).toBe("");
    expect(workFits(work({ names: ["Prelude in C-sharp minor"] }), parseClassicalTitle("Prelude in C# minor"))).toBe("exact");
  });

  it("matches a name the request holds whole: 'Alla Marina' in 'Rondo Alla Marina'", () => {
    expect(workFits(work({ names: ["Piano Sonata No. 9", "Alla Marina"] }), parseClassicalTitle("Rondo Alla Marina"))).toBe("name");
    // One word isn't enough the other way round: "Rondo" alone names nothing.
    expect(workFits(work({ names: ["Rondo"] }), parseClassicalTitle("Rondo Alla Marina"))).toBe("");
  });

  it("takes a catalog code alone only outside strict mode, and prefers a match by name", () => {
    const suite = work({ id: "Q7", names: ["Cello Partita No. 1 in G major"], catalogs: ["2207"] });
    expect(workFits(suite, parseClassicalTitle("BWV 2207 Prelude"))).toBe("catalog");
    expect(workFits(suite, parseClassicalTitle("BWV 2207 Prelude"), true)).toBe("");
    expect(pickWork([sonata5, sonata4], parseClassicalTitle("Lighthouse Sonata"))).toMatchObject({ work: { id: "Q4" } });
    expect(pickWork([sonata5], parseClassicalTitle("Lighthouse Sonata"))).toBeNull();
  });

  it("prefers a name with no other words: 'Le heron' (The Heron) over 'The Dying Heron', a ballet to it", () => {
    const ballet = work({ id: "Q8", names: ["The Dying Heron"], page: "The Dying Heron" });
    const piece = work({ id: "Q9", names: ["Le heron", "The Heron"], page: "Le heron" });
    expect(pickWork([ballet, piece], parseClassicalTitle("The Heron"))).toMatchObject({ work: { id: "Q9" }, by: "exact" });
  });

  it("takes no guess when several works fit as well, unless only one has an article", () => {
    const parsed = parseClassicalTitle("Mazurka in F minor");
    const a = work({ id: "Q11", names: ["Mazurka in F minor, Op. 5, No. 3"], parents: ["Q20"] });
    const b = work({ id: "Q12", names: ["Mazurka in F minor, Op. 40, No. 2"], parents: ["Q21"] });
    expect(pickWork([a, b], parsed)).toMatchObject({ tied: [{ id: "Q11" }, { id: "Q12" }] });
    // Two items for one piece, leading to the same parent, are one.
    expect(pickWork([a, { ...b, parents: ["Q20"] }], parsed)).toMatchObject({ work: { id: "Q11" } });
    expect(pickWork([a, { ...b, page: "Mazurka in F minor, Op. 40, No. 2 (Marrow)" }], parsed)).toMatchObject({ work: { id: "Q12" } });
    // A copy with no article and no parent leads nowhere and doesn't count.
    expect(pickWork([a, work({ id: "Q13", names: ["Mazurka in F minor"] })], parsed)).toMatchObject({ work: { id: "Q11" } });
    // A part beats the whole it is in.
    expect(pickWork([work({ id: "Q20", names: ["Mazurka in F minor"], page: "Mazurkas (Marrow)" }), a], parsed)).toMatchObject({ work: { id: "Q11" } });
  });

  it("finds the set a numbered piece is in: 'Two Lanterns' for 'Lantern No. 1'", () => {
    const set = work({ id: "Q10", names: ["Deux lanternes", "Two Lanterns", "Lanterns"], page: "Two Lanterns" });
    expect(workFits(set, parseClassicalTitle("Lantern No. 1"))).toBe("set");
    expect(workFits(set, parseClassicalTitle("Lantern No. 1"), true)).toBe("");
    // Another catalog number is another set.
    expect(workFits(work({ names: ["Nocturnes, Op. 7"] }), parseClassicalTitle("Nocturne Op. 9 No. 2"))).toBe("");
    expect(workFits(work({ names: ["Nocturnes, Op. 9"] }), parseClassicalTitle("Nocturne Op. 9 No. 2"))).toBe("set");
  });

  it("searches the title with its numbers, then without the key, then its other name or its catalog code", () => {
    expect(workQueries(parseClassicalTitle("Nocturne in E-flat major, Op. 12, No. 3"))).toEqual(["Nocturne Op. 12 No. 3 E-flat major", "Nocturne Op. 12 No. 3", "Op. 12"]);
    expect(workQueries(parseClassicalTitle("Thaw (Il disgelo)"))).toEqual(["Thaw", "Il disgelo"]);
    expect(workQueries(parseClassicalTitle("Arabesque No. 2"))).toEqual(["Arabesque No. 2", "Arabesque"]);
  });
});

describe("pickPerson", () => {
  it("takes the composer named by a surname, never a family-name item or a lookalike", () => {
    const hits = [
      { id: "Q90", label: "Marrow", description: "family name", match: { text: "Marrow" } },
      { id: "Q91", label: "Edda Marrow", description: "English composer (1801–1870)", match: { text: "Marrow" } },
    ];
    expect(pickPerson(hits, "Marrow")).toMatchObject({ hit: { id: "Q91" }, bySurname: false });
    expect(pickPerson([{ id: "Q91", label: "Edda Marrow", description: "English composer" }], "Marrow")).toMatchObject({ bySurname: true });
    expect(pickPerson([{ id: "Q92", label: "Edda Marrowfield", description: "English composer" }], "Marrow")).toBeNull();
  });
});

describe("sections of a piece's or a parent work's article", () => {
  const suite = [
    "Coastal Suite is a suite for piano.",
    "",
    "== Background ==",
    "Tidewater was the name of her house, and this sentence is long enough to be a section of its own for the test.",
    "",
    "== Movements ==",
    "=== Suite No. 2 in D minor ===",
    "Another suite of the set, with a section long enough to be read on its own if it were the right one.",
    "=== Tidewater ===",
    "Tidewater, the third movement, is a gentle barcarolle. Its rocking left hand stands for the tide.",
  ].join("\n");

  it("finds the section naming the piece, never a generic one or another number's", () => {
    expect(pieceSection(suite, ["Tidewater", "Coastal Suite: 3. Tidewater"], [])?.heading).toBe("Tidewater");
    expect(pieceSection(suite, ["Suite No. 1"], ["1"])).toBeNull();
    expect(pieceSection(suite, ["Gull Song"], [])).toBeNull();
  });

  it("in a set, finds the section headed by the piece's number alone, or starting with it", () => {
    const set = "Lead.\n\n== Pieces ==\n=== No. 1 in B♭ minor ===\nThe first of the set is slow and dark, and it is long enough to be read on its own here.\n=== No. 2 in E♭ major ===\nThe second of the set is the best known, a gentle melody over a rocking left hand that is easy to hum.";
    expect(pieceSection(set, ["Nocturne No. 2 in E-flat major, Op. 12, No. 2"], ["12", "2"])?.heading).toBe("No. 2 in E♭ major");
    const arabesques = "Lead.\n\n== The pieces ==\n=== 1. Andantino con moto ===\nThis one is in E major and opens with flowing triplets across both hands, long enough to read.\n=== 2. Allegretto scherzando ===\nThis one is quick and playful, in G major, and is just as long as the first one.";
    expect(pieceSection(arabesques, ["Lantern No. 2"], ["2"])?.heading).toBe("2. Allegretto scherzando");
  });

  it("finds a movement by its numeral, its ordinal or its tempo", () => {
    const sonata = "Lead.\n\n== Movements ==\n=== I. Adagio ===\nThe first movement is slow and quiet, over a steady triplet figure in the right hand.\n=== III. Presto agitato ===\nThe third movement is a stormy presto in sonata form, the longest of the three movements.";
    expect(movementSection(sonata, { n: 3 })?.heading).toBe("III. Presto agitato");
    expect(movementSection(sonata, { name: "Adagio" })?.heading).toBe("I. Adagio");
    expect(movementSection(sonata, { n: 2 })).toBeNull();
    // A movement asked for by its name: "Rondo Presto Agitato" holds "Presto agitato".
    expect(movementSection(sonata, { name: "Rondo Presto Agitato" })?.heading).toBe("III. Presto agitato");
  });
});

describe("notForAPiece", () => {
  const parsed = parseClassicalTitle("Lighthouse Sonata");
  it("turns down a film, a person who isn't a musician, and a piece in another key", () => {
    expect(notForAPiece("Marrow (film)", "Marrow is a 1994 British drama film about the composer.", parsed)).toMatch(/film/);
    expect(notForAPiece("Edwin Marrow", "Edwin Marrow (1790–1850) was an English painter of seascapes.", parsed)).toMatch(/person/);
    expect(notForAPiece("Edda Marrow", "Edda Marrow (1801–1870) was an English composer and pianist.", parsed)).toBe("");
    expect(notForAPiece("Prelude in G minor (Marrow)", "The Prelude in G minor is a piano piece.", parseClassicalTitle("Prelude in C# minor"))).toMatch(/g minor/);
    expect(notForAPiece("Piano Sonata No. 4 (Marrow)", "The Piano Sonata No. 4 is a piano sonata by Edda Marrow.", parsed)).toBe("");
  });
});

describe("classical pieces through Wikidata (issue #260)", () => {
  // Responses shaped like Wikidata's and Wikipedia's, trimmed, with made-up names.
  type Entry = { match: string; body?: unknown; page?: string; extract?: string };
  const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/classical-works.json"), "utf8")) as Record<string, Entry[]>;
  const asked: string[] = [];
  let busy = false;
  const fetchMock = jest.fn(async (input: string | URL) => {
    const url = decodeURIComponent(String(input)).replace(/\+/g, " ");
    asked.push(url);
    if (new URL(url).hostname === "www.wikidata.org") {
      if (busy) return { ok: true, status: 200, json: async () => JSON.parse("You are making too many requests to the API.") } as unknown as Response;
      const hit = fixtures.wikidata.find((e) => url.includes(e.match));
      return { ok: true, status: 200, json: async () => hit?.body ?? { search: [], query: { search: [] }, entities: {} } } as Response;
    }
    const hit = fixtures.wikipedia.find((e) => url.includes(e.match));
    const body = hit?.extract !== undefined ? { query: { pages: { 1: { title: hit.page, extract: hit.extract } } } } : (hit?.body ?? { query: { search: [], pages: {} } });
    return { ok: true, status: 200, json: async () => body } as Response;
  });
  const lookup = (title: string, artist: string) => fetchGrounding({ title, artist });

  beforeAll(() => {
    global.fetch = fetchMock as unknown as typeof fetch;
    classicalPace.ms = 0;
  });
  beforeEach(() => {
    clearGroundingCache();
    asked.length = 0;
    busy = false;
    (config as { classicalLookup: boolean }).classicalLookup = true;
  });

  it("finds a piece by its nickname through the composer's works, never the film named after her", async () => {
    const text = await lookup("Lighthouse Sonata", "Marrow");
    expect(text.split("\n")[0]).toBe("Piano Sonata No. 4 (Marrow)");
    expect(asked.some((u) => u.includes("haswbstatement:P86=Q9100001 Lighthouse Sonata"))).toBe(true);
    expect(workMatchConfidence({ title: "Lighthouse Sonata", artist: "Marrow" }, text)).toEqual({ level: "sure", reason: "the piece's own article, through its Wikidata item" });
  });

  it("reads the movement asked for first", async () => {
    const text = await lookup("Lighthouse Sonata (3rd Movement)", "Marrow");
    expect(text.split("\n")[0]).toBe("Piano Sonata No. 4 (Marrow)");
    expect(text.split("\n")[1]).toMatch(/^III\. Presto agitato: The third movement is a stormy presto/);
  });

  it("keeps a whole piece apart from one of its movements", async () => {
    await lookup("Lighthouse Sonata (3rd Movement)", "Marrow");
    const whole = await lookup("Lighthouse Sonata", "Marrow");
    expect(whole.split("\n")[1]).not.toMatch(/^III\./);
  });

  it("reads a piece with no article of its own from its parent work's, led by its section, and is sure of it", async () => {
    const text = await lookup("Tidewater", "Marrow");
    expect(text.split("\n")[0]).toBe("Coastal Suite");
    expect(text.split("\n")[1]).toBe("About this piece: Tidewater is part of Coastal Suite, by Edda Marrow.");
    expect(text).toContain("Tidewater: Tidewater, the third movement, is a gentle barcarolle");
    expect(workMatchConfidence({ title: "Tidewater", artist: "Marrow" }, text)).toEqual({ level: "sure", reason: "the parent work's article, with a section on the piece" });
  });

  it("is unsure of the parent work's article when no section is about the piece", async () => {
    const text = await lookup("Gull Song", "Marrow");
    expect(text.split("\n")[0]).toBe("Coastal Suite");
    expect(workMatchConfidence({ title: "Gull Song", artist: "Marrow" }, text)).toEqual({ level: "unsure", reason: "the parent work's article has no section on the piece" });
  });

  it("finds the whole a part belongs to when the part doesn't say (has part, P527), by a nickname (P1449)", async () => {
    const text = await lookup("Thaw", "Marrow");
    expect(text.split("\n")[0]).toBe("The Turning Year (Marrow)");
    expect(text).toContain('Concerto No. 2 in F major, Op. 5, "Il disgelo" (Thaw): The second concerto paints the thaw');
  });

  it("finds a work by its catalog code and reads the request's word as a movement", async () => {
    const text = await lookup("L. 40 Prelude", "Marrow");
    expect(text.split("\n")[0]).toBe("Coastal Suite");
  });

  it("takes no guess when several of the composer's works fit, and searches no further", async () => {
    expect(await lookup("Mazurka in F minor", "Marrow")).toBe("");
    expect(asked.some((u) => u.includes("haswbstatement:P86=Q9100001 Mazurka F minor"))).toBe(true);
    expect(asked.filter((u) => u.includes("haswbstatement:P86=Q9100001 Mazurka")).length).toBe(1);
  });

  it("of two items for one piece, takes the one whose parent has an article", async () => {
    const text = await lookup("Heron Dance", "Marrow");
    expect(text.split("\n")[0]).toBe("Coastal Suite");
    expect(text.split("\n")[1]).toBe("About this piece: Heron Dance is part of Coastal Suite, by Edda Marrow.");
  });

  it("looks a performer's piece up by its title and names who wrote it", async () => {
    const text = await lookup("Lighthouse Sonata", "Ivo Brennan");
    expect(text.split("\n")[0]).toBe("Piano Sonata No. 4 (Marrow)");
    expect(text.split("\n")[1]).toBe("About this piece: Piano Sonata No. 4 is by Edda Marrow.");
    expect(asked.some((u) => u.includes("haswbstatement:P86 Lighthouse Sonata"))).toBe(true);
    expect(workMatchConfidence({ title: "Lighthouse Sonata", artist: "Ivo Brennan" }, text).level).toBe("sure");
  });

  it("never takes a film from the usual search for a classical request Wikidata has no work for", async () => {
    expect(await lookup("Storm Sonata", "Marrow")).toBe("");
    expect(asked.some((u) => u.includes("titles=Marrow (film)"))).toBe(true);
  });

  it("finds a composer by a surname alone among composers, only a famous one: never a namesake of a game", async () => {
    const text = await lookup("Lighthouse Sonata", "Holloway");
    expect(asked.some((u) => u.includes("haswbstatement:P106=Q36834 Holloway"))).toBe(true);
    expect(text.split("\n")[0]).toBe("Piano Sonata No. 4 (Marrow)");
    await lookup("Overworld Sonata", "Kestrel");
    expect(asked.some((u) => u.includes("haswbstatement:P106=Q36834 Kestrel"))).toBe(true);
    expect(asked.some((u) => u.includes("haswbstatement:P86=Q9100006"))).toBe(false);
  });

  it("leaves a pop act's songs to the usual lookup: no work search for a singer-songwriter who plays the piano", async () => {
    await lookup("Paper Lanterns", "Tamsin Vale");
    expect(asked.some((u) => u.includes("wbsearchentities"))).toBe(true);
    expect(asked.some((u) => new URL(u).hostname === "www.wikidata.org" && u.includes("list=search"))).toBe(false);
  });

  it("with CLASSICAL_LOOKUP=off, asks Wikidata nothing and the film is taken as before", async () => {
    (config as { classicalLookup: boolean }).classicalLookup = false;
    busy = true;
    expect(await lookup("Storm Sonata", "Marrow")).toMatch(/^Marrow \(film\)\n/);
    expect(asked.some((u) => new URL(u).hostname === "www.wikidata.org")).toBe(false);
  });

  it("when Wikidata is busy, looks the song up the usual way and caches nothing", async () => {
    busy = true;
    expect(await lookup("Lighthouse Sonata", "Marrow")).toBe("");
    busy = false;
    expect((await lookup("Lighthouse Sonata", "Marrow")).split("\n")[0]).toBe("Piano Sonata No. 4 (Marrow)");
  });
});
