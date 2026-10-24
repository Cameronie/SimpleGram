// Browser tests for full-screen video (R8, R9) and the Story swipe work (B19).
//
// Touches are real ones from the browser (Chrome DevTools input), so they are
// trusted, hit-tested and scroll the page like a finger would. Full screen is
// stubbed: headless Chromium has no screen to fill, and the app's full-screen
// view is native. Nothing reaches Instagram: every request is answered locally.
//
// Run: NODE_PATH=/opt/node-tools/node_modules node --test tests/*.test.cjs
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { SCRIPT, ME, sent, waitSent, user, media, PNG } = require('./helpers.cjs');
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
// A one-second clip with sound, served for every video address (a Reel's CDN link).
const CLIP = fs.readFileSync(path.join(__dirname, 'reel.webm'));

let browser;
before(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { await browser.close(); });

// Like helpers.open, with `init` run before the page script (to watch its listeners).
async function openPage(url, html, { api = {}, init = null, video = null } = {}) {
  const context = await browser.newContext({
    viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true,
  });
  const page = await context.newPage();
  page.hits = {};
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    for (const key of Object.keys(api)) {
      if (u.pathname === key || (key.endsWith('*') && u.pathname.startsWith(key.slice(0, -1)))) {
        page.hits[key] = (page.hits[key] || 0) + 1;
        const r = api[key](u);
        return route.fulfill({ status: r.status || 200, contentType: 'application/json', body: JSON.stringify(r.body || {}) });
      }
    }
    if (u.pathname === new URL(url).pathname) return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    if (/\.(mp4|webm)$/.test(u.pathname)) {
      const status = video ? video(u) : 200;
      page.hits.video = (page.hits.video || 0) + 1;
      return status === 200 ? route.fulfill({ status: 200, contentType: 'video/webm', body: CLIP })
        : route.fulfill({ status: status, contentType: 'text/plain', body: '' });
    }
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

// A finger: down at `from`, moved in steps, lifted at `to`.
async function drag(page, from, to, { steps = 8, cancel = false } = {}) {
  const c = await page.context().newCDPSession(page);
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from[0], y: from[1] }] });
  for (let i = 1; i <= steps; i++) {
    await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{
      x: from[0] + (to[0] - from[0]) * i / steps, y: from[1] + (to[1] - from[1]) * i / steps }] });
  }
  await c.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] });
  await c.detach();
  await page.waitForTimeout(60);
}
async function tapAt(page, x, y) {
  const c = await page.context().newCDPSession(page);
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await c.detach();
  await page.waitForTimeout(120);
}

// Full screen as the app's WebView does it, recorded. `already` = Instagram's
// Story is in full screen (its own request on <body>).
async function stubFullscreen(page, already) {
  await page.evaluate(on => {
    window.__fs = [];
    window.__fsActive = [];
    window.__fsExit = 0;
    window.__fsEl = on ? document.body : null;
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => window.__fsEl });
    HTMLElement.prototype.requestFullscreen = function () {
      window.__fs.push((this === document.documentElement ? 'page:' + ((document.querySelector('video[data-sg-full]') || {}).id || '?') : (this.id || this.tagName)));
      window.__fsActive.push(!!(navigator.userActivation && navigator.userActivation.isActive));
      window.__fsEl = this;
      document.dispatchEvent(new Event('fullscreenchange'));
      return Promise.resolve();
    };
    document.exitFullscreen = function () {
      window.__fsExit++;
      window.__fsEl = null;
      document.dispatchEvent(new Event('fullscreenchange'));
      return Promise.resolve();
    };
    // The app (B25): a page's request to leave full screen is done the Back
    // way, its full-screen view first and then the browser's full screen.
    window.__appExits = 0;
    const bridge = window.SGNative;
    if (bridge) {
      window.SGNative = { postMessage: m => {
        bridge.postMessage(m);
        if (JSON.parse(m).action !== 'fullVideoExitRequest' || !window.__fsEl) return;
        window.__appExits++;
        window.__fsEl = null;
        document.dispatchEvent(new Event('fullscreenchange'));
      } };
    }
  }, !!already);
}
const fv = page => page.evaluate(() => window.__sg.stats.diag.fullVideo);
// Which touch moves the page script held still (seen after its own listener).
async function watchMoves(page) {
  await page.evaluate(() => {
    window.__held = 0; window.__free = 0;
    document.addEventListener('touchmove', e => { if (e.defaultPrevented) window.__held++; else window.__free++; }, { passive: true, capture: true });
  });
}

/* ---------------- R8: posts and Reels ---------------- */

