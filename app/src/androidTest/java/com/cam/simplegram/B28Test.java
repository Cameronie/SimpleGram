package com.cam.simplegram;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeTrue;

import android.app.Instrumentation;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Base64;
import android.util.Log;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
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

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.lang.reflect.Field;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * B28 (a video opened full screen from Home paused, and another one was heard):
 * the diagnosis probe (B28Probe) as a test. A feed of three videos (A, B, C)
 * with an Instagram-like player that plays only the post most on screen, B
 * scrolled into view and tapped through the real input path, so SimpleGram's
 * R10 opens it full screen the way it does on the phone: the page full screen
 * and the video lifted over it (page mode). Android's web view then scrolls
 * the page under the video to the top; SimpleGram puts it back at once.
 *
 * Asserts: the page's scroll stays within 2 px of where it was through the
 * full screen; B is the only video playing and the only one with sound; a
 * pause made in full screen is kept after Back, with the page back where it
 * was. Page mode needs the Popover API (WebView 114 or later): on an older
 * WebView the test is skipped (the emulator image's is 74; see
 * notes/batch-6/b28-diagnosis.md "Reproducing it" for the WebView 158 bind
 * mount). Only local pages are loaded; nothing is fetched.
 */
@RunWith(AndroidJUnit4.class)
public class B28Test {
    static final String TAG = "B28";
    static final String BASE = "https://www.instagram.com/";
    static final int SAMPLES = 30;          // 3 s of the full screen, 100 ms apart

    Instrumentation inst;
    ActivityScenario<MainActivity> scenario;
    MainActivity act;
    StringBuilder out = new StringBuilder();
    String name = "";

