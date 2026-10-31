import path from "path";
import { folderShownInstead, presetFolder, presetFoldersShown } from "./now-playing-folder";

const home = path.join(path.sep, "Users", "jane");
const oneDrive = path.join(path.sep, "OneDrive", "Jane");
const moved = path.join(oneDrive, "Documents", "Nightbot");
const existing = (...dirs: string[]) => (p: string) => dirs.includes(p);

describe("the folder the picker names", () => {
  it("is the same folder the server looks in", () => {
    expect(presetFolder(["Nightbot"], { OneDrive: oneDrive }, home, existing(moved))).toBe(moved);
    expect(presetFolder(["Nightbot"], { OneDrive: oneDrive }, home, existing())).toBe(path.join(home, "Documents", "Nightbot"));
  });

  it("is shown only when it differs from the usual Documents folder", () => {
    expect(folderShownInstead(["Nightbot"], { OneDrive: oneDrive }, home, existing(moved))).toBe(moved);
    expect(folderShownInstead(["Nightbot"], { OneDrive: oneDrive }, home, existing(path.join(home, "Documents", "Nightbot"), moved))).toBe("");
    expect(folderShownInstead(["Nightbot"], {}, home, existing())).toBe("");
    const streamling = path.join(oneDrive, "Documents", "streamling", "livetext");
    expect(folderShownInstead(["streamling", "livetext"], { OneDrive: oneDrive }, home, existing(streamling))).toBe(streamling);
  });

  it("names Streamling's file and Nightbot's folder for the window, each empty when Documents is where it usually is", () => {
    const streamling = path.join(oneDrive, "Documents", "streamling", "livetext");
    const env = { OneDrive: oneDrive };
    expect(presetFoldersShown(env, home, existing(streamling))).toEqual({ streamling: path.join(streamling, "nowplaying-minimal.txt"), nightbot: "" });
    expect(presetFoldersShown(env, home, existing(moved))).toEqual({ streamling: "", nightbot: moved });
    expect(presetFoldersShown({}, home, existing())).toEqual({ streamling: "", nightbot: "" });
  });

  it("tries the system's Documents folder first, then the home one", () => {
    const system = path.join(path.sep, "Redirected", "Documents");
    const there = path.join(system, "Nightbot");
    const inHome = path.join(home, "Documents", "Nightbot");
    expect(presetFolder(["Nightbot"], {}, home, existing(there, inHome), system)).toBe(there);
    expect(presetFolder(["Nightbot"], {}, home, existing(inHome), system)).toBe(inHome);
    expect(presetFolder(["Nightbot"], {}, home, existing(), system)).toBe(there);
    expect(folderShownInstead(["Nightbot"], {}, home, existing(there), system)).toBe("");
  });
});
