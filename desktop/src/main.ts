import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, powerMonitor, shell, Tray } from "electron";
import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import { newerRelease, testSongList, testStreamElements } from "./checks";
import { downloadModel, MODEL, modelPath, modelReady, Progress } from "./model";
import { installOverlay, OVERLAY_FILE } from "./overlay";
import { problemReportUrl, wrongFactUrl } from "./reports";
import {
  BUBBLE_SCALE, DEFAULTS, fromWindow, loadSettings, sanitize, saveSettings, secretsOf, secretsUnprotected, Settings, songSourceReady,
  toServerEnv, writeMyPack,
} from "./settings";
import { CLIENT_ID, refresh, revoke, signIn, SignInExpired } from "./signin";

/**
 * A YouTube Data API key restricted to that API, added to package.json at
 * build time from the YOUTUBE_API_KEY secret (never committed). Used to read
 * the exact artist and track of auto-generated uploads (issue #26).
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || (require("../../package.json") as { bubblefacts?: { youtubeApiKey?: string } }).bubblefacts?.youtubeApiKey || "";
import { pruneLogs, Status, Supervisor } from "./supervisor";

/** BubbleFacts desktop app: setup, the dashboard, and a supervised fact server. */

// A second copy hands over to the first (which shows its window) and leaves at once.
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.exit(0);

const ROOT = app.getAppPath();
const DATA = app.getPath("userData");
const DIRS = {
  models: path.join(DATA, "models"),
  overlay: path.join(DATA, "overlay"),
  logs: path.join(DATA, "logs"),
  facts: path.join(DATA, "facts"),
};
const ALLOWED_HOSTS = [
  "github.com", "streamersonglist.com", "www.streamersonglist.com", "id.streamersonglist.com", "console.groq.com", "platform.claude.com",
  "bubblefacts.frolic.org", "www.twitch.tv", "discord.gg", "obsproject.com", "huggingface.co", "www.llama.com", "ollama.com",
  "streamelements.com",
];

// Loaded once the app is ready: before that, Windows and Linux can't read the keychain.
let settings: Settings = { ...DEFAULTS };
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let toldAboutTray = false;
let builtinFailed = false;
let update: { version: string; url: string } | null = null;
let download: AbortController | null = null;
/** The built-in AI's download, shown on the dashboard. */
let modelDownload: (Progress & { error?: string }) | null = null;
let downloadRetry: NodeJS.Timeout | null = null;
let downloadFailures = 0;
let signingIn: AbortController | null = null;
let signInExpired = false;
let refreshTimer: NodeJS.Timeout | null = null;
let refreshing: Promise<void> | null = null;
/** Getting the chosen model into the musician's own Ollama, so they never run "ollama pull". */
let ollama: { pulling?: string; error?: string } | null = null;
/** Bubbles paused from the dashboard or tray. Not saved: a restart shows bubbles again. */
let paused = false;

// Linux builds ship a standard Node.js for the fact server (see Supervisor).
const nodeRuntime = path.join(process.resourcesPath, "runtime", "node");
const supervisor = new Supervisor(
  path.join(ROOT, "dist/backend/server.js"),
  DIRS.logs,
  process.platform === "linux" && fs.existsSync(nodeRuntime) ? nodeRuntime : null
);
const overlayFile = () => path.join(DIRS.overlay, OVERLAY_FILE);
const send = (channel: string, payload: unknown) => win?.webContents.send(channel, payload);

/**
 * Run as soon as the song list is connected, so the test bubble can appear
 * during setup. While the built-in AI is still downloading, songs get backup
 * facts; the server restarts with the AI once it's ready.
 */
function canStart(): boolean {
  return songSourceReady(settings);
}

function serverEnv(): Record<string, string> {
  const env = toServerEnv(settings, { modelPath: modelPath(DIRS.models), logDir: DIRS.logs, topicsDir: DIRS.facts, clientId: CLIENT_ID });
  if (settings.ai === "builtin" && (builtinFailed || !modelReady(DIRS.models))) env.AI_PROVIDER = "none";
  if (paused) env.BUBBLEFACTS_PAUSED = "1";
  env.BUBBLEFACTS_DATA_DIR = DATA;
  if (YOUTUBE_API_KEY) env.YOUTUBE_API_KEY = YOUTUBE_API_KEY;
  return env;
}

