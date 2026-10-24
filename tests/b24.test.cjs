// B24: a Reel a friend sent in a DM opens in Instagram's Reel viewer, which
// carried on into "Suggested" Reels. Browser tests for the three parts of the
// fix: the suggested Reels leave the viewer's data (by the answer's name or its
// clip-list shape; the thread's own messages are never touched), vertical
// swipes are held while the viewer is open (and only then: chats keep their
// passive scrolling), and a suggested Reel that still shows is hidden and the
// viewer put back on the sent Reel.
//
// Instagram's DM Reel viewer is logged-in code that isn't in the public
// bundles, so the mock viewers below model the two ways it can move on: a
// vertically snapping list (like the website's Reels viewer) and a pager driven
// by touch or pointer handlers on the app's root (like React's). Payloads are
// modelled on the website's clips answers (XDTClipsFeedResponseConnection:
// edges[].node.media with page_info; the REST clips answers: items[].media with
// paging_info) and on a DM thread's messages; they are fixtures, not captures.
// Touches are real ones from the browser (Chrome DevTools input). Nothing
// reaches Instagram: every request is answered locally.
//
// Run: NODE_PATH=/opt/node-tools/node_modules node --test tests/*.test.cjs
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { SCRIPT, ME, sent, waitSent, user, media, PNG } = require('./helpers.cjs');
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const CLIP = fs.readFileSync(path.join(__dirname, 'reel.webm'));

let browser;
before(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { await browser.close(); });

const THREAD_URL = 'https://www.instagram.com/direct/t/1234567890/';

