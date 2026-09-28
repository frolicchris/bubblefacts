# Contributing

Thanks for helping. The most useful contributions are reports of wrong facts
and bugs, and neither needs you to write code.

## Report a wrong fact

If a bubble generated from Wikipedia showed something untrue, or a fact about
the wrong song,
[open a "A fact is wrong" issue](https://github.com/frolicchris/stream-facts-overlay/issues/new/choose).
Accuracy is the point of this project, so these reports matter most. Include
the lines starting with `[Grounding]` and `[Screen]` from your log if you can;
they show which Wikipedia article was used.

## Topic packs are examples

The packs in `topics/` are examples that show the format and make the overlay
work on first run. They aren't maintained, and pull requests that add to or
change them won't be accepted. Streamers keep their own packs on their own
machine; the README explains how.

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
5. Update the docs if you changed behaviour or a setting. The README is written
   for streamers, not programmers: plain words, no unexplained jargon.

For anything bigger than a small fix, open an issue first so we can agree on
the approach before you spend time on it.

## Questions

Setup questions are welcome in
[Discussions](https://github.com/frolicchris/stream-facts-overlay/discussions),
where the answer can help the next person too, or on
[Discord](https://discord.gg/rgm4zTMEr) for a quick chat.

By taking part, you agree to the [code of conduct](CODE_OF_CONDUCT.md).
