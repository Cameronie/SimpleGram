// B20: the comment box in the half-screen comments panel.
//
// Models of the bottom of Instagram's mobile comments page, as its bundles lay
// it out: the page layout (PolarisPageLayoutHandler) puts the bottom bar in a
// fixed box (50px, --revamp-nav-bottom-toolbar-height, plus
// env(safe-area-inset-bottom) padding) and, below 767px wide, caps the main
// column at calc(100% - 50px) (always) and gives it a bottom margin of
// --mobile-nav-height (45px, while the bar shows); the comment row (PolarisPostCommentInput) holds
// an auto-sizing textarea (ReactTextareaAutosize) with a max height. Desktop
// Chromium reports env(safe-area-inset-*) as 0, so the phone's safe-area
// padding is modelled as the 34px it would add. Every request is answered
// locally; nothing reaches Instagram.
//
// Run: NODE_PATH=/opt/node-tools/node_modules node --test tests/*.test.cjs
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SCRIPT, ME, useBrowser, getBrowser } = require('./helpers.cjs');

useBrowser();

const URL_ = 'https://www.instagram.com/p/ABCDEFG/comments/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SAFE = 34;   // what env(safe-area-inset-bottom) adds on a phone drawn under its navigation bar

const NAV = `<div id="nav" style="position:fixed;bottom:0;left:0;right:0;height:50px;padding-bottom:${SAFE}px;display:flex;z-index:3;background:#fff">
  <div><a href="/">Home</a></div><div><a href="/explore/">Search</a></div><div><a href="/reels/">Reels</a></div>
  <div><a href="/direct/inbox/">DM</a></div><div><a href="/me/">Profile</a></div></div>`;

function comments(n) {
  let out = '';
  for (let i = 0; i < n; i++) out += `<div class="c" style="height:64px;border-bottom:1px solid #eee">comment ${i}</div>`;
  return out;
}

// Instagram's comment row: avatar, the auto-sizing field (one line, up to 80px) and Post.
function row(style) {
  return `<section id="bar" style="display:flex;align-items:center;border-top:1px solid #ddd;padding:8px 16px;${style || ''}">
    <img id="avatar" src="/a.png" style="width:32px;height:32px;border-radius:50%">
    <form id="form" method="POST" style="display:flex;flex-grow:1;margin:0;padding:0">
      <textarea id="field" aria-label="Add a comment…" placeholder="Add a comment…"
        style="display:flex;flex-grow:1;height:18px;max-height:80px;line-height:18px;font-size:14px;border:0;padding:0;resize:none;outline:none"></textarea>
      <div role="button" id="postBtn" style="padding:0 0 0 8px">Post</div>
    </form></section>`;
}
const AUTOSIZE = `<script>
  // ReactTextareaAutosize: height follows the text (the max height caps it).
  const f = document.getElementById('field');
  f.addEventListener('input', () => { f.style.height = 'auto'; f.style.height = f.scrollHeight + 'px'; });
  document.getElementById('postBtn').addEventListener('click', () => { window.__posted = (window.__posted || 0) + 1; });
</script>`;

// The page layout's column: fixed bar, then the main column, capped at the
// page less the bar and with a margin under it (Instagram's atomic classes,
// x14k21rp and x8vgawa, inside the same media query); inside, the comments
// scroll and the row sits at the end. The row also has the safe-area padding under it.
const MAIN_CSS = `<style>html,body{height:100%}
@media (max-width:767px){#main{max-height:calc(100% - 50px);margin-bottom:45px}}</style>`;
function inFlowPage(n = 30) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width">${MAIN_CSS}</head>
<body style="margin:0;height:100%"><div id="root" style="display:flex;flex-direction:column;justify-content:space-between;height:100%">
  ${NAV}
  <div id="main" style="flex:1 1 auto;min-height:0;display:flex;flex-direction:column">
    <div id="title" style="height:44px">Comments</div>
    <div id="list" style="flex:1 1 auto;min-height:0;overflow-y:auto">${comments(n)}</div>
    ${row(`padding-bottom:${8 + SAFE}px`)}
  </div></div>${AUTOSIZE}</body></html>`;
}

// The other way round: the window scrolls the comments and the row is fixed,
// lifted above the bar by its height and the safe area.
function fixedPage(n = 30) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head>
<body style="margin:0"><main id="main" style="padding-bottom:${60 + 50 + SAFE}px">
  <div id="title" style="height:44px">Comments</div><div id="list">${comments(n)}</div></main>
  <div id="fixedRow" style="position:fixed;left:0;right:0;bottom:${50 + SAFE}px;background:#fff;z-index:2">${row()}</div>
  ${NAV}${AUTOSIZE}</body></html>`;
}

