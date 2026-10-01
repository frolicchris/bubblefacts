# BubbleFacts desktop app: design

The command-line setup is too technical for most musicians. This turns the
project into an app you download, open, and click through: no Terminal, no
`.env` file, no Node.js, and no separate AI install.

## Decisions

| Area | Choice | Why |
|---|---|---|
| App framework | **Electron** | Reuses the existing TypeScript server unchanged. Bundles its own Node.js and browser, so nothing else needs installing. Mature installers and updates on all three systems. |
| Platforms | **macOS 13+** (Apple silicon and Intel), **Windows 10 and 11** (x64), **Linux** x64 | Exactly where OBS 32 runs. |
| Installers | macOS `.dmg`, Windows `.exe` (NSIS, per-user, no admin), Linux `.AppImage` and `.deb` | The standard format on each system. |
| Setup | **Two steps**, then one optional one: 1) connect your songs (sign in with StreamerSongList, or paste a StreamElements token), 2) add BubbleFacts to OBS, then **Tell us about your music** (originals, live learns, your own custom facts), which can be skipped. Everything else has a default and lives in Settings. | Every question in setup is a place to get stuck. |
| Starting up | The server starts as soon as the song list is connected. Until the built-in AI is ready, songs get custom facts. | The overlay works on the first stream, even while the model is still downloading. |
| Adding to OBS | A tile in the app that you **drag into OBS's Sources list**, which makes a Browser source at the canvas size. When OBS connects, the app sends a test bubble and confirms with "It's on your stream!" | No file paths or settings to copy, and immediate proof that it worked. |
| Overlay size | Everything in the overlay scales with the height of the Browser source, with a Bubble size setting on top. | Looks the same on a 720p, 1080p or 4K canvas, whatever size OBS gives the source. |
| On-air controls | **Pause bubbles** and **Show a test bubble** on the dashboard, plus Songs, Facts and Stream status and a Help and troubleshooting section. Paused, songs are still followed but nothing is shown. | The streamer needs a one-click way to hide it mid-stream, and to check it without playing a song. |
| StreamElements | A second song source, chosen in the first setup step ("Where do your song requests come from?") and in Settings. The musician pastes the JWT token from the StreamElements dashboard; the app tests it and saves it encrypted like the other secrets. When StreamElements refuses it, the dashboard asks for a new token in Settings. | Some musicians take requests through StreamElements' Media Request player, not StreamerSongList. StreamElements has no sign-in for apps like this one, so a pasted token is the only way in. |
| Song list sign-in | **OAuth 2 with PKCE** against id.streamersonglist.com, returning to a one-time server on `127.0.0.1:53682`. The app refreshes the hour-long access token five minutes early, saves each rotated refresh token before using it, and hands the running server the new token without a restart. Pasting a Streamer Access Token remains as the fallback. | No token to find and copy. StreamerSongList sign-in goes through Twitch. |
| AI | **Built in**, via node-llama-cpp, running Llama 3.2 3B (Q4_K_M, about 2 GB). It downloads in the background as soon as the app opens, resumes after interruptions, and retries on its own. | No Ollama or API key needed, and no choice to make. Uses the Mac's GPU (Metal) and Vulkan GPUs on Windows and Linux, and falls back to the processor, then to custom facts only. Groq, Anthropic and Ollama remain in Settings. |
| Custom facts | The example packs ship with the app, off unless the musician checks them; with none, a song no source knows gets no custom facts. Installs from before beta.3 that still had the old default packs checked have them unchecked on load. The musician's own facts, typed in Settings one per line, are saved as a pack in the app's data folder, which the server checks first. Saving is refused below five custom facts in total. | The examples are only examples; the musician has to be able to add their own without editing JSON. |
| Settings | A settings screen, saved as JSON in the app's data folder; the StreamerSongList token and API keys are encrypted with the operating system's keychain (Electron `safeStorage`) | No text files to edit, and no secrets stored in plain text. |
| Overlay file | Copied to a fixed folder in the app's data folder on every start | OBS needs a stable path. The app's own install folder moves on updates, and on Linux the AppImage mounts somewhere new each run. |
| Self-healing | The server runs in a supervised child process. The app checks its health every few seconds and restarts it after a crash, a hang, or a stalled song-list connection, backing off if it keeps failing. | A musician mid-song can't debug anything. |
| Song facts | **Add facts for this song** under **On stream now** saves facts for one song in `song-facts.json` in the data folder, matched by StreamerSongList song ID or YouTube video ID, else title and artist (or an alias). They're shown first, exactly as written, with no lookup or AI; a songwriter is credited only when the streamer names one. Each fact on the dashboard shows its source. | Other streamers' originals and small artists have no source; authorship is never inferred from a tag or from who's playing. |
| Wrong facts | A **Wrong** button next to each fact under **On stream now** takes the fact off the overlay at once (even mid-bubble), blocks the source it came from for that song (the Wikipedia article, or Wikidata and MusicBrainz), and drops the song's cached facts so the next play looks again. **Undo** lifts the block for the song it was pressed on. Blocks are kept per song in `wrong-facts.json` in the app's data folder (the server finds it through `BUBBLEFACTS_DATA_DIR`), so they survive restarts. Custom facts and song-list facts are removed but nothing is blocked. **Remove my BubbleFacts data** deletes the file. | A wrong fact almost always means the wrong article was found, so blocking the article fixes the cause, in one click, mid-stream. |
| Problem reports | **"Report it (opens GitHub)"** (after **Wrong**) and **"Report a problem"** open a GitHub issue, pre-filled with the song, the fact, app version, system and recent log lines (which name the Wikipedia article used), with secrets removed. The musician reviews and submits it. | Reports need a person's consent and a GitHub account. Filing issues silently would need a server holding a GitHub token (see Later). |
| Updates | The app checks GitHub Releases at start and shows "A new version is available" with a download link | Works without code signing. Fully automatic updates need signed builds (see Later). |
| Running in the background | Closing the window keeps it running in the menu bar or system tray, with a status light; Quit is in the tray menu. Optional start at login. | Closing a window by habit shouldn't stop the overlay mid-stream. |
| Linux fact server | Linux builds ship a standard Node.js (`runtime/node`), and the fact server runs under it instead of Electron's own runtime. | The built-in AI crashed (illegal instruction) under Electron's runtime on Linux. |
| YouTube lookups | When the build has a YouTube Data API key, the app passes it to the server as `YOUTUBE_API_KEY`. For StreamElements requests, the server asks the YouTube Data API about the video ID, and for YouTube's auto-generated "- Topic" uploads uses the exact artist and track from the description instead of parsing the title. The key comes from the `YOUTUBE_API_KEY` repository secret, is written into `package.json` at build time only, is restricted to the YouTube Data API, and is never logged. Without it, nothing changes. | Titles of auto-generated uploads are often just the song name; their descriptions name the artist exactly. |
| Builds | `.github/workflows/release.yml` builds all installers on each version tag (`v*`), on macOS, Windows and Linux runners. File names include the version. They go into a draft release with `SHA256SUMS.txt` and a build-provenance attestation for each file. The same workflow can be run by hand for test builds. | Each installer is built on its own system, and anyone can check a download came from this workflow. |
| Website | Static pages in `site/`, published to bubblefacts.frolic.org. The download page reads the newest release (betas included) from GitHub's API and offers the right file for the visitor's system. | DreamHost serves static files; no server code needed, and no page edit for each release. |

