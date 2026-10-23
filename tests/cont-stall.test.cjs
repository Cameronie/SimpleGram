// R7 review fixes that need real waiting (continueHome on): an own Following
// read that never answers is given up in time (the card, no false "Skipping…"),
// and the 20-a-minute pacing wait is not a stall. Same mock page and server
// as cont.test.cjs; nothing reaches Instagram.
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

function phoneHome() {
  return {
    head: { edges: [friend('F02'), ad('A1'), friend('F01'), friend('F05')], next: 'h1' },
    h1: { edges: [recs('X1'), friend('F03'), ad('A2'), friend('F08'), recs('X2'), friend('F13'), ad('A3'), friend('F21')], next: 'h2' },
    h2: { edges: [recs('X3'), recs('X4'), ad('A4'), marker()], next: 'm1', ps: 'feed_recs' },
  };
}

test('fix 6: a Following read that never answers fails after about 20 s: the card, and no "Skipping…" note', { timeout: 120000 }, async () => {
  const { pg, S, context } = await openIG({ home: phoneHome(), follow: range(1, 400), delay: { home: 100, following: 60000 } }, { sgCfg: ON });
  await readToEnd(pg, 10, 400);
  assert.ok(await waitFor(pg, async () => own(S).length >= 1, 5000));
  const t0 = Date.now();
  assert.ok(await waitFor(pg, async () => (await snap(pg)).cont.stats.state === 'failed', 26000), 'given up');
  assert.ok(Date.now() - t0 < 24000);
  await readToEnd(pg, 3, 400);
  const s = await snap(pg);
  assert.equal(s.cont.stats.reason, 'request');
  assert.equal(s.cont.inFlight, false);
  assert.equal(own(S).length, 1, 'no retry');
  assert.equal(s.hasNext, false, 'Instagram stops paging');
  assert.equal(lastEnd(s).on, true, 'the card shows');
  assert.equal(lastEnd(s).cont, 'failed');
  assert.equal(s.skipStatus.some(m => m.on && m.kind === 'homeSkipping'), false, 'nothing was skipped');
  const log = await pg.evaluate(() => window.__sg.gqlLog.filter(e => /^PolarisFeed/.test(e.query)).map(e => [e.message, e.timedOut]));
  assert.deepEqual(log, [['timed out', true]]);
  await context.close();
});

test('fix 9: while the 20-a-minute pacing holds the next own read, no "Home isn\'t loading more" card', { timeout: 120000 }, async () => {
  // Following pages that bring nothing to show (ads only): many reads, pacing.
  const follow = Array.from({ length: 400 }, (_, i) => 'Q' + String(i + 1).padStart(3, '0'));
  const followUnit = c => [ad('Z' + c)];
  const { pg, S, context } = await openIG({ home: phoneHome(), follow, followUnit }, { sgCfg: ON });
  await readToEnd(pg, 10, 400);
  await pg.evaluate(() => { const se = document.scrollingElement; se.scrollTop = se.scrollHeight; });
  assert.ok(await waitFor(pg, async () => own(S).length >= 20, 30000), '20 own reads');
  // You wait at the bottom; now and then a small swipe (Home asks again, gets nothing).
  for (let i = 0; i < 12; i++) {
    await pg.waitForTimeout(2500);
    await pg.evaluate(() => { const se = document.scrollingElement; se.scrollTop = se.scrollHeight - 2; });
  }
  const s = await snap(pg);
  assert.equal(own(S).length, 20, 'still paced');
  assert.equal(s.cont.stats.state, 'running');
  assert.equal(s.feedEnd.filter(m => m.on && m.stalled).length, 0, 'no stalled card while SimpleGram waits for its turn');
  await context.close();
});
