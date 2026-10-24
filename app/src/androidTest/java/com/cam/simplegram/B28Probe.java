package com.cam.simplegram;

import static org.junit.Assume.assumeTrue;

import android.app.Instrumentation;
import android.graphics.Bitmap;
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

import org.json.JSONObject;
import org.json.JSONTokener;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.lang.reflect.Field;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * B28 diagnosis probe (not a pass/fail test): a feed of three videos (A, B, C)
 * with an Instagram-like player that plays only the post most on screen, with
 * a feed-wide sound setting. Sound is turned on while A plays, B is scrolled
 * into view, and B is tapped through the real input path, so SimpleGram's R10
 * opens it full screen the way it does on the phone (on a WebView with the
 * Popover API: the page full screen and the video lifted over it). A timeline
 * of every video's state, the scroll position and the viewport is logged, with
 * screenshots, then taps in full screen and Back. Only local pages are loaded.
 *
 * Skipped in normal runs; run it with the instrumentation argument -e probe 1.
 */
@RunWith(AndroidJUnit4.class)
public class B28Probe {
    static final String TAG = "B28";
    static final String BASE = "https://www.instagram.com/";

    Instrumentation inst;
    ActivityScenario<MainActivity> scenario;
    MainActivity act;
    StringBuilder out = new StringBuilder();
    String name = "";
    File shots;

