// Browser tests for R10 (one tap opens a video full screen), R11 (the progress
// bar) and B21 (a video post's cover framed like its video).
//
// Touches are real ones from the browser (Chrome DevTools input), so they are
// trusted, hit-tested, give user activation and scroll the page like a finger
// would. Full screen is stubbed as in video.test.cjs (headless Chromium has no
// app around it); popovers and the top layer are the browser's own. Instagram's
// tap handling is modelled on its own code (PolarisDoubleTappable and
// polarisOnlyHandleSingleClick in its web bundles): a double tap is counted
// from touches, the like runs in the second tap's click, and the single-tap
// action runs 300 ms after a click no second click followed. Nothing reaches
// Instagram: every request is answered locally.
//
// Run: NODE_PATH=/opt/node-tools/node_modules node --test tests/*.test.cjs
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { SCRIPT, ME, sent, user, media, PNG } = require('./helpers.cjs');
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

async function openPage(url, html, { api = {}, init = null } = {}) {
  const context = await browser.newContext({
    viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true,
  });
  const page = await context.newPage();
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    for (const key of Object.keys(api)) {
      if (u.pathname === key || (key.endsWith('*') && u.pathname.startsWith(key.slice(0, -1)))) {
        const r = api[key](u);
        return route.fulfill({ status: r.status || 200, contentType: 'application/json', body: JSON.stringify(r.body || {}) });
      }
    }
    if (u.pathname === new URL(url).pathname) return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    if (/\.(mp4|webm)$/.test(u.pathname)) return route.fulfill({ status: 200, contentType: 'video/webm', body: CLIP });
    if (/\.(jpg|png)/.test(u.pathname)) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    return route.fulfill({ status: 404, contentType: 'text/plain', body: '' });
  });
  if (init) await page.addInitScript(init);
  await page.addInitScript(() => {
    window.__sent = [];
    window.SGNative = { postMessage: m => window.__sent.push(JSON.parse(m)) };
  });
  await page.addInitScript(`window.__sgCfg=${JSON.stringify({ role: 'main', version: 'test', searchPages: 3, viewerId: ME })};\n${SCRIPT}`);
  await page.goto(url);
  return page;
}

// One finger (or two) step by step; the session lives as long as the page (a touch belongs to one).
async function touch(page, type, points) {
  if (!page.__cdp) page.__cdp = await page.context().newCDPSession(page);
  await page.__cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(p => ({ x: p[0], y: p[1] })) });
}
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

// Full screen as the app's WebView does it (as in video.test.cjs): recorded,
// granted at once; a page's request to leave is done the Back way by the app.
async function stubFullscreen(page) {
  await page.evaluate(() => {
    window.__fs = []; window.__fsActive = []; window.__fsExit = 0; window.__fsEl = null; window.__appExits = 0;
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => window.__fsEl });
    HTMLElement.prototype.requestFullscreen = function () {
      window.__fs.push(this === document.documentElement ? 'page:' + ((document.querySelector('video[data-sg-full]') || {}).id || '?') : this.id || this.tagName);
      window.__fsActive.push(!!(navigator.userActivation && navigator.userActivation.isActive));
      window.__fsEl = this;
      document.dispatchEvent(new Event('fullscreenchange'));
      return Promise.resolve();
    };
    document.exitFullscreen = function () {
      window.__fsExit++; window.__fsEl = null;
      document.dispatchEvent(new Event('fullscreenchange'));
      return Promise.resolve();
    };
    const bridge = window.SGNative;
    window.SGNative = { postMessage: m => {
      bridge.postMessage(m);
      if (JSON.parse(m).action !== 'fullVideoExitRequest' || !window.__fsEl) return;
      window.__appExits++; window.__fsEl = null;
      document.dispatchEvent(new Event('fullscreenchange'));
    } };
  });
}
// Back in the app: the full-screen view goes and the browser leaves full screen.
async function appBack(page) {
  await page.evaluate(() => { window.__fsEl = null; document.dispatchEvent(new Event('fullscreenchange')); });
}
const fv = page => page.evaluate(() => JSON.parse(JSON.stringify(window.__sg.stats.diag.fullVideo)));
const lifted = page => page.evaluate(() => {
  const v = document.querySelector('video:popover-open');
  return v ? v.id : null;
});
const ig = page => page.evaluate(() => Object.assign({}, window.__ig));

/* ---------------- An Instagram-like feed ---------------- */

// A post's video under Instagram's tap layer, its sound and tags icons, in a
// 4:5 box. The tap layer counts touches like PolarisDoubleTappable; a single
// tap toggles the sound (or pauses, __ig.mode = 'pause') 300 ms after its
// click; a double tap likes. Its handlers sit on the app's root, like React's.
const IG_MOCK = `<script>
  const S = window.__ig = { mode: 'sound', singles: 0, likes: 0, soundTaps: 0, tagTaps: 0, clicks: 0 };
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
  const audio = v => { const b = v.closest('.box').querySelector('.sound svg'); if (b) b.setAttribute('aria-label', v.muted ? 'Audio is muted' : 'Audio is playing'); };
  root.addEventListener('click', e => {
    const sound = e.target.closest('.sound');
    if (sound) { S.soundTaps++; const v = sound.closest('.box').querySelector('video'); v.muted = !v.muted; audio(v); return; }
    if (e.target.closest('.tags')) { S.tagTaps++; return; }
    const l = layer(e.target);
    if (!l) return;
    S.clicks++;
    const v = l.closest('.box').querySelector('video');
    if (timer) { clearTimeout(timer); timer = null; } else {
      timer = setTimeout(() => {
        timer = null; S.singles++;
        if (S.mode === 'pause') { if (v.paused) v.play(); else v.pause(); } else { v.muted = !v.muted; audio(v); }
      }, 300);
    }
    if (dbl) { dbl = false; S.likes++; }
  });
</script>`;

function videoPost(id, { box = 515, src = '/clip.webm', cover = '' } = {}) {
  return `<article id="a-${id}">
    <header style="height:56px"><a href="/friend/">friend</a></header>
    <div class="box" style="position:relative;width:412px;height:${box}px;background:#000;overflow:hidden">
      <div style="position:absolute;inset:0"><video id="${id}" ${src ? `src="${src}" autoplay` : ''} muted playsinline loop
        style="width:100%;height:100%;display:block"></video></div>
      ${cover ? `<img id="${id}-cover" src="${cover}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">` : ''}
      <div class="tap" role="presentation" style="position:absolute;inset:0"></div>
      <button class="sound" aria-label="Toggle audio" style="position:absolute;right:12px;bottom:12px;width:28px;height:28px;padding:0">
        <svg aria-label="Audio is muted" width="16" height="16"></svg></button>
      <button class="tags" style="position:absolute;left:12px;bottom:12px;width:28px;height:28px;padding:0">
        <svg aria-label="Tags" width="16" height="16"></svg></button>
    </div>
    <section style="height:44px"></section>
  </article>`;
}
const page_ = body => `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head>
  <body style="margin:0"><div id="mount"><main>${body}<div style="height:2400px">more posts</div></main></div>${IG_MOCK}</body></html>`;
