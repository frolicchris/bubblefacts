import fs from "fs";
import path from "path";
jest.mock("electron", () => ({ app: { getPath: () => "", getVersion: () => "0.0.0" }, safeStorage: {} }));
import { DEFAULTS, sanitize, type Settings } from "./settings";

const renderer = path.join(__dirname, "..", "renderer");
const read = (f: string) => fs.readFileSync(path.join(renderer, f), "utf8");

describe("setup headings", () => {
  it("take focus for screen readers without drawing a focus ring", () => {
    // The app focuses these h1s when a screen opens; Chromium would outline them
    expect(read("index.html")).toMatch(/<h1 tabindex="-1">/);
    expect(read("app.css")).toMatch(/h1\[tabindex="-1"\]:focus\s*\{\s*outline:\s*none;\s*\}/);
  });
});

describe("dashboard", () => {
  it("makes Add facts for this song the filled button and for another song the plain one", () => {
    const html = read("index.html");
    expect(html).toMatch(/<button id="song-facts-open" class="primary"/);
    expect(html).toMatch(/<button id="song-facts-other" class="ghost"/);
  });

  it("gives each green banner title its own second line", () => {
    const js = read("banner.js");
    for (const line of [
      "BubbleFacts will show facts when your next song starts.",
      "This song's facts pop up on your stream while it plays.",
      "No bubbles for this song. The note below says why.",
      "Looking up facts for this song. They appear in a few seconds.",
    ]) expect(js).toContain(line);
    expect(js).not.toContain("BubbleFacts is connected and waiting.");
    // Facts off, a live learn or a failure means no bubbles, but not "normal"
    expect(js).not.toContain("No reliable facts for this song, so no bubbles. That's normal.\"");
  });
});

describe("setup's bubble spot question", () => {
  it("offers the corners, top center and bottom center as a picture of the screen, with nothing picked for them", () => {
    const html = read("index.html");
    expect(html).toContain("Where should bubbles appear on your stream?");
    const picker = html.slice(html.indexOf('class="screen-pick"'), html.indexOf("</div>", html.indexOf('class="screen-pick"')));
    const values = [...picker.matchAll(/name="setup-area" value="([a-z-]+)"/g)].map((m) => m[1]);
    // Each is the one spot its place in the picture shows; "top" and "bottom" spread along the whole edge,
    // corners included, so the picture's middle can't stand for them
    expect(values.sort()).toEqual(["bottom-center", "bottom-left", "bottom-right", "top-center", "top-left", "top-right"]);
    // Every one is accepted, and none is chosen before the musician picks
    for (const v of values) expect(sanitize({ ...DEFAULTS, bubbleArea: v as Settings["bubbleArea"] }).bubbleArea).toBe(v);
    expect(picker).not.toContain("checked");
    // A new install starts at Anywhere until then
    expect(DEFAULTS.bubbleArea).toBe("anywhere");
    // Where a camera, chat and the Now Playing bar usually sit
    for (const label of ["Camera", "Chat", "Now Playing"]) expect(html).toMatch(new RegExp(`class="mock [a-z-]+" aria-hidden="true">${label}<`));
    expect(html).not.toContain("Where's clear on your stream?");
    expect(html).toContain("keep them clear of your camera, keyboard or chat");
  });

  it("saves the musician's pick, and shows an existing choice only when it's one of these", () => {
    const js = read("app.js");
    expect(js).toContain('api.saveSettings({ bubbleArea: radio.value })');
    expect(js).toContain("r.checked = r.value === state.settings.bubbleArea");
  });
});

