import { autostartEntry, quoteExecArg } from "./autostart";

describe("the Linux autostart file", () => {
  it("quotes an ordinary path, spaces and all", () => {
    expect(quoteExecArg("/home/jane/Apps/BubbleFacts 2.AppImage")).toBe('"/home/jane/Apps/BubbleFacts 2.AppImage"');
  });

  it("escapes the characters the spec reserves inside quotes, then the string's own backslash", () => {
    // A quote: \" in the argument, written \\" in the file.
    expect(quoteExecArg('/home/jane/My "Live" Apps/bf')).toBe('"/home/jane/My \\\\"Live\\\\" Apps/bf"');
    expect(quoteExecArg("/home/jane/$HOME/bf")).toBe('"/home/jane/\\\\$HOME/bf"');
    expect(quoteExecArg("/home/jane/`id`/bf")).toBe('"/home/jane/\\\\`id\\\\`/bf"');
    // A backslash: \\ in the argument, four in the file.
    expect(quoteExecArg("/home/jane/a\\b/bf")).toBe('"/home/jane/a\\\\\\\\b/bf"');
  });

  it("doubles a percent sign so it isn't read as a field code", () => {
    expect(quoteExecArg("/home/jane/100%/bf")).toBe('"/home/jane/100%%/bf"');
  });

  it("writes the entry with the quoted path and --hidden", () => {
    expect(autostartEntry("/opt/Bubble Facts/bubblefacts")).toBe(
      '[Desktop Entry]\nType=Application\nName=BubbleFacts\nExec="/opt/Bubble Facts/bubblefacts" --hidden\nX-GNOME-Autostart-enabled=true\n'
    );
  });
});