const FEED = page_(videoPost('v'));
const HOME = 'https://www.instagram.com/';
const POST_URL = 'https://www.instagram.com/p/ABCDEFG/';

async function openFeed(url = HOME, html = FEED) {
  const page = await openPage(url, html);
  await stubFullscreen(page);
  await page.waitForFunction(() => { const v = document.getElementById('v'); return v && !v.paused && v.readyState >= 2; });
  return page;
}

/* ---------------- R10: one tap ---------------- */

test('R10: one tap on a feed video opens it full screen after the double-tap window: clean, playing, with sound', async () => {
  const page = await openFeed();
  await page.evaluate(() => window.scrollTo(0, 40));
  await tapAt(page, 200, 300);
  await page.waitForTimeout(150);
  assert.deepEqual(await page.evaluate(() => window.__fs), [], 'waits to tell a single tap from a double');
  await page.waitForFunction(() => window.__fs.length === 1, null, { timeout: 2000 });
  const r = await page.evaluate(() => ({ fs: window.__fs, active: window.__fsActive, popover: !!document.querySelector('#sg-fullbar:popover-open') }));
  assert.deepEqual(r, { fs: ['page:v'], active: [true], popover: true }, 'still within the tap\'s user activation');
  assert.equal(await lifted(page), 'v');
  // The video alone over the whole screen: nothing of Instagram's (the icons, the tap layer) over it.
  const shown = await page.evaluate(() => {
    const v = document.getElementById('v');
    const rr = v.getBoundingClientRect();
    return { rect: [rr.left, rr.top, rr.width, rr.height], fit: getComputedStyle(v).objectFit, bg: getComputedStyle(v).backgroundColor,
      top: [[200, 400], [380, 640], [26, 640], [200, 60]].map(p => (document.elementFromPoint(p[0], p[1]) || {}).id) };
  });
  assert.deepEqual(shown, { rect: [0, 0, 412, 915], fit: 'contain', bg: 'rgb(0, 0, 0)', top: ['v', 'v', 'v', 'v'] });
  // Sound on and playing (Instagram's own single tap ran too: its sound toggle).
  await page.waitForFunction(() => { const v = document.getElementById('v'); return !v.muted && !v.paused; }, null, { timeout: 2000 });
  assert.equal((await ig(page)).singles, 1);
  assert.equal((await fv(page)).r10, 1);
  assert.deepEqual((await sent(page, 'fullVideoExitRequest')), []);
});

test('R10: a double tap likes (Instagram\'s own handler) and opens nothing', async () => {
  const page = await openFeed();
  await tapAt(page, 200, 300);
  await page.waitForTimeout(110);
  await tapAt(page, 204, 304);
  await page.waitForTimeout(700);
  const s = await ig(page);
  assert.deepEqual([s.likes, s.singles, s.clicks], [1, 0, 2], 'liked; Instagram\'s single tap never ran');
  assert.deepEqual(await page.evaluate(() => window.__fs), []);
  assert.equal(await page.evaluate(() => document.getElementById('v').muted), true);
  const f = await fv(page);
  assert.deepEqual([f.r10, f.r10Doubles], [0, 1]);
  // And again later: one tap still opens it.
  await page.waitForTimeout(400);
  await tapAt(page, 200, 300, 600);
  assert.deepEqual(await page.evaluate(() => window.__fs), ['page:v']);
});

test('R10: Instagram\'s sound and tag icons on the video keep their taps; links and other posts\' parts too', async () => {
  const page = await openFeed();
  const box = await page.evaluate(() => { const r = document.querySelector('.box').getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; });
  await tapAt(page, 412 - 26, box.bottom - 26, 500);
  await tapAt(page, 26, box.bottom - 26, 500);
  await tapAt(page, 40, box.top - 28, 500);               // the account's name above (a link)
  await tapAt(page, 200, box.bottom + 200, 500);          // the caption below
  const s = await ig(page);
  assert.deepEqual([s.soundTaps, s.tagTaps, s.singles], [1, 1, 0]);
  assert.equal(await page.evaluate(() => document.getElementById('v').muted), false, 'the sound icon unmuted it, as ever');
  assert.deepEqual(await page.evaluate(() => window.__fs), []);
});

test('R10: a swipe up or down, or Back, leaves through the app and puts the feed video back as it was', async () => {
  const page = await openFeed();
  const y0 = await page.evaluate(() => { window.scrollTo(0, 30); return window.scrollY; });
  const census = async () => {
    await page.evaluate(() => window.__sg.onNative({ type: 'status' }));
    return (await sent(page, 'status')).pop().stats.b25.census.moveBlockers;
  };
  assert.equal(await census(), 0, 'Home has no blocking touch listener');
  for (const [from, to] of [[[200, 700], [200, 250]], [[200, 250], [200, 750]], [null, null]]) {
    await tapAt(page, 200, 300);
    await page.waitForFunction(() => { const v = document.getElementById('v'); return window.__fsEl && !v.muted; }, null, { timeout: 2000 });
    assert.equal(await census(), 1, 'held still only while full screen is on');
    if (from) await drag(page, from, to);
    else await appBack(page);
    await page.waitForTimeout(500);
    const st = await page.evaluate(() => {
      const v = document.getElementById('v');
      return { fs: !!window.__fsEl, lifted: !!document.querySelector(':popover-open'), muted: v.muted, paused: v.paused,
        icon: document.querySelector('.sound svg').getAttribute('aria-label'), y: window.scrollY, attr: v.hasAttribute('popover') };
    });
    assert.deepEqual(st, { fs: false, lifted: false, muted: true, paused: false, icon: 'Audio is muted', y: y0, attr: false },
      'muted again (Instagram\'s own icon agrees), still playing, the feed where it was');
    assert.equal(await census(), 0);
  }
  // Swipes went the app's (Back) way; the page never left full screen itself.
  assert.deepEqual([await page.evaluate(() => window.__appExits), await page.evaluate(() => window.__fsExit)], [2, 0]);
  assert.deepEqual((await sent(page, 'fullVideoExitRequest')).map(m => m.why), ['swipe', 'swipe']);
  const f = await fv(page);
  assert.deepEqual([f.r10, f.exits, f.r10Restored], [3, 3, 3]);
});

