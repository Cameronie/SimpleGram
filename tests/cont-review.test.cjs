// R7 review experiments E1-E7 (continueHome on): the cases that broke the
// first prototype (lost Following posts across a reload, stale answers,
// scroll-only reload rules, unbounded restarts, a false "stalled" card).
// Same mock page and server as cont.test.cjs; nothing reaches Instagram.
//
// Run: NODE_PATH=/opt/node-tools/node_modules node --test tests/*.test.cjs
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useBrowser, openIG, readToEnd, snap, waitFor, friend, recs, ad, marker } = require('./r7-harness.cjs');

useBrowser();
const ON = { continueHome: true };
const F = n => 'F' + String(n).padStart(2, '0');
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => F(a + i));
const dupes = a => a.filter((c, i) => a.indexOf(c) !== i);
const own = S => S.log.filter(e => e.who === 'sg');
const tapHome = pg => pg.evaluate(() => { window.__ig.lastHeadLoad -= 31000; document.getElementById('home').click(); });

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
// Following in order, minus what was shown: every post before the last one
// shown must have been shown (no gaps).
function gaps(followOrder, shownBefore, shownAfter) {
  const skip = new Set(shownBefore);
  const expect = followOrder.filter(c => !skip.has(c));
  const missing = [];
  const last = shownAfter.length ? expect.indexOf(shownAfter[shownAfter.length - 1]) : -1;
  for (let i = 0; i <= last; i++) if (!shownAfter.includes(expect[i])) missing.push(expect[i]);
  return missing;
}

test('E1 a Home-tab reload while one of our Following requests is in flight: its answer is dropped, one request at a time, no gaps', async () => {
  const follow = S => (S.caughtUpTap ? ['NEW01'] : []).concat(range(1, 400));
  const { pg, S, context } = await openIG({ home: phoneHome(), follow, delay: { home: 100, following: 1200 } }, { sgCfg: ON });
  await readToEnd(pg, 10, 400);
  // Wait until one of ours has just been sent and is still on its way.
  const n0 = own(S).length;
  await waitFor(pg, async () => own(S).length > n0, 15000);
  const before = await snap(pg);
  assert.equal(before.cont.inFlight, true);
  S.caughtUpTap = true;
  await tapHome(pg);
  await pg.waitForTimeout(3000);
  await readToEnd(pg, 14, 500);
  const s = await snap(pg);
  const tapAt = S.log.findIndex((e, i) => i > 0 && e.who === 'ig' && e.after == null);
  const sgAfter = S.log.slice(tapAt).filter(e => e.who === 'sg');
  const shownBefore = HOME_KEPT.concat(before.codes.slice(7));
  const shownAfter = s.codes.slice(1);
  assert.equal(S.inflight.maxSg, 1, 'one of our requests at a time');
  assert.equal(sgAfter[0].after, null, 'the restart reads Following\'s newest page first');
  assert.deepEqual(shownAfter.filter(c => shownBefore.includes(c)), [], 'no repeats');
  assert.deepEqual(dupes(s.codes), []);
  assert.deepEqual(gaps(['NEW01'].concat(range(1, 400)), shownBefore.concat(['NEW01']), shownAfter), [], 'no gaps');
  assert.ok(shownAfter.length >= 5);
  await context.close();
});

test('E2 posts read but not shown are kept across a Home-tab reload (no gaps in Following)', async () => {
  const follow = S => (S.caughtUpTap ? ['NEW01'] : []).concat(range(1, 400));
  const { pg, S, context } = await openIG({ home: phoneHome(), follow }, { sgCfg: ON });
  await readToEnd(pg, 10, 400);
  await pg.waitForTimeout(2500);      // the user reads; SimpleGram fills its buffer
  const before = await snap(pg);
  assert.ok(before.cont.buffer > 0, 'posts waiting to be shown');
  S.caughtUpTap = true;
  await tapHome(pg);
  await pg.waitForTimeout(1500);
  const mid = await snap(pg);
  assert.equal(mid.cont.stats.keptBuffer, before.cont.buffer);
  await readToEnd(pg, 16, 400);
  const s = await snap(pg);
  const shownBefore = HOME_KEPT.concat(before.codes.slice(7));
  const shownAfter = s.codes.slice(1);
  assert.deepEqual(gaps(['NEW01'].concat(range(1, 400)), shownBefore.concat(['NEW01']), shownAfter), [], 'no Following post skipped');
  assert.deepEqual(shownAfter.filter(c => shownBefore.includes(c)), []);
  await context.close();
});

test('E3 Instagram\'s next page arriving after you went to the top (B16: Home tab scrolls first) is still a next page', async () => {
  const { pg, S, context } = await openIG({ home: phoneHome(), follow: range(1, 400), delay: { home: 1500, following: 150 } }, { sgCfg: ON });
  await readToEnd(pg, 14, 400);
  await pg.waitForFunction(() => !window.__ig.loading, null, { timeout: 5000 });
  await pg.waitForTimeout(800);
  const before = await snap(pg);
  // One more swipe to the end starts Instagram's next page (1.5 s), then the
  // B16 Home tab sets scrollTop = 0 (no scrollTo, no reload).
  const n0 = S.log.filter(e => e.who === 'ig').length;
  await pg.evaluate(() => { const se = document.scrollingElement; se.scrollTop = se.scrollHeight; });
  await waitFor(pg, async () => S.log.filter(e => e.who === 'ig').length > n0, 3000);
  await pg.evaluate(() => { document.scrollingElement.scrollTop = 0; });
  await pg.waitForTimeout(2500);
  const mid = await snap(pg);
  await readToEnd(pg, 16, 400);
  const s = await snap(pg);
  const shownBefore = HOME_KEPT.concat(before.codes.slice(7));
  const shownAfter = s.codes.slice(before.codes.length);
  assert.equal(mid.cont.stats.heads, before.cont.stats.heads, 'a next page is not a reload');
  assert.deepEqual(gaps(range(1, 400), shownBefore, shownAfter), []);
  assert.deepEqual(dupes(s.codes), []);
  await context.close();
});

