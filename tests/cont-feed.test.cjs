// The Home feed tests whose expectations change when Home goes on into
// Following (R7, continueHome on), duplicated with the switch on. The
// originals (feed.test.cjs, page.test.cjs) keep the switch off and are
// unchanged. Pages here define Instagram's two compiled feed queries
// (window.require), which R7 needs before it starts; without them Home ends
// exactly as with the switch off (last test).
//
// Every request is answered locally (nothing reaches Instagram).
//
// Run: NODE_PATH=/opt/node-tools/node_modules node --test tests/*.test.cjs
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useBrowser, open, sent, user, media, edge, mixedFeed, codes } = require('./helpers.cjs');

useBrowser();
const ON = { continueHome: true };

let seq = 0;
function page(edges, { more = true, cursor = 'cur' + (seq++), source } = {}) {
  const conn = { edges, page_info: { has_next_page: more, end_cursor: cursor } };
  if (source !== undefined) conn.pagination_source = source;
  return { data: { xdt_api__v1__feed__timeline__connection: conn }, extensions: { is_final: true } };
}
const friend = c => edge({ media: media(c, user('f' + c, true)) });
const recs = c => edge({ explore_story: { media: media(c, user('r' + c)) } });
const SUBTITLE = "You've seen all new posts from the past 3 days.";
function marker() {
  return edge({ end_of_feed_demarcator: { id: 'eof', title: "You're all caught up", subtitle: SUBTITLE,
    group_set: { __typename: 'XDTGroupSet', id: 'gs', active_group_id: 'feed_recs', groups: [
      { id: 'feed_recs', title: 'Suggested Posts', pagination_source: 'feed_recs', next_max_id: 'r1',
        feed_items: [{ explore_story: { media: media('GRPREC1', user('x')) } }] }] } } });
}
const conn = out => out.data.xdt_api__v1__feed__timeline__connection;
const keys = out => conn(out).edges.map(e => {
  const n = e.node;
  return n.media ? n.media.code : n.explore_story ? 'explore:' + n.explore_story.media.code : Object.keys(n).filter(k => k !== '__typename')[0];
});

// Instagram's two compiled feed queries, as the page's own require gives them.
const MODULES = `<script>(function () {
  const pv = { __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: { get: () => false } };
  const q = (name, id) => ({ params: { id, name, metadata: { is_distillery: true, root_field_name: ['xdt_api__v1__feed__timeline__connection'] }, providedVariables: pv } });
  const M = { 'PolarisFeedTimelineRootV2Query.graphql': q('PolarisFeedTimelineRootV2Query', '28805668309050001'),
    'PolarisFeedRootPaginationCachedQuery_subscribe.graphql': q('PolarisFeedRootPaginationCachedQuery_subscribe', '28847928918174870'),
    LSD: { token: 'LSDTOKEN' }, DTSGInitialData: { token: 'DTSGTOKEN' } };
  window.require = n => { if (!(n in M)) throw new Error('unknown module ' + n); return M[n]; };
})();</script>`;
const FEED_HTML = '<!doctype html><html><head><meta name="viewport" content="width=device-width">' + MODULES +
  '</head><body style="margin:0"><main id="feed"></main></body></html>';
// SimpleGram's own Following reads: newest first, 3 then 12 a page.
const FOL = n => 'FOL' + String(n).padStart(4, '0');
function api() {
  let fol = 0;
  return { '/graphql/query': (u, req) => {
    const vars = JSON.parse(new URLSearchParams(req.postData() || '').get('variables') || '{}');
    if (vars.variant !== 'following') return { body: page([]) };
    const n = vars.after == null ? 3 : 12;
    const list = Array.from({ length: n }, () => friend(FOL(++fol)));
    return { body: page(list, { cursor: 'fol' + fol, source: 'following' }) };
  } };
}
// Following's posts in order from `from`, as many as a handover gave (one page at most).
function inOrder(list, from) {
  assert.ok(list.length >= 3 && list.length <= 12, 'one page at most: ' + list.length);
  assert.deepEqual(list, list.map((c, i) => FOL(from + i)));
}
function deliver(pg, payload) {
  return pg.evaluate(p => {
    const out = JSON.parse(JSON.stringify(p));
    for (const e of out.data.xdt_api__v1__feed__timeline__connection.edges) {
      const a = document.createElement('article');
      a.style.height = '650px';
      document.getElementById('feed').appendChild(a);
    }
    return out;
  }, payload);
}
const parse = (pg, payload) => pg.evaluate(p => JSON.parse(JSON.stringify(p)), payload);
const toBottom = pg => pg.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
const feedState = pg => pg.evaluate(() => window.__sg.feedState());
const feedStats = pg => pg.evaluate(() => window.__sg.stats.feed);
const contState = pg => pg.evaluate(() => window.__sg.cont());
const ownReads = pg => pg.evaluate(() => window.__sg.gqlLog.filter(e => /^PolarisFeed/.test(e.query)).length);

