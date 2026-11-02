import fs from "fs";
import path from "path";

// Every message from the window goes through handle(), which checks the request is from the app's own window (#174).
it("registers no IPC handler except through handle()", () => {
  const source = fs.readFileSync(path.join(__dirname, "main.ts"), "utf8");
  expect(source.match(/ipcMain\.handle\(/g)).toHaveLength(1);
  const helper = source.indexOf("function handle(");
  expect(helper).toBeGreaterThan(0);
  expect(source.indexOf("ipcMain.handle(")).toBeGreaterThan(helper);
  expect(source.slice(helper, source.indexOf("\n}\n", helper))).toContain("fromOurPage(e)");
});

// The file picker opens a dialog and hands back a path, so it must be one of the checked handlers and reachable only through the preload bridge.
it("registers the now playing file picker behind the own-window check", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.ts"), "utf8");
  expect(main).toContain('handle("choose-now-playing-file"');
  expect(main).not.toMatch(/ipcMain\.on\("choose-now-playing-file"|handleAny\("choose-now-playing-file"/);
  const preload = fs.readFileSync(path.join(__dirname, "preload.ts"), "utf8");
  expect(preload).toContain('ipcRenderer.invoke("choose-now-playing-file")');
});

// Features register their own messages through main.ts's handle(), passed in, so main.ts doesn't grow with each.
const SELF_REGISTERING = ["preparing.ts"];

it("lets a feature's own file register messages only through the handle() main.ts passes it", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.ts"), "utf8");
  for (const file of SELF_REGISTERING) {
    const source = fs.readFileSync(path.join(__dirname, file), "utf8");
    expect(source).not.toMatch(/ipcMain/);
    expect(main).toMatch(new RegExp(`register\\w+\\(\\{\\s*handle,`));
  }
});

// A channel renamed on one side only would make a button do nothing, with no error until someone clicks it.
it("has a handler in main.ts (or a file it wires in) for every channel the preload bridge uses", () => {
  const main = [fs.readFileSync(path.join(__dirname, "main.ts"), "utf8"), ...SELF_REGISTERING.map((f) => fs.readFileSync(path.join(__dirname, f), "utf8"))].join("\n");
  const preload = fs.readFileSync(path.join(__dirname, "preload.ts"), "utf8");
  const channels = [...preload.matchAll(/ipcRenderer\.(?:invoke|send)\("([^"]+)"/g)].map((m) => m[1]);
  expect(channels.length).toBeGreaterThan(30);
  for (const channel of channels) expect(main).toMatch(new RegExp(`(?:handle|ipcMain\\.(?:on|once))\\("${channel}"`));
});
