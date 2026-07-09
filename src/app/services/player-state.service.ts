import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { PlayerCore, SubtitleSpec } from '../player-core/player-core';
import { MediaService, MediaItem, MediaFileNode } from './media.service';
import { CastService } from './cast.service';
import { WatchHistoryService } from './watch-history.service';
import { LibraryService } from './library.service';
import { FireplaceService } from './fireplace.service';
import { formatTime } from '../util/format';

export type CastTrack = { id: number; lang: string; name: string; url: string; source: 'EXT' | 'EMB' };

/**
 * Owns playback: the selected title, the local hls.js engine, seek/scrub, subtitles, cast
 * routing, resume and up-next. Split out of HomeComponent so the player view and its controls
 * are thin components over one shared state. The player component registers its <video> /
 * container / progress-area elements via {@link setVideo} etc.
 *
 * Frequently-updated fields are signals so views stay reactive without a ChangeDetectorRef.
 */
@Injectable({ providedIn: 'root' })
export class PlayerStateService {
  private media        = inject(MediaService);
  readonly cast        = inject(CastService);
  private watchHistory = inject(WatchHistoryService);
  private lib          = inject(LibraryService);
  private fire         = inject(FireplaceService);

  selected = signal<MediaItem | null>(null);

  // ── Player UI state ─────────────────────────────────────────────────────────
  isPlaying          = signal(false);
  isMuted            = signal(false);
  isFullscreen       = signal(false);
  showControls       = signal(true);
  currentTime        = signal(0);
  duration           = signal(0);
  volume             = signal(1);
  buffered           = signal(0);
  subtitlesOn        = signal(false);
  subtitlesAvailable = signal(false);
  scrubbing          = signal(false);   // true while the seek bar is being pressed/dragged
  scrubValue         = signal(0);
  castUseDirectFile  = signal(false);

  // Scene preview popup shown while hovering / arrow-previewing the seek bar.
  scenePreview = signal<{ time: number; leftPx: number; url: string } | null>(null);

  castActiveTrackId = signal<number | null>(null);
  showTrackMenu     = signal(false);
  seekProcessing    = signal(false);
  seekError         = signal<string | null>(null);

  resumeInfo = signal<{ position: number; label: string } | null>(null);
  private pendingAutoResume = false;

  // "Up next" auto-advance: when an episode ends, the next file in the same folder is queued.
  upNext = signal<{ file: MediaFileNode; seconds: number } | null>(null);
  private readonly UP_NEXT_SECONDS = 8;
  private upNextInterval: any;

  // Subtitles & captions panel (design 3c)
  showSubtitles = signal(false);
  subtitleDelay = signal(0);                                   // seconds, + = later
  subtitleSize  = signal<'small' | 'medium' | 'large'>('medium');
  localSubName  = signal<string | null>(null);                // a manually-added file

  // ── Registered DOM elements (owned by the player component) ─────────────────
  private video?: HTMLVideoElement;
  private container?: HTMLElement;
  private progressArea?: HTMLElement;
  private core?: PlayerCore;

  setVideo(el?: HTMLVideoElement) {
    this.video = el;
    if (el) {
      // The shared media engine. Web config: sync-delay shifts cues; seek reloads show the
      // "processando" UI with a generous retry ceiling.
      this.core = new PlayerCore(el, {
        extraSubtitleShift: () => this.subtitleDelay(),
        seekRetry: { timeoutMs: 45000, maxRetries: 3 },
      }, {
        onSeekState: (s, msg) => {
          if (s === 'processing') { this.seekProcessing.set(true); this.seekError.set(null); }
          else if (s === 'idle')  { this.seekProcessing.set(false); }
          else                    { this.seekProcessing.set(false); this.seekError.set(msg ?? 'Falha ao carregar o vídeo.'); }
        },
      });
    } else {
      this.core?.destroy();
      this.core = undefined;
    }
  }
  setContainer(el?: HTMLElement)    { this.container = el; }
  setProgressArea(el?: HTMLElement) { this.progressArea = el; }

  /** Called by the player component on destroy: persist progress, tear down HLS, drop refs. */
  teardownPlayer() {
    this.saveWatchProgress();
    this.setVideo(undefined);
    this.setContainer(undefined);
    this.setProgressArea(undefined);
  }

