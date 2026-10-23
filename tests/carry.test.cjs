// B23: Following opened from the end card starts right past the posts seen
// in Home, with what Home's continuation (R7) already read of Following
// carried over (its cursor and the posts read but not shown), instead of
// paging past every seen post again. Nothing carried, stale or from another
// account: B17's skipping as before. Following opened from the menu: as sent.
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
const lastEnd = s => s.feedEnd[s.feedEnd.length - 1];
const HOME_KEPT = ['F02', 'F01', 'F05', 'F03', 'F08', 'F13', 'F21'];

// The phone's Home; Instagram's own paging after the marker stops at its
// third page (r3), while Following has more: Home ends with the card ("stopped").
function phoneHome(extra) {
  return Object.assign({
    head: { edges: [friend('F02'), ad('A1'), friend('F01'), friend('F05')], next: 'h1' },
    h1: { edges: [recs('X1'), friend('F03'), ad('A2'), friend('F08'), recs('X2'), friend('F13'), ad('A3'), friend('F21')], next: 'h2' },
    h2: { edges: [recs('X3'), recs('X4'), ad('A4'), marker()], next: 'm1', ps: 'feed_recs' },
    r2: { edges: [recs('XS1'), ad('AS1')], next: 'r3', ps: 'feed_recs', more: false },
  }, extra || {});
}
// Home read to its card; returns what Home showed and what the run had.
async function homeToCard(cfg, sgCfg) {
  const o = await openIG(cfg, { sgCfg: sgCfg || ON });
  await readToEnd(o.pg, 12, 350);
  assert.ok(await waitFor(o.pg, async () => { const s = await snap(o.pg); return lastEnd(s) && lastEnd(s).on; }, 15000), 'the card');
  await o.pg.waitForTimeout(600);   // a read on its way lands
  o.home = await snap(o.pg);
  return o;
}
async function tapFollowing(o) {
  const n = o.S.log.length;
  await Promise.all([o.pg.waitForURL(/variant=following/), o.pg.evaluate(() => window.__sg.onNative({ type: 'continueFeed', variant: 'following' }))]);
  await o.pg.waitForFunction(() => window.__ig && window.__ig.conn, null, { timeout: 5000 });
  return n;
}
const igFollowing = (S, from) => S.log.slice(from).filter(e => e.who === 'ig' && e.variant === 'following');

test('B23 the card\'s Following starts right past the posts seen in Home: the carried posts first, then on from the carried cursor, no repeats, no gaps', { timeout: 90000 }, async () => {
  const o = await homeToCard({ home: phoneHome(), follow: range(1, 400) });
  const { pg, S } = o;
  const h = o.home;
  assert.equal(h.cont.stats.state, 'stopped');
  assert.ok(h.cont.buffer > 0, 'posts read but not shown');
  const homeShown = h.codes;
  const carriedCursor = h.cont.cursor;
  const from = await tapFollowing(o);
  await pg.waitForTimeout(300);
  let s = await snap(pg);
  assert.equal(s.feed.carry, 'used');
  assert.equal(s.feed.carried, h.cont.buffer);
  const want = range(1, 400).filter(c => !homeShown.includes(c));
  assert.deepEqual(s.codes, want.slice(0, s.codes.length), 'the first unseen posts, in Following\'s order');
  assert.ok(s.codes.length >= h.cont.buffer, 'one page, at once: ' + s.codes.length);
  assert.equal(s.cursor, carriedCursor, 'Relay\'s cursor is the carried one');
  assert.equal(s.hasNext, true);
  assert.equal(s.feed.anchor || 0, 0, 'no seen post kept as a starting point');
  assert.equal(s.skipStatus.some(m => m.on && m.kind === 'skipping'), false, 'no "Skipping…"');
  // Instagram's next request goes on from the carried cursor.
  await readToEnd(pg, 6, 350);
  s = await snap(pg);
  const ig = igFollowing(S, from);
  assert.equal(ig[0].after, null, 'its own first page');
  assert.equal(ig[1].after, carriedCursor, 'then right past what Home\'s continuation read');
  assert.deepEqual(s.codes, want.slice(0, s.codes.length), 'no gaps, no repeats');
  assert.deepEqual(dupes(s.codes), []);
  assert.ok(s.codes.length > h.cont.buffer + 12);
  // Shapes only in the trail.
  const tr = await pg.evaluate(() => window.__sg.trail().filter(e => e.cy != null));
  assert.equal(tr.length, 1);
  assert.equal(tr[0].cy, h.cont.buffer);
  assert.equal(tr[0].cr, 'used', 'the outcome kept in the trail');
  await o.context.close();
});

