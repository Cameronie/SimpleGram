// B25: scrolling stopped everywhere until a restart. Browser tests for the page
// side of the fix: R8's bookkeeping race and its safe exit (the app leaves full
// screen the Back way), and the dead-drag detector behind the self-repair.
//
// The real failure lives in the web engine's touch state and can't be made in
// a desktop browser. The stand-in "dead" page puts every drag on a layer that
// doesn't pan vertically inside a closed shadow root: drags don't scroll,
// nothing prevents them, and every touch-action the page script can see allows
// vertical panning. Touches are real ones from the browser (Chrome DevTools
// input), so they are trusted and scroll the page like a finger would.
// Full screen is stubbed. Nothing reaches Instagram.
//
// Run: NODE_PATH=/opt/node-tools/node_modules node --test tests/*.test.cjs
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { SCRIPT, ME, sent, PNG } = require('./helpers.cjs');
const { chromium } = require('playwright');

let browser;
before(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { await browser.close(); });

async function openPage(url, html) {
  const context = await browser.newContext({
    viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true,
  });
  const page = await context.newPage();
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.pathname === new URL(url).pathname) return route.fulfill({ status: 200, contentType: 'text/html', body: html });
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

const cdp = page => page.context().newCDPSession(page);
// A finger: down at `from`, moved in steps, lifted at `to`.
async function drag(page, from, to, { steps = 8, settle = 60 } = {}) {
  const c = await cdp(page);
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from[0], y: from[1] }] });
  for (let i = 1; i <= steps; i++) {
    await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{
      x: from[0] + (to[0] - from[0]) * i / steps, y: from[1] + (to[1] - from[1]) * i / steps }] });
  }
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await c.detach();
  await page.waitForTimeout(settle);
}
// A drag up the middle of the page, then long enough for the detector to judge it.
const DRAG_UP = [[200, 800], [200, 600]];
async function deadDrag(page, from = DRAG_UP[0], to = DRAG_UP[1]) {
  await drag(page, from, to, { settle: 950 });
}
const b25 = page => page.evaluate(() => JSON.parse(JSON.stringify(window.__sg.stats.b25)));
const stuckPosts = page => sent(page, 'scrollStuck');

/* ---------------- The dead-drag detector ---------------- */

const DEAD = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body style="margin:0">
  <div id="tall" style="height:4000px;background:linear-gradient(#fff,#ccd)">a long page</div>
  <div id="dead"></div>
  <div id="panx" style="position:fixed;left:0;top:90px;width:412px;height:100px;touch-action:pan-x;z-index:5">a pan-x strip</div>
  <div id="none" style="position:fixed;left:0;top:200px;width:412px;height:100px;touch-action:none;z-index:5">a slider</div>
  <div id="hold" style="position:fixed;left:0;top:310px;width:412px;height:100px;z-index:5">a drag handle</div>
  <p id="text" style="position:fixed;left:0;top:420px;width:412px;margin:0;z-index:5">some words to select</p>
  <script>
    const root = document.getElementById('dead').attachShadow({ mode: 'closed' });
    root.innerHTML = '<div style="position:fixed;inset:0;touch-action:pan-x;z-index:1"></div>';
    window.__dead = on => { root.firstElementChild.style.display = on ? '' : 'none'; };
    document.getElementById('hold').addEventListener('touchmove', e => e.preventDefault(), { passive: false });
  </script></body></html>`;
const DEAD_URL = 'https://www.instagram.com/b25test/';
// A Reel viewer: one Reel a screen, snapping (SimpleGram blocks its swipes).
const REELS = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body style="margin:0">
  <div id="viewer" style="height:915px;overflow-y:scroll;scroll-snap-type:y mandatory">
    <div style="height:915px;scroll-snap-align:start">a Reel</div><div style="height:915px;scroll-snap-align:start">the next Reel</div>
  </div></body></html>`;