async function open(html, { role = 'comments', width = 412, height = 500 } = {}) {
  const context = await getBrowser().newContext({ viewport: { width, height }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.__errors = [];
  page.on('pageerror', e => page.__errors.push(String(e)));
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.pathname === new URL(URL_).pathname) return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    return route.fulfill({ status: 200, contentType: 'text/html', body: '' });
  });
  await page.addInitScript(() => {
    window.__sent = [];
    window.SGNative = { postMessage: m => window.__sent.push(JSON.parse(m)) };
  });
  await page.addInitScript(`window.__sgCfg=${JSON.stringify({ role, version: 'test', searchPages: 3, viewerId: ME })};\n${SCRIPT}`);
  await page.goto(URL_);
  return page;
}

// Layout facts: the space under the row, the row's and field's heights, how much of the list shows.
function layout(page) {
  return page.evaluate(() => {
    const bar = document.getElementById('bar').getBoundingClientRect();
    const field = document.getElementById('field');
    const list = document.getElementById('list');
    const fr = field.getBoundingClientRect();
    const hit = document.elementFromPoint(fr.left + fr.width / 2, fr.top + fr.height / 2);
    return {
      gap: Math.round(innerHeight - bar.bottom), barH: Math.round(bar.height), fieldH: Math.round(fr.height),
      listShown: Math.round(Math.min(list.getBoundingClientRect().bottom, bar.top) - Math.max(0, list.getBoundingClientRect().top)),
      reachable: hit === field, focused: document.activeElement === field,
      barShown: getComputedStyle(document.getElementById('bar')).display !== 'none',
      navHidden: document.getElementById('nav').style.display === 'none',
    };
  });
}
async function fitted(page) {
  await page.waitForFunction(() => window.__sg && window.__sg.stats.comments.gapAfter != null &&
    document.getElementById('nav').style.display === 'none');
  await sleep(100);
}

test('comment box: in-flow layout loses the band under the box; the comments get the space', async () => {
  // Before: the same page with the bar hidden but nothing else changed.
  const plain = await open(inFlowPage(), { role: 'main' });
  await plain.evaluate(() => { document.getElementById('nav').style.display = 'none'; });
  const before = await layout(plain);
  assert.equal(before.gap, 50, 'the main column keeps the bar\'s room');
  assert.ok(before.barH >= 16 + 18 + SAFE, 'the row has the safe-area padding under it: ' + before.barH);

  const page = await open(inFlowPage());
  await fitted(page);
  const after = await layout(page);
  const st = await page.evaluate(() => window.__sg.stats.comments);
  assert.equal(st.gapBefore, 50);
  assert.equal(after.gap, 0, 'nothing under the box');
  assert.ok(after.barH <= 16 + 32 + 2, 'one line high: ' + after.barH);
  assert.equal(after.listShown - before.listShown, 50 + SAFE, 'the comments get the freed room');
  assert.ok(after.barShown && after.reachable, 'the box stays and can be tapped');
  assert.ok(after.navHidden);
  assert.ok(st.fixes.margin >= 1 && st.fixes.padding >= 1 && st.fixes.maxHeight === 1, JSON.stringify(st.fixes));
  assert.deepEqual(page.__errors, []);
});

