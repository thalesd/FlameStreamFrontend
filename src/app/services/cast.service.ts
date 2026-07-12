import { Injectable, NgZone, Signal, effect, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { CAST_MEDIA_BASE } from '../../../env-cast';
import { CastTransport, WebCastTransport, NativeCastTransport } from './cast-transport';

/**
 * Drives the custom FlameStream Cast receiver. The receiver's CAF PlayerManager is broken for every
 * media type (LOAD_FAILED 905 pre-network, established 2026-07-03), so the receiver plays media
 * itself with hls.js and the sender talks to it over a custom namespace instead of the standard
 * media channel — see the protocol at the top of receiver.js.
 *
 * This class is transport-agnostic: in the browser it drives Chrome's Web Sender SDK, and in the
 * Capacitor app the native Android Cast SDK (via the FlameCast plugin). Both speak the same custom
 * receiver + protocol, so everything below (and every caller) is identical across platforms.
 */
@Injectable({ providedIn: 'root' })
export class CastService {
  private readonly transport: CastTransport;

  readonly connected: Signal<boolean>;
  readonly castPlaying     = signal(false);
  readonly castCurrentTime = signal(0);
  readonly castDuration    = signal(0);
  readonly castTrackId     = signal<number | null>(null);

  constructor(private ngZone: NgZone) {
    this.transport = Capacitor.isNativePlatform()
      ? new NativeCastTransport(ngZone)
      : new WebCastTransport(ngZone);
    this.connected = this.transport.connected;

    // Receiver broadcasts {type:'status', t, dur, paused, trackId} every second.
    this.transport.onMessage((m) => {
      if (m?.type !== 'status') return;
      this.castCurrentTime.set(m.t ?? 0);
      if (m.dur > 0) this.castDuration.set(m.dur);
      this.castPlaying.set(!m.paused);
      this.castTrackId.set(m.trackId ?? null);
    });

    // Clear transient playback state whenever a session drops.
    effect(() => {
      if (!this.connected()) {
        this.castPlaying.set(false);
        this.castCurrentTime.set(0);
      }
    });
  }

  init(): void { this.transport.init(); }
  isConnected(): boolean { return this.connected(); }
  isReady(): boolean     { return this.transport.available(); }

  async requestSession(): Promise<void> {
    await this.transport.requestSession();
  }

  private send(msg: object) { this.transport.send(msg); }

  // ── Media controls (all via the custom channel) ───────────────────────────

  play()  { this.send({ type: 'play' });  this.castPlaying.set(true); }
  pause() { this.send({ type: 'pause' }); this.castPlaying.set(false); }

  togglePlay() {
    if (this.castPlaying()) this.pause(); else this.play();
  }

  seek(time: number) {
    this.send({ type: 'seek', time });
    this.castCurrentTime.set(time);
  }

  setVolume(level: number) { this.send({ type: 'setVolume', level }); }
  setMuted(muted: boolean) { this.send({ type: 'setMuted', muted }); }

  activateTrack(trackId: number | null) {
    this.send({ type: 'setTrack', id: trackId });
  }

  // ── Load ──────────────────────────────────────────────────────────────────

  async castUrl(
    url: string, _contentType: string, title?: string, _poster?: string,
    tracks?: Array<{ id: number; lang: string; name: string; url: string }>,
    activeTrackId?: number,
    duration?: number,
    startTime?: number,
    thumbUrl?: string,
  ) {
    await this.transport.requestSession();

    const mediaUrl = url.startsWith('http') ? url : `${CAST_MEDIA_BASE}${url}`;
    console.log(`[Cast] Loading media (custom channel): ${mediaUrl}`);

    if (duration && duration > 0) this.castDuration.set(duration);

    this.transport.send({
      type: 'load',
      url: mediaUrl,
      title,
      duration: duration ?? 0,
      startTime: startTime ?? 0,
      tracks,
      activeTrackId: activeTrackId ?? null,
      thumbUrl: thumbUrl ?? null,
    });
    console.log('[Cast] Load message sent');
  }
}
