/**
 * One-command Android build: web bundle -> cap sync -> debug APK. Handles the machine quirks so it
 * works from any shell (PowerShell, cmd, bash): it resolves JAVA_HOME (Android Studio's bundled JBR)
 * and invokes the right Gradle wrapper for the OS.
 *
 *   npm run build:apk              # build the APK
 *   npm run build:apk -- --install # build, then adb install -r onto the connected device
 *   npm run build:apk -- --release # assembleRelease instead of assembleDebug
 */
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const FRONTEND = resolve(import.meta.dirname, '..');
const ANDROID = join(FRONTEND, 'android');
const isWin = process.platform === 'win32';
const args = process.argv.slice(2);
const release = args.includes('--release');
const install = args.includes('--install');

/** Resolve a JDK: existing JAVA_HOME, else the Android Studio bundled JBR. */
function findJavaHome() {
  const javaBin = isWin ? 'bin/java.exe' : 'bin/java';
  const candidates = [
    process.env.JAVA_HOME,
    'C:/Program Files/Android/Android Studio/jbr',
    '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
    '/opt/android-studio/jbr',
  ].filter(Boolean);
  const found = candidates.find((c) => existsSync(join(c, javaBin)));
  if (!found) {
    console.error('No JDK found. Set JAVA_HOME or install Android Studio (bundled JBR).');
    process.exit(1);
  }
  return found;
}

/** Resolve adb from the Android SDK (PATH may not have it); falls back to a bare `adb`. */
function findAdb() {
  const exe = isWin ? 'adb.exe' : 'adb';
  const roots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Android/Sdk'),
    process.env.HOME && join(process.env.HOME, 'Library/Android/sdk'),
    process.env.HOME && join(process.env.HOME, 'Android/Sdk'),
  ].filter(Boolean);
  const found = roots.map((r) => join(r, 'platform-tools', exe)).find(existsSync);
  return found ? `"${found}"` : 'adb';
}

function run(cmd, opts = {}) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', ...opts });
}

const JAVA_HOME = findJavaHome();
console.log(`JAVA_HOME=${JAVA_HOME}`);

// 1. Angular (native config) + copy into the Android project.
run('npm run cap:sync', { cwd: FRONTEND });

// 2. Compile the APK with the resolved JDK. Invoke the wrapper by ABSOLUTE path — some Windows
// shells don't search the current directory for executables, so a bare `gradlew.bat` isn't found.
const task = release ? 'assembleRelease' : 'assembleDebug';
const gradlew = join(ANDROID, isWin ? 'gradlew.bat' : 'gradlew');
run(`"${gradlew}" ${task}`, { cwd: ANDROID, env: { ...process.env, JAVA_HOME } });

const apk = join(
  ANDROID,
  'app/build/outputs/apk',
  release ? 'release/app-release.apk' : 'debug/app-debug.apk'
);
console.log(`\n✅ APK: ${apk}`);

// 3. Optionally install onto the connected device.
if (install) {
  run(`${findAdb()} install -r "${apk}"`);
  console.log('\n✅ Installed on device.');
} else {
  console.log(`\nInstall with:  adb install -r "${apk}"`);
}
