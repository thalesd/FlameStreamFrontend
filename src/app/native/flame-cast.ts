import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

/**
 * Native Chromecast bridge (Android Cast SDK). Implemented in the app's Android module
 * (FlameCastPlugin.java); there is no web implementation — the browser uses the Cast Web Sender
 * SDK directly (see WebCastTransport). Calls to this plugin are only made on native platforms.
 *
 * It exposes exactly what the custom-receiver protocol needs: connect to a device running our
 * custom receiver app, and pass opaque JSON both ways over the `urn:x-cast:flamestream` channel.
 */
export interface FlameCastPlugin {
  /** Initialise CastContext with our receiver app id + custom namespace, and start discovery. */
  initialize(options: { receiverAppId: string; namespace: string }): Promise<void>;
  /** Show the system device chooser and connect; resolves once a session is established. */
  requestSession(): Promise<void>;
  /** End the current cast session. */
  endSession(): Promise<void>;
  /** Send a message string over the custom namespace to the receiver. */
  sendMessage(options: { message: string }): Promise<void>;

  /** A cast device on the network became available/unavailable. */
  addListener(
    eventName: 'availabilityChanged',
    listenerFunc: (event: { available: boolean }) => void
  ): Promise<PluginListenerHandle>;
  /** Session lifecycle: 'connecting' | 'connected' | 'ended'. */
  addListener(
    eventName: 'sessionStateChanged',
    listenerFunc: (event: { state: 'connecting' | 'connected' | 'ended' }) => void
  ): Promise<PluginListenerHandle>;
  /** A message arrived from the receiver over the custom namespace. */
  addListener(
    eventName: 'messageReceived',
    listenerFunc: (event: { message: string }) => void
  ): Promise<PluginListenerHandle>;
}

export const FlameCast = registerPlugin<FlameCastPlugin>('FlameCast');
