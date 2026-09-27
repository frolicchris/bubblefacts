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

## Design decisions

Each of these was learned from real use. Read them before changing the pipeline.

**Accuracy comes from the source, not from a second model.** There is no LLM
verification pass. Having the same small model grade its own output added
latency and dropped good facts at random. Instead the prompt frames the job as
restating a source, and `screenClaims` checks every sentence against that
source by string comparison: names, years, platforms, award and sales language.

**No source, no model call.** Asked for "general video game music facts"
without a reference, a 3B model states confident errors (Final Fantasy VII
credited to the wrong composer) and nothing can check them. Songs with no
article get facts from the queue entry plus the hand-verified topic pack.

**Partial results are never padded.** Four facts about the right song beat
four plus one unrelated one.

**Wikipedia search never says "no result".** It returns a best fuzzy match,
so a song with no article grounds on something merely similar and the model
writes faithful facts about the wrong work. Screening can't catch that, which
is why `isRelevantArticle` guards every lookup: it compares token sequences,
respects installment numbers ("Final Fantasy X" is not "Final Fantasy"),
rejects titles that merely contain the subject, and reads Wikipedia's
disambiguators ("(video game)", "(band)", "(Debussy)").

**Song lists put the game in the artist field.** Titles are usually track
names. `resolveGameAndTrack` is the one place that encodes this. If every song
suddenly falls back to curated facts, check it first.

**Only a real "no article" is cached.** A timeout or rate limit means the
lookup never happened, so it is not remembered. Real misses expire after ten
minutes. Grounding is cached per game, since a set often works through one
soundtrack.

**Prompts are written for a 3B model.** What moves a model that small is
mechanical: the source before the task, the game named explicitly, a
replacement for each forbidden guess ("if the source names no composer, write
about something else"), and low temperature. "Be accurate" does nothing.

**StreamerSongList.** Every endpoint needs `SSL_ACCESS_TOKEN`. Use the queue's
`playing` slot; `items[0]` is the *next* song and is only a fallback for
streamers who don't use now-playing. Realtime events arrive through
Centrifugo's unidirectional WebSocket, and every event is handled the same
way, by refetching the queue, so an unrecognised event costs at most one poll
interval.

**OBS.** Browser sources render without GPU acceleration: animate only
`transform` and `opacity`. Load the overlay as a Local File, because a URL
source that fails at OBS startup never retries.

## Overlay

- Connects to `ws://localhost:3000/ws`. Under `file://` (the recommended OBS Local File setup) the URL is hard-coded, so the page renders and reconnects regardless of whether the server was up when OBS launched.
- `appearAtSecond` is treated as *spacing* from batch arrival, not an offset from song start; a batch that lands 40 s in still shows every bubble.
- A `song` identity guard discards facts for a song that is no longer current.
- Style flushes use a forced reflow, not `requestAnimationFrame`, because rAF is paused while OBS isn't rendering the source.
- Banner and bubble timers are tracked separately, so a fact batch arriving right after a song change can't cancel the banner's fade-out.
