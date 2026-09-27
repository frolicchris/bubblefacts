/**
 * OBS Browser Source Overlay — Stream Facts Overlay
 *
 * RPG dialog boxes with sparkle effects (restyle in obs-overlay.css).
 * Connects to backend via WebSocket for real-time song fact display.
 *
 * OBS Browser Source setup:
 * - URL: http://localhost:3000/obs-overlay
 * - Width: 1920, Height: 1080
 * - Check "Refresh browser when scene becomes active"
 */
(function () {
  "use strict";

  /**
   * The overlay is meant to be loaded as an OBS "Local File" (see README).
   * When it is served from the backend instead, its own origin is used.
   *
   * Why Local File: OBS loads every Browser Source the moment it starts. If
   * the overlay server is not up yet (2026-09-20: OBS 17:49, server 17:53),
   * CEF renders a connection-error page and never retries — the reconnect
   * loop below only exists once THIS file has loaded. A local file always
   * loads, so the WebSocket simply keeps knocking until the server answers.
   */
  var WS_URL =
    location.protocol === "file:"
      ? "ws://localhost:3000/ws"
      : (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host + "/ws";

  var container = document.getElementById("bubble-container");
  var statusDot = document.getElementById("connection-status");
  var activeBubbles = [];
  var factTimers = [];
  var songToast = null;
  var ws = null;
  var reconnectDelay = 1000;
  var maxReconnectDelay = 30000;

  // Which song is on screen — used to drop fact batches that arrive after
  // the song has already changed.
  var currentSongKey = null;

  // --- Sound effect CSS class cycling (visual only — no audio) ---
  var gameIcons = [
    "\uD83C\uDFAE", // gamepad
    "\uD83C\uDFB5", // musical note
    "\u2B50",       // star
    "\uD83D\uDD25", // fire
    "\u2764\uFE0F", // heart
    "\uD83C\uDFC6", // trophy
    "\u26A1",       // lightning
    "\uD83C\uDF1F", // glowing star
  ];
  var iconIndex = 0;

  function nextIcon() {
    var icon = gameIcons[iconIndex % gameIcons.length];
    iconIndex++;
    return icon;
  }


  /**
   * Commit the element's initial (hidden) style, then start the animation.
   *
   * This used requestAnimationFrame, which is NOT reliable here: rAF is
   * paused whenever the page is not being rendered, and an OBS browser
   * source can be in that state during a scene transition or while hidden.
   * A bubble created in that window was appended at opacity:0 and never
   * received `.visible`, so it stayed invisible for its whole lifetime and
   * then silently expired — indistinguishable from "the overlay didn't fire".
   *
   * Reading offsetWidth forces the pending style to flush synchronously,
   * which is all the rAF was ever there to achieve.
   */
  function startAnimation(el, className) {
    void el.offsetWidth;
    el.classList.add(className);
  }

  // --- WebSocket Connection ---

  function connect() {
    ws = new WebSocket(WS_URL);

    ws.onopen = function () {
      console.log("[PopUpFacts] WebSocket connected");
      statusDot.classList.add("connected");
      reconnectDelay = 1000;
    };

    ws.onmessage = function (event) {
      try {
        var payload = JSON.parse(event.data);
        handlePayload(payload);
      } catch (err) {
        console.error("[PopUpFacts] Error parsing message:", err);
      }
    };

    ws.onclose = function () {
      console.log("[PopUpFacts] WebSocket disconnected, reconnecting in " + reconnectDelay + "ms");
      statusDot.classList.remove("connected");
      scheduleReconnect();
    };

    ws.onerror = function (err) {
      console.error("[PopUpFacts] WebSocket error:", err);
      ws.close();
    };
  }

  function scheduleReconnect() {
    setTimeout(function () {
      reconnectDelay = Math.min(reconnectDelay * 2, maxReconnectDelay);
      connect();
    }, reconnectDelay);
  }

  // --- Payload Handler ---

  function handlePayload(payload) {
    console.log("[PopUpFacts] Received:", payload.type);

    switch (payload.type) {
      case "new_song":
        handleNewSong(payload.song);
        break;
      case "facts_ready":
        handleFactsReady(payload.song, payload.facts);
        break;
      case "clear":
        clearAllBubbles();
        // Must null the key too: the guard below rejects only a positive
        // mismatch, so leaving the old key set let a late batch for the
        // just-ended song play over the outro.
        currentSongKey = null;
        break;
    }
  }

  // --- Song Change ---

  function songKey(song) {
    if (!song) return null;
    return ((song.artist || "") + ":::" + (song.title || "")).toLowerCase();
  }

  function handleNewSong(song) {
    clearAllBubbles();
    if (!song) return;
    // Remember which song is on screen so a late batch for the previous
    // one can be discarded rather than displayed over this one.
    currentSongKey = songKey(song);
    showSongToast(song.title, song.artist, song);
  }

  /**
   * Song banner. For a normal song it shows "NOW PLAYING" for 5 s. For a
   * Live Learn (song.liveLearn, an off-list request) it shows "LIVE LEARN"
   * with the requester and STAYS until the next new_song or clear — both of
   * which already remove the toast — because no fact bubbles follow it.
   */
  function showSongToast(title, artist, song) {
    if (songToast) {
      songToast.remove();
    }

    var liveLearn = !!(song && song.liveLearn);

    songToast = document.createElement("div");
    songToast.className = "song-toast" + (liveLearn ? " live-learn" : "");

    // Build inner HTML with label prefix
    var label = document.createElement("span");
    label.className = "toast-label";
    label.textContent = liveLearn ? "\u25B6 LIVE LEARN" : "\u25B6 NOW PLAYING";

    var text = "  " + title + (artist ? " \u2014 " + artist : "");
    if (liveLearn && song.requestedBy) {
      text += " (requested by " + song.requestedBy + ")";
    }
    var songText = document.createTextNode(text);

    songToast.appendChild(label);
    songToast.appendChild(songText);
    container.appendChild(songToast);

    // Capture the element. Both timers previously read the module-level
    // `songToast`, and neither was cancellable, so song A's orphaned timer
    // stripped `.visible` from and then removed song B's banner — B showed
    // for ~2s instead of 5.
    var el = songToast;

    startAnimation(el, "visible");

    // A live-learn banner is persistent; nothing to schedule.
    if (liveLearn) return;

    factTimers.push(
      setTimeout(function () {
        el.classList.remove("visible");
        factTimers.push(
          setTimeout(function () {
            if (el.parentNode) el.parentNode.removeChild(el);
            if (songToast === el) songToast = null;
          }, 600)
        );
      }, 5000)
    );
  }

  // --- Fact Bubbles ---

  /**
   * Facts are generated asynchronously and can take tens of seconds (measured
   * 8s locally, 34-41s on the Mac mini), so a batch routinely arrives well
   * after its song started — and sometimes after that song has ended.
   *
   * Two rules, both learned from bubbles behaving erratically on stream:
   *
   * 1. Drop batches whose song is no longer playing. Generation for song A
   *    can still be in flight when song B starts; without this check A's
   *    facts are displayed over B. The payload has always carried `song` —
   *    it was simply being ignored here.
   *
   * 2. Treat `appearAtSecond` as SPACING, not as absolute offsets from the
   *    song's start. Anchoring to song start seems more principled but is
   *    wrong in practice: a batch arriving 40s in would have its 0s/15s/30s
   *    entries already "past", so most of the batch is discarded and the
   *    overlay shows two bubbles instead of five. Re-basing to arrival keeps
   *    every fact and preserves the gaps between them.
   */
  function handleFactsReady(song, facts) {
    if (!facts || facts.length === 0) return;

    var key = songKey(song);
    // Strict inequality, including the null case: after a `clear` there is no
    // current song, so nothing should be scheduled.
    if (key !== currentSongKey) {
      console.log(
        "[PopUpFacts] Dropping facts for \"" + song.title + "\" — song already changed"
      );
      return;
    }

    // Cancel anything still queued for this song before scheduling. A
    // browser-source reconnect (which the recommended "Refresh when scene
    // becomes active" setting makes routine) can deliver a second batch with
    // no intervening new_song. Positions are deterministic, so the copies
    // superimposed exactly and two 94%-opaque boxes composited into an
    // unreadable smear rather than looking like two bubbles.
    factTimers.forEach(function (t) {
      clearTimeout(t);
    });
    factTimers = [];

    // Normalise so the earliest fact shows immediately and the rest keep
    // their relative spacing.
    var earliest = facts.reduce(function (min, f) {
      return Math.min(min, f.appearAtSecond);
    }, Infinity);

    facts.forEach(function (fact) {
      var delaySec = fact.appearAtSecond - earliest;
      var timer = setTimeout(function () {
        showBubble(fact);
      }, delaySec * 1000);
      factTimers.push(timer);
    });
  }

  function showBubble(fact) {
    var bubble = document.createElement("div");
    bubble.className = "popup-bubble";
    bubble.style.top = fact.position.top;
    bubble.style.left = fact.position.left;
    bubble.dataset.factId = fact.id;

    // Rotate the gamepad glyph. The CSS ::before falls back to its own
    // content when the variable is unset, so this must be set for the
    // rotation to be visible at all — previously the value was computed and
    // then never reached the element that renders it.
    bubble.style.setProperty("--bubble-icon", '"' + nextIcon() + '"');

    // Fact text
    var textNode = document.createTextNode(fact.text);
    bubble.appendChild(textNode);

    // Add sparkle particles
    for (var i = 1; i <= 3; i++) {
      var sparkle = document.createElement("span");
      sparkle.className = "sparkle sparkle-" + i;
      bubble.appendChild(sparkle);
    }

    container.appendChild(bubble);
    activeBubbles.push(bubble);

    // Trigger pop-in animation
    startAnimation(bubble, "visible");

    // After pop-in completes, switch to idle float
    factTimers.push(
      setTimeout(function () {
        if (bubble.parentNode) {
          bubble.classList.remove("visible");
          bubble.classList.add("idle");
        }
      }, 500)
    );

    // Schedule removal after duration
    var hideTimer = setTimeout(function () {
      hideBubble(bubble);
    }, fact.durationSeconds * 1000);
    factTimers.push(hideTimer);
  }

  function hideBubble(bubble) {
    if (!bubble.parentNode) return;

    bubble.classList.remove("idle");
    bubble.classList.add("hiding");

    bubble.addEventListener("animationend", function () {
      if (bubble.parentNode) {
        bubble.parentNode.removeChild(bubble);
      }
      activeBubbles = activeBubbles.filter(function (b) {
        return b !== bubble;
      });
    });
  }

  function clearAllBubbles() {
    factTimers.forEach(function (t) {
      clearTimeout(t);
    });
    factTimers = [];

    activeBubbles.forEach(function (bubble) {
      if (bubble.parentNode) {
        bubble.parentNode.removeChild(bubble);
      }
    });
    activeBubbles = [];

    if (songToast) {
      songToast.remove();
      songToast = null;
    }
  }


  /**
   * Test mode: append `?test=1` to the overlay URL.
   *
   *   http://localhost:3000/obs-overlay?test=1
   *
   * Draws a permanent bubble immediately, with opacity and transform set
   * INLINE rather than via the animation classes. That deliberately bypasses
   * both the WebSocket and the CSS animations, so if OBS shows this and not
   * real facts the problem is delivery or timing, and if OBS shows nothing at
   * all the problem is the source itself — size, position, visibility, or the
   * page not loading. Those are the two branches that looked identical on
   * stream for two weeks.
   */
  function maybeRenderTestBubble() {
    if (!/[?&]test=1(&|$)/.test(location.search)) return;

    var b = document.createElement("div");
    b.className = "popup-bubble";
    b.dataset.factId = "TEST";
    // Same slot as POSITIONS[0] in fact-generator.ts, so the test bubble is
    // a real check of the clear region (12%/8% sat inside the queue panel).
    b.style.top = "8%";
    b.style.left = "33%";
    b.style.opacity = "1";
    b.style.transform = "scale(1)";
    b.textContent =
      "TEST MODE — if you can read this in OBS, the browser source is " +
      "loading and rendering correctly.";
    container.appendChild(b);

    var t = document.createElement("div");
    t.className = "song-toast";
    t.style.opacity = "1";
    t.textContent = "\u25B6 TEST MODE \u2014 remove ?test=1 when done";
    container.appendChild(t);

    console.log("[PopUpFacts] Test mode active");
  }

  // --- Start ---
  maybeRenderTestBubble();
  connect();
})();
