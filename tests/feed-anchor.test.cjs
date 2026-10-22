// Batch 4 feed tests: a feed's first page is never handed over empty (the
// anchor, B17/B18), the page opened from the end card keeps going past posts
// seen in Home (B17), and each page is told which feed it belongs to (B18).
//
// Every request is answered locally (nothing reaches Instagram). The feed
// page model in ig-feed-mock.js is built from Instagram's bundles; passing
// here does not prove live behaviour.
//
// Run: NODE_PATH=/opt/node-tools/node_modules node --test tests/*.test.cjs
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { useBrowser, open, sent, BLANK, user, media, edge } = require('./helpers.cjs');

useBrowser();
const IGMOCK = fs.readFileSync(path.join(__dirname, 'ig-feed-mock.js'), 'utf8');

/* ---------------- Fixtures ---------------- */

let seq = 0;
function page(edges, { more = true, cursor = 'cur' + (seq++), source } = {}) {
  const conn = { edges, page_info: { has_next_page: more, end_cursor: cursor } };
  if (source !== undefined) conn.pagination_source = source;
  return { data: { xdt_api__v1__feed__timeline__connection: conn }, extensions: { is_final: true } };
}
const friends = {};
const fr = c => friends[c] || (friends[c] = user('f' + c, true));
const friend = c => edge({ media: media(c, fr(c)) });
const recs = c => edge({ explore_story: { media: media(c, user('r' + c)) } });
const adUnit = c => edge({ ad: { ad_id: '1' }, media: media(c, user('brand'), { ad_id: '1' }) });
const SUBTITLE = "You've seen all new posts from the past 3 days.";
function marker() {
  return edge({ end_of_feed_demarcator: { id: 'eof', title: "You're all caught up", subtitle: SUBTITLE,
    group_set: { id: 'gs', active_group_id: 'feed_recs', groups: [
      { id: 'feed_recs', pagination_source: 'feed_recs', next_max_id: 'r1', feed_items: [{ explore_story: { media: media('GRPREC1', user('x')) } }] }] } } });
}
const conn = o => o.data.xdt_api__v1__feed__timeline__connection;
const keys = o => conn(o).edges.map(e => {
  const n = e.node;
  return n.media ? n.media.code : n.explore_story ? 'explore:' + n.explore_story.media.code : Object.keys(n).filter(k => k !== '__typename')[0];
});
const parse = (pg, p) => pg.evaluate(x => JSON.parse(JSON.stringify(x)), p);
const FEED = '<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body style="margin:0"><main id="feed"></main></body></html>';
const feedStats = pg => pg.evaluate(() => window.__sg.stats.feed);
const feedState = pg => pg.evaluate(() => window.__sg.feedState());

// Home showed `codes`; then the end card's Following button.
async function fromEndCard(codes, html) {
  const pg = await open('https://www.instagram.com/', html || FEED);
  await parse(pg, page(codes.map(friend), { more: false }));
  await Promise.all([pg.waitForURL(/variant=following/), pg.evaluate(() => window.__sg.onNative({ type: 'continueFeed', variant: 'following' }))]);
  return pg;
}

/* ---------------- 1. The anchor (data) ---------------- */

test('anchor: a Following first page of 3 posts seen in Home keeps one, the oldest; later pages load and new posts show', async () => {
  const pg = await fromEndCard(['HOME001', 'HOME002', 'HOME003', 'HOME004']);
  const first = await parse(pg, page([friend('HOME004'), friend('HOME003'), friend('HOME002')], { source: 'following' }));
  assert.deepEqual(keys(first), ['HOME002'], 'the oldest seen post (last in list order)');
  assert.equal(conn(first).page_info.has_next_page, true);
  // Later pages of only seen posts are still emptied: the list already has an item.
  const second = await parse(pg, page([friend('HOME001')], { source: 'following' }));
  assert.deepEqual(keys(second), []);
  assert.equal(conn(second).page_info.has_next_page, true);
  const third = await parse(pg, page([friend('NEW0001'), friend('NEW0002')], { source: 'following' }));
  assert.deepEqual(keys(third), ['NEW0001', 'NEW0002']);
  const f = await feedStats(pg);
  assert.equal(f.anchor, 1);
  assert.deepEqual(f.anchorKind, { seen: 1, marker: 0, recs: 0 });
  assert.equal(f.alreadySeen, 3);
  assert.equal(f.kept, 3, 'the anchor counts as kept (the follow fail-open can never arm on it)');
});

test('anchor: a first page with a new post needs none; Following opened another way shows everything', async () => {
  let pg = await fromEndCard(['HOME001', 'HOME002']);
  const out = await parse(pg, page([friend('HOME001'), friend('NEW0001'), friend('HOME002')]));
  assert.deepEqual(keys(out), ['NEW0001']);
  assert.equal((await feedStats(pg)).anchor || 0, 0);
  pg = await open('https://www.instagram.com/?variant=following', FEED);
  const menu = await parse(pg, page([friend('HOME001'), friend('HOME002')]));
  assert.deepEqual(keys(menu), ['HOME001', 'HOME002']);
});

