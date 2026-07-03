import {
  Component, ViewChild, ElementRef,
  OnInit, OnDestroy, signal, effect, inject, computed, ChangeDetectorRef
} from '@angular/core';
import { CommonModule } from '@angular/common';
import Hls from 'hls.js';
import { toSignal } from '@angular/core/rxjs-interop';
import { MediaService, MediaItem, MediaFileNode, MediaNode } from '../services/media.service';
import { CastService } from '../services/cast.service';
import { WatchHistoryService, WatchHistoryEntry } from '../services/watch-history.service';
import { ProcessingTrackerService } from '../services/processing-tracker.service';

type FlatNode = {
  type: 'folder' | 'file';
  name: string;
  path: string;
  level: number;
  expanded?: boolean;
  node?: MediaFileNode;
};

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './home.component.html',
  styleUrls: ['./home.component.scss']
})
export class HomeComponent implements OnInit, OnDestroy {
  private media        = inject(MediaService);
  private cdr          = inject(ChangeDetectorRef);
  private watchHistory = inject(WatchHistoryService);
  public  cast         = inject(CastService);
  public  tracker      = inject(ProcessingTrackerService);
  private trackerUnsubscribe?: () => void;

  tree     = toSignal(this.media.list(), { initialValue: [] as MediaNode[] });
  selected = signal<MediaItem | null>(null);
  expandedFolders = signal(new Set<string>());

  resumeInfo = signal<{ position: number; label: string } | null>(null);
  continueWatchingItems = signal<Array<{ file: MediaFileNode; entry: WatchHistoryEntry }>>([]);
  private pendingAutoResume = false;

  // "Up next" auto-advance: when an episode ends, the next file in the same folder
  // (i.e. the next episode of the series) is queued and plays after a short countdown.
  upNext = signal<{ file: MediaFileNode; seconds: number } | null>(null);
  private readonly UP_NEXT_SECONDS = 8;
  private upNextInterval: any;

