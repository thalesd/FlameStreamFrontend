import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, firstValueFrom } from 'rxjs';
import { BACKEND_BASE } from '../../../env-cast';

export type EmbeddedSubtitle = { url: string; language: string; title: string; codec: string; };

export type MediaItem = {
  id: string;
  path: string;
  title: string;
  url: string;
  directUrl: string;
  contentType: string;
  subUrl?: string | null;
  embeddedSubtitles: EmbeddedSubtitle[];
  duration?: number;
  width?: number;
  height?: number;
};

export type MediaFolder = {
  type: 'folder';
  name: string;
  path: string;
  children: MediaNode[];
};

export type MediaFileNode = {
  type: 'file';
  name: string;
  path: string;
  url: string;
  directUrl: string;
  subUrl?: string | null;
  embeddedSubtitles: EmbeddedSubtitle[];
  duration?: number;
  width?: number;
  height?: number;
  ready?: boolean;
  cachedBytes?: number;
};

export type MediaNode = MediaFolder | MediaFileNode;

@Injectable({ providedIn: 'root' })
export class MediaService {
  constructor(private http: HttpClient) {}

  list(): Observable<MediaNode[]> {
    return this.http.get<MediaNode[]>(`${BACKEND_BASE}/api/media`);
  }

  async preprocess(path: string): Promise<void> {
    await firstValueFrom(
      this.http.post(`${BACKEND_BASE}/api/preprocess?path=${encodeURIComponent(path)}`, {})
    );
  }

  async deleteCache(path: string): Promise<void> {
    await firstValueFrom(
      this.http.post(`${BACKEND_BASE}/api/cache/delete?path=${encodeURIComponent(path)}`, {})
    );
  }

  toMediaItem(file: MediaFileNode): MediaItem {
    return {
      id: encodeURIComponent(file.path),
      path: file.path,
      title: file.name,
      url: `${BACKEND_BASE}${file.url}`,
      directUrl: `${BACKEND_BASE}${file.directUrl}`,
      contentType: 'application/vnd.apple.mpegurl',
      subUrl: file.subUrl ? `${BACKEND_BASE}${file.subUrl}` : file.subUrl,
      embeddedSubtitles: (file.embeddedSubtitles ?? []).map(s => ({
        ...s,
        url: `${BACKEND_BASE}${s.url}`,
      })),
      duration: file.duration,
      width: file.width,
      height: file.height,
    };
  }
}
