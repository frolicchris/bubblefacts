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
      // Which step is current goes to screen readers too, not only as color.
      if (k === n) li.setAttribute("aria-current", "step");
      else li.removeAttribute("aria-current");
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
    if (t.dataset.view && !t.classList.contains("navlink")) show(t.dataset.view);
    if (t.id === "open-notices") api.openNotices();
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
      : state.settings.channel ? `✓ Connected to ${state.settings.channel}.` : "✓ Connected.";
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
    renderSetupOriginals();
    $("#setup-originals-box").hidden = !state.settings.originals;
    goStep(3);
  }

  $("#setup-originals").addEventListener("change", (e) => ($("#setup-originals-box").hidden = !e.target.checked));

  const lines = (el) => el.value.split("\n").map((l) => l.trim()).filter(Boolean);

  // Custom facts have the same limit as a song's own (CUSTOM_FACT_LENGTH in settings.ts).
  const MAX_CUSTOM_FACT = 300;
  /** A "[Song of Storms]" tag never goes on stream, so only the bubble's text counts. */
  const bubbleLength = (line) => line.trim().replace(/^\[[^\]]+\]\s*/, "").length;
  /**
   * Why a custom facts box can't be saved as typed, by the line the musician
   * sees, or "". `select` picks out that line, so it's easy to find on Save.
   */
  function customFactsProblem(box, name, select = false) {
    const rows = box.value.split("\n");
    const long = rows.findIndex((l) => bubbleLength(l) > MAX_CUSTOM_FACT);
    if (long < 0) return "";
    if (select) {
      const start = rows.slice(0, long).reduce((n, l) => n + l.length + 1, 0);
      box.focus();
      box.setSelectionRange(start, start + rows[long].length);
    }
    return `${name}: line ${long + 1} is ${bubbleLength(rows[long])} characters. Shorten it to ${MAX_CUSTOM_FACT} or fewer to save.`;
  }
  /** Shown under the box as soon as a line is too long, as the song facts editor does. */
  function watchCustomFacts(box, name) {
    const note = document.createElement("span");
    note.id = `${box.id}-count`;
    note.className = "hint fact-count over";
    note.setAttribute("aria-live", "polite");
    note.hidden = true;
    box.setAttribute("aria-describedby", note.id);
    box.after(note);
    const render = () => {
      note.textContent = customFactsProblem(box, name);
      note.hidden = !note.textContent;
    };
    box.addEventListener("input", render);
    return render;
  }
  const renderSetupOriginals = watchCustomFacts($("#setup-myoriginals"), "About your own compositions");

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
    const problem = originals && customFactsProblem($("#setup-myoriginals"), "About your own compositions", true);
    if (problem) return setResult($("#facts-result"), problem, "bad");
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

  /** OBS gets a few seconds to reconnect after the fact server starts, before being asked to add BubbleFacts. */
  const OBS_GRACE_MS = 15_000;
  let runningSince = 0;
  function renderStatus(status) {
    if (!state || !status) return;
    if (status.state !== "running") runningSince = 0;
    else runningSince ||= Date.now();
    const obsGrace = runningSince > 0 && Date.now() - runningSince < OBS_GRACE_MS;
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
    else if (obsGrace) light("light-obs", "", "Connecting to OBS");
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
    else if (status.state === "running" && !obs && obsGrace) { title = "Connecting to OBS"; detail = "If BubbleFacts is already in OBS, this takes a few seconds."; }
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

    if (!$("#view-setup").hidden) renderObsCheck();
  }

  /** Why no facts are listed: no song yet, still looking, nothing reliable, or a failure. Silence on stream is normal. */
  function emptyText(r) {
    if (!r.song) return "Facts appear here a few seconds after a song starts.";
    if (!r.ready) return "Looking for facts about this song…";
    if (r.song.liveLearn || r.outcome === "liveLearn") return "Live learn: the banner shows. No source knew this request, so no facts.";
    if (r.outcome === "generationFailed") return "BubbleFacts couldn't write facts for this song. It tries again the next time it plays.";
    return "No reliable facts for this song, so no bubbles. That's normal: BubbleFacts stays quiet rather than guess. Everything is working.";
  }

  let nowShowing = 0, nowReady = false;

  /** One fact on the dashboard: its text, where it came from, Edit for your own, and Wrong. */
  function factItem(f, songObj, label, current = true) {
    const li = $("#fact-item").content.firstElementChild.cloneNode(true);
    $(".fact-text", li).textContent = f.text;
    $(".fact-source", li).textContent = f.source ? `(${f.source})` : "";
    // A fact from an article shows its source: click to see the sentence it was written from, and open the article.
    if (f.url) {
      $(".fact-source", li).hidden = true;
      const link = $(".fact-source-link", li);
      const evidence = $(".fact-evidence", li);
      link.hidden = false;
      link.textContent = f.source;
      link.title = "Show where this came from";
      link.setAttribute("aria-expanded", "false");
      link.addEventListener("click", () => {
        if (!evidence.hidden) {
          evidence.hidden = true;
          link.setAttribute("aria-expanded", "false");
          return;
        }
        evidence.replaceChildren(
          f.evidence ? `The article says: “${f.evidence}” ` : "BubbleFacts couldn't point to one sentence for this. Check the article. ",
          Object.assign(document.createElement("button"), { className: "link", textContent: "Open the article", onclick: () => api.openExternal(f.url) })
        );
        evidence.hidden = false;
        link.setAttribute("aria-expanded", "true");
      });
    }
    // Your own facts can be changed where they show: one song's in the editor, the rest in Settings.
    const edit = $(".edit-fact", li);
    // Edit is for the song on now; an earlier song's facts are edited from Settings.
    if (current && (f.source === "Your facts for this song" || f.source === "Your custom facts")) {
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
      // The song goes along, and which list this is: only On stream now takes the fact off the
      // stream; Earlier songs marks it for next time (hands are busy while playing), even when
      // that song is playing again.
      const result = await api.wrongFact(f.text, songObj, current);
      if (!result || !result.removed) {
        showWrongNote("BubbleFacts no longer has that fact, so there was nothing to mark.", null);
        return;
      }
      // The song itself goes along, so Undo can't land on whatever plays next.
      state.wrong = { song: label || "", text: f.text, article: result.article, songId: songObj };
      wrongNote(result, f.text, songObj, result.live ? "Removed." : "Marked wrong.");
      li.remove();
    });
    return li;
  }

  /** Songs that already played, with Wrong on each fact: for once your hands are free. */
  function renderEarlier(earlier) {
    $("#earlier").hidden = !earlier.length;
    const box = $("#earlier-list");
    box.replaceChildren();
    for (const e of earlier) {
      const title = e.song.title + (e.song.artist && !/^unknown$/i.test(e.song.artist) ? " — " + e.song.artist : "");
      const heading = Object.assign(document.createElement("p"), { className: "now-song", textContent: title });
      const ul = Object.assign(document.createElement("ul"), { className: "facts" });
      for (const f of e.facts) ul.appendChild(factItem(f, e.song, title, false));
      box.append(heading, ul);
    }
  }

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
    const drawn = JSON.stringify([song, r.ready, r.outcome, (r.facts || []).map((f) => f.text), (r.earlier || []).map((e) => [e.song.title, e.facts.length])]);
    if (drawn === lastRecent) return;
    lastRecent = drawn;
    $("#now-song").textContent = song || "Nothing playing yet";
    const list = $("#now-facts");
    list.replaceChildren();
    for (const f of r.facts || []) list.appendChild(factItem(f, r.song, song));
    renderEarlier(r.earlier || []);
    $("#now-empty").hidden = (r.facts || []).length > 0;
    $("#now-empty").textContent = emptyText(r);
    $("#song-facts-open").hidden = !$("#song-facts-form").hidden;
    // With nothing playing, the first button already asks which song.
    $("#song-facts-other").hidden = !$("#song-facts-form").hidden || !r.song;
    const hasOwn = (r.facts || []).some((f) => f.source === "Your facts for this song");
    $("#song-facts-open").textContent = !r.song ? "Add facts for a song" : hasOwn ? "Edit your facts for this song" : "Add facts for this song";
  }

  /** The Edit button on the note, for the streamer's own fact. */
  let wrongEdit = null;
  function showWrongNote(text, undoable, edit = null) {
    $("#wrong-note-text").textContent = text;
    $("#wrong-undo").hidden = !undoable;
    $("#wrong-report").hidden = !state.wrong;
    wrongEdit = edit;
    $("#wrong-edit").hidden = !edit;
    $("#wrong-note").hidden = false;
  }
  $("#wrong-edit").addEventListener("click", () => wrongEdit && wrongEdit());

  /**
   * What Wrong did, in words. A fact from a lookup: the source it won't use
   * again. The streamer's own fact: nothing can be blocked, so it shows again
   * until they change it, and the note opens it for editing.
   */
  function wrongNote(result, text, song, start) {
    if (result.own === "song") {
      // Their own fact isn't a wrong source to report, and there's nothing to undo.
      state.wrong = null;
      showWrongNote(`${start} It's one of your own facts for this song, so it shows again the next time the song plays until you change it.`, null, async () => {
        const got = (await api.getSongFacts(song)) || {};
        show("dashboard");
        openSongFacts(got.song || song, got.entry);
      });
      return;
    }
    if (result.own === "custom") {
      state.wrong = null;
      showWrongNote(`${start} It's one of your own custom facts, so it can show again until you change it in Settings.`, null, () => editCustomFact(text));
      return;
    }
    const what = result.structured
      ? "BubbleFacts won't use Wikidata or MusicBrainz facts for this song again."
      : result.article
        ? `BubbleFacts won't use the "${result.article}" Wikipedia article for this song again.`
        : "";
    showWrongNote(`${start} ${what}`.trim(), result.article);
  }

  /** Settings, at the custom fact: in Your own facts, or About your own compositions. */
  function editCustomFact(text) {
    show("settings");
    const box = [$("#s-myfacts"), $("#s-myoriginals")].find((b) => !b.closest("[hidden]") && b.value.includes(text)) || $("#s-myfacts");
    box.focus();
    const at = box.value.indexOf(text);
    if (at >= 0) box.setSelectionRange(at, at + text.length);
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
    renderTwitchFill();
    $("#song-facts-result").textContent = "";
    $("#song-facts-form").hidden = false;
    $("#song-facts-open").hidden = true;
    $("#song-facts-other").hidden = true;
    $$("#sf-facts textarea").at(-1).focus();
    $("#song-facts-form").scrollIntoView({ block: "nearest" });
  }
  // The server's limits (SONG_FACT_LIMITS in song-facts.ts): shown here, so a save is never cut short.
  const MAX_FACTS = 20;
  const MAX_FACT_LENGTH = 300;
  /** A fact as it's saved: a line break inside it is a space. */
  const cleanFact = (text) => text.replace(/\s+/g, " ").trim();
  /** Characters used, shown once a fact nears the limit. */
  function renderFactLength(box) {
    const n = cleanFact(box.value).length;
    const count = box.nextElementSibling;
    count.hidden = n < MAX_FACT_LENGTH - 60;
    count.textContent = n > MAX_FACT_LENGTH
      ? `${n} of ${MAX_FACT_LENGTH} characters. Shorten it by ${n - MAX_FACT_LENGTH} to save.`
      : `${n} of ${MAX_FACT_LENGTH} characters`;
    count.className = "hint fact-count" + (n > MAX_FACT_LENGTH ? " over" : "");
  }
  /** Add another fact stops at the most a song can have, and says so. */
  function renderFactRoom() {
    const full = $$("#sf-facts textarea").length >= MAX_FACTS;
    $("#sf-add").hidden = full;
    $("#sf-facts-full").hidden = !full;
  }
  let factBoxIds = 0;
  /** One box per fact, so a long fact can wrap or take a line break and stay one fact. */
  function addFactBox(text = "") {
    const n = $$("#sf-facts textarea").length + 1;
    const row = document.createElement("div");
    row.className = "fact-box";
    const box = document.createElement("textarea");
    box.rows = 2;
    box.spellcheck = true;
    box.value = text;
    box.placeholder = "Jane wrote this on stream in one night in 2024.";
    box.setAttribute("aria-label", `Fact ${n}`);
    const count = document.createElement("span");
    count.id = `sf-count-${++factBoxIds}`;
    count.setAttribute("aria-live", "polite");
    box.setAttribute("aria-describedby", count.id);
    box.addEventListener("input", () => renderFactLength(box));
    row.append(box, count);
    $("#sf-facts").appendChild(row);
    renderFactLength(box);
    renderFactRoom();
    return box;
  }
  function setFactBoxes(facts) {
    $("#sf-facts").replaceChildren();
    for (const f of facts) addFactBox(f);
    if (facts.length < MAX_FACTS) addFactBox();
    renderFactRoom();
  }
  const factBoxes = () => $$("#sf-facts textarea").map((b) => cleanFact(b.value)).filter(Boolean);
  /** Why the facts can't be saved as typed, numbered as the boxes are, or "". */
  function factsProblem() {
    const facts = factBoxes();
    if (facts.length > MAX_FACTS) return `A song can have up to ${MAX_FACTS} facts. Remove ${facts.length - MAX_FACTS} to save.`;
    const boxes = $$("#sf-facts textarea");
    const long = boxes.findIndex((b) => cleanFact(b.value).length > MAX_FACT_LENGTH);
    if (long < 0) return "";
    boxes[long].focus();
    return `Fact ${long + 1} is ${cleanFact(boxes[long].value).length} characters. Shorten it to ${MAX_FACT_LENGTH} or fewer to save.`;
  }
  $("#sf-add").addEventListener("click", () => addFactBox().focus());
  /** Fill from their Twitch About: offered when the artist or link names a Twitch channel. */
  const sfArtist = () => (songFactsTarget ? songFactsTarget.artist || "" : $("#sf-artist").value);
  // The app decides what counts as a Twitch channel (twitch.ts), so the button never offers what it would refuse.
  // Asked once typing pauses, and only the newest answer counts.
  let twitchFillAsk = 0;
  let twitchFillTimer;
  async function renderTwitchFill() {
    const ask = ++twitchFillAsk;
    const login = state.twitch && state.twitch.available ? await api.twitchLogin(sfArtist(), $("#sf-link").value) : "";
    if (ask !== twitchFillAsk) return;
    $("#sf-twitch-row").hidden = !login;
    $("#sf-twitch-result").textContent = "";
  }
  for (const id of ["#sf-link", "#sf-artist"]) {
    $(id).addEventListener("input", () => {
      clearTimeout(twitchFillTimer);
      twitchFillTimer = setTimeout(renderTwitchFill, 300);
    });
  }
  $("#sf-twitch").addEventListener("click", async () => {
    if (!state.settings.twitchConnected) {
      setResult($("#sf-twitch-result"), "Connect Twitch in Settings, under You and your music, first.", "bad");
      return;
    }
    const button = $("#sf-twitch");
    button.disabled = true;
    setResult($("#sf-twitch-result"), "Asking Twitch…", "");
    const r = await api.twitchAbout(sfArtist(), $("#sf-link").value).finally(() => (button.disabled = false));
    if (r.ok) {
      if (!$("#sf-link").value.trim()) $("#sf-link").value = r.link;
      // A second click adds nothing twice.
      const have = new Set(factBoxes());
      const blank = $$("#sf-facts textarea").find((b) => !b.value.trim());
      for (const f of r.facts.filter((x) => !have.has(x))) {
        const box = addFactBox(f);
        if (blank) $("#sf-facts").insertBefore(box.parentElement, blank.parentElement);
      }
    }
    setResult($("#sf-twitch-result"), r.message, r.ok ? "ok" : "bad");
  });
  // --- Song search: pick the song from the list instead of typing it exactly ---

  /** The list song picked; its ID goes with the save while both fields still say what it says. */
  let pickedSong = null;
  let songMatches = [];
  let activeMatch = -1;
  // Asked once typing pauses, and only the newest answer counts (like renderTwitchFill).
  let songSearchAsk = 0;
  let songSearchTimer;
  const titleInput = $("#sf-title");
  const songsList = $("#sf-songs");
  const songsStatus = $("#sf-songs-status");

  function closeSongList() {
    songSearchAsk++;
    clearTimeout(songSearchTimer);
    songMatches = [];
    activeMatch = -1;
    songsList.hidden = true;
    songsList.replaceChildren();
    titleInput.setAttribute("aria-expanded", "false");
    titleInput.removeAttribute("aria-activedescendant");
  }
  function showSongList(songs) {
    songMatches = songs;
    activeMatch = -1;
    songsList.replaceChildren(...songs.map((song, i) => {
      const li = document.createElement("li");
      li.id = `sf-song-${i}`;
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", "false");
      const artist = document.createElement("span");
      artist.className = "combo-artist";
      artist.textContent = song.artist ? ` ${song.artist}` : "";
      li.append(song.title, artist);
      // Keep focus in Song title, so the list doesn't close before the click lands.
      li.addEventListener("mousedown", (e) => e.preventDefault());
      li.addEventListener("click", () => pickSong(song));
      return li;
    }));
    songsList.hidden = !songs.length;
    titleInput.setAttribute("aria-expanded", String(songs.length > 0));
    titleInput.removeAttribute("aria-activedescendant");
  }
  function setActiveMatch(i) {
    activeMatch = i;
    $$("li", songsList).forEach((li, k) => li.setAttribute("aria-selected", String(k === i)));
    const li = songsList.children[i];
    if (!li) return titleInput.removeAttribute("aria-activedescendant");
    titleInput.setAttribute("aria-activedescendant", li.id);
    li.scrollIntoView({ block: "nearest" });
  }
  async function searchSongList() {
    const ask = ++songSearchAsk;
    const query = titleInput.value.trim();
    const r = query ? await api.searchSongs(query) : null;
    if (ask !== songSearchAsk || document.activeElement !== titleInput) return;
    const songs = (r && r.available && r.songs) || [];
    showSongList(songs);
    songsStatus.textContent = !r || !r.available
      ? ""
      : songs.length
        ? `${songs.length} ${songs.length === 1 ? "song" : "songs"} on your list. Use the up and down arrows to pick one.`
        : "No song on your list matches. You can still type it as it appears on the request.";
  }
  async function pickSong(song) {
    pickedSong = song;
    titleInput.value = song.title;
    $("#sf-artist").value = song.artist;
    closeSongList();
    songsStatus.textContent = `Picked ${song.title}${song.artist ? " by " + song.artist : ""}.`;
    renderTwitchFill();
    // Facts already saved for it open with it, so a save doesn't replace them unseen.
    if (factBoxes().length || $("#sf-writers").value.trim() || $("#sf-link").value.trim()) return;
    // Matched the way a save matches: by its ID, or by title and artist for facts saved before it was picked from the list.
    const saved = ((await api.getSongFacts({ title: song.title, artist: song.artist, songId: song.id })) || {}).entry;
    if (!saved || pickedSong !== song) return;
    $("#sf-writers").value = (saved.songwriters || []).join(", ");
    $("#sf-link").value = saved.link || "";
    setFactBoxes(saved.facts || []);
    renderTwitchFill();
  }
  titleInput.addEventListener("input", () => {
    clearTimeout(songSearchTimer);
    songSearchTimer = setTimeout(searchSongList, 200);
  });
  titleInput.addEventListener("keydown", (e) => {
    const open = songMatches.length > 0;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return void searchSongList();
      const n = songMatches.length;
      setActiveMatch(e.key === "ArrowDown" ? (activeMatch + 1) % n : activeMatch <= 0 ? n - 1 : activeMatch - 1);
    } else if (e.key === "Enter" && open && activeMatch >= 0) {
      // Picks the song instead of saving the form.
      e.preventDefault();
      pickSong(songMatches[activeMatch]);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      closeSongList();
    }
  });
  titleInput.addEventListener("blur", closeSongList);

  /** Switch the editor between the song that's on and one the streamer names. */
  function otherSong(on) {
    $("#sf-identity").hidden = !on;
    $("#sf-save").textContent = on ? "Save" : "Save and show";
    if (on) {
      songFactsTarget = null;
      pickedSong = null;
      closeSongList();
      $("#song-facts-title").textContent = "a song";
      // StreamElements has no song list to pick from.
      $("#sf-title-hint").textContent = onSE() ? "as it appears on the request" : "type a few letters to pick it from your song list";
      for (const id of ["#sf-title", "#sf-artist", "#sf-writers", "#sf-link"]) $(id).value = "";
      setFactBoxes([]);
      $("#sf-twitch-row").hidden = true;
    }
  }
  $("#song-facts-other").addEventListener("click", () => {
    openSongFacts(null);
    $("#sf-title").focus();
  });
  $("#song-facts-cancel").addEventListener("click", () => {
    $("#song-facts-form").hidden = true;
    lastRecent = "";
  });
  $("#song-facts-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const split = (s, re) => s.split(re).map((x) => x.trim()).filter(Boolean);
    const problem = factsProblem();
    if (problem) {
      $("#song-facts-result").textContent = problem;
      return;
    }
    if (!songFactsTarget) {
      const title = $("#sf-title").value.trim();
      if (!title) {
        $("#song-facts-result").textContent = "Type the song's title first.";
        return;
      }
      const artist = $("#sf-artist").value.trim();
      // A song picked from the list (and not changed since) is matched by its ID.
      const picked = pickedSong && pickedSong.title === title && pickedSong.artist === artist;
      songFactsTarget = { title, artist, ...(picked ? { songId: pickedSong.id } : {}) };
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
          ? "Saved. Your facts show in a moment, and every time this song plays."
          : `Saved for "${songFactsTarget.title}". They'll show the next time it plays.`,
        null
      );
    } else {
      $("#song-facts-result").textContent = (result && result.error) || "Couldn't save. Try again in a moment.";
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
  $("#backup-show").addEventListener("click", () => api.showBackups());
  for (const [id, call] of [["backup-save", () => api.saveBackup()], ["backup-restore", () => api.restoreBackup()]]) {
    $("#" + id).addEventListener("click", async () => {
      const r = await call();
      if (r.message) setResult($("#backup-result"), r.message, r.ok ? "ok" : "bad");
      // A restore changed the settings: show them.
      if (r.ok && id === "backup-restore") { state = await api.getState(); settingsDraft.clear(); fillSettings(); setResult($("#backup-result"), r.message, "ok"); }
    });
  }
  $("#report-problem").addEventListener("click", () => api.reportProblem());
  $("#report-beta").addEventListener("click", () => api.reportBeta());

  // --- Notices ---------------------------------------------------------------

  /** What the notices last said. The box is a live region, so it's redrawn only when that changes. */
  let lastNotices = "";
  function renderNotices() {
    const notices = [];
    const add = (kind, text, buttonText, onClick) => notices.push({ kind, text, buttonText, onClick });
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
      else if (u.stage === "ready") add("info", `BubbleFacts ${v} is ready. Installing closes BubbleFacts for a few seconds and reopens it, so pick a moment between songs.${state.platform === "darwin" ? " When your Mac asks for permission afterward, click Always Allow." : ""}`, "Install now", () => api.installUpdate());
      else if (u.stage === "failed") add("warn", `The update didn't work: ${u.error}. You can download it from the website instead.`, "Get it", getIt);
      else add("info", `BubbleFacts ${v} is available.`, "Update now", () => api.downloadUpdate());
    }
    if (state.builtinFailed && state.settings.ai === "builtin") {
      add("warn", "The built-in AI can't run on this computer. For now, songs get facts from music databases and your own facts. Switching to Groq is free and takes a minute.", "Switch to Groq", () => {
        show("settings");
        $("#s-advanced").open = true;
      });
    }
    if (state.secretsUnprotected) add("warn", "This computer has no keychain (on Linux: GNOME Keyring or KWallet), so your token is saved without real encryption. Anyone who can open your files could read it.", null);
    // Redrawn on every state change, a screen reader would read them all again, and a focused button would lose focus.
    const said = JSON.stringify(notices.map((n) => [n.kind, n.text, n.buttonText]));
    if (said === lastNotices) return;
    lastNotices = said;
    const box = $("#notices");
    box.replaceChildren();
    for (const { kind, text, buttonText, onClick } of notices) {
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
    }
  }

  // --- What's new after an update ---------------------------------------------

  /** The version whose highlights are drawn, so a state change doesn't redraw them. */
  let whatsNewShown = null;
  function renderWhatsNew() {
    const w = state.whatsNew;
    const box = $("#whats-new");
    if (!w) {
      box.hidden = true;
      whatsNewShown = null;
      return;
    }
    if (whatsNewShown === w.version) return;
    whatsNewShown = w.version;
    $("#whats-new-version").textContent = w.version;
    $("#whats-new-list").replaceChildren(...w.highlights.map((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      return li;
    }));
    box.hidden = false;
  }
  async function whatsNewDone() {
    $("#whats-new").hidden = true;
    const saved = await api.whatsNewSeen();
    state.whatsNew = saved.whatsNew;
    renderWhatsNew();
  }
  $("#whats-new-close").addEventListener("click", whatsNewDone);
  $("#whats-new-more").addEventListener("click", () => {
    api.openExternal(state.whatsNew?.url || "https://bubblefacts.frolic.org/changelog.html");
    void whatsNewDone();
  });

  // --- Settings ----------------------------------------------------------------

  const form = $("#settings-form");
  const renderMyFacts = watchCustomFacts($("#s-myfacts"), "Your own facts");
  const renderMyOriginals = watchCustomFacts($("#s-myoriginals"), "About your own compositions");

  /**
   * Settings fields changed since the last save, by name (or id). Filling the
   * form again (coming back to Settings, a sign-in, Twitch) leaves them as typed,
   * so leaving Settings never loses an edit. Save, or restoring a backup, clears them.
   */
  const settingsDraft = new Set();
  const draftKey = (el) => el.name || el.id;
  for (const type of ["input", "change"]) {
    form.addEventListener(type, (e) => {
      const key = draftKey(e.target);
      if (key && e.target.matches("input, textarea, select")) settingsDraft.add(key);
    });
  }

  /** Whether a drafted field still says something other than what's saved (an edit typed back is no draft). */
  function differsFromSaved(key) {
    const s = state.settings;
    if (key === "s-myfacts") return lines($("#s-myfacts")).join("\n") !== s.myFacts.join("\n");
    if (key === "s-myoriginals") return lines($("#s-myoriginals")).join("\n") !== s.myOriginals.join("\n");
    const el = form.elements[key];
    if (!el) return false;
    if (el.type === "checkbox") return el.checked !== !!s[key];
    if (el.type === "password") return el.value !== "";
    return String(el.value).trim() !== String(s[key] ?? "");
  }

  function fillSettings() {
    const s = state.settings;
    for (const key of [...settingsDraft]) if (!differsFromSaved(key)) settingsDraft.delete(key);
    for (const el of form.elements) {
      if (!el.name || el.type === "password" || settingsDraft.has(el.name)) continue;
      if (el.type === "checkbox") el.checked = !!s[el.name];
      else if (el.type === "radio") el.checked = s[el.name] === el.value;
      else el.value = s[el.name] ?? "";
    }
    if (!settingsDraft.has("s-myfacts")) $("#s-myfacts").value = s.myFacts.join("\n");
    if (!settingsDraft.has("s-myoriginals")) $("#s-myoriginals").value = s.myOriginals.join("\n");
    renderMyFacts();
    renderMyOriginals();
    $("#s-originals-box").hidden = !form.elements.originals.checked;
    const signedIn = s.tokenKind === "oauth" && s.tokenSet;
    $("#s-signed-in").textContent = s.songSource === "streamelements"
      ? (s.seJwtSet ? `✓ Connected to StreamElements${s.seChannel ? " as " + s.seChannel : ""}.` : "Not connected.")
      : signedIn ? (s.channel ? `✓ Signed in as ${s.channel}.` : "✓ Signed in.") : s.tokenSet ? `Connected to ${s.channel} with a token.` : "Not connected.";
    showSettingsSource();
    $("#s-sign-in").textContent = signedIn ? "Sign in again" : "Sign in with StreamerSongList";
    $("#s-sign-in").hidden = !state.signInAvailable;
    for (const p of $$('#settings-form input[type="password"]')) if (!settingsDraft.has(draftKey(p))) p.value = "";
    $("#s-datadir").textContent = state.dataDir;
    // Someone already using an online AI or the example packs finds them open.
    $("#s-advanced").open = form.elements.ai.value !== "builtin";
    renderSongFactsList();
    renderTimingHint();
    renderTwitch();
    renderWrongKey();
    setResult($("#settings-result"), settingsDraft.size ? "Your changes aren't saved yet. Click Save to keep them." : "");
  }

  /** Hands-free Wrong: the keys as this computer names them, and a key another app already has. */
  function renderWrongKey() {
    if (state.platform === "darwin") for (const o of $$("#s-wrongkey option[data-mac]")) o.textContent = o.dataset.mac;
    const problem = $("#s-wrongkey-problem");
    problem.textContent = state.wrongKeyProblem || "";
    problem.hidden = !state.wrongKeyProblem;
  }

  /** Connect Twitch: not connected, waiting for the code to be approved, or connected. */
  function renderTwitch() {
    const t = state.twitch || {};
    $("#twitch-box").hidden = !t.available;
    const twitchOn = state.settings.twitchConnected;
    $("#twitch-connect").hidden = twitchOn;
    $("#twitch-disconnect").hidden = !twitchOn;
    $("#twitch-connect").textContent = t.userCode ? "Get a new code" : "Connect Twitch";
    const status = $("#twitch-status");
    if (twitchOn) setResult(status, `✓ Connected${state.settings.twitchLogin ? " as " + state.settings.twitchLogin : ""}.`, "ok");
    else if (t.userCode) setResult(status, `On the Twitch page that just opened, check the code is ${t.userCode}, then click Authorize.`, "");
    else setResult(status, t.error || "", t.error ? "bad" : "");
  }
  $("#twitch-connect").addEventListener("click", async () => {
    state = await api.twitchConnect();
    renderTwitch();
  });
  $("#twitch-disconnect").addEventListener("click", async () => {
    state = await api.twitchDisconnect();
    renderTwitch();
  });

  // Counted from one bubble's start to the next, not the gap between them: say what the two numbers make.
  function renderTimingHint() {
    const every = Number(form.elements.intervalSeconds.value);
    const up = Number(form.elements.durationSeconds.value);
    if (!every || !up) return void ($("#s-timing-hint").textContent = "");
    $("#s-timing-hint").textContent = up < every
      ? `One bubble at a time, with ${every - up} seconds between them.`
      : "Each bubble is still up when the next appears, so two or more show at once.";
  }
  form.elements.intervalSeconds.addEventListener("input", renderTimingHint);
  form.elements.durationSeconds.addEventListener("input", renderTimingHint);

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
    changes.myFacts = lines($("#s-myfacts"));
    changes.myOriginals = lines($("#s-myoriginals"));
    const tooLong = customFactsProblem($("#s-myfacts"), "Your own facts", true)
      || customFactsProblem($("#s-myoriginals"), "About your own compositions", true);
    if (tooLong) return setResult($("#settings-result"), tooLong, "bad");
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
    settingsDraft.clear();
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
  // "About BubbleFacts" in the tray menu.
  api.on("show-view", (view) => show(view));
  // Hands-free Wrong (a foot pedal or Stream Deck): the usual note, with Undo. Nothing on stream, no sound.
  api.on("wrong-key", (r) => {
    if (!state || !r) return;
    if (!r.removed) {
      const why = {
        paused: "Bubbles are paused, so nothing was on stream to mark.",
        "no-song": "No song is playing, so nothing was marked.",
        "not-ready": "This song's facts aren't ready yet, so nothing was marked.",
        "no-facts": "This song has no bubbles, so nothing was marked.",
        "none-shown": "No bubble has shown yet for this song, so nothing was marked.",
        "already-marked": "The last bubble is already marked, so nothing more was marked.",
      };
      // Report and Undo belong to a fact that was marked, and this press marked none.
      state.wrong = null;
      showWrongNote(`Hands-free Wrong: ${why[r.reason] || "BubbleFacts isn't running right now, so nothing was marked."}`, null);
      return;
    }
    const label = r.song.title + (r.song.artist && !/^unknown$/i.test(r.song.artist) ? " — " + r.song.artist : "");
    state.wrong = { song: label, text: r.text, article: r.article, songId: r.song };
    wrongNote(r, r.text, r.song, `Removed with hands-free Wrong: “${r.text}”`);
    lastRecent = "";
    void refreshRecent();
  });
  api.on("state", (s) => {
    state = s;
    if (!$("#view-settings").hidden) {
      renderTwitch();
      renderWrongKey();
    }
    $("#unlocking").hidden = !s.unlocking;
    renderNotices();
    renderWhatsNew();
    renderStatus(s.status);
  });

  (async () => {
    state = await api.getState();
    if (state.unlocking) {
      $("#unlocking").hidden = false;
      // Painted first: the app stops answering while the Mac's prompt is up.
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => api.unlockReady()));
    }
    $("#about-version").textContent = state.version;
    $("#about-page-version").textContent = `Version ${state.version}`;
    $("#report-beta").hidden = !/-beta/.test(state.version);
    renderNotices();
    renderWhatsNew();
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
