package com.rafaelmardojai.blanket;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Doit précéder super.onCreate : c'est là que Capacitor instancie le pont.
        registerPlugin(PlaybackPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
