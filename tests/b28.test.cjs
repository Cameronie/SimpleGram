// Browser tests for B28/B31 (the full-screen video stays the one playing) and
// B27's page side (the dead zone around the ⋮ tab).
//
// The fixture is a three-post feed (A, B, C) with an Instagram-like player
// modelled on Instagram's public bundles (notes/batch-6/b28-diagnosis.md) and
// on the emulator probe's page (app/src/androidTest/assets/b28/feed.html): each
// player watches its own media box with an IntersectionObserver, not the
// <video> (VideoPlayerOnViewability); one video plays at a time, the box most
// on screen (at least half; the higher one on a tie); a playing video under a
// quarter on screen is paused (PauseOnInvisible(.25)); sound is one setting
// for the whole feed; and an effect on every paused change re-applies that
// setting to the active video and pauses any other that plays. Its tap layer
// counts touches like PolarisDoubleTappable: a single tap toggles the feed's
// sound 300 ms after its click, a double tap likes. The Android web view's
// scroll reset is simulated in the full-screen stub: scrollTo(0, 0) 16 ms
// after fullscreenchange on entry, the old position put back 30 ms after exit.
// Touches are real ones (Chrome DevTools input). Nothing reaches Instagram.
//
// Run: NODE_PATH=/opt/node-tools/node_modules node --test tests/*.test.cjs
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { SCRIPT, ME, sent, PNG } = require('./helpers.cjs');
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
// A one-second 64x112 clip with sound, served for every video address.
const CLIP = fs.readFileSync(path.join(__dirname, 'reel.webm'));

let browser;
before(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { await browser.close(); });

const HOME = 'https://www.instagram.com/';
const POST_URL = 'https://www.instagram.com/p/ABCDEFG/';

async function openPage(url, html) {
  const context = await browser.newContext({
    viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true,
  });
  const page = await context.newPage();
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.pathname === new URL(url).pathname) return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    if (/\.(mp4|webm)$/.test(u.pathname)) return route.fulfill({ status: 200, contentType: 'video/webm', body: CLIP });
    if (/\.(jpg|png)/.test(u.pathname)) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    return route.fulfill({ status: 404, contentType: 'text/plain', body: '' });
  });
  await page.addInitScript(() => {
    window.__sent = [];
    window.SGNative = { postMessage: m => window.__sent.push(JSON.parse(m)) };
  });
  await page.addInitScript(`window.__sgCfg=${JSON.stringify({ role: 'main', version: 'test', searchPages: 3, viewerId: ME })};\n${SCRIPT}`);
  await page.goto(url);
  return page;
}

// A finger, step by step (a session lives as long as the page: a touch belongs to one).
async function drag(page, from, to, { steps = 8, settle = 60 } = {}) {
  const c = await page.context().newCDPSession(page);
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from[0], y: from[1] }] });
  for (let i = 1; i <= steps; i++) {
    await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{
      x: from[0] + (to[0] - from[0]) * i / steps, y: from[1] + (to[1] - from[1]) * i / steps }] });
  }
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await c.detach();
  await page.waitForTimeout(settle);
}
async function tapAt(page, x, y, settle = 0) {
  const c = await page.context().newCDPSession(page);
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await c.detach();
  if (settle) await page.waitForTimeout(settle);
}

/* ---------------- The feed and its player ---------------- */

