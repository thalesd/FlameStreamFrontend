import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FireplaceService } from '../../services/fireplace.service';
import { LibraryService, NavFilter } from '../../services/library.service';
import { ProcessingTrackerComponent } from '../processing-tracker/processing-tracker.component';

/** Top navigation bar: brand, section links (Home/Films/Series/List), fireplace, tracker, avatar. */
@Component({
  selector: 'app-nav',
  standalone: true,
  imports: [CommonModule, ProcessingTrackerComponent],
  templateUrl: './nav.component.html',
})
export class NavComponent {
  lib = inject(LibraryService);
  fire = inject(FireplaceService);

  enterFireplace() { this.fire.enter(); }

  setFilter(f: NavFilter) {
    this.lib.closeFocus();       // leave any detail page when switching sections
    this.lib.navFilter.set(f);
  }
}