  /** A subtitle spec whose display mode follows the user's on/off toggle. */
  private subSpec(url: string): SubtitleSpec {
    return { url, label: 'Legendas', lang: 'pt', mode: () => (this.subtitlesOn() ? 'showing' : 'hidden') };
  }

  // ── Internal player plumbing ────────────────────────────────────────────────
  private controlsTimer: any;
  private pointerScrub = false;
  private arrowSeekActive = false;
  private readonly ARROW_STEP = 10;
  private resumeDismissTimer: any;
  private watchHistoryTimer: any;

  castTracks = computed<CastTrack[]>(() => {
    const s = this.selected();
    if (!s) return [];
    const tracks: CastTrack[] = [];
    if (s.subUrl) tracks.push({ id: 1, lang: 'pt', name: 'Legendas', url: s.subUrl, source: 'EXT' });
    s.embeddedSubtitles.forEach((sub, i) => tracks.push({
      id:     i + (s.subUrl ? 2 : 1),
      lang:   sub.language || 'und',
      name:   sub.title    || sub.language || `Track ${i + 1}`,
      url:    sub.url,
      source: 'EMB',
    }));
    return tracks;
  });

  // "Included with this title" = embedded tracks; "From your library" = external side-files.
  includedTracks = computed(() => this.castTracks().filter(t => t.source === 'EMB'));
  externalTracks = computed(() => this.castTracks().filter(t => t.source === 'EXT'));

  // Adjacent episodes for the ⏮/⏭ controls (null → button hidden).
  prevEpisode = computed(() => {
    const sel = this.selected();
    return sel ? this.lib.findAdjacentEpisode(sel.path, -1) : null;
  });
  nextEpisode = computed(() => {
    const sel = this.selected();
    return sel ? this.lib.findAdjacentEpisode(sel.path, 1) : null;
  });

  private beforeUnloadHandler = () => this.saveWatchProgress();
  private keydownHandler = (e: KeyboardEvent) => this.onGlobalKeydown(e);

  constructor() {
    this.cast.init();

    // Load locally when a file is selected and cast is not active.
    effect(() => {
      const sel = this.selected();
      if (!sel) return;
      if (this.cast.isConnected()) { this.core?.destroy(); return; }
      this.subtitlesAvailable.set(!!(sel.subUrl || sel.embeddedSubtitles?.length));
      this.subtitlesOn.set(false);
      // HLS by default for casting: the receiver drives playback itself with hls.js (the TV's
      // CAF PlayerManager is broken for all media — see receiver.js), so HLS works universally,
      // MKV transcodes included. DIR remains a manual override for plain MP4s.
      this.castUseDirectFile.set(false);
      this.currentTime.set(0);
      this.duration.set(sel.duration ?? 0);
      this.clearResumeTimer();
      this.resumeInfo.set(null);
      this.clearUpNext();
      this.scenePreview.set(null);
      const effectiveSub = sel.subUrl || sel.embeddedSubtitles?.[0]?.url;
      setTimeout(() => this.loadLocal(sel.url, effectiveSub ?? undefined));
      this.checkResume(sel);
    });

    // Detach local player when cast connects.
    effect(() => {
      if (this.cast.isConnected()) this.core?.destroy();
    });

    // Default subtitle track to first available when selection changes.
    effect(() => {
      const tracks = this.castTracks();
      this.castActiveTrackId.set(tracks.length > 0 ? tracks[0].id : null);
    });

    document.addEventListener('fullscreenchange', () => {
      this.isFullscreen.set(!!document.fullscreenElement);
    });
    this.watchHistoryTimer = setInterval(() => this.saveWatchProgress(), 8000);
    window.addEventListener('beforeunload', this.beforeUnloadHandler);
    window.addEventListener('keydown', this.keydownHandler);
  }

  // ── Selection / navigation ──────────────────────────────────────────────────

  select(file: MediaFileNode, autoResume: boolean = false) {
    this.pendingAutoResume = autoResume;
    this.selected.set(this.media.toMediaItem(file));
  }

  openContinueWatching(item: { file: MediaFileNode }) {
    this.select(item.file, true);
  }

  // Return from the player to the browse home. Saves progress and tears down the local HLS
  // instance so the freed <video> element doesn't keep a stale pipeline attached, then refreshes
  // the Continue Watching shelf so it reflects this session (new/updated/finished title).
  async closePlayer() {
    await this.saveWatchProgress();
    this.core?.destroy();
    this.selected.set(null);
    this.lib.loadContinueWatching();
  }

