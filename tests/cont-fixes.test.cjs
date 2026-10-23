// R7 review fixes (continueHome on): a reload's marker page stays cut, the
// card's words match why Home ended, one reload counts once, the skip note
// goes when posts are ready, the switch works in the loaded page, the scroll
// room goes, a reload after the end is never an empty list, and a failed
// restart stops Instagram's paging. Same mock page and server as
// cont.test.cjs; nothing reaches Instagram.
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
const own = S => S.log.filter(e => e.who === 'sg');
const lastEnd = s => s.feedEnd[s.feedEnd.length - 1];
const tapHome = pg => pg.evaluate(() => { window.__ig.lastHeadLoad -= 31000; document.getElementById('home').click(); });
// What is drawn, Instagram's own end-of-feed block included.
const dom = pg => pg.evaluate(() => Array.from(document.querySelectorAll('#main article[data-code], #main .eof'))
  .filter(e => getComputedStyle(e).display !== 'none').map(e => e.dataset.code || 'EOF'));

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

for (const wait of [500, 4000]) {
  test('fix 1: after a Home-tab reload with no marker in its heads, the next marker page (cut to nothing) stays cut (' + wait + ' ms)', async () => {
    // The reload's heads carry no marker; Home's page 2 is the phone's marker page.
    const home = phoneHome({
      headB: { edges: [friend('NEW01'), friend('NEW02'), ad('A6'), friend('F02')], next: 'hB' },
      hB: { edges: [recs('X6'), ad('A8'), marker()], next: 'mB', ps: 'feed_recs' },
    });
    const { pg, S, context } = await openIG({ home, follow: range(1, 400) }, { sgCfg: ON });
    await readToEnd(pg, 10);
    const before = await snap(pg);
    assert.equal(before.cont.stats.state, 'running');
    const markerKept0 = before.feed.markerKept || 0, anchors0 = before.cont.stats.anchors;
    await tapHome(pg);
    await pg.waitForTimeout(wait);
    await readToEnd(pg, 12);
    const d = await dom(pg);
    const s = await snap(pg);
    assert.deepEqual(d.slice(0, 3), ['NEW01', 'NEW02', 'F02'], 'Instagram\'s reload, as it sent it');
    assert.ok(!d.includes('EOF'), 'Instagram\'s own end-of-feed block is never drawn mid-feed: ' + d.slice(0, 8).join(' '));
    assert.match(d[3] || '', /^F\d\d$/, 'Following follows Home\'s posts directly');
    assert.equal(s.feed.markerKept || 0, markerKept0);
    assert.equal(s.cont.stats.anchors, anchors0);
    assert.equal(s.cont.stats.state, 'running');
    const tapAt = S.log.findIndex((e, i) => i > 0 && e.who === 'ig' && e.after == null);
    assert.deepEqual(S.log.slice(tapAt).filter(e => e.who === 'ig' && e.token), [], 'no recs_paging_token counting Following posts');
    await context.close();
  });
}

test('fix 2: Instagram stops paging after the marker while Following has more -> the Following card ("stopped"), never "done"', async () => {
  const { pg, context } = await openIG({ home: phoneHome(), follow: range(1, 400), recsMore: false }, { sgCfg: ON });
  await readToEnd(pg, 14);
  const s = await snap(pg);
  assert.equal(s.cont.stats.state, 'stopped');
  assert.equal(s.cont.stats.reason, 'homeEnd');
  assert.equal(s.hasNext, false);
  const last = lastEnd(s);
  assert.equal(last.on, true, 'the card shows');
  assert.notEqual(last.cont, 'done');
  assert.equal(last.contWhy, 'homeEnd');
  await context.close();
});

test('fix 2b: Instagram stops a few pages into Following -> "stopped"; a later reload can go on into Following again', async () => {
  // Instagram's own suggestions paging ends at its third page after the marker.
  const home = phoneHome({ r3: { edges: [recs('XS1'), ad('AS1')], next: 'r4', ps: 'feed_recs', more: false } });
  const follow = S => (S.caughtUpTap ? ['NEW01'] : []).concat(range(1, 400));
  const { pg, S, context } = await openIG({ home, follow }, { sgCfg: ON });
  await readToEnd(pg, 16);
  const s = await snap(pg);
  assert.ok(s.cont.stats.handed > 0);
  assert.equal(s.cont.stats.state, 'stopped');
  assert.notEqual(lastEnd(s).cont, 'done');
  assert.equal(lastEnd(s).on, true);
  // Not a failure: Home's next reload reaches its marker and goes on.
  S.caughtUpTap = true;
  const n = own(S).length;
  await tapHome(pg);
  await pg.waitForTimeout(1500);
  await readToEnd(pg, 8);
  const t = await snap(pg);
  assert.equal(t.cont.stats.state, 'running');
  assert.ok(own(S).length > n);
  await context.close();
});