test('anchor: Home\'s first page of suggestions with no marker ([rec, rec, ad]) keeps the first suggestion, hidden, and pages on', async () => {
  const pg = await open('https://www.instagram.com/', FEED);
  const out = await parse(pg, page([recs('REC0001'), recs('REC0002'), adUnit('AD00001')]));
  assert.deepEqual(keys(out), ['explore:REC0001']);
  assert.equal(conn(out).page_info.has_next_page, true, 'has_next as sent');
  assert.deepEqual((await feedStats(pg)).anchorKind, { seen: 0, marker: 0, recs: 1 });
  assert.equal((await feedStats(pg)).kept, 0, 'a hidden suggestion is not a post shown');
  // Instagram draws it: it is hidden by a rule keyed on its link, before the first frame.
  const r = await pg.evaluate(() => new Promise(done => {
    const feed = document.getElementById('feed');
    feed.insertAdjacentHTML('beforeend', '<article id="rec"><a href="/p/REC0001/"><time>1d</time></a><div style="height:500px"></div></article>' +
      '<article id="other"><a href="/p/OTHER01/"><time>1d</time></a></article>');
    requestAnimationFrame(() => done([getComputedStyle(document.getElementById('rec')).display, getComputedStyle(document.getElementById('other')).display]));
  }));
  assert.deepEqual(r, ['none', 'block']);
  // The scroll room lets a swipe reach Instagram's loader; page 2 brings the marker.
  assert.equal(await pg.evaluate(() => !!document.getElementById('sg-skip-room')), true);
  // Cut to nothing at the marker, the page keeps the marker without its groups
  // (it may be a head load that replaces the list: never []).
  const second = await parse(pg, page([recs('REC0003'), marker()]));
  assert.deepEqual(keys(second), ['end_of_feed_demarcator']);
  assert.deepEqual(conn(second).edges[0].node.end_of_feed_demarcator.group_set.groups, []);
  assert.equal(conn(second).page_info.has_next_page, false);
  assert.equal((await feedState(pg)).ended, true);
  await pg.waitForFunction(() => !document.getElementById('sg-skip-room'), null, { timeout: 4000 });
});

test('anchor: Home\'s first page of suggestions labelled feed_recs with no marker is anchored too, never emptied and ended', async () => {
  const pg = await open('https://www.instagram.com/', FEED);
  const out = await parse(pg, page([recs('REC0001'), recs('REC0002'), adUnit('AD00001')], { source: 'feed_recs' }));
  assert.deepEqual(keys(out), ['explore:REC0001']);
  assert.equal(conn(out).page_info.has_next_page, true, 'has_next as sent');
  assert.equal((await feedState(pg)).ended, false);
  assert.equal((await feedStats(pg)).recsFirst, 1);
  assert.deepEqual((await feedStats(pg)).anchorKind, { seen: 0, marker: 0, recs: 1 });
  // A later page of the same kind is Instagram's all-suggestions feed: Home ends there, as before.
  await parse(pg, page([friend('FRIEND1')]));
  const later = await parse(pg, page([recs('REC0003'), friend('FRIEND2')], { source: 'feed_recs' }));
  assert.deepEqual(keys(later), ['FRIEND2']);
  assert.equal(conn(later).page_info.has_next_page, false);
  assert.equal((await feedState(pg)).ended, true);
});

test('anchor: an ad is never the anchor', async () => {
  const pg = await open('https://www.instagram.com/', FEED);
  const out = await parse(pg, page([adUnit('AD00001'), edge({ explore_story: { media: media('ADREC01', user('b'), { ad_id: '9' }) } }), adUnit('AD00002')]));
  assert.deepEqual(keys(out), []);
  assert.equal((await feedStats(pg)).anchor || 0, 0);
});

test('anchor: a caught-up Home first page with nothing before the marker keeps Instagram\'s marker, without its groups, and stops', async () => {
  const pg = await open('https://www.instagram.com/', FEED);
  const out = await parse(pg, page([adUnit('AD00003'), recs('REC0001'), marker(), recs('AFTER03')], { source: 'feed_recs' }));
  assert.deepEqual(keys(out), ['end_of_feed_demarcator']);
  const gs = conn(out).edges[0].node.end_of_feed_demarcator.group_set;
  assert.deepEqual(gs.groups, []);
  assert.equal(gs.active_group_id, null);
  assert.equal(conn(out).page_info.has_next_page, false);
  const st = await feedState(pg);
  assert.equal(st.ended, true);
  assert.equal(st.caughtUp, true);
  assert.equal(st.endText.subtitle, '', 'the card leaves Instagram\'s line to Instagram');
});

test('anchor: the first page after a refresh reset is anchored too', async () => {
  const pg = await open('https://www.instagram.com/', FEED);
  await parse(pg, page([friend('HOME001'), friend('HOME002'), marker()], { cursor: 'end1' }));
  assert.equal((await feedState(pg)).ended, true);
  // Instagram reloads Home: the new first page holds only its marker.
  const out = await parse(pg, page([recs('REC0001'), marker()], { cursor: 'fresh1' }));
  assert.deepEqual(keys(out), ['end_of_feed_demarcator']);
  assert.equal((await feedStats(pg)).refreshes, 1);
  assert.deepEqual((await feedStats(pg)).anchorKind, { seen: 0, marker: 1, recs: 0 });
});

