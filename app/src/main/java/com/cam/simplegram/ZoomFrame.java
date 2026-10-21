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
    }

    static final float MAX_SCALE = 5f;

    private final Listener listener;
    private final int slop;
    private float scale = 1f, tx = 0f, ty = 0f;
    private boolean pinching;
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
        if (page() == null) return super.dispatchTouchEvent(ev);
        if (split) return dispatchSplit(ev);
        if (isZoomed() || pinching) {
            onZoomTouch(ev);
            return true;
        }
        if (ev.getActionMasked() == MotionEvent.ACTION_POINTER_DOWN && ev.getPointerCount() == 2) {
            if (listener.storyMode() && !holding) {
                // Leave the first finger down on the Story: Instagram pauses it.
                holding = true;
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
        return super.dispatchTouchEvent(ev);
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
        float next = Math.max(0.85f, Math.min(MAX_SCALE, startScale * span / startSpan));
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
        if (scale >= 1f) {
            tx = Math.min(0f, Math.max(w - w * scale, tx));
            ty = Math.min(0f, Math.max(h - h * scale, ty));
        } else {
            tx = (w - w * scale) / 2f;
            ty = (h - h * scale) / 2f;
        }
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

    /** Presses and holds the middle of the page (pauses a Story while a menu is open). */
    void hold() {
        if (holding || page() == null) return;
        long now = SystemClock.uptimeMillis();
        holding = true;
        holdDownTime = now;
        holdX = getWidth() / 2f;
        holdY = getHeight() / 2f;
        MotionEvent down = MotionEvent.obtain(now, now, MotionEvent.ACTION_DOWN, holdX, holdY, 0);
        super.dispatchTouchEvent(down);
        down.recycle();
    }

    boolean isHolding() {
        return holding;
    }

    /** Lets go of a held finger without it counting as a tap. */
    void releaseHold() {
        if (!holding || isZoomed()) return;
        holding = false;
        long now = SystemClock.uptimeMillis();
        MotionEvent cancel = MotionEvent.obtain(holdDownTime, now, MotionEvent.ACTION_CANCEL, holdX, holdY, 0);
        super.dispatchTouchEvent(cancel);
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
        return super.dispatchTouchEvent(ev);
    }
}
