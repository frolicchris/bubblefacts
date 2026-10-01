import { contextBridge, ipcRenderer } from "electron";

/** The only things the window can ask the app to do. */
contextBridge.exposeInMainWorld("bubbleFacts", {
  getState: () => ipcRenderer.invoke("get-state"),
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
  reportProblem: () => ipcRenderer.invoke("report-problem"),
  reportFact: (song: string, fact: string) => ipcRenderer.invoke("report-fact", song, fact),
  wrongFact: (fact: string) => ipcRenderer.invoke("wrong-fact", fact),
  unwrongFact: (article: string, song: unknown) => ipcRenderer.invoke("unwrong-fact", article, song),
  on: (channel: "status" | "state" | "model-progress", callback: (payload: unknown) => void) => {
    ipcRenderer.on(channel, (_e, payload) => callback(payload));
  },
});
