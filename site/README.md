# BubbleFacts website

The public page for the BubbleFacts desktop app, published at
<https://bubblefacts.frolic.org/>.

Plain static files: nine HTML pages, one stylesheet, one small script, and
images. No build step and no server code. The only outside request is the
download script asking GitHub's public API for the newest release.

| File | What it is |
|---|---|
| `index.html` | Home page: pitch, download button, how it works, FAQ |
| `download.html` | Beta note, one main Mac button (Apple silicon) with a small Intel link and "Which Mac do I have?", the other downloads, first-launch steps, and a collapsed "Check your download (optional)" with the in-browser checker and a "For developers" part |
| `guide.html` | Step-by-step setup and troubleshooting |
| `requirements.html` | System requirements, speed, fallback when the built-in AI can't run |
| `changelog.html` | What's new in each version |
| `uninstall.html` | Removing the app, its settings and the AI model |
| `support.html` | Where to get help and report problems |
| `privacy.html` | What the app sends where |
| `credits.html` | Credits, licenses, "Built with Llama" notice |
| `assets/site.css` | All styles |
| `assets/site.js` | Picks the right download for the visitor's computer, Copy buttons, opens linked FAQ answers |
| `assets/favicon.svg` | Browser tab icon |
| `assets/demo.png`, `assets/social-preview.png` | Copied from `docs/` in the repo |

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
its troubleshooting table, the "Opening it the first time" section and the
signing note under "Check your download" in `download.html`.

## When version 2.0.0 ships

Change its "Coming soon" tag in `changelog.html` to the release date.