// An opened post: header, the video under Instagram's own tap layer, a long caption.
const POST = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body style="margin:0">
  <main><article>
    <header style="height:60px">friend</header>
    <div style="position:relative;width:412px;height:500px">
      <video id="v" muted playsinline loop style="width:412px;height:500px;display:block;background:#222"></video>
      <div id="tap" style="position:absolute;left:0;top:0;width:412px;height:500px"></div>
    </div>
    <div id="caption" style="height:2400px">a long description</div>
  </article></main>
  <script>window.__igTaps = 0; document.getElementById('tap').addEventListener('click', () => window.__igTaps++);</script>
  </body></html>`;

test('R8: a swipe down on the video at the top of the page shows that video full screen', async () => {
  const page = await openPage('https://www.instagram.com/p/ABCDEFG/', POST);
  await stubFullscreen(page);
  await watchMoves(page);
  await drag(page, [200, 200], [210, 420]);
  assert.deepEqual(await page.evaluate(() => window.__fs), ['page:v']);
  assert.ok(await page.evaluate(() => window.__held >= 7), 'the armed swipe is held still');
  // The swipe was held still (no scroll), so its lift counts as your tap for the browser.
  assert.deepEqual(await page.evaluate(() => window.__fsActive), [true]);
  assert.equal(await page.evaluate(() => document.getElementById('v').dataset.sgFull), '1');
  assert.equal((await fv(page)).r8, 1);
  // Shown whole on black, with no controls over it.
  const css = await page.evaluate(() => document.getElementById('sg-style').textContent);
  assert.match(css, /video\[data-sg-full\]:fullscreen\{object-fit:contain!important;background:#000!important/);
  assert.match(css, /::-webkit-media-controls\{display:none!important\}/);
});

test('R8: a Reel page works the same way', async () => {
  const page = await openPage('https://www.instagram.com/reel/ABCDEFG/', POST);
  await stubFullscreen(page);
  await drag(page, [200, 300], [200, 450]);
  assert.deepEqual(await page.evaluate(() => window.__fs), ['page:v']);
});

test('R8: scrolled down, the swipe scrolls back up; the next one goes full screen', async () => {
  const page = await openPage('https://www.instagram.com/p/ABCDEFG/', POST);
  await stubFullscreen(page);
  await page.evaluate(() => window.scrollTo(0, 120));
  await drag(page, [200, 150], [200, 400]);
  assert.deepEqual(await page.evaluate(() => window.__fs), []);
  assert.equal(await page.evaluate(() => window.scrollY), 0, 'the page scrolled back to the top');
  await drag(page, [200, 200], [200, 400]);
  assert.deepEqual(await page.evaluate(() => window.__fs), ['page:v']);
});

test('R8: a swipe up never goes full screen (reading the description scrolls as usual)', async () => {
  const page = await openPage('https://www.instagram.com/p/ABCDEFG/', POST);
  await stubFullscreen(page);
  await watchMoves(page);
  await drag(page, [200, 420], [200, 150]);
  assert.deepEqual(await page.evaluate(() => window.__fs), []);
  assert.equal(await page.evaluate(() => window.__held), 0, 'never held');
  assert.ok(await page.evaluate(() => window.scrollY) > 100, 'the page scrolled');
  // Up then down in one touch: decided by its start, so still nothing.
  await page.evaluate(() => window.scrollTo(0, 0));
  const c = await page.context().newCDPSession(page);
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 200, y: 300 }] });
  await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 200, y: 280 }] });
  await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 200, y: 450 }] });
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(60);
  assert.deepEqual(await page.evaluate(() => window.__fs), []);
});

test('R8: a swipe that starts outside the video, or goes sideways, does nothing', async () => {
  const page = await openPage('https://www.instagram.com/p/ABCDEFG/', POST);
  await stubFullscreen(page);
  await drag(page, [200, 30], [200, 300]);           // on the header
  await page.evaluate(() => window.scrollTo(0, 0));
  await drag(page, [200, 640], [200, 900]);          // on the caption
  await page.evaluate(() => window.scrollTo(0, 0));
  await drag(page, [380, 250], [60, 290]);           // a carousel swipe
  await drag(page, [380, 250], [300, 330]);          // short and diagonal
  assert.deepEqual(await page.evaluate(() => window.__fs), []);
  // Taps still reach Instagram (its tap toggles sound or pauses).
  await tapAt(page, 200, 250);
  assert.equal(await page.evaluate(() => window.__igTaps), 1);
  assert.equal((await fv(page)).r8, 0);
});

test('R8: in full screen a swipe up or down returns; a tap pauses or plays', async () => {
  const page = await openPage('https://www.instagram.com/p/ABCDEFG/', POST);
  await stubFullscreen(page);
  await page.evaluate(() => {
    const v = document.getElementById('v');
    window.__plays = 0; window.__pauses = 0; window.__paused = true;
    Object.defineProperty(v, 'paused', { configurable: true, get: () => window.__paused });
    // Already watched a while: SimpleGram's own autoplay leaves it alone.
    Object.defineProperty(v, 'currentTime', { configurable: true, get: () => 5 });
    v.play = () => { window.__plays++; window.__paused = false; return Promise.resolve(); };
    v.pause = () => { window.__pauses++; window.__paused = true; };
  });
  await drag(page, [200, 200], [200, 400]);
  // The page is full screen with the video lifted over it (R11's bar can go over it).
  assert.deepEqual(await page.evaluate(() => [window.__fsEl === document.documentElement, (document.querySelector('video:popover-open') || {}).id]), [true, 'v']);
  await tapAt(page, 200, 400);
  await tapAt(page, 200, 400);
  assert.deepEqual(await page.evaluate(() => [window.__plays, window.__pauses, window.__igTaps]), [1, 1, 0]);
  // A sideways swipe stays in full screen; a vertical one leaves.
  await drag(page, [350, 400], [60, 420]);
  assert.equal(await page.evaluate(() => window.__appExits), 0);
  await drag(page, [200, 700], [200, 300]);
  // B25: the app leaves full screen the Back way; the page doesn't do it itself.
  assert.deepEqual(await page.evaluate(() => [window.__appExits, window.__fsExit]), [1, 0]);
  assert.deepEqual((await sent(page, 'fullVideoExitRequest')).map(m => m.why), ['swipe']);
  assert.equal(await page.evaluate(() => document.getElementById('v').dataset.sgFull), undefined);
  assert.equal(await page.evaluate(() => window.scrollY), 0, 'nothing scrolled under the full-screen video');
  // And again, leaving with a swipe down.
  await drag(page, [200, 200], [200, 400]);
  await drag(page, [200, 300], [200, 700]);
  const s = await fv(page);
  assert.deepEqual([s.r8, s.exits, await page.evaluate(() => window.__appExits), await page.evaluate(() => window.__fsExit)], [2, 2, 2, 0]);
  // Back in the app ends the full-screen view itself: counted as a return too.
  await drag(page, [200, 200], [200, 400]);
  await page.evaluate(() => { window.__fsEl = null; document.dispatchEvent(new Event('fullscreenchange')); });
  assert.equal((await fv(page)).exits, 3);
});

test('R8: no full screen on Home or in DMs', async () => {
  for (const path of ['/', '/direct/t/123/']) {
    const page = await openPage('https://www.instagram.com' + path, POST);
    await stubFullscreen(page);
    await drag(page, [200, 200], [200, 400]);
    assert.deepEqual(await page.evaluate(() => window.__fs), [], path);
  }
});

test('R8: the browser refusing full screen is counted, and the next swipe tries again', async () => {
  const page = await openPage('https://www.instagram.com/p/ABCDEFG/', POST);
  await page.evaluate(() => {
    window.__tries = 0;
    HTMLElement.prototype.requestFullscreen = function () { window.__tries++; return Promise.reject(new TypeError('denied')); };
  });
  await drag(page, [200, 200], [200, 400]);
  await page.waitForTimeout(50);
  await drag(page, [200, 200], [200, 400]);
  await page.waitForTimeout(50);
  const s = await fv(page);
  assert.deepEqual([await page.evaluate(() => window.__tries), s.r8, s.r8Failed], [2, 0, 2]);
});

test('R8: a sheet or dialog over the video keeps its own swipes (its list scrolls; no full screen)', async () => {
  const page = await openPage('https://www.instagram.com/p/ABCDEFG/', POST);
  await stubFullscreen(page);
  // Instagram's Share sheet: a dialog drawn over the post, its friend list scrolled down.
  await page.evaluate(() => {
    const d = document.createElement('div');
    d.setAttribute('role', 'dialog');
    d.style.cssText = 'position:fixed;left:0;right:0;top:100px;height:600px;background:#fff';
    d.innerHTML = '<div id="list" style="height:600px;overflow-y:auto"><div style="height:3000px"></div></div>';
    document.body.appendChild(d);
    document.getElementById('list').scrollTop = 662;
  });
  await drag(page, [200, 250], [200, 450]);
  assert.deepEqual(await page.evaluate(() => window.__fs), []);
  assert.ok(await page.evaluate(() => document.getElementById('list').scrollTop) < 600, 'the list scrolled back up');
  // At the top of its list, a swipe down there (closing the sheet) is the sheet's too.
  await page.evaluate(() => { document.getElementById('list').scrollTop = 0; });
  await drag(page, [200, 250], [200, 450]);
  assert.deepEqual(await page.evaluate(() => window.__fs), []);
  // The same over a layer that isn't marked as a dialog.
  await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]');
    d.removeAttribute('role');
    document.getElementById('list').scrollTop = 900;
  });
  await drag(page, [200, 250], [200, 450]);
  assert.deepEqual(await page.evaluate(() => window.__fs), []);
  assert.ok(await page.evaluate(() => document.getElementById('list').scrollTop) < 850);
  // Gone again, the video's own swipe works.
  await page.evaluate(() => document.querySelector('#list').parentElement.remove());
  await drag(page, [200, 250], [200, 450]);
  assert.deepEqual(await page.evaluate(() => window.__fs), ['page:v']);
  assert.equal((await fv(page)).r8, 1);
});

test('R8: dragging a Reel\'s comments sheet down by its header closes the sheet only', async () => {
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body style="margin:0;overflow:hidden">
    <div id="mount"><main><div style="position:relative;width:412px;height:915px">
      <video id="v" muted playsinline style="width:412px;height:915px;display:block;background:#222"></video>
      <div style="position:absolute;inset:0"></div></div></main></div>
    <div id="sheet" role="dialog" aria-modal="true" style="position:fixed;left:0;right:0;bottom:0;height:500px;background:#fff">
      <div id="hdr" style="height:40px"></div>
      <div style="height:460px;overflow-y:auto"><div style="height:2000px"></div></div></div>
    </body></html>`;
  const page = await openPage('https://www.instagram.com/reel/ABCDEFG/', html);
  await stubFullscreen(page);
  await drag(page, [200, 430], [200, 820]);
  assert.deepEqual(await page.evaluate(() => window.__fs), []);
  await drag(page, [200, 600], [200, 820]);          // on its list, at the top
  assert.deepEqual(await page.evaluate(() => window.__fs), []);
  // Above the sheet, on the video itself: full screen.
  await drag(page, [200, 100], [200, 300]);
  assert.deepEqual(await page.evaluate(() => window.__fs), ['page:v']);
});

