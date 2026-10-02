import { contextBridge, ipcRenderer } from "electron";

/** The only things the window can ask the app to do. */
contextBridge.exposeInMainWorld("bubbleFacts", {
  getState: () => ipcRenderer.invoke("get-state"),
  unlockReady: () => ipcRenderer.send("unlock-ready"),
  testConnection: (channel: string, token: string, kind: string) => ipcRenderer.invoke("test-connection", channel, token, kind),
  testStreamElements: (channel: string, jwt: string) => ipcRenderer.invoke("test-streamelements", channel, jwt),
  saveSettings: (changes: Record<string, unknown>) => ipcRenderer.invoke("save-settings", changes),
  signIn: () => ipcRenderer.invoke("sign-in"),
  cancelSignIn: () => ipcRenderer.invoke("cancel-sign-in"),
  downloadModel: () => ipcRenderer.invoke("download-model"),
  removeData: () => ipcRenderer.invoke("remove-data"),
  copy: (text: string) => ipcRenderer.invoke("copy", text),
  startDrag: () => ipcRenderer.send("start-drag"),
  openExternal: (url: string) => ipcRenderer.invoke("open-external", url),
  testOverlay: () => ipcRenderer.invoke("test-overlay"),
  testBubble: () => ipcRenderer.invoke("test-bubble"),
  setPaused: (paused: boolean) => ipcRenderer.invoke("set-paused", paused),
  showLogs: () => ipcRenderer.invoke("show-logs"),
  recent: () => ipcRenderer.invoke("recent"),
  downloadUpdate: () => ipcRenderer.invoke("update-download"),
  installUpdate: () => ipcRenderer.invoke("update-install"),
  reportProblem: () => ipcRenderer.invoke("report-problem"),
  reportBeta: () => ipcRenderer.invoke("report-beta"),
  reportFact: (song: string, fact: string) => ipcRenderer.invoke("report-fact", song, fact),
  wrongFact: (fact: string) => ipcRenderer.invoke("wrong-fact", fact),
  unwrongFact: (article: string, song: unknown) => ipcRenderer.invoke("unwrong-fact", article, song),
  getSongFacts: () => ipcRenderer.invoke("get-song-facts"),
  saveSongFacts: (data: unknown) => ipcRenderer.invoke("save-song-facts", data),
  listSongFacts: () => ipcRenderer.invoke("list-song-facts"),
  openNotices: () => ipcRenderer.invoke("open-notices"),
  on: (channel: "status" | "state" | "model-progress" | "show-view", callback: (payload: unknown) => void) => {
    ipcRenderer.on(channel, (_e, payload) => callback(payload));
  },
});
