import type { CapacitorConfig } from '@capacitor/cli';

// FlameStream native shell (Android + Windows/Electron).
//
// The web bundle is served LOCALLY from `webDir` (no `server.url`): the shell is a
// static Angular build, and every API/stream/thumbnail request goes to the remote
// backend through BACKEND_BASE in env-cast.ts. Keeping the bundle local is what lets
// @capgo/capacitor-updater hot-swap it (Android) and electron-updater replace the app
// (Windows) without a store round-trip.
//
// androidScheme 'https' gives the WebView an https origin, so calls to the real
// https backend are same-scheme (no cleartext / mixed-content exceptions needed).
const config: CapacitorConfig = {
  appId: 'com.tdonsoft.flamestream',
  appName: 'FlameStream',
  webDir: 'dist/FlameStreamFrontend/browser',
  android: {
    allowMixedContent: false,
  },
  server: {
    androidScheme: 'https',
  },
  plugins: {
    CapacitorUpdater: {
      // Self-hosted manual mode: the plugin does NOT phone the Capgo cloud or auto-check.
      // UpdateService drives download()/set() against our own /api/app/version manifest.
      // notifyAppReady() + the built-in appReadyTimeout still give us automatic rollback
      // if a freshly-set bundle fails to boot.
      autoUpdate: false,
    },
  },
};

export default config;