test('comment box: a column that scrolls with the page keeps its cap (the box would leave the screen)', async () => {
  // No inner scroller: the capped column scrolls itself and the row sticks to its bottom.
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head>
<body style="margin:0"><div id="main" style="max-height:calc(100vh - 50px);overflow-y:auto">
  <div id="title" style="height:44px">Comments</div><div id="list">${comments(30)}</div>
  ${row('position:sticky;bottom:0;background:#fff')}</div>${NAV}${AUTOSIZE}</body></html>`;
  const page = await open(html);
  await fitted(page);
  const r = await page.evaluate(() => ({
    fit: document.getElementById('main').dataset.sgFit || '',
    maxH: getComputedStyle(document.getElementById('main')).maxHeight,
    fixes: window.__sg.stats.comments.fixes,
  }));
  assert.doesNotMatch(r.fit, /max-height/);
  assert.equal(r.maxH, '450px', 'its own cap, put back');
  assert.equal(r.fixes.maxHeight, undefined);
  const after = await layout(page);
  assert.equal(after.gap, 50, 'left as Instagram has it');
  assert.ok(after.reachable);
  assert.deepEqual(page.__errors, []);
});

test('comment box: tapping it opens it, it grows while typing and shrinks back when you leave it', async () => {
  const page = await open(inFlowPage());
  await fitted(page);
  const reading = await layout(page);
  await page.tap('#field');
  assert.ok((await layout(page)).focused);
  await page.keyboard.type('one');
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Shift+Enter'); await page.keyboard.type('more'); }
  const typing = await layout(page);
  assert.ok(typing.fieldH >= 18 * 3, 'grows with the text: ' + typing.fieldH);
  assert.ok(typing.fieldH <= 80, 'as far as Instagram lets it: ' + typing.fieldH);
  assert.equal(typing.gap, 0, 'still nothing under it');
  assert.ok(typing.listShown < reading.listShown);
  // Leaving it (a tap on the comments) shrinks it back to one line, the draft kept.
  await page.tap('#title');
  await sleep(600);
  const left = await layout(page);
  assert.equal(left.fieldH, 18);
  assert.equal(left.listShown, reading.listShown);
  assert.match(await page.inputValue('#field'), /^one\nmore\nmore\nmore$/);
  // Back in: as tall as the text again.
  await page.tap('#field');
  await sleep(100);
  assert.ok((await layout(page)).fieldH >= 18 * 3);
  assert.deepEqual(page.__errors, []);
});

test('comment box: a tap on Post lands before the box shrinks', async () => {
  const page = await open(inFlowPage());
  await fitted(page);
  await page.tap('#field');
  await page.keyboard.type('a');
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Shift+Enter'); await page.keyboard.type('b'); }
  await page.tap('#postBtn');
  assert.equal(await page.evaluate(() => window.__posted), 1);
});

test('comment box: the keyboard shrinks the panel and the box stays in view, on its line', async () => {
  const page = await open(inFlowPage());
  await fitted(page);
  await page.tap('#field');
  // adjustResize: the panel's page gets shorter while the keyboard is up.
  await page.setViewportSize({ width: 412, height: 260 });
  await sleep(500);
  const up = await layout(page);
  assert.equal(up.gap, 0);
  assert.ok(up.focused && up.reachable);
  await page.setViewportSize({ width: 412, height: 500 });
  await sleep(300);
  assert.equal((await layout(page)).gap, 0);
});

test('comment box: putting the keyboard away with Back (no blur) shrinks it back to one line', async () => {
  const page = await open(inFlowPage());
  await fitted(page);
  await page.tap('#field');
  // Focus alone (no keyboard seen yet, or a hardware keyboard) keeps it open.
  await sleep(300);
  assert.equal(await page.evaluate(() => document.getElementById('field').dataset.sgOpen), '1');
  await page.setViewportSize({ width: 412, height: 260 });
  await sleep(300);
  await page.keyboard.type('one');
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Shift+Enter'); await page.keyboard.type('more'); }
  assert.ok((await layout(page)).fieldH >= 18 * 3);
  // Back: the panel gets its height back, the field keeps focus.
  await page.setViewportSize({ width: 412, height: 500 });
  await sleep(500);
  const reading = await layout(page);
  assert.ok(reading.focused, 'still focused');
  assert.equal(reading.fieldH, 18, 'one line while reading');
  assert.equal(reading.gap, 0);
  assert.match(await page.inputValue('#field'), /^one\nmore\nmore\nmore$/, 'the draft is kept');
  // The keyboard back up: as tall as the text again.
  await page.setViewportSize({ width: 412, height: 260 });
  await sleep(500);
  assert.ok((await layout(page)).fieldH >= 18 * 3);
  // Away again, then a tap on the (still focused) box opens it.
  await page.setViewportSize({ width: 412, height: 500 });
  await sleep(500);
  assert.equal((await layout(page)).fieldH, 18);
  await page.tap('#field');
  await sleep(200);
  assert.ok((await layout(page)).fieldH >= 18 * 3);
  assert.deepEqual(page.__errors, []);
});

test('comment box: when the window scrolls, the keyboard coming up still leaves the box in view', async () => {
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head>
<body style="margin:0"><div id="title" style="height:44px">Comments</div><div id="list">${comments(30)}</div>
  ${row()}${NAV}${AUTOSIZE}</body></html>`;
  const page = await open(html);
  await fitted(page);
  await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
  await page.tap('#field');
  await page.setViewportSize({ width: 412, height: 260 });
  await page.waitForFunction(() => {
    const r = document.getElementById('bar').getBoundingClientRect();
    return r.bottom <= innerHeight + 1 && r.top >= 0;
  }, null, { timeout: 3000 });
  assert.ok((await layout(page)).focused);
  assert.equal(await page.evaluate(() => window.__sg.stats.comments.scrolled), 1, 'SimpleGram brought it into view');
});

