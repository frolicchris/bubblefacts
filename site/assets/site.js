/* BubbleFacts website: OS-aware download button, download checker, copy
 * buttons, FAQ links.
 * No tracking. The only outside request is to GitHub's public API, to find
 * the newest full release (or, before there is one with installers, the
 * newest beta), its download links and fingerprints.
 * The download checker hashes files in the browser; files are never uploaded.
 * Without JavaScript the page still works: every download link points at the
 * GitHub Releases page, and the main button jumps to the full list.
 */
(function () {
  "use strict";

  var REPO = "frolicchris/bubblefacts";
  var RELEASES_PAGE = "https://github.com/" + REPO + "/releases";
  var API = "https://api.github.com/repos/" + REPO + "/releases?per_page=30";
  var CACHE_KEY = "sf-releases-v2";
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
    "mac-arm64": { label: "Download for Mac", note: "For Macs with Apple silicon (M1 and newer), macOS 13 or newer. Free." },
    "mac-x64": { label: "Download for Mac", note: "For Intel Macs, macOS 13 or newer. Free." },
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
    Array.prototype.forEach.call(document.querySelectorAll("[data-release-shown]"), function (el) {
      if (version) el.hidden = false;
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

  var releasesPromise = null;

  // The release list, from the 10-minute cache or GitHub. A failed request
  // is forgotten, so the next call tries again.
  function getReleases() {
    if (releasesPromise) return releasesPromise;
    var cached = readCache();
    if (cached) {
      releasesPromise = Promise.resolve(cached);
    } else if (!window.fetch) {
      return Promise.reject(new Error("no fetch"));
    } else {
      releasesPromise = fetch(API, { headers: { Accept: "application/vnd.github+json" } })
        .then(function (res) {
          if (!res.ok) throw new Error("GitHub answered " + res.status);
          return res.json();
        })
        .then(function (list) {
          // Keep only what the page needs.
          var slim = (list || []).map(function (r) {
            return {
              draft: r.draft, prerelease: r.prerelease, tag_name: r.tag_name, name: r.name,
              html_url: r.html_url, body: r.body || "",
              assets: (r.assets || []).map(function (a) {
                return { name: a.name, browser_download_url: a.browser_download_url, digest: a.digest || "" };
              })
            };
          });
          writeCache(slim);
          return slim;
        });
      releasesPromise.catch(function () { releasesPromise = null; });
    }
    return releasesPromise;
  }

  function publishedReleases(list) {
    // Newest first. Prereleases (betas) count; drafts don't.
    return (list || []).filter(function (r) { return !r.draft; });
  }

  // Compares versions like 2.0.0 and 2.1.0-beta.1 the way the app does (desktop/src/checks.ts).
  function compareVersions(a, b) {
    var split = function (v) {
      var parts = String(v).replace(/^v/, "").split("-");
      return { core: parts[0].split(".").map(function (n) { return parseInt(n, 10) || 0; }), pre: parts[1] ? parts.slice(1).join("-").split(".") : [] };
    };
    var x = split(a), y = split(b), i, d;
    for (i = 0; i < 3; i++) {
      d = (x.core[i] || 0) - (y.core[i] || 0);
      if (d) return d > 0 ? 1 : -1;
    }
    if (!x.pre.length || !y.pre.length) return x.pre.length ? -1 : y.pre.length ? 1 : 0;
    for (i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
      var p = x.pre[i], q = y.pre[i];
      if (p === undefined) return -1;
      if (q === undefined) return 1;
      var np = Number(p), nq = Number(q);
      d = !isNaN(np) && !isNaN(nq) ? np - nq : p.localeCompare(q);
      if (d) return d > 0 ? 1 : -1;
    }
    return 0;
  }

  function isPrerelease(r) {
    return !!r.prerelease || versionOf(r).indexOf("-") !== -1;
  }

  function hasInstallers(r) {
    return (r.assets || []).some(function (a) {
      return Object.keys(BUILDS).concat("linux-appimage").some(function (key) { return PATTERNS[key].test(a.name); });
    });
  }

  function newest(list) {
    return list.slice().sort(function (a, b) { return compareVersions(versionOf(b), versionOf(a)); })[0];
  }

  // The newest full release with installers. Before there is one (1.0.0 was
  // command-line only), the newest beta, as before.
  function loadRelease() {
    if (!document.querySelector("[data-asset], [data-release-version], [data-release-link]")) return;
    getReleases().then(function (list) {
      var published = publishedReleases(list).filter(hasInstallers);
      var stable = newest(published.filter(function (r) { return !isPrerelease(r); }));
      var beta = newest(published.filter(isPrerelease));
      var shown = stable || beta;
      if (!shown) return;
      showRelease(shown);
      // Testers find the newest beta when it's ahead of the full release.
      if (stable && beta && compareVersions(versionOf(beta), versionOf(stable)) > 0) {
        Array.prototype.forEach.call(document.querySelectorAll("[data-beta-line]"), function (el) {
          var link = el.querySelector("a");
          if (link && beta.html_url) link.href = beta.html_url;
          el.hidden = false;
        });
      }
    }).catch(function () { /* links keep pointing at the Releases page */ });
  }

  // ---------- Download checker ----------

  function versionOf(release) {
    return String(release.tag_name || release.name || "").replace(/^v/, "");
  }

  // Fingerprints for a release: from each file's "digest" (sha256:<hex>),
  // then from "<hex>  <file name>" lines in the release notes.
  function fingerprints(release) {
    var out = [];
    var seen = {};
    (release.assets || []).forEach(function (a) {
      var m = /^sha256:([0-9a-f]{64})$/i.exec(a.digest || "");
      if (m) { out.push({ name: a.name, hex: m[1].toLowerCase() }); seen[a.name] = true; }
    });
    String(release.body || "").split(/\r?\n/).forEach(function (line) {
      var m = /^\s*(?:[-*]\s+)?`?([0-9a-f]{64})`?\s+\*?`?([^\s`]+)`?\s*$/i.exec(line);
      if (m && !seen[m[2]]) { out.push({ name: m[2], hex: m[1].toLowerCase() }); seen[m[2]] = true; }
    });
    return out;
  }

  function findMatch(releases, fileName, hex) {
    var i, j, list;
    // Same name first, then any file with the same fingerprint (browsers
    // sometimes rename downloads, for example adding "(1)").
    for (i = 0; i < releases.length; i++) {
      list = fingerprints(releases[i]);
      for (j = 0; j < list.length; j++) {
        if (list[j].name === fileName && list[j].hex === hex) return { entry: list[j], index: i };
      }
    }
    for (i = 0; i < releases.length; i++) {
      list = fingerprints(releases[i]);
      for (j = 0; j < list.length; j++) {
        if (list[j].hex === hex) return { entry: list[j], index: i };
      }
    }
    return null;
  }

  function toHex(buffer) {
    var bytes = new Uint8Array(buffer);
    var out = "";
    for (var i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
    return out;
  }

  function setupChecker() {
    var box = document.getElementById("checker");
    if (!box) return;
    var input = document.getElementById("check-file");
    var zone = document.getElementById("check-drop");
    var result = document.getElementById("check-result");
    var nojs = document.getElementById("check-nojs");
    var canHash = window.crypto && window.crypto.subtle && window.Blob && Blob.prototype.arrayBuffer && window.Promise;
    if (!input || !zone || !result || !canHash) return;

    box.hidden = false;
    if (nojs) nojs.hidden = true;
    var current = 0;

    function say(kind, text) {
      result.className = "check-result" + (kind ? " check-" + kind : "");
      result.textContent = text;
    }

    function check(file) {
      var run = ++current;
      var GITHUB = {};
      say("", "Checking " + file.name + "…");
      file.arrayBuffer()
        .then(function (buf) { return window.crypto.subtle.digest("SHA-256", buf); })
        .then(function (digest) {
          var hex = toHex(digest);
          return getReleases().then(function (list) { return { hex: hex, list: list }; }, function () { throw GITHUB; });
        })
        .then(function (got) {
          if (run !== current) return;
          var releases = publishedReleases(got.list);
          var any = releases.some(function (r) { return fingerprints(r).length > 0; });
          if (!any) {
            say("", "GitHub hasn't listed the fingerprints for this release yet. Try again later.");
            return;
          }
          var match = findMatch(releases, file.name, got.hex);
          if (!match) {
            say("bad", "\u2717 This file doesn't match any BubbleFacts download. Delete it and download it again from this page.");
          } else if (match.index === 0) {
            say("ok", "\u2713 This is the genuine " + match.entry.name + " from GitHub.");
          } else {
            say("ok", "\u2713 This is the genuine " + match.entry.name + " from GitHub. It's an older version. The newest is " + versionOf(releases[0]) + ".");
          }
        })
        .catch(function (err) {
          if (run !== current) return;
          if (err === GITHUB) say("", "Couldn't reach GitHub to check. Try again in a minute.");
          else say("bad", "Couldn't read that file. Try choosing it again.");
        });
    }

    input.addEventListener("change", function () {
      var file = input.files && input.files[0];
      if (file) check(file);
      input.value = "";
    });

    ["dragenter", "dragover"].forEach(function (type) {
      zone.addEventListener(type, function (e) { e.preventDefault(); zone.classList.add("is-over"); });
    });
    ["dragleave", "drop"].forEach(function (type) {
      zone.addEventListener(type, function () { zone.classList.remove("is-over"); });
    });
    zone.addEventListener("drop", function (e) {
      e.preventDefault();
      var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) check(file);
    });
    // A file dropped next to the box shouldn't make the browser open it.
    document.addEventListener("dragover", function (e) { e.preventDefault(); });
    document.addEventListener("drop", function (e) { e.preventDefault(); });
  }

  function macAlternative(alt, current) {
    if (!alt) return;
    var other = current === "mac-arm64" ? "mac-x64" : "mac-arm64";
    alt.textContent = "";
    var link = document.createElement("a");
    link.setAttribute("data-asset", other);
    link.href = assetUrls[other] || RELEASES_PAGE;
    link.textContent = other === "mac-x64" ? "Need the Intel version?" : "Need the Apple silicon version?";
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
    // Open the linked section and any collapsed sections around it.
    for (var el = target; el; el = el.parentElement) {
      if (el.tagName === "DETAILS") el.open = true;
    }
    if (target && target.scrollIntoView) target.scrollIntoView();
  }

  setupDownload();
  loadRelease();
  setupChecker();
  setupCopy();
  openFromHash();
  window.addEventListener("hashchange", openFromHash);
})();
