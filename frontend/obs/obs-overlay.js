/* Stream Facts Overlay
 * ====================
 *
 * v1.0.0
 *
 *  <https://github.com/frolicchris/stream-facts-overlay>
 *
 * Setup
 * -----
 *
 *  Add a Browser Source in OBS with "Local File" ticked, pointing at this
 *  folder's obs-overlay.html, 1920x1080. See README.md.
 *
 *  Open obs-overlay.html?test=1 in a browser to draw a fixed test bubble
 *  without the server. A red dot bottom-right means the server isn't
 *  reachable. Styling lives in obs-overlay.css; positions come from the server.
 */
(function () {
  "use strict";

  // The server listens on the loopback address; change PORT to match .env.
  const PORT = 3000;
  const WS_URL = location.protocol === "file:"
    ? "ws://127.0.0.1:" + PORT + "/ws"
    : (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws";

  const TOAST_MS = 5000;
  const TOAST_FADE_MS = 600;
  const POP_IN_MS = 500;
  const HIDE_FALLBACK_MS = 1000;
  const MAX_RECONNECT_MS = 30000;
  const ICONS = ["♪", "🎵", "⭐", "🎶", "✨", "🌟", "💡", "🎼"];

  const container = document.getElementById("bubble-container");
  const statusDot = document.getElementById("connection-status");

  let bubbles = [];
  const bubbleTimers = [];
  let toast = null;
  const toastTimers = [];
  let currentSongKey = null;
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

  function showBubble(fact) {
    const bubble = document.createElement("div");
    bubble.className = "popup-bubble";
    bubble.style.top = fact.position.top;
    bubble.style.left = fact.position.left;
    bubble.style.setProperty("--bubble-icon", JSON.stringify(ICONS[iconIndex++ % ICONS.length]));
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
    bubbleTimers.push(setTimeout(() => hideBubble(bubble), fact.durationSeconds * 1000));
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
    facts.forEach((fact) => bubbleTimers.push(setTimeout(() => showBubble(fact), fact.delaySeconds * 1000)));
  }

  // --- Connection ---

  function handle(msg) {
    if (msg.type === "new_song") {
      clearBubbles();
      currentSongKey = songKey(msg.song);
      if (msg.song) showToast(msg.song);
    } else if (msg.type === "facts_ready") {
      showFacts(msg.song, msg.facts);
    } else if (msg.type === "clear") {
      clearBubbles();
      removeToast();
      currentSongKey = null;
    }
  }

  function connect() {
    const ws = new WebSocket(WS_URL);
    ws.onopen = () => {
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
