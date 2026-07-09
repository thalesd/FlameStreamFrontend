import { Component, Input, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { LibraryService } from '../../services/library.service';
import { PlayerStateService } from '../../services/player-state.service';
import { MediaFileNode } from '../../services/media.service';
import { formatBytes } from '../../util/format';

/** A single library poster tile with hover actions (preprocess / delete-cache / status). */
@Component({
  selector: 'app-tile',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './tile.component.html',
})
export class TileComponent {
  @Input({ required: true }) node!: MediaFileNode;

  lib = inject(LibraryService);
  state = inject(PlayerStateService);
  readonly formatBytes = formatBytes;

  posterSrc = (n: MediaFileNode) => this.lib.posterSrc(n);
  onThumbError = (url: string) => this.lib.onThumbError(url);
  jobForPath = (path: string) => this.lib.jobForPath(path);

  open() { this.lib.openFocus(this.node); }
  toggleList(e: Event) { this.lib.toggleList(this.node, e); }

  preprocess(node: MediaFileNode, e: Event) {
    e.stopPropagation();
    this.lib.preprocessFile(node);
  }

  deleteCache(node: MediaFileNode, e: Event) {
    e.stopPropagation();
    if (this.state.selected()?.path === node.path) return; // don't pull the rug out from playback
    if (!confirm(`Liberar ${this.formatBytes(node.cachedBytes ?? 0)} excluindo o processamento salvo de "${node.name}"?`)) return;
    this.lib.deleteCache(node);
  }
}
