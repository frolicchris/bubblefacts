import "./log-timestamps";
import express from "express";
import http from "http";
import path from "path";
import { WebSocketServer, WebSocket } from "ws";
import { config } from "./config";
import { SongListClient, setAccessToken } from "./songlist-client";
import { SongSource } from "./song-source";
import { StreamElementsClient } from "./streamelements-client";
import { generateFacts, factStats, markWrong, STRUCTURED, unmarkWrong, warmUpBuiltin } from "./fact-generator";
import { FactsPayload, SSLQueueItem } from "./types";

/**
 * HTTP + WebSocket server. Watches the song queue, generates facts on each
 * song change, and pushes them to every connected overlay.
 */

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const songList: SongSource = config.songSource === "streamelements" ? new StreamElementsClient() : new SongListClient();

interface Client {
  id: number;
  ua: string;
  addr: string;
  connectedAt: number;
}
const clients = new Map<WebSocket, Client>();
let clientSeq = 0;

/** Bumped on every song change; a generation that finishes late checks it and drops its result. */
let generation = 0;

function send(ws: WebSocket, payload: FactsPayload): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

/** The last song and facts sent, for the desktop app's dashboard. */
let lastSent: { song: FactsPayload["song"] | null; facts: FactsPayload["facts"] } = { song: null, facts: [] };

/** "Pause bubbles": the streamer's on-air escape hatch. Songs are still followed, just not shown. */
let paused = process.env.BUBBLEFACTS_PAUSED === "1";

/** When the current song's facts went out to the overlay, and when bubbles were paused (0 = never). */
let factsShownAt = 0;
let pausedAt = 0;

function broadcast(payload: FactsPayload): void {
  if (payload.type === "new_song" && !payload.quiet) factsShownAt = 0;
  if (payload.type === "facts_ready" && !paused) factsShownAt = Date.now();
  if (payload.type === "new_song") lastSent = { song: payload.song, facts: [] };
  else if (payload.type === "facts_ready") lastSent = { song: payload.song, facts: payload.facts };
  else if (payload.type === "remove_fact") lastSent = { song: lastSent.song, facts: (lastSent.facts ?? []).filter((f) => f.text !== payload.text) };
  else lastSent = { song: null, facts: [] };
  if (paused && payload.type !== "clear") return;
  for (const ws of clients.keys()) send(ws, payload);
}

wss.on("connection", (ws, req) => {
  const client: Client = {
    id: ++clientSeq,
    ua: req.headers["user-agent"] ?? "unknown",
    addr: req.socket.remoteAddress ?? "unknown",
    connectedAt: Date.now(),
  };
  clients.set(ws, client);
  console.log(`[WS] Client #${client.id} connected from ${client.addr} (${client.ua}), total ${clients.size}`);

  const drop = () => {
    if (clients.delete(ws)) console.log(`[WS] Client #${client.id} disconnected, total ${clients.size}`);
  };
  ws.on("close", drop);
  ws.on("error", (err) => {
    console.error(`[WS] Client #${client.id} error: ${err.message}`);
    drop();
  });

  // Catch a reconnecting overlay up on the current song.
  const current = songList.getCurrentSong();
  if (!current || paused) return;
  const song = songList.toSong(current);
  const token = generation;
  send(ws, { type: "new_song", song });
  generateFacts(song, current)
    .then((facts) => token === generation && send(ws, { type: "facts_ready", song, facts }))
    .catch((err) => console.error("[WS] Could not send facts to new client:", err));
});

async function onSongChange(current: SSLQueueItem | null): Promise<void> {
  const token = ++generation;
  if (!current) {
    broadcast({ type: "clear" });
    return;
  }

  const song = songList.toSong(current);
  broadcast({ type: "new_song", song });

  const facts = await generateFacts(song, current);
  if (token !== generation) {
    console.log(`[Server] Discarding facts for "${song.title}": the song changed while generating`);
    return;
  }
  if (!clients.size && facts.length) {
    console.warn(
      `[Server] ${facts.length} facts ready for "${song.title}" but no overlay is connected. ` +
        "Check the OBS Browser Source (Local File: frontend/obs/obs-overlay.html)."
    );
  }
  broadcast({ type: "facts_ready", song, facts });
}

