import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FireplaceService } from '../../services/fireplace.service';

/** Fireplace Mode (design 3d) — the idle ambient screensaver overlay. */
@Component({
  selector: 'app-fireplace',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './fireplace.component.html',
})
export class FireplaceComponent {
  fire = inject(FireplaceService);
}