test('R8: Instagram nesting the video deep inside its tap layer\'s box still works', async () => {
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body style="margin:0">
    <main><article><header style="height:60px">friend</header>
      <div style="position:relative;width:412px;height:520px"><div><div><div><div><div><div>
        <video id="v" muted playsinline style="width:412px;height:500px;display:block;background:#222"></video>
      </div></div></div></div></div></div>
      <div role="button" style="position:absolute;left:0;top:0;width:412px;height:500px"><div style="height:500px"></div></div></div>
      <div style="height:2400px">a long description</div></article></main></body></html>`;
  const page = await openPage('https://www.instagram.com/p/ABCDEFG/', html);
  await stubFullscreen(page);
  await drag(page, [200, 250], [200, 450]);
  assert.deepEqual(await page.evaluate(() => window.__fs), ['page:v']);
});

test('R8: a letterboxed video under a full-screen tap layer still works', async () => {
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body style="margin:0;overflow:hidden">
    <div id="mount"><main><div style="position:relative;width:412px;height:915px;background:#000">
      <div style="padding-top:340px"><video id="v" muted playsinline style="width:412px;height:232px;display:block;background:#222"></video></div>
      <div role="button" style="position:absolute;inset:0"></div></div></main></div></body></html>`;
  const page = await openPage('https://www.instagram.com/reel/ABCDEFG/', html);
  await stubFullscreen(page);
  await drag(page, [200, 400], [200, 560]);
  assert.deepEqual(await page.evaluate(() => window.__fs), ['page:v']);
});