for (const kind of ['none', 'smooth']) {
  test('E4 a reload from another refresh path deep in the continuation (' + kind + ' scroll) keeps Instagram\'s new posts', async () => {
    // After the caught-up point the server's head has two new friends' posts and no marker.
    const home = phoneHome({ headB: { edges: [friend('NEW01'), friend('NEW02'), ad('A6'), friend('F02')], next: 'hN' },
      hN: { edges: [friend('F01'), recs('X9'), friend('F05'), marker()], next: 'mN', ps: 'feed_recs' } });
    const { pg, context } = await openIG({ home, follow: range(1, 400) }, { sgCfg: ON });
    await readToEnd(pg, 12, 400);
    await pg.evaluate(k => window.__ig.silentReload(k), kind);
    await pg.waitForTimeout(1200);
    const s = await snap(pg);
    assert.ok(s.codes.includes('NEW01') && s.codes.includes('NEW02'), 'Instagram\'s new Home posts are shown: ' + s.codes.slice(0, 6));
    assert.deepEqual(s.codes.slice(0, 3), ['NEW01', 'NEW02', 'F02'], 'its first page, as it sent it');
    assert.equal(s.cont.stats.headWhy.seen, 1, 'a post Home showed came back: Home\'s first page again');
    await context.close();
  });
}

test('E5 if Home prefetched far ahead (10 screens): reading the top two screens never resets the continuation', async () => {
  const { pg, S, context } = await openIG({ home: phoneHome(), follow: range(1, 400) }, { sgCfg: ON, igP: { threshold: 10 } });
  for (let i = 0; i < 40; i++) {
    await pg.evaluate(i => { document.scrollingElement.scrollTop = 200 + (i % 2) * 300; }, i);
    await pg.waitForTimeout(250);
  }
  const s = await snap(pg);
  assert.equal(s.cont.stats.heads, 0, 'next pages are not reloads');
  assert.ok(own(S).length <= 20, 'own requests bounded: ' + own(S).length);
  assert.ok(s.cont.stats.startsMin <= 1);
  await context.close();
});

test('E6 a Home page that lands while a post is open still counts as seen in Home: never handed again', async () => {
  const { pg, S, context } = await openIG({ home: phoneHome(), follow: range(1, 400), delay: { home: 1500, following: 150 } }, { sgCfg: ON });
  // Scroll until Instagram asks for page h1, then open a post before it answers.
  const n0 = S.log.filter(e => e.who === 'ig').length;
  await pg.evaluate(() => { const se = document.scrollingElement; se.scrollTop = se.scrollHeight; });
  await waitFor(pg, async () => S.log.filter(e => e.who === 'ig').length > n0, 3000);
  await pg.evaluate(() => history.pushState({}, '', '/p/F02/'));
  await pg.waitForTimeout(2000);
  await pg.evaluate(() => history.pushState({}, '', '/'));
  await readToEnd(pg, 16, 500);
  const s = await snap(pg);
  const edgeCodes = await pg.evaluate(() => window.__ig.conn.edges.map(e => e.node.media ? e.node.media.code : null).filter(Boolean));
  assert.deepEqual(dupes(edgeCodes), [], 'no repeats handed to Instagram');
  assert.deepEqual(dupes(s.codes), []);
  assert.equal(s.cont.stats.repeats, 0);
  assert.ok(s.codes.includes('F04'));
  await context.close();
});

test('E7 heavy Home, slow Following: no "Home isn\'t loading more" while SimpleGram is still skipping seen posts; the app says it is skipping', async () => {
  const order = [2, 1, 5, 3, 8, 4, 6, 7, 13, 9, 10, 11, 12, 21, 14, 15, 16, 17, 18, 19, 20, 22, 23, 24, 25, 26, 27, 28, 29, 30].map(F);
  const home = { head: { edges: [friend(order[0]), ad('A0'), friend(order[1]), friend(order[2])], next: 'p1' } };
  let i = 3;
  for (let p = 1; p <= 5; p++) {
    const take = order.slice(i, i + 6); i += 6;
    home['p' + p] = { edges: [recs('XH' + p), ...take.slice(0, 3).map(friend), ad('AH' + p), ...take.slice(3).map(friend)], next: 'p' + (p + 1) };
  }
  home.p6 = { edges: [recs('XM1'), ad('AM'), marker()], next: 'm1', ps: 'feed_recs' };
  const { pg, context } = await openIG({ home, follow: range(1, 80), delay: { home: 100, following: 4500 } }, { sgCfg: ON });
  await readToEnd(pg, 12, 300);
  await pg.evaluate(() => { const se = document.scrollingElement; se.scrollTop = se.scrollHeight; });
  await pg.waitForTimeout(22000);       // the reader waits at the bottom, without scrolling
  const s = await snap(pg);
  assert.equal(s.feedEnd.filter(m => m.on && m.stalled && m.cont === 'running').length, 0, 'no stalled card while Following is being read');
  assert.ok(s.codes.includes('F31'), 'the first new post arrived');
  // The app's note: on after about 3 s of skipping with Instagram waiting, off once posts come.
  const notes = s.skipStatus;
  assert.ok(notes.some(m => m.on && m.kind === 'homeSkipping'), JSON.stringify(notes));
  assert.equal(notes[notes.length - 1].on, false);
  assert.ok(s.cont.stats.notes >= 1);
  await context.close();
});
