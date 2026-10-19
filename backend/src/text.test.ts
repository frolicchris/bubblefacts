import { foldCase, songIdentity } from "./text";

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
