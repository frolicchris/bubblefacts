# Contributing

Thanks for helping. The most useful contributions are reports of wrong facts
and bugs, and neither needs you to write code.

## Report a wrong fact

If a bubble generated from Wikipedia showed something untrue, or a fact about
the wrong song,
[open a "A fact is wrong" issue](https://github.com/frolicchris/bubblefacts/issues/new/choose).
Accuracy is the point of this project, so these reports matter most. Include
the lines starting with `[Grounding]` and `[Screen]` from your log if you can;
they show which Wikipedia article was used.

## Topic packs are examples

The packs in `topics/` are examples that show the format and make the overlay
work on first run. They aren't maintained, and pull requests that add to or
change them won't be accepted. Streamers keep their own packs on their own
machine: in the app under **Settings → Backup facts → Your own facts**, or
as described in [docs/MANUAL-SETUP.md](docs/MANUAL-SETUP.md#your-backup-facts)
for the command-line version.

Improvements to how packs are *loaded or used* are welcome like any other code
change.

## Change the code

1. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), especially the section
   for the part you're changing. Most of the unusual choices exist because of
   something that went wrong on a live stream.
2. Install [Node.js](https://nodejs.org/en/download) 20 or newer and
   [ShellCheck](https://www.shellcheck.net), then run `npm install`.
3. Make your change, with a test if it fixes a bug.
4. Run `npm run check`. It type-checks, lints and tests everything in about
   ten seconds, and it's the same check that runs automatically on every pull
   request.
5. Update the docs if you changed behavior or a setting. The README and
   [docs/MANUAL-SETUP.md](docs/MANUAL-SETUP.md) are written for streamers,
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
behind it are in [docs/DESKTOP-APP.md](docs/DESKTOP-APP.md).

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

**Releases** are made by pushing a version tag, such as `v2.0.0`. The Release
workflow builds every installer on its own system and puts them in a *draft*
release with a `SHA256SUMS.txt` file and a build-provenance attestation for
each file, for a person to read over and publish.

**Test the overlay in a real OBS**, not only in a web browser. OBS loads a
Local file from `http://absolute/<path>`, which a browser doesn't reproduce, so
a bug there only shows up in OBS.

## Questions

Setup questions are welcome in
[Discussions](https://github.com/frolicchris/bubblefacts/discussions),
where the answer can help the next person too, or on
[Discord](https://discord.gg/gXdVKc6KWx) for a quick chat.

By taking part, you agree to the [code of conduct](CODE_OF_CONDUCT.md).