test('fix 3: two Home-tab reloads 31 s apart whose heads both carry the marker: one start and one reset per reload', async () => {
  const home = phoneHome({ headA: { edges: [friend('NEW01'), ad('A5'), marker()], next: 'hA', ps: 'feed_recs' } });
  const { pg, context } = await openIG({ home, follow: range(1, 400) }, { sgCfg: ON });
  await readToEnd(pg, 8);
  let s = await snap(pg);
  assert.equal(s.cont.stats.startsMin, 1);
  await tapHome(pg);
  await pg.waitForTimeout(1200);
  s = await snap(pg);
  assert.equal(s.cont.stats.headWhy.marker, 2, 'both heads were taken for Home\'s first page');
  assert.equal(s.cont.stats.resets, 1);
  assert.equal(s.cont.stats.startsMin, 2);
  await readToEnd(pg, 6);
  await tapHome(pg);
  await pg.waitForTimeout(1200);
  s = await snap(pg);
  assert.equal(s.cont.stats.state, 'running');
  assert.equal(s.cont.stats.startsMin, 3);
  assert.equal(s.cont.stats.resets, 2);
  await readToEnd(pg, 8);
  s = await snap(pg);
  assert.equal(s.cont.stats.state, 'running');
  assert.ok(s.codes.length > 1, 'Following goes on after the second reload');
  await context.close();
});

test('fix 4: the skip note goes as soon as posts are ready, even with you scrolled up away from the end', async () => {
  const order = [2, 1, 5, 3, 8, 4, 6, 7, 13, 9, 10, 11, 12, 21, 14, 15, 16, 17, 18, 19, 20, 22, 23, 24, 25, 26, 27, 28, 29, 30].map(F);
  const home = { head: { edges: [friend(order[0]), ad('A0'), friend(order[1]), friend(order[2])], next: 'p1' } };
  let i = 3;
  for (let p = 1; p <= 5; p++) {
    const take = order.slice(i, i + 6); i += 6;
    home['p' + p] = { edges: [recs('XH' + p), ...take.slice(0, 3).map(friend), ad('AH' + p), ...take.slice(3).map(friend)], next: 'p' + (p + 1) };
  }
  home.p6 = { edges: [recs('XM1'), ad('AM'), marker()], next: 'm1', ps: 'feed_recs' };
  const { pg, context } = await openIG({ home, follow: range(1, 80), delay: { home: 100, following: 2500 } }, { sgCfg: ON });
  await readToEnd(pg, 12, 300);
  await pg.evaluate(() => { const se = document.scrollingElement; se.scrollTop = se.scrollHeight; });
  assert.ok(await waitFor(pg, async () => (await snap(pg)).skipStatus.some(m => m.on), 15000), 'the note while skipping');
  // You scroll back up about 4 screens.
  await pg.evaluate(() => { const se = document.scrollingElement; se.scrollTop = se.scrollHeight - innerHeight * 5; });
  assert.ok(await waitFor(pg, async () => (await snap(pg)).cont.buffer > 0, 20000), 'posts ready');
  await pg.waitForTimeout(300);
  const s = await snap(pg);
  assert.equal(s.skipStatus[s.skipStatus.length - 1].on, false, 'no "Skipping…" with posts ready');
  await context.close();
});

