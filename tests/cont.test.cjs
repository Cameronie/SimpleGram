// R7: Home goes on into Following in Instagram's own list (continueHome on).
// Mock page (r7-page.js) and server (r7-harness.cjs) built from Instagram's
// bundles; nothing reaches Instagram, and passing here does not prove live
// behaviour (the phone checks do).
//
// Run: NODE_PATH=/opt/node-tools/node_modules node --test tests/*.test.cjs
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useBrowser, openIG, readToEnd, readScreens, snap, waitFor, friend, recs, ad, marker, ROOT_DOC, PAGING_DOC } = require('./r7-harness.cjs');

useBrowser();
const ON = { continueHome: true };
const F = n => 'F' + String(n).padStart(2, '0');
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => F(a + i));

// The phone's Home: head 3 posts + ad; next 8 units; then [x, x, ad, marker] (ps feed_recs).
function phoneHome(extra) {
  return Object.assign({
    head: { edges: [friend('F02'), ad('A1'), friend('F01'), friend('F05')], next: 'h1' },
    h1: { edges: [recs('X1'), friend('F03'), ad('A2'), friend('F08'), recs('X2'), friend('F13'), ad('A3'), friend('F21')], next: 'h2' },
    h2: { edges: [recs('X3'), recs('X4'), ad('A4'), marker()], next: 'm1', ps: 'feed_recs' },
    headA: { edges: [friend('NEW01'), friend('F02'), ad('A5'), friend('F01')], next: 'hA' },
    headB: { edges: [friend('NEW01'), ad('A6'), marker()], next: 'hB', ps: 'feed_recs' },
    hA: { edges: [recs('X5'), ad('A7'), marker()], next: 'mA', ps: 'feed_recs' },
  }, extra || {});
}
const HOME_KEPT = ['F02', 'F01', 'F05', 'F03', 'F08', 'F13', 'F21'];
const unseen = list => list.filter(c => !HOME_KEPT.includes(c));
const dupes = a => a.filter((c, i) => a.indexOf(c) !== i);
const own = S => S.log.filter(e => e.who === 'sg');
const igAfterMarker = S => S.log.filter(e => e.who === 'ig' && e.after && !['h1', 'h2'].includes(e.after));
const lastEnd = s => s.feedEnd[s.feedEnd.length - 1];
const tapHome = pg => pg.evaluate(() => { window.__ig.lastHeadLoad -= 31000; document.getElementById('home').click(); });

test('R7-1 seamless: Home continues into Following in the same list, no repeats, no card, one document', async () => {
  const { pg, S, context } = await openIG({ home: phoneHome(), follow: range(1, 400) }, { sgCfg: ON });
  await readToEnd(pg, 16);
  const s = await snap(pg);
  assert.deepEqual(s.codes.slice(0, 7), HOME_KEPT, 'Home first, as Instagram ranked it');
  const after = s.codes.slice(7);
  assert.ok(after.length >= 20, 'Following went on: ' + after.length);
  assert.deepEqual(after, unseen(range(1, 400)).slice(0, after.length), 'Following, newest first, without what Home showed');
  assert.deepEqual(dupes(s.codes), []);
  assert.equal(S.navs, 1, 'no page load: the same document');
  assert.equal(s.navs, 1);
  assert.ok(s.edges >= s.codes.length, 'the posts are in Relay\'s own list (data, not DOM)');
  assert.equal(s.feedEnd.some(m => m.on), false, 'no card while Home goes on');
  assert.equal(s.cont.stats.state, 'running');
  assert.equal(s.cont.stats.repeats, 0);
  assert.equal(s.cont.firstCode, 'F04');
  const label = await pg.evaluate(() => getComputedStyle(document.querySelector('article[data-code="F04"]'), '::before').content);
  assert.match(label, /caught up/, 'a line marks where Following starts');
  assert.match(label, /Following, newest first/);
  const other = await pg.evaluate(() => getComputedStyle(document.querySelector('article[data-code="F06"]'), '::before').content);
  assert.equal(other, 'none');
  // Diagnostics: the first run's timing and drawing, and the handovers growing the page.
  await pg.waitForTimeout(3200);
  const st = (await snap(pg)).cont.stats;
  assert.equal(st.runs.length, 1);
  assert.ok(st.runs[0].ms >= 0);
  assert.equal(st.runs[0].drawn, true);
  assert.equal(st.runs[0].line, true);
  assert.ok(st.hand.length >= 2 && st.hand.every(h => h.sh1 !== null));
  assert.ok(st.hand.some(h => h.n > 0 && h.sh1 > h.sh0), 'handovers append (the page grows)');
  assert.deepEqual(st.modules, { root: true, next: true, constants: true, actions: true, asyncParams: true, asyncHeaders: true });
  await context.close();
});

