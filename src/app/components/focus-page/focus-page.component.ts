import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { LibraryService } from '../../services/library.service';
import { PlayerStateService } from '../../services/player-state.service';
import { MediaFileNode } from '../../services/media.service';
import { formatTime, formatBytes } from '../../util/format';

/** The title detail / focus page: backdrop, Play, Add-to-List, and a sibling episode list. */
@Component({
  selector: 'app-focus-page',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './focus-page.component.html',
})
export class FocusPageComponent {
  lib = inject(LibraryService);
  private state = inject(PlayerStateService);
  readonly formatTime = formatTime;
  readonly formatBytes = formatBytes;
  jobForPath = (path: string) => this.lib.jobForPath(path);

  posterSrc = (n: MediaFileNode) => this.lib.posterSrc(n);
  onThumbError = (url: string) => this.lib.onThumbError(url);
  cleanTitle = (name: string) => name.replace(/\.[^.]+$/, '');

  siblings = (node: MediaFileNode) => this.lib.siblingsOf(node.path);
  siblingsLabel = (node: MediaFileNode) => (this.lib.pathKind(node.path) === 'series' ? 'Episódios' : 'Coleção');

  /** Resume percent from the continue-watching shelf, or 0 if not started. */
  progressPct(node: MediaFileNode): number {
    const cw = this.lib.continueWatchingItems().find(i => i.file.path === node.path);
    if (!cw || !cw.entry.durationSeconds) return 0;
    return (cw.entry.positionSeconds / cw.entry.durationSeconds) * 100;
  }

  play(node: MediaFileNode) { this.state.select(node, true); this.lib.closeFocus(); }
  playSibling(node: MediaFileNode, e: Event) { e.stopPropagation(); this.play(node); }
  toggleList(node: MediaFileNode) { this.lib.toggleList(node); }
  openSibling(node: MediaFileNode) { this.lib.openFocus(node); }
  close() { this.lib.closeFocus(); }

  preprocess(node: MediaFileNode) { this.lib.preprocessFile(node); }

  deleteCache(node: MediaFileNode) {
    if (this.state.selected()?.path === node.path) return;   // don't pull the rug out from playback
    if (!confirm(`Liberar ${formatBytes(node.cachedBytes ?? 0)} excluindo o processamento salvo de "${node.name}"?`)) return;
    this.lib.deleteCache(node);
  }
}