test('anchor: a Home page after the end (a reload that replaces the list) is anchored, not emptied, every time', async () => {
  const pg = await open('https://www.instagram.com/', FEED);
  await parse(pg, page([friend('HOME001'), friend('HOME002'), marker()], { cursor: 'end1' }));
  // The reload's head is [rec, rec, ad] (the marker would come on its page 2).
  const out = await parse(pg, page([recs('REC0001'), recs('REC0002'), adUnit('AD00001')], { cursor: 'h1' }));
  assert.deepEqual(keys(out), ['explore:REC0001']);
  assert.equal(conn(out).page_info.has_next_page, false, 'Home stays ended');
  assert.equal((await feedState(pg)).ended, true);
  // Every such page: a second reload (or an appended page) also keeps one, hidden.
  const more = await parse(pg, page([recs('REC0003')], { cursor: 'h2' }));
  assert.deepEqual(keys(more), ['explore:REC0003']);
  // Nothing that can be hidden: emptied, as before.
  const ads = await parse(pg, page([adUnit('AD00009')], { cursor: 'h3' }));
  assert.deepEqual(keys(ads), []);
  const f = await feedStats(pg);
  assert.equal(f.anchorAfterEnd, 2);
});

test('anchor: a Following page that keeps Instagram\'s marker needs no anchor (it is not empty)', async () => {
  const pg = await fromEndCard(['HOME001']);
  const out = await parse(pg, page([friend('HOME001'), marker()], { source: 'following' }));
  assert.deepEqual(keys(out), ['HOME001', 'end_of_feed_demarcator'], 'the seen post anchors; the marker stays as on Following');
});

/* ---------------- 2. Which feed a page belongs to ---------------- */

test('page variant: a Favorites page parsed under the Following address is not skipped; a Following page under Home\'s is', async () => {
  const pg = await fromEndCard(['HOME001', 'HOME002', 'HOME003']);
  await parse(pg, page([friend('HOME003'), friend('HOME002'), friend('HOME001')], { source: 'following' }));
  const fav = await parse(pg, page([friend('HOME002'), friend('HOME001'), friend('FAV0001')], { source: 'favorites' }));
  assert.deepEqual(keys(fav), ['HOME002', 'HOME001', 'FAV0001'], 'the skip is Following\'s only');
  // A Home page (pagination_source null, or Instagram's feed_recs label) follows the address.
  const later = await parse(pg, page([friend('NEW0001'), marker()], { source: 'feed_recs' }));
  assert.deepEqual(keys(later), ['NEW0001', 'end_of_feed_demarcator'], 'on the Following address, still Following');
});

/* ---------------- 3. Following from the end card (B17) ---------------- */

test('skip: a reload of Following\'s first page (every seen post already skipped) ends the skip and shows as sent', async () => {
  const pg = await fromEndCard(['HOME001', 'HOME002', 'HOME003']);
  await parse(pg, page([friend('HOME003'), friend('HOME002'), friend('HOME001')]));
  const again = await parse(pg, page([friend('HOME003'), friend('HOME002'), friend('HOME001')]));
  assert.deepEqual(keys(again), ['HOME003', 'HOME002', 'HOME001'], 'never blank');
  assert.equal((await feedStats(pg)).skipForgotten, 1);
  assert.equal(await pg.evaluate(() => !!document.getElementById('sg-skip-room')), false);
});

test('skip: the note says "Skipping…" after 3 s with only the anchor, goes when new posts arrive, and says "Nothing new" at an end with only the anchor', async () => {
  let pg = await fromEndCard(['HOME001', 'HOME002', 'HOME003']);
  await pg.clock.install();
  await parse(pg, page([friend('HOME003'), friend('HOME002'), friend('HOME001')]));
  await pg.clock.runFor(2000);
  assert.equal((await sent(pg, 'skipStatus')).length, 0);
  await pg.clock.runFor(1500);
  assert.deepEqual((await sent(pg, 'skipStatus')).map(m => [m.on, m.kind, m.n]), [[true, 'skipping', 3]]);
  await parse(pg, page([friend('NEW0001')]));
  assert.deepEqual((await sent(pg, 'skipStatus')).map(m => m.on), [true, false]);
  assert.equal((await sent(pg, 'feedEnd')).filter(m => m.on).length, 0, 'never the end-of-Home card');

  pg = await fromEndCard(['HOME001', 'HOME002', 'HOME003']);
  await parse(pg, page([friend('HOME003'), friend('HOME002')]));
  await parse(pg, page([friend('HOME001')], { more: false }));
  const last = (await sent(pg, 'skipStatus')).pop();
  assert.deepEqual([last.on, last.kind], [true, 'nothingNew']);
});