  // ── Watch history / resume ───────────────────────────────────────────────────

  async saveWatchProgress(): Promise<void> {
    const sel = this.selected();
    if (!sel) return;
    const isCasting = this.cast.isConnected();
    const position  = isCasting ? this.cast.castCurrentTime() : this.currentTime();
    const duration  = (isCasting ? this.cast.castDuration() : 0) || this.duration() || sel.duration || 0;
    if (!position || position <= 0) return;
    await this.watchHistory.save(sel.path, position, duration);
  }

  private async checkResume(sel: MediaItem) {
    const autoResume = this.pendingAutoResume;
    this.pendingAutoResume = false;

    const entry = await this.watchHistory.get(sel.path);
    if (this.selected()?.path !== sel.path) return; // selection changed while awaiting

    const dur = entry?.durationSeconds || sel.duration || 0;
    const eligible = !!entry && entry.positionSeconds > 15 && (dur <= 0 || entry.positionSeconds < dur * 0.95);
    if (!eligible) { this.resumeInfo.set(null); return; }

    if (autoResume) {
      this.reloadFrom(entry!.positionSeconds);
    } else {
      this.resumeInfo.set({ position: entry!.positionSeconds, label: formatTime(entry!.positionSeconds) });
      // Auto-dismiss the prompt after 5s so it doesn't sit over playback if ignored.
      this.clearResumeTimer();
      this.resumeDismissTimer = setTimeout(() => this.dismissResume(), 5000);
    }
  }

  private clearResumeTimer() { clearTimeout(this.resumeDismissTimer); }

  resumeFromHistory() {
    const info = this.resumeInfo();
    if (!info) return;
    this.clearResumeTimer();
    this.resumeInfo.set(null);
    this.reloadFrom(info.position);
  }

  dismissResume() {
    this.clearResumeTimer();
    this.resumeInfo.set(null);
  }

  // ── Controls ────────────────────────────────────────────────────────────────

  togglePlay() {
    if (this.cast.isConnected()) { this.cast.togglePlay(); return; }
    const v = this.video;
    if (!v) return;
    v.paused ? v.play() : v.pause();
  }

  /**
   * Tap/click on the video surface. On touch devices a tap must NOT pause — it reveals the
   * controls (and re-arms their auto-hide); pausing is the play/pause button's job. On a fine
   * pointer (desktop) click keeps its familiar toggle-play behaviour.
   */
  onVideoClick() {
    const coarse = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
    if (coarse) {
      if (this.showControls()) this.showControls.set(false);   // second tap dismisses them
      else this.onMouseMove();                                 // first tap shows + arms auto-hide
      return;
    }
    this.togglePlay();
  }

  toggleMute() {
    if (this.cast.isConnected()) {
      this.isMuted.set(!this.isMuted());
      this.cast.setMuted(this.isMuted());
      return;
    }
    const v = this.video;
    if (!v) return;
    v.muted = !v.muted;
    this.isMuted.set(v.muted);
  }

  setVolume(e: Event) {
    const val = +(e.target as HTMLInputElement).value;
    this.volume.set(val);
    this.isMuted.set(val === 0);
    if (this.cast.isConnected()) { this.cast.setVolume(val); return; }
    const v = this.video;
    if (!v) return;
    v.volume = val;
  }

