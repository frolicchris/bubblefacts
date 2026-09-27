# Stream Facts Overlay

Pop-up trivia for music streams. Watches your [StreamerSongList](https://streamersonglist.com)
queue, and when a song starts, RPG-style dialog boxes appear in OBS with a
few true things about it.

![Overlay demo](docs/demo.png)

Facts are **grounded, not recalled**: the backend finds the song's Wikipedia
article, hands that text to a language model with instructions to restate it,
and then checks every sentence against the article. Names, years and
platforms the article doesn't contain get dropped. When no article exists,
it falls back to hand-verified facts from the topic packs for the genres you
play, instead of letting the model guess. Details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Runs entirely on your machine with a free local model, or against a hosted
free tier if you'd rather not run one.

## What you need

- macOS or Linux for the helper scripts. On Windows the server itself runs
  fine: skip the scripts and use `npm run build` then `npm start`.
- Node.js 20 or newer
- A StreamerSongList account and a **Streamer Access Token** (Settings → Access)
- One of: [Ollama](https://ollama.com) installed locally (default), a
  [Groq](https://console.groq.com) / OpenRouter / Gemini API key, or an
  Anthropic API key
- OBS Studio 28 or newer

## Quick start

```bash
git clone https://github.com/frolicchris/stream-facts-overlay.git
cd stream-facts-overlay
npm install
cp .env.example .env
```

Edit `.env`: set `SSL_STREAMER_NAME` and `SSL_ACCESS_TOKEN`. If you're using
Ollama, run `ollama pull llama3.2` once. Then:

```bash
bash scripts/start-overlay.sh
```

The script checks your token, your model, and the port, builds if needed,
and starts the server. Leave it running while you stream. Without the script
(on Windows, say), run `npm run build` once and then `npm start`.

### Add the overlay to OBS

Add a **Browser Source** to the scene you stream from:

| Setting | Value |
|---|---|
| **Local File** | checked → `frontend/obs/obs-overlay.html` in this folder |
| Width / Height | `1920` / `1080` |
| Custom CSS | *(empty)* |
| Refresh browser when scene becomes active | checked |

Use Local File rather than the URL. OBS loads every browser source the moment
it starts, and if the server isn't up yet a URL source shows a blank error
page and never retries. A local file always loads and reconnects on its own,
so start order stops mattering.

Keep the source at position 0,0 and scale 1.0. The song banner sits at the
bottom of the page, and a scaled transform clips it.

To check rendering on its own, open `frontend/obs/obs-overlay.html?test=1` in
a browser: a test bubble and banner draw without the server. To check the
connection, run `bash scripts/check-overlay.sh`, which reports whether OBS has
connected. A small red dot in the overlay's bottom-right corner means it can't
reach the server; it disappears once connected.

## Choosing a model

| Provider | Cost | Setup | Notes |
|---|---|---|---|
| **Ollama** `llama3.2` | free | local install | Default. Private. ~8 s per song on an M-series Mac. |
| **Groq** via `AI_PROVIDER=openai` | free tier | API key | Hosted and fast. Daily request cap. |
| **OpenRouter / Gemini** | free tiers | API key + `OPENAI_BASE_URL` | Same code path as Groq. |
| **Anthropic** Claude Haiku | fractions of a cent per song | API key | Best quality per dollar. |

The prompts were written for a 3-billion-parameter model and work upward from
there. A larger model mostly buys you fewer dropped sentences, not different
facts, because the facts come from the article either way.

## Where facts come from

Nothing is stored between streams except what you write yourself.

- **Live facts** are generated when a song starts: its Wikipedia article is
  fetched, the model restates it, and screening filters the result. They're
  held in the server's memory for the session so a repeat of the song is
  instant, and they're gone when the server stops. Nothing generated is
  written to disk or to the topic packs.
- **Queue-entry facts** (play count, your note, the requester) come from
  StreamerSongList each time and are never cached for your own compositions,
  so they stay current.
- **Topic packs** are the hand-written files in `topics/`. They are the
  fallback, used only when a song has no usable article or generation fails.
  The overlay only reads them.
- **`logs/songs.log`** records which of those paths each song took, not the
  facts themselves.

## Topic packs

When a song has no article, the overlay shows hand-verified facts from the
topic packs in `topics/`. Set `TOPIC` to the genres your channel plays:

| Pack | Facts | Covers |
|---|---|---|
| `video-game` | 24 | Game composers, sound chips, soundtracks |
| `classical` | 7 | Piano repertoire and composers |
| `film` | 8 | Film and TV scores |
| `pop` | 7 | Pop and rock songs and songwriters |
| `piano` | 4 | The instrument, plus an originals line for solo pianists (not in the default) |
| `general` | 6 | Music in general, plus lines for your own compositions |

```env
TOPIC=classical,film,piano,general   # a classical pianist
```

The default is every pack except `piano`, since its originals line assumes a
solo pianist; add it if that's you. The packs together must hold at least five facts.
Every line in them was checked against a source, which is the point of the
pool; please do the same in a pull request. To make your own pack, copy any
file in `topics/` and add its name to `TOPIC`.

### Your own compositions

Tag your originals in StreamerSongList with an attribute such as "Originals"
or "Jane's Originals", or set the artist field to your channel name, your
`STREAMER_DISPLAY_NAME`, or a credit containing `@yourchannel`. The overlay skips the
article lookup for them (there isn't one) and builds facts from the entry
itself: play count, your note, who requested it, plus the `originalsFacts`
lines from your packs. Those live in `general`, so keep it in `TOPIC`, or add
your own `originalsFacts` to a pack you use.

### Live learns

A request that isn't on your song list shows a persistent **LIVE LEARN**
banner with the title and requester instead of fact bubbles.

## Configuration

Everything is in `.env`. [docs/CONFIG.md](docs/CONFIG.md) documents every
option with its default. The ones you will actually touch:

| Variable | Default | Purpose |
|---|---|---|
| `SSL_STREAMER_NAME` | — | Your StreamerSongList channel |
| `SSL_ACCESS_TOKEN` | — | Required on every API call |
| `AI_PROVIDER` | `ollama` | `ollama`, `openai`, or `anthropic` |
| `TOPIC` | all but `piano` | Which topic packs supply fallback facts |
| `STREAMER_DISPLAY_NAME` | `SSL_STREAMER_NAME` | How prompts and banners name you |
| `INSTRUMENT` | *(empty)* | "piano", "guitar"… used in the prompt |
| `FACTS_PER_SONG` | `5` | Bubbles per song |
| `FACT_VERIFICATION` | `on` | `off` skips grounding: fast and often wrong |

Bubble positions are a fixed array in `backend/src/fact-generator.ts`, laid
out for a song-queue panel top-left and a camera top-right. Move them for your
scene. Colours, fonts and animation live in `frontend/obs/obs-overlay.css`.

## How it decides what to show

| Grounding result | What runs |
|---|---|
| Article found and relevant | Model restates it; every sentence is screened against it |
| No article, or article about something else | Queue-entry facts plus topic-pack facts, **no model call** |
| Model failed or nothing survived screening | Queue-entry facts plus topic-pack facts |
| Your original composition | Facts from the queue entry, no lookup |
| Live learn | Banner only |

Partial results are never padded. Four facts about the right song beat four
plus one about Tetris.

## Health and logs

- `curl 127.0.0.1:3000/health` reports the current song, connected overlay
  clients, and per-session counts: `grounded`, `original`, `liveLearn`,
  `noReference`, `nothingSurvived`, `generationFailed` and `cacheHits`.
- `logs/overlay-<timestamp>.log` is the full server log, `logs/latest.log` a
  symlink to it.
- `logs/songs.log` is one tab-separated line per song: time, title, the artist
  field (usually the game), outcome, and fact count. Good for a post-stream
  look at what viewers saw.

## Development

```bash
npm run check       # typecheck + lint + tests, the full gate
npm run typecheck   # tsc in strict mode with unused-code checks
npm run lint        # eslint on the overlay, shellcheck on the scripts
npm test            # jest, about a second
npm run build       # compile the backend to dist/
```

Linting the scripts needs [shellcheck](https://www.shellcheck.net). Everything
runs compiled; there is no dev transpiler on purpose.

## Notes and caveats

- **Coverage follows Wikipedia.** Well-known games, films, pop songs and
  classical works ground well. Obscure tracks and small indie games often have
  no article, and those songs get entry facts and topic-pack facts instead.
  That is by design: no article means no model call.
- **Screening checks the model against the article, not the article against
  reality.** A fact is only as correct as the Wikipedia text it came from.
- **English Wikipedia only**, and one streamer per running server.
- **The server listens on 127.0.0.1 only**, because it has no authentication.
  If OBS runs on another machine, set `HOST=0.0.0.0` on a network you trust,
  and set `SERVER` at the top of `frontend/obs/obs-overlay.js` to the server's
  address.
- **Expect some sentences to be dropped.** The model is asked for two more
  lines than are shown, and screening removes any it can't support. On a thin
  article you may see fewer bubbles than `FACTS_PER_SONG`.
- **The overlay finds the server at 127.0.0.1:3000.** If you change `PORT`,
  change `SERVER` at the top of `frontend/obs/obs-overlay.js` to match; a
  Local File source can't be given the address any other way.
- **Built against the StreamerSongList API as of 2026.** If they change it,
  the song-list client is the one file to update.

## How this was built

This project was written with [Claude Code](https://claude.com/claude-code),
Anthropic's AI coding agent, directed by frolicchris, a network and security
engineer who plays piano requests on Twitch. Almost none of the code was typed
by hand.

What a person did: decided what it should do, ran it on live streams, read the
logs afterwards, and pushed back when it was wrong. The design decisions in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) came from that loop, and the bugs
found on stream have regression tests in `backend/src/*.test.ts`.

It is shared as a useful tool, not as a claim of hand-written craft. Judge the
code on its merits. Issues and pull requests are welcome.

## Attribution

Facts are restated from Wikipedia, whose text is licensed
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). If you
publish recordings, a line crediting Wikipedia in your description is the
courteous thing to do.

## License

[MIT](LICENSE). Built by [frolicchris](https://twitch.tv/frolicchris) for a
piano request stream.
