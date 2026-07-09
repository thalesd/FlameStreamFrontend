import { Injectable, signal, computed } from '@angular/core';

/**
 * Fireplace Mode (design 3d) — the idle ambient screensaver.
 *
 * Lives in a service (not the component) because the idle countdown must keep running while
 * the screensaver isn't rendered, and both the nav button and the player need to reach it.
 * `PlayerStateService` pushes playback state in via {@link setPlaying} so we can inject one-way
 * (PlayerState → Fireplace) without a DI cycle.
 */
@Injectable({ providedIn: 'root' })
export class FireplaceService {
  active = signal(false);
  private now = signal(new Date());
  private clockTimer: any;

  // Auto-enter after this long without interaction (unless a video is actively playing).
  private readonly IDLE_MS = 120000;
  private idleTimer: any;
  private playing = false;
  // Mouse movement / scrolling only signals presence — it must never dismiss the screensaver.
  private readonly moveHandler = () => { if (!this.active()) this.armIdle(); };
  // Deliberate input (click / tap / key) is what dismisses the screensaver.
  private readonly wakeHandler = () => this.onUserInput();

  constructor() {
    for (const ev of ['mousemove', 'wheel', 'touchmove']) {
      window.addEventListener(ev, this.moveHandler, { passive: true });
    }
    for (const ev of ['mousedown', 'keydown', 'touchstart']) {
      window.addEventListener(ev, this.wakeHandler, { passive: true });
    }
    this.armIdle();   // arm the idle countdown
  }

  time = computed(() => {
    const d = this.now();
    return `${d.getHours()}:${d.getMinutes().toString().padStart(2, '0')}`;
  });
  date = computed(() => {
    const s = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })
      .format(this.now());
    return s.charAt(0).toUpperCase() + s.slice(1);
  });

  /** Kept in sync by PlayerStateService so the idle timer never interrupts active playback. */
  setPlaying(v: boolean) { this.playing = v; }

  enter() {
    if (this.active()) return;
    clearTimeout(this.idleTimer);
    this.active.set(true);
    this.now.set(new Date());
    this.clockTimer = setInterval(() => this.now.set(new Date()), 1000);
  }

  exit() {
    if (!this.active()) return;
    this.active.set(false);
    clearInterval(this.clockTimer);
  }

  // A click / tap / keypress dismisses the screensaver; otherwise it re-arms the idle countdown.
  private onUserInput() {
    if (this.active()) { this.exit(); return; }
    this.armIdle();
  }

  // (Re)start the idle countdown. It only fires while nothing is playing, so it never
  // interrupts a film.
  private armIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { if (!this.playing) this.enter(); }, this.IDLE_MS);
  }
}
