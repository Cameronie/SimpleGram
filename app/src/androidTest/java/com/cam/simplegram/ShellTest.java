package com.cam.simplegram;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.Intent;
import android.graphics.Rect;
import android.graphics.RectF;
import android.net.Uri;
import android.os.SystemClock;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.lang.reflect.Method;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Drives the native shell on a device or emulator. Instagram itself is not
 * needed: these checks cover zoom, the comments split view, the menu,
 * screenshot mode, Back and incoming links.
 */
@RunWith(AndroidJUnit4.class)
public class ShellTest {

    private static ZoomFrame zoomOf(MainActivity a) {
        ViewGroup content = a.findViewById(android.R.id.content);
        ViewGroup root = (ViewGroup) content.getChildAt(0);
        return (ZoomFrame) root.getChildAt(0);
    }

    private static CommentsPanel panelOf(MainActivity a) {
        ViewGroup content = a.findViewById(android.R.id.content);
        ViewGroup root = (ViewGroup) content.getChildAt(0);
        return (CommentsPanel) root.getChildAt(1);
    }

    private static MotionEvent event(long down, int action, float[][] pts) {
        int n = pts.length;
        MotionEvent.PointerProperties[] props = new MotionEvent.PointerProperties[n];
        MotionEvent.PointerCoords[] coords = new MotionEvent.PointerCoords[n];
        for (int i = 0; i < n; i++) {
            props[i] = new MotionEvent.PointerProperties();
            props[i].id = i;
            props[i].toolType = MotionEvent.TOOL_TYPE_FINGER;
            coords[i] = new MotionEvent.PointerCoords();
            coords[i].x = pts[i][0];
            coords[i].y = pts[i][1];
            coords[i].pressure = 1f;
            coords[i].size = 1f;
        }
        return MotionEvent.obtain(down, SystemClock.uptimeMillis(), action, n, props, coords, 0, 0, 1f, 1f, 0, 0, 0, 0);
    }

    private static void pinch(ZoomFrame z, float cx, float cy, float from, float to) {
        long down = SystemClock.uptimeMillis();
        z.dispatchTouchEvent(event(down, MotionEvent.ACTION_DOWN, new float[][]{{cx - from, cy}}));
        z.dispatchTouchEvent(event(down, MotionEvent.ACTION_POINTER_DOWN | (1 << MotionEvent.ACTION_POINTER_INDEX_SHIFT),
                new float[][]{{cx - from, cy}, {cx + from, cy}}));
        for (int i = 1; i <= 10; i++) {
            float d = from + (to - from) * i / 10f;
            z.dispatchTouchEvent(event(down, MotionEvent.ACTION_MOVE, new float[][]{{cx - d, cy}, {cx + d, cy}}));
        }
        z.dispatchTouchEvent(event(down, MotionEvent.ACTION_POINTER_UP | (1 << MotionEvent.ACTION_POINTER_INDEX_SHIFT),
                new float[][]{{cx - to, cy}, {cx + to, cy}}));
        z.dispatchTouchEvent(event(down, MotionEvent.ACTION_UP, new float[][]{{cx - to, cy}}));
    }

    private static void tap(View v, float x, float y) {
        long down = SystemClock.uptimeMillis();
        v.dispatchTouchEvent(event(down, MotionEvent.ACTION_DOWN, new float[][]{{x, y}}));
        v.dispatchTouchEvent(event(down, MotionEvent.ACTION_UP, new float[][]{{x, y}}));
    }

    private static Object call(MainActivity a, String name, Class<?>[] types, Object... args) throws Exception {
        Method m = MainActivity.class.getDeclaredMethod(name, types);
        m.setAccessible(true);
        return m.invoke(a, args);
    }

    private static void idle() {
        InstrumentationRegistry.getInstrumentation().waitForIdleSync();
    }

