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
import android.provider.Settings;
import android.util.TypedValue;
import android.view.Gravity;
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
import android.webkit.JavascriptInterface;
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
    private boolean feedWanted;
    private boolean searchOpen;
    private View screenshotShield;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private Downloads downloads;

    private String route = "other";
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

        menuButton = makeMenuButton();
        root.addView(menuButton, new FrameLayout.LayoutParams(dp(TAB_W), dp(TAB_H)));

        setContentView(root);
        root.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> onRootLayout(r - l, b - t));
        guardEdgeToEdge();

        if (state != null && web.restoreState(state) != null) {
            handleIntent(getIntent(), false);
        } else {
            handleIntent(getIntent(), true);
        }
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
            return c.toString();
        } catch (JSONException e) {
            return "{}";
        }
    }

    private void install(WebView w, String role) {
        Script s = new Script(w, role);
        scripts.add(s);
        registerScript(s);
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(w, "SGNative", ORIGINS,
                    (view, message, origin, isMainFrame, reply) -> {
                        if (isMainFrame && message.getData() != null) onMessage(role, message.getData());
                    });
        } else {
            w.addJavascriptInterface(new LegacyBridge(role, w), "SGNative");
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
                if (target != null) view.loadUrl(target);
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
                view.loadUrl(Links.HOME);
                return true;
            }
            if (scheme.equals("http") && Links.normalize(uri.toString()) != null) {
                view.loadUrl(Links.normalize(uri.toString()));
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
                callback.onCustomViewHidden();
                return;
            }
            customView = view;
            customViewCallback = callback;
            view.setBackgroundColor(Color.BLACK);
            root.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            setSystemBarsHidden(true);
        }

        @Override
        public void onHideCustomView() {
            if (customView == null) return;
            root.removeView(customView);
            customView = null;
            if (!screenshotMode) setSystemBarsHidden(false);
            if (customViewCallback != null) customViewCallback.onCustomViewHidden();
            customViewCallback = null;
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
    final class LegacyBridge {
        private final String role;
        private final WebView view;

        LegacyBridge(String role, WebView view) {
            this.role = role;
            this.view = view;
        }

        @JavascriptInterface
        public void postMessage(String data) {
            ui.post(() -> {
                String url = view.getUrl();
                if (url != null && Links.isInstagram(Uri.parse(url))) onMessage(role, data);
            });
        }
    }

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
                    if ("ready".equals(action)) {
                        // A new page: nothing from the old one carries over.
                        searchOpen = false;
                        feedWanted = false;
                        refreshViewer();
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
                    feedWanted = m.optBoolean("on");
                    updateFeedBar();
                }
                break;
            case "search":
                if (main) {
                    searchOpen = m.optBoolean("open");
                    updateFeedBar();
                }
                break;
            case "awake":
                if (main) setAwake(m.optBoolean("on"));
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
        if (zoomed && !screenshotMode) {
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
     * End of Home: keep going in Following or Favorites
     * ------------------------------------------------------------------ */

    private View makeFeedBar() {
        android.widget.LinearLayout bar = new android.widget.LinearLayout(this);
        bar.setOrientation(android.widget.LinearLayout.VERTICAL);
        bar.setGravity(Gravity.CENTER_HORIZONTAL);
        bar.setPadding(dp(16), dp(12), dp(16), dp(14));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(dark ? 0xF2262626 : 0xF2FFFFFF);
        bg.setCornerRadius(dp(18));
        bg.setStroke(dp(1), dark ? 0x33FFFFFF : 0x22000000);
        bar.setBackground(bg);
        bar.setElevation(dp(8));
        // The card is solid: a tap on its text must not like the post underneath.
        bar.setClickable(true);

        TextView title = new TextView(this);
        title.setText("You're all caught up on Home");
        title.setTextColor(dark ? Color.WHITE : Color.BLACK);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setGravity(Gravity.CENTER);
        bar.addView(title);
        TextView sub = new TextView(this);
        sub.setText("Keep going, newest first, without repeats:");
        sub.setTextColor(dark ? 0xFFA8A8A8 : 0xFF737373);
        sub.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        sub.setGravity(Gravity.CENTER);
        sub.setPadding(0, dp(2), 0, dp(10));
        bar.addView(sub);

        android.widget.LinearLayout row = new android.widget.LinearLayout(this);
        row.setOrientation(android.widget.LinearLayout.HORIZONTAL);
        row.addView(feedButton("Following", "following"));
        View gap = new View(this);
        row.addView(gap, new android.widget.LinearLayout.LayoutParams(dp(10), 1));
        row.addView(feedButton("Favorites", "favorites"));
        bar.addView(row);
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

    private void showFeedBar(boolean on) {
        feedWanted = on;
        updateFeedBar();
    }

    /** The card shows when the page asks for it and nothing else is in the way. */
    private void updateFeedBar() {
        boolean show = feedWanted && "home".equals(route) && !screenshotMode && !comments.isOpen()
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
                    updateFeedBar();
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
                "Open Instagram links with SimpleGram…",
                "Open copied Instagram link",
                "About SimpleGram",
        };
        dialog().setItems(items, (x, which) -> {
            switch (which) {
                case 0:
                    js("status");
                    break;
                case 1:
                    linkSettings();
                    break;
                case 2:
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
        feedWanted = false;
        updateFeedBar();
        closeComments();
        if (zoom.isZoomed()) zoom.reset(false);
        web.loadUrl(url);
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
                    .append("  Suggested removed: ").append(feed.optInt("suggested") + feed.optInt("notFollowed")).append('\n')
                    .append("  Reposts removed: ").append(feed.optInt("repost")).append('\n')
                    .append("  Other promos removed: ").append(feed.optInt("unit")).append('\n')
                    .append("  Pages read: ").append(feed.optInt("pages"))
                    .append(feed.optInt("unknownPages") > 0 ? " (" + feed.optInt("unknownPages") + " unrecognised)" : "")
                    .append('\n');
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
                .append("  Memory warnings: ").append(trimLog.isEmpty() ? "none" : String.join(", ", trimLog)).append('\n')
                .append("  Page restarts: ").append(device.optInt("rendererGone"));
        String last = device.optString("rendererGoneLast");
        if (!last.isEmpty()) b.append(" (last: ").append(last).append(')');
        b.append('\n');
        b.append("\nCounts since the page last loaded. No account names or post details are kept.");
        dialog().setTitle("Filter status").setMessage(b.toString())
                .setNeutralButton("Copy details", (d, w) -> copyDetails(stats, device))
                .setPositiveButton("OK", null).show();
    }

    private JSONObject deviceDiagnostics() {
        JSONObject n = new JSONObject();
        try {
            PackageInfo p = WebViewCompat.getCurrentWebViewPackage(this);
            n.put("app", BuildConfig.VERSION_NAME);
            n.put("android", Build.VERSION.SDK_INT);
            n.put("webView", p != null ? p.versionName : "unknown");
            n.put("memoryWarnings", new JSONArray(trimLog));
            n.put("rendererGone", prefs.getInt("rendererGone", 0));
            n.put("rendererGoneLast", prefs.getString("rendererGoneLast", ""));
        } catch (JSONException e) {
            // Partial details are still useful.
        }
        return n;
    }

    /** Counts and data shapes only, for pasting into a bug report. */
    private void copyDetails(JSONObject stats, JSONObject device) {
        JSONObject all = new JSONObject();
        try {
            all.put("device", device);
            all.put("page", stats);
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
        showFeedBar(false);
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
        menuButton.setVisibility(View.VISIBLE);
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
            web.loadUrl(Links.HOME);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent, false);
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        if (screenshotMode) {
            exitScreenshot();
        } else if (customView != null) {
            new Chrome().onHideCustomView();
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
        if (web.canGoBack() && (!"home".equals(route) || feedVariant)) web.goBack();
        else moveTaskToBack(true);
    }

    private void setAwake(boolean on) {
        if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    @Override
    protected void onPause() {
        super.onPause();
        setAwake(false);
        web.onPause();
        comments.web().onPause();
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        comments.web().onResume();
    }

    // Android's memory warnings since the app started, newest last (Filter status).
    private final ArrayList<String> trimLog = new ArrayList<>();

    @Override
    public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        trimLog.add(level + " at " + clock());
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
        for (Script s : scripts) {
            ViewGroup parent = (ViewGroup) s.view.getParent();
            if (parent != null) parent.removeView(s.view);
            s.view.destroy();
        }
        scripts.clear();
        super.onDestroy();
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