function startServer(): void {
  installOverlay(path.join(ROOT, "frontend/obs"), DIRS.overlay, settings.port, BUBBLE_SCALE[settings.bubbleSize]);
  writeMyPack(settings, DIRS.facts);
  if (canStart()) supervisor.restart(serverEnv());
  else supervisor.stop();
}

function state() {
  const { token, refreshToken, seJwt, groqKey, anthropicKey, ...rest } = settings;
  return {
    settings: { ...rest, tokenSet: !!token, seJwtSet: !!seJwt, groqKeySet: !!groqKey, anthropicKeySet: !!anthropicKey },
    signInAvailable: !!CLIENT_ID,
    paused,
    ollama,
    signInExpired,
    modelDownload,
    status: supervisor.status,
    overlayPath: overlayFile(),
    modelReady: modelReady(DIRS.models),
    modelBytes: MODEL.bytes,
    modelLicense: MODEL.license,
    version: app.getVersion(),
    platform: process.platform,
    secretsUnprotected: secretsUnprotected(),
    builtinFailed,
    update,
    dataDir: DATA,
  };
}

// --- Supervisor events -------------------------------------------------

supervisor.on("status", (status: Status) => {
  send("status", status);
  updateTray(status);
});
// Another program had the port, so the server moved up. The overlay file keeps the
// usual port and looks at the next few itself, so OBS finds the server either way.
supervisor.on("port", () => send("state", state()));
supervisor.on("gpu-off", () => {
  settings.forceCpu = true;
  saveSettings(settings);
});
supervisor.on("builtin-failed", () => {
  if (!builtinFailed) {
    builtinFailed = true;
    notify("The built-in AI can't run on this computer", "Facts will come from your song list for now. Open BubbleFacts to switch to the free online option.");
  }
  send("state", state());
  supervisor.restart(serverEnv());
});

// --- The built-in AI's download ------------------------------------------

/** Download the AI in the background whenever it's chosen and missing, retrying on its own. */
async function ensureModel(): Promise<void> {
  if (settings.ai !== "builtin" || modelReady(DIRS.models) || download) return;
  if (downloadRetry) clearTimeout(downloadRetry);
  downloadRetry = null;
  download = new AbortController();
  const progress = (p: Progress) => {
    modelDownload = p;
    send("model-progress", p);
  };
  try {
    progress({ received: 0, total: MODEL.bytes, phase: "downloading" });
    await downloadModel(DIRS.models, progress, download.signal);
    downloadFailures = 0;
    modelDownload = null;
    startServer();
  } catch (err) {
    if (download.signal.aborted) return;
    downloadFailures++;
    const wait = Math.min(30_000 * downloadFailures, 5 * 60_000);
    const reason = err instanceof Error ? err.message : String(err);
    modelDownload = { ...(modelDownload ?? { received: 0, total: MODEL.bytes, phase: "downloading" }), error: reason };
    send("model-progress", modelDownload);
    downloadRetry = setTimeout(() => void ensureModel(), wait);
  } finally {
    const stopped = download?.signal.aborted;
    download = null;
    send("state", state());
    // Stopped by a switch away and back again: pick the download up again.
    if (stopped && !quitting && settings.ai === "builtin") void ensureModel();
  }
}

function stopModelDownload(): void {
  download?.abort();
  if (downloadRetry) clearTimeout(downloadRetry);
  downloadRetry = null;
  modelDownload = null;
}

// --- The musician's own Ollama --------------------------------------------------

