package com.djoec15.blanket;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.IBinder;

/**
 * Service de premier plan qui maintient le processus vivant pendant la lecture.
 *
 * Il ne produit aucun son : l'audio vient de la WebView. Capacitor la laisse
 * tourner en arrière-plan (`shouldKeepRunning()` vaut true par défaut, donc
 * MockCordovaWebViewImpl.setPaused n'est jamais appelé). Ce qui manquait, c'est
 * la garantie qu'Android ne tue pas le processus et ne le restreigne pas en
 * veille prolongée — ce qu'apporte un foreground service `mediaPlayback`.
 *
 * Il porte aussi la MediaSession, ce qui donne la notification avec play/pause
 * et les contrôles depuis l'écran verrouillé ou l'enceinte Bluetooth. Une
 * WebView ne remonte pas l'API MediaSession JS au système : côté natif est le
 * seul endroit d'où cette notification peut venir.
 */
public class PlaybackService extends Service {

    public static final String ACTION_START = "com.djoec15.blanket.START";
    public static final String ACTION_UPDATE = "com.djoec15.blanket.UPDATE";
    public static final String ACTION_PLAY = "com.djoec15.blanket.PLAY";
    public static final String ACTION_PAUSE = "com.djoec15.blanket.PAUSE";

    public static final String EXTRA_PLAYING = "playing";
    public static final String EXTRA_TITLE = "title";

    private static final String CHANNEL_ID = "blanket_playback";
    private static final int NOTIFICATION_ID = 1;

    /** Remontée des commandes de transport (notification, casque, Bluetooth) vers le JS. */
    public interface TransportListener {
        void onTransport(boolean play);
    }

    private static TransportListener transportListener;

    public static void setTransportListener(TransportListener listener) {
        transportListener = listener;
    }

    private MediaSession session;
    private boolean playing = true;
    private String title = "Ambient mix";

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();

        session = new MediaSession(this, "Blanket");
        session.setCallback(new MediaSession.Callback() {
            @Override
            public void onPlay() {
                dispatch(true);
            }

            @Override
            public void onPause() {
                dispatch(false);
            }

            @Override
            public void onStop() {
                dispatch(false);
            }
        });
        session.setActive(true);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;

        if (ACTION_PLAY.equals(action)) {
            dispatch(true);
        } else if (ACTION_PAUSE.equals(action)) {
            dispatch(false);
        } else if (intent != null) {
            playing = intent.getBooleanExtra(EXTRA_PLAYING, playing);
            String extraTitle = intent.getStringExtra(EXTRA_TITLE);
            if (extraTitle != null && !extraTitle.isEmpty()) {
                title = extraTitle;
            }
        }

        session.setPlaybackState(
            new PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_STOP)
                .setState(
                    playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                    PlaybackState.PLAYBACK_POSITION_UNKNOWN,
                    1f
                )
                .build()
        );

        startInForeground();

        // Ne pas relancer le service tout seul si le système le tue : l'état de
        // lecture appartient à la WebView, un redémarrage à vide n'aurait pas de sens.
        return START_NOT_STICKY;
    }

    /** Bascule l'état localement puis prévient le JS, qui reste la source de vérité. */
    private void dispatch(boolean play) {
        playing = play;
        if (transportListener != null) {
            transportListener.onTransport(play);
        }
    }

    private void startInForeground() {
        Notification notification = buildNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(
            this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Notification.Action action = playing
            ? new Notification.Action.Builder(
                android.R.drawable.ic_media_pause, "Pause", transportIntent(ACTION_PAUSE)
            ).build()
            : new Notification.Action.Builder(
                android.R.drawable.ic_media_play, "Play", transportIntent(ACTION_PLAY)
            ).build();

        Notification.Builder builder = new Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(playing ? "Playing" : "Paused")
            .setContentIntent(contentIntent)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setShowWhen(false)
            .addAction(action)
            .setStyle(
                new Notification.MediaStyle()
                    .setMediaSession(session.getSessionToken())
                    .setShowActionsInCompactView(0)
            )
            // Balayable une fois en pause, persistante pendant la lecture.
            .setOngoing(playing);

        return builder.build();
    }

    private PendingIntent transportIntent(String action) {
        Intent intent = new Intent(this, PlaybackService.class);
        intent.setAction(action);
        return PendingIntent.getService(
            this, action.hashCode(), intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID, "Playback", NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Ongoing ambient sound playback");
        channel.setShowBadge(false);
        channel.setSound(null, null);
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    @Override
    public void onDestroy() {
        if (session != null) {
            session.setActive(false);
            session.release();
            session = null;
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
