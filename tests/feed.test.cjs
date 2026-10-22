// Browser tests for Home's feed: the data layer (B8), the end-of-Home card
// (B11), and the on-screen backup filter, Stories checks and nudges (B9, B10).
//
// Every request is answered locally (nothing reaches Instagram). Payloads are
// modelled on the shapes Instagram's website uses (XDTFeedItem units, the
// end_of_feed_demarcator with its group_set); they are fixtures, not captures
// of a signed-in session, so passing here does not prove live behaviour.
//
// Run: NODE_PATH=/opt/node-tools/node_modules node --test tests/*.test.cjs
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useBrowser, open, sent, BLANK, user, media, edge, timeline, mixedFeed, article } = require('./helpers.cjs');

useBrowser();

/* ---------------- Fixtures ---------------- */

let seq = 0;
// A Home page: Instagram's timeline connection.
function page(edges, { more = true, cursor = 'cur' + (seq++), source } = {}) {
  const conn = { edges, page_info: { has_next_page: more, end_cursor: cursor } };
  if (source !== undefined) conn.pagination_source = source;
  return { data: { xdt_api__v1__feed__timeline__connection: conn }, extensions: { is_final: true } };
}
const friend = c => edge({ media: media(c, user('f' + c, true)) });
const stranger = c => edge({ media: media(c, user('s' + c, false)) });
const noInfo = c => edge({ media: media(c, user('n' + c)) });
const recs = c => edge({ explore_story: { media: media(c, user('r' + c)) } });
const adUnit = c => edge({ ad: { ad_id: '1' }, media: media(c, user('brand'), { ad_id: '1' }) });
// Instagram's "You're all caught up" (XDTEndOfFeedDemarcator); its groups carry the first suggestions.
const SUBTITLE = "You've seen all new posts from the past 3 days.";
function marker(groups) {
  return edge({ end_of_feed_demarcator: { id: 'eof', title: "You're all caught up", subtitle: SUBTITLE,
    group_set: { __typename: 'XDTGroupSet', id: 'gs', active_group_id: 'feed_recs', groups: groups || [
      { id: 'feed_recs', title: 'Suggested Posts', pagination_source: 'feed_recs', next_max_id: 'r1',
        feed_items: [{ explore_story: { media: media('GRPREC1', user('fanaticssports')) } }] },
      { id: 'past_posts', title: 'Older posts', pagination_source: 'past_posts', next_max_id: 'p1',
        feed_items: [{ media: media('OLDPOST', user('old', true)) }] }] } } });
}
const conn = out => out.data.xdt_api__v1__feed__timeline__connection;
const keys = out => conn(out).edges.map(e => {
  const n = e.node;
  return n.media ? n.media.code : n.explore_story ? 'explore:' + n.explore_story.media.code : Object.keys(n).filter(k => k !== '__typename')[0];
});

// A Home page that grows as Instagram draws each post it keeps (650px each).
const FEED_HTML = '<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body style="margin:0"><main id="feed"></main></body></html>';
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
const feedEnds = pg => sent(pg, 'feedEnd');
const lastEnd = async pg => { const m = await feedEnds(pg); return m.length ? m[m.length - 1] : null; };
const everOn = async pg => (await feedEnds(pg)).some(m => m.on);
const waitOn = (pg, on = true) => pg.waitForFunction(o => {
  const m = window.__sent.filter(x => x.action === 'feedEnd');
  return m.length && m[m.length - 1].on === o;
}, on, { timeout: 4000 });
const feedState = pg => pg.evaluate(() => window.__sg.feedState());
const feedStats = pg => pg.evaluate(() => window.__sg.stats.feed);

// Instagram's timers run on a fake clock, so 15 s waits take no time. (The
// script's own 1.5 s interval starts before the clock does; a scroll event
// runs the same end-of-Home check at the current fake time.)
async function openClocked(url, html) {
  const pg = await open(url, html);
  await pg.clock.install();
  await pg.reload();
  return pg;
}
async function check(pg) {
  await pg.evaluate(() => window.dispatchEvent(new Event('scroll')));
  await pg.clock.runFor(300);
}

/* ---------------- 1. Feed data layer (B8) ---------------- */

test('feed: a page of only suggestion units is filtered, not left alone as an unknown format', async () => {
  const pg = await open('https://www.instagram.com/', BLANK);
  await parse(pg, page([friend('FRIEND1')]));
  const out = await parse(pg, page([recs('SPORTS1'), adUnit('ADPOST1'), recs('OTHER01')]));
  assert.deepEqual(keys(out), []);
  assert.equal(conn(out).page_info.has_next_page, true, 'an empty page is not the end by itself');
  const f = await feedStats(pg);
  assert.equal(f.unknownPages, 0);
  assert.equal(f.suggested, 2);
  assert.equal(f.ad, 1);
});