test('skip: the scroll room is only on the page opened from the end card, and goes when the feed ends', async () => {
  let pg = await fromEndCard(['HOME001', 'HOME002', 'HOME003']);
  await parse(pg, page([friend('HOME003'), friend('HOME002'), friend('HOME001')]));
  const h = await pg.evaluate(() => { const r = document.getElementById('sg-skip-room'); return r && r.getBoundingClientRect().height; });
  assert.ok(h >= Math.round(915 * 0.6), String(h));
  assert.ok(await pg.evaluate(() => document.scrollingElement.scrollHeight - innerHeight > 300), 'a swipe can scroll');
  await parse(pg, page([friend('NEW0001')], { more: false }));
  await pg.waitForFunction(() => !document.getElementById('sg-skip-room'), null, { timeout: 4000 });
  // Following from the menu, and Home: never.
  pg = await open('https://www.instagram.com/?variant=following', FEED);
  await parse(pg, page([friend('A000001')]));
  assert.equal(await pg.evaluate(() => !!document.getElementById('sg-skip-room')), false);
  pg = await open('https://www.instagram.com/', FEED);
  await parse(pg, page([friend('A000001')]));
  assert.equal(await pg.evaluate(() => !!document.getElementById('sg-skip-room')), false);
});

test('skip: nudges keep trying (about 1, 2, 4, 8 s) while only the anchor shows; Home and the menu\'s Following nudge once', async () => {
  let pg = await fromEndCard(['HOME001', 'HOME002', 'HOME003']);
  await pg.clock.install();
  await parse(pg, page([friend('HOME003'), friend('HOME002'), friend('HOME001')]));
  await pg.clock.runFor(700);
  assert.equal((await feedStats(pg)).nudges, 1);
  await pg.clock.runFor(16000);
  const n = (await feedStats(pg)).nudges;
  assert.ok(n >= 4 && n <= 6, 'retries: ' + n);
  await pg.clock.runFor(60000);
  assert.ok((await feedStats(pg)).nudges <= 9, 'at most 8 tries after the first');
  // A page arriving stops them.
  pg = await open('https://www.instagram.com/?variant=following', FEED);
  await pg.clock.install();
  await parse(pg, page([friend('A000001')]));
  await pg.clock.runFor(20000);
  assert.equal((await feedStats(pg)).nudges, 1, 'the menu\'s Following: one nudge, as in 1.2');
});

test('skip: paging past seen posts uses its own budget (40 a minute), not Home\'s 10', async () => {
  const seen = Array.from({ length: 60 }, (_, i) => 'SEEN' + String(i).padStart(3, '0'));
  const pg = await fromEndCard(seen);
  await pg.clock.install();
  await parse(pg, page([friend(seen[0])]));
  for (let i = 1; i <= 15; i++) {
    await parse(pg, page([friend(seen[i])], { cursor: 'p' + i }));
    await pg.clock.runFor(450);
  }
  const f = await feedStats(pg);
  assert.ok(f.skipNudges >= 14, JSON.stringify(f));
  assert.equal(f.nudgesCapped || 0, 0);
  assert.equal(f.skipCapped || 0, 0);
});

test('skip: Instagram\'s "please wait" stops the skip\'s nudges', async () => {
  const pg = await fromEndCard(['HOME001', 'HOME002', 'HOME003', 'HOME004']);
  await pg.clock.install();
  await parse(pg, page([friend('HOME001')]));
  await pg.evaluate(() => JSON.parse('{"status":"fail","message":"Please wait a few minutes before you try again."}'));
  await parse(pg, page([friend('HOME002')]));
  await pg.clock.runFor(20000);
  const f = await feedStats(pg);
  assert.equal(f.skipThrottled, 1);
  assert.ok((f.nudges || 0) <= 1, JSON.stringify(f));
});

test('skip: a post opened and closed keeps the skip (Instagram keeps the same list)', async () => {
  const pg = await fromEndCard(['HOME001', 'HOME002']);
  await parse(pg, page([friend('HOME002'), friend('NEW0001')]));
  await pg.evaluate(() => { history.pushState(null, '', '/p/NEW0001/'); history.back(); });
  await pg.waitForFunction(() => location.search === '?variant=following');
  const out = await parse(pg, page([friend('HOME001'), friend('NEW0002')]));
  assert.deepEqual(keys(out), ['NEW0002'], 'still skipping after a post');
  assert.equal((await feedStats(pg)).skipLeft || 0, 0);
});

/* ---------------- 4. With a model of Instagram's feed page ---------------- */

const fedge = c => ({ node: { __typename: 'XDTFeedItem', media: media(c, fr(c)) }, cursor: 'c' });
const codesOf = (p, n) => Array.from({ length: n }, (_, i) => p + String(i).padStart(6, '0'));
const igPage = (edges, more, cursor) => ({ data: { xdt_api__v1__feed__timeline__connection: { edges, page_info: { has_next_page: more, end_cursor: cursor } } }, extensions: { is_final: true } });

