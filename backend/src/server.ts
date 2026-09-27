import "./log-timestamps";
import express from "express";
import cors from "cors";
import http from "http";
import path from "path";
import { WebSocketServer, WebSocket } from "ws";
import { config } from "./config";
import { SongListClient } from "./songlist-client";
import { generateFacts, factStats } from "./fact-generator";
import { FactsPayload, SSLQueueItem } from "./types";

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

// Serve OBS overlay static files
app.use("/obs", express.static(path.resolve(__dirname, "../../frontend/obs")));

const songListClient = new SongListClient();

// WebSocket server for OBS Browser Source clients
const wss = new WebSocketServer({ server, path: "/ws" });
const obsClients = new Set<WebSocket>();

/**
 * Who is actually connected.
 *
 * A bare count is not enough to debug this: a browser tab opened to test the
 * overlay is indistinguishable from OBS in the count, so it silences the
 * "no overlay connected" warning while OBS is still absent. Recording the
 * user-agent and remote address per client is what makes the question
 * answerable — and note the UA alone does NOT disambiguate, since current
 * Chrome and CEF both report a reduced `Chrome/NNN.0.0.0`.
 */
interface ClientInfo {
  ua: string;
  addr: string;
  connectedAt: number;
}
const clientInfo = new Map<WebSocket, ClientInfo>();
let clientSeq = 0;

wss.on("connection", (ws, req) => {
  obsClients.add(ws);
  const info: ClientInfo = {
    ua: req.headers["user-agent"] ?? "unknown",
    addr: req.socket.remoteAddress ?? "unknown",
    connectedAt: Date.now(),
  };
  clientInfo.set(ws, info);
  const id = ++clientSeq;
  console.log(
    `[WS] Client #${id} connected from ${info.addr} (total: ${obsClients.size})\n` +
      `     user-agent: ${info.ua}`
  );

  // Send the current song state immediately on connection
  const current = songListClient.getCurrentSong();
  if (current) {
    const song = SongListClient.toSong(current);
    ws.send(JSON.stringify({ type: "new_song", song } as FactsPayload));

    // Bring the newly-connected client up to date. Capture the token first:
    // this path is reached on every browser-source reconnect, which is
    // routine, and without the check a song change during generation would
    // send this client the previous song's facts.
    const tokenAtConnect = generationToken;
    generateFacts(song, current)
      .then((facts) => {
        if (tokenAtConnect !== generationToken) return;
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "facts_ready", song, facts } as FactsPayload));
        }
      })
      // generateFacts handles its own errors, but an unhandled rejection here
      // would take the process down under --unhandled-rejections=throw, and a
      // reconnect must never be able to kill the server mid-stream.
      .catch((err) => console.error("[WS] Could not send facts to new client:", err));
  }

  ws.on("close", () => {
    obsClients.delete(ws);
    clientInfo.delete(ws);
    console.log(`[WS] Client #${id} disconnected (total: ${obsClients.size})`);
  });

  ws.on("error", (err) => {
    console.error(`[WS] Client #${id} error:`, err.message);
    obsClients.delete(ws);
    clientInfo.delete(ws);
  });
});