test('R7-2 requests: the website\'s own shapes, one own request at a time, none before the marker', async () => {
  for (const jk of [false, true]) {
    const { pg, S, context } = await openIG({ home: phoneHome(), follow: range(1, 60) }, { sgCfg: ON, igP: { jk2492: jk } });
    await readToEnd(pg, 24);
    const s = await snap(pg);
    const ig = S.log.filter(e => e.who === 'ig'), sg = own(S);
    // Instagram: one head load, then its next pages in order; no reloads.
    assert.equal(ig.filter(e => e.after == null).length, 1);
    const markerAt = S.log.findIndex(e => e.who === 'ig' && e.after === 'h2');
    assert.ok(markerAt > 0);
    assert.equal(S.log.slice(0, markerAt + 1).filter(e => e.who === 'sg').length, 0, 'nothing of ours before the marker');
    const igAfter = igAfterMarker(S);
    for (const e of igAfter) {
      assert.equal(e.variant, 'home');
      assert.equal(e.name, 'PolarisFeedRootPaginationCachedQuery_subscribe');
      assert.equal(e.ps, jk ? 'feed_recs' : null, 'Instagram\'s own choice (marker cut, justknobx 2492)');
      assert.equal(e.token, false, 'no recs_paging_token: the marker was cut');
    }
    // Ours: Following's first page (root query, 3), then its paging query from the previous cursor.
    assert.equal(sg[0].name, 'PolarisFeedTimelineRootV2Query');
    assert.equal(sg[0].doc, ROOT_DOC);
    assert.deepEqual([sg[0].variant, sg[0].first, sg[0].after, sg[0].ps], ['following', 3, null, 'following']);
    assert.deepEqual(sg[0].keys, ['data', 'first', 'variant']);
    assert.deepEqual(sg[0].dataKeys, ['pagination_source', 'device_id', 'is_async_ads_double_request', 'is_async_ads_in_headload_enabled', 'is_async_ads_rti', 'rti_delivery_backend']);
    for (let i = 1; i < sg.length; i++) {
      assert.equal(sg[i].name, 'PolarisFeedRootPaginationCachedQuery_subscribe');
      assert.equal(sg[i].doc, PAGING_DOC);
      assert.deepEqual(sg[i].keys, ['after', 'before', 'data', 'first', 'last', 'variant']);
      assert.deepEqual(sg[i].dataKeys, ['device_id', 'is_async_ads_double_request', 'is_async_ads_in_headload_enabled', 'is_async_ads_rti', 'rti_delivery_backend', 'pagination_source']);
      assert.deepEqual([sg[i].variant, sg[i].first, sg[i].ps], ['following', 12, 'following']);
      assert.equal(sg[i].after, 'f' + (3 + 12 * (i - 1)), 'cursor of the page before');
      assert.ok(sg[i].t >= sg[i - 1].done, 'one at a time');
    }
    assert.equal(S.inflight.maxSg, 1);
    for (const e of sg) {
      // Instagram's own request shape: one path, its body and headers, no Referer of ours.
      assert.equal(e.path, '/graphql/query');
      assert.equal(e.referer, 'https://www.instagram.com/', 'the page\'s own address: no Referer override');
      assert.equal(e.pv, 6);
      assert.deepEqual(e.headers, { root: 'xdt_api__v1__feed__timeline__connection', asbd: '359341', lsd: 'LSDTOKEN', app: '936619743392459',
        csrf: 'CSRF1', friendly: e.name });
      for (const k of ['av', '__user', '__a', '__req', '__hs', 'dpr', '__ccg', '__rev', '__s', '__hsi', '__dyn', '__comet_req', 'fb_dtsg', 'jazoest', 'lsd',
        'fb_api_caller_class', 'fb_api_req_friendly_name', 'server_timestamps', 'variables', 'doc_id']) assert.ok(e.bodyKeys.includes(k), 'body has ' + k);
      assert.deepEqual(e.bodyKeys.slice(-5), ['fb_api_caller_class', 'fb_api_req_friendly_name', 'server_timestamps', 'variables', 'doc_id']);
    }
    // Never more of ours than one Following page ahead of what was shown.
    assert.ok(sg.length <= Math.ceil((s.cont.stats.handed + s.cont.stats.skippedSeen) / 12) + 2, `own ${sg.length}, handed ${s.cont.stats.handed}`);
    assert.ok(sg.length <= igAfter.length + 2, `own ${sg.length} vs Instagram's ${igAfter.length}`);
    // The request log in Filter status: shapes only.
    const log = await pg.evaluate(() => window.__sg.gqlLog.filter(e => /^PolarisFeed/.test(e.query)));
    assert.equal(log.length, sg.length);
    for (const e of log) {
      assert.deepEqual([e.idSource, e.providerSource, e.status, e.fid, e.hdr], ['module', 'graphql', 200, 'page', 'page']);
      assert.ok(typeof e.edges === 'number' && typeof e.ms === 'number');
    }
    await context.close();
  }
});

