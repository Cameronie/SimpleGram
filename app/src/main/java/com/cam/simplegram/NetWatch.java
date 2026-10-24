package com.cam.simplegram;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Handler;
import android.os.SystemClock;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.Locale;

/**
 * B33: what Android lets SimpleGram's network do right now. Data Saver cuts a
 * non-exempt app off mobile data the moment it leaves the foreground, and
 * Android 15+ blocks every network for an app in the background after a few
 * seconds. A page loading at that moment loses its files, and Instagram's logo
 * never goes. The default network callback is the live "blocked for me"
 * signal; the app only reads it (never setNetworkAvailable, which switches the
 * web engine's own detection off). Every ConnectivityManager call can throw
 * (the permission, a dead service): each is caught and counted as an error.
 * Kinds, counts and times only.
 */
final class NetWatch {
    interface Listener {
        /** netOk() changed. */
        void onNetOk(boolean ok);
    }

    private static final int RING = 30, RESUMES = 10;

    // Static so they survive the recreate() after a lost renderer.
    private static final ArrayList<JSONObject> events = new ArrayList<>();
    private static final ArrayList<Integer> resumeToOk = new ArrayList<>();
    private static int errors;
    private static String lastError = "";

    private final ConnectivityManager cm;
    private final Handler ui;
    private final Listener listener;
    private ConnectivityManager.NetworkCallback callback;
    private Network net;
    private boolean known, blocked, metered, validated;
    private String transport = "none";
    private boolean resumed, lastOk;
    private long resumedAt;        // the last onResume, until the network was usable after it
    private int pageToken;

    NetWatch(Context context, Handler ui, Listener listener) {
        this.cm = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        this.ui = ui;
        this.listener = listener;
    }

    /** Registers the default network callback (once per Activity, on the UI handler). */
    void start() {
        if (cm == null || callback != null) return;
        callback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                net = network;
                known = true;
                blocked = false;        // onBlockedStatusChanged follows at once with the real value
                note("avail", "");
            }

            @Override
            public void onLost(Network network) {
                if (net == null || net.equals(network)) net = null;
                known = true;
                note("lost", "");
            }

            @Override
            public void onCapabilitiesChanged(Network network, NetworkCapabilities caps) {
                net = network;
                known = true;
                metered = !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED);
                validated = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
                transport = caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) ? "vpn"
                        : caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ? "wifi"
                        : caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) ? "cell"
                        : caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) ? "ethernet" : "other";
                note("caps", transport + (metered ? " metered" : "") + (validated ? " validated" : ""));
            }

            @Override
            public void onBlockedStatusChanged(Network network, boolean isBlocked) {
                net = network;
                known = true;
                blocked = isBlocked;
                note("blocked", String.valueOf(isBlocked));
            }
        };
        try {
            cm.registerDefaultNetworkCallback(callback, ui);
        } catch (RuntimeException e) {
            callback = null;
            error("register", e);
        }
        lastOk = netOk();
    }

    void stop() {
        if (cm == null || callback == null) return;
        try {
            cm.unregisterNetworkCallback(callback);
        } catch (RuntimeException e) {
            error("unregister", e);
        }
        callback = null;
    }

    /** Usable now: the callback's word once it has spoken, else whether there is an active network at all. */
    boolean netOk() {
        if (known) return net != null && !blocked;
        return !activeNull();
    }

    /** getActiveNetwork() == null (it is while the app is blocked); synchronous. */
    boolean activeNull() {
        if (cm == null) return true;
        try {
            return cm.getActiveNetwork() == null;
        } catch (RuntimeException e) {
            error("active", e);
            return true;
        }
    }

    /** Data Saver's word for this app: disabled, enabled (cut off in the background), whitelisted, or error. */
    String restrictStatus() {
        if (cm == null) return "error";
        try {
            switch (cm.getRestrictBackgroundStatus()) {
                case ConnectivityManager.RESTRICT_BACKGROUND_STATUS_DISABLED:
                    return "disabled";
                case ConnectivityManager.RESTRICT_BACKGROUND_STATUS_WHITELISTED:
                    return "whitelisted";
                case ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED:
                    return "enabled";
                default:
                    return "unknown";
            }
        } catch (RuntimeException e) {
            error("restrict", e);
            return "error";
        }
    }

    boolean isKnown() {
        return known;
    }

    boolean isBlocked() {
        return known && (blocked || net == null);
    }

    boolean isMetered() {
        return metered;
    }

    /** The app came on screen (or left it): the time to a usable network is kept for the last few resumes. */
    void setResumed(boolean on) {
        resumed = on;
        if (!on) {
            resumedAt = 0;
            return;
        }
        resumedAt = SystemClock.uptimeMillis();
        if (netOk()) markResumeOk();
    }

    /** The native token of the page being loaded, for the event ring. */
    void setPageToken(int token) {
        pageToken = token;
    }

    private void markResumeOk() {
        if (resumedAt == 0) return;
        resumeToOk.add((int) (SystemClock.uptimeMillis() - resumedAt));
        while (resumeToOk.size() > RESUMES) resumeToOk.remove(0);
        resumedAt = 0;
    }

    private void note(String kind, String value) {
        try {
            JSONObject e = new JSONObject().put("at", clock()).put("ev", kind).put("resumed", resumed).put("token", pageToken);
            if (!value.isEmpty()) e.put("v", value);
            events.add(e);
            while (events.size() > RING) events.remove(0);
        } catch (JSONException ignored) {
            // Not reachable with constant keys.
        }
        boolean ok = netOk();
        if (ok && resumed) markResumeOk();
        if (ok != lastOk) {
            lastOk = ok;
            listener.onNetOk(ok);
        }
    }

    private static void error(String where, Exception e) {
        errors++;
        lastError = where + ": " + e.getClass().getSimpleName();
    }

    /** The `net` block's live part (kinds only). */
    JSONObject state() {
        JSONObject s = new JSONObject();
        try {
            s.put("known", known).put("net", net != null).put("blocked", blocked).put("metered", metered)
                    .put("validated", validated).put("transport", transport).put("ok", netOk())
                    .put("activeNull", activeNull()).put("restrict", restrictStatus())
                    .put("errors", errors).put("lastError", lastError)
                    .put("events", new JSONArray(events)).put("resumeToOkMs", new JSONArray(resumeToOk));
        } catch (JSONException ignored) {
            // Partial state is still useful.
        }
        return s;
    }

    static String clock() {
        return new SimpleDateFormat("HH:mm:ss", Locale.US).format(new Date());
    }
}