async function ensureOllamaModel(): Promise<void> {
  if (settings.ai !== "ollama" || ollama?.pulling) {
    if (settings.ai !== "ollama") ollama = null;
    return;
  }
  const base = settings.ollamaUrl.replace(/\/+$/, "");
  const model = settings.ollamaModel.trim();
  const tell = (next: typeof ollama) => {
    ollama = next;
    send("state", state());
  };
  try {
    const tags = (await (await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5_000) })).json()) as {
      models?: Array<{ name?: string; model?: string }>;
    };
    const names = (tags.models ?? []).flatMap((m) => [m.name, m.model]).filter(Boolean) as string[];
    if (names.some((n) => n === model || n === `${model}:latest`)) return tell(null);
    tell({ pulling: model });
    const res = await fetch(`${base}/api/pull`, { method: "POST", body: JSON.stringify({ model, stream: false }) });
    if (!res.ok) throw new Error(`Ollama couldn't download "${model}" (${res.status}). Check the model name in Settings`);
    tell(null);
    startServer();
  } catch (err) {
    const offline = err instanceof TypeError || (err as Error).name === "TimeoutError";
    tell({ error: offline ? `Ollama isn't running at ${base}. Open the Ollama app, then click Try again` : (err as Error).message });
  }
}

// --- StreamerSongList sign-in ---------------------------------------------

/** Refresh five minutes before the hour-long access token runs out. */
function scheduleRefresh(delayMs?: number): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
  if (settings.tokenKind !== "oauth" || !settings.refreshToken) return;
  const due = delayMs ?? Math.max(0, settings.tokenExpiresAt - Date.now() - 5 * 60_000);
  refreshTimer = setTimeout(() => void refreshSignIn(), due);
}

/** One refresh at a time: a refresh token works once, so two at once would sign the musician out. */
function refreshSignIn(): Promise<void> {
  refreshing ??= doRefresh().finally(() => (refreshing = null));
  return refreshing;
}

async function doRefresh(): Promise<void> {
  const used = settings.refreshToken;
  try {
    const t = await refresh(used);
    // A new sign-in while this was running wins.
    if (settings.refreshToken !== used) return;
    // The old refresh token stopped working the moment this one was issued: save before anything else.
    settings = { ...settings, token: t.accessToken, refreshToken: t.refreshToken, tokenExpiresAt: t.expiresAt };
    saveSettings(settings);
    supervisor.updateToken(t.accessToken);
    if (signInExpired) {
      signInExpired = false;
      send("state", state());
    }
    scheduleRefresh();
  } catch (err) {
    if (settings.refreshToken !== used) return;
    if (err instanceof SignInExpired) {
      signInExpired = true;
      send("state", state());
      notify("Sign in to StreamerSongList again", "BubbleFacts can't see your queue until you do. Open BubbleFacts and click Sign in.");
    } else {
      scheduleRefresh(60_000); // Offline or a hiccup: try again shortly.
    }
  }
}

// --- Window and tray ---------------------------------------------------

function asset(name: string): string {
  return path.join(ROOT, "desktop/build", name);
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 980,
    height: 740,
    minWidth: 820,
    minHeight: 620,
    title: "BubbleFacts",
    backgroundColor: "#0b0d1f",
    icon: asset("icon.png"),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(ROOT, "desktop/renderer/index.html"));
  win.once("ready-to-show", () => win?.show());
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    win?.hide();
    if (!toldAboutTray) {
      toldAboutTray = true;
      const where = process.platform === "darwin" ? "menu bar" : "system tray";
      notify("BubbleFacts is still running", `Facts keep appearing on stream. Quit from the ${where} icon.`);
    }
  });
}

function showWindow(): void {
  if (!win) createWindow();
  win?.show();
  win?.focus();
  // A window hidden to the tray, then shown on another desktop Space, can stay blank on macOS until repainted.
  win?.webContents.invalidate();
}