test('B25: drags that stop scrolling, with nothing holding them, are reported after three strikes', async () => {
  const page = await openPage(DEAD_URL, DEAD);
  await deadDrag(page);
  await deadDrag(page);
  assert.deepEqual(await stuckPosts(page), [], 'two are not enough');
  await deadDrag(page);
  const posts = await stuckPosts(page);
  assert.equal(posts.length, 1);
  assert.deepEqual([posts[0].strikes, posts[0].where, posts[0].dead], [3, 'other', 3]);
  assert.ok(posts[0].moves >= 1);
  assert.equal(await page.evaluate(() => window.scrollY), 0, 'the stand-in really is dead');
  const s = await b25(page);
  assert.equal(s.drag.dead, 3);
  assert.deepEqual(s.drag.deadLast5[0], { route: 'other', where: 'other', travel: 120, chainTA: [] });
  assert.equal(s.stuck.posted, 1);
  // Without an answer from the app, one report a minute at most.
  for (let i = 0; i < 3; i++) await deadDrag(page);
  assert.equal((await stuckPosts(page)).length, 1);
  assert.equal((await b25(page)).drag.dead, 6);
});

test('B25: a drag that scrolls is never a strike and clears the count', async () => {
  const page = await openPage(DEAD_URL, DEAD);
  await deadDrag(page);
  await deadDrag(page);
  await page.evaluate(() => window.__dead(false));
  await deadDrag(page);                                    // this one scrolls
  assert.ok(await page.evaluate(() => window.scrollY) > 50);
  await page.evaluate(() => { window.scrollTo(0, 0); window.__dead(true); });
  await page.waitForTimeout(100);
  await deadDrag(page);
  await deadDrag(page);
  assert.deepEqual(await stuckPosts(page), [], 'the scroll in between started the count again');
  await deadDrag(page);
  assert.equal((await stuckPosts(page)).length, 1);
  const s = await b25(page);
  assert.deepEqual([s.drag.dead, s.drag.scrolled], [5, 1]);
  // Once reported, the next drag that scrolls tells the app (the chip can go).
  await page.evaluate(() => { window.__dead(false); });
  await deadDrag(page);
  assert.equal((await sent(page, 'scrollOk')).length, 1);
});

test('B25: none of the gestures that aren\'t plain scrolls counts as a strike', async () => {
  const page = await openPage(DEAD_URL, DEAD);
  const c = await cdp(page);
  // A pinch: a second finger joins.
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 150, y: 800, id: 1 }] });
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 150, y: 800, id: 1 }, { x: 260, y: 800, id: 2 }] });
  for (let i = 1; i <= 6; i++) {
    await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 150, y: 800 - 30 * i, id: 1 }, { x: 260 + 10 * i, y: 800 - 30 * i, id: 2 }] });
  }
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(950);
  // A carousel swipe (sideways).
  await deadDrag(page, [350, 700], [60, 640]);
  // Surfaces that don't pan vertically: a pan-x strip and a slider.
  await deadDrag(page, [200, 180], [200, 100]);
  await deadDrag(page, [200, 290], [200, 210]);
  // A long press that then moves (text selection, a held menu).
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 200, y: 800 }] });
  await page.waitForTimeout(650);
  for (let i = 1; i <= 6; i++) await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 200, y: 800 - 35 * i }] });
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(950);
  // A selection on the page.
  await page.evaluate(() => getSelection().selectAllChildren(document.getElementById('text')));
  await deadDrag(page);
  await page.evaluate(() => getSelection().removeAllRanges());
  // Short touches and taps aren't drags at all.
  await deadDrag(page, [200, 800], [200, 770]);
  await c.detach();
  const s = await b25(page);
  assert.equal(s.drag.dead, 0, JSON.stringify(s.drag));
  assert.deepEqual(await stuckPosts(page), []);
  for (const k of ['pinch', 'sideways', 'noPanY', 'slowStart', 'selection']) assert.ok(s.drag.skipped[k] >= 1, k + ' ' + JSON.stringify(s.drag.skipped));
  assert.equal(s.drag.skipped.noPanY, 2);
  // The values touched are kept (values only): what a stuck report would name.
  assert.deepEqual(s.taSeen.map(x => x.v).sort(), ['none', 'pan-x']);
  // The page was dead all along: three plain drags are reported.
  for (let i = 0; i < 3; i++) await deadDrag(page);
  assert.equal((await stuckPosts(page)).length, 1);
});