test('B23 a carried post that is also on Instagram\'s first page shows once, in Instagram\'s place', { timeout: 60000 }, async () => {
  // Home showed only F02 and F01; Instagram stops right after the marker, before the
  // slow first read of Following lands, so Following's F03 is carried (and on Instagram's first page).
  const home = {
    head: { edges: [friend('F02'), ad('A1'), friend('F01')], next: 'h1' },
    h1: { edges: [recs('X3'), ad('A4'), marker()], next: 'm1', ps: 'feed_recs' },
    m1: { edges: [recs('XS1'), ad('AS1')], next: 'r1', ps: 'feed_recs', more: false },
  };
  const o = await homeToCard({ home, follow: range(1, 400), delay: { home: 100, following: 1500 } });
  assert.deepEqual(o.home.codes, ['F02', 'F01']);
  assert.equal(o.home.cont.buffer, 1);
  await tapFollowing(o);
  await o.pg.waitForTimeout(300);
  let s = await snap(o.pg);
  assert.equal(s.feed.carry, 'cursor');
  assert.equal(s.feed.carried, 0, 'the carried copy is left out');
  assert.equal(s.codes[0], 'F03');
  assert.ok(await waitFor(o.pg, async () => { await readToEnd(o.pg, 1, 300); return (await snap(o.pg)).codes.length > 3; }, 10000), 'Following goes on');
  s = await snap(o.pg);
  assert.deepEqual(dupes(s.codes), []);
  assert.deepEqual(s.codes, range(3, 2 + s.codes.length));
  await o.context.close();
});

test('B23 Following used up in Home (done): the card\'s Following says "Nothing new since Home" at once, with one request', { timeout: 60000 }, async () => {
  const o = await homeToCard({ home: phoneHome({ r2: undefined }), follow: range(1, 30) });
  assert.equal(o.home.cont.stats.state, 'done');
  const from = await tapFollowing(o);
  await o.pg.waitForTimeout(800);
  const s = await snap(o.pg);
  assert.equal(s.feed.carry, 'cursor');
  assert.equal(s.codes.length, 1, 'one seen post kept as a starting point (never an empty first page)');
  assert.equal(s.hasNext, false);
  assert.ok(s.skipStatus.some(m => m.on && m.kind === 'nothingNew'), 'nothing new, said at once');
  assert.equal(igFollowing(o.S, from).length, 1, 'no paging past seen posts');
  await o.context.close();
});

test('B23 posts new since Home\'s reading fill Instagram\'s first page: the carried start is not used (no gap), B17\'s skipping instead', { timeout: 60000 }, async () => {
  const follow = S => (S.fresh ? ['N1', 'N2', 'N3', 'N4'] : []).concat(range(1, 400));
  const o = await homeToCard({ home: phoneHome(), follow });
  o.S.fresh = true;
  await tapFollowing(o);
  await readToEnd(o.pg, 4, 350);
  const s = await snap(o.pg);
  assert.equal(s.feed.carry, 'new');
  assert.deepEqual(s.codes.slice(0, 4), ['N1', 'N2', 'N3', 'N4'], 'every new post');
  assert.equal(s.codes.some(c => o.home.codes.includes(c)), false, 'seen posts still skipped');
  await o.context.close();
});

