jest.mock("./config", () => ({ config: { topic: "none" } }));

import { aboutIsChannelTalk, aboutIsMusicChannel, connectAboutAsker, forgetAbouts, loginForArtist, loginForHandle, onAboutAnswer, twitchAbout } from "./twitch-about";

const sent: Array<{ login: string; chars: number; withCategory?: boolean }> = [];
beforeEach(() => {
  sent.length = 0;
  forgetAbouts();
  connectAboutAsker((m) => sent.push(m));
});
afterEach(() => {
  connectAboutAsker(null);
  jest.useRealTimers();
});

const found = { type: "twitch-about", login: "marlowkeys", state: "found", name: "MarlowKeys", facts: ["Marlow writes piano loops."] };

describe("loginForArtist", () => {
  it("takes one name that could be a login, without case", () => {
    expect(loginForArtist("MarlowKeys")).toBe("marlowkeys");
    expect(loginForArtist(" tin_lantern42 ")).toBe("tin_lantern42");
  });

  it("abstains on anything else", () => {
    for (const artist of ["Blue Moon", "Marlow, Pike", "Marlow & Pike", "Marlow feat. Pike", "Abba", "2049", "Piano", "ORCHESTRA", "Unknown", "Various", "", "marlow-keys"]) {
      expect(loginForArtist(artist)).toBe("");
    }
  });
});

describe("a credited handle (#450)", () => {
  it("is a login only when it is long and unusual enough to be the creator's own", () => {
    expect(loginForHandle("MarlowKeys")).toBe("marlowkeys");
    for (const handle of ["jane", "abc", "phoenix", "Piano", "2049"]) expect(loginForHandle(handle)).toBe("");
  });

  it("needs a second sign: a music category, or an About that speaks of making music", () => {
    const channel = (facts: string[], category = "") => ({ name: "MarlowKeys", facts, category });
    expect(aboutIsMusicChannel(channel(["Marlow lives in Lisbon."], "Music"))).toBe(true);
    expect(aboutIsMusicChannel(channel(["Marlow lives in Lisbon."], "DJs"))).toBe(true);
    expect(aboutIsMusicChannel(channel(["Marlow writes piano loops in Lisbon."], "Just Chatting"))).toBe(true);
    expect(aboutIsMusicChannel(channel(["Singer and songwriter."]))).toBe(true);
    // A stranger with the same name as someone's Instagram handle
    expect(aboutIsMusicChannel(channel(["Speedrunner from Ohio. Mostly platformers and kart racers."], "Retro"))).toBe(false);
    expect(aboutIsMusicChannel(channel(["I paint miniatures and talk about board games."]))).toBe(false);
  });
});

describe("aboutIsChannelTalk", () => {
  it("knows a sentence about the channel from one about the person", () => {
    expect(aboutIsChannelTalk("Follow for new loops every week!")).toBe(true);
    expect(aboutIsChannelTalk("Join the Discord.")).toBe(true);
    expect(aboutIsChannelTalk("Marlow writes piano loops.")).toBe(false);
  });
});

describe("twitchAbout", () => {
  it("asks the app, and asks once for a channel", async () => {
    const first = twitchAbout("marlowkeys");
    const second = twitchAbout("marlowkeys");
    expect(sent).toHaveLength(1);
    expect(sent[0].chars).toBeLessThan(160);
    onAboutAnswer(found);
    expect(await first).toEqual({ name: "MarlowKeys", facts: ["Marlow writes piano loops."], category: "" });
    expect(await second).toEqual(await first);
    await twitchAbout("marlowkeys");
    expect(sent).toHaveLength(1);
  });

  it("asks for the category only when told to, as its own question", async () => {
    const plain = twitchAbout("marlowkeys");
    expect(sent).toEqual([expect.not.objectContaining({ withCategory: expect.anything() })]);
    onAboutAnswer(found);
    expect((await plain)?.category).toBe("");

    // The plain answer knows no category, so a credited @name asks again, this time with it
    const credited = twitchAbout("marlowkeys", { category: true });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ login: "marlowkeys", withCategory: true });
    // A late plain answer isn't taken for it
    onAboutAnswer(found);
    onAboutAnswer({ ...found, category: "Music", withCategory: true });
    expect((await credited)?.category).toBe("Music");

    // And the fuller answer serves a plain question too
    expect((await twitchAbout("marlowkeys"))?.name).toBe("MarlowKeys");
    expect((await twitchAbout("marlowkeys", { category: true }))?.category).toBe("Music");
    expect(sent).toHaveLength(2);
  });

  it("keeps a miss and a failure, but not off, so connecting works from the next song", async () => {
    for (const [login, state, askedAgain] of [["nochannel1", "none", false], ["nochannel2", "failed", false], ["nochannel3", "off", true]] as const) {
      const asked = twitchAbout(login);
      onAboutAnswer({ type: "twitch-about", login, state });
      expect(await asked).toBeNull();
      const before = sent.length;
      const again = twitchAbout(login);
      expect(sent.length > before).toBe(askedAgain);
      if (askedAgain) onAboutAnswer({ type: "twitch-about", login, state });
      await again;
    }
  });

  it("asks nothing without the app", async () => {
    connectAboutAsker(null);
    expect(await twitchAbout("marlowkeys")).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("stops waiting for a slow answer, and keeps it for the next song", async () => {
    jest.useFakeTimers();
    const slow = twitchAbout("marlowkeys");
    await jest.advanceTimersByTimeAsync(2_000);
    expect(await slow).toBeNull();
    onAboutAnswer(found);
    expect((await twitchAbout("marlowkeys"))?.name).toBe("MarlowKeys");
    expect(sent).toHaveLength(1);
  });

  it("gives up on a question the app never answers, and survives a failed send", async () => {
    jest.useFakeTimers();
    const asked = twitchAbout("marlowkeys");
    await jest.advanceTimersByTimeAsync(60_000);
    await asked;
    void twitchAbout("marlowkeys");
    expect(sent).toHaveLength(2);
    forgetAbouts();
    connectAboutAsker(() => { throw new Error("channel closed"); });
    await expect(twitchAbout("marlowkeys")).resolves.toBeNull();
  });

  it("ignores answers nobody asked for, and forgets on request", async () => {
    onAboutAnswer(found);
    onAboutAnswer(null);
    void twitchAbout("marlowkeys");
    expect(sent).toHaveLength(1);
    forgetAbouts();
    onAboutAnswer(found);
    void twitchAbout("marlowkeys");
    expect(sent).toHaveLength(2);
  });

  it("treats an answer with no text as a miss", async () => {
    const asked = twitchAbout("marlowkeys");
    onAboutAnswer({ ...found, facts: [" "] });
    expect(await asked).toBeNull();
  });
});