test('R8: a landscape video that played muted in the post gets its sound in full screen', async () => {
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body style="margin:0">
    <main><article><header style="height:60px">friend</header>
      <div style="position:relative;width:412px;height:232px">
        <video id="v" muted playsinline style="width:412px;height:232px;display:block;background:#222"></video>
        <div style="position:absolute;inset:0"></div></div>
      <div style="height:2400px">a long description</div></article></main></body></html>`;
  const page = await openPage('https://www.instagram.com/p/ABCDEFG/', html);
  await stubFullscreen(page);
  await page.evaluate(() => {
    const v = document.getElementById('v');
    Object.defineProperty(v, 'paused', { configurable: true, get: () => false });
    // The full-screen view fills the screen with the video.
    const req = HTMLElement.prototype.requestFullscreen;
    HTMLElement.prototype.requestFullscreen = function () {
      this.style.cssText = 'position:fixed;inset:0;width:412px;height:915px';
      return req.call(this);
    };
  });
  assert.equal(await page.evaluate(() => document.getElementById('v').muted), true, 'muted while small');
  await drag(page, [200, 120], [200, 330]);
  assert.deepEqual(await page.evaluate(() => window.__fs), ['page:v']);
  await page.waitForFunction(() => document.getElementById('v').muted === false, null, { timeout: 2000 });
});

/* ---------------- A12: no blocking touch listeners ---------------- */

// Records the page script's touch listeners on window and document that can hold a scroll.
function watchListeners() {
  const live = new Map();
  window.__blocking = () => Array.from(live.values()).filter(x => x.count > 0 && !x.passive).map(x => x.type);
  const key = (t, type, fn, capture) => (t === window ? 'w' : 'd') + type + (capture ? 1 : 0) + ':' + (fn.__id || (fn.__id = Math.random()));
  const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if ((this === window || this === document) && /^(touch|wheel)/.test(type) && fn) {
      const capture = typeof opts === 'boolean' ? opts : !!(opts && opts.capture);
      const passive = typeof opts === 'object' && opts && opts.passive === true;
      const k = key(this, type, fn, capture);
      if (!live.has(k)) live.set(k, { type: type, passive: passive, count: 1 });
    }
    return add.apply(this, arguments);
  };
  EventTarget.prototype.removeEventListener = function (type, fn, opts) {
    if ((this === window || this === document) && fn) {
      const capture = typeof opts === 'boolean' ? opts : !!(opts && opts.capture);
      live.delete(key(this, type, fn, capture));
    }
    return remove.apply(this, arguments);
  };
}

test('A12: no blocking touch listener on Home, in DMs or in Stories; posts have one (R8 uses it)', async () => {
  const page = await openPage('https://www.instagram.com/', POST, { init: watchListeners });
  assert.deepEqual(await page.evaluate(() => window.__blocking()), []);
  for (const [path, want] of [['/p/ABCDEFG/', ['touchmove']], ['/direct/t/1/', []], ['/stories/friend/424242/', []],
    ['/reel/ABCDEFG/', ['touchmove']], ['/', []]]) {
    await page.evaluate(p => history.pushState(null, '', p), path);
    assert.deepEqual(await page.evaluate(() => window.__blocking()), want, path);
  }
});

/* ---------------- R9: a Reel shared to a Story ---------------- */

// A Story viewer modelled on Instagram's mobile one (PolarisMobileStoryEventZone):
// a press pauses; on lift a quick swipe up opens the reply box, down closes,
// sideways changes person. Its handlers sit on the app's root, like React's.
const STORY = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body style="margin:0;background:#000">
  <div id="mount"><section id="viewer" style="position:fixed;inset:0">
    <img id="media" src="/story1.jpg" style="position:absolute;inset:0;width:412px;height:915px">
    <div id="zone" role="button" style="position:absolute;inset:0"></div>
    <textarea id="reply" style="position:absolute;bottom:0;left:0;width:300px;height:40px"></textarea>
  </section></div>
  <script>
    const S = window.__story = { paused: false, reply: 0, closed: 0, next: 0, prev: 0, ends: 0, start: null };
    const root = document.getElementById('mount');
    root.addEventListener('touchstart', e => {
      if (!S.start) S.start = { t: Date.now(), x: e.touches[0].clientX, y: e.touches[0].clientY };
      S.paused = true;
    });
    root.addEventListener('touchend', e => {
      S.ends++;
      if (e.touches.length === 0) S.paused = false;
      const s = S.start; S.start = null;
      if (!s || Date.now() - s.t > 500) return;
      const dx = e.changedTouches[0].clientX - s.x, dy = e.changedTouches[0].clientY - s.y;
      if (Math.abs(dy) > 50 && Math.abs(dx) < 100) { if (dy < 0) S.reply++; else S.closed++; }
      else if (Math.abs(dy) < 100 && dx > 50) S.prev++;
      else if (Math.abs(dy) < 100 && dx < -50) S.next++;
    });
  </script></body></html>`;

function storyPayload(items) {
  return { data: { xdt_api__v1__feed__reels_media: { reels_media: [{ id: '777', items: items }] } } };
}
function sharingItem(pk, sticker) {
  return media('STORYX' + pk, user('friend', true), { pk: pk, id: pk + '_777', story_feed_media: sticker ? [sticker] : undefined });
}
const REEL_STICKER = { x: 0.5, y: 0.5, width: 0.6, height: 0.5, rotation: 0, media_code: 'REELCODE1', product_type: 'clips', id: 'sticker1' };
const reelInfo = () => ({ body: { status: 'ok', items: [media('REELCODE1', user('creator'), {
  product_type: 'clips', video_versions: [{ url: 'https://scontent.cdninstagram.com/v/t50/reel-720.mp4', width: 720, height: 1280 }] })] } });

async function openStory(items, opts = {}) {
  const page = await openPage('https://www.instagram.com/stories/friend/424242/', opts.html || STORY,
    { api: { '/api/v1/media/*': opts.info || reelInfo }, video: opts.video });
  await page.evaluate(p => JSON.parse(JSON.stringify(p)), storyPayload(items));
  await stubFullscreen(page, true);
  return page;
}

test('R9: a swipe up on a Story that shares a Reel plays the Reel full screen; the Story waits', async () => {
  const page = await openStory([sharingItem('424242', REEL_STICKER)]);
  await drag(page, [200, 600], [205, 250], { steps: 4 });
  await page.waitForFunction(() => { const v = document.querySelector('#sg-reel video'); return v && v.getAttribute('src'); });
  const r = await page.evaluate(() => {
    const box = document.getElementById('sg-reel');
    const st = getComputedStyle(box);
    return { parent: box.parentElement.tagName, src: box.querySelector('video').getAttribute('src'),
      fixed: st.position, z: st.zIndex, w: box.getBoundingClientRect().width, h: box.getBoundingClientRect().height,
      story: Object.assign({}, window.__story), fsRequests: window.__fs.length, fsEl: document.fullscreenElement.tagName };
  });
  assert.equal(r.parent, 'BODY', 'inside Instagram\'s own full screen');
  assert.equal(r.src, 'https://scontent.cdninstagram.com/v/t50/reel-720.mp4');
  assert.deepEqual([r.fixed, r.z, r.w, r.h], ['fixed', '2147483647', 412, 915]);
  assert.equal(r.story.reply, 0, 'Instagram\'s swipe up (the reply box) did not happen');
  assert.equal(r.story.paused, true, 'the Story is still pressed, so it waits');
  assert.deepEqual([r.fsRequests, r.fsEl], [0, 'BODY'], 'no second full-screen request');
  assert.deepEqual((await sent(page, 'fullVideo')).map(m => m.on), [true]);
  assert.equal(page.hits['/api/v1/media/*'], 1);
  // A swipe down on the Reel returns; Instagram's Story is let go and continues.
  await drag(page, [200, 300], [200, 650], { steps: 4 });
  const after = await page.evaluate(() => ({ box: !!document.getElementById('sg-reel'), story: Object.assign({}, window.__story), path: location.pathname }));
  assert.equal(after.box, false);
  assert.deepEqual([after.story.paused, after.story.closed, after.story.reply, after.path], [false, 0, 0, '/stories/friend/424242/']);
  assert.deepEqual((await sent(page, 'fullVideo')).map(m => m.on), [true, false]);
  const s = await fv(page);
  assert.deepEqual([s.r9, s.exits, s.r9Moved], [1, 1, 0]);
  // The Story's own gestures work again straight away.
  await drag(page, [100, 500], [330, 510], { steps: 3 });
  assert.equal(await page.evaluate(() => window.__story.prev), 1);
});

test('B25: R9\'s Reel layer holds the page still with a blocking touchmove, never with touch-action', async () => {
  const page = await openStory([sharingItem('424242', REEL_STICKER)]);
  await drag(page, [200, 600], [205, 250], { steps: 4 });
  await page.waitForFunction(() => document.getElementById('sg-reel'));
  // A touch-action surface touched while the web engine believes a finger is
  // down switches vertical scrolling off for good; a held-still move doesn't.
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('sg-reel')).touchAction), 'auto');
  await page.evaluate(() => {
    window.__boxMoves = [];
    document.getElementById('sg-reel').addEventListener('touchmove', e => window.__boxMoves.push(e.defaultPrevented), { passive: true });
  });
  await drag(page, [100, 500], [300, 530], { steps: 5 });          // sideways: the layer stays
  const moves = await page.evaluate(() => window.__boxMoves);
  assert.ok(moves.length >= 4 && moves.every(Boolean), JSON.stringify(moves));
  assert.equal(await page.evaluate(() => !!document.getElementById('sg-reel')), true);
});

