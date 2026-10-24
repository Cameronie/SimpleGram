package com.cam.simplegram;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNotSame;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeTrue;

import android.app.Instrumentation;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Log;
import android.view.InputDevice;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.webkit.WebViewFeature;

import org.json.JSONObject;
import org.json.JSONTokener;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * B25 (scrolling stopped everywhere until a restart): a touch split by a
 * full-screen switch left the web engine believing a finger was still down, and
 * the first touch on a touch-action:none/pan-x surface then switched vertical
 * scrolling off for the WebView's lifetime (taps kept working).
 *
 * Ported from the diagnosis's reproduction (notes/batch-5/b25-diagnosis.md). Every
 * touch goes through the real input path (Instrumentation.sendPointerSync), and
 * full screen is entered and left with the page's real requestFullscreen /
 * exitFullscreen through WebView's own custom view: calling onShowCustomView
 * with a made-up view does not reproduce the bug. Only local pages are loaded
 * (loadDataWithBaseURL); nothing is fetched.
 *
 * Regression cases (y1, y2, y3, r3, r3b, x1, h1, h2) must keep scrolling after
 * tapping the none/pan-x probes; b1, c0 and r0 are controls that always did.
 * The repair cases make the stuck state on purpose and check the chip, that
 * the quiet reset alone doesn't fix it, and that rebuilding the WebView does.
 */
@RunWith(AndroidJUnit4.class)
public class B25Test {
    static final String TAG = "B25";

    static final String PAGE = "<!doctype html><html><head>"
            + "<meta name='viewport' content='width=device-width,initial-scale=1'>"
            + "<style>html,body{margin:0}body{height:9000px;background:repeating-linear-gradient(#fff 0 100px,#ccd 100px 200px)}"
            + ".f{position:fixed;left:25%;width:50%;height:44px;font:16px sans-serif;text-align:center;line-height:44px}"
            + "#none{top:60px;background:#f88;touch-action:none}#panx{top:110px;background:#8f8;touch-action:pan-x}"
            + "#go{top:160px;background:#88f}#busy{top:210px;background:#ff8}#later{top:260px;background:#8ff}"
            + "#plain{top:310px;background:#ccc}"
            + "#vid{position:fixed;left:0;top:360px;width:100%;height:40px;background:#000;color:#fff}"
            + "#inner{position:fixed;right:0;top:60px;width:20%;height:290px;overflow-y:auto;background:#eef}#inner div{height:3000px;background:repeating-linear-gradient(#eef 0 50px,#99c 50px 100px)}"
            + "</style></head><body>"
            + "<div id=none class=f>none</div><div id=panx class=f>panx</div><div id=go class=f>fs now</div>"
            + "<div id=busy class=f>fs busy</div><div id=later class=f>fs later</div><div id=plain class=f>plain</div>"
            + "<div id=vid>video</div><div id=inner><div></div></div><script>"
            + "var S=window.b25={ts:0,tm:0,te:0,tc:0,clicks:0,last:'',fsc:0,fsErr:0,busyMs:700,laterMs:400,exitBusy:0};"
            + "addEventListener('touchstart',function(e){S.ts++},{passive:true,capture:true});"
            + "addEventListener('touchmove',function(e){S.tm++},{passive:true,capture:true});"
            + "addEventListener('touchend',function(e){S.te++},{capture:true});"
            + "addEventListener('touchcancel',function(e){S.tc++},{capture:true});"
            + "addEventListener('click',function(e){S.clicks++;S.last=e.target.id||e.target.tagName},true);"
            + "function fs(){var p=vid.requestFullscreen?vid.requestFullscreen():vid.webkitRequestFullscreen();if(p&&p.catch)p.catch(function(){S.fsErr++})}"
            + "function spin(ms){var t=Date.now();while(Date.now()-t<ms);}"
            + "go.addEventListener('click',fs);"
            + "busy.addEventListener('touchend',function(){spin(S.busyMs);fs()});"
            + "later.addEventListener('click',function(){setTimeout(fs,S.laterMs)});"
            // A page-initiated exit from a touchend, late (a busy page).
            + "vid.addEventListener('touchend',function(){if(document.fullscreenElement&&S.exitBusy){spin(S.exitBusy);document.exitFullscreen()}});"
            + "document.addEventListener('fullscreenchange',function(){S.fsc++});"
            + "window.b25ready=1;</script></body></html>";

    // A base address SimpleGram's page script isn't injected into (the native fix alone).
    static final String PLAIN_BASE = "https://b25.invalid/";
    // An Instagram address: the page script runs (R8, the drag check), nothing is fetched.
    static final String SCRIPT_BASE = "https://www.instagram.com/b25probe/";

    Instrumentation inst;
    ActivityScenario<MainActivity> scenario;
    MainActivity act;
    StringBuilder out = new StringBuilder();
    String name = "";

    @Before
    public void setUp() {
        inst = InstrumentationRegistry.getInstrumentation();
        scenario = ActivityScenario.launch(MainActivity.class);
        AtomicReference<MainActivity> a = new AtomicReference<>();
        scenario.onActivity(a::set);
        act = a.get();
        waitForWindow();
    }

    /**
     * A touch sent while Android's starting window still covers the app lands
     * in that (system) window and is refused. On a slow emulator the app's own
     * window can take ten seconds or more to come up.
     */
    void waitForWindow() {
        boolean[] f = new boolean[1];
        waitFor(() -> {
            inst.runOnMainSync(() -> f[0] = act.hasWindowFocus());
            return f[0] && web().getWidth() > 0;
        }, 45000, "the app's window to take focus");
        SystemClock.sleep(800);
    }

    @After
    public void tearDown() {
        Log.i(TAG, "=== " + name + " ===\n" + out);
        Bundle b = new Bundle();
        b.putString("b25-" + name, out.toString());
        inst.sendStatus(2, b);
        scenario.close();
    }

    /* ---------------- Reflection and page helpers ---------------- */

