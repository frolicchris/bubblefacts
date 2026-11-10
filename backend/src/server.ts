import "./log-timestamps";
import express from "express";
import http from "http";
import path from "path";
import { WebSocketServer, WebSocket } from "ws";
import { config } from "./config";
import { SongListClient, setAccessToken } from "./songlist-client";
import { SongSource } from "./song-source";
import { StreamElementsClient } from "./streamelements-client";
import { NowPlayingFileSource } from "./now-playing-file";
import { factsTookLine, listeningLine } from "./listening";
import { prepareSong, prepModelName, releasePrepModel, streamModelName, aiTimeFor, paceReport, allowedFacts, forgetTwitchAbout, pulledWithWrong, positionsFor, primeFacts, showsBanner, recentShown, restoreRecent, forgetSong, selfTest, setCurrentSong, generateFacts, factStats, markWrong, outcomeFor, ownFactKind, STRUCTURED, unmarkWrong, warmUpBuiltin, spotsForSong, verticalPositionsFor } from "./fact-generator";
import { connectAboutAsker, onAboutAnswer } from "./twitch-about";
import { factsOff, findSongFacts, saveSongFacts, setFactsOff, songFactsProblem } from "./song-facts";
import { songSearchRoute } from "./song-search";
import { allowedHost, allowedOrigin } from "./local-only";
import { bubbleNow, catchUpFacts, factOnScreen, loadSession, remainingFacts, RESUME_WITHIN_MS, sameRequest, saveSession, Session, withLaterFacts } from "./session";
import { Fact, FactsPayload, SSLQueueItem, SSLSong } from "./types";
import { sameSong, wrongTarget } from "./wrong-target";
import { ShownLog } from "./shown-log";
import { AiredFacts } from "./aired-facts";
import { creditLead, creditText, planCredit, restoredCredit } from "./credit";
import { ObsStreaming, isDrewMessage, parseOverlayMessage, watchForStatus } from "./obs-streaming";
import { SongFactSharer } from "./share-song-facts";
import { coverage, Preparer, PrepTarget } from "./preparer";
import { preparedStore } from "./prepared-facts";
import { playHistory } from "./play-history";
import { isNotMusic } from "./not-music";
import { settledRevision } from "./fact-verifier";
import { songKey } from "./wrong-facts";
import { styleFrom, StylePayload } from "./bubble-style";

// HTTP + WebSocket server: follows the song source, writes facts on each song change, sends them to every overlay

const app = express();
const server = http.createServer(app);
// Only this computer (local-only.ts)
const fromHere = (host: string | undefined) => allowedHost(host, config.port, config.host);
app.use((req, res, next) => (fromHere(req.get("host")) ? next() : res.status(403).end()));
const MAX_WS_MESSAGE = 1024; // bytes; the overlay sends one small message (obs-streaming.ts)
const MAX_CLIENTS = 16; // overlays; OBS needs one per scene showing the source, more is not OBS
const wss = new WebSocketServer({
  server,
  path: "/ws",
  maxPayload: MAX_WS_MESSAGE,
  verifyClient: ({ req }: { req: http.IncomingMessage }) => {
    if (!fromHere(req.headers.host)) return false;
    const refused = !allowedOrigin(req.headers.origin, req.headers.host)
      ? `from a web page (${String(req.headers.origin).slice(0, 100)})`
      : clients.size >= MAX_CLIENTS
        ? `: already ${clients.size} connected`
        : null;
    if (refused) console.warn(`[WS] Refused a connection ${refused}`);
    return !refused;
  },
});
const songList: SongSource =
  config.songSource === "streamelements" ? new StreamElementsClient()
  : config.songSource === "nowplaying" ? new NowPlayingFileSource()
  : new SongListClient();

interface Client {
  id: number;
  ua: string;
  addr: string;
  connectedAt: number;
  /** Beats in a row with no pong or message. Two: the connection is dead (one can be a stalled computer, not a dead overlay). */
  missed: number;
  /** When the overlay last said it drew a bubble; 0 before the first. */
  drewAt: number;
}
const clients = new Map<WebSocket, Client>();
let clientSeq = 0;

// Bumped on every song change; a generation that finishes late sees it and drops its result
let generation = 0;

function send(ws: WebSocket, payload: FactsPayload | StylePayload): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

// The last song and facts sent, for the dashboard
let lastSent: { song: FactsPayload["song"] | null; facts: FactsPayload["facts"]; ready?: boolean } = { song: null, facts: [] };

// The bubbles' look (#177), sent on connect and on every save, so no Refresh in OBS
let bubbleStyle: StylePayload = config.bubbleStyle;

// "Pause bubbles": the on-air escape hatch; songs are still followed, just not shown
let paused = process.env.BUBBLEFACTS_PAUSED === "1";

// When the song's facts went out to the overlay, and when bubbles were paused (0 = never)
let factsShownAt = 0;
let pausedAt = 0;

// Songs played this stream, newest first: a musician can't click Wrong mid-song, so it's offered after
const EARLIER_KEPT = 12; // songs
let earlier: Array<{ song: SSLSong; facts: NonNullable<FactsPayload["facts"]> }> = [];

