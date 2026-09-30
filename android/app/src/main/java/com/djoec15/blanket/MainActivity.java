package com.djoec15.blanket;

import android.os.Bundle;
import android.os.SystemClock;

import androidx.core.splashscreen.SplashScreen;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /** Au-delà, on lève le splash même si le JS ne s'est pas signalé. */
    private static final long SPLASH_TIMEOUT_MS = 2500;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Avant super.onCreate : bascule du thème de lancement vers le thème
        // de l'app une fois le splash levé.
        SplashScreen splash = SplashScreen.installSplashScreen(this);

        // Doit précéder super.onCreate : c'est là que Capacitor instancie le pont.
        registerPlugin(PlaybackPlugin.class);
        registerPlugin(UiPlugin.class);
        super.onCreate(savedInstanceState);

        // Garde le splash jusqu'au premier rendu de la page : sans ça on voit
        // la WebView vide, puis l'écran de chargement web, puis l'app.
        UiPlugin.resetWebReady();
        long start = SystemClock.uptimeMillis();
        splash.setKeepOnScreenCondition(() ->
            !UiPlugin.isWebReady() && SystemClock.uptimeMillis() - start < SPLASH_TIMEOUT_MS);
    }
}
