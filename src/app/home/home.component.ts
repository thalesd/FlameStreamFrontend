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

  private controlsTimer: any;
  private hls?: Hls;
  private subtitleTrackEl?: HTMLTrackElement;

  @ViewChild('player',    { static: false }) playerRef!:    ElementRef<HTMLVideoElement>;
  @ViewChild('container', { static: false }) containerRef!: ElementRef<HTMLDivElement>;

  constructor() {
    effect(() => {
      const sel = this.selected();
      if (!sel) return;
      if (this.cast.isConnected()) { this.detachLocal(); return; }
      this.subtitlesAvailable = !!(sel.subUrl || sel.embeddedSubtitles?.length);
      this.subtitlesOn = false;
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
    const v = this.playerRef.nativeElement;
    const val = +(e.target as HTMLInputElement).value;
    v.currentTime = val;
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
    this.currentTime = v.currentTime;
    this.duration    = v.duration || 0;
    if (v.buffered.length > 0) {
      this.buffered = (v.buffered.end(v.buffered.length - 1) / (v.duration || 1)) * 100;
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
    await this.cast.requestSession();
    await this.cast.castUrl(s.url, 'application/vnd.apple.mpegurl', s.title);
    this.playerRef?.nativeElement.pause();
  }

  // ── Local HLS ─────────────────────────────────────────────────────────────

  private loadLocal(url: string, subUrl?: string) {
    if (!this.playerRef) return;
    const video = this.playerRef.nativeElement;
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
      this.hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!this.hls || !data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) this.hls.startLoad();
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) this.hls.recoverMediaError();
        else { this.hls.destroy(); this.hls = undefined; }
      });
      return;
    }

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
      video.load();
      video.play().catch(() => {});
    }
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
