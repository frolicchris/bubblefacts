# BubbleFacts

OBS overlay that shows verified trivia about the song a StreamerSongList
queue says is playing. Node 20+, TypeScript backend compiled with `tsc`,
plain JS overlay. Read `docs/ARCHITECTURE.md` before changing the fact
pipeline — it records the constraints that were learned on live streams.

## Commands
```bash
npm run check       # typecheck + lint + tests: run before every commit
npm run typecheck   # tsc, including the tests
npm test            # jest, ~1 s (transpile-only; types come from tsc)
npm run lint        # eslint on the overlay, shellcheck on the scripts
npm run build       # compile to dist/
npm run app         # build and run the desktop app in development
npm run dist        # build installers into release/ (on iCloud-synced folders, see CONTRIBUTING.md)
bash scripts/start-overlay.sh
```
Desktop app tests live in `desktop/src/*.test.ts` and run with `npm test`.

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
- Docs are for streamers first: plain words, numbered steps, no unexplained
  jargon. Technical reasoning belongs in `docs/ARCHITECTURE.md`.
