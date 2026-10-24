package com.cam.simplegram;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.ConnectivityManager;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.TouchDelegate;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.webkit.ScriptHandler;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Date;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class MainActivity extends Activity implements ZoomFrame.Listener, CommentsPanel.Host {
    private static final Set<String> ORIGINS = new HashSet<>(Arrays.asList(
            "https://www.instagram.com", "https://instagram.com", "https://m.instagram.com"));
    private static final String FOLLOWING = "https://www.instagram.com/?variant=following";
    private static final String FAVORITES = "https://www.instagram.com/?variant=favorites";
    private static final Pattern VIEWER = Pattern.compile("(?:^|;\\s*)ds_user_id=(\\d+)");
    private static final int FILE_REQUEST = 7;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private SharedPreferences prefs;
    private boolean dark;
    private float density;
    private String script;

    private FrameLayout root;
    private ZoomFrame zoom;
    private WebView web;
    private CommentsPanel comments;
    private TextView menuButton;
    private TouchDelegate tabDelegate;      // B27: the tab's extra room (its dead zone), asked before the page is
    private TextView zoomChip;
    private View feedBar;
    private TextView feedTitle;
    private TextView feedSub;
    private GradientDrawable feedBg;
    private boolean feedWanted;
    private boolean searchOpen;
    private boolean restarting;
    private View screenshotShield;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private int fullScreens;
    private int fullScreenNested;
    private String fullScreenLast = "";
    // A Reel the page plays over a Story (R9): Back closes it, not the Story.
    private boolean pageVideo;
    // A post's video in full screen (R8) hid the menu tab: the whole screen, no icons over it.
    private boolean fullHidTab;
    // When the page last said it is about to ask for full screen for a video of
    // its own (R8/R10/menu: fullVideoStart); 0 when not. Instagram's own full
    // screens (a Story or highlight opened from Home or a profile) never set it.
    private long ownFullAt;
    private static final long OWN_FULL_MS = 2500;
    // The comments panel was up when a full screen started: it goes for the full
    // screen (it would be drawn over the video and take its touches) and comes back after.
    private boolean fullHidComments;
    // R12: the comments panel is up for the Reel the page plays over a Story (R9),
    // in the Story's full screen or not. Raised above the full-screen view (or the
    // unsplit page) by its Z only: no view is moved in the tree, so no touch that
    // is down loses its end (B25).
    private boolean commentsOverFull;
    private int commentsOverOpens;
    // R10 from the menu: the taps the app made on the page's video for it, and the ones it held back.
    private int videoTaps, videoTapsHeld;
    private Downloads downloads;
    // B33: what Android lets the network do (Data Saver, the background block).
    private NetWatch netWatch;
    private boolean restrictReceiverOn;
    private final BroadcastReceiver restrictReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            readRestrictStatus("changed");
        }
    };

    private String route = "other";
    private String pageUrl = "";
    private TextView skipChip;
    private String skipKind = "";
    private int skipCount;
    private String menuLink;
    private boolean screenshotMode;
    private boolean zoomedStory;
    private boolean menuOpen;
    private ValueCallback<Uri[]> fileCallback;
    private RectF splitCss;
    private float splitDpr = 1f;
    private int fullHeight;
    private int fullWidth;
    private String viewerId;
    private final List<Script> scripts = new ArrayList<>();
    // B20: the comments panel's comment box, as its page last measured it (sizes and counts only).
    private JSONObject commentsLayout;

    // B25: the touch sequence open at Activity level (DOWN until UP/CANCEL). A
    // full-screen switch moves the page's input from one view to another; a
    // touch open across it must be cancelled where the input now lives and the
    // rest of it swallowed, or the web engine believes a finger is still down
    // and later stops vertical scrolling for good.
    private boolean touchOpen;
    private boolean touchSwallow;
    private boolean touchAccepted;
    private boolean inTouchDispatch;
    private MotionEvent touchLast;
    private int touchDownOn;               // RX_WEB or RX_CUSTOM
    private long touchDownAt;
    private int touchSeq;
    private static final int RX_WEB = 0, RX_CUSTOM = 1;
    private final int[] touchStarted = new int[2], touchEnded = new int[2], touchRefused = new int[2];
    private int cancelsShow, cancelsHide, cancelsHold, swallowedTouches, showDuringTouch, hideDuringTouch;
    // The last few full-screen switches (shapes only), newest last.
    private final ArrayList<JSONObject> fsLog = new ArrayList<>();
    // Who is ending full screen: the page (Chromium already switched), Back, or the
    // page asking the app to do it the Back way (R8's swipe, later R10).
    private String hideInitiator = "page";
    private boolean resumed;

    // B25 self-repair: drags that should scroll don't (reported by the page).
    private TextView stuckChip;
    private boolean stuckChipWanted;
    private boolean softResetDone;
    private long softResetAt, rebuiltAt;
    private int stuckPosts, softResets, strikesAfterSoft, chipShown, rebuilds, strikesAfterRebuild, manualFix;
    private final JSONObject stuckIgnored = new JSONObject();
    private boolean rebuilding;
    private Runnable pendingRebuild;     // the rebuild's delayed swap, dropped in onDestroy
    // The page's search screen, read before a rebuild and handed to the new page once.
    private JSONObject searchHandBack;

    // B33: Instagram didn't start (the logo screen stays). The page says when it
    // booted; the app watches each page start on its own clock and recovers.
    // Package-private timings: ShellTest shortens them.
    static long bootWatchMs = 30_000, bootProbeMs = 2_000, bootReloadFollowMs = 3_000, bootSettleMs = 1_000;
    private static final int RELOADS_PER_10_MIN = 2;
    private int bootSeq;                  // the native token of the newest main-frame page start (kept in prefs: unique across restarts)
    private BootWatch watch;              // the page start being watched, or null
    private BootChain chain;              // the ladder's place for the current page; survives its reloads and rebuilds
    private String startHow = "";         // how the next main-frame page start began, set by whoever starts it
    private Runnable watchTick, reloadFollow, probeTimeout;
    private boolean pendingNetReload;     // the automatic reload waits for the network
    private Runnable resumeReload;        // the automatic reload that came due while the app was away
    private String bootChipKind = "";     // "" (off), "offline", "stuck", "still"
    private int bootChipsShown, bootLate;
    private android.widget.LinearLayout bootChip;
    private TextView bootChipText, bootChipRetry, bootChipPlain;
    private boolean tipDue;               // a stuck page was tied to a block: the Data Saver tip may show
    private boolean plainBootOn;          // the page script's data hooks are off for the page being loaded

    /** A WebView's injected page script, re-registered when the signed-in account changes. */
    private static final class Script {
        final WebView view;
        final String role;
        ScriptHandler handler;
        String fallback;

        Script(WebView view, String role) {
            this.view = view;
            this.role = role;
        }
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("simplegram", MODE_PRIVATE);
        density = getResources().getDisplayMetrics().density;
        dark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
        script = readAsset("simplegram.js");
        viewerId = readViewerId();
        downloads = new Downloads(this, this::toast);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        netWatch = new NetWatch(this, ui, this::onNetOk);
        netWatch.start();
        registerRestrictReceiver();
        readRestrictStatus("create");
        lifecycle(state == null ? "create" : "restore");

        root = new FrameLayout(this) {
            // B27: a touch that lands just beside the ⋮ tab (its dead zone) is the
            // tab's. The page view under it would take the touch first, so the
            // tab's delegate is asked before the children are.
            @Override
            public boolean dispatchTouchEvent(MotionEvent ev) {
                if (tabDelegate != null && menuButton != null && menuButton.getVisibility() == View.VISIBLE
                        && tabDelegate.onTouchEvent(ev)) {
                    return true;
                }
                return super.dispatchTouchEvent(ev);
            }
        };
        root.setBackgroundColor(dark ? Color.BLACK : Color.WHITE);

        web = newWebView("main");
        zoom = new ZoomFrame(this, this);
        zoom.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(zoom, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        comments = new CommentsPanel(this, newWebView("comments"), dark, this);
        root.addView(comments, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(400), Gravity.BOTTOM));

        zoomChip = makeZoomChip();
        FrameLayout.LayoutParams chipLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP | Gravity.CENTER_HORIZONTAL);
        chipLp.topMargin = dp(10);
        root.addView(zoomChip, chipLp);

        feedBar = makeFeedBar();
        FrameLayout.LayoutParams barLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        barLp.bottomMargin = dp(72);
        root.addView(feedBar, barLp);

        skipChip = makeSkipChip();
        FrameLayout.LayoutParams skipLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        skipLp.bottomMargin = dp(72);
        root.addView(skipChip, skipLp);

        stuckChip = makeStuckChip();
        FrameLayout.LayoutParams stuckLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP | Gravity.CENTER_HORIZONTAL);
        stuckLp.topMargin = dp(56);
        root.addView(stuckChip, stuckLp);

        // B33's chip has the same slot: one chip at a time.
        bootChip = makeBootChip();
        FrameLayout.LayoutParams bootLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP | Gravity.CENTER_HORIZONTAL);
        bootLp.topMargin = dp(56);
        bootLp.leftMargin = bootLp.rightMargin = dp(16);
        root.addView(bootChip, bootLp);

        menuButton = makeMenuButton();
        root.addView(menuButton, new FrameLayout.LayoutParams(dp(TAB_W), dp(TAB_H)));

        setContentView(root);
        root.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> onRootLayout(r - l, b - t));
        guardEdgeToEdge();

        // A restored page (after a renderer restart or process death) keeps its
        // place; the launch intent was already handled the first time.
        startHow = "restore";
        if (state == null || web.restoreState(state) == null) handleIntent(getIntent(), true);
    }

    /* ------------------------------------------------------------------ *
     * WebViews
     * ------------------------------------------------------------------ */

    @SuppressLint("SetJavaScriptEnabled")
    private WebView newWebView(String role) {
        WebView w = new WebView(this);
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setUseWideViewPort(true);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setGeolocationEnabled(false);
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(w, true);
        w.setBackgroundColor(dark ? Color.BLACK : Color.WHITE);
        w.setWebViewClient(new Client(role));
        w.setWebChromeClient(new Chrome());
        install(w, role);
        return w;
    }

    private String config(String role) {
        try {
            JSONObject c = new JSONObject();
            c.put("role", role);
            c.put("version", BuildConfig.VERSION_NAME);
            c.put("searchPages", 3);
            c.put("viewerId", viewerId == null ? JSONObject.NULL : viewerId);
            c.put("continueHome", continueHome());
            // B33's last step: one load with the page script's data hooks off (the bridge stays).
            if ("main".equals(role) && plainBootOn) c.put("plainBoot", true);
            return c.toString();
        } catch (JSONException e) {
            return "{}";
        }
    }

    /** R7: Home goes on into posts from people you follow past "caught up" (⋮ → More…). */
    private boolean continueHome() {
        return prefs.getBoolean("continueHome", true);
    }

    /**
     * The menu switch: registered for the next page load, and told to the page
     * already loaded (Instagram's Home tab refreshes inside it). Off ends a run
     * at once with the Following card; on starts at Home's next "caught up".
     */
    private void toggleContinueHome() {
        boolean on = !continueHome();
        prefs.edit().putBoolean("continueHome", on).apply();
        for (Script s : scripts) registerScript(s);
        try {
            js(new JSONObject().put("type", "contSet").put("on", on));
        } catch (JSONException ignored) {
            // Not reachable with constant keys.
        }
        toast(on ? "Continue Home into Following: on. Starts the next time Home reaches \u201Ccaught up\u201D."
                : "Continue Home into Following: off. Home now stops at \u201Ccaught up\u201D.");
    }

    private void install(WebView w, String role) {
        Script s = new Script(w, role);
        scripts.add(s);
        registerScript(s);
        // Only the origin-restricted, main-frame-only listener. A WebView too old
        // for it (before 2020) gets no bridge at all; the page copes without one.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(w, "SGNative", ORIGINS,
                    (view, message, origin, isMainFrame, reply) -> {
                        // A message still on its way from a main WebView that was rebuilt (B25) is dropped.
                        if ("main".equals(role) && view != web) return;
                        if (isMainFrame && message.getData() != null) onMessage(role, message.getData());
                    });
        }
    }

    private void registerScript(Script s) {
        String code = "window.__sgCfg=" + config(s.role) + ";\n" + script;
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            if (s.handler != null) s.handler.remove();
            s.handler = WebViewCompat.addDocumentStartJavaScript(s.view, code, ORIGINS);
        } else {
            s.fallback = code;
        }
    }

    /** Older WebViews without document-start scripts: inject as early as possible. */
    private void injectFallback(WebView w) {
        for (Script s : scripts) {
            if (s.view == w && s.fallback != null) {
                String url = w.getUrl();
                if (url != null && Links.isInstagram(Uri.parse(url))) w.evaluateJavascript(s.fallback, null);
            }
        }
    }

    private String readViewerId() {
        String c = CookieManager.getInstance().getCookie("https://www.instagram.com");
        if (c == null) return null;
        Matcher m = VIEWER.matcher(c);
        return m.find() ? m.group(1) : null;
    }

    private void refreshViewer() {
        String id = readViewerId();
        if (id == null || id.equals(viewerId)) return;
        viewerId = id;
        for (Script s : scripts) registerScript(s);
        try {
            js(new JSONObject().put("type", "viewer").put("id", id));
        } catch (JSONException ignored) {
            // Not reachable with constant keys.
        }
    }

    private void js(JSONObject cmd) {
        web.evaluateJavascript("window.__sg&&window.__sg.onNative(" + cmd + ")", null);
    }

    private void js(String type) {
        try {
            js(new JSONObject().put("type", type));
        } catch (JSONException ignored) {
            // Not reachable with constant keys.
        }
    }

    private final class Client extends WebViewClient {
        private final String role;

        Client(String role) {
            this.role = role;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            if (!request.isForMainFrame()) return false;
            return routeUrl(view, request.getUrl());
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            injectFallback(view);
            if ("main".equals(role) && view == web) onMainPageStarted(view, url);
            if ("main".equals(role)) {
                startsAll++;
                // Only a Back that starts a new page counts as one: most stay in the page.
                if (goBackAt != 0 && SystemClock.uptimeMillis() - goBackAt < 1500) startsGoBack++;
                goBackAt = 0;
            }
            // A page outside Instagram (Meta login, Accounts Center) sends no
            // 'ready': forget the last Instagram page's state so Back goes back.
            if ("main".equals(role)) setPageVideo(false);   // the old page's Reel layer is gone
            if ("main".equals(role)) {
                // The old page's skip note is gone with it; the new page sends its
                // own once its script runs (an error page never does).
                skipKind = "";
                skipCount = 0;
            }
            if ("main".equals(role) && url != null && !Links.isInstagram(Uri.parse(url))) {
                route = "other";
                searchOpen = false;
                feedWanted = false;
            }
            if ("main".equals(role)) updateFeedBar();
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            injectFallback(view);
            CookieManager.getInstance().flush();
            if ("main".equals(role)) refreshViewer();
            else comments.pageReady();
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            super.onReceivedError(view, request, error);
            if ("main".equals(role)) netError(request.getUrl(), request.isForMainFrame(), "net", error.getErrorCode(), String.valueOf(error.getDescription()));
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            super.onReceivedHttpError(view, request, response);
            if ("main".equals(role)) netError(request.getUrl(), request.isForMainFrame(), "http", response.getStatusCode(), "");
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            // The default stays: a page with a bad certificate (a captive portal, a
            // VPN, a wrong clock) is never shown. Until now it was cancelled in silence.
            handler.cancel();
            Uri u = error.getUrl() == null ? null : Uri.parse(error.getUrl());
            if ("main".equals(role)) netError(u, u != null && u.toString().equals(view.getUrl()), "ssl", error.getPrimaryError(), "");
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // Both WebViews share the renderer and each reports it: act once.
            if (restarting) return true;
            restarting = true;
            // The page's renderer stopped; start over with fresh views rather than crash.
            // Remembered for Filter status (the page's own counts are lost with it).
            prefs.edit().putInt("rendererGone", prefs.getInt("rendererGone", 0) + 1)
                    .putString("rendererGoneLast", (detail.didCrash() ? "crashed" : "stopped by Android")
                            + ", priority " + detail.rendererPriorityAtExit() + ", " + clock())
                    .apply();
            // B33: a new page started in the background would load with the network
            // blocked (Data Saver, Android 15+). The place is saved now (the history
            // lives outside the renderer) and the restart waits for the next onResume.
            Bundle keep = new Bundle();
            pendingState = web.saveState(keep) != null ? keep : null;
            if (resumed) ui.post(MainActivity.this::recreate);
            else pendingRecreate = true;
            lifecycle(resumed ? "recreate" : "recreate deferred");
            return true;
        }
    }

    private boolean pendingRecreate;
    private Bundle pendingState;          // the page's history, saved before the dead renderer's WebView goes
    private Runnable deferredSwap;        // a rebuild's swap that waits for the next onResume

    /**
     * B33: a failed load of the page or one of its files (shapes only: host kind,
     * file kind, the error's name and code, whether the app was on screen and
     * whether Android had it blocked). A start-up file that fails leaves
     * Instagram's logo up for good; one that stalls leaves no error at all.
     */
    private void netError(Uri url, boolean mainFrame, String kind, int code, String name) {
        try {
            JSONObject e = new JSONObject()
                    .put("at", NetWatch.clock())
                    .put("kind", kind)
                    .put("code", code)
                    .put("main", mainFrame)
                    .put("host", hostKind(url))
                    .put("res", resKind(url))
                    .put("resumed", resumed)
                    .put("blocked", netWatch.isBlocked());
            if (!name.isEmpty()) e.put("name", name.length() > 60 ? name.substring(0, 60) : name);
            BootWatch w = watch;
            if (w != null) e.put("t", SystemClock.uptimeMillis() - w.startedAt).put("seq", w.seq);
            ring("netErrors", 20, e);
            // The document itself or one of Instagram's start-up scripts: a mark on the page.
            if (w != null && !w.booted && (mainFrame || ("static".equals(e.optString("host")) && "js".equals(e.optString("res"))))) {
                markHurt("netError");
            }
        } catch (JSONException ignored) {
            // Not reachable with constant keys.
        }
    }

    /** main / api / static / media / other: an address's host, by what it serves. */
    static String hostKind(Uri u) {
        if (u == null) return "other";
        String h = Links.host(u);
        String p = u.getPath() == null ? "" : u.getPath();
        if (h.equals("www.instagram.com") || h.equals("instagram.com") || h.equals("m.instagram.com")) {
            return p.startsWith("/api/") || p.startsWith("/graphql") || p.startsWith("/ajax/") ? "api" : "main";
        }
        if (h.equals("i.instagram.com") || h.equals("graph.instagram.com")) return "api";
        if (h.startsWith("static.")) return "static";    // Instagram's script and style files
        if (Links.isMediaFile(u)) return "media";
        return "other";
    }

    /** js / css / json / html / image / video / font / none / other: a file by its extension. */
    static String resKind(Uri u) {
        String p = u == null || u.getLastPathSegment() == null ? "" : u.getLastPathSegment();
        int dot = p.lastIndexOf('.');
        if (dot < 0) return "none";
        switch (p.substring(dot + 1).toLowerCase(Locale.ROOT)) {
            case "js":
            case "mjs":
                return "js";
            case "css":
                return "css";
            case "json":
                return "json";
            case "html":
            case "htm":
                return "html";
            case "jpg":
            case "jpeg":
            case "png":
            case "webp":
            case "gif":
            case "heic":
            case "avif":
            case "svg":
                return "image";
            case "mp4":
            case "m4v":
            case "m4s":
            case "webm":
            case "m3u8":
            case "mpd":
                return "video";
            case "woff":
            case "woff2":
            case "ttf":
                return "font";
            default:
                return "other";
        }
    }

    /** Instagram stays in the app; everything else opens in the browser. */
    private boolean routeUrl(WebView view, Uri uri) {
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if (scheme.equals("intent")) {
            try {
                Intent intent = Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME);
                String target = Links.normalize(intent.getStringExtra("browser_fallback_url"));
                if (target != null) load(view, target);
            } catch (Exception ignored) {
                // "Open in app" prompts have nowhere to go.
            }
            return true;
        }
        if (scheme.equals("http") || scheme.equals("https")) {
            Uri real = Links.unwrapOutbound(uri);
            if (real != uri) {
                openExternal(real);
                return true;
            }
            if (Links.isReelsTab(uri)) {
                load(view, Links.HOME);
                return true;
            }
            if (scheme.equals("http") && Links.normalize(uri.toString()) != null) {
                load(view, Links.normalize(uri.toString()));
                return true;
            }
            if (Links.staysInApp(uri)) return false;
            openExternal(uri);
            return true;
        }
        if (scheme.equals("mailto") || scheme.equals("tel") || scheme.equals("sms") || scheme.equals("geo")) {
            openExternal(uri);
        }
        return true;
    }

    // Page loads since the process started, by who started them (Filter status:
    // a page start the app didn't ask for came from the page itself).
    // backPresses: every Back sent to the page, most of which stay in it.
    private static int startsAll, startsLoadUrl, startsGoBack, startsReload, backPresses;
    private static long goBackAt;

    private void load(WebView view, String url) {
        if (view == web) { startsLoadUrl++; goBackAt = 0; }
        view.loadUrl(url);
    }

    private void openExternal(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (ActivityNotFoundException e) {
            toast("No app can open this link");
        }
    }

    private final class Chrome extends WebChromeClient {
        private Bitmap noPoster;

        /**
         * A video with no poster, before its first frame: nothing (its black box
         * shows), not WebView's gray play icon. R10 lifts a feed video without
         * Instagram's cover picture, and R9's own Reel video has no poster.
         */
        @Override
        public Bitmap getDefaultVideoPoster() {
            if (noPoster == null) noPoster = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888);
            return noPoster;
        }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            Intent intent = params.createIntent();
            if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            }
            try {
                startActivityForResult(intent, FILE_REQUEST);
                return true;
            } catch (ActivityNotFoundException e) {
                fileCallback = null;
                return false;
            }
        }

        @Override
        public void onPermissionRequest(PermissionRequest request) {
            request.deny();
        }

        @Override
        public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
            callback.invoke(origin, false, false);
        }

        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            if (customView != null) {
                // A nested request (a video asking for full screen inside a
                // full-screen Story). Chromium normally settles it inside the
                // page without asking again; if it does ask, show the new view
                // in place of the old one and cancel nothing: a cancel ends full
                // screen altogether, and Instagram then closes the Story.
                fullScreenNested++;
                customViewCallback = callback;
                if (view == customView) return;
                View oldInput = liveInput(customView);
                root.removeView(customView);
                customView = view;
                view.setBackgroundColor(Color.BLACK);
                root.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                logFullScreen("nested", "page");
                splitTouch(true, oldInput, liveInput(view));
                return;
            }
            customView = view;
            customViewCallback = callback;
            fullScreens++;
            fullScreenLast = route + " at " + clock();
            view.setBackgroundColor(Color.BLACK);
            root.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            // B25: Chromium has already moved the page's input to this view. A
            // finger down on the page now is cancelled here, where the input lives.
            logFullScreen("show", "page");
            splitTouch(true, liveInput(view));
            // R8/R10: a video takes the whole screen (from a post, a Reel, the feed or
            // a profile). The tab's elevation would draw it (and give it taps) over
            // the video, so it goes. Not in a Story, where the tab is how Stories are
            // saved (R9's layer hides it itself), nor in DMs (Instagram's own). On
            // Home or a profile only when the page said the full screen is its own:
            // Instagram asks for a Story's full screen there before the route says "story".
            boolean own = ownFullAt != 0 && SystemClock.uptimeMillis() - ownFullAt < OWN_FULL_MS;
            ownFullAt = 0;
            if (("post".equals(route) || "reel".equals(route) || own)
                    && !"story".equals(route) && !"direct".equals(route)) {
                fullHidTab = true;
                setTabShown(false);
                zoomChip.setVisibility(View.GONE);
            }
            // Comments over R9's Reel are raised above any full-screen view: they stay.
            if (comments.isOpen() && comments.getVisibility() == View.VISIBLE && !commentsOverFull) {
                fullHidComments = true;
                comments.setVisibility(View.GONE);
            }
            setSystemBarsHidden(true);
            updateFeedBar();     // the skip note and the end card stay off a full screen
        }

        /**
         * Ends full screen. From Chromium (the page left full screen) the input
         * has already moved back to the WebView; from Back or the page's own
         * request (fullVideoExitRequest) the view goes first and Chromium is told
         * after, so the input is still live in the view while it goes. Either way
         * a finger that is down gets its cancel wherever the input is (B25).
         */
        @Override
        public void onHideCustomView() {
            if (customView == null) return;
            String initiator = hideInitiator;
            hideInitiator = "page";
            logFullScreen("hide", initiator);
            View input = liveInput(customView);
            boolean split = touchOpen && !touchSwallow;
            if (split) cancelTo(input);                  // still live on the Back way
            if (zoom.isHolding()) cancelHoldTo(input);
            root.removeView(customView);
            customView = null;
            if (split) cancelTo(web);                    // live again if Chromium switched first
            if (!screenshotMode) setSystemBarsHidden(false);
            if (customViewCallback != null) customViewCallback.onCustomViewHidden();
            customViewCallback = null;
            if (zoom.isHolding()) cancelHoldTo(web);
            // R12: comments that were up over the Story's full screen go with it.
            if (commentsOverFull) closeComments();
            if (split) {
                cancelTo(web);                           // and after Chromium was told
                startSwallow(false);
                final int seq = touchSeq;
                // Chromium may switch back a moment later: once more if that same
                // touch is still being swallowed (never into a new touch).
                ui.post(() -> {
                    if (touchOpen && touchSwallow && touchSeq == seq) cancelTo(web);
                });
            }
            if (fullHidComments) {
                fullHidComments = false;
                if (comments.isOpen()) comments.setVisibility(View.VISIBLE);
            }
            if (fullHidTab) {
                fullHidTab = false;
                if (!screenshotMode && !pageVideo) setTabShown(true);
                onZoomChanged(zoom.scale());     // also re-reads the skip note and the end card
            } else {
                // A Story's route message can come while its full screen is still up:
                // what it hid (the skip note, the end card) comes back now.
                updateFeedBar();
            }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != FILE_REQUEST) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        if (fileCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null && clip.getItemCount() > 0) {
                result = new Uri[clip.getItemCount()];
                for (int i = 0; i < result.length; i++) result[i] = clip.getItemAt(i).getUri();
            } else if (data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
        }
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    /** Fallback bridge for WebViews without origin-restricted message listeners. */

    /* ------------------------------------------------------------------ *
     * Messages from the page script
     * ------------------------------------------------------------------ */

    private void onMessage(String role, String data) {
        JSONObject m;
        try {
            m = new JSONObject(data);
        } catch (JSONException e) {
            return;
        }
        String action = m.optString("action");
        boolean main = "main".equals(role);
        switch (action) {
            case "ready":
            case "route":
                if (main) {
                    route = m.optString("route", "other");
                    pageUrl = m.optString("url", "");
                    if (fullHidTab && customView != null && ("story".equals(route) || "direct".equals(route))) {
                        // A full screen that started before its route said Story (or DMs):
                        // the tab is how Stories are saved, so it comes back.
                        fullHidTab = false;
                        if (!screenshotMode && !pageVideo) setTabShown(true);
                        onZoomChanged(zoom.scale());
                    }
                    if ("ready".equals(action)) {
                        // A new page: nothing from the old one carries over.
                        searchOpen = false;
                        feedWanted = false;
                        skipKind = "";
                        setPageVideo(false);
                        setAwake(false);     // the old page's playing video is gone
                        refreshViewer();
                        handBackSearch();
                        sendMenuTab();       // B27: the new page learns where the tab is
                        // The chip is still up: the new page says scrollOk on its first drag that scrolls.
                        if (stuckChipWanted) js("stuckChipUp");
                        if (!prefs.getBoolean("tabTip", false)) {
                            prefs.edit().putBoolean("tabTip", true).apply();
                            toast("Tip: drag the ⋮ tab up, down or to the other side");
                        }
                    }
                    updateFeedBar();
                } else {
                    comments.pageReady();
                }
                break;
            case "feedEnd":
                if (main) {
                    // The end-of-Home card belongs to Home only, whatever the page asks;
                    // never while Home is going on into Following (unless it stalled).
                    String cont = m.optString("cont", "off");
                    String contWhy = m.optString("contWhy", "");
                    boolean stalled = m.optBoolean("stalled");
                    feedWanted = m.optBoolean("on") && !onOtherFeed() && !("running".equals(cont) && !stalled);
                    if (feedWanted) {
                        String subtitle = m.optBoolean("caughtUp") && !m.isNull("subtitle") ? m.optString("subtitle", "").trim() : "";
                        setFeedText(stalled, subtitle.length() > 200 ? subtitle.substring(0, 200) : subtitle, cont, contWhy);
                    }
                    updateFeedBar();
                }
                break;
            case "search":
                if (main) {
                    searchOpen = m.optBoolean("open");
                    updateFeedBar();
                }
                break;
            case "skipStatus":
                if (main) {
                    String kind = m.optString("kind", "");
                    skipKind = m.optBoolean("on") && ("skipping".equals(kind) || "nothingNew".equals(kind) || "homeSkipping".equals(kind)
                            || "homeLoading".equals(kind)) ? kind : "";
                    skipCount = Math.max(0, Math.min(99999, m.optInt("n")));
                    updateFeedBar();
                }
                break;
            case "openFeed":
                if (main) {
                    String v = m.optString("variant");
                    if ("home".equals(v)) loadMain(Links.HOME);
                    else if ("following".equals(v)) loadMain(FOLLOWING);
                    else if ("favorites".equals(v)) loadMain(FAVORITES);
                }
                break;
            case "trail":
                if (main) keepTrail(m.optJSONObject("entry"));
                break;
            case "awake":
                if (main) setAwake(m.optBoolean("on"));
                break;
            case "fullVideo":
                if (main) setPageVideo(m.optBoolean("on"));
                break;
            case "fullVideoStart":
                // The page is about to ask for full screen for a video of its own.
                if (main) ownFullAt = SystemClock.uptimeMillis();
                break;
            case "fullVideoTap":
                // R10 from the menu: the page names a spot on its video; the app taps it.
                if (main) tapVideoForPage(m.optDouble("x", -1), m.optDouble("y", -1), m.optDouble("w", 0), 0);
                break;
            case "fullVideoExitRequest":
                // R8's swipe (and R10's later): leave full screen the Back way, view
                // first. Never a Story's own full screen: that would close the Story.
                if (main && !"story".equals(route)) hideCustomView("r8bridge");
                break;
            case "scrollStuck":
                if (main) onScrollStuck(m);
                break;
            case "boot":
                // B33: Instagram's logo went (removed / hidden / never there).
                if (main) onBoot(m);
                break;
            case "bootStuck":
                if (main) onBootStuck(m);
                break;
            case "bootRecord":
                if (main) onBootRecord(m);
                break;
            case "scrollOk":
                // Drags scroll again (the page saw one): the chip has nothing to fix.
                if (main && stuckChipWanted) {
                    stuckChipWanted = false;
                    updateStuckChip();
                }
                break;
            case "comments":
                if (main) openComments(m);
                break;
            case "share":
                // R12: the share button over a Story's Reel offers the Reel's link.
                if (main) shareText(Links.normalize(m.optString("url", "")));
                break;
            case "commentsLayout":
                if ("comments".equals(role)) commentsLayout = commentsShape(m);
                break;
            case "menuContext":
                if (main) menuLink = m.optString("link", null);
                break;
            case "download":
                if (main) startDownloads(m.optJSONArray("items"));
                break;
            case "downloadAsk":
                if (main) askDownload(m.optJSONObject("current"), m.optJSONArray("all"));
                break;
            case "downloadChoices":
                if (main) chooseDownload(m.optJSONArray("choices"));
                break;
            case "status":
                if (main) deliverStatus(m.optJSONObject("stats"));
                break;
            case "toast": {
                String text = m.optString("message");
                if (!text.isEmpty() && text.length() <= 200) toast(text);
                break;
            }
            default:
                break;
        }
    }

    /* ------------------------------------------------------------------ *
     * Zoom
     * ------------------------------------------------------------------ */

    @Override
    public boolean storyMode() {
        return "story".equals(route);
    }

    @Override
    public void onZoomChanged(float scale) {
        boolean zoomed = scale > 1.01f;
        if (zoomed && !screenshotMode && !fullHidTab) {
            zoomChip.setText(String.format(Locale.US, "%.1f×  ·  Reset", scale));
            zoomChip.setVisibility(View.VISIBLE);
        } else {
            zoomChip.setVisibility(View.GONE);
        }
        updateFeedBar();
        if (zoomed && !zoomedStory && storyMode()) {
            zoomedStory = true;
            storyHold(true);
        } else if (!zoomed && zoomedStory) {
            zoomedStory = false;
            storyHold(false);
        }
    }

    @Override
    public void onHoldChanged(boolean on) {
        try {
            js(new JSONObject().put("type", "appHold").put("on", on));
        } catch (JSONException ignored) {
            // Not reachable with constant keys.
        }
    }

    /** R9's Reel layer covers the page: no menu tab or system bars over it. */
    private void setPageVideo(boolean on) {
        if (pageVideo == on) return;
        pageVideo = on;
        if (on) {
            setTabShown(false);
            zoomChip.setVisibility(View.GONE);
            updateStuckChip();       // the stuck chip stays off the Reel layer too
            setSystemBarsHidden(true);
        } else {
            // R12: the Reel's comments go with the Reel.
            if (commentsOverFull) closeComments();
            if (!screenshotMode && !fullHidTab) setTabShown(true);
            if (customView == null && !screenshotMode) setSystemBarsHidden(false);
            onZoomChanged(zoom.scale());
        }
    }

    private void storyHold(boolean on) {
        try {
            js(new JSONObject().put("type", "storyHold").put("on", on));
        } catch (JSONException ignored) {
            // Not reachable with constant keys.
        }
    }

    private TextView makeZoomChip() {
        TextView chip = new TextView(this);
        chip.setTextColor(Color.WHITE);
        chip.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        chip.setTypeface(Typeface.DEFAULT_BOLD);
        chip.setPadding(dp(14), dp(7), dp(14), dp(7));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0xB3000000);
        bg.setCornerRadius(dp(18));
        chip.setBackground(bg);
        chip.setElevation(dp(4));
        chip.setVisibility(View.GONE);
        chip.setOnClickListener(v -> zoom.reset(true));
        return chip;
    }

    /* ------------------------------------------------------------------ *
     * End of Home: keep going in Following
     * ------------------------------------------------------------------ */

    /** Following, Favorites or Older posts (the address's variant), not Home. */
    private boolean onOtherFeed() {
        if (pageUrl == null || pageUrl.isEmpty()) return false;
        String v = Uri.parse(pageUrl).getQueryParameter("variant");
        return v != null && !v.isEmpty() && !"home".equals(v);
    }

    /** Following or Favorites: where the skip note may show. */
    private boolean onFollowingOrFavorites() {
        if (pageUrl == null || pageUrl.isEmpty()) return false;
        String v = Uri.parse(pageUrl).getQueryParameter("variant");
        return "following".equals(v) || "favorites".equals(v);
    }

    /** The note on Following opened from the end card, never through the card itself. */
    private TextView makeSkipChip() {
        TextView chip = new TextView(this);
        chip.setTextColor(Color.WHITE);
        chip.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        chip.setGravity(Gravity.CENTER);
        chip.setPadding(dp(16), dp(9), dp(16), dp(9));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0xD9262626);
        bg.setCornerRadius(dp(18));
        chip.setBackground(bg);
        chip.setElevation(dp(6));
        chip.setContentDescription("Skip status");
        chip.setVisibility(View.GONE);
        return chip;
    }

    private void updateSkipChip() {
        // Following or Favorites opened from the card; or Home itself while it goes on
        // into Following and is still passing posts you saw (R7, homeSkipping) or
        // waits at the bottom for the next posts from Following (B22, homeLoading).
        boolean home = "homeSkipping".equals(skipKind) || "homeLoading".equals(skipKind);
        // Never on top of the end card (they share the bottom of the screen).
        boolean show = !skipKind.isEmpty() && "home".equals(route) && (home ? !onOtherFeed() && !feedWanted : onFollowingOrFavorites())
                && !screenshotMode && !comments.isOpen() && !searchOpen && customView == null;
        if (show) {
            skipChip.setText("nothingNew".equals(skipKind) ? "Nothing new since Home"
                    : "homeLoading".equals(skipKind) ? "Loading more from people you follow…"
                    : skipCount > 0 ? "Skipping " + skipCount + " posts you saw in Home…" : "Skipping posts you saw in Home…");
        }
        skipChip.setVisibility(show ? View.VISIBLE : View.GONE);
    }

    private View makeFeedBar() {
        android.widget.LinearLayout bar = new android.widget.LinearLayout(this);
        bar.setOrientation(android.widget.LinearLayout.VERTICAL);
        bar.setGravity(Gravity.CENTER_HORIZONTAL);
        bar.setPadding(dp(16), dp(12), dp(16), dp(14));
        GradientDrawable bg = feedBg = new GradientDrawable();
        bg.setColor(dark ? 0xF2262626 : 0xF2FFFFFF);
        bg.setCornerRadius(dp(18));
        bg.setStroke(dp(1), dark ? 0x33FFFFFF : 0x22000000);
        bar.setBackground(bg);
        bar.setElevation(dp(8));
        // The card is solid: a tap on its text must not like the post underneath.
        bar.setClickable(true);
        bar.setContentDescription("End of Home");

        TextView title = new TextView(this);
        title.setTextColor(dark ? Color.WHITE : Color.BLACK);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setGravity(Gravity.CENTER);
        bar.addView(title);
        TextView sub = new TextView(this);
        sub.setTextColor(dark ? 0xFFA8A8A8 : 0xFF737373);
        sub.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        sub.setGravity(Gravity.CENTER);
        sub.setPadding(0, dp(2), 0, dp(10));
        bar.addView(sub);
        feedTitle = title;
        feedSub = sub;
        setFeedText(false, "", "off", "");

        // Following only: Favorites stays in the ⋮ menu.
        bar.addView(feedButton("Following", "following"));
        bar.setVisibility(View.GONE);
        return bar;
    }

    private TextView feedButton(String label, String variant) {
        TextView b = new TextView(this);
        b.setText(label);
        b.setTextColor(Color.WHITE);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setGravity(Gravity.CENTER);
        b.setPadding(dp(22), dp(9), dp(22), dp(9));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0xFF0095F6);
        bg.setCornerRadius(dp(10));
        b.setBackground(bg);
        b.setOnClickListener(v -> {
            feedWanted = false;
            updateFeedBar();
            try {
                js(new JSONObject().put("type", "continueFeed").put("variant", variant));
            } catch (JSONException ignored) {
                // Not reachable with constant keys.
            }
        });
        return b;
    }

    /**
     * At the end of Home, Instagram's own line ("You've seen all new posts from
     * the past 3 days.") when it sent one; when nothing has loaded for a while, says so.
     * With Home going on into Following (R7, cont): nothing while it runs; this
     * card if it failed, stalled or Instagram stopped paging first (stopped);
     * its own words when Following has nothing new (done) or at the required
     * stop (limit), which names the 200 posts only when that was the reason
     * (contWhy "posts"; "requests" makes no claim about a count).
     */
    private void setFeedText(boolean stalled, String subtitle, String cont, String contWhy) {
        String keepGoing = "Keep going, newest first, without repeats:";
        if (stalled) {
            feedTitle.setText("Home isn't loading more");
            feedSub.setText(keepGoing);
        } else if ("done".equals(cont)) {
            feedTitle.setText("That's everything new from people you follow");
            feedSub.setText("Older posts, newest first, without repeats:");
        } else if ("limit".equals(cont)) {
            feedTitle.setText("Keep going in Following");
            feedSub.setText("posts".equals(contWhy)
                    ? "Home stops here after about 200 posts from people you follow.\nNewest first, without repeats:"
                    : "Newest first, without repeats:");
        } else {
            feedTitle.setText("You're all caught up on Home");
            feedSub.setText(subtitle.isEmpty() ? keepGoing : subtitle + "\n" + keepGoing);
        }
    }

    private void showFeedBar(boolean on) {
        feedWanted = on;
        updateFeedBar();
    }

    /** The card shows when the page asks for it and nothing else is in the way. */
    private void updateFeedBar() {
        updateSkipChip();
        updateStuckChip();
        boolean show = feedWanted && "home".equals(route) && !onOtherFeed() && !screenshotMode && !comments.isOpen()
                && !zoom.isZoomed() && !searchOpen && customView == null;
        boolean visible = feedBar.getVisibility() == View.VISIBLE;
        if (show && visible && feedBar.getAlpha() >= 1f) return;
        feedBar.animate().cancel();
        if (show) {
            if (!visible) {
                feedBar.setAlpha(0f);
                feedBar.setTranslationY(dp(16));
                feedBar.setVisibility(View.VISIBLE);
            }
            feedBar.animate().alpha(1f).translationY(0f).setDuration(180).start();
        } else if (visible) {
            feedBar.animate().alpha(0f).translationY(dp(16)).setDuration(150)
                    .withEndAction(() -> feedBar.setVisibility(View.GONE)).start();
        }
    }

    /* ------------------------------------------------------------------ *
     * Comments split view
     * ------------------------------------------------------------------ */

    private void openComments(JSONObject m) {
        String url = Links.commentsUrl(m.optString("code"));
        if (url == null) return;
        // R12: R9's Reel layer is up (in the Story's full screen or, for a Story
        // that isn't full screen, over the page): the comments are the Reel's.
        if (pageVideo) {
            openCommentsOverFull(url, (float) m.optDouble("dpr", density));
            return;
        }
        JSONObject r = m.optJSONObject("rect");
        RectF css = null;
        if (r != null) {
            float x = (float) r.optDouble("x"), y = (float) r.optDouble("y");
            float w = (float) r.optDouble("w"), h = (float) r.optDouble("h");
            if (w > 1 && h > 1) css = new RectF(x, y, x + w, y + h);
        }
        splitCss = css;
        splitDpr = (float) m.optDouble("dpr", density);
        if (screenshotMode) exitScreenshot();
        if (zoom.isZoomed()) zoom.reset(false);
        updateFeedBar();
        if (!comments.isOpen()) {
            // Keep the page its full size underneath so nothing on it re-lays out.
            ViewGroup.LayoutParams lp = zoom.getLayoutParams();
            lp.height = zoom.getHeight();
            zoom.setLayoutParams(lp);
        }
        int height = root.getHeight();
        int top = splitTop(height);
        zoom.showSplit(css, splitDpr, top, true);
        comments.open(url, height - top);
        zoomChip.setVisibility(View.GONE);
    }

    /**
     * R12: comments for the Reel shown over a Story (R9's layer). The Story may
     * be in Instagram's full screen (the app's full-screen view) or not (a Story
     * reached by a full load can't ask for one): either way the page isn't
     * split. The panel comes up over whatever is on top, raised by its Z (drawn
     * and touched above it), and the page fits the Reel into the part above it.
     * The Story stays paused under the Reel. Back closes the comments first, and
     * they go when the Reel does. Nothing switches full screen and no view moves
     * in the tree, so no touch is split.
     */
    private void openCommentsOverFull(String url, float dpr) {
        if (screenshotMode) exitScreenshot();
        if (comments.isOpen() && !commentsOverFull) {
            // An ordinary split from before the Reel: the page goes back to full size.
            zoom.hideSplit();
            ViewGroup.LayoutParams lp = zoom.getLayoutParams();
            lp.height = ViewGroup.LayoutParams.MATCH_PARENT;
            zoom.setLayoutParams(lp);
        }
        splitCss = null;
        splitDpr = dpr > 0 ? dpr : density;
        fullHidComments = false;
        commentsOverFull = true;
        commentsOverOpens++;
        comments.setTranslationZ(dp(16));
        int height = root.getHeight();
        int top = splitTop(height);
        comments.open(url, height - top);
        comments.setVisibility(View.VISIBLE);
        zoomChip.setVisibility(View.GONE);
        tellCommentsOver(top);
    }

    /** The page's Reel layer: where the panel's top is (CSS px), or that it has gone (top < 0). */
    private void tellCommentsOver(int top) {
        try {
            JSONObject c = new JSONObject().put("type", "commentsOver").put("on", top >= 0);
            if (top >= 0) c.put("top", top / splitDpr);
            js(c);
        } catch (JSONException ignored) {
            // Not reachable with constant keys.
        }
    }

    private int splitTop(int height) {
        boolean keyboard = fullHeight > 0 && height < fullHeight * 0.8f;
        return Math.round(height * (keyboard ? 0.30f : 0.42f));
    }

    @Override
    public void onCommentsCloseRequested() {
        closeComments();
    }

    private void closeComments() {
        if (!comments.isOpen()) return;
        InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
        if (imm != null) imm.hideSoftInputFromWindow(root.getWindowToken(), 0);
        comments.close();
        if (commentsOverFull) {
            commentsOverFull = false;
            comments.setTranslationZ(0f);
        }
        zoom.hideSplit();
        ViewGroup.LayoutParams lp = zoom.getLayoutParams();
        lp.height = ViewGroup.LayoutParams.MATCH_PARENT;
        zoom.setLayoutParams(lp);
        js("splitClosed");
        updateFeedBar();
    }

    /**
     * The theme opts out of Android 15's edge-to-edge layout, so the system keeps
     * the page clear of the status and navigation bars. If a future Android
     * ignores that, pad for the bars and the keyboard ourselves.
     */
    private void guardEdgeToEdge() {
        if (Build.VERSION.SDK_INT < 30) return;
        root.post(() -> {
            WindowInsets wi = root.getRootWindowInsets();
            if (wi == null) return;
            int status = wi.getInsets(WindowInsets.Type.statusBars()).top;
            int[] loc = new int[2];
            root.getLocationOnScreen(loc);
            if (status == 0 || loc[1] >= status) return;
            root.setOnApplyWindowInsetsListener((v, in) -> {
                android.graphics.Insets bars = in.getInsets(WindowInsets.Type.systemBars());
                android.graphics.Insets ime = in.getInsets(WindowInsets.Type.ime());
                v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
                return in;
            });
            root.requestApplyInsets();
        });
    }

    private void onRootLayout(int width, int height) {
        if (width != fullWidth) {
            fullWidth = width;
            fullHeight = height;
        } else {
            fullHeight = Math.max(fullHeight, height);
        }
        ui.post(() -> {
            placeMenuButton();
            if (comments.isOpen() && commentsOverFull) {
                int top = splitTop(height);
                comments.setHeight(height - top);
                tellCommentsOver(top);
            } else if (comments.isOpen()) {
                int top = splitTop(height);
                zoom.showSplit(splitCss, splitDpr, top, false);
                comments.setHeight(height - top);
            }
        });
    }

    /* ------------------------------------------------------------------ *
     * Menu
     * ------------------------------------------------------------------ */

    // The menu is a slim tab on the screen edge, clear of Instagram's own
    // buttons (a post's Save icon sits a little in from the edge).
    private static final int TAB_W = 16, TAB_H = 48;
    // B27: how far the tab's hit area reaches past it (inward, above and below).
    private static final int TAB_REACH = 8;
    private Rect tabHit;
    // Where the tab is, as the page last heard it (fractions of root's height).
    private boolean tabLeft;
    private float tabTop, tabHeight;

    @SuppressLint("ClickableViewAccessibility")
    private TextView makeMenuButton() {
        TextView b = new TextView(this);
        b.setText("⋮");
        b.setTextColor(Color.WHITE);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setGravity(Gravity.CENTER);
        b.setIncludeFontPadding(false);
        b.setBackground(tabBackground(false));
        b.setElevation(dp(6));
        b.setContentDescription("SimpleGram menu");
        b.setOnTouchListener(new View.OnTouchListener() {
            final int slop = ViewConfiguration.get(MainActivity.this).getScaledTouchSlop();
            float downX, downY, startX, startY;
            boolean dragging;

            @Override
            public boolean onTouch(View v, MotionEvent e) {
                switch (e.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        downX = e.getRawX();
                        downY = e.getRawY();
                        startX = v.getX();
                        startY = v.getY();
                        dragging = false;
                        v.setAlpha(0.8f);
                        return true;
                    case MotionEvent.ACTION_MOVE: {
                        float dx = e.getRawX() - downX, dy = e.getRawY() - downY;
                        if (!dragging && Math.hypot(dx, dy) > slop) dragging = true;
                        if (dragging) {
                            v.setX(clamp(startX + dx, 0, root.getWidth() - v.getWidth()));
                            v.setY(clamp(startY + dy, 0, root.getHeight() - v.getHeight()));
                        }
                        return true;
                    }
                    case MotionEvent.ACTION_UP:
                        v.setAlpha(1f);
                        if (!dragging) {
                            showMenu();
                        } else {
                            boolean left = v.getX() + v.getWidth() / 2f < root.getWidth() / 2f;
                            prefs.edit().putBoolean("menuLeft", left)
                                    .putFloat("menuY", v.getY() / Math.max(1, root.getHeight())).apply();
                            placeMenuButton();
                        }
                        return true;
                    case MotionEvent.ACTION_CANCEL:
                        v.setAlpha(1f);
                        return true;
                    default:
                        return false;
                }
            }
        });
        return b;
    }

    private static float clamp(float v, float lo, float hi) {
        return Math.max(lo, Math.min(hi, v));
    }

    private void placeMenuButton() {
        int w = root.getWidth(), h = root.getHeight();
        if (w == 0 || h == 0) return;
        int tabW = dp(TAB_W), tabH = dp(TAB_H);
        boolean left = prefs.getBoolean("menuLeft", false);
        int x = left ? 0 : w - tabW;
        int y = Math.round(clamp(prefs.getFloat("menuY", 0.58f) * h, dp(56), h - tabH - dp(60)));
        menuButton.setBackground(tabBackground(left));
        menuButton.animate().cancel();
        menuButton.animate().x(x).y(y).setDuration(120).start();
        // B27: a thumb aimed at a 16 dp tab often lands just beside it (over a
        // video, that was R10's one tap). The tab's hit area reaches 8 dp inward
        // and 8 dp above and below; the tab itself stays slim, and Instagram's own
        // edge icons start about 16 dp in, so their taps are never taken.
        int reach = dp(TAB_REACH);
        Rect hit = new Rect(x - (left ? 0 : reach), y - reach, x + tabW + (left ? reach : 0), y + tabH + reach);
        if (!hit.equals(tabHit)) {
            // Kept while it is unchanged: a new delegate forgets a touch it is in the middle of.
            tabHit = hit;
            tabDelegate = new TouchDelegate(hit, menuButton);
        }
        if (Build.VERSION.SDK_INT >= 29) {
            // Dragging the tab (from its extra room too) must not start the system Back gesture.
            menuButton.setSystemGestureExclusionRects(Collections.singletonList(new Rect(0, 0, tabW, tabH)));
            root.setSystemGestureExclusionRects(Collections.singletonList(hit));
        }
        tabLeft = left;
        tabTop = y / (float) h;
        tabHeight = tabH / (float) h;
        sendMenuTab();
    }

    /**
     * B27: the page keeps a dead zone around the tab (no one-tap full screen and
     * no swipe arm there, wherever the tab was dragged). It is told where the
     * tab is after every layout and drag, when the tab is hidden or shown, and
     * when a new page is ready. Fractions of root's height, so the page needs
     * no pixel ratio.
     */
    private void sendMenuTab() {
        try {
            js(new JSONObject().put("type", "menuTab")
                    .put("on", menuButton.getVisibility() == View.VISIBLE)
                    .put("side", tabLeft ? "left" : "right")
                    .put("yFrac", Math.round(tabTop * 10000) / 10000.0)
                    .put("hFrac", Math.round(tabHeight * 10000) / 10000.0));
        } catch (JSONException ignored) {
            // Not reachable with constant keys.
        }
    }

    /** Shows or hides the tab, and tells the page when that changes. */
    private void setTabShown(boolean on) {
        int v = on ? View.VISIBLE : View.GONE;
        if (menuButton.getVisibility() == v) return;
        menuButton.setVisibility(v);
        sendMenuTab();
    }

    /** Rounded on the side facing the screen, square against the edge. */
    private GradientDrawable tabBackground(boolean left) {
        float r = dp(10);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0x8C1C1C1C);
        bg.setStroke(dp(1), 0x40FFFFFF);
        bg.setCornerRadii(left
                ? new float[]{0, 0, r, r, r, r, 0, 0}
                : new float[]{r, r, 0, 0, 0, 0, r, r});
        return bg;
    }

    private AlertDialog.Builder dialog() {
        return new AlertDialog.Builder(this, dark
                ? android.R.style.Theme_DeviceDefault_Dialog_Alert
                : android.R.style.Theme_DeviceDefault_Light_Dialog_Alert);
    }

    private void showMenu() {
        if (menuOpen) return;
        menuOpen = true;
        try {
            JSONObject cmd = new JSONObject().put("type", "menu");
            if (zoom.isZoomed()) {
                RectF r = zoom.visiblePageRect();
                cmd.put("focus", new JSONObject().put("x", r.left / density).put("y", r.top / density)
                        .put("w", r.width() / density).put("h", r.height() / density));
            }
            js(cmd);
        } catch (JSONException ignored) {
            // Not reachable with constant keys.
        }
        // A Story would move on while you choose; hold it like a finger would.
        if (storyMode()) zoom.hold();
        final boolean[] keepHold = {false};
        String[] items = {
                "Download photo / video",
                "Full-screen video",
                "Copy link",
                "Share link…",
                "Following feed (newest first)",
                "Favorites feed",
                "Refresh",
                "Fix scrolling",
                "Hide controls for screenshot",
                "More…",
        };
        AlertDialog d = dialog().setItems(items, (x, which) -> {
            switch (which) {
                case 0:
                    js("download");
                    break;
                case 1:
                    // R10: the page finds the video on screen and asks for a tap (fullVideoTap).
                    js("fullVideoMenu");
                    break;
                case 2:
                    copyLink();
                    break;
                case 3:
                    shareLink();
                    break;
                case 4:
                    loadMain(FOLLOWING);
                    break;
                case 5:
                    loadMain(FAVORITES);
                    break;
                case 6:
                    feedWanted = false;
                    skipKind = "";
                    updateFeedBar();
                    startsReload++;
                    goBackAt = 0;
                    startHow = "Refresh";
                    web.reload();
                    break;
                case 7:
                    // B25's escape hatch: a new page view, at any time.
                    fixScrolling();
                    break;
                case 8:
                    keepHold[0] = true;
                    enterScreenshot();
                    break;
                default:
                    showMore();
                    break;
            }
        }).create();
        d.setOnDismissListener(x -> {
            menuOpen = false;
            if (!keepHold[0]) zoom.releaseHold();
        });
        d.show();
    }

    private void showMore() {
        String[] items = {
                "Filter status",
                "Continue Home into Following: " + (continueHome() ? "On" : "Off"),
                "Open Instagram links with SimpleGram…",
                "Open copied Instagram link",
                "About SimpleGram",
        };
        dialog().setItems(items, (x, which) -> {
            switch (which) {
                case 0:
                    askStatus(false);
                    break;
                case 1:
                    toggleContinueHome();
                    break;
                case 2:
                    linkSettings();
                    break;
                case 3:
                    openCopiedLink();
                    break;
                default:
                    dialog().setTitle("SimpleGram " + BuildConfig.VERSION_NAME)
                            .setMessage("Your own Instagram, without the doom scrolling.\n\n"
                                    + "Uses Instagram's website with your account. No ads, suggested posts, "
                                    + "reposts or Reels tab. Pinch to zoom anywhere; download from the menu.\n\n"
                                    + "Downloads are saved to Downloads/SimpleGram.")
                            .setPositiveButton("OK", null).show();
                    break;
            }
        }).show();
    }

    private void loadMain(String url) {
        if (startHow.isEmpty()) startHow = "menu";
        feedWanted = false;
        skipKind = "";       // the note belongs to the page being left
        updateFeedBar();
        closeComments();
        if (zoom.isZoomed()) zoom.reset(false);
        load(web, url);
    }

    private String currentLink() {
        if (menuLink != null && Links.normalize(menuLink) != null) return menuLink;
        String u = web.getUrl();
        return u == null ? Links.HOME : u;
    }

    private void copyLink() {
        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (cm == null) return;
        cm.setPrimaryClip(ClipData.newPlainText("Instagram link", currentLink()));
        if (Build.VERSION.SDK_INT < 33) toast("Link copied");
    }

    private void shareLink() {
        shareText(currentLink());
    }

    private void shareText(String link) {
        if (link == null) return;
        Intent send = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, link);
        try {
            startActivity(Intent.createChooser(send, "Share link"));
        } catch (ActivityNotFoundException e) {
            toast("No app can share this");
        }
    }

    private void openCopiedLink() {
        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        ClipData clip = cm == null ? null : cm.getPrimaryClip();
        CharSequence text = clip != null && clip.getItemCount() > 0 ? clip.getItemAt(0).coerceToText(this) : null;
        String url = text == null ? null : Links.fromText(text.toString());
        if (url == null) {
            toast("No Instagram link copied");
            return;
        }
        loadMain(url);
    }

    private void linkSettings() {
        dialog().setTitle("Open Instagram links here")
                .setMessage("Android decides which app opens instagram.com links from texts and other apps.\n\n"
                        + "On the next screen tap “Open supported links”, then “Add link” and tick "
                        + "instagram.com and www.instagram.com.\n\n"
                        + "If a link still opens elsewhere, use Share → SimpleGram, or copy it and use "
                        + "“Open copied Instagram link”.")
                .setPositiveButton("Open settings", (d, w) -> {
                    Uri pkg = Uri.parse("package:" + getPackageName());
                    Intent i = Build.VERSION.SDK_INT >= 31
                            ? new Intent(Settings.ACTION_APP_OPEN_BY_DEFAULT_SETTINGS, pkg)
                            : new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg);
                    try {
                        startActivity(i);
                    } catch (ActivityNotFoundException e) {
                        startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg));
                    }
                })
                .setNegativeButton("Cancel", null).show();
    }

    private int statusWanted;             // 0 none, 1 Filter status, 2 Copy details alone
    private Runnable statusFallback;
    String lastDetails;                   // what Copy details last put on the clipboard (ShellTest reads it)

    /**
     * Filter status, or Copy details alone (the chip's Details): the page is
     * asked; a page that doesn't answer within a second (stuck on the logo, or
     * dead) gets the app's own part shown or copied without it.
     */
    private void askStatus(boolean copy) {
        statusWanted = copy ? 2 : 1;
        if (statusFallback != null) ui.removeCallbacks(statusFallback);
        statusFallback = () -> {
            statusFallback = null;
            deliverStatus(null);
        };
        ui.postDelayed(statusFallback, 1000);
        js("status");
    }

    private void deliverStatus(JSONObject stats) {
        if (statusFallback != null) {
            ui.removeCallbacks(statusFallback);
            statusFallback = null;
        }
        int want = statusWanted;
        statusWanted = 0;
        if (want == 2) copyDetails(stats, deviceDiagnostics());
        else if (want == 1 || stats != null) showStatus(stats);
    }

    private void showStatus(JSONObject stats) {
        boolean pageAnswered = stats != null;
        if (!pageAnswered) stats = new JSONObject();
        JSONObject feed = stats.optJSONObject("feed");
        JSONObject dom = stats.optJSONObject("dom");
        StringBuilder b = new StringBuilder();
        if (!pageAnswered) b.append("The page didn't answer, so only the app's own counts are here.\n\n");
        if (feed != null) {
            b.append("Home feed\n")
                    .append("  Posts shown: ").append(feed.optInt("kept")).append('\n')
                    .append("  Ads removed: ").append(feed.optInt("ad")).append('\n')
                    .append("  Suggested removed: ").append(feed.optInt("suggested") + feed.optInt("notFollowed")
                            + feed.optInt("exploreTitle")).append('\n')
                    .append("  Reposts removed: ").append(feed.optInt("repost")).append('\n')
                    .append("  Other promos removed: ").append(feed.optInt("unit")).append('\n')
                    .append("  Pages read: ").append(feed.optInt("pages"))
                    .append(" (").append(feed.optInt("unknownPages")).append(" unrecognised, ")
                    .append(feed.optInt("streamed")).append(" streamed)\n")
                    .append("  \"Caught up\" seen: ").append(feed.optInt("eof"))
                    .append(" · removed after it: ").append(feed.optInt("afterEnd") + feed.optInt("inMarker")).append('\n')
                    .append("  Posts with a Follow button: ").append(feed.optInt("followButtons"))
                    .append(" · follow unknown: ").append(feed.optInt("followUnknown")).append('\n')
                    .append("  Blank screen: ").append(feed.optInt("blank"))
                    .append(" · most posts loaded: ").append(feed.optInt("peakPosts")).append('\n');
            JSONObject kinds = feed.optJSONObject("anchorKind");
            JSONObject nav = stats.optJSONObject("nav");
            JSONObject full = nav == null ? null : nav.optJSONObject("homeFull");
            b.append("  Home tab: to the top ").append(feed.optInt("homeTapTop"))
                    .append(" · let through ").append(feed.optInt("homeTapRefresh"))
                    .append(" · fresh Home ").append(full == null ? 0 : full.optInt("bar") + full.optInt("header"))
                    .append(full == null ? "" : " (bar " + full.optInt("bar") + ", header " + full.optInt("header") + ")").append('\n');
            // R5: whether the star found Instagram's bar and lines up with it (shapes only).
            JSONObject geo = nav == null ? null : nav.optJSONObject("geo");
            b.append("  Favorites star: ").append(nav == null || nav.optInt("inserted") == 0 ? "not in the bar" : "in the bar");
            if (geo != null) {
                b.append(" (").append(geo.optInt("items")).append(" items, off by ").append(geo.optInt("dy")).append(" px)");
            }
            if (nav != null && nav.optInt("waitReactGaveUp") > 0) b.append(" · bar never ready ").append(nav.optInt("waitReactGaveUp"));
            b.append(" · taps ").append(nav == null ? 0 : nav.optInt("taps"));
            if (nav != null) {
                b.append(" (to the top ").append(nav.optInt("top"))
                        .append(", refreshed ").append(nav.optInt("refresh"))
                        .append(", held ").append(nav.optInt("refreshHeld"))
                        .append(", search closed ").append(nav.optInt("closedSearch")).append(')');
            }
            b.append('\n')
                    .append("  First-page anchors: ").append(feed.optInt("anchor"));
            if (kinds != null) {
                b.append(" (seen ").append(kinds.optInt("seen")).append(", caught-up line ").append(kinds.optInt("marker"))
                        .append(", hidden suggestion ").append(kinds.optInt("recs")).append(')');
            }
            b.append('\n')
                    .append("  Following from the card: seen skipped ").append(feed.optInt("alreadySeen"))
                    .append(" · skip ended ").append(feed.optInt("skipForgotten") + feed.optInt("skipLeft"))
                    .append(" · repeat stops ").append(feed.optInt("cursorEcho"))
                    .append(" · slowed ").append(feed.optInt("skipThrottled"))
                    .append(" · start from Home: ").append(feed.optString("carry", "none"))
                    .append(feed.optInt("carried") > 0 ? " (" + feed.optInt("carried") + " posts)" : "").append('\n')
                    .append("  Feed switches reloaded: ").append(feed.optInt("switchLoads"))
                    .append(" · blank feeds reloaded: ").append(feed.optInt("recovered"))
                    .append(" (held ").append(feed.optInt("recoverHeld")).append(")\n")
                    .append("  Feed trail: ").append(trail().length()).append(" entries, kept across restarts (Copy details)\n");
        }
        JSONObject cont = stats.optJSONObject("cont");
        if (cont != null) {
            JSONObject why = cont.optJSONObject("headWhy");
            String reason = cont.optString("reason", "");
            b.append("\nHome into Following\n")
                    .append("  Switch: ").append(cont.optBoolean("on") ? "on" : "off")
                    .append(" · state: ").append(cont.optString("state", "off"))
                    .append(reason.isEmpty() ? "" : " (" + reason + ")").append('\n')
                    .append("  Posts added: ").append(cont.optInt("handed"))
                    .append(" · Instagram's own kept: ").append(cont.optInt("igKept"))
                    .append(" · seen skipped: ").append(cont.optInt("skippedSeen")).append('\n')
                    .append("  Own requests: ").append(cont.optInt("own"))
                    .append(" (failed ").append(cont.optInt("ownFail"))
                    .append(", most in a minute ").append(cont.optInt("peakMin")).append(")\n")
                    .append("  Pages handed: ").append(cont.optInt("swaps"))
                    .append(" (empty ").append(cont.optInt("empty")).append(")")
                    .append(" · repeats: ").append(cont.optInt("repeats")).append('\n')
                    .append("  Home reloads: ").append(cont.optInt("heads"));
            if (why != null) {
                b.append(" (marker ").append(why.optInt("marker")).append(", seen ").append(why.optInt("seen"))
                        .append(", jump ").append(why.optInt("jump")).append(", tap ").append(why.optInt("tap"))
                        .append(", ended ").append(why.optInt("ended")).append(')');
            }
            b.append('\n');
            // B22: how long you waited at the bottom while Home went on, and why (seconds).
            JSONObject waits = cont.optJSONObject("waits");
            JSONObject ww = waits == null ? null : waits.optJSONObject("why");
            if (waits != null && ww != null) {
                b.append("  Waits at the bottom: ").append(waits.optInt("n"))
                        .append(" (longest ").append(seconds(waits.optInt("longest")))
                        .append("; nothing ready ").append(seconds(ww.optInt("empty")))
                        .append(", reading ").append(seconds(ww.optInt("read")))
                        .append(", paced ").append(seconds(ww.optInt("pacing")))
                        .append(", Instagram's page ").append(seconds(ww.optInt("ig")))
                        .append(")\n  \"Loading more\" notes: ").append(waits.optInt("notes"))
                        .append(" · stalled cards while going on: ").append(waits.optInt("cards")).append('\n');
            }
        }
        JSONObject sd = stats.optJSONObject("searchData");
        JSONObject opens = stats.optJSONObject("searchOpens");
        if (sd != null || opens != null) {
            b.append("\nSearch\n");
            if (sd != null) {
                JSONArray log = sd.optJSONArray("gqlLog");
                int n = log == null ? 0 : log.length(), failed = 0;
                String lastFail = "";
                for (int i = 0; i < n; i++) {
                    JSONObject e = log.optJSONObject(i);
                    if (e == null) continue;
                    if (e.has("code") || e.has("message") || e.optInt("status") != 200) {
                        failed++;
                        String why = e.has("code") ? e.optString("code")
                                : e.optInt("status") != 200 ? String.valueOf(e.optInt("status"))
                                : e.optString("message");
                        lastFail = e.optString("query") + " " + why;
                    }
                }
                b.append("  Requests: ").append(n).append(" (").append(failed).append(" failed)\n");
                if (!lastFail.isEmpty()) b.append("  Last failure: ").append(lastFail).append('\n');
            }
            if (opens != null) {
                b.append("  Results opened: ").append(opens.optInt("router") + opens.optInt("popstate") + opens.optInt("samePage"))
                        .append(" · full reloads: ").append(opens.optInt("fullLoad"))
                        .append(" · last: ").append(opens.optInt("lastMs")).append(" ms\n");
            }
        }
        JSONObject dg = stats.optJSONObject("diag");
        if (dg != null) {
            JSONArray ms = dg.optJSONArray("storyMs");
            b.append("\nSpeed\n")
                    .append("  Stories took: ").append(ms == null || ms.length() == 0 ? "not opened yet" : ms.toString().replace(",", ", ") + " ms").append('\n')
                    .append("  Instagram slow-downs: ").append(dg.optInt("s429") + dg.optInt("pleaseWait"))
                    .append(" · server errors: ").append(dg.optInt("s5xx")).append('\n')
                    .append("  Page stalls: ").append(dg.optInt("longTasks"))
                    .append(" (longest ").append(dg.optInt("longestTask")).append(" ms)\n")
                    .append("  Story swipes took: ").append(storySwitches(dg.optJSONArray("storySwitch")))
                    .append(" · over 4 s: ").append(dg.optInt("storySwitchSlow")).append('\n')
                    .append("  Story touches let go: ").append(dg.optInt("storyCancels")).append('\n');
            JSONObject fv = dg.optJSONObject("fullVideo");
            if (fv != null) {
                b.append("\nFull-screen video\n")
                        .append("  Posts and Reels (swipe down): ").append(fv.optInt("r8"))
                        .append(" · didn't open: ").append(fv.optInt("r8Failed")).append('\n')
                        .append("  Reels in Stories (swipe up): ").append(fv.optInt("r9"))
                        .append(" · not found: ").append(fv.optInt("r9Missing"))
                        .append(" · Story moved on: ").append(fv.optInt("r9Moved"))
                        .append(" · from the card: ").append(fv.optInt("r9Pressed")).append('\n')
                        .append("  Feed and post videos (one tap): ").append(fv.optInt("r10"))
                        .append(" · double taps (likes): ").append(fv.optInt("r10Doubles"))
                        .append(" · from the menu: ").append(fv.optInt("r10Menu"))
                        .append(" (taps made ").append(videoTaps).append(", held ").append(videoTapsHeld).append(")\n")
                        .append("  Back to the post or Story: ").append(fv.optInt("exits")).append('\n');
            }
            // R12: what was shown and done over a Story's Reel (counts only).
            JSONObject ri = stats.optJSONObject("reelInfo");
            if (ri != null) {
                b.append("  Story Reel details shown: ").append(ri.optInt("shown"))
                        .append(" · no details: ").append(ri.optInt("noInfo")).append('\n')
                        .append("    likes ").append(actionCounts(ri, "like", "unlike"))
                        .append(" · saves ").append(actionCounts(ri, "save", "unsave"))
                        .append(" · follows ").append(actionCounts(ri, "follow", null)).append('\n')
                        .append("    held back while Instagram slowed down: ").append(ri.optInt("slowed"))
                        .append(" · comments opened: ").append(ri.optInt("comments"))
                        .append(" (over the Story ").append(commentsOverOpens).append(")")
                        .append(" · shares: ").append(ri.optInt("shares"))
                        .append(" · profiles: ").append(ri.optInt("profile")).append('\n');
            }
        }
        b.append("\nElsewhere\n")
                .append("  Ads removed (Stories etc.): ").append(stats.optInt("ads")).append('\n')
                .append("  Endless-Reels items blocked: ").append(stats.optInt("chainingTrimmed")).append('\n')
                .append("  Reel swipes blocked: ").append(stats.optInt("swipesBlocked")).append('\n');
        // B24: a Reel sent in a DM (counts only).
        JSONObject dmReel = stats.optJSONObject("dmReel");
        if (dmReel != null) {
            b.append("  DM Reels: suggested removed ").append(dmReel.optInt("trimmed"))
                    .append(" · swipes held ").append(dmReel.optInt("swipes"))
                    .append(" · hidden on screen ").append(dmReel.optInt("hidden"))
                    .append(" (put back ").append(dmReel.optInt("returned"))
                    .append(", stuck ").append(dmReel.optInt("stuck")).append(")\n");
        }
        b.append("  Explore items removed: ").append(stats.optInt("exploreBlanked")).append('\n')
                .append("  Suggested accounts removed: ").append(stats.optInt("suggestionsBlanked")).append('\n');
        if (dom != null) {
            b.append("\nBackup filter (hidden on screen)\n")
                    .append("  Ads: ").append(dom.optInt("ads"))
                    .append("  Suggested: ").append(dom.optInt("suggested"))
                    .append("  Reposts: ").append(dom.optInt("reposts")).append('\n')
                    .append("  App banners: ").append(dom.optInt("banners")).append('\n');
        }
        JSONObject device = deviceDiagnostics();
        b.append("\nApp\n")
                .append("  WebView: ").append(device.optString("webView")).append('\n')
                .append("  Android memory callbacks: ").append(trimLog.isEmpty() ? "none" : String.join(", ", trimLog)).append('\n')
                .append("  Full-screen views: ").append(fullScreens)
                .append(fullScreens > 0 ? " (last: " + fullScreenLast + ")" : "")
                .append(" · nested: ").append(fullScreenNested);
        String pageFull = dg == null ? "" : dg.optString("fullscreenLast");
        if (!pageFull.isEmpty()) b.append(" · page: ").append(pageFull);
        b.append('\n')
                .append("  Page restarts: ").append(device.optInt("rendererGone"));
        String last = device.optString("rendererGoneLast");
        if (!last.isEmpty()) b.append(" (last: ").append(last).append(')');
        b.append('\n');
        b.append("  Page loads since the app started: ").append(startsAll)
                .append(" (app: open ").append(startsLoadUrl).append(", back ").append(startsGoBack)
                .append(", refresh ").append(startsReload).append(")\n")
                .append("  Back presses in the page: ").append(backPresses).append('\n')
                .append("  Comment box: ").append(commentsLine(commentsLayout)).append('\n');
        appendTouchStatus(b, stats.optJSONObject("b25"));
        appendBootStatus(b);
        b.append("\nCounts since the page last loaded. No account names or post details are kept.");
        final JSONObject page = pageAnswered ? stats : null;
        dialog().setTitle("Filter status").setMessage(b.toString())
                .setNeutralButton("Copy details", (d, w) -> copyDetails(page, device))
                .setPositiveButton("OK", null).show();
    }

    /** Filter status: a short "Starting Instagram" section (B33). */
    private void appendBootStatus(StringBuilder b) {
        JSONArray log = ringOf("bootLog");
        int booted = 0, stuck = 0;
        for (int i = 0; i < log.length(); i++) {
            JSONObject e = log.optJSONObject(i);
            String o = e == null ? "" : e.optString("outcome");
            if (o.startsWith("booted")) booted++;
            else if (o.startsWith("stuck") || o.startsWith("busy")) stuck++;
        }
        String lastStuck = prefs.getString("lastStuck", "");
        String when = "";
        try {
            if (!lastStuck.isEmpty()) when = new JSONObject(lastStuck).optString("at");
        } catch (JSONException ignored) {
            // Shown without a time.
        }
        b.append("\nStarting Instagram\n")
                .append("  Last ").append(log.length()).append(" page starts: ").append(booted).append(" started, ")
                .append(stuck).append(" stuck").append(when.isEmpty() ? "" : " (last at " + when + ")").append('\n')
                .append("  Reloads by itself: ").append(ringOf("reloadLog").length())
                .append(" · page view rebuilt: ").append(ringOf("rebuildLog").length())
                .append(" · loads without filters: ").append(prefs.getInt("plainBoots", 0)).append('\n')
                .append("  Network errors kept: ").append(ringOf("netErrors").length())
                .append(" · network now: ").append(netWatch.netOk() ? "usable" : "blocked or none")
                .append(" · Data Saver: ").append(netWatch.restrictStatus()).append('\n');
    }

    /** Milliseconds as "12.3 s". */
    private static String seconds(int ms) {
        return String.format(Locale.ROOT, "%.1f s", ms / 1000.0);
    }

    private static final String[] COMMENTS_KEYS = {"boxes", "gapBefore", "gapAfter", "barH", "fieldH", "opened", "scrolled", "reverted"};
    private static final String[] COMMENTS_FIXES = {"offset", "padding", "margin", "spacer"};

    /** Only the known numbers from the comments page's report, whatever else it sends. */
    static JSONObject commentsShape(JSONObject m) {
        JSONObject out = new JSONObject();
        try {
            for (String k : COMMENTS_KEYS) {
                if (m.opt(k) instanceof Number) out.put(k, Math.max(-9999, Math.min(9999, m.optInt(k))));
            }
            JSONObject fixes = m.optJSONObject("fixes");
            JSONObject f = new JSONObject();
            for (String k : COMMENTS_FIXES) {
                if (fixes != null && fixes.opt(k) instanceof Number) f.put(k, Math.max(0, Math.min(9999, fixes.optInt(k))));
            }
            out.put("fixes", f);
        } catch (JSONException e) {
            // Keys are constants; not reachable.
        }
        return out;
    }

    /** "gap under it 50 → 0 px, 44 px high (padding 1, margin 1)": the comment box's layout. */
    static String commentsLine(JSONObject c) {
        if (c == null) return "not opened yet";
        StringBuilder b = new StringBuilder();
        b.append("gap under it ").append(c.has("gapBefore") ? String.valueOf(c.optInt("gapBefore")) : "?")
                .append(" → ").append(c.has("gapAfter") ? String.valueOf(c.optInt("gapAfter")) : "?").append(" px, ")
                .append(c.optInt("barH")).append(" px high");
        JSONObject f = c.optJSONObject("fixes");
        StringBuilder fx = new StringBuilder();
        for (String k : COMMENTS_FIXES) {
            int n = f == null ? 0 : f.optInt(k);
            if (n > 0) fx.append(fx.length() > 0 ? ", " : "").append(k).append(' ').append(n);
        }
        if (fx.length() > 0) b.append(" (").append(fx).append(')');
        if (c.optInt("reverted") > 0) b.append(" · put back ").append(c.optInt("reverted"));
        b.append(" · typed in ").append(c.optInt("opened"));
        return b.toString();
    }

    /** "back 900 ms (address 120), next 400 ms": timings only. */
    private static String storySwitches(JSONArray list) {
        if (list == null || list.length() == 0) return "none yet";
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < list.length(); i++) {
            JSONObject e = list.optJSONObject(i);
            if (e == null) continue;
            if (b.length() > 0) b.append(", ");
            b.append("back".equals(e.optString("dir")) ? "back " : "next ").append(e.optInt("ms")).append(" ms");
            if (e.optInt("urlMs", -1) >= 0) b.append(" (address ").append(e.optInt("urlMs")).append(')');
        }
        return b.length() == 0 ? "none yet" : b.toString();
    }

    /** "sent/ok/refused" for an action and its undo (R12; counts only). */
    private static String actionCounts(JSONObject ri, String a, String undo) {
        JSONObject x = ri.optJSONObject(a), y = undo == null ? null : ri.optJSONObject(undo);
        int sent = (x == null ? 0 : x.optInt("sent")) + (y == null ? 0 : y.optInt("sent"));
        int ok = (x == null ? 0 : x.optInt("ok")) + (y == null ? 0 : y.optInt("ok"));
        int no = (x == null ? 0 : x.optInt("refused") + x.optInt("friction")) + (y == null ? 0 : y.optInt("refused"));
        return sent + " sent, " + ok + " ok, " + no + " refused";
    }

    private JSONObject deviceDiagnostics() {
        JSONObject n = new JSONObject();
        try {
            PackageInfo p = WebViewCompat.getCurrentWebViewPackage(this);
            n.put("app", BuildConfig.VERSION_NAME);
            n.put("android", Build.VERSION.SDK_INT);
            n.put("webView", p != null ? p.versionName : "unknown");
            n.put("memoryWarnings", new JSONArray(trimLog));
            n.put("fullScreens", fullScreens);
            n.put("fullScreenLast", fullScreenLast);
            n.put("fullScreenNested", fullScreenNested);
            n.put("videoTaps", videoTaps);
            n.put("videoTapsHeld", videoTapsHeld);
            n.put("commentsOverFull", commentsOverOpens);
            n.put("continueHome", continueHome());
            n.put("rendererGone", prefs.getInt("rendererGone", 0));
            n.put("rendererGoneLast", prefs.getString("rendererGoneLast", ""));
            n.put("resumed", resumed);
            n.put("clock", NetWatch.clock());
            if (commentsLayout != null) n.put("comments", commentsLayout);
            n.put("pageStarts", new JSONObject().put("all", startsAll).put("loadUrl", startsLoadUrl)
                    .put("goBack", startsGoBack).put("reload", startsReload).put("backPresses", backPresses));
            n.put("b25", touchDiagnostics());
        } catch (JSONException e) {
            // Partial details are still useful.
        }
        return n;
    }

    // The page's feed trail (counts and shapes only), kept across restarts so a
    // report sent after restarting still shows what happened before.
    private static final int TRAIL_MAX = 40;

    private JSONArray trail() {
        return ringOf("feedTrail");
    }

    private void keepTrail(JSONObject entry) {
        if (entry == null || entry.toString().length() > 800) return;
        ring("feedTrail", TRAIL_MAX, entry);
    }

    /** A ring of entries kept in prefs (counts and shapes only), newest last; it survives a rebuild. */
    private void ring(String key, int max, JSONObject entry) {
        if (entry == null || entry.toString().length() > 2000) return;
        JSONArray old = ringOf(key);
        JSONArray kept = new JSONArray();
        for (int i = Math.max(0, old.length() - (max - 1)); i < old.length(); i++) kept.put(old.opt(i));
        kept.put(entry);
        prefs.edit().putString(key, kept.toString()).apply();
    }

    private JSONArray ringOf(String key) {
        try {
            return new JSONArray(prefs.getString(key, "[]"));
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    /** Counts and data shapes only, for pasting into a bug report. Works without the page (stats null). */
    private void copyDetails(JSONObject stats, JSONObject device) {
        JSONObject all = new JSONObject();
        try {
            all.put("device", device);
            if (stats != null) {
                // The page's trail is the newest part of the kept one.
                JSONObject page = new JSONObject(stats.toString());
                page.remove("trail");
                all.put("page", page);
            } else {
                all.put("page", JSONObject.NULL);
            }
            all.put("trail", trail());
            all.put("net", netBlock());
            all.put("boot", bootBlock());
        } catch (JSONException e) {
            return;
        }
        lastDetails = all.toString();
        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (cm == null) return;
        cm.setPrimaryClip(ClipData.newPlainText("SimpleGram details", lastDetails));
        toast(stats == null ? "Details copied (the page didn't answer): paste them into your message"
                : "Details copied: paste them into your message");
    }

    /** The net block: what Android let the network do, built by the app alone (B33). */
    private JSONObject netBlock() throws JSONException {
        JSONArray errors = ringOf("netErrors");
        JSONObject byHost = new JSONObject();
        for (int i = 0; i < errors.length(); i++) {
            JSONObject e = errors.optJSONObject(i);
            String k = e == null ? "other" : e.optString("host", "other");
            byHost.put(k, byHost.optInt(k) + 1);
        }
        BootWatch w = watch;
        JSONObject hurt = new JSONObject();
        if (w != null) hurt.put("seq", w.seq).put("hurt", w.hurt).put("why", w.hurtWhy);
        return new JSONObject()
                .put("now", netWatch.state())
                .put("restrictChanges", ringOf("netStatus"))
                .put("netErrors", errors)
                .put("errorsByHost", byHost)
                .put("hurt", hurt)
                .put("tip", new JSONObject().put("shown", prefs.getBoolean("dataSaverTip", false))
                        .put("at", prefs.getString("dataSaverTipAt", "")).put("due", tipDue));
    }

    /** The boot block: page starts, the stuck record, reloads and rebuilds (B33). */
    private JSONObject bootBlock() throws JSONException {
        BootWatch w = watch;
        JSONObject now = new JSONObject();
        if (w != null) {
            now.put("seq", w.seq).put("how", w.how).put("shownMs", w.shown()).put("booted", w.booted)
                    .put("stuck", w.stuck).put("hurt", w.hurtWhy).put("pageToken", !w.pageToken.isEmpty())
                    .put("hasRecord", w.record != null);
        }
        JSONObject c = new JSONObject();
        if (chain != null) c.put("reloads", chain.reloads).put("tryAgains", chain.tryAgains).put("plain", chain.plain);
        JSONObject b = new JSONObject()
                .put("bootLog", ringOf("bootLog"))
                .put("lifecycle", ringOf("lifecycle"))
                .put("reloadLog", ringOf("reloadLog"))
                .put("rebuildLog", ringOf("rebuildLog"))
                .put("watch", now)
                .put("chain", c)
                .put("chip", bootChipKind)
                .put("chipsShown", bootChipsShown)
                .put("lateMessages", bootLate)
                .put("pendingNetReload", pendingNetReload)
                .put("pendingResumeReload", resumeReload != null)
                .put("plainBoots", prefs.getInt("plainBoots", 0))
                .put("plainNext", plainBootOn)
                .put("autoReloads10min", ringOf("autoReloads").length());
        for (String k : new String[]{"lastStuck", "rebuildRecord"}) {
            String v = prefs.getString(k, "");
            if (v.isEmpty()) continue;
            try {
                b.put(k, new JSONObject(v));
            } catch (JSONException e) {
                b.put(k, "unreadable");
            }
        }
        return b;
    }

    /* ------------------------------------------------------------------ *
     * Downloads
     * ------------------------------------------------------------------ */

    private void startDownloads(JSONArray items) {
        if (items == null) return;
        String ua = web.getSettings().getUserAgentString();
        int started = 0;
        for (int i = 0; i < items.length(); i++) {
            JSONObject it = items.optJSONObject(i);
            if (it == null) continue;
            if (downloads.enqueue(it.optString("url"), it.optString("name"), "video".equals(it.optString("kind")), ua)) {
                started++;
            }
        }
        if (started == 0) toast("This can't be downloaded");
        else toast(started == 1 ? "Downloading…" : "Downloading " + started + " items…");
    }

    private static String noun(JSONObject item) {
        return item != null && "video".equals(item.optString("kind")) ? "video" : "photo";
    }

    private void askDownload(JSONObject current, JSONArray all) {
        if (all == null || all.length() == 0) {
            if (current != null) startDownloads(new JSONArray().put(current));
            return;
        }
        List<String> labels = new ArrayList<>();
        List<JSONArray> picks = new ArrayList<>();
        if (current != null) {
            labels.add("This " + noun(current));
            picks.add(new JSONArray().put(current));
        }
        labels.add("All " + all.length() + " in this post");
        picks.add(all);
        if (current == null) {
            for (int i = 0; i < all.length(); i++) {
                labels.add("Item " + (i + 1) + " (" + noun(all.optJSONObject(i)) + ")");
                picks.add(new JSONArray().put(all.optJSONObject(i)));
            }
        }
        dialog().setTitle("Download")
                .setItems(labels.toArray(new String[0]), (d, w) -> startDownloads(picks.get(w)))
                .setNegativeButton("Cancel", null).show();
    }

    private void chooseDownload(JSONArray choices) {
        if (choices == null || choices.length() == 0) return;
        String[] labels = new String[choices.length()];
        for (int i = 0; i < labels.length; i++) {
            JSONObject c = choices.optJSONObject(i);
            labels[i] = c == null ? "Item " + (i + 1) : c.optString("label", "Item " + (i + 1));
        }
        dialog().setTitle("Which video?")
                .setItems(labels, (d, w) -> startDownloads(new JSONArray().put(choices.optJSONObject(w))))
                .setNegativeButton("Cancel", null).show();
    }

    /* ------------------------------------------------------------------ *
     * Screenshot mode
     * ------------------------------------------------------------------ */

    private void enterScreenshot() {
        if (screenshotMode) return;
        screenshotMode = true;
        if (storyMode()) zoom.hold();
        setTabShown(false);
        zoomChip.setVisibility(View.GONE);
        updateFeedBar();                      // hidden while screenshotMode, back afterwards
        setSystemBarsHidden(true);
        screenshotShield = new View(this);
        screenshotShield.setOnClickListener(v -> exitScreenshot());
        root.addView(screenshotShield, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        toast("Tap the screen to bring controls back");
    }

    private void exitScreenshot() {
        if (!screenshotMode) return;
        screenshotMode = false;
        if (screenshotShield != null) root.removeView(screenshotShield);
        screenshotShield = null;
        if (!fullHidTab) setTabShown(true);
        if (customView == null) setSystemBarsHidden(false);
        onZoomChanged(zoom.scale());
        zoom.releaseHold();
        updateFeedBar();
    }

    /**
     * B26: only the status bar (clock, battery) ever hides. The Android buttons
     * at the bottom (Back, Home, Recent apps) stay in every full screen (R8/R10,
     * R9's Reel layer, Instagram's own Stories) and in screenshot mode: hiding
     * them needs a swipe up from the bottom edge to get them back, and that
     * swipe reaches the page too. The window keeps its room above the buttons,
     * so nothing is drawn under them.
     */
    @SuppressWarnings("deprecation")
    private void setSystemBarsHidden(boolean hidden) {
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c == null) return;
            if (hidden) {
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                c.hide(WindowInsets.Type.statusBars());
            } else {
                c.show(WindowInsets.Type.statusBars());
            }
        } else {
            View d = getWindow().getDecorView();
            d.setSystemUiVisibility(hidden ? View.SYSTEM_UI_FLAG_FULLSCREEN : 0);
        }
    }

    /* ------------------------------------------------------------------ *
     * Lifecycle, intents and Back
     * ------------------------------------------------------------------ */

    private void handleIntent(Intent intent, boolean fresh) {
        String target = null;
        if (intent != null && Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getData() != null) {
            target = Links.normalize(intent.getData().toString());
        } else if (intent != null && Intent.ACTION_SEND.equals(intent.getAction())) {
            target = Links.fromText(intent.getStringExtra(Intent.EXTRA_TEXT));
            if (target == null) toast("That isn't an Instagram link");
        }
        if (target != null) {
            startHow = "link";
            loadMain(target);
        } else if (fresh) {
            startHow = "cold";
            load(web, Links.HOME);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent, false);
    }

    /**
     * WebView's own full-screen view takes focus when the WebView had it (after
     * any typing) and ends full screen on Back itself, before onBackPressed: a
     * Story Reel's Back would close the whole Story. While a full-screen view,
     * R9's Reel or screenshot mode is up, Back is taken here first and goes
     * through onBackPressed, in its usual order.
     */
    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        if (e.getKeyCode() == KeyEvent.KEYCODE_BACK && (pageVideo || customView != null || screenshotMode)) {
            if (e.getAction() == KeyEvent.ACTION_UP && !e.isCanceled()) onBackPressed();
            return true;
        }
        return super.dispatchKeyEvent(e);
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        if (screenshotMode) {
            exitScreenshot();
        } else if ((commentsOverFull || pageVideo) && comments.isOpen()) {
            // R12: the comments over a Story's Reel close first; the Reel stays.
            if (!comments.goBack()) closeComments();
        } else if (pageVideo) {
            // Back to the Story under the Reel; its full screen stays.
            setPageVideo(false);
            js("fullVideoExit");
        } else if (customView != null) {
            hideCustomView("back");
        } else if (zoom.isZoomed()) {
            zoom.reset(true);
        } else if (comments.isOpen()) {
            if (!comments.goBack()) closeComments();
        } else if (searchOpen) {
            // SimpleGram's search screen closes first (a tag/place page, then search).
            final boolean[] done = {false};
            web.evaluateJavascript("!!(window.__sg&&window.__sg.back&&window.__sg.back())", handled -> {
                if (done[0]) return;
                done[0] = true;
                if (!"true".equals(handled)) pageBack();
            });
            // A page too busy to answer in time (e.g. drawing a result it is
            // opening, while the route still says Home) gets nothing on this
            // press: a late answer must never leave the app.
            ui.postDelayed(() -> done[0] = true, 600);
        } else {
            pageBack();
        }
    }

    /** Back within Instagram's pages; from the Home feed itself, leave the app like Instagram does. */
    private void pageBack() {
        String url = web.getUrl();
        boolean feedVariant = url != null && url.contains("variant=") && !url.contains("variant=home");
        if (web.canGoBack() && (!"home".equals(route) || feedVariant)) {
            backPresses++;
            goBackAt = SystemClock.uptimeMillis();
            web.goBack();
        } else {
            moveTaskToBack(true);
        }
    }

    private void setAwake(boolean on) {
        if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    @Override
    protected void onStart() {
        super.onStart();
        lifecycle("start");
    }

    @Override
    protected void onPause() {
        super.onPause();
        resumed = false;
        netWatch.setResumed(false);
        lifecycle("pause");
        pauseWatchClock();
        markHurt("pause");
        setAwake(false);
        web.onPause();
        comments.web().onPause();
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onResume() {
        super.onResume();
        resumed = true;
        netWatch.setResumed(true);
        lifecycle("resume");
        readRestrictStatus("resume");
        resumeWatchClock();
        web.onResume();
        comments.web().onResume();
        if (pendingRecreate) {
            // The renderer went while the app was away: start over now, on screen.
            pendingRecreate = false;
            ui.post(this::recreate);
            return;
        }
        if (deferredSwap != null) {
            Runnable swap = deferredSwap;
            deferredSwap = null;
            ui.post(swap);
        }
        if (resumeReload != null) {
            // The ladder's reload came due while Cam was away: after a moment to settle.
            Runnable reload = resumeReload;
            resumeReload = null;
            if (chain != null) chain.deferred = 0;
            ui.postDelayed(reload, bootSettleMs);
        }
        BootWatch w = watch;
        if (w != null && w.hurt && !w.booted && !w.stuck && !w.recovering) scheduleResumeRecovery(w);
    }

    /**
     * B33: a page that hasn't booted when the app leaves the screen (or its
     * network is blocked or lost) is marked hurt: its files may have failed or
     * stalled, which leaves Instagram's logo up for good. Checked on resume.
     */
    private void markHurt(String why) {
        BootWatch w = watch;
        if (w == null || w.booted) return;
        w.hurt = true;
        if (!w.hurtWhy.contains(why) && w.hurtWhy.length() < 60) w.hurtWhy += (w.hurtWhy.isEmpty() ? "" : " ") + why;
        if (w.log != null) bootOutcome(w, w.log.optString("outcome", "loading"));
    }

    /**
     * Recovery on resume for a hurt page: once the network is usable (or a
     * second has passed with no word from the callback), another second to
     * settle, then the page is asked whether the logo is still up. If it is,
     * or the page is WebView's error page, one reload through the watchdog's
     * budget (never restoreState). No answer: busy, Try again offered, no reload.
     */
    private void scheduleResumeRecovery(BootWatch w) {
        w.recovering = true;
        final long since = SystemClock.uptimeMillis();
        Runnable[] wait = new Runnable[1];
        wait[0] = () -> {
            if (watch != w || w.booted || w.stuck || !resumed || isDestroyed()) {
                w.recovering = false;
                return;
            }
            boolean ok = netWatch.netOk() || (!netWatch.isKnown() && SystemClock.uptimeMillis() - since >= bootSettleMs);
            if (!ok) {
                ui.postDelayed(wait[0], 500);        // the watchdog's cap runs on regardless
                return;
            }
            ui.postDelayed(() -> resumeCheck(w, 0), bootSettleMs);
        };
        ui.post(wait[0]);
    }

    private void resumeCheck(BootWatch w, int tries) {
        if (watch != w || w.booted || w.stuck || !resumed || isDestroyed()) {
            w.recovering = false;
            return;
        }
        if (reloadGate() != null) {
            if (tries < 30) ui.postDelayed(() -> resumeCheck(w, tries + 1), bootSettleMs);
            else w.recovering = false;
            return;
        }
        probe(w, answer -> {
            w.recovering = false;
            if (watch != w || w.booted || w.stuck) return;
            if (answer == null) {
                w.stuck = true;
                bootOutcome(w, "busy on resume after " + w.shown() + " ms shown");
                keepLastStuck(w, "resume", "busy");
                showBootChip("stuck");
                return;
            }
            w.probe = answer;
            boolean logo = answer.optBoolean("logo");
            boolean blank = answer.optInt("kids", -1) == 0 && !"complete".equals(answer.optString("ready"));
            if (!logo && !answer.optBoolean("error") && !blank) return;     // started after all: the watch goes on
            w.stuck = true;
            String rule = answer.optBoolean("error") ? "errorPage" : logo ? "logo" : "blank";
            bootOutcome(w, "stuck: " + rule + " (resume) after " + w.shown() + " ms shown");
            keepLastStuck(w, "resume", rule);
            recover(w, "resume " + rule);
        });
    }

    /**
     * Shown once, never during a start-up (only once a page has booted, or with
     * the chip up), and only after a stuck page tied to a block, while Data
     * Saver cuts this app off in the background and the network is metered.
     */
    private void maybeShowDataSaverTip() {
        if (!tipDue || prefs.getBoolean("dataSaverTip", false) || menuOpen || !hasWindowFocus() || isFinishing()) return;
        if (!"enabled".equals(netWatch.restrictStatus()) || !netWatch.isMetered()) return;
        tipDue = false;
        prefs.edit().putBoolean("dataSaverTip", true).putString("dataSaverTipAt", NetWatch.clock()).apply();
        dialog().setTitle("Data Saver")
                .setMessage("Data Saver is on, so Android cuts SimpleGram off the moment you switch apps. "
                        + "That can leave Instagram stuck on its logo. Let SimpleGram use data while Data Saver is on?\n\n"
                        + "(Android still pauses apps in the background after a while; SimpleGram now reloads by itself when that happens.)")
                .setPositiveButton("Open settings", (d, which) -> openDataSaverSettings())
                .setNegativeButton("Not now", null)
                .show();
    }

    private void openDataSaverSettings() {
        Intent i = new Intent(Settings.ACTION_IGNORE_BACKGROUND_DATA_RESTRICTIONS_SETTINGS, Uri.parse("package:" + getPackageName()));
        String manual = "Settings → Connections → Data usage → Data saver → Allowed to use data while Data saver is on";
        try {
            if (i.resolveActivity(getPackageManager()) == null) {
                toast(manual);
                return;
            }
            startActivity(i);
        } catch (RuntimeException e) {
            toast(manual);
        }
    }

    @Override
    protected void onStop() {
        super.onStop();
        // The screen going off stops the Activity too: told apart for the record.
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        boolean off = pm != null && !pm.isInteractive();
        lifecycle(off ? "screenOff" : "stop");
        markHurt(off ? "screenOff" : "stop");
    }

    /**
     * B33: the ring of pause/resume/stop/start/memory events (times only, kept in
     * prefs). A page that was loading when the app left the screen is the
     * likeliest to be stuck on Instagram's logo.
     */
    private void lifecycle(String event) {
        try {
            ring("lifecycle", 20, new JSONObject().put("ev", event).put("at", NetWatch.clock()));
        } catch (JSONException ignored) {
            // Not reachable with constant keys.
        }
    }

    /**
     * Data Saver's status for this app, re-read when the app comes back and when
     * Android says it changed (a protected broadcast: registered here, not in the
     * manifest). Changes are kept with their times.
     */
    private void registerRestrictReceiver() {
        try {
            IntentFilter f = new IntentFilter(ConnectivityManager.ACTION_RESTRICT_BACKGROUND_CHANGED);
            if (Build.VERSION.SDK_INT >= 33) registerReceiver(restrictReceiver, f, Context.RECEIVER_NOT_EXPORTED);
            else registerReceiver(restrictReceiver, f);
            restrictReceiverOn = true;
        } catch (RuntimeException ignored) {
            // Without it the status is still read on every resume.
        }
    }

    private void readRestrictStatus(String why) {
        String now = netWatch.restrictStatus();
        if (now.equals(prefs.getString("restrictStatus", ""))) return;
        prefs.edit().putString("restrictStatus", now).apply();
        try {
            ring("netStatus", 10, new JSONObject().put("status", now).put("why", why).put("at", NetWatch.clock()));
        } catch (JSONException ignored) {
            // Not reachable with constant keys.
        }
    }


    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        boolean night = (newConfig.uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        if (night != dark) {
            dark = night;
            applyTheme();
        }
    }

    /** Recolours the native parts (dialogs read `dark` when they open). */
    private void applyTheme() {
        int bg = dark ? Color.BLACK : Color.WHITE;
        root.setBackgroundColor(bg);
        web.setBackgroundColor(bg);
        comments.setDark(dark);
        feedBg.setColor(dark ? 0xF2262626 : 0xF2FFFFFF);
        feedBg.setStroke(dp(1), dark ? 0x33FFFFFF : 0x22000000);
        feedTitle.setTextColor(dark ? Color.WHITE : Color.BLACK);
        feedSub.setTextColor(dark ? 0xFFA8A8A8 : 0xFF737373);
    }

    // Android's memory callbacks since the app started, newest last (Filter status).
    // Static so they survive the recreate() after the renderer is lost.
    private static final ArrayList<String> trimLog = new ArrayList<>();

    @Override
    public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        if (level == TRIM_MEMORY_UI_HIDDEN) {         // only "the app left the screen"
            lifecycle("uiHidden");
            return;
        }
        String name = level >= 80 ? "complete" : level >= 60 ? "moderate" : level >= 40 ? "background"
                : level >= 15 ? "critical" : level >= 10 ? "low" : "running moderate";
        lifecycle("trim " + name);
        trimLog.add(name + " at " + clock());
        if (trimLog.size() > 10) trimLog.remove(0);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (pendingState != null) out.putAll(pendingState);
        else web.saveState(out);
    }

    @Override
    protected void onDestroy() {
        if (pendingRebuild != null) {
            ui.removeCallbacks(pendingRebuild);
            pendingRebuild = null;
        }
        deferredSwap = null;
        rebuilding = false;
        closeWatch("destroyed");
        if (statusFallback != null) ui.removeCallbacks(statusFallback);
        downloads.release();
        netWatch.stop();
        if (restrictReceiverOn) {
            restrictReceiverOn = false;
            try {
                unregisterReceiver(restrictReceiver);
            } catch (RuntimeException ignored) {
                // Already gone.
            }
        }
        if (touchLast != null) {
            touchLast.recycle();
            touchLast = null;
        }
        for (Script s : scripts) {
            ViewGroup parent = (ViewGroup) s.view.getParent();
            if (parent != null) parent.removeView(s.view);
            s.view.destroy();
        }
        scripts.clear();
        super.onDestroy();
    }

    /* ------------------------------------------------------------------ *
     * B25: touches across full-screen switches, and the scrolling repair
     * ------------------------------------------------------------------ */

    /**
     * Every touch passes here first. The open sequence is tracked so that a
     * full-screen switch in the middle of it can cancel it where the page's
     * input lives (see splitTouch) and swallow the rest of it: the moves and
     * the lift of a split touch must reach no view at all.
     */
    @Override
    public boolean dispatchTouchEvent(MotionEvent ev) {
        int a = ev.getActionMasked();
        if (a == MotionEvent.ACTION_DOWN) {
            touchOpen = true;
            touchSwallow = false;
            touchAccepted = false;
            touchDownOn = customView != null ? RX_CUSTOM : RX_WEB;
            touchDownAt = ev.getEventTime();
            touchSeq++;
            touchStarted[touchDownOn]++;
        }
        if (!touchOpen) return super.dispatchTouchEvent(ev);   // the rest of a touch that began before this window had it
        if (touchLast != null) touchLast.recycle();
        touchLast = MotionEvent.obtain(ev);
        boolean end = a == MotionEvent.ACTION_UP || a == MotionEvent.ACTION_CANCEL;
        if (touchSwallow) {
            if (end) closeTouch();
            return true;
        }
        boolean handled;
        inTouchDispatch = true;
        try {
            handled = super.dispatchTouchEvent(ev);
        } finally {
            inTouchDispatch = false;
        }
        if (a == MotionEvent.ACTION_DOWN) {
            touchAccepted = handled;
        } else if (touchAccepted && !handled && a != MotionEvent.ACTION_CANCEL) {
            // The view that took the DOWN turned the rest down: what an input
            // that went inert under the finger does (counted once per touch).
            touchRefused[touchDownOn]++;
            touchAccepted = false;
        }
        if (end) closeTouch();
        return handled;
    }

    private void closeTouch() {
        touchOpen = false;
        touchSwallow = false;
        touchEnded[touchDownOn]++;
    }

    /** The view that takes the page's input inside a full-screen view (WebView's own is its first child). */
    private static View liveInput(View custom) {
        if (custom instanceof ViewGroup && ((ViewGroup) custom).getChildCount() > 0) return ((ViewGroup) custom).getChildAt(0);
        return custom;
    }

    /** A cancel built from the open touch's latest event (all its pointers), sent straight to a view. */
    private void cancelTo(View v) {
        if (v == null || touchLast == null) return;
        MotionEvent c = MotionEvent.obtain(touchLast);
        c.setAction(MotionEvent.ACTION_CANCEL);
        v.dispatchTouchEvent(c);
        c.recycle();
    }

    /** The app's held finger (ZoomFrame.hold) gets its cancel where the input is too. */
    private void cancelHoldTo(View v) {
        if (v == null) return;
        MotionEvent c = zoom.holdCancel();
        v.dispatchTouchEvent(c);
        c.recycle();
        cancelsHold++;
    }

    /**
     * Full screen just started: the touch that is down (if any) and the app's
     * held finger are cancelled for the views that now hold the input. Extra
     * cancels are harmless; a missing one is what B25 was.
     */
    private void splitTouch(boolean show, View... inputs) {
        if (zoom.isHolding()) for (View v : inputs) cancelHoldTo(v);
        if (!touchOpen || touchSwallow) return;
        for (View v : inputs) cancelTo(v);
        cancelTo(web);
        startSwallow(show);
    }

    private void startSwallow(boolean show) {
        if (show) cancelsShow++;
        else cancelsHide++;
        swallowedTouches++;
        touchSwallow = true;
        // The view tree lets go of the touch too (the menu tab, the zoom frame),
        // unless this runs inside a touch's own dispatch.
        if (!inTouchDispatch && touchLast != null) {
            MotionEvent c = MotionEvent.obtain(touchLast);
            c.setAction(MotionEvent.ACTION_CANCEL);
            getWindow().superDispatchTouchEvent(c);
            c.recycle();
        }
    }

    /**
     * R10 from the menu. Full screen needs a tap of yours, and a native menu gives
     * the page none, so the app taps the page's video for it once the menu has
     * gone: one finger, down and up at once, straight to the page view, through
     * the web engine's own input (a real, trusted tap). The page turns that tap
     * into full screen at once and keeps it from Instagram. B25: never while a
     * finger is down, a full-screen view is up or the zoom frame holds or owns
     * the page; the down and up go together, so no touch of yours can come
     * between them, and nothing the app holds is split.
     *
     * @param x the spot, in the page's CSS pixels
     * @param w the page's width in CSS pixels (the scale to the view's pixels)
     */
    private void tapVideoForPage(final double x, final double y, final double w, final int tries) {
        if (!(x >= 0) || !(y >= 0) || !(w > 0) || Double.isInfinite(x) || Double.isInfinite(y) || Double.isInfinite(w)) return;
        ui.postDelayed(() -> {
            if (isFinishing() || web == null) return;
            if (menuOpen || !hasWindowFocus()) {
                // The menu is still going away.
                if (tries < 10) tapVideoForPage(x, y, w, tries + 1);
                else videoTapsHeld++;
                return;
            }
            if (customView != null || touchOpen || zoom.isHolding() || zoom.isOwned() || zoom.isPinching()
                    || comments.isOpen() || zoom.isSplit()
                    || screenshotMode || pageVideo || rebuilding || web.getWidth() <= 0) {
                videoTapsHeld++;
                return;
            }
            float f = web.getWidth() / (float) w;
            float px = (float) (x * f), py = (float) (y * f);
            if (px >= web.getWidth() || py >= web.getHeight()) return;
            long t = SystemClock.uptimeMillis();
            MotionEvent.PointerProperties[] pp = {new MotionEvent.PointerProperties()};
            pp[0].id = 0;
            pp[0].toolType = MotionEvent.TOOL_TYPE_FINGER;
            MotionEvent.PointerCoords[] pc = {new MotionEvent.PointerCoords()};
            pc[0].x = px;
            pc[0].y = py;
            pc[0].pressure = 1f;
            pc[0].size = 0.05f;
            MotionEvent down = MotionEvent.obtain(t - 40, t - 40, MotionEvent.ACTION_DOWN, 1, pp, pc, 0, 0, 1f, 1f,
                    0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0);
            MotionEvent up = MotionEvent.obtain(t - 40, t, MotionEvent.ACTION_UP, 1, pp, pc, 0, 0, 1f, 1f,
                    0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0);
            web.dispatchTouchEvent(down);
            web.dispatchTouchEvent(up);
            down.recycle();
            up.recycle();
            videoTaps++;
        }, 150);
    }

    /** Leaves full screen the Back way: the view goes first, then Chromium is told. */
    private void hideCustomView(String initiator) {
        if (customView == null) return;
        hideInitiator = initiator;
        new Chrome().onHideCustomView();
    }

    /** One line of the full-screen log (shapes only). */
    private void logFullScreen(String kind, String initiator) {
        if (touchOpen) {
            if ("hide".equals(kind)) hideDuringTouch++;
            else showDuringTouch++;
        }
        try {
            JSONObject e = new JSONObject()
                    .put("kind", kind)
                    .put("route", route)
                    .put("initiator", initiator)
                    .put("touchOpen", touchOpen)
                    .put("pointers", touchOpen && touchLast != null ? touchLast.getPointerCount() : 0)
                    .put("downOn", touchOpen ? (touchDownOn == RX_CUSTOM ? "custom" : "web") : "")
                    .put("msSinceDown", touchOpen ? SystemClock.uptimeMillis() - touchDownAt : -1)
                    .put("holding", zoom.isHolding())
                    .put("orientation", getResources().getConfiguration().orientation);
            fsLog.add(e);
            while (fsLog.size() > 8) fsLog.remove(0);
        } catch (JSONException ignored) {
            // Not reachable with constant keys.
        }
    }

    private TextView makeStuckChip() {
        TextView chip = new TextView(this);
        chip.setText("Scrolling stopped. Tap to fix");
        chip.setTextColor(Color.WHITE);
        chip.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        chip.setTypeface(Typeface.DEFAULT_BOLD);
        chip.setGravity(Gravity.CENTER);
        chip.setPadding(dp(18), dp(10), dp(18), dp(10));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0xF20095F6);
        bg.setCornerRadius(dp(20));
        chip.setBackground(bg);
        chip.setElevation(dp(8));
        chip.setContentDescription("Scrolling stopped. Tap to fix");
        chip.setVisibility(View.GONE);
        // Only ever on a tap: the rebuild reloads the page.
        chip.setOnClickListener(v -> {
            stuckChipWanted = false;
            updateStuckChip();
            rebuildWebView("Scrolling chip", "scroll");
        });
        return chip;
    }

    private void updateStuckChip() {
        if (stuckChip == null || bootChip == null) return;
        boolean clear = customView == null && !pageVideo && !screenshotMode && !zoom.isZoomed();
        boolean boot = !bootChipKind.isEmpty() && clear;
        if (boot) {
            boolean offline = "offline".equals(bootChipKind), still = "still".equals(bootChipKind);
            bootChipText.setText(offline ? "No connection. SimpleGram will reload when you're back online"
                    : still ? "Still not starting. Check your connection, then Try again." : "Instagram didn't start");
            // Try again stays on the offline chip too: a wrong word from the network
            // callback (a stale loss, a VPN) may delay the reload, never leave Cam stuck.
            bootChipRetry.setVisibility(View.VISIBLE);
            bootChipPlain.setVisibility(still && (chain == null || !chain.plain) ? View.VISIBLE : View.GONE);
        }
        bootChip.setVisibility(boot ? View.VISIBLE : View.GONE);
        // One chip at a time: B33's has the slot while it is up.
        stuckChip.setVisibility(!boot && stuckChipWanted && clear ? View.VISIBLE : View.GONE);
    }

    /* ------------------------------------------------------------------ *
     * B33: Instagram didn't start
     * ------------------------------------------------------------------ */

    /**
     * One main-frame page start on an Instagram host, watched until the page
     * says Instagram booted (or it is left for another page). Its clock counts
     * on-screen time only: a page that loads while the app is in the
     * background is given its 30 s once it is back.
     */
    private final class BootWatch {
        final int seq;
        final WebView view;
        final String url, how;
        final long startedAt = SystemClock.uptimeMillis();
        long shownMs, shownSince;         // on-screen time so far; when the current stretch began (0 off screen)
        boolean booted, stuck, hurt, probing, recovering;
        String hurtWhy = "", pageToken = "";
        int probeMisses;                  // misses in the current probe round (two make a busy page)
        JSONObject probe;                 // the app's own probe's last answer
        JSONObject record;                // the page's latest boot record (shapes only)
        JSONObject log;                   // its bootLog entry, rewritten as the outcome changes

        BootWatch(WebView view, String url, String how) {
            // The logs are matched by this number, so it must never repeat: a new
            // Activity (a recreate, a fresh process) carries on from the last one.
            seq = bootSeq = prefs.getInt("bootSeq", 0) + 1;
            prefs.edit().putInt("bootSeq", bootSeq).apply();
            this.view = view;
            this.url = url;
            this.how = how;
        }

        long shown() {
            return shownMs + (shownSince == 0 ? 0 : SystemClock.uptimeMillis() - shownSince);
        }
    }

    /** The ladder's place for one page: kept across its automatic reloads and Try again rebuilds. */
    private static final class BootChain {
        int reloads, tryAgains, deferred;
        boolean plain;
    }

    private static boolean isRecoveryStart(String how) {
        return how.startsWith("reload ") || "Try again".equals(how) || "Load without filters".equals(how);
    }

    /** Every main-frame page start: the bootLog entry, the watch (Instagram hosts only) and the ladder's chain. */
    private void onMainPageStarted(WebView view, String url) {
        String how = !startHow.isEmpty() ? startHow
                : goBackAt != 0 && SystemClock.uptimeMillis() - goBackAt < 1500 ? "Back" : "page";
        startHow = "";
        if (reloadFollow != null) {
            ui.removeCallbacks(reloadFollow);         // the reload did start a page
            reloadFollow = null;
        }
        if (plainBootOn && !"Load without filters".equals(how)) {
            // The one load without filters is over (it never said so): back to the normal script.
            plainBootOn = false;
            for (Script sc : scripts) registerScript(sc);
        }
        closeWatch("left");
        if (!isRecoveryStart(how)) chain = null;
        boolean ig = url != null && Links.isInstagram(Uri.parse(url));
        if (!ig) {
            watch = null;
            netWatch.setPageToken(0);
            try {
                ring("bootLog", 10, new JSONObject().put("how", how).put("at", NetWatch.clock()).put("outcome", "other host"));
            } catch (JSONException ignored) {
                // Not reachable with constant keys.
            }
            return;
        }
        watch = new BootWatch(view, url, how);
        netWatch.setPageToken(watch.seq);
        try {
            watch.log = new JSONObject().put("seq", watch.seq).put("how", how).put("at", NetWatch.clock())
                    .put("route", route).put("home", Links.HOME.equals(url) || url.startsWith(Links.HOME + "?"))
                    .put("resumed", resumed).put("outcome", "loading");
            if (plainBootOn) watch.log.put("plain", true);
            ring("bootLog", 10, watch.log);
        } catch (JSONException ignored) {
            // Not reachable with constant keys.
        }
        pendingNetReload = false;
        resumeReload = null;
        if (!bootChipKind.isEmpty()) {
            bootChipKind = "";           // the new page gets its chance
            updateStuckChip();
        }
        if (resumed) {
            watch.shownSince = SystemClock.uptimeMillis();
            scheduleWatchTick();
        }
    }

    /** The watched page is being left (a new page, a rebuild): its entry gets its outcome. */
    private void closeWatch(String outcome) {
        BootWatch w = watch;
        if (watchTick != null) {
            ui.removeCallbacks(watchTick);
            watchTick = null;
        }
        if (probeTimeout != null) {
            ui.removeCallbacks(probeTimeout);
            probeTimeout = null;
        }
        if (w == null) return;
        if (!w.booted && !w.stuck) bootOutcome(w, outcome + " after " + w.shown() + " ms shown");
        watch = null;
    }

    private void bootOutcome(BootWatch w, String outcome) {
        if (w.log == null) return;
        try {
            w.log.put("outcome", outcome);
            if (w.hurt) w.log.put("hurt", w.hurtWhy);
            JSONArray old = ringOf("bootLog");
            JSONArray kept = new JSONArray();
            boolean found = false;
            for (int i = 0; i < old.length(); i++) {
                JSONObject e = old.optJSONObject(i);
                if (e != null && e.optInt("seq", -1) == w.seq) {
                    kept.put(w.log);
                    found = true;
                } else {
                    kept.put(old.opt(i));
                }
            }
            if (!found) kept.put(w.log);
            prefs.edit().putString("bootLog", kept.toString()).apply();
        } catch (JSONException ignored) {
            // Not reachable with constant keys.
        }
    }

    private void pauseWatchClock() {
        BootWatch w = watch;
        if (w != null && w.shownSince != 0) {
            w.shownMs += SystemClock.uptimeMillis() - w.shownSince;
            w.shownSince = 0;
        }
        if (watchTick != null) {
            ui.removeCallbacks(watchTick);
            watchTick = null;
        }
    }

    private void resumeWatchClock() {
        BootWatch w = watch;
        if (w == null || w.booted || w.stuck) return;
        if (w.shownSince == 0) w.shownSince = SystemClock.uptimeMillis();
        scheduleWatchTick();
    }

    /** The cap: 30 s of on-screen time with no word from the page. The network state never delays it. */
    private void scheduleWatchTick() {
        if (watchTick != null) ui.removeCallbacks(watchTick);
        watchTick = null;
        final BootWatch w = watch;
        if (w == null || w.booted || w.stuck || !resumed) return;
        Runnable tick = new Runnable() {
            @Override
            public void run() {
                if (watchTick == this) watchTick = null;
                if (watch != w || w.booted || w.stuck || !resumed || isDestroyed()) return;
                onWatchFired(w);
            }
        };
        watchTick = tick;
        ui.postDelayed(tick, Math.max(0, bootWatchMs - w.shown()));
    }

    /**
     * The page's token: its own per-document id, adopted from its first boot
     * message. A message with another token is from another document (one
     * already left) and must never act on this page. Nor may a late message
     * from the old document be taken for the new one's first: a "stuck" or a
     * record within the first second of a start (no rule fires that soon), or
     * a "booted" that took longer than the page has existed, is left aside.
     */
    private boolean pageTokenOk(BootWatch w, JSONObject m, long minAgeMs) {
        String token = m.optString("token", "");
        long age = SystemClock.uptimeMillis() - w.startedAt;
        if (!w.pageToken.isEmpty()) {
            if (token.equals(w.pageToken)) return true;
            bootLate++;
            return false;
        }
        if (age < minAgeMs || (m.has("ms") && m.optLong("ms") > age + 1000)) {
            bootLate++;
            return false;
        }
        w.pageToken = token;
        return true;
    }

    private void onBoot(JSONObject m) {
        BootWatch w = watch;
        if (w == null || w.booted || !pageTokenOk(w, m, 0)) return;
        w.booted = true;
        if (watchTick != null) {
            ui.removeCallbacks(watchTick);
            watchTick = null;
        }
        String how = m.optString("how", "");
        bootOutcome(w, "booted in " + Math.max(0, Math.min(600_000, m.optLong("ms"))) + " ms (" + (how.length() > 12 ? "?" : how) + ")");
        chain = null;
        pendingNetReload = false;
        resumeReload = null;
        if (!bootChipKind.isEmpty()) {
            bootChipKind = "";
            updateStuckChip();
        }
        if (plainBootOn) {
            // The one load without filters has started: the next page is a normal one.
            plainBootOn = false;
            for (Script s : scripts) registerScript(s);
        }
        maybeShowDataSaverTip();
    }

    private void onBootStuck(JSONObject m) {
        BootWatch w = watch;
        if (w == null || w.booted || !pageTokenOk(w, m, 1000)) return;
        String rule = m.optString("rule", "?");
        if (rule.length() > 24) rule = rule.substring(0, 24);
        JSONObject record = capped(m.optJSONObject("record"));
        if (record != null) w.record = record;
        if (w.stuck) {
            // The app's own probe spoke first (its cap and the page's rule (c) share
            // the 30 s mark): the ladder is already running, but the page's record is
            // the fuller evidence, so it joins what was kept.
            String after = w.probe != null ? "after probe" : "after busy";
            bootOutcome(w, "stuck: " + rule + " (page, " + after + ") after " + w.shown() + " ms shown");
            keepLastStuck(w, "page " + after, rule);
            return;
        }
        w.stuck = true;
        bootOutcome(w, "stuck: " + rule + " after " + w.shown() + " ms shown");
        keepLastStuck(w, "page", rule);
        recover(w, "page " + rule);
    }

    private void onBootRecord(JSONObject m) {
        BootWatch w = watch;
        if (w == null || !pageTokenOk(w, m, 1000)) return;
        w.record = capped(m.optJSONObject("record"));
    }

    /** The page's record, as sent (shapes and counts by design), but never a large one. */
    private static JSONObject capped(JSONObject record) {
        if (record == null || record.toString().length() > 6000) return null;
        return record;
    }

    /** The stuck page's state (the page's record, the app's probe, or both), kept in prefs for Copy details. */
    private void keepLastStuck(BootWatch w, String from, String rule) {
        try {
            JSONObject e = new JSONObject().put("from", from).put("rule", rule).put("at", NetWatch.clock())
                    .put("seq", w.seq).put("how", w.how).put("shownMs", w.shown()).put("hurt", w.hurtWhy)
                    .put("resumed", resumed).put("netOk", netWatch.netOk());
            if (w.probe != null) e.put("probe", w.probe);
            if (w.record != null) e.put("record", w.record);
            prefs.edit().putString("lastStuck", e.toString()).apply();
        } catch (JSONException ignored) {
            // Not reachable with constant keys.
        }
    }

    // What the app can see of a page without its script: the logo and whether
    // it is shown, the document's state, Instagram's loader, the host (never the
    // address), and whether the page is WebView's error page.
    private static final String PROBE = "(function(){try{var s=document.getElementById('splash-screen');"
            + "return JSON.stringify({splash:!!s,logo:!!s&&getComputedStyle(s).display!=='none',ready:document.readyState,"
            + "req:typeof require,d:typeof window.__d,dLen:(window.__d&&window.__d.length)||0,"
            + "kids:document.body?document.body.children.length:-1,host:String(location.host).slice(0,40),"
            + "error:String(location.href).indexOf('chrome-error')===0,sg:!!window.__sg})}"
            + "catch(e){return JSON.stringify({err:String(e).slice(0,60)})}})()";

    /** The cap passed with no word from the page: ask the page itself. */
    private void onWatchFired(BootWatch w) {
        probe(w, answer -> {
            if (watch != w || w.booted || w.stuck) return;
            if (answer == null) {
                // No answer twice: a page too busy to speak. Recorded; Cam decides.
                w.stuck = true;
                bootOutcome(w, "busy after " + w.shown() + " ms shown");
                keepLastStuck(w, "probe", "busy");
                showBootChip("stuck");
                return;
            }
            w.probe = answer;
            boolean logo = answer.optBoolean("logo");
            boolean blank = answer.optInt("kids", -1) == 0 && !"complete".equals(answer.optString("ready"));
            if (!logo && !answer.optBoolean("error") && !blank && !answer.has("err")) {
                // Booted without a word (the page script didn't run, or its message was lost).
                w.booted = true;
                bootOutcome(w, "booted quietly (probe) after " + w.shown() + " ms shown");
                chain = null;
                return;
            }
            w.stuck = true;
            String rule = answer.optBoolean("error") ? "errorPage" : logo ? "logo" : blank ? "blank" : "probeError";
            bootOutcome(w, "stuck: " + rule + " (probe) after " + w.shown() + " ms shown");
            keepLastStuck(w, "probe", rule);
            recover(w, "probe " + rule);
        });
    }

    /** Asks the page about itself; null after two misses of {@code bootProbeMs} in this round. */
    private void probe(BootWatch w, ValueCallback<JSONObject> cb) {
        w.probeMisses = 0;              // a miss in an earlier round (one the page answered) doesn't count
        probeOnce(w, cb);
    }

    private void probeOnce(BootWatch w, ValueCallback<JSONObject> cb) {
        if (w.view != web || isDestroyed()) return;
        w.probing = true;
        final boolean[] done = {false};
        Runnable timeout = () -> {
            if (done[0]) return;
            done[0] = true;
            probeTimeout = null;
            w.probeMisses++;
            if (w.probeMisses >= 2) {
                w.probing = false;
                cb.onReceiveValue(null);
            } else {
                probeOnce(w, cb);
            }
        };
        probeTimeout = timeout;
        try {
            w.view.evaluateJavascript(PROBE, v -> {
                if (done[0]) return;
                done[0] = true;
                ui.removeCallbacks(timeout);
                probeTimeout = null;
                w.probing = false;
                cb.onReceiveValue(parseProbe(v));
            });
        } catch (RuntimeException e) {
            // A view already destroyed answers nothing.
        }
        ui.postDelayed(timeout, bootProbeMs);
    }

    private static JSONObject parseProbe(String v) {
        try {
            Object o = v == null ? null : new JSONTokener(v).nextValue();
            if (o instanceof String) return new JSONObject((String) o);
        } catch (JSONException ignored) {
            // Fall through: an answer that isn't the probe's.
        }
        try {
            return new JSONObject().put("err", "unreadable");
        } catch (JSONException e) {
            return new JSONObject();
        }
    }

    /**
     * The recovery ladder for a page that didn't start; each step is recorded
     * before it runs. 1: one automatic reload per page (at most two per ten
     * minutes); offline, it waits for the network. 2: the chip, with Try again (a
     * new page view) and Details. 3: the same chip with a load without
     * SimpleGram's filters. Never a reload while a dialog, a full screen,
     * screenshot mode, the comments or a focused field is up.
     */
    private void recover(BootWatch w, String why) {
        if (watch != w || w.booted || isDestroyed()) return;
        if (chain == null) chain = new BootChain();
        if (w.hurt) tipDue = true;        // a stuck page tied to a block
        if (chain.tryAgains > 0) {
            showBootChip("still");
        } else if (chain.reloads > 0) {
            showBootChip("stuck");
        } else if (!netWatch.netOk()) {
            pendingNetReload = true;
            logReload("wait " + why, 1);
            showBootChip("offline");
        } else {
            autoReload(w, why);
        }
    }

    /** NetWatch: the network became usable, or stopped being. */
    private void onNetOk(boolean ok) {
        BootWatch w = watch;
        if (!ok) {
            markHurt("netLost");
            return;
        }
        if (!pendingNetReload || w == null || w.booted) return;
        pendingNetReload = false;
        tipDue = true;                    // an automatic reload after an unblock
        autoReload(w, "online");
    }

    /** Why an automatic reload must wait, or null. */
    private String reloadGate() {
        if (!resumed) return "paused";
        if (menuOpen || !hasWindowFocus()) return "dialog";
        if (customView != null) return "fullScreen";
        if (pageVideo) return "pageVideo";
        if (screenshotMode) return "screenshot";
        if (comments.isOpen() || zoom.isSplit()) return "comments";
        if (searchOpen) return "search";
        if (keyboardUp()) return "typing";
        if (rebuilding) return "rebuilding";
        return null;
    }

    /** A text field has the keyboard (the page's input connection, or the window shrunk for it). */
    private boolean keyboardUp() {
        InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
        if (imm != null && imm.isAcceptingText() && web.hasFocus()) return true;
        return fullHeight > 0 && root.getHeight() < fullHeight * 0.8f;
    }

    /** Step 1: the one automatic reload, through the budget and the gate. */
    private void autoReload(BootWatch w, String why) {
        if (watch != w || w.booted || isDestroyed()) return;
        if (chain == null) chain = new BootChain();
        String gate = reloadGate();
        if ("paused".equals(gate)) {
            // Off screen: a page started now would load with the network blocked, and
            // half a minute away must not end in the chip. The reload waits for the
            // next onResume, which runs the ladder again (offline, it waits for the
            // network as before).
            if (resumeReload == null) logReload("wait paused " + why, 1);
            resumeReload = () -> recover(w, why);
            return;
        }
        if (gate != null) {
            // Not now: again in a moment, for up to half a minute; then the chip.
            if (chain.deferred++ < 30) {
                ui.postDelayed(() -> autoReload(w, why), bootSettleMs);
                return;
            }
            logReload("held " + gate + " " + why, 1);
            showBootChip("stuck");
            return;
        }
        if (!takeReloadBudget()) {
            logReload("budget " + why, 1);
            showBootChip("stuck");
            return;
        }
        chain.reloads++;
        logReload("reload " + why, 1);
        startsReload++;
        goBackAt = 0;
        startHow = "reload " + why;
        w.view.reload();
        // A reload that starts no page in time: the address from the page start
        // instead (not loadMain, which closes the comments).
        final int seq = w.seq;
        reloadFollow = () -> {
            reloadFollow = null;
            if (watch != w || w.seq != seq || isDestroyed()) return;
            logReload("loadUrl " + why, 1);
            startHow = "reload " + why;
            w.view.loadUrl(w.url);
        };
        ui.postDelayed(reloadFollow, bootReloadFollowMs);
    }

    /** Two automatic reloads per ten minutes, however many pages (kept in prefs). */
    private boolean takeReloadBudget() {
        long now = System.currentTimeMillis();
        JSONArray old = ringOf("autoReloads");
        JSONArray kept = new JSONArray();
        for (int i = 0; i < old.length(); i++) {
            long t = old.optLong(i);
            if (t > 0 && now - t < 10 * 60_000L) kept.put(t);
        }
        if (kept.length() >= RELOADS_PER_10_MIN) return false;
        kept.put(now);
        prefs.edit().putString("autoReloads", kept.toString()).apply();
        return true;
    }

    private void logReload(String what, int step) {
        try {
            ring("reloadLog", 10, new JSONObject().put("what", what).put("step", step).put("at", NetWatch.clock())
                    .put("seq", watch == null ? 0 : watch.seq).put("route", route).put("netOk", netWatch.netOk())
                    .put("resumed", resumed));
        } catch (JSONException ignored) {
            // Not reachable with constant keys.
        }
    }

    private void showBootChip(String kind) {
        if (!kind.equals(bootChipKind)) bootChipsShown++;
        bootChipKind = kind;
        updateStuckChip();
        if (!"offline".equals(kind)) maybeShowDataSaverTip();
    }

    /** "Instagram didn't start": Try again (a new page view), Details, and later a load without filters. */
    private android.widget.LinearLayout makeBootChip() {
        android.widget.LinearLayout box = new android.widget.LinearLayout(this);
        box.setOrientation(android.widget.LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER_HORIZONTAL);
        box.setPadding(dp(16), dp(10), dp(16), dp(10));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0xF2262626);
        bg.setCornerRadius(dp(18));
        box.setBackground(bg);
        box.setElevation(dp(8));
        box.setClickable(true);           // solid: a tap on it never reaches the page
        box.setContentDescription("Instagram didn't start");
        bootChipText = new TextView(this);
        bootChipText.setTextColor(Color.WHITE);
        bootChipText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        bootChipText.setTypeface(Typeface.DEFAULT_BOLD);
        bootChipText.setGravity(Gravity.CENTER);
        box.addView(bootChipText);
        android.widget.LinearLayout row = new android.widget.LinearLayout(this);
        row.setOrientation(android.widget.LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_HORIZONTAL);
        row.setPadding(0, dp(8), 0, 0);
        bootChipRetry = chipButton("Try again", this::tryAgain);
        row.addView(bootChipRetry);
        row.addView(chipButton("Details", () -> askStatus(true)));
        bootChipPlain = chipButton("Load without filters", this::loadWithoutFilters);
        row.addView(bootChipPlain);
        box.addView(row);
        box.setVisibility(View.GONE);
        return box;
    }

    private TextView chipButton(String label, Runnable action) {
        TextView b = new TextView(this);
        b.setText(label);
        b.setContentDescription(label);
        b.setTextColor(Color.WHITE);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setGravity(Gravity.CENTER);
        b.setPadding(dp(12), dp(7), dp(12), dp(7));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0xFF0095F6);
        bg.setCornerRadius(dp(10));
        b.setBackground(bg);
        android.widget.LinearLayout.LayoutParams lp = new android.widget.LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.leftMargin = lp.rightMargin = dp(4);
        b.setLayoutParams(lp);
        b.setOnClickListener(v -> action.run());
        return b;
    }

    /** Step 2's button: a new page view, loaded from the address (never restoreState: that is what failed). */
    private void tryAgain() {
        if (rebuilding) return;           // a second tap while the first is under way
        if (chain == null) chain = new BootChain();
        chain.tryAgains++;
        String chip = bootChipKind;       // for the rebuild log: the chip Cam answered
        bootChipKind = "";
        updateStuckChip();
        rebuildWebView("Try again", chip);
    }

    /** Step 3's button: one load with the page script's data hooks and boot-time DOM rules off. */
    private void loadWithoutFilters() {
        if (rebuilding) return;
        if (chain == null) chain = new BootChain();
        chain.plain = true;
        chain.tryAgains++;
        String chip = bootChipKind;
        bootChipKind = "";
        updateStuckChip();
        prefs.edit().putInt("plainBoots", prefs.getInt("plainBoots", 0) + 1).apply();
        plainBootOn = true;
        rebuildWebView("Load without filters", chip);
    }

    /**
     * The page saw drags that should have scrolled and didn't. The first time,
     * a reset that changes nothing you can see; if it goes on, the chip. Never
     * while anything of the app's own could explain it (the gate).
     */
    private void onScrollStuck(JSONObject m) {
        stuckPosts++;
        String why = stuckGate(m.optInt("moves", 1));
        if (why != null) {
            try {
                stuckIgnored.put(why, stuckIgnored.optInt(why) + 1);
            } catch (JSONException ignored) {
                // Not reachable with constant keys.
            }
            stuckAck(false, "");
            return;
        }
        if (rebuiltAt > 0) strikesAfterRebuild++;
        long now = SystemClock.uptimeMillis();
        if (!softResetDone || now - softResetAt > 10 * 60_000L) {
            softReset();
            stuckAck(true, "soft");
        } else {
            strikesAfterSoft++;
            if (!stuckChipWanted) chipShown++;
            stuckChipWanted = true;
            updateStuckChip();
            stuckAck(true, "chip");
        }
    }

    /** Why a report can't be trusted right now, or null. */
    private String stuckGate(int pageMoves) {
        if (zoom.scale() != 1f) return "zoom";
        if (zoom.isOwned() || zoom.isPinching() || zoom.isAnimating()) return "zoomGesture";
        if (zoom.isHolding()) return "holding";
        if (zoom.isSplit() || comments.isOpen()) return "comments";
        if (customView != null) return "fullScreen";
        if (pageVideo) return "pageVideo";
        if (screenshotMode) return "screenshot";
        if (menuOpen || !hasWindowFocus()) return "dialog";
        if (!resumed) return "paused";
        if (touchOpen) return "fingerDown";
        // The drags' moves reached the page (this app didn't keep them).
        if (zoom.recentPageMoves() < Math.max(1, Math.min(pageMoves, 3))) return "movesKept";
        return null;
    }

    private void stuckAck(boolean accepted, String stage) {
        try {
            js(new JSONObject().put("type", "scrollStuckAck").put("accepted", accepted).put("stage", stage));
        } catch (JSONException ignored) {
            // Not reachable with constant keys.
        }
    }

    /** Clears everything the app and the page hold about touches; harmless at any time. */
    private void softReset() {
        softResets++;
        softResetDone = true;
        softResetAt = SystemClock.uptimeMillis();
        zoom.forceIdle(comments.isOpen());
        js("gestureReset");
    }

    /** ⋮ → Fix scrolling. */
    private void fixScrolling() {
        manualFix++;
        String chip = chipNow();
        stuckChipWanted = false;
        updateStuckChip();
        rebuildWebView("Fix scrolling", chip);
    }

    /** Which chip is up: B33's kind, B25's "scroll", or none. */
    private String chipNow() {
        return !bootChipKind.isEmpty() ? bootChipKind : stuckChipWanted ? "scroll" : "";
    }

    /**
     * A new main WebView in the old one's place: the only thing that clears
     * the web engine's stuck touch state, and B33's fresh start. The page's
     * search screen and its boot record are read first (the search screen is
     * handed to the new page; the record is kept, so the evidence of a page
     * stuck on the logo doesn't go with it); the rest comes back from the saved
     * history, or from the address for Try again. The rebuild is logged with
     * why it was chosen and what was up ({@code chip}: the one Cam answered,
     * read before the tap took it down). A swap due while the app is off
     * screen waits for the next onResume (its page would load blocked).
     */
    private void rebuildWebView(String why, String chip) {
        if (rebuilding || isFinishing()) return;
        rebuilding = true;
        final JSONObject entry = rebuildEntry(why, chip);
        final long asked = SystemClock.uptimeMillis();
        final boolean[] done = {false};
        final long[] answered = {-1};
        Runnable go = new Runnable() {
            @Override
            public void run() {
                if (done[0] || isDestroyed()) return;
                if (!resumed) {
                    pendingRebuild = null;
                    deferredSwap = this;
                    return;
                }
                done[0] = true;
                pendingRebuild = null;
                deferredSwap = null;
                try {
                    entry.put("answered", answered[0] >= 0).put("answerMs", answered[0]);
                } catch (JSONException ignored) {
                    // Not reachable with constant keys.
                }
                ring("rebuildLog", 5, entry);
                swapWebView(why);
            }
        };
        web.evaluateJavascript(READ_OLD_PAGE, v -> {
            if (done[0] || isDestroyed()) return;
            answered[0] = SystemClock.uptimeMillis() - asked;
            JSONObject old = parseOldPage(v);
            searchHandBack = searchStateOf(old == null ? null : old.opt("search"));
            searchHandBackUntil = SystemClock.uptimeMillis() + 30_000L;
            keepRebuildRecord(why, old == null ? null : old.opt("boot"));
            ui.post(go);         // not from inside the old WebView's own callback
        });
        // A page too busy to answer is rebuilt without its search screen or record.
        pendingRebuild = go;
        ui.postDelayed(go, 700);
    }

    // The old page's search screen and boot record, read in one go before it is destroyed.
    private static final String READ_OLD_PAGE = "(function(){var r={};"
            + "try{r.search=window.__sg&&window.__sg.searchState?window.__sg.searchState():null}catch(e){r.search=null}"
            + "try{r.boot=window.__sg&&window.__sg.bootRecord?window.__sg.bootRecord():null}catch(e){r.boot=null}"
            + "try{return JSON.stringify(r)}catch(e){return null}})()";

    /** What was up when a rebuild was chosen (kinds only). */
    private JSONObject rebuildEntry(String why, String chip) {
        JSONObject e = new JSONObject();
        try {
            BootWatch w = watch;
            e.put("why", why).put("at", NetWatch.clock()).put("route", route)
                    .put("logoUp", w != null && !w.booted).put("stuck", w != null && w.stuck)
                    .put("fullScreen", customView != null || pageVideo)
                    .put("chip", chip)
                    .put("seq", w == null ? 0 : w.seq).put("resumed", resumed);
        } catch (JSONException ignored) {
            // Not reachable with constant keys.
        }
        return e;
    }

    private long searchHandBackUntil;

    private static JSONObject parseOldPage(String v) {
        if (v == null || "null".equals(v)) return null;
        try {
            Object o = new JSONTokener(v).nextValue();
            return o instanceof String ? new JSONObject((String) o) : null;
        } catch (JSONException e) {
            return null;
        }
    }

    /** The page's search state: an object, or the JSON text of one; only when it has something to hand back. */
    private static JSONObject searchStateOf(Object o) {
        try {
            JSONObject st = o instanceof JSONObject ? (JSONObject) o
                    : o instanceof String ? new JSONObject((String) o) : null;
            return st != null && (st.optBoolean("open") || st.optBoolean("suspended")) ? st : null;
        } catch (JSONException e) {
            return null;
        }
    }

    /** The old page's boot record (shapes only), kept in prefs for Copy details. */
    private void keepRebuildRecord(String why, Object o) {
        JSONObject record = null;
        try {
            record = o instanceof JSONObject ? (JSONObject) o : o instanceof String ? new JSONObject((String) o) : null;
        } catch (JSONException ignored) {
            // Not a record.
        }
        if (record == null || record.toString().length() > 6000) return;
        try {
            prefs.edit().putString("rebuildRecord", new JSONObject().put("why", why).put("at", NetWatch.clock())
                    .put("seq", watch == null ? 0 : watch.seq).put("record", record).toString()).apply();
        } catch (JSONException ignored) {
            // Not reachable with constant keys.
        }
    }

    /** The new page's 'ready': its search screen as it was before the rebuild. */
    private void handBackSearch() {
        JSONObject st = searchHandBack;
        searchHandBack = null;
        if (st == null || SystemClock.uptimeMillis() > searchHandBackUntil) return;
        try {
            js(new JSONObject().put("type", "searchRestore").put("state", st));
        } catch (JSONException ignored) {
            // Not reachable with constant keys.
        }
    }

    private void swapWebView(String why) {
        // A swap queued before the Activity went away would leave a WebView nobody destroys.
        if (isFinishing() || isDestroyed()) {
            rebuilding = false;
            return;
        }
        // B33: Try again (and the load without filters) start from the address:
        // restoring the history is what just failed.
        boolean fromAddress = "Try again".equals(why) || "Load without filters".equals(why);
        String watched = watch == null ? null : watch.url;
        closeWatch("rebuilt");
        // Nothing that belongs to the old page view stays up.
        if (screenshotMode) exitScreenshot();
        if (customView != null) hideCustomView("rebuild");
        setPageVideo(false);
        closeComments();
        zoom.forceIdle(false);
        if (fileCallback != null) {
            fileCallback.onReceiveValue(null);
            fileCallback = null;
        }
        setAwake(false);

        WebView old = web;
        Bundle state = new Bundle();
        String url = old.getUrl();
        boolean saved = old.saveState(state) != null;
        int index = Math.max(0, zoom.indexOfChild(old));
        ViewGroup.LayoutParams lp = old.getLayoutParams();
        for (java.util.Iterator<Script> it = scripts.iterator(); it.hasNext(); ) {
            Script s = it.next();
            if (s.view != old) continue;
            if (s.handler != null) s.handler.remove();
            it.remove();
        }
        zoom.removeView(old);
        old.stopLoading();
        old.destroy();

        WebView fresh = newWebView("main");
        web = fresh;
        zoom.addView(fresh, index, lp != null ? lp
                : new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        if (!resumed) fresh.onPause();
        fresh.requestFocus();

        // A new page: what the old one asked for goes with it ('ready' brings the new state).
        route = "other";
        pageUrl = "";
        searchOpen = false;
        feedWanted = false;
        skipKind = "";
        skipCount = 0;
        menuLink = null;
        rebuilds++;
        rebuiltAt = SystemClock.uptimeMillis();
        softResetDone = false;
        stuckChipWanted = false;
        updateFeedBar();
        onZoomChanged(zoom.scale());

        startHow = "rebuild restore";
        boolean restored = !fromAddress && saved && fresh.restoreState(state) != null;
        if (restored) {
            // The restore's own onPageStarted adds it to startsAll: credit it to the app.
            startsLoadUrl++;
            goBackAt = 0;
        } else {
            startHow = fromAddress ? why : "rebuild loadUrl";
            String target = url != null && Links.isInstagram(Uri.parse(url)) ? url
                    : watched != null ? watched : Links.HOME;
            load(fresh, target);
        }
        rebuilding = false;
    }

    /** The b25 block of Copy details: counts and shapes only. */
    private JSONObject touchDiagnostics() throws JSONException {
        JSONObject touch = new JSONObject()
                .put("web", new JSONObject().put("started", touchStarted[RX_WEB]).put("ended", touchEnded[RX_WEB]).put("refused", touchRefused[RX_WEB]))
                .put("custom", new JSONObject().put("started", touchStarted[RX_CUSTOM]).put("ended", touchEnded[RX_CUSTOM]).put("refused", touchRefused[RX_CUSTOM]))
                .put("cancelsSent", new JSONObject().put("show", cancelsShow).put("hide", cancelsHide).put("hold", cancelsHold))
                .put("swallowed", swallowedTouches)
                .put("open", touchOpen);
        JSONObject fs = new JSONObject()
                .put("last", new JSONArray(fsLog))
                .put("showDuringTouch", showDuringTouch)
                .put("hideDuringTouch", hideDuringTouch);
        JSONObject z = new JSONObject()
                .put("scale", Math.round(zoom.scale() * 100) / 100.0)
                .put("owned", zoom.isOwned())
                .put("pinching", zoom.isPinching())
                .put("holding", zoom.isHolding())
                .put("split", zoom.isSplit())
                .put("animating", zoom.isAnimating())
                .put("chipVisible", zoomChip.getVisibility() == View.VISIBLE)
                .put("fullHidTab", fullHidTab)
                .put("pageVideo", pageVideo)
                .put("screenshotMode", screenshotMode);
        JSONObject repair = new JSONObject()
                .put("stuckPosts", stuckPosts)
                .put("stuckIgnored", new JSONObject(stuckIgnored.toString()))
                .put("softResets", softResets)
                .put("strikesAfterSoft", strikesAfterSoft)
                .put("chipShown", chipShown)
                .put("chipNow", stuckChipWanted)
                .put("rebuilds", rebuilds)
                .put("strikesAfterRebuild", strikesAfterRebuild)
                .put("manualFix", manualFix);
        return new JSONObject().put("touch", touch).put("fsLog", fs).put("zoom", z).put("repair", repair);
    }

    private int ignoredReports() {
        int n = 0;
        for (java.util.Iterator<String> k = stuckIgnored.keys(); k.hasNext(); ) n += stuckIgnored.optInt(k.next());
        return n;
    }

    /** Filter status: a short "Touch and scrolling" section. */
    private void appendTouchStatus(StringBuilder b, JSONObject page) {
        JSONObject seq = page == null ? null : page.optJSONObject("touchSeq");
        JSONObject drag = page == null ? null : page.optJSONObject("drag");
        b.append("\nTouch and scrolling\n")
                .append("  Full screen during a touch: ").append(showDuringTouch + hideDuringTouch)
                .append(" (touches cancelled ").append(cancelsShow + cancelsHide)
                .append(", held finger ").append(cancelsHold).append(")\n")
                .append("  Touch ends turned down: ").append(touchRefused[RX_WEB] + touchRefused[RX_CUSTOM])
                .append(" · lost touch ends seen by the page: ").append(seq == null ? 0 : seq.optInt("orphans")).append('\n')
                .append("  Drags that didn't scroll: ").append(drag == null ? 0 : drag.optInt("dead"))
                .append(" · reported ").append(stuckPosts)
                .append(" (not trusted ").append(ignoredReports()).append(")\n")
                .append("  Quiet resets: ").append(softResets)
                .append(" · page view rebuilt: ").append(rebuilds)
                .append(" (by hand ").append(manualFix).append(")\n");
    }

    /* ------------------------------------------------------------------ *
     * Utilities
     * ------------------------------------------------------------------ */

    private static String clock() {
        return new SimpleDateFormat("HH:mm", Locale.US).format(new Date());
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private void toast(String message) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
    }

    private String readAsset(String name) {
        try (InputStream in = getAssets().open(name)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString(StandardCharsets.UTF_8.name());
        } catch (IOException e) {
            throw new IllegalStateException("Missing page script", e);
        }
    }
}
