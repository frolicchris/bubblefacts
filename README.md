# Stream Facts Overlay

When you play a song from your request queue, little game-style dialog boxes
pop up on your stream with true facts about it.

![Three fact bubbles and a Now Playing banner over a dark background](docs/demo.png)

It works with [StreamerSongList](https://streamersonglist.com) and OBS, and it
was built for music streamers: video game music, classical, film scores, pop,
and your own compositions.

**How it keeps the facts true.** When a song starts, the overlay looks up the
song (or the game it's from) on Wikipedia and asks an AI model to rewrite a few
details from that article as short captions. Before anything reaches your
stream, it checks each caption against the article and throws out any that
mention a name, year or console the article doesn't. If there's no article, the
AI isn't used at all; you get hand-checked facts instead.

It's free to run. The AI can run on your own computer, or on a free online
service if your computer is busy enough already.

---

## Contents

- [Quick links](#quick-links)
- [Before you start](#before-you-start)
- [Setup](#setup)
- [What you'll see on stream](#what-youll-see-on-stream)
- [Making it yours](#making-it-yours)
- [Updating to a new version](#updating-to-a-new-version)
- [If something goes wrong](#if-something-goes-wrong)
- [Good to know](#good-to-know)
- [How this was built](#how-this-was-built)
- [For developers](#for-developers)

---

## Quick links

Everything you might need to download or sign up for, in one place.

**The overlay**

- [Download the latest version (ZIP)](https://github.com/frolicchris/stream-facts-overlay/releases/latest/download/stream-facts-overlay.zip)
- [All versions and what changed](https://github.com/frolicchris/stream-facts-overlay/releases)
- [Report a problem or ask a question](https://github.com/frolicchris/stream-facts-overlay/issues)

**Required**

| Tool | Download | Help |
|---|---|---|
| OBS Studio | [obsproject.com/download](https://obsproject.com/download) | [Browser source guide](https://obsproject.com/kb/browser-source) |
| Node.js (choose the LTS version) | [nodejs.org/en/download](https://nodejs.org/en/download) | |
| StreamerSongList | [streamersonglist.com](https://streamersonglist.com) | Your token is under **Settings → Access** once signed in. |

**The AI: pick one**

| Option | Get started | Notes |
|---|---|---|
| Ollama, on your computer (free) | [Mac](https://ollama.com/download/mac) · [Windows](https://ollama.com/download/windows) · [Linux](https://ollama.com/download/linux) | Then get the model: [llama3.2](https://ollama.com/library/llama3.2), with `ollama pull llama3.2`. [Ollama FAQ](https://docs.ollama.com/faq). |
| Groq (free, with a daily limit) | [Create an API key](https://console.groq.com/keys) | [Free plan limits](https://console.groq.com/docs/rate-limits) |
| Anthropic Claude (paid, cheap) | [Create an API key](https://platform.claude.com/settings/keys) | |
| OpenRouter | [Create an API key](https://openrouter.ai/keys) | See `OPENAI_BASE_URL` in [docs/CONFIG.md](docs/CONFIG.md). |
| Google Gemini | [Create an API key](https://aistudio.google.com/apikey) | See `OPENAI_BASE_URL` in [docs/CONFIG.md](docs/CONFIG.md). |

**Handy, not required**

| Tool | What it's for |
|---|---|
| [Terminal user guide (Mac)](https://support.apple.com/guide/terminal/welcome/mac) | If you haven't used Terminal before. |
| [Homebrew](https://brew.sh) | Installs developer tools on a Mac with one command. |
| [Git](https://git-scm.com/downloads) | Download and update the overlay with `git` instead of a ZIP. |
| [ShellCheck](https://www.shellcheck.net) | Only for developers running `npm run lint`. |

---

## Before you start

You'll need:

| What | Why | Where to get it |
|---|---|---|
| **OBS Studio** 28 or newer | Shows the overlay on your stream | [obsproject.com/download](https://obsproject.com/download) |
| **A StreamerSongList account** | The overlay reads your request queue from it | [streamersonglist.com](https://streamersonglist.com) |
| **Node.js** 20 or newer | Runs the overlay's small server on your computer | [nodejs.org/en/download](https://nodejs.org/en/download), the "LTS" version |
| **An AI model** | Rewrites Wikipedia text into captions | See [step 3](#3-choose-where-the-ai-runs) |

All the download links are also in [Quick links](#quick-links).

The setup steps use the Terminal on a Mac (Linux works the same way). On
Windows the overlay itself works, but the helper scripts don't; see the
Windows note in [step 5](#5-start-the-overlay).

---

## Setup

This takes about 15 minutes the first time.

### 1. Download the overlay

[Download the latest version](https://github.com/frolicchris/stream-facts-overlay/releases/latest/download/stream-facts-overlay.zip) and unzip it somewhere you'll remember,
such as your Documents folder. You'll get a folder called
`stream-facts-overlay`. (If you use git:
`git clone https://github.com/frolicchris/stream-facts-overlay.git`.)

Then open Terminal, type `cd ` (with a space), drag the `stream-facts-overlay`
folder onto the Terminal window, and press Return. Now install what it needs:

```bash
npm install
```

### 2. Get your StreamerSongList token

The overlay needs permission to read your queue.

1. Sign in at [streamersonglist.com](https://streamersonglist.com).
2. Go to **Settings → Access** and create a **Streamer Access Token**.
3. Copy it. You'll paste it in step 4.

Treat the token like a password: keep it off your stream and out of screenshots.

### 3. Choose where the AI runs

Pick one. You can switch later.

| Option | Cost | Good for |
|---|---|---|
| **Ollama** (on your computer) | Free | Privacy, and no account needed. Takes a few seconds per song on a recent Mac. |
| **Groq** (online) | Free, with a daily limit | Computers already busy with streaming. |
| **Anthropic Claude** (online) | A fraction of a cent per song | The best captions for the money. |

- **Ollama:** download it for [Mac](https://ollama.com/download/mac),
  [Windows](https://ollama.com/download/windows) or
  [Linux](https://ollama.com/download/linux) and open it once. Then run
  `ollama pull llama3.2` in Terminal to download the model (about 2 GB).
  Nothing else to set up.
- **Groq:** sign up and [create an API key](https://console.groq.com/keys).
- **Anthropic:** sign up and [create an API key](https://platform.claude.com/settings/keys).

OpenRouter and Google Gemini work too; see [docs/CONFIG.md](docs/CONFIG.md).

### 4. Fill in your settings

Your settings live in a file named `.env` in the overlay folder. Create it
from the example and open it:

```bash
cp .env.example .env
open -e .env
```

(Files starting with a dot are hidden in Finder. Press Cmd+Shift+. to show them.)

Fill in the first two lines. Everything else has a sensible default.

```env
SSL_STREAMER_NAME=yourchannel
SSL_ACCESS_TOKEN=paste-your-token-here
```

If you chose Groq or Anthropic, also add one of these:

```env
OPENAI_API_KEY=your-groq-key          # for Groq
ANTHROPIC_API_KEY=your-anthropic-key  # for Anthropic
```

Save and close the file.

### 5. Start the overlay

```bash
bash scripts/start-overlay.sh
```

It checks your token, your AI model and your settings, then starts. Any problem
is printed in red with what to do about it. **Leave this window open while you
stream**; closing it stops the overlay.

*On Windows:* run `npm run build` once, then `npm start` each time you stream.

### 6. Add it to OBS

1. In the scene you stream from, under **Sources**, click **+** and choose
   **Browser**. Name it "Stream Facts".
2. Tick **Local file**, click **Browse**, and pick
   `frontend/obs/obs-overlay.html` inside the overlay folder.
3. Set **Width** to `1920` and **Height** to `1080`.
4. Tick **Refresh browser when scene becomes active**. Leave Custom CSS empty.
5. Click **OK**. Then right-click the source and choose
   **Transform → Reset Transform**, so it fills the screen exactly.

Use **Local file**, not the URL option. A local file keeps retrying until the
overlay is running, so it doesn't matter whether you open OBS or start the
overlay first.

### 7. Check it works

Play a song from your queue. A **NOW PLAYING** banner appears at the bottom,
and a few seconds later the first fact bubble pops up.

Nothing showing? See [If something goes wrong](#if-something-goes-wrong).

---

## What you'll see on stream

| When | On screen |
|---|---|
| A song starts | A gold **NOW PLAYING** banner for five seconds, then up to five fact bubbles, one every 15 seconds. |
| A song with no Wikipedia article | Bubbles from the song's own details (how often you've played it, who requested it, your note on it) plus hand-checked facts for your genres. |
| One of **your own compositions** | Bubbles about the piece from your song list: that it's an original, play count, requester, your note. |
| A **Live Learn** (a request that isn't on your list) | A **LIVE LEARN** banner with the title and who requested it. It stays up until the next song, with no bubbles. |
| The overlay can't reach its server | A small red dot in the bottom-right corner. It disappears once reconnected. |

---

## Making it yours

All of these are lines in your `.env` file. Restart the overlay after changing it.
[docs/CONFIG.md](docs/CONFIG.md) lists every setting.

### Your genres

When a song has no Wikipedia article, the overlay shows hand-checked facts
from **topic packs**, one per genre. Choose the ones your channel plays:

```env
TOPIC=classical,film,piano,general
```

| Pack | Facts | About |
|---|---|---|
| `video-game` | 24 | Game composers, sound chips, soundtracks |
| `classical` | 7 | Composers and piano repertoire |
| `film` | 8 | Film and TV scores |
| `pop` | 7 | Pop and rock songs and songwriters |
| `piano` | 4 | The instrument itself, plus a line for solo pianists' originals |
| `general` | 6 | Music in general, plus lines for your own compositions |

The default is every pack except `piano`. Keep `general` if you play your own
music. Your choice needs at least five facts in total.

You can write your own pack: copy any file in the `topics` folder, change the
facts, and add its name to `TOPIC`. Please only include facts you've checked
against a source; that's the whole point of these packs.

### Your own compositions

The overlay recognises your originals if, in StreamerSongList, you either:

- tag them with an attribute named something like **Originals** or
  **Jane's Originals**, or
- set the artist to your channel name or your `STREAMER_DISPLAY_NAME`, or to
  a credit that includes `@yourchannel`.

It skips Wikipedia for these (there's no article) and uses what your song list
knows about the piece instead.

### How it talks about you

```env
STREAMER_DISPLAY_NAME=Jane    # instead of your channel name
INSTRUMENT=guitar             # "Jane is playing ... on guitar"
```

### How many bubbles, and how long

```env
FACTS_PER_SONG=5
FACT_INTERVAL_SECONDS=15   # time between bubbles
FACT_DURATION_SECONDS=8    # how long each stays up
```

Keep the interval longer than the duration, so only one bubble is on screen
at a time.

### The look

Colours, fonts and animation are in `frontend/obs/obs-overlay.css`. To make the
text bigger or smaller, change `--fact-font-size` near the top. Save the file,
then right-click the source in OBS and choose **Refresh**.

Where bubbles appear is set in `backend/src/fact-generator.ts` (the list called
`POSITIONS`). The defaults avoid a song-queue panel in the top-left, a camera
in the top-right, and goal widgets in the bottom-right. If they cover something
in your scene, edit the percentages there; the start script rebuilds
automatically.

---

## Updating to a new version

New versions are listed on the
[releases page](https://github.com/frolicchris/stream-facts-overlay/releases),
with what changed in each.

1. Stop the overlay (Ctrl-C in its window).
2. [Download the latest version](https://github.com/frolicchris/stream-facts-overlay/releases/latest/download/stream-facts-overlay.zip) and unzip it.
3. Copy your `.env` file from the old folder into the new one. (Press
   Cmd+Shift+. in Finder to see it.) If you edited the look or wrote your own
   topic pack, copy those files over too.
4. In Terminal, go to the new folder and run `npm install`, then start it as
   usual with `bash scripts/start-overlay.sh`.
5. In OBS, point the Browser source's **Local file** at `obs-overlay.html` in
   the new folder, if you put it somewhere different.

If you used git instead: `git pull`, then `npm install`.

---

## If something goes wrong

| What you see | Likely cause | What to do |
|---|---|---|
| A **red dot** in the corner, no bubbles | The overlay isn't running | Run `bash scripts/start-overlay.sh` and leave the window open. |
| Nothing at all, not even a red dot | OBS isn't loading the page | Check the source uses **Local file** pointing at `obs-overlay.html` and is visible. Then run `bash scripts/check-overlay.sh`, which tells you whether OBS is connected. |
| "StreamerSongList rejected the token" | Wrong or expired token | Create a new token (step 2) and paste it into `.env`. |
| "Ollama not responding" | Ollama isn't running | Open the Ollama app, or [download it](https://ollama.com/download). |
| "Model llama3.2 missing" | The model isn't downloaded | Run `ollama pull llama3.2`. |
| "Port 3000 is in use" | The overlay is already running somewhere | Close the other Terminal window running it. |
| Facts are generic, never about the song | No Wikipedia article was found | For game music, put the **game's name in the artist field** in StreamerSongList. The log line starting `[Grounding]` says what was searched. |
| Fewer bubbles than expected | Some captions failed the fact check | Normal on songs with short articles. |
| The banner is cut off at the bottom | The source is scaled | Right-click the source → **Transform → Reset Transform**. |
| Bubbles cover your camera or chat | Your layout differs from the default | See [The look](#the-look). |

To test the overlay without the server, open `frontend/obs/obs-overlay.html`
in a web browser and add `?test=1` to the end of the address. A sample bubble
and banner appear. If they show in a browser but not in OBS, the problem is in
the OBS source settings.

Still stuck? [Open an issue](https://github.com/frolicchris/stream-facts-overlay/issues)
and include the newest file from the `logs` folder, with your token removed.

---

## Good to know

- **Nothing is saved between streams.** Facts are made fresh when a song
  starts and kept in memory until you stop the overlay, so a repeated song
  shows instantly. The topic packs are only ever read, never written. The log
  file `logs/songs.log` records which way each song was handled, not the facts.
- **Facts are only as good as Wikipedia.** The check makes sure captions match
  the article; it can't tell whether the article is right.
- **Well-known works do best.** Famous games, films, pop songs and classical
  pieces have articles. Obscure tracks and small indie games often don't, so
  they get the hand-checked facts instead.
- **English Wikipedia only**, and one streamer per copy of the overlay.
- **The overlay only accepts connections from your own computer**, because it
  has no password. Running OBS on a second computer is possible; see `HOST` in
  [docs/CONFIG.md](docs/CONFIG.md).
- **Built for StreamerSongList as it worked in 2026.** If their service
  changes, the overlay may need an update.

---

## How this was built

This project was written with [Claude Code](https://claude.com/claude-code),
Anthropic's AI coding agent, directed by frolicchris, a network and security
engineer who plays piano requests on Twitch. Almost none of the code was typed
by hand.

What a person did: decided what it should do, ran it on live streams, read the
logs afterwards, and pushed back when it was wrong. The design decisions in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) came from that loop, and the bugs
found on stream have tests that keep them fixed.

It is shared as a useful tool, not as a claim of hand-written craft. Judge the
code on its merits. Issues and pull requests are welcome.

### Credits and license

Facts are rewritten from Wikipedia, whose text is shared under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). If you publish
recordings, crediting Wikipedia in your description is the courteous thing to do.

The code is [MIT licensed](LICENSE). Built by
[frolicchris](https://twitch.tv/frolicchris) for a piano request stream.

---

## For developers

How it works, and the reasons behind the less obvious choices, are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Read it before changing how
facts are found or checked.

```bash
npm run check       # everything below, the gate for a pull request
npm run typecheck   # TypeScript in strict mode, tests included
npm run lint        # eslint on the overlay, shellcheck on the scripts
npm test            # jest, about a second
npm run build       # compile the server to dist/
```

`npm run lint` needs [shellcheck](https://www.shellcheck.net). The server
always runs compiled; there's no development transpiler on purpose.

While it runs, `curl 127.0.0.1:3000/health` reports the current song, which
overlays are connected, and how each song this session was handled.
