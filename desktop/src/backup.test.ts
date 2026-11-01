jest.mock("electron", () => ({ app: { getPath: () => "/tmp" }, safeStorage: { isEncryptionAvailable: () => false } }));

import fs from "fs";
import os from "os";
import path from "path";
import { autoBackup, backupFileName, makeBackup, readBackup, REMOVED_WITH_DATA, wrongLogLines } from "./backup";
import { DEFAULTS } from "./settings";

const mine = {
  ...DEFAULTS,
  setupComplete: true,
  channel: "jane",
  token: "secret-token-123",
  seJwt: "secret-jwt-456",
  shareKey: "made-up-key-789",
  shareFacts: true,
  shareUrl: "https://share.example.com/events",
  shareChannel: "madeupchannel",
  groqKey: "gsk_secret",
  anthropicKey: "sk-ant-secret",
  twitchToken: "twitch-secret-at",
  twitchRefreshToken: "twitch-secret-rt",
  myFacts: ["[Song of Storms] It plays in a windmill."],
  myOriginals: ["Written during a snowstorm."],
  displayName: "Jane Composer",
  bubbleArea: "bottom" as const,
};

describe("backups", () => {
  it("keep the streamer's settings and facts, and never a sign-in or key", () => {
    const b = makeBackup(mine, { songFacts: [{ title: "A" }], wrongFacts: { k: ["x"] } }, "2.0.0-beta.9", new Date("2026-10-02T12:00:00Z"));
    const text = JSON.stringify(b);
    for (const secret of ["secret-token-123", "secret-jwt-456", "gsk_secret", "sk-ant-secret", "twitch-secret-at", "twitch-secret-rt", "made-up-key-789", "madeupchannel", "\"jane\""]) expect(text).not.toContain(secret);
    expect(b.settings).not.toHaveProperty("shareFacts");
    expect(b.settings).not.toHaveProperty("shareUrl");
    expect(b.settings).toMatchObject({ myFacts: mine.myFacts, myOriginals: mine.myOriginals, displayName: "Jane Composer", bubbleArea: "bottom" });
    expect(b.songFacts).toEqual([{ title: "A" }]);
    expect(b.createdAt).toBe("2026-10-02T12:00:00.000Z");
  });

  it("read back what they wrote", () => {
    const b = readBackup(JSON.stringify(makeBackup(mine, { songFacts: [], wrongFacts: {} }, "2.0.0-beta.9")));
    expect(b.settings.myFacts).toEqual(mine.myFacts);
    expect(b.songFacts).toEqual([]);
  });

  it("refuse other files, and take no sign-in or key from a doctored one", () => {
    expect(() => readBackup("not json")).toThrow(/isn't a BubbleFacts backup/);
    expect(() => readBackup(JSON.stringify({ format: "something-else" }))).toThrow(/isn't a BubbleFacts backup/);
    expect(() => readBackup(JSON.stringify({ format: "bubblefacts-backup", formatVersion: 2 }))).toThrow(/newer BubbleFacts/);
    const doctored = readBackup(JSON.stringify({ format: "bubblefacts-backup", formatVersion: 1, settings: { token: "evil", channel: "someone", myFacts: "not a list", factsPerSong: 3 } }));
    expect(doctored.settings).toEqual({ factsPerSong: 3 });
  });

  it("never change which AI writes the facts", () => {
    const b = makeBackup({ ...mine, ai: "ollama", ollamaUrl: "http://studio-pc:11434" }, { songFacts: [], wrongFacts: {} }, "2.0.0-beta.11");
    expect(b.settings).not.toHaveProperty("ai");
    expect(b.settings).not.toHaveProperty("ollamaUrl");
    expect(makeBackup({ ...mine, aiQuality: "high" }, { songFacts: [], wrongFacts: {} }, "2.0.0-beta.13").settings).not.toHaveProperty("aiQuality");
    const shared = readBackup(JSON.stringify({ format: "bubblefacts-backup", formatVersion: 1, settings: { ai: "ollama", ollamaUrl: "http://203.0.113.9:11434", ollamaModel: "theirs", factsPerSong: 3 } }));
    expect(shared.settings).toEqual({ factsPerSong: 3 });
  });

  it("names the file by date", () => {
    expect(backupFileName(new Date("2026-10-02T12:00:00Z"))).toBe("BubbleFacts backup 2026-10-02.json");
  });
});

describe("automatic backups", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-backups-"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Local time, as the file names are.
  const at = (i: number) => new Date(2026, 9, 2, 12, 0, i);

  it("saves one when the facts change, and none when nothing did", () => {
    expect(autoBackup(dir, makeBackup(mine, { songFacts: [], wrongFacts: {} }, "v", at(0)))).toMatch(/auto 2026-10-02 12-00-00\.json$/);
    expect(autoBackup(dir, makeBackup(mine, { songFacts: [], wrongFacts: {} }, "v", at(1)))).toBe("");
    const changed = { ...mine, myFacts: [...mine.myFacts, "A new fact."] };
    expect(autoBackup(dir, makeBackup(changed, { songFacts: [], wrongFacts: {} }, "v", at(2)))).not.toBe("");
    expect(fs.readdirSync(dir)).toHaveLength(2);
  });

  it("keeps only the newest ones", () => {
    for (let i = 10; i < 30; i++) autoBackup(dir, makeBackup({ ...mine, myFacts: [`Fact ${i}.`] }, { songFacts: [], wrongFacts: {} }, "v", at(i)), 5);
    const left = fs.readdirSync(dir).sort();
    expect(left).toHaveLength(5);
    expect(left[4]).toBe("auto 2026-10-02 12-00-29.json");
  });

  it("never stops the app when it can't write", () => {
    // A folder inside a regular file can't be made on any system.
    const file = path.join(dir, "a-file");
    fs.writeFileSync(file, "");
    expect(autoBackup(path.join(file, "backups"), makeBackup(mine, { songFacts: [], wrongFacts: {} }, "v"))).toBe("");
  });
});

describe("the Wrong log in backups and in Remove my data", () => {
  const press = { song: { title: "Moonlit Harbor", artist: "Test Quartet" }, caption: "A caption.", source: "Wikipedia: Harbor Game", article: "Harbor Game", appVersion: "2.1.0", date: "2026-10-18T12:00:00.000Z" };

  it("goes into a backup and comes back out of it", () => {
    const b = makeBackup(mine, { songFacts: [], wrongFacts: {}, wrongLog: [press] }, "2.1.0");
    expect(readBackup(JSON.stringify(b)).wrongLog).toEqual([press]);
  });

  it("is absent from a backup made before it existed, and from one with nothing logged", () => {
    expect(readBackup(JSON.stringify({ format: "bubblefacts-backup", formatVersion: 1 })).wrongLog).toBeNull();
    expect(makeBackup(mine, { songFacts: [], wrongFacts: {}, wrongLog: [] }, "2.1.0").wrongLog).toBeNull();
  });

  it("changes what an automatic backup compares, so a new press is backed up", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bubblefacts-backup-"));
    const first = makeBackup(mine, { songFacts: [], wrongFacts: {} }, "2.1.0", new Date("2026-10-18T12:00:00Z"));
    expect(autoBackup(dir, first)).not.toBe("");
    expect(autoBackup(dir, { ...first, wrongLog: [press] })).not.toBe("");
  });

  it("reads only whole records, newest 500", () => {
    const text = [...Array.from({ length: 502 }, (_, i) => JSON.stringify({ ...press, caption: `C${i}` })), '{"cut', "", "[1]"].join("\n");
    const got = wrongLogLines(text) as Array<{ caption: string }>;
    expect(got).toHaveLength(500);
    expect(got[0].caption).toBe("C2");
  });

  it("is deleted by Remove my data", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bubblefacts-remove-"));
    fs.writeFileSync(path.join(dir, "wrong-log.jsonl"), JSON.stringify(press) + "\n");
    for (const name of REMOVED_WITH_DATA) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    expect(fs.existsSync(path.join(dir, "wrong-log.jsonl"))).toBe(false);
    expect(REMOVED_WITH_DATA).toContain("wrong-log.jsonl");
    expect(REMOVED_WITH_DATA).toContain("aired-facts.json");
  });
});
