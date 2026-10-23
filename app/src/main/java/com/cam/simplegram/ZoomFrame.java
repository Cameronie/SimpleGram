package com.cam.simplegram;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Color;
import android.graphics.Rect;
import android.graphics.RectF;
import android.os.SystemClock;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.animation.DecelerateInterpolator;
import android.widget.FrameLayout;

/**
 * Holds the Instagram page and magnifies it like a loupe.
 *
 * Two fingers zoom up to 5x and one finger pans while zoomed. The page itself is
 * never resized or re-laid out, so the feed cannot jump, a carousel keeps its
 * photo and videos keep playing. In a Story the first finger stays "held" on the
 * page while zoomed, which is Instagram's own pause, so the Story does not move on.
 *
 * The same transform shows a post in the top half of the screen above the
 * comments panel.
 */
final class ZoomFrame extends FrameLayout {
    interface Listener {
        boolean storyMode();

        void onZoomChanged(float scale);

        /**
         * The finger held on the page starts (before it presses) or has ended.
         * WebView cancels a held touch as soon as a dialog or the notification
         * shade takes focus; the page must not take that for the end of the hold.
         */
        void onHoldChanged(boolean on);
    }

    static final float MAX_SCALE = 5f;

    private final Listener listener;
    private final int slop;
    private float scale = 1f, tx = 0f, ty = 0f;
    private boolean pinching;
    // Once two fingers touch, the whole gesture is the zoom's until the last
    // finger lifts. Half a gesture must never leak to the page: a broken
    // touch sequence can leave the page ignoring scrolls.
    private boolean owned;
    private float startSpan, startScale, startTx, startTy, startFx, startFy;
    private int panPointer = -1;
    private float lastX, lastY, tapX, tapY, prevTapX, prevTapY;
    private boolean tapCandidate;
    private long prevTapTime;
    private ValueAnimator animator;

    // A finger kept down on the page (pauses Stories).
    private boolean holding;
    private long holdDownTime;
    private float holdX, holdY;

    // Comments split view.
    private boolean split;
    private final RectF splitHit = new RectF();
    private int splitGesture;
    private boolean splitDecided;
    private float splitX, splitY;

    // B25: MOVEs handed on to the page in the current touch, and in the last few
    // finished ones. A report that drags stop scrolling counts only when the
    // drags really reached the page (this frame didn't keep them).
    private int seqMoves;
    private final int[] lastMoves = new int[4];
    private int lastMovesAt;

    ZoomFrame(Context context, Listener listener) {
        super(context);
        this.listener = listener;
        this.slop = ViewConfiguration.get(context).getScaledTouchSlop();
        setBackgroundColor(Color.BLACK);
    }

    private View page() {
        return getChildAt(0);
    }

    boolean isZoomed() {
        return scale > 1.001f;
    }

    float scale() {
        return scale;
    }

    /** The part of the page currently on screen, in page pixels. */
    RectF visiblePageRect() {
        float w = getWidth(), h = getHeight();
        return new RectF(-tx / scale, -ty / scale, (w - tx) / scale, (h - ty) / scale);
    }

    @Override
    public boolean dispatchTouchEvent(MotionEvent ev) {
        int a = ev.getActionMasked();
        if (a == MotionEvent.ACTION_DOWN) seqMoves = 0;
        boolean r = route(ev);
        if (a == MotionEvent.ACTION_UP || a == MotionEvent.ACTION_CANCEL) {
            lastMoves[lastMovesAt] = seqMoves;
            lastMovesAt = (lastMovesAt + 1) % lastMoves.length;
        }
        return r;
    }

    /** Hands a touch event on to the page, counting the MOVEs that get there. */
    private boolean toPage(MotionEvent ev) {
        if (ev.getActionMasked() == MotionEvent.ACTION_MOVE) seqMoves++;
        return super.dispatchTouchEvent(ev);
    }

    /** The most MOVEs any of the last few finished touches handed to the page. */
    int recentPageMoves() {
        int most = 0;
        for (int n : lastMoves) most = Math.max(most, n);
        return most;
    }

