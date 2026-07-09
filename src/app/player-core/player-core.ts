// ── PlayerCore — framework-agnostic HLS media engine ────────────────────────────────────────
//
// The single source of truth for FlameStream playback, shared by the Angular web player
// (via PlayerStateService) and the Chromecast receiver (via receiver/main.ts, bundled to
// wwwroot with esbuild). Everything both sides copy-pasted lives here:
//   • hls.js lifecycle (startPosition:0 for in-progress EVENT playlists, fatal-error recovery)
//   • the X-Hls-Start-Offset header → absolute-time offset, and cue re-shifting
//   • subtitle <track> attach with ?shift= to compensate for the post-reload currentTime reset
//   • the buffered-check seek: native when in buffer, else reload so the backend can seek-transcode
//
// Consumer-specific bits (scrub overlays, seek-processing UI, buffer tuning, the sync-delay)
// are injected through PlayerCoreConfig / PlayerCoreCallbacks, so this file has no Angular and
// no Cast dependency.

import Hls from 'hls.js';

export type SeekState = 'idle' | 'processing' | 'error';
type TrackMode = 'showing' | 'hidden';

export interface SubtitleSpec {
  url: string;
  label?: string;
  lang?: string;
  /** Display mode, re-read on every (re)attach so the web player's on/off can vary over time. */
  mode: TrackMode | (() => TrackMode);
}

export interface PlayerCoreConfig {
  /** Extra hls.js config merged over the base (TV media stacks need tighter buffer limits). */
  hls?: Record<string, any>;
  /** Seconds subtracted from the offset when shifting cues (the web sync-delay); default 0. */
  extraSubtitleShift?: () => number;
  /** Clamp a seek target (the receiver keeps 2s off the end); default identity. */
  clampTarget?: (target: number) => number;
  /** Retry/timeout for seek reloads (web seek-processing UX); null on the receiver. */
  seekRetry?: { timeoutMs: number; maxRetries: number } | null;
  log?: (msg: string) => void;
}

export interface PlayerCoreCallbacks {
  onOffset?(offset: number): void;
  onManifestParsed?(isSeek: boolean): void;
  onSeekState?(state: SeekState, message?: string): void;
  onNonFatal?(details: string): void;
  onFatal?(type: string, details: string): void;
}

interface LoadOpts { play?: boolean; isSeek?: boolean; retries?: number; subtitle?: SubtitleSpec; }

