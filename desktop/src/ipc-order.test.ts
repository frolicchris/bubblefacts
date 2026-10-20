import fs from "fs";
import path from "path";

// Every ipcMain.handle must come after the wrapper that checks the request is from the app's own window (#174).
it("registers no IPC handler before the own-window check", () => {
  const source = fs.readFileSync(path.join(__dirname, "main.ts"), "utf8");
  const wrapper = source.indexOf("ipcMain.handle = (channel, listener) =>");
  expect(wrapper).toBeGreaterThan(0);
  expect(source.slice(0, wrapper)).not.toMatch(/ipcMain\.handle\(/);
});

// The file picker opens a dialog and hands back a path, so it must be one of the checked handlers and reachable only through the preload bridge.
it("registers the now playing file picker behind the own-window check", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.ts"), "utf8");
  const wrapper = main.indexOf("ipcMain.handle = (channel, listener) =>");
  const picker = main.indexOf('ipcMain.handle("choose-now-playing-file"');
  expect(picker).toBeGreaterThan(wrapper);
  expect(main).not.toMatch(/ipcMain\.on\("choose-now-playing-file"|handleAny\("choose-now-playing-file"/);
  const preload = fs.readFileSync(path.join(__dirname, "preload.ts"), "utf8");
  expect(preload).toContain('ipcRenderer.invoke("choose-now-playing-file")');
});