// Home shows 30 posts (F01..F30 in ranked order) over 5 pages, then the marker.
function heavyHome() {
  const order = [2, 1, 5, 3, 8, 4, 6, 7, 13, 9, 10, 11, 12, 21, 14, 15, 16, 17, 18, 19, 20, 22, 23, 24, 25, 26, 27, 28, 29, 30].map(F);
  const home = { head: { edges: [friend(order[0]), ad('A0'), friend(order[1]), friend(order[2])], next: 'p1' } };
  let i = 3;
  for (let p = 1; p <= 5; p++) {
    const take = order.slice(i, i + 6); i += 6;
    home['p' + p] = { edges: [recs('XH' + p), ...take.slice(0, 3).map(friend), ad('AH' + p), ...take.slice(3).map(friend)], next: 'p' + (p + 1) };
  }
  home.p6 = { edges: [recs('XM1'), ad('AM'), marker()], next: 'm1', ps: 'feed_recs' };
  return { order, home };
}

test('R7-3 heavy Home (B17): Following\'s first pages all seen; reached past them, never an empty list', async () => {
  const { order, home } = heavyHome();
  const { pg, S, context } = await openIG({ home, follow: range(1, 80) }, { sgCfg: ON });
  let minEdges = Infinity;
  for (let r = 0; r < 30; r++) {
    await readToEnd(pg, 1, 350);
    const e = await pg.evaluate(() => window.__ig.codes().length);
    minEdges = Math.min(minEdges, e);
  }
  const s = await snap(pg);
  assert.ok(minEdges >= 3, 'never an empty Home');
  const shownHome = s.codes.slice(0, order.length);
  assert.deepEqual(shownHome, order.filter(c => shownHome.includes(c)));
  const after = s.codes.slice(order.length);
  assert.ok(after.length >= 10, 'reached new posts: ' + after.length);
  assert.equal(after[0], 'F31');
  assert.deepEqual(dupes(s.codes), []);
  assert.ok(s.cont.stats.skippedSeen >= 30);
  const sgLog = own(S);
  assert.ok(sgLog.length <= Math.ceil((s.cont.stats.handed + s.cont.stats.skippedSeen - 3) / 12) + 2, 'no more of ours than the Following pages passed: ' + sgLog.length);
  assert.equal(sgLog.findIndex(e => e.after === 'f27'), 3, 'past 30 seen posts in 4 of our requests');
  await context.close();
});

