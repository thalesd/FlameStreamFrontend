/**
 * Version of THIS web bundle (baked into the build). The running app compares it against
 * the backend manifest at /api/app/version to decide whether an OTA swap is needed.
 *
 * Release step: bump this AND `AppReleases/version.json` -> web.version together, then
 * publish the new bundle.zip (see scripts/publish-ota.mjs). After capgo applies a bundle,
 * the now-running code carries the new value here, so the next launch sees "up to date".
 */
export const WEB_VERSION = '1.0.0';