test('B25: no strike where scrolling isn\'t expected: list ends, scroll locks, Stories, full screen, dialogs, zoom, keyboard, the app\'s hold', async () => {
  const page = await openPage(DEAD_URL, DEAD);
  // At the top, a drag down has nothing to scroll; at the bottom, a drag up.
  await deadDrag(page, [200, 600], [200, 800]);
  await page.evaluate(() => window.scrollTo(0, 1e6));
  await page.waitForTimeout(100);
  await deadDrag(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(100);
  // A body scroll lock (a sheet open).
  await page.evaluate(() => { document.documentElement.style.overflow = 'hidden'; });
  await deadDrag(page);
  await page.evaluate(() => { document.documentElement.style.overflow = ''; });
  // Stories.
  await page.evaluate(() => history.pushState(null, '', '/stories/friend/424242/'));
  await deadDrag(page);
  await page.evaluate(() => history.pushState(null, '', '/b25test/'));
  // Full screen.
  await page.evaluate(() => Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => document.body }));
  await deadDrag(page);
  await page.evaluate(() => Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => null }));
  // A dialog showing.
  await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div id="dlg" role="dialog" style="position:fixed;left:0;top:0;width:200px;height:40px;z-index:6">sheet</div>'));
  await deadDrag(page);
  await page.evaluate(() => document.getElementById('dlg').remove());
  // Zoomed in.
  await page.evaluate(() => Object.defineProperty(window.visualViewport, 'scale', { configurable: true, get: () => 2 }));
  await deadDrag(page);
  await page.evaluate(() => { delete window.visualViewport.scale; });
  // The keyboard (a field has focus).
  await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<input id="field" style="position:fixed;left:0;top:20px;z-index:6">');
    document.getElementById('field').focus();
  });
  await deadDrag(page);
  await page.evaluate(() => { const f = document.getElementById('field'); f.blur(); f.remove(); });
  // The app holding a finger on the page (its menu in a Story).
  await page.evaluate(() => window.__sg.onNative({ type: 'appHold', on: true }));
  await deadDrag(page);
  await page.evaluate(() => window.__sg.onNative({ type: 'appHold', on: false }));
  const s = await b25(page);
  assert.equal(s.drag.dead, 0, JSON.stringify(s.drag));
  assert.deepEqual(await stuckPosts(page), []);
  assert.deepEqual(s.drag.skipped, { end: 2, locked: 1, story: 1, fullScreen: 1, dialog: 1, zoom: 1, keyboard: 1, held: 1 });
  for (let i = 0; i < 3; i++) await deadDrag(page);
  assert.equal((await stuckPosts(page)).length, 1);
});

test('B25: no strike for a drag something held still, or one on a page too busy to tell', async () => {
  const page = await openPage(DEAD_URL, DEAD);
  // Instagram's own drag handler holding the touch (preventDefault).
  await deadDrag(page, [200, 400], [200, 320]);
  await deadDrag(page, [200, 400], [200, 330]);
  // A long task right after the lift.
  await page.evaluate(() => {
    window.__spin = () => { const t = Date.now(); while (Date.now() - t < 300); };
    document.addEventListener('touchend', window.__spin);
  });
  await deadDrag(page);
  await page.evaluate(() => document.removeEventListener('touchend', window.__spin));
  const s = await b25(page);
  assert.equal(s.drag.dead, 0, JSON.stringify(s.drag));
  assert.deepEqual([s.drag.skipped.prevented, s.drag.preventedOther, s.drag.preventedSG], [2, 2, 0]);
  assert.equal(s.drag.skipped.busy, 1);
  assert.deepEqual(await stuckPosts(page), []);
  // SimpleGram's own hold (the swipe block in a Reel viewer) is told apart from Instagram's.
  const reels = await openPage(DEAD_URL, REELS);
  await deadDrag(reels, [200, 700], [200, 400]);
  const r = await b25(reels);
  assert.deepEqual([r.drag.dead, r.drag.preventedSG, r.drag.preventedOther], [0, 1, 0], JSON.stringify(r.drag));
});

test('B25: the app\'s answers: a quiet reset first, then two more strikes bring the chip; a refusal lets the next strike ask again', async () => {
  let page = await openPage(DEAD_URL, DEAD);
  for (let i = 0; i < 3; i++) await deadDrag(page);
  assert.equal((await stuckPosts(page)).length, 1);
  // The app reset what it holds; the page clears its own gestures too.
  await page.evaluate(() => window.__sg.onNative({ type: 'gestureReset' }));
  await page.evaluate(() => window.__sg.onNative({ type: 'scrollStuckAck', accepted: true, stage: 'soft' }));
  await deadDrag(page);
  assert.equal((await stuckPosts(page)).length, 1);
  await deadDrag(page);
  assert.equal((await stuckPosts(page)).length, 2, 'still dead after the quiet reset: asked again at once');
  await page.evaluate(() => window.__sg.onNative({ type: 'scrollStuckAck', accepted: true, stage: 'chip' }));
  for (let i = 0; i < 3; i++) await deadDrag(page);
  assert.equal((await stuckPosts(page)).length, 2, 'the chip is up: no more for a minute');
  let s = await b25(page);
  assert.deepEqual([s.stuck.soft, s.stuck.chip, s.stuck.deadAfterSoft], [1, 1, 5]);

  // The app couldn't trust a report (a finger down, a dialog): the next strike asks again.
  page = await openPage(DEAD_URL, DEAD);
  for (let i = 0; i < 3; i++) await deadDrag(page);
  await page.evaluate(() => window.__sg.onNative({ type: 'scrollStuckAck', accepted: false }));
  await deadDrag(page);
  assert.equal((await stuckPosts(page)).length, 2);
  s = await b25(page);
  assert.equal(s.stuck.refused, 1);
});