function updateTray(status: Status): void {
  if (!tray) return;
  const label =
    status.state === "running" && status.health?.status === "ok" ? "Running" :
    status.state === "stopped" ? (settings.setupComplete ? "Stopped" : "Needs setup") :
    status.state === "failing" ? "Having trouble" : "Starting";
  tray.setToolTip(`BubbleFacts: ${label}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `BubbleFacts: ${label}${paused ? ", bubbles paused" : ""}`, enabled: false },
      { type: "separator" },
      { label: paused ? "Resume bubbles" : "Pause bubbles", click: () => void setPaused(!paused) },
      { label: "Open BubbleFacts", click: showWindow },
      { label: "Quit BubbleFacts", click: () => { quitting = true; app.quit(); } },
    ])
  );
}

function createTray(): void {
  const icon = nativeImage.createFromPath(asset(process.platform === "darwin" ? "trayTemplate.png" : "tray.png"));
  if (process.platform === "darwin") icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.on("click", showWindow);
  updateTray(supervisor.status);
}

function notify(title: string, body: string): void {
  if (Notification.isSupported()) new Notification({ title, body }).show();
}

function openExternal(url: string): void {
  try {
    const u = new URL(url);
    if (u.protocol === "https:" && ALLOWED_HOSTS.includes(u.hostname)) void shell.openExternal(url);
  } catch {
    // Ignore anything that isn't a valid address.
  }
}

/** Start at login. macOS and Windows have an API; Linux uses the autostart folder. */
function applyStartAtLogin(): void {
  if (process.platform === "linux") {
    const file = path.join(os.homedir(), ".config/autostart/bubblefacts.desktop");
    try {
      if (settings.startAtLogin) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const exec = process.env.APPIMAGE || process.execPath;
        fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=BubbleFacts\nExec="${exec}" --hidden\nX-GNOME-Autostart-enabled=true\n`);
      } else if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    } catch {
      // Not fatal: the musician can start it by hand.
    }
    return;
  }
  app.setLoginItemSettings({ openAtLogin: settings.startAtLogin, args: ["--hidden"] });
}

/** Ask the running server to do something only the app may ask for. */
async function control(pathname: string, body: unknown = {}): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${supervisor.status.port}/control/${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-BubbleFacts": "1" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3_000),
    });
    return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function setPaused(next: boolean): Promise<void> {
  paused = next;
  await control("pause", { paused });
  updateTray(supervisor.status);
  send("state", state());
}

// --- Messages from the window ------------------------------------------

ipcMain.handle("test-bubble", () => control("test"));
ipcMain.handle("wrong-fact", (_e, text: string) => control("wrong", { text: String(text) }));
ipcMain.handle("unwrong-fact", (_e, article: string) => control("unwrong", { article: String(article) }));
ipcMain.handle("set-paused", (_e, next: boolean) => setPaused(Boolean(next)));

ipcMain.handle("get-state", () => state());

ipcMain.handle("test-connection", (_e, channel: string, token: string, kind: string) =>
  testSongList(channel, token || settings.token, kind)
);

ipcMain.handle("test-streamelements", (_e, channel: string, jwt: string) =>
  testStreamElements(String(channel ?? ""), String(jwt ?? "") || settings.seJwt)
);

ipcMain.handle("save-settings", (_e, raw: Record<string, unknown>) => {
  const changes = fromWindow(raw ?? {});
  const next: Settings = sanitize({ ...settings, ...changes });
  // Blank secret fields mean "keep the one already saved".
  for (const key of ["token", "seJwt", "groqKey", "anthropicKey"] as const) if (!changes[key]) next[key] = settings[key];
  // A pasted token replaces the sign-in.
  if (changes.token) Object.assign(next, { tokenKind: "streamer", refreshToken: "", tokenExpiresAt: 0, streamerId: 0 });
  const aiChanged = next.ai !== settings.ai;
  const sourceChanged = next.songSource !== settings.songSource;
  settings = next;
  if (aiChanged) builtinFailed = false;
  saveSettings(settings);
  applyStartAtLogin();
  if (changes.token) {
    signInExpired = false;
    scheduleRefresh(); // Stops refreshing the replaced sign-in.
  }
  // A new StreamElements token, or a switch of source, starts over; health reports if it's still refused.
  if (changes.seJwt || sourceChanged) signInExpired = false;
  if (settings.ai === "builtin") void ensureModel();
  else stopModelDownload();
  void ensureOllamaModel();
  startServer();
  return state();
});

ipcMain.handle("sign-in", async () => {
  signingIn?.abort();
  const mine = new AbortController();
  signingIn = mine;
  try {
    const s = await signIn((url) => void shell.openExternal(url), mine.signal);
    settings = {
      ...settings,
      songSource: "streamersonglist",
      tokenKind: "oauth",
      token: s.accessToken,
      refreshToken: s.refreshToken,
      tokenExpiresAt: s.expiresAt,
      streamerId: s.streamerId,
      channel: s.channel || settings.channel,
    };
    signInExpired = false;
    saveSettings(settings);
    scheduleRefresh();
    startServer();
    showWindow();
    return { ok: true, channel: settings.channel, state: state() };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    if (signingIn === mine) signingIn = null;
  }
});
ipcMain.handle("cancel-sign-in", () => signingIn?.abort());