test('comment box: a fixed box lifted above the bar comes down to the bottom', async () => {
  const plain = await open(fixedPage(), { role: 'main' });
  await plain.evaluate(() => { document.getElementById('nav').style.display = 'none'; });
  assert.equal((await layout(plain)).gap, 50 + SAFE, 'the band before');

  const page = await open(fixedPage());
  await fitted(page);
  const after = await layout(page);
  assert.equal(after.gap, 0);
  assert.ok(after.reachable);
  const st = await page.evaluate(() => window.__sg.stats.comments);
  assert.equal(st.gapBefore, 50 + SAFE);
  assert.equal(st.fixes.offset, 1);
  // The last comment still scrolls clear of the box.
  await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
  const clear = await page.evaluate(() => {
    const last = document.querySelector('#list .c:last-child').getBoundingClientRect();
    return last.bottom <= document.getElementById('bar').getBoundingClientRect().top + 1;
  });
  assert.ok(clear);
  await page.tap('#field');
  await page.keyboard.type('hi');
  assert.equal(await page.inputValue('#field'), 'hi');
});

test('comment box: an empty stand-in for the bar under the box goes; the box is never hidden', async () => {
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head>
<body style="margin:0"><div style="display:flex;flex-direction:column;height:100vh">
  <div id="list" style="flex:1 1 auto;min-height:0;overflow-y:auto">${comments(20)}</div>
  ${row()}<div id="spacer" style="height:50px;flex:none"></div></div>
  ${NAV}${AUTOSIZE}</body></html>`;
  const page = await open(html);
  await fitted(page);
  const after = await layout(page);
  assert.equal(after.gap, 0);
  assert.equal(await page.evaluate(() => document.getElementById('spacer').dataset.sgHidden), 'spacer');
  assert.ok(after.barShown && after.reachable);
});

test('comment box: if moving it down would put it under something, it is put back', async () => {
  // A bar SimpleGram doesn't recognise (no Instagram links) stays over the bottom.
  const html = fixedPage().replace(NAV, `<div id="nav" style="position:fixed;bottom:0;left:0;right:0;height:${50 + SAFE}px;z-index:5;background:#eee"><div>other bar</div></div>`);
  const page = await open(html);
  await page.waitForFunction(() => window.__sg.stats.comments.gapAfter != null);
  await sleep(200);
  const st = await page.evaluate(() => window.__sg.stats.comments);
  assert.equal(st.reverted, 1);
  const after = await layout(page);
  assert.equal(after.gap, 50 + SAFE, 'left where Instagram put it');
  assert.ok(after.reachable);
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-sg-fit]').length), 0);
});

const OTHER_BAR = `<div id="nav" style="position:fixed;bottom:0;left:0;right:0;height:${50 + SAFE}px;z-index:5;background:#eee"><div>other bar</div></div>`;
async function settled(page) {
  const r = await page.evaluate(() => {
    const f = document.getElementById('field').getBoundingClientRect();
    const hit = document.elementFromPoint(f.left + f.width / 2, f.top + f.height / 2);
    return { hit: hit && (hit.id || hit.tagName), reverted: window.__sg.stats.comments.reverted,
      fit: document.querySelectorAll('[data-sg-fit]').length };
  });
  return r;
}

test('comment box: put back too when a loading screen covered everything while it was fitted', async () => {
  // Instagram's splash screen (fixed, z-index 100) is up during the first passes.
  const html = fixedPage().replace(NAV, OTHER_BAR).replace('</body>',
    `<div id="splash-screen" style="position:fixed;inset:0;z-index:100;background:#fff"></div>
    <script>setTimeout(() => { document.getElementById('splash-screen').style.display = 'none'; }, 700);</script></body>`);
  const page = await open(html);
  await page.waitForFunction(() => window.__sg && window.__sg.stats.comments.gapAfter != null);
  // Hidden by a style change only (no added or removed nodes): the box is looked at again anyway.
  await page.waitForFunction(() => window.__sg.stats.comments.reverted === 1, null, { timeout: 3000 });
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('fixedRow')).bottom), (50 + SAFE) + 'px');
  assert.deepEqual(await settled(page), { hit: 'field', reverted: 1, fit: 0 });
  assert.deepEqual(page.__errors, []);
});

test('comment box: put back when a bar SimpleGram does not know comes after the box', async () => {
  const html = fixedPage().replace(NAV, `<script>setTimeout(() => document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(OTHER_BAR)}), 600);</script>`);
  const page = await open(html);
  await page.waitForFunction(() => window.__sg && window.__sg.stats.comments.gapAfter === 0);
  await page.waitForFunction(() => window.__sg.stats.comments.reverted === 1, null, { timeout: 3000 });
  assert.deepEqual(await settled(page), { hit: 'field', reverted: 1, fit: 0 });
});

test('comment box: a box at the end of a scrolling page is checked once it scrolls into view', async () => {
  // The window scrolls; the main column's margin keeps the box above a bar SimpleGram doesn't know.
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head>
<body style="margin:0"><div id="main" style="margin-bottom:${50 + SAFE}px"><div id="list">${comments(30)}</div>${row()}</div>
  ${OTHER_BAR}${AUTOSIZE}</body></html>`;
  const page = await open(html);
  await page.waitForFunction(() => window.__sg && window.__sg.stats.comments.gapAfter != null);
  await sleep(200);
  assert.equal(await page.evaluate(() => window.__sg.stats.comments.reverted), 0, 'off screen: nothing to tell yet');
  await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
  await page.waitForFunction(() => window.__sg.stats.comments.reverted === 1, null, { timeout: 3000 });
  // The margin is back, so the box scrolls clear of the bar.
  await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
  await sleep(100);
  assert.deepEqual(await settled(page), { hit: 'field', reverted: 1, fit: 0 });
});