test('B25: the lift that opens R9\'s Reel still counts in the page\'s touch bookkeeping (no false lost end)', async () => {
  const page = await openStory([sharingItem('424242', REEL_STICKER)]);
  const seq = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__sg.stats.b25.touchSeq)));
  for (let i = 0; i < 2; i++) {
    await drag(page, [200, 600], [205, 250], { steps: 4 });        // opens the Reel
    await page.waitForFunction(() => document.getElementById('sg-reel'));
    await drag(page, [200, 300], [200, 650], { steps: 4 });        // back to the Story
    assert.equal(await page.evaluate(() => !!document.getElementById('sg-reel')), false);
  }
  const s = await seq();
  assert.deepEqual([s.starts, s.ends, s.orphans, s.orphanLast], [4, 4, 0, null], JSON.stringify(s));
});

test('R9: Back (from the app) and a swipe up also return; a tap pauses the Reel', async () => {
  const page = await openStory([sharingItem('424242', REEL_STICKER)]);
  await drag(page, [200, 600], [200, 300], { steps: 4 });
  await page.waitForFunction(() => { const v = document.querySelector('#sg-reel video'); return v && v.getAttribute('src'); });
  await page.evaluate(() => {
    const v = document.querySelector('#sg-reel video');
    window.__rp = 0; window.__rpaused = false;
    Object.defineProperty(v, 'paused', { configurable: true, get: () => window.__rpaused });
    v.pause = () => { window.__rp++; window.__rpaused = true; };
  });
  await tapAt(page, 200, 450);
  assert.equal(await page.evaluate(() => window.__rp), 1);
  assert.equal(await page.evaluate(() => window.__story.ends), 0, 'the tap stayed on the Reel');
  await page.evaluate(() => window.__sg.onNative({ type: 'fullVideoExit' }));
  assert.equal(await page.evaluate(() => !!document.getElementById('sg-reel')), false);
  assert.equal(await page.evaluate(() => window.__story.paused), false);
  // Indexed now: the second time needs no request.
  await drag(page, [200, 600], [200, 300], { steps: 4 });
  await page.waitForFunction(() => { const v = document.querySelector('#sg-reel video'); return v && v.getAttribute('src'); });
  assert.equal(page.hits['/api/v1/media/*'], 1);
  await drag(page, [200, 700], [200, 250], { steps: 4 });
  assert.equal(await page.evaluate(() => !!document.getElementById('sg-reel')), false);
  const s = await fv(page);
  assert.deepEqual([s.r9, s.exits], [2, 2]);
});

test('R9: Stories without a shared Reel keep Instagram\'s own swipes', async () => {
  const page = await openStory([sharingItem('424242', null)]);
  await drag(page, [200, 600], [200, 300], { steps: 4 });            // up: Instagram's reply box
  await drag(page, [200, 300], [200, 650], { steps: 4 });            // down: Instagram closes
  const st = await page.evaluate(() => window.__story);
  assert.deepEqual([st.reply, st.closed], [1, 1]);
  assert.equal(await page.evaluate(() => !!document.getElementById('sg-reel')), false);
  assert.equal((await fv(page)).r9, 0);
  assert.deepEqual(await sent(page, 'fullVideo'), []);
});