test('B23 nothing carried with the switch off: B17\'s skipping as before (a seen post as the starting point)', { timeout: 60000 }, async () => {
  const o = await homeToCard({ home: phoneHome(), follow: range(1, 400) }, { continueHome: false });
  await tapFollowing(o);
  await o.pg.waitForTimeout(300);
  const s = await snap(o.pg);
  assert.equal(s.feed.carry, 'none');
  assert.equal(s.feed.anchor, 1);
  assert.deepEqual(s.feed.anchorKind, { seen: 1, marker: 0, recs: 0 });
  await o.context.close();
});

for (const [why, change] of [['stale', c => { c.at -= 6 * 60000; }], ['acct', c => { c.acct = '999'; }]]) {
  test(`B23 carried data ${why === 'stale' ? 'older than 5 minutes' : 'from another account'} is ignored: B17's skipping`, { timeout: 60000 }, async () => {
    const o = await homeToCard({ home: phoneHome(), follow: range(1, 400) });
    // The card's button, with the carried data then changed in storage before the page loads.
    await Promise.all([o.pg.waitForURL(/variant=following/), o.pg.evaluate(src => {
      const change = eval(src);
      const set = sessionStorage.setItem.bind(sessionStorage);
      sessionStorage.setItem = (k, v) => {
        if (k === 'sg_skip_seen') { const o = JSON.parse(v); if (o.carry) change(o.carry); v = JSON.stringify(o); }
        return set(k, v);
      };
      window.__sg.onNative({ type: 'continueFeed', variant: 'following' });
    }, change.toString())]);
    await o.pg.waitForFunction(() => window.__ig && window.__ig.conn, null, { timeout: 5000 });
    await o.pg.waitForTimeout(300);
    const s = await snap(o.pg);
    assert.equal(s.feed.carry, why);
    assert.equal(s.feed.anchor, 1, 'a seen post as the starting point');
    assert.equal(s.cursor, 'f3', 'Instagram\'s own cursor');
    await o.context.close();
  });
}

test('B23 Following opened from the menu is unchanged: Instagram\'s pages as sent, nothing carried', { timeout: 60000 }, async () => {
  const o = await homeToCard({ home: phoneHome(), follow: range(1, 400) });
  await Promise.all([o.pg.waitForURL(/variant=following/), o.pg.evaluate(() => location.assign('/?variant=following'))]);
  await o.pg.waitForFunction(() => window.__ig && window.__ig.conn, null, { timeout: 5000 });
  await o.pg.waitForTimeout(300);
  const s = await snap(o.pg);
  assert.equal(s.feed.carry, undefined);
  assert.deepEqual(s.codes, ['F01', 'F02', 'F03'], 'its first page as sent, seen posts included');
  assert.equal(s.cursor, 'f3');
  await o.context.close();
});