test('feed: Home ends at "You\'re all caught up": the marker, its groups and everything after it go', async () => {
  const pg = await open('https://www.instagram.com/', FEED_HTML);
  const out = await deliver(pg, page([friend('FRIEND1'), friend('FRIEND2'), friend('FRIEND3'), marker(), recs('AFTER01'), friend('AFTER02')]));
  assert.deepEqual(keys(out), ['FRIEND1', 'FRIEND2', 'FRIEND3']);
  assert.equal(conn(out).page_info.has_next_page, false);
  const f = await feedStats(pg);
  assert.equal(f.pages, 1, 'the marker\'s groups are not pages');
  assert.equal(f.eof, 1);
  assert.equal(f.afterEnd, 2);
  assert.equal(f.inMarker, 2);
  const fs = await feedState(pg);
  assert.equal(fs.ended, true);
  assert.equal(fs.caughtUp, true);
  await pg.waitForTimeout(400);
  assert.equal(await everOn(pg), false, 'not yet: the end is not on screen');
  await toBottom(pg);
  await waitOn(pg);
  const m = await lastEnd(pg);
  assert.equal(m.caughtUp, true);
  assert.equal(m.stalled, false);
  assert.equal(m.subtitle, SUBTITLE);
  assert.equal(m.title, "You're all caught up");
  // Room below the last post, so the card never covers it.
  assert.equal(await pg.evaluate(() => document.getElementById('sg-end-room').getBoundingClientRect().height), 170);
});

test('feed: a marker in a page without plain posts still ends Home', async () => {
  const pg = await open('https://www.instagram.com/', FEED_HTML);
  await deliver(pg, page([friend('FRIEND1'), friend('FRIEND2')]));
  const out = await deliver(pg, page([recs('HSMARK1'), marker(), recs('AFTER01')]));
  assert.deepEqual(keys(out), [], 'the suggestion before the marker is removed too');
  assert.equal(conn(out).page_info.has_next_page, false);
  assert.equal((await feedStats(pg)).unknownPages, 0);
  await toBottom(pg);
  await waitOn(pg);
});

test('feed: the marker as the very first item ends Home and the card shows', async () => {
  const pg = await open('https://www.instagram.com/', FEED_HTML);
  const out = await deliver(pg, page([marker()]));
  assert.deepEqual(keys(out), []);
  assert.equal(conn(out).page_info.has_next_page, false);
  await waitOn(pg);
  assert.equal((await lastEnd(pg)).subtitle, SUBTITLE);
});

test('feed: the suggested accounts Instagram shows on an empty Home are emptied', async () => {
  const pg = await open('https://www.instagram.com/', BLANK);
  const out = await parse(pg, { data: { xdt_api__v1__ayml__strict: {
    groups: [{ id: 'ayml', title: 'Suggested for you', users: [user('stranger1'), user('stranger2')] }], more_available: true } } });
  assert.equal(out.data.xdt_api__v1__ayml__strict.groups.length, 0);
  assert.equal(out.data.xdt_api__v1__ayml__strict.more_available, false);
});

test('feed: an all-suggestions page (pagination_source feed_recs) keeps only people you follow, then stops', async () => {
  const pg = await open('https://www.instagram.com/', BLANK);
  const out = await parse(pg, page([friend('FRIEND1'), recs('REC0001'), stranger('STRANG1'), friend('FRIEND2'), adUnit('ADPOST1'), noInfo('NOINFO1')], { source: 'feed_recs' }));
  assert.deepEqual(keys(out), ['FRIEND1', 'FRIEND2']);
  assert.equal(conn(out).page_info.has_next_page, false);
  const f = await feedStats(pg);
  assert.equal(f.recsPages, 1);
  assert.equal(f.afterEnd, 4);
  assert.equal((await feedState(pg)).ended, true);
});

test('feed: Following keeps Instagram\'s marker; its groups keep only followed posts and never end the feed', async () => {
  const pg = await open('https://www.instagram.com/?variant=following', FEED_HTML);
  const out = await deliver(pg, page([friend('FRIEND1'), marker([{ id: 'feed_recs', title: 'Suggested Posts', pagination_source: 'feed_recs', next_max_id: 'r1', feed_items: [
    { media: media('STRANGE', user('x', false)) }, { ad: { ad_id: '9' }, media: media('ADGRP01', user('brand'), { ad_id: '9' }) },
    { media: media('FRNDGRP', user('y', true)) }, { explore_story: { media: media('GRPREC1', user('z', true)) } }] }])]));
  assert.deepEqual(keys(out), ['FRIEND1', 'end_of_feed_demarcator']);
  assert.equal(conn(out).page_info.has_next_page, true);
  const group = conn(out).edges[1].node.end_of_feed_demarcator.group_set.groups[0];
  assert.deepEqual(group.feed_items.map(i => i.media.code), ['FRNDGRP']);
  const f = await feedStats(pg);
  assert.equal(f.pages, 1);
  assert.equal(f.inMarker, 3);
  assert.equal((await feedState(pg)).ended, false);
  await toBottom(pg);
  await pg.waitForTimeout(800);
  assert.equal(await everOn(pg), false, 'the card is for Home only');
});

test('feed: Instagram\'s Older posts feed (variant past_posts) is not cut at its marker', async () => {
  const pg = await open('https://www.instagram.com/?variant=past_posts', BLANK);
  const out = await parse(pg, page([friend('OLDPOS1'), stranger('STRANG1'), marker([])]));
  assert.deepEqual(keys(out), ['OLDPOS1', 'end_of_feed_demarcator']);
  assert.equal(conn(out).page_info.has_next_page, true);
});

test('feed: only lists with real paging fields can end a feed', async () => {
  const pg = await open('https://www.instagram.com/', BLANK);
  const out = await parse(pg, { feed_items: [{ media_or_ad: media('FRIEND1', user('a', true)) }, { media_or_ad: media('SUGG001', user('b', false)) }], status: 'ok' });
  assert.deepEqual(out.feed_items.map(i => i.media_or_ad.code), ['FRIEND1']);
  assert.equal((await feedState(pg)).ended, false);
  await parse(pg, { feed_items: [{ media_or_ad: media('FRIEND2', user('a', true)) }], more_available: false, next_max_id: null, status: 'ok' });
  assert.equal((await feedState(pg)).ended, true);
});