describe("Settings", () => {
  const html = read("index.html");
  const settings = html.slice(html.indexOf('<form id="settings-form"'), html.indexOf("</form>", html.indexOf('<form id="settings-form"')));
  /** An element's text, tags dropped and spaces squeezed */
  const text = (s: string) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  const cards = (src: string, name: string) =>
    [...src.matchAll(new RegExp(`<label class="choice">\\s*<input type="radio" name="${name}" value="([a-z]+)"[^>]*>\\s*<span class="choice-body">\\s*<strong>([^<]+)</strong>\\s*<span>([\\s\\S]*?)</span>\\s*</span>\\s*</label>`, "g"))]
      .map((m) => ({ value: m[1], title: m[2], body: text(m[3]) }));

  it("shows one section at a time, every setting under one of the section buttons, all in the one form", () => {
    const tabs = [...settings.matchAll(/class="settings-tab" data-settings-tab="([a-z]+)"( aria-current="true")?>([^<]+)</g)];
    expect(tabs.map((t) => t[3])).toEqual(["Song list", "Your music", "Custom facts", "Bubbles", "Vertical stream", "Sharing", "General"]);
    // Opens on the first, so the page reads the same before the script runs
    expect(tabs.filter((t) => t[2]).map((t) => t[1])).toEqual(["songs"]);
    const names = tabs.map((t) => t[1]);
    // No section is left outside the buttons, where nobody could reach it
    const fieldsets = [...settings.matchAll(/<fieldset([^>]*)>/g)].map((f) => f[1].match(/data-settings-panel="([a-z]+)"/)?.[1]);
    expect(fieldsets.length).toBeGreaterThan(0);
    for (const panel of fieldsets) expect(names).toContain(panel);
    expect(settings).toMatch(/<details class="advanced" id="s-advanced" data-settings-panel="general">/);
    for (const name of names) expect(settings).toContain(`data-settings-panel="${name}"`);
    // Hidden by a class, never the hidden attribute, which Prepare my songs and others already use for their own reasons
    expect(read("app.css")).toContain("[data-settings-panel].tab-off { display: none; }");
    const js = read("app.js");
    expect(js).toContain('p.classList.toggle("tab-off", p.dataset.settingsPanel !== name)');
    // A link or button that sends the musician to one setting opens its section first
    expect(js).toContain("revealInSettings(document.getElementById(t.dataset.scrollTo))");
    expect(js).toContain('revealInSettings($("#s-myfacts"))');
    // Reopens on the section last looked at, and on the first when that one is gone or nothing was saved
    expect(js).toContain("showSettingsTab(lastSettingsTab())");
    expect(js).toMatch(/lastSettingsTab\(\) \{[^]*?\? saved : "songs";/);
  });

  it("warns, without blocking, the moment another AI is chosen to write the facts", () => {
    const start = settings.indexOf('aria-labelledby="s-ai-label"');
    const group = settings.slice(start, settings.indexOf("</div>", start));
    expect(group).toContain('aria-describedby="s-ai-paused s-ai-warning"');
    for (const ai of ["groq", "anthropic", "ollama"]) expect(group).toContain(`name="ai" value="${ai}"`);
    // Under the choice, read out as it changes, empty until another AI is picked
    expect(settings).toContain('<div role="status"><p id="s-ai-warning" class="result bad" hidden></p></div>');
    const js = read("app.js");
    const fn = js.slice(js.indexOf("function renderAiWarning"), js.indexOf("\n  }", js.indexOf("function renderAiWarning")));
    expect(js).toMatch(/const OTHER_AI = \{ groq: "Groq", anthropic: "Anthropic", ollama: "your Ollama model" \}/);
    // BubbleFacts doesn't control or test another AI: the warning claims no checks
    expect(fn).toContain("! BubbleFacts doesn't control or test ${who}, so it can't vouch for its facts, and they may be wrong more often. Press Wrong on any fact that's off, and switch back any time.");
    expect(fn).not.toMatch(/screen|check|verif/i);
    expect(fn).toContain("warning.hidden = !who");
    // Renders when Settings opens and whenever the choice changes
    expect(js).toContain("renderQuality();\n    renderAiWarning();");
    expect(js).toContain("form.querySelectorAll('input[name=\"ai\"]')) el.addEventListener(\"change\", renderAiWarning)");
  });

  it("doesn't offer other AIs, but keeps them for someone who already chose one", () => {
    // Choice and keys start hidden; only a saved choice of another AI shows them
    const choice = settings.slice(settings.indexOf('<div id="s-other-ai" hidden>'), settings.indexOf('<div id="s-quality-box"'));
    expect(choice).toContain('id="s-ai-label">Who writes the facts</p>');
    expect(choice).toContain('name="ai" value="groq"');
    expect(choice).toContain("Online AIs and Ollama are a legacy choice, kept for anyone who already chose one. BubbleFacts doesn't control or test them and can't vouch for their facts, and your viewers see a bubble saying so. If you switch back and save, these choices go away.");
    // No claim their facts are checked: BubbleFacts doesn't control that pipeline
    expect(choice).not.toMatch(/screen|checked|verified/i);
    const keys = settings.slice(settings.indexOf('<div id="s-other-ai-keys" hidden>'), settings.indexOf('<label for="s-port">'));
    for (const name of ["groqKey", "anthropicKey", "ollamaUrl", "ollamaModel"]) expect(keys).toContain(`name="${name}"`);
    const js = read("app.js");
    expect(js).toContain('const otherAi = s.ai !== "builtin";\n    $("#s-other-ai").hidden = !otherAi;\n    $("#s-other-ai-keys").hidden = !otherAi;');
    // Nothing points people to them: no Switch to Groq, no fine print offering them
    expect(js).not.toContain("Switch to Groq");
    expect(html).not.toMatch(/Online AI and Larger AI|choose an online AI or your own Ollama/);
    expect(html).not.toMatch(/choose (one|another AI|Anthropic|Groq|Ollama|an online AI) under Advanced/i);
    // Lite is gone: no edition switching, no Lite screens or notice
    expect(js).not.toMatch(/isLite|showEdition|BubbleFacts Lite/);
    expect(html).not.toMatch(/data-edition|BubbleFacts Lite/);
    expect(settings).toContain("Larger AI is under Advanced.");
    // Saving refills the form from what's saved, which hides the choice after switching back
    const save = js.slice(js.indexOf("async function saveSettingsForm"), js.indexOf("\n  }", js.indexOf("async function saveSettingsForm")));
    expect(save).toContain("state = saved;");
    expect(save).toContain("fillSettings();");
  });

  it("offers the song sources as the same three cards as setup", () => {
    const setup = cards(html, "setup-source");
    expect(setup.map((c) => c.value)).toEqual(["streamersonglist", "streamelements", "nowplaying"]);
    expect(cards(settings, "songSource")).toEqual(setup);
  });

  it("puts Streamling, Nightbot, What's Now Playing and Another app's file as cards right under Now playing file", () => {
    expect(cards(settings, "nowPlayingPreset").map((c) => c.title)).toEqual(["Streamling", "Nightbot", "What's Now Playing", "Another app's file"]);
    expect(cards(html, "setup-np").map((c) => c.value)).toEqual(cards(settings, "nowPlayingPreset").map((c) => c.value));
    const nowPlayingCard = settings.indexOf('name="songSource" value="nowplaying"');
    const box = settings.indexOf('<div id="s-np-box"');
    expect(box).toBeGreaterThan(nowPlayingCard);
    // Nothing else (the sign-in, StreamElements) comes between the card and its choices
    expect(settings.slice(nowPlayingCard, box)).not.toMatch(/id="s-(ssl|se)-box"|id="s-signed-in"/);
  });

  it("keeps every control", () => {
    const tags = [...settings.matchAll(/<(?:input|select|textarea|button)\b[^>]*>/g)].map((m) => m[0]);
    const controls = new Set(tags.flatMap((t) => [...t.matchAll(/\b(?:name|id)="([^"]+)"/g)].map((m) => m[1])));
    for (const c of [
      "songSource", "channel", "token", "s-sign-in", "nowPlayingPreset", "nowPlayingFile", "s-np-choose", "nowPlayingFormat",
      "seChannel", "seJwt", "displayName", "originals", "s-myoriginals", "liveLearns", "twitch-connect", "twitch-disconnect",
      "s-myfacts", "bubbleSize", "bubbleStyle", "customColors", "accentColor", "backgroundColor", "bubbleArea", "nowPlaying", "creditBubble", "liveLearnBanner", "factsPerSong",
      "intervalSeconds", "durationSeconds", "wrongKey", "startAtLogin", "updateChannel", "ai", "aiQuality", "groqKey",
      "anthropicKey", "ollamaUrl", "ollamaModel", "port", "backup-save", "backup-show", "backup-restore", "remove-data", "prepareSongs",
    ]) expect(controls).toContain(c);
  });

  it("explains Twitch, custom facts and Hands-free Wrong in one line each", () => {
    const after = (marker: string) => {
      const at = settings.indexOf("<p class=\"fine\">", settings.indexOf(marker));
      return text(settings.slice(at, settings.indexOf("</p>", at)));
    };
    for (const marker of ["Other music content creators' originals", "<legend>Custom facts", 'id="s-wrongkey"']) {
      expect(after(marker).length).toBeLessThanOrEqual(110);
    }
    // The bracket rules are in the box's gray example, which never goes on stream
    const placeholder = settings.match(/id="s-myfacts"[^>]*placeholder="([^"]*)"/)![1];
    expect(placeholder).toContain("[Song of Storms]");
    expect(placeholder).toContain("[Chopin]");
    expect(placeholder).toContain("no bubbles");
  });

  it("puts the hint for where the facts come from under its checkbox", () => {
    const label = settings.match(/<label class="inline"><input name="creditBubble"[^>]*>[^<]*<\/label>/);
    expect(label?.[0]).toContain('aria-describedby="s-credit-hint"');
    expect(settings).toMatch(/<\/label>\s*<p class="hint indent" id="s-credit-hint">One extra bubble/);
    // Unchecked is rarer, not never: the server still credits each stream once (credit.ts)
    expect(settings).toContain("Unchecked, it still shows when you go live in OBS, and again after 20 minutes without facts.");
  });

  it("sets its help text at 14px and keeps the Save bar on screen", () => {
    const css = read("app.css");
    expect(css).toMatch(/#settings-form \.fine, #settings-form \.hint \{ font-size: 14px; \}/);
    expect(settings).toMatch(/<div class="nav-buttons save-bar">\s*<span id="settings-result"/);
    const bar = css.slice(css.indexOf(".save-bar {"), css.indexOf("}", css.indexOf(".save-bar {")));
    expect(bar).toContain("position: sticky; bottom: 0;");
  });

  it("says changes aren't saved as soon as one is made", () => {
    const js = read("app.js");
    const listener = js.slice(js.indexOf('for (const type of ["input", "change"])'), js.indexOf("function differsFromSaved"));
    expect(listener).toContain("renderDraftNote();");
    expect(js).toContain("Your changes aren't saved yet. Click Save to keep them.");
  });
});