// What was showing before a restart, until the first song after it is known
let restored: Session | null = loadSession();
if (restored) {
  restoreRecent(restored.recent);
  earlier = (restored.earlier ?? []).slice(0, EARLIER_KEPT);
}

// When the credit bubble is next due (credit.ts); a restart mid-stream carries on the count
const creditCount = restoredCredit(restored);
// When the streamer last pressed Test: the credit keeps clear of it
let testAt = 0;
// Whether OBS is streaming; kept across a restart within a stream break, so a reconnect isn't going live
const obsStreaming = new ObsStreaming(restored && Date.now() - restored.savedAt < RESUME_WITHIN_MS ? restored.obsStreaming : undefined);

// The [Shown] lines: once per play of a song, as facts go out to an overlay; also the aired facts record
const aired = new AiredFacts();
const shown = new ShownLog(aired);
const logShown = (song: SSLSong, facts: Fact[]) => {
  shown.log(song, facts);
  // [Shown] says what went out, not that an overlay drew it: this says how many connections it went to.
  if (facts.length) console.log(`[WS] Sent ${facts.length} bubble${facts.length === 1 ? "" : "s"} to ${clients.size} overlay${clients.size === 1 ? "" : "s"}`);
};

// Share song facts with other apps: the streamer's choice, off by default
const sharer = config.shareFactsUrl && config.shareFactsKey && config.shareFactsChannel
  ? new SongFactSharer({ url: config.shareFactsUrl, apiKey: config.shareFactsKey, channel: config.shareFactsChannel })
  : null;

/** Gives the sharer what's on stream now: nothing while paused, and without facts taken off */
function shareNow(): void {
  sharer?.update(paused ? null : (lastSent.song ?? null), lastSent.facts ?? [], songList.getCurrentSong()?.song?.durationSeconds);
}

/** `credit`: goes to the overlay ahead of a facts_ready batch, never into the song's record */
function broadcast(payload: FactsPayload, credit?: Fact): void {
  // A new song moves the one that was showing into the earlier list
  if (payload.type === "new_song" && !payload.quiet && lastSent.song && lastSent.facts?.length && !sameSong(lastSent.song, payload.song)) {
    earlier = [{ song: lastSent.song, facts: lastSent.facts }, ...earlier.filter((e) => !sameSong(e.song, lastSent.song))].slice(0, EARLIER_KEPT);
  }
  if (payload.type === "new_song" && !payload.quiet) factsShownAt = 0;
  // No overlay connected, nobody saw them: the first to connect gets them all
  if (payload.type === "facts_ready" && !paused) factsShownAt = clients.size ? Date.now() : 0;
  if (payload.type === "new_song") lastSent = { song: payload.song, facts: [] };
  else if (payload.type === "facts_ready") lastSent = { song: payload.song, facts: payload.facts, ready: true };
  else if (payload.type === "remove_fact") lastSent = { ...lastSent, facts: (lastSent.facts ?? []).filter((f) => f.text !== payload.text) };
  else lastSent = { song: null, facts: [] };
  // What a restart resumes: a fact taken off with Wrong stays off
  if ((payload.type === "facts_ready" || payload.type === "remove_fact") && lastSent.song) remember(lastSent.song, lastSent.facts ?? []);
  // A new play starts a new record, even of the same song; a quiet one (resuming) carries on
  if (payload.type === "new_song" && !payload.quiet) shown.newPlay();
  shareNow();
  if (paused && payload.type !== "clear") return;
  const sent: FactsPayload = credit && payload.type === "facts_ready" ? { ...payload, facts: [credit, ...(payload.facts ?? [])] } : payload;
  for (const ws of clients.keys()) send(ws, sent);
  if (payload.type === "facts_ready" && payload.song && clients.size) {
    logShown(payload.song, payload.facts ?? []);
    watchDrawn(payload.song, sent.facts ?? []);
  }
}

const TARGETS_FRESH_MS = 30_000; // ms between rebuilds of the songs to prepare (the window asks every 5 s)
let targetsBuilt: { at: number; targets: PrepTarget[] } | null = null;

// Whether the song list has been read, so the songs to prepare are all known (true for a source with no list)
const songListRead = (): boolean => !songList.listedSongs || songList.listedSongs() !== null;

/**
 * Every song to prepare: the list's, with play counts (#293), and every song seen on stream (#297),
 * which covers requests no list has and moves a played one up
 */
function prepTargets(): PrepTarget[] {
  if (targetsBuilt && Date.now() - targetsBuilt.at < TARGETS_FRESH_MS) return targetsBuilt.targets;
  const targets = new Map<string, PrepTarget>();
  for (const s of songList.listedSongs?.() ?? []) {
    const song: SSLSong = { title: s.title, artist: s.artist, songId: s.id };
    targets.set(songKey(song), { key: songKey(song), song, requests: s.plays });
  }
  for (const [key, played] of Object.entries(playHistory.all())) {
    const listed = targets.get(key);
    targets.set(key, listed ? { ...listed, requests: listed.requests + played.plays } : { key, song: played.song, requests: played.plays });
  }
  const built = [...targets.values()];
  // Built before the list was read: history only, not kept, so the list's songs join once it's read
  targetsBuilt = songListRead() ? { at: Date.now(), targets: built } : null;
  return built;
}