/** The first half of uninstalling, without hunting for hidden folders. */
ipcMain.handle("remove-data", async () => {
  const options = {
    type: "warning" as const,
    buttons: ["Remove and quit", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: "Remove all BubbleFacts data?",
    detail:
      "This signs you out of your song list and deletes your settings, the downloaded AI (about 2 GB), your own backup facts and the logs. Then BubbleFacts quits. The app itself stays until you remove it.",
  };
  const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  if (response !== 0) return false;
  quitting = true;
  download?.abort();
  supervisor.stop();
  if (refreshTimer) clearTimeout(refreshTimer);
  await revoke(settings.refreshToken);
  settings = { ...settings, startAtLogin: false };
  applyStartAtLogin();
  for (const name of ["models", "overlay", "logs", "facts", "settings.json", "settings.json.unreadable", "wrong-facts.json"]) {
    fs.rmSync(path.join(DATA, name), { recursive: true, force: true });
  }
  app.quit();
  return true;
});

ipcMain.handle("download-model", () => {
  downloadFailures = 0;
  void ensureModel();
  void ensureOllamaModel();
});
ipcMain.handle("copy", (_e, text: string) => clipboard.writeText(text));
// Dragging the overlay file onto OBS's Sources list makes a Browser source at the canvas size.
ipcMain.on("start-drag", (e) => e.sender.startDrag({ file: overlayFile(), icon: asset("tray@2x.png") }));
ipcMain.handle("open-external", (_e, url: string) => openExternal(url));
ipcMain.handle("test-overlay", () => shell.openExternal(`${pathToFileURL(overlayFile())}?test=1`));
ipcMain.handle("show-logs", () => shell.openPath(DIRS.logs));
ipcMain.handle("recent", async () => {
  try {
    const res = await fetch(`http://127.0.0.1:${supervisor.status.port}/recent`, { signal: AbortSignal.timeout(2000) });
    return await res.json();
  } catch {
    return { song: null, facts: [] };
  }
});
ipcMain.handle("report-problem", () =>
  shell.openExternal(problemReportUrl({ version: app.getVersion(), ai: settings.ai, logLines: supervisor.lines, secrets: secretsOf(settings) }))
);
ipcMain.handle("report-fact", (_e, song: string, fact: string) =>
  shell.openExternal(wrongFactUrl({ song, fact, logLines: supervisor.lines, secrets: secretsOf(settings) }))
);

// --- Lifecycle -----------------------------------------------------------

app.on("second-instance", showWindow);
app.on("activate", showWindow);
app.on("before-quit", () => {
  quitting = true;
  download?.abort();
  supervisor.stop();
});
app.on("window-all-closed", () => {
  // Stay running in the tray; quitting is explicit.
});

app.whenReady().then(async () => {
  if (!primaryInstance) return;
  app.setAppUserModelId("org.frolic.bubblefacts");
  settings = loadSettings();
  // A secret the keychain could no longer read comes back blank.
  if (settings.setupComplete && !(settings.songSource === "streamelements" ? settings.seJwt : settings.token)) signInExpired = true;
  pruneLogs(DIRS.logs);
  createTray();
  const atLogin = process.argv.includes("--hidden") || (process.platform === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin);
  if (!atLogin || !settings.setupComplete) createWindow();
  powerMonitor.on("resume", () => scheduleRefresh());
  // Refresh a sign-in that ran out while the app was closed before the server needs it.
  if (settings.tokenKind === "oauth" && settings.refreshToken && settings.tokenExpiresAt - Date.now() < 5 * 60_000) {
    await refreshSignIn();
  } else {
    scheduleRefresh();
  }
  void ensureModel();
  void ensureOllamaModel();
  startServer();
  update = await newerRelease(app.getVersion());
  if (update) send("state", state());
});