test('on: Home\'s marker and everything after it go, but paging stays on and Following is read (no card)', async () => {
  const pg = await open('https://www.instagram.com/', FEED_HTML, { cfg: ON, api: api() });
  const out = await deliver(pg, page([friend('FRIEND1'), friend('FRIEND2'), friend('FRIEND3'), marker(), recs('AFTER01'), friend('AFTER02')]));
  assert.deepEqual(keys(out), ['FRIEND1', 'FRIEND2', 'FRIEND3']);
  assert.equal(conn(out).page_info.has_next_page, true, 'paging stays on (decision 1)');
  const fs = await feedState(pg);
  assert.equal(fs.caughtUp, true);
  assert.equal(fs.ended, false);
  assert.equal(fs.cont, true);
  await pg.waitForFunction(() => window.__sg.cont().buffer > 0, null, { timeout: 4000 });
  assert.equal(await ownReads(pg), 1);
  await toBottom(pg);
  await pg.waitForTimeout(800);
  assert.equal((await sent(pg, 'feedEnd')).some(m => m.on), false, 'no card while Home goes on');
  // Instagram's next page: its suggestions give way to Following.
  const next = await deliver(pg, page([recs('REC0001'), recs('REC0002')], { source: 'feed_recs' }));
  inOrder(keys(next), 1);
  assert.equal(conn(next).page_info.has_next_page, true);
  assert.equal(conn(next).pagination_source, 'feed_recs', 'Instagram\'s own fields stay as sent');
});

test('on: a marker in a page without plain posts is cut to nothing and paging stays on (never Instagram\'s line mid-feed)', async () => {
  const pg = await open('https://www.instagram.com/', FEED_HTML, { cfg: ON, api: api() });
  await deliver(pg, page([friend('FRIEND1'), friend('FRIEND2')]));
  const out = await deliver(pg, page([recs('HSMARK1'), marker(), recs('AFTER01')]));
  assert.deepEqual(keys(out), []);
  assert.equal(conn(out).page_info.has_next_page, true);
  assert.equal((await feedStats(pg)).markerKept || 0, 0);
  assert.equal((await contState(pg)).stats.state, 'running');
});

test('on: the marker as the very first item stays (no groups) with paging on, so Home can go on (B18 anchor)', async () => {
  const pg = await open('https://www.instagram.com/', FEED_HTML, { cfg: ON, api: api() });
  const out = await deliver(pg, page([marker()]));
  assert.deepEqual(keys(out), ['end_of_feed_demarcator']);
  const gs = conn(out).edges[0].node.end_of_feed_demarcator.group_set;
  assert.deepEqual([gs.groups, gs.active_group_id], [[], null]);
  assert.equal(conn(out).page_info.has_next_page, true);
  assert.deepEqual((await feedStats(pg)).anchorKind, { seen: 0, marker: 1, recs: 0 });
  assert.equal((await contState(pg)).stats.anchors, 1);
});

test('on: an all-suggestions page (feed_recs) keeps only people you follow, and Home goes on into Following', async () => {
  const pg = await open('https://www.instagram.com/', FEED_HTML, { cfg: ON, api: api() });
  const out = await parse(pg, page([friend('FRIEND1'), recs('REC0001'), friend('FRIEND2')], { source: 'feed_recs' }));
  assert.deepEqual(keys(out), ['FRIEND1', 'FRIEND2']);
  assert.equal(conn(out).page_info.has_next_page, true);
  assert.equal((await feedStats(pg)).recsPages, 1);
  assert.equal((await contState(pg)).stats.state, 'running');
});

