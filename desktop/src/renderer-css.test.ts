import fs from "fs";
import path from "path";
jest.mock("electron", () => ({ app: { getPath: () => "", getVersion: () => "0.0.0" }, safeStorage: {} }));
import { DEFAULTS, sanitize, type Settings } from "./settings";

const renderer = path.join(__dirname, "..", "renderer");
const read = (f: string) => fs.readFileSync(path.join(renderer, f), "utf8");

describe("setup headings", () => {
  it("take focus for screen readers without drawing a focus ring", () => {
    // The app focuses these h1s when a screen opens; Chromium would outline them.
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
    const js = read("app.js");
    for (const line of [
      "BubbleFacts will show facts when your next song starts.",
      "This song's facts pop up on your stream while it plays.",
      "No bubbles for this song. The note below says why.",
      "Looking up facts for this song. They appear in a few seconds.",
    ]) expect(js).toContain(line);
    expect(js).not.toContain("BubbleFacts is connected and waiting.");
    // With facts off, a live learn or a failure there are no bubbles, but calling it "normal" would be wrong.
    expect(js).not.toContain("No reliable facts for this song, so no bubbles. That's normal.\"");
  });
});

describe("setup's bubble spot question", () => {
  it("offers the corners, top center and bottom center as a picture of the screen, with nothing picked for them", () => {
    const html = read("index.html");
    expect(html).toContain("Where should bubbles appear on your stream?");
    const picker = html.slice(html.indexOf('class="screen-pick"'), html.indexOf("</div>", html.indexOf('class="screen-pick"')));
    const values = [...picker.matchAll(/name="setup-area" value="([a-z-]+)"/g)].map((m) => m[1]);
    // Each one is the one spot its place in the picture shows. "top" and "bottom" spread bubbles along
    // the whole edge, corners included, so the middle of the picture can't stand for them.
    expect(values.sort()).toEqual(["bottom-center", "bottom-left", "bottom-right", "top-center", "top-left", "top-right"]);
    // Every one is a spot the app accepts, and none is chosen before the musician picks.
    for (const v of values) expect(sanitize({ ...DEFAULTS, bubbleArea: v as Settings["bubbleArea"] }).bubbleArea).toBe(v);
    expect(picker).not.toContain("checked");
    // A new install still starts at Anywhere until then, and Settings keeps its hint.
    expect(DEFAULTS.bubbleArea).toBe("anywhere");
    // The picture shows where a camera, chat and the Now Playing bar usually sit.
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
  /** The text inside an element, tags dropped and spaces squeezed. */
  const text = (s: string) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  const cards = (src: string, name: string) =>
    [...src.matchAll(new RegExp(`<label class="choice">\\s*<input type="radio" name="${name}" value="([a-z]+)"[^>]*>\\s*<span class="choice-body">\\s*<strong>([^<]+)</strong>\\s*<span>([\\s\\S]*?)</span>\\s*</span>\\s*</label>`, "g"))]
      .map((m) => ({ value: m[1], title: m[2], body: text(m[3]) }));

  it("offers the song sources as the same three cards as setup", () => {
    const setup = cards(html, "setup-source");
    expect(setup.map((c) => c.value)).toEqual(["streamersonglist", "streamelements", "nowplaying"]);
    expect(cards(settings, "songSource")).toEqual(setup);
  });

  it("puts Streamling, Nightbot and Another app's file as cards right under Now playing file", () => {
    expect(cards(settings, "nowPlayingPreset").map((c) => c.title)).toEqual(["Streamling", "Nightbot", "Another app's file"]);
    const nowPlayingCard = settings.indexOf('name="songSource" value="nowplaying"');
    const box = settings.indexOf('<div id="s-np-box"');
    expect(box).toBeGreaterThan(nowPlayingCard);
    // Nothing else (the sign-in, StreamElements) comes between the card and its choices.
    expect(settings.slice(nowPlayingCard, box)).not.toMatch(/id="s-(ssl|se)-box"|id="s-signed-in"/);
  });

  it("keeps every control", () => {
    const tags = [...settings.matchAll(/<(?:input|select|textarea|button)\b[^>]*>/g)].map((m) => m[0]);
    const controls = new Set(tags.flatMap((t) => [...t.matchAll(/\b(?:name|id)="([^"]+)"/g)].map((m) => m[1])));
    for (const c of [
      "songSource", "channel", "token", "s-sign-in", "nowPlayingPreset", "nowPlayingFile", "s-np-choose", "nowPlayingFormat",
      "seChannel", "seJwt", "displayName", "originals", "s-myoriginals", "liveLearns", "twitch-connect", "twitch-disconnect",
      "s-myfacts", "bubbleSize", "bubbleArea", "nowPlaying", "creditBubble", "liveLearnBanner", "factsPerSong",
      "intervalSeconds", "durationSeconds", "wrongKey", "startAtLogin", "updateChannel", "ai", "aiQuality", "groqKey",
      "anthropicKey", "ollamaUrl", "ollamaModel", "port", "backup-save", "backup-show", "backup-restore", "remove-data",
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
    // The bracket rules moved into the box's gray example, which never goes on stream.
    const placeholder = settings.match(/id="s-myfacts"[^>]*placeholder="([^"]*)"/)![1];
    expect(placeholder).toContain("[Song of Storms]");
    expect(placeholder).toContain("[Chopin]");
    expect(placeholder).toContain("no bubbles");
  });

  it("puts the hint for where the facts come from under its checkbox", () => {
    const label = settings.match(/<label class="inline"><input name="creditBubble"[^>]*>[^<]*<\/label>/);
    expect(label?.[0]).toContain('aria-describedby="s-credit-hint"');
    expect(settings).toMatch(/<\/label>\s*<p class="hint indent" id="s-credit-hint">One extra bubble/);
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
