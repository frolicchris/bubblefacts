# Settings

Every setting lives in the `.env` file in the overlay folder, one per line:

```env
SETTING_NAME=value
```

Anything after a `#` is a note to yourself and is ignored. After changing a
setting, stop the overlay (Ctrl-C in its window) and start it again.

**Most people only need two settings:** `SSL_STREAMER_NAME` and
`SSL_ACCESS_TOKEN`. Everything else has a default that works.

If a setting has a typo or an impossible value (a word where a number belongs,
or a number that's out of range), the overlay refuses to start and tells you
which one. Names and web addresses are used as written, so double-check those.

---

## Your StreamerSongList account

`SSL` in these names is short for StreamerSongList.

| Setting | Default | What it does |
|---|---|---|
| `SSL_STREAMER_NAME` | *required* | Your channel name on streamersonglist.com. |
| `SSL_ACCESS_TOKEN` | *required* | Lets the overlay read your queue. Create one under **Settings → Access**. Keep it private. |
| `SSL_TOKEN_KIND` | `streamer` | Only change this if you use a different kind of token: `user` for one from **Profile → API Access** (it covers every channel you manage), or `bearer` for an OAuth token. |
| `SSL_PLATFORM` | `twitch` | The platform your channel is on. |
| `SSL_POLL_INTERVAL_MS` | `15000` | How often, in milliseconds, the overlay double-checks your queue in case it missed a change. Between 2000 and 300000. |
| `SSL_REQUEST_TIMEOUT_MS` | `5000` | How long to wait for StreamerSongList before giving up on one check. |
| `SSL_ENV`, `SSL_API_BASE`, `SSL_EVENTS_URL` | *production* | For testing against StreamerSongList's test servers. Leave them out. |

---

## You and your music

| Setting | Default | What it does |
|---|---|---|
| `STREAMER_DISPLAY_NAME` | your channel name | The name used when talking about you: "performed live by Jane". |
| `INSTRUMENT` | *none* | Your instrument, such as `piano` or `guitar`. With it, the AI is told you're "playing *the song* on piano"; without it, just "performing" it. |
| `TOPIC` | `video-game,classical,film,pop,general` | Which topic packs (files of facts in `topics/`) to use when a song has no Wikipedia article, separated by commas. The default uses the example packs; list your own pack's name to use it. Keep `general`, or your own pack with originals lines, if you play your own compositions. Together they need at least five facts. The overlay only reads these files. |

The example packs are `video-game`, `classical`, `film`, `pop`, `piano` and
`general`. They aren't maintained; copy one to start your own.

---

## The AI model

The overlay chooses automatically: Anthropic if you've set
`ANTHROPIC_API_KEY`, the OpenAI-style option (Groq and others) if you've set
`OPENAI_API_KEY`, otherwise Ollama on your own computer.

| Setting | Default | What it does |
|---|---|---|
| `AI_PROVIDER` | *automatic* | Force a choice: `ollama`, `openai` or `anthropic`. |
| `TEMPERATURE` | `0.2` | How freely the AI writes, from 0 to 2. Keep it low: its job is to rephrase an article faithfully, and higher values make it wander. |

### Ollama (on your own computer)

| Setting | Default | What it does |
|---|---|---|
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Where Ollama is running. |
| `OLLAMA_FALLBACK_URL` | *none* | A second computer running Ollama, tried if the first fails. |
| `OLLAMA_MODEL` | `llama3.2` | Which model to use. Download it first with `ollama pull`. |
| `OLLAMA_TIMEOUT_MS` | `90000` | How long to wait for an answer. Raise it for a slow computer; a computer that's turned off fails right away regardless. |
| `OLLAMA_KEEP_ALIVE` | `4h` | How long Ollama keeps the model loaded between songs. Its own default of five minutes is shorter than the gap between most songs, which would make every song wait for the model to reload. |

### Groq, OpenRouter, Gemini and similar services

These all use the same "OpenAI-compatible" connection. Groq is set up by default.

| Setting | Default | What it does |
|---|---|---|
| `OPENAI_API_KEY` | *none* | Your key from the service. Setting it switches the overlay to this option. |
| `OPENAI_BASE_URL` | Groq | The service's address. OpenRouter: `https://openrouter.ai/api/v1`. Gemini: `https://generativelanguage.googleapis.com/v1beta/openai`. |
| `OPENAI_MODEL` | `openai/gpt-oss-20b` | The model name as your service lists it. The default is free on Groq, with a limit of 1,000 requests a day as of 2026. |
| `OPENAI_TIMEOUT_MS` | `30000` | How long to wait for an answer. |

### Anthropic Claude

| Setting | Default | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | *none* | Your key from [platform.claude.com](https://platform.claude.com/settings/keys). Setting it switches the overlay to Claude. |
| `ANTHROPIC_MODEL` | `claude-haiku-4-5-20251001` | Which Claude model to use. |

---

## Fact checking

| Setting | Default | What it does |
|---|---|---|
| `FACT_VERIFICATION` | `on` | `on` looks up each song on Wikipedia, has the AI write only from that article, and drops any caption the article doesn't support. `off` lets the AI write from memory: faster, but wrong often enough that viewers will notice. Either way, captions are still cleaned up (no "Here are 5 facts:", no award or chart claims, no repeats). |
| `GROUNDING_TIMEOUT_MS` | `5000` | How long to wait for a Wikipedia search. |
| `GROUNDING_EXTRACT_TIMEOUT_MS` | `15000` | How long to wait for the article itself, which can be large. |
| `WIKIPEDIA_CONTACT` | this project's page | Wikipedia asks programs that use it to leave a contact. Set it to your channel or your copy of the project. |

---

## Bubbles on screen

| Setting | Default | What it does |
|---|---|---|
| `FACTS_PER_SONG` | `5` | How many bubbles per song, from 1 to 12. Songs with short articles may get fewer. |
| `FACT_INTERVAL_SECONDS` | `15` | Seconds between one bubble and the next. |
| `FACT_DURATION_SECONDS` | `8` | Seconds each bubble stays up. Keep this shorter than the interval so bubbles don't overlap. |

Where bubbles appear is not a setting. It's the `POSITIONS` list in
`backend/src/fact-generator.ts`. Text size, colors and animation are at the
top of `frontend/obs/obs-overlay.css`.

---

## Connection

| Setting | Default | What it does |
|---|---|---|
| `PORT` | `3000` | The port the overlay's server uses on your computer. Change it only if something else already uses 3000. |
| `HOST` | `127.0.0.1` | Which computers may connect. The default allows only your own computer, because the overlay has no password. Set `0.0.0.0` only if OBS runs on a different computer, and only on a network you trust. |

**If you change `PORT` or `HOST`**, the overlay page in OBS needs to know too,
because it can't read this file. Open `frontend/obs/obs-overlay.js`, find this
line near the top, and change it to match:

```js
const SERVER = "127.0.0.1:3000";
```

For example, `"192.168.1.20:3001"` for a server on another computer using port 3001.