// A fixed row inside an empty wrapper (how React nests it), lifted above the bar.
function wrappedRow() {
  return `<div id="wrap"><div id="fixedRow" style="position:fixed;left:0;right:0;bottom:${50 + SAFE}px;background:#fff;z-index:2">${row()}</div></div>`;
}

test('comment box: a fixed row in an empty wrapper elsewhere on the page is measured as the row', async () => {
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head>
<body style="margin:0"><div id="app"><main id="col" style="padding-bottom:83px">
  <div id="title" style="height:44px">Comments</div><div id="list">${comments(30)}</div></main></div>
  ${wrappedRow()}${NAV}${AUTOSIZE}</body></html>`;
  const page = await open(html);
  await fitted(page);
  const st = await page.evaluate(() => window.__sg.stats.comments);
  assert.equal(st.gapBefore, 50 + SAFE);
  assert.equal(st.gapAfter, 0);
  assert.ok(Math.abs(st.barH - 49) <= 2, 'the row, not its wrapper: ' + st.barH);
  // Reading mid-list, a tap on the box doesn't jump to the end.
  await page.evaluate(() => window.scrollTo(0, 600));
  await sleep(100);
  await page.tap('#field');
  await page.setViewportSize({ width: 412, height: 260 });
  await sleep(600);
  assert.equal(await page.evaluate(() => scrollY), 600);
  assert.equal(await page.evaluate(() => window.__sg.stats.comments.scrolled), 0);
});

test('comment box: the column keeps the room that lets its last comment clear a wrapped fixed row', async () => {
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head>
<body style="margin:0"><div id="app"><main id="col" style="padding-bottom:83px">
  <div id="title" style="height:44px">Comments</div><div id="list">${comments(30)}</div>${wrappedRow()}</main></div>
  ${NAV}${AUTOSIZE}</body></html>`;
  const page = await open(html);
  await fitted(page);
  const r = await page.evaluate(() => {
    window.scrollTo(0, document.scrollingElement.scrollHeight);
    const last = document.querySelector('#list .c:last-child').getBoundingClientRect();
    return { colFit: document.getElementById('col').dataset.sgFit || '', lastBottom: last.bottom,
      barTop: document.getElementById('bar').getBoundingClientRect().top, gap: window.__sg.stats.comments.gapAfter };
  });
  assert.doesNotMatch(r.colFit, /padding-bottom/);
  assert.equal(r.gap, 0);
  assert.ok(r.lastBottom <= r.barTop + 1, JSON.stringify(r));
});

