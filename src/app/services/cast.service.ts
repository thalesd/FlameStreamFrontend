import { Injectable, NgZone, signal } from '@angular/core';
import { CAST_MEDIA_BASE, RECEIVER_APP_ID } from '../../../env-cast';

// Custom message channel shared with the receiver (wwwroot/receiver.js in the backend).
// The TV's CAF PlayerManager is broken for every media type (LOAD_FAILED 905 pre-network,
// even for Google's own sample streams — established 2026-07-03), so the receiver drives
// playback itself with hls.js and the sender talks to it over this namespace instead of
// the standard media channel. Protocol documented at the top of receiver.js.
const NS = 'urn:x-cast:flamestream';

@Injectable({ providedIn: 'root' })
export class CastService {
  private context: any;
  private _session: any = null;
  private initialized = false;
  private messageListenerAttached = false;

  constructor(private ngZone: NgZone) {}

  readonly connected       = signal(false);
  readonly castPlaying     = signal(false);
  readonly castCurrentTime = signal(0);
  readonly castDuration    = signal(0);
  readonly castTrackId     = signal<number | null>(null);

  init(): void {
    if (this.initialized) return;

    const waitForCast = () =>
      new Promise<void>((resolve) => {
        const tick = () => {
          if (window.cast && window.chrome?.cast?.isAvailable) return resolve();
          setTimeout(tick, 100);
        };
        tick();
      });

    waitForCast().then(() => {
      const castContext = (window as any).cast.framework.CastContext.getInstance();
      castContext.setOptions({
        autoJoinPolicy: (window as any).chrome.cast.AutoJoinPolicy.TAB_AND_ORIGIN_SCOPED,
        receiverApplicationId: RECEIVER_APP_ID,
      });
      this.context = castContext;
      this.initialized = true;

      castContext.addEventListener(
        (window as any).cast.framework.CastContextEventType.SESSION_STATE_CHANGED,
        (e: any) => {
          const SS = (window as any).cast.framework.SessionState;
          console.log('[Cast] Session state changed:', e.sessionState);
          if (e.sessionState === SS.SESSION_STARTED || e.sessionState === SS.SESSION_RESUMED) {
            this._session = castContext.getCurrentSession();
            this.attachMessageListener();
            this.connected.set(true);
          } else if (e.sessionState === SS.SESSION_ENDED || e.sessionState === SS.NO_SESSION) {
            this._session = null;
            this.messageListenerAttached = false;
            this.connected.set(false);
            this.castPlaying.set(false);
            this.castCurrentTime.set(0);
          }
        }
      );
    });
  }

  isConnected(): boolean { return this.connected(); }
  isReady(): boolean     { return !!this.context; }

  async requestSession(): Promise<any> {
    if (this._session) return this._session;
    this._session = await this.context.requestSession();
    this.attachMessageListener();
    this.connected.set(true);
    return this._session;
  }

  // Receiver broadcasts {type:'status', t, dur, paused, trackId} every second.
  private attachMessageListener() {
    if (!this._session || this.messageListenerAttached) return;
    this.messageListenerAttached = true;
    this._session.addMessageListener(NS, (_ns: string, raw: string) => {
      let m: any;
      try { m = JSON.parse(raw); } catch { return; }
      if (m?.type !== 'status') return;
      this.ngZone.run(() => {
        this.castCurrentTime.set(m.t ?? 0);
        if (m.dur > 0) this.castDuration.set(m.dur);
        this.castPlaying.set(!m.paused);
        this.castTrackId.set(m.trackId ?? null);
      });
    });
  }

  private send(msg: object) {
    if (!this._session) return;
    this._session.sendMessage(NS, msg).catch?.((e: any) =>
      console.error('[Cast] sendMessage failed:', e));
  }

  // ── Media controls (all via the custom channel) ───────────────────────────

  play()  { this.send({ type: 'play' }); this.castPlaying.set(true); }
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
  ) {
    if (!this.isReady()) this.init();
    const session = this.context.getCurrentSession() ?? await this.context.requestSession();
    this._session = session;
    this.attachMessageListener();

    const mediaUrl = url.startsWith('http') ? url : `${CAST_MEDIA_BASE}${url}`;
    console.log(`[Cast] Loading media (custom channel): ${mediaUrl}`);

    if (duration && duration > 0) this.castDuration.set(duration);

    await session.sendMessage(NS, {
      type: 'load',
      url: mediaUrl,
      title,
      duration: duration ?? 0,
      startTime: startTime ?? 0,
      tracks,
      activeTrackId: activeTrackId ?? null,
    });
    console.log('[Cast] Load message sent');
  }
}