for (const [label, pause] of [['jumps to the end every 0.3 s', 300], ['jumps to the end every 1.2 s', 1200], ['flings 2.5 screens a second', 0]]) {
  test('R7-4 race, Following answers in 1.5 s (' + label + '): empty pages while waiting, then posts', async () => {
    const { pg, context } = await openIG({ home: phoneHome(), follow: range(1, 400), delay: { home: 300, following: 1500 } }, { sgCfg: ON });
    if (pause) await readToEnd(pg, Math.round(9000 / pause), pause);
    else await readScreens(pg, 15000, 2.5);
    const s = await snap(pg);
    assert.ok(s.codes.includes('F04') && s.codes.includes('F12'), 'Following arrived');
    if (pause) assert.ok(s.cont.stats.empty >= 1, 'readers that jump to the end outrun a 1.5 s answer');
    else assert.ok(s.cont.stats.empty <= 1, 'a reader who scrolls meets at most the race at the marker: ' + s.cont.stats.empty);
    // Bounded by how often Instagram asks while our page is on its way (its own pace).
    assert.ok(s.cont.stats.empty <= (pause === 300 ? 12 : 4), 'empty pages: ' + s.cont.stats.empty);
    assert.deepEqual(dupes(s.codes), []);
    assert.equal(s.hasNext, true);
    await context.close();
  });
}

test('R7-5 Home tab reload during the continuation (B16): Instagram\'s head replaces the list, then Following resumes without repeats', async () => {
  const follow = S => (S.caughtUpTap ? ['NEW01'] : []).concat(range(1, 400));
  const { pg, S, context } = await openIG({ home: phoneHome(), follow }, { sgCfg: ON });
  await readToEnd(pg, 16);
  const before = await snap(pg);
  const shownBefore = before.codes.slice(7);
  assert.ok(shownBefore.length >= 8);
  S.caughtUpTap = true;
  // More than 30 s since the last head load: Instagram's Home tab reloads twice and scrolls to the top.
  // Where Following had got to is read at the tap itself: with two pages read ahead (B22) a read
  // can land between the snapshot above and the tap.
  const cursorAtTap = await pg.evaluate(() => { const c = window.__sg.cont().cursor; window.__ig.lastHeadLoad -= 31000; document.getElementById('home').click(); return c; });
  await pg.waitForTimeout(900);
  const mid = await snap(pg);
  assert.deepEqual(mid.codes, ['NEW01'], 'Instagram\'s own reload: its head (cut at the marker), not Following');
  assert.ok(mid.cont.stats.heads >= 1);
  assert.ok(mid.cont.stats.headWhy.seen + mid.cont.stats.headWhy.jump >= 1, JSON.stringify(mid.cont.stats.headWhy));
  assert.equal(mid.cont.stats.resets, 1);
  assert.equal(mid.cont.stats.state, 'running', 'continuation re-armed at the new marker');
  await readToEnd(pg, 16);
  const s = await snap(pg);
  const again = s.codes.slice(1);
  assert.ok(again.length >= 5, 'Following resumed');
  assert.deepEqual(again.filter(c => shownBefore.includes(c) || HOME_KEPT.includes(c) || c === 'NEW01'), [], 'nothing shown before comes again');
  // No gaps: the posts read but not shown come first, then on from the cursor.
  assert.equal(again[0], unseen(range(1, 400)).filter(c => !shownBefore.includes(c))[0]);
  const tapAt = S.log.findIndex((e, i) => i > 0 && e.who === 'ig' && e.after == null);
  const sgAfter = S.log.slice(tapAt).filter(e => e.who === 'sg').map(e => e.after);
  assert.deepEqual(sgAfter.slice(0, 2), [null, cursorAtTap], 'the newest page, then on from the saved cursor');
  const n = c => Number(String(c).slice(1));
  assert.deepEqual(sgAfter.filter(c => c && n(c) < n(cursorAtTap)), [], 'nothing re-read');
  assert.equal(s.cont.stats.repeats, 0);
  await context.close();
});

