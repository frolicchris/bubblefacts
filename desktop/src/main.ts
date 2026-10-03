import { autoBackup, backupFileName, makeBackup, readBackup } from "./backup";
import { factsFromAbout, getChannel, TWITCH_CLIENT_ID, TwitchSession, twitchLoginFrom } from "./twitch";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, powerMonitor, shell, Tray } from "electron";
import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import { newerRelease, Release, testSongList, testStreamElements } from "./checks";
import { assetName, downloadUpdate, startInstall } from "./updater";
import { ChecksumMismatch, downloadModel, MODEL, modelPath, modelReady, Progress } from "./model";
import { installOverlay, OVERLAY_FILE } from "./overlay";
import { betaReportUrl, problemReportUrl, wrongFactUrl } from "./reports";
import {
  BUBBLE_SCALE, DEFAULTS, fromWindow, loadSettings, sanitize, saveSettings, secretsWaiting, unlockSecrets, secretsOf, secretsUnprotected, Settings, songSourceReady,
  serverSettingsSignature, toServerEnv, writeMyPack,
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
  backups: path.join(DATA, "backups"),
};
const ALLOWED_HOSTS = [
  "github.com", "streamersonglist.com", "www.streamersonglist.com", "id.streamersonglist.com", "console.groq.com", "platform.claude.com",
  "bubblefacts.frolic.org", "www.twitch.tv", "obsproject.com", "huggingface.co", "www.llama.com", "ollama.com",
  "streamelements.com", "en.wikipedia.org",
];

// Loaded once the app is ready: before that, Windows and Linux can't read the keychain.
let settings: Settings = { ...DEFAULTS };
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let toldAboutTray = false;
let builtinFailed = false;
let update: Release | null = null;
/** Where the in-app update stands: nothing yet, downloading, checked and ready, or failed (then the download page is offered). */
let updating: { stage: "idle" | "downloading" | "ready" | "failed"; progress: number; file: string; error: string } = { stage: "idle", progress: 0, file: "", error: "" };
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
 * during setup. While the built-in AI is still downloading, songs get facts
 * that need no AI; the server restarts with the AI once it's ready.
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

/** What the running server was started with, to tell a save that changes nothing for it. */
let serverSignature = "";

/**
 * Start the server, or restart it when something it uses has changed. A
 * save that doesn't touch the server (finishing setup, "start at login")
 * leaves it running: a restart mid-song announces the song again and
 * rewrites its facts (seen on a live stream, issue #55). `force` restarts
 * regardless, for a new sign-in or token.
 */
function startServer(force = false): void {
  installOverlay(path.join(ROOT, "frontend/obs"), DIRS.overlay, settings.port, BUBBLE_SCALE[settings.bubbleSize]);
  writeMyPack(settings, DIRS.facts);
  if (!canStart()) {
    serverSignature = "";
    supervisor.stop();
    return;
  }
  const env = serverEnv();
  const signature = serverSettingsSignature(env, settings);
  if (!force && signature === serverSignature && supervisor.status.state !== "stopped") return;
  serverSignature = signature;
  supervisor.restart(env);
}

function state() {
  const { token, refreshToken, seJwt, groqKey, anthropicKey, twitchToken, twitchRefreshToken, ...rest } = settings;
  return {
    settings: { ...rest, tokenSet: !!token, seJwtSet: !!seJwt, groqKeySet: !!groqKey, anthropicKeySet: !!anthropicKey, twitchConnected: !!twitchRefreshToken },
    signInAvailable: !!CLIENT_ID,
    twitch: { available: !!TWITCH_CLIENT_ID, userCode: twitch.userCode, error: twitch.error },
    paused,
    ollama,
    signInExpired,
    unlocking: secretsWaiting(),
    modelDownload,
    status: supervisor.status,
    overlayPath: overlayFile(),
    modelReady: modelReady(DIRS.models),
    modelBytes: MODEL.bytes,
    modelLicense: MODEL.license,
    version: app.getVersion(),
    platform: process.platform,
    // Not asked until the sign-in is read: the window must be up first (see secretsUnprotected).
    secretsUnprotected: !secretsWaiting() && secretsUnprotected(),
    builtinFailed,
    update,
    updating: { stage: updating.stage, progress: updating.progress, error: updating.error },
    dataDir: DATA,
  };
}

// --- Supervisor events -------------------------------------------------

