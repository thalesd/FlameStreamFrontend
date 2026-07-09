import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { LibraryService } from '../../services/library.service';
import { PlayerStateService } from '../../services/player-state.service';
import { MediaFileNode } from '../../services/media.service';
import { formatTime } from '../../util/format';

/** The home hero: the featured (most-recent / first) title with poster art + PLAY. */
@Component({
  selector: 'app-hero',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './hero.component.html',
})
export class HeroComponent {
  lib = inject(LibraryService);
  private state = inject(PlayerStateService);

  readonly formatTime = formatTime;
  posterSrc = (n: MediaFileNode) => this.lib.posterSrc(n);
  onThumbError = (url: string) => this.lib.onThumbError(url);
  play(node: MediaFileNode) { this.state.select(node); }
  toggleList(node: MediaFileNode) { this.lib.toggleList(node); }
}
