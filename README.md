# BubbleFacts

[![Check](https://github.com/frolicchris/bubblefacts/actions/workflows/check.yml/badge.svg)](https://github.com/frolicchris/bubblefacts/actions/workflows/check.yml)
[![Release](https://img.shields.io/github/v/release/frolicchris/bubblefacts?include_prereleases)](https://github.com/frolicchris/bubblefacts/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**Song facts that pop up right on your stream.**

BubbleFacts watches your [StreamerSongList](https://streamersonglist.com)
requests and shows short, Wikipedia-checked facts in game-inspired bubbles in
OBS while you play.

![Three fact bubbles and a Now Playing banner over a dark background](docs/demo.png)

## Download

**[Download BubbleFacts](https://bubblefacts.frolic.org/download.html)** from
the website. It's free, for Mac, Windows and Linux.

This is a beta. The app isn't code-signed yet, so the first time you open it,
your computer may ask you to confirm that you want to run it. The download
page shows what to click.

## Get running in two steps

1. **Connect your songs.** Click **Sign in with StreamerSongList** and sign in
   with Twitch. (If that doesn't work, **Having trouble signing in?** lets you
   paste a token instead.)
2. **Add BubbleFacts to OBS.** Drag the tile from the app into the **Sources**
   list in OBS.

A test bubble appears in OBS, and the app says **It's on your stream!** That's
it. There's one optional step after that, **Tell us about your music**, where
you can mark your originals and live learns and add backup facts of your own.

No coding. No Terminal. No AI setup.

The built-in fact writer downloads in the background (about 2 GB). Until it's
ready, songs get backup facts. From the app you can pause bubbles, show a test
bubble, and see how your songs, facts and stream are doing. The
[setup guide](https://bubblefacts.frolic.org/guide.html) walks through every
screen.

## How BubbleFacts checks its facts

AI can make things up. BubbleFacts is built to keep made-up facts off your
stream, so its fact writer never answers from memory.

1. When a song starts, it finds the Wikipedia article for the song, or for the
   game or film it's from.
2. The fact writer writes short captions **only from that article**.
3. Any caption that names a person, year or console the article doesn't
   contain is dropped before it reaches your stream.
4. No article means no AI. It shows messages you provide instead.

Facts are only as good as Wikipedia: the check makes sure captions match the
article, not that the article is right. Found a wrong fact? Please
[report it](https://github.com/frolicchris/bubblefacts/issues/new?template=wrong_fact.yml).
It's the most useful report of all.

## Made by a music streamer

BubbleFacts was created and tested by
[frolicchris](https://twitch.tv/frolicchris), a Twitch pianist who plays
viewer requests. It grew out of a tool for his own streams: he ran it live,
read the logs afterward, and fixed what went wrong.

<sub>Development used [Claude Code](https://claude.com/claude-code),
Anthropic's AI coding agent. BubbleFacts is open source under the
[MIT license](LICENSE).</sub>

## Help

- [Setup guide](https://bubblefacts.frolic.org/guide.html), step by step with pictures
- [Discord](https://discord.gg/gXdVKc6KWx) for quick questions, or
  [Discussions](https://github.com/frolicchris/bubblefacts/discussions/categories/q-a)
- [Report a problem](https://github.com/frolicchris/bubblefacts/issues/new?template=bug_report.yml).
  In the app, **Report a problem** fills in the details for you.
- [Report a wrong fact](https://github.com/frolicchris/bubblefacts/issues/new?template=wrong_fact.yml).
  In the app, click **Report this fact** next to it.
- [Beta test report](https://github.com/frolicchris/bubblefacts/issues/new?template=beta_test.yml):
  tried the beta? Tell us how each step went.
- [Security policy](SECURITY.md): report security problems privately.

## For developers

- **[Manual setup (command line)](docs/MANUAL-SETUP.md):** run the overlay
  with Node.js and a settings file, without the app. Its backup facts are a
  few examples you replace with your own.
- **[Build and run the app from source](CONTRIBUTING.md#working-on-the-desktop-app)**,
  and how to contribute.
- [How it works](docs/ARCHITECTURE.md), and why. Read it before changing how
  facts are found or checked.
- [Every setting](docs/CONFIG.md) for the command-line version.
- [Desktop app design](docs/DESKTOP-APP.md)

## Credits and license

Facts are rewritten from Wikipedia, whose text is shared under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). If you publish
recordings, crediting Wikipedia in your description is the courteous thing to
do.

Built with Llama. The app's built-in AI is Meta's Llama 3.2 3B, used under the
[Llama 3.2 Community License](https://www.llama.com/llama3_2/license/).

The code is [MIT licensed](LICENSE).