  flatList   = computed(() => this.flattenNodes(this.tree(), this.expandedFolders()));
  castTracks = computed(() => {
    const s = this.selected();
    if (!s) return [];
    const tracks: Array<{ id: number; lang: string; name: string; url: string; source: 'EXT' | 'EMB' }> = [];
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

  // UI state
  isPlaying       = false;
  isMuted         = false;
  isFullscreen    = false;
  showControls    = true;
  showSidebar     = true;
  currentTime     = 0;
  duration        = 0;
  volume          = 1;
  subtitlesOn     = false;
  subtitlesAvailable = false;
  scrubbing       = false;  // true while the seek bar is being pressed/dragged (#125 slash handle)
  buffered        = 0;
  castUseDirectFile  = false;
  castActiveTrackId  = signal<number | null>(null);
  showTrackMenu      = signal(false);

  private controlsTimer: any;
  private seekDebounce: any;
  private hls?: Hls;
  private subtitleTrackEl?: HTMLTrackElement;
  private currentSubUrl?: string;
  // Offset between stream-local time (video.currentTime) and original file timeline.
  private hlsStartOffset = 0;
  private lastSeekTarget = 0;
  seekProcessing = signal(false);
  seekError      = signal<string | null>(null);

  @ViewChild('player',    { static: false }) playerRef!:    ElementRef<HTMLVideoElement>;
  @ViewChild('container', { static: false }) containerRef!: ElementRef<HTMLDivElement>;

  constructor() {
    // Load locally when a file is selected and cast is not active
    effect(() => {
      const sel = this.selected();
      if (!sel) return;
      if (this.cast.isConnected()) { this.detachLocal(); return; }
      this.subtitlesAvailable = !!(sel.subUrl || sel.embeddedSubtitles?.length);
      this.subtitlesOn = false;
      // HLS by default for casting: the receiver drives playback itself with hls.js
      // (the TV's CAF PlayerManager is broken for all media — see receiver.js), so
      // HLS works universally, MKV transcodes included. DIR remains a manual override
      // for plain MP4s (native progressive playback on the receiver's <video>).
      this.castUseDirectFile = false;
      this.currentTime = 0;
      this.duration = sel.duration ?? 0;
      this.clearResumeTimer();
      this.resumeInfo.set(null);
      this.clearUpNext();
      const effectiveSub = sel.subUrl || sel.embeddedSubtitles?.[0]?.url;
      setTimeout(() => this.loadLocal(sel.url, effectiveSub ?? undefined));
      this.checkResume(sel);
    });

    // Detach local player when cast connects
    effect(() => {
      if (this.cast.isConnected()) this.detachLocal();
    });

    // Default subtitle track to first available when selection changes
    effect(() => {
      const tracks = this.castTracks();
      this.castActiveTrackId.set(tracks.length > 0 ? tracks[0].id : null);
    });

    // Refresh the Continue Watching shelf once the library tree is available
    effect(() => {
      if (this.tree().length > 0) this.loadContinueWatching();
    });
  }

  private watchHistoryTimer: any;
  private beforeUnloadHandler = () => this.saveWatchProgress();

  ngOnInit() {
    this.cast.init();

    document.addEventListener('fullscreenchange', () => {
      this.isFullscreen = !!document.fullscreenElement;
      this.cdr.detectChanges();
    });

    this.watchHistoryTimer = setInterval(() => this.saveWatchProgress(), 8000);
    window.addEventListener('beforeunload', this.beforeUnloadHandler);
    this.trackerUnsubscribe = this.tracker.subscribe();
  }

  ngOnDestroy() {
    this.saveWatchProgress();
    this.detachLocal();
    clearTimeout(this.controlsTimer);
    clearTimeout(this.trackerCloseTimer);
    this.clearResumeTimer();
    this.clearUpNext();
    clearInterval(this.watchHistoryTimer);
    window.removeEventListener('beforeunload', this.beforeUnloadHandler);
    document.removeEventListener('fullscreenchange', () => {});
    this.trackerUnsubscribe?.();
  }

  fileNameFor(path: string): string {
    return this.allFileNodes().find(f => f.path === path)?.name ?? path;
  }

  trackerPopupPos = signal<{ top: number; left: number } | null>(null);
  private trackerCloseTimer: any;

  onTrackerEnter(e: MouseEvent) {
    clearTimeout(this.trackerCloseTimer);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    this.trackerPopupPos.set({ top: rect.bottom + 8, left: rect.left });
  }

  onTrackerLeave() {
    // The popup is position:fixed with an 8px gap below the button, so it isn't part
    // of the wrapper's hover box — moving the pointer toward it fires mouseleave and
    // used to close it instantly, making the Cancel button unreachable. Delay the close
    // so the pointer can cross the gap; entering the popup (keepTrackerOpen) cancels it.
    clearTimeout(this.trackerCloseTimer);
    this.trackerCloseTimer = setTimeout(() => this.trackerPopupPos.set(null), 250);
  }

  keepTrackerOpen() {
    clearTimeout(this.trackerCloseTimer);
  }

  jobForPath(path: string) {
    return this.tracker.jobs().find(j => j.path === path && j.jobType === 'main');
  }

  async preprocessFile(node: MediaFileNode, e: Event) {
    e.stopPropagation();
    await this.media.preprocess(node.path);
  }

  async deleteCache(node: MediaFileNode, e: Event) {
    e.stopPropagation();
    if (this.selected()?.path === node.path) return; // don't pull the rug out from under active playback
    if (!confirm(`Liberar ${this.formatBytes(node.cachedBytes ?? 0)} excluindo o processamento salvo de "${node.name}"?`)) return;
    await this.media.deleteCache(node.path);
    node.ready = false;
    node.cachedBytes = 0;
  }

  formatBytes(bytes: number): string {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes, i = 0;
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
    return `${value.toFixed(i > 0 && value < 10 ? 1 : 0)} ${units[i]}`;
  }

  select(file: MediaFileNode, autoResume: boolean = false) {
    this.pendingAutoResume = autoResume;
    this.selected.set(this.media.toMediaItem(file));
  }

  openContinueWatching(item: { file: MediaFileNode; entry: WatchHistoryEntry }) {
    this.select(item.file, true);
  }

  // ── Watch history / resume ───────────────────────────────────────────────────

  private saveWatchProgress() {
    const sel = this.selected();
    if (!sel) return;
    const isCasting = this.cast.isConnected();
    const position  = isCasting ? this.cast.castCurrentTime() : this.currentTime;
    const duration  = (isCasting ? this.cast.castDuration() : 0) || this.duration || sel.duration || 0;
    if (!position || position <= 0) return;
    this.watchHistory.save(sel.path, position, duration);
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
      this.resumeInfo.set({ position: entry!.positionSeconds, label: this.formatTime(entry!.positionSeconds) });
      // Auto-dismiss the "continue from where you left off?" prompt after 5s so it
      // doesn't sit over playback if ignored (#122).
      this.clearResumeTimer();
      this.resumeDismissTimer = setTimeout(() => this.dismissResume(), 5000);
    }
  }

  private resumeDismissTimer: any;
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

  private allFileNodes(): MediaFileNode[] {
    const result: MediaFileNode[] = [];
    const walk = (nodes: MediaNode[]) => {
      for (const node of nodes) {
        if (node.type === 'folder') walk(node.children);
        else result.push(node);
      }
    };
    walk(this.tree());
    return result;
  }

  private async loadContinueWatching() {
    const rows  = await this.watchHistory.continueWatching();
    const files = this.allFileNodes();
    const items = rows
      .map(entry => ({ entry, file: files.find(f => f.path === entry.path) }))
      .filter((x): x is { entry: WatchHistoryEntry; file: MediaFileNode } => !!x.file);
    this.continueWatchingItems.set(items);
  }

  toggleFolder(path: string) {
    this.expandedFolders.update(set => {
      const next = new Set(set);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  }

  private flattenNodes(nodes: MediaNode[], expanded: Set<string>, level = 0): FlatNode[] {
    const result: FlatNode[] = [];
    for (const node of nodes) {
      if (node.type === 'folder') {
        const isExpanded = expanded.has(node.path);
        result.push({ type: 'folder', name: node.name, path: node.path, level, expanded: isExpanded });
        if (isExpanded) {
          result.push(...this.flattenNodes(node.children, expanded, level + 1));
        }
      } else {
        result.push({ type: 'file', name: node.name, path: node.path, level, node });
      }
    }
    return result;
  }

  // ── Controls ──────────────────────────────────────────────────────────────

  togglePlay() {
    if (this.cast.isConnected()) { this.cast.togglePlay(); return; }
    if (!this.playerRef) return;
    const v = this.playerRef.nativeElement;
    v.paused ? v.play() : v.pause();
  }

  toggleMute() {
    if (this.cast.isConnected()) {
      this.isMuted = !this.isMuted;
      this.cast.setMuted(this.isMuted);
      return;
    }
    if (!this.playerRef) return;
    const v = this.playerRef.nativeElement;
    v.muted = !v.muted;
    this.isMuted = v.muted;
  }

  seek(e: Event) {
    e.preventDefault();
    const val = +(e.target as HTMLInputElement).value;

    if (this.cast.isConnected()) {
      this.currentTime = val;
      this.cast.seek(val);
      return;
    }

    if (!this.playerRef) return;
    const v = this.playerRef.nativeElement;

    // Convert original-timeline value to stream-local time for buffered checks.
    const localVal = val - this.hlsStartOffset;
    let isBuffered = false;
    for (let i = 0; i < v.buffered.length; i++) {
      if (localVal >= v.buffered.start(i) - 1 && localVal <= v.buffered.end(i)) {
        isBuffered = true;
        break;
      }
    }

    if (!isBuffered && this.hls) {
      this.currentTime = val;
      clearTimeout(this.seekDebounce);
      this.seekDebounce = setTimeout(() => this.reloadFrom(val), 200);
    } else {
      v.currentTime = localVal;
    }
  }

  setVolume(e: Event) {
    const val = +(e.target as HTMLInputElement).value;
    this.volume  = val;
    this.isMuted = val === 0;
    if (this.cast.isConnected()) { this.cast.setVolume(val); return; }
    if (!this.playerRef) return;
    const v = this.playerRef.nativeElement;
    v.volume = val;
  }

  skip(sec: number) {
    if (this.cast.isConnected()) {
      const t = this.cast.castCurrentTime();
      const dur = this.cast.castDuration() || this.duration;
      this.cast.seek(Math.max(0, Math.min(dur, t + sec)));
      return;
    }
    if (!this.playerRef) return;
    const v = this.playerRef.nativeElement;
    v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + sec));
  }

  toggleSubtitles() {
    this.subtitlesOn = !this.subtitlesOn;
    console.log(`[Subtitles] Toggle: ${this.subtitlesOn ? 'ON' : 'OFF'}`);
    
    if (this.hls && this.hls.subtitleTracks.length > 0) {
      console.log(`[Subtitles] Found ${this.hls.subtitleTracks.length} HLS subtitle track(s)`);
      this.hls.subtitleTrack = this.subtitlesOn ? 0 : -1;
    }
    
    if (this.subtitleTrackEl) {
      const newMode = this.subtitlesOn ? 'showing' : 'hidden';
      this.subtitleTrackEl.track.mode = newMode;
      console.log(`[Subtitles] Native track mode set to: ${newMode}`);
    } else {
      console.log('[Subtitles] No native track element found');
    }
  }

  setCastTrack(id: number | null) {
    this.castActiveTrackId.set(id);
    this.showTrackMenu.set(false);

    // While casting, the receiver handles track switching.
    if (this.cast.isConnected()) { this.cast.activateTrack(id); return; }

    // Local playback: switch the native <track> to the chosen subtitle. Every track in
    // castTracks() — the external sidecar and each embedded track (served as VTT by the
    // backend via /subs/...?track=N) — is selectable here, so embedded subs are watchable
    // locally, not just the side-file .srt/.vtt.
    const video = this.playerRef?.nativeElement;
    if (id === null) {
      this.subtitlesOn = false;
      if (this.subtitleTrackEl) this.subtitleTrackEl.track.mode = 'hidden';
      return;
    }
    const track = this.castTracks().find(t => t.id === id);
    if (!track || !video) return;
    this.currentSubUrl = track.url;
    this.subtitlesOn = true;
    this.attachSubtitleTrack(video, track.url);
  }

  toggleTrackMenu() { this.showTrackMenu.update(v => !v); }
  closeTrackMenu()  { this.showTrackMenu.set(false); }

  // Compact label for the popup trigger: the active track's language code, or "Off".
  activeTrackLabel(): string {
    const id = this.castActiveTrackId();
    if (id === null) return 'Off';
    const t = this.castTracks().find(t => t.id === id);
    return (t?.lang || 'CC').toUpperCase();
  }

  toggleFullscreen() {
    if (!this.containerRef) return;
    const el = this.containerRef.nativeElement;
    if (!document.fullscreenElement) {
      el.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  }

  onMouseMove() {
    this.showControls = true;
    clearTimeout(this.controlsTimer);
    this.controlsTimer = setTimeout(() => {
      if (this.isPlaying) {
        this.showControls = false;
        this.cdr.detectChanges();
      }
    }, 2800);
  }

  // ── Video events ──────────────────────────────────────────────────────────

  onPlay()   { this.isPlaying = true; this.clearUpNext(); }
  onPause()  { this.isPlaying = false; this.showControls = true; this.saveWatchProgress(); }
  onEnded()  {
    this.isPlaying = false;
    this.showControls = true;
    this.saveWatchProgress();
    this.maybeQueueNextEpisode();
  }

  // ── Up next / auto-advance ──────────────────────────────────────────────────

  /**
   * Locate the next episode: the file that follows `path` among its sibling files in
   * the same folder. Only searches within folders — top-level files are standalone
   * titles, not a series, so they never chain into one another.
   */
  private findNextEpisode(path: string): MediaFileNode | null {
    const searchFolder = (children: MediaNode[]): MediaFileNode | null => {
      const idx = children.findIndex(n => n.type === 'file' && n.path === path);
      if (idx !== -1) {
        for (let i = idx + 1; i < children.length; i++) {
          if (children[i].type === 'file') return children[i] as MediaFileNode;
        }
        return null; // last episode in this folder
      }
      for (const n of children) {
        if (n.type === 'folder') {
          const found = searchFolder(n.children);
          if (found) return found;
        }
      }
      return null;
    };
    for (const n of this.tree()) {
      if (n.type === 'folder') {
        const found = searchFolder(n.children);
        if (found) return found;
      }
    }
    return null;
  }

  private maybeQueueNextEpisode() {
    // Casting is driven by the receiver; auto-advance only applies to local playback.
    if (this.cast.isConnected()) return;
    const sel = this.selected();
    if (!sel) return;
    const next = this.findNextEpisode(sel.path);
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

  onTimeUpdate() {
    const v = this.playerRef.nativeElement;
    this.currentTime = v.currentTime + this.hlsStartOffset;
    if (!this.selected()?.duration) {
      this.duration = isFinite(v.duration) ? v.duration : 0;
    }
    if (v.buffered.length > 0 && this.duration > 0) {
      this.buffered = ((v.buffered.end(v.buffered.length - 1) + this.hlsStartOffset) / this.duration) * 100;
    }
  }

  onVolumeChange() {
    const v = this.playerRef.nativeElement;
    this.isMuted = v.muted;
    this.volume  = v.volume;
  }

  // ── Formatters ────────────────────────────────────────────────────────────

  formatTime(s: number): string {
    if (!s || isNaN(s)) return '0:00';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    const mm = m.toString().padStart(2, '0');
    const ss = sec.toString().padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
  }

  get progressPct(): number {
    return this.duration ? (this.currentTime / this.duration) * 100 : 0;
  }

  // ── Cast ──────────────────────────────────────────────────────────────────

  async castSelected() {
    const s = this.selected();
    if (!s) return;
    try {
      await this.cast.requestSession();
      console.log('[Cast] Session requested successfully');

      let url: string;
      let mime: string;
      if (this.castUseDirectFile) {
        const ext = s.directUrl.split('.').pop()?.toLowerCase() ?? '';
        mime = ext === 'mkv' ? 'video/x-matroska'
             : ext === 'mov' ? 'video/quicktime'
             : ext === 'avi' ? 'video/x-msvideo'
             : 'video/mp4';
        url = s.directUrl;
      } else {
        url  = s.url;
        // application/x-mpegurl (not vnd.apple.mpegurl) — the HLS MIME value Google's
        // Cast samples use; some receiver stacks only reliably match this spelling.
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

      console.log(`[Cast] Mode: ${this.castUseDirectFile ? 'direct' : 'hls'} — ${url} — ${tracks.length} subtitle track(s), resume=${resumeAt}s`);
      await this.cast.castUrl(
        url, mime, s.title, undefined,
        tracks.length ? tracks : undefined,
        trackId ?? undefined,
        s.duration ?? 0,
        resumeAt
      );
      console.log('[Cast] Content cast successfully');
      this.playerRef?.nativeElement.pause();
    } catch (error) {
      console.error('[Cast] Error during casting:', error);
    }
  }

  // ── Local HLS ─────────────────────────────────────────────────────────────

  /**
   * (Re)creates the native <track> element and applies the current subtitlesOn state.
   * Must be called after every (re)attach of an Hls instance to the video element —
   * recreating the Hls instance resets the video's existing TextTracks to their default
   * ("disabled", no cues loaded), silently killing subtitles after any seek-triggered
   * reloadFrom() if not reapplied.
   */
  private attachSubtitleTrack(video: HTMLVideoElement, subUrl: string) {
    if (this.subtitleTrackEl) {
      try { this.subtitleTrackEl.remove(); } catch {}
      this.subtitleTrackEl = undefined;
    }
    const track = document.createElement('track');
    track.kind    = 'subtitles';
    track.label   = 'Legendas';
    track.srclang = 'pt';
    // Cue timestamps are always absolute (original-file-relative); after any seek, the
    // player's own currentTime resets to ~0 for the newly loaded manifest (hlsStartOffset
    // tracks that reset). Native cue matching only ever compares against currentTime
    // directly, so the backend must shift cue times by the same offset or they'd never
    // line up with what's actually on screen post-seek.
    track.src = this.hlsStartOffset > 0
      ? `${subUrl}${subUrl.includes('?') ? '&' : '?'}shift=${this.hlsStartOffset}`
      : subUrl;
    track.addEventListener('load', () => console.log('[Subtitles] Track loaded successfully'));
    track.addEventListener('error', (e: any) => console.error('[Subtitles] Failed to load track:', e));
    video.appendChild(track);
    this.subtitleTrackEl = track;
    track.track.mode = this.subtitlesOn ? 'showing' : 'hidden';
    console.log(`[Subtitles] Track (re)attached from: ${subUrl}, mode=${track.track.mode}`);
  }

  // The backend reports, via the X-Hls-Start-Offset response header, the absolute time that
  // the freshly loaded manifest's local time 0 actually corresponds to. This is NOT always
  // the requested seek target: when served from the main stream we can only start at a
  // segment boundary at or before the request. Trusting the requested target instead left
  // the clock and subtitle cues off by (target − segmentStart) — a constant post-seek
  // desync, worst on caches whose segment length differs from the current config.
  private applyStartOffsetHeader(data: any) {
    const raw = data?.networkDetails?.getResponseHeader?.('X-Hls-Start-Offset');
    const s = raw != null ? parseFloat(raw) : NaN;
    if (isNaN(s) || s === this.hlsStartOffset) return;
    this.hlsStartOffset = s;
    // The subtitle track may already have been attached (its shift baked in) before this
    // header landed — hls.js's MANIFEST_LOADED vs MANIFEST_PARSED ordering isn't guaranteed
    // relative to our handlers — so re-attach it now that the true offset is known.
    const video = this.playerRef?.nativeElement;
    if (video && this.currentSubUrl && this.subtitleTrackEl) {
      this.attachSubtitleTrack(video, this.currentSubUrl);
    }
  }

  private loadLocal(url: string, subUrl?: string) {
    if (!this.playerRef) return;
    const video = this.playerRef.nativeElement;
    this.hlsStartOffset = 0;
    this.currentSubUrl = subUrl;
    this.detachLocal();
    video.muted  = false;
    video.volume = this.volume;

    if (Hls.isSupported()) {
      // startPosition: 0 is required — our backend serves in-progress transcodes as
      // EVENT-type (non-ENDLIST) playlists, which hls.js otherwise treats as "live" and
      // defaults startPosition to -1 (start at the live edge / tip of what's encoded so
      // far) instead of the first listed segment, which is always what we actually want.
      this.hls = new Hls({ enableWorker: true, startPosition: 0 });
      this.hls.attachMedia(video);
      // Fires before MANIFEST_PARSED, so hlsStartOffset is corrected before subtitles attach.
      // MANIFEST_LOADED sees the master playlist's response; LEVEL_LOADED sees the media
      // playlist's — the X-Hls-Start-Offset header rides on the media response now that
      // /stream fronts everything with a one-variant master (Chromecast requires one), so
      // hook both and let whichever response carries the header win.
      this.hls.on(Hls.Events.MANIFEST_LOADED, (_e, data) => this.applyStartOffsetHeader(data));
      this.hls.on(Hls.Events.LEVEL_LOADED, (_e, data) => this.applyStartOffsetHeader(data));
      this.hls.on(Hls.Events.MEDIA_ATTACHED, () => this.hls!.loadSource(url));
      this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {});
        this.hls!.subtitleTrack = -1;
        if (subUrl) this.attachSubtitleTrack(video, subUrl);
      });
      const globalErrorHandler = (_e: any, data: any) => {
        if (!this.hls || !data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          this.reloadFrom((this.playerRef?.nativeElement.currentTime ?? 0) + this.hlsStartOffset);
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          this.hls.recoverMediaError();
        } else {
          this.hls.destroy();
          this.hls = undefined;
        }
      };
      (this.hls as any)._globalErrorHandler = globalErrorHandler;
      this.hls.on(Hls.Events.ERROR, globalErrorHandler);
      return;
    }

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
      video.load();
      video.play().catch(() => {});
    }
  }

