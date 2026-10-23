package com.cam.simplegram;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
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
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
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
    private Downloads downloads;

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
    // The page's search screen, read before a rebuild and handed to the new page once.
    private JSONObject searchHandBack;

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

        root = new FrameLayout(this);
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

        menuButton = makeMenuButton();
        root.addView(menuButton, new FrameLayout.LayoutParams(dp(TAB_W), dp(TAB_H)));

        setContentView(root);
        root.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> onRootLayout(r - l, b - t));
        guardEdgeToEdge();

        // A restored page (after a renderer restart or process death) keeps its
        // place; the launch intent was already handled the first time.
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
            ui.post(MainActivity.this::recreate);
            return true;
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
            // R8: a post's video takes the whole screen. The tab's elevation would
            // draw it (and give it taps) over the video, so it goes. Not in a Story,
            // where the tab is how Stories are saved (R9's layer hides it itself).
            if ("post".equals(route) || "reel".equals(route)) {
                fullHidTab = true;
                menuButton.setVisibility(View.GONE);
                zoomChip.setVisibility(View.GONE);
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
            if (fullHidTab) {
                fullHidTab = false;
                if (!screenshotMode && !pageVideo) menuButton.setVisibility(View.VISIBLE);
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
                    if ("ready".equals(action)) {
                        // A new page: nothing from the old one carries over.
                        searchOpen = false;
                        feedWanted = false;
                        skipKind = "";
                        setPageVideo(false);
                        setAwake(false);     // the old page's playing video is gone
                        refreshViewer();
                        handBackSearch();
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
                    skipKind = m.optBoolean("on") && ("skipping".equals(kind) || "nothingNew".equals(kind) || "homeSkipping".equals(kind)) ? kind : "";
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
            case "fullVideoExitRequest":
                // R8's swipe (and R10's later): leave full screen the Back way, view
                // first. Never a Story's own full screen: that would close the Story.
                if (main && !"story".equals(route)) hideCustomView("r8bridge");
                break;
            case "scrollStuck":
                if (main) onScrollStuck(m);
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
                if (main) showStatus(m.optJSONObject("stats"));
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
            menuButton.setVisibility(View.GONE);
            zoomChip.setVisibility(View.GONE);
            setSystemBarsHidden(true);
        } else {
            if (!screenshotMode && !fullHidTab) menuButton.setVisibility(View.VISIBLE);
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
        // into Following and is still passing posts you saw (R7, homeSkipping).
        boolean home = "homeSkipping".equals(skipKind);
        // Never on top of the end card (they share the bottom of the screen).
        boolean show = !skipKind.isEmpty() && "home".equals(route) && (home ? !onOtherFeed() && !feedWanted : onFollowingOrFavorites())
                && !screenshotMode && !comments.isOpen() && !searchOpen && customView == null;
        if (show) {
            skipChip.setText("nothingNew".equals(skipKind) ? "Nothing new since Home"
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
            if (comments.isOpen()) {
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
        float y = prefs.getFloat("menuY", 0.58f) * h;
        menuButton.setBackground(tabBackground(left));
        menuButton.animate().cancel();
        menuButton.animate().x(left ? 0 : w - tabW)
                .y(clamp(y, dp(56), h - tabH - dp(60))).setDuration(120).start();
        if (Build.VERSION.SDK_INT >= 29) {
            // Dragging the tab must not start the system Back gesture.
            menuButton.setSystemGestureExclusionRects(Collections.singletonList(new Rect(0, 0, tabW, tabH)));
        }
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
                "Copy link",
                "Share link…",
                "Following feed (newest first)",
                "Favorites feed",
                "Refresh",
                "Hide controls for screenshot",
                "More…",
        };
        AlertDialog d = dialog().setItems(items, (x, which) -> {
            switch (which) {
                case 0:
                    js("download");
                    break;
                case 1:
                    copyLink();
                    break;
                case 2:
                    shareLink();
                    break;
                case 3:
                    loadMain(FOLLOWING);
                    break;
                case 4:
                    loadMain(FAVORITES);
                    break;
                case 5:
                    feedWanted = false;
                    skipKind = "";
                    updateFeedBar();
                    startsReload++;
                    goBackAt = 0;
                    web.reload();
                    break;
                case 6:
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
                "Fix scrolling",
                "About SimpleGram",
        };
        dialog().setItems(items, (x, which) -> {
            switch (which) {
                case 0:
                    js("status");
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
                case 4:
                    // B25's escape hatch: a new page view, at any time.
                    fixScrolling();
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
        Intent send = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, currentLink());
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

    private void showStatus(JSONObject stats) {
        if (stats == null) return;
        JSONObject feed = stats.optJSONObject("feed");
        JSONObject dom = stats.optJSONObject("dom");
        StringBuilder b = new StringBuilder();
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
                    .append(" · slowed ").append(feed.optInt("skipThrottled")).append('\n')
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
                        .append("  Back to the post or Story: ").append(fv.optInt("exits")).append('\n');
            }
        }
        b.append("\nElsewhere\n")
                .append("  Ads removed (Stories etc.): ").append(stats.optInt("ads")).append('\n')
                .append("  Endless-Reels items blocked: ").append(stats.optInt("chainingTrimmed")).append('\n')
                .append("  Reel swipes blocked: ").append(stats.optInt("swipesBlocked")).append('\n')
                .append("  Explore items removed: ").append(stats.optInt("exploreBlanked")).append('\n')
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
                .append("  Back presses in the page: ").append(backPresses).append('\n');
        appendTouchStatus(b, stats.optJSONObject("b25"));
        b.append("\nCounts since the page last loaded. No account names or post details are kept.");
        dialog().setTitle("Filter status").setMessage(b.toString())
                .setNeutralButton("Copy details", (d, w) -> copyDetails(stats, device))
                .setPositiveButton("OK", null).show();
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
            n.put("continueHome", continueHome());
            n.put("rendererGone", prefs.getInt("rendererGone", 0));
            n.put("rendererGoneLast", prefs.getString("rendererGoneLast", ""));
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
        try {
            return new JSONArray(prefs.getString("feedTrail", "[]"));
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    private void keepTrail(JSONObject entry) {
        if (entry == null || entry.toString().length() > 800) return;
        JSONArray old = trail();
        JSONArray kept = new JSONArray();
        for (int i = Math.max(0, old.length() - (TRAIL_MAX - 1)); i < old.length(); i++) kept.put(old.opt(i));
        kept.put(entry);
        prefs.edit().putString("feedTrail", kept.toString()).apply();
    }

    /** Counts and data shapes only, for pasting into a bug report. */
    private void copyDetails(JSONObject stats, JSONObject device) {
        JSONObject all = new JSONObject();
        try {
            all.put("device", device);
            // The page's trail is the newest part of the kept one.
            JSONObject page = new JSONObject(stats.toString());
            page.remove("trail");
            all.put("page", page);
            all.put("trail", trail());
        } catch (JSONException e) {
            return;
        }
        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (cm == null) return;
        cm.setPrimaryClip(ClipData.newPlainText("SimpleGram details", all.toString()));
        toast("Details copied: paste them into your message");
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
        menuButton.setVisibility(View.GONE);
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
        if (!fullHidTab) menuButton.setVisibility(View.VISIBLE);
        if (customView == null) setSystemBarsHidden(false);
        onZoomChanged(zoom.scale());
        zoom.releaseHold();
        updateFeedBar();
    }

    @SuppressWarnings("deprecation")
    private void setSystemBarsHidden(boolean hidden) {
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c == null) return;
            if (hidden) {
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                c.hide(WindowInsets.Type.systemBars());
            } else {
                c.show(WindowInsets.Type.systemBars());
            }
        } else {
            View d = getWindow().getDecorView();
            d.setSystemUiVisibility(hidden
                    ? View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    : 0);
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
            loadMain(target);
        } else if (fresh) {
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
    protected void onPause() {
        super.onPause();
        resumed = false;
        setAwake(false);
        web.onPause();
        comments.web().onPause();
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onResume() {
        super.onResume();
        resumed = true;
        web.onResume();
        comments.web().onResume();
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
        if (level == TRIM_MEMORY_UI_HIDDEN) return;   // only "the app left the screen"
        String name = level >= 80 ? "complete" : level >= 60 ? "moderate" : level >= 40 ? "background"
                : level >= 15 ? "critical" : level >= 10 ? "low" : "running moderate";
        trimLog.add(name + " at " + clock());
        if (trimLog.size() > 10) trimLog.remove(0);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onDestroy() {
        downloads.release();
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
            rebuildWebView();
        });
        return chip;
    }

    private void updateStuckChip() {
        if (stuckChip == null) return;
        boolean show = stuckChipWanted && customView == null && !pageVideo && !screenshotMode && !zoom.isZoomed();
        stuckChip.setVisibility(show ? View.VISIBLE : View.GONE);
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

    /** ⋮ → More… → Fix scrolling. */
    private void fixScrolling() {
        manualFix++;
        stuckChipWanted = false;
        updateStuckChip();
        rebuildWebView();
    }

    /**
     * A new main WebView in the old one's place: the only thing that clears
     * the web engine's stuck touch state. The page's search screen is read
     * first and handed to the new page; the rest comes back from the saved
     * history (or the address).
     */
    private void rebuildWebView() {
        if (rebuilding || isFinishing()) return;
        rebuilding = true;
        final boolean[] done = {false};
        Runnable go = () -> {
            if (done[0]) return;
            done[0] = true;
            swapWebView();
        };
        web.evaluateJavascript("(function(){try{return window.__sg&&window.__sg.searchState?window.__sg.searchState():null}catch(e){return null}})()",
                v -> {
                    if (done[0]) return;
                    searchHandBack = parseSearchState(v);
                    searchHandBackUntil = SystemClock.uptimeMillis() + 30_000L;
                    ui.post(go);         // not from inside the old WebView's own callback
                });
        // A page too busy to answer is rebuilt without its search screen.
        ui.postDelayed(go, 700);
    }

    private long searchHandBackUntil;

    private static JSONObject parseSearchState(String v) {
        if (v == null || "null".equals(v)) return null;
        try {
            Object o = new JSONTokener(v).nextValue();
            if (!(o instanceof String)) return null;
            JSONObject st = new JSONObject((String) o);
            return st.optBoolean("open") || st.optBoolean("suspended") ? st : null;
        } catch (JSONException e) {
            return null;
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

    private void swapWebView() {
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

        boolean restored = saved && fresh.restoreState(state) != null;
        if (restored) {
            startsAll++;      // counted like any other page load the app started
        } else {
            load(fresh, url != null && Links.isInstagram(Uri.parse(url)) ? url : Links.HOME);
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
