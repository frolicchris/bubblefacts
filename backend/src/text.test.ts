import { foldCase, removeAll, songIdentity, withoutArtistNote, withoutRefsAndComments } from "./text";

describe("foldCase", () => {
  it("lowercases and drops accents, keeping punctuation", () => {
    expect(foldCase("Café  Mr. Big")).toBe("cafe  mr. big");
  });
});

describe("songIdentity", () => {
  it("ignores case, accents and punctuation but keeps a version in brackets", () => {
    expect(songIdentity("Café-Noir (Acoustic)!")).toBe("cafe noir acoustic");
    expect(songIdentity("Night Drive (Acoustic)")).not.toBe(songIdentity("Night Drive (Remix)"));
  });
});

describe("withoutArtistNote (issue #262)", () => {
  it("leaves out the notes a song list adds after the artist's name", () => {
    expect(withoutArtistNote("Wren Halloway (note words)")).toBe("Wren Halloway");
    expect(withoutArtistNote("Wren Halloway [note]")).toBe("Wren Halloway");
    expect(withoutArtistNote("Wren Halloway (note) [another]")).toBe("Wren Halloway");
    expect(withoutArtistNote("Wren Halloway (note/other note")).toBe("Wren Halloway");
    expect(withoutArtistNote("Wren Halloway (a (nested) note)")).toBe("Wren Halloway");
    expect(withoutArtistNote("  The Orchard Lanterns  ")).toBe("The Orchard Lanterns");
  });

  it("keeps a handle, a name that is all brackets, and brackets that aren't at the end", () => {
    expect(withoutArtistNote("Jane (@janeplayskeys)")).toBe("Jane (@janeplayskeys)");
    expect(withoutArtistNote("(Untitled)")).toBe("(Untitled)");
    expect(withoutArtistNote("Drone Choir O)))")).toBe("Drone Choir O)))");
    expect(withoutArtistNote("Wren (and the Hollows) Band")).toBe("Wren (and the Hollows) Band");
  });

  it("is quick on a long run of brackets and spaces", () => {
    const long = "A" + " (".repeat(5000) + "x";
    const started = Date.now();
    withoutArtistNote(long);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("removeAll and withoutRefsAndComments", () => {
  it("removes until nothing matches", () => {
    expect(removeAll("<scr<script>ipt>x", /<script>/g)).toBe("x");
    expect(withoutRefsAndComments("a<!<!---->--b-->c<re<ref/>f>d</ref>e")).toBe("ace");
    expect(withoutRefsAndComments("a<!-- left open")).toBe("a");
  });
});