test('R9: a swipe down, a shared photo post, or a swipe from the reply box never opens a Reel', async () => {
  const photo = Object.assign({}, REEL_STICKER, { media_code: 'PHOTO1234', product_type: 'feed' });
  let page = await openStory([sharingItem('424242', REEL_STICKER)]);
  await drag(page, [200, 300], [200, 650], { steps: 4 });
  assert.equal(await page.evaluate(() => window.__story.closed), 1);
  await drag(page, [100, 895], [100, 500], { steps: 4 });            // starts on the reply box
  assert.equal(await page.evaluate(() => !!document.getElementById('sg-reel')), false);
  page = await openStory([sharingItem('424242', photo)]);
  await drag(page, [200, 600], [200, 300], { steps: 4 });
  assert.equal(await page.evaluate(() => !!document.getElementById('sg-reel')), false);
  assert.equal(await page.evaluate(() => window.__story.reply), 1);
});

test('R9: a Reel that can\'t be found says so and the Story continues', async () => {
  const page = await openStory([sharingItem('424242', REEL_STICKER)], { info: () => ({ status: 404, body: {} }) });
  await drag(page, [200, 600], [200, 300], { steps: 4 });
  const [t] = await waitSent(page, 'toast');
  assert.match(t.message, /Reel couldn.t be loaded/);
  assert.equal(await page.evaluate(() => !!document.getElementById('sg-reel')), false);
  assert.equal(await page.evaluate(() => window.__story.paused), false);
  assert.deepEqual((await sent(page, 'fullVideo')).map(m => m.on), [true, false]);
  assert.equal((await fv(page)).r9Missing, 1);
});

test('R9: a Story video still playing under the Reel is paused there and played again after', async () => {
  const page = await openStory([sharingItem('424242', REEL_STICKER)]);
  await page.evaluate(() => {
    const v = document.createElement('video');
    v.id = 'sv';
    v.style.cssText = 'position:absolute;inset:0;width:412px;height:915px';
    document.getElementById('viewer').insertBefore(v, document.getElementById('zone'));
    window.__svPaused = false; window.__svPlays = 0;
    Object.defineProperty(v, 'paused', { configurable: true, get: () => window.__svPaused });
    v.pause = () => { window.__svPaused = true; };
    v.play = () => { window.__svPlays++; window.__svPaused = false; return Promise.resolve(); };
  });
  await drag(page, [200, 600], [200, 300], { steps: 4 });
  await page.waitForFunction(() => window.__svPaused === true);
  await page.evaluate(() => window.__sg.onNative({ type: 'fullVideoExit' }));
  await page.waitForFunction(() => window.__svPlays === 1);
});

test('R9: if Instagram\'s full screen ends under the Reel (the Story closes), the Reel goes too', async () => {
  const page = await openStory([sharingItem('424242', REEL_STICKER)]);
  await drag(page, [200, 600], [200, 300], { steps: 4 });
  await page.waitForFunction(() => !!document.getElementById('sg-reel'));
  await page.evaluate(() => { window.__fsEl = null; document.dispatchEvent(new Event('fullscreenchange')); });
  assert.equal(await page.evaluate(() => !!document.getElementById('sg-reel')), false);
  assert.deepEqual((await sent(page, 'fullVideo')).map(m => m.on), [true, false]);
});

test('R9: shared Reels are remembered by Story item; diagnostics carry counts only', async () => {
  const page = await openStory([sharingItem('424242', REEL_STICKER)]);
  await drag(page, [200, 600], [200, 300], { steps: 4 });
  await page.waitForFunction(() => { const v = document.querySelector('#sg-reel video'); return v && v.getAttribute('src'); });
  const d = await page.evaluate(() => JSON.stringify(window.__sg.stats.diag));
  assert.doesNotMatch(d, /REELCODE1|friend|creator|cdninstagram|424242/);
});