test('R10: where Instagram\'s tap pauses instead, full screen plays it; afterwards it plays on, muted as before', async () => {
  const page = await openFeed();
  await page.evaluate(() => { window.__ig.mode = 'pause'; });
  await tapAt(page, 200, 300);
  await page.waitForFunction(() => { const v = document.getElementById('v'); return window.__fsEl && !v.muted && !v.paused && window.__ig.singles === 1; }, null, { timeout: 2000 });
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => document.getElementById('v').paused), false);
  // In full screen a tap pauses or plays (R8's rule), and never reaches Instagram's layer.
  await tapAt(page, 200, 400, 150);
  assert.equal(await page.evaluate(() => document.getElementById('v').paused), true);
  await tapAt(page, 200, 400, 150);
  assert.equal(await page.evaluate(() => document.getElementById('v').paused), false);
  assert.equal((await ig(page)).clicks, 1);
  await appBack(page);
  await page.waitForTimeout(500);
  assert.deepEqual(await page.evaluate(() => { const v = document.getElementById('v'); return [v.muted, v.paused]; }), [true, false]);
});

test('R10: a pinch, a scroll, a tap with a finger soon down elsewhere, or a busy page\'s late tap opens nothing', async () => {
  const page = await openFeed();
  // Two fingers.
  await touch(page, 'touchStart', [[150, 300], [250, 320]]);
  await touch(page, 'touchMove', [[120, 280], [290, 340]]);
  await touch(page, 'touchEnd', []);
  // A scroll that starts on the video.
  await drag(page, [200, 450], [200, 200], { settle: 800 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  assert.equal((await ig(page)).clicks, 0);
  // A tap, then straight away a drag elsewhere: the wait ends with no full screen.
  await tapAt(page, 200, 300);
  await page.waitForTimeout(60);
  await drag(page, [300, 800], [300, 600], { steps: 4 });
  await page.waitForTimeout(500);
  assert.deepEqual(await page.evaluate(() => window.__fs), []);
  assert.deepEqual([(await ig(page)).clicks, (await fv(page)).r10Skipped], [1, 1]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  // A tap whose click is handled long after it happened (a busy page) switches
  // nothing: the page's clock is a second ahead of the tap's own time.
  await page.evaluate(() => { const now = performance.now.bind(performance); performance.now = () => now() + 1000; });
  await tapAt(page, 200, 300, 600);
  assert.deepEqual(await page.evaluate(() => window.__fs), []);
  assert.deepEqual([(await ig(page)).clicks, (await fv(page)).r10Skipped], [2, 2], 'the tap reached the page; R10 let it be');
});

test('R10: in the post view the same tap opens it; R8\'s swipe down at the top still does too', async () => {
  const page = await openFeed(POST_URL);
  await tapAt(page, 200, 300, 600);
  assert.deepEqual(await page.evaluate(() => window.__fs), ['page:v']);
  await appBack(page);
  await page.waitForTimeout(300);
  await drag(page, [200, 200], [200, 420]);
  await page.waitForTimeout(100);
  assert.deepEqual(await page.evaluate(() => window.__fs), ['page:v', 'page:v']);
  const f = await fv(page);
  assert.deepEqual([f.r10, f.r8], [1, 1]);
  // No tap full screen in DMs or Stories.
  for (const url of ['https://www.instagram.com/direct/t/1/', 'https://www.instagram.com/stories/friend/424242/']) {
    const p = await openFeed(url);
    await tapAt(p, 200, 300, 600);
    assert.deepEqual(await p.evaluate(() => window.__fs), [], url);
  }
});

test('R10: an engine without popovers falls back to the video\'s own full screen (no bar), and still leaves the safe way', async () => {
  const page = await openFeed();
  await page.evaluate(() => { delete HTMLElement.prototype.showPopover; });
  await tapAt(page, 200, 300, 600);
  assert.deepEqual(await page.evaluate(() => window.__fs), ['v']);
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-sg-bar]').length), 0);
  await drag(page, [200, 700], [200, 250]);
  await page.waitForTimeout(300);
  assert.deepEqual([await page.evaluate(() => window.__appExits), await page.evaluate(() => !!window.__fsEl)], [1, false]);
  assert.equal(await page.evaluate(() => document.getElementById('v').muted), true);
});

test('R10: in full screen the video\'s touches stay SimpleGram\'s: Instagram\'s page under it sees none (no like, no carousel)', async () => {
  const page = await openFeed();
  await page.evaluate(() => {
    window.__rootTouches = 0;
    for (const t of ['touchstart', 'touchend', 'pointerdown']) document.getElementById('mount').addEventListener(t, () => window.__rootTouches++);
  });
  await tapAt(page, 200, 300, 600);
  assert.equal(await lifted(page), 'v');
  const before = await page.evaluate(() => [window.__rootTouches, window.__sg.stats.b25.touchSeq.starts]);
  await drag(page, [380, 400], [40, 420]);                // sideways: stays full screen
  await tapAt(page, 200, 400);
  await page.waitForTimeout(100);
  await tapAt(page, 204, 404, 500);                       // a double tap: two pauses, no like
  const after = await page.evaluate(() => [window.__rootTouches, window.__sg.stats.b25.touchSeq.starts]);
  assert.equal(after[0], before[0], 'none reached Instagram\'s page');
  assert.equal(after[1], before[1] + 3, 'SimpleGram\'s own touch bookkeeping saw them all');
  assert.deepEqual([(await ig(page)).likes, await page.evaluate(() => !!window.__fsEl)], [0, true]);
});

test('R10: if Instagram takes the video out of the page while it is full screen, full screen ends (the app\'s way)', async () => {
  const page = await openFeed();
  await tapAt(page, 200, 300, 600);
  assert.equal(await lifted(page), 'v');
  await page.evaluate(() => document.getElementById('a-v').remove());
  await page.waitForFunction(() => !window.__fsEl, null, { timeout: 3000 });
  assert.deepEqual((await sent(page, 'fullVideoExitRequest')).map(m => m.why), ['gone']);
  assert.equal(await page.evaluate(() => document.querySelectorAll('#sg-fullbar,[data-sg-bar]').length), 0);
});

// The browser's own full screen (no stub): Chromium resolves the request's
// promise before it fires fullscreenchange, as the app's WebView does.
async function openRealFullscreen(url = HOME, html = FEED) {
  const page = await openPage(url, html);
  await page.evaluate(() => {
    window.__order = [];
    document.addEventListener('fullscreenchange', () => window.__order.push('change'), true);
    const ask = Element.prototype.requestFullscreen;
    Element.prototype.requestFullscreen = function (o) {
      window.__order.push('request');
      const p = ask.call(this, o);
      p.then(() => window.__order.push('resolved'), () => window.__order.push('rejected'));
      return p;
    };
    // The app leaves full screen the Back way when the page asks.
    const bridge = window.SGNative;
    window.SGNative = { postMessage: m => {
      bridge.postMessage(m);
      if (JSON.parse(m).action === 'fullVideoExitRequest' && document.fullscreenElement) document.exitFullscreen();
    } };
  });
  await page.waitForFunction(() => { const v = document.getElementById('v'); return v && !v.paused && v.readyState >= 2; });
  return page;
}

test('R10 with the browser\'s real full screen (promise first, event after): the tap lands, the video is lifted, a swipe leaves', async () => {
  for (const url of [HOME, POST_URL]) {
    const page = await openRealFullscreen(url);
    await page.evaluate(() => window.scrollTo(0, 40));
    await tapAt(page, 200, 300);
    await page.waitForFunction(() => window.__order.includes('change'), null, { timeout: 3000 });
    await page.waitForTimeout(300);
    const st = await page.evaluate(() => ({ order: window.__order, fs: document.fullscreenElement && document.fullscreenElement.tagName,
      lifted: (document.querySelector('video:popover-open') || {}).id || null, full: !!document.querySelector('video[data-sg-full]'),
      bar: !!document.querySelector('[data-sg-bar="full"]') }));
    assert.deepEqual(st, { order: ['request', 'resolved', 'change'], fs: 'HTML', lifted: 'v', full: true, bar: true }, url);
    assert.equal((await fv(page)).r10, 1, url);
    // (Headless Chromium's real full screen never makes a touchmove cancelable,
    // so whether the feed under it scrolls is checked with the stub above.)
    await drag(page, [200, 700], [200, 250]);
    await page.waitForFunction(() => !document.fullscreenElement, null, { timeout: 3000 });
    await page.waitForTimeout(300);
    assert.deepEqual((await sent(page, 'fullVideoExitRequest')).map(m => m.why), ['swipe'], url);
    assert.equal(await page.evaluate(() => document.querySelectorAll('[data-sg-full],:popover-open').length), 0, url);
    // And again: the next tap opens it once more (back where it was, once the
    // fling headless Chromium let through, see above, has run out).
    await page.waitForTimeout(2500);
    await page.waitForFunction(() => new Promise(done => { const y = scrollY; setTimeout(() => done(scrollY === y), 400); }), null, { timeout: 5000 });
    const mid = await page.evaluate(() => {
      const v = document.getElementById('v');
      v.scrollIntoView({ block: 'center' });
      const r = v.getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    });
    await page.waitForTimeout(300);
    await tapAt(page, mid[0], mid[1]);
    await page.waitForFunction(() => document.querySelector('video:popover-open'), null, { timeout: 3000 });
    assert.equal((await fv(page)).r10, 2, url);
    await page.context().close();
  }
});

test('R10 with the browser\'s real full screen: R8\'s swipe down in the post view lands too', async () => {
  const page = await openRealFullscreen(POST_URL);
  await drag(page, [200, 200], [200, 420]);
  await page.waitForFunction(() => document.querySelector('video:popover-open'), null, { timeout: 3000 });
  assert.equal((await fv(page)).r8, 1);
  await page.context().close();
});

test('R10: a full screen SimpleGram asks for is announced to the app first (it hides its tab only for those)', async () => {
  const page = await openFeed();
  await page.evaluate(() => {
    const ask = HTMLElement.prototype.requestFullscreen;
    HTMLElement.prototype.requestFullscreen = function () {
      window.__announced = window.__sent.filter(m => m.action === 'fullVideoStart').length;
      return ask.apply(this, arguments);
    };
  });
  await tapAt(page, 200, 300, 600);
  assert.deepEqual([await page.evaluate(() => window.__announced), (await sent(page, 'fullVideoStart')).length], [1, 1]);
  assert.deepEqual(Object.keys((await sent(page, 'fullVideoStart'))[0]), ['action']);
});

test('R10: with the comments panel open, a tap on the post\'s video or ⋮ → Full-screen video opens no full screen', async () => {
  const html = page_(videoPost('v').replace('<section style="height:44px"></section>',
    `<section style="height:44px"><button class="cmt" style="width:40px;height:40px"><svg aria-label="Comment" width="24" height="24"></svg></button>
     <a href="/p/ABCDEFG/"><time>1h</time></a></section>`));
  const page = await openFeed(HOME, html);
  const b = await page.evaluate(() => { const r = document.querySelector('.cmt').getBoundingClientRect(); return [r.left + 20, r.top + 20]; });
  await tapAt(page, b[0], b[1], 300);
  const c = await sent(page, 'comments');
  assert.equal(c.length, 1, 'the comments panel opened');
  const r = c[0].rect;
  await tapAt(page, r.x + r.w / 2, r.y + r.h / 2, 800);
  assert.deepEqual(await page.evaluate(() => window.__fs), []);
  assert.equal((await ig(page)).singles, 1, 'Instagram\'s own tap still ran (its sound toggle)');
  await page.evaluate(() => { window.__sg.onNative({ type: 'menu' }); window.__sg.onNative({ type: 'fullVideoMenu' }); });
  assert.deepEqual(await sent(page, 'fullVideoTap'), []);
  assert.deepEqual((await sent(page, 'toast')).map(m => m.message), ['Close the comments first.']);
  // Closed: the tap opens it again.
  await page.evaluate(() => window.__sg.onNative({ type: 'splitClosed' }));
  await page.waitForTimeout(400);
  await tapAt(page, 200, 300, 700);
  assert.deepEqual(await page.evaluate(() => window.__fs), ['page:v']);
});

/* ---------------- R10: the ⋮ menu ---------------- */

test('R10: ⋮ → Full-screen video: the page names a spot on the video; the app\'s tap there opens it at once, kept from Instagram', async () => {
  const page = await openFeed();
  await page.evaluate(() => { window.__sg.onNative({ type: 'menu' }); window.__sg.onNative({ type: 'fullVideoMenu' }); });
  const ask = (await sent(page, 'fullVideoTap'))[0];
  assert.ok(ask, 'asks the app for a tap');
  assert.deepEqual(Object.keys(ask).sort(), ['action', 'w', 'x', 'y']);
  assert.equal(ask.w, 412);
  const spot = await page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y);
    return { cls: el.className, v: !!el.closest('.box') };
  }, [ask.x, ask.y]);
  assert.deepEqual(spot, { cls: 'tap', v: true }, 'on the video\'s own tap area, clear of the icons');
  // The app's tap (real input, so it brings user activation): full screen at once.
  await tapAt(page, ask.x, ask.y, 80);
  assert.deepEqual(await page.evaluate(() => [window.__fs, window.__fsActive]), [['page:v'], [true]]);
  await page.waitForFunction(() => !document.getElementById('v').muted, null, { timeout: 2000 });
  await page.waitForTimeout(400);
  assert.deepEqual([(await ig(page)).clicks, (await ig(page)).singles], [0, 0], 'Instagram never saw that tap');
  assert.equal((await fv(page)).r10Menu, 1);
  await appBack(page);
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => document.getElementById('v').muted), true);
  // An ordinary tap long after isn't taken for the menu's.
  await page.evaluate(() => { window.__sg.onNative({ type: 'menu' }); window.__sg.onNative({ type: 'fullVideoMenu' }); });
  await page.waitForTimeout(2700);
  await tapAt(page, ask.x, ask.y, 100);
  assert.equal(await page.evaluate(() => window.__fs.length), 1, 'not at once: an ordinary tap waits for a double');
});