function broadcastToOBSClients(payload: FactsPayload): void {
  const message = JSON.stringify(payload);
  for (const ws of obsClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}

// --- Routes ---

/**
 * Health check.
 *
 * `status` is derived, not hardcoded. It used to always report "ok" while
 * describing configuration only, so it could not distinguish a working
 * pipeline from one quietly serving curated filler — the actual question
 * during a stream. `facts` answers that in one curl between songs, which is
 * something a performing pianist can do and watching a terminal is not.
 */
app.get("/health", (_req, res) => {
  const current = songListClient.getCurrentSong();
  const lastQueueAgeMs = songListClient.lastSuccessfulFetchAgeMs();

  // Stale queue data means we are flying blind regardless of what else works.
  const stale = lastQueueAgeMs !== null && lastQueueAgeMs > config.sslPollIntervalMs * 3;

  res.json({
    status: stale ? "degraded" : "ok",
    degradedReason: stale ? "no successful queue fetch recently" : undefined,
    aiProvider: config.aiProvider,
    topic: config.topic,
    ollamaEndpoint: config.aiProvider === "ollama" ? config.ollamaBaseUrl : undefined,
    ollamaFallback:
      config.aiProvider === "ollama" && config.ollamaFallbackUrl
        ? config.ollamaFallbackUrl
        : undefined,
    ollamaModel: config.aiProvider === "ollama" ? config.ollamaModel : undefined,
    sslEnv: config.sslEnv,
    currentSong: current ? SongListClient.displayTitle(current) : null,
    lastQueueFetchAgeMs: lastQueueAgeMs,
    eventsConnected: songListClient.isEventStreamConnected(),
    obsClients: obsClients.size,
    // Listed individually so a test browser tab cannot be mistaken for OBS.
    clients: Array.from(clientInfo.values()).map((c) => ({
      addr: c.addr,
      ua: c.ua,
      connectedForSec: Math.round((Date.now() - c.connectedAt) / 1000),
    })),
    // How songs have actually been served this session.
    facts: {
      grounded: factStats.grounded,
      original: factStats.original,
      liveLearn: factStats.liveLearn,
      noReference: factStats.noReference,
      nothingSurvived: factStats.nothingSurvived,
      generationFailed: factStats.generationFailed,
      cacheHits: factStats.cacheHits,
      lastOutcome: factStats.lastOutcome || null,
      lastDurationMs: factStats.lastDurationMs || null,
      lastEndpoint: factStats.lastEndpoint || null,
    },
  });
});

/** OBS overlay landing page — redirects to the overlay HTML */
app.get("/obs-overlay", (req, res) => {
  // Logged because its ABSENCE is diagnostic. A whole stream once produced
  // perfect facts and zero bubbles: the browser source had never loaded the
  // page at all, and nothing in the log said so.
  console.log(`[Server] Overlay page requested by ${req.headers["user-agent"] ?? "unknown"}`);
  res.redirect("/obs/obs-overlay.html");
});

/**
 * Manual trigger endpoint for testing — generate facts for current song.
 */
app.get("/current-facts", async (_req, res) => {
  const current = songListClient.getCurrentSong();
  if (!current) {
    res.json({ song: null, facts: [] });
    return;
  }

  const song = SongListClient.toSong(current);
  const facts = await generateFacts(song, current);
  res.json({ song, facts });
});

// --- Song change handler ---

/**
 * Incremented on every song change. Generation takes tens of seconds, so a
 * song can change while a previous batch is still being written. Whoever
 * finishes checks whether they are still the current generation and drops
 * their result if not — otherwise the previous song's facts get broadcast
 * over the one now playing.
 */
let generationToken = 0;

async function handleSongChange(
  current: SSLQueueItem | null,
  _previous: SSLQueueItem | null
): Promise<void> {
  const token = ++generationToken;

  if (!current) {
    const clearPayload: FactsPayload = { type: "clear" };
    broadcastToOBSClients(clearPayload);
    return;
  }

  // Carries liveLearn / requestedBy so the overlay can draw the banner.
  const song = SongListClient.toSong(current);

  // Notify that a new song started
  const newSongPayload: FactsPayload = { type: "new_song", song };
  broadcastToOBSClients(newSongPayload);

  // Generate facts (may be cached). The queue entry travels with the song so
  // play counts, the streamer's note and requester names are available even
  // when no reference article exists.
  const facts = await generateFacts(song, current);

  if (token !== generationToken) {
    console.log(
      `[Server] Discarding facts for "${song.title}" — song changed while generating`
    );
    return;
  }

  // Send facts to all clients
  const factsPayload: FactsPayload = { type: "facts_ready", song, facts };
  if (obsClients.size === 0) {
    // The failure mode this catches: a full stream of correctly generated
    // facts broadcast to nobody, because the OBS browser source was never
    // loaded. Everything upstream looked healthy, so nothing flagged it.
    console.warn(
      `[Server] ${facts.length} facts ready for "${song.title}" but NO overlay is connected — ` +
        "add a Browser Source pointing at " +
        `http://localhost:${config.port}/obs-overlay, or refresh the existing one (better: use Local File -> frontend/obs/obs-overlay.html so start order does not matter)`
    );
  }
  broadcastToOBSClients(factsPayload);
}

// --- Start ---

async function start(): Promise<void> {
  console.log(`[Server] Starting with "${config.aiProvider}" AI provider, topic "${config.topic}"`);

  songListClient.onCurrentSongChange(handleSongChange);

  // Listen FIRST, connect in the background. Binding the port behind a
  // network call means a slow or unreachable API delays the bind, so OBS
  // gets ECONNREFUSED and sits in reconnect backoff showing a red dot —
  // the overlay looks broken because of something unrelated to it.
  // connect() now starts its own polling and retries internally.
  songListClient
    .connect()
    .then(() => console.log("[Server] Connected to StreamerSongList"))
    .catch((err) => {
      console.error("[Server] Failed to connect to StreamerSongList:", err);
      console.log("[Server] Polling will keep retrying in the background");
    });

  server.listen(config.port, () => {
    console.log(`[Server] Running on port ${config.port}`);
    console.log(`[Server] Tracking streamer: ${config.sslStreamerName}`);
    console.log(`[Server] OBS overlay: http://localhost:${config.port}/obs-overlay`);
    console.log(`[Server] WebSocket:   ws://localhost:${config.port}/ws`);
  });
}

start().catch(console.error);

export { app, server };
