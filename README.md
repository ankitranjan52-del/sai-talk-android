# Sai Talk for Android

Push-to-talk walkie-talkie for Sai Electric. The same app as https://sai-talk.5mixnmatch.workers.dev, wrapped as an Android app, plus a
**Nearby mode**: when there is no internet, phones close to each other talk directly (Bluetooth + Wi-Fi, through Google Nearby Connections),
and phones in between can relay.

## Get the app
Every push to `main` builds an APK in GitHub Actions. Download it from **Releases > "Sai Talk test build"** (file `Sai-Talk-test.apk`),
open it on the phone and allow "install unknown apps". Updates install over the old one (same test signing key).

## How Nearby mode works
1. While the phone has internet it signs in and the app silently fetches an offline pass (a certificate + channel keys) from the server.
   The admin must switch it on once: Admin page > Offline mode > on (or `POST /api/admin/offline {"enabled":true}`).
2. If the server cannot be reached for 8 s, the app starts Nearby mode: banner "Nearby mode: N phones in range".
3. Talk as usual. Voice is end-to-end encrypted with the channel key; every phone relays for others.

## Status: read this before relying on it
See `docs/ANDROID-STATUS.md`. The native code compiles in CI, but it has **not been tested on real phones** by the author.
Range, delay, battery and screen-off behaviour are unmeasured. Android only; iPhone cannot join Nearby mode.

## Layout
- `www/` web app (copied from the Cloudflare project's `public/` with `scripts/sync-web.sh`)
- `android/app/src/main/java/com/saielectric/talk/` native: `SaiNearbyPlugin` (radio link), `SaiTalkService` (keeps running when locked)
- `.github/workflows/android.yml` the build