async function openPage(url, html, { init = null } = {}) {
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
async function drag(page, from, to, { steps = 8 } = {}) {
  const c = await page.context().newCDPSession(page);
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from[0], y: from[1] }] });
  for (let i = 1; i <= steps; i++) {
    await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{
      x: from[0] + (to[0] - from[0]) * i / steps, y: from[1] + (to[1] - from[1]) * i / steps }] });
  }
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
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
// Which touch moves were held still (seen after the page script's own listener).
async function watchMoves(page) {
  await page.evaluate(() => {
    window.__held = 0; window.__free = 0;
    document.addEventListener('touchmove', e => { if (e.defaultPrevented) window.__held++; else window.__free++; }, { passive: true, capture: true });
  });
}
// The page script's touch listeners on window and document that can hold a scroll (as in A12).
function watchListeners() {
  const live = new Map();
  window.__blocking = () => Array.from(live.values()).filter(x => !x.passive).map(x => x.type);
  const key = (t, type, fn, capture) => (t === window ? 'w' : 'd') + type + (capture ? 1 : 0) + ':' + (fn.__id || (fn.__id = Math.random()));
  const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if ((this === window || this === document) && /^(touch|wheel)/.test(type) && fn) {
      const capture = typeof opts === 'boolean' ? opts : !!(opts && opts.capture);
      const passive = typeof opts === 'object' && opts && opts.passive === true;
      const k = key(this, type, fn, capture);
      // Playwright's own (its hit-target check) don't count.
      if (!live.has(k) && !/HitTargetInterceptor/.test(new Error().stack)) live.set(k, { type: type, passive: passive });
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
const dm = page => page.evaluate(() => window.__sg.stats.dmReel);
const parse = (page, payload) => page.evaluate(p => JSON.parse(JSON.stringify(p)), payload);

/* ---------------- Fixtures ---------------- */

function clip(code, extra = {}) {
  return media(code, user('u' + code, extra.following), Object.assign({
    product_type: 'clips', media_type: 2,
    video_versions: [{ url: `https://scontent.cdninstagram.com/v/t50/${code}-720.mp4`, width: 720, height: 1280 }],
  }, extra));
}
// A DM thread's messages (REST): a shared Reel (item_type clip), a text, and the thread's own paging.
function threadPayload(sentCode) {
  return { thread: { thread_id: '1234567890', has_older: true, oldest_cursor: 'older1', items: [
    { item_id: '9001', item_type: 'clip', user_id: '77', timestamp: '1700000000000000', clip: { clip: clip(sentCode) } },
    { item_id: '9002', item_type: 'text', user_id: '77', timestamp: '1700000000000001', text: 'look at this' },
    { item_id: '9003', item_type: 'media_share', user_id: '77', timestamp: '1700000000000002', media_share: media('PHOTO01', user('friend', true)) },
  ] }, status: 'ok' };
}
// The viewer's continuation by name: the website's clips connection.
function chainByKey(list, more = true) {
  return { data: { xdt_api__v1__clips__home__connection_v2: {
    edges: list.map(m => ({ node: { __typename: 'XDTClipsItemDict', media: m }, cursor: 'c' })),
    page_info: { has_next_page: more, end_cursor: 'next1' } } }, extensions: { is_final: true } };
}
// The same by shape: a REST clips answer, a key nobody knows.
function chainByShape(list) {
  return { items: list.map(m => ({ media: m })), paging_info: { max_id: 'm2', more_available: true }, status: 'ok' };
}
const keyCodes = p => p.data.xdt_api__v1__clips__home__connection_v2.edges.map(e => e.node.media.code);

/* ---------------- 1: the data ---------------- */

test('B24 data: the viewer\'s Reels chain keeps only the Reel the thread shares; nothing more is asked for', async () => {
  const page = await openPage(THREAD_URL, '<!doctype html><body></body>');
  const thread = await parse(page, threadPayload('SENT001'));
  // The thread's messages are untouched: all three, paging and all.
  assert.deepEqual(thread.thread.items.map(i => i.item_id), ['9001', '9002', '9003']);
  assert.equal(thread.thread.items[0].clip.clip.code, 'SENT001');
  assert.equal(thread.thread.has_older, true);
  const out = await parse(page, chainByKey([clip('SUGG001'), clip('SENT001'), clip('SUGG002'), clip('SUGG003')]));
  assert.deepEqual(keyCodes(out), ['SENT001']);
  assert.equal(out.data.xdt_api__v1__clips__home__connection_v2.page_info.has_next_page, false);
  const s = await dm(page);
  assert.deepEqual([s.trimmed, s.lists, s.byKey, s.keptSent, s.keptFirst, s.sentKnown], [3, 1, 1, 1, 0, 2]);
  assert.equal(await page.evaluate(() => window.__sg.stats.chainingTrimmed), 3);
  // A later page of the chain (if Instagram asks anyway) brings nothing.
  const next = await parse(page, chainByKey([clip('SUGG004'), clip('SUGG005')]));
  assert.deepEqual(keyCodes(next), []);
  assert.equal((await dm(page)).trimmed, 5);
});

test('B24 data: a chain of an unknown name is found by its shape (a paged list of Reels only)', async () => {
  const page = await openPage(THREAD_URL, '<!doctype html><body></body>');
  await parse(page, threadPayload('SENT001'));
  const out = await parse(page, chainByShape([clip('SUGG001'), clip('SENT001'), clip('SUGG002')]));
  assert.deepEqual(out.items.map(i => i.media.code), ['SENT001']);
  assert.equal(out.paging_info.more_available, false);
  // GraphQL's shape under a name nobody knows: edges of Reels with page_info.
  const gql = await parse(page, { data: { xdt_api__v1__direct__media_viewer__connection: {
    edges: [clip('SUGG007'), clip('SUGG008')].map(m => ({ node: { media: m } })), page_info: { has_next_page: true, end_cursor: 'x' } } } });
  assert.deepEqual(gql.data.xdt_api__v1__direct__media_viewer__connection.edges, []);
  assert.equal(gql.data.xdt_api__v1__direct__media_viewer__connection.page_info.has_next_page, false);
  const s = await dm(page);
  assert.deepEqual([s.trimmed, s.byShape, s.byKey], [4, 2, 0]);
});

test('B24 data: the thread\'s own lists are never touched (messages, its media, one Reel\'s own answer)', async () => {
  const page = await openPage(THREAD_URL, '<!doctype html><body></body>');
  // Messages with Reels in them, paged: each message wraps its share.
  const msgs = await parse(page, { items: [
    { item_id: '1', item_type: 'clip', clip: { clip: clip('SENT001') } },
    { item_id: '2', item_type: 'clip', clip: { clip: clip('SENT002') } },
    { item_id: '3', item_type: 'clip', clip: { clip: clip('SENT003') } }], more_available: true, next_cursor: 'c' });
  assert.deepEqual(msgs.items.map(i => i.item_id), ['1', '2', '3']);
  assert.equal(msgs.more_available, true);
  // GraphQL messages carrying a Reel's card (its link).
  const slide = await parse(page, { data: { xfb_slide_thread_messages: { edges: [1, 2, 3].map(i => ({ node: {
    message_id: 'm' + i, content: { xma: [{ target_url: 'https://www.instagram.com/reel/XMACODE' + i + '/?igsh=abc', title: 'card' }] } } })),
    page_info: { has_next_page: true, end_cursor: 'o' } } } });
  assert.equal(slide.data.xfb_slide_thread_messages.edges.length, 3);
  assert.equal(slide.data.xfb_slide_thread_messages.page_info.has_next_page, true);
  // The chat's photos and videos (not paged), and one Reel's own answer (its info).
  const coll = await parse(page, { medias: [clip('VID0001'), clip('VID0002'), media('PHOTO02', user('friend', true))] });
  assert.equal(coll.medias.length, 3);
  const info = await parse(page, { items: [clip('SENT001')], num_results: 1, more_available: false, status: 'ok' });
  assert.deepEqual(info.items.map(m => m.code), ['SENT001']);
  assert.equal((await dm(page)).trimmed, 0);
  // Every Reel those messages share counts as sent: a chain keeps any of them (one).
  const out = await parse(page, chainByKey([clip('SUGG001'), clip('XMACODE2'), clip('SUGG002')]));
  assert.deepEqual(keyCodes(out), ['XMACODE2']);
  assert.equal((await dm(page)).sentKnown, 6);
});

test('B24 data: with nothing known about the thread, the chain\'s first Reel is kept once (the one asked for)', async () => {
  const page = await openPage(THREAD_URL, '<!doctype html><body></body>');
  const out = await parse(page, chainByKey([clip('SENT001'), clip('SUGG001'), clip('SUGG002')]));
  assert.deepEqual(keyCodes(out), ['SENT001']);
  // Its next answer: the first one there is a suggestion, so nothing stays.
  const next = await parse(page, chainByShape([clip('SUGG003'), clip('SUGG004')]));
  assert.deepEqual(next.items, []);
  // The sent Reel coming back (drawn again from another answer) still stays.
  const again = await parse(page, chainByShape([clip('SUGG005'), clip('SENT001')]));
  assert.deepEqual(again.items.map(i => i.media.code), ['SENT001']);
  const s = await dm(page);
  assert.deepEqual([s.keptFirst, s.keptSent, s.trimmed], [1, 1, 5]);
  // A first Reel Instagram marks as recommended is never the sent one.
  const p2 = await openPage(THREAD_URL, '<!doctype html><body></body>');
  const rec = await parse(p2, chainByKey([clip('SUGG001', { inventory_source: 'clips_chaining_recommended' }), clip('SUGG002')]));
  assert.deepEqual(keyCodes(rec), []);
});

test('B24 data: the bubble you tapped in the chat names the sent Reel', async () => {
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body style="margin:0">
    <div id="thread" style="position:fixed;left:0;top:60px;width:412px;height:795px;overflow-y:auto">
      <div style="height:300px">older</div>
      <div role="button" id="bubble" style="width:200px;height:300px;position:relative"><div style="height:260px"><img src="/cover.jpg" style="width:200px;height:260px"></div>
        <a href="/reel/TAPPED1/?igsh=xyz" style="display:block;height:40px">friend</a></div>
      <div role="button" style="width:200px;height:300px"><a href="/reel/OTHER01/">other</a></div>
    </div></body></html>`;
  const page = await openPage(THREAD_URL, html);
  await tapAt(page, 100, 500);
  const out = await parse(page, chainByShape([clip('SUGG001'), clip('OTHER09'), clip('TAPPED1'), clip('SUGG002')]));
  assert.deepEqual(out.items.map(i => i.media.code), ['TAPPED1']);
  assert.equal((await dm(page)).keptSent, 1);
});

test('B24 data: Reels chains elsewhere work as before; a DM chain off a DM page is not B24\'s', async () => {
  const page = await openPage('https://www.instagram.com/reel/SENT001/', '<!doctype html><body></body>');
  const out = await parse(page, chainByKey([clip('OTHER01'), clip('SENT001'), clip('OTHER02')]));
  assert.deepEqual(keyCodes(out), ['SENT001']);
  // A REST answer of Reels on a Reel page isn't touched by B24's shape rule.
  const rest = await parse(page, chainByShape([clip('OTHER01'), clip('OTHER02')]));
  assert.equal(rest.items.length, 2);
  assert.equal((await dm(page)).trimmed, 0);
  // Instagram's non-profiled Reels connection is a chain too (it wasn't trimmed before 1.4).
  const conn = await parse(page, { data: { xdt_api__v1__clips__connected__connection_v2: {
    edges: [clip('OTHER03'), clip('SENT001'), clip('OTHER04')].map(m => ({ node: { media: m } })), page_info: { has_next_page: true } } } });
  assert.deepEqual(conn.data.xdt_api__v1__clips__connected__connection_v2.edges.map(e => e.node.media.code), ['SENT001']);
  assert.equal(conn.data.xdt_api__v1__clips__connected__connection_v2.page_info.has_next_page, false);
});

// A Reel sent while the chat is open arrives as a live message (a slide delta):
// no list, nothing but the card's link. Read with JSON.parse, as the realtime
// channel does.
function sliceDelta(code) {
  return { data: { slide_delta_processor: [{ __typename: 'SlideUQPPNewMessage', message: {
    message_id: 'mid.$delta1', timestamp_ms: '1700000000999', sender_fbid: '77',
    content: { xma: [{ target_url: `https://www.instagram.com/reel/${code}/?igsh=abc`, title: 'card', subtitle: 'friend' }] } } }] } };
}
function slideThread(codes) {
  return { data: { xfb_slide_thread_messages: { edges: codes.map((c, i) => ({ node: {
    message_id: 'm' + i, content: { xma: [{ target_url: `https://www.instagram.com/reel/${c}/`, title: 'card' }] } } })),
    page_info: { has_next_page: true, end_cursor: 'o' } } } };
}

test('B24 data: a Reel sent while the chat is open keeps its own place in its chain (old Reels known, the new one too)', async () => {
  const page = await openPage(THREAD_URL, '<!doctype html><body></body>');
  await parse(page, slideThread(['OLD00001', 'OLD00002']));
  const delta = JSON.stringify(sliceDelta('NEWSENT1'));
  // None of the words that send other answers through the filter.
  assert.doesNotMatch(delta, /"(?:edges|items|image_versions2|video_versions)"/);
  const back = await parse(page, sliceDelta('NEWSENT1'));
  assert.equal(back.data.slide_delta_processor[0].message.content.xma.length, 1, 'the message itself is untouched');
  assert.ok(await page.evaluate(() => window.__sg.b24Sent.codes.has('NEWSENT1')), 'the new Reel is known as sent');
  const out = await parse(page, chainByKey([clip('NEWSENT1'), clip('SUGG001'), clip('SUGG002')]));
  assert.deepEqual(keyCodes(out), ['NEWSENT1']);
  assert.equal((await dm(page)).keptSent, 1);
  // A later page of the same chain keeps nothing.
  assert.deepEqual(keyCodes(await parse(page, chainByKey([clip('SUGG003'), clip('SUGG004')]))), []);
});

test('B24 data: an answer with none of the thread\'s known Reels keeps its first one (the one asked for), not nothing', async () => {
  const page = await openPage(THREAD_URL, '<!doctype html><body></body>');
  await parse(page, slideThread(['OLD00001', 'OLD00002']));
  // The new Reel's message was never seen.
  const out = await parse(page, chainByKey([clip('NEWSENT1'), clip('SUGG001'), clip('SUGG002')]));
  assert.deepEqual(keyCodes(out), ['NEWSENT1']);
  assert.equal((await dm(page)).keptFirst, 1);
  assert.deepEqual(keyCodes(await parse(page, chainByKey([clip('SUGG003'), clip('SUGG004')]))), [], 'its next page brings nothing');
  // Still never a Reel Instagram marks as recommended.
  const p2 = await openPage(THREAD_URL, '<!doctype html><body></body>');
  await parse(p2, slideThread(['OLD00001']));
  assert.deepEqual(keyCodes(await parse(p2, chainByKey([clip('SUGG001', { inventory_source: 'clips_chaining_recommended' }), clip('SUGG002')]))), []);
});

// A chat whose Reel bubbles carry no link (pressables), and a viewer: full
// screen, or a landscape Reel not in a dialog (never counted as open).
const NOLINKS = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body style="margin:0">
  <div id="thread" style="position:fixed;left:0;top:60px;width:412px;height:795px;overflow-y:auto">
    <div style="height:200px">older</div>
    <div role="button" id="bA" style="width:200px;height:250px;background:#ccc">Reel A</div>
    <div role="button" id="bB" style="width:200px;height:250px;background:#aaa">Reel B</div>
  </div>
  <script>
    window.openViewer = function (land) {
      const d = document.createElement('div');
      d.id = 'viewer';
      d.style.cssText = 'position:fixed;inset:0;background:#000;z-index:5';
      d.innerHTML = '<video muted playsinline style="' + (land ? 'position:absolute;top:340px;left:0;width:412px;height:232px' : 'width:412px;height:915px;display:block') + '"></video>';
      document.body.appendChild(d);
    };
    window.closeViewer = () => { const d = document.getElementById('viewer'); if (d) d.remove(); };
  </script></body></html>`;

test('B24 data: a guessed Reel holds for its own opening only; the next Reel tapped keeps its place', async () => {
  const B = () => [clip('SENTBBB'), clip('SUGG004')];
  // A's answer lands after its viewer was closed (a slow network).
  let page = await openPage(THREAD_URL, NOLINKS);
  await tapAt(page, 100, 400);
  await page.evaluate(() => window.openViewer(false));
  await page.waitForFunction(() => window.__sg.dmReelOpen(), null, { timeout: 3000 });
  await page.evaluate(() => window.closeViewer());
  await page.waitForFunction(() => !window.__sg.dmReelOpen(), null, { timeout: 3000 });
  assert.deepEqual(keyCodes(await parse(page, chainByKey([clip('SENTAAA'), clip('SUGG001')]))), ['SENTAAA']);
  await tapAt(page, 100, 650);
  await page.evaluate(() => window.openViewer(false));
  assert.deepEqual(keyCodes(await parse(page, chainByKey(B()))), ['SENTBBB']);
  // A landscape Reel's viewer, never counted as open (so never closed).
  page = await openPage(THREAD_URL, NOLINKS);
  await tapAt(page, 100, 400);
  await page.evaluate(() => window.openViewer(true));
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => window.__sg.dmReelOpen()), false);
  assert.deepEqual(keyCodes(await parse(page, chainByKey([clip('SENTAAA'), clip('SUGG001')]))), ['SENTAAA']);
  await page.evaluate(() => window.closeViewer());
  await tapAt(page, 100, 650);
  await page.evaluate(() => window.openViewer(false));
  assert.deepEqual(keyCodes(await parse(page, chainByKey(B()))), ['SENTBBB']);
  // No viewer noticed at all (Back before its video was drawn).
  page = await openPage(THREAD_URL, NOLINKS);
  await tapAt(page, 100, 400);
  assert.deepEqual(keyCodes(await parse(page, chainByKey([clip('SENTAAA'), clip('SUGG001')]))), ['SENTAAA']);
  await tapAt(page, 100, 650);
  assert.deepEqual(keyCodes(await parse(page, chainByKey(B()))), ['SENTBBB']);
  assert.deepEqual(await page.evaluate(() => [...window.__sg.b24Sent.codes]), ['SENTBBB'], 'A\'s guess is gone');
});

/* ---------------- 2: the swipe in the open viewer ---------------- */

// A chat (its list scrolls) and, once opened, Instagram's Reel viewer over it:
// a vertically snapping list (the sent Reel, then a suggested one with its
// "Suggested" header) and the reply box.
const CHAT = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body style="margin:0">
  <div id="thread" style="position:fixed;left:0;top:60px;width:412px;height:795px;overflow-y:auto">
    ${Array.from({ length: 80 }, (_, i) => `<div style="height:40px">message ${i}</div>`).join('')}
    <div role="button" id="bubble" style="width:200px;height:300px"><a href="/reel/SENT001/">friend's Reel</a></div>
  </div>
  <script>
    window.__clicks = 0;
    window.openViewer = function (kind) {
      const v = document.createElement('div');
      v.id = 'viewer';
      v.setAttribute('role', 'dialog');
      v.style.cssText = 'position:fixed;left:0;top:0;width:412px;height:915px;background:#000;z-index:5';
      const slide = (id, header, vid) => '<div class="slide" id="' + id + '" style="position:relative;width:412px;height:915px;scroll-snap-align:start">' +
        '<div class="hdr" style="position:absolute;left:12px;top:14px;color:#fff;z-index:1"><span>' + header + '</span></div>' +
        '<video id="' + vid + '" muted playsinline loop style="width:412px;height:915px;display:block;background:#222"></video>' +
        '<div class="tap" style="position:absolute;left:0;top:60px;width:412px;height:700px"></div></div>';
      const reply = '<textarea id="reply" placeholder="Reply to friend…" style="position:absolute;left:10px;bottom:20px;width:300px;height:40px;z-index:2"></textarea>' +
        '<div id="caption" style="position:absolute;left:0;bottom:80px;width:412px;height:120px;overflow-y:auto;z-index:2"><div style="height:600px">a long caption</div></div>';
      if (kind === 'pager') {
        v.innerHTML = '<div id="stage" style="position:absolute;inset:0">' + slide('one', 'friend 9h ago', 'sent') + '</div>' + reply;
      } else {
        v.innerHTML = '<div id="list" style="position:absolute;inset:0;overflow-y:scroll;scroll-snap-type:y mandatory">' +
          slide('one', 'friend 9h ago', 'sent') + slide('two', 'Suggested', 'sugg') + '</div>' + reply;
      }
      v.addEventListener('click', () => window.__clicks++);
      document.body.appendChild(v);
    };
    window.closeViewer = () => document.getElementById('viewer').remove();
  </script></body></html>`;

async function openViewer(page, kind) {
  await page.evaluate(k => window.openViewer(k), kind || 'list');
  await page.waitForFunction(() => window.__sg.dmReelOpen(), null, { timeout: 3000 });
}

test('B24 swipe: no blocking listener in a chat; one only while the Reel viewer is open', async () => {
  const page = await openPage(THREAD_URL, CHAT, { init: watchListeners });
  assert.deepEqual(await page.evaluate(() => window.__blocking()), []);
  // The chat scrolls with a finger, nothing held.
  await watchMoves(page);
  await drag(page, [200, 300], [200, 700]);
  await page.evaluate(() => { document.getElementById('thread').scrollTop = 1000; });
  await drag(page, [200, 700], [200, 300]);
  assert.ok(await page.evaluate(() => document.getElementById('thread').scrollTop) > 1100, 'the chat scrolled');
  assert.equal(await page.evaluate(() => window.__held), 0);
  await openViewer(page);
  assert.deepEqual(await page.evaluate(() => window.__blocking()), ['touchmove']);
  assert.equal((await dm(page)).opened, 1);
  await page.evaluate(() => window.closeViewer());
  await page.waitForFunction(() => !window.__sg.dmReelOpen(), null, { timeout: 3000 });
  assert.deepEqual(await page.evaluate(() => window.__blocking()), []);
  assert.equal((await dm(page)).closed, 1);
  // The chat scrolls as before.
  await page.evaluate(() => { window.__held = 0; document.getElementById('thread').scrollTop = 1000; });
  await drag(page, [200, 700], [200, 300]);
  assert.ok(await page.evaluate(() => document.getElementById('thread').scrollTop) > 1100);
  assert.equal(await page.evaluate(() => window.__held), 0);
  // Right after the viewer closes (before SimpleGram has noticed), the chat scrolls already.
  await openViewer(page);
  const held = await page.evaluate(() => {
    window.closeViewer();
    const el = document.querySelector('#thread > div');
    const mk = (type, y) => {
      const t = new Touch({ identifier: 1, target: el, clientX: 200, clientY: y });
      return new TouchEvent(type, { touches: type === 'touchend' ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true });
    };
    el.dispatchEvent(mk('touchstart', 600));
    const move = mk('touchmove', 400);
    el.dispatchEvent(move);
    el.dispatchEvent(mk('touchend', 400));
    return [window.__sg.dmReelOpen(), move.defaultPrevented];
  });
  assert.deepEqual(held, [true, false], 'not yet noticed, and the chat\'s drag is not held');
  await page.waitForFunction(() => !window.__sg.dmReelOpen(), null, { timeout: 3000 });
  // Leaving DMs with the viewer open also takes the listener away.
  await openViewer(page);
  await page.evaluate(() => history.pushState(null, '', '/'));
  assert.deepEqual(await page.evaluate(() => window.__blocking()), []);
  assert.equal(await page.evaluate(() => window.__sg.dmReelOpen()), false);
});

test('B24 swipe: a chat\'s own videos are never taken for the viewer; a landscape Reel in the viewer is', async () => {
  // A short chat (nothing to scroll) in a full-screen layout, with a video message.
  const short = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body style="margin:0">
    <div style="position:fixed;inset:0;display:flex;flex-direction:column"><div style="height:60px">friend</div>
      <div id="thread" style="flex:1;overflow-y:auto"><div>hi</div>
        <video id="msgv" muted playsinline style="width:300px;height:400px;display:block"></video></div></div></body></html>`;
  let page = await openPage(THREAD_URL, short, { init: watchListeners });
  await page.evaluate(() => document.getElementById('msgv').dispatchEvent(new Event('loadedmetadata')));
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => window.__sg.dmReelOpen()), false);
  // A long chat with a big video message in its list (not a whole screen tall).
  page = await openPage(THREAD_URL, CHAT.replace('<div role="button" id="bubble"',
    '<video id="msgv" muted playsinline style="width:412px;height:620px;display:block"></video><div role="button" id="bubble"'), { init: watchListeners });
  await page.evaluate(() => { const t = document.getElementById('thread'); t.scrollTop = t.scrollHeight; });
  await page.evaluate(() => document.getElementById('msgv').dispatchEvent(new Event('loadedmetadata')));
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => window.__sg.dmReelOpen()), false);
  assert.deepEqual(await page.evaluate(() => window.__blocking()), []);
  const before = await page.evaluate(() => document.getElementById('thread').scrollTop);
  await drag(page, [200, 300], [200, 700]);
  assert.ok(await page.evaluate(() => document.getElementById('thread').scrollTop) < before - 100, 'the chat scrolled');
  // A landscape Reel letterboxed in Instagram's full-screen viewer.
  await page.evaluate(() => {
    const d = document.createElement('div');
    d.setAttribute('role', 'dialog');
    d.style.cssText = 'position:fixed;inset:0;background:#000;display:flex;align-items:center';
    d.innerHTML = '<video id="land" muted playsinline style="width:412px;height:232px;display:block"></video>';
    document.body.appendChild(d);
  });
  await page.waitForFunction(() => window.__sg.dmReelOpen(), null, { timeout: 3000 });
  assert.deepEqual(await page.evaluate(() => window.__blocking()), ['touchmove']);
});

test('B24 swipe: typing in a chat with the keyboard up, a video message is not taken for the viewer; the chat scrolls', async () => {
  // The chat: header, its list, and the message box. A portrait video message at the end.
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body style="margin:0">
    <div style="position:fixed;inset:0;display:flex;flex-direction:column"><div style="height:60px;flex:none">friend</div>
      <div id="thread" style="flex:1;overflow-y:auto">${Array.from({ length: 60 }, (_, i) => `<div style="height:40px">message ${i}</div>`).join('')}
        <video id="msgv" muted playsinline style="width:250px;height:440px;display:block;margin-left:150px"></video><div style="height:8px"></div></div>
      <div style="height:56px;flex:none"><div id="field" contenteditable="true" role="textbox" style="height:40px;border:1px solid #888"></div></div></div></body></html>`;
  const page = await openPage(THREAD_URL, html, { init: watchListeners });
  await page.evaluate(() => { const t = document.getElementById('thread'); t.scrollTop = t.scrollHeight; });
  await page.waitForTimeout(300);
  // The keyboard comes up: the app makes the page shorter.
  await page.setViewportSize({ width: 412, height: 580 });
  await page.evaluate(() => { const t = document.getElementById('thread'); t.scrollTop = t.scrollHeight; document.getElementById('field').focus(); });
  await page.keyboard.type('hey');
  await page.evaluate(() => document.getElementById('msgv').dispatchEvent(new Event('loadedmetadata')));
  await page.waitForTimeout(500);
  assert.ok(await page.evaluate(() => document.getElementById('msgv').getBoundingClientRect().height >= 0.75 * innerHeight), 'the bubble looks big');
  assert.equal(await page.evaluate(() => window.__sg.dmReelOpen()), false);
  assert.deepEqual(await page.evaluate(() => window.__blocking()), []);
  await watchMoves(page);
  const before = await page.evaluate(() => document.getElementById('thread').scrollTop);
  await drag(page, [100, 150], [100, 500]);
  assert.ok(await page.evaluate(() => document.getElementById('thread').scrollTop) < before - 100, 'the chat scrolled');
  assert.equal(await page.evaluate(() => window.__held), 0);
  assert.equal((await dm(page)).swipes, 0);
});

// Touch moves held still (preventDefault), counted as they happen.
function countHolds() {
  window.__pd = 0;
  const pd = Event.prototype.preventDefault;
  Event.prototype.preventDefault = function () { if (this.type === 'touchmove') window.__pd++; return pd.apply(this, arguments); };
}

test('B24 swipe: in the open viewer a swipe up or down doesn\'t move on; taps, sideways swipes and the reply box still work', async () => {
  const page = await openPage(THREAD_URL, CHAT, { init: countHolds });
  await openViewer(page);
  // What Instagram's own listeners on the page see.
  await watchMoves(page);
  const top = () => page.evaluate(() => document.getElementById('list').scrollTop);
  const seen = () => page.evaluate(() => [window.__pd, window.__free + window.__held]);
  await drag(page, [200, 700], [200, 200]);
  assert.equal(await top(), 0, 'still on the sent Reel');
  await drag(page, [200, 200], [200, 700]);
  assert.equal(await top(), 0);
  // Held still, and Instagram's viewer never saw them move.
  const [held, igSaw] = await seen();
  assert.ok(held >= 14, String(held));
  assert.equal(igSaw, 0);
  assert.equal((await dm(page)).swipes, 2);
  assert.equal(await page.evaluate(() => window.__sg.stats.swipesBlocked), 2);
  // A tap reaches Instagram's viewer (pause, its buttons).
  await tapAt(page, 200, 400);
  assert.equal(await page.evaluate(() => window.__clicks), 1);
  // A sideways swipe isn't held.
  await page.evaluate(() => { window.__pd = 0; window.__free = 0; window.__held = 0; });
  await drag(page, [380, 400], [40, 420]);
  assert.deepEqual(await seen(), [0, 8]);
  // The reply box and the caption's own list are left alone.
  await page.evaluate(() => { window.__free = 0; });
  await drag(page, [100, 875], [100, 600]);
  await drag(page, [200, 800], [200, 720]);
  const [heldNow, sawNow] = await seen();
  assert.equal(heldNow, 0);
  assert.ok(sawNow >= 12, String(sawNow));
  assert.ok(await page.evaluate(() => document.getElementById('caption').scrollTop) > 20, 'the caption scrolled');
  assert.equal(await top(), 0);
  assert.equal((await dm(page)).swipes, 2);
});

test('B24 swipe: a pager moved by touch or pointer handlers on the app\'s root never sees a held swipe', async () => {
  const html = CHAT.replace('</script>', `
    window.__moved = 0;
    (function () {
      let s = null, p = null;
      document.addEventListener('touchstart', e => { s = { y: e.touches[0].clientY, dy: 0 }; });
      document.addEventListener('touchmove', e => { if (s) s.dy = e.touches[0].clientY - s.y; });
      document.addEventListener('touchend', () => { if (s && Math.abs(s.dy) > 80) window.__moved++; s = null; });
      document.addEventListener('pointerdown', e => { p = { y: e.clientY, dy: 0 }; });
      document.addEventListener('pointermove', e => { if (p) p.dy = e.clientY - p.y; });
      document.addEventListener('pointerup', () => { if (p && Math.abs(p.dy) > 80) window.__moved++; p = null; });
    })();
  </script>`);
  const page = await openPage(THREAD_URL, html);
  // In the chat (no viewer) Instagram's handlers see the drag, as before (its
  // pointers are cancelled once the browser scrolls: only the touch counts).
  await drag(page, [200, 700], [200, 300]);
  assert.equal(await page.evaluate(() => window.__moved), 1);
  await page.evaluate(() => { window.__moved = 0; });
  await openViewer(page, 'pager');
  await drag(page, [200, 700], [200, 200]);
  await drag(page, [200, 200], [200, 700]);
  assert.equal(await page.evaluate(() => window.__moved), 0);
  assert.equal((await dm(page)).swipes, 2);
});

/* ---------------- 3: a suggested Reel that slips through ---------------- */

test('B24 slip: the list moved on to a "Suggested" Reel is put back on the sent one, and the suggested one hidden', async () => {
  const page = await openPage(THREAD_URL, CHAT);
  await openViewer(page);
  // Instagram moves its list itself (an end-of-video advance, or a data path SimpleGram didn't see).
  await page.evaluate(() => { document.getElementById('list').scrollTop = 915; });
  await page.waitForFunction(() => window.__sg.stats.dmReel.returned === 1, null, { timeout: 3000 });
  const r = await page.evaluate(() => ({
    top: document.getElementById('list').scrollTop,
    hidden: document.getElementById('two').dataset.sgDmHide,
    vis: getComputedStyle(document.getElementById('sugg')).visibility,
    sentShown: getComputedStyle(document.getElementById('sent')).visibility,
    sentMark: document.getElementById('one').dataset.sgDmHide,
  }));
  assert.deepEqual(r, { top: 0, hidden: '1', vis: 'hidden', sentShown: 'visible', sentMark: undefined });
  const s = await dm(page);
  assert.deepEqual([s.header, s.hidden, s.returned, s.stuck], [1, 1, 1, 0]);
  assert.equal(await page.evaluate(() => window.__sg.dmReelOpen()), true);
  // The hidden one never plays (Instagram may try), and gets no sound.
  await page.evaluate(() => {
    const v = document.getElementById('sugg');
    window.__pauses = 0;
    v.pause = () => { window.__pauses++; };
    v.dispatchEvent(new Event('play'));
  });
  assert.equal(await page.evaluate(() => window.__pauses), 1);
  assert.equal(await page.evaluate(() => document.getElementById('sugg').muted), true);
  // Closing the viewer puts everything back as Instagram left it.
  await page.evaluate(() => { const v = document.getElementById('viewer'); v.style.display = 'none'; });
  await page.evaluate(() => document.body.appendChild(document.createElement('div')));
  await page.waitForFunction(() => !window.__sg.dmReelOpen(), null, { timeout: 3000 });
  assert.equal(await page.evaluate(() => document.getElementById('two').dataset.sgDmHide), undefined);
});

test('B24 slip: with no "Suggested" header, the list moving off the sent Reel is caught too', async () => {
  const page = await openPage(THREAD_URL, CHAT);
  await openViewer(page);
  await page.evaluate(() => { document.querySelector('#two .hdr span').textContent = 'creator 2d'; document.getElementById('list').scrollTop = 915; });
  await page.waitForFunction(() => window.__sg.stats.dmReel.returned === 1, null, { timeout: 3000 });
  const s = await dm(page);
  assert.deepEqual([s.moved, s.header, s.hidden], [1, 0, 1]);
  assert.equal(await page.evaluate(() => document.getElementById('list').scrollTop), 0);
});

test('B24 slip: a pager that swapped in a suggested Reel: it is hidden and paused, and the app says how to get back (once)', async () => {
  const page = await openPage(THREAD_URL, CHAT);
  await openViewer(page, 'pager');
  // Instagram's pager hides the sent Reel's slide and shows the next one.
  const swap = () => page.evaluate(() => {
    const stage = document.getElementById('stage');
    for (const s of stage.querySelectorAll('.slide')) s.style.display = 'none';
    const n = document.createElement('div');
    n.className = 'slide';
    n.style.cssText = 'position:relative;width:412px;height:915px';
    n.innerHTML = '<div style="position:absolute;left:12px;top:14px;color:#fff"><span>Suggested</span></div>' +
      '<video class="sv" muted playsinline style="width:412px;height:915px;display:block"></video>';
    stage.appendChild(n);
  });
  await swap();
  await waitSent(page, 'toast');
  const s = await dm(page);
  assert.deepEqual([s.header, s.hidden, s.stuck, s.returned], [1, 1, 1, 0]);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.sv')).visibility), 'hidden');
  assert.equal(await page.evaluate(() => window.__sg.dmReelOpen()), true, 'the viewer still counts as open');
  const [t] = await sent(page, 'toast');
  assert.match(t.message, /Suggested Reels are hidden/);
  await swap();
  await page.waitForFunction(() => window.__sg.stats.dmReel.hidden === 2, null, { timeout: 3000 });
  assert.equal((await sent(page, 'toast')).length, 1, 'said once per opening');
});

test('B24 slip x R11: a suggested Reel left hidden (the return failed) gets no progress bar, even once it has loaded', async () => {
  const page = await openPage(THREAD_URL, CHAT);
  await openViewer(page, 'pager');
  // The sent Reel plays and has its bar (R11, the DM Reel viewer).
  await page.evaluate(() => { const v = document.getElementById('sent'); v.src = '/v/sent.webm'; v.play().catch(() => {}); });
  await page.waitForFunction(() => document.querySelector('[data-sg-bar="dm"]'), null, { timeout: 3000 });
  // Instagram's pager swaps in a suggested Reel that has its own clip and loads it.
  await page.evaluate(() => {
    const stage = document.getElementById('stage');
    for (const s of stage.querySelectorAll('.slide')) s.style.display = 'none';
    const n = document.createElement('div');
    n.className = 'slide';
    n.style.cssText = 'position:relative;width:412px;height:915px';
    n.innerHTML = '<div style="position:absolute;left:12px;top:14px;color:#fff"><span>Suggested</span></div>' +
      '<video class="sv" src="/v/sugg.webm" muted playsinline loop style="width:412px;height:915px;display:block"></video>';
    stage.appendChild(n);
  });
  await waitSent(page, 'toast');
  await page.waitForFunction(() => document.querySelector('.sv').readyState >= 1, null, { timeout: 3000 });
  await page.waitForTimeout(1300);   // the bar's own once-a-second look
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.sv')).visibility), 'hidden');
  assert.equal((await dm(page)).stuck, 1);
  const bars = await page.evaluate(() => Array.from(document.querySelectorAll('[data-sg-bar]'))
    .filter(b => getComputedStyle(b).visibility !== 'hidden' && b.getBoundingClientRect().width > 0).length);
  assert.equal(bars, 0, 'no bar over the blank viewer for a Reel nobody can see');
});

test('B24 slip: the sent Reel drawn again (a new element for the same Reel) is not taken for a suggestion', async () => {
  const page = await openPage(THREAD_URL, CHAT);
  await openViewer(page, 'pager');
  await page.evaluate(() => {
    const one = document.getElementById('one');
    const copy = one.cloneNode(true);
    copy.id = 'one2';
    copy.querySelector('video').id = 'sent2';
    one.remove();
    document.getElementById('stage').appendChild(copy);
  });
  await page.waitForTimeout(800);
  const s = await dm(page);
  assert.deepEqual([s.hidden, s.header, s.moved], [0, 0, 0]);
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('sent2')).visibility), 'visible');
});