// "Prepare my songs": the app starts it while the computer is free and stops it when it isn't (#295)
const preparer = new Preparer({
  store: preparedStore,
  targets: prepTargets,
  listRead: songListRead,
  prepare: prepareSong,
  revisionOf: settledRevision,
  prepModel: prepModelName,
  streamModel: streamModelName,
  release: releasePrepModel,
});

/** Why preparing can't run now, or "": an overlay connected (a stream may be on), no AI, or lookups off */
function cantPrepare(): string {
  if (clients.size) return "overlay";
  if (config.aiProvider === "none") return "no-ai";
  if (!config.factVerification) return "lookups-off";
  return "";
}

/**
 * OBS went live: the credit goes out now in the next bubble's spot, and the rest (and the record) move
 * later by its time (ARCHITECTURE.md: The credit bubble)
 */
function onObsStreaming(streaming: boolean, client: number): void {
  const wentLive = obsStreaming.report(streaming, client);
  // Kept for a restart, with the song's record when there is one
  if (lastSent.song && lastSent.ready) remember(lastSent.song, lastSent.facts ?? []);
  if (!wentLive) return;
  console.log("[Credit] OBS started streaming: the credit bubble is due");
  creditCount.newStream();
  const song = lastSent.song;
  const facts = lastSent.facts ?? [];
  if (!song || !lastSent.ready || !facts.length || !factsShownAt) return;
  const now = Date.now();
  const next = remainingFacts(facts, factsShownAt, now)[0];
  const spot = next ? { position: next.position, ...(next.vertical ? { vertical: next.vertical } : {}) } : spotsForSong(song)(0);
  const plan = planCredit(creditCount, facts, { enabled: config.creditBubble, onAir: clients.size > 0 && !paused, testAt, now, ...spot });
  if (!plan.credit) return;
  const elapsed = (now - factsShownAt) / 1000;
  const lead = creditLead(plan.credit);
  resendRemaining(song, facts.map((f) => (f.delaySeconds > elapsed ? { ...f, delaySeconds: f.delaySeconds + lead } : f)), plan.credit);
}

/**
 * A new schedule for the song on stream, everywhere; overlays get the bubbles to come with `keep`, after
 * `first`. Returns those bubbles, or null while paused (nothing sent)
 */
function resendRemaining(song: SSLSong, record: Fact[], first?: Fact): Fact[] | null {
  lastSent = { song, facts: record, ready: true };
  shareNow();
  remember(song, record);
  if (paused) return null;
  const remaining = remainingFacts(record, factsShownAt);
  for (const ws of clients.keys()) send(ws, { type: "facts_ready", song, facts: first ? [first, ...remaining] : remaining, keep: true });
  return remaining;
}

function remember(song: SSLSong, facts: NonNullable<FactsPayload["facts"]>): void {
  saveSession({ song: { title: song.title, artist: song.artist }, facts, shownAt: factsShownAt, recent: recentShown(), savedAt: Date.now(), earlier, ...(creditCount.since !== undefined ? { creditSince: creditCount.since, creditText: creditText() } : {}), ...(obsStreaming.state !== undefined ? { obsStreaming: obsStreaming.state } : {}) });
}


/**
 * A connection can answer pings and still draw nothing (a page that hung, or a stale one). Each
 * overlay says when it puts a bubble on its page; a batch's first bubble is due after its delay, so
 * a little later this logs the overlays that were sent the batch and drew nothing since. It
 * only reports: the streamer sees it in the log, and a reload of the source clears it.
 */
const DRAW_GRACE_MS = Number(process.env.BUBBLEFACTS_DRAW_GRACE_MS) || 6000;
function watchDrawn(song: SSLSong, facts: Fact[]): void {
  if (!facts.length) return;
  const sentAt = Date.now();
  const first = Math.min(...facts.map((f) => f.delaySeconds ?? 0));
  if (first > 20) return;
  const token = generation;
  setTimeout(() => {
    if (token !== generation || paused) return;
    const silent = [...clients.values()].filter((c) => c.connectedAt <= sentAt && c.drewAt < sentAt);
    if (silent.length) console.warn(`[WS] ${silent.length} of ${clients.size} overlays were sent the bubbles for "${song.title}" and drew none: ${silent.map((c) => "#" + c.id).join(", ")}. Reload the Browser source in OBS.`);
  }, Math.max(first, 0) * 1000 + DRAW_GRACE_MS).unref();
}

/**
 * A connection that died without closing (OBS killed, a sleep, a dropped network) stays in `clients`
 * and counts as an overlay: the bubbles go to nobody and the log still says [Shown]. Every overlay is
 * pinged on this beat, and one that answered nothing since the last beat is dropped, so its source
 * reconnects (and is caught up on the song) by itself. The env var is for the tests.
 */