test('R7-6 fallback: Following refused (please wait) -> Home ends with the card, no more requests of ours', async () => {
  const { pg, S, context } = await openIG({ home: phoneHome(), follow: range(1, 60), followFail: { at: 2 } }, { sgCfg: ON });
  await readToEnd(pg, 20);
  const s = await snap(pg);
  assert.equal(s.cont.stats.state, 'failed');
  assert.equal(s.cont.stats.reason, 'request');
  assert.equal(s.cont.stats.ownFail, 1);
  assert.equal(own(S).length, 2, 'no retries after a refusal');
  assert.deepEqual(s.codes.slice(0, 7), HOME_KEPT);
  assert.deepEqual(dupes(s.codes), []);
  assert.equal(s.hasNext, false, 'Instagram stops paging');
  assert.equal(s.fs.ended, true);
  const last = lastEnd(s);
  assert.equal(last.on, true, 'the card shows');
  assert.equal(last.caughtUp, true);
  assert.equal(last.cont, 'failed');
  await context.close();
});

test('R7-6b fallback: an answer that is not a feed page -> the card', async () => {
  const { pg, S, context } = await openIG({ home: phoneHome(), follow: range(1, 60), followFail: { at: 1, body: { data: { something_else: {} } } } }, { sgCfg: ON });
  await readToEnd(pg, 14);
  const s = await snap(pg);
  assert.equal(s.cont.stats.state, 'failed');
  assert.deepEqual(s.codes, HOME_KEPT);
  assert.equal(lastEnd(s).on, true);
  assert.ok(own(S).length <= 1, 'one path only, no retry');
  await context.close();
});

test('R7-7 Following runs out: the last page stops Instagram\'s paging and the card shows', async () => {
  const { pg, S, context } = await openIG({ home: phoneHome(), follow: range(1, 14) }, { sgCfg: ON });
  await readToEnd(pg, 20);
  const s = await snap(pg);
  assert.deepEqual(s.codes, HOME_KEPT.concat(unseen(range(1, 14))));
  assert.equal(s.hasNext, false);
  assert.equal(s.cont.stats.state, 'done');
  assert.equal(lastEnd(s).on, true);
  assert.equal(lastEnd(s).cont, 'done');
  assert.ok(igAfterMarker(S).length <= 3);
  await context.close();
});

test('R7-8 marker first on Home\'s first page (B18): the marker stays as the only item, paging on, and Home goes on into Following', async () => {
  const home = { head: { edges: [recs('X0'), ad('A0'), marker()], next: 'm0', ps: 'feed_recs' } };
  const { pg, S, context } = await openIG({ home, follow: range(1, 30) }, { sgCfg: ON });
  const first = await snap(pg);
  assert.equal(first.empty, false, 'no empty-feed screen');
  assert.equal(first.edges, 1);
  assert.equal(first.hasNext, true, 'has_next left on while Home goes on (decision 1)');
  await readToEnd(pg, 16);
  const s = await snap(pg);
  const ig = S.log.filter(e => e.who === 'ig' && e.after);
  assert.equal(s.cont.stats.anchors, 1);
  assert.equal(s.feed.anchorKind.marker, 1);
  assert.ok(s.codes.length >= 10 && s.codes[0] === 'F01');
  assert.equal(ig[0].ps, 'feed_recs', 'the kept marker makes Instagram ask feed_recs');
  assert.equal(ig[0].token, false, 'marker last: no recs token, as on the website');
  const groups = await pg.evaluate(() => window.__ig.conn.edges[0].node.end_of_feed_demarcator.group_set);
  assert.deepEqual([groups.groups, groups.active_group_id], [[], null]);
  await context.close();
});

test('R7-9 off (1.3 stage 1 behaviour) and other feeds: no continuation', async () => {
  const a = await openIG({ home: phoneHome(), follow: range(1, 60) }, { sgCfg: {} });
  await readToEnd(a.pg, 12);
  const s = await snap(a.pg);
  assert.deepEqual(s.codes, HOME_KEPT);
  assert.equal(s.hasNext, false);
  assert.equal(own(a.S).length, 0);
  assert.equal(lastEnd(s).on, true);
  assert.equal(lastEnd(s).cont, 'off');
  assert.equal(s.cont.stats.on, false);
  assert.equal(await a.pg.evaluate(() => /native code/.test(String(window.scrollTo))), true, 'scrollTo untouched when off');
  await a.context.close();
  const home = { head: { edges: [friend('F01'), friend('F02'), friend('F03')], next: 'g1' }, g1: { edges: [friend('F04'), marker()], next: 'gm' } };
  const b = await openIG({ home, follow: range(1, 60) }, { url: 'https://www.instagram.com/?variant=following', sgCfg: ON });
  await readToEnd(b.pg, 8);
  assert.equal(own(b.S).length, 0, 'only Home continues');
  await b.context.close();
});

