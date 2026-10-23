// R5: the Favorites star in Instagram's bottom bar.
//
// The bar (ig-bar-app.js) is a React 19 model of Instagram's logged-in mobile
// bar, with Instagram's own class names, laid out by a subset of its CSS
// (ig-bar.css). React (react-19.js) is a vendored test fixture. Every request
// is answered locally; nothing reaches Instagram.
//
// Run: NODE_PATH=/opt/node-tools/node_modules node --test tests/*.test.cjs
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SCRIPT, ME, useBrowser, getBrowser, open: openPlain, media, user, timeline, edge, shadowClick } = require('./helpers.cjs');

useBrowser();

const REACT = fs.readFileSync(path.join(__dirname, 'react-19.js'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, 'ig-bar-app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, 'ig-bar.css'), 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const STAR_ROW = '[data-visualcompletion="ignore-dynamic"]';

function html({ dark = false, header = false, mode = 'client' } = {}) {
  return `<!doctype html><html class="_9dls ${dark ? '_aa4d' : '_aa4c'} touch" lang="en" dir="ltr"><head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<link rel="stylesheet" href="/__ig.css"><script>window.__mockMode=${JSON.stringify(mode)}</script>
<script src="/__react.js"></script></head>
<body style="margin:0">${header ? `<div id="hdr" style="position:fixed;top:0;left:0;right:0;height:44px;display:flex;justify-content:space-between;z-index:5">
<div><a href="/">Instagram</a></div><div><a href="/accounts/activity/">Heart</a></div><div><a href="/direct/inbox/">DM</a></div><div>x</div></div>` : ''}
<div id="mount"></div><script src="/__app.js"></script></body></html>`;
}

// Every frame, what you would see: a bar without its star, the star in a
// row that isn't a flex row (a side bar), the empty Reels item taking a share.
const FRAMES = () => {
  window.__frames = { bar: 0, barNoStar: 0, sideWithStar: 0, reelsSlot: 0 };
  const tick = () => {
    for (const row of document.querySelectorAll('[data-visualcompletion="ignore-dynamic"]')) {
      if (row.offsetParent === null) continue;
      const star = !!row.querySelector(':scope > [data-sg-fav]');
      if (getComputedStyle(row).display !== 'flex') { if (star) window.__frames.sideWithStar++; continue; }
      window.__frames.bar++;
      if (!star) window.__frames.barNoStar++;
      if (Array.from(row.children).some(c => c.querySelector('a[href="/reels/"]') && getComputedStyle(c).display !== 'none')) window.__frames.reelsSlot++;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

/**
 * Opens the bar model at `url`. bridge: 'record' (the app's bridge records
 * messages), 'none' (no bridge: SimpleGram loads pages itself) or 'app' (the
 * app answers openFeed by loading the feed, like loadMain).
 */
async function open(url, { role = 'main', dark = false, header = false, width = 412, height = 915, pre = null, mode = 'client', bridge = 'record', clock = false } = {}) {
  const context = await getBrowser().newContext({ viewport: { width, height }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, colorScheme: dark ? 'dark' : 'light' });
  const page = await context.newPage();
  page.__errors = [];
  page.__docs = [];
  page.on('pageerror', e => page.__errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') page.__errors.push(m.text()); });
  await page.route('**/*', route => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.pathname === '/__ig.css') return route.fulfill({ status: 200, contentType: 'text/css', body: CSS });
    if (u.pathname === '/__react.js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: REACT });
    if (u.pathname === '/__app.js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: APP });
    if (req.resourceType() === 'document') {
      page.__docs.push(u.pathname + u.search);
      return route.fulfill({ status: 200, contentType: 'text/html', body: html({ dark, header, mode }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  if (clock) await page.clock.install();
  await page.addInitScript(b => {
    window.__sent = [];
    if (b === 'none') return;
    window.SGNative = { postMessage: m => {
      const msg = JSON.parse(m);
      window.__sent.push(msg);
      if (b === 'app' && msg.action === 'openFeed') location.assign(msg.variant === 'home' ? '/' : '/?variant=' + msg.variant);
    } };
  }, bridge);
  await page.addInitScript(FRAMES);
  if (pre) await page.addInitScript(pre);
  await page.addInitScript(`window.__sgCfg=${JSON.stringify({ role, version: 'test', searchPages: 3, viewerId: ME })};\n${SCRIPT}`);
  await page.goto(url);
  await page.waitForSelector('[data-mock="nav"]', { state: 'attached' });
  if (!clock) await page.waitForTimeout(300);
  return page;
}
const nav = page => page.evaluate(() => window.__sg.stats.nav);
const starCount = page => page.evaluate(() => document.querySelectorAll('[data-sg-fav]').length);
const rows = page => page.evaluate(s => Array.from(document.querySelectorAll(s)).map(row => {
  const kids = Array.from(row.children);
  const stars = kids.filter(c => c.hasAttribute('data-sg-fav'));
  const home = kids.findIndex(c => c.querySelector('a[href="/"]'));
  return { stars: stars.length, afterHome: stars.length === 1 && kids[home + 1] === stars[0], hidden: row.offsetParent === null };
}), STAR_ROW);
const order = page => page.evaluate(s => Array.from(document.querySelector(s).children)
  .map(k => k.hasAttribute('data-sg-fav') ? 'STAR' : k.querySelector('a').getAttribute('href')), STAR_ROW);

// Layout of every visible bar item: icon box and centre.
function layout(page) {
  return page.evaluate(s => {
    const row = Array.from(document.querySelectorAll(s)).find(r => r.offsetParent !== null);
    return Array.from(row.children).filter(c => c.getBoundingClientRect().width > 0).map(c => {
      const svg = Array.from(c.querySelectorAll('svg')).find(x => x.getBoundingClientRect().width > 0);
      const a = c.querySelector('a');
      const r = svg.getBoundingClientRect(), box = (c.querySelector('.sg-fav-box') || a.firstElementChild).getBoundingClientRect();
      return { href: a.getAttribute('href'), fav: c.hasAttribute('data-sg-fav'), x: Math.round((r.left + r.width / 2) * 10) / 10, y: Math.round((r.top + r.height / 2) * 10) / 10,
        w: r.width, h: r.height, boxW: box.width, boxH: box.height, color: getComputedStyle(svg).color };
    });
  }, STAR_ROW);
}

/* ---------------- Placement and look ---------------- */

test('R5: the star sits right after Home; five items evenly spaced, same size, line and colour; Home untouched', async () => {
  const page = await open('https://www.instagram.com/');
  const items = await layout(page);
  assert.deepEqual(items.map(i => i.fav ? 'STAR' : i.href), ['/', 'STAR', '/explore/', '/direct/inbox/', '/me/']);
  const home = items[0], star = items[1];
  assert.equal(star.w, 24); assert.equal(star.h, 24);
  assert.equal(star.boxW, home.boxW); assert.equal(star.boxH, home.boxH);
  assert.equal(star.y, home.y, 'on the same line as Home');
  assert.equal(star.color, home.color);
  assert.equal(star.color, 'rgb(0, 0, 0)');
  const gaps = items.slice(1).map((it, i) => it.x - items[i].x);
  assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 1, 'evenly spaced: ' + gaps.join(','));
  const st = await page.evaluate(() => ({
    frames: window.__frames, outline: getComputedStyle(document.querySelector('[data-sg-fav] .sg-off')).display,
    filled: getComputedStyle(document.querySelector('[data-sg-fav] .sg-on')).display,
    current: document.querySelector('[data-sg-fav] a').hasAttribute('aria-current'),
  }));
  assert.equal(st.frames.barNoStar, 0, 'no frame shows the bar without the star');
  assert.equal(st.frames.reelsSlot, 0, 'no frame gives the empty Reels item a share of the row');
  assert.ok(st.frames.bar > 0);
  assert.deepEqual([st.outline, st.filled, st.current], ['block', 'none', false], 'an outline away from Favorites');
  // Shape-only geometry, sampled about 2 s after the star first showed.
  await page.waitForFunction(() => !!window.__sg.stats.nav.geo, null, { timeout: 4000 });
  const n = await nav(page);
  assert.deepEqual(n.geo, { items: 5, rowW: 412, home: [24, 24], star: [24, 24], dy: 0, gap: n.geo.gap, sameColour: true, msg: 'inbox' });
  assert.ok(n.geo.gap[1] - n.geo.gap[0] <= 1);
  assert.equal(n.inserted, 1);
  assert.deepEqual(page.__errors, []);
});

test('R5: dark mode follows Instagram\'s own colour variables', async () => {
  const page = await open('https://www.instagram.com/', { dark: true });
  const items = await layout(page);
  assert.equal(items[1].color, items[0].color);
  assert.equal(items[1].color, 'rgb(245, 245, 245)');
});

test('R5: React re-renders, a new item, a remount and a kept-alive page never lose or double the star; no React errors', async () => {
  const page = await open('https://www.instagram.com/');
  await page.evaluate(() => window.__app.set({ showCreate: true }));
  await page.waitForTimeout(50);
  assert.deepEqual(await rows(page), [{ stars: 1, afterHome: true, hidden: false }]);
  assert.deepEqual(await order(page), ['/', 'STAR', '/explore/', '/reels/', '#create', '/direct/inbox/', '/me/']);
  await page.evaluate(() => window.__app.set({ showCreate: false }));
  await page.evaluate(() => window.__app.set({ remount: 1 }));
  await page.waitForTimeout(50);
  assert.deepEqual(await rows(page), [{ stars: 1, afterHome: true, hidden: false }]);
  // Instagram's own in-page navigation (its Profile tab), with Home kept alive underneath.
  await page.evaluate(() => window.__app.set({ maintainFeed: true }));
  await page.tap('a[href="/me/"]');
  await page.waitForTimeout(100);
  const c = await rows(page);
  assert.equal(c.length, 2);
  assert.ok(c.every(r => r.stars === 1 && r.afterHome), JSON.stringify(c));
  assert.equal(await page.evaluate(() => location.pathname), '/me/', 'Instagram\'s own tab still works');
  // Back to Home in the page (Instagram's Home tab away from the feed is Instagram's).
  await page.tap('a[href="/"]:visible');
  await page.waitForTimeout(100);
  assert.deepEqual(await rows(page), [{ stars: 1, afterHome: true, hidden: false }]);
  const st = await page.evaluate(() => ({ errs: window.__renderErrors, frames: window.__frames, igClicks: window.__igClicks }));
  assert.deepEqual(st.errs, []);
  assert.equal(st.frames.barNoStar, 0, 'no frame without the star, even across remounts');
  assert.equal(st.frames.reelsSlot, 0);
  assert.deepEqual(st.igClicks, ['/me/', '/']);
  assert.deepEqual(page.__errors, []);
  // Rows React has committed (and re-rendered since) count as React's at once:
  // a resize looks at every star again and never waits.
  for (let i = 0; i < 4; i++) { await page.evaluate(() => window.__app.rerender()); await page.waitForTimeout(20); }
  await page.setViewportSize({ width: 412, height: 700 });
  await page.waitForTimeout(1300);
  assert.equal((await nav(page)).waitReact, 0);
  assert.deepEqual(await rows(page), [{ stars: 1, afterHome: true, hidden: false }]);
});

test('R5: a bar drawn before DOMContentLoaded has its star from the first frame', async () => {
  const page = await open('https://www.instagram.com/', { pre: () => { window.__syncRender = true; } });
  const st = await page.evaluate(() => ({ early: window.__renderedBeforeDCL, frames: window.__frames, stars: document.querySelectorAll('[data-sg-fav]').length }));
  assert.equal(st.early, true);
  assert.equal(st.stars, 1);
  assert.equal(st.frames.barNoStar, 0);
  assert.equal(st.frames.reelsSlot, 0);
});

test('R5: if Instagram adds its own Favorites item to the bar, the star steps aside, and comes back when it goes', async () => {
  const page = await open('https://www.instagram.com/');
  await page.evaluate(() => window.__app.set({ igFav: true }));
  await page.waitForTimeout(700);
  assert.equal(await starCount(page), 0);
  assert.equal((await nav(page)).igHasFav, 1);
  await page.evaluate(() => window.__app.set({ igFav: false }));
  await page.waitForTimeout(700);
  assert.deepEqual(await rows(page), [{ stars: 1, afterHome: true, hidden: false }]);
});

/* ---------------- Where it never goes ---------------- */

test('R5: no star in a side bar (turned sideways) or in a header linking Home and Messages; back in portrait it returns', async () => {
  const page = await open('https://www.instagram.com/');
  assert.equal(await starCount(page), 1);
  await page.evaluate(() => { window.__frames.sideWithStar = 0; window.__frames.barNoStar = 0; });
  // Turned sideways: Instagram's bar follows the window and becomes its side bar.
  await page.setViewportSize({ width: 900, height: 412 });
  await page.waitForTimeout(800);
  assert.equal(await starCount(page), 0, 'gone with the side bar');
  await page.setViewportSize({ width: 412, height: 915 });
  await page.waitForTimeout(800);
  assert.deepEqual(await rows(page), [{ stars: 1, afterHome: true, hidden: false }]);
  const f = await page.evaluate(() => window.__frames);
  assert.equal(f.sideWithStar, 0, 'no frame with the star in the side bar');
  assert.equal(f.barNoStar, 0, 'no frame with the portrait bar without its star');
  assert.equal((await nav(page)).notBottom, 1);
  const hdr = await open('https://www.instagram.com/', { header: true });
  assert.deepEqual(await hdr.evaluate(() => Array.from(document.querySelectorAll('[data-sg-fav]')).map(s => !!s.closest('#hdr'))), [false]);
});

test('R5: the comments panel, Stories and messages never get a star', async () => {
  const comments = await open('https://www.instagram.com/p/ABCDEF123/comments/', { role: 'comments' });
  assert.equal(await starCount(comments), 0);
  const story = await open('https://www.instagram.com/stories/friend/3700000000000000001/');
  assert.equal(await starCount(story), 0);
  const dm = await open('https://www.instagram.com/direct/inbox/');
  assert.equal(await starCount(dm), 0);
  // From Home to messages inside the page and back: hidden there, back on Home.
  const page = await open('https://www.instagram.com/');
  await page.evaluate(() => window.__app.set({ maintainFeed: true }));
  await page.tap('a[href="/direct/inbox/"]');
  await page.waitForTimeout(150);
  const shown = await page.evaluate(() => Array.from(document.querySelectorAll('[data-sg-fav]')).filter(s => s.getBoundingClientRect().width > 0).length);
  assert.equal(shown, 0, 'no star shows in messages');
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-sg-nostar')), true);
  await page.goBack();
  await page.waitForTimeout(200);
  assert.deepEqual(await rows(page), [{ stars: 1, afterHome: true, hidden: false }]);
  assert.equal(await page.evaluate(() => document.querySelector('[data-sg-fav]').getBoundingClientRect().width > 0), true);
});

/* ---------------- Taps ---------------- */

test('R5: the star opens Favorites as a new page through the app; Instagram never sees the tap; no skip list', async () => {
  const page = await open('https://www.instagram.com/');
  await page.tap('[data-sg-fav] a');
  await page.waitForTimeout(150);
  const st = await page.evaluate(() => ({ sent: window.__sent.filter(m => m.action === 'openFeed' || m.action === 'feedEnd'),
    igClicks: window.__igClicks, url: location.pathname + location.search, skip: sessionStorage.getItem('sg_skip_seen'), taps: window.__sg.stats.nav.taps }));
  assert.deepEqual(st.sent, [{ action: 'feedEnd', on: false }, { action: 'openFeed', variant: 'favorites' }]);
  assert.deepEqual(st.igClicks, []);
  assert.equal(st.url, '/', 'the app loads it');
  assert.equal(st.skip, null);
  assert.equal(st.taps, 1);
});

test('R5: without the app\'s bridge the star is a full load of Favorites: filled star, aria-current, Home left as Instagram draws it', async () => {
  const page = await open('https://www.instagram.com/', { bridge: 'none' });
  const homeD = await page.evaluate(() => document.querySelector('a[href="/"] svg path').getAttribute('d'));
  await Promise.all([page.waitForURL('https://www.instagram.com/?variant=favorites'), page.tap('[data-sg-fav] a')]);
  await page.waitForSelector('[data-sg-fav]');
  await page.waitForTimeout(200);
  const st = await page.evaluate(() => ({
    navType: performance.getEntriesByType('navigation')[0].type,
    feed: document.documentElement.getAttribute('data-sg-feed'),
    current: document.querySelector('[data-sg-fav] a').getAttribute('aria-current'),
    on: getComputedStyle(document.querySelector('[data-sg-fav] .sg-on')).display,
    off: getComputedStyle(document.querySelector('[data-sg-fav] .sg-off')).display,
    homeSelected: document.querySelector('a[href="/"] [aria-selected]').getAttribute('aria-selected'),
    homeD: document.querySelector('a[href="/"] svg path').getAttribute('d'),
    igClicks: window.__igClicks,
  }));
  assert.equal(st.navType, 'navigate', 'a full page load, not an in-page switch');
  assert.equal(st.feed, 'favorites');
  assert.equal(st.current, 'page');
  assert.deepEqual([st.on, st.off], ['block', 'none']);
  assert.equal(st.homeSelected, 'true');
  assert.equal(st.homeD, homeD, 'Instagram\'s Home icon is left alone');
  assert.deepEqual(st.igClicks, []);
  assert.deepEqual(page.__docs, ['/', '/?variant=favorites']);
  assert.deepEqual(page.__errors, []);
});

test('R5: accessible as a link named Favorites; Enter works like a tap', async () => {
  const page = await open('https://www.instagram.com/', { bridge: 'none' });
  assert.equal(await page.getByRole('link', { name: 'Favorites' }).count(), 1);
  await page.focus('[data-sg-fav] a');
  await Promise.all([page.waitForURL('https://www.instagram.com/?variant=favorites'), page.keyboard.press('Enter')]);
});

test('R5: on Favorites, the star goes to the top first; at the top it refreshes only 30 s after the page or its last feed page', async () => {
  const page = await open('https://www.instagram.com/?variant=favorites', { bridge: 'none', pre: () => {
    // A clock SimpleGram reads through Date.now(), moved on by the test.
    const real = Date.now;
    window.__skew = 0;
    Date.now = () => real() + window.__skew;
  } });
  await page.evaluate(() => window.scrollTo(0, 2000));
  await page.waitForTimeout(100);
  const h0 = await page.evaluate(() => history.length);
  await page.tap('[data-sg-fav] a');
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => document.scrollingElement.scrollTop), 0);
  // At the top, within 30 s of the page loading: nothing happens.
  await page.tap('[data-sg-fav] a');
  await page.waitForTimeout(300);
  let n = await nav(page);
  assert.deepEqual([n.top, n.refreshHeld, n.refresh], [1, 1, 0]);
  // 31 s later a Favorites page arrived: still held.
  await page.evaluate(() => { window.__skew = 31000; });
  await page.evaluate(p => JSON.parse(JSON.stringify(p)), timeline([edge({ media: media('FAV0001', user('fav', true)) })]));
  await page.tap('[data-sg-fav] a');
  await page.waitForTimeout(300);
  n = await nav(page);
  assert.deepEqual([n.refreshHeld, n.refresh], [2, 0]);
  assert.deepEqual(page.__docs, ['/?variant=favorites']);
  // 31 s after that: a fresh load that replaces this entry.
  await page.evaluate(() => { window.__skew = 62000; });
  await Promise.all([page.waitForEvent('framenavigated'), page.tap('[data-sg-fav] a')]);
  await page.waitForSelector('[data-sg-fav]');
  assert.deepEqual(page.__docs, ['/?variant=favorites', '/?variant=favorites']);
  assert.equal(await page.evaluate(() => location.search), '?variant=favorites');
  assert.equal(await page.evaluate(() => history.length), h0, 'replace, not push');
});

test('R5: Instagram\'s Home tab and its "< Favorites" link on Favorites load Home as a new page, never in the page', async () => {
  const page = await open('https://www.instagram.com/?variant=favorites', { bridge: 'none' });
  await Promise.all([page.waitForURL('https://www.instagram.com/'), page.tap('a[href="/"]:visible >> nth=0')]);
  await page.waitForSelector('[data-sg-fav]');
  const st = await page.evaluate(() => ({ igClicks: window.__igClicks, go: window.__goCalls, feed: document.documentElement.getAttribute('data-sg-feed'),
    current: document.querySelector('[data-sg-fav] a').hasAttribute('aria-current'), on: getComputedStyle(document.querySelector('[data-sg-fav] .sg-on')).display }));
  assert.deepEqual(st, { igClicks: [], go: [], feed: 'home', current: false, on: 'none' });
  assert.deepEqual(page.__docs, ['/?variant=favorites', '/']);
  const hdr = await open('https://www.instagram.com/?variant=favorites', { bridge: 'none' });
  await Promise.all([hdr.waitForURL('https://www.instagram.com/'), hdr.tap('#variants-back')]);
  assert.deepEqual(await hdr.evaluate(() => [window.__igClicks, window.__goCalls]), [[], []]);
  // Counted by where they are, though the header link sits in a <nav> like Instagram's.
  const rec = await open('https://www.instagram.com/?variant=favorites');
  await rec.tap('#variants-back');
  await rec.waitForTimeout(150);
  assert.deepEqual(await rec.evaluate(() => [window.__sent.filter(m => m.action === 'openFeed').map(m => m.variant), window.__sg.stats.nav.homeFull]),
    [['home'], { bar: 0, header: 1 }]);
  await rec.tap('a[href="/"]:visible >> nth=0');
  await rec.waitForTimeout(150);
  assert.deepEqual(await rec.evaluate(() => window.__sg.stats.nav.homeFull), { bar: 1, header: 1 });
});

test('R5: with SimpleGram search open on Home, the star closes it and opens Favorites', async () => {
  const page = await open('https://www.instagram.com/', { bridge: 'none' });
  await page.tap('a[href="/explore/"]');
  await page.waitForFunction(() => window.__sent.length === 0 && document.getElementById('sg-search') && document.getElementById('sg-search').style.display !== 'none');
  await Promise.all([page.waitForURL('https://www.instagram.com/?variant=favorites'), page.tap('[data-sg-fav] a')]);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('sg_search_state')), null);
});

test('R5: on Favorites with search open, the star only closes search: no load, no scroll', async () => {
  const page = await open('https://www.instagram.com/?variant=favorites', { bridge: 'none' });
  await page.evaluate(() => window.scrollTo(0, 1500));
  await page.tap('a[href="/explore/"]');
  await page.waitForFunction(() => { const h = document.getElementById('sg-search'); return h && h.style.display !== 'none'; });
  await page.tap('[data-sg-fav] a');
  await page.waitForTimeout(400);
  const st = await page.evaluate(() => ({ open: document.getElementById('sg-search').style.display !== 'none', y: document.scrollingElement.scrollTop,
    nav: window.__sg.stats.nav, saved: sessionStorage.getItem('sg_search_state') }));
  assert.equal(st.open, false);
  assert.equal(st.y, 1500);
  assert.deepEqual([st.nav.closedSearch, st.nav.top, st.nav.refresh, st.nav.refreshHeld], [1, 0, 0, 0]);
  assert.equal(st.saved, null);
  assert.deepEqual(page.__docs, ['/?variant=favorites']);
});

/* ---------------- Waiting for React ---------------- */

test('R5: a bar drawn before React takes it over gets its star only after hydration (no redraw, no React error)', async () => {
  const page = await open('https://www.instagram.com/', { mode: 'hydrate', pre: () => { window.__hydrateDelay = 800; } });
  assert.equal(await starCount(page), 0, 'not while the bar is plain HTML');
  await page.waitForFunction(() => window.__hydrateCalled);
  await page.waitForTimeout(800);
  const st = await page.evaluate(() => ({ errs: window.__renderErrors, kept: window.__beforeHydrate.home === document.querySelector('a[href="/"]'), nav: window.__sg.stats.nav }));
  assert.deepEqual(st.errs, []);
  assert.equal(st.kept, true, 'React kept the drawn bar');
  assert.ok(st.nav.waitReact > 0);
  assert.equal(st.nav.waitReactGaveUp, 0);
  assert.deepEqual(await rows(page), [{ stars: 1, afterHome: true, hidden: false }]);
  await page.tap('a[href="/me/"]');
  await page.waitForTimeout(150);
  assert.deepEqual(await page.evaluate(() => [location.pathname, window.__igClicks]), ['/me/', ['/me/']]);
});

// React puts its key on the bar while it hydrates, before it commits; a
// hydration in time slices that starts over (a tap, or any update) would
// meet a star put in too early, throw #418 and draw the bar again.
for (const [what, pre, tap] of [
  ['a tap on a post', () => { window.__suspense = true; window.__hydrateDelay = 300; }, true],
  ['an update outside the boundary', () => { window.__suspense = true; window.__hydrateDelay = 300; window.__tickAt = 700; }, false],
]) {
  test(`R5: a bar hydrated in slices inside a Suspense boundary gets its star only after React commits (${what} mid-hydration)`, async () => {
    const page = await open('https://www.instagram.com/', { mode: 'hydrate', pre });
    await page.waitForFunction(() => window.__hydrateCalled);
    if (tap) { await page.waitForTimeout(700); await page.tap('#slow article:nth-child(3)', { force: true }); }
    await page.waitForFunction(() => window.__boundaryDone, null, { timeout: 12000 });
    await page.waitForFunction(() => !!document.querySelector('[data-sg-fav]'), null, { timeout: 3000 });
    await page.waitForTimeout(500);
    const st = await page.evaluate(() => ({ errs: window.__renderErrors, kept: window.__beforeHydrate.home === document.querySelector('a[href="/"]'),
      tick: document.getElementById('tick').textContent, inserted: window.__sg.stats.nav.inserted }));
    assert.deepEqual(st.errs, [], 'no hydration error (#418)');
    assert.equal(st.kept, true, 'React kept the drawn bar');
    assert.equal(st.inserted, 1);
    if (!tap) assert.equal(st.tick, '1');
    assert.deepEqual(await rows(page), [{ stars: 1, afterHome: true, hidden: false }]);
  });
}

test('R5: a bar React never takes over stops being retried after the limit (no star, no endless timer)', async () => {
  const page = await open('https://www.instagram.com/', { mode: 'static', clock: true });
  await page.clock.runFor(5000);
  let n = await nav(page);
  assert.ok(n.waitReact > 5 && n.waitReact <= 26, String(n.waitReact));
  assert.equal(n.waitReactGaveUp, 0);
  await page.clock.runFor(8000);
  n = await nav(page);
  assert.equal(n.waitReactGaveUp, 1);
  const tries = n.waitReact, scans = n.tidyScans;
  // Many tidy passes later: no more tries, no searches of the page.
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => document.querySelector('main').appendChild(document.createElement('div')));
    await page.clock.runFor(1000);
  }
  n = await nav(page);
  assert.equal(n.waitReact, tries);
  assert.equal(n.tidyScans, scans);
  assert.equal(await starCount(page), 0);
});

/* ---------------- Cost on a long feed ---------------- */

test('R5: on a long feed, a "< Favorites" header redraw costs the observer little and tidy passes never search the page', async () => {
  const page = await open('https://www.instagram.com/?variant=favorites');
  const r = await page.evaluate(async () => {
    const feed = document.getElementById('feed');
    const before = window.__sg.stats.nav.tidyScans;
    // About 58,000 elements, added in 40 batches like a feed loading.
    for (let batch = 0; batch < 40; batch++) {
      for (let i = 0; i < 6; i++) {
        const art = document.createElement('article');
        let h = '';
        for (let k = 0; k < 40; k++) h += '<div><span><a href="/user' + k + '/">u</a></span><div><img src="data:,"><div>t</div></div></div>';
        art.innerHTML = h;
        feed.appendChild(art);
      }
      await new Promise(res => setTimeout(res, 20));
    }
    await new Promise(res => setTimeout(res, 800));
    const scans = window.__sg.stats.nav.tidyScans - before;
    // Instagram redraws the "< Favorites" header: one batch with a link to "/".
    // (Before the bounded look, each cost about 2 ms here, 5 ms in the review.)
    const hdr = document.getElementById('variants-header');
    const ms = [];
    for (let i = 0; i < 7; i++) {
      window.__sg.stats.nav.obsMs = 0;
      const copy = hdr.cloneNode(true);
      hdr.parentElement.insertBefore(copy, hdr);
      await new Promise(res => setTimeout(res, 20));
      ms.push(window.__sg.stats.nav.obsMs);
      copy.remove();
    }
    ms.sort((a, b) => a - b);
    return { nodes: document.getElementsByTagName('*').length, scans, headerMs: ms[3], stars: document.querySelectorAll('[data-sg-fav]').length };
  });
  assert.ok(r.nodes > 50000, String(r.nodes));
  assert.equal(r.scans, 0, 'no tidy pass searched the page for links to "/"');
  assert.ok(r.headerMs <= 0.5, 'header batch (median) ' + r.headerMs + ' ms');
  assert.equal(r.stars, 1);
});

/* ---------------- A search result opening (B14) ---------------- */

const ROUTER = fs.readFileSync(path.join(__dirname, 'comet-router-mock.js'), 'utf8');
// The B14 page with a bottom bar SimpleGram takes for Instagram's (a flex row
// fixed at the bottom, marked as React's).
const B14 = cfg => `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Instagram</title>
<script>window.__mockcfg=${JSON.stringify(cfg)};</script></head>
<body style="margin:0"><main style="min-height:80vh"></main>
<div style="position:fixed;bottom:0;left:0;right:0;height:50px"><div id="nav" style="display:flex;justify-content:space-evenly;width:100%">
<div><a href="/" style="display:block;width:48px;height:48px">Home</a></div>
<div><a id="searchlink" href="/explore/" style="display:block;width:48px;height:48px">Search</a></div>
<div><a href="/direct/inbox/" style="display:block;width:48px;height:48px">DM</a></div>
<div><a href="/me/" style="display:block;width:48px;height:48px">Me</a></div></div></div>
<script>document.getElementById('nav')['__reactFiber$test'] = {};</script>
<script>${ROUTER}</script></body></html>`;
function graphql(u, req) {
  const name = new URLSearchParams(req.postData() || '').get('fb_api_req_friendly_name');
  if (name === 'PolarisKeywordSearchExplorePageRelayQuery') {
    return { body: { data: { xdt_fbsearch__top_serp_graphql: {
      edges: [{ node: { __typename: 'XDTTopSerpHeaderUnit' } },
        { node: { __typename: 'XDTTopSerpMediaGridUnit', items: [media('KEYW001', user('a', true)), media('KEYW002', user('b', true))] } }],
      page_info: { has_next_page: false, end_cursor: null } } }, extensions: { is_final: true } } };
  }
  return { body: { data: { xdt_api__v1__fbsearch__topsearch_connection: { users: [], hashtags: [], places: [] } } } };
}
const NOT_FOUND = '<!DOCTYPE html><html><head><title>Page Not Found</title></head><body>no</body></html>';
const API = { '/web/search/topsearch/': () => ({ status: 404, body: NOT_FOUND }), '/api/v1/fbsearch/web/top_serp/': () => ({ status: 404, body: NOT_FOUND }),
  '/api/graphql': graphql, '/graphql/query': graphql };

async function searchThenOpen(cfg) {
  const page = await openPlain('https://www.instagram.com' + (cfg.start || '/'), B14(cfg), { api: API });
  page.__docs = [];
  // The app answers openFeed like loadMain: a new page of that feed.
  await page.evaluate(() => {
    window.SGNative = { postMessage: m => { const msg = JSON.parse(m); window.__sent.push(msg); if (msg.action === 'openFeed') location.assign(msg.variant === 'home' ? '/' : '/?variant=' + msg.variant); } };
  });
  await page.route('**/*', async route => {
    const req = route.request();
    if (req.resourceType() !== 'document') return route.fallback();
    const u = new URL(req.url());
    page.__docs.push(u.pathname + u.search);
    await sleep(cfg.docDelay || 1500);   // Instagram's HTML over mobile data
    try { await route.fulfill({ status: 200, contentType: 'text/html', body: B14(cfg) }); } catch (e) { /* called off */ }
  });
  await page.waitForFunction(() => document.querySelector('main').textContent.length > 0);
  await page.waitForFunction(() => !!document.querySelector('[data-sg-fav]'), null, { timeout: 5000 });
  await page.tap('#searchlink');
  await page.waitForFunction(() => { const h = document.getElementById('sg-search'); return h && h.style.display !== 'none'; });
  await page.keyboard.type('sharks');
  await shadowClick(page, 'Posts & Reels');
  await page.waitForFunction(() => document.getElementById('sg-search').shadowRoot.querySelectorAll('.cell').length === 2);
  await page.evaluate(() => document.getElementById('sg-search').shadowRoot.querySelectorAll('.cell')[0].click());
  return page;
}
async function landed(page) {
  await page.waitForURL(u => u.search === '?variant=favorites', { timeout: 8000 });
  await page.waitForLoadState('load');
  await sleep(2500);   // long enough for any late full load of the result to show up
  return page.evaluate(() => ({ where: location.pathname + location.search, opens: JSON.parse(sessionStorage.getItem('sg_search_opens') || '{}') }));
}

test('R5: the star while a result opens that Instagram never takes: the open is called off and Favorites loads', async () => {
  const page = await searchThenOpen({ exposeRequire: true, dropPush: true, ignoreForeign: true });
  await sleep(300);
  await page.tap('[data-sg-fav] a');
  const r = await landed(page);
  assert.equal(r.where, '/?variant=favorites');
  assert.equal(r.opens.cancelled, 1);
  assert.equal(r.opens.fullLoad || 0, 0);
  assert.deepEqual(page.__docs, ['/?variant=favorites'], 'the result was never loaded as a page');
});

test('R5: the star while Instagram\'s router is in the middle of opening a result: Favorites, and the result never loads as a page', async () => {
  const page = await searchThenOpen({ exposeRequire: true, fetchMs: 300, renderMs: 3000 });
  await sleep(450);
  await page.tap('[data-sg-fav] a');
  const r = await landed(page);
  assert.equal(r.where, '/?variant=favorites');
  assert.equal(r.opens.cancelled, 1, 'the open, mid-way, is called off once');
  assert.deepEqual(page.__docs, ['/?variant=favorites']);
});

// Tapped while Instagram's router is still fetching the result's route (the
// URL hasn't moved): the open is called off, then the router pushes the
// result before the feed's page arrives. The app's loadUrl is modelled by a
// browser-initiated load (page.goto) or by location.assign.
async function racedOpen(start, tap, how) {
  const page = await searchThenOpen({ start, exposeRequire: true, fetchMs: 700, renderMs: 300, docDelay: 2500 });
  if (how === 'goto') {
    await page.evaluate(() => { window.SGNative.postMessage = m => { const msg = JSON.parse(m); window.__sent.push(msg); if (msg.action === 'openFeed') window.__wantFeed = msg.variant; }; });
  }
  await sleep(300);
  const before = await page.evaluate(() => location.pathname + location.search);
  await page.tap(tap);
  let aborted = null;
  if (how === 'goto') {
    const v = await page.evaluate(() => window.__wantFeed);
    page.goto('https://www.instagram.com/' + (v === 'home' ? '' : '?variant=' + v)).catch(e => { aborted = String(e).slice(0, 80); });
  }
  const want = start === '/' ? '?variant=favorites' : '';
  await page.waitForFunction(w => location.search === w && document.readyState === 'complete' && !!window.__sg, want, { timeout: 12000, polling: 100 });
  await sleep(2500);
  const r = await page.evaluate(() => ({ where: location.pathname + location.search, opens: JSON.parse(sessionStorage.getItem('sg_search_opens') || '{}') }));
  return { before, r, docs: page.__docs, aborted, page };
}
for (const how of ['assign', 'goto']) {
  test(`R5: the star while Instagram's router still fetches the result (${how}): the late push never cancels the Favorites load`, async () => {
    const { before, r, docs } = await racedOpen('/', '[data-sg-fav] a', how);
    assert.equal(before, '/', 'tapped before Instagram moved the URL');
    assert.equal(r.where, '/?variant=favorites');
    assert.equal(r.opens.cancelled, 1);
    assert.equal(r.opens.fullLoad || 0, 0);
    assert.ok(docs.length >= 1 && docs.every(d => d === '/?variant=favorites'), JSON.stringify(docs));
  });
}
test('R5: Home tab on Following while Instagram\'s router still fetches the result: Home loads, the result never does', async () => {
  const { before, r, docs } = await racedOpen('/?variant=following', 'a[href="/"]', 'goto');
  assert.equal(before, '/?variant=following');
  assert.equal(r.where, '/');
  assert.equal(r.opens.cancelled, 1);
  assert.ok(docs.length >= 1 && docs.every(d => d === '/'), JSON.stringify(docs));
});

/* ---------------- Diagnostics ---------------- */

test('R5: the star\'s diagnostics are counts, timings and shapes only', async () => {
  const page = await open('https://www.instagram.com/');
  await page.waitForFunction(() => !!window.__sg.stats.nav.geo, null, { timeout: 4000 });
  await page.tap('[data-sg-fav] a');
  const n = await nav(page);
  for (const k of ['inserted', 'moved', 'notBottom', 'waitReact', 'waitReactGaveUp', 'igHasFav', 'taps', 'top', 'refresh', 'refreshHeld',
    'closedSearch', 'openCancelled', 'tidyScans', 'obsMs']) assert.equal(typeof n[k], 'number', k);
  assert.doesNotMatch(JSON.stringify(n), /instagram|variant|\/direct|\/me\/|explore|favorites/i);
});

// Messages keeps Instagram's bar mounted (only Stories, a chat and search
// results hide it), so the star stays put across the trip and nothing is
// inserted again on the way back: the sample must still be taken.
test('R5: the geometry sample survives a trip to Messages within 2 s of the star showing', async () => {
  const page = await open('https://www.instagram.com/');
  await page.evaluate(() => history.pushState({}, '', '/direct/inbox/'));   // the bar stays mounted
  await page.waitForTimeout(2500);
  let n = await nav(page);
  assert.equal(n.geo, null, 'not sampled while the star is hidden');
  await page.evaluate(() => history.back());
  await page.waitForFunction(() => !!window.__sg.stats.nav.geo, null, { timeout: 4000 });
  n = await nav(page);
  assert.equal(n.inserted, 1, 'the same star, never put in again');
  assert.equal(n.geo.items, 5);
});

test('R5: in Messages a resize (the keyboard) puts no hidden star in; back on Home the star shows and is sampled', async () => {
  const page = await open('https://www.instagram.com/direct/inbox/');
  await page.setViewportSize({ width: 412, height: 600 });
  await page.waitForTimeout(1300);
  await page.setViewportSize({ width: 412, height: 915 });
  await page.waitForTimeout(1500);
  let n = await nav(page);
  assert.deepEqual([n.inserted, await starCount(page)], [0, 0]);
  await page.evaluate(() => history.pushState({}, '', '/'));   // the same bar, now on Home
  await page.waitForFunction(() => !!window.__sg.stats.nav.geo, null, { timeout: 5000 });
  n = await nav(page);
  assert.equal(n.inserted, 1);
  assert.deepEqual(await rows(page), [{ stars: 1, afterHome: true, hidden: false }]);
});
