# BubbleFacts

OBS overlay and desktop app that show verified trivia about the song a
StreamerSongList queue or StreamElements request player says is playing.
Node 20+, TypeScript backend compiled with `tsc`, plain JS overlay. Read
`docs/ARCHITECTURE.md` before changing the fact pipeline. It records the
constraints that were learned on live streams.

The rules for every contributor are in `.github/CONTRIBUTING.md`; the rules
below add to them.

## Commands
```bash
npm run check       # typecheck + lint + tests + script tests: run before every commit
npm run typecheck   # tsc, including the tests
npm test            # jest, a few seconds (transpile-only; types come from tsc)
npm run lint        # eslint on the overlay and the app's screens, shellcheck on the scripts
npm run build       # compile to dist/
npm run bump -- X.Y.Z  # set a new version everywhere a release needs it
npm run app         # build and run the desktop app in development
npm run dist        # build installers into release/ (on iCloud-synced folders, see .github/CONTRIBUTING.md)
bash scripts/start-overlay.sh
```
Desktop app tests live in `desktop/src/*.test.ts` and run with `npm test`.

## Sources of truth
Change the source first. Everything else copies from it.

| What | Source | Copies |
| --- | --- | --- |
| How it works | code on `main`, `docs/ARCHITECTURE.md` | site guide |
| What a version does | GitHub Releases | `site/changelog.html`, announcements |
| News | `.github/workflows/announce.yml` | Discussions Announcements, Discord #announcements |
| What's planned | GitHub milestones and issues | Discord "What's coming next" post, pinned in #feature-requests |
| Bugs and wrong facts | GitHub issues | none |
| Questions and answers | Discord #help | none |
| Ideas | Discord #feature-requests until approved, then a GitHub issue | none |
| How to get help | `.github/SUPPORT.md` | `site/support.html`, Discord #help "Start here" post |
| Conduct | `.github/CODE_OF_CONDUCT.md`, Discord #rules | Discord Server Rules (Access page), kept in step with #rules |
| Who to thank | `AUTHORS.md` | README, app About, site credits |
| Releases | `docs/RELEASING.md` | none |
| Website | `site/` on `main` | the live site, which must match it |

## Rules
- Everything runs compiled (`node dist/backend/server.js`). No ts-node-dev.
- Never commit `.env`. It holds the StreamerSongList token.
- OBS animations: `transform` and `opacity` only.
- There is deliberately **no LLM verification pass**. Accuracy comes from
  grounding + deterministic screening. Sharpen the prompt before adding layers.
- Never ask the model for facts without a reference. No article → topic packs,
  or nothing when the streamer has none (the app's default).
- Partial results are never padded from the topic packs.
- The packs in `topics/` are examples, not maintained content. Don't add to,
  expand, or "improve" them, and don't accept pull requests that do. Streamers
  keep their own packs.
- Test the overlay in a real OBS before a release (OBS loads Local files from
  `http://absolute/`, which a browser doesn't reproduce).
- Examples in code, tests and test data use made-up names, never a real
  streamer's or tester's. Don't name the web host or its setup anywhere in the repo.
- Docs are for streamers first: plain words, numbered steps, no unexplained
  jargon. Technical reasoning belongs in `docs/ARCHITECTURE.md`.
- Help: Discord #help is the one support channel (one post per question,
  searchable inside Discord). Ideas start in #feature-requests; approved ones
  become GitHub issues. Announcements go out through announce.yml to
  both places, never by hand.
- Call other streamers "music content creators" (they may stream on Twitch,
  Kick or elsewhere), not "other streamers".