test('R7-10 away from Home (a post, Stories): our reading pauses, and resumes on return', async () => {
  const { pg, S, context } = await openIG({ home: phoneHome(), follow: range(1, 200) }, { sgCfg: ON });
  await readToEnd(pg, 10);
  await pg.evaluate(() => history.pushState({}, '', '/p/F04/'));
  const n0 = own(S).length;
  await pg.waitForTimeout(2500);
  const n1 = own(S).length;
  assert.ok(n1 - n0 <= 1, 'at most the request already on its way: ' + (n1 - n0));
  await pg.evaluate(() => history.pushState({}, '', '/'));
  await readToEnd(pg, 10);
  const s = await snap(pg);
  assert.ok(own(S).length > n1);
  assert.deepEqual(dupes(s.codes), []);
  await context.close();
});

test('R7-5b reload after Following was all shown: nothing new, so Home ends with the card (no endless spinner)', async () => {
  const { pg, S, context } = await openIG({ home: phoneHome(), follow: range(1, 40) }, { sgCfg: ON });
  await readToEnd(pg, 16);
  const before = await snap(pg);
  assert.equal(before.cont.stats.state, 'done');
  await tapHome(pg);
  await pg.waitForTimeout(5000);
  const s = await snap(pg);
  assert.deepEqual(s.codes, ['NEW01']);
  assert.equal(s.cont.stats.state, 'done');
  assert.equal(s.fs.ended, true);
  assert.equal(lastEnd(s).on, true, 'the card, not a spinner forever');
  assert.ok(own(S).length <= 2 * 5, 'bounded by the seen posts');
  await context.close();
});

test('R7-5c Home tab reload, heads answered in the other order (B, then A): A is a reload too, never swapped', async () => {
  const follow = S => (S.caughtUpTap ? ['NEW01'] : []).concat(range(1, 400));
  const { pg, S, context } = await openIG({ home: phoneHome(), follow, headOrder: 'BA' }, { sgCfg: ON });
  await readToEnd(pg, 12);
  const shownBefore = (await snap(pg)).codes.slice(7);
  S.caughtUpTap = true;
  await tapHome(pg);
  await pg.waitForTimeout(900);
  const mid = await snap(pg);
  assert.deepEqual(mid.codes, ['NEW01', 'F02', 'F01'], 'Relay keeps the last head (A), as Instagram sent it');
  await readToEnd(pg, 14);
  const s = await snap(pg);
  const again = s.codes.slice(3);
  assert.ok(again.length >= 5, 'Following resumed after Home reached the marker again');
  assert.deepEqual(again.filter(c => shownBefore.includes(c) || HOME_KEPT.includes(c) || c === 'NEW01'), []);
  await context.close();
});

/* ---------------- Arming, request fidelity, limits, diagnostics ---------------- */

for (const [label, igP] of [['a query module missing', { missing: ['PolarisFeedRootPaginationCachedQuery_subscribe.graphql'] }],
  ['no page modules at all', { noRequire: true }]]) {
  test('R7 arming: ' + label + ' -> Home ends at the marker with the card, exactly as with the switch off', async () => {
    const { pg, S, context } = await openIG({ home: phoneHome(), follow: range(1, 60) }, { sgCfg: ON, igP });
    await readToEnd(pg, 12);
    const s = await snap(pg);
    assert.deepEqual(s.codes, HOME_KEPT);
    assert.equal(s.hasNext, false);
    assert.equal(own(S).length, 0, 'no request of ours');
    assert.equal(s.cont.stats.state, 'failed');
    assert.equal(s.cont.stats.reason, 'modules');
    assert.equal(s.cont.stats.modules.next, false);
    assert.equal(lastEnd(s).on, true);
    assert.equal(lastEnd(s).cont, 'failed');
    await context.close();
  });
}

