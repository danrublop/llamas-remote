# Releasing Llamas Remote

Releases are cut by pushing a `v*` tag. GitHub Actions
(`.github/workflows/release.yml`) then builds the universal macOS DMG + ZIP,
signs and notarizes them (when the secrets below are set), and publishes them —
together with the `latest-mac.yml` update feed — to a GitHub Release.

## Cutting a release

```bash
./scripts/release.sh [patch|minor|major]   # bumps version, commits, tags v<x>, pushes
```

or manually:

```bash
npm version patch --no-git-tag-version
git commit -am "chore: release vX.Y.Z"
git tag vX.Y.Z && git push origin <branch> --follow-tags
```

The workflow reads the matching `## [X.Y.Z]` section out of `CHANGELOG.md` and
uses it as the GitHub Release notes, so keep the changelog current.

## Auto-update

The app ships `electron-updater`. On launch (packaged builds only) it checks the
GitHub Release feed, downloads a newer version in the background, and installs it
on the next quit. There's also a **Check for Updates…** item in the menu-bar
tray.

> Auto-update on macOS only works for **signed + notarized** builds —
> electron-updater verifies the signature before installing. An unsigned build
> still runs, but it will not auto-update.

## Signing + notarization (required for a smooth install + auto-update)

Without these, the build is unsigned: Gatekeeper blocks it (users must
right-click → Open) and auto-update won't install. The build **does not fail**
without them — `build-resources/notarize.js` no-ops when the Apple credentials
are absent.

Add these as **GitHub Actions repository secrets** (Settings → Secrets and
variables → Actions):

| Secret | What it is |
| --- | --- |
| `MAC_CERT_P12_BASE64` | Your "Developer ID Application" certificate exported as a `.p12`, base64-encoded: `base64 -i cert.p12 \| pbcopy` |
| `MAC_CERT_PASSWORD` | The password you set when exporting the `.p12` |
| `APPLE_ID` | Your Apple Developer account email |
| `APPLE_APP_SPECIFIC_PASSWORD` | An app-specific password from appleid.apple.com (not your login password) |
| `APPLE_TEAM_ID` | Your 10-character Apple Developer Team ID |

`GITHUB_TOKEN` is provided automatically by Actions — no setup needed.

Once the secrets exist, the next tagged release is signed, notarized, and
auto-updatable end to end. To verify locally:

```bash
export APPLE_ID=... APPLE_APP_SPECIFIC_PASSWORD=... APPLE_TEAM_ID=...
export CSC_LINK=/path/to/cert.p12 CSC_KEY_PASSWORD=...
npm run build:mac        # signs + notarizes without publishing
```
