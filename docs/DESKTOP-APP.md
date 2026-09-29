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
| Setup | **Two steps:** sign in with StreamerSongList, then add the overlay to OBS. Everything else has a default and lives in Settings. | Every question in setup is a place to get stuck. |
| Song list sign-in | **OAuth 2 with PKCE** against id.streamersonglist.com, returning to a one-time server on `127.0.0.1:53682`. The app refreshes the hour-long access token five minutes early, saves each rotated refresh token before using it, and hands the running server the new token without a restart. Pasting a Streamer Access Token remains as the fallback. | No token to find and copy. StreamerSongList sign-in goes through Twitch. |
| AI | **Built in**, via node-llama-cpp, running Llama 3.2 3B (Q4_K_M, about 2 GB). It downloads in the background as soon as the app opens, resumes after interruptions, and retries on its own. | No Ollama or API key needed, and no choice to make. Uses the Mac's GPU (Metal) and Vulkan GPUs on Windows and Linux, and falls back to the processor, then to backup facts only. Groq, Anthropic and Ollama remain in Settings. |
| Backup facts | The example packs ship with the app. The musician's own facts, typed in Settings one per line, are saved as a pack in the app's data folder, which the server checks first. Saving is refused below five backup facts in total. | The examples are only examples; the musician has to be able to add their own without editing JSON. |
| Settings | A settings screen, saved as JSON in the app's data folder; the StreamerSongList token and API keys are encrypted with the operating system's keychain (Electron `safeStorage`) | No text files to edit, and no secrets stored in plain text. |
| Overlay file | Copied to a fixed folder in the app's data folder on every start | OBS needs a stable path. The app's own install folder moves on updates, and on Linux the AppImage mounts somewhere new each run. |
| Self-healing | The server runs in a supervised child process. The app checks its health every few seconds and restarts it after a crash, a hang, or a stalled song-list connection, backing off if it keeps failing. | A musician mid-song can't debug anything. |
| Problem reports | **"That fact is wrong"** and **"Report a problem"** buttons open a GitHub issue, pre-filled with the song, the fact, the Wikipedia article used, app version, system and recent log lines, with secrets removed. The musician reviews and submits it. | Reports need a person's consent and a GitHub account. Filing issues silently would need a server holding a GitHub token (see Later). |
| Updates | The app checks GitHub Releases at start and shows "A new version is available" with a download link | Works without code signing. Fully automatic updates need signed builds (see Later). |
| Running in the background | Closing the window keeps it running in the menu bar or system tray, with a status light; Quit is in the tray menu. Optional start at login. | Closing a window by habit shouldn't stop the overlay mid-stream. |
| Builds | GitHub Actions builds all installers on each version tag, on macOS, Windows and Linux runners, and attaches them to the release | Each installer is built on its own system. |
| Website | Static pages in `site/`, published to bubblefacts.frolic.org | DreamHost serves static files; no server code needed. |

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