// Home showed `seenN` posts; Following has them first, then new ones (3 on
// its first page, `per` on later ones). `serve` replaces Following's pages.
async function igEndCard({ seenN = 19, per = 8, params = {}, serve = null }) {
  const seen = codesOf('S', seenN);
  const list = seen.concat(codesOf('U', 80));
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>body{margin:0;background:#000;color:#fff}</style></head><body>
    <div style="height:60px">Feed</div><main id="main"></main><script>window.__igParams=${JSON.stringify(Object.assign({ mode: 'H2', mountMs: 1500 }, params))};</script><script>${IGMOCK}</script></body></html>`;
  const api = {
    '/api/graphql': u => {
      const v = u.searchParams.get('variant'), n = +u.searchParams.get('page');
      if (v === 'home') return { body: igPage(seen.map(fedge), false, 'h0') };
      if (serve) return { body: serve(n, seen) };
      const start = n === 0 ? 0 : 3 + (n - 1) * per, len = n === 0 ? 3 : per;
      return { body: igPage(list.slice(start, start + len).map(fedge), start + len < list.length, v + n) };
    },
    '/api/ayml': { data: { xdt_api__v1__ayml__strict: { users: [{ pk: '1', username: 'a' }, { pk: '2', username: 'b' }] } } },
  };
  const pg = await open('https://www.instagram.com/', html, { api });
  await pg.waitForFunction(() => window.__ig && window.__ig.items.length > 0 && window.__ig.mountedAt > 0);
  await Promise.all([pg.waitForURL(/variant=/), pg.evaluate(() => window.__sg.onNative({ type: 'continueFeed', variant: 'following' }))]);
  await pg.waitForFunction(() => !!window.__ig);
  return { pg, seen: new Set(seen) };
}
const igState = pg => pg.evaluate(() => ({ items: window.__ig.items.map(i => i.code), empty: window.__ig.empty, screen: window.__ig.screen(),
  req: window.__ig.requests.length, feed: window.__sg.stats.feed }));
const reachedNew = (pg, ms) => pg.waitForFunction(() => window.__ig.items.some(i => i.code[0] === 'U'), null, { timeout: ms || 12000 }).catch(() => {});

for (const mode of ['H1', 'H2']) {
  test(`B17 (${mode}): Following from the end card is never blank, shows one repeat at most, and reaches new posts`, async () => {
    const { pg, seen } = await igEndCard({ params: { mode } });
    await reachedNew(pg);
    const s = await igState(pg);
    assert.equal(s.empty, false, 'Instagram never sees an empty first page');
    assert.ok(s.items.filter(c => seen.has(c)).length <= 1, 'one repeat at most: ' + s.items.slice(0, 5));
    assert.ok(s.items.some(c => !seen.has(c)), 'new posts loaded: ' + JSON.stringify({ req: s.req, nudges: s.feed.nudges }));
    // Diagnostics: how the next page was asked for, and when the first new post came.
    assert.ok(s.feed.skipFirstNewMs > 0, JSON.stringify(s.feed));
    assert.ok(Object.values(s.feed.tries).some(t => t.n > 0 && t.hit > 0), JSON.stringify(s.feed.tries));
  });
}

test('B17: 120 posts seen in Home and 8-post pages: Following still reaches the posts after them', async () => {
  const { pg, seen } = await igEndCard({ seenN: 120, per: 8, params: { mountMs: 0 } });
  await reachedNew(pg, 40000);
  const s = await igState(pg);
  assert.ok(s.items.some(c => !seen.has(c)), 'new posts loaded: ' + JSON.stringify({ req: s.req, nudges: s.feed.nudges, capped: s.feed.nudgesCapped }));
  assert.equal(s.feed.nudgesCapped || 0, 0);
});

test('B17: a list that pages only on real scrolls still reaches new posts (first page: 2 seen + 1 new)', async () => {
  const { pg, seen } = await igEndCard({ seenN: 2, params: { trustedOnly: true } });
  await pg.waitForFunction(() => window.__ig.items.length > 3, null, { timeout: 10000 }).catch(() => {});
  const items = await pg.evaluate(() => window.__ig.items.map(i => i.code));
  assert.ok(items.filter(c => !seen.has(c)).length > 1, 'stuck at ' + JSON.stringify(items));
});

test('B17: with only the anchor, a swipe into the scroll room pages', async () => {
  const { pg } = await igEndCard({ params: { trustedOnly: true } });
  await pg.waitForFunction(() => window.__ig.mountedAt > 0 && window.__ig.items.length === 1, null, { timeout: 5000 });
  await pg.mouse.wheel(0, 400);
  await pg.waitForFunction(() => window.__ig.items.some(i => i.code[0] === 'U'), null, { timeout: 10000 });
  const tries = await pg.evaluate(() => window.__sg.stats.feed.tries);
  assert.ok(tries.swipe && tries.swipe.n >= 1, JSON.stringify(tries));
});

test('B17: releasing the scroll room never moves the page (Instagram draws a moment after the data)', async () => {
  const { pg } = await igEndCard({ params: { trustedOnly: true, renderDelay: 150 } });
  await pg.waitForFunction(() => window.__ig.mountedAt > 0 && window.__ig.items.length === 1 && !!document.getElementById('sg-skip-room'), null, { timeout: 5000 });
  await pg.evaluate(() => { window.__minY = Infinity; addEventListener('scroll', () => { if (scrollY > 0) window.__sawY = true; if (window.__sawY) window.__minY = Math.min(window.__minY, scrollY); }, true); });
  await pg.mouse.wheel(0, 400);
  await pg.waitForFunction(() => window.__ig.items.length > 1, null, { timeout: 10000 });
  await pg.waitForTimeout(800);
  const y = await pg.evaluate(() => ({ y: scrollY, min: window.__minY }));
  assert.ok(y.min > 100 && y.y > 100, 'the page jumped back to the top: ' + JSON.stringify(y));
});

test('B17: Instagram looping the same seen posts costs a few requests, not a burst', async () => {
  const { pg } = await igEndCard({ params: { mountMs: 0 }, serve: (n, seen) => igPage(seen.slice(0, 3).map(fedge), true, 'same') });
  await pg.waitForTimeout(12000);
  const req = await pg.evaluate(() => window.__ig.requests.length);
  assert.ok(req <= 5, req + ' requests in 12 s');
});

test('B17: a pull to refresh on Following opened from the end card is never left blank', async () => {
  const { pg } = await igEndCard({ params: { mountMs: 0 } });
  await reachedNew(pg, 10000);
  await pg.evaluate(() => window.__ig.refetch());
  await pg.waitForTimeout(400);
  const s = await pg.evaluate(() => ({ items: window.__ig.items.length, inView: window.__ig.screen().inView.length }));
  assert.ok(s.items > 0 && s.inView > 0, JSON.stringify(s));
});

test('B17: the scroll room goes when you leave for Home inside the page', async () => {
  const { pg } = await igEndCard({ params: { trustedOnly: true } });
  await pg.waitForFunction(() => !!document.getElementById('sg-skip-room'), null, { timeout: 5000 });
  // (An in-page switch to Home is now a fresh page of Home: B18.)
  await pg.evaluate(() => { history.pushState({}, '', '/'); dispatchEvent(new PopStateEvent('popstate')); });
  await pg.waitForTimeout(1600);
  assert.equal(await pg.evaluate(() => !!document.getElementById('sg-skip-room')), false);
});

test('B18: Home\'s first page [rec, rec, ad] with the marker on page 2 is never empty, and page 2 arrives', async () => {
  for (const mode of ['H1', 'H2']) {
    const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body style="margin:0">
      <div style="height:60px">Stories</div><main id="main"></main><script>window.__igParams=${JSON.stringify({ mode, mountMs: 1000, trustedOnly: mode === 'H2' })};</script><script>${IGMOCK}</script></body></html>`;
    const api = {
      '/api/graphql': u => {
        const n = +u.searchParams.get('page');
        if (n === 0) return { body: page([recs('REC0001'), recs('REC0002'), adUnit('AD00001')], { cursor: 'h0' }) };
        return { body: page([friend('HOMENEW'), marker(), recs('AFTER01')], { cursor: 'h1', source: 'feed_recs' }) };
      },
      '/api/ayml': { data: { xdt_api__v1__ayml__strict: { users: [{ pk: '1', username: 'a' }] } } },
    };
    const pg = await open('https://www.instagram.com/', html, { api });
    await pg.waitForFunction(() => window.__ig && window.__ig.mountedAt > 0);
    if (mode === 'H2') {
      // A list that only pages on real scrolls: the room takes your swipe.
      await pg.waitForFunction(() => !!document.getElementById('sg-skip-room'));
      await pg.mouse.wheel(0, 300);
    }
    await pg.waitForFunction(() => window.__ig.items.some(i => i.code === 'HOMENEW'), null, { timeout: 12000 });
    const s = await igState(pg);
    assert.equal(s.empty, false, mode + ': Instagram never saw an empty Home');
    assert.equal(s.screen.recsShown, 0, mode + ': the anchor suggestion is never drawn');
    assert.ok(s.items.includes('HOMENEW'), mode + ': ' + JSON.stringify(s.screen));
    assert.equal((await feedState(pg)).ended, true);
  }
});

