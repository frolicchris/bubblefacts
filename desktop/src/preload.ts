import { contextBridge, ipcRenderer as electronIpc } from "electron";
import type { AskChannel, TellChannel, WindowChannel } from "./ipc-channels";

// Only the message names declared in ipc-channels.ts
const ipcRenderer: {
  invoke: (channel: AskChannel, ...args: unknown[]) => Promise<unknown>;
  send: (channel: TellChannel, ...args: unknown[]) => void;
  on: typeof electronIpc.on;
} = electronIpc;

// The only things the window can ask the app to do
contextBridge.exposeInMainWorld("bubbleFacts", {
  getState: () => ipcRenderer.invoke("get-state"),
  unlockReady: () => ipcRenderer.send("unlock-secrets"),
  testConnection: (channel: string, token: string, kind: string) => ipcRenderer.invoke("test-connection", channel, token, kind),
  testStreamElements: (channel: string, jwt: string) => ipcRenderer.invoke("test-streamelements", channel, jwt),
  testSharing: (url: string, channel: string, key: string) => ipcRenderer.invoke("test-sharing", url, channel, key),
  importLook: () => ipcRenderer.invoke("import-look"),
  readyLook: (id: string) => ipcRenderer.invoke("read-ready-look", id),
  saveLook: (name: string, author: string) => ipcRenderer.invoke("save-look", name, author),
  useLook: (look: unknown) => ipcRenderer.invoke("use-look", look),
  removeLook: () => ipcRenderer.invoke("remove-look"),
  chooseNowPlayingFile: () => ipcRenderer.invoke("choose-now-playing-file"),
  saveSettings: (changes: Record<string, unknown>) => ipcRenderer.invoke("save-settings", changes),
  signIn: () => ipcRenderer.invoke("sign-in"),
  cancelSignIn: () => ipcRenderer.invoke("cancel-sign-in"),
  downloadModel: () => ipcRenderer.invoke("download-model"),
  removeData: () => ipcRenderer.invoke("remove-data"),
  copy: (text: string) => ipcRenderer.invoke("copy", text),
  startDrag: (vertical = false) => ipcRenderer.send("start-drag", vertical === true),
  openExternal: (url: string) => ipcRenderer.invoke("open-external", url),
  testOverlay: (vertical = false) => ipcRenderer.invoke("test-overlay", vertical === true),
  testBubble: () => ipcRenderer.invoke("test-bubble"),
  setPaused: (paused: boolean) => ipcRenderer.invoke("set-paused", paused),
  showLogs: () => ipcRenderer.invoke("show-logs"),
  recent: () => ipcRenderer.invoke("get-recent"),
  downloadUpdate: () => ipcRenderer.invoke("download-update"),
  installUpdate: () => ipcRenderer.invoke("install-update"),
  reportProblem: () => ipcRenderer.invoke("report-problem"),
  reportBeta: () => ipcRenderer.invoke("report-beta"),
  copyReport: (kind: "problem" | "beta") => ipcRenderer.invoke("copy-report", kind),
  reportFact: (song: string, fact: string) => ipcRenderer.invoke("report-fact", song, fact),
  wrongFact: (fact: string, song?: unknown, live?: boolean) => ipcRenderer.invoke("mark-wrong", fact, song, live === true),
  unwrongFact: (article: string, song: unknown) => ipcRenderer.invoke("unmark-wrong", article, song),
  getSongFacts: (song?: { title: string; artist: string; songId?: number }) => ipcRenderer.invoke("get-song-facts", song),
  saveSongFacts: (data: unknown) => ipcRenderer.invoke("save-song-facts", data),
  listSongFacts: () => ipcRenderer.invoke("list-song-facts"),
  setFactsOff: (song: unknown, kind: "song" | "artist", on: boolean) => ipcRenderer.invoke("set-facts-off", song, kind, on),
  searchSongs: (query: string) => ipcRenderer.invoke("search-songs", query),
  openNotices: () => ipcRenderer.invoke("open-notices"),
  whatsNewSeen: () => ipcRenderer.invoke("mark-whats-new-seen"),
  saveBackup: () => ipcRenderer.invoke("save-backup"),
  restoreBackup: () => ipcRenderer.invoke("restore-backup"),
  showBackups: () => ipcRenderer.invoke("show-backups"),
  twitchConnect: () => ipcRenderer.invoke("connect-twitch"),
  twitchDisconnect: () => ipcRenderer.invoke("disconnect-twitch"),
  twitchAbout: (artist: string, link: string) => ipcRenderer.invoke("read-twitch-about", artist, link),
  twitchLogin: (artist: string, link: string) => ipcRenderer.invoke("find-twitch-login", artist, link),
  prepareStatus: () => ipcRenderer.invoke("get-prepare-status"),
  on: (channel: WindowChannel, callback: (payload: unknown) => void) => {
    ipcRenderer.on(channel, (_e, payload) => callback(payload));
  },
});