export class PlayerCore {
  private hls?: Hls;
  private baseUrl = '';                 // stream URL without any ?start / ?query
  private offset = 0;                   // absolute time of the current manifest's local 0
  private activeSub: SubtitleSpec | null = null;
  private trackEl: HTMLTrackElement | null = null;
  private lastSeekTarget = 0;
  private manifestTimeout: any;
  private lastNonFatal = '';

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly cfg: PlayerCoreConfig = {},
    private readonly cb: PlayerCoreCallbacks = {},
  ) {}

  /** Absolute time of the current manifest's local 0 (= served segment start, header-corrected). */
  get startOffset() { return this.offset; }

  /** Current absolute (original-file) playback position. */
  absTime() { return this.video.currentTime + this.offset; }

  /** Fresh load of a title at an absolute start time. */
  load(baseUrl: string, start = 0, opts: { play?: boolean; subtitle?: SubtitleSpec } = {}) {
    this.baseUrl = baseUrl;
    this.loadAt(start, { play: opts.play !== false, isSeek: false, subtitle: opts.subtitle });
  }

  /** Reload the current title at an absolute time via a seek transcode (shows seek UI on web). */
  reloadFrom(target: number) {
    this.loadAt(Math.max(0, target), { play: true, isSeek: true });
  }

  retryLastSeek() {
    this.cb.onSeekState?.('idle');
    this.reloadFrom(this.lastSeekTarget);
  }

  /**
   * Seek to an absolute (original-file) time. In-buffer (or direct-file) seeks are native;
   * out-of-buffer HLS seeks reload so the backend can start a seek transcode.
   * resumePlaying: true → play after, false → pause after, omitted → leave play state untouched.
   */
  seek(target: number, opts: { resumePlaying?: boolean } = {}) {
    if (typeof target !== 'number' || isNaN(target) || !this.baseUrl) return;
    target = this.cfg.clampTarget ? this.cfg.clampTarget(target) : target;
    const isDirect = this.baseUrl.indexOf('.m3u8') === -1;
    const local = target - this.offset;

    let buffered = false;
    for (let i = 0; i < this.video.buffered.length; i++) {
      if (local >= this.video.buffered.start(i) - 1 && local <= this.video.buffered.end(i)) { buffered = true; break; }
    }

    if (buffered || isDirect) {
      this.video.currentTime = isDirect ? target : local;
      if (opts.resumePlaying === true) this.video.play().catch(() => {});
      else if (opts.resumePlaying === false) this.video.pause();
    } else {
      this.loadAt(target, { play: opts.resumePlaying !== false, isSeek: true });
    }
  }

  // ── Subtitles ────────────────────────────────────────────────────────────────

  /** Attach (or switch to) a subtitle track immediately, and remember it for re-attaches. */
  attachSubtitle(spec: SubtitleSpec) {
    this.activeSub = spec;
    this.buildTrack();
  }

  /** Change the current track's display mode without rebuilding it (used for on/off toggles). */
  setSubtitleMode(mode: TrackMode) {
    if (this.trackEl) this.trackEl.track.mode = mode;
  }

  /** Rebuild the active track (e.g. after the sync-delay changed, to re-apply the ?shift=). */
  reattachSubtitle() {
    if (this.activeSub) this.buildTrack();
  }

  detachSubtitle() {
    if (this.trackEl) { try { this.trackEl.remove(); } catch {} this.trackEl = null; }
    this.activeSub = null;
  }

  destroy() {
    clearTimeout(this.manifestTimeout);
    this.destroyHls();
    try { this.video.pause(); } catch {}
    this.video.removeAttribute('src');
    try { this.video.load(); } catch {}
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  private log(m: string) { this.cfg.log?.(m); }

  private destroyHls() {
    if (this.hls) { try { this.hls.destroy(); } catch {} this.hls = undefined; }
    if (this.trackEl) { try { this.trackEl.remove(); } catch {} this.trackEl = null; }
  }

  private buildTrack() {
    if (this.trackEl) { try { this.trackEl.remove(); } catch {} this.trackEl = null; }
    const a = this.activeSub;
    if (!a) return;
    const el = document.createElement('track');
    el.kind = 'subtitles';
    el.label = a.label || 'Legendas';
    el.srclang = a.lang || 'pt';
    // Native cue matching compares against raw currentTime, which resets to ~0 on every (re)load;
    // the backend rewrites cue times by ?shift=. Effective shift = offset minus the sync-delay.
    // blob: tracks (a manually-added local file) can't carry a query string, so attach as-is.
    const shift = this.offset - (this.cfg.extraSubtitleShift?.() ?? 0);
    const isBlob = a.url.startsWith('blob:');
    el.src = (shift !== 0 && !isBlob)
      ? `${a.url}${a.url.indexOf('?') !== -1 ? '&' : '?'}shift=${shift}`
      : a.url;
    this.video.appendChild(el);
    this.trackEl = el;
    el.track.mode = typeof a.mode === 'function' ? a.mode() : a.mode;
  }

  // The backend reports the absolute time of the manifest's local 0 in this header; it is the
  // served segment's start, not necessarily the requested target. Re-shift cues once it lands.
  private applyStartOffsetHeader(data: any) {
    const raw = data?.networkDetails?.getResponseHeader?.('X-Hls-Start-Offset');
    const s = raw != null ? parseFloat(raw) : NaN;
    if (isNaN(s) || s === this.offset) return;
    this.offset = s;
    this.cb.onOffset?.(s);
    if (this.activeSub) this.buildTrack();
  }

  private loadAt(absoluteStart: number, opts: LoadOpts) {
    const play = opts.play !== false;
    const isSeek = !!opts.isSeek;
    const retries = opts.retries ?? 0;
    if (opts.subtitle) this.activeSub = opts.subtitle;

    clearTimeout(this.manifestTimeout);
    this.destroyHls();
    this.offset = absoluteStart;         // provisional until X-Hls-Start-Offset corrects it
    if (isSeek) { this.lastSeekTarget = absoluteStart; this.cb.onSeekState?.('processing'); }

    const src = absoluteStart > 0 ? `${this.baseUrl}?start=${absoluteStart}` : this.baseUrl;
    this.log(`loadAt ${absoluteStart.toFixed(1)}s${play ? '' : ' (paused)'}`);

    // Direct file (progressive MP4) — native playback, native seeking.
    if (this.baseUrl.indexOf('.m3u8') === -1) {
      this.video.src = this.baseUrl;
      this.video.currentTime = absoluteStart;
      if (play) this.video.play().catch(() => {}); else this.video.pause();
      if (this.activeSub) this.buildTrack();
      return;
    }

    if (!Hls.isSupported()) {
      // Safari et al.: native HLS. No offset header / seek-transcode support, but plays.
      if (this.video.canPlayType('application/vnd.apple.mpegurl')) {
        this.video.src = src;
        this.video.load();
        if (play) this.video.play().catch(() => {});
      }
      if (isSeek) this.cb.onSeekState?.('idle');
      return;
    }

    // startPosition:0 — in-progress transcodes are EVENT playlists hls.js would otherwise treat
    // as live and start at the encode tip. Extra config (TV buffer limits) merges over this.
    this.hls = new Hls({ enableWorker: true, startPosition: 0, ...(this.cfg.hls || {}) });
    const hls = this.hls;

    hls.on(Hls.Events.MANIFEST_LOADED, (_e, d) => this.applyStartOffsetHeader(d));
    hls.on(Hls.Events.LEVEL_LOADED, (_e, d) => this.applyStartOffsetHeader(d));

    const onParsed = () => {
      clearTimeout(this.manifestTimeout);
      if (isSeek) this.cb.onSeekState?.('idle');
      if (play) this.video.play().catch(() => {}); else this.video.pause();
      hls.subtitleTrack = -1;                 // disable any in-manifest text track; we use <track>
      if (this.activeSub) this.buildTrack();
      this.cb.onManifestParsed?.(isSeek);
    };
    hls.once(Hls.Events.MANIFEST_PARSED, onParsed);

    hls.on(Hls.Events.ERROR, (_e, d) => {
      if (!d.fatal) {
        if (d.details !== this.lastNonFatal) { this.lastNonFatal = d.details; this.log('hls non-fatal: ' + d.details); }
        this.cb.onNonFatal?.(d.details);
        return;
      }
      this.log('hls FATAL ' + d.type + ' / ' + d.details);
      this.cb.onFatal?.(d.type, d.details);
      if (d.type === Hls.ErrorTypes.NETWORK_ERROR) {
        clearTimeout(this.manifestTimeout);
        this.loadAt(this.absTime(), { play, isSeek });   // reload where we were
      } else if (d.type === Hls.ErrorTypes.MEDIA_ERROR && this.hls) {
        this.hls.recoverMediaError();
      } else {
        this.destroyHls();
        if (isSeek && this.cfg.seekRetry) this.cb.onSeekState?.('error', 'Falha ao carregar o vídeo.');
      }
    });

    hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(src));
    hls.attachMedia(this.video);

    // Seek reloads can take a while for a brand-new position under load; give the backend a
    // generous ceiling before surfacing an error (web only — the receiver passes no seekRetry).
    const retry = this.cfg.seekRetry;
    if (isSeek && retry) {
      this.manifestTimeout = setTimeout(() => {
        hls.off(Hls.Events.MANIFEST_PARSED, onParsed);
        if (retries < retry.maxRetries) {
          this.loadAt(absoluteStart, { play, isSeek, retries: retries + 1 });
        } else {
          this.cb.onSeekState?.('error', 'O processamento está demorando mais que o esperado.');
        }
      }, retry.timeoutMs);
    }
  }
}
