process.env.TZ = "UTC";
jest.mock("electron", () => ({ app: { getPath: () => "/tmp" }, safeStorage: { isEncryptionAvailable: () => false } }));

import fs from "fs";
import os from "os";
import path from "path";
import { autoBackup, backupFileName, makeBackup, readBackup } from "./backup";
import { DEFAULTS } from "./settings";

const mine = {
  ...DEFAULTS,
  setupComplete: true,
  channel: "jane",
  token: "secret-token-123",
  seJwt: "secret-jwt-456",
  groqKey: "gsk_secret",
  anthropicKey: "sk-ant-secret",
  myFacts: ["[Song of Storms] It plays in a windmill."],
  myOriginals: ["Written during a snowstorm."],
  displayName: "Jane Composer",
  bubbleArea: "bottom" as const,
};

describe("backups", () => {
  it("keep the streamer's settings and facts, and never a sign-in or key", () => {
    const b = makeBackup(mine, { songFacts: [{ title: "A" }], wrongFacts: { k: ["x"] } }, "2.0.0-beta.9", new Date("2026-10-02T12:00:00Z"));
    const text = JSON.stringify(b);
    for (const secret of ["secret-token-123", "secret-jwt-456", "gsk_secret", "sk-ant-secret", "\"jane\""]) expect(text).not.toContain(secret);
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

  it("names the file by date", () => {
    expect(backupFileName(new Date("2026-10-02T12:00:00Z"))).toBe("BubbleFacts backup 2026-10-02.json");
  });
});

describe("automatic backups", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-backups-"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const at = (i: number) => new Date(Date.UTC(2026, 9, 2, 12, 0, i));

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
    expect(autoBackup("/dev/null/not-a-folder", makeBackup(mine, { songFacts: [], wrongFacts: {} }, "v"))).toBe("");
  });
});