    @Before
    public void setUp() {
        assumeTrue("needs the page-to-app bridge (WebMessageListener); this WebView is too old",
                WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER));
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
        if (scenario == null) return;
        Log.i(TAG, "=== " + name + " ===\n" + out);
        Bundle b = new Bundle();
        b.putString("b28-" + name, out.toString());
        inst.sendStatus(2, b);
        scenario.close();
    }

    /* ---------------- Reflection and page helpers (as in B28Probe) ---------------- */

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

    WebView web() {
        return (WebView) field("web");
    }

    boolean fullScreen() {
        return field("customView") != null;
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

    String jsText(String code) {
        String v = js(code);
        try {
            Object o = new JSONTokener(v).nextValue();
            return o instanceof String ? (String) o : String.valueOf(o);
        } catch (Exception e) {
            return v;
        }
    }

    int jsInt(String code) {
        String v = js(code);
        try {
            return (int) Math.round(Double.parseDouble(v));
        } catch (Exception e) {
            return -1;
        }
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

    static String asset(String path) {
        try (InputStream in = InstrumentationRegistry.getInstrumentation().getContext().getAssets().open(path)) {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] buf = new byte[65536];
            for (int n; (n = in.read(buf)) > 0; ) b.write(buf, 0, n);
            return path.endsWith(".html") ? b.toString("UTF-8") : Base64.encodeToString(b.toByteArray(), Base64.NO_WRAP);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    /** The probe's feed, its player watching the media boxes as Instagram's does. */
    void loadFeed() {
        String html = asset("b28/feed.html").replace("%MODE%", "box");
        for (String id : new String[]{"A", "B", "C"}) {
            html = html.replace("%" + id + "%", "data:video/webm;base64," + asset("b28/" + id + ".webm"));
        }
        final String page = html;
        WebView w = web();
        inst.runOnMainSync(() -> w.loadDataWithBaseURL(BASE, page, "text/html", "utf-8", null));
        assertTrue("the feed page loads", waitFor(() -> "1".equals(js("window.b28ready||0")), 30000, "page ready"));
        assertTrue("the clips decode", waitFor(() -> "true".equals(js("['A','B','C'].every(function(i){return document.getElementById(i).readyState>=2})")),
                30000, "clips ready"));
        log("WebView " + jsText("navigator.userAgent.match(/Chrome\\/[\\d.]+/)[0]") + "  popover="
                + jsText("typeof HTMLElement.prototype.showPopover") + "  sg=" + jsText("typeof window.__sg")
                + "  route=" + jsText("window.__sg&&window.__sg.route?window.__sg.route():'?'")
                + "  vp=" + jsText("innerWidth+'x'+innerHeight"));
        assumeTrue("needs SimpleGram's page script in the page", "object".equals(jsText("typeof window.__sg")));
        // Page mode (the page full screen, the video lifted over it) needs popovers;
        // without them R10 uses the video's own full screen, which this doesn't cover.
        assumeTrue("needs the Popover API (WebView 114 or later) for page mode",
                "function".equals(jsText("typeof HTMLElement.prototype.showPopover")));
    }

    int[] webOnScreen() {
        int[] loc = new int[2];
        WebView w = web();
        inst.runOnMainSync(() -> w.getLocationOnScreen(loc));
        return loc;
    }

    float[] center(String sel) {
        try {
            String r = jsText("(function(){var b=document.querySelector('" + sel + "').getBoundingClientRect();"
                    + "return JSON.stringify({x:(b.left+b.width/2)*devicePixelRatio,y:(b.top+b.height/2)*devicePixelRatio})})()");
            JSONObject o = new JSONObject(r);
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

    /** Each video's state as "P"/">" (paused/playing) and "m"/"S" (muted/sound), with the player's choice. */
    String videoStates() {
        return jsText("['A','B','C'].map(function(i){var v=document.getElementById(i);return i+(v.paused?'P':'>')+(v.muted?'m':'S')}).join(' ')+' active='+__ig.active");
    }

    boolean videoIs(String id, boolean paused, boolean muted) {
        return (paused ? "true" : "false").equals(js("document.getElementById('" + id + "').paused"))
                && (muted ? "true" : "false").equals(js("document.getElementById('" + id + "').muted"));
    }

    /* ---------------- The test ---------------- */

    @Test
    public void fullScreenKeepsTheTappedVideoPlayingAndThePageStill() {
        name = "keepsPlaying";
        loadFeed();
        // B on the screen with A gone above it, as a scroll of Cam's leaves it;
        // the feed's sound is off (R10 brings the sound for the full screen).
        js("(function(){var b=document.querySelector('.box[data-id=B]').getBoundingClientRect();scrollTo(0,scrollY+b.top-120)})()");
        assertTrue("B plays once it is on screen", waitFor(() -> "B".equals(jsText("__ig.active")) && videoIs("B", false, true), 8000, "B playing"));
        SystemClock.sleep(800);
        int y0 = jsInt("Math.round(scrollY)");
        int playsA = jsInt("__ig.plays.A"), playsC = jsInt("__ig.plays.C");
        log("before the tap: scrollY " + y0 + "  " + videoStates());
        assertTrue("the page is scrolled past A (" + y0 + ")", y0 > 200);

        // The real tap on B: R10's full screen.
        float[] p = center(".box[data-id=B]");
        tapAt(p[0], p[1]);
        assertTrue("R10 opens the full screen (the app's custom view)", waitFor(this::fullScreen, 8000, "onShowCustomView"));
        assertTrue("B is lifted over the full-screen page", waitFor(() -> "B".equals(jsText("(document.querySelector('video:popover-open')||{}).id||''")), 5000, "B lifted"));
        // Sound comes with the landing's check (150 ms), the bars hide a moment later.
        assertTrue("B plays with sound in full screen", waitFor(() -> videoIs("B", false, false), 3000, "B with sound"));

        // Three seconds of full screen: the page where it was, B the only one
        // playing and the only one with sound, A and C paused and muted.
        int maxOff = 0;
        StringBuilder wrong = new StringBuilder();
        for (int i = 0; i < SAMPLES; i++) {
            int y = jsInt("Math.round(scrollY)");
            maxOff = Math.max(maxOff, Math.abs(y - y0));
            String st = videoStates();
            if (!st.startsWith("APm B>S CPm active=B")) wrong.append(i).append(": ").append(st).append("  y=").append(y).append('\n');
            if (i % 10 == 0) log("sample " + i + ": scrollY " + y + "  " + st + "  vp=" + jsText("innerWidth+'x'+innerHeight"));
            SystemClock.sleep(100);
        }
        log("largest move from " + y0 + ": " + maxOff + " px  SG: " + jsText("JSON.stringify((function(d){return {scrollHeld:d.scrollHeld,scrollHeldMax:d.scrollHeldMax,othersPaused:d.othersPaused,replays:d.replays,remuted:d.remuted,framesStalled:d.framesStalled}})(__sg.stats.diag.fullVideo))"));
        assertTrue("the page stays within 2 px of " + y0 + " under the full screen (moved " + maxOff + ")", maxOff <= 2);
        assertEquals("B the only video playing and the only one with sound, every sample:\n" + wrong, 0, wrong.length());
        assertEquals("A was never played", playsA, jsInt("__ig.plays.A"));
        assertEquals("C was never played", playsC, jsInt("__ig.plays.C"));
        assertEquals("Instagram's player kept B", "B", jsText("__ig.active"));
        assertEquals("the feed's sound setting was never touched", "false", js("__ig.sound"));
        assertEquals("Instagram's single tap never ran for the tap", 0, jsInt("__ig.singles"));

        // B31: a jump as the progress bar makes one; the picture follows (the clock runs on).
        js("(function(){var v=document.getElementById('B');v.currentTime=Math.min(v.duration-0.5,(v.currentTime+3)%v.duration)})()");
        double t1 = Double.parseDouble(js("document.getElementById('B').currentTime"));
        SystemClock.sleep(1200);
        double t2 = Double.parseDouble(js("document.getElementById('B').currentTime"));
        log("after the jump: " + t1 + " -> " + t2 + "  " + videoStates());
        assertTrue("B plays on after the jump", videoIs("B", false, false) && t2 != t1);

        // A tap in the middle of the full screen pauses B; nothing plays it again.
        float mx = act.getWindow().getDecorView().getWidth() / 2f, my = act.getWindow().getDecorView().getHeight() / 2f;
        tapAt(mx, my);
        assertTrue("a tap in full screen pauses B", waitFor(() -> "true".equals(js("document.getElementById('B').paused")), 3000, "B paused"));
        SystemClock.sleep(1200);
        log("after the pause: " + videoStates());
        assertTrue("the pause holds (your pause is never undone)", videoIs("B", true, false));
        assertTrue("nothing else started", videoIs("A", true, true) && videoIs("C", true, true));
        assertTrue("still full screen", fullScreen());

        // Back: the pause is kept, the page is back where it was, B muted as before the tap.
        inst.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);
        assertTrue("Back leaves the full screen", waitFor(() -> !fullScreen(), 8000, "onHideCustomView"));
        SystemClock.sleep(1500);
        int y1 = jsInt("Math.round(scrollY)");
        log("after Back: scrollY " + y1 + "  " + videoStates() + "  exits=" + jsText("JSON.stringify(__sg.stats.diag.fullVideo.exitsBy)")
                + "  kept=" + jsText("String(__sg.stats.diag.fullVideo.r10KeptPaused)"));
        assertTrue("the pause made in full screen is kept after Back", videoIs("B", true, true));
        assertTrue("the page is back where it was (" + y1 + " vs " + y0 + ")", Math.abs(y1 - y0) <= 2);
        assertEquals("nothing lifted is left", "0", js("document.querySelectorAll('[data-sg-full],:popover-open,#sg-fullbar').length"));
    }
}
