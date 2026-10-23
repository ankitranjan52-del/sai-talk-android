# Android status (honest)

| Piece | State |
|---|---|
| Online push-to-talk (server) | Works (tested earlier in a browser and on the Cloudflare deployment). |
| Mesh logic (routing, crypto, floor control) | 59 unit tests + simulation pass. Simulation is not radio. |
| Server offline pass (`/api/offline/enroll`) | Passes 10/10 integration checks against a local worker. Must be deployed. |
| Native Nearby link (`SaiNearbyPlugin.java`) | Written. Compiles in CI only if the build is green. **Never run on a phone.** |
| Foreground service (screen locked) | Written. **Never run on a phone.** |

## Known limits
- Android only. iPhone <-> Android direct links are not solved by any mainstream API.
- Needs Google Play Services (Nearby). Needs Bluetooth + Wi-Fi on; on Android 11 and older also Location ON.
- Range: Nearby is about tens of metres per hop. 500 m needs several phones in between. Not measured.
- Screen locked: the service keeps the process and radio alive, so receiving should work. Transmitting needs the screen on
  (the talk button is on screen). Whether Android's WebView keeps mic capture alive in the background is unverified.
- Battery: advertising and scanning together, all day, is heavy. Not measured. Turn Nearby on only at the event.
- Anyone nearby can open a Nearby link, but without an offline pass from your server they cannot talk or be heard.
- The APK uses a fixed test signing key stored in this repo. Fine for testing; make a private key before any wider rollout.

## First on-phone test (2-3 phones, ~10 minutes)
1. Install the APK, sign in on each, leave online for a minute, grant all permissions.
2. Turn Wi-Fi and mobile data OFF on all (Bluetooth ON).
3. Wait ~10 s: banner should say "Nearby mode: 2 phones in range".
4. Hold talk on one; the others should hear it. Note the delay, and the distance where it breaks.
5. Lock one phone, talk from another: does the locked phone play it?
