# Contributing

Thanks for helping. The most useful contributions are reports of wrong facts
and bugs, and neither needs you to write code.

## Report a wrong fact

If a bubble showed something untrue, or a fact about the wrong song,
[open an "A fact is wrong" issue](https://github.com/frolicchris/bubblefacts/issues/new?template=wrong_fact.yml).
Accuracy is the point of this project, so these reports matter most. In the
app, click **Wrong** next to the fact, then **Report it (opens GitHub)**: the
report is filled in for you. Otherwise, include the lines starting with
`[Grounding]` and `[Screen]` from your log if you can; they show which
Wikipedia article was used.

## YouTube titles that read wrong

With StreamElements, BubbleFacts works out the artist and song from each
request's YouTube title. Every real title that was read wrong belongs in
`backend/src/fixtures/youtube-titles.json`, labeled by hand with the artist
and song a person would read, the uploading channel, and where it came from
(for example `"source": "stream 2026-09-30"`). The tests read every entry, so
a fix can't quietly break an older title. Swap a small creator's name for an
invented one of the same shape. Add the title even if you can't fix
the rule yourself. [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md#song-sources-and-youtube-titles)
explains how titles are read.

## Topic packs are examples

The packs in `topics/` are examples that show the format and make the overlay
work on first run. They aren't maintained, and pull requests that add to or
change them won't be accepted. Streamers keep their own packs on their own
machine: in the app under **Settings**, then **Custom facts**, or
as described in [docs/MANUAL-SETUP.md](../docs/MANUAL-SETUP.md#your-custom-facts)
for the command-line version.

Improvements to how packs are *loaded or used* are welcome like any other code
change.

## Change the code

1. Read [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md), especially the section
   for the part you're changing. It explains each integration (StreamerSongList,
   StreamElements, YouTube titles, Wikipedia, Wikidata, MusicBrainz, **Wrong**)
   and why it works the way it does. Most of the unusual choices exist because
   of something that went wrong on a live stream.
2. Install [Node.js](https://nodejs.org/en/download) 20 or newer and
   [ShellCheck](https://www.shellcheck.net), then run `npm install`.
3. Make your change, with a test if it fixes a bug. Examples in code, tests
   and test data use made-up names, not a real streamer's or viewer's.
4. Run `npm run check`. It type-checks, lints and tests everything in about
   ten seconds. The same check runs on every pull request, on Linux, macOS
   and Windows; `main` only accepts a change through a pull request whose
   **ci-ok** check passed.
5. Changed `dependencies`? Run `node scripts/third-party-notices.mjs` so
   `THIRD-PARTY-NOTICES.md` lists every package the app ships, with its license.
6. Your name goes in `AUTHORS.md` (under Contributors) in the same pull
   request, and in that release's notes.
7. Update the docs if you changed behavior or a setting. The README and
   [docs/MANUAL-SETUP.md](../docs/MANUAL-SETUP.md) are written for streamers,
   not programmers: plain words, no unexplained jargon.

For anything bigger than a small fix, open an issue first so we can agree on
the approach before you spend time on it.

The commands, one by one:

```bash
npm run check       # all of the below; also runs on every push and pull request
npm run typecheck   # TypeScript in strict mode, tests included
npm run lint        # eslint on the overlay and the app's screens, shellcheck on the scripts
npm test            # jest, about a second: the server and the desktop app
npm run build       # compile the server to dist/
```

The server always runs compiled; there's no development transpiler on purpose.

## Working on the desktop app

The app is Electron. It starts the same server as the command-line version and
adds setup, settings, sign-in and the built-in AI. The design and the reasons
behind it are in [docs/DESKTOP-APP.md](../docs/DESKTOP-APP.md).

1. `npm ci` to install exactly the versions in `package-lock.json`.
2. `npm run check` type-checks, lints and tests everything, including the
   app's tests in `desktop/src/*.test.ts`.
3. `npm run app` builds the app and runs it in development.
4. `npm run dist` builds installers for your own system into `release/`.

On a Mac whose Desktop or Documents folder is synced by iCloud, build into a
folder outside it, or code signing fails on the metadata Finder adds:

```bash
npx electron-builder --mac --arm64 -c.directories.output=/tmp/bubblefacts-release
```

**Test builds for every system:** on GitHub, go to **Actions → Release → Run
workflow**. The installers appear as downloadable artifacts on the run. This
works in forks too.

**Releases** are made by the maintainer pushing a version tag, such as
`v2.0.0`. Version tags are protected, so a published release's tag can't be
moved or deleted. The Release workflow builds every installer on its own
system and puts them in a *draft* release with a `SHA256SUMS.txt` file and a
build-provenance attestation for each file, for a person to read over and
publish. A tag with a hyphen (`v2.0.0-beta.3`) becomes a pre-release.

The workflow reads the `YOUTUBE_API_KEY` repository secret, if it's set, and
writes it into `package.json` for that build only, so StreamElements songs
from YouTube's auto-generated uploads are read exactly. Never commit the key.
Restrict it to the YouTube Data API in Google Cloud. Builds without it,
including forks and local builds, read every title from the video title
alone. To try it locally, set `YOUTUBE_API_KEY` in your environment before
`npm run app`.

**Test the overlay in a real OBS**, not only in a web browser. OBS loads a
Local file from `http://absolute/<path>`, which a browser doesn't reproduce, so
a bug there only shows up in OBS.

### Code signing

Builds are signed only when the repository has the secrets below; without
them (and in forks) they come out unsigned, as now. The release log's
**Report signing** step says which.

**Mac (Apple Developer Program, $99 a year):**

1. Enroll at [developer.apple.com/programs](https://developer.apple.com/programs/) as an individual.
2. In Xcode or the developer site, create a **Developer ID Application** certificate and export it with its key as a `.p12` file with a password.
3. In App Store Connect, under Users and Access, Integrations, create an **App Store Connect API key** for notarization and download the `.p8` file.
4. Add repository secrets: `MAC_CERT_P12_BASE64` (`base64 -i cert.p12`), `MAC_CERT_PASSWORD`, `APPLE_API_KEY_P8` (the `.p8` file's text), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`.

Signed and notarized, the Mac app opens without the "unidentified developer"
steps, and macOS stops asking for the keychain again after each update.

**Windows (Azure Artifact Signing, formerly Trusted Signing, billed monthly):**

1. In Azure, create an Artifact Signing account, complete identity validation, and create a public-trust certificate profile.
2. Create an app registration with the certificate profile signer role on the account.
3. Add secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET`, and repository variables `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE` and `AZURE_SIGNING_PUBLISHER` (the certificate's subject name).

Once both are signed, remove the first-launch steps from `site/guide.html`
and `site/download.html` (see `site/README.md`).

### Release checklist

Before publishing a draft release, check the packaged app, not only the source.
The tests can't see what OBS or an installer does.

1. The version in `package.json` and the `obs-overlay.js` header match the tag.
2. The Release workflow passed for every system, and the draft has every
   installer, `SHA256SUMS.txt` and `bubblefacts.zip`.
3. Run the **Smoke** workflow on the Release run's artifacts:
   `gh workflow run smoke.yml -f run=RUN_ID`. (A draft release can't be
   downloaded by the workflow's read-only token, so test the run that built
   it.) Every system passes, including writing and keeping captions.
4. Download one installer from the draft. Its checksum matches the draft's
   `SHA256SUMS.txt`, and `gh attestation verify FILE --repo
   frolicchris/bubblefacts --source-ref refs/tags/vX.Y.Z` passes.
5. Install it and open it. The setup screen appears and shows the new version
   at the bottom.
6. Sign in, then drag the tile into a test scene in a real OBS. The test bubble
   appears in OBS and the app says **It's on your stream!**
7. Play one song from the queue. The Now Playing bubble and facts appear.
8. Quit from the menu bar or tray. Nothing is left running.
9. While in beta, add the new version to the top of the version list in
   `.github/ISSUE_TEMPLATE/beta_test.yml` (a test fails until you do).
   Publish as a pre-release. The draft's notes start from
   `.github/release-template.md`: fill in New, Improved, Fixed and Thanks
   (the same lines as the website's changelog), delete empty sections and
   the comments, and keep the checksums. Releases are immutable once published:
   a mistake in a file is fixed with a new version, never by replacing it.
10. Upload the changed `site/` files to the website and check each one against
    `main`.

## Questions

Setup questions are welcome in
[Discussions](https://github.com/frolicchris/bubblefacts/discussions),
where the answer can help the next person too, or on
[Discord](https://discord.gg/gXdVKc6KWx) for a quick chat.

By taking part, you agree to the [code of conduct](CODE_OF_CONDUCT.md).
