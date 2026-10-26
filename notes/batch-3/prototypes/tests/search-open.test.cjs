// B14: opening a search result must never show the page underneath (Home).
// A stand-in for Instagram's CometRouter (see mockapp.js) runs in the page.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const SCRIPT = fs.readFileSync(process.env.SG_SCRIPT, 'utf8');
const MOCK = fs.readFileSync(path.join(__dirname, '..', 'mockapp.js'), 'utf8');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PAGE = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Instagram</title></head>
<body style="margin:0"><main style="min-height:80vh"></main>
<div style="position:fixed;bottom:0;left:0;right:0;height:50px;display:flex" id="nav"><div><a href="/" style="display:block;width:60px;height:50px">Home</a></div><div><a id="searchlink" href="/explore/" style="display:block;width:60px;height:50px">Search</a></div></div>
<script>${MOCK}</script></body></html>`;
let pk = 5000;
function media(code, extra) { const u = { pk: String(pk++), username: 'u' + code }; return Object.assign({ pk: String(pk++), id: pk + '_' + u.pk, code, user: u, image_versions2: { candidates: [{ url: `https://scontent.cdninstagram.com/v/t51/${code}_n.jpg`, width: 640, height: 800 }] } }, extra || {}); }
const API = {
  '/web/search/topsearch/': { users: [{ position: 0, user: { pk: '1', username: 'sanjosesharks', full_name: 'San Jose Sharks' } }], hashtags: [], places: [] },
  '/api/v1/fbsearch/web/top_serp/': { media_grid: { sections: [{ layout_type: 'media_grid', layout_content: { medias: [{ media: media('KEYW001') }, { media: media('KEYW002', { product_type: 'clips', media_type: 2 }) }] } }], has_more: false } },
};
// Every frame: is search drawn, is it the cover, what does the page show.
const REC = `(() => {
  const doc = +(sessionStorage.getItem('loads') || 0) + 1;
  window.__rec = [];
  const tick = () => {
    const h = document.getElementById('sg-search');
    const ov = !!(h && h.style.display !== 'none');
    window.__rec.push({ t: Date.now(), doc, ov, cov: !!(ov && h.shadowRoot.querySelector('.wrap.leaving')), main: (document.querySelector('main') || {}).textContent || '', path: location.pathname });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  addEventListener('pagehide', () => { try { sessionStorage.setItem('rec', JSON.stringify(JSON.parse(sessionStorage.getItem('rec') || '[]').concat(window.__rec))); } catch (e) {} });
})();`;
let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser.close(); });

async function open(cfg) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (API[u.pathname]) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(API[u.pathname]) });
    if (/\.(jpg|png)/.test(u.pathname)) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    if (route.request().resourceType() === 'document') return route.fulfill({ status: 200, contentType: 'text/html', body: PAGE });
    return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
  });
  await page.addInitScript(`window.__mockcfg=${JSON.stringify(cfg)};window.__sent=[];window.SGNative={postMessage:m=>window.__sent.push(JSON.parse(m))};`);
  await page.addInitScript(REC);
  await page.addInitScript(`window.__sgCfg=${JSON.stringify({ role: 'main', version: 'test', searchPages: 3, viewerId: '1000' })};\n${SCRIPT}`);
  await page.goto('https://www.instagram.com/');
  await page.waitForFunction(() => document.querySelector('main').textContent.startsWith('HOME'));
  await page.tap('#searchlink');
  await page.waitForFunction(() => { const h = document.getElementById('sg-search'); return h && h.style.display !== 'none'; });
  await page.keyboard.type('sharks');
  return page;
}
async function showPosts(page) {
  await page.evaluate(() => Array.from(document.getElementById('sg-search').shadowRoot.querySelectorAll('button')).find(b => b.textContent.trim() === 'Posts & Reels').click());
  await page.waitForFunction(() => document.getElementById('sg-search').shadowRoot.querySelectorAll('.cell').length === 2);
}
async function frames(page, t0) {
  const d = await page.evaluate(() => ({ prev: JSON.parse(sessionStorage.getItem('rec') || '[]'), cur: window.__rec }));
  return d.prev.concat(d.cur).filter(s => s.t >= t0).sort((a, b) => a.t - b.t);
}
const homeShowing = f => !f.ov && f.main.startsWith('HOME');
async function tapCell(page, i) {
  return page.evaluate(n => { const t = Date.now(); document.getElementById('sg-search').shadowRoot.querySelectorAll('.cell')[n].click(); return t; }, i || 0);
}
async function waitPostShown(page, re) {
  await page.waitForFunction(r => { const h = document.getElementById('sg-search'); return new RegExp(r).test(document.querySelector('main').textContent) && !(h && h.style.display !== 'none'); }, (re || /^POST/).source, { timeout: 15000 });
}
async function waitResults(page) {
  await page.waitForFunction(() => { const h = document.getElementById('sg-search'); return h && h.style.display !== 'none' && !h.shadowRoot.querySelector('.wrap.leaving') && h.shadowRoot.querySelectorAll('.cell').length === 2; }, null, { timeout: 5000 });
}

