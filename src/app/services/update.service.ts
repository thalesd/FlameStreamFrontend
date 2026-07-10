import { Injectable, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { CapacitorUpdater } from '@capgo/capacitor-updater';
import { App } from '@capacitor/app';
import { BACKEND_BASE } from '../../../env-cast';
import { WEB_VERSION } from '../version';

interface VersionManifest {
  web?: { version: string; url: string; minAndroidVersionCode?: number; notes?: string };
  androidNative?: { versionCode: number; versionName: string; url: string };
}

/**
 * Self-hosted over-the-air updater for the Android shell. On cold launch it asks the backend
 * (/api/app/version) whether a newer web bundle exists and, if the installed native shell is
 * new enough to run it, downloads and hot-swaps it via @capgo/capacitor-updater — no Play Store,
 * no APK reinstall. If instead the *native* shell itself is behind (a bundle needs newer native
 * code / plugins), it raises {@link nativeUpdateAvailable} so the UI can prompt a full reinstall.
 *
 * Windows/Electron does NOT use this path — it updates via electron-updater.
 */
@Injectable({ providedIn: 'root' })
export class UpdateService {
  /** Set when a full APK reinstall is required (manifest's native versionCode > installed). */
  readonly nativeUpdateAvailable = signal<{ versionName: string; url: string } | null>(null);

  /**
   * Confirm the current bundle booted successfully. MUST be called early on every launch:
   * without it, capgo assumes the last-set bundle is broken and rolls back on the next start.
   * No-op off-device.
   */
  async notifyReady(): Promise<void> {
    if (!Capacitor.isNativePlatform()) return;
    try {
      await CapacitorUpdater.notifyAppReady();
    } catch {
      /* not fatal — plugin may be absent (web/older shell) */
    }
  }

  /** Cold-launch update check. Safe to call unconditionally; no-ops on non-Android platforms. */
  async checkForUpdate(): Promise<void> {
    if (Capacitor.getPlatform() !== 'android') return;

    let manifest: VersionManifest;
    try {
      const res = await fetch(`${BACKEND_BASE}/api/app/version`, { cache: 'no-store' });
      if (!res.ok) return;
      manifest = await res.json();
    } catch {
      return; // backend offline / unreachable — just keep running the current bundle
    }

    const installedCode = await this.installedVersionCode();
    const web = manifest.web;

    // Preferred path: OTA-swap the web bundle, but only if this native shell can run it.
    if (web && isNewer(web.version, WEB_VERSION)) {
      if (installedCode >= (web.minAndroidVersionCode ?? 0)) {
        await this.applyBundle(web.version, web.url);
        return; // set() reloads the webview into the new bundle; nothing after this runs
      }
    }

    // Fallback: the native shell is too old — surface a full-reinstall prompt instead.
    const nat = manifest.androidNative;
    if (nat && nat.versionCode > installedCode) {
      this.nativeUpdateAvailable.set({ versionName: nat.versionName, url: nat.url });
    }
  }

  private async applyBundle(version: string, url: string): Promise<void> {
    const abs = url.startsWith('http') ? url : `${BACKEND_BASE}${url}`;
    const bundle = await CapacitorUpdater.download({ version, url: abs });
    // set() activates immediately and reloads. (Use CapacitorUpdater.next({id}) instead to defer
    // activation to the next launch if a mid-session reload ever becomes disruptive.)
    await CapacitorUpdater.set({ id: bundle.id });
  }

  private async installedVersionCode(): Promise<number> {
    try {
      const info = await App.getInfo(); // Android: build === versionCode
      return parseInt(info.build, 10) || 0;
    } catch {
      return 0;
    }
  }
}

/** Numeric-dotted "newer than" compare (e.g. 1.0.10 > 1.0.9). Non-numeric segments sort as 0. */
function isNewer(candidate: string, base: string): boolean {
  const a = candidate.split('.');
  const b = base.split('.');
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = parseInt(a[i] ?? '0', 10) || 0;
    const y = parseInt(b[i] ?? '0', 10) || 0;
    if (x !== y) return x > y;
  }
  return false;
}
