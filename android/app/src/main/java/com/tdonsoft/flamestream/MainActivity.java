package com.tdonsoft.flamestream;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // App-local plugin (native Chromecast bridge) — must be registered before the bridge starts.
        registerPlugin(FlameCastPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