test('feed: after the end, a refresh starts over and anything else stays out', async () => {
  const pg = await open('https://www.instagram.com/', FEED_HTML);
  const end = page([friend('FRIEND1'), friend('FRIEND2'), marker(), recs('AFTER01')], { cursor: 'end1' });
  await deliver(pg, end);
  await toBottom(pg);
  await waitOn(pg);
  // The same end page read again is still the end.
  const again = await parse(pg, end);
  assert.deepEqual(keys(again), ['FRIEND1', 'FRIEND2']);
  assert.equal(conn(again).page_info.has_next_page, false);
  // Instagram loads more after the end, with nobody you follow: never shown,
  // and never left alone as an unknown format.
  const extra = await deliver(pg, page([recs('EOF0001'), stranger('EOF0002'), noInfo('EOF0003'), edge({ post_v2: { code: 'EOF0004' } })], { cursor: 'eofrecs' }));
  assert.deepEqual(keys(extra), []);
  assert.equal(conn(extra).page_info.has_next_page, false);
  const noCursor = await parse(pg, page([noInfo('EOF0005'), edge({ post_v2: { code: 'EOF0006' } })], { cursor: null }));
  assert.deepEqual(keys(noCursor), [], 'a page without a cursor is not let through either');
  assert.equal((await feedState(pg)).ended, true);
  assert.equal((await lastEnd(pg)).on, true, 'the card stays');
  // Pull to refresh: a first page with a new cursor and your friends' posts.
  await pg.evaluate(() => { document.getElementById('feed').textContent = ''; window.scrollTo(0, 0); });
  const fresh = await deliver(pg, page([friend('NEW0001'), friend('NEW0002'), friend('NEW0003')], { cursor: 'fresh1' }));
  assert.deepEqual(keys(fresh), ['NEW0001', 'NEW0002', 'NEW0003']);
  assert.equal(conn(fresh).page_info.has_next_page, true);
  assert.equal((await feedState(pg)).ended, false);
  assert.equal((await feedStats(pg)).refreshes, 1);
  await waitOn(pg, false);
  await toBottom(pg);
  await pg.waitForTimeout(1200);
  assert.equal((await lastEnd(pg)).on, false, 'no early card on the new feed');
  assert.equal(await pg.evaluate(() => !!document.getElementById('sg-end-room')), false);
});

test('feed: Instagram\'s own "Suggested for you" rules (mixed_unconnected, a label title) are applied', async () => {
  const pg = await open('https://www.instagram.com/', BLANK);
  const out = await parse(pg, page([
    edge({ media: media('UNCONN1', user('x'), { inventory_source: 'mixed_unconnected' }) }),
    edge({ media: media('TITLED1', user('y'), { explore: { title: 'Suggested for you' } }) }),
    edge({ media: media('FRNDTTL', user('z', true), { explore: { title: 'Suggested for you' } }) }),
    noInfo('NOINFO1'),
  ]));
  assert.deepEqual(keys(out), ['FRNDTTL', 'NOINFO1']);
  const f = await feedStats(pg);
  assert.equal(f.suggested, 1);
  assert.equal(f.exploreTitle, 1, 'counted on its own');
  assert.equal(f.followUnknown, 1, 'NOINFO1 is kept, and counted as unknown');
});

// The phone's 1.1 Filter status read "Posts shown 2, Suggested removed 0,
// Pages read 8 (7 unrecognised)". These are the Relay-shaped pages that
// reproduced it exactly (notes/batch-3/prototypes/tests/unknown-pages-replay.cjs).
const UNIT_KEYS = ['media', 'ad', 'explore_story', 'end_of_feed_demarcator', 'stories_netego', 'suggested_users', 'bloks_netego', 'abra_icebreakers_in_feed_unit', 'ad4ad_in_webfeed'];
let rpk = 70000;
function rUser(name, following) {
  const u = { pk: String(rpk++), id: String(rpk), username: name, __typename: 'XDTUserDict' };
  u.friendship_status = following === undefined ? null : { following, is_feed_favorite: false };
  return u;
}
function rMedia(code, u, extra = {}) {
  return Object.assign({ id: (rpk++) + '_' + u.pk, pk: String(rpk), code, inventory_source: null, explore: null, user: u, coauthor_producers: [], social_context: [],
    image_versions2: { candidates: [{ url: 'https://scontent.cdninstagram.com/v/t51/' + code + '_big_n.jpg', width: 1080, height: 1350 }] } }, extra);
}
function rNode(fields) { const n = { __typename: 'XDTFeedItem' }; for (const k of UNIT_KEYS) n[k] = null; return { node: Object.assign(n, fields), cursor: 'c' + (rpk++) }; }
const rFriend = c => rNode({ media: rMedia(c, rUser('friend_' + c, true)) });
const rExplore = (c, name) => rNode({ explore_story: { id: 'es' + c, inventory_source: 'explore_recs', media: rMedia(c, rUser(name, false), { inventory_source: 'explore_recs' }) } });
const rAd = c => rNode({ ad: { ad_id: '777' + c, id: 'ad' + c, items: [rMedia(c, rUser('brand', false))] } });
const rEof = items => rNode({ end_of_feed_demarcator: { id: 'eof', title: "You're all caught up", subtitle: SUBTITLE,
  group_set: { __typename: 'XDTGroupSet', id: 'gs', active_group_id: 'recs', connected_group_id: null,
    groups: [{ id: 'recs', title: 'Suggested Posts', pagination_source: 'feed_recs', next_max_id: 'n', feed_items: items }] } } });