  private reloadFrom(t: number, retries: number = 0) {
    const sel = this.selected();
    if (!sel || !this.playerRef) return;

    const video = this.playerRef.nativeElement;
    const startTime = Math.max(0, t);
    const src = `${sel.url}?start=${startTime.toString()}`;

    this.lastSeekTarget = startTime;
    this.seekProcessing.set(true);
    this.seekError.set(null);

    console.log(`[Seek] Reloading from ${startTime}s (attempt ${retries + 1})`);

    // Provisional offset until the manifest response's X-Hls-Start-Offset header corrects it
    // (see applyStartOffsetHeader): the true origin is the served segment's start, which is
    // <= startTime. Used meanwhile by onTimeUpdate, seek-buffered checks, and error retries.
    this.hlsStartOffset = startTime;

    if (this.hls) {
      try { this.hls.destroy(); } catch {}
      this.hls = undefined;
    }

    if (!Hls.isSupported()) { this.seekProcessing.set(false); return; }

    // See loadLocal() for why startPosition: 0 is required for in-progress (EVENT-type)
    // playlists — without it hls.js jumps to the live edge instead of the requested segment.
    this.hls = new Hls({ enableWorker: true, startPosition: 0 });
    this.hls.attachMedia(video);
    // Corrects hlsStartOffset to the true segment start before MANIFEST_PARSED reattaches subs.
    // Both hooks needed: the header rides the media playlist (LEVEL_LOADED), not the
    // master (MANIFEST_LOADED) — see loadLocal().
    this.hls.on(Hls.Events.MANIFEST_LOADED, (_e, data) => this.applyStartOffsetHeader(data));
    this.hls.on(Hls.Events.LEVEL_LOADED, (_e, data) => this.applyStartOffsetHeader(data));

    // The backend can take up to ~600s to produce a fresh segment for a brand-new
    // seek position under load, so give it a generous ceiling (45s x 4 attempts) before
    // surfacing an error, rather than the previous 35s/1-retry setup.
    const MANIFEST_TIMEOUT_MS = 45000;
    const MAX_RETRIES = 3;
    let manifestTimeout: any;

    const manifestHandler = () => {
      clearTimeout(manifestTimeout);
      console.log('[Seek] Manifest parsed successfully');
      this.seekProcessing.set(false);
      // Reattaching Hls above reset the video's TextTracks — reapply subtitles now.
      if (this.currentSubUrl) this.attachSubtitleTrack(video, this.currentSubUrl);
      video.play().catch(() => {});
    };

    const errorHandler = (_e: any, data: any) => {
      if (!this.hls || !data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        clearTimeout(manifestTimeout);
        this.reloadFrom((this.playerRef?.nativeElement.currentTime ?? 0) + this.hlsStartOffset);
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        this.hls.recoverMediaError();
      } else {
        this.hls.destroy();
        this.hls = undefined;
        this.seekProcessing.set(false);
        this.seekError.set('Falha ao carregar o vídeo.');
      }
    };
    (this.hls as any)._globalErrorHandler = errorHandler;
    this.hls.on(Hls.Events.ERROR, errorHandler);

    this.hls.on(Hls.Events.MEDIA_ATTACHED, () => this.hls!.loadSource(src));
    this.hls.once(Hls.Events.MANIFEST_PARSED, manifestHandler);

    manifestTimeout = setTimeout(() => {
      if (this.hls) this.hls.off(Hls.Events.MANIFEST_PARSED, manifestHandler);
      console.warn('[Seek] Manifest parsing timeout after', MANIFEST_TIMEOUT_MS, 'ms');
      if (retries < MAX_RETRIES) {
        this.reloadFrom(t, retries + 1);
      } else {
        console.error('[Seek] Giving up after retries');
        this.seekProcessing.set(false);
        this.seekError.set('O processamento está demorando mais que o esperado.');
      }
    }, MANIFEST_TIMEOUT_MS);
  }

  retrySeek() {
    this.seekError.set(null);
    this.reloadFrom(this.lastSeekTarget, 0);
  }

  private detachLocal() {
    const video = this.playerRef?.nativeElement;
    if (!video) return;
    if (this.hls) { try { this.hls.destroy(); } catch {} this.hls = undefined; }
    if (this.subtitleTrackEl) { try { this.subtitleTrackEl.remove(); } catch {} this.subtitleTrackEl = undefined; }
    try { video.pause(); } catch {}
    video.removeAttribute('src');
    video.load();
  }
}