test('B23 a refreshed Home showed posts newer than R7\'s reading (R7 failed, so no new read): a seen post is no proof, B17\'s skipping shows every new post', { timeout: 120000 }, async () => {
  const home = Object.assign(phoneHome(), {
    headA: { edges: [friend('N4'), friend('N3'), ad('A5'), friend('F02')], next: 'hA' },
    headB: { edges: [friend('N4'), friend('N3'), ad('A6'), marker()], next: 'hB', ps: 'feed_recs' },
    hA: { edges: [recs('X5'), ad('A7'), marker()], next: 'mA', ps: 'feed_recs' },
  });
  delete home.r2;
  const cfg = { home, follow: S => (S.fresh ? ['N4', 'N3', 'N2', 'N1'] : []).concat(range(1, 400)) };
  const o = await openIG(cfg, { sgCfg: ON });
  const { pg, S } = o;
  await readToEnd(pg, 8, 350);
  // A read of Following fails: Home's continuation is over for this page load.
  cfg.followFail = { at: S.log.filter(e => e.variant === 'following').length + 1, status: 500 };
  assert.ok(await waitFor(pg, async () => { await readToEnd(pg, 2, 350); return (await snap(pg)).cont.stats.state === 'failed'; }, 30000), 'failed');
  delete cfg.followFail;
  // Friends post N4..N1; the Home tab refreshes Home, which leads with N4 N3, then the marker.
  S.fresh = true;
  await pg.evaluate(() => { window.__ig.lastHeadLoad -= 31000; document.getElementById('home').click(); });
  await pg.waitForTimeout(1500);
  await readToEnd(pg, 8, 350);
  const h = await snap(pg);
  assert.ok(h.codes.includes('N4') && h.codes.includes('N3'), 'Home showed N4 N3');
  assert.ok(!h.codes.includes('N2') && !h.codes.includes('N1'));
  await tapFollowing(o);
  await readToEnd(pg, 6, 350);
  const s = await snap(pg);
  assert.equal(s.feed.carry, 'new', 'the carried cursor is not used');
  assert.ok(s.codes.includes('N2') && s.codes.includes('N1'), 'every new post: ' + s.codes.slice(0, 8).join(' '));
  assert.equal(s.codes.some(c => h.codes.includes(c)), false, 'seen posts still skipped');
  const tr = await pg.evaluate(() => window.__sg.trail().filter(e => e.cr != null));
  assert.equal(tr.length, 1);
  assert.equal(tr[0].cr, 'new');
  await o.context.close();
});

// Following's posts with a large payload (about 80 K characters each), like carousels and videos.
const bigUnit = code => { const u = friend(code); u.node.media.video_dash_manifest = 'x'.repeat(80000); return [u]; };
// The card's button, with sessionStorage refusing the entry with the carried posts (a full storage).
async function tapFollowingQuota(o) {
  await Promise.all([o.pg.waitForURL(/variant=following/), o.pg.evaluate(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (k === 'sg_skip_seen' && String(v).includes('"edges":[')) throw new DOMException('full', 'QuotaExceededError');
      return set.call(this, k, v);
    };
    window.__sg.onNative({ type: 'continueFeed', variant: 'following' });
  })]);
  await o.pg.waitForFunction(() => window.__ig && window.__ig.conn, null, { timeout: 5000 });
}
for (const [why, cfg, tap] of [
  ['big', { follow: range(1, 400), followUnit: bigUnit, followFirst: 30 }, tapFollowing],
  ['many', { follow: range(1, 400), followFirst: 100 }, tapFollowing],
  ['quota', { follow: range(1, 400) }, tapFollowingQuota],
]) {
  test(`B23 a carry left behind (${why}) says why in Filter status and the trail, and B17's skipping takes over`, { timeout: 90000 }, async () => {
    const o = await homeToCard(Object.assign({ home: phoneHome() }, cfg));
    assert.ok(o.home.cont.buffer > 0, 'posts read but not shown');
    await tap(o);
    await o.pg.waitForTimeout(400);
    const s = await snap(o.pg);
    assert.equal(s.feed.carry, why);
    assert.ok(s.feed.carryN > 0 && s.feed.carryN >= o.home.cont.buffer - 1, 'posts left behind: ' + s.feed.carryN);
    if (why === 'big') assert.ok(s.feed.carryChars > 1000000, String(s.feed.carryChars));
    if (why === 'many') assert.ok(s.feed.carryN > 48);
    assert.equal(s.feed.anchor, 1, 'a seen post as the starting point (B17)');
    const tr = await o.pg.evaluate(() => window.__sg.trail().filter(e => e.cr != null));
    assert.equal(tr.length, 1);
    assert.equal(tr[0].cr, why);
    assert.doesNotMatch(JSON.stringify(tr) + JSON.stringify({ c: s.feed.carry, n: s.feed.carryN }), /F\d\d|"f\d+"/);
    await o.context.close();
  });
}
