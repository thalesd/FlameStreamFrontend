import { ApplicationConfig, provideBrowserGlobalErrorListeners, provideZoneChangeDetection, isDevMode, provideAppInitializer, inject } from '@angular/core';
import { provideRouter } from '@angular/router';

import { routes } from './app.routes';
import { provideServiceWorker } from '@angular/service-worker';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { Capacitor } from '@capacitor/core';
import { UpdateService } from './services/update.service';

// The Angular service worker is web/PWA-only. Inside the native Capacitor shells
// (Android WebView / Electron) the app updates via @capgo/capacitor-updater and
// electron-updater; a registered ngsw would fight those and can pin a stale bundle.
const serviceWorkerEnabled = !isDevMode() && !Capacitor.isNativePlatform();

export const appConfig: ApplicationConfig = {
  providers: [
    provideHttpClient(withFetch()),
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    provideServiceWorker('ngsw-worker.js', {
            enabled: serviceWorkerEnabled,
            registrationStrategy: 'registerWhenStable:30000'
          }),
    // Native OTA updater (Android). notifyReady() must fire on every launch to confirm the
    // current bundle is healthy (else capgo rolls it back); the network check runs in the
    // background so it never blocks startup — set()+reload happens only if an update lands.
    provideAppInitializer(() => {
      const updates = inject(UpdateService);
      updates.notifyReady();
      void updates.checkForUpdate();
    }),
  ]
};