function post(id) {
  return `<article id="a-${id}" data-id="${id}">
    <header style="height:56px"><a href="/friend_${id}/">friend_${id}</a></header>
    <div class="box" data-id="${id}" style="position:relative;width:412px;height:515px;background:#000;overflow:hidden">
      <div style="position:absolute;inset:0"><video id="${id}" src="/clip-${id}.webm" muted playsinline loop preload="auto"
        style="width:100%;height:100%;display:block"></video></div>
      <div class="tap" role="presentation" style="position:absolute;inset:0"></div>
      <button class="sound" aria-label="Toggle audio" style="position:absolute;right:12px;bottom:12px;width:28px;height:28px;padding:0">
        <svg aria-label="Audio is muted" width="16" height="16"></svg></button>
    </div>
    <section style="height:44px"></section>
  </article>`;
}
const IG_MOCK = `<script>
(function () {
  const IG = window.__ig = { sound: false, active: null, ratios: {}, singles: 0, likes: 0, clicks: 0, plays: {}, pauses: {}, mutes: {}, changes: [] };
  const ids = ['A', 'B', 'C'];
  const vid = id => document.getElementById(id);
  const box = id => document.querySelector('.box[data-id="' + id + '"]');
  const icons = () => { for (const id of ids) box(id).querySelector('.sound svg').setAttribute('aria-label', IG.sound ? 'Audio is playing' : 'Audio is muted'); };
  // The product-initiated effect, on every paused change: the active video
  // gets the feed's sound setting; another video that plays is paused.
  function effect(id) {
    const v = vid(id);
    if (id === IG.active) { if (v.muted === IG.sound) { v.muted = !IG.sound; IG.mutes[id]++; } }
    else if (!v.paused) v.pause();
  }
  for (const id of ids) {
    IG.plays[id] = 0; IG.pauses[id] = 0; IG.mutes[id] = 0;
    vid(id).addEventListener('play', () => { IG.plays[id]++; effect(id); });
    vid(id).addEventListener('pause', () => { IG.pauses[id]++; effect(id); });
  }
  // The post most on screen plays: at least half, nearest the middle, the higher one on a tie.
  function choose(why) {
    let best = null, score = Infinity;
    for (const id of ids) {
      if ((IG.ratios[id] || 0) < 0.5) continue;
      const r = box(id).getBoundingClientRect();
      const d = Math.abs((r.top + r.bottom) / 2 - innerHeight / 2);
      if (d < score - 0.5) { best = id; score = d; }
    }
    if (best === IG.active) return;
    IG.changes.push({ t: Math.round(performance.now()), why: why, from: IG.active, to: best, y: Math.round(scrollY) });
    IG.active = best;
    for (const id of ids) if (id !== best && !vid(id).paused) vid(id).pause();
    if (best) { const v = vid(best); v.muted = !IG.sound; const p = v.play(); if (p && p.catch) p.catch(() => {}); }
  }
  const io = new IntersectionObserver(es => {
    for (const e of es) IG.ratios[e.target.dataset.id] = e.intersectionRatio;
    // PauseOnInvisible(.25): a playing video whose post has left the screen is paused.
    for (const id of ids) {
      if ((IG.ratios[id] || 0) < 0.25 && !vid(id).paused) { vid(id).pause(); if (IG.active === id) IG.active = null; }
    }
    choose('io');
  }, { threshold: [0, 0.25, 0.5, 0.75, 1] });
  for (const id of ids) io.observe(box(id));
  IG.setSound = on => { IG.sound = on; if (IG.active) vid(IG.active).muted = !on; icons(); };
  // The tap layer, its handlers on the app's root like React's (PolarisDoubleTappable).
  const root = document.getElementById('mount');
  let n = 0, first = null, cur = null, lastStart = 0, dbl = false, timer = null;
  const near = (a, b) => Math.max((a.pageX - b.pageX) ** 2 + (a.pageY - b.pageY) ** 2, (a.screenX - b.screenX) ** 2 + (a.screenY - b.screenY) ** 2) <= 1600;
  const layer = t => t.closest && t.closest('.tap');
  root.addEventListener('touchstart', e => {
    if (!layer(e.target)) return;
    dbl = false;
    if (Date.now() - lastStart > 300) n = 0;
    if (e.touches.length === 1) { cur = e.touches[0]; lastStart = Date.now(); if (n === 0) first = cur; }
  });
  root.addEventListener('touchmove', e => {
    if (!layer(e.target) || e.touches.length !== 1 || !cur) return;
    if (!near(cur, e.touches[0])) { n = 0; cur = null; first = null; }
  });
  root.addEventListener('touchend', e => {
    if (!layer(e.target) || e.touches.length !== 0 || !cur || !first) return;
    const ok = near(cur, first);
    n++;
    if (n === 2) { n = 0; if (ok) dbl = true; }
    cur = null;
  });
  root.addEventListener('click', e => {
    if (e.target.closest('.sound')) { IG.setSound(!IG.sound); return; }
    if (!layer(e.target)) return;
    IG.clicks++;
    if (timer) { clearTimeout(timer); timer = null; } else {
      timer = setTimeout(() => { timer = null; IG.singles++; IG.setSound(!IG.sound); }, 300);
    }
    if (dbl) { dbl = false; IG.likes++; }
  });
  window.b28ready = 1;
})();
</script>`;
const FEED = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head>
  <body style="margin:0"><div id="mount"><main>${post('A')}${post('B')}${post('C')}<div style="height:3000px">more posts</div></main></div>${IG_MOCK}</body></html>`;
// Where B's box is centred on the screen (A's post is 615 px tall, B's header 56).
const B_Y = 615 + 56 + 515 / 2 - 915 / 2;

// Full screen as the app's web view does it (as in tests/r10.test.cjs), with
// its scroll reset: a fresh full-screen view whose scroll is 0, synced to the
// page on its first draw, and the old position put back on exit. A page's
// request to leave is done the Back way by the app.
async function stubWebView(page) {
  await page.evaluate(() => {
    window.__fs = []; window.__fsEl = null; window.__appExits = 0; window.__resets = 0; window.__restores = 0; window.__fsExit = 0;
    let saved = 0;
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => window.__fsEl });
    HTMLElement.prototype.requestFullscreen = function () {
      window.__fs.push(this === document.documentElement ? 'page:' + ((document.querySelector('video[data-sg-full]') || {}).id || '?') : this.id || this.tagName);
      window.__fsEl = this;
      saved = scrollY;
      document.dispatchEvent(new Event('fullscreenchange'));
      setTimeout(() => { if (window.__fsEl) { window.__resets++; window.scrollTo(0, 0); } }, 16);
      return Promise.resolve();
    };
    const leave = () => {
      window.__fsEl = null;
      document.dispatchEvent(new Event('fullscreenchange'));
      setTimeout(() => { window.__restores++; window.scrollTo(0, saved); }, 30);
    };
    window.__appBack = leave;
    document.exitFullscreen = function () { window.__fsExit++; leave(); return Promise.resolve(); };
    const bridge = window.SGNative;
    window.SGNative = { postMessage: m => {
      bridge.postMessage(m);
      if (JSON.parse(m).action !== 'fullVideoExitRequest' || !window.__fsEl) return;
      window.__appExits++;
      leave();
    } };
  });
}
const appBack = page => page.evaluate(() => window.__appBack());
const fv = page => page.evaluate(() => JSON.parse(JSON.stringify(window.__sg.stats.diag.fullVideo)));
const ig = page => page.evaluate(() => JSON.parse(JSON.stringify(window.__ig)));
const lifted = page => page.evaluate(() => (document.querySelector('video:popover-open') || {}).id || null);
// Each video's state: paused, muted.
const videos = page => page.evaluate(() => {
  const st = id => { const v = document.getElementById(id); return [v.paused, v.muted]; };
  return { A: st('A'), B: st('B'), C: st('C'), y: Math.round(scrollY), active: window.__ig.active };
});
// Home with A playing at the top, then (`sound`) the feed's sound turned on,
// then B scrolled to the middle of the screen: B plays, A and C are paused.
async function openFeed({ sound = false, url = HOME } = {}) {
  const page = await openPage(url, FEED);
  await stubWebView(page);
  await page.waitForFunction(() => { const v = document.getElementById('A'); return window.__ig.active === 'A' && !v.paused && v.readyState >= 2; }, null, { timeout: 5000 });
  if (sound) await page.evaluate(() => window.__ig.setSound(true));
  await page.evaluate(y => window.scrollTo(0, y), B_Y);
  await page.waitForFunction(() => { const b = document.getElementById('B'); return window.__ig.active === 'B' && !b.paused && document.getElementById('A').paused; }, null, { timeout: 5000 });
  await page.waitForTimeout(200);
  return page;
}
// Taps B (R10) and waits for the full screen with B lifted over the page.
async function openFull(page) {
  await tapAt(page, 200, 457);
  await page.waitForFunction(() => window.__fsEl === document.documentElement && document.querySelector('video:popover-open'), null, { timeout: 3000 });
}
// A dozen samples 100 ms apart of the page and the videos while full screen is up.
const watch = (page, n = 12) => page.evaluate(count => new Promise(done => {
  const out = [];
  const t = setInterval(() => {
    const st = id => { const v = document.getElementById(id); return [v.paused, v.muted]; };
    out.push({ y: Math.round(scrollY), A: st('A'), B: st('B'), C: st('C'), active: window.__ig.active, fs: !!window.__fsEl });
    if (out.length >= count) { clearInterval(t); done(out); }
  }, 100);
}), n);

/* ---------------- B28: the full-screen video stays the one playing ---------------- */

test('B28: the web view\'s scroll to the top is put back at once: the page stays within 2 px, the tapped video is the only one playing and the only one with sound', async () => {
  const page = await openFeed();
  const before = await ig(page);
  assert.deepEqual(await videos(page), { A: [true, true], B: [false, true], C: [true, true], y: B_Y, active: 'B' });
  await openFull(page);
  assert.equal(await lifted(page), 'B');
  await page.waitForFunction(() => !document.getElementById('B').muted, null, { timeout: 2000 });
  const samples = await watch(page);
  assert.equal(await page.evaluate(() => window.__resets), 1, 'the web view did move the page');
  for (const s of samples) {
    assert.ok(Math.abs(s.y - B_Y) <= 2, 'held at ' + B_Y + ': ' + JSON.stringify(s));
    assert.deepEqual([s.A, s.B, s.C, s.active, s.fs], [[true, true], [false, false], [true, true], 'B', true], JSON.stringify(s));
  }
  const after = await ig(page);
  assert.deepEqual([after.plays.A - before.plays.A, after.plays.C - before.plays.C, after.pauses.B - before.pauses.B], [0, 0, 0], 'no play of the others, no pause of B');
  assert.deepEqual(after.changes.slice(before.changes.length), [], 'Instagram\'s player kept B');
  assert.deepEqual([after.sound, after.singles], [false, 0], 'the feed\'s sound setting untouched; its single tap never ran');
  const f = await fv(page);
  assert.ok(f.scrollHeld >= 1 && f.scrollHeldMax >= B_Y - 2, JSON.stringify(f));
  assert.deepEqual([f.othersPaused, f.replays, f.framesStalled], [0, 0, 0], JSON.stringify(f));
  // Back: the hold is off before the exit, so the web view's own restore finds the page where it left it.
  await appBack(page);
  await page.waitForTimeout(400);
  assert.deepEqual(await videos(page), { A: [true, true], B: [false, true], C: [true, true], y: B_Y, active: 'B' }, 'as before the tap, muted again');
  assert.equal(await page.evaluate(() => window.__restores), 1);
  assert.equal((await fv(page)).scrollHeld, f.scrollHeld, 'nothing held after the exit');
});

test('B28: with the feed\'s sound on (Cam\'s case), the same: nothing else plays under the full screen, and the video plays on with sound after', async () => {
  const page = await openFeed({ sound: true });
  const before = await ig(page);
  assert.deepEqual((await videos(page)).B, [false, false]);
  await openFull(page);
  const samples = await watch(page, 8);
  for (const s of samples) {
    assert.ok(Math.abs(s.y - B_Y) <= 2, JSON.stringify(s));
    assert.deepEqual([s.A[0], s.B, s.C[0], s.active], [true, [false, false], true, 'B'], JSON.stringify(s));
  }
  const after = await ig(page);
  assert.deepEqual([after.plays.A - before.plays.A, after.plays.C - before.plays.C, after.sound], [0, 0, true]);
  await appBack(page);
  await page.waitForTimeout(400);
  assert.deepEqual(await videos(page), { A: [true, false], B: [false, false], C: [true, true], y: B_Y, active: 'B' }, 'B plays on with sound, where it was');
});

test('B28: a pause made in full screen is kept after Back; Instagram\'s re-mute of the paused video is undone while full screen is up', async () => {
  const page = await openFeed();
  await openFull(page);
  await page.waitForFunction(() => !document.getElementById('B').muted, null, { timeout: 2000 });
  await tapAt(page, 200, 500, 300);                     // a tap in full screen pauses
  let st = await videos(page);
  assert.deepEqual([st.B, st.active], [[true, false], 'B'], 'paused, its sound still on: ' + JSON.stringify(st));
  assert.ok((await ig(page)).mutes.B >= 1, 'Instagram\'s effect did mute it on the pause');
  await page.waitForTimeout(600);
  st = await videos(page);
  assert.deepEqual(st.B, [true, false], 'not played again (your pause), still with sound');
  const f = await fv(page);
  assert.deepEqual([f.replays, f.remuted >= 1], [0, true], JSON.stringify(f));
  await appBack(page);
  await page.waitForTimeout(500);
  st = await videos(page);
  assert.deepEqual([st.B, st.A, st.C, st.y], [[true, true], [true, true], [true, true], B_Y], 'still paused, muted as before: ' + JSON.stringify(st));
  assert.deepEqual([(await fv(page)).r10KeptPaused, (await fv(page)).r10Restored], [1, 1]);
  // The next full screen opens it playing (R10). Back pauses it again: that play
  // was R10's, not yours, and Instagram's player still shows the post paused.
  await openFull(page);
  await page.waitForFunction(() => !document.getElementById('B').paused && !document.getElementById('B').muted, null, { timeout: 2000 });
  await appBack(page);
  await page.waitForTimeout(500);
  assert.deepEqual((await videos(page)).B, [true, true], 'paused again, as before that tap');
  assert.deepEqual([(await fv(page)).r10KeptPaused, (await fv(page)).r10Restored], [1, 2]);
  // A tap that plays it in full screen is yours: it plays on after Back.
  await openFull(page);
  await page.waitForFunction(() => !document.getElementById('B').paused && !document.getElementById('B').muted, null, { timeout: 2000 });
  await tapAt(page, 200, 500, 300);                     // pause
  await tapAt(page, 200, 500, 300);                     // play: yours
  assert.deepEqual((await videos(page)).B, [false, false]);
  await appBack(page);
  await page.waitForTimeout(500);
  assert.deepEqual((await videos(page)).B, [false, true], 'your play is kept');
  assert.equal((await fv(page)).r10KeptPaused, 1);
});

test('B28: your own pause and play taps cost no sound budget (Instagram re-mutes on each): after five of each the sound is still on; a fight with Instagram still ends at 8', async () => {
  const page = await openFeed();
  await openFull(page);
  await page.waitForFunction(() => !document.getElementById('B').muted, null, { timeout: 2000 });
  for (let i = 0; i < 5; i++) {
    await tapAt(page, 200, 500, 250);
    let st = await videos(page);
    assert.deepEqual(st.B, [true, false], 'pause ' + i + ': ' + JSON.stringify(st));
    await tapAt(page, 200, 500, 250);
    st = await videos(page);
    assert.deepEqual(st.B, [false, false], 'play ' + i + ': ' + JSON.stringify(st));
  }
  let f = await fv(page);
  assert.ok(f.remuted >= 10 && (await ig(page)).mutes.B >= 10, 'Instagram did re-mute each time: ' + JSON.stringify(f));
  // Instagram muting it by itself (no play or pause of SimpleGram's behind it): set back 8 times, then left.
  await page.waitForTimeout(600);
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => { document.getElementById('B').muted = true; });
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => document.getElementById('B').muted), true, 'left muted after 8');
  assert.equal((await fv(page)).remuted - f.remuted, 8);
  // The next full screen has its own budget.
  await appBack(page);
  await page.waitForTimeout(500);
  await openFull(page);
  await page.waitForFunction(() => !document.getElementById('B').muted, null, { timeout: 2000 });
});

test('B28: the web view\'s pause while the app is in the background is no fight: no replay is spent; back in the foreground the video plays on, unless you had paused it', async () => {
  const page = await openFeed();
  await openFull(page);
  await page.waitForFunction(() => !document.getElementById('B').muted, null, { timeout: 2000 });
  // The page hidden (and, as the web view does to a backgrounded video, the video paused), then shown again.
  const hide = on => page.evaluate(h => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => h ? 'hidden' : 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    if (h) document.getElementById('B').pause();
  }, on);
  await hide(true);
  await page.waitForTimeout(300);
  let st = await videos(page);
  assert.deepEqual([st.B[0], (await fv(page)).replays], [true, 0], 'left paused: ' + JSON.stringify(st));
  await hide(false);
  await page.waitForFunction(() => !document.getElementById('B').paused, null, { timeout: 1000 });
  await page.waitForTimeout(200);
  st = await videos(page);
  assert.deepEqual([st.B, st.active, (await fv(page)).replays], [[false, false], 'B', 0], 'plays on with sound, no replay spent: ' + JSON.stringify(st));
  // Paused by your tap before the app went to the background: still paused on return.
  await tapAt(page, 200, 500, 300);
  assert.equal((await videos(page)).B[0], true);
  await hide(true);
  await page.waitForTimeout(200);
  await hide(false);
  await page.waitForTimeout(300);
  assert.deepEqual((await videos(page)).B, [true, false]);
  await appBack(page);
  await page.waitForTimeout(500);
  assert.deepEqual([(await videos(page)).B, (await fv(page)).r10KeptPaused], [[true, true], 1]);
});

test('B28: a reset the hold puts back is no Home jump: Home\'s log says held (where the page stood), never jump', async () => {
  const page = await openFeed();
  // C in the middle of the screen: the page more than a screen down (noteJump's threshold).
  const C_Y = B_Y + 615;
  await page.evaluate(y => window.scrollTo(0, y), C_Y);
  await page.waitForFunction(() => window.__ig.active === 'C' && !document.getElementById('C').paused, null, { timeout: 5000 });
  await page.waitForTimeout(400);
  await openFull(page);
  await page.waitForTimeout(300);
  assert.deepEqual([await page.evaluate(() => window.__resets), await lifted(page), (await videos(page)).y], [1, 'C', C_Y]);
  await page.evaluate(() => window.__sg.onNative({ type: 'status' }));
  const m = (await sent(page, 'status')).pop();
  const events = m.stats.homeEvents || [];
  assert.deepEqual(events.filter(e => e.e === 'jump'), [], JSON.stringify(events));
  assert.deepEqual(events.filter(e => e.e === 'held').map(e => e.from), [1.2], JSON.stringify(events));
  assert.equal((await fv(page)).scrollHeld, 1);
});

test('B28: another video Instagram starts under the full screen is paused; the full-screen video paused by Instagram is played again, 6 times at most', async () => {
  const page = await openFeed();
  await openFull(page);
  await page.waitForFunction(() => !document.getElementById('B').muted, null, { timeout: 2000 });
  // Instagram starts A (as its player would for the post at the top).
  await page.evaluate(() => document.getElementById('A').play().catch(() => {}));
  await page.waitForTimeout(150);
  let st = await videos(page);
  assert.deepEqual([st.A[0], st.B[0]], [true, false], JSON.stringify(st));
  assert.equal((await fv(page)).othersPaused, 1);
  // Instagram pauses B (as its player does for a post it thinks is off screen): played again, each time.
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => document.getElementById('B').pause());
    await page.waitForFunction(() => !document.getElementById('B').paused, null, { timeout: 1000 });
  }
  let f = await fv(page);
  assert.deepEqual([f.replays, f.replaysGaveUp], [3, 0], JSON.stringify(f));
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => document.getElementById('B').pause());
    await page.waitForTimeout(80);
  }
  f = await fv(page);
  assert.deepEqual([f.replays, f.replaysGaveUp, (await videos(page)).B[0]], [6, 1, true], 'gave up after 6: ' + JSON.stringify(f));
  // The next full screen has its own budget.
  await appBack(page);
  await page.waitForTimeout(400);
  await page.waitForFunction(() => !document.getElementById('B').paused, null, { timeout: 2000 });
  await openFull(page);
  await page.waitForFunction(() => !document.getElementById('B').muted, null, { timeout: 2000 });
  await page.evaluate(() => document.getElementById('B').pause());
  await page.waitForFunction(() => !document.getElementById('B').paused, null, { timeout: 1000 });
  assert.equal((await fv(page)).replays, 7);
});

test('B28: R10 takes the tap: Instagram\'s single tap never runs for a tap that opened full screen; a double tap still likes (click, click) and opens nothing', async () => {
  const page = await openFeed();
  await tapAt(page, 200, 457);
  await page.waitForTimeout(700);
  let s = await ig(page);
  assert.deepEqual([s.clicks, s.singles, s.likes, s.sound, !!(await page.evaluate(() => window.__fsEl))], [0, 0, 0, false, true]);
  assert.equal(await page.evaluate(() => document.querySelector('.box[data-id="B"] .sound svg').getAttribute('aria-label')), 'Audio is muted');
  await appBack(page);
  await page.waitForTimeout(500);
  // A double tap: Instagram sees click, click (the first given back just before the second), its timer never fires, it likes.
  await tapAt(page, 200, 457);
  await page.waitForTimeout(110);
  await tapAt(page, 204, 461);
  await page.waitForTimeout(700);
  s = await ig(page);
  assert.deepEqual([s.clicks, s.singles, s.likes, s.sound], [2, 0, 1, false], 'liked; the feed\'s sound untouched');
  assert.equal(await page.evaluate(() => window.__fs.length), 1, 'no second full screen');
  const f = await fv(page);
  assert.deepEqual([f.r10, f.r10Doubles], [1, 1]);
  // Taps elsewhere are Instagram's as ever: the sound icon still toggles the feed's sound.
  const b = await page.evaluate(() => { const r = document.querySelector('.box[data-id="B"] .sound').getBoundingClientRect(); return [r.left + 14, r.top + 14]; });
  await tapAt(page, b[0], b[1], 300);
  assert.equal((await ig(page)).sound, true);
});

test('B28: a lifted video that stops showing ends full screen, saying why: unlifted (dropped out of the top layer), hidden, gone', async () => {
  const cases = [
    ['unlifted', () => document.getElementById('B').hidePopover()],
    ['hidden', () => { document.getElementById('B').style.display = 'none'; }],
    ['gone', () => document.getElementById('a-B').remove()],
  ];
  for (const [why, act] of cases) {
    const page = await openFeed();
    await openFull(page);
    await page.evaluate(act);
    await page.waitForFunction(() => !window.__fsEl, null, { timeout: 3000 });
    assert.deepEqual((await sent(page, 'fullVideoExitRequest')).map(m => m.why), [why], why);
    assert.equal(await page.evaluate(() => document.querySelectorAll('#sg-fullbar,[data-sg-bar],:popover-open').length), 0, why);
    const f = await fv(page);
    assert.deepEqual(f.exitsBy, { [why]: 1 }, why);
    await page.context().close();
  }
});

test('B28: diagnostics: the full-screen log carries the scroll, the viewport, the time and what played (shapes only); why each full screen ended', async () => {
  const page = await openFeed();
  await openFull(page);
  await page.waitForTimeout(300);
  await drag(page, [200, 700], [200, 250]);              // a swipe leaves
  await page.waitForFunction(() => !window.__fsEl, null, { timeout: 3000 });
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__sg.onNative({ type: 'status' }));
  const m = (await sent(page, 'status')).pop();
  const log = m.stats.b25.fsPage;
  assert.equal(log.length, 2);
  const [on, off] = log;
  assert.deepEqual(Object.keys(on).sort(), ['msSinceTouchEnd', 'on', 'playing', 'route', 't', 'tag', 'touchActive', 'vh', 'via', 'y']);
  assert.deepEqual([on.on, on.tag, on.via, on.y, on.vh, on.playing], [true, 'html', 'r8', B_Y, 915, { n: 1, full: true, otherSound: false }]);
  assert.deepEqual([off.on, off.y, typeof off.t, off.t > 0, off.playing], [false, B_Y, 'number', true, { n: 1, full: true, otherSound: false }], 'at the exit the video still plays on, with its sound (put back a moment later)');
  assert.deepEqual(m.stats.diag.fullVideo.exitsBy, { swipe: 1 });
  assert.doesNotMatch(JSON.stringify(m.stats), /friend_|clip-|instagram\.com/);
});

test('B28: diagnostics: a video whose clock runs while no new frame comes counts as stalled, a quarter second at a time', async () => {
  const page = await openFeed();
  // The frames never come (the callback is never answered), though the clip plays on.
  await page.evaluate(() => { document.getElementById('B').requestVideoFrameCallback = () => 1; });
  await openFull(page);
  await page.waitForTimeout(1100);
  const f = await fv(page);
  assert.ok(f.framesStalled >= 2 && f.framesStalled <= 5, JSON.stringify(f));
  assert.equal(await page.evaluate(() => document.getElementById('B').paused), false);
  // Back: the check ends with the full screen.
  await appBack(page);
  await page.waitForTimeout(600);
  assert.equal((await fv(page)).framesStalled, f.framesStalled);
});

/* ---------------- B27: the dead zone around the ⋮ tab ---------------- */

const tabAt = (page, cmd) => page.evaluate(c => window.__sg.onNative(Object.assign({ type: 'menuTab' }, c)), cmd);

test('B27: a tap beside the ⋮ tab (the app says where it is) opens no full screen: it is Instagram\'s; off the zone, or with the tab hidden, the tap opens it', async () => {
  const page = await openFeed();
  // The tab on the right, from 40% to 46% of the screen's height: the zone is x >= 340
  // (the 16 px tab and 56 px past its inner edge), y 342 to 445 (24 px either way).
  await tabAt(page, { on: true, side: 'right', yFrac: 0.4, hFrac: 0.06 });
  await tapAt(page, 380, 400, 700);
  let s = await ig(page);
  assert.deepEqual([await page.evaluate(() => window.__fs), s.singles, s.sound, (await fv(page)).r10DeadZone], [[], 1, true, 1], 'refused; Instagram\'s own tap ran');
  await tapAt(page, 345, 440, 700);                      // still within: 67 px from the edge, in the 24 px below
  assert.deepEqual([await page.evaluate(() => window.__fs.length), (await fv(page)).r10DeadZone], [0, 2]);
  await tapAt(page, 330, 400, 700);                      // 82 px in: off the zone
  assert.deepEqual(await page.evaluate(() => window.__fs), ['page:B']);
  await appBack(page);
  await page.waitForTimeout(500);
  await tapAt(page, 380, 480, 700);                      // below the zone
  assert.equal(await page.evaluate(() => window.__fs.length), 2);
  await appBack(page);
  await page.waitForTimeout(500);
  // The tab moved to the left: the zone follows it (x <= 72); the right side is free again.
  await tabAt(page, { on: true, side: 'left', yFrac: 0.4, hFrac: 0.06 });
  await tapAt(page, 60, 400, 700);
  assert.deepEqual([await page.evaluate(() => window.__fs.length), (await fv(page)).r10DeadZone], [2, 3]);
  await tapAt(page, 380, 400, 700);
  assert.equal(await page.evaluate(() => window.__fs.length), 3);
  await appBack(page);
  await page.waitForTimeout(500);
  // Hidden (on: false): no zone.
  await tabAt(page, { on: false });
  await tapAt(page, 30, 400, 700);
  assert.deepEqual([await page.evaluate(() => window.__fs.length), (await fv(page)).r10DeadZone], [4, 3]);
});

test('B27: R8\'s swipe down from beside the tab arms nothing; from the video elsewhere it still opens full screen; nonsense fractions clear the zone', async () => {
  const page = await openPage(POST_URL, FEED);
  await stubWebView(page);
  await page.waitForFunction(() => window.__ig.active === 'A' && !document.getElementById('A').paused, null, { timeout: 5000 });
  await tabAt(page, { on: true, side: 'right', yFrac: 0.1, hFrac: 0.1 });    // zone: x >= 340, y 67.5 to 207
  await drag(page, [380, 120], [380, 360]);
  await page.waitForTimeout(200);
  assert.deepEqual([await page.evaluate(() => window.__fs), (await fv(page)).r10DeadZone], [[], 1]);
  await drag(page, [200, 120], [200, 360]);
  await page.waitForTimeout(200);
  assert.deepEqual(await page.evaluate(() => window.__fs), ['page:A']);
  await appBack(page);
  await page.waitForTimeout(500);
  await tabAt(page, { on: true, side: 'right', yFrac: 'x', hFrac: 0.1 });
  await drag(page, [380, 120], [380, 360]);
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.__fs.length), 2, 'no zone from a broken message');
});
