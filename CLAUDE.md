# Stream Facts Overlay

OBS overlay that shows verified trivia about the song a StreamerSongList
queue says is playing. Node 20+, TypeScript backend compiled with `tsc`,
plain JS overlay. Read `docs/ARCHITECTURE.md` before changing the fact
pipeline — it records the constraints that were learned on live streams.

## Commands
```bash
npm run typecheck   # tsc --noEmit — the type gate
npm test            # jest, ~1 s (transpile-only; types come from tsc)
npm run lint        # eslint on the overlay, shellcheck on the scripts
npm run build       # compile to dist/
bash scripts/start-overlay.sh
```

## Rules
- Everything runs compiled (`node dist/backend/server.js`). No ts-node-dev.
- Never commit `.env`. It holds the StreamerSongList token.
- OBS animations: `transform` and `opacity` only.
- There is deliberately **no LLM verification pass**. Accuracy comes from
  grounding + deterministic screening. Sharpen the prompt before adding layers.
- Never ask the model for facts without a reference. No article → topic packs.
- Partial results are never padded from the topic packs.
- Topic packs (`topics/*.json`, one per genre, merged by `TOPIC`) contain only
  hand-verified lines. Don't pad a small pack with unverified facts.
