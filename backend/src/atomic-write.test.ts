import fs from "fs";
import os from "os";
import path from "path";
import { writeFileAtomic } from "./atomic-write";

describe("writeFileAtomic", () => {
  let dir: string;
  beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-atomic-"))));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("writes a new file and replaces an existing one, leaving no temporary file", () => {
    const file = path.join(dir, "session.json");
    writeFileAtomic(file, "first");
    writeFileAtomic(file, "second");
    expect(fs.readFileSync(file, "utf8")).toBe("second");
    expect(fs.readdirSync(dir)).toEqual(["session.json"]);
  });

  it("keeps the old file whole when the write fails", () => {
    const file = path.join(dir, "session.json");
    writeFileAtomic(file, "before");
    const write = jest.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    });
    expect(() => writeFileAtomic(file, "after")).toThrow("no space");
    write.mockRestore();
    expect(fs.readFileSync(file, "utf8")).toBe("before");
    expect(fs.readdirSync(dir)).toEqual(["session.json"]);
  });

  const posix = process.platform === "win32" ? it.skip : it;
  posix("sets the mode asked for, and otherwise keeps the file's own", () => {
    const secret = path.join(dir, "settings.json");
    writeFileAtomic(secret, "{}", { mode: 0o600 });
    expect(fs.statSync(secret).mode & 0o777).toBe(0o600);
    const shared = path.join(dir, "song-facts.json");
    fs.writeFileSync(shared, "[]");
    fs.chmodSync(shared, 0o640);
    writeFileAtomic(shared, "[1]");
    expect(fs.statSync(shared).mode & 0o777).toBe(0o640);
  });
});
