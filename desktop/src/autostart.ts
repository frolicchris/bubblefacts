/**
 * Linux starts BubbleFacts at login from a .desktop file in the autostart
 * folder. The program's path goes in its Exec line, quoted and escaped as the
 * Desktop Entry spec says, so a folder name with a quote, dollar sign,
 * backtick, backslash or percent sign still starts the app.
 * https://specifications.freedesktop.org/desktop-entry-spec/latest/exec-variables.html
 */

/**
 * Each character the Exec line can't take as it is, written once with both layers of escaping
 * applied: inside double quotes " ` $ and \ take a backslash, and Exec is also a string value
 * whose own escapes double that backslash (\\) and spell \n, \t and \r; % starts a field code
 * like %f, so a real one is written %%. One pass, so nothing is ever escaped twice by accident.
 */
const EXEC_ESCAPES: Record<string, string> = {
  '"': '\\\\"',
  "`": "\\\\`",
  $: "\\\\$",
  "\\": "\\\\\\\\",
  "\n": "\\n",
  "\t": "\\t",
  "\r": "\\r",
  "%": "%%",
};

export function quoteExecArg(arg: string): string {
  return `"${arg.replace(/["`$\\\n\t\r%]/g, (c) => EXEC_ESCAPES[c])}"`;
}

/** The autostart file for the program at `exec`, opening in the background. */
export function autostartEntry(exec: string): string {
  return `[Desktop Entry]\nType=Application\nName=BubbleFacts\nExec=${quoteExecArg(exec)} --hidden\nX-GNOME-Autostart-enabled=true\n`;
}