test('B25: a drag on SimpleGram\'s search list counts there, and the list\'s own scroll is seen', async () => {
  const page = await openPage('https://www.instagram.com/explore/', DEAD);
  await page.waitForFunction(() => window.__sg.search.open && window.__sg.search.body);
  await page.evaluate(() => {
    document.activeElement && document.activeElement.blur();
    const s = window.__sg.search;
    s.root.activeElement && s.root.activeElement.blur();
    const tall = document.createElement('div');
    tall.id = 'tall-list';
    tall.style.height = '3000px';
    s.body.appendChild(tall);
  });
  await deadDrag(page);
  let s = await b25(page);
  assert.deepEqual([s.drag.scrolled, s.drag.dead], [1, 0], JSON.stringify(s.drag));
  assert.ok(await page.evaluate(() => window.__sg.search.body.scrollTop) > 50);
  // Now the list's contents stop panning, out of the page script's sight.
  await page.evaluate(() => {
    const s = window.__sg.search;
    s.body.scrollTop = 0;
    const host = document.createElement('div');
    const r = host.attachShadow({ mode: 'closed' });
    r.innerHTML = '<div style="height:3000px;touch-action:pan-x"></div>';
    s.body.textContent = '';
    s.body.appendChild(host);
  });
  await page.waitForTimeout(100);
  for (let i = 0; i < 3; i++) await deadDrag(page);
  const posts = await stuckPosts(page);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].where, 'overlay');
});

test('B25: the app\'s quiet reset drops a half-done R8 swipe', async () => {
  const page = await openPage('https://www.instagram.com/p/ABCDEFG/', POST);
  await stubSync(page);
  const c = await cdp(page);
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 200, y: 200 }] });
  for (let i = 1; i <= 6; i++) await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 200, y: 200 + 35 * i }] });
  await page.evaluate(() => window.__sg.onNative({ type: 'gestureReset' }));
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await c.detach();
  await page.waitForTimeout(100);
  assert.deepEqual(await page.evaluate(() => window.__fs), []);
  // The next swipe works as ever.
  await drag(page, [200, 200], [200, 420]);
  assert.deepEqual(await page.evaluate(() => window.__fs), ['v']);
});

/* ---------------- R8: the safe exit and the bookkeeping race ---------------- */

