import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { BACKEND_BASE } from '../../../env-cast';

export type JobStatus = {
  key: string;
  path: string;
  jobType: 'main' | 'seek';
  startSeconds: number;
  percentComplete: number;
  elapsedSeconds: number;
};

@Injectable({ providedIn: 'root' })
export class ProcessingTrackerService {
  readonly jobs = signal<JobStatus[]>([]);
  private pollHandle: any = null;
  private subscriberCount = 0;

  constructor(private http: HttpClient) {}

  /** Multiple consumers (popup + sidebar rows) share one poll; it starts/stops with subscriber count. */
  subscribe(): () => void {
    this.subscriberCount++;
    if (this.subscriberCount === 1) this.startPolling();
    return () => {
      this.subscriberCount = Math.max(0, this.subscriberCount - 1);
      if (this.subscriberCount === 0) this.stopPolling();
    };
  }

  async cancel(key: string): Promise<void> {
    try {
      await firstValueFrom(this.http.post(`${BACKEND_BASE}/api/jobs/${key}/cancel`, {}));
    } finally {
      this.refresh();
    }
  }

  private startPolling() {
    this.refresh();
    this.pollHandle = setInterval(() => this.refresh(), 5000);
  }

  private stopPolling() {
    clearInterval(this.pollHandle);
    this.pollHandle = null;
    this.jobs.set([]);
  }

  private async refresh() {
    try {
      const jobs = await firstValueFrom(this.http.get<JobStatus[]>(`${BACKEND_BASE}/api/jobs`));
      this.jobs.set(jobs);
    } catch {
      // transient network hiccup — keep showing the last known state
    }
  }
}
