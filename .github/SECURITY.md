# Security

## Reporting a problem

If you find a security problem, please report it privately using
[**Report a vulnerability**](https://github.com/frolicchris/bubblefacts/security/advisories/new)
on the Security tab, not in a public issue. You'll get a reply as soon as
possible, and credit in the fix if you'd like it.

## What's covered

Both ways of running BubbleFacts: the desktop app (Mac, Windows, Linux) and the
command-line overlay. In particular:

- **Sign-in and keys.** The app's StreamerSongList sign-in tokens, your
  StreamElements JWT token and any API keys you enter are encrypted with your
  operating system's keychain before they're saved. (If no keychain is
  available, which can happen on some Linux systems, they're saved without
  real encryption in the app's settings file, and the app warns you.)
- **The local server.** The overlay's server only listens on your own computer
  (`127.0.0.1`), because it has no password.
- **The app's controls.** Buttons such as **Pause bubbles** and **Show a test
  bubble** talk to the server through routes that require a custom header. A
  web page open in your browser can't send it, so it can't press those buttons.
- **Reports.** **Report it (opens GitHub)** (after **Wrong**) and **Report a
  problem** open a GitHub issue filled in for you, with your tokens and keys
  removed from the log lines. You read it over before anything is posted.
- **Downloads.** Release files come with a `SHA256SUMS.txt` file and a
  build-provenance attestation, so you can check a file came from this
  project's release workflow, built from a release tag:

  ```
  gh attestation verify FILE --repo frolicchris/bubblefacts \
    --signer-workflow frolicchris/bubblefacts/.github/workflows/release.yml \
    --source-ref refs/tags/v2.0.0-beta.4
  ```

  Test builds are attested too, but from a branch, so `--source-ref` tells
  them apart.
- **The built-in YouTube key.** Official builds include a Google API key
  restricted to the YouTube Data API, used only to read song details for
  auto-generated "- Topic" uploads. Anyone can extract a key shipped in an
  app, so it has a daily quota cap and is replaced if it's abused; without
  it, BubbleFacts reads the video title instead.

## Keeping your own setup safe

- **Never paste a StreamerSongList or StreamElements token, or an API key,**
  into an issue, a discussion, Discord or a screenshot. If one leaks, delete it on the service's
  website and create a new one. With the command-line version, never share
  your `.env` file.
- **Read a report before you submit it.** The app removes your secrets, but
  it's your report, so check it.
- **The overlay only accepts connections from your own computer** by default.
  With the command-line version, change `HOST` only if you understand the
  risk, and only on a network you trust.
- **Only the newest release is supported.** Update when a new one comes out.
  The app tells you when there is one.