const HEARTBEAT_MS = Number(process.env.BUBBLEFACTS_HEARTBEAT_MS) || 15_000;
let lastBeat = Date.now();
setInterval(() => {
  // After a sleep or a stall the pongs waiting to be read haven't been: that beat counts for nothing.
  const late = Date.now() - lastBeat > HEARTBEAT_MS * 1.5;
  lastBeat = Date.now();
  const dropped: number[] = [];
  for (const [ws, client] of clients) {
    if (!late && client.missed >= 2) {
      dropped.push(client.id);
      ws.terminate();
      continue;
    }
    if (!late) client.missed++;
    try { ws.ping(); } catch { ws.terminate(); }
  }
  if (dropped.length) console.warn(`[WS] Client${dropped.length === 1 ? "" : "s"} ${dropped.map((id) => "#" + id).join(", ")} stopped answering: dropped, total ${clients.size}. An overlay that is still there reconnects by itself.`);
}, HEARTBEAT_MS).unref();

wss.on("connection", (ws, req) => {
  const client: Client = {
    id: ++clientSeq,
    ua: req.headers["user-agent"] ?? "unknown",
    addr: req.socket.remoteAddress ?? "unknown",
    connectedAt: Date.now(),
    missed: 0,
    drewAt: 0,
  };
  clients.set(ws, client);
  ws.on("pong", () => { client.missed = 0; });
  console.log(`[WS] Client #${client.id} connected from ${client.addr} (${client.ua}), total ${clients.size}`);
  // OBS is up, the stream comes first: preparing stops, and the app restarts it once OBS is closed
  if (preparer.running) {
    console.log("[Prepare] An overlay connected: stopping");
    preparer.stop();
  }

  const drop = () => {
    if (clients.delete(ws)) console.log(`[WS] Client #${client.id} disconnected, total ${clients.size}`);
  };
  ws.on("close", drop);
  ws.on("error", (err) => {
    console.error(`[WS] Client #${client.id} error: ${err.message}`);
    drop();
  });
  // The one message an overlay sends: whether OBS is streaming. Silence means the credit keeps its own timing
  const status = watchForStatus(() =>
    console.log(`[WS] Client #${client.id} hasn't said whether OBS is streaming: it's outside OBS, or the Browser source's Page permissions don't allow it. The credit bubble keeps to its own timing.`)
  );
  ws.on("close", () => {
    status.cancel();
    obsStreaming.forget(client.id);
  });
  ws.on("message", (data, isBinary) => {
    client.missed = 0;
    if (!isBinary && isDrewMessage(String(data))) {
      client.drewAt = Date.now();
      return;
    }
    const msg = isBinary ? null : parseOverlayMessage(String(data));
    if (!msg) return;
    status.heard();
    onObsStreaming(msg.streaming, client.id);
  });
  // First, before any bubble, even while paused, so Resume shows the right look
  send(ws, bubbleStyle);

  // Catch a reconnecting overlay up on the current song
  const current = songList.getCurrentSong();
  if (!current || paused) return;
  const song = songList.toSong(current);
  const token = generation;
  // Facts out: join from the song's record, on the others' schedule and with no second banner, so a
  // reload mid-song (a scene switch) neither misses bubbles nor replays them
  if (lastSent.ready && sameRequest(lastSent.song, song)) {
    // A LIVE LEARN banner stays up all song, so a reloaded overlay needs it again
    send(ws, factsShownAt && !song.liveLearn ? { type: "new_song", song, quiet: true } : newSong(song));
    const record = lastSent.facts ?? [];
    const facts = catchUpFacts(record, factsShownAt);
    send(ws, { type: "facts_ready", song, facts });
    // Logged already unless no overlay was there when they went out (a restart, say)
    logShown(song, facts);
    // No overlay was there when they went out: their schedule starts now
    if (!factsShownAt) {
      factsShownAt = Date.now();
      remember(song, record);
    }
    return;
  }
  send(ws, newSong(song));
  // Still being written: onSongChange's broadcast reaches this overlay too (its own copy as well
  // made it start the same bubbles twice)
  if (!lastSent.ready && sameRequest(lastSent.song, song)) return;
  generateFacts(song, current)
    .then((facts) => {
      // Paused meanwhile: Pause cleared the screen, and they wait for Resume
      if (token !== generation || paused) return;
      send(ws, { type: "facts_ready", song, facts });
      logShown(song, facts);
      if (!factsShownAt && sameRequest(lastSent.song, song)) {
        factsShownAt = Date.now();
        remember(song, facts);
      }
    })
    .catch((err) => console.error("[WS] Could not send facts to new client:", err));
});

/** A song starting, with or without its NOW PLAYING or LIVE LEARN bubble (the streamer's choice) */
function newSong(song: SSLSong): FactsPayload {
  return { type: "new_song", song, ...(showsBanner(song) ? {} : { noBanner: true }) };
}

