# Releasing BubbleFacts

For the maintainer. Contributors don't need any of this; see
[CONTRIBUTING.md](../.github/CONTRIBUTING.md).

**Releases** are made by the maintainer pushing a version tag, such as
`v2.0.0`. Version tags are protected, so a published release's tag can't be
moved or deleted. The Release workflow builds every installer on its own
system and puts them in a *draft* release with a `SHA256SUMS.txt` file, a
software bill of materials (`bubblefacts-sbom.spdx.json`) and a
build-provenance attestation for each file, for a person to read over and
publish. A tag with a hyphen (`v2.0.0-beta.3`) becomes a pre-release.

**Update channels.** Every beta and release candidate is published as a GitHub
pre-release; full releases (`v2.0.0`, `v2.0.1`) are not. That's what the app's
**Updates** setting reads: **Stable** offers only full releases, **Beta**
offers the newest of everything. The app also treats any version with a
hyphen as a prerelease, so a beta published without the box checked still
doesn't reach Stable. The download page offers the newest full release with
installers (until 2.0.0, the newest beta), with a "Testing betas?" link when a
newer beta is out.

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

## Setting the version

One command sets a new version everywhere it's written, through a pull
request to `main` before tagging:

```bash
npm run bump -- 2.0.0-beta.12
```

It sets `package.json` and `package-lock.json`, the `obs-overlay.js` header,
the top of the version list in `.github/ISSUE_TEMPLATE/beta_test.yml` and the
example in `bug_report.yml`, and adds a dated entry at the top of
`site/changelog.html`. Fill in its `FILL IN` lines (the same lines as the
release notes' New, Improved and Fixed; delete the ones you don't need):
`npm run check` fails until you do. Running it again changes nothing.

## Telling builds apart

Every build from the Release workflow carries the commit it was built from,
written in at build time like the YouTube key. The app shows it at the bottom
of the window and on its About page, writes it at the top of each day's log,
and puts it in problem, beta test and Wrong reports:

- A release (a `v*` tag): `2.0.0-beta.12 (c4ee826)`.
- A test build (**Run workflow**): `2.0.0-beta.12 test build (c4ee826)`.
  It keeps the version in `package.json`, so a test build of `main` between
  releases says the last version set there. The in-app update treats it like
  that version: it offers only a newer release.
- Built on your own computer (`npm run app`, `npm run dist`): `2.0.0-beta.12 (dev)`.

## Release checklist

Before publishing a draft release, check the packaged app, not only the source.
The tests can't see what OBS or an installer does.

