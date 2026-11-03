# BubbleFacts website

The public page for the BubbleFacts desktop app, published at
<https://bubblefacts.frolic.org/>.

Plain static files: ten HTML pages, one stylesheet, one small script, and
images. No build step and no server code. The only outside request is the
download script asking GitHub's public API for the newest release.

| File | What it is |
|---|---|
| `index.html` | Home page: pitch, download button, how it works, FAQ |
| `download.html` | Signing note, one main Mac button (Apple silicon) with a small Intel link and "Which Mac do I have?", the other downloads, first-launch steps, the beta box, the BubbleFacts Lite box, updating, and a collapsed "For security-conscious users and developers" with the in-browser checker and the file names and commands |
| `guide.html` | Step-by-step setup, then "Make it yours" (your facts and display settings) |
| `troubleshooting.html` | What you see, why, and what to do, as one table |
| `requirements.html` | System requirements, High quality, speed, BubbleFacts Lite, fallback when the built-in AI can't run |
| `changelog.html` | What's new in each version |
| `uninstall.html` | Removing the app, its settings and the AI model |
| `support.html` | Where to get help and report problems |
| `privacy.html` | What the app sends where |
| `credits.html` | Credits, licenses, "Built with Llama" notice |
| `assets/site.css` | All styles |
| `assets/site.js` | Picks the right download for the visitor's computer, switches beta wording to stable, Copy buttons, opens linked FAQ answers, plays the home page clip with a Pause button |
| `assets/favicon.svg`, `assets/favicon-32.png`, `favicon.ico`, `assets/apple-touch-icon.png` | Browser tab and home screen icons |
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
| `BubbleFacts-VERSION-lite-mac-arm64.dmg` and the rest with `-lite` | BubbleFacts Lite, with no AI (from 2.2.0) |
| `bubblefacts-lite_VERSION_amd64.deb` | BubbleFacts Lite for Ubuntu, Debian and similar |
| `SHA256SUMS.txt` | Checksums for all of the above |

Betas are published as GitHub prereleases, which GitHub's `/releases/latest`
link ignores. So the pages don't use fixed links. Instead:

- Every download link has a `data-asset` attribute (`mac-arm64`, `mac-x64`,
  `windows-x64`, `linux-appimage`, `linux-deb`, `sha256sums`, and for Lite the
  same with `lite-` in front, such as `lite-mac-arm64`) and a plain
  `href` to the GitHub Releases page. The full app's patterns skip Lite's
  files. The Lite box (`data-lite-shown`, and `data-beta-lite` in the beta box)
  shows only when that release has Lite installers.
- `assets/site.js` asks
  `https://api.github.com/repos/frolicchris/bubblefacts/releases?per_page=30`,
  takes the newest full release with installers, and matches its files by the end of
  their names (`PATTERNS` at the top of the script).
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

Words that are only true before 2.0.0 (the download page's "BubbleFacts
test version" and its signing note, the home page's "Not signed yet:"
line, the guide's signing note, the support page's "While a new version is
being tested", the changelog's "Coming soon" tag for 2.0.0) sit next to their stable wording, each marked:

- `data-beta-only` for beta wording, `data-stable-only` for stable wording.
- `assets/site.js` adds the class `site-stable` to `<html>` when GitHub lists
  a full (not pre-release) 2.x release with installers, and `site-beta` when
  it lists only betas. `assets/site.css` hides the other wording.
- So the site switches to stable wording **by itself** the moment 2.0.0 is
  published, with no upload.
- Without JavaScript, or if GitHub can't be reached, the **site default** in
  `assets/site.css` decides. It's stable.

New beta-only wording gets `data-beta-only` and a `data-stable-only` twin
(or none, if nothing should show after 2.0).

## Since version 2.0.0

Done in 2.0.0: the site default is stable. The beta wording and its markers
can be deleted at leisure; nothing depends on them.
