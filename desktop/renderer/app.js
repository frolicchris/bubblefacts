/* BubbleFacts desktop window. Talks to the app only through window.bubbleFacts. */
(function () {
  "use strict";

  const api = window.bubbleFacts;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  let state = null;
  let recentTimer = null;

  // --- Views -------------------------------------------------------------

  function show(view) {
    for (const v of $$(".view")) v.hidden = v.id !== "view-" + view;
    for (const b of $$(".navlink")) b.setAttribute("aria-current", b.dataset.view === view ? "page" : "false");
    $("#nav").hidden = view === "setup";
    clearInterval(recentTimer);
    if (view === "dashboard") {
      refreshRecent();
      recentTimer = setInterval(refreshRecent, 4000);
    }
    if (view === "settings") fillSettings();
  }

  function goStep(n) {
    for (const s of $$(".step")) s.hidden = Number(s.dataset.step) !== n;
    for (const li of $$(".steps li")) {
      const k = Number(li.dataset.step);
      li.classList.toggle("current", k === n);
      li.classList.toggle("done", k < n);
    }
    $(`.step[data-step="${n}"] h1`).focus?.();
  }

  // --- Shared buttons ----------------------------------------------------

  // The main process starts a real file drag, which OBS turns into a Browser source.
  document.addEventListener("dragstart", (e) => {
    if (!e.target.closest?.("[data-drag-overlay]")) return;
    e.preventDefault();
    api.startDrag();
  });

  document.addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.open) api.openExternal(t.dataset.open);
    if ("openLicense" in t.dataset) api.openExternal(state.modelLicense);
    if ("testOverlay" in t.dataset) api.testOverlay();
    if ("copyPath" in t.dataset) {
      api.copy(state.overlayPath);
      flash(t, "Copied");
    }
    if (t.dataset.toggleSecret) {
      const input = document.getElementById(t.dataset.toggleSecret);
      input.type = input.type === "password" ? "text" : "password";
      t.textContent = input.type === "password" ? "Show" : "Hide";
    }
    if (t.dataset.gotoStep) goStep(Number(t.dataset.gotoStep));
    if (t.dataset.view) show(t.dataset.view);
  });

  function flash(button, text) {
    const before = button.textContent;
    button.textContent = text;
    setTimeout(() => (button.textContent = before), 1500);
  }

  function setResult(el, text, kind) {
    el.textContent = text;
    el.className = "result " + (kind || "");
  }

  const onSE = () => state?.settings.songSource === "streamelements";
  /** The channel name for the song source in use. */
  const channelName = () => (onSE() ? state.settings.seChannel : state.settings.channel);
  /** The song source has its token saved. */
  const connected = () => (onSE() ? state.settings.seJwtSet : state.settings.tokenSet);

  // --- Setup: step 1, connect ------------------------------------------------

  const channelInput = $("#setup-channel");
  const tokenInput = $("#setup-token");
  const testResult = $("#setup-test-result");

  async function doSignIn(button, result) {
    if (button.dataset.running) {
      api.cancelSignIn();
      return false;
    }
    button.dataset.running = "1";
    const label = button.textContent;
    button.textContent = "Waiting for your browser... (click to cancel)";
    setResult(result, "");
    const r = await api.signIn();
    delete button.dataset.running;
    button.textContent = label;
    if (!r.ok) {
      setResult(result, r.reason, "bad");
      return false;
    }
    state = r.state;
    return true;
  }

  $("#sign-in").addEventListener("click", async (e) => {
    if (await doSignIn(e.currentTarget, $("#sign-in-result"))) toStreamStep();
  });

  $("#setup-test").addEventListener("click", async () => {
    setResult(testResult, "Checking...");
    const r = await api.testConnection(channelInput.value, tokenInput.value, "streamer");
    if (!r.ok) return setResult(testResult, r.reason, "bad");
    setResult(testResult, "✓ Connected.", "ok");
    const saved = await api.saveSettings({ songSource: "streamersonglist", channel: channelInput.value.trim(), token: tokenInput.value.trim() });
    if (saved.error) return setResult(testResult, saved.error, "bad");
    state = saved;
    toStreamStep();
  });

  // Where the requests come from: StreamerSongList (sign in) or StreamElements (paste a token).
  function showSourceBox() {
    const se = $('input[name="setup-source"]:checked').value === "streamelements";
    $("#se-box").hidden = !se;
    $("#ssl-box").hidden = se;
  }
  for (const r of $$('input[name="setup-source"]')) r.addEventListener("change", showSourceBox);

  $("#setup-se-test").addEventListener("click", async () => {
    const result = $("#setup-se-result");
    setResult(result, "Checking...");
    const jwt = $("#setup-se-jwt").value.trim();
    if (!jwt) return setResult(result, "Paste your JWT token first.", "bad");
    const r = await api.testStreamElements($("#setup-se-channel").value, jwt);
    if (!r.ok) return setResult(result, r.reason, "bad");
    setResult(result, "✓ Connected.", "ok");
    const saved = await api.saveSettings({ songSource: "streamelements", seChannel: r.channel, seJwt: jwt });
    if (saved.error) return setResult(result, saved.error, "bad");
    state = saved;
    toStreamStep();
  });

  // --- Setup: step 2, OBS ------------------------------------------------------------

  let obsConfirmed = false;

  function toStreamStep() {
    $("#connected-as").textContent = onSE()
      ? `✓ Connected to StreamElements${channelName() ? " as " + channelName() : ""}.`
      : `✓ Connected to ${state.settings.channel}.`;
    renderPaths();
    goStep(2);
    renderObsCheck();
  }

  const obsConnected = (s) => !!s?.health?.clients?.some((c) => /OBS\//.test(c.ua));

  /** Watch for OBS to load the overlay, then put a test bubble on stream and say so. */
  async function renderObsCheck() {
    const box = $("#obs-check");
    if (obsConfirmed || !obsConnected(state.status)) {
      if (!obsConfirmed) {
        box.className = "check waiting";
        $(".check-icon", box).textContent = "…";
        $("#obs-check-text").textContent = state.status?.state === "running"
          ? "Waiting for OBS. As soon as you drop it in, a test bubble appears on your stream."
          : "Getting BubbleFacts ready. You can add it to OBS now.";
      }
      return;
    }
    obsConfirmed = true;
    await api.testBubble();
    box.className = "check ok";
    $(".check-icon", box).textContent = "✓";
    $("#obs-check-text").textContent = "It's on your stream! You should see a test bubble in OBS now.";
    $("#show-test-again").hidden = false;
    const next = $("#stream-next");
    next.className = "primary";
    next.textContent = "Continue";
    next.focus();
  }

  $("#show-test-again").addEventListener("click", () => api.testBubble());
  $("#stream-next").addEventListener("click", toMusicStep);

  // --- Setup: step 3, your music (optional) --------------------------------------------

  function toMusicStep() {
    $("#setup-originals").checked = state.settings.originals;
    $("#setup-livelearns").checked = state.settings.liveLearns;
    // Live learns are a StreamerSongList idea: StreamElements requests are always videos.
    $("#setup-livelearns-row").hidden = onSE();
    $("#setup-myoriginals").value = state.settings.myOriginals.join("\n");
    $("#setup-originals-box").hidden = !state.settings.originals;
    if (state.settings.myFacts.length) {
      $('input[name="facts-choice"][value="now"]').checked = true;
      $("#setup-myfacts").value = state.settings.myFacts.join("\n");
    }
    showFactsBox();
    goStep(3);
  }

  function showFactsBox() {
    $("#setup-facts-box").hidden = $('input[name="facts-choice"]:checked').value !== "now";
  }
  for (const r of $$('input[name="facts-choice"]')) r.addEventListener("change", showFactsBox);
  $("#setup-originals").addEventListener("change", (e) => ($("#setup-originals-box").hidden = !e.target.checked));

  const lines = (el) => el.value.split("\n").map((l) => l.trim()).filter(Boolean);

  async function finishSetup(changes) {
    const saved = await api.saveSettings({ ...changes, setupComplete: true });
    if (saved.error) return setResult($("#facts-result"), saved.error, "bad");
    state = saved;
    show("dashboard");
    renderStatus(state.status);
    renderNotices();
  }

  $("#music-skip").addEventListener("click", () => finishSetup({}));
  $("#music-finish").addEventListener("click", () => {
    const originals = $("#setup-originals").checked;
    finishSetup({
      originals,
      liveLearns: $("#setup-livelearns").checked,
      myOriginals: originals ? lines($("#setup-myoriginals")) : state.settings.myOriginals,
      myFacts: $('input[name="facts-choice"]:checked').value === "now" ? lines($("#setup-myfacts")) : state.settings.myFacts,
    });
  });

  function downloadText(d) {
    if (!d) return "";
    if (d.error) return `Paused: ${d.error}. It tries again on its own.`;
    if (d.phase === "checking") return "Almost ready";
    if (d.phase === "done") return "Ready";
    return `${Math.floor((d.received / d.total) * 100)}% downloaded`;
  }

  api.on("model-progress", (p) => {
    if (!state) return;
    state.modelDownload = p;
    if (p.phase === "done") state.modelReady = true;
    renderStatus(state.status);
  });

  function renderPaths() {
    for (const c of $$(".overlay-path")) c.textContent = state.overlayPath;
  }

  // --- Dashboard -----------------------------------------------------------

  const ICONS = { ok: "✓ ", warn: "! ", bad: "✕ ", "": "" };

  /** Status in words and a symbol, never color alone. */
  function light(id, kind, text) {
    const li = $("#" + id);
    li.className = kind;
    $("em", li).textContent = ICONS[kind] + text;
  }

  function renderStatus(status) {
    if (!state || !status) return;
    const h = status.health;
    const obs = obsConnected(status);
    const otherClient = h && h.obsClients > 0 && !obs;
    const downloading = state.settings.ai === "builtin" && !state.modelReady;
    const rejected = state.signInExpired || h?.status === "unauthorized";

    // Songs
    if (!h) light("light-songlist", "", "Starting");
    else if (rejected) light("light-songlist", "bad", onSE() ? "Paste a new token in Settings" : "Sign in again");
    else if (h.status === "ok" && h.lastQueueFetchAgeMs !== null) {
      light("light-songlist", "ok", h.currentSong ? (onSE() ? "Following your song requests" : "Following your queue") : "Connected");
    }
    else light("light-songlist", "warn", "Reconnecting");

    // Facts
    if (downloading) light("light-ai", state.modelDownload?.error ? "warn" : "", "Getting ready: " + (downloadText(state.modelDownload) || "starting"));
    else if (state.builtinFailed && state.settings.ai === "builtin") light("light-ai", "bad", "Needs attention");
    else if (status.state === "running") light("light-ai", "ok", "Ready");
    else light("light-ai", "", "Starting");

    // Stream
    if (state.paused) light("light-obs", "warn", "Bubbles paused");
    else if (obs) light("light-obs", "ok", "On your stream");
    else if (otherClient) light("light-obs", "warn", "Open in a browser, not OBS");
    else light("light-obs", status.state === "running" ? "warn" : "", "Not in OBS yet");

    // Banner
    const banner = $("#status-banner");
    let kind = "warn", title = "Getting BubbleFacts ready", detail = "This only takes a moment.";
    if (status.state === "failing") { kind = "bad"; title = "Something's wrong"; detail = status.message + ". BubbleFacts keeps trying on its own. If this doesn't clear, use Report a problem under Help."; }
    else if (status.state === "restarting") { title = "Fixing a problem"; detail = status.message + ". This fixes itself in a moment."; }
    else if (rejected) {
      kind = "bad"; title = "Reconnect your song list";
      detail = onSE() ? "StreamElements didn't accept your JWT token. Paste a new one in Settings." : "StreamerSongList needs you to sign in again.";
    }
    else if (status.state === "stopped") {
      title = "Connect your songs";
      detail = onSE() ? "Paste your StreamElements JWT token in Settings to start." : "Sign in with StreamerSongList in Settings to start.";
    }
    else if (state.paused) { title = "Bubbles are paused"; detail = "BubbleFacts is still following your songs. Click Resume bubbles when you're ready."; }
    else if (status.state === "running" && !obs) { title = "Add BubbleFacts to OBS"; detail = "Drag the tile below into OBS's Sources list, or open OBS if it's closed."; }
    else if (status.state === "running" && status.message) { title = "Reconnecting"; detail = status.message + "."; }
    else if (status.state === "running") {
      kind = "ok";
      title = h.currentSong ? "Showing facts" : "Ready for your next song";
      detail = downloading
        ? `Getting BubbleFacts ready (${downloadText(state.modelDownload) || "starting"}). Until then, songs get backup facts.`
        : "BubbleFacts is connected and waiting.";
    }
    banner.className = "banner " + kind;
    $("#status-title").textContent = title;
    $("#status-detail").textContent = detail;
    $("#pause-toggle").textContent = state.paused ? "Resume bubbles" : "Pause bubbles";

    // Only nudge when the example facts actually stood in for a song.
    $("#nudge").hidden = !(h?.facts?.lastOutcome === "noReference" && !state.settings.myFacts.length);

    if (!$("#view-setup").hidden) renderObsCheck();
  }

  async function refreshRecent() {
    const r = await api.recent();
    const song = r.song ? r.song.title + (r.song.artist && !/^unknown$/i.test(r.song.artist) ? " — " + r.song.artist : "") : null;
    $("#now-song").textContent = song || "Nothing playing yet";
    const list = $("#now-facts");
    list.replaceChildren();
    for (const f of r.facts || []) {
      const li = $("#fact-item").content.firstElementChild.cloneNode(true);
      $(".fact-text", li).textContent = f.text;
      $(".wrong", li).addEventListener("click", async () => {
        const result = await api.wrongFact(f.text);
        if (!result || !result.removed) return;
        state.wrong = { song: song || "", text: f.text };
        $("#wrong-note-text").textContent = result.article
          ? `Removed. BubbleFacts won't use the "${result.article}" article for this song again.`
          : "Removed from your stream.";
        $("#wrong-note").hidden = false;
        li.remove();
      });
      list.appendChild(li);
    }
    $("#now-empty").hidden = (r.facts || []).length > 0;
  }

  $("#wrong-report").addEventListener("click", () => state.wrong && api.reportFact(state.wrong.song, state.wrong.text));
  $("#pause-toggle").addEventListener("click", () => api.setPaused(!state.paused));
  $("#test-bubble").addEventListener("click", async () => {
    const r = await api.testBubble();
    setResult($("#test-result"), r && r.overlays ? "✓ Sent to OBS." : "OBS isn't showing BubbleFacts yet. Drag the tile into OBS first.", r && r.overlays ? "ok" : "bad");
    setTimeout(() => setResult($("#test-result"), ""), 5000);
  });
  $("#show-logs").addEventListener("click", () => api.showLogs());
  $("#remove-data").addEventListener("click", () => api.removeData());
  $("#report-problem").addEventListener("click", () => api.reportProblem());

  // --- Notices ---------------------------------------------------------------

  function renderNotices() {
    const box = $("#notices");
    box.replaceChildren();
    const add = (kind, text, buttonText, onClick) => {
      const div = document.createElement("div");
      div.className = "notice " + kind;
      const p = document.createElement("span");
      p.textContent = text;
      div.appendChild(p);
      if (buttonText) {
        const b = document.createElement("button");
        b.className = "primary";
        b.textContent = buttonText;
        b.addEventListener("click", onClick);
        div.appendChild(b);
      }
      box.appendChild(div);
    };
    const signInNotice = (text) => !state.signInAvailable
      ? add("warn", text.replace("Sign in again", "Paste a new token in Settings"), "Open Settings", () => show("settings"))
      : add("warn", text, "Sign in", async (e) => {
      const result = document.createElement("span");
      result.className = "result";
      e.currentTarget.before(result);
      if (await doSignIn(e.currentTarget, result)) renderNotices();
    });
    if (onSE()) {
      if (state.signInExpired) add("warn", "BubbleFacts couldn't read your saved StreamElements token. Paste it again in Settings.", "Open Settings", () => show("settings"));
      else if (state.status?.health?.status === "unauthorized") add("warn", "StreamElements didn't accept your JWT token. Paste a new one in Settings.", "Open Settings", () => show("settings"));
    }
    else if (state.signInExpired) signInNotice("Your StreamerSongList sign-in ended. Sign in again to keep facts coming.");
    else if (state.status?.health?.status === "unauthorized") signInNotice("StreamerSongList didn't accept your sign-in. Sign in again.");
    if (state.settings.ai === "ollama" && state.ollama?.pulling) add("info", `Downloading "${state.ollama.pulling}" into Ollama. This can take a few minutes the first time.`);
    if (state.settings.ai === "ollama" && state.ollama?.error) add("warn", state.ollama.error + ".", "Try again", () => api.downloadModel());
    if (state.settings.ai === "builtin" && state.modelDownload?.error) {
      add("warn", `The AI download paused: ${state.modelDownload.error}.`, "Try again", () => api.downloadModel());
    }
    if (state.update) add("info", `BubbleFacts ${state.update.version} is available.`, "Get it", () => api.openExternal(state.update.url));
    if (state.builtinFailed && state.settings.ai === "builtin") {
      add("warn", "The built-in AI can't run on this computer. Facts are coming from your song list for now. Switching to Groq is free and takes a minute.", "Switch to Groq", () => show("settings"));
    }
    if (state.secretsUnprotected) add("warn", "This computer has no keychain, so your token is saved without encryption.", null);
  }

  // --- Settings ----------------------------------------------------------------

  const form = $("#settings-form");

  function fillSettings() {
    const s = state.settings;
    for (const el of form.elements) {
      if (!el.name || el.type === "password") continue;
      if (el.type === "checkbox") el.checked = !!s[el.name];
      else if (el.type === "radio") el.checked = s[el.name] === el.value;
      else el.value = s[el.name] ?? "";
    }
    for (const box of $$("#s-topics input")) box.checked = s.topics.includes(box.value);
    $("#s-myfacts").value = s.myFacts.join("\n");
    $("#s-myoriginals").value = s.myOriginals.join("\n");
    $("#s-originals-box").hidden = !s.originals;
    const signedIn = s.tokenKind === "oauth" && s.tokenSet;
    $("#s-signed-in").textContent = s.songSource === "streamelements"
      ? (s.seJwtSet ? `✓ Connected to StreamElements${s.seChannel ? " as " + s.seChannel : ""}.` : "Not connected.")
      : signedIn ? `✓ Signed in as ${s.channel}.` : s.tokenSet ? `Connected to ${s.channel} with a token.` : "Not connected.";
    showSettingsSource();
    $("#s-sign-in").textContent = signedIn ? "Sign in again" : "Sign in with StreamerSongList";
    $("#s-sign-in").hidden = !state.signInAvailable;
    for (const p of $$('#settings-form input[type="password"]')) p.value = "";
    $("#s-datadir").textContent = state.dataDir;
    setResult($("#settings-result"), "");
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const changes = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.type === "checkbox") changes[el.name] = el.checked;
      else if (el.type === "radio") { if (el.checked) changes[el.name] = el.value; }
      else if (el.type === "number") changes[el.name] = Number(el.value);
      else changes[el.name] = el.value.trim();
    }
    changes.topics = $$("#s-topics input").filter((b) => b.checked).map((b) => b.value);
    changes.myFacts = lines($("#s-myfacts"));
    changes.myOriginals = lines($("#s-myoriginals"));
    if (changes.token) changes.tokenKind = "streamer";
    if (changes.ai === "groq" && !changes.groqKey && !state.settings.groqKeySet) return setResult($("#settings-result"), "Add your Groq key first.", "bad");
    if (changes.ai === "anthropic" && !changes.anthropicKey && !state.settings.anthropicKeySet) return setResult($("#settings-result"), "Add your Anthropic key first.", "bad");
    const switching = changes.songSource !== state.settings.songSource;
    if (changes.songSource === "streamelements") {
      delete changes.token; // The StreamerSongList fields are hidden; keep what's saved there.
      if (!changes.seJwt && !state.settings.seJwtSet) return setResult($("#settings-result"), "Paste your StreamElements JWT token first.", "bad");
      if (changes.seJwt || switching || changes.seChannel !== state.settings.seChannel) {
        setResult($("#settings-result"), "Checking your StreamElements token...");
        const r = await api.testStreamElements(changes.seChannel, changes.seJwt);
        if (!r.ok) return setResult($("#settings-result"), r.reason, "bad");
        changes.seChannel = r.channel;
      }
    } else {
      delete changes.seJwt;
      if (switching && !changes.token && !state.settings.tokenSet) {
        return setResult($("#settings-result"), "Sign in with StreamerSongList first, or paste a token.", "bad");
      }
    }
    if (changes.token) {
      const r = await api.testConnection(changes.channel, changes.token, "streamer");
      if (!r.ok) return setResult($("#settings-result"), r.reason, "bad");
    }
    const saved = await api.saveSettings(changes);
    if (saved.error) return setResult($("#settings-result"), saved.error, "bad");
    state = saved;
    renderNotices();
    fillSettings();
    setResult($("#settings-result"), "✓ Saved. BubbleFacts restarted with your changes.", "ok");
  });

  form.elements.originals.addEventListener("change", (e) => ($("#s-originals-box").hidden = !e.target.checked));

  function showSettingsSource() {
    const se = form.elements.songSource.value === "streamelements";
    $("#s-se-box").hidden = !se;
    $("#s-ssl-box").hidden = se;
    $("#s-livelearns-row").hidden = se;
    // The saved connection's line only describes the source it belongs to.
    $("#s-signed-in").hidden = se !== onSE();
  }
  for (const r of form.elements.songSource) r.addEventListener("change", showSettingsSource);

  $("#s-sign-in").addEventListener("click", async (e) => {
    if (await doSignIn(e.currentTarget, $("#settings-result"))) {
      renderNotices();
      fillSettings();
      setResult($("#settings-result"), "✓ Signed in.", "ok");
    }
  });

  // --- Start ---------------------------------------------------------------------

  api.on("status", (status) => {
    if (!state) return;
    const rejected = (s) => s?.health?.status === "unauthorized";
    const changed = rejected(state.status) !== rejected(status);
    state.status = status;
    renderStatus(status);
    if (changed) renderNotices();
  });
  api.on("state", (s) => {
    state = s;
    renderNotices();
    renderStatus(s.status);
  });

  (async () => {
    state = await api.getState();
    $("#about-version").textContent = state.version;
    renderNotices();
    renderPaths();
    if (state.settings.setupComplete) {
      show("dashboard");
      renderStatus(state.status);
    } else {
      show("setup");
      channelInput.value = state.settings.channel || "";
      // Without sign-in, the token form is the way in.
      $("#signin-box").hidden = !state.signInAvailable;
      $("#token-box").open = !state.signInAvailable;
      if (!state.signInAvailable) $("#token-summary").textContent = "Connect with a token";
      $("#setup-se-channel").value = state.settings.seChannel || "";
      if (onSE()) $('input[name="setup-source"][value="streamelements"]').checked = true;
      showSourceBox();
      if (connected()) toStreamStep();
      else goStep(1);
    }
  })();
})();
