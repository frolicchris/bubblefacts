# Releasing BubbleFacts

For the maintainer. Contributors don't need any of this; see
[CONTRIBUTING.md](../.github/CONTRIBUTING.md).

**Releases** are made by the maintainer pushing a version tag, such as
`v2.0.0`. Version tags are protected, so a published release's tag can't be
moved or deleted. The Release workflow builds every installer on its own
system and puts them in a *draft* release with a `SHA256SUMS.txt` file and a
build-provenance attestation for each file, for a person to read over and
publish. A tag with a hyphen (`v2.0.0-beta.3`) becomes a pre-release.

## Code signing

Builds are signed only when the repository has the secrets below; without
them (and in forks) they come out unsigned, as now. The release log's
**Report signing** step says which.

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
