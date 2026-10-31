import path from "path";
import { presetFolder } from "./now-playing-folder";

/** Made-up Windows-style places, joined the way this computer joins them. */
const home = path.join(path.sep, "Users", "jane");
const usual = path.join(home, "Documents", "Nightbot");
const oneDrive = path.join(path.sep, "OneDrive", "Jane");
const existing = (...dirs: string[]) => (p: string) => dirs.includes(p);

describe("presetFolder", () => {
  it("uses the usual Documents folder first", () => {
    const env = { OneDrive: oneDrive };
    expect(presetFolder(["Nightbot"], env, home, existing(usual, path.join(oneDrive, "Documents", "Nightbot")))).toBe(usual);
  });

  it("falls back to Documents in OneDrive when the usual folder isn't there", () => {
    const moved = path.join(oneDrive, "Documents", "Nightbot");
    expect(presetFolder(["Nightbot"], { OneDrive: oneDrive }, home, existing(moved))).toBe(moved);
  });

  it("tries OneDrive, then OneDriveConsumer, then OneDriveCommercial", () => {
    const consumer = path.join(path.sep, "OneDrive", "Personal");
    const commercial = path.join(path.sep, "OneDrive", "Work");
    const env = { OneDrive: oneDrive, OneDriveConsumer: consumer, OneDriveCommercial: commercial };
    const at = (d: string) => path.join(d, "Documents", "Nightbot");
    expect(presetFolder(["Nightbot"], env, home, existing(at(consumer), at(commercial)))).toBe(at(consumer));
    expect(presetFolder(["Nightbot"], env, home, existing(at(commercial)))).toBe(at(commercial));
    expect(presetFolder(["Nightbot"], env, home, existing(at(oneDrive), at(commercial)))).toBe(at(oneDrive));
  });

  it("returns the usual folder when none exists, or no OneDrive is named", () => {
    expect(presetFolder(["Nightbot"], { OneDrive: oneDrive }, home, existing())).toBe(usual);
    expect(presetFolder(["Nightbot"], {}, home, existing())).toBe(usual);
    expect(presetFolder(["Nightbot"], { OneDrive: "  ", OneDriveConsumer: "" }, home, existing())).toBe(usual);
  });

  it("keeps a preset's subfolders under Documents", () => {
    const moved = path.join(oneDrive, "Documents", "streamling", "livetext");
    expect(presetFolder(["streamling", "livetext"], { OneDrive: oneDrive }, home, existing(moved))).toBe(moved);
  });

  it("looks on the real disk by default, and a folder that isn't there is not a match", () => {
    const nowhere = path.join(path.sep, "no-such-onedrive-folder");
    expect(presetFolder(["Nightbot"], { OneDrive: nowhere }, path.join(nowhere, "home"))).toBe(path.join(nowhere, "home", "Documents", "Nightbot"));
  });

  it("tries the Documents folder the app names first, then the home one", () => {
    const system = path.join(path.sep, "Redirected", "Documents");
    const there = path.join(system, "Nightbot");
    const env = { BUBBLEFACTS_DOCUMENTS_DIR: system };
    expect(presetFolder(["Nightbot"], env, home, existing(there, usual))).toBe(there);
    expect(presetFolder(["Nightbot"], env, home, existing(usual))).toBe(usual);
    expect(presetFolder(["Nightbot"], env, home, existing())).toBe(there);
  });
});