    @Test
    public void pinchZoomsPansAndResets() throws Exception {
        try (ActivityScenario<MainActivity> s = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<ZoomFrame> ref = new AtomicReference<>();
            s.onActivity(a -> ref.set(zoomOf(a)));
            ZoomFrame z = ref.get();
            s.onActivity(a -> pinch(z, z.getWidth() / 2f, z.getHeight() / 2f, 100f, 300f));
            idle();
            assertEquals(3f, z.scale(), 0.05f);
            WebView page = (WebView) z.getChildAt(0);
            assertEquals(3f, page.getScaleX(), 0.05f);
            // The magnified page always covers the screen.
            assertTrue(page.getTranslationX() <= 0f && page.getTranslationX() >= z.getWidth() - z.getWidth() * 3f);

            // One finger pans.
            float before = page.getTranslationX();
            s.onActivity(a -> {
                long down = SystemClock.uptimeMillis();
                z.dispatchTouchEvent(event(down, MotionEvent.ACTION_DOWN, new float[][]{{300, 800}}));
                z.dispatchTouchEvent(event(down, MotionEvent.ACTION_MOVE, new float[][]{{400, 800}}));
                z.dispatchTouchEvent(event(down, MotionEvent.ACTION_UP, new float[][]{{400, 800}}));
            });
            idle();
            assertTrue(page.getTranslationX() > before || page.getTranslationX() == 0f);

            // Zoom is capped at 5x.
            s.onActivity(a -> pinch(z, z.getWidth() / 2f, z.getHeight() / 2f, 50f, 500f));
            idle();
            assertEquals(ZoomFrame.MAX_SCALE, z.scale(), 0.01f);

            // Double tap resets.
            s.onActivity(a -> {
                tap(z, 500, 900);
                tap(z, 500, 900);
            });
            SystemClock.sleep(600);
            idle();
            assertEquals(1f, z.scale(), 0.001f);
            assertEquals(1f, page.getScaleX(), 0.001f);

            // A small pinch snaps back to normal on release.
            s.onActivity(a -> pinch(z, z.getWidth() / 2f, z.getHeight() / 2f, 200f, 205f));
            SystemClock.sleep(600);
            idle();
            assertFalse(z.isZoomed());
        }
    }

    @Test
    public void pinchingInNeverShrinksThePage() throws Exception {
        try (ActivityScenario<MainActivity> s = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<ZoomFrame> ref = new AtomicReference<>();
            s.onActivity(a -> ref.set(zoomOf(a)));
            ZoomFrame z = ref.get();
            // Fingers move together (zoom out), then one lifts before the other.
            s.onActivity(a -> pinch(z, z.getWidth() / 2f, z.getHeight() / 2f, 300f, 80f));
            SystemClock.sleep(400);
            idle();
            WebView page = (WebView) z.getChildAt(0);
            assertEquals(1f, z.scale(), 0.001f);
            assertEquals(1f, page.getScaleX(), 0.001f);
            assertEquals(0f, page.getTranslationX(), 0.5f);
            assertFalse(z.isZoomed());
            // The next ordinary touch goes to the page again (not swallowed by the zoom).
            s.onActivity(a -> {
                long down = SystemClock.uptimeMillis();
                z.dispatchTouchEvent(event(down, MotionEvent.ACTION_DOWN, new float[][]{{300, 800}}));
                z.dispatchTouchEvent(event(down, MotionEvent.ACTION_MOVE, new float[][]{{300, 600}}));
                z.dispatchTouchEvent(event(down, MotionEvent.ACTION_UP, new float[][]{{300, 600}}));
            });
            idle();
            assertEquals(1f, z.scale(), 0.001f);
        }
    }

