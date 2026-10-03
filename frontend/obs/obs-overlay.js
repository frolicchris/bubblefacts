/* BubbleFacts
 * ====================
 *
 * v2.0.0-beta.10
 *
 *  <https://github.com/frolicchris/bubblefacts>
 *
 * Help
 * ----
 *
 *  Questions, bug reports and wrong facts: open an issue or ask in
 *  Discussions on the page above, or chat on Discord at <https://discord.gg/gXdVKc6KWx>.
 *
 * Setup
 * -----
 *
 *  Add a Browser Source in OBS with "Local File" checked, pointing at this
 *  folder's obs-overlay.html, 1920x1080. See docs/MANUAL-SETUP.md.
 *
 *  Open obs-overlay.html?test=1 in a browser to draw a fixed test bubble
 *  without the server. A red dot bottom-right means the server isn't
 *  reachable. Styling lives in obs-overlay.css; positions come from the server.
 */
(function () {
  "use strict";

  // Where the server is when OBS loads this page as a Local File. Change it
  // if you change PORT, or if the server runs on another machine (HOST).
  const SERVER = "127.0.0.1:3000";
  // As a local file, also try the next few ports: the desktop app moves to one
  // when another program already has its port.
  const PORT_SPAN = 10;
  const [SERVER_HOST, SERVER_PORT] = SERVER.split(":");
  // OBS serves a Local File from http://absolute/<path>, not file://.
  const LOCAL_FILE = location.protocol === "file:" || location.hostname === "absolute";
  let portOffset = 0;
  const wsUrl = () =>
    LOCAL_FILE
      ? "ws://" + SERVER_HOST + ":" + (Number(SERVER_PORT) + portOffset) + "/ws"
      : (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws";

  const TOAST_MS = 5000;
  const TOAST_FADE_MS = 600;
  const POP_IN_MS = 500;
  const HIDE_FALLBACK_MS = 1000;
  // The server is on this computer, so trying often costs nothing, and BubbleFacts
  // opening again shows up on stream within a few seconds.
  const MAX_RECONNECT_MS = 4000;
  const ICONS = ["♪", "🎵", "⭐", "🎶", "✨", "🌟", "💡", "🎼"];

  const container = document.getElementById("bubble-container");
  const statusDot = document.getElementById("connection-status");

  let bubbles = [];
  const bubbleTimers = [];
  let toast = null;
  const toastTimers = [];
  let currentSongKey = null;
  /** Facts the streamer marked wrong during this song: never shown, even from a resent batch. */
  let removed = new Set();
  let iconIndex = 0;
  let reconnectMs = 1000;

  /** Flush the element's hidden style synchronously, then animate. rAF pauses while OBS isn't rendering. */
  function animateIn(el) {
    void el.offsetWidth;
    el.classList.add("visible");
  }

  function cancel(timers) {
    timers.forEach(clearTimeout);
    timers.length = 0;
  }

  const songKey = (song) => (song ? ((song.artist || "") + ":::" + (song.title || "")).toLowerCase() : null);

  // --- Song banner ---

  function removeToast() {
    cancel(toastTimers);
    if (toast) toast.remove();
    toast = null;
  }

  /** "NOW PLAYING" for five seconds, or a persistent "LIVE LEARN" banner. */
  function showToast(song) {
    removeToast();
    const el = document.createElement("div");
    el.className = "song-toast" + (song.liveLearn ? " live-learn" : "");

    const label = document.createElement("span");
    label.className = "toast-label";
    label.textContent = song.liveLearn ? "▶ LIVE LEARN" : "▶ NOW PLAYING";

    const artist = /^unknown$/i.test(song.artist || "") ? "" : song.artist;
    let text = "  " + song.title + (artist ? " — " + artist : "");
    if (song.liveLearn && song.requestedBy) text += " (requested by " + song.requestedBy + ")";

    el.append(label, text);
    container.appendChild(el);
    toast = el;
    animateIn(el);

    if (song.liveLearn) return;
    toastTimers.push(setTimeout(() => {
      el.classList.remove("visible");
      toastTimers.push(setTimeout(() => {
        el.remove();
        if (toast === el) toast = null;
      }, TOAST_FADE_MS));
    }, TOAST_MS));
  }

  // --- Fact bubbles ---

  function clearBubbles() {
    cancel(bubbleTimers);
    bubbles.forEach((b) => b.remove());
    bubbles = [];
  }

  function hideBubble(bubble) {
    const remove = () => {
      bubble.remove();
      bubbles = bubbles.filter((b) => b !== bubble);
    };
    bubble.classList.remove("idle");
    bubble.classList.add("hiding");
    bubble.addEventListener("animationend", remove, { once: true });
    // animationend never fires while the source is hidden.
    bubbleTimers.push(setTimeout(remove, HIDE_FALLBACK_MS));
  }

  /**
   * Long facts stay up long enough to read: about three words a second
   * (subtitle reading speed), plus two seconds to notice the bubble.
   */
  function readingSeconds(fact) {
    const words = String(fact.text || "").split(/\s+/).filter(Boolean).length;
    return Math.max(fact.durationSeconds, 2 + words / 3);
  }

  function showBubble(fact) {
    const bubble = document.createElement("div");
    bubble.className = "popup-bubble";
    // A bottom spot sits on the bottom edge and grows upward, whatever the fact's length.
    if (fact.position.bottom) bubble.style.bottom = fact.position.bottom;
    else bubble.style.top = fact.position.top;
    bubble.style.left = fact.position.left;
    bubble.style.setProperty("--bubble-icon", JSON.stringify(ICONS[iconIndex++ % ICONS.length]));
    bubble.dataset.fact = fact.text;
    bubble.append(fact.text);
    for (let i = 1; i <= 3; i++) {
      const sparkle = document.createElement("span");
      sparkle.className = "sparkle sparkle-" + i;
      bubble.appendChild(sparkle);
    }

    container.appendChild(bubble);
    bubbles.push(bubble);
    animateIn(bubble);

    bubbleTimers.push(setTimeout(() => {
      bubble.classList.remove("visible");
      bubble.classList.add("idle");
    }, POP_IN_MS));
    bubbleTimers.push(setTimeout(() => hideBubble(bubble), readingSeconds(fact) * 1000));
  }

  /**
   * Batches can arrive long after their song started, or after it ended.
   * Drop a batch for a song that is no longer current. Delays count from
   * arrival, so a late batch still shows every fact.
   */
  function showFacts(song, facts) {
    if (!facts || !facts.length || songKey(song) !== currentSongKey) return;
    // A reconnect can resend the batch; replace rather than stack.
    clearBubbles();
    facts.forEach((fact) =>
      bubbleTimers.push(setTimeout(() => removed.has(fact.text) || showBubble(fact), fact.delaySeconds * 1000))
    );
  }

  // --- Connection ---

  function handle(msg) {
    if (msg.type === "new_song") {
      clearBubbles();
      removed = new Set();
      currentSongKey = songKey(msg.song);
      // noBanner: the streamer turned NOW PLAYING off. The last song's banner still goes.
      if (msg.song && !msg.quiet) msg.noBanner ? removeToast() : showToast(msg.song);
    } else if (msg.type === "facts_ready") {
      showFacts(msg.song, msg.facts);
    } else if (msg.type === "test_bubble") {
      // On top of the current song, whose bubbles and state are left alone.
      if (msg.facts && msg.facts[0]) showBubble(msg.facts[0]);
    } else if (msg.type === "remove_fact") {
      if (songKey(msg.song) !== currentSongKey) return;
      removed.add(msg.text);
      bubbles.filter((b) => b.dataset.fact === msg.text).forEach(hideBubble);
    } else if (msg.type === "clear") {
      removed = new Set();
      clearBubbles();
      removeToast();
      currentSongKey = null;
    }
  }

  function connect() {
    const ws = new WebSocket(wsUrl());
    let opened = false;
    ws.onopen = () => {
      opened = true;
      statusDot.classList.add("connected");
      reconnectMs = 1000;
    };
    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      handle(msg);
    };
    ws.onclose = () => {
      statusDot.classList.remove("connected");
      // The song may change while disconnected: drop its pending bubbles and banner.
      // A reconnect starts fresh with the current song.
      if (opened) {
        clearBubbles();
        removeToast();
        currentSongKey = null;
        removed = new Set();
      }
      if (!opened && LOCAL_FILE) {
        portOffset = (portOffset + 1) % (PORT_SPAN + 1);
        if (portOffset !== 0) {
          setTimeout(connect, 200);
          return;
        }
      }
      setTimeout(connect, reconnectMs);
      reconnectMs = Math.min(reconnectMs * 2, MAX_RECONNECT_MS);
    };
    ws.onerror = () => ws.close();
  }

  /** ?test=1: a fixed bubble and banner with inline styles, independent of the server and animations. */
  function renderTestMode() {
    if (!/[?&]test=1(&|$)/.test(location.search)) return;
    const bubble = document.createElement("div");
    bubble.className = "popup-bubble";
    Object.assign(bubble.style, { top: "8%", left: "33%", opacity: "1", transform: "scale(1)" });
    bubble.textContent = "TEST MODE — if you can read this in OBS, the browser source is loading and rendering correctly.";
    const banner = document.createElement("div");
    banner.className = "song-toast";
    banner.style.opacity = "1";
    banner.textContent = "▶ TEST MODE — remove ?test=1 when done";
    container.append(bubble, banner);
  }

  renderTestMode();
  connect();
})();