  skip(sec: number) {
    if (this.cast.isConnected()) {
      const t = this.cast.castCurrentTime();
      const dur = this.cast.castDuration() || this.duration();
      this.cast.seek(Math.max(0, Math.min(dur, t + sec)));
      return;
    }
    const v = this.video;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + sec));
  }

  toggleFullscreen() {
    const el = this.container;
    if (!el) return;
    if (!document.fullscreenElement) el.requestFullscreen();
    else document.exitFullscreen();
  }

  onMouseMove() {
    this.showControls.set(true);
    clearTimeout(this.controlsTimer);
    this.controlsTimer = setTimeout(() => {
      if (this.isPlaying()) this.showControls.set(false);
    }, 2800);
  }

  // ── Seek bar: drag-to-preview, commit-on-release ────────────────────────────
  // The actual seek fires once, on release — not on every input tick (which previously
  // re-transcoded repeatedly and yanked the handle back to the play position mid-drag).

  private timeFromClientX(e: PointerEvent): number {
    const dur = (this.cast.isConnected() ? this.cast.castDuration() : 0) || this.duration();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    return frac * dur;
  }

  onScrubPointerDown(e: PointerEvent) {
    this.pointerScrub = true;
    this.scrubbing.set(true);
    this.scrubValue.set(this.timeFromClientX(e));
    try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch {}
  }

  onScrubPointerMove(e: PointerEvent) {
    if (!this.pointerScrub) return; // ignore plain hover; only track an active drag
    this.scrubValue.set(this.timeFromClientX(e));
  }

  onScrubKeyDown() {
    if (this.scrubbing()) return;
    this.scrubbing.set(true);
    this.scrubValue.set(this.cast.isConnected() ? this.cast.castCurrentTime() : this.currentTime());
  }

  onScrubInput(e: Event) {
    if (this.pointerScrub) return; // pointer path owns scrubValue via clientX
    this.scrubbing.set(true);
    this.scrubValue.set(+(e.target as HTMLInputElement).value);
  }

  onScrubEnd() {
    if (!this.scrubbing()) return;
    this.scrubbing.set(false);
    this.pointerScrub = false;
    this.commitSeek(this.scrubValue());
  }

  private commitSeek(val: number) {
    if (this.cast.isConnected()) {
      this.currentTime.set(val);
      this.cast.seek(val);
      return;
    }
    // Buffered-check → native seek, else reload so the backend can seek-transcode (PlayerCore).
    this.core?.seek(val);
  }

  // ── Seek-bar scene preview ───────────────────────────────────────────────────

  onSeekHover(e: MouseEvent) {
    const sel = this.selected();
    const dur = (this.cast.isConnected() ? this.cast.castDuration() : 0) || this.duration();
    if (!sel?.thumbUrl || dur <= 0) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const time = frac * dur;
    // Snap to the backend's 10s preview grid so the <img> src only changes once per bucket.
    const bucket = Math.max(0, Math.floor(time / 10) * 10);
    const halfW = 80;
    const leftPx = Math.min(Math.max(frac * rect.width, halfW), Math.max(halfW, rect.width - halfW));
    this.scenePreview.set({ time, leftPx, url: `${sel.thumbUrl}?t=${bucket}` });
  }

  onSeekLeave() {
    // Don't clear the popup out from under an active keyboard-seek preview.
    if (this.arrowSeekActive) return;
    this.scenePreview.set(null);
  }

  onThumbError(url: string) { this.lib.onThumbError(url); }

  // ── Keyboard seek preview (← / →, commit with Space) ────────────────────────
  // Arrow keys don't jump the video — they pause it and scrub a *preview*: each press nudges
  // the target ±10s and shows the scene thumbnail. Space commits and resumes (Esc cancels).

  private onGlobalKeydown(e: KeyboardEvent) {
    if (this.fire.active()) return;   // the screensaver swallows keys to wake, not seek
    if (!this.selected()) return;
    const tag = (document.activeElement?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;

    switch (e.key) {
      case 'ArrowRight': e.preventDefault(); this.arrowSeek(1);  break;
      case 'ArrowLeft':  e.preventDefault(); this.arrowSeek(-1); break;
      case ' ':
      case 'Spacebar':
        e.preventDefault();
        if (!this.commitArrowSeek()) this.togglePlay();
        break;
      case 'Escape':
        if (this.arrowSeekActive) { e.preventDefault(); this.cancelArrowSeek(); }
        break;
    }
  }

  private arrowSeek(dir: 1 | -1) {
    if (this.cast.isConnected()) return;   // casting uses the receiver's own remote
    const dur = this.duration();
    if (!dur) return;

    if (!this.arrowSeekActive) {
      this.arrowSeekActive = true;
      this.scrubbing.set(true);            // reuse the drag-preview handle rendering
      this.video?.pause();                 // freeze the frame while hunting
      this.scrubValue.set(this.currentTime());
    }
    this.scrubValue.set(Math.max(0, Math.min(dur, this.scrubValue() + dir * this.ARROW_STEP)));
    this.updateArrowPreview();
  }

  private updateArrowPreview() {
    const sel = this.selected();
    const dur = this.duration();
    if (!sel?.thumbUrl || !dur) return;
    const val = this.scrubValue();
    const frac = val / dur;
    const bucket = Math.max(0, Math.floor(val / 10) * 10);
    const width = this.progressArea?.getBoundingClientRect().width ?? 0;
    const halfW = 80;
    const leftPx = width
      ? Math.min(Math.max(frac * width, halfW), Math.max(halfW, width - halfW))
      : frac * 100;
    this.scenePreview.set({ time: val, leftPx, url: `${sel.thumbUrl}?t=${bucket}` });
  }

  /** Commit a pending keyboard-seek preview. Returns false if none was active. */
  private commitArrowSeek(): boolean {
    if (!this.arrowSeekActive) return false;
    const target = this.scrubValue();
    this.arrowSeekActive = false;
    this.scrubbing.set(false);
    this.scenePreview.set(null);
    this.commitSeek(target);
    this.video?.play().catch(() => {});
    return true;
  }

  private cancelArrowSeek() {
    this.arrowSeekActive = false;
    this.scrubbing.set(false);
    this.scenePreview.set(null);
    this.video?.play().catch(() => {});
  }

  // ── Subtitles ────────────────────────────────────────────────────────────────

  toggleSubtitles() {
    this.subtitlesOn.set(!this.subtitlesOn());
    this.core?.setSubtitleMode(this.subtitlesOn() ? 'showing' : 'hidden');
  }

  setCastTrack(id: number | null) {
    this.castActiveTrackId.set(id);
    this.showTrackMenu.set(false);

    // While casting, the receiver handles track switching.
    if (this.cast.isConnected()) { this.cast.activateTrack(id); return; }

    // Local playback: switch the native <track> to the chosen subtitle. Every track in
    // castTracks() — the external sidecar and each embedded track (served as VTT by the
    // backend) — is selectable here, so embedded subs are watchable locally too.
    if (id === null) {
      this.subtitlesOn.set(false);
      this.core?.setSubtitleMode('hidden');
      return;
    }
    const track = this.castTracks().find(t => t.id === id);
    if (!track) return;
    this.subtitlesOn.set(true);
    this.core?.attachSubtitle(this.subSpec(track.url));
  }

  toggleTrackMenu() { this.showTrackMenu.update(v => !v); }
  closeTrackMenu()  { this.showTrackMenu.set(false); }

  openSubtitles()  { this.showSubtitles.set(true); }
  closeSubtitles() { this.showSubtitles.set(false); }

  adjustSubtitleDelay(delta: number) {
    this.subtitleDelay.update(d => Math.round((d + delta) * 10) / 10);
    this.core?.reattachSubtitle();   // re-apply cue ?shift= with the new delay
  }
  resetSubtitleDelay() { this.subtitleDelay.set(0); this.core?.reattachSubtitle(); }

  setSubtitleSize(size: 'small' | 'medium' | 'large') { this.subtitleSize.set(size); }
  subtitleSizeLabel(): string {
    return { small: 'Pequeno', medium: 'Médio', large: 'Grande' }[this.subtitleSize()];
  }

  onSubtitleFilePicked(file: File) {
    // <track> renders WebVTT only; .srt would need backend conversion (a later feature).
    if (!/\.vtt$/i.test(file.name)) {
      alert('Por enquanto, apenas arquivos .vtt podem ser carregados manualmente.');
      return;
    }
    if (!this.core) return;
    this.subtitlesOn.set(true);
    this.core.attachSubtitle(this.subSpec(URL.createObjectURL(file)));
    this.localSubName.set(file.name);
  }

  // Compact label for the popup trigger: the active track's language code, or "Off".
  activeTrackLabel(): string {
    const id = this.castActiveTrackId();
    if (id === null) return 'Off';
    const t = this.castTracks().find(t => t.id === id);
    return (t?.lang || 'CC').toUpperCase();
  }

  // ── Video events ──────────────────────────────────────────────────────────

  onPlay()  { this.isPlaying.set(true); this.fire.setPlaying(true); this.clearUpNext(); }
  onPause() { this.isPlaying.set(false); this.fire.setPlaying(false); this.showControls.set(true); this.saveWatchProgress(); }
  async onEnded() {
    this.isPlaying.set(false);
    this.fire.setPlaying(false);
    this.showControls.set(true);
    await this.saveWatchProgress();
    // A finished title is now ≥95% watched, so refreshing drops it from Continue Watching.
    this.lib.loadContinueWatching();
    this.maybeQueueNextEpisode();
  }

  onTimeUpdate() {
    const v = this.video;
    if (!v) return;
    const offset = this.core?.startOffset ?? 0;
    this.currentTime.set(v.currentTime + offset);
    if (!this.selected()?.duration) {
      this.duration.set(isFinite(v.duration) ? v.duration : 0);
    }
    const dur = this.duration();
    if (v.buffered.length > 0 && dur > 0) {
      this.buffered.set(((v.buffered.end(v.buffered.length - 1) + offset) / dur) * 100);
    }
  }

  onVolumeChange() {
    const v = this.video;
    if (!v) return;
    this.isMuted.set(v.muted);
    this.volume.set(v.volume);
  }

  // ── Up next / auto-advance ──────────────────────────────────────────────────

  goToEpisode(node: MediaFileNode | null) {
    if (!node) return;
    this.select(node);
    // If casting, push the new episode to the receiver too (⏮/⏭ act as the remote).
    if (this.cast.isConnected()) this.castSelected();
  }

  private maybeQueueNextEpisode() {
    if (this.cast.isConnected()) return;   // casting is driven by the receiver
    const sel = this.selected();
    if (!sel) return;
    const next = this.lib.findAdjacentEpisode(sel.path, 1);
    if (!next) return;

    this.clearUpNext();
    this.upNext.set({ file: next, seconds: this.UP_NEXT_SECONDS });
    this.upNextInterval = setInterval(() => {
      const cur = this.upNext();
      if (!cur) return;
      if (cur.seconds <= 1) {
        this.playNextEpisode();
      } else {
        this.upNext.set({ file: cur.file, seconds: cur.seconds - 1 });
      }
    }, 1000);
  }

  playNextEpisode() {
    const cur = this.upNext();
    if (!cur) return;
    this.clearUpNext();
    this.select(cur.file);
  }

  cancelUpNext() { this.clearUpNext(); }

  private clearUpNext() {
    clearInterval(this.upNextInterval);
    this.upNextInterval = undefined;
    this.upNext.set(null);
  }

  // ── Cast ──────────────────────────────────────────────────────────────────

  async castSelected() {
    const s = this.selected();
    if (!s) return;
    try {
      await this.cast.requestSession();

      let url: string;
      let mime: string;
      if (this.castUseDirectFile()) {
        const ext = s.directUrl.split('.').pop()?.toLowerCase() ?? '';
        mime = ext === 'mkv' ? 'video/x-matroska'
             : ext === 'mov' ? 'video/quicktime'
             : ext === 'avi' ? 'video/x-msvideo'
             : 'video/mp4';
        url = s.directUrl;
      } else {
        url  = s.url;
        // application/x-mpegurl (not vnd.apple.mpegurl) — the HLS MIME value Google's Cast
        // samples use; some receiver stacks only reliably match this spelling.
        mime = 'application/x-mpegurl';
      }

      const tracks  = this.castTracks();
      const trackId = this.castActiveTrackId();

      // Resume position rides the load message itself (the receiver loads directly at
      // ?start=<t>) instead of a racy seek command fired right after the load.
      const entry = await this.watchHistory.get(s.path);
      const dur = entry?.durationSeconds || s.duration || 0;
      const resumeAt = entry && entry.positionSeconds > 15 && (dur <= 0 || entry.positionSeconds < dur * 0.95)
        ? entry.positionSeconds : 0;

      await this.cast.castUrl(
        url, mime, s.title, undefined,
        tracks.length ? tracks : undefined,
        trackId ?? undefined,
        s.duration ?? 0,
        resumeAt,
        s.thumbUrl
      );
      this.video?.pause();
    } catch (error) {
      console.error('[Cast] Error during casting:', error);
    }
  }

  // ── Local playback (delegates to the shared PlayerCore engine) ──────────────

  private loadLocal(url: string, subUrl?: string) {
    const video = this.video;
    if (!video || !this.core) return;
    video.muted  = false;
    video.volume = this.volume();
    this.core.load(url, 0, { play: true, subtitle: subUrl ? this.subSpec(subUrl) : undefined });
  }

  private reloadFrom(t: number) {
    this.core?.reloadFrom(Math.max(0, t));
  }

  retrySeek() {
    this.seekError.set(null);
    this.core?.retryLastSeek();
  }
}
