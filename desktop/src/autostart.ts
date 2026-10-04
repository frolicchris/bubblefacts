/**
 * Linux starts BubbleFacts at login from a .desktop file in the autostart
 * folder. The program's path goes in its Exec line, quoted and escaped as the
 * Desktop Entry spec says, so a folder name with a quote, dollar sign,
 * backtick, backslash or percent sign still starts the app.
 * https://specifications.freedesktop.org/desktop-entry-spec/latest/exec-variables.html
 */
export function quoteExecArg(arg: string): string {
  // Inside double quotes, " ` $ and \ take a backslash.
  const quoted = arg.replace(/["`$\\]/g, "\\$&");
  // Exec is also a string value, whose own escapes apply on top: \\ for a backslash, \n and friends.
  const asString = quoted.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\t/g, "\\t").replace(/\r/g, "\\r");
  // % starts a field code like %f, so a real one is written %%.
  return `"${asString.replace(/%/g, "%%")}"`;
}

/** The autostart file for the program at `exec`, opening in the background. */
export function autostartEntry(exec: string): string {
  return `[Desktop Entry]\nType=Application\nName=BubbleFacts\nExec=${quoteExecArg(exec)} --hidden\nX-GNOME-Autostart-enabled=true\n`;
}
