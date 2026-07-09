// Shared formatters used across browse tiles, the player, the processing tracker and the
// resume banner. Pulled out of HomeComponent so every split component can reuse one copy.

/** `H:MM:SS` (or `M:SS` under an hour). `0:00` for falsy/NaN. */
export function formatTime(s: number): string {
  if (!s || isNaN(s)) return '0:00';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const mm = m.toString().padStart(2, '0');
  const ss = sec.toString().padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/** Human byte size, e.g. `1.4 GB`. */
export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes, i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(i > 0 && value < 10 ? 1 : 0)} ${units[i]}`;
}
