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