test('R7 requests: if Instagram\'s own request helpers fail, the minimal request goes (and says so)', async () => {
  const { pg, S, context } = await openIG({ home: phoneHome(), follow: range(1, 400) }, { sgCfg: ON, igP: { badAsync: true } });
  await readToEnd(pg, 12);
  const sg = own(S);
  assert.ok(sg.length >= 1);
  for (const e of sg) {
    assert.deepEqual(e.bodyKeys, ['doc_id', 'variables', 'fb_dtsg', 'lsd', 'fb_api_caller_class', 'fb_api_req_friendly_name', 'server_timestamps']);
    assert.equal(e.headers.lsd, 'LSDTOKEN');
    assert.equal(e.headers.asbd, null);
    assert.equal(e.headers.root, 'xdt_api__v1__feed__timeline__connection');
  }
  const log = await pg.evaluate(() => window.__sg.gqlLog.filter(e => /^PolarisFeed/.test(e.query)));
  assert.ok(log.every(e => e.fid === 'min' && e.hdr === 'min'));
  const s = await snap(pg);
  assert.equal(s.cont.stats.state, 'running');
  assert.ok(s.codes.includes('F04'));
  await context.close();
});

test('R7 reload reasons: Instagram\'s jump to the top and a passed Home-tab tap are counted; a feed_recs page never is', async () => {
  // After the caught-up point the server's head has new posts only (no marker, nothing Home showed).
  const home = phoneHome({ headB: { edges: [friend('NEW01'), friend('NEW02'), ad('A6')], next: 'hN' },
    hN: { edges: [friend('NEW03'), marker()], next: 'mN', ps: 'feed_recs' } });
  const { pg, context } = await openIG({ home, follow: range(1, 400) }, { sgCfg: ON });
  await readToEnd(pg, 10);
  // Instagram jumps to the top and reloads its first page (the new-posts pill).
  await pg.evaluate(() => { window.scrollTo(0, 0); return window.__ig.silentReload('none'); });
  await pg.waitForTimeout(600);
  let s = await snap(pg);
  assert.equal(s.cont.stats.headWhy.jump, 1, JSON.stringify(s.cont.stats.headWhy));
  assert.deepEqual(s.codes.slice(0, 2), ['NEW01', 'NEW02'], 'Instagram\'s new posts, never replaced by Following');
  // Back to the marker; then a Home-tab tap at the top passed to Instagram.
  await readToEnd(pg, 8);
  s = await snap(pg);
  assert.equal(s.cont.stats.state, 'running');
  // The next reload brings other new posts (nothing Home showed).
  home.headB = { edges: [friend('NEW04'), ad('A8')], next: 'hM' };
  home.hM = { edges: [friend('NEW05'), marker()], next: 'mM', ps: 'feed_recs' };
  await pg.evaluate(() => { document.scrollingElement.scrollTop = 0; });
  await pg.waitForTimeout(300);
  await pg.tap('#home');
  await pg.waitForTimeout(300);
  const tapped = await pg.evaluate(() => window.__sg.stats.feed.homeTapRefresh || 0);
  assert.equal(tapped, 1, 'the tap at the top was passed to Instagram');
  // Within 30 s of its last head load Instagram only scrolled to the top; its
  // reload comes later (past the 6 s of the jump rule), with no scroll.
  await pg.waitForTimeout(6500);
  await pg.evaluate(() => window.__ig.silentReload('none'));
  await pg.waitForTimeout(600);
  s = await snap(pg);
  assert.equal(s.cont.stats.headWhy.tap, 1, JSON.stringify(s.cont.stats.headWhy));
  assert.equal(s.cont.stats.headWhy.seen, 0, 'nothing Home showed came back');
  await context.close();
});