async function onSongChange(current: SSLQueueItem | null): Promise<void> {
  const token = ++generation;
  if (!current) {
    setCurrentSong(null);
    broadcast({ type: "clear" });
    return;
  }

  const song = songList.toSong(current);
  // Work for any other song is no longer wanted (setCurrentSong)
  setCurrentSong(song);
  // Kept to prepare after the stream (#297), so its facts are ready next time
  if (!isNotMusic(song)) playHistory.record(song);

  // The first song after a restart is the one that was showing: carry on where it left off
  const before = restored;
  restored = null;
  if (before && sameRequest(before.song, song)) {
    if (Date.now() - (before.shownAt || before.savedAt) < RESUME_WITHIN_MS) {
      // Spots from the current setting: the restart may be the streamer moving the bubbles
      const spotFor = spotsForSong(song);
      // Facts turned off for the song or artist while the app was closed stay off (#262)
      before.facts = allowedFacts(song, before.facts).map((f, i) => ({ ...f, ...spotFor(i) }));
      console.log(`[Server] "${song.title}" was showing before the restart: carrying on with the bubbles not shown yet`);
      // Only the streamer's own facts (the AI was off, still loading or failed that time): not cached as the song's
      // facts for good, so the next play asks again with whatever is working now.
      if (!before.facts.every((f) => f.source?.startsWith("Your "))) primeFacts(song, before.facts);
      broadcast(song.liveLearn ? newSong(song) : { type: "new_song", song, quiet: true });
      broadcast({ type: "facts_ready", song, facts: remainingFacts(before.facts, before.shownAt) });
      // The record keeps the full set and first send time, for an overlay connecting later
      factsShownAt = before.shownAt;
      lastSent = { song, facts: before.facts, ready: true };
      shareNow();
      remember(song, before.facts);
      return;
    }
    // An earlier stream's play of this song: its own facts may show again
    const own = new Set(before.facts.map((f) => f.text));
    restoreRecent(before.recent.filter((r) => !own.has(r)));
  }
  broadcast(newSong(song));

  // Facts from data go out as soon as they're ready, while the AI writes (#256)
  let early: Fact[] | null = null;
  const facts = await generateFacts(song, current, (data) => {
    if (token !== generation) return;
    early = data;
    const plan = planCredit(creditCount, data, { enabled: config.creditBubble, onAir: clients.size > 0 && !paused, testAt, now: Date.now(), ...spotsForSong(song)(0) });
    broadcast({ type: "facts_ready", song, facts: plan.facts }, plan.credit);
  });
  if (token !== generation) {
    console.log(`[Server] Discarding facts for "${song.title}": the song changed while generating`);
    return;
  }
  if (early && sameRequest(lastSent.song, song) && lastSent.ready) {
    sendLater(song, early, facts);
    return;
  }
  if (!clients.size && facts.length) {
    console.warn(
      `[Server] ${facts.length} facts ready for "${song.title}" but no overlay is connected. ` +
        "Add BubbleFacts to OBS, or open OBS if it is closed."
    );
  }
  // The credit goes ahead of a song's facts that really reach an overlay (credit.ts)
  const plan = planCredit(creditCount, facts, { enabled: config.creditBubble, onAir: clients.size > 0 && !paused, testAt, now: Date.now(), ...spotsForSong(song)(0) });
  broadcast({ type: "facts_ready", song, facts: plan.facts }, plan.credit);
}

/**
 * The AI's captions after the data facts went out: added to the record and sent with `keep`
 * (ARCHITECTURE.md: Where structured facts come from)
 */
function sendLater(song: SSLSong, early: Fact[], facts: Fact[]): void {
  const record = lastSent.facts ?? [];
  // Not yet seen by any overlay (none connected, or paused): it all goes out as one batch
  const elapsed = factsShownAt ? (Date.now() - factsShownAt) / 1000 : 0;
  const merged = withLaterFacts(record, early, facts, elapsed, config.factIntervalSeconds);
  if (merged.length === record.length) return;
  if (!factsShownAt) {
    broadcast({ type: "facts_ready", song, facts: merged });
    return;
  }
  const remaining = resendRemaining(lastSent.song!, merged);
  if (remaining && clients.size) logShown(song, remaining);
}

// --- Routes --------------------------------------------------------------

// Controls for the desktop app; the header keeps web pages out (ARCHITECTURE.md: The app's control routes)
const control = express.Router();
control.use((req, res, next) => (req.get("X-BubbleFacts") === "1" ? next() : res.status(403).end()));
control.use(express.json());

control.post("/test", (_req, res) => {
  const song = { title: "BubbleFacts test", artist: "" };
  const facts = [{
    text: "✓ BubbleFacts is working! Facts about each song you play will pop up right here.",
    delaySeconds: 0,
    durationSeconds: 8,
    position: positionsFor()[0],
    vertical: verticalPositionsFor()[0],
  }];
  // Shown even while paused; not "on stream now", so the song's bubbles and Wrong on them carry on
  testAt = Date.now();
  for (const ws of clients.keys()) send(ws, { type: "test_bubble", song, facts });
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
      onSongChange(songList.getCurrentSong()).catch((err) => console.error("[Server] Song change failed:", err));
    }
    shareNow();
  }
  res.json({ paused });
});

// A new look from Settings (#177), on every overlay now: no restart (it would announce the song
// again), no Refresh in OBS. Anything unknown falls back to Classic, never refused
control.post("/style", (req, res) => {
  bubbleStyle = styleFrom(req.body?.style, req.body?.accent, req.body?.background, (line) => console.warn(`[Server] ${line}`), {
    scale: req.body?.scale,
    verticalScale: req.body?.verticalScale,
    icon: req.body?.icon,
  });
  console.log(`[Server] Bubble style: ${bubbleStyle.style}${bubbleStyle.colors ? ", with custom colors" : ""}`);
  for (const ws of clients.keys()) send(ws, bubbleStyle);
  res.json({ style: bubbleStyle.style, colors: bubbleStyle.colors ?? null, overlays: clients.size });
});

