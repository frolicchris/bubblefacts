// The names of the messages between the window and the app, declared once, so a name changed or misspelled
// on one side fails the type check instead of making a button silently do nothing.
// Types only: the preload script runs sandboxed and can't load a local file, so it uses `import type`,
// which leaves nothing in the compiled script. Each name starts with what it does.

/** The window asks and waits for the answer: `ipcRenderer.invoke` in preload.ts, `handle` in main.ts */
export type AskChannel =
  | "get-state"
  | "test-connection"
  | "test-streamelements"
  | "test-sharing"
  | "import-look"
  | "read-ready-look"
  | "save-look"
  | "use-look"
  | "remove-look"
  | "choose-now-playing-file"
  | "save-settings"
  | "sign-in"
  | "cancel-sign-in"
  | "download-model"
  | "remove-data"
  | "copy"
  | "open-external"
  | "test-overlay"
  | "test-bubble"
  | "set-paused"
  | "show-logs"
  | "get-recent"
  | "download-update"
  | "install-update"
  | "report-problem"
  | "report-beta"
  | "copy-report"
  | "report-fact"
  | "mark-wrong"
  | "unmark-wrong"
  | "get-song-facts"
  | "save-song-facts"
  | "list-song-facts"
  | "set-facts-off"
  | "search-songs"
  | "open-notices"
  | "mark-whats-new-seen"
  | "save-backup"
  | "restore-backup"
  | "show-backups"
  | "connect-twitch"
  | "disconnect-twitch"
  | "read-twitch-about"
  | "find-twitch-login"
  | "get-prepare-status";

/** The window tells the app, with no answer: `ipcRenderer.send` in preload.ts, `ipcMain.on` or `once` in main.ts */
export type TellChannel = "unlock-secrets" | "start-drag";

/** The app tells the window something happened: `webContents.send` in main.ts, `on` in preload.ts */
export type WindowChannel = "status" | "state" | "model-progress" | "show-view" | "wrong-key";
