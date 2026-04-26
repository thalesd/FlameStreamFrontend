import {
  Component, ViewChild, ElementRef,
  OnInit, OnDestroy, signal, effect, inject, computed, ChangeDetectorRef
} from '@angular/core';
import { CommonModule } from '@angular/common';
import Hls from 'hls.js';
import { toSignal } from '@angular/core/rxjs-interop';
import { MediaService, MediaItem, MediaFileNode, MediaNode } from '../services/media.service';
import { CastService } from '../services/cast.service';

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
  private media = inject(MediaService);
  private cdr    = inject(ChangeDetectorRef);
  public  cast   = inject(CastService);

  tree     = toSignal(this.media.list(), { initialValue: [] as MediaNode[] });
  selected = signal<MediaItem | null>(null);
  expandedFolders = signal(new Set<string>());

  flatList = computed(() => this.flattenNodes(this.tree(), this.expandedFolders()));

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
  buffered        = 0;
  castUseDirectFile = false;

  private controlsTimer: any;
  private seekDebounce: any;
  private hls?: Hls;
  private subtitleTrackEl?: HTMLTrackElement;
  // Offset between stream-local time (video.currentTime) and original file timeline.
  // Non-zero when playing a seek job whose PTS is normalized to 0 by HLS.js.
  private hlsStartOffset = 0;

  @ViewChild('player',    { static: false }) playerRef!:    ElementRef<HTMLVideoElement>;
  @ViewChild('container', { static: false }) containerRef!: ElementRef<HTMLDivElement>;

  constructor() {
    effect(() => {
      const sel = this.selected();
      if (!sel) return;
      if (this.cast.isConnected()) { this.detachLocal(); return; }
      this.subtitlesAvailable = !!(sel.subUrl || sel.embeddedSubtitles?.length);
      this.subtitlesOn = false;
      this.currentTime = 0;
      this.duration = sel.duration ?? 0;
      const effectiveSub = sel.subUrl || sel.embeddedSubtitles?.[0]?.url;
      setTimeout(() => this.loadLocal(sel.url, effectiveSub ?? undefined));
    });

    effect(() => {
      if (this.cast.isConnected()) this.detachLocal();
    });
  }

  ngOnInit() {
    this.cast.init();

    document.addEventListener('fullscreenchange', () => {
      this.isFullscreen = !!document.fullscreenElement;
      this.cdr.detectChanges();
    });
  }

  ngOnDestroy() {
    this.detachLocal();
    clearTimeout(this.controlsTimer);
    document.removeEventListener('fullscreenchange', () => {});
  }

  select(file: MediaFileNode) {
    this.selected.set(this.media.toMediaItem(file));
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
    if (!this.playerRef) return;
    const v = this.playerRef.nativeElement;
    v.paused ? v.play() : v.pause();
  }

  toggleMute() {
    if (!this.playerRef) return;
    const v = this.playerRef.nativeElement;
    v.muted = !v.muted;
    this.isMuted = v.muted;
  }

  seek(e: Event) {
    if (!this.playerRef) return;
    
    e.preventDefault();
    const v = this.playerRef.nativeElement;
    const val = +(e.target as HTMLInputElement).value;

    // Convert original-timeline value to stream-local time for buffered checks.
    const localVal = val - this.hlsStartOffset;
    let isBuffered = false;
    for (let i = 0; i < v.buffered.length; i++) {
      if (localVal >= v.buffered.start(i) - 1 && localVal <= v.buffered.end(i)) {
        isBuffered = true;
        break;
      }
    }

    // If seeking to unbuffered region with HLS enabled, reload from that point
    if (!isBuffered && this.hls) {
      this.currentTime = val;
      clearTimeout(this.seekDebounce);
      this.seekDebounce = setTimeout(() => this.reloadFrom(val), 200);
    } else {
      // Direct seek within already-buffered content (stream-local time)
      v.currentTime = localVal;
    }
  }

  setVolume(e: Event) {
    if (!this.playerRef) return;
    const v = this.playerRef.nativeElement;
    const val = +(e.target as HTMLInputElement).value;
    v.volume = val;
    this.volume = val;
    this.isMuted = val === 0;
  }

  skip(sec: number) {
    if (!this.playerRef) return;
    const v = this.playerRef.nativeElement;
    v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + sec));
  }

  toggleSubtitles() {
    this.subtitlesOn = !this.subtitlesOn;
    if (this.hls && this.hls.subtitleTracks.length > 0) {
      this.hls.subtitleTrack = this.subtitlesOn ? 0 : -1;
    }
    if (this.subtitleTrackEl) {
      this.subtitleTrackEl.track.mode = this.subtitlesOn ? 'showing' : 'hidden';
    }
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

  onPlay()   { this.isPlaying = true; }
  onPause()  { this.isPlaying = false; this.showControls = true; }
  onEnded()  { this.isPlaying = false; this.showControls = true; }

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
        mime = 'application/vnd.apple.mpegurl';
      }
      console.log(`[Cast] Mode: ${this.castUseDirectFile ? 'direct' : 'hls'} — ${url}`);
      await this.cast.castUrl(url, mime, s.title);
      console.log('[Cast] Content cast successfully');
      this.playerRef?.nativeElement.pause();
    } catch (error) {
      console.error('[Cast] Error during casting:', error);
    }
  }

  // ── Local HLS ─────────────────────────────────────────────────────────────

  private loadLocal(url: string, subUrl?: string) {
    if (!this.playerRef) return;
    const video = this.playerRef.nativeElement;
    this.hlsStartOffset = 0;
    this.detachLocal();
    video.muted  = false;
    video.volume = this.volume;

    if (Hls.isSupported()) {
      this.hls = new Hls({ enableWorker: true });
      this.hls.attachMedia(video);
      this.hls.on(Hls.Events.MEDIA_ATTACHED, () => this.hls!.loadSource(url));
      this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {});
        this.hls!.subtitleTrack = -1;
        if (subUrl) {
          const track = document.createElement('track');
          track.kind    = 'subtitles';
          track.label   = 'Legendas';
          track.srclang = 'pt';
          track.src     = subUrl;
          video.appendChild(track);
          this.subtitleTrackEl = track;
          track.track.mode = 'hidden';
        }
      });
      // Store error handler for later removal in reloadFrom
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

    console.log(`[Seek] Reloading from ${startTime}s (attempt ${retries + 1})`);

    // HLS.js normalizes PTS to 0 for every new source. Track the offset so that
    // onTimeUpdate, seek-buffered checks, and error retries use the correct position.
    this.hlsStartOffset = startTime;

    // Destroy the current instance entirely so no stale error handlers can cancel
    // the new manifest request milliseconds after it's sent.
    if (this.hls) {
      try { this.hls.destroy(); } catch {}
      this.hls = undefined;
    }

    if (!Hls.isSupported()) return;

    this.hls = new Hls({ enableWorker: true });
    this.hls.attachMedia(video);

    const MANIFEST_TIMEOUT_MS = 35000;
    let manifestTimeout: any;

    const manifestHandler = () => {
      clearTimeout(manifestTimeout);
      console.log('[Seek] Manifest parsed successfully');
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
      }
    };
    (this.hls as any)._globalErrorHandler = errorHandler;
    this.hls.on(Hls.Events.ERROR, errorHandler);

    this.hls.on(Hls.Events.MEDIA_ATTACHED, () => this.hls!.loadSource(src));
    this.hls.once(Hls.Events.MANIFEST_PARSED, manifestHandler);

    manifestTimeout = setTimeout(() => {
      if (this.hls) this.hls.off(Hls.Events.MANIFEST_PARSED, manifestHandler);
      console.warn('[Seek] Manifest parsing timeout after', MANIFEST_TIMEOUT_MS, 'ms');
      if (retries < 1) {
        this.reloadFrom(t, retries + 1);
      } else {
        console.error('[Seek] Giving up after retries');
      }
    }, MANIFEST_TIMEOUT_MS);
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
