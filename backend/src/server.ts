import "./log-timestamps";
import express from "express";
import http from "http";
import path from "path";
import { WebSocketServer, WebSocket } from "ws";
import { config } from "./config";
import { SongListClient } from "./songlist-client";
import { generateFacts, factStats } from "./fact-generator";
import { FactsPayload, SSLQueueItem } from "./types";

/**
 * HTTP + WebSocket server. Watches the song queue, generates facts on each
 * song change, and pushes them to every connected overlay.
 */

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const songList = new SongListClient();

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

function broadcast(payload: FactsPayload): void {
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
  if (!current) return;
  const song = SongListClient.toSong(current);
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

  const song = SongListClient.toSong(current);
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

app.use("/obs", express.static(path.resolve(__dirname, "../../frontend/obs")));

app.get("/obs-overlay", (req, res) => {
  console.log(`[Server] Overlay page requested by ${req.headers["user-agent"] ?? "unknown"}`);
  res.redirect("/obs/obs-overlay.html" + req.url.replace(/^[^?]*/, ""));
});

app.get("/health", (_req, res) => {
  const current = songList.getCurrentSong();
  const queueAgeMs = songList.lastSuccessfulFetchAgeMs();
  const stale = queueAgeMs !== null && queueAgeMs > config.sslPollIntervalMs * 3;
  const { lastOutcome, lastDurationMs, lastEndpoint, ...counts } = factStats;

  res.json({
    status: stale ? "degraded" : "ok",
    degradedReason: stale ? "no successful queue fetch recently" : undefined,
    aiProvider: config.aiProvider,
    topic: config.topic,
    currentSong: current ? SongListClient.displayTitle(current) : null,
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

/** Facts for whatever is playing now, for testing without OBS. */
app.get("/current-facts", async (_req, res) => {
  const current = songList.getCurrentSong();
  if (!current) {
    res.json({ song: null, facts: [] });
    return;
  }
  const song = SongListClient.toSong(current);
  res.json({ song, facts: await generateFacts(song, current) });
});

// --- Start -----------------------------------------------------------------

songList.onCurrentSongChange((current) => {
  onSongChange(current).catch((err) => console.error("[Server] Song change failed:", err));
});

// Listen before connecting upstream, so a slow API never delays the overlay's socket.
server.listen(config.port, config.host, () => {
  console.log(`[Server] Listening on http://${config.host}:${config.port} (AI: ${config.aiProvider}, topic: ${config.topic})`);
  console.log(`[Server] Tracking streamer "${config.sslStreamerName}"`);
});

songList
  .connect()
  .then(() => console.log("[Server] Connected to StreamerSongList"))
  .catch((err) => console.error(`[Server] StreamerSongList unavailable, retrying by poll: ${err.message}`));
