/* BubbleFacts desktop window. Talks to the app only through window.bubbleFacts. */
(function () {
  "use strict";

  const api = window.bubbleFacts;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  let state = null;
  /** What the On stream now list last showed, so it redraws only on change. */
  let lastRecent = "";
  /** The song the "Add facts" editor was opened on. */
  let songFactsTarget = null;
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
    if ("copyCredit" in t.dataset) {
      api.copy("Song facts from Wikipedia (CC BY-SA 4.0), Wikidata and MusicBrainz, shown with BubbleFacts.");
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
    next.textContent = "Start using BubbleFacts";
    next.focus();
  }

  $("#show-test-again").addEventListener("click", () => api.testBubble());
  // Setup ends here. Originals and live learns are optional, and also in Settings.
  $("#stream-next").addEventListener("click", () => finishSetup({}, $("#stream-result")));
  $("#stream-customize").addEventListener("click", toMusicStep);

  // --- Setup: step 3, your music (optional) --------------------------------------------

  function toMusicStep() {
    $("#setup-originals").checked = state.settings.originals;
    $("#setup-livelearns").checked = state.settings.liveLearns;
    // Live learns are a StreamerSongList idea: StreamElements requests are always videos.
    $("#setup-livelearns-row").hidden = onSE();
    $("#setup-myoriginals").value = state.settings.myOriginals.join("\n");
    $("#setup-originals-box").hidden = !state.settings.originals;
    goStep(3);
  }

  $("#setup-originals").addEventListener("change", (e) => ($("#setup-originals-box").hidden = !e.target.checked));

  const lines = (el) => el.value.split("\n").map((l) => l.trim()).filter(Boolean);

  async function finishSetup(changes, result = $("#facts-result")) {
    const saved = await api.saveSettings({ ...changes, setupComplete: true });
    if (saved.error) return setResult(result, saved.error, "bad");
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
      title = !h.currentSong ? "Ready for your next song" : nowShowing > 0 ? "Showing facts" : nowReady ? "Following your songs" : "Finding facts";
      detail = downloading
        ? `Getting BubbleFacts ready (${downloadText(state.modelDownload) || "starting"}). Until then, songs get facts from music databases and your custom facts.`
        : "BubbleFacts is connected and waiting.";
    }
    banner.className = "banner " + kind;
    $("#status-title").textContent = title;
    $("#status-detail").textContent = detail;
    $("#pause-toggle").textContent = state.paused ? "Resume bubbles" : "Pause bubbles";

    // Only nudge when the example facts actually stood in for a song. With no
    // examples checked, showing nothing is the streamer's choice.
    $("#nudge").hidden = !(h?.facts?.lastOutcome === "noReference" && !state.settings.myFacts.length && state.settings.topics.length);

    if (!$("#view-setup").hidden) renderObsCheck();
  }

  /** Why no facts are listed: no song yet, still looking, nothing reliable, or a failure. Silence on stream is normal. */
  function emptyText(r) {
    if (!r.song) return "Facts appear here a few seconds after a song starts.";
    if (!r.ready) return "Looking for facts about this song…";
    if (r.song.liveLearn || r.outcome === "liveLearn") return "Live learn: the banner shows, with no facts.";
    if (r.outcome === "generationFailed") return "BubbleFacts couldn't write facts for this song. It tries again the next time it plays.";
    return "No reliable facts for this song, so no bubbles. That's normal: BubbleFacts stays quiet rather than guess. Everything is working.";
  }

  let nowShowing = 0, nowReady = false;

  async function refreshRecent() {
    const r = await api.recent();
    if (nowShowing !== (r.facts || []).length || nowReady !== !!r.ready) {
      nowShowing = (r.facts || []).length;
      nowReady = !!r.ready;
      if (state) renderStatus(state.status);
    }
    const song = r.song ? r.song.title + (r.song.artist && !/^unknown$/i.test(r.song.artist) ? " — " + r.song.artist : "") : null;
    $("#now-title").textContent = state && state.paused ? "Paused: these show when you resume" : "On stream now";
    // Redraw only when something changed, so a list being clicked doesn't move under the pointer.
    const drawn = JSON.stringify([song, r.ready, r.outcome, (r.facts || []).map((f) => f.text)]);
    if (drawn === lastRecent) return;
    lastRecent = drawn;
    $("#now-song").textContent = song || "Nothing playing yet";
    const list = $("#now-facts");
    list.replaceChildren();
    for (const f of r.facts || []) {
      const li = $("#fact-item").content.firstElementChild.cloneNode(true);
      $(".fact-text", li).textContent = f.text;
      $(".fact-source", li).textContent = f.source ? `(${f.source})` : "";
      // Your own facts can be changed where they show: one song's in the editor, the rest in Settings.
      const edit = $(".edit-fact", li);
      if (f.source === "Your facts for this song" || f.source === "Your custom facts") {
        edit.hidden = false;
        edit.setAttribute("aria-label", `Edit: ${f.text}`);
        edit.addEventListener("click", async () => {
          if (f.source === "Your custom facts") {
            show("settings");
            $("#s-myfacts").focus();
            return;
          }
          const got = (await api.getSongFacts()) || {};
          openSongFacts(got.song, got.entry);
        });
      }
      const wrong = $(".wrong", li);
      wrong.setAttribute("aria-label", `Mark wrong: ${f.text}`);
      wrong.addEventListener("click", async () => {
        const result = await api.wrongFact(f.text);
        if (!result || !result.removed) {
          showWrongNote("That song already ended, so there was nothing to remove.", null);
          return;
        }
        // The song itself goes along, so Undo can't land on whatever plays next.
        state.wrong = { song: song || "", text: f.text, article: result.article, songId: r.song };
        showWrongNote(
          result.structured
            ? "Removed. BubbleFacts won't use Wikidata or MusicBrainz facts for this song again."
            : result.article
              ? `Removed. BubbleFacts won't use the "${result.article}" Wikipedia article for this song again.`
              : "Removed from your stream.",
          result.article
        );
        li.remove();
      });
      list.appendChild(li);
    }
    $("#now-empty").hidden = (r.facts || []).length > 0;
    $("#now-empty").textContent = emptyText(r);
    $("#song-facts-open").hidden = !$("#song-facts-form").hidden;
    const hasOwn = (r.facts || []).some((f) => f.source === "Your facts for this song");
    $("#song-facts-open").textContent = !r.song ? "Add facts for a song" : hasOwn ? "Edit your facts for this song" : "Add facts for this song";
  }

  function showWrongNote(text, undoable) {
    $("#wrong-note-text").textContent = text;
    $("#wrong-undo").hidden = !undoable;
    $("#wrong-report").hidden = !state.wrong;
    $("#wrong-note").hidden = false;
  }

  $("#song-facts-open").addEventListener("click", async () => {
    const r = (await api.getSongFacts()) || {};
    openSongFacts(r.song, r.entry);
  });
  /** Open the editor on a song: the one that's on, one from the saved list, or none (the streamer names it). */
  function openSongFacts(song, entry) {
    // The edit belongs to this song, even if another one starts before you save.
    // With nothing playing, the streamer names the song: getting ready before a show.
    const e = entry || {};
    otherSong(!song);
    songFactsTarget = song || null;
    if (song) $("#song-facts-title").textContent = `"${song.title}"`;
    $("#sf-writers").value = (e.songwriters || []).join(", ");
    $("#sf-link").value = e.link || "";
    setFactBoxes(e.facts || []);
    $("#song-facts-result").textContent = "";
    $("#song-facts-form").hidden = false;
    $("#song-facts-open").hidden = true;
    $("#sf-facts textarea:last-child").focus();
    $("#song-facts-form").scrollIntoView({ block: "nearest" });
  }
  /** One box per fact, so a long fact can wrap or take a line break and stay one fact. */
  function addFactBox(text = "") {
    const box = document.createElement("textarea");
    box.rows = 2;
    box.spellcheck = true;
    box.value = text;
    box.placeholder = "Jane wrote this on stream in one night in 2024.";
    box.setAttribute("aria-label", `Fact ${$$("#sf-facts textarea").length + 1}`);
    $("#sf-facts").appendChild(box);
    return box;
  }
  function setFactBoxes(facts) {
    $("#sf-facts").replaceChildren();
    for (const f of facts) addFactBox(f);
    addFactBox();
  }
  const factBoxes = () => $$("#sf-facts textarea").map((b) => b.value.replace(/\s+/g, " ").trim()).filter(Boolean);
  $("#sf-add").addEventListener("click", () => addFactBox().focus());
  /** Switch the editor between the song that's on and one the streamer names. */
  function otherSong(on) {
    $("#sf-identity").hidden = !on;
    $("#sf-other").hidden = on;
    $("#sf-save").textContent = on ? "Save" : "Save and show";
    if (on) {
      songFactsTarget = null;
      $("#song-facts-title").textContent = "a song";
      for (const id of ["#sf-title", "#sf-artist", "#sf-writers", "#sf-link"]) $(id).value = "";
      setFactBoxes([]);
    }
  }
  $("#sf-other").addEventListener("click", () => {
    otherSong(true);
    $("#sf-title").focus();
  });
  $("#song-facts-cancel").addEventListener("click", () => {
    $("#song-facts-form").hidden = true;
    lastRecent = "";
  });
  $("#song-facts-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const split = (s, re) => s.split(re).map((x) => x.trim()).filter(Boolean);
    if (!songFactsTarget) {
      const title = $("#sf-title").value.trim();
      if (!title) {
        $("#song-facts-result").textContent = "Type the song's title first.";
        return;
      }
      songFactsTarget = { title, artist: $("#sf-artist").value.trim() };
    }
    const result = await api.saveSongFacts({
      song: songFactsTarget,
      songwriters: split($("#sf-writers").value, /,/),
      link: $("#sf-link").value.trim(),
      facts: factBoxes(),
    });
    if (result && result.saved) {
      $("#song-facts-form").hidden = true;
      lastRecent = "";
      showWrongNote(
        result.shown
          ? "Saved. Your facts show now and every time this song plays."
          : `Saved for "${songFactsTarget.title}". They'll show the next time it plays.`,
        null
      );
    } else {
      $("#song-facts-result").textContent = "Couldn't save. Try again in a moment.";
    }
  });
  $("#wrong-report").addEventListener("click", () => state.wrong && api.reportFact(state.wrong.song, state.wrong.text));
  $("#wrong-undo").addEventListener("click", async () => {
    if (!state.wrong || !state.wrong.article) return;
    const result = await api.unwrongFact(state.wrong.article, state.wrong.songId);
    showWrongNote(
      result && result.restored
        ? `Undone. BubbleFacts may use that source for "${state.wrong.song}" again; the fact stays off for now.`
        : "Couldn't undo that. Try again in a moment.",
      result && result.restored ? null : state.wrong.article
    );
  });
  $("#pause-toggle").addEventListener("click", () => api.setPaused(!state.paused));
  $("#test-bubble").addEventListener("click", async () => {
    const r = await api.testBubble();
    setResult($("#test-result"), r && r.overlays ? "✓ Sent to OBS." : "OBS isn't showing BubbleFacts yet. Drag the tile into OBS first.", r && r.overlays ? "ok" : "bad");
    setTimeout(() => setResult($("#test-result"), ""), 5000);
  });
  $("#show-logs").addEventListener("click", () => api.showLogs());
  $("#remove-data").addEventListener("click", () => api.removeData());
  $("#report-problem").addEventListener("click", () => api.reportProblem());
  $("#report-beta").addEventListener("click", () => api.reportBeta());

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
    if (state.update) {
      const v = state.update.version;
      const u = state.updating || { stage: "idle" };
      const getIt = () => api.openExternal(state.update.url);
      if (!state.update.download) add("info", `BubbleFacts ${v} is available.`, "Get it", getIt);
      else if (u.stage === "downloading") add("info", `Downloading BubbleFacts ${v}: ${Math.floor((u.progress || 0) * 100)}%. You can keep streaming.`);
      else if (u.stage === "ready") add("info", `BubbleFacts ${v} is ready. Installing closes BubbleFacts for a few seconds and reopens it, so pick a moment between songs.`, "Install now", () => api.installUpdate());
      else if (u.stage === "failed") add("warn", `The update didn't work: ${u.error}. You can download it from the website instead.`, "Get it", getIt);
      else add("info", `BubbleFacts ${v} is available.`, "Update now", () => api.downloadUpdate());
    }
    if (state.builtinFailed && state.settings.ai === "builtin") {
      add("warn", "The built-in AI can't run on this computer. Facts are coming from your song list for now. Switching to Groq is free and takes a minute.", "Switch to Groq", () => {
        show("settings");
        $("#s-advanced").open = true;
      });
    }
    if (state.secretsUnprotected) add("warn", "This computer has no keychain (on Linux: GNOME Keyring or KWallet), so your token is saved without real encryption. Anyone who can open your files could read it.", null);
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
    // Someone already using an online AI or the example packs finds them open.
    $("#s-advanced").open = s.ai !== "builtin" || s.topics.length > 0;
    renderSongFactsList();
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

  /** Every song with its own facts, to edit or remove without waiting for it to play. */
  async function renderSongFactsList() {
    const saved = (await api.listSongFacts()) || [];
    const list = $("#s-songfacts");
    list.replaceChildren();
    $("#s-songfacts-empty").hidden = saved.length > 0;
    for (const entry of saved) {
      const song = { title: entry.title, artist: entry.artist, ...(entry.songId ? { songId: entry.songId } : {}), ...(entry.videoId ? { videoId: entry.videoId } : {}) };
      const li = document.createElement("li");
      const name = document.createElement("span");
      const count = (entry.facts || []).length;
      name.textContent = `${entry.title}${entry.artist ? " — " + entry.artist : ""} (${count} ${count === 1 ? "fact" : "facts"})`;
      const button = (text, onClick) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "link";
        b.textContent = text;
        b.addEventListener("click", onClick);
        return b;
      };
      li.append(
        name, " ",
        button("Edit", () => {
          show("dashboard");
          openSongFacts(song, entry);
        }),
        " ",
        button("Remove", async () => {
          const r = await api.saveSongFacts({ song, songwriters: [], link: "", facts: [] });
          if (r && r.saved) renderSongFactsList();
          else setResult($("#settings-result"), "Couldn't remove it. Connect your songs first, then try again.", "bad");
        })
      );
      list.appendChild(li);
    }
  }

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
    $("#report-beta").hidden = !/-beta/.test(state.version);
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