const POST = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body style="margin:0">
  <main><article>
    <header style="height:60px">friend</header>
    <div style="position:relative;width:412px;height:500px">
      <video id="v" muted playsinline loop style="width:412px;height:500px;display:block;background:#222"></video>
      <div id="tap" style="position:absolute;left:0;top:0;width:412px;height:500px"></div>
    </div>
    <div id="caption" style="height:2400px">a long description</div>
  </article></main></body></html>`;
const REEL_URL = 'https://www.instagram.com/reel/ABCDEFG/';

// Full screen at once, like the stub in video.test.cjs.
async function stubSync(page) {
  await page.evaluate(() => {
    window.__fs = []; window.__fsExit = 0; window.__fsEl = null;
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => window.__fsEl });
    HTMLElement.prototype.requestFullscreen = function () {
      window.__fs.push(this.id || this.tagName);
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
  });
}
// Full screen as the browser and the app do it: a request is granted a little
// later; leaving clears the element at once and its event comes later; the app
// leaves full screen (a page's request) a moment after it is asked.
async function stubAsync(page, { grantMs = 150, exitEventMs = 300, appExitMs = 100 } = {}) {
  await page.evaluate(({ grantMs, exitEventMs, appExitMs }) => {
    window.__fs = []; window.__fsExit = 0; window.__appExits = 0; window.__fsEl = null;
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => window.__fsEl });
    HTMLElement.prototype.requestFullscreen = function () {
      const el = this;
      window.__fs.push(el.id || el.tagName);
      return new Promise(res => setTimeout(() => { window.__fsEl = el; document.dispatchEvent(new Event('fullscreenchange')); res(); }, grantMs));
    };
    const leave = () => { window.__fsEl = null; setTimeout(() => document.dispatchEvent(new Event('fullscreenchange')), exitEventMs); };
    document.exitFullscreen = function () { window.__fsExit++; leave(); return Promise.resolve(); };
    const bridge = window.SGNative;
    window.SGNative = { postMessage: m => {
      bridge.postMessage(m);
      if (JSON.parse(m).action === 'fullVideoExitRequest' && window.__fsEl) { window.__appExits++; setTimeout(leave, appExitMs); }
    } };
  }, { grantMs, exitEventMs, appExitMs });
}
const state = page => page.evaluate(() => ({
  fv: window.__sg.stats.diag.fullVideo, fs: window.__sg.stats.b25.fs, el: window.__fsEl ? window.__fsEl.id : null,
  sgFull: document.getElementById('v').dataset.sgFull || null, requests: window.__fs.length,
  appExits: window.__appExits, pageExits: window.__fsExit }));

test('B25 R8: a quick swipe down right after an exit swipe starts nothing until the exit has landed', async () => {
  const page = await openPage(REEL_URL, POST);
  await stubAsync(page);
  await drag(page, [200, 200], [200, 400]);
  await page.waitForTimeout(300);
  let s = await state(page);
  assert.deepEqual([s.el, s.fv.r8, s.sgFull], ['v', 1, '1']);
  await drag(page, [200, 300], [200, 700]);              // the exit swipe: the app is asked
  await drag(page, [200, 200], [200, 420]);              // at once: a swipe down, before the exit lands
  await page.waitForTimeout(900);
  s = await state(page);
  assert.deepEqual([s.el, s.requests, s.fv.r8, s.fv.exits, s.sgFull, s.appExits, s.pageExits], [null, 1, 1, 1, null, 1, 0],
    'no second request (1.3 made one here and lost track of it: an untracked full screen no swipe could leave)');
  assert.ok(s.fs.r8Settling >= 1);
  // Once settled, swipes work as ever and stay tracked.
  await drag(page, [200, 200], [200, 400]);
  await page.waitForTimeout(300);
  s = await state(page);
  assert.deepEqual([s.el, s.fv.r8, s.sgFull], ['v', 2, '1']);
  await drag(page, [200, 300], [200, 700]);
  await page.waitForTimeout(600);
  s = await state(page);
  assert.deepEqual([s.el, s.fv.exits, s.appExits], [null, 2, 2]);
  // The page's own log of full-screen changes: shapes only.
  const log = (await b25(page)).fsPage;
  assert.deepEqual(log.map(e => [e.tag, e.via, e.on]), [['video', 'r8', true], [null, 'r8', false], ['video', 'r8', true], [null, 'r8', false]]);
  assert.ok(log.every(e => e.route === 'reel' && typeof e.msSinceTouchEnd === 'number' && typeof e.touchActive === 'boolean'));
});

test('B25 R8: the same with no app to ask (a browser): the page leaves full screen itself, and waits for it too', async () => {
  const page = await openPage(REEL_URL, POST);
  await page.evaluate(() => { delete window.SGNative; });
  await stubAsync(page);
  await drag(page, [200, 200], [200, 400]);
  await page.waitForTimeout(300);
  await drag(page, [200, 300], [200, 700]);
  await drag(page, [200, 200], [200, 420]);
  await page.waitForTimeout(700);
  const s = await state(page);
  assert.deepEqual([s.el, s.requests, s.pageExits, s.fs.exitFallback, s.fs.exitAsked, s.sgFull], [null, 1, 1, 1, 0, null]);
});

test('B25 R8: a late exit event while the next request is on its way keeps that request tracked', async () => {
  const page = await openPage(REEL_URL, POST);
  await stubAsync(page, { grantMs: 400 });
  await drag(page, [200, 200], [200, 400]);              // asks; granted 400 ms later
  await page.evaluate(() => document.dispatchEvent(new Event('fullscreenchange')));   // an earlier exit's event, late
  await page.waitForTimeout(600);
  let s = await state(page);
  assert.deepEqual([s.el, s.fv.r8, s.sgFull, s.fs.r8Race], ['v', 1, '1', 1]);
  await drag(page, [200, 300], [200, 700]);
  await page.waitForTimeout(600);
  s = await state(page);
  assert.deepEqual([s.el, s.fv.exits, s.appExits], [null, 1, 1]);
});

test('B25 R8: a video full screen R8 didn\'t ask for is taken over, so a swipe leaves it', async () => {
  const page = await openPage(REEL_URL, POST);
  await stubAsync(page);
  // Instagram's own player asking for full screen.
  await page.evaluate(() => document.getElementById('v').requestFullscreen());
  await page.waitForTimeout(250);
  let s = await state(page);
  assert.deepEqual([s.el, s.sgFull, s.fs.r8Adopted, s.fv.r8], ['v', '1', 1, 0]);
  await drag(page, [200, 300], [200, 700]);
  await page.waitForTimeout(600);
  s = await state(page);
  assert.deepEqual([s.el, s.sgFull, s.appExits, s.fv.exits], [null, null, 1, 1]);
  assert.equal((await b25(page)).fsPage[0].via, 'r8-adopted');
  // Not on Home, and never SimpleGram's own video.
  const home = await openPage('https://www.instagram.com/', POST);
  await stubAsync(home);
  await home.evaluate(() => document.getElementById('v').requestFullscreen());
  await home.waitForTimeout(250);
  assert.deepEqual([(await state(home)).sgFull, (await state(home)).fs.r8Adopted], [null, 0]);
});

test('B25 R8: a swipe whose lift is handled long after it happened switches nothing', async () => {
  const page = await openPage(REEL_URL, POST);
  await stubSync(page);
  const c = await cdp(page);
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 200, y: 200 }] });
  for (let i = 1; i <= 6; i++) await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 200, y: 200 + 35 * i }] });
  // The page is busy when the finger lifts: the lift is handled 700 ms late.
  const busy = page.evaluate(() => { const t = Date.now(); while (Date.now() - t < 700); });
  await page.waitForTimeout(50);
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await busy;
  await c.detach();
  await page.waitForTimeout(100);
  let s = await state(page);
  assert.deepEqual([s.requests, s.fs.r8Stale], [0, 1]);
  await drag(page, [200, 200], [200, 420]);
  s = await state(page);
  assert.deepEqual([s.requests, s.el], [1, 'v']);
});

/* ---------------- Diagnostics ---------------- */

test('B25: the b25 diagnostics carry counts and shapes only', async () => {
  const page = await openPage(REEL_URL, POST);
  await stubAsync(page);
  await drag(page, [200, 200], [200, 400]);
  await page.waitForTimeout(300);
  await drag(page, [200, 300], [200, 700]);
  await page.waitForTimeout(600);
  await drag(page, [200, 700], [200, 300], { settle: 950 });
  await page.evaluate(() => window.__sg.onNative({ type: 'status' }));
  const st = (await sent(page, 'status')).pop().stats.b25;
  assert.deepEqual(Object.keys(st).sort(), ['census', 'drag', 'fs', 'fsPage', 'search', 'stuck', 'taSeen', 'touchSeq']);
  assert.deepEqual(Object.keys(st.touchSeq).sort(), ['cancels', 'ends', 'orphanLast', 'orphans', 'starts']);
  assert.equal(st.touchSeq.starts, 3);
  assert.equal(st.touchSeq.ends, 3);
  assert.deepEqual(Object.keys(st.census).sort(), ['body', 'dialogs', 'downNow', 'html', 'moveBlockers', 'strikes', 'swipeGuard', 'vvScale']);
  // A post page has SimpleGram's own swipe guard (R8, the Reel swipe block): one blocking listener.
  assert.deepEqual([st.census.swipeGuard, st.census.moveBlockers], [true, 1]);
  assert.deepEqual(st.search, { open: false, leaving: false, cells: 0, liveObservers: 0 });
  const text = JSON.stringify(st);
  for (const word of ['friend', 'description', 'instagram', 'ABCDEFG', 'http']) assert.ok(!text.includes(word), word);
  // Home has none of ours.
  const home = await openPage('https://www.instagram.com/', POST);
  await home.evaluate(() => window.__sg.onNative({ type: 'status' }));
  assert.equal((await sent(home, 'status')).pop().stats.b25.census.moveBlockers, 0);
});
