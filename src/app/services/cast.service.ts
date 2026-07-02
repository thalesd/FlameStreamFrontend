import { Injectable, NgZone, signal } from '@angular/core';
import { CAST_MEDIA_BASE, RECEIVER_APP_ID } from '../../../env-cast';

@Injectable({ providedIn: 'root' })
export class CastService {
  private context: any;
  private _session: any = null;
  private mediaSession: any = null;
  private initialized = false;
  private pollInterval: any = null;

  constructor(private ngZone: NgZone) {}

  readonly connected       = signal(false);
  readonly castPlaying     = signal(false);
  readonly castCurrentTime = signal(0);
  readonly castDuration    = signal(0);

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
            this.connected.set(true);
          } else if (e.sessionState === SS.SESSION_ENDED || e.sessionState === SS.NO_SESSION) {
            this._session = null;
            this.mediaSession = null;
            this.connected.set(false);
            this.castPlaying.set(false);
            this.castCurrentTime.set(0);
            clearInterval(this.pollInterval);
          }
        }
      );

      const ui = (window as any).cast?.framework?.ui;
      if (ui?.setLoggerLevel) {
        ui.setLoggerLevel((window as any).cast.framework.LoggerLevel.INFO);
      }
    });
  }

  isConnected(): boolean { return this.connected(); }
  isReady(): boolean     { return !!this.context; }

  async requestSession(): Promise<any> {
    if (this._session) return this._session;
    this._session = await this.context.requestSession();
    this.connected.set(true);
    return this._session;
  }

  // ── Media controls ────────────────────────────────────────────────────────

  play() {
    this.mediaSession?.play(new (window as any).chrome.cast.media.PlayRequest(), null, null);
  }

  pause() {
    this.mediaSession?.pause(new (window as any).chrome.cast.media.PauseRequest(), null, null);
  }

  togglePlay() {
    if (this.castPlaying()) this.pause(); else this.play();
  }

  seek(time: number) {
    if (!this.mediaSession) return;
    const req = new (window as any).chrome.cast.media.SeekRequest();
    req.currentTime = time;
    this.mediaSession.seek(req, null, null);
    this.castCurrentTime.set(time);
  }

  setVolume(level: number) {
    if (!this.mediaSession) return;
    const vol = new (window as any).chrome.cast.Volume();
    vol.level = Math.max(0, Math.min(1, level));
    const req = new (window as any).chrome.cast.media.VolumeRequest();
    req.volume = vol;
    this.mediaSession.setVolume(req, null, null);
  }

  setMuted(muted: boolean) {
    if (!this.mediaSession) return;
    const vol = new (window as any).chrome.cast.Volume();
    vol.muted = muted;
    const req = new (window as any).chrome.cast.media.VolumeRequest();
    req.volume = vol;
    this.mediaSession.setVolume(req, null, null);
  }

  activateTrack(trackId: number | null) {
    if (!this.mediaSession) return;
    const req = new (window as any).chrome.cast.media.EditTracksInfoRequest();
    req.activeTrackIds = trackId != null ? [trackId] : [];
    this.mediaSession.editTracksInfo(req, null, null);
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private setupMediaListener(media: any) {
    this.mediaSession = media;
    this.castDuration.set(media.media?.duration ?? 0);
    this.castPlaying.set(media.playerState === 'PLAYING' || media.playerState === 'BUFFERING');

    media.addUpdateListener((isAlive: boolean) => {
      if (!isAlive) {
        this.mediaSession = null;
        this.castPlaying.set(false);
        clearInterval(this.pollInterval);
        return;
      }
      this.castPlaying.set(media.playerState === 'PLAYING' || media.playerState === 'BUFFERING');
      const dur = media.media?.duration ?? 0;
      if (dur > 0) this.castDuration.set(dur);
    });

    clearInterval(this.pollInterval);
    this.pollInterval = setInterval(() => {
      if (this.mediaSession) {
        this.ngZone.run(() => this.castCurrentTime.set(this.mediaSession.currentTime ?? 0));
      }
    }, 500);
  }

  // ── Cast URL ──────────────────────────────────────────────────────────────

  async castUrl(
    url: string, contentType: string, title?: string, poster?: string,
    tracks?: Array<{ id: number; lang: string; name: string; url: string }>,
    activeTrackId?: number
  ) {
    if (!this.isReady()) this.init();
    const session = this.context.getCurrentSession() ?? await this.context.requestSession();

    const mediaUrl = url.startsWith('http') ? url : `${CAST_MEDIA_BASE}${url}`;
    console.log(`[Cast] Loading media: ${mediaUrl}`);

    const mediaInfo = new (window as any).chrome.cast.media.MediaInfo(mediaUrl, contentType);
    const md = new (window as any).chrome.cast.media.MovieMediaMetadata();
    if (title) md.title = title;
    if (poster) md.images = [{ url: poster }];
    mediaInfo.metadata = md;

    if (tracks?.length) {
      mediaInfo.tracks = tracks.map(t => {
        const track = new (window as any).chrome.cast.media.Track(
          t.id, (window as any).chrome.cast.media.TrackType.TEXT
        );
        track.language         = t.lang || 'und';
        track.name             = t.name || t.lang;
        track.subtype          = (window as any).chrome.cast.media.TextTrackType.SUBTITLES;
        track.trackContentType = 'text/vtt';
        track.trackContentId   = t.url;
        return track;
      });
      
      // Configure subtitle styling: transparent background, white text, black outline
      const textTrackStyle = new (window as any).chrome.cast.media.TextTrackStyle();
      textTrackStyle.foregroundColor = '#FFFFFFFF';  // White text (RRGGBBAA format)
      textTrackStyle.backgroundColor = '#00000000';  // Transparent background
      textTrackStyle.windowColor = '#00000000';      // Transparent window
      textTrackStyle.edgeType = (window as any).chrome.cast.media.TextTrackEdgeType.OUTLINE;
      textTrackStyle.edgeColor = '#000000FF';        // Black outline (RRGGBBAA format)
      textTrackStyle.fontScale = 1.0;                // Normal font size
      mediaInfo.textTrackStyle = textTrackStyle;
    }

    const request = new (window as any).chrome.cast.media.LoadRequest(mediaInfo);
    if (activeTrackId != null) request.activeTrackIds = [activeTrackId];

    try {
      await session.loadMedia(request);
      console.log('[Cast] Media loaded successfully');
      const media = session.getMediaSession();
      if (media) this.setupMediaListener(media);
    } catch (error) {
      console.error('[Cast] Failed to load media:', error);
      throw error;
    }
  }
}