supervisor.on("status", (status: Status) => {
  // The streamer's Pause is the truth: a server that came back without it is told again.
  if (typeof status.health?.paused === "boolean" && status.health.paused !== paused) void control("pause", { paused });
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
    if (!(err instanceof ChecksumMismatch)) downloadRetry = setTimeout(() => void ensureModel(), wait);
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
      // Windows hides tray icons behind the ^ next to the clock.
      const where = process.platform === "darwin"
        ? "the BubbleFacts icon in the menu bar"
        : process.platform === "win32"
          ? "the ^ next to the clock, then the BubbleFacts icon"
          : "the BubbleFacts icon in the system tray";
      notify("BubbleFacts is still running", `Facts keep appearing on stream. To quit, click ${where}.`);
    }
  });
}

/** The About page in the window: the same on every system (Windows has no About panel of its own here). */
function showAbout(): void {
  showWindow();
  const go = () => win?.webContents.send("show-view", "about");
  if (win?.webContents.isLoading()) win.webContents.once("did-finish-load", go);
  else go();
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
      { label: "About BubbleFacts", click: showAbout },
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
  // A server the supervisor restarts later (after a crash or a stall) starts paused too.
  supervisor.setEnv({ BUBBLEFACTS_PAUSED: paused ? "1" : "" });
  await control("pause", { paused });
  updateTray(supervisor.status);
  send("state", state());
}

// --- Messages from the window ------------------------------------------

/**
 * Only BubbleFacts' own window may ask for anything. Navigation is already
 * blocked, so this is a second lock: if a page ever got into the window, it
 * still couldn't press Remove my data or install an update. Every handler
 * below goes through it, including ones added later.
 */
const fromOurPage = (e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean => {
  try {
    // Compared loosely (drive letters and escaping differ between systems): a local file, and ours.
    const url = new URL(e.senderFrame?.url ?? "");
    return url.protocol === "file:" && url.pathname.endsWith("/desktop/renderer/index.html");
  } catch {
    return false;
  }
};
const handleAny = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) =>
  handleAny(channel, (e, ...args) => {
    if (!fromOurPage(e)) throw new Error(`"${channel}" isn't available to this page`);
    return listener(e, ...args);
  });

ipcMain.handle("test-bubble", () => control("test"));
ipcMain.handle("wrong-fact", async (_e, text: string, song?: unknown) => {
  const result = await control("wrong", { text: String(text), song });
  backUpNow();
  return result;
});
ipcMain.handle("get-song-facts", () => control("song-facts/get"));
// Read from the file, so the list works even before the songs are connected.
ipcMain.handle("list-song-facts", () => {
  try {
    const list: unknown = JSON.parse(fs.readFileSync(path.join(DATA, "song-facts.json"), "utf8"));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
});
ipcMain.handle("save-song-facts", async (_e, data: unknown) => {
  const result = await control("song-facts", data);
  backUpNow();
  return result;
});
ipcMain.handle("unwrong-fact", async (_e, article: string, song: unknown) => {
  const result = await control("unwrong", { article: String(article), song });
  backUpNow();
  return result;
});
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
  // A new token or song source always starts over; anything else only if the server would notice.
  startServer(Boolean(changes.token || changes.seJwt || sourceChanged));
  backUpNow();
  return state();
});

// --- Connect Twitch (optional, issue #47) ---------------------------------------

const twitch = new TwitchSession(
  () => (settings.twitchRefreshToken
    ? { accessToken: settings.twitchToken, refreshToken: settings.twitchRefreshToken, expiresAt: settings.twitchTokenExpiresAt, login: settings.twitchLogin }
    : null),
  (t) => {
    settings = { ...settings, twitchToken: t?.accessToken ?? "", twitchRefreshToken: t?.refreshToken ?? "", twitchTokenExpiresAt: t?.expiresAt ?? 0, twitchLogin: t?.login ?? "" };
    saveSettings(settings);
  }
);

ipcMain.handle("twitch-connect", async () => {
  await twitch.connect(openExternal, () => send("state", state()));
  return state();
});

ipcMain.handle("twitch-disconnect", async () => {
  await twitch.disconnect();
  return state();
});

/** The Twitch channel a song points to, for the window to offer Fill: one rule, in twitch.ts. */
ipcMain.handle("twitch-login", (_e, artist: unknown, link: unknown) => twitchLoginFrom(String(artist ?? ""), String(link ?? "")));