test('R7 required stop: about 200 Following posts in one page load, then Home ends with "Keep going in Following"', async () => {
  const { pg, S, context } = await openIG({ home: phoneHome(), follow: range(1, 400) }, { sgCfg: ON });
  await readToEnd(pg, 6, 300);
  for (let i = 0; i < 12 && (await snap(pg)).cont.stats.state === 'running'; i++) await readToEnd(pg, 6, 300);
  // To the bottom once more: the stop can come with the last swipe, before you are at the end again.
  await readToEnd(pg, 2, 300);
  const s = await snap(pg);
  assert.equal(s.cont.stats.state, 'limit');
  assert.equal(s.cont.stats.reason, 'posts');
  assert.equal(s.cont.stats.handed, 200);
  assert.equal(s.codes.length, 7 + 200);
  assert.equal(s.hasNext, false);
  assert.equal(lastEnd(s).on, true);
  assert.equal(lastEnd(s).cont, 'limit');
  assert.equal(lastEnd(s).contWhy, 'posts', 'the card names the 200 posts');
  assert.ok(own(S).length <= 20, 'about one request per 12 posts: ' + own(S).length);
  // A reload in the same page load stays ended at its marker (no new start).
  const n = own(S).length;
  await tapHome(pg);
  await pg.waitForTimeout(1500);
  await readToEnd(pg, 4);
  const t = await snap(pg);
  assert.equal(own(S).length, n);
  assert.equal(t.cont.stats.state, 'limit');
  assert.equal(t.hasNext, false);
  await context.close();
});

test('R7 pacing: own requests stay within 20 a minute across the whole page load, and stop at about 25 ("Keep going in Following")', async () => {
  // Following pages that each bring one new post among ads: many requests for few posts.
  const follow = range(1, 400);
  const followUnit = c => [friend(c)].concat(Array.from({ length: 11 }, (_, i) => ad('Z' + c + i)));
  const { pg, S, context } = await openIG({ home: phoneHome(), follow, followUnit, followFirst: 1 }, { sgCfg: ON });
  await readToEnd(pg, 6, 300);
  for (let t = 0; t < 80 && (await snap(pg)).cont.stats.state === 'running'; t++) await readToEnd(pg, 2, 500);
  const s = await snap(pg);
  const times = own(S).map(e => e.t);
  for (let i = 20; i < times.length; i++) assert.ok(times[i] - times[i - 20] >= 59000, 'never 21 in a minute');
  assert.ok(s.cont.stats.peakMin <= 20);
  assert.equal(own(S).length, 25);
  assert.equal(s.cont.stats.state, 'limit');
  assert.equal(s.cont.stats.reason, 'requests');
  assert.equal(lastEnd(s).cont, 'limit');
  assert.equal(lastEnd(s).contWhy, 'requests', 'the card makes no claim about 200 posts');
  await context.close();
});

test('R7 restarts: more than 4 starts in a minute -> the card, no more of our requests', async () => {
  const { pg, S, context } = await openIG({ home: phoneHome(), follow: range(1, 400) }, { sgCfg: ON });
  await readToEnd(pg, 8);
  for (let i = 0; i < 4; i++) {
    await tapHome(pg);
    await pg.waitForTimeout(1200);
  }
  const s = await snap(pg);
  assert.equal(s.cont.stats.state, 'failed');
  assert.equal(s.cont.stats.reason, 'restarts');
  assert.equal(s.cont.stats.startsMin, 5);
  const n = own(S).length;
  await readToEnd(pg, 6);
  const t = await snap(pg);
  assert.equal(own(S).length, n);
  assert.equal(t.hasNext, false);
  assert.equal(lastEnd(t).on, true);
  assert.equal(lastEnd(t).cont, 'failed');
  await context.close();
});

test('R7 diagnostics: stats.cont, the trail and the Home pages carry no names, codes or addresses', async () => {
  const { pg, context } = await openIG({ home: phoneHome(), follow: range(1, 400) }, { sgCfg: ON });
  await readToEnd(pg, 12);
  await pg.waitForTimeout(1600);
  const st = await pg.evaluate(() => window.__sg.stats);
  const text = JSON.stringify(st);
  assert.doesNotMatch(text, /\bF\d\d\b|NEW\d\d|\bf_|r_x|cdninstagram|https?:|\/p\//);
  assert.ok(st.cont.handed > 0 && st.cont.swaps > 0);
  const ring = st.homeRing;
  assert.ok(ring.some(e => e.am === true) && ring.some(e => e.am === false), 'pages before and after the marker');
  assert.ok(ring.every(e => typeof e.fe === 'number'));
  assert.ok(st.trail.some(e => e.ev === 'page' && typeof e.cf === 'number'), 'handovers in the trail');
  await context.close();
});
