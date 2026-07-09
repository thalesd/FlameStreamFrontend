import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ProcessingTrackerService } from '../../services/processing-tracker.service';
import { LibraryService } from '../../services/library.service';
import { formatTime } from '../../util/format';

/** Top-nav processing tracker: a badge button that opens a fixed popup of active ffmpeg jobs. */
@Component({
  selector: 'app-processing-tracker',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './processing-tracker.component.html',
})
export class ProcessingTrackerComponent implements OnInit, OnDestroy {
  tracker = inject(ProcessingTrackerService);
  private lib = inject(LibraryService);
  private unsubscribe?: () => void;

  readonly formatTime = formatTime;
  fileNameFor = (path: string) => this.lib.fileNameFor(path);

  trackerPopupPos = signal<{ top: number; left: number } | null>(null);
  private closeTimer: any;

  ngOnInit() { this.unsubscribe = this.tracker.subscribe(); }
  ngOnDestroy() { clearTimeout(this.closeTimer); this.unsubscribe?.(); }

  onEnter(e: MouseEvent) {
    clearTimeout(this.closeTimer);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // Anchor the (300px-wide) popup to the button's right edge and open it leftward —
    // anchoring the left edge ran it off-screen.
    const POPUP_W = 300;
    const left = Math.max(8, rect.right - POPUP_W);
    this.trackerPopupPos.set({ top: rect.bottom + 8, left });
  }

  onLeave() {
    // The popup is position:fixed with an 8px gap below the button, so moving the pointer
    // toward it fires mouseleave; delay the close so the pointer can cross the gap.
    clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => this.trackerPopupPos.set(null), 250);
  }

  keepOpen() { clearTimeout(this.closeTimer); }
}
