// Batch 4: the Home tab (B16), switching feeds inside the page and the
// one-time recovery of a blank feed (B18), and their shape-only diagnostics.
//
// Every request is answered locally (nothing reaches Instagram). The Home
// page below follows Relay's connection handler (a load without a cursor
// replaces the list, a load after the end cursor appends) and Instagram's
// mobile Home tab (usePolarisOnHomeClick: 30 s rule, scroll to the top, two
// head loads); it is a model, not Instagram's code.
//
// Run: NODE_PATH=/opt/node-tools/node_modules node --test tests/*.test.cjs
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useBrowser, open, sent, user, media, edge } = require('./helpers.cjs');

useBrowser();

const friend = c => edge({ media: media(c, user('f' + c, true), { inventory_source: 'media_or_ad', product_type: 'clips' }) });
const recs = c => edge({ explore_story: { media: media(c, user('r' + c, false), { inventory_source: 'mixed_unconnected' }) } });
const adUnit = c => edge({ ad: { ad_id: '1' }, media: media(c, user('brand'), { ad_id: '1' }) });
const marker = () => edge({ end_of_feed_demarcator: { id: 'eof', title: "You're all caught up", subtitle: "You've seen all new posts from the past 3 days.",
  group_set: { __typename: 'XDTGroupSet', id: 'gs', groups: [{ id: 'feed_recs', pagination_source: 'feed_recs', feed_items: [] }] } } });
function page(edges, cursor, ps = null, more = true) {
  return { data: { xdt_api__v1__feed__timeline__connection: { edges, pagination_source: ps, page_info: { has_next_page: more, end_cursor: cursor, has_previous_page: false, start_cursor: null } } }, extensions: { is_final: true } };
}
const PAGES = {
  head0: page([friend('TOP0001'), adUnit('AD1'), friend('TOP0002'), friend('TOP0003')], 'c1'),
  c1: page([recs('X1'), recs('X2'), adUnit('AD2'), friend('MID0001'), friend('MID0002'), friend('MID0003'), friend('MID0004'), adUnit('AD3')], 'c2'),
  c2: page([recs('X3'), recs('X4'), adUnit('AD4'), marker()], 'c12', 'feed_recs'),
  // Older posts from friends (seen on earlier days), if Instagram pages past the end.
  c12: page([friend('OLD0001'), adUnit('AD5'), friend('OLD0002'), friend('OLD0003')], 'c13'),
  // Head loads.
  headA: page([friend('TOP0001'), adUnit('AD5'), friend('TOP0002'), friend('TOP0003')], 'h13'),
  headB: page([friend('NEWPOST'), adUnit('AD6'), marker()], 'h14', 'feed_recs'),
};

const MOCK = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;background:#000;color:#fff">
<header style="position:sticky;top:0;height:44px;background:#111;z-index:2"><a id="back" href="/" style="display:inline-block;width:100px;height:44px">&lt; Feed</a><a id="menuFollowing" href="/?variant=following" style="display:inline-block;width:120px;height:44px">Following</a></header>
<div style="height:120px">stories tray</div><main id="feed"></main>
<nav style="position:fixed;bottom:0;left:0;right:0;height:50px;background:#111;display:flex">
  <div><a id="home" href="/" style="display:block;width:80px;height:50px">Home</a></div><div><a href="/direct/inbox/">DM</a></div></nav>