## Using StreamElements instead of StreamerSongList

If viewers request songs through StreamElements (its Media Request player):

1. In the first setup step, under **Where do your song requests come from?**, choose **StreamElements**.
2. Open your StreamElements dashboard, then **Account**, then **Channels**, and click **Show secrets**.
3. Copy the **JWT token** and paste it into BubbleFacts, with your channel name. The token works like a password, so keep it off your stream.
4. Click **Connect**. BubbleFacts checks the token and moves on to adding the overlay to OBS.

To switch later, or to paste a new token, open **Settings**, then **Your song list**.

What's different with StreamElements:

- Facts follow the song request player: they appear while it plays and clear when it stops. Pausing keeps the current song, and resuming carries on.
- If StreamElements says a song is playing but BubbleFacts can't see which one for 30 seconds, the dashboard shows **Reconnecting** instead of all green. If that lasts two more minutes, the app restarts its fact server, which reads StreamElements' state again without touching the queue.
- StreamElements only has each video's YouTube title, so BubbleFacts works out the song and artist from it ("Ciara - 1, 2 Step (Official Video)" becomes "1, 2 Step" by Ciara). Clearly titled videos get the best facts. With a YouTube key built in, auto-generated uploads are read exactly instead (see YouTube lookups above).
- There are no live learns, so that setting is hidden.
- If StreamElements stops accepting the token (you reset it, say), the Songs light turns red and BubbleFacts asks you to paste a new one in Settings.

## What stays the same

The fact pipeline (grounding, screening, topic packs), the overlay page, and the
command-line setup for people who prefer it. The desktop app starts the same
server with settings passed as environment variables.

## Later (needs accounts or decisions)

- **Code signing.** Without it, macOS says the app "can't be checked for
  malicious software" and Windows SmartScreen warns on download. Needs an Apple
  Developer Program membership ($99 a year) and Azure Artifact Signing ($9.99 a
  month). Signing also enables fully automatic updates.
- **Add to OBS automatically,** through OBS's built-in WebSocket server (OBS 28+).
  The musician enables it in OBS once; the app then creates the Browser Source.
- **Automatic problem reports,** through a small endpoint on bubblefacts.frolic.org that holds
  a GitHub token, is rate-limited, and files issues only with the musician's
  consent.
- **Other languages.** The app, the overlay and the facts are English only
  (English Wikipedia).
- **Two-PC streaming,** with OBS on a second computer. The command-line version
  can do it with `HOST` (see [CONFIG.md](CONFIG.md)); the app only serves its
  own computer.