/**
 * Resume on the same song with its unshown facts and no second banner; false when the song changed
 * or its facts arrived during the pause (it then starts like a new song)
 */
function resumeSameSong(): boolean {
  const current = songList.getCurrentSong();
  const song = current && songList.toSong(current);
  if (!song || !lastSent.song || !factsShownAt || factsShownAt > pausedAt) return false;
  if (!sameRequest(song, lastSent.song)) return false;
  // The facts left as of the pause, not as of now
  const facts = remainingFacts(lastSent.facts ?? [], factsShownAt, pausedAt);
  broadcast({ type: "new_song", song: lastSent.song, quiet: true });
  broadcast({ type: "facts_ready", song: lastSent.song, facts });
  return true;
}

// "Wrong": from On stream now (`live`) also off the stream; from Earlier songs marked for next time,
// even when that song is on again. Either way its source is blocked for the song
control.post("/wrong", (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text : "";
  const click = { text, song: songFrom(req.body?.song), live: req.body?.live === true };
  const target = wrongTarget(click, { song: songFrom(lastSent.song), facts: lastSent.facts ?? [] }, earlier);
  if (!target) {
    res.status(404).json({ removed: false });
    return;
  }
  // The live song as the server holds it, so remove_fact matches what the overlay was sent
  res.json(takeWrong(target.playing ? lastSent.song! : target.song, target.fact, target.playing));
});

/**
 * Wrong on one fact: if its song is on, off the stream with this play's others from its source
 * (`pulledWithWrong`), never back on Resume or restart; else marked. Its source is blocked
 */
function takeWrong(song: SSLSong, fact: Fact, playing: boolean) {
  const text = fact.text;
  let pulled = 0;
  if (playing) {
    const gone = pulledWithWrong(lastSent.facts ?? [], fact);
    if (!gone.some((f) => f.text === text)) gone.push(fact);
    for (const f of gone) broadcast({ type: "remove_fact", song, text: f.text });
    pulled = gone.length - 1;
  } else {
    earlier = earlier.map((e) => (sameSong(e.song, song) ? { ...e, facts: e.facts.filter((f) => f.text !== text) } : e));
    if (lastSent.song) remember(lastSent.song, lastSent.facts ?? []);
  }
  const article = markWrong(song, text, fact.source);
  // The streamer's own fact: nothing to block, and it shows again until they change it
  return { removed: true, live: playing, article, structured: article === STRUCTURED, own: ownFactKind(fact.source), pulled };
}

// When a hands-free Wrong last marked a bubble: the next press counts only later bubbles
let handsfreeAt = 0;

// Hands-free Wrong (a foot pedal or Stream Deck key): the server knows what's up (ARCHITECTURE.md: Wrong and Undo)
control.post("/wrong-current", (_req, res) => {
  const song = lastSent.song;
  const facts = lastSent.facts ?? [];
  const fact = !paused && song && facts.length ? factOnScreen(facts, factsShownAt, Date.now(), handsfreeAt) : null;
  if (!song || !fact) {
    const anyShown = !!factsShownAt && !!factOnScreen(facts, factsShownAt);
    const reason = paused ? "paused" : !song ? "no-song" : !lastSent.ready ? "not-ready" : !facts.length ? "no-facts" : anyShown ? "already-marked" : "none-shown";
    res.json({ removed: false, reason });
    return;
  }
  handsfreeAt = Date.now();
  console.log(`[Server] Hands-free Wrong: ${fact.text.slice(0, 90)}`);
  // The fact and song go back, so the dashboard can offer Undo and Report
  res.json({ ...takeWrong(song, fact, true), text: fact.text, song });
});

// Undo "Wrong": the source may be used for the song again; the fact stays off this play
control.post("/unwrong", (req, res) => {
  const article = typeof req.body?.article === "string" ? req.body.article : "";
  // The song Wrong was pressed on, in full: list songs and videos are blocked by their ID
  const song = songFrom(req.body?.song);
  if (!song || !article) {
    res.status(404).json({ restored: false });
    return;
  }
  unmarkWrong(song, article);
  res.json({ restored: true });
});

