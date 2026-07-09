import { Component, ViewEncapsulation, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { LibraryService } from '../services/library.service';
import { PlayerStateService } from '../services/player-state.service';
import { FireplaceService } from '../services/fireplace.service';
import { MediaFileNode } from '../services/media.service';
import { NavComponent } from '../components/nav/nav.component';
import { HeroComponent } from '../components/hero/hero.component';
import { RailComponent } from '../components/rail/rail.component';
import { TileComponent } from '../components/tile/tile.component';
import { PlayerComponent } from '../components/player/player.component';
import { FireplaceComponent } from '../components/fireplace/fireplace.component';
import { FocusPageComponent } from '../components/focus-page/focus-page.component';
import { formatTime } from '../util/format';

/**
 * Thin shell composing the CozyFlame views: browse home (nav + hero + rails), the player, and
 * the fireplace overlay. All state lives in LibraryService / PlayerStateService / FireplaceService;
 * this component just wires the top-level layout. ViewEncapsulation.None keeps the shared .cf-*
 * stylesheet global so every extracted child renders with the same styles.
 */
@Component({
  selector: 'app-home',
  standalone: true,
  imports: [
    CommonModule, NavComponent, HeroComponent, RailComponent, TileComponent,
    PlayerComponent, FireplaceComponent, FocusPageComponent,
  ],
  templateUrl: './home.component.html',
  styleUrls: ['./home.component.scss'],
  encapsulation: ViewEncapsulation.None,
})
export class HomeComponent {
  lib   = inject(LibraryService);
  state = inject(PlayerStateService);
  fire  = inject(FireplaceService);

  readonly formatTime = formatTime;
  posterSrc = (n: MediaFileNode) => this.lib.posterSrc(n);

  scrollRail(row: HTMLElement, dir: number) {
    row.scrollBy({ left: row.clientWidth * 0.9 * dir, behavior: 'smooth' });
  }
}