test('R10: ⋮ → Full-screen video with no video on the screen says so and asks for no tap', async () => {
  const html = page_(`<article><header style="height:56px">friend</header><img id="photo" src="/p.jpg" style="width:412px;height:515px;display:block"></article>`);
  const STORY_URL = 'https://www.instagram.com/stories/friend/424242/';
  // A Story or DM on the phone is in Instagram's own full screen (on <body>), with the ⋮ tab showing.
  for (const [url, full] of [[HOME, false], [STORY_URL, false], [STORY_URL, true], ['https://www.instagram.com/direct/t/1/', true], [HOME, true]]) {
    const page = await openPage(url, html);
    if (full) {
      await page.evaluate(() => Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => document.body }));
    }
    await page.evaluate(() => { window.__sg.onNative({ type: 'menu' }); window.__sg.onNative({ type: 'fullVideoMenu' }); });
    assert.deepEqual(await sent(page, 'fullVideoTap'), [], url);
    assert.equal((await sent(page, 'toast')).length, 1, url + ' ' + full);
    await page.context().close();
  }
});

test('R10: full screen from a tap or the menu has sound even after you muted a video once; your mute is back afterwards', async () => {
  const muteOnce = async page => {
    const b = await page.evaluate(() => { const r = document.querySelector('.sound').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
    // Sound on and off again, or (where SimpleGram already turned it on) just off: your choice is mute.
    for (let i = 0; i < 2 && !(i && await page.evaluate(() => document.getElementById('v').muted)); i++) await tapAt(page, b[0], b[1], 500);
    assert.equal(await page.evaluate(() => document.getElementById('v').muted), true);
    await page.waitForTimeout(600);
    assert.equal(await page.evaluate(() => document.getElementById('v').muted), true, 'and it stays muted');
  };
  const state = page => page.evaluate(() => { const v = document.getElementById('v'); return { fs: !!window.__fsEl, muted: v.muted, paused: v.paused }; });
  // The post view, where Instagram's single tap pauses.
  let page = await openFeed(POST_URL);
  await muteOnce(page);
  await page.evaluate(() => { window.__ig.mode = 'pause'; });
  await tapAt(page, 200, 300);
  await page.waitForFunction(() => { const v = document.getElementById('v'); return window.__fsEl && !v.muted && !v.paused; }, null, { timeout: 3000 });
  await appBack(page);
  await page.waitForTimeout(600);
  assert.deepEqual(await state(page), { fs: false, muted: true, paused: false });
  await page.context().close();
  // ⋮ → Full-screen video on Home (Instagram never sees that tap).
  page = await openFeed();
  await muteOnce(page);
  await page.evaluate(() => { window.__sg.onNative({ type: 'menu' }); window.__sg.onNative({ type: 'fullVideoMenu' }); });
  const ask = (await sent(page, 'fullVideoTap'))[0];
  await tapAt(page, ask.x, ask.y);
  await page.waitForFunction(() => { const v = document.getElementById('v'); return window.__fsEl && !v.muted && !v.paused; }, null, { timeout: 3000 });
  await appBack(page);
  await page.waitForTimeout(600);
  assert.deepEqual(await state(page), { fs: false, muted: true, paused: false });
  // Your mute still holds outside full screen: a later play doesn't turn the sound on.
  await page.evaluate(() => { const v = document.getElementById('v'); v.pause(); return v.play(); });
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => document.getElementById('v').muted), true);
  await page.context().close();
});

