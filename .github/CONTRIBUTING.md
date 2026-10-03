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
   [ShellCheck](https://www.shellcheck.net), then run `npm ci`. It installs
   Electron and the built-in AI's native parts too (several hundred MB).
   Changing only the server or the overlay? `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci`
   skips the Electron download, as CI does.
3. Make your change, with tests: a bug fix gets a test that fails without
   it, and new behavior gets tests that cover it. Examples in code, tests
   and test data use made-up names, not a real streamer's or viewer's. Don't
   name the website's host or describe its setup anywhere in the repository.
4. Run `npm run check`. It type-checks, lints and tests everything in about
   ten seconds. The same check runs on every pull request; `main` only accepts
   a change through a pull request whose **ci-ok** check passed. On Windows,
   ShellCheck usually isn't installed, so run `npm run typecheck` and
   `npm test` instead (CI lints on Linux and macOS).
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
npm test            # jest, a few seconds: the server and the desktop app
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
3. `npm run app` builds the app and runs it in development. On Linux, the
   packaged app runs its fact server under a bundled Node.js because the
   built-in AI crashes under Electron's own runtime there; from source it
   uses Electron's, so choose an online AI or Ollama in Settings while
   developing on Linux.
4. `npm run dist` builds installers for your own system into `release/`.

On a Mac whose Desktop or Documents folder is synced by iCloud, build into a
folder outside it, or code signing fails on the metadata Finder adds:

```bash
npx electron-builder --mac --arm64 -c.directories.output=/tmp/bubblefacts-release
```

**Test builds for every system:** on GitHub, go to **Actions → Release → Run
workflow**. The installers appear as downloadable artifacts on the run. This
works in forks too.

**Releases** are made by the maintainer; how, and how builds get signed, is
in [docs/RELEASING.md](../docs/RELEASING.md).

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

## Questions

Setup questions are welcome in
[Discussions](https://github.com/frolicchris/bubblefacts/discussions),
where the answer can help the next person too.

By taking part, you agree to the [code of conduct](CODE_OF_CONDUCT.md).
