import {
  Component, ViewChild, ElementRef,
  OnInit, OnDestroy, signal, effect, inject
} from '@angular/core';
import { CommonModule } from '@angular/common';
import Hls from 'hls.js';
import { toSignal } from '@angular/core/rxjs-interop';
import { MediaService, MediaItem } from '../services/media.service';
import { CastService } from '../services/cast.service';

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './home.component.html',
  styleUrls: ['./home.component.scss']
})
export class HomeComponent implements OnInit, OnDestroy {
  // inject services (safe to use in field initializers)
  private media = inject(MediaService);
  public  cast  = inject(CastService);

  // reactive data
  items = toSignal(this.media.list(), { initialValue: [] as MediaItem[] });
  selected = signal<MediaItem | null>(null);

  @ViewChild('player', { static: true }) playerRef!: ElementRef<HTMLVideoElement>;
  private hls?: Hls;

  ngOnInit() {
    this.cast.init();

    // Load locally via HLS when selection changes and NOT casting
    effect(() => {
      const sel = this.selected();
      if (!sel) return;
      if (this.cast.isConnected()) {
        this.detachLocal();
        return;
      }
      this.loadLocal(sel.url);
    });

    // If cast connects at any time, detach local player
    effect(() => {
      if (this.cast.isConnected()) this.detachLocal();
    });
  }

  ngOnDestroy() { this.detachLocal(); }

  select(item: MediaItem) { this.selected.set(item); this.loadLocal(item.url); }

  async castSelected() {
    const s = this.selected();
    if (!s) return;
    await this.cast.requestSession();
    await this.cast.castUrl(s.url, 'application/vnd.apple.mpegurl', s.title);
  }

  // --- Local HLS playback ---
  private loadLocal(url: string) {
    const video = this.playerRef.nativeElement;

    this.detachLocal(); // clean previous

    video.muted = false;
    video.volume = 1.0;

    if (Hls.isSupported()) {
      this.hls = new Hls();
      this.hls.attachMedia(video);
      this.hls.on(Hls.Events.MEDIA_ATTACHED, () => this.hls!.loadSource(url));
      this.hls.on(Hls.Events.ERROR, (_e, data) => {
        console.error('HLS error', data);
        if (!this.hls || !data.fatal) return;
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR: this.hls.startLoad(); break;
          case Hls.ErrorTypes.MEDIA_ERROR:   this.hls.recoverMediaError(); break;
          default: this.hls.destroy(); this.hls = undefined; break;
        }
      });
      this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
        // Enable the first subtitle track (if available)
        if (this.hls!.subtitleTracks.length > 0) {
          this.hls!.subtitleTrack = 0;
        }
      });
      return;
    }
    else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari/iOS native HLS
      video.src = url;
      video.load();
      return;
    }

    console.warn('HLS not supported in this browser.');
  }

  private detachLocal() {
    const video = this.playerRef?.nativeElement;
    if (!video) return;
    if (this.hls) { try { this.hls.destroy(); } catch {} this.hls = undefined; }
    try { video.pause(); } catch {}
    video.removeAttribute('src');
    video.load();
  }
}
