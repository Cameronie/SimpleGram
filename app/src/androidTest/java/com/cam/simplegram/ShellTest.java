package com.cam.simplegram;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.content.Intent;
import android.graphics.Rect;
import android.graphics.RectF;
import android.net.Uri;
import android.os.SystemClock;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebChromeClient;
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
                if (c instanceof ViewGroup && c.getVisibility() == View.VISIBLE && "End of Home".equals(String.valueOf(c.getContentDescription()))) bar = c;
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
            assertTrue(text, text.contains("You're all caught up") && text.contains("past 3 days") && text.contains("Favorites"));
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
}
