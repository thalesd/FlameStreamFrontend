package com.tdonsoft.flamestream;

import android.content.Context;

import com.google.android.gms.cast.framework.CastOptions;
import com.google.android.gms.cast.framework.OptionsProvider;
import com.google.android.gms.cast.framework.SessionProvider;

import java.util.List;

/**
 * Tells the Cast framework which receiver to launch. Referenced from AndroidManifest.xml via the
 * OPTIONS_PROVIDER_CLASS_NAME meta-data; the framework instantiates it before any JS runs, so the
 * receiver app id lives in a string resource (kept in sync with RECEIVER_APP_ID in env-cast.ts).
 */
public class CastOptionsProvider implements OptionsProvider {
    @Override
    public CastOptions getCastOptions(Context context) {
        return new CastOptions.Builder()
                .setReceiverApplicationId(context.getString(R.string.cast_receiver_app_id))
                .build();
    }

    @Override
    public List<SessionProvider> getAdditionalSessionProviders(Context context) {
        return null;
    }
}
