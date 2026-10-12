import fs from "fs";
import path from "path";

// Every ipcMain.handle must come after the wrapper that checks the request is from the app's own window (#174).
it("registers no IPC handler before the own-window check", () => {
  const source = fs.readFileSync(path.join(__dirname, "main.ts"), "utf8");
  const wrapper = source.indexOf("ipcMain.handle = (channel, listener) =>");
  expect(wrapper).toBeGreaterThan(0);
  expect(source.slice(0, wrapper)).not.toMatch(/ipcMain\.handle\(/);
});
