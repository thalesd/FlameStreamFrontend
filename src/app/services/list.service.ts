import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { BACKEND_BASE } from '../../../env-cast';

/**
 * "Minha lista" — the user's saved-titles list, persisted server-side (mirrors
 * WatchHistoryService). Plain POSTs (not sendBeacon) so the wildcard-CORS backend accepts them.
 */
@Injectable({ providedIn: 'root' })
export class ListService {
  private http = inject(HttpClient);

  async getAll(): Promise<string[]> {
    try {
      return await firstValueFrom(this.http.get<string[]>(`${BACKEND_BASE}/api/list`));
    } catch {
      return [];
    }
  }

  add(path: string): Promise<unknown> {
    return firstValueFrom(this.http.post(`${BACKEND_BASE}/api/list`, { path }));
  }

  remove(path: string): Promise<unknown> {
    return firstValueFrom(this.http.post(`${BACKEND_BASE}/api/list/remove`, { path }));
  }
}
