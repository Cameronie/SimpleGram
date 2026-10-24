package com.cam.simplegram;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Rect;
import android.graphics.RectF;
import android.net.Uri;
import android.os.SystemClock;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
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
    public void endOfHomeBarShowsFollowingOnlyAndHides() throws Exception {
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
                if (c instanceof ViewGroup && c.getVisibility() == View.VISIBLE && "End of Home".equals(String.valueOf(c.getContentDescription()))) bar = c;
            }
            assertNotNull("end-of-Home bar visible", bar);
            String text = textOf((ViewGroup) bar);
            // Following only: Favorites stays in the menu.
            assertTrue(text, text.contains("Following") && !text.contains("Favorites"));
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

    @Test
    public void endOfHomeCardShowsInstagramsLineOrAStall() throws Exception {
        try (ActivityScenario<MainActivity> s = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<MainActivity> act = new AtomicReference<>();
            s.onActivity(act::set);
            String caughtUp = new JSONObject().put("action", "feedEnd").put("on", true).put("caughtUp", true)
                    .put("subtitle", "You've seen all new posts from the past 3 days.").toString();
            String stalled = new JSONObject().put("action", "feedEnd").put("on", true).put("stalled", true).toString();
            s.onActivity(x -> {
                try {
                    java.lang.reflect.Field route = MainActivity.class.getDeclaredField("route");
                    route.setAccessible(true);
                    route.set(x, "home");
                    call(x, "onMessage", new Class<?>[]{String.class, String.class}, "main", caughtUp);
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
            SystemClock.sleep(400);
            idle();
            String text = textOf(feedCard(act.get()));
            assertTrue(text, text.contains("You're all caught up") && text.contains("past 3 days")
                    && text.contains("Following") && !text.contains("Favorites"));
            s.onActivity(x -> {
                try {
                    call(x, "onMessage", new Class<?>[]{String.class, String.class}, "main", stalled);
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
            idle();
            text = textOf(feedCard(act.get()));
            assertTrue(text, text.contains("Home isn't loading more") && !text.contains("past 3 days"));
        }
    }

    private static void message(ActivityScenario<MainActivity> s, String json) {
        s.onActivity(x -> {
            try {
                call(x, "onMessage", new Class<?>[]{String.class, String.class}, "main", json);
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        });
    }

    private static View visibleChild(MainActivity a, String description) {
        ViewGroup root = (ViewGroup) ((ViewGroup) a.findViewById(android.R.id.content)).getChildAt(0);
        for (int i = 0; i < root.getChildCount(); i++) {
            View c = root.getChildAt(i);
            if (c.getVisibility() == View.VISIBLE && description.equals(String.valueOf(c.getContentDescription()))) return c;
        }
        return null;
    }

    @Test
    public void endOfHomeCardIsIgnoredOnFollowing() throws Exception {
        try (ActivityScenario<MainActivity> s = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<MainActivity> act = new AtomicReference<>();
            s.onActivity(act::set);
            message(s, new JSONObject().put("action", "route").put("route", "home")
                    .put("url", "https://www.instagram.com/?variant=following").toString());
            message(s, new JSONObject().put("action", "feedEnd").put("on", true).put("caughtUp", true).toString());
            SystemClock.sleep(400);
            idle();
            assertEquals(null, visibleChild(act.get(), "End of Home"));
            // Back on Home the same message shows the card.
            message(s, new JSONObject().put("action", "route").put("route", "home")
                    .put("url", "https://www.instagram.com/").toString());
            message(s, new JSONObject().put("action", "feedEnd").put("on", true).put("caughtUp", true).toString());
            SystemClock.sleep(400);
            idle();
            assertNotNull(visibleChild(act.get(), "End of Home"));
        }
    }

    @Test
    public void endOfHomeCardFollowsHomeGoingOnIntoFollowing() throws Exception {
        try (ActivityScenario<MainActivity> s = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<MainActivity> act = new AtomicReference<>();
            s.onActivity(act::set);
            message(s, new JSONObject().put("action", "route").put("route", "home")
                    .put("url", "https://www.instagram.com/").toString());
            // Running: Home goes on, so no card even if asked.
            message(s, new JSONObject().put("action", "feedEnd").put("on", true).put("caughtUp", true).put("cont", "running").toString());
            SystemClock.sleep(400);
            idle();
            assertNull(visibleChild(act.get(), "End of Home"));
            // Running but stalled: the Following card.
            message(s, new JSONObject().put("action", "feedEnd").put("on", true).put("stalled", true).put("cont", "running").toString());
            SystemClock.sleep(400);
            idle();
            String text = textOf(feedCard(act.get()));
            assertTrue(text, text.contains("Home isn't loading more") && text.contains("Following"));
            // Failed: the card as without the continuation.
            message(s, new JSONObject().put("action", "feedEnd").put("on", true).put("caughtUp", true).put("cont", "failed")
                    .put("subtitle", "You've seen all new posts from the past 3 days.").toString());
            idle();
            text = textOf(feedCard(act.get()));
            assertTrue(text, text.contains("You're all caught up on Home") && text.contains("Following"));
            // Done: everything new from people you follow was shown.
            message(s, new JSONObject().put("action", "feedEnd").put("on", true).put("caughtUp", true).put("cont", "done")
                    .put("subtitle", "You've seen all new posts from the past 3 days.").toString());
            idle();
            text = textOf(feedCard(act.get()));
            assertTrue(text, text.contains("That's everything new from people you follow") && !text.contains("past 3 days")
                    && text.contains("Following"));
            // The required stop after about 200 posts.
            message(s, new JSONObject().put("action", "feedEnd").put("on", true).put("caughtUp", true).put("cont", "limit")
                    .put("contWhy", "posts").toString());
            idle();
            text = textOf(feedCard(act.get()));
            assertTrue(text, text.contains("Keep going in Following") && text.contains("about 200 posts"));
            // The stop after about 25 requests: no claim about a count of posts.
            message(s, new JSONObject().put("action", "feedEnd").put("on", true).put("caughtUp", true).put("cont", "limit")
                    .put("contWhy", "requests").toString());
            idle();
            text = textOf(feedCard(act.get()));
            assertTrue(text, text.contains("Keep going in Following") && !text.contains("200"));
            // Instagram stopped paging while Following still had posts: the Following card, never "everything".
            message(s, new JSONObject().put("action", "feedEnd").put("on", true).put("caughtUp", true).put("cont", "stopped")
                    .put("contWhy", "homeEnd").toString());
            idle();
            text = textOf(feedCard(act.get()));
            assertTrue(text, text.contains("You're all caught up on Home") && !text.contains("That's everything")
                    && text.contains("Following"));
        }
    }

    @Test
    public void homeSkipNoteNeverShowsOverTheEndCard() throws Exception {
        try (ActivityScenario<MainActivity> s = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<MainActivity> act = new AtomicReference<>();
            s.onActivity(act::set);
            message(s, new JSONObject().put("action", "route").put("route", "home")
                    .put("url", "https://www.instagram.com/").toString());
            message(s, new JSONObject().put("action", "skipStatus").put("on", true).put("kind", "homeSkipping").toString());
            idle();
            assertNotNull(visibleChild(act.get(), "Skip status"));
            // A stalled card while the note is on: the card only.
            message(s, new JSONObject().put("action", "feedEnd").put("on", true).put("stalled", true).put("cont", "running").toString());
            SystemClock.sleep(400);
            idle();
            assertNotNull(visibleChild(act.get(), "End of Home"));
            assertNull(visibleChild(act.get(), "Skip status"));
        }
    }

    @Test
    public void continueHomeSwitchReachesThePageConfig() throws Exception {
        try (ActivityScenario<MainActivity> s = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<MainActivity> act = new AtomicReference<>();
            s.onActivity(act::set);
            AtomicReference<String> before = new AtomicReference<>();
            AtomicReference<String> after = new AtomicReference<>();
            s.onActivity(x -> {
                try {
                    before.set((String) call(x, "config", new Class<?>[]{String.class}, "main"));
                    call(x, "toggleContinueHome", new Class<?>[]{});
                    after.set((String) call(x, "config", new Class<?>[]{String.class}, "main"));
                    call(x, "toggleContinueHome", new Class<?>[]{});   // back as it was
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
            boolean was = new JSONObject(before.get()).getBoolean("continueHome");
            assertEquals(!was, new JSONObject(after.get()).getBoolean("continueHome"));
        }
    }

    @Test
    public void homeSkipNoteShowsOnHomeOnly() throws Exception {
        try (ActivityScenario<MainActivity> s = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<MainActivity> act = new AtomicReference<>();
            s.onActivity(act::set);
            message(s, new JSONObject().put("action", "route").put("route", "home")
                    .put("url", "https://www.instagram.com/").toString());
            message(s, new JSONObject().put("action", "skipStatus").put("on", true).put("kind", "homeSkipping").toString());
            idle();
            View chip = visibleChild(act.get(), "Skip status");
            assertNotNull("skip note on Home", chip);
            assertTrue(String.valueOf(((android.widget.TextView) chip).getText()).contains("Skipping posts you saw in Home"));
            assertNull(visibleChild(act.get(), "End of Home"));
            // Not on Following (that page has its own note).
            message(s, new JSONObject().put("action", "route").put("route", "home")
                    .put("url", "https://www.instagram.com/?variant=following").toString());
            idle();
            assertNull(visibleChild(act.get(), "Skip status"));
            // Off again on Home.
            message(s, new JSONObject().put("action", "route").put("route", "home")
                    .put("url", "https://www.instagram.com/").toString());
            message(s, new JSONObject().put("action", "skipStatus").put("on", false).toString());
            idle();
            assertNull(visibleChild(act.get(), "Skip status"));
        }
    }

    @Test
    public void homeLoadingNoteShowsOnHomeOnlyNeverOverTheCard() throws Exception {
        // B22: the quiet note while Home waits at the bottom for more from Following.
        try (ActivityScenario<MainActivity> s = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<MainActivity> act = new AtomicReference<>();
            s.onActivity(act::set);
            message(s, new JSONObject().put("action", "route").put("route", "home")
                    .put("url", "https://www.instagram.com/").toString());
            message(s, new JSONObject().put("action", "skipStatus").put("on", true).put("kind", "homeLoading").toString());
            idle();
            View chip = visibleChild(act.get(), "Skip status");
            assertNotNull("loading note on Home", chip);
            assertTrue(String.valueOf(((android.widget.TextView) chip).getText()).contains("Loading more from people you follow"));
            // While Home goes on into Following (not stalled), no card.
            message(s, new JSONObject().put("action", "feedEnd").put("on", true).put("cont", "running").toString());
            idle();
            assertNull(visibleChild(act.get(), "End of Home"));
            assertNotNull(visibleChild(act.get(), "Skip status"));
            // The card (the continuation failed): the card only.
            message(s, new JSONObject().put("action", "feedEnd").put("on", true).put("caughtUp", true).put("cont", "failed").toString());
            SystemClock.sleep(400);
            idle();
            assertNotNull(visibleChild(act.get(), "End of Home"));
            assertNull(visibleChild(act.get(), "Skip status"));
            // Not on Following.
            message(s, new JSONObject().put("action", "feedEnd").put("on", false).put("cont", "running").toString());
            message(s, new JSONObject().put("action", "route").put("route", "home")
                    .put("url", "https://www.instagram.com/?variant=following").toString());
            idle();
            assertNull(visibleChild(act.get(), "Skip status"));
        }
    }

    @Test
    public void skipStatusShowsOnFollowingOnlyNeverAsTheCard() throws Exception {
        try (ActivityScenario<MainActivity> s = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<MainActivity> act = new AtomicReference<>();
            s.onActivity(act::set);
            message(s, new JSONObject().put("action", "route").put("route", "home")
                    .put("url", "https://www.instagram.com/?variant=following").toString());
            message(s, new JSONObject().put("action", "skipStatus").put("on", true).put("kind", "skipping").put("n", 19).toString());
            idle();
            View chip = visibleChild(act.get(), "Skip status");
            assertNotNull("skip note visible", chip);
            String text = String.valueOf(((android.widget.TextView) chip).getText());
            assertTrue(text, text.contains("Skipping 19 posts you saw in Home"));
            assertEquals(null, visibleChild(act.get(), "End of Home"));
            message(s, new JSONObject().put("action", "skipStatus").put("on", true).put("kind", "nothingNew").toString());
            idle();
            chip = visibleChild(act.get(), "Skip status");
            assertNotNull(chip);
            assertTrue(String.valueOf(((android.widget.TextView) chip).getText()).contains("Nothing new since Home"));
            // Not on Home, even if asked.
            message(s, new JSONObject().put("action", "route").put("route", "home")
                    .put("url", "https://www.instagram.com/").toString());
            idle();
            assertEquals(null, visibleChild(act.get(), "Skip status"));
            // Turned off on Following.
            message(s, new JSONObject().put("action", "route").put("route", "home")
                    .put("url", "https://www.instagram.com/?variant=following").toString());
            message(s, new JSONObject().put("action", "skipStatus").put("on", false).toString());
            idle();
            assertEquals(null, visibleChild(act.get(), "Skip status"));
        }
    }

    private static ViewGroup feedCard(MainActivity a) {
        ViewGroup root = (ViewGroup) ((ViewGroup) a.findViewById(android.R.id.content)).getChildAt(0);
        for (int i = 0; i < root.getChildCount(); i++) {
            View c = root.getChildAt(i);
            if (c instanceof ViewGroup && c.getVisibility() == View.VISIBLE && "End of Home".equals(String.valueOf(c.getContentDescription()))) {
                return (ViewGroup) c;
            }
        }
        throw new AssertionError("end-of-Home card not visible");
    }

    @Test
    public void menuIsASlimTabOnTheScreenEdge() throws Exception {
        try (ActivityScenario<MainActivity> s = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<MainActivity> act = new AtomicReference<>();
            s.onActivity(act::set);
            SystemClock.sleep(600);   // placement animates for 120 ms after layout
            idle();
            ViewGroup root = (ViewGroup) ((ViewGroup) act.get().findViewById(android.R.id.content)).getChildAt(0);
            View tab = null;
            for (int i = 0; i < root.getChildCount(); i++) {
                CharSequence d = root.getChildAt(i).getContentDescription();
                if (d != null && d.toString().equals("SimpleGram menu")) tab = root.getChildAt(i);
            }
            assertNotNull(tab);
            float density = act.get().getResources().getDisplayMetrics().density;
            assertTrue("slim: " + tab.getWidth(), tab.getWidth() <= Math.round(16 * density));
            boolean onLeft = tab.getX() < 1;
            boolean onRight = Math.abs(tab.getX() + tab.getWidth() - root.getWidth()) < 1;
            assertTrue("flush with an edge: x=" + tab.getX(), onLeft || onRight);
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

    /**
     * The page is told when the app's hold starts (before it presses) and when
     * it ends: WebView cancels the held touch as soon as the menu dialog or the
     * notification shade takes focus, and the Story must stay paused anyway.
     */
    @Test
    public void appHoldIsAnnouncedToThePage() throws Exception {
        java.util.List<String> calls = new java.util.ArrayList<>();
        boolean[] story = {true};
        AtomicReference<ZoomFrame> ref = new AtomicReference<>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            ZoomFrame z = new ZoomFrame(InstrumentationRegistry.getInstrumentation().getTargetContext(), new ZoomFrame.Listener() {
                @Override
                public boolean storyMode() {
                    return story[0];
                }

                @Override
                public void onZoomChanged(float scale) {
                }

                @Override
                public void onHoldChanged(boolean on) {
                    calls.add(on ? "on" : "off");
                }
            });
            View page = new View(z.getContext()) {
                @Override
                public boolean dispatchTouchEvent(MotionEvent e) {
                    calls.add(MotionEvent.actionToString(e.getActionMasked()));
                    return true;
                }
            };
            z.addView(page, new ViewGroup.LayoutParams(1080, 2000));
            z.measure(View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(2000, View.MeasureSpec.EXACTLY));
            z.layout(0, 0, 1080, 2000);
            ref.set(z);
            // The menu's hold: announced before the press; released once.
            z.hold();
            z.hold();
            z.releaseHold();
            z.releaseHold();
        });
        assertEquals(java.util.Arrays.asList("on", "ACTION_DOWN", "ACTION_CANCEL", "off"), calls);
        calls.clear();
        // The zoom's hold on a Story: on when the second finger lands, off when zoomed out.
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> pinch(ref.get(), 540f, 1000f, 100f, 300f));
        assertTrue(ref.get().isZoomed());
        assertEquals("on", calls.get(calls.indexOf("ACTION_DOWN") + 1));
        assertFalse(calls.contains("off"));
        calls.clear();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> ref.get().reset(false));
        assertEquals(java.util.Arrays.asList("ACTION_CANCEL", "off"), calls);
        calls.clear();
        // Outside Stories a pinch holds nothing.
        story[0] = false;
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            pinch(ref.get(), 540f, 1000f, 100f, 300f);
            ref.get().reset(false);
        });
        assertFalse(calls.contains("on"));
        assertFalse(calls.contains("off"));

        // The menu and screenshot mode in a Story hold and let go through the frame.
        try (ActivityScenario<MainActivity> s = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<MainActivity> act = new AtomicReference<>();
            s.onActivity(act::set);
            java.lang.reflect.Field route = MainActivity.class.getDeclaredField("route");
            route.setAccessible(true);
            s.onActivity(a -> {
                try {
                    route.set(a, "story");
                    call(a, "showMenu", new Class<?>[]{});
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
            idle();
            SystemClock.sleep(400);
            assertTrue(zoomOf(act.get()).isHolding());
            InstrumentationRegistry.getInstrumentation().getUiAutomation()
                    .performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK);
            SystemClock.sleep(800);
            idle();
            assertFalse(zoomOf(act.get()).isHolding());
            s.onActivity(a -> {
                try {
                    call(a, "enterScreenshot", new Class<?>[]{});
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
            idle();
            assertTrue(zoomOf(act.get()).isHolding());
            s.onActivity(MainActivity::onBackPressed);
            idle();
            assertFalse(zoomOf(act.get()).isHolding());
        }
    }

    /**
     * B25 again: a finger already down on a Story (not in full screen) while
     * another finger taps ⋮. The menu's hold must end that touch on the page
     * before pressing, and the rest of it must stay off the page; a second
     * press over an open touch orphans it in the web engine.
     */
    @Test
    public void menuHoldEndsAFingerAlreadyOnThePage() {
        java.util.List<String> calls = new java.util.ArrayList<>();
        AtomicReference<ZoomFrame> ref = new AtomicReference<>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            ZoomFrame z = new ZoomFrame(InstrumentationRegistry.getInstrumentation().getTargetContext(), new ZoomFrame.Listener() {
                @Override
                public boolean storyMode() {
                    return true;
                }

                @Override
                public void onZoomChanged(float scale) {
                }

                @Override
                public void onHoldChanged(boolean on) {
                    calls.add(on ? "on" : "off");
                }
            });
            View page = new View(z.getContext()) {
                @Override
                public boolean dispatchTouchEvent(MotionEvent e) {
                    calls.add(MotionEvent.actionToString(e.getActionMasked()));
                    return true;
                }
            };
            z.addView(page, new ViewGroup.LayoutParams(1080, 2000));
            z.measure(View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(2000, View.MeasureSpec.EXACTLY));
            z.layout(0, 0, 1080, 2000);
            ref.set(z);
            long down = SystemClock.uptimeMillis();
            z.dispatchTouchEvent(event(down, MotionEvent.ACTION_DOWN, new float[][]{{300f, 900f}}));
            z.dispatchTouchEvent(event(down, MotionEvent.ACTION_MOVE, new float[][]{{302f, 901f}}));
            // The other finger's tap on ⋮ (a sibling view) opens the menu.
            z.hold();
            z.dispatchTouchEvent(event(down, MotionEvent.ACTION_MOVE, new float[][]{{304f, 902f}}));
            z.dispatchTouchEvent(event(down, MotionEvent.ACTION_UP, new float[][]{{304f, 902f}}));
            z.releaseHold();
        });
        assertEquals(java.util.Arrays.asList("ACTION_DOWN", "ACTION_MOVE", "on", "ACTION_CANCEL", "ACTION_DOWN",
                "ACTION_CANCEL", "off"), calls);
        // Moves that no longer reached the page don't count as drags that did.
        assertEquals(1, ref.get().recentPageMoves());
        calls.clear();
        // A finished touch is not cancelled again.
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            tap(ref.get(), 300f, 900f);
            ref.get().hold();
            ref.get().releaseHold();
        });
        assertEquals(java.util.Arrays.asList("ACTION_DOWN", "ACTION_UP", "on", "ACTION_DOWN", "ACTION_CANCEL", "off"), calls);
    }

    /** A video before its first frame shows its own black box, not WebView's gray play icon (R10, R9). */
    @Test
    public void videosWithoutAPosterShowNoGrayIcon() {
        try (ActivityScenario<MainActivity> s = ActivityScenario.launch(MainActivity.class)) {
            s.onActivity(a -> {
                try {
                    WebChromeClient chrome = chromeOf(a);
                    android.graphics.Bitmap b = chrome.getDefaultVideoPoster();
                    assertNotNull("the app gives its own default poster", b);
                    for (int x = 0; x < b.getWidth(); x++) {
                        for (int y = 0; y < b.getHeight(); y++) {
                            assertEquals("fully transparent", 0, android.graphics.Color.alpha(b.getPixel(x, y)));
                        }
                    }
                    assertTrue("one shared bitmap", b == chrome.getDefaultVideoPoster());
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
        }
    }

    private static WebChromeClient chromeOf(MainActivity a) throws Exception {
        java.lang.reflect.Field f = MainActivity.class.getDeclaredField("web");
        f.setAccessible(true);
        return ((WebView) f.get(a)).getWebChromeClient();
    }

    private static View menuTab(MainActivity a) {
        ViewGroup root = (ViewGroup) ((ViewGroup) a.findViewById(android.R.id.content)).getChildAt(0);
        for (int i = 0; i < root.getChildCount(); i++) {
            CharSequence d = root.getChildAt(i).getContentDescription();
            if (d != null && d.toString().equals("SimpleGram menu")) return root.getChildAt(i);
        }
        throw new AssertionError("no menu tab");
    }

    /** Decision 7: a second full-screen request never cancels the one showing (a Story would close). */
    @Test
    public void nestedFullScreenNeverCancelsTheFirst() {
        try (ActivityScenario<MainActivity> s = ActivityScenario.launch(MainActivity.class)) {
            boolean[] hidden = new boolean[2];
            View[] views = new View[2];
            s.onActivity(a -> {
                try {
                    WebChromeClient chrome = chromeOf(a);
                    views[0] = new View(a);
                    views[1] = new View(a);
                    chrome.onShowCustomView(views[0], () -> hidden[0] = true);
                    chrome.onShowCustomView(views[1], () -> hidden[1] = true);
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
            idle();
            assertFalse(hidden[0]);
            assertFalse(hidden[1]);
            assertNull(views[0].getParent());
            assertNotNull(views[1].getParent());
            s.onActivity(MainActivity::onBackPressed);
            idle();
            assertTrue(hidden[1]);
            assertNull(views[1].getParent());
        }
    }

    /** R9: Back closes the Reel shown over a Story; the Story's full screen stays. */
    @Test
    public void backClosesAStoryReelBeforeTheStory() throws Exception {
        try (ActivityScenario<MainActivity> s = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<MainActivity> act = new AtomicReference<>();
            s.onActivity(act::set);
            boolean[] hidden = new boolean[1];
            View story = new View(InstrumentationRegistry.getInstrumentation().getTargetContext());
            String on = new JSONObject().put("action", "fullVideo").put("on", true).toString();
            s.onActivity(a -> {
                try {
                    chromeOf(a).onShowCustomView(story, () -> hidden[0] = true);
                    call(a, "onMessage", new Class<?>[]{String.class, String.class}, "main", on);
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
            idle();
            assertEquals(View.GONE, menuTab(act.get()).getVisibility());
            s.onActivity(MainActivity::onBackPressed);
            idle();
            assertFalse("the Story's full screen stays", hidden[0]);
            assertNotNull(story.getParent());
            assertEquals(View.VISIBLE, menuTab(act.get()).getVisibility());
            s.onActivity(MainActivity::onBackPressed);
            idle();
            assertTrue(hidden[0]);
        }
    }

    /**
     * R9 with a real Back key: WebView's full-screen view takes focus and ends
     * full screen on Back itself (before onBackPressed). Here a focused stand-in
     * that eats Back the same way: the app still closes only the Reel.
     */
    @Test
    public void backKeyClosesAStoryReelEvenWhenTheFullScreenViewHasFocus() throws Exception {
        try (ActivityScenario<MainActivity> s = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<MainActivity> act = new AtomicReference<>();
            s.onActivity(act::set);
            boolean[] hidden = new boolean[1];
            int[] eaten = new int[1];
            View story = new View(InstrumentationRegistry.getInstrumentation().getTargetContext()) {
                @Override
                public boolean dispatchKeyEvent(KeyEvent e) {
                    if (e.getKeyCode() == KeyEvent.KEYCODE_BACK && e.getAction() == KeyEvent.ACTION_UP) {
                        eaten[0]++;
                        hidden[0] = true;              // what WebView's view does: leave full screen
                        return true;
                    }
                    return super.dispatchKeyEvent(e);
                }
            };
            story.setFocusable(true);
            story.setFocusableInTouchMode(true);
            String on = new JSONObject().put("action", "fullVideo").put("on", true).toString();
            s.onActivity(a -> {
                try {
                    chromeOf(a).onShowCustomView(story, () -> hidden[0] = true);
                    story.requestFocus();
                    call(a, "onMessage", new Class<?>[]{String.class, String.class}, "main", on);
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
            idle();
            assertTrue("the stand-in has focus", story.hasFocus());
            assertEquals(View.GONE, menuTab(act.get()).getVisibility());
            InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);
            idle();
            assertEquals("Back never reached the full-screen view", 0, eaten[0]);
            assertFalse("the Story's full screen stays", hidden[0]);
            assertNotNull(story.getParent());
            assertEquals(View.VISIBLE, menuTab(act.get()).getVisibility());
            // The next Back ends the Story's full screen through the app.
            InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);
            idle();
            assertTrue(hidden[0]);
            assertEquals(0, eaten[0]);
            assertNull(story.getParent());
        }
    }

    /**
     * R8/R10: a video in full screen (a post's, a Reel's, the feed's) has the whole
     * screen; the tab (elevated) is not drawn or touchable over it. On Home and
     * other pages only for the page's own full screen (it says fullVideoStart first).
     */
    @Test
    public void postVideoFullScreenHidesTheMenuTab() throws Exception {
        String start = new JSONObject().put("action", "fullVideoStart").toString();
        for (String r : new String[]{"post", "reel", "home", "other"}) {
            try (ActivityScenario<MainActivity> s = ActivityScenario.launch(MainActivity.class)) {
                AtomicReference<MainActivity> act = new AtomicReference<>();
                s.onActivity(act::set);
                boolean[] hidden = new boolean[1];
                View video = new View(InstrumentationRegistry.getInstrumentation().getTargetContext());
                java.lang.reflect.Field route = MainActivity.class.getDeclaredField("route");
                route.setAccessible(true);
                s.onActivity(a -> {
                    try {
                        route.set(a, r);
                        if ("home".equals(r) || "other".equals(r)) {
                            call(a, "onMessage", new Class<?>[]{String.class, String.class}, "main", start);
                        }
                        chromeOf(a).onShowCustomView(video, () -> hidden[0] = true);
                    } catch (Exception e) {
                        throw new RuntimeException(e);
                    }
                });
                idle();
                assertEquals(r, View.GONE, menuTab(act.get()).getVisibility());
                // Back leaves full screen through onHideCustomView: the tab comes back.
                s.onActivity(MainActivity::onBackPressed);
                idle();
                assertTrue(hidden[0]);
                assertNull(video.getParent());
                assertEquals(r, View.VISIBLE, menuTab(act.get()).getVisibility());
            }
        }
    }

    /**
     * R10 from the menu: the app taps the page's video for it (a real tap through
     * the web view's input), but never while a full-screen view is up or the menu
     * is still showing; held taps are counted. Shapes only.
     */
    @Test
    public void menuFullScreenVideoTapsThePageOnlyWhenSafe() throws Exception {
        try (ActivityScenario<MainActivity> s = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<MainActivity> act = new AtomicReference<>();
            s.onActivity(act::set);
            java.lang.reflect.Field taps = MainActivity.class.getDeclaredField("videoTaps");
            java.lang.reflect.Field held = MainActivity.class.getDeclaredField("videoTapsHeld");
            taps.setAccessible(true);
            held.setAccessible(true);
            String tap = new JSONObject().put("action", "fullVideoTap").put("x", 200).put("y", 300).put("w", 412).toString();
            // A full-screen view is up: held.
            View video = new View(InstrumentationRegistry.getInstrumentation().getTargetContext());
            s.onActivity(a -> {
                try {
                    chromeOf(a).onShowCustomView(video, () -> { });
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
            idle();
            message(s, tap);
            SystemClock.sleep(600);
            idle();
            assertEquals(0, taps.getInt(act.get()));
            assertEquals(1, held.getInt(act.get()));
            s.onActivity(MainActivity::onBackPressed);
            idle();
            // Nothing in the way: one tap is made. Nonsense spots are ignored.
            message(s, tap);
            message(s, new JSONObject().put("action", "fullVideoTap").put("x", -5).put("y", 300).put("w", 412).toString());
            message(s, new JSONObject().put("action", "fullVideoTap").put("x", 200).put("y", 300).put("w", 0).toString());
            SystemClock.sleep(600);
            idle();
            assertEquals(1, taps.getInt(act.get()));
            assertEquals(1, held.getInt(act.get()));
        }
    }

    /**
     * Instagram opens a Story (from Home's tray) or a highlight (from a profile)
     * by asking for full screen before its route says "story": that full screen
     * isn't the page's own, so the tab (how Stories are saved) stays. And if a
     * tab was hidden for a full screen whose route then says "story", it comes back.
     */
    @Test
    public void storyFullScreenStartedBeforeItsRouteKeepsTheMenuTab() throws Exception {
        String story = new JSONObject().put("action", "route").put("route", "story")
                .put("url", "https://www.instagram.com/stories/friend/1/").toString();
        String start = new JSONObject().put("action", "fullVideoStart").toString();
        for (String r : new String[]{"home", "other"}) {
            for (boolean own : new boolean[]{false, true}) {
                try (ActivityScenario<MainActivity> s = ActivityScenario.launch(MainActivity.class)) {
                    AtomicReference<MainActivity> act = new AtomicReference<>();
                    s.onActivity(act::set);
                    View view = new View(InstrumentationRegistry.getInstrumentation().getTargetContext());
                    java.lang.reflect.Field route = MainActivity.class.getDeclaredField("route");
                    route.setAccessible(true);
                    s.onActivity(a -> {
                        try {
                            route.set(a, r);
                            if (own) call(a, "onMessage", new Class<?>[]{String.class, String.class}, "main", start);
                            chromeOf(a).onShowCustomView(view, () -> { });
                        } catch (Exception e) {
                            throw new RuntimeException(e);
                        }
                    });
                    idle();
                    assertEquals(r + " " + own, own ? View.GONE : View.VISIBLE, menuTab(act.get()).getVisibility());
                    message(s, story);
                    idle();
                    assertEquals(r + " " + own, View.VISIBLE, menuTab(act.get()).getVisibility());
                    // Nothing still hides the tab or the zoom chip (onZoomChanged reads this).
                    java.lang.reflect.Field hid = MainActivity.class.getDeclaredField("fullHidTab");
                    hid.setAccessible(true);
                    assertFalse(hid.getBoolean(act.get()));
                }
            }
        }
        // A start message long before a full screen of Instagram's doesn't count.
        try (ActivityScenario<MainActivity> s = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<MainActivity> act = new AtomicReference<>();
            s.onActivity(act::set);
            message(s, start);
            SystemClock.sleep(3000);
            View view = new View(InstrumentationRegistry.getInstrumentation().getTargetContext());
            s.onActivity(a -> {
                try {
                    chromeOf(a).onShowCustomView(view, () -> { });
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
            idle();
            assertEquals(View.VISIBLE, menuTab(act.get()).getVisibility());
        }
    }

    /**
     * R10 with the comments panel up: the app makes no tap for the menu item, and
     * any full screen that starts anyway (Instagram's own player) has the panel
     * out of its way until it ends.
     */
    @Test
    public void fullScreenOverTheCommentsPanelPutsThePanelAside() throws Exception {
        try (ActivityScenario<MainActivity> s = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<MainActivity> act = new AtomicReference<>();
            s.onActivity(act::set);
            CommentsPanel panel = panelOf(act.get());
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
            assertTrue(panel.isOpen());
            java.lang.reflect.Field taps = MainActivity.class.getDeclaredField("videoTaps");
            java.lang.reflect.Field held = MainActivity.class.getDeclaredField("videoTapsHeld");
            taps.setAccessible(true);
            held.setAccessible(true);
            message(s, new JSONObject().put("action", "fullVideoTap").put("x", 200).put("y", 300).put("w", 412).toString());
            SystemClock.sleep(600);
            idle();
            assertEquals(0, taps.getInt(act.get()));
            assertEquals(1, held.getInt(act.get()));
            boolean[] hidden = new boolean[1];
            View video = new View(InstrumentationRegistry.getInstrumentation().getTargetContext());
            s.onActivity(a -> {
                try {
                    chromeOf(a).onShowCustomView(video, () -> hidden[0] = true);
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
            idle();
            assertTrue(panel.isOpen());
            assertEquals(View.GONE, panel.getVisibility());
            s.onActivity(MainActivity::onBackPressed);
            idle();
            assertTrue(hidden[0]);
            assertTrue("Back left full screen, not the comments", panel.isOpen());
            assertEquals(View.VISIBLE, panel.getVisibility());
            s.onActivity(MainActivity::onBackPressed);
            SystemClock.sleep(600);
            idle();
            assertFalse(panel.isOpen());
        }
    }

    /** In a Story's full screen the tab stays: it is how Stories are saved (R9's layer hides it itself). */
    @Test
    public void storyFullScreenKeepsTheMenuTab() throws Exception {
        try (ActivityScenario<MainActivity> s = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<MainActivity> act = new AtomicReference<>();
            s.onActivity(act::set);
            View story = new View(InstrumentationRegistry.getInstrumentation().getTargetContext());
            java.lang.reflect.Field route = MainActivity.class.getDeclaredField("route");
            route.setAccessible(true);
            s.onActivity(a -> {
                try {
                    route.set(a, "story");
                    chromeOf(a).onShowCustomView(story, () -> { });
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
            idle();
            assertEquals(View.VISIBLE, menuTab(act.get()).getVisibility());
            s.onActivity(a -> {
                try {
                    chromeOf(a).onHideCustomView();
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
            idle();
            assertEquals(View.VISIBLE, menuTab(act.get()).getVisibility());
        }
    }

    /** A new page starting (Back to Home, a menu load, an offline error page) takes the old page's skip note with it. */
    @Test
    public void skipNoteGoesWhenANewPageStarts() throws Exception {
        try (ActivityScenario<MainActivity> s = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<MainActivity> act = new AtomicReference<>();
            s.onActivity(act::set);
            message(s, new JSONObject().put("action", "route").put("route", "home")
                    .put("url", "https://www.instagram.com/?variant=following").toString());
            message(s, new JSONObject().put("action", "skipStatus").put("on", true).put("kind", "nothingNew").toString());
            idle();
            assertNotNull(visibleChild(act.get(), "Skip status"));
            // Home starts loading (an Instagram URL, so route and pageUrl stay until its 'ready').
            s.onActivity(a -> {
                try {
                    java.lang.reflect.Field f = MainActivity.class.getDeclaredField("web");
                    f.setAccessible(true);
                    WebView w = (WebView) f.get(a);
                    w.getWebViewClient().onPageStarted(w, "https://www.instagram.com/", null);
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
            idle();
            assertNull(visibleChild(act.get(), "Skip status"));
        }
    }

    /**
     * A Story closing sends its route message while its full screen is still up
     * (Instagram exits full screen after the viewer has left): the skip note and
     * the end card come back when the full screen ends.
     */
    @Test
    public void skipNoteAndEndCardComeBackWhenFullScreenEnds() throws Exception {
        try (ActivityScenario<MainActivity> s = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<MainActivity> act = new AtomicReference<>();
            s.onActivity(act::set);
            message(s, new JSONObject().put("action", "route").put("route", "home")
                    .put("url", "https://www.instagram.com/?variant=following").toString());
            message(s, new JSONObject().put("action", "skipStatus").put("on", true).put("kind", "skipping").put("n", 19).toString());
            idle();
            assertNotNull(visibleChild(act.get(), "Skip status"));
            View story = new View(InstrumentationRegistry.getInstrumentation().getTargetContext());
            String routeStory = new JSONObject().put("action", "route").put("route", "story")
                    .put("url", "https://www.instagram.com/stories/x/1/").toString();
            String routeBack = new JSONObject().put("action", "route").put("route", "home")
                    .put("url", "https://www.instagram.com/?variant=following").toString();
            s.onActivity(a -> {
                try {
                    call(a, "onMessage", new Class<?>[]{String.class, String.class}, "main", routeStory);
                    chromeOf(a).onShowCustomView(story, () -> { });
                    call(a, "onMessage", new Class<?>[]{String.class, String.class}, "main", routeBack);
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
            idle();
            assertNull("never over the full screen", visibleChild(act.get(), "Skip status"));
            s.onActivity(a -> {
                try {
                    chromeOf(a).onHideCustomView();
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
            idle();
            View chip = visibleChild(act.get(), "Skip status");
            assertNotNull("the note is back", chip);
            assertTrue(String.valueOf(((android.widget.TextView) chip).getText()).contains("Skipping 19 posts"));

            // The end card on Home, the same way.
            message(s, new JSONObject().put("action", "skipStatus").put("on", false).toString());
            message(s, new JSONObject().put("action", "route").put("route", "home")
                    .put("url", "https://www.instagram.com/").toString());
            View story2 = new View(InstrumentationRegistry.getInstrumentation().getTargetContext());
            String feedEnd = new JSONObject().put("action", "feedEnd").put("on", true).put("caughtUp", true).toString();
            String routeHome = new JSONObject().put("action", "route").put("route", "home")
                    .put("url", "https://www.instagram.com/").toString();
            s.onActivity(a -> {
                try {
                    chromeOf(a).onShowCustomView(story2, () -> { });
                    call(a, "onMessage", new Class<?>[]{String.class, String.class}, "main", routeHome);
                    call(a, "onMessage", new Class<?>[]{String.class, String.class}, "main", feedEnd);
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
            SystemClock.sleep(400);
            idle();
            assertNull(visibleChild(act.get(), "End of Home"));
            s.onActivity(a -> {
                try {
                    chromeOf(a).onHideCustomView();
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
            SystemClock.sleep(400);
            idle();
            assertNotNull("the card is back", visibleChild(act.get(), "End of Home"));
        }
    }

    // B20: the comments page gets no room for the system bars or the keyboard
    // (the panel sits clear of both), the panel shrinks above the keyboard,
    // and the comment box's report keeps only its numbers.
    @Test
    public void commentsPanelKeepsNoBarRoomAndShrinksAboveTheKeyboard() throws Exception {
        try (ActivityScenario<MainActivity> s = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<MainActivity> act = new AtomicReference<>();
            s.onActivity(act::set);
            MainActivity a = act.get();
            CommentsPanel panel = panelOf(a);
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                AtomicBoolean reached = new AtomicBoolean();
                AtomicReference<WindowInsets> out = new AtomicReference<>();
                s.onActivity(x -> {
                    panel.web().setOnApplyWindowInsetsListener((v, in) -> {
                        reached.set(true);
                        return in;
                    });
                    WindowInsets in = new WindowInsets.Builder()
                            .setInsets(WindowInsets.Type.navigationBars(), android.graphics.Insets.of(0, 0, 0, 126))
                            .setInsets(WindowInsets.Type.ime(), android.graphics.Insets.of(0, 0, 0, 900))
                            .build();
                    out.set(panel.dispatchApplyWindowInsets(in));
                    panel.web().setOnApplyWindowInsetsListener(null);
                });
                assertTrue(out.get().isConsumed());
                assertFalse("the comments page never sees bar or keyboard room", reached.get());
            }

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
            View root = (View) panel.getParent();
            int rootH = root.getHeight();
            assertEquals(rootH - Math.round(rootH * 0.42f), panel.getHeight(), 3);
            // The keyboard: the content area gets shorter (adjustResize); the panel follows it, bottom-aligned.
            int typing = Math.round(rootH * 0.55f);
            s.onActivity(x -> {
                ViewGroup.LayoutParams lp = root.getLayoutParams();
                lp.height = typing;
                root.setLayoutParams(lp);
            });
            SystemClock.sleep(400);
            idle();
            assertEquals(typing, root.getHeight());
            assertEquals(typing - Math.round(typing * 0.30f), panel.getLayoutParams().height, 3);
            assertEquals(typing, panel.getBottom(), 3);
            s.onActivity(x -> {
                ViewGroup.LayoutParams lp = root.getLayoutParams();
                lp.height = ViewGroup.LayoutParams.MATCH_PARENT;
                root.setLayoutParams(lp);
            });
            SystemClock.sleep(400);
            idle();
            assertEquals(rootH - Math.round(rootH * 0.42f), panel.getLayoutParams().height, 3);

            // The box's report: numbers kept, anything else dropped; only from the comments page.
            String report = new JSONObject().put("action", "commentsLayout").put("gapBefore", 50).put("gapAfter", 0)
                    .put("barH", 44).put("boxes", 1).put("who", "someone")
                    .put("fixes", new JSONObject().put("margin", 1).put("padding", 2).put("text", "x")).toString();
            String fromMain = new JSONObject().put("action", "commentsLayout").put("gapBefore", 999).toString();
            s.onActivity(x -> {
                try {
                    call(x, "onMessage", new Class<?>[]{String.class, String.class}, "main", fromMain);
                    call(x, "onMessage", new Class<?>[]{String.class, String.class}, "comments", report);
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
            java.lang.reflect.Field f = MainActivity.class.getDeclaredField("commentsLayout");
            f.setAccessible(true);
            JSONObject kept = (JSONObject) f.get(a);
            assertNotNull(kept);
            assertEquals(50, kept.getInt("gapBefore"));
            assertEquals(0, kept.getInt("gapAfter"));
            assertFalse(kept.has("who"));
            assertFalse(kept.getJSONObject("fixes").has("text"));
            assertEquals(2, kept.getJSONObject("fixes").getInt("padding"));
            JSONObject device = (JSONObject) call(a, "deviceDiagnostics", new Class<?>[]{});
            assertEquals(50, device.getJSONObject("comments").getInt("gapBefore"));
            assertEquals("gap under it 50 → 0 px, 44 px high (padding 2, margin 1) · typed in 0", MainActivity.commentsLine(kept));
            assertEquals("not opened yet", MainActivity.commentsLine(null));
            s.onActivity(MainActivity::onBackPressed);
            SystemClock.sleep(400);
            idle();
        }
    }

    /**
     * R12: comments for a Reel shown over a Story. The Story is in the app's
     * full-screen view; the comments sheet comes up over it (drawn and touched
     * above it, raised by Z with no view moved in the tree), the page under the
     * Story isn't split, Back closes the comments first and then the Reel, and
     * the comments go when the Reel or the Story's full screen does.
     */
    @Test
    public void commentsSheetShowsOverAStoryReel() throws Exception {
        try (ActivityScenario<MainActivity> s = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<MainActivity> act = new AtomicReference<>();
            s.onActivity(act::set);
            MainActivity a = act.get();
            // The launch's own load (instagram.com) would reset the Reel layer
            // (onPageStarted, 'ready') mid-test: a local blank page instead.
            blankPage(s);
            CommentsPanel panel = panelOf(a);
            ZoomFrame z = zoomOf(a);
            boolean[] hidden = new boolean[1];
            int[] storyTouches = new int[1];
            View story = new View(InstrumentationRegistry.getInstrumentation().getTargetContext()) {
                @Override
                public boolean dispatchTouchEvent(MotionEvent e) {
                    storyTouches[0]++;
                    return true;
                }
            };
            String on = new JSONObject().put("action", "fullVideo").put("on", true).toString();
            String open = new JSONObject().put("action", "comments").put("code", "REELCODE1")
                    .put("url", "https://www.instagram.com/p/REELCODE1/comments/").put("dpr", 2.625).toString();
            s.onActivity(x -> {
                try {
                    chromeOf(x).onShowCustomView(story, () -> hidden[0] = true);
                    call(x, "onMessage", new Class<?>[]{String.class, String.class}, "main", on);
                    call(x, "onMessage", new Class<?>[]{String.class, String.class}, "main", open);
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
            SystemClock.sleep(500);
            idle();
            assertTrue(panel.isOpen());
            assertTrue("over the Reel", (Boolean) fieldOf(s, "commentsOverFull"));
            assertEquals(View.VISIBLE, panel.getVisibility());
            assertFalse("the page under the Story isn't split", z.isSplit());
            assertTrue("the sheet is above the full-screen view", panel.getZ() > story.getZ());
            ViewGroup root = (ViewGroup) panel.getParent();
            assertEquals("no view moved in the tree", 1, root.indexOfChild(panel));
            int rootH = root.getHeight();
            int top = Math.round(rootH * 0.42f);
            assertEquals(rootH - top, panel.getHeight(), 3);
            // A touch on the sheet is the sheet's; one above it is the Story's (its Reel's).
            int[] at = new int[2];
            root.getLocationInWindow(at);
            s.onActivity(x -> tap(x.getWindow().getDecorView(), at[0] + root.getWidth() / 2f, at[1] + top + dpOf(x, 120)));
            idle();
            assertEquals(0, storyTouches[0]);
            s.onActivity(x -> tap(x.getWindow().getDecorView(), at[0] + root.getWidth() / 2f, at[1] + top / 2f));
            idle();
            assertEquals(2, storyTouches[0]);
            // Back: the comments first; the Reel and the Story's full screen stay.
            s.onActivity(MainActivity::onBackPressed);
            SystemClock.sleep(500);
            idle();
            assertFalse(panel.isOpen());
            assertEquals(0f, panel.getTranslationZ(), 0.001f);
            assertFalse(hidden[0]);
            assertEquals(View.GONE, menuTab(a).getVisibility());
            // Open again; the Reel closing (fullVideo off) takes the comments with it.
            message(s, on);
            message(s, open);
            SystemClock.sleep(400);
            idle();
            assertTrue(panel.isOpen());
            assertTrue("over the Reel", (Boolean) fieldOf(s, "commentsOverFull"));
            message(s, new JSONObject().put("action", "fullVideo").put("on", false).toString());
            SystemClock.sleep(400);
            idle();
            assertFalse(panel.isOpen());
            assertFalse(hidden[0]);
            // And the Story's full screen ending takes them too.
            message(s, on);
            message(s, open);
            SystemClock.sleep(400);
            idle();
            assertTrue(panel.isOpen());
            assertTrue("over the Reel", (Boolean) fieldOf(s, "commentsOverFull"));
            s.onActivity(x -> {
                try {
                    chromeOf(x).onHideCustomView();
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
            SystemClock.sleep(400);
            idle();
            assertFalse(panel.isOpen());
        }
    }

    /**
     * R12: a Story that isn't in Instagram's full screen (one reached by a full
     * load can't ask for it): R9's layer is over the page with no custom view.
     * The comment tap (no rect) still brings the comments up over the Reel, the
     * page isn't split and is told where the panel's top is; Back closes the
     * comments first and leaves the Reel; the Reel closing takes them with it.
     */
    @Test
    public void commentsOverAStoryReelWithoutFullScreen() throws Exception {
        try (ActivityScenario<MainActivity> s = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<MainActivity> act = new AtomicReference<>();
            s.onActivity(act::set);
            MainActivity a = act.get();
            blankPage(s);
            CommentsPanel panel = panelOf(a);
            ZoomFrame z = zoomOf(a);
            String on = new JSONObject().put("action", "fullVideo").put("on", true).toString();
            String open = new JSONObject().put("action", "comments").put("code", "REELCODE1")
                    .put("url", "https://www.instagram.com/p/REELCODE1/comments/").put("rect", JSONObject.NULL)
                    .put("dpr", 2.625).toString();
            message(s, on);
            message(s, open);
            SystemClock.sleep(500);
            idle();
            assertNull(fieldOf(s, "customView"));
            assertTrue(panel.isOpen());
            assertTrue("over the Reel", (Boolean) fieldOf(s, "commentsOverFull"));
            assertFalse("the page isn't split", z.isSplit());
            assertTrue("raised over the page", panel.getTranslationZ() > 0f);
            String got = pageJs(s, "String(window.__got||'')");
            assertTrue(got, got != null && got.contains("commentsOver:true"));
            // Back: the comments first; the Reel stays (no fullVideoExit to the page).
            s.onActivity(MainActivity::onBackPressed);
            SystemClock.sleep(400);
            idle();
            assertFalse(panel.isOpen());
            assertFalse((Boolean) fieldOf(s, "commentsOverFull"));
            assertTrue("the Reel stays", (Boolean) fieldOf(s, "pageVideo"));
            got = pageJs(s, "String(window.__got||'')");
            assertFalse(got, got != null && got.contains("fullVideoExit"));
            // A second Back is the Reel's.
            s.onActivity(MainActivity::onBackPressed);
            idle();
            assertFalse((Boolean) fieldOf(s, "pageVideo"));
            // Again, and the Reel closing (a swipe: fullVideo off) takes the comments.
            message(s, on);
            message(s, open);
            SystemClock.sleep(400);
            idle();
            assertTrue(panel.isOpen());
            message(s, new JSONObject().put("action", "fullVideo").put("on", false).toString());
            SystemClock.sleep(400);
            idle();
            assertFalse(panel.isOpen());
            assertFalse(z.isSplit());
        }
    }

    /**
     * B26: the Android buttons never go. A full-screen view (a video, a Story)
     * and screenshot mode hide only the status bar: the navigation bar stays and
     * the view shown ends above it, so nothing is drawn under the buttons.
     */
    @Test
    public void fullScreenAndScreenshotModeKeepTheNavigationBar() throws Exception {
        try (ActivityScenario<MainActivity> s = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<MainActivity> act = new AtomicReference<>();
            s.onActivity(act::set);
            MainActivity a = act.get();
            View video = new View(InstrumentationRegistry.getInstrumentation().getTargetContext());
            s.onActivity(x -> {
                try {
                    chromeOf(x).onShowCustomView(video, () -> { });
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
            SystemClock.sleep(700);        // the status bar animates away
            idle();
            assertNavigationBarKept(a, video, "full screen");
            s.onActivity(MainActivity::onBackPressed);
            SystemClock.sleep(400);
            idle();
            assertNull(fieldOf(s, "customView"));
            s.onActivity(x -> {
                try {
                    call(x, "enterScreenshot", new Class<?>[]{});
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
            SystemClock.sleep(700);
            idle();
            assertNavigationBarKept(a, (View) fieldOf(s, "screenshotShield"), "screenshot mode");
            s.onActivity(MainActivity::onBackPressed);
            idle();
        }
    }

    @SuppressWarnings("deprecation")
    private static void assertNavigationBarKept(MainActivity a, View shown, String when) {
        View decor = a.getWindow().getDecorView();
        int[] flags = new int[1];
        int[] edges = new int[3];      // the view's bottom edge in the window, the room kept for the buttons, the window's height
        boolean[] navVisible = {true};
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            flags[0] = decor.getSystemUiVisibility();
            int[] loc = new int[2];
            shown.getLocationInWindow(loc);
            edges[0] = loc[1] + shown.getHeight();
            edges[2] = decor.getHeight();
            WindowInsets in = decor.getRootWindowInsets();
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                navVisible[0] = in == null || in.isVisible(WindowInsets.Type.navigationBars());
                edges[1] = in == null ? 0 : in.getInsets(WindowInsets.Type.navigationBars()).bottom;
            } else {
                edges[1] = in == null ? 0 : in.getSystemWindowInsetBottom();
            }
        });
        assertEquals(when + ": the navigation bar isn't hidden", 0, flags[0] & View.SYSTEM_UI_FLAG_HIDE_NAVIGATION);
        assertEquals(when + ": no immersive mode", 0,
                flags[0] & (View.SYSTEM_UI_FLAG_IMMERSIVE | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY));
        assertTrue(when + ": the navigation bar is visible", navVisible[0]);
        assertTrue(when + ": the view ends above the buttons (bottom " + edges[0] + ", room " + edges[1] + " of " + edges[2] + ")",
                edges[0] <= edges[2] - edges[1] + 1);
    }

    /**
     * B27: the page is told where the tab is (fractions of root's height) after
     * a drag, and a tap just inside the tab's inner edge (its extra room, not
     * the tab itself) opens the menu instead of reaching the page.
     */
    @Test
    public void menuTabIsToldToThePageAndItsExtraRoomOpensTheMenu() throws Exception {
        try (ActivityScenario<MainActivity> s = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<MainActivity> act = new AtomicReference<>();
            s.onActivity(act::set);
            MainActivity a = act.get();
            SharedPreferences prefs = a.getSharedPreferences("simplegram", Context.MODE_PRIVATE);
            try {
                blankPage(s);
                pageJs(s, "window.__sg = { onNative: function (c) { (window.__cmds = window.__cmds || []).push(JSON.stringify(c)); } }; 1");
                View tab = menuTab(a);
                ViewGroup root = (ViewGroup) tab.getParent();
                SystemClock.sleep(400);        // placement animates for 120 ms
                idle();
                float x0 = tab.getX() + tab.getWidth() / 2f, y0 = tab.getY() + tab.getHeight() / 2f;
                float dy = root.getHeight() / 4f;
                // A drag down by a quarter of the screen (the tab reads raw coordinates).
                s.onActivity(x -> {
                    long d = SystemClock.uptimeMillis();
                    tab.dispatchTouchEvent(event(d, MotionEvent.ACTION_DOWN, new float[][]{{x0, y0}}));
                    for (int i = 1; i <= 8; i++) {
                        tab.dispatchTouchEvent(event(d, MotionEvent.ACTION_MOVE, new float[][]{{x0, y0 + dy * i / 8f}}));
                    }
                    tab.dispatchTouchEvent(event(d, MotionEvent.ACTION_UP, new float[][]{{x0, y0 + dy}}));
                });
                SystemClock.sleep(500);
                idle();
                assertTrue("the tab moved", tab.getY() > y0 - tab.getHeight() / 2f + dpOf(a, 20));
                JSONObject last = lastCommand(s, "menuTab");
                assertNotNull("menuTab reached the page", last);
                assertTrue(last.getBoolean("on"));
                boolean left = tab.getX() < 1;
                assertEquals(left ? "left" : "right", last.getString("side"));
                assertEquals(tab.getY() / root.getHeight(), last.getDouble("yFrac"), 0.01);
                assertEquals(tab.getHeight() / (float) root.getHeight(), last.getDouble("hFrac"), 0.01);
                // 4 dp inside the tab's inner edge: beside the tab, in its extra room.
                int[] at = new int[2];
                root.getLocationInWindow(at);
                float tx = left ? tab.getX() + tab.getWidth() + dpOf(a, 4) : tab.getX() - dpOf(a, 4);
                float ty = tab.getY() + tab.getHeight() / 2f;
                assertFalse("the spot is off the tab itself", tx >= tab.getX() && tx < tab.getX() + tab.getWidth());
                s.onActivity(x -> tap(x.getWindow().getDecorView(), at[0] + tx, at[1] + ty));
                SystemClock.sleep(400);
                idle();
                assertTrue("the menu opened", (Boolean) fieldOf(s, "menuOpen"));
                InstrumentationRegistry.getInstrumentation().getUiAutomation()
                        .performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK);
                SystemClock.sleep(800);
                idle();
            } finally {
                prefs.edit().remove("menuY").remove("menuLeft").apply();
            }
        }
    }

    /** The last command of a type the page's stub recorded, or null. */
    private static JSONObject lastCommand(ActivityScenario<MainActivity> s, String type) throws Exception {
        String v = pageJs(s, "JSON.stringify(window.__cmds||[])");
        if (v == null || "null".equals(v)) return null;
        JSONArray all = new JSONArray(String.valueOf(new JSONTokener(v).nextValue()));
        JSONObject last = null;
        for (int i = 0; i < all.length(); i++) {
            JSONObject c = new JSONObject(all.getString(i));
            if (type.equals(c.optString("type"))) last = c;
        }
        return last;
    }

    // B33: a local page on an Instagram address whose logo screen never goes (nothing is fetched).
    private static final String STUCK_BASE = "https://www.instagram.com/b33test/";
    private static final String STUCK_PAGE = "<!doctype html><html><head><title>Instagram</title></head><body>"
            + "<div id=\"splash-screen\" style=\"position:fixed;inset:0;background:#fff\"><div>logo</div></div>"
            + "<script>window.b33ready=1;</script></body></html>";

    /**
     * B33: a page stuck on Instagram's logo. The watch fires on the app's own
     * clock (shortened here), the page is reloaded once by itself, and when the
     * reloaded page is stuck too the chip offers Try again and Details (the
     * load without filters comes only after a Try again). One chip at a time.
     */
    @Test
    public void stuckLogoGetsOneReloadThenTheChip() throws Exception {
        long watchWas = MainActivity.bootWatchMs;
        NetWatch.testNetOk = true;             // the ladder, not the emulator's connectivity, is under test
        try (ActivityScenario<MainActivity> s = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<MainActivity> act = new AtomicReference<>();
            s.onActivity(act::set);
            MainActivity a = act.get();
            SharedPreferences prefs = a.getSharedPreferences("simplegram", Context.MODE_PRIVATE);
            prefs.edit().remove("autoReloads").remove("reloadLog").remove("bootLog").remove("lastStuck").apply();
            SystemClock.sleep(1000);           // the launch's own load settles (or is cancelled) first
            MainActivity.bootWatchMs = 1500;
            localPage(s, STUCK_BASE, STUCK_PAGE, "www.instagram.com");
            // One reload by itself, recorded before it runs...
            assertTrue("a reload by itself", waitFor(() -> ringOf(prefs, "reloadLog").length() >= 1, 8000));
            JSONObject reload = ringOf(prefs, "reloadLog").getJSONObject(0);
            assertTrue(reload.toString(), reload.getString("what").startsWith("reload "));
            assertEquals(1, reload.getInt("step"));
            // ...then the chip, once the reloaded page is stuck too.
            assertTrue("the chip", waitFor(() -> visibleChild(a, "Instagram didn't start") != null, 10000));
            String text = textOf((ViewGroup) visibleChild(a, "Instagram didn't start"));
            assertTrue(text, text.contains("Instagram didn't start") && text.contains("Try again") && text.contains("Details"));
            assertFalse(text, text.contains("Load without filters"));
            JSONArray reloads = ringOf(prefs, "reloadLog");
            for (int i = 0; i < reloads.length(); i++) {
                String what = reloads.getJSONObject(i).getString("what");
                assertFalse(what, what.startsWith("loadUrl"));            // the reload did start a page
                assertFalse(what, what.startsWith("reload ") && i > 0);   // only one by itself
            }
            JSONArray log = ringOf(prefs, "bootLog");
            assertTrue(log.toString(), log.length() >= 2);
            JSONObject first = log.getJSONObject(log.length() - 2), second = log.getJSONObject(log.length() - 1);
            assertTrue(first.toString(), first.getString("outcome").startsWith("stuck"));
            assertTrue(second.toString(), second.getString("how").startsWith("reload ") && second.getString("outcome").startsWith("stuck"));
            assertTrue(prefs.getString("lastStuck", "").contains("\"rule\""));
            assertNull("one chip at a time", visibleChild(a, "Scrolling stopped. Tap to fix"));
            assertFalse("no address in what is kept", prefs.getString("bootLog", "").contains("b33test"));
        } finally {
            MainActivity.bootWatchMs = watchWas;
            NetWatch.testNetOk = null;
        }
    }

    /** B33: a failed load is kept by host kind, file kind and code; never its address. */
    @Test
    public void networkErrorsAreKeptByKind() throws Exception {
        try (ActivityScenario<MainActivity> s = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<MainActivity> act = new AtomicReference<>();
            s.onActivity(act::set);
            SharedPreferences prefs = act.get().getSharedPreferences("simplegram", Context.MODE_PRIVATE);
            prefs.edit().remove("netErrors").apply();
            s.onActivity(x -> {
                WebView w = (WebView) fieldOf(s, "web");
                w.getWebViewClient().onReceivedHttpError(w, request("https://sg.test/static/x.js", false),
                        new WebResourceResponse("text/plain", "utf-8", 503, "Service Unavailable", new HashMap<>(), null));
            });
            idle();
            JSONArray errors = ringOf(prefs, "netErrors");
            assertEquals(1, errors.length());
            JSONObject e = errors.getJSONObject(0);
            assertEquals(503, e.getInt("code"));
            assertEquals("http", e.getString("kind"));
            assertEquals("other", e.getString("host"));
            assertEquals("js", e.getString("res"));
            assertFalse(e.getBoolean("main"));
            assertTrue(e.has("resumed") && e.has("blocked") && e.has("at"));
            assertFalse(errors.toString(), errors.toString().contains("sg.test"));
            // Host and file kinds.
            assertEquals("static", MainActivity.hostKind(Uri.parse("https://static.cdninstagram.com/rsrc.php/v4/yX/r/abc.js")));
            assertEquals("js", MainActivity.resKind(Uri.parse("https://static.cdninstagram.com/rsrc.php/v4/yX/r/abc.js")));
            assertEquals("main", MainActivity.hostKind(Uri.parse("https://www.instagram.com/")));
            assertEquals("none", MainActivity.resKind(Uri.parse("https://www.instagram.com/")));
            assertEquals("api", MainActivity.hostKind(Uri.parse("https://www.instagram.com/api/v1/feed/timeline/")));
            assertEquals("media", MainActivity.hostKind(Uri.parse("https://scontent-lax3-1.cdninstagram.com/v/a.jpg")));
            assertEquals("image", MainActivity.resKind(Uri.parse("https://scontent-lax3-1.cdninstagram.com/v/a.jpg")));
            assertEquals("other", MainActivity.hostKind(null));
        }
    }

    /**
     * B33: Copy details works from the app alone. A page that doesn't answer
     * (here one without the page script) gets the device, net and boot blocks
     * copied after a second, with no page block.
     */
    @Test
    public void copyDetailsOpensWithoutAPageAnswer() throws Exception {
        try (ActivityScenario<MainActivity> s = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<MainActivity> act = new AtomicReference<>();
            s.onActivity(act::set);
            blankPage(s);
            s.onActivity(x -> {
                try {
                    call(x, "askStatus", new Class<?>[]{boolean.class}, true);
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
            SystemClock.sleep(300);
            assertNull("not before the page had its second", fieldOf(s, "lastDetails"));
            assertTrue(waitFor(() -> fieldOf(s, "lastDetails") != null, 3000));
            String details = (String) fieldOf(s, "lastDetails");
            JSONObject all = new JSONObject(details);
            assertTrue(all.isNull("page"));
            assertTrue(all.has("device") && all.has("trail"));
            JSONObject net = all.getJSONObject("net");
            assertTrue(net.getJSONObject("now").has("restrict") && net.getJSONObject("now").has("ok"));
            assertTrue(net.has("netErrors") && net.has("restrictChanges") && net.has("tip"));
            JSONObject boot = all.getJSONObject("boot");
            assertTrue(boot.has("bootLog") && boot.has("lifecycle") && boot.has("reloadLog") && boot.has("rebuildLog"));
            // The lifecycle ring counted this start (create, start, resume).
            assertTrue(boot.getJSONArray("lifecycle").length() >= 3);
            assertFalse(details, details.contains("sg.test"));
        }
    }

    /**
     * B33: Fix scrolling reads the old page's boot record along with its search
     * state before destroying it, keeps the record, and logs the rebuild with
     * what was up when it was chosen.
     */
    @Test
    public void fixScrollingKeepsTheOldPagesBootRecordAndLogsTheRebuild() throws Exception {
        try (ActivityScenario<MainActivity> s = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<MainActivity> act = new AtomicReference<>();
            s.onActivity(act::set);
            SharedPreferences prefs = act.get().getSharedPreferences("simplegram", Context.MODE_PRIVATE);
            prefs.edit().remove("rebuildLog").remove("rebuildRecord").apply();
            blankPage(s);
            pageJs(s, "window.__sg = { onNative: function () {}, searchState: function () { return JSON.stringify({open: false}); },"
                    + " bootRecord: function () { return {rule: 'test', logo: true, scripts: {count: 6, errored: 1}}; } }; 1");
            WebView old = (WebView) fieldOf(s, "web");
            s.onActivity(x -> {
                try {
                    call(x, "fixScrolling", new Class<?>[]{});
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
            assertTrue("rebuilt", waitFor(() -> fieldOf(s, "web") != old, 5000));
            JSONArray log = ringOf(prefs, "rebuildLog");
            assertEquals(1, log.length());
            JSONObject e = log.getJSONObject(0);
            assertEquals("Fix scrolling", e.getString("why"));
            assertTrue(e.toString(), e.getBoolean("answered") && e.getInt("answerMs") >= 0);
            assertTrue(e.has("route") && e.has("logoUp") && e.has("fullScreen") && e.has("chip") && e.has("at"));
            JSONObject kept = new JSONObject(prefs.getString("rebuildRecord", "{}"));
            assertEquals("Fix scrolling", kept.getString("why"));
            assertEquals("test", kept.getJSONObject("record").getString("rule"));
            assertEquals(1, kept.getJSONObject("record").getJSONObject("scripts").getInt("errored"));
            assertEquals(1, (int) (Integer) fieldOf(s, "manualFix"));
        }
    }

    private static JSONArray ringOf(SharedPreferences prefs, String key) {
        try {
            return new JSONArray(prefs.getString(key, "[]"));
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    private static boolean waitFor(java.util.function.BooleanSupplier c, long ms) {
        long end = SystemClock.uptimeMillis() + ms;
        while (SystemClock.uptimeMillis() < end) {
            if (c.getAsBoolean()) return true;
            SystemClock.sleep(50);
        }
        return c.getAsBoolean();
    }

    /** A request for the WebViewClient's error callbacks (the kind WebView would hand it). */
    private static WebResourceRequest request(String url, boolean mainFrame) {
        return new WebResourceRequest() {
            @Override
            public Uri getUrl() {
                return Uri.parse(url);
            }

            @Override
            public boolean isForMainFrame() {
                return mainFrame;
            }

            @Override
            public boolean isRedirect() {
                return false;
            }

            @Override
            public boolean hasGesture() {
                return false;
            }

            @Override
            public String getMethod() {
                return "GET";
            }

            @Override
            public Map<String, String> getRequestHeaders() {
                return new HashMap<>();
            }
        };
    }

    private static Object fieldOf(ActivityScenario<MainActivity> s, String name) {
        Object[] r = new Object[1];
        s.onActivity(x -> {
            try {
                Field f = MainActivity.class.getDeclaredField(name);
                f.setAccessible(true);
                r[0] = f.get(x);
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        });
        return r[0];
    }

    /** Runs `code` in the main WebView and returns its JSON result (null after 10 s). */
    private static String pageJs(ActivityScenario<MainActivity> s, String code) {
        CountDownLatch l = new CountDownLatch(1);
        String[] r = new String[1];
        s.onActivity(x -> {
            try {
                Field f = MainActivity.class.getDeclaredField("web");
                f.setAccessible(true);
                ((WebView) f.get(x)).evaluateJavascript(code, v -> {
                    r[0] = v;
                    l.countDown();
                });
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        });
        try {
            l.await(10, TimeUnit.SECONDS);
        } catch (InterruptedException ignored) {
            // The caller sees null.
        }
        return r[0];
    }

    /**
     * Swaps the launch's own load for a local blank page (nothing fetched, no
     * page script, no 'ready'), waits for it to settle, and stubs the page's
     * side so the test can read what the app told it.
     */
    private static void blankPage(ActivityScenario<MainActivity> s) {
        localPage(s, "https://sg.test/", "<!doctype html><title>t</title><body></body>", "sg.test");
        pageJs(s, "window.__sg = { onNative: function (c) { (window.__got = window.__got || [])"
                + ".push(c.type + (c.type === 'commentsOver' ? ':' + c.on : '')); } }; 1");
    }

    /** A local page in the main WebView (nothing fetched), settled. */
    private static void localPage(ActivityScenario<MainActivity> s, String base, String html, String host) {
        s.onActivity(x -> {
            try {
                Field f = MainActivity.class.getDeclaredField("web");
                f.setAccessible(true);
                WebView w = (WebView) f.get(x);
                w.stopLoading();
                w.loadDataWithBaseURL(base, html, "text/html", "utf-8", null);
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        });
        long end = SystemClock.uptimeMillis() + 10000;
        while (SystemClock.uptimeMillis() < end
                && !("\"" + host + " complete\"").equals(pageJs(s, "location.host + ' ' + document.readyState"))) {
            SystemClock.sleep(50);
        }
        SystemClock.sleep(500);
        idle();
    }

    private static float dpOf(MainActivity a, int v) {
        return v * a.getResources().getDisplayMetrics().density;
    }
}
