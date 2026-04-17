// src/app/services/cast.service.ts
import { Injectable } from '@angular/core';
import { CAST_MEDIA_BASE } from '../../../env-cast';

@Injectable({ providedIn: 'root' })
export class CastService {
  private context: any;
  private session: cast.framework.CastSession | null = null;
  private initialized = false;

  init(): void {
    // Default Media Receiver App ID (good for most use cases)
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
        receiverApplicationId: (window as any).chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
      });
      this.context = castContext;
      this.initialized = true;
      // Optional: set logger level if available
      const ui = (window as any).cast?.framework?.ui;
      if (ui?.setLoggerLevel) {
        ui.setLoggerLevel((window as any).cast.framework.LoggerLevel.ERROR);
      }
    });
  }

  isConnected(): boolean {
    return !!this.session;
  }

  isReady(): boolean {
    return !!this.context;
  }

  async requestSession(): Promise<cast.framework.CastSession> {
    if (this.session) return this.session;
    this.session = await this.context.requestSession();
    return this.session;
  }

  async castUrl(url: string, contentType: string, title?: string, poster?: string, tracks?: Array<{id:number, lang:string, name:string, url:string}>, activeTrackId?: number) 
  {
    if (!this.isReady()) this.init();
    const session = this.context.getCurrentSession() ?? await this.context.requestSession();

    console.log(url);
    const mediaUrl = url.startsWith('http') ? url : `${CAST_MEDIA_BASE}${url}`;
    const mediaInfo = new (window as any).chrome.cast.media.MediaInfo(mediaUrl, contentType);
    const md = new (window as any).chrome.cast.media.MovieMediaMetadata();
    if (title) md.title = title;
    if (poster) md.images = [{ url: poster }];
    mediaInfo.metadata = md;

    if (tracks?.length) {
      mediaInfo.tracks = tracks.map(t => {
        const track = new (window as any).chrome.cast.media.Track(t.id, (window as any).chrome.cast.media.TrackType.TEXT);
        track.language = t.lang || 'und';
        track.name = t.name || t.lang;
        track.subtype = (window as any).chrome.cast.media.TextTrackType.SUBTITLES; // or CAPTIONS
        track.trackContentType = 'text/vtt';
        track.trackContentId = t.url; // absolute URL to your /hls/<hash>/sub_*.vtt
        return track;
      });
      mediaInfo.textTrackStyle = new (window as any).chrome.cast.media.TextTrackStyle();
    }

    const request = new (window as any).chrome.cast.media.LoadRequest(mediaInfo);
    if (activeTrackId) request.activeTrackIds = [activeTrackId];
    await session.loadMedia(request);
  }
}