const rPage = (edges, src = null) => ({ data: { xdt_api__v1__feed__timeline__connection: { pagination_source: src, edges, page_info: { has_next_page: true, end_cursor: 'x' + (rpk++) } } }, extensions: { is_final: true } });
const PHONE_PAGES = [
  rPage([rFriend('FRIEND1'), rFriend('FRIEND2')]),
  rPage([rExplore('SPORTS1', 'sportsonprime'), rAd('A1'), rExplore('X1', 'someone')]),
  rPage([rExplore('HSMARK1', 'hsmarken'), rEof([rExplore('FANAT1', 'fanaticssports').node, rExplore('NBA1', 'nba').node])]),
  rPage([rExplore('R1', 'a'), rExplore('R2', 'b'), rAd('A2'), rExplore('R3', 'c')], 'feed_recs'),
  rPage([rExplore('R4', 'd'), rExplore('R5', 'e')], 'feed_recs'),
  rPage([rExplore('R6', 'f'), rAd('A3'), rExplore('R7', 'g')], 'feed_recs'),
  rPage([rExplore('R8', 'h'), rExplore('R9', 'i')], 'feed_recs'),
];

test('feed: replaying the phone\'s pages, suggestions are removed and Home ends at the marker', async () => {
  const pg = await open('https://www.instagram.com/', FEED_HTML);
  const kept = [], next = [];
  for (const p of PHONE_PAGES) {
    const out = await deliver(pg, p);
    kept.push(conn(out).edges.map(e => e.node.media ? e.node.media.code : Object.keys(e.node).filter(k => e.node[k] && k !== '__typename')[0]));
    next.push(conn(out).page_info.has_next_page);
  }
  assert.deepEqual(kept, [['FRIEND1', 'FRIEND2'], [], [], [], [], [], []]);
  assert.deepEqual(next, [true, true, false, false, false, false, false]);
  const f = await feedStats(pg);
  // 1.1 read: Posts shown 2, Suggested removed 0, Pages read 8 (7 unrecognised).
  assert.equal(f.kept, 2);
  assert.equal(f.unknownPages, 0, 'no page is "unrecognised"');
  assert.equal(f.pages, 7, 'the marker\'s group is not a page');
  assert.equal(f.streamed, 0);
  assert.equal(f.suggested + f.notFollowed, 3, 'Suggested removed');
  assert.equal(f.ad, 1);
  assert.equal(f.eof, 1);
  assert.equal(f.inMarker, 2);
  assert.equal(f.afterEnd, 11, 'the 4 later pages');
  const fs = await feedState(pg);
  assert.equal(fs.ended, true);
  assert.equal(fs.caughtUp, true);
  await toBottom(pg);
  await waitOn(pg);
});

test('status: the feed details are shapes only (no names, codes, captions or URLs)', async () => {
  const pg = await open('https://www.instagram.com/', FEED_HTML);
  for (const p of PHONE_PAGES.slice(0, 3)) await deliver(pg, p);
  await pg.evaluate(p => JSON.parse(JSON.stringify(p)), mixedFeed());
  await pg.waitForTimeout(1700); // one Home sample
  await pg.evaluate(() => window.__sg.onNative({ type: 'status' }));
  const [st] = await sent(pg, 'status');
  const ring = st.stats.feedUnits;
  assert.ok(ring.length > 10 && ring.length <= 40, String(ring.length));
  assert.deepEqual(Object.keys(ring[0]).sort(), ['f', 'fin', 'i', 'inv', 'k', 'nx', 'pg', 'ps', 'pt', 'sc', 'v', 'via']);
  assert.deepEqual(ring.slice(0, 2).map(u => [u.pg, u.i, u.k, u.v, u.f, u.via, u.fin]), [[1, 0, 'm', 'kept', 1, 'parse', true], [1, 1, 'm', 'kept', 1, 'parse', true]]);
  const eof = ring.find(u => u.k === 'e');
  assert.equal(eof.v, 'end');
  assert.ok(ring.some(u => u.k === 'x' && u.v === 'suggested' && u.inv === 'explore_recs' && u.f === 0));
  assert.ok(ring.some(u => u.k === 'a' && u.v === 'ad'));
  assert.ok(ring.some(u => u.v === 'repost' && u.sc[0] === 'text'), 'a text social context is recorded only as "text"');
  assert.deepEqual(st.stats.ghostOwl, { env: [], hooked: true });
  for (const k of ['eof', 'afterEnd', 'inMarker', 'followUnknown', 'peakPosts', 'peakVideos']) assert.equal(typeof st.stats.feed[k], 'number', k);
  const json = JSON.stringify(st);
  for (const bad of ['FRIEND1', 'HSMARK1', 'SPORTS1', 'ADPOST1', 'NOINFO1', 'hsmarken', 'sportsonprime', 'fanaticssports', 'nofollowinfo', 'friend5',
    'scontent', 'http', 'caught up', 'Suggested for you', 'reposted', 'Sponsored']) {
    assert.ok(!json.includes(bad), 'status must not contain ' + bad);
  }
});

