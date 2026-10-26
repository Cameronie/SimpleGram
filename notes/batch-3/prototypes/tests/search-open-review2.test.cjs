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

const sleep = ms => new Promise(r => setTimeout(r, ms));
test('R3b: popstate mode, Home has feed images, title badge changes during the load', async () => {
  for (const badge of [false, true]) {
    const page = await open({ fetchMs: 600, renderMs: 900, homeImg: true });
    await showPosts(page);
    const t0 = await tapCell(page);
    await sleep(150);
    if (badge) await page.evaluate(() => { document.title = '(1) Instagram'; });
    await waitPostShown(page);
    const f = await frames(page, t0);
    const home = f.filter(homeShowing);
    console.log('R3b', JSON.stringify({ badge, homeFrames: home.length, homeMs: home.length ? home[home.length - 1].t - home[0].t : 0 }));
    await page.context().close();
  }
});
test('R3c: router mode, Home has feed images, title badge changes during the load', async () => {
  const page = await open({ exposeRequire: true, fetchMs: 600, renderMs: 900, homeImg: true });
  await showPosts(page);
  const t0 = await tapCell(page);
  await sleep(150);
  await page.evaluate(() => { document.title = '(1) Instagram'; });
  await waitPostShown(page);
  const f = await frames(page, t0);
  const home = f.filter(homeShowing);
  console.log('R3c', JSON.stringify({ homeFrames: home.length }));
});
