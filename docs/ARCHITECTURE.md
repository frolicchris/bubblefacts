# Architecture

```
StreamerSongList ──(Centrifugo WS + 15s poll)──► Backend ──WebSocket──► OBS overlay
                                                    │
                                         grounding → generate → screen
```

| File | Role |
|---|---|
| `backend/src/songlist-client.ts` | StreamerSongList REST + realtime; resolves the now-playing entry |
| `backend/src/centrifugo-client.ts` | Unidirectional Centrifugo WebSocket reader |
| `backend/src/fact-generator.ts` | Prompts, providers (Ollama / OpenAI-compatible / Anthropic), cache, pipeline |
| `backend/src/fact-verifier.ts` | Wikipedia grounding, article-relevance guard, deterministic screening |
| `backend/src/stat-facts.ts` | Facts built from the queue entry itself (play count, note, requester) |
| `backend/src/topic.ts` | Loads `topics/<TOPIC>.json` |
| `backend/src/server.ts` | Express + WebSocket server, `/health` |
| `frontend/obs/` | The OBS browser-source overlay (plain HTML/CSS/JS, no build step) |

## The pipeline, per song

1. **Resolve** the now-playing entry (`playing` slot, else head of queue).
2. **Classify**: live learn → banner only. Original composition → entry facts, no lookup.
3. **Ground**: search Wikipedia for the game/work, reject irrelevant matches, fetch the extract.
4. **Generate**: the model restates the extract under strict rules, at low temperature.
5. **Screen**: every sentence is checked against the extract by string comparison — names, years, platforms, awards/sales language, meta-commentary, length, duplicates.
6. **Fall back**: no article, or nothing survived → topic-pack facts, with no model call.
7. **Broadcast** `new_song` immediately and `facts_ready` when done; the overlay drops batches for songs that already ended.

## Non-obvious constraints — read before changing these

**The StreamerSongList API needs a token for everything.** The platform was
rebuilt in August 2026. There are no public read endpoints any more — even
`GET /queue` returns `401 missing authorization header`. `SSL_ACCESS_TOKEN`
is mandatory and the process refuses to start without it. It is a Streamer
Access Token (Settings → Access); `SSL_TOKEN_KIND` switches the header scheme
to `User` or `Bearer` for the other token types.

**Realtime is Centrifugo, not Socket.IO.** The old Socket.IO v2 client, its
`join-room` / `queue-update` events, and the `socket.io-client` pin are all
gone. `centrifugo-client.ts` reads the *unidirectional* endpoint
(`/connection/uni_websocket`): connect, send the channel list once, read
frames. The public channels `streamer:{id}` and `streamer:{id}-queue` need no
auth. Every queue event is handled the same way — refetch `GET /queue` — so a
renamed or unrecognised event costs one poll interval, not correctness.

**Use the `playing` slot, not `items[0]`.** The queue response is now
`{ items, playing, total }` with a real now-playing state. `items[0]` is the
*next* song. We fall back to `items[0]` only when `playing` is null, for
streamers who leave `promoteQueueToPlaying` off. Old field names moved too:
`list` → `items`, `comment` → `note`.

**Do not use ts-node-dev.** It cannot resolve extensionless TS imports on
Node 24+. Everything runs compiled: `tsc` then `node dist/backend/server.js`.
`dev:backend` and `start-overlay.sh` both do this.

**Wikipedia search never returns "no result".** `list=search` always hands
back a best fuzzy match, so a song with no article does not fail — it grounds
on something unrelated and the model writes five *faithful* facts about the
wrong work. Live, one of the streamer's own compositions grounded on "The Last
of Us season 1". Screening cannot catch this class: the facts do match the
reference; the reference is what's wrong. `isRelevantArticle` is the guard,
and it must stay in front of every grounding lookup.

Two related rules in `fact-verifier.ts`: requests must NOT pass `origin=*` (a
browser-CORS parameter that buys nothing from Node and forces the strictest
anonymous rate-limit bucket — it is how we hit 429s in testing), and a 429
must never be cached as "this game has no article". Grounding is cached per
*game*, not per song, because a set usually works through one soundtrack.

**Song lists often put the game in the `artist` field.** Titles are frequently track names
("Sunshine Coastline"), and the game ("Ys VIII: Lacrimosa of Dana") is in
`artist` — the opposite of how the field names read. `resolveGameAndTrack`
encodes this and is the single place to change it. Getting it backwards is
silent, not loud: Wikipedia finds nothing for a bare track name, grounding
returns empty, and every song quietly falls through to curated facts. If the
overlay suddenly goes generic for everything, check this first.

**Accuracy is the prompt's job, not a verifier's.** There is deliberately no
LLM verification pass. Asking the same small model to grade its own output
added latency, dropped song-specific facts on a coin flip, and pushed the
overlay toward generic curated filler. Instead:

- the prompt is framed as *restating a source*, not recalling trivia, with the
  reference first and every rule a test the model can apply to its own
  sentence ("does this name appear in the SOURCE?");
- `screenClaims` does the only checking, and every check is a string
  comparison against that reference — years and platform names must appear in
  it, so wrong-console and wrong-year claims die deterministically;
- decoding runs at `OLLAMA_TEMPERATURE=0.2`, because restating a source is a
  copying task and high temperature is what makes a small model wander off it.

There are exactly three outcomes, and the middle one is the load-bearing rule:

| Grounding | What runs |
|---|---|
| Article found | Model writes from it — song-specific facts |
| No article | `CURATED_FACTS` directly, **no model call** |
| Generation failed / nothing survived | `CURATED_FACTS` |

**Never ask the model for "general video game music facts."** That was tried;
with no reference there is nothing for screening to check, and it produced
confident errors (it credited Final Fantasy VII to Yoko Shimomura). Hand-written
facts beat invented ones, so the no-reference path skips inference entirely.

Also: **partial results are never padded** from `CURATED_FACTS` — four
song-specific facts beat four plus one about Tetris. Keep the pool comfortably
larger than `FACTS_PER_SONG` so unknown songs don't all show the same bubbles.
Covered by tests in `fact-verifier.test.ts`.

**OBS animations: `transform` and `opacity` only.** OBS renders the browser
source off-screen with hardware acceleration disabled. Animating `box-shadow`,
`filter`, `width`, etc. spikes CPU and drops frames.

**`llama3.2` (3B) is the intended model — write prompts for it.** It had been
ignoring the grounding reference even when the reference contained the answer
(it invented three different wrong composers for Ys VIII across runs). The
levers that move a model this small are concrete and mechanical, not
rhetorical: put the reference *before* the task, name the game explicitly
(`resolveGameAndTrack` reads it off the entry), tell it what to write
*instead of* a guess rather than only forbidding the guess, and keep
temperature low. Vague instructions like "be accurate" or "don't hallucinate"
do nothing at this size. Prefer sharpening the prompt over adding a checking
layer.

## Overlay

- Connects to `ws://localhost:3000/ws`. Under `file://` (the recommended OBS Local File setup) the URL is hard-coded, so the page renders and reconnects regardless of whether the server was up when OBS launched.
- `appearAtSecond` is treated as *spacing* from batch arrival, not an offset from song start; a batch that lands 40 s in still shows every bubble.
- A `song` identity guard discards facts for a song that is no longer current.
- Style flushes use a forced reflow, not `requestAnimationFrame`, because rAF is paused while OBS isn't rendering the source.
