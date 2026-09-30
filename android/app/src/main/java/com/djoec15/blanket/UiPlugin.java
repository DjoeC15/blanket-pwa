package com.djoec15.blanket;

import android.graphics.Color;
import android.os.Build;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.Window;

import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Ce qu'une WebView ne sait pas faire seule pour passer pour une app native :
 * dessiner sous les barres système (bord à bord), connaître leur hauteur,
 * accorder la couleur de leurs icônes au thème, intercepter le bouton retour,
 * retenir le splash screen jusqu'au premier rendu et produire un retour
 * haptique système.
 */
@CapacitorPlugin(name = "BlanketUi")
public class UiPlugin extends Plugin {

    /** Lu par MainActivity pour garder le splash tant que le JS n'a pas rendu. */
    private static volatile boolean webReady = false;

    private JSObject lastInsets;

    static boolean isWebReady() { return webReady; }

    static void resetWebReady() { webReady = false; }

    @Override
    public void load() {
        AppCompatActivity activity = getActivity();
        Window window = activity.getWindow();

        // Bord à bord : la WebView occupe tout l'écran et le JS réserve
        // lui-même la place des barres (--inset-top / --inset-bottom).
        WindowCompat.setDecorFitsSystemWindows(window, false);
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.setNavigationBarContrastEnforced(false);
            window.setStatusBarContrastEnforced(false);
        }

        View webView = getBridge().getWebView();
        ViewCompat.setOnApplyWindowInsetsListener(webView, (v, insets) -> {
            Insets bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            float density = v.getResources().getDisplayMetrics().density;

            JSObject data = new JSObject();
            data.put("top", bars.top / density);
            data.put("bottom", bars.bottom / density);
            data.put("left", bars.left / density);
            data.put("right", bars.right / density);
            // Le clavier recouvre la barre de navigation : seul l'excédent compte.
            data.put("ime", Math.max(0, ime.bottom - bars.bottom) / density);
            lastInsets = data;
            notifyListeners("insets", data);
            return insets;
        });
        ViewCompat.requestApplyInsets(webView);

        // Retour matériel / geste : le JS ferme le calque ouvert ou demande
        // minimize(). Si la page n'écoute pas encore, on se contente de passer
        // en arrière-plan — jamais finish(), qui arrêterait le son.
        activity.getOnBackPressedDispatcher().addCallback(activity, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (hasListeners("back")) {
                    notifyListeners("back", new JSObject());
                } else {
                    activity.moveTaskToBack(true);
                }
            }
        });
    }

    /** Le premier rendu est prêt : le splash natif peut partir. */
    @PluginMethod
    public void ready(PluginCall call) {
        webReady = true;
        call.resolve();
    }

    @PluginMethod
    public void getInsets(PluginCall call) {
        if (lastInsets != null) {
            call.resolve(lastInsets);
        } else {
            getActivity().runOnUiThread(() -> ViewCompat.requestApplyInsets(getBridge().getWebView()));
            call.resolve(new JSObject());
        }
    }

    /** light = fond clair, donc icônes sombres dans les barres système. */
    @PluginMethod
    public void setSystemBars(PluginCall call) {
        boolean light = Boolean.TRUE.equals(call.getBoolean("light", false));
        String color = call.getString("color");

        getActivity().runOnUiThread(() -> {
            Window window = getActivity().getWindow();
            WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(window, window.getDecorView());
            controller.setAppearanceLightStatusBars(light);
            controller.setAppearanceLightNavigationBars(light);

            // Fond de fenêtre et de WebView à la couleur du thème : évite un
            // éclair d'une autre couleur au redimensionnement (clavier, rotation).
            if (color != null) {
                try {
                    int parsed = Color.parseColor(color);
                    window.getDecorView().setBackgroundColor(parsed);
                    getBridge().getWebView().setBackgroundColor(parsed);
                } catch (IllegalArgumentException ignored) {
                }
            }
        });
        call.resolve();
    }

    /** Retour haptique système (respecte le réglage « vibration au toucher »). */
    @PluginMethod
    public void haptic(PluginCall call) {
        String kind = call.getString("kind", "tick");
        int constant;
        if ("confirm".equals(kind)) {
            constant = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                ? HapticFeedbackConstants.CONFIRM
                : HapticFeedbackConstants.VIRTUAL_KEY;
        } else {
            constant = HapticFeedbackConstants.CLOCK_TICK;
        }
        getActivity().runOnUiThread(() -> getBridge().getWebView().performHapticFeedback(constant));
        call.resolve();
    }

    /** Équivalent du bouton Accueil : l'app et la lecture continuent. */
    @PluginMethod
    public void minimize(PluginCall call) {
        getActivity().runOnUiThread(() -> getActivity().moveTaskToBack(true));
        call.resolve();
    }
}