/** Their Twitch About, as fact boxes for the streamer to review in the song facts editor. */
ipcMain.handle("twitch-about", async (_e, artist: unknown, link: unknown) => {
  const login = twitchLoginFrom(String(artist ?? ""), String(link ?? ""));
  if (!login) return { ok: false, message: "Put their Twitch link in \"Their link\" first, like twitch.tv/theirname." };
  try {
    const channel = await twitch.withToken((token) => getChannel(login, token));
    if (!channel) return { ok: false, message: `There's no Twitch channel called ${login}.` };
    const facts = factsFromAbout(channel.description);
    return {
      ok: true,
      link: `twitch.tv/${channel.login}`,
      facts,
      message: facts.length ? "Added from their Twitch About. Check it before you save." : `${channel.displayName}'s Twitch About is empty. Their link is filled in.`,
    };
  } catch (err) {
    send("state", state());
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
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
    startServer(true);
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
// --- Backup -----------------------------------------------------------------

const readJson = (name: string): unknown => {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, name), "utf8"));
  } catch {
    return null;
  }
};

const currentBackup = () => makeBackup(settings, { songFacts: readJson("song-facts.json"), wrongFacts: readJson("wrong-facts.json") }, app.getVersion());
/** After anything that changes the streamer's facts or settings: a copy they never have to think about. */
const backUpNow = () => void autoBackup(DIRS.backups, currentBackup());

ipcMain.handle("backup-save", async () => {
  const options = { defaultPath: path.join(app.getPath("documents"), backupFileName()), filters: [{ name: "BubbleFacts backup", extensions: ["json"] }] };
  const { canceled, filePath } = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
  if (canceled || !filePath) return { ok: false, message: "" };
  fs.writeFileSync(filePath, JSON.stringify(currentBackup(), null, 2));
  return { ok: true, message: `Saved to ${path.basename(filePath)}.` };
});

ipcMain.handle("backup-restore", async () => {
  // Opens where the automatic backups are, so the newest is a click away.
  const options = { defaultPath: DIRS.backups, properties: ["openFile" as const], filters: [{ name: "BubbleFacts backup", extensions: ["json"] }] };
  const { canceled, filePaths } = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  if (canceled || !filePaths[0]) return { ok: false, message: "" };
  let backup;
  try {
    backup = readBackup(fs.readFileSync(filePaths[0], "utf8"));
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "That file couldn't be read." };
  }
  const when = backup.createdAt ? new Date(backup.createdAt).toLocaleDateString() : "an earlier day";
  const confirm = {
    type: "question" as const,
    buttons: ["Restore", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: `Restore the backup from ${when}?`,
    detail: "This replaces your settings, your facts, your facts for particular songs and the sources you marked Wrong on this computer. Your sign-in and your AI choice stay as they are.",
  };
  const { response } = win ? await dialog.showMessageBox(win, confirm) : await dialog.showMessageBox(confirm);
  if (response !== 0) return { ok: false, message: "" };
  // What's here now is backed up first, so a restore can itself be undone.
  backUpNow();
  settings = sanitize({ ...settings, ...backup.settings });
  saveSettings(settings);
  if (backup.songFacts) fs.writeFileSync(path.join(DATA, "song-facts.json"), JSON.stringify(backup.songFacts, null, 2));
  if (backup.wrongFacts) fs.writeFileSync(path.join(DATA, "wrong-facts.json"), JSON.stringify(backup.wrongFacts, null, 2));
  applyStartAtLogin();
  // The fact server reads its files at start.
  startServer(true);
  send("state", state());
  return { ok: true, message: "Restored." };
});

