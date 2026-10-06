# BubbleFacts website

The public page for the BubbleFacts desktop app, published at
<https://bubblefacts.frolic.org/>.

Plain static files: ten HTML pages, one stylesheet, one small script, and
images. No build step and no server code. The only outside request is the
download script asking GitHub's public API for the newest release.

| File | What it is |
|---|---|
| `index.html` | Home page: pitch, download button, how it works, FAQ |
| `download.html` | Beta note, one main Mac button (Apple silicon) with a small Intel link and "Which Mac do I have?", the other downloads, first-launch steps, and a collapsed "Check your download (optional)" with the in-browser checker and a "For developers" part |
| `guide.html` | Step-by-step setup, then "Make it yours" (your facts and display settings) |
| `troubleshooting.html` | What you see, why, and what to do, as one table |
| `requirements.html` | System requirements, speed, fallback when the built-in AI can't run |
| `changelog.html` | What's new in each version |
| `uninstall.html` | Removing the app, its settings and the AI model |
| `support.html` | Where to get help and report problems |
| `privacy.html` | What the app sends where |
| `credits.html` | Credits, licenses, "Built with Llama" notice |
| `assets/site.css` | All styles |
| `assets/site.js` | Picks the right download for the visitor's computer, switches beta wording to stable, Copy buttons, opens linked FAQ answers, plays the home page clip with a Pause button |
| `assets/favicon.svg` | Browser tab icon |
| `assets/social-preview.png` | Copied from `docs/` in the repo |
| `assets/demo.mp4`, `assets/demo-poster.jpg` | Home page clip and its still frame, recorded from the real overlay with `docs/record-demo-video.mjs` |

Every page has the same header, footer and social-preview tags. If you add a
page or change the menu, update the `<header>` and `<footer>` in every page.

All links between pages are relative, so the site works from any folder.

## Preview on your computer

```bash
cd site
python3 -m http.server 8000
```

Then open <http://localhost:8000/>. Press Ctrl-C to stop.

## Publish

Upload the **contents** of `site/` (not the `site` folder itself) to any
static web host. `README.md` doesn't need to go up.

After uploading, check:

- <https://bubblefacts.frolic.org/> loads with its images and styles.
- The download button names your computer and its link works.
- Pasting the page link into Discord shows the preview image.

## Download links

Release files have the version in their names, for example for `2.0.0-beta.1`:

| File | For |
|---|---|
| `BubbleFacts-VERSION-mac-arm64.dmg` | Macs with Apple silicon (M1 and newer) |
| `BubbleFacts-VERSION-mac-x64.dmg` | Intel Macs |
| `BubbleFacts-VERSION-windows-x64.exe` | Windows |
| `BubbleFacts-VERSION-linux-x86_64.AppImage` | Other Linux |
| `bubblefacts_VERSION_amd64.deb` | Ubuntu, Debian and similar |
| `SHA256SUMS.txt` | Checksums for all of the above |

Betas are published as GitHub prereleases, which GitHub's `/releases/latest`
link ignores. So the pages don't use fixed links. Instead:

- Every download link has a `data-asset` attribute (`mac-arm64`, `mac-x64`,
  `windows-x64`, `linux-appimage`, `linux-deb`, `sha256sums`) and a plain
  `href` to the GitHub Releases page.
- `assets/site.js` asks
  `https://api.github.com/repos/frolicchris/bubblefacts/releases?per_page=10`,
  takes the first release that isn't a draft (prereleases count), and matches
  its files by the end of their names (`PATTERNS` at the top of the script).
  It then points each link at the matching file.
- Elements with `data-release-version` show the version number, and links with
  `data-release-link` go to that release's page.
- The download checker on `download.html` reuses the same data. It hashes the chosen file with `crypto.subtle` in the browser and compares it with each file's `digest` (`sha256:<hex>`), or with `<hex>  <file name>` lines in the release notes. It matches by name first, then by fingerprint alone, across the fetched releases.
- The answer is kept in `sessionStorage` for 10 minutes, to stay well under
  GitHub's limit of 60 API requests an hour per visitor.
- If the request fails or a file is missing, that link stays on the Releases
  page. With JavaScript off, every link goes there too, so no link is ever dead.
- On a Mac, the main button is Apple silicon, with a small "Need the Intel version?" link below it.
  Chrome and Edge can report an Intel Mac, and then the two swap.

If the release pipeline changes the file names, update `PATTERNS` in
`assets/site.js` and the example names shown in `download.html`.

Every file is built by GitHub Actions with a build-provenance attestation.
`download.html` shows the check:
`gh attestation verify FILE --repo frolicchris/bubblefacts`.

## When the app is signed

`guide.html` and `download.html` explain the macOS and Windows warnings for
unsigned builds. Once builds are signed, remove the "About the security
warnings" note and first-launch steps in `guide.html`, the first two rows of
`troubleshooting.html`, the "Opening it the first time" section and the
signing note under "Check your download" in `download.html`.

## Beta or stable wording

Words that are only true during the beta (the download page's "BubbleFacts
2.0 beta" and "Beta note", the home page's "Beta:" line, the guide's signing
note, the support page's "While BubbleFacts is in beta", the changelog's
"Coming soon" tag for 2.0.0) sit next to their stable wording, each marked:

- `data-beta-only` for beta wording, `data-stable-only` for stable wording.
- `assets/site.js` adds the class `site-stable` to `<html>` when GitHub lists
  a full (not pre-release) 2.x release with installers, and `site-beta` when
  it lists only betas. `assets/site.css` hides the other wording.
- So the site switches to stable wording **by itself** the moment 2.0.0 is
  published, with no upload.
- Without JavaScript, or if GitHub can't be reached, the **site default** in
  `assets/site.css` decides. Until 2.0.0 it's beta.

New beta-only wording gets `data-beta-only` and a `data-stable-only` twin
(or none, if nothing should show after 2.0).

## When version 2.0.0 ships

1. In `assets/site.css`, under "SITE DEFAULT", change the rule to
   `html:not(.site-stable):not(.site-beta) [data-beta-only]` and the comment
   to "SITE DEFAULT: stable." That's the one change: visitors without
   JavaScript now see stable wording too.
2. Change the 2.0.0 entry in `changelog.html` to the release date, as for
   any version.
3. Upload the changed files, then open the download page in a private window
   and check it says "Newest version (2.0.0)".

Later, the beta wording and its markers can be deleted at leisure; nothing
depends on them.
