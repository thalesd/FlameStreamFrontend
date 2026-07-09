import { Component, ElementRef, ViewChild, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { PlayerStateService } from '../../services/player-state.service';

/** The Legendas & Captions panel (design 3c): track selection, sync delay, text size. */
@Component({
  selector: 'app-subtitles-modal',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './subtitles-modal.component.html',
})
export class SubtitlesModalComponent {
  state = inject(PlayerStateService);
  @ViewChild('subFileInput', { static: false }) subFileInputRef?: ElementRef<HTMLInputElement>;

  promptAddSubtitle() { this.subFileInputRef?.nativeElement.click(); }

  onFilePicked(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';                     // allow re-picking the same file
    if (file) this.state.onSubtitleFilePicked(file);
  }
}