test('on: after the marker, a page bringing back a post Home showed is a refresh (starts over); a suggestions page is a next page', async () => {
  const pg = await open('https://www.instagram.com/', FEED_HTML, { cfg: ON, api: api() });
  await deliver(pg, page([friend('FRIEND1'), friend('FRIEND2'), marker(), recs('AFTER01')], { cursor: 'end1' }));
  await pg.waitForFunction(() => window.__sg.cont().buffer > 0, null, { timeout: 4000 });
  const next = await deliver(pg, page([recs('EOF0001'), recs('EOF0002')], { cursor: 'eofrecs', source: 'feed_recs' }));
  inOrder(keys(next), 1);
  // Pull to refresh: Home's first page again (FRIEND1 came back) with a new post.
  const fresh = await deliver(pg, page([friend('NEW0001'), friend('FRIEND1'), friend('NEW0002')], { cursor: 'fresh1' }));
  assert.deepEqual(keys(fresh), ['NEW0001', 'FRIEND1', 'NEW0002']);
  assert.equal(conn(fresh).page_info.has_next_page, true);
  const st = await contState(pg);
  assert.equal(st.stats.headWhy.seen, 1);
  assert.equal(st.stats.state, 'off', 'Home starts over; Following comes back at the next marker');
  assert.equal((await feedState(pg)).cont, false);
  assert.equal((await feedStats(pg)).refreshes, 1);
});

test('on: replaying the phone\'s pages, Home ends at the marker and its suggestions pages bring Following instead', async () => {
  const pg = await open('https://www.instagram.com/', FEED_HTML, { cfg: ON, api: api() });
  const kept = [], next = [];
  const phone = [
    page([friend('FRIEND1'), friend('FRIEND2')]),
    page([recs('SPORTS1'), recs('X1')]),
    page([recs('HSMARK1'), marker()]),
    page([recs('R1'), recs('R2'), recs('R3')], { source: 'feed_recs' }),
    page([recs('R4'), recs('R5')], { source: 'feed_recs' }),
  ];
  for (const p of phone) {
    const out = await deliver(pg, p);
    kept.push(keys(out));
    next.push(conn(out).page_info.has_next_page);
    await pg.waitForTimeout(400);    // Following is read meanwhile
  }
  assert.deepEqual(kept.slice(0, 3), [['FRIEND1', 'FRIEND2'], [], []]);
  inOrder(kept[3], 1);
  inOrder(kept[4], 1 + kept[3].length);
  assert.deepEqual(next, [true, true, true, true, true]);
  const f = await feedStats(pg);
  assert.equal(f.eof, 1);
  assert.equal(f.unknownPages, 0);
  assert.equal((await feedState(pg)).ended, false);
});

test('on: JSON.parse keeps friends and removes ads, suggestions and reposts; paging stays on at the marker', async () => {
  const pg = await open('https://www.instagram.com/', FEED_HTML, { cfg: ON, api: api() });
  const out = await pg.evaluate(p => JSON.parse(JSON.stringify(p)), mixedFeed());
  assert.deepEqual(codes(out), ['FRIEND1', 'MINE001', 'NOINFO1', 'COLLAB1', 'FRIEND2']);
  assert.equal(out.data.xdt_api__v1__feed__timeline__connection.page_info.has_next_page, true);
  const stats = await pg.evaluate(() => window.__sg.stats.feed);
  assert.equal(stats.eof, 1);
  assert.equal(stats.ad, 1);
});

test('on, without Instagram\'s query modules: Home ends at the marker exactly as with the switch off', async () => {
  const pg = await open('https://www.instagram.com/', '<!doctype html><html><body><main id="feed"></main></body></html>', { cfg: ON, api: api() });
  const out = await deliver(pg, page([friend('FRIEND1'), friend('FRIEND2'), marker(), recs('AFTER01')]));
  assert.deepEqual(keys(out), ['FRIEND1', 'FRIEND2']);
  assert.equal(conn(out).page_info.has_next_page, false);
  const fs = await feedState(pg);
  assert.equal(fs.ended, true);
  assert.equal(fs.cont, false);
  const st = await contState(pg);
  assert.deepEqual([st.stats.state, st.stats.reason], ['failed', 'modules']);
  await toBottom(pg);
  await pg.waitForFunction(() => { const m = window.__sent.filter(x => x.action === 'feedEnd'); return m.length && m[m.length - 1].on; }, null, { timeout: 4000 });
  const m = (await sent(pg, 'feedEnd')).pop();
  assert.equal(m.cont, 'failed');
  assert.equal(await ownReads(pg), 0);
});