/* ---------------- 2. End-of-Home card (B11) ---------------- */

test('feed end: no card while Instagram is still loading, even with pages that add nothing (R1)', async () => {
  const pg = await openClocked('https://www.instagram.com/', FEED_HTML);
  await deliver(pg, page([friend('FRIEND1'), friend('FRIEND2'), friend('FRIEND3')]));
  await toBottom(pg);
  await pg.clock.runFor(1000);
  // Pages keep arriving every 1.3 s while you wait at the bottom, but bring nothing.
  for (let i = 0; i < 3; i++) {
    await pg.clock.runFor(1300);
    await deliver(pg, page([adUnit('ADX000' + i), stranger('STRAN0' + i)]));
    await toBottom(pg);
  }
  await pg.clock.runFor(2500);
  await check(pg);
  assert.equal(await everOn(pg), false, '1.1 showed the card here, after 4 s at the bottom');
  await deliver(pg, page([friend('FRIEND4')]));
  await toBottom(pg);
  await pg.clock.runFor(2000);
  await check(pg);
  assert.equal(await everOn(pg), false);
});

test('feed end: when nothing arrives for 15 s at the bottom, the card says Home isn\'t loading more (R3, R10)', async () => {
  const pg = await openClocked('https://www.instagram.com/', FEED_HTML);
  await deliver(pg, page([friend('FRIEND1'), friend('FRIEND2')]));
  await toBottom(pg);
  // Empty pages every 5 s: Instagram is still answering, so no card.
  for (let i = 0; i < 3; i++) {
    await pg.clock.runFor(5000);
    await deliver(pg, page([adUnit('ADZ000' + i)]));
    await toBottom(pg);
  }
  await check(pg);
  assert.equal(await everOn(pg), false);
  // Then nothing at all.
  await pg.clock.runFor(16000);
  await check(pg);
  const m = await lastEnd(pg);
  assert.equal(m.on, true);
  assert.equal(m.stalled, true);
  assert.equal(m.caughtUp, false);
  assert.equal(await pg.evaluate(() => !!document.getElementById('sg-end-room')), true, 'room under the last post');
  // A page arriving takes it away again.
  await deliver(pg, page([friend('LATE001')]));
  await pg.clock.runFor(400);
  assert.equal((await lastEnd(pg)).on, false);
});

test('feed end: the card comes back after watching Stories or opening a post (R2)', async () => {
  const pg = await open('https://www.instagram.com/', FEED_HTML);
  await deliver(pg, page([friend('FRIEND1'), friend('FRIEND2'), marker()]));
  await toBottom(pg);
  await waitOn(pg);
  for (const away of ['/stories/friend/123/', '/p/ABCDEF1/']) {
    await pg.evaluate(p => { history.pushState(null, '', p); dispatchEvent(new PopStateEvent('popstate')); }, away);
    await waitOn(pg, false);
    assert.equal(await pg.evaluate(() => !!document.getElementById('sg-end-room')), false, 'no blank room under ' + away);
    await pg.evaluate(() => history.back());
    await pg.waitForURL('https://www.instagram.com/');
    await toBottom(pg);
    await waitOn(pg);
  }
  assert.equal((await feedState(pg)).homePages, 1, 'Home\'s state was kept');
});

test('feed end: once shown, the card stays until you scroll well away (no flicker)', async () => {
  const pg = await open('https://www.instagram.com/', FEED_HTML);
  await deliver(pg, page([friend('FRIEND1'), friend('FRIEND2'), friend('FRIEND3'), friend('FRIEND4'), marker()]));
  await toBottom(pg);
  await waitOn(pg);
  await pg.evaluate(() => window.scrollBy(0, -650)); // more than the distance that shows it, less than a screen
  await pg.waitForTimeout(700);
  assert.equal((await lastEnd(pg)).on, true);
  await pg.evaluate(() => window.scrollTo(0, 0));
  await waitOn(pg, false);
});

/* ---------------- 3. Backup filter, Stories checks, nudges (B9, B10) ---------------- */

test('backup filter: a labelled post Instagram adds to Home is hidden before it is drawn, and its video paused', async () => {
  const pg = await open('https://www.instagram.com/', FEED_HTML);
  const r = await pg.evaluate(html => new Promise(done => {
    const box = document.createElement('div');
    box.innerHTML = html;
    const v = box.querySelector('video');
    Object.defineProperty(v, 'paused', { configurable: true, get() { return !!this.__p; } });
    v.__p = false;
    v.pause = function () { this.__p = true; };
    document.getElementById('feed').appendChild(box);
    // The first frame after Instagram adds it: it must already be hidden.
    requestAnimationFrame(() => {
      const a = box.querySelector('article');
      done({ hidden: a.dataset.sgHidden || '', display: getComputedStyle(a).display, paused: v.paused });
    });
  }), article('SUGG001', 'Suggested for you', { video: '/clip.mp4' }));
  assert.deepEqual(r, { hidden: 'suggested', display: 'none', paused: true });
});

