/* BubbleFacts website: OS-aware download button, copy buttons, FAQ links.
 * No tracking. The only outside request is to GitHub's public API, to find
 * the newest release (betas included) and its download links.
 * Without JavaScript the page still works: every download link points at the
 * GitHub Releases page, and the main button jumps to the full list.
 */
(function () {
  "use strict";

  var REPO = "frolicchris/bubblefacts";
  var RELEASES_PAGE = "https://github.com/" + REPO + "/releases";
  var API = "https://api.github.com/repos/" + REPO + "/releases?per_page=10";
  var CACHE_KEY = "sf-releases-v1";
  var CACHE_MS = 10 * 60 * 1000;

  // Release file names include the version, so match them by their ending.
  var PATTERNS = {
    "mac-arm64": /-mac-arm64\.dmg$/,
    "mac-x64": /-mac-x64\.dmg$/,
    "windows-x64": /-windows-x64\.exe$/,
    "linux-appimage": /-linux-x86_64\.AppImage$/,
    "linux-deb": /_amd64\.deb$/,
    "sha256sums": /^SHA256SUMS\.txt$/
  };

  var BUILDS = {
    "mac-arm64": { label: "Download for Mac (Apple silicon)", note: "For macOS 13 or newer, on Macs with Apple silicon (M1 and newer). Free." },
    "mac-x64": { label: "Download for Mac (Intel)", note: "For macOS 13 or newer, on Macs with an Intel processor. Free." },
    "windows-x64": { label: "Download for Windows", note: "For Windows 10 or 11, 64-bit. Free." },
    "linux-deb": { label: "Download for Linux (.deb)", note: "For Ubuntu, Debian and similar, 64-bit. Free. Other Linux: use the AppImage below." }
  };

  // Download links found for the newest release, by asset key. Empty until loaded.
  var assetUrls = {};

  function detectOS() {
    var ua = navigator.userAgent || "";
    var platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
    var touch = navigator.maxTouchPoints || 0;

    if (/iPhone|iPad|iPod|Android/i.test(ua)) return "mobile";
    if (/Mac/i.test(platform) || /Macintosh/i.test(ua)) {
      // iPads report themselves as a Mac but have a touch screen.
      return touch > 1 ? "mobile" : "mac";
    }
    if (/Win/i.test(platform) || /Windows/i.test(ua)) return "windows";
    if (/CrOS/i.test(ua)) return "unknown";
    if (/Linux/i.test(platform) || /Linux|X11/i.test(ua)) return "linux";
    return "unknown";
  }

  function applyAssets() {
    var links = document.querySelectorAll("[data-asset]");
    Array.prototype.forEach.call(links, function (link) {
      var url = assetUrls[link.getAttribute("data-asset")];
      // A missing file falls back to the Releases page, never a dead link.
      link.href = url || RELEASES_PAGE;
    });
  }

  function showRelease(release) {
    var version = String(release.tag_name || release.name || "").replace(/^v/, "");
    Array.prototype.forEach.call(document.querySelectorAll("[data-release-version]"), function (el) {
      if (version) el.textContent = version;
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-release-link]"), function (el) {
      if (release.html_url) el.href = release.html_url;
    });
    assetUrls = {};
    (release.assets || []).forEach(function (asset) {
      Object.keys(PATTERNS).forEach(function (key) {
        if (!assetUrls[key] && PATTERNS[key].test(asset.name)) assetUrls[key] = asset.browser_download_url;
      });
    });
    applyAssets();
  }

  function readCache() {
    try {
      var saved = JSON.parse(window.sessionStorage.getItem(CACHE_KEY));
      if (saved && Date.now() - saved.time < CACHE_MS) return saved.releases;
    } catch (e) { /* storage blocked or empty */ }
    return null;
  }

  function writeCache(releases) {
    try {
      window.sessionStorage.setItem(CACHE_KEY, JSON.stringify({ time: Date.now(), releases: releases }));
    } catch (e) { /* storage blocked or full */ }
  }

  function loadRelease() {
    if (!document.querySelector("[data-asset], [data-release-version], [data-release-link]")) return;
    var cached = readCache();
    var got = cached ? Promise.resolve(cached) : (window.fetch ? fetch(API, { headers: { Accept: "application/vnd.github+json" } })
      .then(function (res) {
        if (!res.ok) throw new Error("GitHub answered " + res.status);
        return res.json();
      })
      .then(function (list) {
        // Keep only what the page needs.
        var slim = (list || []).map(function (r) {
          return {
            draft: r.draft, tag_name: r.tag_name, name: r.name, html_url: r.html_url,
            assets: (r.assets || []).map(function (a) { return { name: a.name, browser_download_url: a.browser_download_url }; })
          };
        });
        writeCache(slim);
        return slim;
      }) : Promise.reject(new Error("no fetch")));

    got.then(function (list) {
      // Newest first. Prereleases (betas) count; drafts don't.
      for (var i = 0; i < list.length; i++) {
        if (!list[i].draft) { showRelease(list[i]); return; }
      }
    }).catch(function () { /* links keep pointing at the Releases page */ });
  }

  function macAlternative(alt, current) {
    if (!alt) return;
    var other = current === "mac-arm64" ? "mac-x64" : "mac-arm64";
    alt.textContent = "";
    alt.appendChild(document.createTextNode(other === "mac-x64" ? "Intel Mac? " : "Mac with Apple silicon? "));
    var link = document.createElement("a");
    link.setAttribute("data-asset", other);
    link.href = assetUrls[other] || RELEASES_PAGE;
    link.textContent = other === "mac-x64" ? "Download for Intel" : "Download for Apple silicon";
    alt.appendChild(link);
    alt.appendChild(document.createTextNode(" · "));
    var help = document.createElement("a");
    help.href = "download.html#which-mac";
    help.textContent = "Which Mac do I have?";
    alt.appendChild(help);
    alt.hidden = false;
  }

  function setPrimary(button, note, key) {
    var build = BUILDS[key];
    button.setAttribute("data-asset", key);
    button.href = assetUrls[key] || RELEASES_PAGE;
    button.textContent = build.label;
    if (note) note.textContent = build.note;
  }

  function setupDownload() {
    var button = document.getElementById("dl-primary");
    if (!button) return;
    var note = document.getElementById("dl-note");
    var alt = document.getElementById("dl-alt");
    var heading = document.getElementById("dl-other-heading");
    var os = detectOS();

    if (os === "mac" || os === "windows" || os === "linux") {
      var key = os === "mac" ? "mac-arm64" : os === "windows" ? "windows-x64" : "linux-deb";
      setPrimary(button, note, key);
      if (heading) heading.textContent = "Other computers";
      Array.prototype.forEach.call(document.querySelectorAll('[data-os="' + os + '"]'), function (item) {
        item.hidden = true;
      });
      if (os === "mac") {
        // Most Macs since late 2020 are Apple silicon. Chrome and Edge can tell us about Intel.
        macAlternative(alt, key);
        var uad = navigator.userAgentData;
        if (uad && uad.getHighEntropyValues) {
          uad.getHighEntropyValues(["architecture"]).then(function (v) {
            if (v && v.architecture === "x86") {
              setPrimary(button, note, "mac-x64");
              macAlternative(alt, "mac-x64");
            }
          }).catch(function () { /* keep Apple silicon */ });
        }
      }
    } else if (os === "mobile") {
      if (note) {
        note.textContent = "BubbleFacts runs on Mac, Windows and Linux computers. Open this page on the computer you stream from to download it.";
      }
    }
  }

  function setupCopy() {
    var buttons = document.querySelectorAll("[data-copy]");
    var status = document.getElementById("copy-status");
    Array.prototype.forEach.call(buttons, function (btn) {
      btn.hidden = false;
      btn.addEventListener("click", function () {
        var text = btn.getAttribute("data-copy");
        var original = btn.getAttribute("data-label") || btn.textContent;
        btn.setAttribute("data-label", original);
        function done(ok) {
          btn.textContent = ok ? "Copied" : "Press Ctrl+C to copy";
          if (status) status.textContent = ok ? "Copied " + text + " to the clipboard." : "";
          window.setTimeout(function () { btn.textContent = original; }, 2000);
        }
        if (navigator.clipboard && window.isSecureContext) {
          navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
        } else {
          var area = document.createElement("textarea");
          area.value = text;
          area.setAttribute("readonly", "");
          area.style.position = "absolute";
          area.style.left = "-9999px";
          document.body.appendChild(area);
          area.select();
          var ok = false;
          try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
          document.body.removeChild(area);
          done(ok);
        }
      });
    });
  }

  // Open a FAQ answer when someone follows a link straight to it.
  function openFromHash() {
    if (!location.hash) return;
    var target = document.getElementById(location.hash.slice(1));
    if (target && target.tagName === "DETAILS") target.open = true;
  }

  setupDownload();
  loadRelease();
  setupCopy();
  openFromHash();
  window.addEventListener("hashchange", openFromHash);
})();
