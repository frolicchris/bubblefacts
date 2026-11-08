/* BubbleFacts
 * ====================
 *
 * v2.2.0-beta.4
 *
 *  <https://github.com/frolicchris/bubblefacts>
 *
 * Help
 * ----
 *
 *  Bug reports and wrong facts: open an issue on the page above.
 *  Questions: #help on the BubbleFacts Discord, https://discord.gg/3YS3eWkWrW
 *
 * Setup
 * -----
 *
 *  Add a Browser Source in OBS with the URL http://127.0.0.1:3000/obs-overlay
 *  while the server runs, or with "Local file" checked, pointing at this
 *  folder's obs-overlay.html, 1920x1080. See docs/MANUAL-SETUP.md.
 *
 *  For a vertical (9:16) stream, use obs-overlay-vertical.html instead, at
 *  1080x1920. It has its own bubble spots and size, kept clear of the
 *  phone apps' buttons and chat.
 *
 *  Open obs-overlay.html?test=1 in a browser to draw a fixed test bubble
 *  without the server. A red dot bottom-right means the server isn't
 *  reachable. Styling lives in obs-overlay.css; positions, the bubble size,
 *  and which Style to use, come from the server.
 */
(function () {
  "use strict";

  // The server, for a Local File: change it with PORT, or HOST for another machine
  const SERVER = "127.0.0.1:3000";
  const PORT_SPAN = 10; // next ports also tried; the app moves up when its port is taken
  const [SERVER_HOST, SERVER_PORT] = SERVER.split(":");
  // OBS serves a Local File from http://absolute/<path>, not file://
  const LOCAL_FILE = location.protocol === "file:" || location.hostname === "absolute";
  let portOffset = 0;
  const wsUrl = () =>
    LOCAL_FILE
      ? "ws://" + SERVER_HOST + ":" + (Number(SERVER_PORT) + portOffset) + "/ws"
      : (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws";

  const TOAST_MS = 5000;         // ms the NOW PLAYING banner stays up
  const TOAST_FADE_MS = 600;     // ms the banner takes to fade out
  const POP_IN_MS = 500;         // ms a bubble takes to pop in
  const HIDE_FALLBACK_MS = 1000; // ms before a fading bubble is removed anyway
  const MAX_RECONNECT_MS = 4000; // ms; the server is on this computer, so retrying often is free
  const ICONS = ["♪", "🎵", "⭐", "🎶", "✨", "🌟", "💡", "🎼"];

  // The vertical overlay (obs-overlay-vertical.html) uses each fact's vertical spot
  const VERTICAL = document.documentElement.dataset.layout === "vertical";

  const container = document.getElementById("bubble-container");
  const statusDot = document.getElementById("connection-status");

  let bubbles = [];
  const bubbleTimers = [];
  /** Each fact's turn still to come; a batch with `keep` replaces only these */
  const showTimers = [];
  let toast = null;
  const toastTimers = [];
  let currentSongKey = null;
  /** Facts marked wrong this song: never shown, even from a resent batch */
  let removed = new Set();
  let iconIndex = 0;
  let reconnectMs = 1000;

  /** Force a style update, then animate (requestAnimationFrame pauses while OBS isn't drawing) */
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

  /** "NOW PLAYING" for TOAST_MS, or a "LIVE LEARN" banner that stays */
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
    cancel(showTimers);
    cancel(bubbleTimers);
    bubbles.forEach((b) => b.remove());
    bubbles = [];
  }

  function hideBubble(bubble) {
    // Already on its way out (replaced, then its time ran out, or marked wrong)
    if (bubble.dataset.hiding) return;
    bubble.dataset.hiding = "1";
    const remove = () => {
      bubble.remove();
      bubbles = bubbles.filter((b) => b !== bubble);
    };
    bubble.classList.remove("idle");
    bubble.classList.add("hiding");
    bubble.addEventListener("animationend", remove, { once: true });
    // animationend never fires while the source is hidden
    bubbleTimers.push(setTimeout(remove, HIDE_FALLBACK_MS));
  }

  /**
   * Seconds up: 3 words a second (subtitle speed) plus 2 to notice it.
   * Must match readingSeconds in session.ts (hands-free Wrong uses it)
   */
  function readingSeconds(fact) {
    const words = String(fact.text || "").split(/\s+/).filter(Boolean).length;
    return Math.max(fact.durationSeconds, 2 + words / 3);
  }

  function showBubble(fact) {
    const bubble = document.createElement("div");
    bubble.className = "popup-bubble";
    const at = (VERTICAL && fact.vertical) || fact.position;
    // A bottom spot grows upward from the bottom edge, whatever the fact's length
    if (at.bottom) bubble.style.bottom = at.bottom;
    else bubble.style.top = at.top;
    // Right spots measure from the right edge, others with no side are centered: any length stays in its spot
    if (at.left) bubble.style.left = at.left;
    else if (at.right) bubble.style.right = at.right;
    else bubble.classList.add("centered");
    bubble.dataset.spot = [at.top, at.bottom, at.left, at.right].join("|");
    bubble.style.setProperty("--bubble-icon", JSON.stringify(ICONS[iconIndex++ % ICONS.length]));
    bubble.dataset.fact = fact.text;
    bubble.append(fact.text);
    for (let i = 1; i <= 3; i++) {
      const sparkle = document.createElement("span");
      sparkle.className = "sparkle sparkle-" + i;
      bubble.appendChild(sparkle);
    }

    // One bubble per spot: the last one there fades out as this one pops in
    bubbles.filter((b) => b.dataset.spot === bubble.dataset.spot).forEach(hideBubble);
    container.appendChild(bubble);
    bubbles.push(bubble);
    animateIn(bubble);

    bubbleTimers.push(setTimeout(() => {
      bubble.classList.remove("visible");
      bubble.classList.add("idle");
    }, POP_IN_MS));
    bubbleTimers.push(setTimeout(() => hideBubble(bubble), readingSeconds(fact) * 1000));
  }

  /** Shows a batch for the current song (others are dropped); delays count from arrival */
  function showFacts(song, facts, keep) {
    if (!facts || songKey(song) !== currentSongKey) return;
    if (keep) {
      // More facts (the AI's, after the data ones): the bubble on screen stays, these replace the turns to come
      cancel(showTimers);
    } else {
      if (!facts.length) return;
      // A reconnect can resend the batch: replace, don't stack
      clearBubbles();
    }
    const showing = (text) => bubbles.some((b) => b.dataset.fact === text && !b.dataset.hiding);
    // Joining mid-song: catch-up keeps one bubble per landscape spot, but a vertical area is one spot,
    // so only the latest comes back
    if (VERTICAL) {
      const spot = (f) => JSON.stringify(f.vertical || f.position);
      facts = facts.filter((f, i) => f.delaySeconds > 0 || !facts.some((g, j) => j > i && g.delaySeconds <= 0 && spot(g) === spot(f)));
    }
    facts.forEach((fact) =>
      showTimers.push(setTimeout(() => removed.has(fact.text) || showing(fact.text) || showBubble(fact), fact.delaySeconds * 1000))
    );
  }

  // --- Style (issue #177) ---

  /** The built-in Styles in obs-overlay.css; anything else shows Classic, never no bubbles */
  const STYLES = ["classic", "light", "minimal", "retro", "high-contrast"];
  const ICON_CHOICES = ["notes", "heart", "star", "moon", "diamond"];
  const HEX = /^#[0-9a-f]{6}$/i;
  const COLOR_KEYS = ["background", "accent", "text", "label", "liveLearn"];
  const CUSTOM_ALPHA = 1; // custom background opacity; must match CUSTOM_ALPHA in bubble-style.ts (contrast check)
  let colorSheet = null;
  let sizeSheet = null;

  const rgbaOf = (hex, alpha) =>
    "rgba(" + [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ") + ", " + alpha + ")";

  /** The streamer's colors: beat the Style, lose to OBS's Custom CSS. The server picked readable text colors */
  function customColorsCss(c) {
    const lightText = parseInt(c.text.slice(1, 3), 16) > 128;
    const shadow = lightText ? "0 2px 4px rgba(0, 0, 0, 0.9)" : "none";
    const props = {
      "--bf-bg-1": rgbaOf(c.background, CUSTOM_ALPHA),
      "--bf-bg-2": rgbaOf(c.background, CUSTOM_ALPHA),
      "--bf-toast-bg-1": rgbaOf(c.background, CUSTOM_ALPHA),
      "--bf-toast-bg-2": rgbaOf(c.background, CUSTOM_ALPHA),
      "--bf-accent": c.accent,
      "--bf-outline": rgbaOf(c.accent, 0.3),
      "--bf-text": c.text,
      "--bf-text-shadow": shadow,
      "--bf-toast-text": c.text,
      "--bf-toast-glow": shadow,
      "--bf-toast-label": c.label,
      "--bf-live-learn": c.liveLearn,
    };
    return ":where(html) {\n" + Object.keys(props).map((k) => "  " + k + ": " + props[k] + ";").join("\n") + "\n}";
  }

  /** The look the streamer chose, switched at once, bubbles on screen included */
  function applyStyle(msg) {
    document.documentElement.dataset.style = STYLES.includes(msg.style) ? msg.style : "classic";
    if (ICON_CHOICES.includes(msg.icon)) document.documentElement.dataset.icon = msg.icon;
    else delete document.documentElement.dataset.icon;
    applySizes(msg);
    const c = msg.colors;
    const custom = !!c && COLOR_KEYS.every((k) => HEX.test(c[k]));
    if (!custom && !colorSheet) return;
    if (!colorSheet) {
      colorSheet = document.createElement("style");
      document.head.appendChild(colorSheet);
    }
    colorSheet.textContent = custom ? customColorsCss(c) : "";
  }

  /** A size the server sent, or null outside MIN_SCALE to MAX_SCALE (bubble-style.ts) */
  const sizeOf = (n) => (typeof n === "number" && n >= 0.5 && n <= 3 ? n : null);

  /** Bubble size, live: beats the size in the copied CSS, loses to OBS's Custom CSS */
  function applySizes(msg) {
    const scale = sizeOf(msg.scale);
    const vertical = sizeOf(msg.verticalScale);
    if (scale === null && vertical === null && !sizeSheet) return;
    if (!sizeSheet) {
      sizeSheet = document.createElement("style");
      document.head.appendChild(sizeSheet);
    }
    const props = (scale !== null ? "  --bf-scale: " + scale + ";\n" : "") + (vertical !== null ? "  --bf-vertical-scale: " + vertical + ";\n" : "");
    sizeSheet.textContent = props ? ":where(html) {\n" + props + "}" : "";
  }

  // --- Connection ---

  function handle(msg) {
    if (msg.type === "style") {
      applyStyle(msg);
    } else if (msg.type === "new_song") {
      clearBubbles();
      removed = new Set();
      currentSongKey = songKey(msg.song);
      // noBanner: NOW PLAYING is off; the last song's banner still goes
      if (msg.song && !msg.quiet) msg.noBanner ? removeToast() : showToast(msg.song);
    } else if (msg.type === "facts_ready") {
      showFacts(msg.song, msg.facts, msg.keep === true);
    } else if (msg.type === "test_bubble") {
      // On top of the current song, whose bubbles and state are left alone
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

  // --- OBS's streaming signal ---

  /** The open connection, for the one message the overlay sends */
  let socket = null;

  /** Tells the app OBS started or stopped streaming, so the credit goes out as the stream goes live */
  function sendStreaming(streaming) {
    if (socket && socket.readyState === 1) socket.send(JSON.stringify({ type: "obs_streaming", streaming }));
  }
  window.addEventListener("obsStreamingStarted", () => sendStreaming(true));
  window.addEventListener("obsStreamingStopped", () => sendStreaming(false));

  /** On connecting: whether OBS is already streaming, so a stream that went live first still counts */
  function reportStreaming() {
    const obs = window.obsstudio;
    if (!obs || typeof obs.getStatus !== "function") return;
    try {
      obs.getStatus((status) => {
        if (status && typeof status.streaming === "boolean") sendStreaming(status.streaming);
      });
    } catch {
      // Not allowed by this source's Page permissions: the events above may still come
    }
  }

  function connect() {
    const ws = new WebSocket(wsUrl());
    let opened = false;
    ws.onopen = () => {
      opened = true;
      socket = ws;
      statusDot.classList.add("connected");
      reconnectMs = 1000;
      reportStreaming();
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
      if (socket === ws) socket = null;
      statusDot.classList.remove("connected");
      // The song may change while disconnected: drop its bubbles and banner; a reconnect starts fresh
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

  /** ?test=1: a fixed bubble and banner, with no server or animations */
  function renderTestMode() {
    if (!/[?&]test=1(&|$)/.test(location.search)) return;
    const bubble = document.createElement("div");
    bubble.className = "popup-bubble" + (VERTICAL ? " centered" : "");
    Object.assign(bubble.style, VERTICAL ? { top: "15%" } : { top: "8%", left: "33%" }, { opacity: "1", transform: "scale(1)" });
    bubble.textContent = "TEST MODE — if you can read this in OBS, the browser source is loading and rendering correctly.";
    const banner = document.createElement("div");
    banner.className = "song-toast";
    banner.style.opacity = "1";
    banner.textContent = "▶ TEST MODE — remove ?test=1 when done";
    container.append(bubble, banner);
  }

  /**
   * A vertical overlay in a wide source (landscape canvas, or a new source's 800x600): says how to fix it.
   * Only in OBS: "Test in your browser" opens it in a wide window on purpose
   */
  function checkVerticalSize() {
    if (!VERTICAL || !window.obsstudio) return;
    const wide = window.innerWidth > window.innerHeight;
    let note = document.querySelector(".size-note");
    if (wide && !note) {
      note = document.createElement("div");
      note.className = "size-note";
      note.textContent = "BubbleFacts Vertical: in this Browser source's properties, set Width to 1080 and Height to 1920.";
      document.body.appendChild(note);
    } else if (!wide && note) {
      note.remove();
    }
  }

  renderTestMode();
  checkVerticalSize();
  window.addEventListener("resize", checkVerticalSize);
  connect();
})();
