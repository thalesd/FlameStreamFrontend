import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { PlayerStateService } from '../../services/player-state.service';
import { LibraryService } from '../../services/library.service';
import { SubtitlesModalComponent } from '../subtitles-modal/subtitles-modal.component';
import { formatTime } from '../../util/format';

/** The full-screen player stage: video, top bar, banners, controls and the subtitles modal. */
@Component({
  selector: 'app-player',
  standalone: true,
  imports: [CommonModule, SubtitlesModalComponent],
  templateUrl: './player.component.html',
})
export class PlayerComponent implements AfterViewInit, OnDestroy {
  state = inject(PlayerStateService);
  lib = inject(LibraryService);
  readonly formatTime = formatTime;

  @ViewChild('player',      { static: false }) playerRef!:       ElementRef<HTMLVideoElement>;
  @ViewChild('container',   { static: false }) containerRef!:    ElementRef<HTMLDivElement>;
  @ViewChild('progressArea',{ static: false }) progressAreaRef?: ElementRef<HTMLDivElement>;

  ngAfterViewInit() {
    this.state.setVideo(this.playerRef?.nativeElement);
    this.state.setContainer(this.containerRef?.nativeElement);
    this.state.setProgressArea(this.progressAreaRef?.nativeElement);
  }

  ngOnDestroy() {
    this.state.teardownPlayer();
  }
}