    private boolean route(MotionEvent ev) {
        if (page() == null) return super.dispatchTouchEvent(ev);
        if (split) return dispatchSplit(ev);
        int action = ev.getActionMasked();
        if (action == MotionEvent.ACTION_DOWN) owned = isZoomed();
        if (owned) {
            onZoomTouch(ev);
            if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) owned = false;
            return true;
        }
        if (action == MotionEvent.ACTION_POINTER_DOWN && ev.getPointerCount() == 2) {
            owned = true;
            if (listener.storyMode() && !holding) {
                // Leave the first finger down on the Story: Instagram pauses it.
                holding = true;
                listener.onHoldChanged(true);
                holdDownTime = ev.getDownTime();
                holdX = ev.getX(0);
                holdY = ev.getY(0);
            } else if (!holding) {
                cancelPage(ev);
            }
            startPinch(ev);
            pinching = true;
            tapCandidate = false;
            return true;
        }
        return toPage(ev);
    }

    private void onZoomTouch(MotionEvent ev) {
        switch (ev.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                stopAnimation();
                panPointer = ev.getPointerId(0);
                lastX = tapX = ev.getX();
                lastY = tapY = ev.getY();
                tapCandidate = true;
                break;
            case MotionEvent.ACTION_POINTER_DOWN:
                if (ev.getPointerCount() >= 2) {
                    startPinch(ev);
                    pinching = true;
                    tapCandidate = false;
                }
                break;
            case MotionEvent.ACTION_MOVE:
                if (pinching && ev.getPointerCount() >= 2) {
                    updatePinch(ev);
                } else {
                    int i = ev.findPointerIndex(panPointer);
                    if (i < 0) {
                        i = 0;
                        panPointer = ev.getPointerId(0);
                        lastX = ev.getX(0);
                        lastY = ev.getY(0);
                    }
                    float x = ev.getX(i), y = ev.getY(i);
                    if (tapCandidate && Math.hypot(x - tapX, y - tapY) > slop) tapCandidate = false;
                    if (isZoomed()) {
                        tx += x - lastX;
                        ty += y - lastY;
                        clamp();
                        apply();
                    }
                    lastX = x;
                    lastY = y;
                }
                break;
            case MotionEvent.ACTION_POINTER_UP: {
                int up = ev.getActionIndex();
                int keep = up == 0 ? 1 : 0;
                panPointer = ev.getPointerId(keep);
                lastX = ev.getX(keep);
                lastY = ev.getY(keep);
                if (ev.getPointerCount() - 1 < 2) pinching = false;
                break;
            }
            case MotionEvent.ACTION_UP:
                pinching = false;
                if (scale < 1.08f) {
                    reset(true);
                } else if (tapCandidate) {
                    long now = ev.getEventTime();
                    if (now - prevTapTime < 320 && Math.hypot(tapX - prevTapX, tapY - prevTapY) < slop * 4) {
                        prevTapTime = 0;
                        reset(true);
                    } else {
                        prevTapTime = now;
                        prevTapX = tapX;
                        prevTapY = tapY;
                    }
                }
                break;
            case MotionEvent.ACTION_CANCEL:
                pinching = false;
                if (scale < 1.08f) reset(true);
                break;
            default:
                break;
        }
    }

    private void startPinch(MotionEvent ev) {
        stopAnimation();
        float dx = ev.getX(1) - ev.getX(0), dy = ev.getY(1) - ev.getY(0);
        startSpan = Math.max(1f, (float) Math.hypot(dx, dy));
        startScale = scale;
        startTx = tx;
        startTy = ty;
        startFx = (ev.getX(0) + ev.getX(1)) / 2f;
        startFy = (ev.getY(0) + ev.getY(1)) / 2f;
    }

    private void updatePinch(MotionEvent ev) {
        float dx = ev.getX(1) - ev.getX(0), dy = ev.getY(1) - ev.getY(0);
        float span = Math.max(1f, (float) Math.hypot(dx, dy));
        float fx = (ev.getX(0) + ev.getX(1)) / 2f, fy = (ev.getY(0) + ev.getY(1)) / 2f;
        // Never smaller than the screen.
        float next = Math.max(1f, Math.min(MAX_SCALE, startScale * span / startSpan));
        // Keep the page point that started under the fingers under the fingers.
        float cx = (startFx - startTx) / startScale, cy = (startFy - startTy) / startScale;
        scale = next;
        tx = fx - cx * next;
        ty = fy - cy * next;
        clamp();
        apply();
    }

    private void clamp() {
        float w = getWidth(), h = getHeight();
        scale = Math.max(1f, scale);
        tx = Math.min(0f, Math.max(w - w * scale, tx));
        ty = Math.min(0f, Math.max(h - h * scale, ty));
    }

    private void apply() {
        View p = page();
        p.setPivotX(0f);
        p.setPivotY(0f);
        p.setScaleX(scale);
        p.setScaleY(scale);
        p.setTranslationX(tx);
        p.setTranslationY(ty);
        listener.onZoomChanged(scale);
    }

    private void stopAnimation() {
        if (animator != null) {
            animator.cancel();
            animator = null;
        }
    }

    /** Back to normal size, letting go of a held Story. */
    void reset(boolean animate) {
        stopAnimation();
        pinching = false;
        if (!animate || scale == 1f && tx == 0f && ty == 0f) {
            scale = 1f;
            tx = ty = 0f;
            apply();
            releaseHold();
            return;
        }
        final float s0 = scale, x0 = tx, y0 = ty;
        animator = ValueAnimator.ofFloat(0f, 1f);
        animator.setDuration(180);
        animator.setInterpolator(new DecelerateInterpolator());
        animator.addUpdateListener(a -> {
            float f = (float) a.getAnimatedValue();
            scale = s0 + (1f - s0) * f;
            tx = x0 * (1f - f);
            ty = y0 * (1f - f);
            apply();
        });
        animator.addListener(new android.animation.AnimatorListenerAdapter() {
            @Override
            public void onAnimationEnd(android.animation.Animator a) {
                scale = 1f;
                tx = ty = 0f;
                apply();
                releaseHold();
            }
        });
        animator.start();
    }

    /**
     * Presses and holds the middle of the page (pauses a Story while a menu is open).
     * The press and its release go straight to the page view, not through this
     * frame's touch target: a release that went astray would leave the web engine
     * believing a finger is still down (B25).
     */
    void hold() {
        if (holding || page() == null) return;
        long now = SystemClock.uptimeMillis();
        holding = true;
        holdDownTime = now;
        holdX = getWidth() / 2f;
        holdY = getHeight() / 2f;
        listener.onHoldChanged(true);
        MotionEvent down = MotionEvent.obtain(now, now, MotionEvent.ACTION_DOWN, holdX, holdY, 0);
        page().dispatchTouchEvent(down);
        down.recycle();
    }

    boolean isHolding() {
        return holding;
    }

    /** Lets go of a held finger without it counting as a tap. */
    void releaseHold() {
        if (!holding || isZoomed()) return;
        dropHold();
    }

    private void dropHold() {
        holding = false;
        MotionEvent cancel = holdCancel();
        View p = page();
        if (p != null) p.dispatchTouchEvent(cancel);
        cancel.recycle();
        listener.onHoldChanged(false);
    }

    /**
     * The cancel that ends the held finger, for whichever view has the page's
     * input at the moment (the app also sends it to a full-screen view). The
     * caller recycles it.
     */
    MotionEvent holdCancel() {
        return MotionEvent.obtain(holdDownTime, SystemClock.uptimeMillis(), MotionEvent.ACTION_CANCEL, holdX, holdY, 0);
    }

    boolean isOwned() {
        return owned;
    }

    boolean isPinching() {
        return pinching;
    }

    boolean isAnimating() {
        return animator != null;
    }

    /**
     * B25's harmless reset: back to 1x with no gesture in progress, any held
     * finger let go (even while zoomed), split view off unless the comments
     * still need it, and one cancel straight to the page view. It cannot repair
     * the web engine's own touch state; it clears everything this frame holds.
     */
    void forceIdle(boolean keepSplit) {
        stopAnimation();
        owned = false;
        pinching = false;
        panPointer = -1;
        tapCandidate = false;
        View p = page();
        if (p == null) return;
        if (split && !keepSplit) {
            split = false;
            p.animate().cancel();
            p.setClipBounds(null);
        }
        if (!split) {
            scale = 1f;
            tx = ty = 0f;
            apply();
        }
        if (holding) dropHold();
        long now = SystemClock.uptimeMillis();
        MotionEvent cancel = MotionEvent.obtain(now, now, MotionEvent.ACTION_CANCEL, getWidth() / 2f, getHeight() / 2f, 0);
        p.dispatchTouchEvent(cancel);
        cancel.recycle();
    }

    private void cancelPage(MotionEvent ev) {
        MotionEvent cancel = MotionEvent.obtain(ev);
        cancel.setAction(MotionEvent.ACTION_CANCEL);
        super.dispatchTouchEvent(cancel);
        cancel.recycle();
    }

    /* ---------------- Comments split view ---------------- */

    boolean isSplit() {
        return split;
    }

    /**
     * Shows the post's photo/video (rect in page CSS pixels) fitted into the top
     * {@code topHeight} pixels. A null rect shows the top of the page as it is.
     */
    void showSplit(RectF css, float dpr, int topHeight, boolean animate) {
        if (isZoomed() || holding) reset(false);
        split = true;
        View p = page();
        float w = getWidth();
        float s = 1f, nx = 0f, ny = 0f;
        RectF r;
        if (css != null && css.width() > 1 && css.height() > 1) {
            r = new RectF(css.left * dpr, css.top * dpr, css.right * dpr, css.bottom * dpr);
            s = Math.min(1f, Math.min(w / r.width(), topHeight / r.height()));
            nx = (w - r.width() * s) / 2f - r.left * s;
            ny = (topHeight - r.height() * s) / 2f - r.top * s;
            p.setClipBounds(new Rect(Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)));
        } else {
            r = new RectF(0, 0, w, topHeight);
            p.setClipBounds(null);
        }
        splitHit.set(nx + r.left * s, ny + r.top * s, nx + r.right * s, ny + r.bottom * s);
        p.setPivotX(0f);
        p.setPivotY(0f);
        p.animate().cancel();
        if (animate) {
            p.animate().scaleX(s).scaleY(s).translationX(nx).translationY(ny).setDuration(220)
                    .setInterpolator(new DecelerateInterpolator()).start();
        } else {
            p.setScaleX(s);
            p.setScaleY(s);
            p.setTranslationX(nx);
            p.setTranslationY(ny);
        }
    }

    void hideSplit() {
        if (!split) return;
        split = false;
        final View p = page();
        p.animate().cancel();
        p.animate().scaleX(1f).scaleY(1f).translationX(0f).translationY(0f).setDuration(200)
                .setInterpolator(new DecelerateInterpolator())
                .withEndAction(() -> p.setClipBounds(null)).start();
        scale = 1f;
        tx = ty = 0f;
    }

    /** In split view: taps and sideways swipes reach the post; scrolling the page does not. */
    private boolean dispatchSplit(MotionEvent ev) {
        int action = ev.getActionMasked();
        if (action == MotionEvent.ACTION_DOWN) {
            splitGesture = splitHit.contains(ev.getX(), ev.getY()) ? 1 : 0;
            splitX = ev.getX();
            splitY = ev.getY();
            splitDecided = false;
        }
        if (splitGesture == 0) return true;
        if (ev.getPointerCount() > 1) {
            cancelPage(ev);
            splitGesture = 0;
            return true;
        }
        if (action == MotionEvent.ACTION_MOVE && !splitDecided) {
            float dx = ev.getX() - splitX, dy = ev.getY() - splitY;
            if (Math.abs(dx) > slop || Math.abs(dy) > slop) {
                splitDecided = true;
                if (Math.abs(dy) > Math.abs(dx)) {
                    cancelPage(ev);
                    splitGesture = 0;
                    return true;
                }
            }
        }
        return toPage(ev);
    }
}
