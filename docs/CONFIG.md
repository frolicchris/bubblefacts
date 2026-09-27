Configuration
=============

All settings live in `.env` in the project folder. Copy `.env.example` to
start. Restart the server after changing anything; overlay styling changes in
`frontend/obs/obs-overlay.css` only need a Refresh of the OBS source.

A setting with a bad value (a typo, a number out of range) stops the server at
startup with a message naming it, rather than running with a surprise.

StreamerSongList
----------------

* `SSL_STREAMER_NAME` **required**
  Your channel name on streamersonglist.com.

* `SSL_ACCESS_TOKEN` **required**
  Every API call needs it, including reading the queue. Create one at
  streamersonglist.com under **Settings → Access**. Keep it out of screenshots
  and never commit `.env`.

* `SSL_TOKEN_KIND` default `streamer`
  `streamer` for a Settings → Access token, `user` for a Profile → API Access
  token (covers every channel you administrate), `bearer` for an OAuth2 token.

* `SSL_PLATFORM` default `twitch`

* `SSL_POLL_INTERVAL_MS` default `15000` (2000–300000)
  How often the queue is re-read as a safety net for missed realtime events.

* `SSL_REQUEST_TIMEOUT_MS` default `5000`

* `SSL_ENV`, `SSL_API_BASE`, `SSL_EVENTS_URL`
  Only for testing against StreamerSongList's staging environment.

Performer and content
---------------------

* `STREAMER_DISPLAY_NAME` default: `SSL_STREAMER_NAME`
  How prompts and fallback facts name you: "performed live by Jane".

* `INSTRUMENT` default: empty
  "piano", "guitar"… With it the prompt says "playing X on piano"; without it,
  "performing X".

* `TOPIC` default `video-game,classical,film,pop,general`
  One topic pack or a comma-separated list from `topics/`, merged. Pick the
  genres your channel plays; keep `general`, which holds the lines used for
  your own compositions. Together they need at least five facts.

Model
-----

* `AI_PROVIDER` default `ollama`
  `ollama`, `openai` (any OpenAI-compatible endpoint), or `anthropic`. If
  unset and an API key for one of the others is present, that one is used.

* `TEMPERATURE` default `0.2`
  Applies to every provider. Keep it low: the model is restating a source,
  and higher values make it wander.

* `OLLAMA_BASE_URL` default `http://localhost:11434`
* `OLLAMA_FALLBACK_URL` default: none
  A second machine to try if the first fails.
* `OLLAMA_MODEL` default `llama3.2`
* `OLLAMA_TIMEOUT_MS` default `90000`
  Size it to your slowest host. Unreachable hosts fail immediately anyway.
* `OLLAMA_KEEP_ALIVE` default `4h`
  Ollama unloads idle models after five minutes, which is shorter than the
  gap between songs.

* `OPENAI_API_KEY` required when `AI_PROVIDER=openai`
* `OPENAI_BASE_URL` default `https://api.groq.com/openai/v1`
  OpenRouter: `https://openrouter.ai/api/v1`.
  Gemini: `https://generativelanguage.googleapis.com/v1beta/openai`.
* `OPENAI_MODEL` default `llama-3.1-8b-instant`
* `OPENAI_TIMEOUT_MS` default `30000`

* `ANTHROPIC_API_KEY` required when `AI_PROVIDER=anthropic`
* `ANTHROPIC_MODEL` default `claude-haiku-4-5-20251001`

Accuracy
--------

* `FACT_VERIFICATION` default `on`
  `on` grounds every song in its Wikipedia article and screens the output.
  `off` lets the model write from memory: faster, and wrong often enough to
  notice on stream.

* `GROUNDING_TIMEOUT_MS` default `5000`
  Wikipedia search.
* `GROUNDING_EXTRACT_TIMEOUT_MS` default `15000`
  Article download; larger because it fetches the whole article.

* `WIKIPEDIA_CONTACT` default: this project's repository
  Wikimedia asks API clients to identify themselves. Set it to your channel or
  fork URL.

Display
-------

* `FACTS_PER_SONG` default `5` (1–12)
* `FACT_INTERVAL_SECONDS` default `15`
  Gap between bubbles. Keep it above `FACT_DURATION_SECONDS` so only one
  bubble is on screen at a time.
* `FACT_DURATION_SECONDS` default `8`

Bubble positions are the `POSITIONS` array in `backend/src/fact-generator.ts`
(rebuild after editing). Font size, colours and animation are CSS variables at
the top of `frontend/obs/obs-overlay.css`.

Server
------

* `PORT` default `3000`
  If you change it, also change `PORT` at the top of
  `frontend/obs/obs-overlay.js`, which the Local File overlay uses to find the
  server.
