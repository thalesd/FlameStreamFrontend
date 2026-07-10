// Full Android launcher-icon pipeline (run from frontend root, or `npm run icons`):
//   1. rasterize the CozyFlame SVG into the source PNGs @capacitor/assets consumes,
//   2. run capacitor-assets to fan them out across densities,
//   3. re-apply the fixed adaptive-icon XML (see note at the bottom).
import sharp from 'sharp';
import { execSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';

const SVG = 'public/CozyFlameLogoColor.svg';
const BG = { r: 0x0a, g: 0x08, b: 0x06, alpha: 1 }; // --cf-bg ember dark
mkdirSync('assets', { recursive: true });

const raster = (px) =>
  sharp(SVG, { density: 300 })
    .resize(px, px, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

// Adaptive foreground: logo at ~62% (640/1024) centered on transparent canvas (Android safe zone).
await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: await raster(640), gravity: 'center' }])
  .png()
  .toFile('assets/icon-foreground.png');

// Adaptive background: solid ember-dark.
await sharp({ create: { width: 1024, height: 1024, channels: 4, background: BG } })
  .png()
  .toFile('assets/icon-background.png');

// Legacy square / round / PWA icon: logo at ~78% on the ember-dark background.
await sharp({ create: { width: 1024, height: 1024, channels: 4, background: BG } })
  .composite([{ input: await raster(800), gravity: 'center' }])
  .png()
  .toFile('assets/icon-only.png');

console.log('generated sources:', readdirSync('assets'));

// 2. Fan the sources out into android/**/mipmap-* via @capacitor/assets.
console.log('running capacitor-assets...');
execSync('capacitor-assets generate --android', { stdio: 'inherit' });

// 3. capacitor-assets writes an adaptive-icon XML that wraps BOTH layers in <inset 16.7%>.
// With a full-bleed solid background that leaves transparent corners on edge-reaching launcher
// masks AND shrinks the logo too far, so overwrite with direct (un-inset) drawable refs. The
// foreground source already carries safe-zone padding (logo at ~62% of canvas).
const adaptiveXml = `<?xml version="1.0" encoding="utf-8"?>
<!-- Background is full-bleed solid ember-dark (no inset, so launcher masks never reveal
     transparent corners); foreground logo source already sits at ~62% within the safe zone. -->
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
`;
const anydpi = 'android/app/src/main/res/mipmap-anydpi-v26';
for (const f of ['ic_launcher.xml', 'ic_launcher_round.xml']) {
  writeFileSync(`${anydpi}/${f}`, adaptiveXml);
}
console.log('re-applied un-inset adaptive-icon XML. Done.');