// The viewer paging sideways through the message's own videos (several videos
// in one message, or a shared carousel): a scrolling carousel, or a pager that
// keeps both slides in the page and moves them.
function sidewaysViewer(kind) {
  const vid = id => `<video id="${id}" src="/v/${id}.webm" muted playsinline loop style="width:412px;height:915px;display:block;background:#222"></video>`;
  const head = '<div style="position:absolute;left:12px;top:14px;color:#fff;z-index:1">friend 9h ago</div>';
  return kind === 'carousel'
    ? `<div id="car" style="position:absolute;inset:0;display:flex;overflow-x:auto;scroll-snap-type:x mandatory">
        <div style="flex:0 0 412px;position:relative;scroll-snap-align:start">${head}${vid('s1')}</div>
        <div style="flex:0 0 412px;position:relative;scroll-snap-align:start">${vid('s2')}</div></div>`
    : `<div id="track" style="position:absolute;top:0;left:0;width:824px;height:915px;display:flex">
        <div style="flex:0 0 412px;position:relative">${head}${vid('s1')}</div>
        <div style="flex:0 0 412px;position:relative">${vid('s2')}</div></div>`;
}
for (const kind of ['carousel', 'pager']) {
  test(`B24 slip: paging sideways to the message's next video (${kind}) follows it: not hidden, not a suggestion`, async () => {
    const page = await openPage(THREAD_URL, CHAT, { init: countHolds });
    await page.evaluate(body => {
      const d = document.createElement('div');
      d.setAttribute('role', 'dialog');
      d.style.cssText = 'position:fixed;inset:0;background:#000;z-index:5';
      d.innerHTML = body;
      document.body.appendChild(d);
      for (const v of d.querySelectorAll('video')) v.play().catch(() => {});
    }, sidewaysViewer(kind));
    await page.waitForFunction(() => window.__sg.dmReelOpen(), null, { timeout: 3000 });
    await drag(page, [380, 450], [30, 455], { steps: 10 });
    if (kind === 'pager') {
      await page.evaluate(() => { document.getElementById('track').style.transform = 'translateX(-412px)'; document.getElementById('s2').dispatchEvent(new Event('playing')); });
    }
    await page.waitForTimeout(900);
    // A snapping carousel may still be settling on a busy machine: wait for it.
    await page.waitForFunction(() => Math.abs(document.getElementById('s2').getBoundingClientRect().left) < 1, null, { timeout: 4000 }).catch(() => {});
    const r = await page.evaluate(() => {
      const s2 = document.getElementById('s2');
      return { left: Math.round(s2.getBoundingClientRect().left), hidden: !!s2.closest('[data-sg-dm-hide]'), vis: getComputedStyle(s2).visibility, paused: s2.paused };
    });
    assert.deepEqual(r, { left: 0, hidden: false, vis: 'visible', paused: false });
    let s = await dm(page);
    assert.deepEqual([s.moved, s.header, s.hidden, s.stuck, s.returned], [0, 0, 0, 0, 0]);
    assert.ok(s.sideways >= 1);
    assert.equal((await sent(page, 'toast')).length, 0);
    // A vertical swipe on the second video is still held.
    await page.evaluate(() => { window.__pd = 0; });
    await drag(page, [200, 700], [200, 200]);
    assert.ok(await page.evaluate(() => window.__pd) >= 6);
    s = await dm(page);
    assert.equal(s.swipes, 1);
    assert.equal(await page.evaluate(() => window.__sg.dmReelOpen()), true);
  });
}