// Instagram's real layering (PolarisMobileStoryEventZone): the press zone has
// the touch handlers; the tappable stickers are a sibling layer above it,
// pointer-events none, each sticker auto. A photo moves on after its timer
// unless the zone is pressed.
const STICKER_STORY = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body style="margin:0;background:#000">
  <div id="mount"><section id="viewer" style="position:fixed;inset:0">
    <img id="media" src="/story1.jpg" style="position:absolute;inset:0;width:412px;height:915px">
    <div style="position:absolute;inset:0">
      <div id="zone" role="button" style="position:absolute;inset:0">
        <button id="prev" style="position:absolute;left:0;top:0;width:120px;height:915px;opacity:0"></button>
        <button id="next" style="position:absolute;right:0;top:0;width:292px;height:915px;opacity:0"></button>
      </div>
      <div id="tappables" style="position:absolute;inset:0;pointer-events:none">
        <div><div id="sticker" role="button" style="position:absolute;left:80px;top:450px;width:250px;height:300px;pointer-events:auto;z-index:1;background:#555">
          <span id="card" style="display:block;height:300px">Watch Reel</span></div></div>
      </div>
    </div>
  </section></div>
  <script>
    const S = window.__story = { paused: false, elapsed: 0, item: 1, stickerTouches: 0 };
    const zone = document.getElementById('zone');
    zone.addEventListener('touchstart', e => { S.paused = true; S.x = e.touches[0].clientX; });
    zone.addEventListener('touchend', e => { if (e.touches.length === 0) S.paused = false; });
    document.getElementById('sticker').addEventListener('touchstart', () => S.stickerTouches++);
    setInterval(() => {
      if (S.paused) return;
      S.elapsed += 100;
      if (S.elapsed >= 1200) { S.elapsed = 0; S.item++; history.pushState(null, '', '/stories/friend/42424' + (S.item + 1) + '/'); }
    }, 100);
  </script></body></html>`;

test('R9: a swipe that starts on the Reel card presses the Story itself, so it waits', async () => {
  const page = await openStory([sharingItem('424242', REEL_STICKER)], { html: STICKER_STORY });
  await page.evaluate(() => { window.__story.elapsed = 0; });
  await drag(page, [200, 600], [205, 250], { steps: 4 });
  assert.equal(await page.evaluate(() => window.__story.stickerTouches), 1, 'the finger was on the card');
  await page.waitForFunction(() => { const v = document.querySelector('#sg-reel video'); return v && v.getAttribute('src'); });
  assert.equal(await page.evaluate(() => window.__story.paused), true, 'the Story is pressed at once');
  await page.waitForTimeout(1600);                   // longer than the photo's own time
  const mid = await page.evaluate(() => ({ paused: window.__story.paused, item: window.__story.item, path: location.pathname }));
  assert.deepEqual(mid, { paused: true, item: 1, path: '/stories/friend/424242/' });
  await drag(page, [200, 300], [200, 650], { steps: 4 });
  assert.equal(await page.evaluate(() => !!document.getElementById('sg-reel')), false);
  assert.equal(await page.evaluate(() => window.__story.paused), false, 'let go: the Story continues');
  const s = await fv(page);
  assert.deepEqual([s.r9, s.r9Moved, s.r9Pressed], [1, 0, 1]);
});

test('R9: a swipe that starts on the Story itself is left to Instagram\'s own press', async () => {
  const page = await openStory([sharingItem('424242', REEL_STICKER)], { html: STICKER_STORY });
  await drag(page, [200, 850], [205, 450], { steps: 4 });
  await page.waitForFunction(() => !!document.getElementById('sg-reel'));
  assert.equal(await page.evaluate(() => window.__story.paused), true);
  await page.evaluate(() => window.__sg.onNative({ type: 'fullVideoExit' }));
  assert.equal(await page.evaluate(() => window.__story.paused), false);
  assert.equal((await fv(page)).r9Pressed, 0);
});

test('R9: your own mute in Stories carries over to the Reel', async () => {
  const page = await openStory([sharingItem('424242', REEL_STICKER)]);
  await page.evaluate(() => {
    const v = document.createElement('video');
    v.id = 'sv';
    v.style.cssText = 'position:absolute;inset:0;width:412px;height:915px';
    document.getElementById('viewer').insertBefore(v, document.getElementById('zone'));
    const b = document.createElement('div');
    b.setAttribute('role', 'button');
    b.style.cssText = 'position:absolute;top:20px;right:20px;width:44px;height:44px';
    b.innerHTML = '<svg aria-label="Audio is playing" width="44" height="44"></svg>';
    b.addEventListener('click', () => { v.muted = !v.muted; });
    document.getElementById('viewer').appendChild(b);
  });
  await tapAt(page, 390, 40);
  assert.equal(await page.evaluate(() => document.getElementById('sv').muted), true);
  await drag(page, [200, 600], [205, 250], { steps: 4 });
  await page.waitForFunction(() => { const v = document.querySelector('#sg-reel video'); return v && v.getAttribute('src'); });
  assert.equal(await page.evaluate(() => document.querySelector('#sg-reel video').muted), true);
});

test('R9: a Reel that won\'t load closes with a message; an old link is renewed once', async () => {
  // The link fails: the layer goes, the Story continues.
  let page = await openStory([sharingItem('424242', REEL_STICKER)], { video: () => 403 });
  await drag(page, [200, 600], [205, 250], { steps: 4 });
  const [t] = await waitSent(page, 'toast');
  assert.match(t.message, /Reel couldn.t be loaded/);
  assert.equal(await page.evaluate(() => !!document.getElementById('sg-reel')), false);
  assert.equal(await page.evaluate(() => window.__story.paused), false);
  assert.equal((await fv(page)).r9Missing, 1);
  assert.equal(page.hits['/api/v1/media/*'], 1, 'a fresh lookup is not repeated');
  // An expired link from an earlier page: asked for afresh, and it plays.
  page = await openStory([sharingItem('424242', REEL_STICKER)], { video: u => (/old/.test(u.pathname) ? 403 : 200) });
  await page.evaluate(p => JSON.parse(JSON.stringify(p)), { items: [media('REELCODE1', user('creator'), {
    product_type: 'clips', video_versions: [{ url: 'https://scontent.cdninstagram.com/v/t50/reel-old.mp4', width: 720, height: 1280 }] })] });
  await drag(page, [200, 600], [205, 250], { steps: 4 });
  await page.waitForFunction(() => { const v = document.querySelector('#sg-reel video'); return v && /reel-720/.test(v.getAttribute('src') || ''); });
  assert.equal(page.hits['/api/v1/media/*'], 1);
  assert.equal(await page.evaluate(() => !!document.getElementById('sg-reel')), true);
  assert.equal((await fv(page)).r9Missing, 0);
  assert.deepEqual(await sent(page, 'toast'), []);
});

/* ---------------- B19: Story swipes ---------------- */

test('B19: a swipe to the next person is timed to the new Story showing', async () => {
  const page = await openStory([sharingItem('424242', null)]);
  await page.evaluate(() => {
    // Instagram changes the address, then draws the next person's Story.
    document.getElementById('mount').addEventListener('touchend', () => {
      if (window.__story.next || window.__story.prev) {
        setTimeout(() => history.pushState(null, '', '/stories/other/525252/'), 80);
        setTimeout(() => { document.getElementById('media').src = '/story2.jpg'; }, 220);
      }
    });
  });
  await drag(page, [330, 500], [100, 510], { steps: 3 });
  await page.waitForFunction(() => window.__sg.stats.diag.storySwitch.length === 1);
  const [e] = await page.evaluate(() => window.__sg.stats.diag.storySwitch);
  assert.equal(e.dir, 'next');
  assert.ok(e.urlMs >= 60 && e.urlMs < 1000, JSON.stringify(e));
  assert.ok(e.ms >= 200 && e.ms < 1500, JSON.stringify(e));
  // A swipe back with no one before: nothing to time, nothing counted.
  await drag(page, [100, 500], [330, 510], { steps: 3 });
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__sg.stats.diag.storySwitch.length), 1);
});

test('B19: a cancelled touch lets go of the Story (it continues and the next swipe works)', async () => {
  const page = await openStory([sharingItem('424242', null)]);
  await drag(page, [200, 500], [200, 505], { steps: 1, cancel: true });
  const st = await page.evaluate(() => Object.assign({}, window.__story));
  assert.deepEqual([st.paused, st.start], [false, null]);
  assert.equal(await page.evaluate(() => window.__sg.stats.diag.storyCancels), 1);
  await drag(page, [330, 500], [100, 510], { steps: 3 });
  assert.equal(await page.evaluate(() => window.__story.next), 1);
});

test('B19: the app\'s own hold (menu, screenshot, zoom) keeps the Story paused through the focus-loss cancel', async () => {
  const page = await openStory([sharingItem('424242', null)]);
  const c = await page.context().newCDPSession(page);
  // The app says it is holding, then presses the middle of the page.
  await page.evaluate(() => window.__sg.onNative({ type: 'appHold', on: true }));
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 206, y: 457 }] });
  assert.equal(await page.evaluate(() => window.__story.paused), true);
  // The ⋮ dialog (or the notification shade) takes focus: WebView cancels the touch.
  await c.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await page.waitForTimeout(120);
  let st = await page.evaluate(() => Object.assign({}, window.__story));
  assert.deepEqual([st.paused, st.ends], [true, 0], 'the Story stays paused under the menu');
  assert.equal(await page.evaluate(() => window.__sg.stats.diag.storyCancels), 0);
  // The app lets go (menu closed, screenshot mode left, zoomed out): the Story continues.
  await page.evaluate(() => window.__sg.onNative({ type: 'appHold', on: false }));
  st = await page.evaluate(() => Object.assign({}, window.__story));
  assert.deepEqual([st.paused, st.ends, st.start, st.next, st.prev], [false, 1, null, 0, 0]);
  assert.equal(await page.evaluate(() => window.__sg.stats.diag.storyCancels), 1);
  // A second release changes nothing.
  await page.evaluate(() => window.__sg.onNative({ type: 'appHold', on: false }));
  assert.equal(await page.evaluate(() => window.__story.ends), 1);
  // The release arriving before the hold's own cancel (a pinch that didn't
  // zoom): the Story is let go once.
  await page.evaluate(() => window.__sg.onNative({ type: 'appHold', on: true }));
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 206, y: 457 }] });
  await page.evaluate(() => window.__sg.onNative({ type: 'appHold', on: false }));
  await c.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await c.detach();
  await page.waitForTimeout(60);
  st = await page.evaluate(() => Object.assign({}, window.__story));
  assert.deepEqual([st.paused, st.ends, st.start], [false, 2, null]);
  assert.equal(await page.evaluate(() => window.__sg.stats.diag.storyCancels), 2);
  // Unheld cancels still let go, and swipes work again.
  await drag(page, [200, 500], [200, 505], { steps: 1, cancel: true });
  assert.deepEqual(await page.evaluate(() => [window.__story.paused, window.__sg.stats.diag.storyCancels]), [false, 3]);
  await drag(page, [330, 500], [100, 510], { steps: 3 });
  assert.equal(await page.evaluate(() => window.__story.next), 1);
});

test('B19: in Stories the banner scan is skipped; Story download, sound and the zoom hold still work', async () => {
  const story = media('STORY01', user('friend', true), { pk: '424242', video_versions: [
    { url: 'https://scontent.cdninstagram.com/v/t50/story-high.mp4', width: 720, height: 1280 }] });
  const html = `<!doctype html><html><head><script>
      window.__textWalks = 0;
      const nn = TreeWalker.prototype.nextNode;
      TreeWalker.prototype.nextNode = function () { if (this.whatToShow === NodeFilter.SHOW_TEXT) window.__textWalks++; return nn.call(this); };
    </script></head><body style="margin:0"><main>${'<p>post text</p>'.repeat(200)}</main>
    <section id="viewer" style="position:fixed;inset:0"><video id="sv" src="blob:https://www.instagram.com/x" style="width:412px;height:732px"></video>
    <div role="button" id="mute" style="position:absolute;top:20px;right:20px;width:40px;height:40px"><svg aria-label="Audio is muted"></svg></div></section>
    <script>document.getElementById('mute').addEventListener('click',()=>{const v=document.getElementById('sv');v.muted=!v.muted;window.__toggled=(window.__toggled||0)+1;});</script>
    </body></html>`;
  const page = await openPage('https://www.instagram.com/stories/friend/424242/', html);
  await page.evaluate(p => JSON.parse(JSON.stringify(p)), { data: { xdt_api__v1__feed__reels_media: { reels_media: [{ items: [story] }] } } });
  await page.evaluate(() => new Promise(done => {
    window.__textWalks = 0;
    let k = 0;
    const id = setInterval(() => { document.getElementById('viewer').appendChild(document.createElement('i')); if (++k >= 8) { clearInterval(id); setTimeout(done, 1300); } }, 150);
  }));
  assert.equal(await page.evaluate(() => window.__textWalks), 0, 'no whole-page text walk in Stories');
  // Download the Story on screen.
  await page.evaluate(() => { window.__sg.onNative({ type: 'menu' }); window.__sg.onNative({ type: 'download' }); });
  const [dl] = await waitSent(page, 'download');
  assert.equal(dl.items[0].url, 'https://scontent.cdninstagram.com/v/t50/story-high.mp4');
  // Sound on, with Instagram's own toggle.
  await page.evaluate(() => { const v = document.getElementById('sv'); v.muted = true; v.dispatchEvent(new Event('play')); });
  await page.waitForFunction(() => window.__toggled === 1);
  // The zoom hold loops the Story's video and lets go afterwards.
  await page.evaluate(() => window.__sg.onNative({ type: 'storyHold', on: true }));
  await page.waitForFunction(() => document.getElementById('sv').loop === true);
  await page.evaluate(() => window.__sg.onNative({ type: 'storyHold', on: false }));
  assert.equal(await page.evaluate(() => document.getElementById('sv').loop), false);
  // On Home the banner scan still runs.
  await page.evaluate(() => { history.pushState(null, '', '/'); window.__textWalks = 0; document.body.appendChild(document.createElement('div')); });
  await page.waitForFunction(() => window.__textWalks > 0, null, { timeout: 3000 });
});
