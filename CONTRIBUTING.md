# Contributing

Thanks for helping. There are three useful ways to contribute, and none of
them needs you to write code.

## Report a wrong fact

If a bubble showed something untrue, or a fact about the wrong song,
[open a "A fact is wrong" issue](https://github.com/frolicchris/stream-facts-overlay/issues/new/choose).
Accuracy is the point of this project, so these reports matter most. Include
the lines starting with `[Grounding]` and `[Screen]` from your log if you can;
they show which Wikipedia article was used.

## Add facts to a topic pack

The topic packs in `topics/` are the hand-checked facts shown when a song has
no Wikipedia article. `film` and `pop` are the smallest and most in need of
help.

Every fact must:

- **be checked against a source you can link**, such as the Wikipedia article
  about the song, composer or game. Put the link in your pull request;
- be one sentence, under 160 characters, readable at a glance;
- be a fact, not an opinion ("arrangement is composition too" is an opinion);
- avoid awards, chart positions and sales figures. The overlay rejects those
  claims from the AI because they're so often wrong, so the packs don't use
  them either.

To add a whole new genre, copy an existing file in `topics/`, change the
`id`, `name`, `description` and facts, and mention it in the README's topic
pack table.

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
where the answer can help the next person too.

By taking part, you agree to the [code of conduct](CODE_OF_CONDUCT.md).