// --- Routes --------------------------------------------------------------

/**
 * Controls for the desktop app. The custom header makes a browser ask first
 * (a CORS preflight, which this server never approves), so a web page can't
 * press these buttons; only the app can.
 */
const control = express.Router();
control.use((req, res, next) => (req.get("X-BubbleFacts") === "1" ? next() : res.status(403).end()));
control.use(express.json());

control.post("/test", (_req, res) => {
  const song = { title: "BubbleFacts test", artist: "" };
  const facts = [{
    text: "✓ BubbleFacts is working! Facts about each song you play will pop up right here.",
    delaySeconds: 0,
    durationSeconds: 8,
    position: { top: "8%", left: "33%" },
  }];
  // Shown even while paused: the streamer asked for it. Not recorded as "on stream now".
  for (const ws of clients.keys()) {
    send(ws, { type: "new_song", song });
    send(ws, { type: "facts_ready", song, facts });
  }
  res.json({ overlays: clients.size });
});

control.post("/pause", (req, res) => {
  const next = Boolean(req.body?.paused);
  if (next !== paused) {
    paused = next;
    console.log(`[Server] Bubbles ${paused ? "paused" : "resumed"}`);
    if (paused) {
      pausedAt = Date.now();
      for (const ws of clients.keys()) send(ws, { type: "clear" });
    } else if (!resumeSameSong()) {
      void onSongChange(songList.getCurrentSong());
    }
  }
  res.json({ paused });
});

/**
 * Resuming on the song that was showing: carry on where it left off, with
 * the facts not shown yet on their remaining delays and no second NOW
 * PLAYING banner. Returns false when the song changed or its facts arrived
 * during the pause, so it starts like any new song.
 */
function resumeSameSong(): boolean {
  const current = songList.getCurrentSong();
  const song = current && songList.toSong(current);
  if (!song || !lastSent.song || !factsShownAt || factsShownAt > pausedAt) return false;
  if (`${song.artist}:::${song.title}` !== `${lastSent.song.artist}:::${lastSent.song.title}`) return false;
  const elapsed = (pausedAt - factsShownAt) / 1000;
  const facts = (lastSent.facts ?? [])
    .filter((f) => f.delaySeconds > elapsed)
    .map((f) => ({ ...f, delaySeconds: f.delaySeconds - elapsed }));
  broadcast({ type: "new_song", song: lastSent.song, quiet: true });
  broadcast({ type: "facts_ready", song: lastSent.song, facts });
  return true;
}

// "Wrong" in the app: take the fact off the stream now, and stop using its article for this song.
control.post("/wrong", (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text : "";
  const song = lastSent.song;
  if (!song || !text || !(lastSent.facts ?? []).some((f) => f.text === text)) {
    res.status(404).json({ removed: false });
    return;
  }
  broadcast({ type: "remove_fact", song, text });
  const article = markWrong(song, text);
  res.json({ removed: true, article, structured: article === STRUCTURED });
});

// Undo "Wrong": the source may be used for the song again. The removed fact stays off this play.
control.post("/unwrong", (req, res) => {
  const article = typeof req.body?.article === "string" ? req.body.article : "";
  const song = lastSent.song;
  if (!song || !article) {
    res.status(404).json({ restored: false });
    return;
  }
  unmarkWrong(song, article);
  res.json({ restored: true });
});

app.use("/control", control);

app.use("/obs", express.static(path.resolve(__dirname, "../../frontend/obs")));