<script>
const C = window.__c = { edges: [], pageInfo: {}, loading: false, requests: [], nav: [], clicks: 0, lastHeadLoad: Date.now() - 60000 };
function render() {
  document.getElementById('feed').innerHTML = C.edges.filter(e => e.node.media && !e.node.ad).map(e =>
    '<article style="height:650px"><a href="/p/' + e.node.media.code + '/"><time>1d</time></a></article>').join('');
}
function apply(conn, after) {
  if (after != null) {
    C.edges = C.edges.concat(conn.edges);
    C.pageInfo.has_next_page = !!conn.page_info.has_next_page;
    if (typeof conn.page_info.end_cursor === 'string') C.pageInfo.end_cursor = conn.page_info.end_cursor;
  } else {
    C.edges = conn.edges.slice();
    C.pageInfo = Object.assign({}, conn.page_info);
  }
  render();
}
async function request(kind, after) {
  C.requests.push(kind + (after ? ':' + after : ''));
  const r = await fetch('/api/graphql?kind=' + kind + '&after=' + (after || ''), { method: 'POST' });
  apply(JSON.parse(await r.text()).data.xdt_api__v1__feed__timeline__connection, after);
}
async function loadNext(force) {
  if (C.loading || (!C.pageInfo.has_next_page && !force)) return;
  C.loading = true;
  try { await request('next', C.pageInfo.end_cursor); } finally { C.loading = false; }
}
window.__loadNextIgnoringHasNext = () => loadNext(true);
window.__head = k => request(k, null);
addEventListener('scroll', () => {
  const se = document.scrollingElement;
  if (se.scrollHeight - (se.scrollTop + innerHeight) < innerHeight) loadNext();
}, { passive: true });
// Instagram's Home tab (usePolarisOnHomeClick on mobile).
for (const id of ['home', 'back']) document.getElementById(id).addEventListener('click', e => {
  e.preventDefault();
  C.clicks++;
  if (Date.now() - C.lastHeadLoad > 30000) {
    window.scrollTo(0, 0); C.lastHeadLoad = Date.now(); request('headA', null);
    window.scrollTo(0, 0); request('headB', null);
  }
  window.scrollTo(0, 0);
});
// A React-handled variants link: the app navigates in its handler.
document.getElementById('menuFollowing').addEventListener('click', e => { e.preventDefault(); C.nav.push('/?variant=following'); });
request('head0', null);
</script></body></html>`;

async function openHome(url, opts) {
  const pg = await open(url || 'https://www.instagram.com/', MOCK, Object.assign({ api: { '/api/graphql': u => {
    const kind = u.searchParams.get('kind'), after = u.searchParams.get('after');
    return { body: PAGES[kind === 'next' ? after : kind] || page([], 'none', null, false) };
  } } }, opts || {}));
  await pg.waitForFunction(() => document.querySelectorAll('article').length > 0);
  return pg;
}
const state = pg => pg.evaluate(() => ({
  codes: Array.from(document.querySelectorAll('article a')).map(a => a.getAttribute('href').split('/')[2]),
  y: Math.round(document.scrollingElement.scrollTop),
  requests: window.__c.requests.slice(), nav: window.__c.nav.slice(), clicks: window.__c.clicks,
  fs: window.__sg.feedState(), feed: window.__sg.stats.feed, navStats: window.__sg.stats.nav,
}));
const lastEnd = async pg => { const m = await sent(pg, 'feedEnd'); return m.length ? m[m.length - 1] : null; };
async function scrollToEnd(pg) {
  for (let i = 0; i < 12; i++) {
    await pg.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
    await pg.waitForTimeout(250);
  }
  await pg.waitForFunction(() => window.__sg.feedState().ended === true, null, { timeout: 4000 });
  await pg.waitForTimeout(400);
}

/* ---------------- 1. Home tab on Home (B16) ---------------- */

test('Home tab: scrolled down, the tap goes to the top and keeps the list; no request; the card comes back at the bottom', async () => {
  const pg = await openHome();
  await scrollToEnd(pg);
  assert.equal((await lastEnd(pg)).on, true);
  const before = await state(pg);
  await pg.tap('#home');
  await pg.waitForTimeout(700);
  const s = await state(pg);
  assert.deepEqual(s.codes, before.codes, 'the list stays');
  assert.deepEqual(s.requests, before.requests, 'no request');
  assert.equal(s.clicks, 0, 'Instagram never saw the tap');
  assert.equal(s.y, 0);
  assert.equal(s.fs.ended, true);
  assert.equal(s.feed.homeTapTop, 1);
  assert.equal((await lastEnd(pg)).on, false, 'the card hides at the top');
  await pg.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
  await pg.waitForFunction(() => { const m = window.__sent.filter(x => x.action === 'feedEnd'); return m[m.length - 1].on; });
  const ev = await pg.evaluate(() => window.__sg.stats.homeEvents.filter(e => e.e === 'tap'));
  assert.deepEqual(ev.map(e => [e.a, e.y]), [['top', 'end']]);
});

test('Home tab: at the top, the tap is Instagram\'s (its own refresh: two head loads)', async () => {
  const pg = await openHome();
  await scrollToEnd(pg);
  await pg.tap('#home');                       // to the top
  await pg.waitForTimeout(300);
  await pg.tap('#home');                       // at the top: Instagram reloads
  await pg.waitForFunction(() => document.querySelectorAll('article').length === 1);
  const s = await state(pg);
  assert.deepEqual(s.requests.slice(-2), ['headA', 'headB']);
  assert.equal(s.feed.homeTapRefresh, 1);
  assert.equal(s.feed.refreshes, 1);
  assert.deepEqual(s.codes, ['NEWPOST']);
  // The Home pages ring tells the reload: the list shrank (sh1 < sh0).
  await pg.waitForTimeout(1700);
  const ring = await pg.evaluate(() => window.__sg.stats.homeRing);
  const last = ring[ring.length - 1];
  assert.ok(last.sh1 < last.sh0, JSON.stringify(last));
  assert.equal(last.mk, true);
  assert.equal(last.ps, 'feed_recs');
});

test('Home tab: at the top with nothing new (second head load [ad, marker]), Home keeps Instagram\'s line, never an empty list', async () => {
  const saved = PAGES.headB;
  PAGES.headB = page([adUnit('AD7'), marker()], 'h14', 'feed_recs');
  try {
    const pg = await openHome();
    await scrollToEnd(pg);
    await pg.tap('#home');                       // to the top
    await pg.waitForTimeout(300);
    await pg.tap('#home');                       // Instagram reloads: headA, then headB lands last
    await pg.waitForFunction(() => window.__c.requests.slice(-1)[0] === 'headB' && document.querySelectorAll('article').length === 0);
    await pg.waitForTimeout(300);
    const c = await pg.evaluate(() => ({ edges: window.__c.edges.map(e => Object.keys(e.node).find(k => k !== '__typename')), more: window.__c.pageInfo.has_next_page,
      groups: window.__c.edges[0] && window.__c.edges[0].node.end_of_feed_demarcator.group_set.groups }));
    assert.deepEqual(c, { edges: ['end_of_feed_demarcator'], more: false, groups: [] });
    const s = await state(pg);
    assert.equal(s.fs.ended, true);
    assert.equal(s.feed.refreshes, 1);
  } finally {
    PAGES.headB = saved;
  }
});

test('Home tab: a tap within 8 px of the top is passed to Instagram', async () => {
  const pg = await openHome();
  await pg.evaluate(() => window.scrollTo(0, 6));
  await pg.tap('#home');
  await pg.waitForTimeout(300);
  const s = await state(pg);
  assert.equal(s.clicks, 1);
  assert.equal(s.feed.homeTapTop || 0, 0);
  assert.equal(s.feed.homeTapRefresh, 1);
});

test('Home tab: a "/?variant=following" link while Home is scrolled down is never swallowed', async () => {
  const pg = await openHome();
  await scrollToEnd(pg);
  const y0 = (await state(pg)).y;
  await pg.tap('#menuFollowing');
  await pg.waitForTimeout(300);
  const s = await state(pg);
  assert.deepEqual(s.nav, ['/?variant=following']);
  assert.equal(s.y, y0);
  assert.equal(s.feed.homeTapTop || 0, 0);
});

test('Home tab: next pages grow the list in the Home pages ring (sh1 > sh0), with no tap', async () => {
  const pg = await openHome();
  await pg.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
  await pg.waitForFunction(() => window.__c.requests.length >= 2);
  await pg.waitForTimeout(1700);
  const ring = await pg.evaluate(() => window.__sg.stats.homeRing);
  assert.ok(ring.length >= 2);
  assert.ok(ring[1].sh1 > ring[1].sh0, JSON.stringify(ring[1]));
  assert.ok(ring[1].dt >= 0);
  assert.equal(await pg.evaluate(() => (window.__sg.stats.homeEvents || []).filter(e => e.e === 'tap').length), 0);
});

/* ---------------- 2. Home tab on another feed (fresh Home) ---------------- */

test('Home tab and the header\'s back link on ?variant=following load Home afresh (through the app), never in the page', async () => {
  const pg = await openHome('https://www.instagram.com/?variant=following');
  await pg.tap('#home');
  await pg.waitForTimeout(200);
  await pg.tap('#back');
  await pg.waitForTimeout(200);
  const s = await state(pg);
  assert.equal(s.clicks, 0, 'Instagram never switched feeds in the page');
  assert.deepEqual((await sent(pg, 'openFeed')).map(m => m.variant), ['home', 'home']);
  assert.deepEqual(s.navStats.homeFull, { bar: 1, header: 1 });
  assert.equal(await pg.evaluate(() => location.search), '?variant=following', 'the app loads it');
});

test('Home tab on ?variant=following without the app\'s bridge: a full load of /', async () => {
  const pg = await openHome('https://www.instagram.com/?variant=following');
  await pg.evaluate(() => { delete window.SGNative; });
  await Promise.all([pg.waitForURL('https://www.instagram.com/'), pg.tap('#home')]);
  await pg.waitForFunction(() => !!window.__sg && window.__c && window.__c.requests.length > 0);
  assert.equal(await pg.evaluate(() => window.__c.clicks), 0);
});

test('Home tab: a modified or untrusted click is left alone', async () => {
  const pg = await openHome('https://www.instagram.com/?variant=following');
  await pg.evaluate(() => document.getElementById('home').click());   // untrusted
  await pg.click('#home', { modifiers: ['Control'] });
  const s = await state(pg);
  assert.equal(s.clicks, 2);
  assert.equal((await sent(pg, 'openFeed')).length, 0);
});

/* ---------------- 3. Switching feeds inside the page (B18) ---------------- */

const FEED = '<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body style="margin:0"><main id="feed"></main></body></html>';
const parse = (pg, p) => pg.evaluate(x => JSON.parse(JSON.stringify(x)), p);
const docN = pg => pg.evaluate(() => +sessionStorage.getItem('sg_doc_n'));

test('switch: Instagram switching from Following to Home inside the page loads Home afresh, once; a second switch within 2 s does not reload', async () => {
  const pg = await open('https://www.instagram.com/?variant=following', FEED);
  await parse(pg, page([friend('FOL0001')], 'f1', 'following'));
  const nav = pg.waitForNavigation();
  await pg.evaluate(() => history.pushState({ key: 'x' }, '', '/'));
  await nav;
  await pg.waitForFunction(() => !!window.__sg);
  assert.equal(await pg.evaluate(() => location.href), 'https://www.instagram.com/');
  assert.equal(await docN(pg), 2, 'a new page');
  assert.equal(await pg.evaluate(() => window.__sg.stats.feed.switchLoads), 1);
  // Right away another switch (a loop): held, no reload.
  await pg.evaluate(() => history.pushState({ key: 'y' }, '', '/?variant=favorites'));
  await pg.waitForTimeout(500);
  assert.equal(await docN(pg), 2);
  assert.equal(await pg.evaluate(() => location.search), '?variant=favorites');
  const f = await pg.evaluate(() => window.__sg.stats.feed);
  assert.equal(f.switchHeld, 1);
  assert.equal(f.switchLoads, 1);
  assert.ok((await pg.evaluate(() => window.__sg.trail())).some(e => e.ev === 'switchHeld' && e.from === 'home' && e.to === 'favorites'));
});

test('switch: the same feed\'s address written again, or a post opened and closed, never reloads', async () => {
  const pg = await open('https://www.instagram.com/', FEED);
  await pg.evaluate(() => { history.replaceState({ key: 'a' }, '', '/?foo=1'); history.pushState(null, '', '/p/ABCDEF1/'); history.back(); });
  await pg.waitForTimeout(600);
  assert.equal(await docN(pg), 1);
  assert.equal(await pg.evaluate(() => window.__sg.stats.feed.switchLoads || 0), 0);
  // Opened on a post first: going Home is the first feed this page shows.
  const p2 = await open('https://www.instagram.com/p/ABCDEF1/', FEED);
  await p2.evaluate(() => history.pushState(null, '', '/'));
  await p2.waitForTimeout(400);
  assert.equal(await docN(p2), 1);
});

/* ---------------- 4. Recovery of a blank feed (B18) ---------------- */

async function draw(pg, n) {
  await pg.evaluate(k => { document.getElementById('feed').innerHTML = '<article style="height:600px">x</article>'.repeat(k); }, n);
}
async function checks(pg, n) {
  for (let i = 0; i < n; i++) { await pg.clock.fastForward(1600); await pg.evaluate(() => window.__sg.checkNotDrawn()); }
}

test('recovery: posts kept but none drawn reloads once per address; the next time it holds off (no loop)', async () => {
  const pg = await open('https://www.instagram.com/?variant=favorites', FEED);
  await pg.clock.install();
  await draw(pg, 1);
  await pg.evaluate(() => window.__sg.checkNotDrawn());   // posts were drawn once in this session
  await draw(pg, 0);
  await parse(pg, page([friend('FAV0001'), friend('FAV0002')], 'v1', 'favorites'));
  const nav = pg.waitForNavigation({ timeout: 10000 });
  // 10 s with no post drawn after the page (Instagram may still be mounting its list).
  await checks(pg, 8).catch(() => {});
  await nav;
  await pg.waitForFunction(() => !!window.__sg);
  assert.equal(await docN(pg), 2);
  assert.equal(await pg.evaluate(() => window.__sg.stats.feed.recovered), 1);
  await pg.clock.install();
  await parse(pg, page([friend('FAV0001'), friend('FAV0002')], 'v2', 'favorites'));
  await checks(pg, 8);
  const f = await pg.evaluate(() => window.__sg.stats.feed);
  assert.equal(f.recoverHeld, 1);
  assert.equal(await docN(pg), 2, 'no second reload');
});

test('recovery: never before posts were drawn in this session, never with posts on screen, never while the card or the caught-up line is the content', async () => {
  // Nothing ever drawn (Instagram's markup changed, or a fresh session): quiet.
  let pg = await open('https://www.instagram.com/', FEED);
  await pg.clock.install();
  await parse(pg, page([friend('HOME001')], 'a1'));
  await checks(pg, 4);
  assert.equal(await docN(pg), 1);
  // Posts on screen.
  pg = await open('https://www.instagram.com/', FEED);
  await pg.clock.install();
  await draw(pg, 2);
  await parse(pg, page([friend('HOME001')], 'a1'));
  await checks(pg, 4);
  assert.equal(await pg.evaluate(() => window.__sg.stats.feed.recovered || 0), 0);
  // Only Instagram's caught-up line (the marker anchor).
  pg = await open('https://www.instagram.com/', FEED);
  await pg.clock.install();
  await draw(pg, 1);
  await pg.evaluate(() => window.__sg.checkNotDrawn());
  await draw(pg, 0);
  await parse(pg, page([marker()], 'm1'));
  await checks(pg, 4);
  assert.equal(await pg.evaluate(() => window.__sg.stats.feed.recovered || 0), 0);
  assert.equal(await docN(pg), 1);
});

test('recovery: Instagram\'s own refresh placeholder (no posts until its new page lands) is never reloaded', async () => {
  const pg = await open('https://www.instagram.com/', FEED);
  await pg.clock.install();
  await parse(pg, page([friend('HOME001'), friend('HOME002'), friend('HOME003')], 'c1'));
  await draw(pg, 3);
  await checks(pg, 20);                                  // read for half a minute
  // The Home tab at the top: Instagram shows its placeholder (divs only) while it refetches.
  await pg.evaluate(() => { document.getElementById('feed').innerHTML = '<div><div class="glimmer" style="height:600px"></div></div>'; });
  await checks(pg, 8);
  assert.equal(await docN(pg), 1, 'no reload while the refresh runs');
  await parse(pg, page([friend('NEW0001'), friend('HOME001')], 'h2'));
  await draw(pg, 2);
  await checks(pg, 8);
  assert.equal(await docN(pg), 1);
  assert.equal(await pg.evaluate(() => window.__sg.stats.feed.recovered || 0), 0);
  assert.equal(await pg.evaluate(() => sessionStorage.getItem('sg_feed_recover')), null, 'the one recovery for Home is still there');
});

test('recovery: Instagram\'s empty-feed screen after SimpleGram handed the feed a post reloads once', async () => {
  const pg = await open('https://www.instagram.com/?variant=favorites', FEED);
  await pg.clock.install();
  await draw(pg, 1);
  await pg.evaluate(() => window.__sg.checkNotDrawn());
  await draw(pg, 0);
  await parse(pg, page([friend('FAV0001')], 'v1', 'favorites'));
  await pg.evaluate(() => { document.getElementById('feed').innerHTML = '<svg aria-label="Star outline icon in circle."></svg><h2>Choose the accounts you can\'t miss out on</h2>'; });
  const nav = pg.waitForNavigation({ timeout: 10000 });
  // Fresh within 2.5 s of the page: only the screen itself can trigger it.
  await pg.evaluate(() => window.__sg.checkNotDrawn());
  await pg.evaluate(() => window.__sg.checkNotDrawn());
  await nav;
  await pg.waitForFunction(() => !!window.__sg);
  assert.equal(await pg.evaluate(() => window.__sg.stats.feed.recovered), 1);
});

/* ---------------- 5. Diagnostics: shapes only ---------------- */

test('diagnostics: the feed trail, Home events and Home pages carry no names, codes or addresses, and the trail reaches the app', async () => {
  const pg = await openHome();
  await scrollToEnd(pg);
  await pg.tap('#home');
  await pg.waitForTimeout(300);
  await pg.evaluate(() => { history.pushState(null, '', '/p/TOP0001/'); history.back(); });
  await pg.waitForTimeout(3500);   // the drawn sample
  await pg.evaluate(() => window.__sg.onNative({ type: 'status' }));
  const [st] = await sent(pg, 'status');
  const s = st.stats;
  assert.ok(s.trail.length >= 4, JSON.stringify(s.trail));
  const pageEntry = s.trail.find(e => e.ev === 'page');
  for (const k of ['d', 'pg', 'nav', 'va', 'vp', 'ps', 'in', 'out', 'k', 'sk', 'ad', 'sg', 'mk', 'nx0', 'nx1', 'an', 'first', 'ae', 't']) assert.ok(k in pageEntry, k);
  const drawn = s.trail.find(e => e.ev === 'drawn');
  assert.ok(drawn && drawn.posts > 0 && typeof drawn.raf === 'number' && drawn.bar === true, JSON.stringify(drawn));
  assert.ok(s.homeEvents.some(e => e.e === 'route' && e.to === 'post'));
  assert.ok(s.homeEvents.some(e => e.e === 'tap'));
  assert.ok(s.homeRing.length >= 3);
  assert.deepEqual(Object.keys(s.storage).sort(), ['other', 'screenTime', 'scroll', 'sg', 'tabId']);
  assert.ok(s.storage.sg >= 1);
  // Mirrored to the app as written.
  const mirrored = (await sent(pg, 'trail')).map(m => m.entry);
  assert.deepEqual(mirrored.slice(-s.trail.length), s.trail);
  const json = JSON.stringify({ t: s.trail, e: s.homeEvents, r: s.homeRing, st: s.storage, m: mirrored });
  for (const bad of ['TOP0001', 'MID0001', 'NEWPOST', 'X1', 'AD1', 'fTOP', 'brand', 'instagram', 'http', '/p/', 'caught up', 'scontent']) {
    assert.ok(!json.includes(bad), 'must not contain ' + bad);
  }
});