test('backup filter: a label Instagram draws a moment after the post is still caught', async () => {
  const pg = await open('https://www.instagram.com/', FEED_HTML);
  const first = await pg.evaluate(async html => {
    document.getElementById('feed').insertAdjacentHTML('beforeend', html);
    await Promise.resolve(); // the first look happens here, before the label exists
    const seen = document.getElementById('a-SUGG001').dataset.sgHidden || '';
    const d = document.createElement('div');
    d.innerHTML = '<span>Suggested for you</span>';
    document.querySelector('#a-SUGG001 header').appendChild(d);
    return seen;
  }, article('SUGG001', ''));
  assert.equal(first, '');
  await pg.waitForFunction(() => document.getElementById('a-SUGG001').dataset.sgHidden === 'suggested');
});

test('backup filter: four hidden suggestions in a row at the end of Home end it', async () => {
  const pg = await open('https://www.instagram.com/', FEED_HTML);
  // Posts the data layer can't judge (no follow info) that Instagram labels on screen.
  await deliver(pg, page([friend('FRIEND1'), friend('FRIEND2'), noInfo('SUGG001'), noInfo('SUGG002'), noInfo('ADPOST1'), noInfo('SUGG003')], { cursor: 'c1' }));
  const add = list => pg.evaluate(html => document.getElementById('feed').insertAdjacentHTML('beforeend', html), list.join(''));
  await add([article('SUGG001', 'Suggested for you'), article('SUGG002', 'Suggested for you'), article('ADPOST1', 'Sponsored')]);
  await pg.waitForTimeout(100);
  assert.equal((await feedState(pg)).ended, false, 'three are not enough');
  await add([article('SUGG003', 'Suggested for you')]);
  await pg.waitForTimeout(100);
  assert.equal((await feedState(pg)).ended, true);
  const f = await feedStats(pg);
  assert.equal(f.domStop, 1);
  assert.equal(f.hiddenRun, 4);
  await toBottom(pg);
  await waitOn(pg);
  // Instagram asks for more: nobody you follow there, so it is not shown and paging stops.
  const out = await deliver(pg, page([noInfo('SUGG004'), noInfo('SUGG005'), recs('REC0001')], { cursor: 'c2' }));
  assert.deepEqual(keys(out), []);
  assert.equal(conn(out).page_info.has_next_page, false);
});

test('backup filter: a hidden run that is not the end of what Home loaded does not end it', async () => {
  const pg = await open('https://www.instagram.com/', FEED_HTML);
  // Four labelled posts, then friends Instagram has loaded but not drawn yet.
  await deliver(pg, page([friend('FRIEND1'), noInfo('SUGG001'), noInfo('SUGG002'), noInfo('SUGG003'), noInfo('SUGG004'),
    friend('FRIEND2'), friend('FRIEND3')], { cursor: 'c1' }));
  await pg.evaluate(html => document.getElementById('feed').insertAdjacentHTML('beforeend', html),
    [article('SUGG001', 'Suggested for you'), article('SUGG002', 'Suggested for you'), article('SUGG003', 'Suggested for you'), article('SUGG004', 'Suggested for you')].join(''));
  await pg.waitForTimeout(150);
  assert.equal((await feedState(pg)).ended, false);
  assert.equal((await feedStats(pg)).domStop || 0, 0);
});

