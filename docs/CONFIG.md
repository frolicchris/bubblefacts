# Settings

Every setting lives in the `.env` file in the overlay folder, one per line:

```env
SETTING_NAME=value
```

Anything after a `#` is a note to yourself and is ignored. After changing a
setting, stop the overlay (Ctrl-C in its window) and start it again.

**Most people only need two settings:** `SSL_STREAMER_NAME` and
`SSL_ACCESS_TOKEN`. Everything else has a default that works. If your song
requests come through StreamElements instead, see
[Your StreamElements account](#your-streamelements-account). To follow a text
file your music app writes, such as Streamling's or Nightbot's, see
[A now playing file](#a-now-playing-file).

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
| `SSL_PLATFORM` | `twitch` | The platform your channel is on, as StreamerSongList names it (`twitch` for Twitch). |
| `SSL_POLL_INTERVAL_MS` | `15000` | How often, in milliseconds, the overlay double-checks your queue in case it missed a change. Between 2000 and 300000. |
| `SSL_REQUEST_TIMEOUT_MS` | `5000` | How long to wait for StreamerSongList before giving up on one check. |
| `SSL_ENV`, `SSL_API_BASE`, `SSL_EVENTS_URL` | *production* | For testing against StreamerSongList's test servers. Leave them out. |

---

## Your StreamElements account

Use these instead of the StreamerSongList settings if viewers request songs
through StreamElements' song request player (Media Request). You then don't
need `SSL_STREAMER_NAME` or `SSL_ACCESS_TOKEN`.

To find your JWT token:

1. Open your StreamElements dashboard.
2. Open **Account**, then **Channels**.
3. Click **Show secrets** and copy the **JWT token**. It works like a password, so keep it off your stream.

| Setting | Default | What it does |
|---|---|---|
| `SONG_SOURCE` | `streamersonglist` | Where song requests come from: `streamersonglist` or `streamelements` (or `nowplaying`, see [A now playing file](#a-now-playing-file)). |
| `SE_CHANNEL` | the token's channel | Your StreamElements channel name (optional: the token already says which channel). BubbleFacts also uses it as your name, for spotting your own compositions. |
| `SE_JWT` | *required with StreamElements* | Lets the overlay see what your song request player is playing. Keep it private. |
| `SE_POLL_INTERVAL_MS` | `15000` | How often, in milliseconds, the overlay double-checks the player in case it missed a change. Between 5000 and 300000. |
| `SE_REQUEST_TIMEOUT_MS` | `5000` | How long to wait for StreamElements before giving up on one check. |
| `YOUTUBE_API_KEY` | *none* | Optional. A YouTube Data API key from Google. With it, for YouTube's auto-generated uploads (channels ending in "- Topic") only, the video ID is sent to Google and the exact artist and song are read from the video's description instead of guessed from its title. Each lookup uses 1 unit of the key's daily quota. Restrict the key to the YouTube Data API, and keep it private. |

Good to know:

- Facts only appear while the player is playing. When it's paused, the current song stays, and resuming carries on as normal; when nothing is playing, the overlay clears.
- If StreamElements says a song is playing but the overlay can't see which one for 30 seconds, it reports the connection as degraded (the desktop app shows "Reconnecting to StreamElements" and, if it lasts, restarts the server).
- StreamElements only knows each request's YouTube title, such as "Artist - Song (Official Video)". BubbleFacts reads the song and artist out of it, so a clearly titled video gets better facts than "my fav song!!".
- There are no live learns with StreamElements, so `LIVE_LEARNS` does nothing. Your notes about your own compositions show only when a request's artist is your channel name or `STREAMER_DISPLAY_NAME`. A tag alone isn't enough, so a friend's piece never gets them.

---

## A now playing file

Some apps write the song playing now into a text file, one line, for OBS to
show. BubbleFacts can follow that file instead of a request queue. Set
`SONG_SOURCE=nowplaying` and these:

| Setting | Default | What it does |
|---|---|---|
| `NOW_PLAYING_FILE` | *required with a now playing file* | The text file to follow. A full path, or with a preset just the file's name. |
| `NOW_PLAYING_FORMAT` | `artist-title` (`youtube-title` with either preset) | How the line reads: `artist-title` for "Artist - Title", `title` for the title alone, or `youtube-title` for a YouTube video's title such as "Artist - Song (Official Video)". |
| `NOW_PLAYING_PRESET` | *none* | `streamling` reads Streamling's `Documents\streamling\livetext\nowplaying-minimal.txt` (Windows); `nightbot` reads the newest `.txt` in `Documents/Nightbot` (Windows and Mac). Both read the line as a YouTube title. Either way `NOW_PLAYING_FILE` can stay empty. If your Documents folder lives in OneDrive, the preset looks there when the usual `Documents` folder doesn't have the app's folder. |

Good to know:

- An empty or missing file means no song, and the overlay clears.
- A file that hasn't changed for 15 minutes counts as no song too, so last night's song never comes back when you start streaming.
- The file says nothing about who asked or how long the song is, so facts built from those don't appear. Neither do live learns.
- The line is read every 2 seconds. A new song shows once two checks in a row agree, so expect about 2 to 4 seconds.
- Nightbot's file is written by its desktop app, so the app has to be running while you play. Nightbot's own docs don't name the file or its line, so BubbleFacts takes the newest `.txt` in the folder and drops a trailing "requested by ..." or "added by ...".
- A line with a title and no artist (a YouTube title like "Song - Official Music Video") gets an artist only when MusicBrainz knows exactly one artist with a recording of that title. Common titles stay without one. Such a song shows basic facts from the databases, no AI captions.

---

## You and your music

| Setting | Default | What it does |
|---|---|---|
| `STREAMER_DISPLAY_NAME` | your channel name | Your name in play-count facts ("Jane has played this 3 times") and for spotting your own compositions. Never sent to the AI. |
| `INSTRUMENT` | *none* | No longer used. Nothing about you is sent to the AI: only the song and its article. |
| `TOPIC` | `video-game,classical,film,pop,general` | Which topic packs (files of facts in `topics/`) to use when a song has no Wikipedia article, separated by commas. The default uses the example packs; list your own pack's name to use it, or set it to nothing (`TOPIC=`) for no custom facts, so a song without an article gets no bubbles. The desktop app never uses the example packs, only the facts you type in its Settings. Keep `general`, or your own pack with originals lines, if you play your own compositions. Five or more facts keep them from repeating often. The overlay only reads these files. |
| `ORIGINALS` | `on` | `on` if you play your own compositions: songs tagged "Originals" in StreamerSongList, or with you as the artist, get facts from your song list instead of a lookup. `off` looks them up like any other song. |
| `NOW_PLAYING` | `on` | `off` hides the Now Playing bubble on a song change, for when your own overlay already shows the song. |
| `CREDIT_BUBBLE` | `on` | `off` hides the credit bubble: "Facts from Wikipedia, Wikidata and MusicBrainz, retold by AI. Spot a mistake? Let the streamer know." It shows once before the first song's facts after BubbleFacts starts, then with about every 5th song that has facts, for viewers who join later. It is never shown for a song with no facts, and your song's facts start right after it. A restart in the middle of a stream carries on with the count. |
| `LIVE_LEARN_BANNER` | `on` | `off` hides the LIVE LEARN bubble that stays up during a live learn. |
| `LIVE_LEARNS` | `on` | `on` shows a LIVE LEARN banner for off-list requests; facts show only when a source knows the song. `off` treats them like any other song. |

The example packs are `video-game`, `classical`, `film`, `pop`, `piano` and
`general`. **They're only a few examples, and they aren't maintained.** Fill
in your own facts for the music you play: copy one to start your own pack.

---

## The AI model

The overlay chooses automatically: Anthropic if you've set
`ANTHROPIC_API_KEY`, the OpenAI-style option (Groq and others) if you've set
`OPENAI_API_KEY`, otherwise Ollama on your own computer.

| Setting | Default | What it does |
|---|---|---|
| `AI_PROVIDER` | *automatic* | Force a choice: `ollama`, `openai` or `anthropic`. `none` uses no AI: songs get Wikidata, MusicBrainz and custom facts only. (`builtin` is the desktop app's.) |
| `TEMPERATURE` | `0` | How freely the AI writes, from 0 to 2. Keep it at or near 0: its job is to rephrase an article faithfully, and higher values make it wander. |

### Ollama (on your own computer)

| Setting | Default | What it does |
|---|---|---|
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Where Ollama is running. |
| `OLLAMA_FALLBACK_URL` | *none* | A second computer running Ollama, tried if the first fails. |
| `OLLAMA_MODEL` | `llama3.2` | Which model to use. Download it first with `ollama pull`. |
| `OLLAMA_TIMEOUT_MS` | `90000` | How long to wait for an answer. Raise it for a slow computer; a computer that's turned off fails right away regardless. |
| `OLLAMA_KEEP_ALIVE` | `4h` | How long Ollama keeps the model loaded between songs. Its own default of five minutes is shorter than the gap between most songs, which would make every song wait for the model to reload. |

### Groq, OpenRouter, Gemini and similar services

These all use the same "OpenAI-compatible" connection. Groq is set up by default. BubbleFacts sends a short system message with every request, so choose a model that accepts one: Gemma models through Gemini's API, for example, don't.

| Setting | Default | What it does |
|---|---|---|
| `OPENAI_API_KEY` | *none* | Your key from the service. Setting it switches the overlay to this option. |
| `OPENAI_BASE_URL` | Groq | The service's address. OpenRouter: `https://openrouter.ai/api/v1`. Gemini: `https://generativelanguage.googleapis.com/v1beta/openai`. |
| `OPENAI_MODEL` | `openai/gpt-oss-20b` | The model name as your service lists it. The default is free on Groq, within its [daily limits](https://console.groq.com/docs/rate-limits). |
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
| `PROMPT_STYLE` | *unset* | How the AI's instructions are laid out. The default is CROSS (Context, Role, Objective, Source, Scope). `rules` switches to the older numbered rule list. In trials of 72 songs each, CROSS gave about three times as many chart and award facts and broke fewer rules; a few more of its captions were screened out, so one extra is requested. |
| `CITE_SENTENCES` | `off` | `on` numbers the article's sentences and has the AI name the one each caption retells, so screening checks the caption against that sentence. Off by default: small models miscount the numbers, and true captions get dropped. |
| `FACT_VERIFICATION` | `on` | `on` looks up each song on Wikipedia, has the AI write only from that article, and drops any caption the article doesn't support. With no article, it looks the song up on Wikidata, then MusicBrainz, and fills fixed sentences from their data, with no AI. `off` looks nothing up and the AI writes nothing: only your own facts, your song list's facts and your topic pack's facts show. The AI never writes facts without an article to write from. Basic facts from data can go out first, before the AI's captions, when the article is about the artist or game or is surely the song's own. |
| `MB_LINK` | `on` | When Wikipedia search finds no article for a song, `on` asks MusicBrainz for the recording and follows its own link (through Wikidata) to the song's or the artist's English Wikipedia article. The page must still be about that song or performer. `off` skips this step. |
| `ABSTAIN` | `on` | When BubbleFacts isn't sure the article is about the song playing (a series' article for one game's track, a film named like the band, the artist's article found after dropping a note, or a page Wikipedia's own summary calls a disambiguation page or a film), `on` skips the AI's captions for that song and shows only facts from Wikidata or MusicBrainz and your own facts. `off` writes captions from that article anyway. |
| `SOURCE_RISK` | `on` | `on` holds back the AI's captions that retell a risky sentence (someone's words or view, a long sentence, one the caption shortened a lot or lost a "usually" or "about" from), unless the song would show fewer than three bubbles, then shows the most interesting first, at most four. `off` shows the captions their sentences support best, in the order written, up to `FACTS_PER_SONG`. |
| `CLASSICAL_LOOKUP` | `on` | For a classical piece ("Moonlight Sonata", "Nocturne Op. 9 No. 2", "Clair de Lune" by its composer or by a pianist), `on` finds the work on Wikidata by its composer, catalog number or nickname and reads its own Wikipedia article, or the article of the larger work it belongs to ("Clair de Lune" is in "Suite bergamasque"). A film, a show or someone else's piece never stands in for it. `off` looks classical pieces up like any other song. |
| `GROUNDING_TIMEOUT_MS` | `5000` | How long to wait for a Wikipedia search. |
| `GROUNDING_EXTRACT_TIMEOUT_MS` | `15000` | How long to wait for the article itself, which can be large. |
| `WIKIPEDIA_CONTACT` | this project's page | Wikipedia asks programs that use it to leave a contact. Set it to your channel or your copy of the project. |

The content standard has no setting. Captions and facts from data are filtered to leave out
what isn't family-friendly or about the music (scandals, crime, threats,
private life) or labels who a person is, and an article edited in the last 72
hours is read as it was before. See
[the content standard](ARCHITECTURE.md#the-content-standard).

---

## Bubbles on screen

| Setting | Default | What it does |
|---|---|---|
| `FACTS_PER_SONG` | `5` | How many bubbles per song, from 1 to 12. Facts from Wikipedia, Wikidata or MusicBrainz stop at four (see `SOURCE_RISK`). Songs with short articles may get fewer. |
| `FACT_INTERVAL_SECONDS` | `15` | A new bubble every this many seconds, counted from one bubble's start to the next. From 3 to 300. |
| `FACT_DURATION_SECONDS` | `8` | Seconds each bubble stays up, from 2 to 120. Shorter than `FACT_INTERVAL_SECONDS` shows one at a time; longer, and they overlap. |

`BUBBLE_AREA` (`anywhere`, `top`, `bottom`, `left` or `right`; default
`anywhere`) keeps bubbles to one part of the screen. To put every bubble in
the same spot, use `top-left`, `top-center`, `top-right`, `bottom-left`,
`bottom-center` or `bottom-right`: a new bubble replaces the one showing
there. No bubble covers the Now Playing bubble: bottom spots sit just above
it, and low spots grow upward. With that bubble off (`NOW_PLAYING=off`, and
for a live learn `LIVE_LEARN_BANNER=off`), bottom spots are at the very bottom. The exact spots are the
lists at the top of `backend/src/fact-generator.ts`. Text size, colors and animation are at the
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

---

## Set by the desktop app

The desktop app starts the same server and passes these for you. You don't
need them with a `.env` file.

| Setting | What it does |
|---|---|
| `AI_PROVIDER=builtin`, `MODEL_PATH`, `LLAMA_GPU` | Run the app's built-in AI from the downloaded model file: Llama 3.2 3B for **Standard**, Llama 3.1 8B for **High quality** (Settings, Advanced). While a switch downloads the new one, `MODEL_PATH` stays on the one already there. `LLAMA_GPU=off` uses the processor only. `AI_PROVIDER=none` shows custom facts only. |
| `SSL_CLIENT_ID`, `SSL_STREAMER_ID` | Sent with the app's StreamerSongList sign-in: the app's client ID, and the channel's ID so it's found without its name. |
| `BUBBLEFACTS_TOPICS_DIR` | A folder of your own packs, checked before the examples in `topics`. |
| `BUBBLEFACTS_LOG_DIR` | Where `songs.log` goes. |
| `BUBBLEFACTS_PAUSED` | `1` starts the server with bubbles paused, so a restart while paused stays paused. |
| `BUBBLEFACTS_DATA_DIR` | Where `wrong-facts.json` (sources marked **Wrong**, per song), `song-facts.json` (the streamer's facts for particular songs) and `session.json` (what the current stream has shown) go. Without it, the overlay uses a `data` folder in the overlay folder. |
| `YOUTUBE_API_KEY` | The YouTube Data API key built into the app, if its build had one (see [Your StreamElements account](#your-streamelements-account)). |