/* ---------------- R11: the progress bar ---------------- */

// A longer video for the bar: Instagram's own clip, said to be 45 s long; seeks are recorded.
async function longVideo(page, id = 'v', secs = 45) {
  await page.evaluate(([id, secs]) => {
    const v = document.getElementById(id);
    window.__seeks = [];
    let at = 0;
    Object.defineProperty(v, 'duration', { configurable: true, get: () => secs });
    Object.defineProperty(v, 'currentTime', { configurable: true, get: () => at, set: t => { at = t; window.__seeks.push(Math.round(t * 10) / 10); } });
    v.dispatchEvent(new Event('durationchange'));
  }, [id, secs]);
  await page.waitForTimeout(100);
}
const barState = (page, sel = '[data-sg-bar]') => page.evaluate(s => {
  const host = document.querySelector(s);
  if (!host) return null;
  const root = host.shadowRoot;
  const q = c => root.querySelector(c);
  const cs = el => getComputedStyle(el);
  const r = host.getBoundingClientRect(), t = q('.track').getBoundingClientRect();
  return { where: host.dataset.sgBar, visible: cs(host).visibility !== 'hidden', active: host.hasAttribute('data-active'),
    host: [r.left, r.width], track: { bottom: t.bottom, height: t.height, left: t.left, width: t.width, bg: cs(q('.track')).backgroundColor },
    fill: { bg: cs(q('.fill')).backgroundColor, t: q('.fill').style.transform },
    knob: { opacity: cs(q('.knob')).opacity, w: q('.knob').getBoundingClientRect().width, radius: cs(q('.knob')).borderRadius, bg: cs(q('.knob')).backgroundColor },
    time: { opacity: cs(q('.time')).opacity, text: q('.time').textContent },
    touchAction: [host, q('.track'), q('.fill'), q('.knob'), q('.time')].map(e => cs(e).touchAction) };
}, sel);

test('R11: the post view\'s bar: a thin white-on-dark line on the video\'s bottom edge; touch thickens it, shows the handle and the time', async () => {
  const page = await openFeed(POST_URL);
  await longVideo(page);
  await page.waitForFunction(() => document.querySelector('[data-sg-bar="post"]'));
  const vb = await page.evaluate(() => document.getElementById('v').getBoundingClientRect().bottom);
  let b = await barState(page);
  assert.equal(b.visible, true);
  assert.deepEqual(b.host, [0, 412], 'the whole width of the video');
  assert.equal(b.track.height, 2, 'thin');
  assert.ok(Math.abs(b.track.bottom - vb) < 1, `along the video's bottom edge (${b.track.bottom} vs ${vb})`);
  assert.equal(b.track.bg, 'rgba(0, 0, 0, 0.4)', 'dark translucent for the rest');
  assert.equal(b.fill.bg, 'rgb(255, 255, 255)', 'white for the part played');
  assert.equal(b.active, false);
  assert.ok(b.touchAction.every(x => x === 'auto'), 'never touch-action (B25)');
  assert.deepEqual(await page.evaluate(() => [document.getElementById('sg-style').textContent,
    document.querySelector('[data-sg-bar]').shadowRoot.querySelector('style').textContent,
    document.querySelector('[data-sg-bar]').getAttribute('style')].filter(t => /touch-action/.test(t))), [], 'no touch-action anywhere of ours');
  // Touch: thicker, the round white handle, the time.
  await page.evaluate(() => { document.getElementById('v').currentTime = 12; window.__seeks = []; });
  await touch(page, 'touchStart', [[100, vb - 3]]);
  await page.waitForTimeout(200);
  b = await barState(page);
  assert.deepEqual([b.active, b.track.height, b.knob.opacity, b.knob.w, b.knob.radius, b.knob.bg, b.time.opacity],
    [true, 6, '1', 14, '50%', 'rgb(255, 255, 255)', '1']);
  assert.match(b.time.text, /^0:\d\d \/ 0:45$/);
  // Drag to scrub: the time follows the finger; the video jumps only on letting go.
  await touch(page, 'touchMove', [[200, vb - 3]]);
  await touch(page, 'touchMove', [[300, vb + 40]]);
  await page.waitForTimeout(100);
  b = await barState(page);
  assert.equal(b.time.text, '0:32 / 0:45');
  assert.deepEqual(await page.evaluate(() => window.__seeks), []);
  await touch(page, 'touchEnd', []);
  await page.waitForTimeout(100);
  const seeks = await page.evaluate(() => window.__seeks);
  assert.equal(seeks.length, 1);
  assert.ok(Math.abs(seeks[0] - 300 / 412 * 45) < 0.3, String(seeks));
  // A tap on a point jumps there.
  await tapAt(page, 103, vb - 2, 150);
  const s2 = await page.evaluate(() => window.__seeks);
  assert.ok(Math.abs(s2[1] - 103 / 412 * 45) < 0.3, String(s2));
  // It goes thin again a moment after.
  await page.waitForTimeout(1100);
  assert.equal((await barState(page)).active, false);
  const st = await page.evaluate(() => JSON.parse(JSON.stringify(window.__sg.stats.seekBar)));
  assert.deepEqual([st.drags, st.taps, st.where.post], [1, 1, 1]);
});