// Instagram's Home list keeps only a window of posts mounted, reserves room for
// posts it hasn't drawn yet, and asks for the next page when the end comes near
// (a port of PolarisIGVirtualList/PolarisSizeCache/PolarisBatchDOM). 1.1 hid
// labelled posts ~300 ms after they were drawn: they flashed, left black space,
// and Instagram kept paging through them (23 pages in 25 s).
const VLIST = `
window.__mkArticle = function (i, o) {
  const code = o.code || 'C' + String(i).padStart(9, '0');
  const label = o.label ? '<div><span>' + o.label + '</span></div>' : '';
  const m = o.video ? '<video playsinline preload="none" style="display:block;width:100%;height:700px"></video>'
    : '<img sizes="412px" style="display:block;width:100%;height:515px" src="/blank.png">';
  return '<article><div class="hdr" style="height:56px"><a href="/u' + i + '/">user' + i + '</a>' + label + '<div role="button">Follow</div></div>' + m +
    '<section><div role="button"><svg aria-label="Like"></svg></div></section><span>Caption ' + i + '</span><a href="/p/' + code + '/"><time>1d</time></a></article>';
};
(function () {
  const mq = [], uq = []; let sch = false;
  function flush() { sch = false; while (mq.length || uq.length) { while (uq.length) uq.shift()(); while (mq.length) mq.shift()(); } }
  const B = { measure(f) { mq.push(f); if (!sch) { sch = true; requestAnimationFrame(flush); } } };
  const size = new Map(), EST = 900;
  const get = i => size.has(i) ? size.get(i) : EST;
  const dist = (a, b) => { let e = 0; for (let r = a; r < b; r++) e += get(r); return e; };
  const index = (t, n) => { let e = 0; for (let r = 0; r < n; r++) { e += get(r); if (e > t) return r; } return n; };
  const last = (t, n) => { let e = 0; for (let r = 0; r < n; r++) { e += get(r); if (e > t) { if (r + 1 < n && get(r + 1) === 0) continue; return r; } } return n; };
  const zeros = (a, b) => { let e = 0; for (let r = a; r < b; r++) if (get(r) === 0) e++; return e; };
  const V = window.__vl = { items: [], hasNext: true, loading: false, cursor: 0, requests: 0, st: { rs: 0, re: 0 }, els: new Map() };
  let outer, inner;
  function render() {
    const st = V.st, n = V.items.length, end = Math.min(st.re, n);
    inner.style.paddingTop = dist(0, st.rs) + 'px';
    inner.style.paddingBottom = dist(st.re, n) + 'px';
    const want = [];
    for (let i = st.rs; i < end; i++) {
      let el = V.els.get(i);
      if (!el) { el = document.createElement('div'); el.innerHTML = window.__mkArticle(i, V.items[i]); if (V.items[i].label) el.dataset.lab = '1'; V.els.set(i, el); }
      want.push(el);
    }
    const keep = new Set(want);
    for (const [i, el] of V.els) if (!keep.has(el)) { el.remove(); V.els.delete(i); }
    want.forEach((el, k) => { if (inner.children[k] !== el) inner.insertBefore(el, inner.children[k] || null); });
    B.measure(() => {
      for (let l = 0; l < inner.children.length; l++) {
        const c = inner.children[l], e = c.getBoundingClientRect(), nx = c.nextElementSibling;
        const a = e.height === 0 ? 0 : nx ? nx.getBoundingClientRect().top - e.top : inner.getBoundingClientRect().bottom - parseFloat(inner.style.paddingBottom) - e.top;
        size.set(V.st.rs + l, a);
      }
    });
  }
  function update() {
    return new Promise(res => B.measure(() => {
      const r = outer.getBoundingClientRect(), top = Math.max(0, -r.top), n = V.items.length;
      const l = index(top, n), s = last(top + innerHeight, n) + 1;
      const w = { rs: Math.max(0, l - 3 - zeros(0, l)), re: s + 3 + zeros(s, n) };
      if (w.rs !== V.st.rs || w.re !== V.st.re) { V.st = w; render(); }
      res((outer.scrollHeight - top) / innerHeight - 1);
    }));
  }
  async function loadNext() {
    V.loading = true; V.requests++;
    try {
      const data = await (await fetch('/api/graphql?page=' + V.cursor, { method: 'POST' })).json();
      const c = data.data.xdt_api__v1__feed__timeline__connection;
      for (const e of c.edges) { const m = e.node.media; if (m) V.items.push({ code: m.code, video: !!m.video_versions, label: m.__domtag || '' }); }
      V.hasNext = !!c.page_info.has_next_page; V.cursor++;
    } finally { V.loading = false; render(); update(); }
  }
  addEventListener('DOMContentLoaded', () => {
    outer = document.getElementById('feed');
    inner = document.createElement('div'); inner.style.cssText = 'display:flex;flex-direction:column';
    outer.appendChild(inner);
    addEventListener('scroll', () => update().then(fromEnd => { if (fromEnd < 3 && V.hasNext && !V.loading) loadNext(); }), { capture: true, passive: true });
    loadNext();
  });
  // A labelled post on screen that is not hidden (yet).
  V.flashing = () => Array.from(inner.children).some(el => {
    if (!el.dataset.lab || (el.firstElementChild && el.firstElementChild.dataset.sgHidden)) return false;
    const r = el.getBoundingClientRect(); return r.height > 0 && r.bottom > 50 && r.top < innerHeight - 50;
  });
})();`;

