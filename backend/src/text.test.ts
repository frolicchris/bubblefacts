import { foldCase, removeAll, songIdentity, withoutArtistNote, withoutRefsAndComments, withoutRequestCredit } from "./text";

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

describe("withoutRequestCredit: who asked or paid for a song", () => {
  it("leaves out a note naming who commissioned or requested it, bracketed or not", () => {
    expect(withoutArtistNote("Wren Halloway, Commissioned by Moss Tinker")).toBe("Wren Halloway");
    expect(withoutArtistNote("Wren Halloway, Commissioned by A")).toBe("Wren Halloway");
    expect(withoutArtistNote("Wren Halloway (commissioned by Moss Tinker)")).toBe("Wren Halloway");
    expect(withoutArtistNote("Wren Halloway - requested by Moss Tinker")).toBe("Wren Halloway");
    expect(withoutArtistNote("Wren Halloway | req. by Moss Tinker")).toBe("Wren Halloway");
    expect(withoutArtistNote("Wren Halloway, for Moss Tinker")).toBe("Wren Halloway");
    expect(withoutArtistNote("Wren Halloway (note), Commissioned by Moss Tinker")).toBe("Wren Halloway");
    expect(withoutArtistNote("Requested by Moss Tinker")).toBe("");
    expect(withoutRequestCredit("Glass Orchard (requested by Moss Tinker)")).toBe("Glass Orchard");
    expect(withoutRequestCredit("Glass Orchard - Suggested by Moss Tinker")).toBe("Glass Orchard");
  });

  it("keeps names and titles that only hold the words", () => {
    expect(withoutArtistNote("Lanterns for Hollows")).toBe("Lanterns for Hollows");
    expect(withoutArtistNote("Wren, Hollow & Fire")).toBe("Wren, Hollow & Fire");
    expect(withoutArtistNote("Special Request")).toBe("Special Request");
    // "for" counts only in an artist field: a title is often "A Song for Someone".
    expect(withoutRequestCredit("Glass Orchard, for Wren")).toBe("Glass Orchard, for Wren");
    expect(withoutRequestCredit("The Request")).toBe("The Request");
  });
});

describe("removeAll and withoutRefsAndComments", () => {
  it("removes until nothing matches", () => {
    expect(removeAll("<scr<script>ipt>x", /<script\b[^>]*>/gi)).toBe("x");
    expect(withoutRefsAndComments("a<!<!---->--b-->c<re<ref/>f>d</ref>e")).toBe("ace");
    expect(withoutRefsAndComments("a<!-- left open")).toBe("a");
  });
});
