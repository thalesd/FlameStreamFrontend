# FlameStream native shell (Capacitor)

The same Angular build wrapped as native apps: **Android** (`@capacitor/android`) and,
later, **Windows** (`@capacitor-community/electron`). Auto-update is served self-hosted
from the ASP.NET backend under `/api/app/*`.

The web bundle is served **locally** from `webDir` (`dist/FlameStreamFrontend/browser`) —
there is no `server.url`. Every API/stream/thumbnail call goes to the remote backend via
`BACKEND_BASE` in `env-cast.ts`. Keeping the bundle local is what makes OTA bundle swaps
(Android) and installer updates (Windows) possible without an app-store round-trip.

## Build / sync workflow

```bash
npm run build:native   # ng build --configuration native  (no service worker)
npx cap sync android   # copy the fresh bundle into android/ + update plugins
# or the combined helpers:
npm run cap:sync       # build:native + cap sync
npm run cap:android    # cap:sync + cap open android
```

`build:native` uses the `native` Angular configuration (`angular.json`): production
optimization **without** the ngsw service worker, which is web/PWA-only and would fight
the native update mechanisms. Runtime SW registration is additionally gated off on native
via `Capacitor.isNativePlatform()` in `src/app/app.config.ts`.

## Building the Android APK

Toolchain is installed on the dev box (Android Studio + SDK, bundled JDK 21). The global
`ANDROID_HOME` / `JAVA_HOME` are not set, so:

- `android/local.properties` points Gradle at the SDK (`sdk.dir=...`, gitignored).
- Set `JAVA_HOME` to the bundled JBR per build.

**One command (any shell — PowerShell, cmd, bash):**

```bash
npm run build:apk               # cap:sync + assembleDebug → app/build/outputs/apk/debug/app-debug.apk
npm run build:apk -- --install  # also adb install -r onto the connected device
npm run build:apk -- --release  # assembleRelease instead
```

`scripts/build-apk.mjs` resolves `JAVA_HOME` (Android Studio's bundled JBR) and `adb` (from the SDK)
itself, and invokes the Gradle wrapper by **absolute path** (some Windows shells don't search the
current dir for `gradlew.bat`). Manual equivalent, if you prefer:

```bash
npm run cap:sync
cd android
JAVA_HOME="/c/Program Files/Android/Android Studio/jbr" ./gradlew assembleDebug   # git-bash
# PowerShell: $env:JAVA_HOME="C:\Program Files\Android\Android Studio\jbr"; .\gradlew.bat assembleDebug
```

A signed release build needs a keystore (kept out of git) — documented later in the release runbook.

## Launcher icon

```bash
npm run icons          # regenerate all Android icons from public/CozyFlameLogoColor.svg
```

`scripts/gen-icons.mjs` rasterizes the SVG into `assets/icon-{foreground,background,only}.png`,
runs `capacitor-assets generate --android`, then re-applies a fixed adaptive-icon XML
(capacitor-assets' default insets both layers 16.7%, which breaks a full-bleed solid
background — see the script comment). Rebuild the APK afterwards to bake the icon in.

## Auto-update (Android OTA)

`@capgo/capacitor-updater` in **self-hosted manual mode** (`autoUpdate: false` in
`capacitor.config.ts`). On every cold launch `UpdateService` (`src/app/services/update.service.ts`):

1. calls `notifyAppReady()` — confirms the running bundle is healthy; without it capgo
   auto-rolls-back on the next launch (this is the safety net for a bad bundle);
2. fetches `/api/app/version`, and if `web.version` is newer than the baked `WEB_VERSION`
   (`src/app/version.ts`) **and** the installed native `versionCode >= web.minAndroidVersionCode`,
   downloads `bundle.zip` and `set()`s it (reloads into the new bundle — no reinstall);
3. otherwise, if the *native* shell is behind (`androidNative.versionCode > installed`), raises
   `UpdateService.nativeUpdateAvailable` for the UI to prompt a full APK reinstall.

### Publishing a web (OTA) update

```bash
# 1. bump WEB_VERSION in src/app/version.ts
# 2.
npm run publish:ota
```

`scripts/publish-ota.mjs` builds the native bundle, zips it to
`../FlameStreamBackend/AppReleases/android/bundle.zip` (index.html at the zip root), and sets
the backend manifest's `web.version` to `WEB_VERSION`. Devices update on next cold launch.
Adding/altering **native** code or plugins still requires a fresh APK + an
`androidNative.versionCode` bump (not an OTA).

## Status

- [x] Capacitor 8 scaffolded; `android/` platform added, `cap sync` round-trips the bundle.
- [x] APK compiles and runs on a real Android device (loads the remote https backend).
- [x] Launcher icon (CozyFlame adaptive icon).
- [x] Backend `/api/app/*` update endpoints (manifest + artifact serving).
- [x] `@capgo/capacitor-updater` OTA web-bundle swap + native-update flag.
- [ ] UI surface for `nativeUpdateAvailable` (APK reinstall prompt) + APK install flow.
- [ ] Windows (`@capacitor-community/electron`) + electron-updater.