/* ---------------- 5. Review fixes ---------------- */

const neutral = o => {
  const d = conn(o).edges[0].node.end_of_feed_demarcator;
  return { groups: d.group_set.groups, active: d.group_set.active_group_id, next: conn(o).page_info.has_next_page };
};

test('anchor: a refresh\'s second head load holding only [ad, marker] keeps the neutralised marker, never []', async () => {
  const pg = await open('https://www.instagram.com/', FEED);
  await parse(pg, page([friend('HOME001'), friend('HOME002'), friend('HOME003'), marker()], { cursor: 'end1' }));
  // Instagram's Home tab: two head loads; the one that lands last replaces the list.
  const a = await parse(pg, page([friend('HOME001'), adUnit('AD00001'), friend('HOME002'), friend('HOME003')], { cursor: 'hA' }));
  assert.deepEqual(keys(a), ['HOME001', 'HOME002', 'HOME003']);
  const b = await parse(pg, page([adUnit('AD00002'), marker()], { cursor: 'hB', source: 'feed_recs' }));
  assert.deepEqual(keys(b), ['end_of_feed_demarcator'], 'never an empty list');
  assert.deepEqual(neutral(b), { groups: [], active: null, next: false });
  const st = await feedState(pg);
  assert.equal(st.ended, true);
  assert.equal(st.endText.subtitle, '', 'Instagram draws its line: the card does not repeat it');
  // The marker alone, too.
  const c = await parse(pg, page([marker()], { cursor: 'hC', source: 'feed_recs' }));
  assert.deepEqual(keys(c), ['end_of_feed_demarcator']);
  assert.deepEqual(neutral(c), { groups: [], active: null, next: false });
});