test('B24 slip: a viewer that fades out and stays in the page counts as closed; the next one is watched as usual', async () => {
  const page = await openPage(THREAD_URL, CHAT, { init: watchListeners });
  await openViewer(page);
  assert.deepEqual(await page.evaluate(() => window.__blocking()), ['touchmove']);
  // Instagram fades its viewer out and leaves it mounted.
  await page.evaluate(() => {
    const v = document.getElementById('viewer');
    v.style.opacity = '0';
    v.style.pointerEvents = 'none';
    // Its own names out of the way of the next viewer's.
    v.id = 'old';
    for (const el of v.querySelectorAll('[id]')) el.id = 'old-' + el.id;
  });
  await page.evaluate(() => { document.getElementById('thread').scrollTop += 200; });
  await page.waitForFunction(() => !window.__sg.dmReelOpen(), null, { timeout: 3000 });
  assert.deepEqual(await page.evaluate(() => window.__blocking()), []);
  assert.equal((await dm(page)).closed, 1);
  // The chat scrolls with nothing held.
  await page.waitForTimeout(800);
  assert.equal(await page.evaluate(() => window.__sg.dmReelOpen()), false, 'the faded one does not open again');
  // The next viewer: its own Reel is the sent one, and a suggested one is caught.
  await openViewer(page);
  assert.equal((await dm(page)).opened, 2);
  await page.evaluate(() => { document.getElementById('list').scrollTop = 915; });
  await page.waitForFunction(() => window.__sg.stats.dmReel.returned === 1, null, { timeout: 3000 });
  assert.equal(await page.evaluate(() => document.getElementById('two').dataset.sgDmHide), '1');
  assert.equal(await page.evaluate(() => document.getElementById('list').scrollTop), 0);
  assert.equal((await dm(page)).header, 1);
});

