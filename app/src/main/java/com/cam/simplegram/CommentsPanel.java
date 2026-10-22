package com.cam.simplegram;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.animation.DecelerateInterpolator;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

/** The half-screen comments sheet under a post, like the Instagram app's. */
final class CommentsPanel extends LinearLayout {
    interface Host {
        void onCommentsCloseRequested();
    }

    private final Host host;
    private final WebView web;
    private final ProgressBar spinner;
    private final float density;
    private String url;
    private boolean open;
    private GradientDrawable sheet;
    private GradientDrawable pill;
    private TextView close;

    @SuppressLint("ClickableViewAccessibility")
    CommentsPanel(Context context, WebView web, boolean dark, Host host) {
        super(context);
        this.host = host;
        this.web = web;
        this.density = context.getResources().getDisplayMetrics().density;
        setOrientation(VERTICAL);
        setClickable(true);
        int bg = dark ? Color.BLACK : Color.WHITE;
        int fg = dark ? Color.WHITE : Color.BLACK;

        sheet = new GradientDrawable();
        sheet.setColor(bg);
        float r = 14 * density;
        sheet.setCornerRadii(new float[]{r, r, r, r, 0, 0, 0, 0});
        setBackground(sheet);
        setElevation(12 * density);
        setClipToOutline(true);

        // Header: drag handle, title and close button.
        FrameLayout header = new FrameLayout(context);
        View handle = new View(context);
        pill = new GradientDrawable();
        pill.setColor(dark ? 0x66FFFFFF : 0x40000000);
        pill.setCornerRadius(2 * density);
        handle.setBackground(pill);
        FrameLayout.LayoutParams hp = new FrameLayout.LayoutParams(dp(36), dp(4), Gravity.CENTER_HORIZONTAL | Gravity.TOP);
        hp.topMargin = dp(8);
        header.addView(handle, hp);
        close = new TextView(context);
        close.setText("✕");
        close.setTextColor(fg);
        close.setTextSize(18);
        close.setGravity(Gravity.CENTER);
        close.setContentDescription("Close comments");
        close.setOnClickListener(v -> host.onCommentsCloseRequested());
        header.addView(close, new FrameLayout.LayoutParams(dp(48), dp(40), Gravity.END | Gravity.BOTTOM));
        addView(header, new LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(40)));
        header.setOnTouchListener(new DragToClose());

        FrameLayout body = new FrameLayout(context);
        body.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        spinner = new ProgressBar(context);
        spinner.setIndeterminate(true);
        body.addView(spinner, new FrameLayout.LayoutParams(dp(36), dp(36), Gravity.CENTER));
        addView(body, new LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        setVisibility(GONE);
    }

    private int dp(int v) {
        return Math.round(v * density);
    }

    boolean isOpen() {
        return open;
    }

    WebView web() {
        return web;
    }

    void open(String commentsUrl, int height) {
        setHeight(height);
        if (!commentsUrl.equals(url)) {
            url = commentsUrl;
            spinner.setVisibility(VISIBLE);
            web.loadUrl(commentsUrl);
        }
        if (!open) {
            open = true;
            setVisibility(VISIBLE);
            setTranslationY(height);
            animate().translationY(0f).setDuration(220).setInterpolator(new DecelerateInterpolator()).start();
        }
    }

    void setHeight(int height) {
        ViewGroup.LayoutParams lp = getLayoutParams();
        if (lp != null && lp.height != height) {
            lp.height = height;
            setLayoutParams(lp);
        }
    }

    /** Follows the phone's light/dark setting while the app is open. */
    void setDark(boolean dark) {
        sheet.setColor(dark ? Color.BLACK : Color.WHITE);
        pill.setColor(dark ? 0x66FFFFFF : 0x40000000);
        close.setTextColor(dark ? Color.WHITE : Color.BLACK);
        web.setBackgroundColor(dark ? Color.BLACK : Color.WHITE);
    }

    void close() {
        if (!open) return;
        open = false;
        // Navigated inside the panel (to a profile): the next open reloads the comments.
        String current = web.getUrl();
        if (web.canGoBack() && current != null && !current.equals(url)) url = null;
        web.evaluateJavascript("document.querySelectorAll('video').forEach(v=>v.pause())", null);
        animate().translationY(getHeight()).setDuration(200).withEndAction(() -> setVisibility(GONE)).start();
    }

    void pageReady() {
        spinner.setVisibility(GONE);
    }

    /** Back inside the comments (e.g. from a profile) before closing. */
    boolean goBack() {
        String current = web.getUrl();
        if (web.canGoBack() && current != null && !current.equals(url)) {
            web.goBack();
            return true;
        }
        return false;
    }

    private final class DragToClose implements OnTouchListener {
        private float startY;
        private boolean dragging;

        @SuppressLint("ClickableViewAccessibility")
        @Override
        public boolean onTouch(View v, MotionEvent e) {
            switch (e.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    startY = e.getRawY();
                    dragging = false;
                    return true;
                case MotionEvent.ACTION_MOVE: {
                    float dy = e.getRawY() - startY;
                    if (dy > dp(6)) dragging = true;
                    if (dragging) setTranslationY(Math.max(0f, dy));
                    return true;
                }
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    if (dragging && getTranslationY() > getHeight() * 0.22f) {
                        host.onCommentsCloseRequested();
                    } else {
                        animate().translationY(0f).setDuration(150).start();
                    }
                    return true;
                default:
                    return false;
            }
        }
    }
}
