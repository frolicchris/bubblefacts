// Starting at login on Linux: a .desktop file whose Exec line quotes the path per the Desktop Entry spec,
// so a folder name with " $ ` \ or % still starts the app
// https://specifications.freedesktop.org/desktop-entry-spec/latest/exec-variables.html

// Both escaping layers in one pass, so nothing is escaped twice: in quotes " ` $ \ take a backslash, which the
// string value doubles (\\), also spelling \n \t \r; % starts a field code like %f, so a real one is %%
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

/** The autostart file for the program at `exec`, opening in the background */
export function autostartEntry(exec: string): string {
  return `[Desktop Entry]\nType=Application\nName=BubbleFacts\nExec=${quoteExecArg(exec)} --hidden\nX-GNOME-Autostart-enabled=true\n`;
}