ipcMain.handle("remove-data", async () => {
  const options = {
    type: "warning" as const,
    buttons: ["Remove and quit", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: "Remove all BubbleFacts data?",
    detail:
      "This signs you out of your song list and deletes your settings, the downloaded AI (about 2 GB), your custom facts, the facts you added for particular songs, the sources you marked Wrong, the logs and the automatic backups. A backup you saved elsewhere with Back up… stays. Then BubbleFacts quits. The app itself stays until you remove it.",
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
  await twitch.disconnect();
  for (const name of ["models", "overlay", "logs", "facts", "settings.json", "settings.json.unreadable", "wrong-facts.json", "song-facts.json", "session.json", "backups", "updates", "THIRD-PARTY-NOTICES.md"]) {
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
ipcMain.on("start-drag", (e) => fromOurPage(e) && e.sender.startDrag({ file: overlayFile(), icon: asset("tray@2x.png") }));
ipcMain.handle("open-external", (_e, url: string) => openExternal(url));
ipcMain.handle("test-overlay", () => shell.openExternal(`${pathToFileURL(overlayFile())}?test=1`));
ipcMain.handle("show-logs", () => shell.openPath(DIRS.logs));
ipcMain.handle("show-backups", () => {
  fs.mkdirSync(DIRS.backups, { recursive: true });
  return shell.openPath(DIRS.backups);
});
// Inside the app's archive other programs can't read it, so a copy goes in the data folder first.
ipcMain.handle("open-notices", () => {
  const copy = path.join(DATA, "THIRD-PARTY-NOTICES.md");
  fs.copyFileSync(path.join(ROOT, "THIRD-PARTY-NOTICES.md"), copy);
  return shell.openPath(copy);
});
ipcMain.handle("recent", async () => {
  try {
    const res = await fetch(`http://127.0.0.1:${supervisor.status.port}/recent`, { signal: AbortSignal.timeout(2000) });
    return await res.json();
  } catch {
    return { song: null, facts: [] };
  }
});
// --- Updating itself ---------------------------------------------------------

ipcMain.handle("update-download", async () => {
  if (!update?.download || updating.stage === "downloading") return;
  updating = { stage: "downloading", progress: 0, file: "", error: "" };
  send("state", state());
  let last = 0;
  try {
    const file = await downloadUpdate(update.download, path.join(DATA, "updates"), (fraction) => {
      // A few updates a second is plenty for a progress line.
      if (Date.now() - last < 300) return;
      last = Date.now();
      updating.progress = fraction;
      send("state", state());
    });
    updating = { stage: "ready", progress: 1, file, error: "" };
  } catch (err) {
    updating = { stage: "failed", progress: 0, file: "", error: err instanceof Error ? err.message : String(err) };
  }
  send("state", state());
});

ipcMain.handle("update-install", () => {
  if (updating.stage !== "ready") return;
  fs.mkdirSync(DIRS.logs, { recursive: true });
  const result = startInstall(updating.file, { pid: process.pid, logFile: path.join(DIRS.logs, "update.log"), scriptDir: path.join(DATA, "updates") });
  if (!result.started) {
    updating = { stage: "failed", progress: 0, file: "", error: result.reason };
    send("state", state());
    return;
  }
  // The installer is waiting for this app to close. On Linux the app reopens the new AppImage itself.
  if (result.relaunch) app.relaunch({ execPath: result.relaunch, args: [] });
  quitting = true;
  app.quit();
});

ipcMain.handle("report-problem", () =>
  shell.openExternal(problemReportUrl({ version: app.getVersion(), ai: settings.ai, logLines: supervisor.lines, secrets: secretsOf(settings) }))
);
ipcMain.handle("report-beta", () =>
  shell.openExternal(
    betaReportUrl({
      version: app.getVersion(),
      systemVersion: process.getSystemVersion(),
      songSource: settings.songSource,
      logLines: supervisor.lines,
      secrets: secretsOf(settings),
    })
  )
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
  // The system's About panel (the app menu on a Mac): the license and the credits, as in the window's footer.
  app.setAboutPanelOptions({
    applicationName: "BubbleFacts",
    applicationVersion: app.getVersion(),
    copyright: "© 2026 Christopher Feyrer",
    credits: "MIT License. Built with Llama. Credits, licenses and thanks are under About in the BubbleFacts window.",
    authors: ["Christopher Feyrer (creator and maintainer)", "Claude Code by Anthropic (AI coding agent)"],
    website: "https://bubblefacts.frolic.org/",
  });
  const atLogin = process.argv.includes("--hidden") || (process.platform === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin);
  // On a Mac, each new version makes macOS ask again before the saved sign-in can be read, and the
  // app waits on that prompt. The window goes up first, saying what to click (issue #62).
  settings = loadSettings(!(process.platform === "darwin" && !atLogin));
  pruneLogs(DIRS.logs);
  createTray();
  if (!atLogin || !settings.setupComplete) createWindow();
  if (secretsWaiting()) {
    await new Promise<void>((resolve) => {
      ipcMain.once("unlock-ready", () => resolve());
      setTimeout(resolve, 4000);
    });
    settings = unlockSecrets(settings);
    send("state", state());
  }
  // A secret the keychain could no longer read comes back blank.
  if (settings.setupComplete && !(settings.songSource === "streamelements" ? settings.seJwt : settings.token)) signInExpired = true;
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
  backUpNow();
  update = await newerRelease(app.getVersion(), app.isPackaged ? (v) => assetName(v) : () => null);
  if (update) send("state", state());
});