test('anchor: a refresh before Home ended ([old posts] then [ad, marker]) never leaves Home empty', async () => {
  const pg = await open('https://www.instagram.com/', FEED);
  await parse(pg, page([friend('HOME001'), friend('HOME002')], { cursor: 'p1' }));
  await parse(pg, page([friend('HOME001'), adUnit('AD00001'), friend('HOME002')], { cursor: 'hA' }));
  const b = await parse(pg, page([adUnit('AD00002'), marker()], { cursor: 'hB', source: 'feed_recs' }));
  assert.deepEqual(keys(b), ['end_of_feed_demarcator']);
  assert.deepEqual(neutral(b), { groups: [], active: null, next: false });
  assert.equal((await feedStats(pg)).markerKept, 1);
});

test('anchor: a second head load with no marker right after a refresh reset ([ad, rec]) keeps a hidden suggestion', async () => {
  const pg = await open('https://www.instagram.com/', FEED);
  await parse(pg, page([friend('HOME001'), marker()], { cursor: 'end1' }));
  await parse(pg, page([friend('HOME001'), friend('HOME002')], { cursor: 'hA' }));
  const b = await parse(pg, page([adUnit('AD00002'), recs('REC0009')], { cursor: 'hB' }));
  assert.deepEqual(keys(b), ['explore:REC0009']);
  assert.equal((await feedStats(pg)).refreshes, 1);
});

test('anchor: two refreshes after the end, each with a [rec, rec, ad] head, both keep one hidden suggestion', async () => {
  const pg = await open('https://www.instagram.com/', FEED);
  await parse(pg, page([friend('HOME001'), friend('HOME002'), marker()], { cursor: 'end1' }));
  const a = await parse(pg, page([recs('REC0001'), recs('REC0002'), adUnit('AD00001')], { cursor: 'r1' }));
  const b = await parse(pg, page([recs('REC0005'), recs('REC0006'), adUnit('AD00002')], { cursor: 'r2' }));
  assert.deepEqual([keys(a), keys(b)], [['explore:REC0001'], ['explore:REC0005']]);
  // Both are hidden before they are drawn.
  const shown = await pg.evaluate(() => new Promise(done => {
    document.getElementById('feed').innerHTML = ['REC0001', 'REC0005'].map(c => '<article><a href="/p/' + c + '/">x</a></article>').join('');
    requestAnimationFrame(() => done(Array.from(document.querySelectorAll('article')).map(a => getComputedStyle(a).display)));
  }));
  assert.deepEqual(shown, ['none', 'none']);
  assert.equal((await feedStats(pg)).anchorAfterEnd, 2);
});

test('anchor: an appended suggestions page after the end does not use up the anchor of a later reload', async () => {
  const pg = await open('https://www.instagram.com/', FEED);
  await parse(pg, page([friend('HOME001'), marker()], { cursor: 'end1' }));
  // Instagram paging past has_next false: an appended page of suggestions.
  const appended = await parse(pg, page([recs('REC0001')], { cursor: 'x1', source: 'feed_recs' }));
  assert.deepEqual(keys(appended), ['explore:REC0001']);
  const reload = await parse(pg, page([recs('REC0002'), recs('REC0003'), adUnit('AD00001')], { cursor: 'h1' }));
  assert.notDeepEqual(keys(reload), []);
  assert.deepEqual(keys(reload), ['explore:REC0002']);
});

test('skip: a pacing nudge that fires after the skip was forgotten is not an error', async () => {
  const pg = await fromEndCard(['S000001', 'S000002', 'S000003', 'S000004', 'S000005']);
  await parse(pg, page([friend('S000001')]));               // the anchor
  await parse(pg, page([friend('S000002')]));               // seen only: a 400 ms pacing nudge
  const e0 = await pg.evaluate(() => window.__sg.stats.errors);
  // Instagram reloads its first page within those 400 ms: the skip ends, 4 posts show.
  await parse(pg, page([friend('S000002'), friend('NEW0001'), friend('NEW0002'), friend('NEW0003')]));
  await pg.waitForTimeout(700);
  const s = await pg.evaluate(() => ({ errors: window.__sg.stats.errors, forgot: window.__sg.stats.feed.skipForgotten }));
  assert.equal(s.forgot, 1);
  assert.equal(s.errors, e0, 'no error');
});

test('B17: nudges alone (no finger, no wheel) are counted as jiggles, never as swipes', async () => {
  const { pg } = await igEndCard({ params: { trustedOnly: true } });
  await reachedNew(pg, 12000);
  const tries = await pg.evaluate(() => window.__sg.stats.feed.tries);
  assert.equal(tries.swipe, undefined, JSON.stringify(tries));
  assert.ok(tries.jiggle && tries.jiggle.hit >= 1, JSON.stringify(tries));
});

