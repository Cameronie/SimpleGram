// B14: opening a search result must never show the page underneath (Home).
// A stand-in for Instagram's CometRouter (comet-router-mock.js) runs in the
// page; every frame is recorded, across full loads too.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { useBrowser, open, media, user, shadowClick } = require('./helpers.cjs');

useBrowser();

const MOCK = fs.readFileSync(path.join(__dirname, 'comet-router-mock.js'), 'utf8');
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
const PAGE = cfg => `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Instagram</title>
<script>window.__mockcfg=${JSON.stringify(cfg)};${REC}</script></head>
<body style="margin:0"><main style="min-height:80vh"></main>
<div style="position:fixed;bottom:0;left:0;right:0;height:50px;display:flex" id="nav"><div><a href="/" style="display:block;width:60px;height:50px">Home</a></div><div><a id="searchlink" href="/explore/" style="display:block;width:60px;height:50px">Search</a></div></div>
<script>${MOCK}</script></body></html>`;

// Today's website: the old REST search endpoints answer 404; accounts and
// posts come from its GraphQL search requests.
const NOT_FOUND = '<!DOCTYPE html><html><head><title>Page Not Found &bull; Instagram</title></head><body>Sorry, this page isn\'t available.</body></html>';
function graphql(u, req) {
  const name = new URLSearchParams(req.postData() || '').get('fb_api_req_friendly_name');
  if (name === 'PolarisSearchBoxRefetchableQuery') {
    return { body: { data: { xdt_api__v1__fbsearch__topsearch_connection: {
      users: [{ position: 0, user: { pk: '1', username: 'sanjosesharks', full_name: 'San Jose Sharks' } }], hashtags: [], places: [] } } } };
  }
  if (name === 'PolarisKeywordSearchExplorePageRelayQuery') {
    return { body: { data: { xdt_fbsearch__top_serp_graphql: {
      edges: [{ node: { __typename: 'XDTTopSerpHeaderUnit' } },
        { node: { __typename: 'XDTTopSerpMediaGridUnit', items: [media('KEYW001', user('a', true)), media('KEYW002', user('b', true), { product_type: 'clips', media_type: 2 })] } }],
      page_info: { has_next_page: false, end_cursor: null } } }, extensions: { is_final: true } } };
  }
  return { body: { errors: [{ message: 'execution error', code: 1675004 }], data: null } };
}
const API = {
  '/web/search/topsearch/': () => ({ status: 404, body: NOT_FOUND }),
  '/api/v1/fbsearch/web/top_serp/': () => ({ status: 404, body: NOT_FOUND }),
  '/api/graphql': graphql,
  '/graphql/query': graphql,
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Opens the mock Instagram with the router options in `cfg`, opens search and types "sharks". */
async function start(cfg) {
  const page = await open('https://www.instagram.com' + (cfg.start || '/'), PAGE(cfg), { api: API });
  // Every page of the mock site is the same document; the mock draws the route.
  await page.route('**/*', async route => {
    const req = route.request();
    if (req.resourceType() !== 'document') return route.fallback();
    const p = new URL(req.url()).pathname;
    if (cfg.docDelay && p !== (cfg.start || '/')) await sleep(cfg.docDelay);
    try { await route.fulfill({ status: 200, contentType: 'text/html', body: PAGE(cfg) }); } catch (e) { /* the navigation was called off */ }
  });
  await page.waitForFunction(() => document.querySelector('main').textContent.length > 0);
  await page.tap('#searchlink');
  await page.waitForFunction(() => { const h = document.getElementById('sg-search'); return h && h.style.display !== 'none'; });
  await page.keyboard.type('sharks');
  return page;
}
async function showPosts(page) {
  await shadowClick(page, 'Posts & Reels');
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
const searchUp = page => page.evaluate(() => { const h = document.getElementById('sg-search'); return !!(h && h.style.display !== 'none'); });
const loads = page => page.evaluate(() => +sessionStorage.getItem('loads'));
const opens = page => page.evaluate(() => window.__sg.stats.searchOpens);

test('B14: a Posts & Reels result opens through Instagram\'s router; Home never shows; Back returns to the results', async () => {
  const page = await start({ exposeRequire: true, fetchMs: 300, renderMs: 700 });
  await showPosts(page);
  const t0 = await tapCell(page);
  await waitPostShown(page);
  const f = await frames(page, t0);
  assert.equal(f.filter(homeShowing).length, 0, 'no frame shows Home without search on top');
  assert.ok(f.some(x => x.cov), 'search stayed up as a cover while Instagram loaded the post');
  assert.equal(await page.evaluate(() => window.__mockLog.length), 0, 'no synthetic popstate needed');
  assert.equal(await page.evaluate(() => window.__goCalls), 1);
  assert.equal(await loads(page), 1, 'no full reload');
  const o = await opens(page);
  assert.equal(o.router, 1);
  assert.equal(o.lastVia, 'router');
  assert.ok(o.lastMs >= 1000, 'timed to the drawn post: ' + o.lastMs);
  await page.goBack();
  await waitResults(page);
  assert.equal(await page.evaluate(() => location.pathname), '/');
});

test('B14: without Instagram\'s modules, the popstate way still never shows Home (slow route, no reload)', async () => {
  const page = await start({ fetchMs: 900, renderMs: 1300 });
  await showPosts(page);
  const t0 = await tapCell(page, 1);
  await waitPostShown(page, /^POST KEYW002/);
  const f = await frames(page, t0);
  assert.equal(f.filter(homeShowing).length, 0);
  assert.equal(await loads(page), 1, 'a slow client-side open is not cut short by a reload');
  assert.match(await page.evaluate(() => location.pathname), /^\/reel\/KEYW002\/$/);
  await page.goBack();
  await waitResults(page);
});

test('B14: a router that ignores foreign history states -> full load behind the cover; Back returns to the results; the count survives', async () => {
  const page = await start({ ignoreForeign: true });
  await showPosts(page);
  const t0 = await tapCell(page);
  await waitPostShown(page);
  const f = await frames(page, t0);
  assert.equal(f.filter(homeShowing).length, 0);
  const lastOld = f.filter(x => x.doc === 1).pop();
  assert.ok(lastOld.ov && lastOld.cov, 'the old page was left showing the cover, not Home');
  assert.equal(await loads(page), 2);
  // Counted in the page that started the load, read back by the new page.
  await page.waitForFunction(() => window.__sg.stats.searchOpens.lastMs > 0);
  const o = await opens(page);
  assert.equal(o.fullLoad, 1);
  assert.equal(o.popstate, 1);
  assert.equal(o.lastVia, 'fullLoad');
  await page.goBack();
  await waitResults(page);
});

test('B14: Back while a result is still opening stays in search and undoes the open unseen', async () => {
  const page = await start({ exposeRequire: true, fetchMs: 1200, renderMs: 600 });
  await showPosts(page);
  const len0 = await page.evaluate(() => history.length);
  const t0 = await tapCell(page);
  await sleep(300);
  assert.equal(await page.evaluate(() => window.__sg.back()), true);
  await waitResults(page);
  await sleep(2600);   // Instagram finishes its navigation; SimpleGram steps back
  const f = await frames(page, t0);
  assert.equal(f.filter(x => !x.ov).length, 0, 'search never left the screen');
  assert.equal(await page.evaluate(() => location.pathname), '/');
  await waitResults(page);
  assert.ok(await page.evaluate(() => !(history.state && history.state.sgSearch)), 'no stale marker');
  assert.ok((await page.evaluate(() => history.length)) <= len0 + 1);
  assert.equal((await opens(page)).cancelled, 1);
});

test('B14: Back pressed after the address changed but before the post is drawn returns to the results', async () => {
  const page = await start({ exposeRequire: true, fetchMs: 200, renderMs: 1500 });
  await showPosts(page);
  const t0 = await tapCell(page);
  await page.waitForFunction(() => location.pathname.startsWith('/p/'));
  assert.equal(await page.evaluate(() => window.__sg.back()), true);
  await page.waitForFunction(() => location.pathname === '/');
  await waitResults(page);
  await sleep(1800);
  const f = await frames(page, t0);
  assert.equal(f.filter(homeShowing).length, 0);
  await waitResults(page);
});

test('B14: an account result also keeps search up until the profile is drawn', async () => {
  const page = await start({ exposeRequire: true, fetchMs: 300, renderMs: 500 });
  await page.waitForFunction(() => document.getElementById('sg-search').shadowRoot.textContent.includes('San Jose Sharks'));
  const t0 = await page.evaluate(() => Date.now());
  await shadowClick(page, 'sanjosesharks');
  await waitPostShown(page, /^OTHER \/sanjosesharks\//);
  const f = await frames(page, t0);
  assert.equal(f.filter(homeShowing).length, 0);
  assert.ok(f.some(x => x.cov));
});

test('B14: if Back restores the page from the back/forward cache, the results show (the open is not resumed)', async () => {
  const page = await start({ exposeRequire: true, fetchMs: 5000, renderMs: 500 });
  await showPosts(page);
  await tapCell(page);
  await sleep(200);
  await page.evaluate(() => { dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })); dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
  await waitResults(page);
  await sleep(1200);
  await waitResults(page);
  assert.equal(await loads(page), 1, 'no full load was started after the restore');
  assert.ok(await page.evaluate(() => !(history.state && history.state.sgSearch)), 'no stale marker');
});

test('B14: if Instagram\'s router drops the push, the popstate way is used (no full load, Home never shows)', async () => {
  const page = await start({ exposeRequire: true, dropPush: true, fetchMs: 300, renderMs: 500 });
  await showPosts(page);
  const t0 = await tapCell(page);
  await waitPostShown(page);
  const f = await frames(page, t0);
  assert.equal(f.filter(homeShowing).length, 0);
  assert.equal(await loads(page), 1);
  const o = await opens(page);
  assert.deepEqual([o.router, o.popstate, o.fullLoad], [1, 1, 0]);
  await page.goBack();
  await waitResults(page);
});

/* ---------------- Review cases ---------------- */

test('B14 R1: Back is never swallowed: a second Back closes search while Instagram is still slow', async () => {
  // a) The address moves quickly, the post takes 12 s to draw.
  let page = await start({ exposeRequire: true, fetchMs: 300, renderMs: 12000 });
  await showPosts(page);
  await tapCell(page);
  await sleep(120);
  assert.equal(await page.evaluate(() => window.__sg.back()), true);
  await waitResults(page);
  await sleep(1500);
  assert.equal(await page.evaluate(() => window.__sg.back()), true);
  assert.equal(await searchUp(page), false, 'the second Back closes search');
  assert.equal(await page.evaluate(() => location.pathname), '/');
  await page.context().close();
  // b) Instagram is still fetching the route (the address never moved).
  page = await start({ exposeRequire: true, fetchMs: 12000, renderMs: 500 });
  await showPosts(page);
  await tapCell(page);
  await sleep(120);
  assert.equal(await page.evaluate(() => window.__sg.back()), true);
  await waitResults(page);
  await sleep(1500);
  assert.equal(await page.evaluate(() => window.__sg.back()), true);
  assert.equal(await searchUp(page), false, 'the second Back closes search');
  await page.context().close();
});

test('B14 R2: with Instagram\'s history module but no readable router state, exactly one navigation', async () => {
  const page = await start({ exposeRequire: true, noStatus: true, fetchMs: 400, renderMs: 500 });
  await showPosts(page);
  const t0 = await tapCell(page);
  await waitPostShown(page);
  const f = await frames(page, t0);
  assert.equal(await page.evaluate(() => window.__goCalls), 1, 'one router navigation, not a push plus a popstate');
  assert.equal(await page.evaluate(() => window.__mockLog.filter(x => !x.trusted).length), 1);
  assert.equal(await loads(page), 1);
  assert.equal(f.filter(homeShowing).length, 0);
});

test('B14 R3b: an unread badge in the title is not mistaken for the new page (Home with feed pictures)', async () => {
  for (const badge of [false, true]) {
    const page = await start({ fetchMs: 600, renderMs: 900, homeImg: true });
    await showPosts(page);
    const t0 = await tapCell(page);
    await sleep(150);
    if (badge) await page.evaluate(() => { document.title = '(1) Instagram'; });
    await waitPostShown(page);
    const f = await frames(page, t0);
    assert.equal(f.filter(homeShowing).length, 0, 'badge ' + badge);
    await page.context().close();
  }
});

test('B14 R6: a Home video under the cover is not unmuted or started; the opened Reel\'s own video is', async () => {
  for (const cfg of [{ fetchMs: 300, renderMs: 1500, reelVideo: true }, { exposeRequire: true, fetchMs: 300, renderMs: 1500, reelVideo: true }]) {
    const page = await start(cfg);
    await page.evaluate(() => {
      const v = document.createElement('video'); v.id = 'hv'; v.muted = true; v.setAttribute('playsinline', ''); v.style.cssText = 'width:400px;height:700px;display:block';
      document.querySelector('main').appendChild(v);
    });
    await showPosts(page);
    await tapCell(page, 1);
    await sleep(600);   // address already /reel/, Instagram still drawing, Home's DOM still there
    const r = await page.evaluate(() => {
      const v = document.getElementById('hv');
      v.dispatchEvent(new Event('play'));
      v.dispatchEvent(new Event('loadedmetadata'));
      return { path: location.pathname, connected: v.isConnected };
    });
    assert.match(r.path, /^\/reel\//);
    assert.ok(r.connected);
    await sleep(500);
    assert.equal(await page.evaluate(() => document.getElementById('hv').muted), true, 'Home video stays muted ' + JSON.stringify(cfg));
    assert.equal(await page.evaluate(() => window.__sg.stats.autoplayed), 0, 'Home video not started');
    await waitPostShown(page, /^POST KEYW002/);
    await page.waitForFunction(() => window.__sg.stats.autoplayed === 1);   // the Reel's own video
    await page.evaluate(() => document.getElementById('rv').dispatchEvent(new Event('play')));
    await page.waitForFunction(() => document.getElementById('rv').muted === false);
    await page.context().close();
  }
});

test('B14 R7: opening the account that is already the page underneath shows it at once, without a reload', async () => {
  for (const cfg of [{ start: '/sanjosesharks/', exposeRequire: true }, { start: '/sanjosesharks/' }]) {
    const page = await start(cfg);
    await page.waitForFunction(() => document.getElementById('sg-search').shadowRoot.textContent.includes('San Jose Sharks'));
    const goneAtOnce = await page.evaluate(() => {
      const h = document.getElementById('sg-search');
      Array.from(h.shadowRoot.querySelectorAll('button')).find(b => b.textContent.includes('sanjosesharks')).click();
      return h.style.display === 'none';
    });
    assert.ok(goneAtOnce, 'search removed at once ' + JSON.stringify(cfg));
    await sleep(2500);
    assert.equal(await loads(page), 1, 'no full load ' + JSON.stringify(cfg));
    assert.equal(await page.evaluate(() => location.pathname), '/sanjosesharks/');
    assert.equal((await opens(page)).samePage, 1);
    await page.context().close();
  }
});

test('B14 R7b: after a same-page account result, Back returns to the results', async () => {
  const page = await start({ start: '/sanjosesharks/', exposeRequire: true });
  await page.waitForFunction(() => document.getElementById('sg-search').shadowRoot.textContent.includes('San Jose Sharks'));
  await shadowClick(page, 'sanjosesharks');
  await sleep(600);
  await page.goBack();
  await page.waitForFunction(() => { const h = document.getElementById('sg-search'); return h && h.style.display !== 'none' && h.shadowRoot.textContent.includes('San Jose Sharks'); }, null, { timeout: 5000 });
  assert.equal(await page.evaluate(() => location.pathname), '/sanjosesharks/');
  assert.equal(await loads(page), 1);
});

/* ---------------- More ways out during the cover ---------------- */

test('B14: Instagram\'s Search tab tapped while a result opens stays in search', async () => {
  const page = await start({ exposeRequire: true, fetchMs: 1500, renderMs: 500 });
  await showPosts(page);
  const t0 = await tapCell(page);
  await sleep(300);
  await page.tap('#searchlink');
  await waitResults(page);
  await sleep(2500);
  const f = await frames(page, t0);
  assert.equal(f.filter(x => !x.ov).length, 0, 'search never left the screen');
  assert.equal(await page.evaluate(() => location.pathname), '/');
  await waitResults(page);
});

test('B14: Instagram\'s Home tab during the cover calls the open off and closes search', async () => {
  const page = await start({ exposeRequire: true, fetchMs: 300, renderMs: 3000 });
  await showPosts(page);
  await tapCell(page);
  await page.waitForFunction(() => location.pathname.startsWith('/p/'));
  // Instagram's Home tab is a router navigation to '/'.
  await page.evaluate(() => window.require('ifRequired')('browserHistory_DO_NOT_USE', m => m.browserHistory.push('/')));
  await page.waitForFunction(() => location.pathname === '/');
  await page.waitForFunction(() => { const h = document.getElementById('sg-search'); return !(h && h.style.display !== 'none'); });
  await sleep(3500);
  assert.equal(await searchUp(page), false);
  assert.equal(await loads(page), 1);
});

test('B14: Instagram\'s Home tab tapped before the address changes closes search; the result is not loaded later', async () => {
  const page = await start({ exposeRequire: true, linkNav: true, fetchMs: 1500, renderMs: 500 });
  await showPosts(page);
  await tapCell(page);
  await sleep(300);
  await page.tap('#nav a[href="/"]');
  await page.waitForFunction(() => { const h = document.getElementById('sg-search'); return !(h && h.style.display !== 'none'); });
  await sleep(9000);   // past every full-load rule
  assert.equal(await searchUp(page), false);
  assert.equal(await page.evaluate(() => location.pathname), '/');
  assert.equal(await loads(page), 1, 'no full load of the result');
  assert.ok((await page.evaluate(() => document.querySelector('main').textContent)).startsWith('HOME'));
  assert.equal((await opens(page)).cancelled, 1);
});

// Playwright can't evaluate while a page load is pending, so the page presses Back
// itself: as soon as SimpleGram has started its own full load, or after `ms` at the latest.
const backAt = (page, ms) => page.evaluate(t => {
  const t0 = Date.now();
  const tick = () => {
    const n = window.__sg.stats.searchOpens.fullLoad;
    if (n >= 1 || Date.now() - t0 >= t) { window.__fullLoads = n; window.__back = window.__sg.back(); return; }
    setTimeout(tick, 50);
  };
  setTimeout(tick, 50);
}, ms);

test('B14: Back while SimpleGram\'s own full load is on its way calls it off and shows the results', async () => {
  // Nothing picks the open up (address already changed), so the page is loaded normally; that load is slow.
  const page = await start({ exposeRequire: true, dropPush: true, ignoreForeign: true, docDelay: 5000 });
  await showPosts(page);
  await backAt(page, 1300);   // after the 800 ms rule started the load
  await tapCell(page);
  await sleep(2000);
  assert.deepEqual(await page.evaluate(() => [window.__fullLoads, window.__back]), [1, true]);
  await page.waitForFunction(() => location.pathname === '/');
  await waitResults(page);
  await sleep(5000);
  await waitResults(page);
  assert.equal(await page.evaluate(() => location.pathname), '/');
  assert.equal(await loads(page), 1, 'the load was called off');
});

test('B14: Instagram\'s Home tab while SimpleGram\'s own full load is on its way calls the load off', async () => {
  const page = await start({ exposeRequire: true, dropPush: true, ignoreForeign: true, linkNav: true, docDelay: 5000 });
  await showPosts(page);
  await tapCell(page);
  await sleep(1300);   // the full load has started (800 ms rule) and is waiting for the server
  await page.touchscreen.tap(30, 915 - 25);   // the Home tab, as raw input (the page is mid-load)
  await page.waitForFunction(() => location.pathname === '/' && document.querySelector('main').textContent.startsWith('HOME'));
  await sleep(5000);
  assert.equal(await searchUp(page), false);
  assert.equal(await page.evaluate(() => location.pathname), '/');
  assert.equal(await loads(page), 1, 'the load was called off');
});

test('B14: Back while a full load after a stuck router is on its way also returns to the results', async () => {
  // Instagram stays busy without moving the address; after 10 s the page is loaded normally (slowly).
  const page = await start({ exposeRequire: true, fetchMs: 30000, docDelay: 4000 });
  await showPosts(page);
  await backAt(page, 10600);
  await tapCell(page);
  await sleep(11000);
  assert.deepEqual(await page.evaluate(() => [window.__fullLoads, window.__back, location.pathname]), [1, true, '/']);
  await waitResults(page);
  await sleep(4000);
  await waitResults(page);
  assert.equal(await loads(page), 1, 'the load was called off');
});

/* ---------------- 1.2 review fixes ---------------- */

test('B14: after a result opens through a full page load, Back shows the results and the app knows search is open', async () => {
  // Instagram turns the router push into a full page load (e.g. after a deploy).
  const page = await start({ exposeRequire: true, forceReload: true, docDelay: 600 });
  await showPosts(page);
  await tapCell(page);
  await page.waitForFunction(() => +sessionStorage.getItem('loads') === 2, null, { timeout: 20000 });
  await waitPostShown(page);
  await page.goBack();
  // A new document: search comes back from its saved state.
  await page.waitForFunction(() => { const h = document.getElementById('sg-search'); return h && h.style.display !== 'none' && h.shadowRoot.querySelectorAll('.cell').length === 2; }, null, { timeout: 15000 });
  // 'ready' resets the app's searchOpen, so search must be announced after it.
  const order = await page.evaluate(() => window.__sent.filter(m => m.action === 'ready' || m.action === 'search')
    .map(m => m.action === 'search' ? 'search:' + m.open : 'ready'));
  assert.equal(order[order.length - 1], 'search:true', order.join(','));
  assert.ok(order.includes('ready'));
});

test('B14: an open called off with two Backs does not complete by itself when Instagram answers late', async () => {
  const page = await start({ exposeRequire: true, fetchMs: 3000, renderMs: 300 });
  await showPosts(page);
  await tapCell(page);
  await sleep(150);
  assert.equal(await page.evaluate(() => window.__sg.back()), true);
  await waitResults(page);
  assert.equal(await page.evaluate(() => window.__sg.back()), true);
  assert.equal(await searchUp(page), false, 'the second Back closes search');
  await sleep(4500);   // Instagram's route answer arrives and it pushes the post
  assert.equal(await page.evaluate(() => location.pathname), '/');
  await page.waitForFunction(() => document.querySelector('main').textContent.startsWith('HOME'));
});

test('B14: after Back during the spinner, tapping another result opens it', async () => {
  const page = await start({ exposeRequire: true, fetchMs: 2500, renderMs: 500 });
  await showPosts(page);
  const t0 = await tapCell(page, 0);
  await sleep(200);
  assert.equal(await page.evaluate(() => window.__sg.back()), true);
  await waitResults(page);
  await tapCell(page, 1);
  await sleep(300);
  assert.equal(await page.evaluate(() => !!document.getElementById('sg-search').shadowRoot.querySelector('.wrap.leaving')), true, 'the cover is up');
  await waitPostShown(page, /KEYW002/);
  assert.equal((await frames(page, t0)).filter(homeShowing).length, 0, 'Home never shows on its own');
  await page.goBack();
  await waitResults(page);
});

test('B14: from a profile\'s Reels tab, tapping that account opens at once (no spinner, no reload)', async () => {
  const page = await start({ start: '/sanjosesharks/reels/', exposeRequire: true, sameHeader: true, fetchMs: 300, renderMs: 400 });
  await page.waitForFunction(() => document.getElementById('sg-search').shadowRoot.textContent.includes('San Jose Sharks'));
  const t0 = Date.now();
  await shadowClick(page, 'sanjosesharks');
  await page.waitForFunction(() => { const h = document.getElementById('sg-search'); return !(h && h.style.display !== 'none'); }, null, { timeout: 5000 });
  assert.ok(Date.now() - t0 < 2000, 'no 8 s spinner');
  assert.equal(await loads(page), 1, 'no full reload');
  assert.equal((await opens(page)).samePage, 1);
});

test('B14: a query edited just before the tap gets its results when search comes back after a full load', async () => {
  const page = await start({ exposeRequire: true, forceReload: true, docDelay: 600 });
  await showPosts(page);
  // One more letter, then a cell tap inside the 400 ms debounce.
  await page.evaluate(() => { const r = document.getElementById('sg-search').shadowRoot; const i = r.querySelector('input'); i.focus(); i.value = 'sharksx'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await tapCell(page);
  await page.waitForFunction(() => +sessionStorage.getItem('loads') === 2, null, { timeout: 20000 });
  await waitPostShown(page);
  await page.goBack();
  await page.waitForFunction(() => { const h = document.getElementById('sg-search'); return h && h.style.display !== 'none' && h.shadowRoot.querySelectorAll('.cell').length === 2; }, null, { timeout: 15000 });
  const st = await page.evaluate(() => ({ q: window.__sg.search.query, postsQ: window.__sg.search.posts.q, spin: document.getElementById('sg-search').shadowRoot.querySelectorAll('.spin').length }));
  assert.deepEqual(st, { q: 'sharksx', postsQ: 'sharksx', spin: 0 });
});

/* ---------------- Batch 4: the Home tab with search (B16, R5's "Home elsewhere") ---------------- */

const goCalls = page => page.evaluate(() => window.__goCalls || 0);
const openFeeds = page => page.evaluate(() => window.__sent.filter(m => m.action === 'openFeed').map(m => m.variant));

test('Home tab on Home with SimpleGram\'s search open is Instagram\'s (search\'s own handling), never swallowed', async () => {
  const page = await start({ exposeRequire: true, linkNav: true, fetchMs: 100, renderMs: 100 });
  await page.evaluate(() => window.scrollTo(0, 50));
  const before = await goCalls(page);
  await page.tap('#nav a[href="/"]');
  await sleep(300);
  assert.equal(await goCalls(page), before + 1, 'Instagram\'s router got the tap');
  assert.deepEqual(await openFeeds(page), []);
  assert.equal(await page.evaluate(() => window.__sg.stats.feed.homeTapTop || 0), 0);
});

test('Home tab on Following with SimpleGram\'s search open closes search and loads Home afresh', async () => {
  const page = await start({ start: '/?variant=following', exposeRequire: true, linkNav: true, fetchMs: 100, renderMs: 100 });
  const before = await goCalls(page);
  await page.tap('#nav a[href="/"]');
  await sleep(300);
  assert.equal(await goCalls(page), before, 'no in-page switch');
  assert.equal(await searchUp(page), false);
  assert.deepEqual(await openFeeds(page), ['home']);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('sg_search_state')), null, 'search is not brought back later');
});

test('Home tab on Following while a result is opening calls the open off and loads Home afresh', async () => {
  const page = await start({ start: '/?variant=following', exposeRequire: true, linkNav: true, fetchMs: 1500, renderMs: 500 });
  await showPosts(page);
  await tapCell(page);
  await sleep(300);
  await page.tap('#nav a[href="/"]');
  await sleep(300);
  assert.deepEqual(await openFeeds(page), ['home']);
  assert.equal(await searchUp(page), false);
  assert.equal((await opens(page)).cancelled, 1);
  await sleep(9000);   // past every full-load rule: the result is never loaded
  // This bridge only records openFeed, so the router's late push of the
  // result is replaced by Home itself (one load of '/'; a step back would
  // also call off the app's load of Home).
  assert.equal(await loads(page), 2);
  assert.equal(await page.evaluate(() => location.pathname + location.search), '/');
  assert.equal((await opens(page)).cancelled, 1);
});