test('fix 5: the menu switch applies in the page already loaded (off ends a run with the card; on starts at the next marker)', async () => {
  // Off during a run: Home ends with the Following card, and a reload does not start again.
  let { pg, S, context } = await openIG({ home: phoneHome(), follow: range(1, 400) }, { sgCfg: ON });
  await readToEnd(pg, 10);
  assert.equal((await snap(pg)).cont.stats.state, 'running');
  await pg.evaluate(() => window.__sg.onNative({ type: 'contSet', on: false }));
  await readToEnd(pg, 8);
  let s = await snap(pg);
  assert.equal(s.cont.stats.on, false);
  assert.equal(s.cont.stats.state, 'failed');
  assert.equal(s.cont.stats.reason, 'switchedOff');
  assert.equal(s.hasNext, false);
  assert.equal(lastEnd(s).on, true);
  const n = own(S).length;
  await tapHome(pg);
  await pg.waitForTimeout(1500);
  await readToEnd(pg, 6);
  s = await snap(pg);
  assert.equal(own(S).length, n, 'no new run after the switch went off');
  assert.equal(s.hasNext, false);
  await context.close();
  // On in a page loaded with it off: Home goes on from its next marker.
  ({ pg, S, context } = await openIG({ home: phoneHome(), follow: range(1, 400) }, { sgCfg: { continueHome: false } }));
  await pg.evaluate(() => window.__sg.onNative({ type: 'contSet', on: true }));
  await readToEnd(pg, 12);
  s = await snap(pg);
  assert.equal(s.cont.stats.state, 'running');
  assert.ok(s.codes.includes('F04'), 'Following after Home');
  assert.equal(s.feedEnd.some(m => m.on), false);
  await context.close();
});

test('fix 8: the scroll room under a recs-anchored first page goes once Following\'s posts show', async () => {
  const home = { head: { edges: [recs('X0'), recs('X1'), ad('A0')], next: 'h1' },
    h1: { edges: [recs('X2'), ad('A1'), marker()], next: 'm1', ps: 'feed_recs' } };
  const { pg, context } = await openIG({ home, follow: range(1, 200) }, { sgCfg: ON });
  await pg.waitForTimeout(500);
  assert.ok(await pg.evaluate(() => !!document.getElementById('sg-skip-room')), 'stage 1\'s room under the anchor');
  await readToEnd(pg, 8);
  const s = await snap(pg);
  assert.equal(s.cont.stats.state, 'running');
  assert.ok(s.cont.stats.handed > 0);
  assert.ok(await waitFor(pg, () => pg.evaluate(() => !document.getElementById('sg-skip-room')), 3500), 'the room is gone');
  await context.close();
});

for (const kind of ['none', 'smooth']) {
  test('fix 10: a suggestions-only reload after Following ended keeps one hidden suggestion, never an empty list (' + kind + ')', async () => {
    const home = phoneHome({ headA: { edges: [recs('Y0'), ad('A5')], next: 'hA' },
      headB: { edges: [recs('Y1'), recs('Y2'), ad('A6')], next: 'hR' } });
    const { pg, context } = await openIG({ home, follow: ['G1', 'G2', 'G3', 'G4'] }, { sgCfg: ON });
    for (let i = 0; i < 8; i++) { await readToEnd(pg, 6, 300); if ((await snap(pg)).fs.ended) break; }
    let s = await snap(pg);
    assert.equal(s.cont.stats.state, 'done');
    await pg.waitForTimeout(7000);
    await pg.evaluate(k => window.__ig.silentReload(k), kind);
    await pg.waitForTimeout(1500);
    s = await snap(pg);
    assert.equal(s.edges, 1, 'one hidden suggestion');
    assert.equal(s.empty, false, 'never Instagram\'s empty-feed screen');
    assert.deepEqual(await dom(pg), [], 'nothing drawn');
    await context.close();
  });
}

test('fix 13: a restart whose first Following read fails stops Instagram\'s paging (no endless empty pages)', async () => {
  const cfg = { home: phoneHome(), follow: S => (S.caughtUpTap ? ['NEW01'] : []).concat(range(1, 400)) };
  const { pg, S, context } = await openIG(cfg, { sgCfg: ON });
  await readToEnd(pg, 10, 400);
  await pg.waitForTimeout(2500);
  assert.ok((await snap(pg)).cont.buffer > 0, 'posts read but not shown, kept across the reload');
  S.caughtUpTap = true;
  cfg.followFail = { at: S.log.filter(e => e.variant === 'following').length + 1 };
  await tapHome(pg);
  // The restart reads Following's newest page about 3 s after the jump to the top.
  assert.ok(await waitFor(pg, async () => (await snap(pg)).cont.stats.state === 'failed', 8000), 'the restart\'s first read failed');
  const igMid = S.log.filter(e => e.who === 'ig').length;
  await readToEnd(pg, 16, 400);
  const s = await snap(pg);
  assert.equal(s.hasNext, false, 'Instagram stops paging');
  assert.ok(S.log.filter(e => e.who === 'ig').length - igMid <= 2, 'at most a page or two more from Instagram');
  assert.equal(lastEnd(s).on, true);
  assert.equal(lastEnd(s).cont, 'failed');
  await context.close();
});
