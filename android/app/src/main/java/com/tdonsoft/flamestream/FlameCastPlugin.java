package com.tdonsoft.flamestream;

import android.os.Handler;
import android.os.Looper;
import android.view.ContextThemeWrapper;

import androidx.mediarouter.app.MediaRouteChooserDialog;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.cast.Cast;
import com.google.android.gms.cast.CastDevice;
import com.google.android.gms.cast.framework.CastContext;
import com.google.android.gms.cast.framework.CastSession;
import com.google.android.gms.cast.framework.CastState;
import com.google.android.gms.cast.framework.SessionManager;
import com.google.android.gms.cast.framework.SessionManagerListener;

/**
 * Native Chromecast bridge for the Capacitor app. The web Cast Sender SDK can't run inside the
 * Android WebView, so this wraps the Android Cast SDK and exposes just what the custom receiver
 * protocol needs: connect to a device running our receiver app, and pass opaque JSON both ways over
 * the {@code urn:x-cast:flamestream} channel. Playback is driven entirely by those messages (the
 * TV's CAF PlayerManager is broken), exactly as on the web — the receiver is unchanged.
 */
@CapacitorPlugin(name = "FlameCast")
public class FlameCastPlugin extends Plugin {

    private CastContext castContext;
    private SessionManager sessionManager;
    private String namespace = "urn:x-cast:flamestream";

    // The pending requestSession() call, resolved when a session actually connects (or rejected on
    // failure / user cancel). Only one at a time.
    private PluginCall pendingSessionCall;
    private boolean connecting;

    // Receiver -> sender messages on the custom channel.
    private final Cast.MessageReceivedCallback messageCallback = new Cast.MessageReceivedCallback() {
        @Override
        public void onMessageReceived(CastDevice castDevice, String ns, String message) {
            JSObject data = new JSObject();
            data.put("message", message);
            notifyListeners("messageReceived", data);
        }
    };

    private final SessionManagerListener<CastSession> sessionListener = new SessionManagerListener<CastSession>() {
        @Override public void onSessionStarting(CastSession session) { connecting = true; emitState("connecting"); }
        @Override public void onSessionStarted(CastSession session, String sessionId) { onConnected(session); }
        @Override public void onSessionStartFailed(CastSession session, int error) { failPending("start failed (" + error + ")"); }
        @Override public void onSessionResuming(CastSession session, String sessionId) { connecting = true; }
        @Override public void onSessionResumed(CastSession session, boolean wasSuspended) { onConnected(session); }
        @Override public void onSessionResumeFailed(CastSession session, int error) { failPending("resume failed (" + error + ")"); }
        @Override public void onSessionSuspended(CastSession session, int reason) { emitState("ended"); }
        @Override public void onSessionEnding(CastSession session) { /* no-op */ }
        @Override public void onSessionEnded(CastSession session, int error) { connecting = false; emitState("ended"); }
    };

    private void onConnected(CastSession session) {
        connecting = false;
        attachChannel(session);
        emitState("connected");
        resolvePending();
    }

    @PluginMethod
    public void initialize(PluginCall call) {
        String ns = call.getString("namespace");
        if (ns != null) namespace = ns;
        runMain(() -> {
            try {
                castContext = CastContext.getSharedInstance(getContext());
                sessionManager = castContext.getSessionManager();
                sessionManager.addSessionManagerListener(sessionListener, CastSession.class);

                castContext.addCastStateListener(state -> {
                    JSObject data = new JSObject();
                    data.put("available", state != CastState.NO_DEVICES_AVAILABLE);
                    notifyListeners("availabilityChanged", data);
                });
                // Emit the current availability immediately so the UI doesn't wait for a change.
                JSObject initial = new JSObject();
                initial.put("available", castContext.getCastState() != CastState.NO_DEVICES_AVAILABLE);
                notifyListeners("availabilityChanged", initial);

                // Re-attach if a session is already live (e.g. after an activity recreate).
                CastSession existing = sessionManager.getCurrentCastSession();
                if (existing != null && existing.isConnected()) onConnected(existing);

                call.resolve();
            } catch (Exception e) {
                call.reject("Cast init failed: " + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void requestSession(PluginCall call) {
        runMain(() -> {
            if (castContext == null) { call.reject("Cast not initialised"); return; }
            CastSession current = sessionManager.getCurrentCastSession();
            if (current != null && current.isConnected()) { call.resolve(); return; }

            pendingSessionCall = call;
            // MediaRouteChooserDialog requires an AppCompat theme; wrap the activity in our
            // AppCompat AppTheme so it can't crash even if the launch/splash theme is in effect.
            ContextThemeWrapper themed = new ContextThemeWrapper(getActivity(), R.style.AppTheme);
            MediaRouteChooserDialog dialog = new MediaRouteChooserDialog(themed);
            dialog.setRouteSelector(castContext.getMergedSelector());
            // Selecting a Cast route makes the framework start a session (-> onSessionStarted).
            // If the user dismisses without picking anything, nothing starts — reject after a grace
            // period so the JS promise doesn't hang. The delay lets onSessionStarting flip
            // `connecting` first when a device WAS chosen.
            dialog.setOnDismissListener(d -> new Handler(Looper.getMainLooper()).postDelayed(() -> {
                if (pendingSessionCall != null && !connecting) {
                    CastSession cs = sessionManager.getCurrentCastSession();
                    if (cs == null || !cs.isConnected()) failPending("No cast device selected");
                }
            }, 500));
            dialog.show();
        });
    }

    @PluginMethod
    public void sendMessage(PluginCall call) {
        String message = call.getString("message");
        if (message == null) { call.reject("message required"); return; }
        runMain(() -> {
            CastSession session = sessionManager != null ? sessionManager.getCurrentCastSession() : null;
            if (session == null || !session.isConnected()) { call.reject("No cast session"); return; }
            try {
                session.sendMessage(namespace, message);
                call.resolve();
            } catch (Exception e) {
                call.reject("sendMessage failed: " + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void endSession(PluginCall call) {
        runMain(() -> {
            if (sessionManager != null) sessionManager.endCurrentSession(true);
            call.resolve();
        });
    }

    private void attachChannel(CastSession session) {
        try {
            session.setMessageReceivedCallbacks(namespace, messageCallback);
        } catch (Exception e) {
            // Non-fatal: controls just won't reach the receiver; log and carry on.
            android.util.Log.e("FlameCast", "attachChannel failed", e);
        }
    }

    private void emitState(String state) {
        JSObject data = new JSObject();
        data.put("state", state);
        notifyListeners("sessionStateChanged", data);
    }

    private void resolvePending() {
        if (pendingSessionCall != null) {
            pendingSessionCall.resolve();
            pendingSessionCall = null;
        }
    }

    private void failPending(String reason) {
        connecting = false;
        if (pendingSessionCall != null) {
            pendingSessionCall.reject(reason);
            pendingSessionCall = null;
        }
    }

    private void runMain(Runnable r) {
        getActivity().runOnUiThread(r);
    }
}
