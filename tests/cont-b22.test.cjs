// B22: while Home goes on into Following (continueHome on), the "Home isn't
// loading more" card never shows as long as the continuation is still
// working (a read on its way or paced, the buffer filling, Instagram's own
// next page pending); at most the app's quiet "Loading more from people you
// follow…" note. Two of Instagram's pages are kept ready. The card still
// comes for a real failure, or when Instagram stops asking for ready posts.
// Same mock page and server as cont.test.cjs; nothing reaches Instagram.
//
// Run: NODE_PATH=/opt/node-tools/node_modules node --test tests/*.test.cjs
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useBrowser, openIG, readToEnd, readScreens, snap, waitFor, friend, recs, ad, marker } = require('./r7-harness.cjs');

useBrowser();
const ON = { continueHome: true };
const F = n => 'F' + String(n).padStart(2, '0');
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => F(a + i));
const own = S => S.log.filter(e => e.who === 'sg');
const lastEnd = s => s.feedEnd[s.feedEnd.length - 1];
const stalledCards = s => s.feedEnd.filter(m => m.on && m.stalled);
const chips = (s, kind) => s.skipStatus.filter(m => m.on && m.kind === kind);

function phoneHome() {
  return {
    head: { edges: [friend('F02'), ad('A1'), friend('F01'), friend('F05')], next: 'h1' },
    h1: { edges: [recs('X1'), friend('F03'), ad('A2'), friend('F08'), recs('X2'), friend('F13'), ad('A3'), friend('F21')], next: 'h2' },
    h2: { edges: [recs('X3'), recs('X4'), ad('A4'), marker()], next: 'm1', ps: 'feed_recs' },
  };
}
// Sitting at the very bottom (no scrolling), checking now and then.
async function sitAtBottom(pg, ms) {
  await pg.evaluate(() => { const se = document.scrollingElement; se.scrollTop = se.scrollHeight; });
  await pg.waitForTimeout(ms);
}

test('B22 two pages kept ready: about 24 Following posts read ahead, one read at a time, refilled as Instagram takes them', { timeout: 60000 }, async () => {
  const { pg, S, context } = await openIG({ home: phoneHome(), follow: range(1, 400) }, { sgCfg: ON });
  await readToEnd(pg, 6, 300);
  assert.ok(await waitFor(pg, async () => (await snap(pg)).cont.buffer >= 24, 10000), 'two pages ready');
  // Scrolled up, away from the end: Instagram doesn't ask, and nothing more is read.
  await pg.evaluate(() => { document.scrollingElement.scrollTop = 0; });
  await pg.waitForTimeout(400);
  const n = own(S).length;
  await pg.waitForTimeout(2500);
  let s = await snap(pg);
  assert.equal(own(S).length, n, 'no reads past two pages');
  assert.ok(s.cont.buffer >= 24 && s.cont.buffer < 24 + 12, 'buffer ' + s.cont.buffer);
  assert.equal(S.inflight.maxSg, 1, 'one own request at a time');
  // Instagram takes a page: the buffer is filled again to two pages.
  const handed = s.cont.stats.handed;
  await readToEnd(pg, 4, 300);
  assert.ok(await waitFor(pg, async () => { const t = await snap(pg); return t.cont.stats.handed > handed && t.cont.buffer >= 24; }, 10000), 'refilled');
  s = await snap(pg);
  assert.equal(S.inflight.maxSg, 1);
  assert.ok(s.cont.stats.peakMin <= 20);
  await context.close();
});

test('B22 a fast reader while Instagram\'s own next page takes 17 s: no stalled card, the quiet note, and the wait is recorded as Instagram\'s', { timeout: 90000 }, async () => {
  // Instagram's second page after the marker is slow; the posts for it are ready.
  const { pg, S, context } = await openIG({ home: phoneHome(), follow: range(1, 400), delay: { home: 100, following: 150, recs: n => n === 2 ? 17000 : 150 } }, { sgCfg: ON });
  await readToEnd(pg, 8, 300);
  await readScreens(pg, 4000, 3);
  assert.ok(await waitFor(pg, async () => S.recsN >= 2, 15000), 'Instagram asked for its second page after the marker');
  const t0 = Date.now();
  // You wait at the very bottom (now and then a small swipe).
  while (Date.now() - t0 < 19000) {
    await pg.waitForTimeout(1500);
    await pg.evaluate(() => { const se = document.scrollingElement; se.scrollTop = se.scrollHeight; });
  }
  assert.ok(await waitFor(pg, async () => (await snap(pg)).cont.stats.swaps >= 2, 5000), 'the slow page arrived');
  await pg.evaluate(() => { const se = document.scrollingElement; se.scrollTop = 0; });
  await pg.waitForTimeout(800);
  const s = await snap(pg);
  assert.equal(stalledCards(s).length, 0, 'no "Home isn\'t loading more" while the continuation works');
  assert.equal(s.feedEnd.some(m => m.on), false, 'no card at all');
  assert.equal(s.cont.stats.state, 'running');
  assert.ok(chips(s, 'homeLoading').length >= 1, 'the quiet note showed');
  assert.equal(s.cont.chip, '', 'and went');
  assert.equal(s.skipStatus[s.skipStatus.length - 1].on, false);
  const W = s.cont.stats.waits;
  assert.ok(W.n >= 1 && W.longest >= 12000, JSON.stringify(W));
  assert.ok(W.why.ig >= 10000, 'waited on Instagram\'s page: ' + JSON.stringify(W.why));
  assert.ok(W.notes >= 1);
  assert.equal(W.cards, 0);
  assert.ok(W.last.some(e => e.ms >= 12000 && e.i >= 10000 && e.end === 'posts'), JSON.stringify(W.last));
  // Shapes and timings only.
  assert.doesNotMatch(JSON.stringify(W), /F\d\d|X\d|"f\d+"|instagram/);
  const trail = await pg.evaluate(() => window.__sg.trail().filter(e => e.ev === 'wait'));
  assert.ok(trail.length >= 1 && trail.every(e => typeof e.ms === 'number' && !('code' in e)), JSON.stringify(trail));
  await context.close();
});

