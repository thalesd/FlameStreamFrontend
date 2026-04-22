// src/app/services/media.service.ts
import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../environments/environment';
import { map } from 'rxjs/operators';
import { Observable } from 'rxjs';

export type MediaItem = { id: string; title: string; url: string; contentType: string; subUrl?: string; };

type BackendFile = {
  name: string;
  path: string;          // relative path under your media folder
  contentType: string;   // optional from backend
  subUrl?: string;    // optional subtitle URL from backend
};

@Injectable({ providedIn: 'root' })
export class MediaService {
  private base: string;

  constructor(private http: HttpClient) {
    this.base = environment.apiBaseUrl;
  }

  list(): Observable<MediaItem[]> {
    return this.http.get<BackendFile[]>(`/api/media`).pipe(
      map(files =>
        files.map(f => ({
          id: encodeURIComponent(f.path),
          title: f.name,
          // IMPORTANT: keep path as-is (with slashes); only encode when building URLs.
          url: `/stream/${encodeURI(f.path)}.m3u8`,
          contentType: 'application/vnd.apple.mpegurl',
          subUrl: f.subUrl
        }))
      )
    );
  }

  private guessType(path: string): string {
    const ext = path.split('.').pop()?.toLowerCase();
    return ext === 'mp4' ? 'video/mp4' : 'application/octet-stream';
  }
}
