import { NgZone, Signal, signal } from '@angular/core';
import { RECEIVER_APP_ID } from '../../../env-cast';
import { FlameCast } from '../native/flame-cast';

/** Custom message channel shared with the receiver (backend wwwroot/receiver.js). */
export const CAST_NAMESPACE = 'urn:x-cast:flamestream';

/**
 * Low-level Cast transport: session lifecycle + raw custom-namespace messaging. Two impls —
 * {@link WebCastTransport} (Chrome's Web Sender SDK, browser only) and {@link NativeCastTransport}
 * (the FlameCast Capacitor plugin over the Android Cast SDK). CastService owns the higher-level
 * protocol (load payloads, status parsing, control messages) and is transport-agnostic.
 */
export interface CastTransport {
  /** A cast device is reachable (drives cast-button availability). */
  readonly available: Signal<boolean>;
  /** A receiver session is currently connected. */
  readonly connected: Signal<boolean>;
  /** Begin SDK init / device discovery. Idempotent. */
  init(): void;
  /** Open the device picker and connect; resolves once a session is active. */
  requestSession(): Promise<void>;
  /** Tear down the current session. */
  endSession(): void;
  /** Send a JSON-serialisable message over the custom namespace. */
  send(msg: unknown): void;
  /** Register the (single) handler for parsed messages from the receiver. */
  onMessage(handler: (msg: any) => void): void;
}

/**
 * Browser transport — Google Cast Web Sender SDK (`window.cast` / `window.chrome.cast`). This is
 * the original CastService logic, unchanged in behaviour; it only works in Chrome, never in the
 * Android WebView (hence NativeCastTransport for the app).
 */
export class WebCastTransport implements CastTransport {
  readonly available = signal(false);
  readonly connected = signal(false);

  private context: any;
  private _session: any = null;
  private initialized = false;
  private messageAttached = false;
  private handler: ((msg: any) => void) | null = null;

  constructor(private ngZone: NgZone) {}

  init(): void {
    if (this.initialized) return;

    const waitForCast = () =>
      new Promise<void>((resolve) => {
        const tick = () => {
          if (window.cast && window.chrome?.cast?.isAvailable) return resolve();
          setTimeout(tick, 100);
        };
        tick();
      });

    waitForCast().then(() => {
      const castContext = (window as any).cast.framework.CastContext.getInstance();
      castContext.setOptions({
        autoJoinPolicy: (window as any).chrome.cast.AutoJoinPolicy.TAB_AND_ORIGIN_SCOPED,
        receiverApplicationId: RECEIVER_APP_ID,
      });
      this.context = castContext;
      this.initialized = true;
      this.available.set(true);

      castContext.addEventListener(
        (window as any).cast.framework.CastContextEventType.SESSION_STATE_CHANGED,
        (e: any) => {
          const SS = (window as any).cast.framework.SessionState;
          if (e.sessionState === SS.SESSION_STARTED || e.sessionState === SS.SESSION_RESUMED) {
            this._session = castContext.getCurrentSession();
            this.attach();
            this.connected.set(true);
          } else if (e.sessionState === SS.SESSION_ENDED || e.sessionState === SS.NO_SESSION) {
            this._session = null;
            this.messageAttached = false;
            this.connected.set(false);
          }
        }
      );
    });
  }

  async requestSession(): Promise<void> {
    if (!this.context) this.init();
    if (this._session) return;
    // Wait for the SDK if init() is still polling for it.
    while (!this.context) await new Promise((r) => setTimeout(r, 100));
    this._session = this.context.getCurrentSession() ?? (await this.context.requestSession());
    this.attach();
    this.connected.set(true);
  }

  endSession(): void {
    try {
      this.context?.endCurrentSession?.(true);
    } catch {
      /* no active session */
    }
  }

  send(msg: unknown): void {
    if (!this._session) return;
    this._session
      .sendMessage(CAST_NAMESPACE, msg)
      .catch?.((e: any) => console.error('[Cast] sendMessage failed:', e));
  }

  onMessage(handler: (msg: any) => void): void {
    this.handler = handler;
    if (this._session) this.attach();
  }

  private attach(): void {
    if (!this._session || this.messageAttached) return;
    this.messageAttached = true;
    this._session.addMessageListener(CAST_NAMESPACE, (_ns: string, raw: string) => {
      let m: any;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      this.ngZone.run(() => this.handler?.(m));
    });
  }
}

/**
 * Native transport — the FlameCast Capacitor plugin bridging to the Android Cast SDK. Same custom
 * receiver + namespace as the web path, so the receiver needs no changes.
 */
export class NativeCastTransport implements CastTransport {
  readonly available = signal(false);
  readonly connected = signal(false);

  private started = false;
  private handler: ((msg: any) => void) | null = null;

  constructor(private ngZone: NgZone) {}

  init(): void {
    if (this.started) return;
    this.started = true;

    FlameCast.addListener('availabilityChanged', (e) =>
      this.ngZone.run(() => this.available.set(!!e.available))
    );
    FlameCast.addListener('sessionStateChanged', (e) =>
      this.ngZone.run(() => this.connected.set(e.state === 'connected'))
    );
    FlameCast.addListener('messageReceived', (e) => {
      let m: any;
      try {
        m = JSON.parse(e.message);
      } catch {
        return;
      }
      this.ngZone.run(() => this.handler?.(m));
    });

    FlameCast.initialize({ receiverAppId: RECEIVER_APP_ID, namespace: CAST_NAMESPACE });
  }

  async requestSession(): Promise<void> {
    this.init();
    if (this.connected()) return;
    await FlameCast.requestSession();
    this.connected.set(true);
  }

  endSession(): void {
    FlameCast.endSession();
  }

  send(msg: unknown): void {
    FlameCast.sendMessage({ message: JSON.stringify(msg) });
  }

  onMessage(handler: (msg: any) => void): void {
    this.handler = handler;
  }
}