test('B22 slow Following reads and a fast reader: Home runs dry, the note says "Loading more", never the card; the wait is "reading"', { timeout: 90000 }, async () => {
  const { pg, S, context } = await openIG({ home: phoneHome(), follow: range(1, 400), delay: { home: 100, following: 6000 } }, { sgCfg: ON });
  await readToEnd(pg, 8, 300);
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) await readScreens(pg, 1500, 4);
  const s = await snap(pg);
  assert.ok(s.cont.stats.handed >= 12, 'Following came: ' + s.cont.stats.handed);
  assert.equal(stalledCards(s).length, 0);
  assert.equal(s.feedEnd.some(m => m.on), false);
  assert.ok(chips(s, 'homeLoading').length >= 1, 'the note while it read');
  assert.ok(s.cont.stats.waits.why.read >= 3000, JSON.stringify(s.cont.stats.waits));
  assert.equal(S.inflight.maxSg, 1);
  await context.close();
});

test('B22 a finger held down eats the nudge: once posts are ready the nudges keep trying, and Instagram asks without another swipe', { timeout: 90000 }, async () => {
  // Instagram's list here pages on real scrolls only (synthetic scroll events are ignored);
  // each slow read of Following fills the buffer at once, so no later read nudges again.
  const { pg, S, context } = await openIG({ home: phoneHome(), follow: range(1, 400), followFirst: 30, delay: { home: 100, following: 6000 } },
    { sgCfg: ON, igP: { trustedOnly: true } });
  await readToEnd(pg, 8, 300);
  // Through what is ready, until Instagram's page comes back without Following (the buffer ran dry).
  assert.ok(await waitFor(pg, async () => { await readScreens(pg, 400, 4); const t = await snap(pg); return t.cont.waiting && t.cont.buffer === 0; }, 40000), 'ran dry');
  // A finger stays down at the bottom while the next read lands (its nudge is synthetic only).
  await pg.evaluate(() => { const se = document.scrollingElement; se.scrollTop = se.scrollHeight;
    window.dispatchEvent(new TouchEvent('touchstart', { bubbles: true })); });
  assert.ok(await waitFor(pg, async () => (await snap(pg)).cont.buffer > 0, 10000), 'posts ready');
  await pg.waitForTimeout(1200);
  const swaps = (await snap(pg)).cont.stats.swaps;
  await pg.evaluate(() => window.dispatchEvent(new TouchEvent('touchend', { bubbles: true })));
  // No more scrolling of yours: the nudges that keep trying bring Instagram's next page.
  assert.ok(await waitFor(pg, async () => (await snap(pg)).cont.stats.swaps > swaps, 12000), 'Instagram asked again');
  const s = await snap(pg);
  assert.equal(stalledCards(s).length, 0);
  assert.ok(s.feed.nudges >= 2);
  await context.close();
});

test('B22 a real failure still shows the card: Following refused mid-scroll, with a fast reader', { timeout: 60000 }, async () => {
  const { pg, S, context } = await openIG({ home: phoneHome(), follow: range(1, 400), followFail: { at: 4 } }, { sgCfg: ON });
  await readToEnd(pg, 8, 300);
  const t0 = Date.now();
  while (Date.now() - t0 < 12000 && (await snap(pg)).cont.stats.state === 'running') await readScreens(pg, 1000, 4);
  await readToEnd(pg, 6, 300);
  const s = await snap(pg);
  assert.equal(s.cont.stats.state, 'failed');
  assert.equal(lastEnd(s).on, true, 'the card');
  assert.equal(lastEnd(s).cont, 'failed');
  assert.equal(s.cont.chip, '', 'no note with the card');
  assert.equal(own(S).length, 4, 'no retries');
  await context.close();
});

test('B22 Instagram stops asking for ready posts: after about 40 s at the bottom the card shows, and Copy details has the wait', { timeout: 120000 }, async () => {
  // Instagram's second page after the marker never comes back in time.
  const { pg, S, context } = await openIG({ home: phoneHome(), follow: range(1, 400), delay: { home: 100, following: 150, recs: n => n === 2 ? 90000 : 150 } }, { sgCfg: ON });
  await readToEnd(pg, 8, 300);
  await readScreens(pg, 4000, 3);
  assert.ok(await waitFor(pg, async () => S.recsN >= 2, 15000));
  const t0 = Date.now();
  let shownAt = 0;
  while (Date.now() - t0 < 50000 && !shownAt) {
    await sitAtBottom(pg, 1000);
    const s = await snap(pg);
    if (stalledCards(s).length) shownAt = Date.now() - t0;
    if (!shownAt && Date.now() - t0 < 30000) assert.equal(s.feedEnd.some(m => m.on), false, 'no card before 30 s');
  }
  assert.ok(shownAt >= 30000 && shownAt <= 50000, 'the stalled card at ' + shownAt);
  const s = await snap(pg);
  assert.equal(s.cont.stats.state, 'running', 'not a failure of ours: if Instagram asks later, Home goes on');
  assert.equal(s.cont.stats.waits.cards, 1);
  assert.equal(s.cont.stats.waits.atCard.why, 'ig');
  assert.ok(s.cont.stats.waits.atCard.ms >= 30000 && s.cont.stats.waits.atCard.buffer > 0, JSON.stringify(s.cont.stats.waits.atCard));
  await context.close();
});
