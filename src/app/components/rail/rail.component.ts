import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Rail } from '../../services/library.service';
import { TileComponent } from '../tile/tile.component';

/** A titled horizontal carousel of library tiles, with hover arrows that page-scroll. */
@Component({
  selector: 'app-rail',
  standalone: true,
  imports: [CommonModule, TileComponent],
  templateUrl: './rail.component.html',
})
export class RailComponent {
  @Input({ required: true }) rail!: Rail;

  scrollRail(row: HTMLElement, dir: number) {
    row.scrollBy({ left: row.clientWidth * 0.9 * dir, behavior: 'smooth' });
  }
}
