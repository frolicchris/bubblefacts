# Releasing BubbleFacts

For the maintainer. Contributors don't need any of this; see
[CONTRIBUTING.md](../.github/CONTRIBUTING.md).

**Releases** are made by the maintainer pushing a version tag, such as
`v2.0.0`. Version tags are protected, so a published release's tag can't be
moved or deleted. The Release workflow builds every installer on its own
system and puts them in a *draft* release with a `SHA256SUMS.txt` file and a
build-provenance attestation for each file, for a person to read over and
publish. A tag with a hyphen (`v2.0.0-beta.3`) becomes a pre-release.

Tag a commit that's already on `main`: the workflow refuses any other, so a
release is always built from code that went through a pull request. The
workflow's actions are pinned to exact commits; Dependabot proposes updates.

## Code signing

Builds are signed only when the repository has the secrets below; without
them (and in forks) they come out unsigned, as now. The release log's
**Report signing** step says which.

Before adding the first signing secret, move the build job's signing secrets
into a protected `release` environment that only `v*` tags can use, so a test
build from another branch never sees them.

**Mac (Apple Developer Program, $99 a year):**

1. Enroll at [developer.apple.com/programs](https://developer.apple.com/programs/) as an individual.
2. In Xcode or the developer site, create a **Developer ID Application** certificate and export it with its key as a `.p12` file with a password.
3. In App Store Connect, under Users and Access, Integrations, create an **App Store Connect API key** for notarization and download the `.p8` file.
4. Add repository secrets: `MAC_CERT_P12_BASE64` (`base64 -i cert.p12`), `MAC_CERT_PASSWORD`, `APPLE_API_KEY_P8` (the `.p8` file's text), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`.

Signed and notarized, the Mac app opens without the "unidentified developer"
steps, and macOS stops asking for the keychain again after each update.

**Windows (Azure Artifact Signing, formerly Trusted Signing, billed monthly):**

1. In Azure, create an Artifact Signing account, complete identity validation, and create a public-trust certificate profile.
2. Create an app registration with the certificate profile signer role on the account.
3. Add secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET`, and repository variables `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE` and `AZURE_SIGNING_PUBLISHER` (the certificate's subject name).

Once both are signed, remove the first-launch steps from `site/guide.html`
and `site/download.html` (see `site/README.md`).

## Release checklist

Before publishing a draft release, check the packaged app, not only the source.
The tests can't see what OBS or an installer does.

1. The version in `package.json` and the `obs-overlay.js` header match the tag.
2. The Release workflow passed for every system, and the draft has every
   installer, `SHA256SUMS.txt` and `bubblefacts.zip`.
3. Run the **Smoke** workflow on the Release run's artifacts:
   `gh workflow run smoke.yml -f run=RUN_ID`. (A draft release can't be
   downloaded by the workflow's read-only token, so test the run that built
   it.) Every system passes, including writing and keeping captions.
4. Download one installer from the draft. Its checksum matches the draft's
   `SHA256SUMS.txt`, and `gh attestation verify FILE --repo
   frolicchris/bubblefacts --source-ref refs/tags/vX.Y.Z` passes.
5. Install it and open it. The setup screen appears and shows the new version
   at the bottom.
6. Sign in, then drag the tile into a test scene in a real OBS. The test bubble
   appears in OBS and the app says **It's on your stream!**
7. Play one song from the queue. The Now Playing bubble and facts appear.
8. Quit from the menu bar or tray. Nothing is left running.
9. While in beta, add the new version to the top of the version list in
   `.github/ISSUE_TEMPLATE/beta_test.yml` (a test fails until you do).
   Publish as a pre-release. The draft's notes start from
   `.github/release-template.md`: fill in New, Improved, Fixed and Thanks
   (the same lines as the website's changelog), delete empty sections and
   the comments, and keep the checksums. Releases are immutable once published:
   a mistake in a file is fixed with a new version, never by replacing it.
10. Upload the changed `site/` files to the website and check each one against
    `main`.

## Release candidates and the final release

A release candidate (`2.0.0-rc.1`) means "this is 2.0.0 unless testing finds
a blocker." These rules follow the practice of projects such as Python,
GNOME, Mozilla and VS Code, sized for one maintainer.

**Freezes, from the last beta (beta.12):**

- **Features:** nothing new. Only fixes, docs and tests.
- **Screens and wording:** no changes to the app's labels or layout, so the
  setup guide, screenshots and tester steps stay right.
- **Dependencies:** no new packages and no major upgrades. A security fix to
  a dependency is allowed.

**What may change during the release candidates:** only a low-risk fix for a
release blocker. Anything else waits for 2.0.1. To make an exception, write
the reason in the pull request.

**Release blockers** carry the `release blocker` label and the 2.0.0
milestone. A blocker is anything that puts wrong or unsafe words on stream,
stops bubbles mid-stream, loses a musician's settings or facts, breaks
setup, sign-in or the in-app update, or a security problem. There must be
none open to make a release candidate, and none to make the final release.

**Every change during the release candidates** gets a second review (an
independent code review, plus the maintainer reading the diff) before it
merges.

**Testing each release candidate:**

1. The release checklist above, on every system.
2. A hands-on pass on real computers: Mac and Windows by a tester each. Linux
   relies on the smoke test unless a tester has it; say so in the notes.
3. Every bug fixed since the last beta, checked again.
4. The in-app update from the previous version, on Mac and Windows, with
   settings and facts kept.
5. At least one tester streams with it, twice, with no new blocker.

**Making the final release:** 2.0.0 is the last release candidate's code with
only the version number changed. Before tagging it, go or no-go:

- [ ] No open release blockers.
- [ ] The last release candidate was out at least three days, and testers
      streamed with it.
- [ ] The update from it to 2.0.0 works (the app treats 2.0.0 as newer than
      any `rc` or `beta`).
- [ ] Release notes, changelog, guide and known issues are current.
- [ ] Signing is decided: signed, or the first-launch steps are on the
      download page.

**If 2.0.0 has a serious problem:** releases are immutable and version tags
are locked, so the way back is forward: fix it on `main` and release 2.0.1
the same way, as soon as possible. Serious means a release blocker as
defined above. Post in Discussions (Announcements) what happened and what to
do meanwhile; if the in-app update itself is broken, the post links the
download page. People who want the earlier version can install it over the
new one (see Troubleshooting).