    @Before
    public void setUp() {
        assumeTrue("a diagnosis probe: run with -e probe 1", InstrumentationRegistry.getArguments().getString("probe") != null);
        inst = InstrumentationRegistry.getInstrumentation();
        scenario = ActivityScenario.launch(MainActivity.class);
        AtomicReference<MainActivity> a = new AtomicReference<>();
        scenario.onActivity(a::set);
        act = a.get();
        shots = new File(act.getExternalFilesDir(null), "b28");
        shots.mkdirs();
        SystemClock.sleep(1500);
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

    void loadFeed(String mode) {
        String html = asset("b28/feed.html").replace("%MODE%", mode);
        for (String id : new String[]{"A", "B", "C"}) {
            html = html.replace("%" + id + "%", "data:video/webm;base64," + asset("b28/" + id + ".webm"));
        }
        final String page = html;
        WebView w = web();
        inst.runOnMainSync(() -> w.loadDataWithBaseURL(BASE, page, "text/html", "utf-8", null));
        long end = SystemClock.uptimeMillis() + 30000;
        while (SystemClock.uptimeMillis() < end && !"1".equals(js("window.b28ready||0"))) SystemClock.sleep(100);
        end = SystemClock.uptimeMillis() + 30000;
        while (SystemClock.uptimeMillis() < end
                && !"true".equals(js("['A','B','C'].every(function(i){return document.getElementById(i).readyState>=2})"))) {
            SystemClock.sleep(200);
        }
        log("WebView " + jsText("navigator.userAgent.match(/Chrome\\/[\\d.]+/)[0]") + "  popover="
                + jsText("typeof HTMLElement.prototype.showPopover") + "  sg=" + jsText("typeof window.__sg")
                + "  route=" + jsText("window.__sg&&window.__sg.route?window.__sg.route():'?'")
                + "  dpr=" + jsText("devicePixelRatio") + "  vp=" + jsText("innerWidth+'x'+innerHeight"));
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

    void shot(String label) {
        Bitmap b = inst.getUiAutomation().takeScreenshot();
        if (b == null) {
            log("shot " + label + ": none");
            return;
        }
        File f = new File(shots, name + "-" + label + ".png");
        try (FileOutputStream o = new FileOutputStream(f)) {
            b.compress(Bitmap.CompressFormat.PNG, 100, o);
        } catch (Exception e) {
            log("shot " + label + ": " + e);
        }
    }

    /** The timeline since the last mark, with repeated lines left out. */
    void timeline(String label) {
        String t = jsText("(function(){var T=window.__t||[],m=window.__mark||0,o=[],last='';"
                + "for(var i=0;i<T.length;i++){var s=T[i];var t=+s.split(' ')[0];if(t<m)continue;"
                + "var k=s.replace(/^\\d+ /,'').replace(/(\\d+\\.)\\d/g,'$1');if(k===last)continue;last=k;o.push(s)}"
                + "window.__mark=performance.now();return o.join('\\n')})()");
        log("--- " + label + "  [ms scrollY viewport fullscreen B-lifted IG-active A B C box-tops; P/>=paused/playing m/S=muted/sound]");
        log(t);
        log("holds: " + jsText("String(window.__holds)"));
        log("IG: " + jsText("JSON.stringify({active:__ig.active,sound:__ig.sound,singles:__ig.singles,likes:__ig.likes,plays:__ig.plays,pauses:__ig.pauses,changes:__ig.changes.slice(-6)})"));
        log("bridge: " + jsText("(function(){var m=window.__msgs||[],k=window.__msgMark||0,o=m.slice(k);window.__msgMark=m.length;return JSON.stringify(o)})()"));
        log("SG: fs=" + (field("customView") != null) + " " + jsText("(function(){try{var d=__sg.stats.diag;return JSON.stringify({fullVideo:d.fullVideo})}catch(e){return 'n/a '+e}})()"));
    }

    // A fix candidate, tried from outside SimpleGram: while the page is full
    // screen, its scroll position is put back wherever the web view moves it.
    static final String HOLD = "(function(){var last=scrollY,y=null;window.__holds=0;"
            + "function fix(){if(y!=null&&document.fullscreenElement&&Math.abs(scrollY-y)>2){__holds++;scrollTo(0,y)}}"
            + "document.addEventListener('fullscreenchange',function(){y=document.fullscreenElement===document.documentElement?last:null;fix()},true);"
            + "addEventListener('scroll',function(){if(!document.fullscreenElement)last=scrollY;else fix()},true);"
            + "addEventListener('resize',function(){fix();requestAnimationFrame(fix)});return 'hold on'})()";

    void run(String mode) {
        run(mode, false);
    }

    void run(String mode, boolean hold) {
        loadFeed(mode);
        if (hold) log("hold: " + jsText(HOLD));
        // Sound on while A plays, as if Cam had turned it on in the feed.
        js("(function(){var b=document.querySelector('.box[data-id=A]').getBoundingClientRect();scrollTo(0,scrollY+b.top-120)})()");
        SystemClock.sleep(1500);
        js("__ig.setSound(true);if('" + mode + "'==='none'){document.getElementById('A').muted=false}");
        SystemClock.sleep(2000);
        js("window.__mark=0");
        timeline("A playing with sound");
        // B on screen (A gone above it).
        js("(function(){var b=document.querySelector('.box[data-id=B]').getBoundingClientRect();scrollTo(0,scrollY+b.top-120)})()");
        SystemClock.sleep(2000);
        if ("none".equals(mode)) js("document.getElementById('A').muted=true;document.getElementById('B').muted=false");
        timeline("B on screen");
        // Every message the page sends the app (fullVideoStart, fullVideoExitRequest and its why).
        log("bridge wrap: " + jsText("(function(){try{var o=window.SGNative;window.__msgs=[];window.SGNative={postMessage:function(m){"
                + "try{var j=JSON.parse(m);if(!/^(status|scrollOk|bars)$/.test(j.action))__msgs.push(Math.round(performance.now())+' '+m.slice(0,140))}catch(e){}"
                + "return o.postMessage(m)}};return window.SGNative!==o?'ok':'not replaced'}catch(e){return 'failed '+e}})()"));
        shot("0-feed");
        float[] p = center(".box[data-id=B]");
        log("tap B at " + p[0] + "," + p[1]);
        tapAt(p[0], p[1]);
        SystemClock.sleep(1500);
        shot("1-full");
        SystemClock.sleep(1200);
        shot("2-full-later");
        timeline("after the tap on B (R10)");
        // B31: a jump, as the progress bar makes one (the picture should follow).
        js("(function(){var v=document.getElementById('B');v.currentTime=Math.min(v.duration-0.5,(v.currentTime+3)%v.duration)})()");
        SystemClock.sleep(900);
        shot("2b-after-seek");
        SystemClock.sleep(1200);
        shot("2c-after-seek-later");
        timeline("after a jump of 3 s on B");
        // A tap in the middle of the full screen.
        int[] loc = webOnScreen();
        float mx = act.getWindow().getDecorView().getWidth() / 2f, my = act.getWindow().getDecorView().getHeight() / 2f;
        log("tap middle at " + mx + "," + my + " (web at " + loc[0] + "," + loc[1] + ")");
        tapAt(mx, my);
        SystemClock.sleep(1600);
        shot("3-after-tap1");
        timeline("after tap 1 in the middle");
        tapAt(mx, my);
        SystemClock.sleep(1600);
        shot("4-after-tap2");
        timeline("after tap 2 in the middle");
        tapAt(mx, my);
        SystemClock.sleep(1600);
        shot("5-after-tap3");
        timeline("after tap 3 in the middle");
        if (field("customView") != null) {
            inst.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);
            SystemClock.sleep(1600);
            shot("6-after-back");
            timeline("after Back");
        }
    }

    @Test
    public void box() {
        name = "box";
        run("box");
    }

    @Test
    public void boxHold() {
        name = "boxHold";
        run("box", true);
    }

    @Test
    public void video() {
        name = "video";
        run("video");
    }

    @Test
    public void none() {
        name = "none";
        run("none");
    }
}