/* ---------------- The sent Reel: sound and autoplay ---------------- */

test('B24: the sent Reel in the viewer keeps its sound and its autoplay', async () => {
  const html = CHAT.replace('<div role="button" id="bubble"', '<div role="button" id="bubble"');
  const page = await openPage(THREAD_URL, html);
  await openViewer(page);
  await page.evaluate(() => {
    const v = document.getElementById('sent');
    window.__plays = 0;
    v.play = () => { window.__plays++; return Promise.resolve(); };
    v.dispatchEvent(new Event('loadedmetadata'));
  });
  await page.waitForFunction(() => window.__plays >= 1, null, { timeout: 3000 });
  await page.evaluate(() => document.getElementById('sent').dispatchEvent(new Event('play')));
  await page.waitForFunction(() => document.getElementById('sent').muted === false, null, { timeout: 3000 });
  assert.equal(await page.evaluate(() => window.__sg.stats.autoplayed), 1);
});

/* ---------------- Copy details ---------------- */

test('B24: Copy details counts what was trimmed and held, numbers only', async () => {
  const page = await openPage(THREAD_URL, CHAT);
  await parse(page, threadPayload('SENT001'));
  await parse(page, chainByKey([clip('SUGG001'), clip('SENT001')]));
  await openViewer(page);
  await drag(page, [200, 700], [200, 200]);
  await page.evaluate(() => window.__sg.onNative({ type: 'status' }));
  const [st] = await waitSent(page, 'status');
  const d = st.stats.dmReel;
  assert.ok(d && Object.keys(d).length >= 10);
  for (const [k, v] of Object.entries(d)) assert.equal(typeof v, 'number', k);
  assert.deepEqual([d.trimmed, d.keptSent, d.opened, d.swipes], [1, 1, 1, 1]);
  assert.doesNotMatch(JSON.stringify(Object.values(d)), /[A-Za-z]/);
});