test('R11: the bar\'s touches start nothing else: no scroll, no full-screen swipe, no like, no tap on the video', async () => {
  const page = await openFeed(POST_URL);
  await longVideo(page);
  await page.waitForFunction(() => document.querySelector('[data-sg-bar="post"]'));
  const vb = await page.evaluate(() => document.getElementById('v').getBoundingClientRect().bottom);
  await page.evaluate(() => {
    window.__free = 0;
    document.addEventListener('touchmove', e => { if (!e.defaultPrevented) window.__free++; }, { passive: true, capture: false });
  });
  // Down the page (R8's swipe down at the top), up, sideways (a carousel), a double tap (a like).
  await drag(page, [200, vb - 3], [200, vb + 300]);
  await drag(page, [200, vb - 3], [200, vb - 300]);
  await drag(page, [380, vb - 3], [40, vb]);
  await tapAt(page, 200, vb - 3);
  await page.waitForTimeout(100);
  await tapAt(page, 200, vb - 3);
  await page.waitForTimeout(700);
  assert.deepEqual(await page.evaluate(() => [window.scrollY, window.__fs.length, window.__free]), [0, 0, 0]);
  const s = await ig(page);
  assert.deepEqual([s.likes, s.clicks, s.singles], [0, 0, 0]);
  assert.equal(await page.evaluate(() => window.__seeks.length), 5);
  // The video itself just above still takes R10's tap.
  await tapAt(page, 200, vb - 60, 600);
  assert.equal(await page.evaluate(() => window.__fs.length), 1);
});

test('R11: Instagram\'s sound and tag icons under the bar\'s strip keep their taps; the rest of the strip still seeks', async () => {
  // Icons as Instagram lays them out: a button at the corner whose circle has a
  // 12 px margin, so the button reaches the video's bottom edge, under the strip.
  const icon = (side, label) => `<div style="position:absolute;${side === 'sound' ? 'right' : 'left'}:0;bottom:0">
    <button class="${side}" aria-label="${label}" style="border:0;padding:0;background:none;display:block">
    <div class="circle" style="margin:12px;padding:8px;border-radius:50%;background:#333"><svg aria-label="${side === 'sound' ? 'Audio is muted' : 'Tags'}" width="12" height="12"></svg></div></button></div>`;
  const body = videoPost('v').replace(/<button class="sound"[\s\S]*?<\/button>\s*<button class="tags"[\s\S]*?<\/button>/,
    icon('sound', 'Toggle audio') + icon('tags', 'Tags'));
  const page = await openFeed(POST_URL, page_(body));
  await longVideo(page);
  await page.waitForFunction(() => document.querySelector('[data-sg-bar="post"]'));
  await page.waitForTimeout(500);
  await page.evaluate(() => { document.getElementById('v').currentTime = 20; window.__seeks = []; });
  const s0 = await ig(page), muted0 = await page.evaluate(() => document.getElementById('v').muted);
  const g = await page.evaluate(() => {
    const c = s => { const r = document.querySelector(s + ' .circle').getBoundingClientRect(); return (r.left + r.right) / 2; };
    return { sound: c('.sound'), tags: c('.tags'), vb: document.getElementById('v').getBoundingClientRect().bottom };
  });
  for (const dy of [10, 6, 2]) {
    assert.equal(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y).dataset.sgBar, [g.sound, g.vb - dy]), true, 'the strip is on top there');
    await tapAt(page, g.sound, g.vb - dy, 400);
    await tapAt(page, g.tags, g.vb - dy, 400);
  }
  const s1 = await ig(page);
  assert.deepEqual([s1.soundTaps - s0.soundTaps, s1.tagTaps - s0.tagTaps, s1.clicks, s1.likes], [3, 3, 0, 0]);
  assert.deepEqual(await page.evaluate(() => window.__seeks), [], 'no jump to the end or the start');
  assert.equal(await page.evaluate(() => document.getElementById('v').muted), !muted0, 'three taps on the sound icon toggled it three times');
  assert.deepEqual(await page.evaluate(() => window.__fs), []);
  // The strip's middle still seeks; a drag that starts on an icon does nothing.
  await tapAt(page, 206, g.vb - 3, 200);
  await drag(page, [g.sound, g.vb - 4], [g.sound - 200, g.vb - 4]);
  const seeks = await page.evaluate(() => window.__seeks);
  assert.equal(seeks.length, 1);
  assert.ok(Math.abs(seeks[0] - 22.5) < 0.3, String(seeks));
  assert.equal((await ig(page)).soundTaps, s1.soundTaps);
  assert.equal(await page.evaluate(() => window.__sg.stats.seekBar.passed), 6);
});

