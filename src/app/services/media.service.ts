import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export type EmbeddedSubtitle = { url: string; language: string; title: string; codec: string; };

export type MediaItem = {
  id: string;
  title: string;
  url: string;
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
  subUrl?: string | null;
  embeddedSubtitles: EmbeddedSubtitle[];
  duration?: number;
  width?: number;
  height?: number;
};

export type MediaNode = MediaFolder | MediaFileNode;

@Injectable({ providedIn: 'root' })
export class MediaService {
  constructor(private http: HttpClient) {}

  list(): Observable<MediaNode[]> {
    return this.http.get<MediaNode[]>(`/api/media`);
  }

  toMediaItem(file: MediaFileNode): MediaItem {
    return {
      id: encodeURIComponent(file.path),
      title: file.name,
      url: file.url,
      contentType: 'application/vnd.apple.mpegurl',
      subUrl: file.subUrl,
      embeddedSubtitles: file.embeddedSubtitles ?? [],
      duration: file.duration,
      width: file.width,
      height: file.height,
    };
  }
}