    Object field(String n) {
        try {
            Field f = MainActivity.class.getDeclaredField(n);
            f.setAccessible(true);
            AtomicReference<Object> r = new AtomicReference<>();
            inst.runOnMainSync(() -> {
                try {
                    r.set(f.get(act));
                } catch (IllegalAccessException e) {
                    throw new RuntimeException(e);
                }
            });
            return r.get();
        } catch (NoSuchFieldException e) {
            throw new RuntimeException(e);
        }
    }

    int intField(String n) {
        return (Integer) field(n);
    }

    void call(String method) {
        inst.runOnMainSync(() -> {
            try {
                Method m = MainActivity.class.getDeclaredMethod(method);
                m.setAccessible(true);
                m.invoke(act);
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        });
    }

    /** The current main WebView (a rebuild replaces it). */
    WebView web() {
        return (WebView) field("web");
    }

    ZoomFrame zoom() {
        return (ZoomFrame) field("zoom");
    }

    boolean fullScreen() {
        return field("customView") != null;
    }

    void loadPage(String base) {
        WebView w = web();
        inst.runOnMainSync(() -> w.loadDataWithBaseURL(base, PAGE, "text/html", "utf-8", null));
        waitFor(() -> "1".equals(js("window.b25ready||0")), 20000, "page ready");
        SystemClock.sleep(500);
    }

    String js(String code) {
        CountDownLatch l = new CountDownLatch(1);
        String[] r = new String[1];
        WebView w = web();
        inst.runOnMainSync(() -> w.evaluateJavascript(code, v -> {
            r[0] = v;
            l.countDown();
        }));
        try {
            l.await(15, TimeUnit.SECONDS);
        } catch (InterruptedException ignored) {
            // The caller sees null.
        }
        return r[0];
    }

    interface Cond {
        boolean ok();
    }

    boolean waitFor(Cond c, long ms, String what) {
        long end = SystemClock.uptimeMillis() + ms;
        while (SystemClock.uptimeMillis() < end) {
            if (c.ok()) return true;
            SystemClock.sleep(40);
        }
        log("TIMEOUT waiting for " + what);
        return false;
    }

    void log(String s) {
        Log.i(TAG, name + ": " + s);
        out.append(s).append('\n');
    }

    int[] webOnScreen() {
        int[] loc = new int[2];
        WebView w = web();
        inst.runOnMainSync(() -> w.getLocationOnScreen(loc));
        return loc;
    }

    float[] center(String id) {
        try {
            String r = js("(function(){var b=document.getElementById('" + id + "').getBoundingClientRect();"
                    + "return JSON.stringify({x:(b.left+b.width/2)*devicePixelRatio,y:(b.top+b.height/2)*devicePixelRatio})})()");
            JSONObject o = new JSONObject(new JSONTokener(r).nextValue().toString());
            int[] loc = webOnScreen();
            return new float[]{loc[0] + (float) o.getDouble("x"), loc[1] + (float) o.getDouble("y")};
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    void send(long down, int action, float x, float y) {
        MotionEvent e = MotionEvent.obtain(down, SystemClock.uptimeMillis(), action, x, y, 0);
        e.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        inst.sendPointerSync(e);
        e.recycle();
    }

    void tapAt(float x, float y) {
        long d = SystemClock.uptimeMillis();
        send(d, MotionEvent.ACTION_DOWN, x, y);
        SystemClock.sleep(40);
        send(d, MotionEvent.ACTION_UP, x, y);
    }

    void tap(String id) {
        float[] p = center(id);
        tapAt(p[0], p[1]);
        SystemClock.sleep(400);
    }

    void moves(long down, float x, float y0, float y1) {
        for (int i = 1; i <= 12; i++) {
            send(down, MotionEvent.ACTION_MOVE, x, y0 + (y1 - y0) * i / 12f);
            SystemClock.sleep(12);
        }
    }

    void drag(float x, float y0, float y1) {
        long d = SystemClock.uptimeMillis();
        send(d, MotionEvent.ACTION_DOWN, x, y0);
        moves(d, x, y0, y1);
        send(d, MotionEvent.ACTION_UP, x, y1);
    }

    float midX() {
        return web().getWidth() / 2f + webOnScreen()[0];
    }

    float yAt(float frac) {
        return webOnScreen()[1] + web().getHeight() * frac;
    }

    /** Drag up from 85% to 50% of the page; returns scrollY afterwards (from 0). */
    int scrollCheck(String label) {
        js("scrollTo(0,0)");
        SystemClock.sleep(300);
        drag(midX(), yAt(0.85f), yAt(0.5f));
        SystemClock.sleep(1200);
        String y = js("Math.round(scrollY)");
        int v = y == null ? -1 : Integer.parseInt(y);
        log(label + ": drag -> scrollY " + v + (v > 20 ? "  (scrolls)" : "  (NO SCROLL)") + "  " + counts());
        return v;
    }

    /** Drag inside the overflow-y:auto box (like the search screen's own list). */
    int innerCheck(String label) {
        js("inner.scrollTop=0");
        SystemClock.sleep(200);
        try {
            String r = js("(function(){var b=inner.getBoundingClientRect();return JSON.stringify({x:(b.left+b.width/2)*devicePixelRatio,t:b.top*devicePixelRatio,h:b.height*devicePixelRatio})})()");
            JSONObject o = new JSONObject(new JSONTokener(r).nextValue().toString());
            int[] loc = webOnScreen();
            float x = loc[0] + (float) o.getDouble("x"), t = loc[1] + (float) o.getDouble("t"), h = (float) o.getDouble("h");
            drag(x, t + h * 0.9f, t + h * 0.15f);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
        SystemClock.sleep(1000);
        String y = js("Math.round(inner.scrollTop)");
        int v = y == null ? -1 : Integer.parseInt(y);
        log(label + ": inner overflow:auto box drag -> scrollTop " + v + (v > 20 ? "  (scrolls)" : "  (NO SCROLL)"));
        return v;
    }

    String counts() {
        return js("JSON.stringify({ts:b25.ts,tm:b25.tm,te:b25.te,tc:b25.tc,clicks:b25.clicks,last:b25.last,fsc:b25.fsc,fsErr:b25.fsErr})");
    }

    void tapStillClicks(String label) {
        String before = js("b25.clicks");
        tap("plain");
        String after = js("b25.clicks");
        log(label + ": tap plain clicks " + before + " -> " + after);
        assertEquals(label + ": taps work", Integer.parseInt(before) + 1, Integer.parseInt(after));
    }

    /** After a split touch: drags scroll, also after touching the none/pan-x surfaces, and taps work. */
    void assertStillScrolls() {
        assertTrue("C: scrolls after the split touch", scrollCheck("C after straddle") > 20);
        tap("none");
        assertTrue("D: scrolls after a touch-action:none surface", scrollCheck("D after tapping touch-action:none") > 20);
        tap("panx");
        assertTrue("D2: scrolls after a touch-action:pan-x surface", scrollCheck("D2 after tapping touch-action:pan-x") > 20);
        assertTrue("D3: an inner list scrolls", innerCheck("D3") > 20);
        tapStillClicks("E");
    }

    void enterNow() {
        tap("go");
        boolean ok = waitFor(this::fullScreen, 8000, "onShowCustomView");
        SystemClock.sleep(500);
        log("entered full screen: " + ok + " fsEl " + js("!!document.fullscreenElement"));
        assertTrue("full screen through WebView's own custom view", ok);
    }

    void exitByPage() {
        js("document.exitFullscreen()");
        waitFor(() -> !fullScreen(), 8000, "onHideCustomView");
        SystemClock.sleep(600);
        log("left full screen, fsEl " + js("!!document.fullscreenElement"));
    }

    void baseline() {
        assertTrue("A baseline", scrollCheck("A baseline") > 20);
        assertTrue("A2 baseline", innerCheck("A2 baseline") > 20);
        tap("none");
        assertTrue("B: a none surface alone is harmless", scrollCheck("B after tapping touch-action:none (no straddle yet)") > 20);
    }

    /* ---------------- Controls (always worked) ---------------- */

    @Test
    public void c0_controlFullScreenRoundTripNoStraddle() {
        name = "c0_control";
        loadPage(PLAIN_BASE);
        baseline();
        enterNow();
        float cx = midX(), cy = yAt(0.5f);
        drag(cx, cy + 200, cy - 200);
        SystemClock.sleep(400);
        exitByPage();
        assertStillScrolls();
        assertEquals("nothing to cancel", 0, intField("cancelsShow") + intField("cancelsHide"));
    }

    @Test
    public void b1_backWhileFingerDown() {
        name = "b1_backMidTouch";
        loadPage(PLAIN_BASE);
        enterNow();
        float cx = midX(), cy = yAt(0.5f);
        long d = SystemClock.uptimeMillis();
        send(d, MotionEvent.ACTION_DOWN, cx, cy);
        SystemClock.sleep(300);
        inst.runOnMainSync(act::onBackPressed);
        waitFor(() -> !fullScreen(), 8000, "hide");
        SystemClock.sleep(600);
        moves(d, cx, cy, cy - 300);
        send(d, MotionEvent.ACTION_UP, cx, cy - 300);
        SystemClock.sleep(600);
        log("fsEl after Back " + js("!!document.fullscreenElement"));
        assertEquals("false", js("!!document.fullscreenElement"));
        assertStillScrolls();
    }

    /* ---------------- Regression cases (broke in 1.3) ---------------- */

    /** (Y) A finger down on the full-screen view while the page ends full screen. */
    @Test
    public void y1_exitWhileFingerDown() {
        name = "y1_exitMidTouch";
        loadPage(PLAIN_BASE);
        baseline();
        enterNow();
        float cx = midX(), cy = yAt(0.5f);
        long d = SystemClock.uptimeMillis();
        send(d, MotionEvent.ACTION_DOWN, cx, cy);
        SystemClock.sleep(300);
        js("document.exitFullscreen()");
        boolean hid = waitFor(() -> !fullScreen(), 8000, "onHideCustomView");
        log("hid while finger down: " + hid);
        SystemClock.sleep(300);
        moves(d, cx, cy, cy - 300);
        send(d, MotionEvent.ACTION_UP, cx, cy - 300);
        SystemClock.sleep(600);
        log("straddled touch done " + counts());
        assertTrue(hid);
        assertTrue("the split touch was cancelled", intField("cancelsHide") >= 1);
        assertEquals("the page saw it end", "1", js("b25.tc"));
        assertStillScrolls();
    }

    /** (Y') The same, with touch-action:pan-x the only no-pan-y surface touched. */
    @Test
    public void y2_exitWhileFingerDownPanX() {
        name = "y2_exitMidTouch_panx";
        loadPage(PLAIN_BASE);
        enterNow();
        float cx = midX(), cy = yAt(0.5f);
        long d = SystemClock.uptimeMillis();
        send(d, MotionEvent.ACTION_DOWN, cx, cy);
        SystemClock.sleep(300);
        js("document.exitFullscreen()");
        waitFor(() -> !fullScreen(), 8000, "onHideCustomView");
        SystemClock.sleep(300);
        moves(d, cx, cy, cy - 300);
        send(d, MotionEvent.ACTION_UP, cx, cy - 300);
        SystemClock.sleep(600);
        assertTrue("C", scrollCheck("C after straddle") > 20);
        tap("panx");
        assertTrue("D", scrollCheck("D after tapping touch-action:pan-x") > 20);
        tapStillClicks("E");
    }

    /** A swipe's touchend ends full screen late (a busy page); the next swipe is already down. */
    @Test
    public void y3_exitFromBusyTouchendNextSwipeDown() {
        name = "y3_exitBusyTouchend";
        loadPage(PLAIN_BASE);
        enterNow();
        js("b25.exitBusy=700");
        float cx = midX(), cy = yAt(0.5f);
        drag(cx, cy - 200, cy + 200);
        SystemClock.sleep(80);
        long d = SystemClock.uptimeMillis();
        send(d, MotionEvent.ACTION_DOWN, cx, cy - 200);
        boolean before = fullScreen();
        boolean hid = waitFor(() -> !fullScreen(), 8000, "onHideCustomView");
        log("DOWN landed while still full screen: " + before + ", hide came: " + hid);
        SystemClock.sleep(300);
        moves(d, cx, cy - 200, cy + 200);
        send(d, MotionEvent.ACTION_UP, cx, cy + 200);
        SystemClock.sleep(600);
        js("b25.exitBusy=0");
        assertStillScrolls();
    }

    /** (X) The page asks for full screen from a busy touchend; the next finger is already down. */
    @Test
    public void x1_enterWhileFingerDownBusyTouchend() {
        name = "x1_enterMidTouch_busy";
        loadPage(PLAIN_BASE);
        baseline();
        float[] b = center("busy");
        tapAt(b[0], b[1]);                       // its touchend spins 700 ms, then requestFullscreen
        SystemClock.sleep(80);
        float cx = midX(), cy = yAt(0.8f);
        long d = SystemClock.uptimeMillis();
        send(d, MotionEvent.ACTION_DOWN, cx, cy);
        boolean before = !fullScreen();
        boolean shown = waitFor(this::fullScreen, 8000, "onShowCustomView");
        log("DOWN landed before show: " + before + ", show came: " + shown);
        SystemClock.sleep(300);
        moves(d, cx, cy, cy - 300);
        send(d, MotionEvent.ACTION_UP, cx, cy - 300);
        SystemClock.sleep(600);
        assertTrue(shown);
        if (before) assertTrue("the touch open at the switch was cancelled", intField("cancelsShow") >= 1);
        exitByPage();
        assertStillScrolls();
    }

    /** The app's held finger (the Story menu's hold) across a full-screen switch. */
    @Test
    public void h1_holdAcrossFullScreen() {
        name = "h1_holdAcrossFullScreen";
        loadPage(PLAIN_BASE);
        float[] b = center("later");
        ZoomFrame z = zoom();
        tapAt(b[0], b[1]);                       // full screen in 400 ms
        inst.runOnMainSync(z::hold);
        boolean shown = waitFor(this::fullScreen, 8000, "onShowCustomView");
        log("held, full screen shown " + shown + " holding " + z.isHolding() + " " + counts());
        SystemClock.sleep(400);
        inst.runOnMainSync(z::releaseHold);
        SystemClock.sleep(300);
        if (fullScreen()) exitByPage();
        assertTrue("the held finger got its cancel where the input was", intField("cancelsHold") >= 1);
        assertStillScrolls();
    }

    /** A touchscreen event with several fingers (pointer ids 0..n-1), through the real input path. */
    void sendFingers(long down, int action, float[][] pts) {
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
        MotionEvent e = MotionEvent.obtain(down, SystemClock.uptimeMillis(), action, n, props, coords, 0, 0, 1f, 1f, 0, 0,
                InputDevice.SOURCE_TOUCHSCREEN, 0);
        inst.sendPointerSync(e);
        e.recycle();
    }

    /**
     * A Story outside full screen held with one finger while another taps ⋮:
     * the menu's own press must not land on top of the finger already on the
     * page (the web engine would keep counting one of them down for good).
     */
    @Test
    public void h2_menuTappedWhileAFingerHoldsTheStory() throws Exception {
        name = "h2_menuTappedWhileAFingerHoldsTheStory";
        loadPage(PLAIN_BASE);
        baseline();
        Field route = MainActivity.class.getDeclaredField("route");
        route.setAccessible(true);
        inst.runOnMainSync(() -> {
            try {
                route.set(act, "story");
            } catch (IllegalAccessException e) {
                throw new RuntimeException(e);
            }
        });
        View tab = (View) field("menuButton");
        int[] tl = new int[2];
        inst.runOnMainSync(() -> tab.getLocationOnScreen(tl));
        float tx = tl[0] + tab.getWidth() / 2f, ty = tl[1] + tab.getHeight() / 2f;
        float x = midX(), y = yAt(0.7f);
        long d = SystemClock.uptimeMillis();
        send(d, MotionEvent.ACTION_DOWN, x, y);              // finger 1 presses the Story
        SystemClock.sleep(200);
        sendFingers(d, MotionEvent.ACTION_MOVE, new float[][]{{x, y + 2}});
        SystemClock.sleep(100);
        int second = 1 << MotionEvent.ACTION_POINTER_INDEX_SHIFT;
        sendFingers(d, MotionEvent.ACTION_POINTER_DOWN | second, new float[][]{{x, y + 2}, {tx, ty}});
        SystemClock.sleep(60);
        sendFingers(d, MotionEvent.ACTION_POINTER_UP | second, new float[][]{{x, y + 2}, {tx, ty}});
        boolean opened = waitFor(() -> (Boolean) field("menuOpen"), 4000, "menu");
        SystemClock.sleep(500);
        log("menu open " + opened + " holding " + zoom().isHolding() + " " + counts());
        assertTrue("the second finger's tap opened the menu", opened);
        assertTrue("the menu holds the Story", zoom().isHolding());
        sendFingers(d, MotionEvent.ACTION_MOVE, new float[][]{{x, y + 4}});
        SystemClock.sleep(100);
        inst.getUiAutomation().performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK);
        waitFor(() -> !(Boolean) field("menuOpen"), 4000, "menu closed");
        SystemClock.sleep(300);
        send(d, MotionEvent.ACTION_UP, x, y + 4);          // finger 1 lifts after the menu
        SystemClock.sleep(500);
        log("after: holding " + zoom().isHolding() + " " + counts());
        assertFalse("the hold was let go", zoom().isHolding());
        inst.runOnMainSync(() -> {
            try {
                route.set(act, "other");
            } catch (IllegalAccessException e) {
                throw new RuntimeException(e);
            }
        });
        assertStillScrolls();
    }

    /** Taps an item of the dialog showing now (through accessibility, as a finger would pick it). */
    boolean pickMenuItem(String label) {
        long end = SystemClock.uptimeMillis() + 6000;
        while (SystemClock.uptimeMillis() < end) {
            // The dialog may not be the "active" window yet, and a long menu may
            // need scrolling on a small screen: look in every window and scroll.
            java.util.List<android.view.accessibility.AccessibilityNodeInfo> roots = new java.util.ArrayList<>();
            android.view.accessibility.AccessibilityNodeInfo active = inst.getUiAutomation().getRootInActiveWindow();
            if (active != null) roots.add(active);
            for (android.view.accessibility.AccessibilityWindowInfo w : inst.getUiAutomation().getWindows()) {
                if (w.getRoot() != null) roots.add(w.getRoot());
            }
            for (android.view.accessibility.AccessibilityNodeInfo root : roots) {
                for (android.view.accessibility.AccessibilityNodeInfo n : root.findAccessibilityNodeInfosByText(label)) {
                    if (n.getText() == null || !label.contentEquals(n.getText())) continue;
                    // Tap the item where it is on screen, through the test framework's
                    // own input path (a dialog's list item takes no accessibility click
                    // on Android 10).
                    android.graphics.Rect b = new android.graphics.Rect();
                    n.getBoundsInScreen(b);
                    boolean ok = !b.isEmpty() && tapScreen(b.exactCenterX(), b.exactCenterY());
                    log("menu item '" + label + "' tapped " + ok + " at " + b.toShortString());
                    return ok;
                }
            }
            for (android.view.accessibility.AccessibilityNodeInfo root : roots) scrollForward(root, 0);
            SystemClock.sleep(150);
        }
        log("menu item '" + label + "' not found");
        return false;
    }

    private boolean tapScreen(float x, float y) {
        android.app.UiAutomation ua = inst.getUiAutomation();
        long t = SystemClock.uptimeMillis();
        MotionEvent down = MotionEvent.obtain(t, t, MotionEvent.ACTION_DOWN, x, y, 0);
        down.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        MotionEvent up = MotionEvent.obtain(t, t + 60, MotionEvent.ACTION_UP, x, y, 0);
        up.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        try {
            return ua.injectInputEvent(down, true) && ua.injectInputEvent(up, true);
        } finally {
            down.recycle();
            up.recycle();
        }
    }

    private static boolean scrollForward(android.view.accessibility.AccessibilityNodeInfo n, int depth) {
        if (n == null || depth > 12) return false;
        if (n.isScrollable() && n.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_SCROLL_FORWARD)) return true;
        for (int i = 0; i < n.getChildCount(); i++) if (scrollForward(n.getChild(i), depth + 1)) return true;
        return false;
    }

    /* ---------------- With SimpleGram's page script and R8 ---------------- */

    static final String REEL = "<!doctype html><html><head>"
            + "<meta name='viewport' content='width=device-width,initial-scale=1'>"
            + "<style>html,body{margin:0}body{height:6000px;background:#fff}"
            + "#wrap{height:300px}#rv{display:block;width:100%;height:300px;background:#123}"
            + "</style></head><body><div id=wrap><video id=rv muted playsinline></video></div><script>"
            + "var S=window.b25={busy:0,ts:0,te:0,tc:0};"
            + "function spin(ms){var t=Date.now();while(Date.now()-t<ms);}"
            // A busy page: from a swipe's touchstart the main thread is tied up, so
            // the swipe's touchend (and R8's full-screen switch in it) runs late.
            + "addEventListener('touchstart',function(){S.ts++;if(S.busy)setTimeout(function(){spin(S.busy)},0)},{passive:true,capture:true});"
            + "addEventListener('touchend',function(){S.te++},{capture:true});"
            + "addEventListener('touchcancel',function(){S.tc++},{capture:true});"
            + "window.b25ready=1;</script></body></html>";

    void loadReel() {
        String b = "https://www.instagram.com/reel/B25test/";
        WebView w = web();
        inst.runOnMainSync(() -> w.loadDataWithBaseURL(b, REEL, "text/html", "utf-8", b));
        waitFor(() -> "1".equals(js("window.b25ready||0")), 20000, "reel ready");
        waitFor(() -> "true".equals(js("typeof window.__sgCfg==='object'")), 10000, "page script");
        SystemClock.sleep(1500);
        log("reel page: script " + js("typeof window.__sgCfg") + " role " + js("window.__sgCfg&&__sgCfg.role"));
    }

    float[] videoPt(float fy) {
        try {
            String r = js("(function(){var b=rv.getBoundingClientRect();return JSON.stringify({x:(b.left+b.width/2)*devicePixelRatio,t:b.top*devicePixelRatio,h:b.height*devicePixelRatio})})()");
            JSONObject o = new JSONObject(new JSONTokener(r).nextValue().toString());
            int[] loc = webOnScreen();
            return new float[]{loc[0] + (float) o.getDouble("x"), loc[1] + (float) o.getDouble("t") + (float) o.getDouble("h") * fy};
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    String r8State() {
        return "fullScreens " + field("fullScreens") + " customView " + fullScreen() + " page fsEl "
                + js("document.fullscreenElement?document.fullscreenElement.id:null") + " sgFull " + js("rv.dataset.sgFull||null")
                + " " + js("JSON.stringify(b25)") + " fs " + js("JSON.stringify(window.__sg.stats.b25.fs)");
    }

    void r8Enter() {
        float[] a = videoPt(0.2f), z = videoPt(0.9f);
        long t0 = SystemClock.uptimeMillis();
        drag(a[0], a[1], z[1]);
        long dragMs = SystemClock.uptimeMillis() - t0;        // R8 takes a swipe under 1.5 s
        boolean ok = waitFor(this::fullScreen, 8000, "R8 full screen");
        SystemClock.sleep(800);
        log("R8 enter by swipe: " + ok + "  drag took " + dragMs + " ms  " + r8State()
                + " fullVideo " + js("JSON.stringify(window.__sg.stats.diag.fullVideo)"));
        assertTrue("R8 entered full screen", ok);
    }

    /** Put the plain page's probes onto the current (reel) document. */
    void addProbes() {
        int a = PAGE.indexOf("<style>") + 7, b = PAGE.indexOf("</style>");
        String css = PAGE.substring(a, b).replace("html,body{margin:0}body{height:9000px;", "x{");
        int c = PAGE.indexOf("<body>") + 6, d = PAGE.indexOf("<script>");
        String html = PAGE.substring(c, d).replace("<div id=vid>video</div>", "");
        String code = "(function(){var st=document.createElement('style');st.textContent=" + JSONObject.quote(css) + ";document.head.appendChild(st);"
                + "document.body.insertAdjacentHTML('beforeend'," + JSONObject.quote(html) + ");"
                + "var S=window.b25;S.tm=0;S.clicks=0;S.last='';S.fsc=0;S.fsErr=0;"
                + "addEventListener('touchmove',function(e){S.tm++},{passive:true,capture:true});"
                + "addEventListener('click',function(e){S.clicks++;S.last=e.target.id||e.target.tagName},true);return 1})()";
        log("probes added " + js(code));
    }

    void backIfStillFull() {
        if (!fullScreen()) return;
        inst.runOnMainSync(act::onBackPressed);
        waitFor(() -> !fullScreen(), 8000, "Back");
        SystemClock.sleep(800);
        log("Back: " + r8State());
    }

    /** Control: R8 in and out by swipes, each complete before the next; the exit goes the Back way. */
    /**
     * These cases need the page to talk to the app (WebMessageListener, WebView
     * 82 or newer; the phone has 155). An older WebView, such as the Android 10
     * emulator image's 74, gets no bridge by design, so they can't run there.
     */
    private static void assumeBridge() {
        assumeTrue("needs the page-to-app bridge (WebMessageListener); this WebView is too old",
                WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER));
    }

    @Test
    public void r0_r8RoundTripControl() {
        assumeBridge();
        name = "r0_r8Control";
        loadReel();
        r8Enter();
        js("b25.busy=200");
        float cx = midX(), cy = yAt(0.5f);
        drag(cx, cy - 250, cy + 250);
        boolean out = waitFor(() -> !fullScreen(), 8000, "R8 exit");
        SystemClock.sleep(1500);
        log("R8 exit: " + out + " " + r8State());
        js("b25.busy=0");
        assertTrue("R8's swipe left full screen", out);
        assertEquals("through the app, the Back way", "1", js("window.__sg.stats.b25.fs.exitAsked"));
        loadPage(PLAIN_BASE);
        assertStillScrolls();
    }

    /** R8's exit swipe on a very busy page and a second swipe down before the page acted on it. */
    @Test
    public void r3_r8QuickSecondSwipeSameDocument() {
        name = "r3_r8QuickSecondSwipeSameDoc";
        loadReel();
        r8Enter();
        js("b25.busy=1500");
        float cx = midX(), cy = yAt(0.5f);
        drag(cx, cy - 250, cy + 250);
        SystemClock.sleep(60);
        long d = SystemClock.uptimeMillis();
        send(d, MotionEvent.ACTION_DOWN, cx, cy - 250);
        boolean before = fullScreen();
        boolean hid = waitFor(() -> !fullScreen(), 4000, "R8 exit");
        log("swipe 2 DOWN while still full screen: " + before + ", exit came while it was down: " + hid);
        SystemClock.sleep(300);
        moves(d, cx, cy - 250, cy + 250);
        send(d, MotionEvent.ACTION_UP, cx, cy + 250);
        SystemClock.sleep(2500);
        js("b25.busy=0");
        log("after swipe 2: " + r8State());
        // A lift handled that late may switch nothing at all (it is stale): then Back.
        backIfStillFull();
        addProbes();
        assertStillScrolls();
    }

    /** As r3, with the page busy enough that R8's exit lands while the second finger is down. */
    @Test
    public void r3b_r8ExitLandsUnderTheNextFinger() {
        name = "r3b_r8ExitUnderNextFinger";
        loadReel();
        r8Enter();
        js("b25.busy=300");
        float cx = midX(), cy = yAt(0.5f);
        drag(cx, cy - 250, cy + 250);
        SystemClock.sleep(40);
        long d = SystemClock.uptimeMillis();
        send(d, MotionEvent.ACTION_DOWN, cx, cy - 250);
        boolean before = fullScreen();
        boolean hid = waitFor(() -> !fullScreen(), 4000, "R8 exit");
        log("swipe 2 DOWN while still full screen: " + before + ", exit came while it was down: " + hid);
        SystemClock.sleep(300);
        moves(d, cx, cy - 250, cy + 250);
        send(d, MotionEvent.ACTION_UP, cx, cy + 250);
        SystemClock.sleep(1500);
        js("b25.busy=0");
        log("after swipe 2: " + r8State() + " cancelsHide " + field("cancelsHide"));
        backIfStillFull();
        assertEquals("never full screen again", "null", js("document.fullscreenElement&&document.fullscreenElement.id"));
        addProbes();
        assertStillScrolls();
    }

    void message(String json) {
        inst.runOnMainSync(() -> {
            try {
                Method m = MainActivity.class.getDeclaredMethod("onMessage", String.class, String.class);
                m.setAccessible(true);
                m.invoke(act, "main", json);
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        });
    }

    void setRoute(String r) {
        inst.runOnMainSync(() -> {
            try {
                Field f = MainActivity.class.getDeclaredField("route");
                f.setAccessible(true);
                f.set(act, r);
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        });
    }

    /** The page's requests: leave full screen the Back way (never a Story's); the repair's steps and its gate. */
    @Test
    public void messages_exitRequestAndTheRepairGate() throws Exception {
        name = "messages";
        loadPage(PLAIN_BASE);
        // fullVideoExitRequest: the app leaves full screen itself, view first.
        enterNow();
        setRoute("post");
        message("{\"action\":\"fullVideoExitRequest\",\"why\":\"swipe\"}");
        assertTrue(waitFor(() -> !fullScreen(), 4000, "exit by request"));
        assertTrue(waitFor(() -> "false".equals(js("!!document.fullscreenElement")), 4000, "page left full screen"));
        @SuppressWarnings("unchecked")
        List<JSONObject> log = (List<JSONObject>) field("fsLog");
        assertEquals("r8bridge", log.get(log.size() - 1).getString("initiator"));
        // Never a Story's own full screen (Instagram would close the Story).
        enterNow();
        setRoute("story");
        message("{\"action\":\"fullVideoExitRequest\",\"why\":\"swipe\"}");
        SystemClock.sleep(500);
        assertTrue(fullScreen());
        inst.runOnMainSync(act::onBackPressed);
        assertTrue(waitFor(() -> !fullScreen(), 4000, "Back"));
        setRoute("other");

        // The repair: the gate first. In screenshot mode a report isn't trusted.
        scrollCheck("moves for the gate");
        call("enterScreenshot");
        message("{\"action\":\"scrollStuck\",\"strikes\":3,\"where\":\"other\",\"moves\":5}");
        assertEquals(0, intField("softResets"));
        assertEquals(1, ((JSONObject) field("stuckIgnored")).optInt("screenshot"));
        call("exitScreenshot");
        SystemClock.sleep(300);
        // Trusted: a quiet reset first, then the chip; it goes when drags scroll again.
        message("{\"action\":\"scrollStuck\",\"strikes\":3,\"where\":\"other\",\"moves\":5}");
        assertEquals(1, intField("softResets"));
        assertFalse(chipShowing());
        message("{\"action\":\"scrollStuck\",\"strikes\":2,\"where\":\"other\",\"moves\":5}");
        assertTrue(waitFor(this::chipShowing, 2000, "chip"));
        // Never over a full screen.
        enterNow();
        assertFalse(chipShowing());
        inst.runOnMainSync(act::onBackPressed);
        assertTrue(waitFor(() -> !fullScreen(), 4000, "Back"));
        assertTrue(waitFor(this::chipShowing, 2000, "chip back"));
        message("{\"action\":\"scrollOk\"}");
        assertFalse(chipShowing());
        assertEquals(0, intField("rebuilds"));
    }

    /* ---------------- The repair ---------------- */

    /**
     * The stuck state on purpose: a DOWN delivered straight to the WebView and
     * never lifted (the lost end), then a tap on the pan-x surface.
     */
    void makeStuck() {
        WebView w = web();
        float x = midX(), y = yAt(0.7f);
        inst.runOnMainSync(() -> {
            long now = SystemClock.uptimeMillis();
            MotionEvent down = MotionEvent.obtain(now, now, MotionEvent.ACTION_DOWN, x - webOnScreenNow(w)[0], y - webOnScreenNow(w)[1], 0);
            down.setSource(InputDevice.SOURCE_TOUCHSCREEN);
            w.dispatchTouchEvent(down);
            down.recycle();
        });
        SystemClock.sleep(300);
        tap("panx");
        log("stuck on purpose: " + counts());
    }

    static int[] webOnScreenNow(WebView w) {
        int[] loc = new int[2];
        w.getLocationOnScreen(loc);
        return loc;
    }

    View stuckChip() {
        return (View) field("stuckChip");
    }

    boolean chipShowing() {
        View c = stuckChip();
        AtomicReference<Boolean> r = new AtomicReference<>(false);
        inst.runOnMainSync(() -> r.set(c.getVisibility() == View.VISIBLE && c.isShown()));
        return r.get();
    }

    @Test
    public void repair_chipQuietResetAndRebuild() {
        assumeBridge();
        name = "repair_chip";
        loadPage(SCRIPT_BASE);
        assertEquals("the page script runs", "true", js("typeof window.__sg==='object'"));
        assertTrue("A baseline", scrollCheck("A baseline") > 20);
        makeStuck();
        // Three drags that don't scroll: the page reports, the app resets quietly.
        for (int i = 1; i <= 3; i++) assertTrue("dead " + i, scrollCheck("dead " + i) <= 20);
        boolean soft = waitFor(() -> intField("softResets") == 1, 4000, "the quiet reset");
        log("page b25: " + js("JSON.stringify({seq:__sg.stats.b25.touchSeq,drag:__sg.stats.b25.drag.dead,stuck:__sg.stats.b25.stuck})"));
        log("native: posts " + field("stuckPosts") + " ignored " + field("stuckIgnored") + " soft " + field("softResets"));
        assertTrue("reported and reset quietly", soft);
        assertFalse("no chip yet", chipShowing());
        // On WebView 74 the quiet reset alone doesn't fix it (the web engine's
        // own state) and the chip follows. A newer web engine comes back from
        // the reset itself: then there is nothing for the chip to do, and the
        // rest of this case (the chip's rebuild) can't be run here.
        if (scrollCheck("after soft 1") > 20) {
            SystemClock.sleep(1500);
            assertFalse("no chip once scrolling is back", chipShowing());
            log("the quiet reset was enough on this WebView: the chip's rebuild isn't exercised");
            assertStillScrolls();
            return;
        }
        assertTrue(scrollCheck("after soft 2") <= 20);
        assertTrue("the chip offers the fix", waitFor(this::chipShowing, 4000, "chip"));
        assertEquals(1, intField("chipShown"));
        // It never acts on its own: still the same WebView.
        WebView old = web();
        SystemClock.sleep(1500);
        assertSame(old, web());
        // Tap it: a new WebView in the same place.
        float[] p = new float[2];
        View chip = stuckChip();
        inst.runOnMainSync(() -> {
            int[] loc = new int[2];
            chip.getLocationOnScreen(loc);
            p[0] = loc[0] + chip.getWidth() / 2f;
            p[1] = loc[1] + chip.getHeight() / 2f;
        });
        tapAt(p[0], p[1]);
        assertTrue("rebuilt", waitFor(() -> web() != old, 5000, "rebuild"));
        SystemClock.sleep(1000);
        assertFalse(chipShowing());
        assertEquals(1, intField("rebuilds"));
        loadPage(SCRIPT_BASE);
        assertStillScrolls();
    }

    @Test
    public void repair_fixScrollingMenuRebuildsInPlace() throws Exception {
        name = "repair_menu";
        loadPage(PLAIN_BASE);
        makeStuck();
        assertTrue("stuck on purpose", scrollCheck("stuck") <= 20);
        WebView old = web();
        CommentsPanel panel = (CommentsPanel) field("comments");
        WebView commentsWeb = panel.web();
        ZoomFrame z = zoom();
        int allBefore = intField("startsAll"), appBefore = intField("startsLoadUrl");
        // Where the diagnosis's recovery steps send Cam: straight in the ⋮ menu.
        call("showMenu");
        assertTrue("⋮ lists Fix scrolling", pickMenuItem("Fix scrolling"));
        assertTrue("rebuilt", waitFor(() -> web() != old, 5000, "rebuild"));
        SystemClock.sleep(800);
        WebView fresh = web();
        // The restored (or reloaded) page counts once, as a load the app started.
        assertTrue(waitFor(() -> intField("startsAll") > allBefore, 5000, "the new page's start"));
        SystemClock.sleep(500);
        assertEquals("page loads: one more", allBefore + 1, intField("startsAll"));
        assertEquals("and the app started it", appBefore + 1, intField("startsLoadUrl"));
        assertNotSame(old, fresh);
        AtomicReference<Object[]> r = new AtomicReference<>();
        inst.runOnMainSync(() -> r.set(new Object[]{z.getChildAt(0), old.getParent(), commentsWeb.getParent() != null, panel.web()}));
        assertSame("the new WebView sits where the old one was", fresh, r.get()[0]);
        assertNull("the old one is gone", r.get()[1]);
        assertTrue("the comments panel keeps its own", (Boolean) r.get()[2]);
        assertSame(commentsWeb, r.get()[3]);
        // The page script is registered for the new WebView (and no longer for the old one).
        @SuppressWarnings("unchecked")
        List<Object> scripts = (List<Object>) field("scripts");
        int forFresh = 0, forOld = 0;
        for (Object s : scripts) {
            Field v = s.getClass().getDeclaredField("view");
            v.setAccessible(true);
            if (v.get(s) == fresh) forFresh++;
            if (v.get(s) == old) forOld++;
        }
        assertEquals(1, forFresh);
        assertEquals(0, forOld);
        assertEquals(1, intField("manualFix"));
        AtomicReference<Object> chrome = new AtomicReference<>();
        inst.runOnMainSync(() -> chrome.set(fresh.getWebChromeClient()));   // WebView calls belong on the main thread
        assertNotNull(chrome.get());
        loadPage(PLAIN_BASE);
        assertStillScrolls();
        // Full screen works on the new WebView, and Back leaves it.
        enterNow();
        inst.runOnMainSync(act::onBackPressed);
        assertTrue(waitFor(() -> !fullScreen(), 8000, "Back"));
    }

    /**
     * After a zoom that ended with its animated reset (the chip, Back, a double
     * tap, a pinch let go near 1x), the zoom isn't "animating" for good: a
     * report is trusted. Then the chip: off R9's Reel layer, and gone when the
     * next page's first drag scrolls.
     */
    @Test
    public void repair_gateAfterAnimatedZoomResetAndTheChipsPlaces() throws Exception {
        assumeBridge();
        name = "repair_gateAfterZoom";
        loadPage(PLAIN_BASE);
        ZoomFrame z = zoom();
        inst.runOnMainSync(() -> {
            try {
                Field f = ZoomFrame.class.getDeclaredField("scale");
                f.setAccessible(true);
                f.setFloat(z, 2f);
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
            z.reset(true);
        });
        AtomicReference<Boolean> anim = new AtomicReference<>();
        inst.runOnMainSync(() -> anim.set(z.isAnimating()));
        log("animating right after the reset: " + anim.get());   // false on a device with animations off
        SystemClock.sleep(500);
        inst.runOnMainSync(() -> anim.set(z.isAnimating()));
        assertFalse("not animating once it has ended", anim.get());
        assertEquals(1f, z.scale(), 0.0001f);

        scrollCheck("moves for the gate");
        message("{\"action\":\"scrollStuck\",\"strikes\":3,\"where\":\"other\",\"moves\":5}");
        assertEquals("trusted: the quiet reset", 1, intField("softResets"));
        assertFalse(((JSONObject) field("stuckIgnored")).has("zoomGesture"));
        message("{\"action\":\"scrollStuck\",\"strikes\":2,\"where\":\"other\",\"moves\":5}");
        assertTrue(waitFor(this::chipShowing, 2000, "chip"));
        // R9's Reel layer (no WebView full screen): never under the chip.
        message("{\"action\":\"fullVideo\",\"on\":true}");
        assertFalse("no chip over the Reel layer", chipShowing());
        message("{\"action\":\"fullVideo\",\"on\":false}");
        assertTrue(waitFor(this::chipShowing, 2000, "chip back"));
        // A new page (Refresh, Following) where drags scroll: its first one clears the chip.
        loadPage(SCRIPT_BASE);
        assertTrue("still up on the new page", chipShowing());
        assertTrue(scrollCheck("scrolls on the new page") > 20);
        assertTrue("gone once a drag scrolled", waitFor(() -> !chipShowing(), 3000, "chip gone"));
        assertEquals(0, intField("rebuilds"));
    }

    /** A rebuild asked for just before the Activity goes leaves nothing behind. */
    @Test
    public void repair_rebuildThenDestroyLeavesNoWebView() throws Exception {
        name = "repair_rebuildThenDestroy";
        loadPage(PLAIN_BASE);
        js("setTimeout(function(){spin(3000)},0)");    // too busy to answer: only the delayed swap is left
        SystemClock.sleep(100);
        MainActivity first = act;
        WebView old = web();
        inst.runOnMainSync(() -> {
            try {
                Method m = MainActivity.class.getDeclaredMethod("rebuildWebView");
                m.setAccessible(true);
                m.invoke(first);
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
            first.recreate();
        });
        SystemClock.sleep(3500);
        AtomicReference<Boolean> destroyed = new AtomicReference<>();
        inst.runOnMainSync(() -> destroyed.set(first.isDestroyed()));
        assertTrue("the first Activity is gone", destroyed.get());
        assertEquals("no swap on the destroyed Activity", 0, intField("rebuilds"));
        assertSame(old, web());
        assertNull(field("pendingRebuild"));
        assertTrue("no WebView left registered", ((List<?>) field("scripts")).isEmpty());
    }
}
