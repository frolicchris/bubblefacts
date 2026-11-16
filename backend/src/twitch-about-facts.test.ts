jest.mock("@anthropic-ai/sdk", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("./config", () => ({
  config: {
    sslStreamerName: "teststreamer",
    dataDir: process.env.BUBBLEFACTS_DATA_DIR,
    streamerDisplayName: "Test Streamer",
    originals: true,
    topic: "none",
    aiProvider: "anthropic",
    anthropicApiKey: "test-key",
    anthropicModel: "test-model",
    temperature: 0,
    factVerification: true,
    sourceRisk: true,
    factsPerSong: 5,
    factIntervalSeconds: 15,
    factDurationSeconds: 8,
    bubbleArea: "anywhere",
  },
}));
const actual = <T>(name: string, fn: string) => (...args: unknown[]): T => jest.requireActual(name)[fn](...args);
jest.mock("./wikidata", () => ({
  wikidataFacts: jest.fn().mockResolvedValue([]),
  artistFacts: jest.fn().mockResolvedValue([]),
  articleItem: jest.fn().mockResolvedValue(null),
  songItemFacts: actual("./wikidata", "songItemFacts"),
}));
jest.mock("./artist-good", () => ({ artistGoodFacts: jest.fn().mockResolvedValue([]), clearArtistGoodCache: jest.fn() }));
jest.mock("./musicbrainz", () => ({
  musicbrainzFacts: jest.fn().mockResolvedValue([]),
  artistByTitle: jest.fn().mockResolvedValue(""),
  cachedArtistByTitle: jest.fn().mockReturnValue(""),
  statedYear: actual("./musicbrainz", "statedYear"),
  statesAlbum: actual("./musicbrainz", "statesAlbum"),
  withoutYear: actual("./musicbrainz", "withoutYear"),
}));
jest.mock("./fact-verifier", () => ({
  ...jest.requireActual("./fact-verifier"),
  fetchGrounding: jest.fn().mockResolvedValue(""),
  summaryGate: jest.fn().mockResolvedValue(""),
  loadWikitext: jest.fn().mockResolvedValue(""),
}));

import fs from "fs";
import path from "path";
import { config } from "./config";
import { fetchGrounding } from "./fact-verifier";
import { blockFor, clearFactCache, factStats, forgetTwitchAbout, generateFacts, markWrong, SOURCE, unmarkWrong } from "./fact-generator";
import { musicbrainzFacts } from "./musicbrainz";
import { resetSongFacts, saveSongFacts } from "./song-facts";
import { topic } from "./topic";
import { ABOUT_CREDIT, connectAboutAsker, forgetAbouts, onAboutAnswer } from "./twitch-about";
import { resetWrongFacts } from "./wrong-facts";
import { SSLQueueItem, SSLSong } from "./types";

const song = (title: string, artist = "MarlowKeys"): SSLSong => ({ title, artist });
const about = ["Marlow writes piano loops in Lisbon.", "Marlow scored two short films."];
let asked: string[];
/** The app's answer to every question. */
let answer: (login: string) => Record<string, unknown>;

beforeEach(() => {
  asked = [];
  answer = (login) => ({ type: "twitch-about", login, state: "found", name: "MarlowKeys", facts: about });
  forgetAbouts();
  clearFactCache();
  connectAboutAsker(({ login }) => {
    asked.push(login);
    onAboutAnswer(answer(login));
  });
  (fetchGrounding as jest.Mock).mockResolvedValue("");
  (musicbrainzFacts as jest.Mock).mockResolvedValue([]);
  topic.taggedFacts = [];
  fs.rmSync(path.join(process.env.BUBBLEFACTS_DATA_DIR as string, "song-facts.json"), { force: true });
  resetSongFacts();
  resetWrongFacts();
});
afterAll(() => connectAboutAsker(null));

describe("Twitch About for a song no source knows", () => {
  it("shows the About word for word, credited on stream and on the dashboard", async () => {
    const before = factStats.twitchAbout;
    const facts = await generateFacts(song("Rain Loop"));
    expect(asked).toEqual(["marlowkeys"]);
    expect(facts.map((f) => f.text)).toEqual(about.map((f) => `${ABOUT_CREDIT}${f}`));
    expect(facts.every((f) => f.source === `${SOURCE.twitchAbout}MarlowKeys`)).toBe(true);
    expect(factStats.twitchAbout).toBe(before + 1);
  });

  it("covers another artist's song tagged Originals, but never the streamer's own", async () => {
    const tagged = (artist: string) => ({ song: { attributes: [{ name: "Originals" }], artist } }) as unknown as SSLQueueItem;
    const facts = await generateFacts(song("Rain Loop"), tagged("MarlowKeys"));
    expect(facts[0].text).toBe(`${ABOUT_CREDIT}${about[0]}`);
    asked = [];
    clearFactCache();
    await generateFacts(song("Rain Loop", config.sslStreamerName), tagged(config.sslStreamerName));
    expect(asked).toEqual([]);
  });

  it("never asks about a song with an article or database facts", async () => {
    (musicbrainzFacts as jest.Mock).mockResolvedValue(['"Rain Loop" came out in 2019.']);
    await generateFacts(song("Rain Loop"));
    expect(asked).toEqual([]);
  });

  it("never asks about a song with the streamer's own or tagged facts", async () => {
    saveSongFacts({ title: "Rain Loop", artist: "MarlowKeys", facts: ["Mine."] });
    await generateFacts(song("Rain Loop"));
    topic.taggedFacts = [{ tag: "MarlowKeys", text: "A friend of the channel." }];
    await generateFacts(song("Snow Loop"));
    expect(asked).toEqual([]);
  });

  it("never asks about a name that can't safely be a login, or a guessed artist", async () => {
    for (const s of [song("One", "Blue Moon"), song("Two", "Marlow & Pike"), song("Three", "Piano"), { ...song("Four"), artistUncertain: true }]) await generateFacts(s);
    expect(asked).toEqual([]);
  });

  it("drops what can't go on stream, and anything left goes on as before", async () => {
    answer = (login) => ({ type: "twitch-about", login, state: "found", name: "MarlowKeys", facts: ["Find me at marlow.tv now.", "Type !discord in chat today.", "Follow for new loops every week!"] });
    const facts = await generateFacts(song("Rain Loop"));
    expect(asked).toHaveLength(1);
    expect(facts.some((f) => f.source?.startsWith(SOURCE.twitchAbout))).toBe(false);
  });

  it("a Twitch failure, or Twitch being off, leaves the song as it would be", async () => {
    for (const [title, state] of [["Rain Loop", "failed"], ["Snow Loop", "off"]]) {
      answer = (login) => ({ type: "twitch-about", login, state });
      forgetAbouts();
      const facts = await generateFacts(song(title));
      expect(facts.some((f) => f.source?.startsWith(SOURCE.twitchAbout))).toBe(false);
    }
  });

  it("shows a sentence once across the artist's songs", async () => {
    await generateFacts(song("Rain Loop"));
    const next = await generateFacts(song("Snow Loop"));
    expect(next.some((f) => f.source?.startsWith(SOURCE.twitchAbout))).toBe(false);
  });

  it("Wrong blocks the channel for that song, and Undo lets it back", async () => {
    const s = song("Rain Loop");
    const [fact] = await generateFacts(s);
    expect(blockFor(fact.source)).toBe(fact.source);
    expect(markWrong(s, fact.text, fact.source)).toBe(fact.source);
    clearFactCache();
    expect((await generateFacts(s)).some((f) => f.source === fact.source)).toBe(false);
    unmarkWrong(s, fact.source as string);
    clearFactCache();
    expect((await generateFacts(s)).some((f) => f.source === fact.source)).toBe(true);
  });

  it("turning it off takes its facts off songs already looked up", async () => {
    const s = song("Rain Loop");
    await generateFacts(s);
    answer = (login) => ({ type: "twitch-about", login, state: "off" });
    forgetTwitchAbout();
    expect((await generateFacts(s)).some((f) => f.source?.startsWith(SOURCE.twitchAbout))).toBe(false);
  });

  it("without an AI, a song with an article still isn't looked up", async () => {
    (config as { aiProvider: string }).aiProvider = "none";
    (fetchGrounding as jest.Mock).mockResolvedValue("Rain Loop\nRain Loop is a song by MarlowKeys.");
    await generateFacts(song("Rain Loop"));
    (config as { aiProvider: string }).aiProvider = "anthropic";
    expect(asked).toEqual([]);
  });
});

describe("A song credited to a Twitch handle", () => {
  const credited = (title: string, artist = "Marlow (@MarlowKeys)") => song(title, artist);

  it("takes the handle as the channel and shows its About", async () => {
    const facts = await generateFacts(credited("Rain Loop"));
    expect(asked).toEqual(["marlowkeys"]);
    expect(facts.map((f) => f.text)).toEqual(about.map((f) => `${ABOUT_CREDIT}${f}`));
  });

  it("works for a bare @handle, and never looks up Wikipedia or MusicBrainz", async () => {
    (musicbrainzFacts as jest.Mock).mockClear();
    (fetchGrounding as jest.Mock).mockClear();
    await generateFacts(credited("Rain Loop", "@marlowkeys"));
    expect(asked).toEqual(["marlowkeys"]);
    expect(musicbrainzFacts).not.toHaveBeenCalled();
    expect(fetchGrounding).not.toHaveBeenCalled();
  });

  it("lets the streamer's own or tagged facts win", async () => {
    saveSongFacts({ title: "Rain Loop", artist: "Marlow (@MarlowKeys)", facts: ["Mine."] });
    await generateFacts(credited("Rain Loop"));
    topic.taggedFacts = [{ tag: "Marlow (@MarlowKeys)", text: "A friend of the channel." }];
    await generateFacts(credited("Snow Loop"));
    expect(asked).toEqual([]);
  });

  it("leaves the song as it was when Twitch is off, and honors Wrong", async () => {
    answer = (login) => ({ type: "twitch-about", login, state: "off" });
    expect((await generateFacts(credited("Rain Loop"))).some((f) => f.source?.startsWith(SOURCE.twitchAbout))).toBe(false);
    answer = (login) => ({ type: "twitch-about", login, state: "found", name: "MarlowKeys", facts: about });
    forgetAbouts();
    clearFactCache();
    const s = credited("Snow Loop");
    const [fact] = await generateFacts(s);
    markWrong(s, fact.text, fact.source);
    clearFactCache();
    expect((await generateFacts(s)).some((f) => f.source === fact.source)).toBe(false);
  });

  it("drops channel talk, and skips a placeholder request", async () => {
    answer = (login) => ({ type: "twitch-about", login, state: "found", name: "MarlowKeys", facts: ["Follow for new loops every week!"] });
    expect((await generateFacts(credited("Rain Loop"))).some((f) => f.source?.startsWith(SOURCE.twitchAbout))).toBe(false);
    asked = [];
    await generateFacts(credited("Off-List YouTube Request < 5 Min (Free)"));
    expect(asked).toEqual([]);
  });
});