test('comment box: a fixed layer holding both the bar and the box is not hidden', async () => {
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head>
<body style="margin:0"><div id="list">${comments(20)}</div>
  <div id="layer" style="position:fixed;bottom:0;left:0;right:0;background:#fff">${row()}
    <div id="nav" style="display:flex;height:50px"><a href="/">Home</a><a href="/explore/">Search</a><a href="/direct/inbox/">DM</a></div></div>
  ${AUTOSIZE}</body></html>`;
  const page = await open(html);
  await page.waitForFunction(() => window.__sg.stats.comments.gapAfter != null);
  await sleep(200);
  assert.notEqual(await page.evaluate(() => document.getElementById('layer').style.display), 'none');
  assert.ok((await layout(page)).reachable);
});

test('comment box: diagnostics carry sizes and counts only; the main page is left alone', async () => {
  const page = await open(inFlowPage());
  await fitted(page);
  const msgs = await page.evaluate(() => window.__sent.filter(m => m.action === 'commentsLayout'));
  assert.ok(msgs.length >= 1);
  const last = msgs[msgs.length - 1];
  assert.deepEqual(Object.keys(last).sort(), ['action', 'barH', 'boxes', 'fieldH', 'fixes', 'gapAfter', 'gapBefore', 'opened', 'reverted', 'scrolled']);
  for (const [k, v] of Object.entries(last)) {
    if (k === 'action') continue;
    if (k === 'fixes') { for (const n of Object.values(v)) assert.equal(typeof n, 'number'); continue; }
    assert.equal(typeof v, 'number', k);
  }
  assert.equal(last.gapBefore, 50);
  assert.equal(last.gapAfter, 0);

  const main = await open(inFlowPage(), { role: 'main' });
  await sleep(600);
  assert.equal(await main.evaluate(() => document.querySelectorAll('[data-sg-composer],[data-sg-fit]').length), 0);
});

test('comment box: a loading cover over the box when it is fitted does not undo the fit', async () => {
  const html = inFlowPage().replace('</body>', `<div id="cover" style="position:fixed;inset:0;z-index:9;background:rgba(0,0,0,.2)"></div>
    <script>setTimeout(() => { document.getElementById('cover').remove(); }, 700);</script></body>`);
  const page = await open(html);
  await fitted(page);
  const st = await page.evaluate(() => window.__sg.stats.comments);
  assert.equal(st.reverted, 0);
  assert.equal(st.gapAfter, 0);
  await page.waitForFunction(() => !document.getElementById('cover'));
  assert.ok((await layout(page)).reachable);
});

test('comment box: other pages the panel goes on to are left alone', async () => {
  const page = await open(inFlowPage());
  await fitted(page);
  // The panel goes on to a profile (Instagram's router changes the address).
  const other = await page.evaluate(async () => {
    history.pushState({}, '', '/someone/');
    document.getElementById('field').remove();
    const t = document.createElement('textarea');
    t.setAttribute('aria-label', 'x');
    t.style.cssText = 'height:18px';
    const box = document.createElement('div');
    box.style.cssText = 'padding:4px 0 40px';
    box.appendChild(t);
    document.body.insertBefore(box, document.body.firstChild);
    await new Promise(r => setTimeout(r, 800));
    return { composer: t.dataset.sgComposer || null, padding: box.style.paddingBottom };
  });
  assert.deepEqual(other, { composer: null, padding: '40px' });
});