app.get("/obs-overlay", (req, res) => {
  console.log(`[Server] Overlay page requested by ${req.headers["user-agent"] ?? "unknown"}`);
  res.redirect("/obs/obs-overlay.html" + req.url.replace(/^[^?]*/, ""));
});

/** How long after starting the server may go without reaching the song source before health says so. */
const STARTUP_GRACE_MS = 30_000;

app.get("/health", (_req, res) => {
  const current = songList.getCurrentSong();
  const queueAgeMs = songList.lastSuccessfulFetchAgeMs();
  // Never having reached the song source counts too, once startup has had its chance.
  // A source told to wait (Retry-After) isn't stale; restarting would only undo the wait.
  const stale = !songList.backingOff?.() && (queueAgeMs === null
    ? process.uptime() * 1000 > STARTUP_GRACE_MS
    : queueAgeMs > songList.pollIntervalMs() * 3);
  const rejected = songList.authRejected();
  const notFollowing = songList.followingProblem?.() ?? null;
  const { lastOutcome, lastDurationMs, lastEndpoint, ...counts } = factStats;

  res.json({
    paused,
    status: rejected ? "unauthorized" : stale || notFollowing ? "degraded" : "ok",
    degradedReason: rejected ? `${songList.name} rejected the token` : stale ? "no successful queue fetch recently" : notFollowing ?? undefined,
    songSource: songList.name,
    aiProvider: config.aiProvider,
    topic: config.topic,
    currentSong: current ? songList.displayTitle(current) : null,
    lastQueueFetchAgeMs: queueAgeMs,
    eventsConnected: songList.isEventStreamConnected(),
    obsClients: clients.size,
    clients: [...clients.values()].map((c) => ({
      addr: c.addr,
      ua: c.ua,
      connectedForSec: Math.round((Date.now() - c.connectedAt) / 1000),
    })),
    facts: {
      ...counts,
      lastOutcome: lastOutcome || null,
      lastDurationMs: lastDurationMs || null,
      lastEndpoint: lastEndpoint || null,
    },
  });
});

/** What the overlay is showing now. Read-only, unlike /current-facts. */
app.get("/recent", (_req, res) => {
  res.json(lastSent);
});

/** Facts for whatever is playing now, for testing without OBS. */
app.get("/current-facts", async (_req, res) => {
  const current = songList.getCurrentSong();
  if (!current) {
    res.json({ song: null, facts: [] });
    return;
  }
  const song = songList.toSong(current);
  res.json({ song, facts: await generateFacts(song, current) });
});

// --- Start -----------------------------------------------------------------

songList.onCurrentSongChange((current) => {
  onSongChange(current).catch((err) => console.error("[Server] Song change failed:", err));
});

// Listen before connecting upstream, so a slow API never delays the overlay's socket.
server.listen(config.port, config.host, () => {
  console.log(`[Server] Listening on http://${config.host}:${config.port} (AI: ${config.aiProvider}, topic: ${config.topic})`);
  console.log(`[Server] Tracking streamer "${config.sslStreamerName || config.seChannel || "(from the token)"}" on ${songList.name}`);
});

void warmUpBuiltin();

// Under the desktop app, the app refreshes the StreamerSongList sign-in and passes each new token here:
// through Electron's parentPort, or Node's IPC channel when the app runs the server under Node.js (Linux).
function onAppMessage(data: unknown): void {
  const msg = data as { type?: string; token?: unknown };
  if (msg?.type === "ssl-token" && typeof msg.token === "string" && msg.token) {
    setAccessToken(msg.token);
    console.log("[SSL] Sign-in refreshed");
  }
}
type ParentPort = { on(event: "message", listener: (e: { data: unknown }) => void): void };
const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
parentPort?.on("message", ({ data }) => onAppMessage(data));
if (process.send) process.on("message", onAppMessage);

songList
  .connect()
  .then(() => console.log(`[Server] Connected to ${songList.name}`))
  .catch((err) => console.error(`[Server] ${songList.name} unavailable, retrying by poll: ${err.message}`));