// The smoke test's check that the AI writes and screening keeps real captions
control.post("/selftest", async (req, res) => {
  try {
    res.json(await selfTest(Number(req.body?.variant) || 0));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** The song an edit is for, exactly as the editor received it */
function songFrom(v: unknown): SSLSong | null {
  const s = v as Partial<SSLSong> | null | undefined;
  if (!s || typeof s.title !== "string" || typeof s.artist !== "string") return null;
  return {
    title: s.title,
    artist: s.artist,
    ...(typeof s.songId === "number" ? { songId: s.songId } : {}),
    ...(typeof s.videoId === "string" ? { videoId: s.videoId } : {}),
    ...(s.liveLearn === true ? { liveLearn: true } : {}),
  };
}

// The song named (picked from the list), else the one on now, matched as a save would.
// `off`: its switches, the artist's from whichever of their songs it was turned on for
control.post("/song-facts/get", (req, res) => {
  const target = songFrom(req.body?.song) ?? (lastSent.song && songFrom(lastSent.song));
  res.json(target ? { song: target, entry: findSongFacts(target), off: factsOff(target) } : { song: null, entry: null, off: null });
});

/**
 * After a song's facts or switches change: forget its found facts and, if it's on now, show the
 * new ones in place of those to come, with no second banner. Returns whether it's on now
 */
function showAgainIfOn(song: SSLSong): boolean {
  forgetSong(song);
  const current = songList.getCurrentSong();
  const playing = current ? songFrom(songList.toSong(current)) : null;
  const shown = sameSong(playing, song) && sameSong(songFrom(lastSent.song), song);
  // A switch turned on takes the found facts off at once: an empty batch wouldn't clear them
  if (shown) pullSwitchedOff();
  if (shown && current) {
    generateFacts(songList.toSong(current), current)
      .then((facts) => {
        if (sameSong(songFrom(lastSent.song), song)) broadcast({ type: "facts_ready", song: lastSent.song!, facts });
      })
      .catch((err) => console.error("[SongFacts] Couldn't show the saved facts:", err));
  }
  return shown;
}

control.post("/song-facts", (req, res) => {
  // Saved against the song the editor opened on, even if another is playing now
  const song = songFrom(req.body?.song);
  if (!song) {
    res.status(400).json({ saved: false });
    return;
  }
  // Over a limit: refused with the reason, never trimmed, so what's saved is what was typed
  const problem = songFactsProblem(req.body ?? {});
  if (problem) {
    res.status(400).json({ saved: false, error: problem });
    return;
  }
  // A failed save (a full disk) is an answer for the window, not a crash mid-stream
  try {
    saveSongFacts({
      title: song.title,
      artist: song.artist,
      ...(song.songId ? { songId: song.songId } : {}),
      ...(song.videoId ? { videoId: song.videoId } : {}),
      songwriters: (req.body?.songwriters as string[] | undefined) ?? [],
      link: (req.body?.link as string | undefined) ?? "",
      facts: (req.body?.facts as string[] | undefined) ?? [],
      // The switches (#262): left out (an older app), they're off
      noFacts: req.body?.noFacts === true,
      ...(typeof req.body?.noArtistFacts === "boolean" ? { noArtistFacts: req.body.noArtistFacts as boolean } : {}),
    });
  } catch (err) {
    console.warn(`[SongFacts] Couldn't save: ${err instanceof Error ? err.message : err}`);
    res.status(500).json({ saved: false });
    return;
  }
  // Answered now: the app gives up after 3 seconds, and a slow AI made a save look failed
  res.json({ saved: true, shown: showAgainIfOn(song) });
});

// "No facts for this song" / "for this artist" (#262): the streamer's own facts still show
control.post("/facts-off", (req, res) => {
  const song = songFrom(req.body?.song);
  const kind = req.body?.kind;
  if (!song || (kind !== "song" && kind !== "artist") || typeof req.body?.on !== "boolean") {
    res.status(400).json({ saved: false });
    return;
  }
  try {
    setFactsOff(song, kind, req.body.on);
  } catch (err) {
    console.warn(`[SongFacts] Couldn't save: ${err instanceof Error ? err.message : err}`);
    res.status(500).json({ saved: false });
    return;
  }
  forgetSong(song);
  // On now (or any of the artist's on now): found facts off at once, the streamer's own stay.
  // Switched off again, the found ones are back the next time it plays
  const pulled = req.body.on ? pullSwitchedOff() : 0;
  res.json({ saved: true, off: factsOff(song), pulled });
});

/**
 * Takes off the song on now's bubbles its switches no longer allow, like Wrong (never back on
 * restart or Resume). Returns how many
 */
function pullSwitchedOff(): number {
  const song = lastSent.song;
  if (!song) return 0;
  const allowed = new Set(allowedFacts(song, lastSent.facts ?? []));
  const gone = (lastSent.facts ?? []).filter((f) => !allowed.has(f));
  for (const f of gone) broadcast({ type: "remove_fact", song, text: f.text });
  return gone.length;
}

// The facts that went out, oldest first, for the app's reports (aired-facts.ts)
control.post("/aired", (_req, res) => {
  res.json({ facts: aired.list() });
});

// "Prepare my songs" (#293): {run: true} starts or carries on, {run: false} stops, keeping what's done.
// The app decides when (#295); refused while an overlay is connected
control.post("/prepare", (req, res) => {
  const refused = req.body?.run === true ? cantPrepare() : "";
  if (req.body?.run === true && !refused) preparer.start();
  else preparer.stop();
  res.json({ ...preparer.status(), ...(refused ? { refused } : {}) });
});

// Where preparing stands and how many songs are ready (#294), for the app's window
control.post("/prepare/status", (_req, res) => {
  res.json({ ...preparer.status(), coverage: coverage(prepTargets(), preparedStore) });
});

// "Add facts for another song": search the song list as the musician types
control.post("/songs/search", songSearchRoute(songList));

app.use("/control", control);

app.use("/obs", express.static(path.resolve(__dirname, "../../frontend/obs")));

app.get("/obs-overlay", (req, res) => {
  console.log(`[Server] Overlay page requested by ${req.headers["user-agent"] ?? "unknown"}`);
  res.redirect("/obs/obs-overlay.html" + req.url.replace(/^[^?]*/, ""));
});

const STARTUP_GRACE_MS = 30_000; // ms after start before not reaching the song source counts as degraded

app.get("/health", (_req, res) => {
  const current = songList.getCurrentSong();
  const queueAgeMs = songList.lastSuccessfulFetchAgeMs();
  // Never reached counts too, after startup. A source told to wait (Retry-After) isn't stale:
  // a restart would only undo the wait
  const stale = !songList.backingOff?.() && (queueAgeMs === null
    ? process.uptime() * 1000 > STARTUP_GRACE_MS
    : queueAgeMs > songList.pollIntervalMs() * 3);
  const rejected = songList.authRejected();
  const notFollowing = songList.followingProblem?.() ?? null;
  const { lastOutcome, lastDurationMs, lastEndpoint, ...counts } = factStats;
  const pace = paceReport();

  res.json({
    paused,
    status: rejected ? "unauthorized" : stale || notFollowing ? "degraded" : "ok",
    degradedReason: rejected ? `${songList.name} rejected the token` : stale ? "no successful queue fetch recently" : notFollowing ?? undefined,
    songSource: songList.name,
    aiProvider: config.aiProvider,
    topic: config.topic,
    currentSong: current ? songList.displayTitle(current) : null,
    lastQueueFetchAgeMs: queueAgeMs,
    // For the app's watchdog: failing fetches (an outage) keep this small; only a stuck poll loop grows it
    lastPollAttemptAgeMs: songList.lastPollAttemptAgeMs?.() ?? null,
    pollIntervalMs: songList.pollIntervalMs(),
    eventsConnected: songList.isEventStreamConnected(),
    // How songs arrive, in words for the dashboard ("Hearing your queue live")
    listening: listeningLine(songList),
    // How long the AI took for the song on now ("Facts took 45 s"); empty when it wrote nothing
    factsTook: factsTookLine(current ? aiTimeFor(songList.toSong(current)) : null),
    // Whether the built-in AI asks for less on a busy computer, in words ("Your computer is busy,
    // so quick facts only"), and the measures behind it (#314)
    pace: pace.line,
    computer: pace,
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

// What the overlay is showing now; read-only
app.get("/recent", (_req, res) => {
  // "ready" and "outcome" tell still looking from nothing reliable from failed
  const song = songFrom(lastSent.song);
  // Which bubble is up, on the overlay's schedule (none while paused); earlier songs with their switches
  const onStream = paused ? { up: [], nextInSeconds: null } : bubbleNow(lastSent.facts ?? [], factsShownAt);
  res.json({ ...lastSent, onStream, ready: Boolean(lastSent.ready), outcome: song && lastSent.ready ? outcomeFor(song) : "", earlier: earlier.map((e) => ({ ...e, off: factsOff(e.song) })) });
});

// --- Start -----------------------------------------------------------------

songList.onCurrentSongChange((current) => {
  onSongChange(current).catch((err) => console.error("[Server] Song change failed:", err));
});

// Listen before connecting upstream, so a slow API never delays the overlay's socket
server.listen(config.port, config.host, () => {
  console.log(`[Server] Listening on http://${config.host}:${config.port} (AI: ${config.aiProvider}, topic: ${config.topic})`);
  console.log(`[Server] Tracking streamer "${config.sslStreamerName || config.seChannel || (config.songSource === "nowplaying" ? config.streamerDisplayName : "(from the token)")}" on ${songList.name}`);
});

void warmUpBuiltin();

// Messages from the desktop app (new StreamerSongList tokens, Twitch About answers): Electron's
// parentPort, or Node's IPC channel when it runs the server under Node.js (Linux)
function onAppMessage(data: unknown): void {
  const msg = data as { type?: string; token?: unknown };
  if (msg?.type === "twitch-about") onAboutAnswer(msg);
  if (msg?.type === "twitch-about-off") forgetTwitchAbout();
  if (msg?.type === "ssl-token" && typeof msg.token === "string" && msg.token) {
    setAccessToken(msg.token);
    console.log("[SSL] Sign-in refreshed");
  }
}
type ParentPort = { on(event: "message", listener: (e: { data: unknown }) => void): void; postMessage(message: unknown): void };
const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
parentPort?.on("message", ({ data }) => onAppMessage(data));
if (process.send) process.on("message", onAppMessage);
// An uncaught promise mustn't end the server mid-stream (bubbles stop until the app restarts it): log it
process.on("unhandledRejection", (err) => console.error("[Server] Unhandled error, still running:", err));
// The app holds the Twitch sign-in, so it reads a channel's About for the server (twitch-about.ts)
if (parentPort) connectAboutAsker((m) => parentPort.postMessage(m));
else if (process.send) connectAboutAsker((m) => process.send?.(m));

songList
  .connect()
  .then(() => console.log(`[Server] Connected to ${songList.name}`))
  .catch((err) => console.error(`[Server] ${songList.name} unavailable, retrying by poll: ${err.message}`));