test('R11: in full screen the bar is docked over the bottom of the video, above it, and its touches keep full screen', async () => {
  const page = await openFeed();
  await longVideo(page);
  await tapAt(page, 200, 300);
  await page.waitForFunction(() => window.__fsEl && document.querySelector('[data-sg-bar="full"]'), null, { timeout: 2000 });
  await page.waitForTimeout(200);
  const b = await barState(page, '[data-sg-bar="full"]');
  assert.deepEqual([b.visible, b.host, b.track.width, b.track.height], [true, [0, 412], 412, 2]);
  assert.ok(b.track.bottom > 915 - 40 && b.track.bottom < 915 - 20, 'near the bottom, clear of the system gesture edge: ' + b.track.bottom);
  const hit = await page.evaluate(y => { const e = document.elementFromPoint(200, y); return e && e.dataset ? e.dataset.sgBar : null; }, b.track.bottom - 2);
  assert.equal(hit, 'full', 'drawn and touched above the lifted video');
  const playing = await page.evaluate(() => !document.getElementById('v').paused);
  await drag(page, [100, b.track.bottom - 2], [300, b.track.bottom - 2]);           // scrub
  await drag(page, [200, b.track.bottom - 2], [200, b.track.bottom - 400]);        // a swipe up from the bar
  await tapAt(page, 50, b.track.bottom - 2, 200);                                  // a tap on the bar
  const st = await page.evaluate(() => ({ fs: !!window.__fsEl, paused: document.getElementById('v').paused, seeks: window.__seeks.length }));
  assert.deepEqual(st, { fs: true, paused: !playing, seeks: 3 }, 'still full screen, not paused, three jumps');
  assert.deepEqual(await sent(page, 'fullVideoExitRequest'), []);
  // Leaving takes the bar and its layer away.
  await appBack(page);
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-sg-bar],#sg-fullbar').length), 0);
});

test('R11: the bar in Instagram\'s DM Reel viewer (only there in DMs), and no window-level blocking listener for it', async () => {
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body style="margin:0">
    <div id="mount"><div id="thread"><video id="small" src="/clip.webm" muted autoplay loop style="width:240px;height:300px"></video></div>
    <div id="viewer" role="dialog" style="position:fixed;inset:0;background:#000">
      <video id="v" src="/clip.webm" muted autoplay loop playsinline style="width:412px;height:915px;display:block"></video></div></div></body></html>`;
  const add = () => {
    const live = new Set();
    const a = EventTarget.prototype.addEventListener;
    window.__blocking = live;
    EventTarget.prototype.addEventListener = function (type, fn, opts) {
      if ((this === window || this === document) && type === 'touchmove' && opts && typeof opts === 'object' && opts.passive === false) { live.add(type) }
      return a.apply(this, arguments);
    };
  };
  const page = await openPage('https://www.instagram.com/direct/t/1/', html, { init: add });
  await page.waitForFunction(() => document.getElementById('v').readyState >= 1);
  await longVideo(page);
  await page.waitForFunction(() => document.querySelector('[data-sg-bar="dm"]'));
  const b = await barState(page, '[data-sg-bar="dm"]');
  assert.equal(b.visible, true);
  assert.ok(Math.abs(b.track.bottom - 915) < 1, 'at the bottom of the viewer: ' + b.track.bottom);
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-sg-bar]').length), 1, 'none on the small video in the chat');
  assert.deepEqual(await page.evaluate(() => Array.from(window.__blocking)), []);
  await tapAt(page, 206, 913, 150);
  assert.ok(Math.abs((await page.evaluate(() => window.__seeks))[0] - 22.5) < 0.3);
  // The viewer closed: the bar goes.
  await page.evaluate(() => document.getElementById('viewer').remove());
  await page.waitForFunction(() => !document.querySelector('[data-sg-bar]'), null, { timeout: 2000 });
});

test('R11: no bar on Home (a tap opens full screen instead); in the post view it steps aside for a sheet', async () => {
  const home = await openFeed();
  await longVideo(home);
  await home.waitForTimeout(300);
  assert.equal(await home.evaluate(() => document.querySelectorAll('[data-sg-bar]').length), 0);
  const page = await openFeed(POST_URL);
  await longVideo(page);
  await page.waitForFunction(() => document.querySelector('[data-sg-bar="post"]'));
  await page.evaluate(() => {
    const d = document.createElement('div');
    d.id = 'sheet'; d.setAttribute('role', 'dialog');
    d.style.cssText = 'position:fixed;left:0;right:0;bottom:0;height:500px;background:#fff';
    document.body.appendChild(d);
  });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-sg-bar]')).visibility === 'hidden', null, { timeout: 2000 });
  await page.evaluate(() => document.getElementById('sheet').remove());
  await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-sg-bar]')).visibility !== 'hidden', null, { timeout: 2000 });
  // It follows the video when the page scrolls.
  await page.evaluate(() => window.scrollTo(0, 120));
  await page.waitForTimeout(150);
  const [tb, vb] = await page.evaluate(() => [document.querySelector('[data-sg-bar]').shadowRoot.querySelector('.track').getBoundingClientRect().bottom,
    document.getElementById('v').getBoundingClientRect().bottom]);
  assert.ok(Math.abs(tb - vb) < 1, `${tb} vs ${vb}`);
});

test('R11: the bar over R9\'s Story Reel; its touches neither close the Reel nor pause it', async () => {
  const STORY = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body style="margin:0;background:#000">
    <div id="mount"><section style="position:fixed;inset:0"><img src="/story1.jpg" style="position:absolute;inset:0;width:412px;height:915px">
    <div role="button" style="position:absolute;inset:0"></div></section></div></body></html>`;
  const reelInfo = () => ({ body: { status: 'ok', items: [media('REELCODE1', user('creator'), {
    product_type: 'clips', video_versions: [{ url: 'https://scontent.cdninstagram.com/v/t50/reel-720.webm', width: 720, height: 1280 }] })] } });
  const page = await openPage('https://www.instagram.com/stories/friend/424242/', STORY, { api: { '/api/v1/media/*': reelInfo } });
  const item = media('STORYX424242', user('friend', true), { pk: '424242', id: '424242_777',
    story_feed_media: [{ x: 0.5, y: 0.5, width: 0.6, height: 0.5, rotation: 0, media_code: 'REELCODE1', product_type: 'clips', id: 's1' }] });
  await page.evaluate(p => JSON.parse(JSON.stringify(p)), { data: { xdt_api__v1__feed__reels_media: { reels_media: [{ id: '777', items: [item] }] } } });
  await page.evaluate(() => {
    window.__fsEl = document.body;
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => window.__fsEl });
  });
  await drag(page, [200, 600], [205, 250], { steps: 4 });
  await page.waitForFunction(() => { const v = document.querySelector('#sg-reel video'); return v && v.readyState >= 1 && !v.paused; }, null, { timeout: 4000 });
  const b = await barState(page, '#sg-reel [data-sg-bar="story"]');
  assert.ok(b && b.visible && b.host[1] === 412, JSON.stringify(b));
  const y = b.track.bottom - 2;
  await drag(page, [200, y], [200, y - 400]);       // a swipe up from the bar
  await tapAt(page, 100, y, 200);                   // a tap on the bar
  const st = await page.evaluate(() => ({ open: !!document.getElementById('sg-reel'), paused: document.querySelector('#sg-reel video').paused }));
  assert.deepEqual(st, { open: true, paused: false });
  // Closing the Reel takes its bar.
  await drag(page, [200, 300], [200, 650], { steps: 4 });
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-sg-bar]').length), 0);
});

