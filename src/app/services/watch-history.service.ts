import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { BACKEND_BASE } from '../../../env-cast';

export type WatchHistoryEntry = {
  path: string;
  positionSeconds: number;
  durationSeconds: number;
  lastWatchedUtc: string;
};

@Injectable({ providedIn: 'root' })
export class WatchHistoryService {
  constructor(private http: HttpClient) {}

  async get(path: string): Promise<WatchHistoryEntry | null> {
    try {
      return await firstValueFrom(
        this.http.get<WatchHistoryEntry | null>(`${BACKEND_BASE}/api/watch-history/${path}`)
      );
    } catch {
      return null;
    }
  }

  async continueWatching(): Promise<WatchHistoryEntry[]> {
    try {
      return await firstValueFrom(this.http.get<WatchHistoryEntry[]>(`${BACKEND_BASE}/api/continue-watching`));
    } catch {
      return [];
    }
  }

  save(path: string, positionSeconds: number, durationSeconds: number): void {
    // Deliberately not using navigator.sendBeacon here: the Beacon API always sends
    // cross-origin requests with credentials included, which the browser then refuses
    // to accept against this backend's wildcard `Access-Control-Allow-Origin: *` CORS
    // policy (a fixed browser security rule, not something fixable client-side) — every
    // sendBeacon call to a cross-origin backend like ours fails outright. A plain POST
    // doesn't include credentials cross-origin by default, so it works with the
    // existing policy; the tradeoff is a beforeunload save can occasionally get cut off
    // by the browser mid-flight, which is acceptable for a personal watch-progress feature.
    this.http.post(`${BACKEND_BASE}/api/watch-history`, { path, positionSeconds, durationSeconds })
      .subscribe({ error: () => {} });
  }
}