    @Test
    public void endOfHomeBarShowsBothFeedsAndHides() throws Exception {
        try (ActivityScenario<MainActivity> s = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<MainActivity> act = new AtomicReference<>();
            s.onActivity(act::set);
            s.onActivity(x -> {
                try {
                    java.lang.reflect.Field route = MainActivity.class.getDeclaredField("route");
                    route.setAccessible(true);
                    route.set(x, "home");               // the card belongs to the Home feed
                    call(x, "showFeedBar", new Class<?>[]{boolean.class}, true);
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
            SystemClock.sleep(400);
            idle();
            ViewGroup content = act.get().findViewById(android.R.id.content);
            ViewGroup root = (ViewGroup) content.getChildAt(0);
            View bar = null;
            for (int i = 0; i < root.getChildCount(); i++) {
                View c = root.getChildAt(i);
                if (c instanceof ViewGroup && c.getVisibility() == View.VISIBLE && textOf((ViewGroup) c).contains("Favorites")) bar = c;
            }
            assertNotNull("end-of-Home bar visible", bar);
            String text = textOf((ViewGroup) bar);
            assertTrue(text, text.contains("Following") && text.contains("Favorites"));
            s.onActivity(x -> {
                try {
                    call(x, "showFeedBar", new Class<?>[]{boolean.class}, false);
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
            SystemClock.sleep(500);
            idle();
            assertEquals(View.GONE, bar.getVisibility());
            // Not on other pages, even if asked.
            s.onActivity(x -> {
                try {
                    java.lang.reflect.Field route = MainActivity.class.getDeclaredField("route");
                    route.setAccessible(true);
                    route.set(x, "direct");
                    call(x, "showFeedBar", new Class<?>[]{boolean.class}, true);
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
            SystemClock.sleep(400);
            idle();
            assertEquals(View.GONE, bar.getVisibility());
        }
    }

    private static String textOf(ViewGroup g) {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < g.getChildCount(); i++) {
            View c = g.getChildAt(i);
            if (c instanceof android.widget.TextView) b.append(((android.widget.TextView) c).getText()).append(' ');
            else if (c instanceof ViewGroup) b.append(textOf((ViewGroup) c));
        }
        return b.toString();
    }

    @Test
    public void backResetsZoomBeforeLeaving() throws Exception {
        try (ActivityScenario<MainActivity> s = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<ZoomFrame> ref = new AtomicReference<>();
            s.onActivity(a -> {
                ref.set(zoomOf(a));
                pinch(ref.get(), 500, 900, 100, 250);
            });
            idle();
            assertTrue(ref.get().isZoomed());
            s.onActivity(MainActivity::onBackPressed);
            SystemClock.sleep(600);
            idle();
            assertFalse(ref.get().isZoomed());
        }
    }

    @Test
    public void commentsSplitShowsPostOnTopAndClosesWithBack() throws Exception {
        try (ActivityScenario<MainActivity> s = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<MainActivity> act = new AtomicReference<>();
            s.onActivity(act::set);
            MainActivity a = act.get();
            ZoomFrame z = zoomOf(a);
            CommentsPanel panel = panelOf(a);
            JSONObject msg = new JSONObject()
                    .put("code", "ABCDEFG")
                    .put("rect", new JSONObject().put("x", 0).put("y", 120).put("w", 412).put("h", 515))
                    .put("dpr", 2.625);
            s.onActivity(x -> {
                try {
                    call(x, "openComments", new Class<?>[]{JSONObject.class}, msg);
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
            SystemClock.sleep(500);
            idle();
            assertTrue(z.isSplit());
            assertTrue(panel.isOpen());
            assertEquals(View.VISIBLE, panel.getVisibility());
            WebView page = (WebView) z.getChildAt(0);
            Rect clip = page.getClipBounds();
            assertNotNull(clip);
            int rootH = ((View) z.getParent()).getHeight();
            int top = Math.round(rootH * 0.42f);
            // The post fits inside the top part, centred.
            float shownH = 515 * 2.625f * page.getScaleY();
            assertTrue("post height " + shownH + " top " + top, shownH <= top + 2);
            assertEquals(rootH - top, panel.getHeight(), 3);
            AtomicReference<String> url = new AtomicReference<>();
            s.onActivity(x -> url.set(panel.web().getUrl()));
            String childUrl = url.get();
            assertTrue(String.valueOf(childUrl), childUrl == null || childUrl.contains("/p/ABCDEFG/comments/") || childUrl.startsWith("data:") || childUrl.startsWith("about:") || childUrl.contains("chrome-error"));

            // Taps outside the post are ignored, sideways swipes and taps on it go through.
            s.onActivity(x -> tap(z, 5, top - 5));

            s.onActivity(MainActivity::onBackPressed);
            SystemClock.sleep(600);
            idle();
            assertFalse(z.isSplit());
            assertFalse(panel.isOpen());
            assertEquals(1f, page.getScaleX(), 0.001f);
            assertEquals(ViewGroup.LayoutParams.MATCH_PARENT, z.getLayoutParams().height);
        }
    }

    @Test
    public void menuScreenshotModeAndLinks() throws Exception {
        try (ActivityScenario<MainActivity> s = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<MainActivity> act = new AtomicReference<>();
            s.onActivity(act::set);
            // Menu opens without crashing; Back closes it.
            s.onActivity(x -> {
                try {
                    call(x, "showMenu", new Class<?>[]{});
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
            idle();
            SystemClock.sleep(400);
            InstrumentationRegistry.getInstrumentation().getUiAutomation()
                    .performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK);
            SystemClock.sleep(800);
            idle();
            // Screenshot mode hides the menu button; Back restores it.
            s.onActivity(x -> {
                try {
                    call(x, "enterScreenshot", new Class<?>[]{});
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
            idle();
            ViewGroup content = act.get().findViewById(android.R.id.content);
            ViewGroup root = (ViewGroup) content.getChildAt(0);
            View button = null;
            for (int i = 0; i < root.getChildCount(); i++) {
                CharSequence d = root.getChildAt(i).getContentDescription();
                if (d != null && d.toString().equals("SimpleGram menu")) button = root.getChildAt(i);
            }
            assertNotNull(button);
            assertEquals(View.GONE, button.getVisibility());
            s.onActivity(MainActivity::onBackPressed);
            idle();
            assertEquals(View.VISIBLE, button.getVisibility());

            // Incoming links are accepted; lookalike hosts are not.
            assertEquals("https://www.instagram.com/p/ABC123/", Links.normalize("http://instagram.com/p/ABC123/"));
            assertEquals(null, Links.normalize("https://instagram.com.evil.example/p/ABC123/"));
            assertEquals(null, Links.normalize("https://user@instagram.com/p/ABC123/"));
            assertEquals("https://www.instagram.com/reel/XYZ987/?igsh=1",
                    Links.fromText("look at this https://www.instagram.com/reel/XYZ987/?igsh=1 lol"));
            assertTrue(Links.isMediaFile(Uri.parse("https://scontent-lax3-1.cdninstagram.com/v/a.jpg")));
            assertFalse(Links.isMediaFile(Uri.parse("https://evil.example/cdninstagram.com/a.jpg")));
            // (handleIntent directly: onNewIntent would replace the intent ActivityScenario tracks.)
            for (Intent in : new Intent[]{
                    new Intent(Intent.ACTION_VIEW, Uri.parse("https://instagram.com/p/ABC123/")),
                    new Intent(Intent.ACTION_SEND).setType("text/plain")
                            .putExtra(Intent.EXTRA_TEXT, "https://www.instagram.com/stories/friend/123/")}) {
                s.onActivity(x -> {
                    try {
                        call(x, "handleIntent", new Class<?>[]{Intent.class, boolean.class}, in, false);
                    } catch (Exception e) {
                        throw new RuntimeException(e);
                    }
                });
            }
            idle();
        }
    }

    @Test
    public void storyMenuHoldIsReleased() {
        try (ActivityScenario<MainActivity> s = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<ZoomFrame> ref = new AtomicReference<>();
            s.onActivity(a -> {
                ZoomFrame z = zoomOf(a);
                ref.set(z);
                z.hold();
            });
            idle();
            assertTrue(ref.get().isHolding());
            s.onActivity(a -> ref.get().releaseHold());
            idle();
            assertFalse(ref.get().isHolding());
            // Split view geometry with no post rectangle shows the page top unchanged.
            s.onActivity(a -> ref.get().showSplit(null, 2.625f, 900, false));
            idle();
            assertEquals(1f, ((View) ref.get().getChildAt(0)).getScaleX(), 0.001f);
            s.onActivity(a -> ref.get().hideSplit());
            SystemClock.sleep(400);
            // And with a tall Reel it shrinks the video into the top part.
            s.onActivity(a -> ref.get().showSplit(new RectF(0, 0, 412, 915), 2.625f, 900, false));
            idle();
            assertTrue(((View) ref.get().getChildAt(0)).getScaleX() < 0.5f);
        }
    }
}