test('R11: the bar goes with the page it was on, and comes back with the video', async () => {
  const page = await openFeed(POST_URL);
  await longVideo(page);
  await page.waitForFunction(() => document.querySelector('[data-sg-bar="post"]'));
  await page.evaluate(() => history.pushState(null, '', '/'));
  await page.waitForFunction(() => !document.querySelector('[data-sg-bar]'), null, { timeout: 2000 });
  await page.evaluate(() => history.pushState(null, '', '/p/ABCDEFG/'));
  await page.waitForFunction(() => document.querySelectorAll('[data-sg-bar="post"]').length === 1, null, { timeout: 2000 });
  assert.equal(await page.evaluate(() => window.__sg.stats.seekBar.attached), 2);
});

/* ---------------- B21: the cover framed like the video ---------------- */

const coverUrl = code => `https://scontent.cdninstagram.com/v/t51/${code}_big_n.jpg?stp=640`;
const COVERS = page_(['VERT', 'SQUA', 'LAND'].map(c => videoPost(c, { src: '', cover: coverUrl(c) })).join('') +
  videoPost('WIDE', { box: 232, src: '', cover: coverUrl('WIDE') }) +
  `<article><div style="position:relative;width:412px;height:515px"><img id="photo" src="${coverUrl('PHOT')}" style="width:100%;height:100%;object-fit:cover"></div></article>`);
// Instagram's data for those posts: each video's own shape.
function coverData() {
  const vid = (code, w, h) => media(code, user('friend', true), { video_versions: [{ url: `https://scontent.cdninstagram.com/v/t50/${code}.mp4`, width: w, height: h }] });
  return { status: 'ok', items: [vid('VERT', 720, 1280), vid('SQUA', 720, 720), vid('LAND', 1280, 720), vid('WIDE', 1280, 720), media('PHOT', user('friend', true))] };
}
// The picture's rectangle inside an element: its box less its padding.
const pictureOf = (page, id) => page.evaluate(i => {
  const el = document.getElementById(i);
  const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
  const p = k => parseFloat(cs['padding' + k]) || 0;
  return { box: [r.left, r.top, r.width, r.height].map(n => Math.round(n * 10) / 10),
    pic: [r.left + p('Left'), r.top + p('Top'), r.width - p('Left') - p('Right'), r.height - p('Top') - p('Bottom')].map(n => Math.round(n * 10) / 10),
    fit: cs.objectFit, bg: cs.backgroundColor, framed: el.dataset.sgCover || null };
}, id);
// Where a <video> draws its picture: whole, as large as fits, centred.
function containRect(box, aspect) {
  const [l, t, w, h] = box;
  const pw = aspect > w / h ? w : h * aspect, ph = aspect > w / h ? w / aspect : h;
  return [l + (w - pw) / 2, t + (h - ph) / 2, pw, ph].map(n => Math.round(n * 10) / 10);
}

test('B21: a vertical, square or landscape video\'s cover takes the video\'s own framing, with the same black bars', async () => {
  const page = await openPage(HOME, COVERS);
  await page.evaluate(d => JSON.parse(JSON.stringify(d)), coverData());
  await page.evaluate(() => window.__sg.onNative({ type: 'tidy' }));
  await page.waitForFunction(() => document.querySelectorAll('[data-sg-cover]').length >= 3, null, { timeout: 3000 });
  for (const [code, aspect] of [['VERT', 720 / 1280], ['SQUA', 1], ['LAND', 1280 / 720]]) {
    const img = await pictureOf(page, code + '-cover');
    const box = (await pictureOf(page, code)).box;
    assert.deepEqual(img.box, box, code + ': the cover\'s box is unchanged');
    const want = containRect(box, aspect);
    for (let i = 0; i < 4; i++) assert.ok(Math.abs(img.pic[i] - want[i]) < 0.6, `${code}: ${img.pic} vs ${want}`);
    assert.deepEqual([img.fit, img.bg], ['cover', 'rgb(0, 0, 0)'], code);
  }
  // A landscape video in its own 16:9 box has no bars: its cover is left alone. Photos too.
  assert.deepEqual([(await pictureOf(page, 'WIDE-cover')).framed, (await pictureOf(page, 'photo')).framed], [null, null]);
  const st = await page.evaluate(() => window.__sg.stats.covers);
  assert.deepEqual(st, { framed: 3, undone: 0 });
});

test('B21: nothing moves when the video starts: the cover showed exactly where the video then draws', async () => {
  // The cover is a square picture (not the video's shape) and Instagram's data
  // has no entry for it: the video's own size, once known, frames it.
  const html = page_(videoPost('v', { cover: '/cover-square.png' }));
  const page = await openPage(HOME, html.replace(' autoplay', ''));
  await page.waitForFunction(() => { const v = document.getElementById('v'); return v.videoWidth > 0; });
  await page.waitForFunction(() => document.getElementById('v-cover').dataset.sgCover, null, { timeout: 3000 });
  const cover = await pictureOf(page, 'v-cover');
  const vid = await page.evaluate(() => { const v = document.getElementById('v'); return [v.videoWidth, v.videoHeight]; });
  // Instagram takes the cover away once the video plays (VideoPlayerWithThumbnail).
  await page.evaluate(() => {
    const v = document.getElementById('v');
    v.addEventListener('playing', () => document.getElementById('v-cover').remove(), { once: true });
    v.play();
  });
  await page.waitForFunction(() => !document.getElementById('v-cover'));
  const box = (await pictureOf(page, 'v')).box;
  const drawn = containRect(box, vid[0] / vid[1]);
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(cover.pic[i] - drawn[i]) < 0.6, `${cover.pic} vs ${drawn}`);
  assert.ok(cover.pic[2] < 412 - 100, 'narrower than the box, with bars (a vertical clip)');
});

test('B21: a cover whose box would change size is left as Instagram drew it', async () => {
  // A cover sized by its own picture (height auto): padding would make it taller.
  const svg = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="412" height="515"></svg>');
  const html = page_(`<article><div class="box" style="position:relative;width:412px;height:515px;background:#000">
    <div style="position:absolute;inset:0"><video id="v" src="/clip.webm" muted style="width:100%;height:100%;display:block"></video></div>
    <div style="position:absolute;left:0;top:0;width:412px"><img id="v-cover" src="${svg}" style="width:100%;height:auto;display:block"></div></div></article>`);
  const page = await openPage(HOME, html);
  await page.waitForFunction(() => document.getElementById('v').videoWidth > 0 && document.getElementById('v-cover').complete);
  await page.evaluate(() => window.__sg.onNative({ type: 'tidy' }));
  await page.waitForFunction(() => document.getElementById('v-cover').dataset.sgCover, null, { timeout: 3000 });
  const img = await pictureOf(page, 'v-cover');
  assert.equal(img.framed, 'no');
  assert.deepEqual(img.box, [0, 0, 412, 515]);
  assert.deepEqual(await page.evaluate(() => window.__sg.stats.covers), { framed: 0, undone: 1 });
});
