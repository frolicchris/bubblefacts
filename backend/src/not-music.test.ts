import { isNotMusic } from "./not-music";

const track = (title: string, artist = "Unknown") => ({ title, artist });

describe("isNotMusic", () => {
  it.each([
    ["a fake commercial", track("Moonbrew Cola (Fake Commercial)", "The Morning Crew")],
    ["a bracketed tag", track("Moonbrew Cola [Commercial]", "Harbor FM")],
    ["a jingle tag", track("Harbor FM (Jingle)", "Harbor FM")],
    ["a station ident", track("Harbor FM Station ID", "Harbor FM")],
    ["a hyphenated ident", track("Station-ID 3", "Harbor FM")],
    ["the word ident", track("Harbor FM Ident", "Harbor FM")],
    ["a break", track("Commercial Break", "Harbor FM")],
    ["radio imaging in the artist field", track("Top of the Hour", "Radio Imaging")],
    ["a folder-style artist", track("Moonbrew Cola", "Commercials")],
    ["a title alone ending in the word", track("Moonbrew Cola Commercial")],
    ["a numbered title alone", track("Jingle 03")],
  ])("catches %s", (_name, t) => {
    expect(isNotMusic(t)).toBe(true);
  });

  it.each([
    ["a Christmas song", track("Jingle Bell Rock", "Wren Halloway")],
    ["a song that names the word", track("Commercial", "Wren Halloway")],
    ["a song ending in the word", track("Beer Commercial", "Wren Halloway")],
    ["a radio edit", track("Night Ferry (Radio Edit)", "Wren Halloway")],
    ["a promo copy", track("Night Ferry (Promo)", "Wren Halloway")],
    ["a promo version", track("Night Ferry (Commercial Version)", "Wren Halloway")],
    ["a title with radio in it", track("Radio Harbor", "Wren Halloway")],
    ["a word that only contains the tag", track("Bad Advice (Ladder)", "Wren Halloway")],
  ])("leaves alone %s", (_name, t) => {
    expect(isNotMusic(t)).toBe(false);
  });

  it("never touches a live learn: its banner is the point", () => {
    expect(isNotMusic({ ...track("Station ID", "Harbor FM"), liveLearn: true })).toBe(false);
  });
});