test('B18: Home\'s hidden-suggestion anchor gets its scroll room and nudges back after a Story', async () => {
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body style="margin:0">
    <div style="height:60px">Stories</div><main id="main"></main><script>window.__igParams=${JSON.stringify({ mode: 'H2', mountMs: 1000, trustedOnly: true })};</script><script>${IGMOCK}</script></body></html>`;
  const api = {
    '/api/graphql': u => {
      const n = +u.searchParams.get('page');
      if (n === 0) return { body: page([recs('REC0001'), recs('REC0002'), adUnit('AD00001')], { cursor: 'h0' }) };
      return { body: page([friend('HOMENEW'), marker()], { cursor: 'h1', source: 'feed_recs' }) };
    },
    '/api/ayml': { data: { xdt_api__v1__ayml__strict: { users: [] } } },
  };
  const pg = await open('https://www.instagram.com/', html, { api });
  // Hold back the nudges until the Story is open (as if the list had not mounted yet).
  await pg.waitForFunction(() => !!document.getElementById('sg-skip-room'));
  await pg.evaluate(() => history.pushState({}, '', '/stories/someone/123/'));
  await pg.waitForTimeout(6000);
  assert.equal(await pg.evaluate(() => window.__ig.items.some(i => i.code === 'HOMENEW')), false, 'page 2 waits for Home');
  await pg.evaluate(() => history.back());
  await pg.waitForFunction(() => location.pathname === '/');
  await pg.waitForFunction(() => !!document.getElementById('sg-skip-room'), null, { timeout: 1000 });
  await pg.waitForFunction(() => window.__ig.items.some(i => i.code === 'HOMENEW'), null, { timeout: 3500 });
});

// Home drew posts in this session; then Following from the end card, whose
// list mounts `mountMs` after its first page.
async function lateMount(mountMs) {
  const seen = codesOf('S', 19);
  const list = seen.concat(codesOf('U', 80));
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body style="margin:0">
    <div style="height:60px">Feed</div><main id="main"></main><script>window.__igParams=Object.assign({ mode: 'H2' }, location.search.includes('following') ? { mountMs: ${mountMs} } : {});</script><script>${IGMOCK}</script></body></html>`;
  const api = {
    '/api/graphql': u => {
      const v = u.searchParams.get('variant'), n = +u.searchParams.get('page');
      if (v === 'home') return { body: igPage(seen.map(fedge), false, 'h0') };
      const start = n === 0 ? 0 : 3 + (n - 1) * 8, len = n === 0 ? 3 : 8;
      return { body: igPage(list.slice(start, start + len).map(fedge), true, v + n) };
    },
    '/api/ayml': { data: { xdt_api__v1__ayml__strict: { users: [] } } },
  };
  const pg = await open('https://www.instagram.com/', html, { api });
  await pg.waitForFunction(() => window.__ig && window.__ig.mountedAt > 0);
  await pg.waitForFunction(() => sessionStorage.getItem('sg_posts_drawn') !== null, null, { timeout: 4000 });
  await Promise.all([pg.waitForURL(/variant=/), pg.evaluate(() => window.__sg.onNative({ type: 'continueFeed', variant: 'following' }))]);
  return { pg, seen: new Set(seen) };
}
for (const ms of [5000, 6000]) {
  test(`recovery: Following from the end card whose list mounts ${ms / 1000} s after its first page is not reloaded`, async () => {
    const { pg, seen } = await lateMount(ms);
    await pg.waitForTimeout(ms + 3500);
    const s = await pg.evaluate(() => ({ docN: +sessionStorage.getItem('sg_doc_n'), recovered: window.__sg.stats.feed.recovered || 0,
      recover: sessionStorage.getItem('sg_feed_recover'), items: window.__ig.items.map(i => i.code), alreadySeen: window.__sg.stats.feed.alreadySeen || 0 }));
    assert.equal(s.recovered, 0, JSON.stringify(s));
    assert.equal(s.recover, null);
    assert.equal(s.docN, 2, 'Home, then the card\'s Following: no reload');
    assert.ok(s.alreadySeen > 0);
    assert.ok(s.items.filter(c => seen.has(c)).length <= 1, 'one repeat at most: ' + s.items.slice(0, 4));
  });
}

test('recovery: a reload of the page opened from the end card keeps its one-time skip', async () => {
  const pg = await open('https://www.instagram.com/', FEED);
  // Posts were drawn in this session.
  await pg.evaluate(() => { document.getElementById('feed').innerHTML = '<article>x</article>'; window.__sg.checkNotDrawn(); document.getElementById('feed').innerHTML = ''; });
  await parse(pg, page(['HOME001', 'HOME002', 'HOME003'].map(friend), { more: false }));
  await Promise.all([pg.waitForURL(/variant=following/), pg.evaluate(() => window.__sg.onNative({ type: 'continueFeed', variant: 'following' }))]);
  await pg.clock.install();
  await parse(pg, page([friend('HOME003'), friend('HOME002')], { source: 'following' }));
  // Kept, but nothing drawn for 10 s: one reload.
  const nav = pg.waitForNavigation({ timeout: 10000 });
  for (let i = 0; i < 8; i++) { await pg.clock.fastForward(1600); await pg.evaluate(() => window.__sg.checkNotDrawn()).catch(() => {}); }
  await nav;
  await pg.waitForFunction(() => !!window.__sg);
  assert.equal(await pg.evaluate(() => window.__sg.stats.feed.recovered), 1);
  const out = await parse(pg, page([friend('HOME003'), friend('HOME002'), friend('NEW0001')], { source: 'following' }));
  assert.deepEqual(keys(out), ['NEW0001'], 'still skipping Home\'s posts after the reload');
});