test('backup filter: in Instagram\'s virtual list, labelled posts never flash and paging stops', async () => {
  const vpage = n => {
    const edges = n === 0
      ? [friend('FRIEND0'), edge({ media: media('FRIEND1', user('friend1', true), { video_versions: [{ url: 'https://scontent.cdninstagram.com/v/f1.mp4', width: 720, height: 1280 }] }) })]
      // Posts the data layer can't judge (no follow info) but Instagram labels on
      // screen. (__domtag is only the fixture's way to tell the list to draw the label.)
      : Array.from({ length: 6 }, (_, k) => edge({ media: media('R' + n + '_' + k, user('rec' + k), { __domtag: 'Suggested for you' }) }));
    return page(edges, { more: n < 60, cursor: 'p' + n });
  };
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>body{margin:0;background:#000;color:#fff}</style></head><body>
    <main><div style="height:120px">stories tray</div><div id="feed"></div><div style="height:60px">spinner</div></main><script>${VLIST}</script></body></html>`;
  const pg = await open('https://www.instagram.com/', html, { api: { '/api/graphql': u => ({ body: vpage(+u.searchParams.get('page')) }) } });
  await pg.waitForFunction(() => window.__vl && window.__vl.requests >= 1 && !window.__vl.loading);
  const r = await pg.evaluate(() => new Promise(done => {
    const out = { frames: 0, flashFrames: 0, maxPosts: 0 };
    const t0 = performance.now();
    (function frame(now) {
      if (Math.floor((now - t0) / 600) % 2 === 0) window.scrollBy(0, 45);
      out.frames++;
      if (window.__vl.flashing()) out.flashFrames++;
      out.maxPosts = Math.max(out.maxPosts, document.querySelectorAll('article').length);
      if (now - t0 < 6000) requestAnimationFrame(frame); else done(Object.assign(out, { requests: window.__vl.requests, hasNext: window.__vl.hasNext }));
    })(t0);
  }));
  const f = await feedStats(pg);
  assert.equal(r.flashFrames, 0, JSON.stringify(r));
  assert.equal(f.domStop, 1);
  assert.equal(r.hasNext, false, 'paging stopped');
  assert.ok(r.requests <= 5, JSON.stringify(r));
  assert.ok(r.maxPosts <= 20, JSON.stringify(r));
  assert.equal(await everOn(pg), true);
});

test('stories: the Story checks skip Home\'s feed mounted underneath, and still skip a Story ad', async () => {
  const post = i => '<article><section><div><span>Sponsored</span></div>' +
    Array.from({ length: 12 }, (_, k) => '<span>comment ' + k + ' on post ' + i + '</span>').join('') + '</section><div><span>caption</span></div></article>';
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><script>
    window.__walks = 0; window.__reads = 0; window.__next = 0;
    const nn = TreeWalker.prototype.nextNode;
    TreeWalker.prototype.nextNode = function () { if (this.whatToShow !== NodeFilter.SHOW_TEXT) window.__walks++; return nn.call(this); };
    const tc = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
    Object.defineProperty(Node.prototype, 'textContent', { configurable: true, get() { window.__reads++; return tc.get.call(this); }, set(v) { tc.set.call(this, v); } });
    </script></head><body style="margin:0"><main>${Array.from({ length: 60 }, (_, i) => post(i)).join('')}</main>
    <section id="viewer" style="position:fixed;top:0;left:0;right:0;height:915px;background:#000"><header><span id="who">friend</span></header>
    <div id="ticks"></div><div role="button" aria-label="Next" id="next" style="position:absolute;right:0;top:400px;width:60px;height:60px"></div></section>
    <script>document.getElementById('next').addEventListener('click', () => window.__next++);</script></body></html>`;
  const pg = await open('https://www.instagram.com/stories/friend/123/', html);
  await pg.waitForTimeout(1200);
  // The Story viewer re-renders a few times a second for 1.5 s.
  await pg.evaluate(() => new Promise(done => {
    window.__walks = 0; window.__reads = 0;
    let k = 0;
    const id = setInterval(() => {
      document.getElementById('ticks').appendChild(document.createElement('i'));
      if (++k >= 10) { clearInterval(id); setTimeout(done, 400); }
    }, 150);
  }));
  const cost = await pg.evaluate(() => ({ walks: window.__walks, reads: window.__reads, next: window.__next }));
  assert.equal(cost.next, 0, 'a "Sponsored" under a feed post is not this Story');
  assert.ok(cost.walks < 300 && cost.reads < 100, JSON.stringify(cost) + ' (1.1 walked every post: thousands)');
  await pg.evaluate(() => { document.getElementById('who').textContent = 'Sponsored'; });
  await pg.waitForFunction(() => window.__next === 1);
});

test('nudges: none after the end of Home, and none while the app is in the background', async () => {
  let pg = await open('https://www.instagram.com/', BLANK);
  await parse(pg, page([friend('FRIEND1')]));            // a short page: ask for the next one early...
  await parse(pg, page([friend('FRIEND2'), marker()]));  // ...but Home ends first
  await pg.waitForTimeout(900);
  assert.equal((await feedStats(pg)).nudges, undefined);
  pg = await open('https://www.instagram.com/', BLANK);
  await pg.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }));
  await parse(pg, page([friend('FRIEND1')]));
  await pg.waitForTimeout(900);
  assert.equal((await feedStats(pg)).nudges, undefined);
  await pg.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }));
  await parse(pg, page([friend('FRIEND2')]));
  await pg.waitForTimeout(900);
  assert.equal((await feedStats(pg)).nudges, 1, 'visible again: it works');
});

test('nudges: at most 10 a minute', async () => {
  const pg = await openClocked('https://www.instagram.com/', BLANK);
  for (let i = 0; i < 12; i++) {
    await parse(pg, page([friend('FRIEND' + String(i).padStart(2, '0'))]));
    await pg.clock.runFor(700);
  }
  const f = await feedStats(pg);
  assert.equal(f.nudges, 10);
  assert.equal(f.nudgesCapped, 2);
  await pg.clock.runFor(60000);
  await parse(pg, page([friend('FRIEND99')]));
  await pg.clock.runFor(700);
  assert.equal((await feedStats(pg)).nudges, 11, 'a minute later, again');
});

test('nudges: the extra room below is removed even when frames stop', async () => {
  const pg = await open('https://www.instagram.com/', BLANK);
  await pg.evaluate(() => { window.requestAnimationFrame = () => 0; });
  await parse(pg, page([stranger('STRANG1')])); // nothing kept: a hard nudge on a page too short to scroll
  await pg.waitForTimeout(1000);
  assert.equal((await feedStats(pg)).nudges, 1);
  const pads = await pg.evaluate(() => Array.from(document.body.children).filter(el => el.style.height === innerHeight * 3 + 'px').length);
  assert.equal(pads, 0);
  assert.equal(await pg.evaluate(() => document.scrollingElement.scrollTop), 0);
});

test('feed: paging past posts already seen stops after 15 pages, not 40', async () => {
  const pg = await open('https://www.instagram.com/', BLANK);
  await parse(pg, timeline([edge({ media: media('SEEN001', user('a', true)) })]));
  await Promise.all([pg.waitForURL(/variant=following/), pg.evaluate(() => window.__sg.onNative({ type: 'continueFeed', variant: 'following' }))]);
  const flags = await pg.evaluate(p => {
    const out = [];
    for (let i = 0; i < 16; i++) out.push(JSON.parse(JSON.stringify(p)).data.xdt_api__v1__feed__timeline__connection.page_info.has_next_page);
    return out;
  }, timeline([edge({ media: media('SEEN001', user('a', true)) })]));
  assert.deepEqual(flags, Array(14).fill(true).concat([false, false]));
});
