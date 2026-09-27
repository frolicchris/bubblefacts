# Stream Facts Overlay

Pop-up trivia for music streams. Watches your [StreamerSongList](https://streamersonglist.com)
queue, and when a song starts, RPG-style dialog boxes appear in OBS with a
few true things about it.

![Overlay demo](docs/demo.png)

Facts are **grounded, not recalled**: the backend finds the song's Wikipedia
article, hands that text to a language model with instructions to restate it,
and then checks every sentence against the article. Names, years and
platforms the article doesn't contain get dropped. When no article exists,
it falls back to hand-verified facts from a topic pack instead of letting the
model guess. Details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Runs entirely on your machine with a free local model, or against a hosted
free tier if you'd rather not run one.

## What you need

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
and starts the server. Leave it running while you stream.

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

To confirm it's working before you go live, open
`http://localhost:3000/obs-overlay?test=1` in a browser: a test bubble draws
immediately with no server round-trip. And `bash scripts/check-overlay.sh`
tells you whether OBS has actually connected.

## Choosing a model

| Provider | Cost | Setup | Notes |
|---|---|---|---|
| **Ollama** `llama3.2` | free | local install | Default. Private. ~8 s per song on an M-series Mac. |
| **Groq** via `AI_PROVIDER=openai` | free tier | API key | ~1 s per song. 1,000 requests/day cap. |
| **OpenRouter / Gemini** | free tiers | API key + `OPENAI_BASE_URL` | Same code path as Groq. |
| **Anthropic** Claude Haiku | fractions of a cent per song | API key | Best quality per dollar. |

The prompts were written for a 3-billion-parameter model and work upward from
there. A larger model mostly buys you fewer dropped sentences, not different
facts, because the facts come from the article either way.

## Topic packs

When a song has no article, the overlay shows hand-verified facts from the
topic packs in `topics/`. Set `TOPIC` to the genres your channel plays:

| Pack | Facts | Covers |
|---|---|---|
| `video-game` | 24 | Game composers, sound chips, soundtracks |
| `classical` | 7 | Piano repertoire and composers |
| `film` | 3 | Film and TV scores |
| `pop` | 2 | Pop and rock |
| `general` | 10 | Music and the piano in general, plus lines for your own compositions |

```env
TOPIC=classical,film,general   # a classical pianist
```

The default is all five. `film` and `pop` are small, so pull requests with
verified facts are welcome. Every line should be something you've checked
yourself; that is the entire point of the pool. To make your own pack, copy
any file in `topics/` and add its name to `TOPIC`.

### Your own compositions

Tag your originals in StreamerSongList with an attribute containing the word
"original", or put your name in the artist field. The overlay skips the
article lookup for them (there isn't one) and builds facts from the entry
itself: play count, your note, who requested it, plus the pack's
`originalsFacts`.

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
| `TOPIC` | all five packs | Which topic packs supply fallback facts |
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
| No article, or article about something else | Topic-pack facts directly, **no model call** |
| Model failed or nothing survived screening | Topic-pack facts |
| Your original composition | Facts from the queue entry, no lookup |
| Live learn | Banner only |

Partial results are never padded. Four facts about the right song beat four
plus one about Tetris.

## Health and logs

- `curl localhost:3000/health` reports the current song, connected overlay
  clients, and a per-outcome count (grounded, curated, original, live learn)
  for this session.
- `logs/overlay-<timestamp>.log` is the full server log, `logs/latest.log` a
  symlink to it.
- `logs/songs.log` is one line per song: time, title, game, outcome, fact
  count. Good for a post-stream look at what viewers saw.

## Development

```bash
npm run check       # typecheck + lint + tests, the full gate
npm run typecheck   # tsc in strict mode with unused-code checks
npm run lint        # eslint on the overlay, shellcheck on the scripts
npm test            # jest, about a second
npm run build       # compile the backend to dist/
```

Everything runs compiled. There is no dev transpiler on purpose.

## Notes and caveats

- **Coverage follows Wikipedia.** Well-known games, films, pop songs and
  classical works ground well. Obscure tracks and small indie games often have
  no article, and those songs get entry facts and topic-pack facts instead.
  That is by design: no article means no model call.
- **Screening checks the model against the article, not the article against
  reality.** A fact is only as correct as the Wikipedia text it came from.
- **English Wikipedia only**, and one streamer per running server.
- **Expect some sentences to be dropped.** The model is asked for two more
  lines than are shown, and screening removes any it can't support. On a thin
  article you may see fewer bubbles than `FACTS_PER_SONG`.
- **The overlay finds the server on port 3000.** If you change `PORT`, change
  it at the top of `frontend/obs/obs-overlay.js` too.
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
