package com.rafaelmardojai.blanket;

import android.Manifest;
import android.content.Intent;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Pont entre la couche audio JS et {@link PlaybackService}.
 *
 * Le JS reste la source de vérité sur l'état de lecture ; le natif ne fait
 * qu'afficher la notification, tenir la MediaSession et empêcher le système de
 * tuer le processus.
 */
@CapacitorPlugin(
    name = "BlanketPlayback",
    permissions = {
        @Permission(alias = PlaybackPlugin.NOTIFICATIONS, strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class PlaybackPlugin extends Plugin {

    static final String NOTIFICATIONS = "notifications";

    @Override
    public void load() {
        PlaybackService.setTransportListener(play -> {
            JSObject data = new JSObject();
            data.put("play", play);
            notifyListeners("transport", data);
        });
    }

    /** Démarre le service (ou met à jour son état s'il tourne déjà). */
    @PluginMethod
    public void start(PluginCall call) {
        Intent intent = new Intent(getContext(), PlaybackService.class);
        intent.setAction(PlaybackService.ACTION_START);
        intent.putExtra(PlaybackService.EXTRA_PLAYING, Boolean.TRUE.equals(call.getBoolean("playing", true)));
        intent.putExtra(PlaybackService.EXTRA_TITLE, call.getString("title", ""));

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
        }
        call.resolve();
    }

    /** Met à jour titre et état lecture/pause de la notification. */
    @PluginMethod
    public void update(PluginCall call) {
        start(call);
    }

    /** Retire la notification et libère le service. */
    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), PlaybackService.class));
        call.resolve();
    }

    /**
     * Sans POST_NOTIFICATIONS le service tourne quand même — seule la
     * notification est masquée. On demande donc la permission sans en faire
     * une condition de la lecture.
     */
    @PluginMethod
    public void ensureNotificationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && getPermissionState(NOTIFICATIONS) != PermissionState.GRANTED) {
            requestPermissionForAlias(NOTIFICATIONS, call, "permissionCallback");
        } else {
            call.resolve();
        }
    }

    @PermissionCallback
    private void permissionCallback(PluginCall call) {
        call.resolve();
    }
}
