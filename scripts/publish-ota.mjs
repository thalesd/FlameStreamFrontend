/**
 * Publish an over-the-air web-bundle update for the Android shell.
 *
 *   1. Bump WEB_VERSION in src/app/version.ts (and, if you want, notes in the manifest).
 *   2. node scripts/publish-ota.mjs
 *
 * It builds the native web bundle, zips it into the backend's AppReleases/android/bundle.zip
 * (index.html at the zip root, which is what capgo expects), and rewrites the backend
 * version.json so web.version === WEB_VERSION. Devices pick it up on their next cold launch.
 *
 * Note: this only ships WEB changes. If you changed native code / added a Capacitor plugin,
 * you must build + distribute a new APK and bump androidNative.versionCode instead.
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Locate the JDK `jar` tool: JAVA_HOME, then the Android Studio bundled JBR, then PATH. */
function findJar() {
  const candidates = [
    process.env.JAVA_HOME && resolve(process.env.JAVA_HOME, 'bin/jar.exe'),
    'C:/Program Files/Android/Android Studio/jbr/bin/jar.exe',
  ].filter(Boolean);
  return candidates.find((c) => existsSync(c)) ?? 'jar';
}

const FRONTEND = resolve(import.meta.dirname, '..');
const BROWSER_DIR = resolve(FRONTEND, 'dist/FlameStreamFrontend/browser');
const RELEASES = resolve(FRONTEND, '../FlameStreamBackend/AppReleases');
const BUNDLE_ZIP = resolve(RELEASES, 'android/bundle.zip');
const MANIFEST = resolve(RELEASES, 'version.json');

// 1. Read the version baked into this build.
const versionTs = readFileSync(resolve(FRONTEND, 'src/app/version.ts'), 'utf8');
const WEB_VERSION = versionTs.match(/WEB_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1];
if (!WEB_VERSION) throw new Error('Could not parse WEB_VERSION from src/app/version.ts');
console.log(`Publishing web bundle v${WEB_VERSION}`);

// 2. Build the native (service-worker-free) bundle.
console.log('Building (ng build --configuration native)...');
execSync('npm run build:native', { cwd: FRONTEND, stdio: 'inherit' });
if (!existsSync(BROWSER_DIR)) throw new Error(`Build output missing: ${BROWSER_DIR}`);

// 3. Zip the bundle contents at the archive root. We use the JDK `jar` tool, NOT PowerShell
// Compress-Archive: on Windows PowerShell 5.1 the latter writes ZIP entry names with backslashes
// (e.g. `icons\x.png`), which capgo's Java unzip on Android treats as literal filenames instead
// of subdirectories, misplacing nested assets. `jar` emits spec-correct forward slashes.
console.log(`Zipping -> ${BUNDLE_ZIP}`);
const jar = findJar();
execSync(`"${jar}" --create --no-manifest --file "${BUNDLE_ZIP}" -C "${BROWSER_DIR}" .`, {
  stdio: 'inherit',
});

// 4. Point the manifest at this version.
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
manifest.web = { ...manifest.web, version: WEB_VERSION, url: '/api/app/android/bundle.zip' };
writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Updated manifest web.version -> ${WEB_VERSION}`);
console.log('Done. Restart the backend if needed; devices update on next cold launch.');