1. The version was set with `npm run bump` (above) and matches the tag, and
   `desktop/renderer/whats-new.json` has that version's two to four
   highlights (plain words, like the changelog's top lines), added before
   tagging. The app shows them once on the dashboard after the update; a
   version without an entry shows nothing.
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
   at the bottom, with the tagged commit and no "test build".
6. Sign in, then drag the tile into a test scene in a real OBS. The test bubble
   appears in OBS and the app says **It's on your stream!**
7. Play one song from the queue. The Now Playing bubble and facts appear.
8. Quit from the menu bar or tray. Nothing is left running.
9. While in beta, publish as a pre-release. The draft's notes start from
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

**Freezes, from the first release candidate (rc.1):** (planned from beta.12; testers' requests added a beta.13 and a few features after it, so the freeze took effect with rc.1)

- **Features:** nothing new. Only fixes, docs and tests.
- **Screens and wording:** no changes to the app's labels or layout, so the
  setup guide, screenshots and tester steps stay right.
- **Dependencies:** no new packages and no major upgrades. A security fix to
  a dependency is allowed. Dependabot is set to skip major versions until 2.0.0
  ships; restore its Electron-only rule then (`.github/dependabot.yml`).

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
1. A fact check of two testers' whole song lists, of different kinds of
   music (with their permission): `npm run build`, then
   `node scripts/check-song-list.mjs LIST.json OUT_DIR --facts 50`. It
   records the Wikipedia article every song gets and flags ones that look
   wrong, and writes facts for a random 50 songs, each checked against its
   own source. **The bar: under 5% of the facts that come from a source are
   wrong or misleading, on each list, with no new kind of mistake.** (A
   small AI never reaches zero; Wrong and Hands-free Wrong catch the rest.)
   Keep the lists and results out of the repository.
2. A hands-on pass on real computers: Mac and Windows by a tester each. Linux
   relies on the smoke test unless a tester has it; say so in the notes.
3. Every bug fixed since the last beta, checked again.
4. The in-app update from the previous version, on Mac and Windows, with
   settings and facts kept.
5. At least one tester streams with it, twice, with no new blocker.

**Making the final release:** 2.0.0 is the last release candidate's code with
only the version number changed. Before tagging it, go or no-go:

- [ ] No open release blockers.
- [ ] The fact check of the last release candidate met the under-5% bar.
- [ ] The last release candidate was out at least three days, and testers
      streamed with it.
- [ ] The update from it to 2.0.0 works (the app treats 2.0.0 as newer than
      any `rc` or `beta`).
- [ ] Release notes, changelog, guide and known issues are current.
- [ ] Signing is decided: signed, or the first-launch steps are on the
      download page.
- [ ] `desktop/renderer/whats-new.json` has 2.0.0's highlights.

**The website on release day:** it switches to stable wording by itself as
soon as 2.0.0 is published (the download page then says "Newest version"
instead of "2.0 beta"). The one edit is for visitors without JavaScript:
flip the site default in `site/assets/site.css`, as `site/README.md`
("When version 2.0.0 ships") describes, and upload it.

**If 2.0.0 has a serious problem:** releases are immutable and version tags
are locked, so the way back is forward: fix it on `main` and release 2.0.1
the same way, as soon as possible. Serious means a release blocker as
defined above. Post in Discussions (Announcements) what happened and what to
do meanwhile; if the in-app update itself is broken, the post links the
download page. People who want the earlier version can install it over the
new one (see Troubleshooting).

**Declaring a stable release (2.0.0, and each 2.x after it):** besides the
go/no-go list above,

- [ ] Every item in "What every 2.x release keeps working"
      (docs/ARCHITECTURE.md) still holds, checked with a settings file and a
      backup from the oldest 2.0 beta.
- [ ] The Electron version is one of the three Electron still supports
      (https://www.electronjs.org/docs/latest/tutorial/electron-timelines).
- [ ] Known issues (#36) are current and linked from the release notes.
- [ ] The release has its software bill of materials.

A new feature release (x.y.0) reaches Beta-channel users at once and
Stable-channel users three days later, so problems show up with testers
first. Maintenance releases (below) reach both at once. Plan a 2.0.1
about a week after 2.0.0 for what they find.

## Maintenance releases

A maintenance release (2.0.1, 2.0.2) has only backward-compatible fixes.
Everything else waits for the next feature release (2.1.0), through betas.
This follows SemVer and the practice of Firefox, Chromium, Node, Electron and
Kubernetes, sized for one maintainer.

**Goes in a maintenance release:** security fixes; anything that would be a
release blocker (see above), including a wrong or unsafe fact the screening
should have caught; crashes; regressions; a fix when a song service, Twitch
or an AI provider changes under us, keeping today's behavior; Electron patch
versions within the same major; a dependency's fix at the smallest fixed
version; docs and tests.

**Goes through betas:** new features or settings; wording or layout changes;
behavior changes; AI model or prompt changes (except a screening fix); new
dependencies; minor or major upgrades; Electron majors; refactors; anything a
musician would have to relearn. If unsure, it goes through betas. The pull
request for a maintenance fix says what it fixes, who is affected and how it
was checked.

**When:** a serious security problem within 3 days; other security fixes
within a week; release blockers and regressions as soon as they're fixed;
anything else together, about monthly, only when something changed. A
maintenance release reaches Stable at once; only a new feature release (x.y.0)
waits three days for Beta to have it first.

**Support:** only the newest release gets fixes. When 2.1.0 ships, 2.0.x
stops. After 3.0.0, the last 2.x gets security fixes for three months.

**Automated:** Dependabot opens security fixes as one grouped pull request
against `main`, and version updates weekly. Patch updates to development
tools and workflow actions merge on their own once CI passes
(`dependabot-automerge.yml`): they don't change what musicians install.
Everything that ships in the app (runtime packages, Electron) and every minor
or major update waits for a person.

**Keeping stable and beta in step:** every fix lands on `main` first, so the
next beta has it; a fix that only reached the stable line would be lost to
Beta-channel users, whose newer beta outranks it. While `main` has nothing
newer than 2.0.x, maintenance releases are tagged from `main`. Once 2.1 work
merges:

1. Create `release/2.0` from the newest 2.0.x tag, with the same protection
   as `main` (pull requests and `ci-ok`, no force pushes or deletion), and add
   a Dependabot entry for it that takes patch updates only.
2. Fix on `main` first, through a pull request, and label it `backport 2.0`.
3. Cherry-pick it to a branch from `release/2.0` (`git cherry-pick -x`) and
   open a pull request into `release/2.0`. Merge when `ci-ok` passes, and
   remove the label.
4. The release workflow accepts a tag like `v2.0.3` from `release/2.0`, and
   only that kind of tag.

**Making a maintenance release:**

1. Set the version with `npm run bump -- X.Y.Z`, through a pull request to
   the branch it comes from.
2. Tag `vX.Y.Z` on that commit and push the tag.
3. Run the release checklist; its hands-on steps on one Mac and one Windows
   computer are enough.
4. Check the in-app update from the previous release on one system, with
   settings and facts kept.
5. Fill in Fixed (and Security) in the release notes and publish it as a
   full release.
6. Upload changed `site/` files. A release from `release/2.0` also needs
   its changelog entry copied to `main`.