test('B14: a Posts & Reels result opens through Instagram\'s router; Home never shows; Back returns to the results', async () => {
  const page = await open({ exposeRequire: true, fetchMs: 300, renderMs: 700 });
  await showPosts(page);
  const t0 = await tapCell(page);
  await waitPostShown(page);
  const f = await frames(page, t0);
  assert.equal(f.filter(homeShowing).length, 0, 'no frame shows Home without search on top');
  assert.ok(f.some(x => x.cov), 'search stayed up as a cover while Instagram loaded the post');
  assert.equal(await page.evaluate(() => window.__mockLog.length), 0, 'no synthetic popstate needed');
  assert.equal(await page.evaluate(() => +sessionStorage.getItem('loads')), 1, 'no full reload');
  await page.goBack();
  await waitResults(page);
  assert.equal(await page.evaluate(() => location.pathname), '/');
});

test('B14: without Instagram\'s modules, the popstate path still never shows Home (slow route, no reload)', async () => {
  const page = await open({ fetchMs: 900, renderMs: 1300 });
  await showPosts(page);
  const t0 = await tapCell(page, 1);
  await waitPostShown(page, /^POST KEYW002/);
  const f = await frames(page, t0);
  assert.equal(f.filter(homeShowing).length, 0);
  assert.equal(await page.evaluate(() => +sessionStorage.getItem('loads')), 1, 'a slow client-side open is not cut short by a reload');
  assert.match(await page.evaluate(() => location.pathname), /^\/reel\/KEYW002\/$/);
  await page.goBack();
  await waitResults(page);
});

test('B14: a router that ignores foreign history states -> full load behind the cover; Back returns to the results', async () => {
  const page = await open({ ignoreForeign: true });
  await showPosts(page);
  const t0 = await tapCell(page);
  await waitPostShown(page);
  const f = await frames(page, t0);
  assert.equal(f.filter(homeShowing).length, 0);
  const lastOld = f.filter(x => x.doc === 1).pop();
  assert.ok(lastOld.ov && lastOld.cov, 'the old page was left showing the cover, not Home');
  assert.equal(await page.evaluate(() => +sessionStorage.getItem('loads')), 2);
  await page.goBack();
  await waitResults(page);
});

test('B14: Back while a result is still opening stays in search and undoes the open unseen', async () => {
  const page = await open({ exposeRequire: true, fetchMs: 1200, renderMs: 600 });
  await showPosts(page);
  const len0 = await page.evaluate(() => history.length);
  const t0 = await tapCell(page);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__sg.back()), true);
  await waitResults(page);
  await page.waitForTimeout(2600);   // Instagram finishes its navigation; SimpleGram steps back
  const f = await frames(page, t0);
  assert.equal(f.filter(x => !x.ov).length, 0, 'search never left the screen');
  assert.equal(await page.evaluate(() => location.pathname), '/');
  await waitResults(page);
  assert.ok(await page.evaluate(() => !(history.state && history.state.sgSearch)), 'no stale marker');
  assert.ok((await page.evaluate(() => history.length)) <= len0 + 1);
});

test('B14: Back pressed after the address changed but before the post is drawn returns to the results', async () => {
  const page = await open({ exposeRequire: true, fetchMs: 200, renderMs: 1500 });
  await showPosts(page);
  const t0 = await tapCell(page);
  await page.waitForFunction(() => location.pathname.startsWith('/p/'));
  assert.equal(await page.evaluate(() => window.__sg.back()), true);
  await page.waitForFunction(() => location.pathname === '/');
  await waitResults(page);
  await page.waitForTimeout(1800);
  const f = await frames(page, t0);
  assert.equal(f.filter(homeShowing).length, 0);
  await waitResults(page);
});

test('B14: an account result also keeps search up until the profile is drawn', async () => {
  const page = await open({ exposeRequire: true, fetchMs: 300, renderMs: 500 });
  await page.waitForFunction(() => document.getElementById('sg-search').shadowRoot.textContent.includes('San Jose Sharks'));
  const t0 = await page.evaluate(() => { const t = Date.now(); Array.from(document.getElementById('sg-search').shadowRoot.querySelectorAll('button')).find(b => b.textContent.includes('sanjosesharks')).click(); return t; });
  await waitPostShown(page, /^OTHER \/sanjosesharks\//);
  const f = await frames(page, t0);
  assert.equal(f.filter(homeShowing).length, 0);
});

test('B14: if Back restores the page from the back/forward cache, the results show (the open is not resumed)', async () => {
  const page = await open({ exposeRequire: true, fetchMs: 5000, renderMs: 500 });
  await showPosts(page);
  await tapCell(page);
  await page.waitForTimeout(200);
  await page.evaluate(() => { dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })); dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
  await waitResults(page);
  await page.waitForTimeout(1200);
  await waitResults(page);
  assert.equal(await page.evaluate(() => +sessionStorage.getItem('loads')), 1, 'no full load was started after the restore');
});

test('B14: if Instagram\'s router drops the push, the popstate way is used (no full load, Home never shows)', async () => {
  const page = await open({ exposeRequire: true, dropPush: true, fetchMs: 300, renderMs: 500 });
  await showPosts(page);
  const t0 = await tapCell(page);
  await waitPostShown(page);
  const f = await frames(page, t0);
  assert.equal(f.filter(homeShowing).length, 0);
  assert.equal(await page.evaluate(() => +sessionStorage.getItem('loads')), 1);
  assert.deepEqual(await page.evaluate(() => { const o = window.__sg.stats.searchOpens; return [o.router, o.popstate, o.fullLoad]; }), [1, 1, 0]);
  await page.goBack();
  await waitResults(page);
});
