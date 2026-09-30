jest.mock("./config", () => ({ config: { topic: "general" } }));

import { artistFromChannel, parseVideoTitle } from "./youtube-title";
import { resolveGameAndTrack } from "./fact-verifier";

describe("parseVideoTitle", () => {
  it.each<[string, string, string, string]>([
    // [video title, uploader channel, title, artist]
    // Official uploads
    ["Ciara - 1, 2 Step (Official Video) ft. Missy Elliott", "CiaraVEVO", "1, 2 Step", "Ciara"],
    // Covers on an instrument: the instrument is a label, not the song
    ["EVERYBODY DANCE NOW - DRUM COVER | C+C MUSIC FACTORY", "Some Drummer", "EVERYBODY DANCE NOW", "C+C MUSIC FACTORY"],
    ["C+C Music Factory - Everybody Dance Now (Drum Cover)", "Some Drummer", "Everybody Dance Now", "C+C Music Factory"],
    ["The Midnight - Lost Boy [Music Video]", "Digital Gravity", "Lost Boy", "The Midnight"],
    // From the same stream: a label after the pipe, a show's initials, hashtags
    ["Sunflower Seeds | Original Song (Live Performance)", "JoshuaWooMusic", "Sunflower Seeds", "JoshuaWooMusic"],
    ["Friendos (featuring A$AP Rocky) - SNL", "Saturday Night Live", "Friendos", "Saturday Night Live"],
    ["Lil Nas X, Jack Harlow - INDUSTRY BABY (Official Video) #shorts", "LilNasXVEVO", "INDUSTRY BABY", "Lil Nas X, Jack Harlow"],
    ["Rick Astley - Never Gonna Give You Up (Official Music Video)", "Rick Astley", "Never Gonna Give You Up", "Rick Astley"],
    ["Queen – Bohemian Rhapsody (Official Video Remastered)", "Queen Official", "Bohemian Rhapsody", "Queen"],
    ["Adele - Hello (Official Lyric Video)", "AdeleVEVO", "Hello", "Adele"],
    ["The Weeknd - Blinding Lights (Official Audio)", "TheWeekndVEVO", "Blinding Lights", "The Weeknd"],
    ["Coldplay - Yellow (Official Video) [4K]", "Coldplay", "Yellow", "Coldplay"],
    ["a-ha - Take On Me (Official Video) [Remastered in 4K]", "a-ha", "Take On Me", "a-ha"],
    ["Fleetwood Mac - Dreams (2004 Remaster)", "Fleetwood Mac", "Dreams", "Fleetwood Mac"],
    ["The Beatles - Here Comes The Sun (Remastered 2009)", "The Beatles", "Here Comes The Sun", "The Beatles"],
    ["Toto - Africa (Official HD Video)", "TotoVEVO", "Africa", "Toto"],
    ["Mark Ronson - Uptown Funk (Official Video) ft. Bruno Mars", "MarkRonsonVEVO", "Uptown Funk", "Mark Ronson"],
    ["Daft Punk - Get Lucky (feat. Pharrell Williams and Nile Rodgers)", "Daft Punk", "Get Lucky", "Daft Punk"],
    ["Calvin Harris ft. Rihanna - This Is What You Came For", "CalvinHarrisVEVO", "This Is What You Came For", "Calvin Harris"],
    ["Ed Sheeran - Perfect [Official Video]", "Ed Sheeran", "Perfect", "Ed Sheeran"],
    ["Linkin Park - Numb - Official Music Video", "Linkin Park", "Numb", "Linkin Park"],
    ["Imagine Dragons - Believer (Lyrics)", "7clouds", "Believer", "Imagine Dragons"],
    ["Hozier - Take Me To Church | Lyrics", "Lyric Channel", "Take Me To Church", "Hozier"],
    ["Taylor Swift - 22", "TaylorSwiftVEVO", "22", "Taylor Swift"],
    ["Prince - 1999 (Official Video)", "Prince", "1999", "Prince"],
    // Auto-generated "Topic" channels put only the song in the title
    ["Blinding Lights", "The Weeknd - Topic", "Blinding Lights", "The Weeknd"],
    ["Clair de lune", "Claude Debussy - Topic", "Clair de lune", "Claude Debussy"],
    ["Hello", "AdeleVEVO", "Hello", "Adele"],
    // Quoted titles
    ['Nirvana "Smells Like Teen Spirit"', "Nirvana", "Smells Like Teen Spirit", "Nirvana"],
    // Classical
    ["Beethoven - Moonlight Sonata (3rd Movement)", "Rousseau", "Moonlight Sonata (3rd Movement)", "Beethoven"],
    ["Chopin - Nocturne Op. 9 No. 2", "Rousseau", "Nocturne Op. 9 No. 2", "Chopin"],
    ["Debussy - Clair de Lune [Piano]", "Rousseau", "Clair de Lune", "Debussy"],
    // Game and film music, in both orders
    ["Zelda: Ocarina of Time - Song of Storms", "GilvaSunner", "Song of Storms", "Zelda: Ocarina of Time"],
    ["Song of Storms - The Legend of Zelda: Ocarina of Time", "Some Channel", "Song of Storms", "The Legend of Zelda: Ocarina of Time"],
    ["Aerith's Theme - Final Fantasy VII OST", "Uploader", "Aerith's Theme", "Final Fantasy VII"],
    ["Final Fantasy VII - Aerith's Theme [Piano Cover]", "Uploader", "Aerith's Theme", "Final Fantasy VII"],
    ["Undertale - Megalovania (Piano Cover) | Rousseau", "Rousseau", "Megalovania", "Undertale"],
    ["Rains of Castamere | Game of Thrones", "Uploader", "Rains of Castamere", "Game of Thrones"],
    ["Main Theme | Game of Thrones (Soundtrack by Ramin Djawadi)", "Uploader", "Main Theme", "Game of Thrones"],
    ["Song of Storms (Ocarina of Time OST)", "Uploader", "Song of Storms", "Ocarina of Time"],
    ['Let It Go (From "Frozen")', "DisneyMusicVEVO", "Let It Go", "Frozen"],
    ["Idina Menzel - Let It Go (From \"Frozen\") (Official Video)", "DisneyMusicVEVO", "Let It Go", "Idina Menzel"],
    ["Hans Zimmer - Time (Inception)", "Hans Zimmer", "Time (Inception)", "Hans Zimmer"],
    ["Super Mario 64 - Dire, Dire Docks", "Uploader", "Dire, Dire Docks", "Super Mario 64"],
    ["Megalovania", "Toby Fox - Topic", "Megalovania", "Toby Fox"],
    // Covers with no separator: the channel is only a guess
    ["Clair de Lune (Piano)", "Rousseau", "Clair de Lune", "Rousseau"],
    ["River Flows In You - Yiruma", "Yiruma", "River Flows In You", "Yiruma"],
    // Re-uploads that only relabel the song
    ["Hotel California (Slowed + Reverb)", "Eagles - Topic", "Hotel California", "Eagles"],
    ["Nightcore - Angel With A Shotgun (Lyrics)", "NightcoreReality", "Angel With A Shotgun", "NightcoreReality"],
    ["Interstellar Main Theme (1 Hour Extended)", "Hans Zimmer - Topic", "Interstellar Main Theme", "Hans Zimmer"],
    ["Gymnopédie No.1 (Piano Version)", "Erik Satie - Topic", "Gymnopédie No.1", "Erik Satie"],
    ["Pokémon Red/Blue - Lavender Town [Remastered]", "Uploader", "Lavender Town", "Pokémon Red/Blue"],
    // No channel at all
    ["Some Unknown Tune", "", "Some Unknown Tune", ""],
  ])("%s (by %s)", (raw, channel, title, artist) => {
    expect(parseVideoTitle(raw, channel)).toMatchObject({ title, artist });
  });

  it("is confident about a split title or an official channel, not about an uploader's name", () => {
    expect(parseVideoTitle("Ciara - 1, 2 Step", "anyone").confident).toBe(true);
    expect(parseVideoTitle("Blinding Lights", "The Weeknd - Topic").confident).toBe(true);
    expect(parseVideoTitle("Rains of Castamere | Game of Thrones", "x").confident).toBe(true);
    expect(parseVideoTitle("Clair de Lune (Piano)", "Rousseau").confident).toBe(false);
  });

  it("keeps the uploader's title when nothing readable is left", () => {
    expect(parseVideoTitle("(Official Video)", "")).toMatchObject({ title: "(Official Video)", confident: false });
    expect(parseVideoTitle("", "")).toMatchObject({ title: "", artist: "" });
  });

  it("keeps parts of a title that look like labels but aren't only labels", () => {
    expect(parseVideoTitle("Queen - Bohemian Rhapsody (Live Aid 1985)", "Queen").title).toBe("Bohemian Rhapsody (Live Aid 1985)");
    expect(parseVideoTitle("Avicii - Levels (Skrillex Remix)", "Avicii").title).toBe("Levels (Skrillex Remix)");
  });

  it("gives the fact pipeline the work and the track the way a song list would", () => {
    const zelda = parseVideoTitle("Song of Storms - The Legend of Zelda: Ocarina of Time", "x");
    expect(resolveGameAndTrack(zelda)).toEqual({ game: "The Legend of Zelda: Ocarina of Time", track: "Song of Storms" });
    const got = parseVideoTitle("Rains of Castamere | Game of Thrones", "x");
    expect(resolveGameAndTrack(got)).toEqual({ game: "Game of Thrones", track: "Rains of Castamere" });
    const ciara = parseVideoTitle("Ciara - 1, 2 Step (Official Video) ft. Missy Elliott", "CiaraVEVO");
    expect(resolveGameAndTrack(ciara)).toEqual({ game: "Ciara", track: "1, 2 Step" });
  });
});

describe("artistFromChannel", () => {
  it.each<[string, string, boolean]>([
    ["CiaraVEVO", "Ciara", true],
    ["TaylorSwiftVEVO", "Taylor Swift", true],
    ["ACDCVEVO", "ACDC", true],
    ["Imagine Dragons VEVO", "Imagine Dragons", true],
    ["Claude Debussy - Topic", "Claude Debussy", true],
    ["Rousseau", "Rousseau", false],
    ["", "", false],
  ])("%s", (channel, artist, official) => {
    expect(artistFromChannel(channel)).toEqual({ artist, official });
  });
});
