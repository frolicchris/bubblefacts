# Manual setup (command line)

This page is for people who want to run BubbleFacts from the command line,
with Node.js and a settings file, instead of using the app.

> **Most streamers should use the app instead.** It needs no Terminal, no
> Node.js and no AI setup. Download it for Mac, Windows or Linux at
> **[bubblefacts.frolic.org](https://bubblefacts.frolic.org/download.html)**.

The manual setup works on its own, without the app, and uses the same fact
checking. It is built for a Mac or Linux; Windows works with a couple of extra
steps.

## Contents

- [Quick links](#quick-links)
- [Before you start](#before-you-start)
- [Setup](#setup)
- [What you'll see on stream](#what-youll-see-on-stream)
- [Making it yours](#making-it-yours)
- [Updating to a new version](#updating-to-a-new-version)
- [If something goes wrong](#if-something-goes-wrong)
- [Good to know](#good-to-know)
- [For developers](#for-developers)

---

## Quick links

Everything you might need to download or sign up for, in one place.

**The overlay**

- [Releases](https://github.com/frolicchris/bubblefacts/releases): from the newest one, download **bubblefacts.zip**
- [All versions and what changed](https://github.com/frolicchris/bubblefacts/releases)
- [Ask a setup question](https://github.com/frolicchris/bubblefacts/discussions/categories/q-a), or chat on [Discord](https://discord.gg/gXdVKc6KWx)
- [Report a problem or a wrong fact](https://github.com/frolicchris/bubblefacts/issues/new/choose)

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
| OpenRouter | [Create an API key](https://openrouter.ai/keys) | See `OPENAI_BASE_URL` in [CONFIG.md](CONFIG.md). |
| Google Gemini | [Create an API key](https://aistudio.google.com/apikey) | See `OPENAI_BASE_URL` in [CONFIG.md](CONFIG.md). |

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

From the [newest release](https://github.com/frolicchris/bubblefacts/releases), download **bubblefacts.zip** and unzip it somewhere you'll remember,
such as your Documents folder. You'll get a folder called
`bubblefacts`. (If you use git:
`git clone https://github.com/frolicchris/bubblefacts.git`.)

Then open Terminal, type `cd ` (with a space), drag the `bubblefacts`
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

OpenRouter and Google Gemini work too; see [CONFIG.md](CONFIG.md).

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

Start the overlay (step 5) before you do this.

1. In the scene you stream from, under **Sources**, click **+** and choose
   **Browser**. Name it "BubbleFacts".
2. Leave **Local file** unchecked. In **URL**, type
   `http://127.0.0.1:3000/obs-overlay`
3. Set **Width** to `1920` and **Height** to `1080`.
4. Check **Refresh browser when scene becomes active**. Leave Custom CSS empty.
5. Click **OK**. Then right-click the source and choose
   **Transform → Reset Transform**, so it fills the screen exactly.

The URL only loads while the overlay is running. If you open OBS first, start
the overlay, then right-click the source and choose **Refresh**.

> **About the Local file option.** Version 2.0.0-beta.2 and newer can also be
> added as a **Local file** (`frontend/obs/obs-overlay.html` in the overlay
> folder), which keeps retrying until the overlay is running. **Version 1.0.0
> can't:** as a Local file it never connects, and shows a red dot even while
> the overlay is running. The ZIP in step 1 is version 1.0.0 until a newer full
> release comes out, so use the URL above.

### 7. Check it works

Play a song from your queue. A **NOW PLAYING** banner appears at the bottom,
and a few seconds later the first fact bubble pops up.

Nothing showing? See [If something goes wrong](#if-something-goes-wrong).

---

## What you'll see on stream

| When | On screen |
|---|---|
| A song starts | A gold **NOW PLAYING** banner for five seconds, then up to five fact bubbles, one every 15 seconds. |
| A song with no Wikipedia article | Plain facts from Wikidata or MusicBrainz, such as the year and the album. If they don't know it either: bubbles from the song's own details (how often you've played it, who requested it, your note on it) plus your custom facts. |
| One of **your own compositions** | Bubbles about the piece from your song list: that it's an original, play count, requester, your note. |
| A **Live Learn** (a request that isn't on your list) | A **LIVE LEARN** banner with the title and who requested it. It stays up until the next song, with no bubbles. |
| The overlay can't reach its server | A small red dot in the bottom-right corner. It disappears once reconnected. |

---

## Making it yours

All of these are lines in your `.env` file. Restart the overlay after changing it.
[CONFIG.md](CONFIG.md) lists every setting.

### Your custom facts

> **The included packs are only a few examples.** They're short, they aren't
> updated, and they won't know your songs. Fill in your own facts for the
> music you play. In the desktop app, that's **Settings → Custom facts →
> Your own facts**, one per line.

When a song has no Wikipedia article, and Wikidata and MusicBrainz don't
know it either, the overlay shows facts from **topic packs**: small files
in the `topics` folder, each a list of facts you've chosen. These facts go
straight to your stream without being checked by the overlay, so only
include ones you've checked yourself.

The overlay comes with a few **example packs** so it works right away and
so you can see the format:

| Example | Facts | About |
|---|---|---|
| `video-game` | 24 | Game composers, sound chips, soundtracks |
| `classical` | 7 | Composers and piano repertoire |
| `film` | 8 | Film and TV scores |
| `pop` | 7 | Pop and rock songs and songwriters |
| `piano` | 4 | The instrument itself, plus a line for solo pianists' originals |
| `general` | 6 | Music in general, plus lines for your own compositions |

They're examples, not a maintained collection: they won't be expanded or
updated, and changes to them aren't accepted into the project. Use them as
they are, trim them, or replace them with your own.

To choose which packs to use, list them in `.env`:

```env
TOPIC=classical,film,piano,general
```

The default is every example except `piano`. Keep `general`, or a pack of
your own with lines for your originals, if you play your own music. Five or
more facts keep them from repeating often. Set `TOPIC=` (empty) for no
custom facts at all.

**To make your own pack,** copy any file in `topics`, give it a name that's
yours (such as `my-facts.json`), change the facts, and add that name to
`TOPIC`. A name of your own means a future update can't overwrite it. Keep it
short: a couple of dozen facts you're sure of beat a long list you aren't.

### Your own compositions

The overlay recognizes your originals if, in StreamerSongList, you either:

- tag them with an attribute named something like **Originals** or
  **Jane's Originals**, or
- set the artist to your channel name or your `STREAMER_DISPLAY_NAME`, or to
  a credit that includes `@yourchannel`.

It skips Wikipedia for these (there's no article) and uses what your song list
knows about the piece instead.

### How it talks about you

```env
STREAMER_DISPLAY_NAME=Jane    # instead of your channel name
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

Colors, fonts and animation are in `frontend/obs/obs-overlay.css`. To make the
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
[releases page](https://github.com/frolicchris/bubblefacts/releases),
with what changed in each.

1. Stop the overlay (Ctrl-C in its window).
2. From the [newest release](https://github.com/frolicchris/bubblefacts/releases), download **bubblefacts.zip** and unzip it.
3. Copy your `.env` file from the old folder into the new one. (Press
   Cmd+Shift+. in Finder to see it.) Copy your own topic pack too, the
   CSS file if you changed the look, and the `data` folder: it holds your
   facts for particular songs and the sources you marked **Wrong**.
4. In Terminal, go to the new folder and run `npm install`, then start it as
   usual with `bash scripts/start-overlay.sh`.
5. If your OBS source uses **Local file**, point it at `obs-overlay.html` in
   the new folder, if you put it somewhere different. A source using the URL
   needs no change.

If you used git instead: `git pull`, then `npm install`.

---

## If something goes wrong

| What you see | Likely cause | What to do |
|---|---|---|
| A **red dot** in the corner, no bubbles | The overlay isn't running | Run `bash scripts/start-overlay.sh` and leave the window open. |
| A **red dot** that stays, though the overlay is running | Version 1.0.0 added as a **Local file**, which never connects | Change the source to the URL `http://127.0.0.1:3000/obs-overlay` ([step 6](#6-add-it-to-obs)), or update to the newest release. |
| Nothing at all, not even a red dot | OBS isn't loading the page | Start the overlay, then right-click the source and choose **Refresh**. Check the source's URL is `http://127.0.0.1:3000/obs-overlay` and the source is visible. Then run `bash scripts/check-overlay.sh`, which tells you whether OBS is connected. |
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

Still stuck? [Ask in Discussions](https://github.com/frolicchris/bubblefacts/discussions/categories/q-a)
or on [Discord](https://discord.gg/gXdVKc6KWx), or if it looks like a bug, [open an issue](https://github.com/frolicchris/bubblefacts/issues/new/choose).
Include the relevant lines from the newest file in the `logs` folder, with
your token removed.

---

## Good to know

- **Generated facts aren't saved between streams.** They're made fresh when a
  song starts and kept in memory until you stop the overlay, so a repeated
  song shows instantly. What you add is saved, in the `data` folder: your
  facts for particular songs and the sources you marked **Wrong**. The topic packs are only ever read, never written. The log
  file `logs/songs.log` records which way each song was handled, not the facts.
- **Facts are only as good as Wikipedia.** The check makes sure captions match
  the article; it can't tell whether the article is right.
- **Well-known works do best.** Famous games, films, pop songs and classical
  pieces have articles. Obscure tracks and small indie games often don't, so
  they get the hand-checked facts instead.
- **English Wikipedia only**, and one streamer per copy of the overlay.
- **The overlay only accepts connections from your own computer**, because it
  has no password. Running OBS on a second computer is possible; see `HOST` in
  [CONFIG.md](CONFIG.md).
- **Built for StreamerSongList as it worked in 2026.** If their service
  changes, the overlay may need an update.
---

## For developers

How it works, and the reasons behind the less obvious choices, are in
[ARCHITECTURE.md](ARCHITECTURE.md). Read it before changing how facts are
found or checked. [CONTRIBUTING.md](../.github/CONTRIBUTING.md) covers the checks,
the desktop app and pull requests.

While the overlay runs, `curl 127.0.0.1:3000/health` reports the current song,
which overlays are connected, and how each song this session was handled.

Facts are rewritten from Wikipedia, whose text is shared under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). If you publish
recordings, crediting Wikipedia in your description is the courteous thing to
do. The code is [MIT licensed](../LICENSE).
