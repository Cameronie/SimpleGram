// B32 (continueHome on): Home runs out of friends' posts without Instagram's
// "You're all caught up" marker (Cam's Copy details: five friends' posts, then
// only suggestions, no line, the card after four empty pages). The second page
// in a row without a friend's post, or a page Instagram labels as its
// suggestions (feed_recs), is Home's end: Following follows under SimpleGram's
// own line, as after a marker. Instagram's marker arriving later in such a run
// is cut there (a next page, not a reload); a Home that showed nothing from
// friends keeps to the card. Same mock page and server as cont.test.cjs;
// nothing reaches Instagram.
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
const HOME_KEPT = ['F02', 'F01', 'F05', 'F03', 'F08', 'F13', 'F21'];
const unseen = list => list.filter(c => !HOME_KEPT.includes(c));
const dupes = a => a.filter((c, i) => a.indexOf(c) !== i);
const own = S => S.log.filter(e => e.who === 'sg');
const lastEnd = s => s.feedEnd[s.feedEnd.length - 1];
// The posts drawn with SimpleGram's line above them.
const lined = pg => pg.evaluate(() => Array.from(document.querySelectorAll('article[data-code]'))
  .filter(a => /caught up/.test(getComputedStyle(a, '::before').content)).map(a => a.dataset.code));
// What shows: the posts drawn, less R7's hidden suggestion anchors (on pages
// Instagram does not label as its suggestions, an empty handover keeps one).
const shown = pg => pg.evaluate(() => Array.from(document.querySelectorAll('article[data-code]'))
  .filter(a => getComputedStyle(a).display !== 'none').map(a => a.dataset.code));

// Cam's Home of B32: friends' posts, then suggestions only, never the marker,
// and no label on the pages (the server's later pages carry none either).
function noLineHome(extra) {
  return Object.assign({
    head: { edges: [friend('F02'), ad('A1'), friend('F01'), friend('F05')], next: 'h1' },
    h1: { edges: [recs('X1'), friend('F03'), ad('A2'), friend('F08'), recs('X2'), friend('F13'), ad('A3'), friend('F21')], next: 'h2' },
    h2: { edges: [recs('X3'), recs('X4'), ad('A4')], next: 'h3' },
    h3: { edges: [recs('X5'), ad('A5'), recs('X6')], next: 'm1' },
  }, extra || {});
}
// The phone's Home with the marker (cont.test.cjs).
function markerHome() {
  return {
    head: { edges: [friend('F02'), ad('A1'), friend('F01'), friend('F05')], next: 'h1' },
    h1: { edges: [recs('X1'), friend('F03'), ad('A2'), friend('F08'), recs('X2'), friend('F13'), ad('A3'), friend('F21')], next: 'h2' },
    h2: { edges: [recs('X3'), recs('X4'), ad('A4'), marker()], next: 'm1', ps: 'feed_recs' },
  };
}

test('B32 no marker, unlabelled suggestion pages: the second page without friends\' posts starts Following, under one line, no card', async () => {
  const { pg, S, context } = await openIG({ home: noLineHome(), follow: range(1, 400), recsPs: null }, { sgCfg: ON });
  await readToEnd(pg, 16);
  const s = await snap(pg);
  const visible = await shown(pg);
  assert.deepEqual(visible.slice(0, 7), HOME_KEPT, 'Home first, as Instagram ranked it');
  const after = visible.slice(7);
  assert.ok(after.length >= 12, 'Following went on: ' + after.length);
  assert.deepEqual(after, unseen(range(1, 400)).slice(0, after.length), 'Following, newest first, without what Home showed');
  assert.deepEqual(dupes(s.codes), []);
  assert.ok(s.codes.length - visible.length <= 10, 'hidden anchors only, a few at most: ' + (s.codes.length - visible.length));
  assert.equal(s.cont.stats.state, 'running');
  assert.equal(s.cont.stats.startVia, 'noLine');
  assert.equal(s.cont.stats.headWhy.noLine, 1);
  assert.equal(s.cont.stats.headWhy.marker, 0);
  assert.equal(s.feed.eof || 0, 0, 'Instagram never sent its marker');
  assert.equal(s.feed.stopped, 0, 'Home was not stopped by the four-empty-pages rule');
  assert.equal(s.fs.caughtUp, true);
  assert.equal(s.fs.ended, false);
  assert.equal(s.feedEnd.some(m => m.on), false, 'no card while Home goes on');
  assert.deepEqual(await lined(pg), ['F04'], 'one line, above Following\'s first post');
  // The empty pages: h2 (the first without friends' posts) was let through as a gap, h3 started it.
  const ig = S.log.filter(e => e.who === 'ig');
  assert.ok(ig.some(e => e.after === 'h3'), 'Instagram asked for the page after h3: paging stayed on');
  assert.ok(own(S).length >= 1, 'Following was read');
  assert.equal(s.cont.stats.repeats, 0);
  await pg.waitForTimeout(3200);
  const st = (await snap(pg)).cont.stats;
  assert.equal(st.runs.length, 1);
  assert.equal(st.runs[0].drawn, true);
  assert.equal(st.runs[0].line, true);
  await context.close();
});

test('B32 no marker, Home turns to its suggestions (feed_recs): Following starts at that page', async () => {
  const home = noLineHome({ h2: { edges: [recs('X3'), recs('X4'), ad('A4')], next: 'm1', ps: 'feed_recs' } });
  delete home.h3;
  const { pg, S, context } = await openIG({ home, follow: range(1, 400) }, { sgCfg: ON });
  await readToEnd(pg, 14);
  const s = await snap(pg);
  assert.deepEqual(s.codes.slice(0, 7), HOME_KEPT);
  const after = s.codes.slice(7);
  assert.ok(after.length >= 12, 'Following went on: ' + after.length);
  assert.deepEqual(after, unseen(range(1, 400)).slice(0, after.length));
  assert.equal(s.cont.stats.state, 'running');
  assert.equal(s.cont.stats.startVia, 'noLine');
  assert.equal(s.cont.stats.headWhy.noLine, 1);
  assert.equal(s.feed.recsPages, 1, 'the labelled page ended Home');
  assert.equal(s.feedEnd.some(m => m.on), false);
  assert.deepEqual(await lined(pg), ['F04']);
  assert.ok(own(S).length >= 1);
  await context.close();
});

test('B32 after a start without the line, Instagram\'s marker on a later page comes late: cut there, not a reload; Following goes on under the one line', async () => {
  const home = noLineHome({ h3: { edges: [recs('X5'), ad('A5'), recs('X6')], next: 'h4' },
    h4: { edges: [recs('X7'), ad('A6'), marker()], next: 'm1', ps: 'feed_recs' } });
  const { pg, S, context } = await openIG({ home, follow: range(1, 400), recsPs: null }, { sgCfg: ON });
  await readToEnd(pg, 18);
  const s = await snap(pg);
  const visible = await shown(pg);
  assert.deepEqual(visible.slice(0, 7), HOME_KEPT);
  const after = visible.slice(7);
  assert.ok(after.length >= 12, 'Following went on: ' + after.length);
  assert.deepEqual(after, unseen(range(1, 400)).slice(0, after.length));
  assert.deepEqual(dupes(s.codes), []);
  assert.equal(s.cont.stats.state, 'running');
  assert.equal(s.cont.stats.startVia, 'noLine');
  assert.equal(s.cont.stats.lateMarker, 1);
  assert.deepEqual([s.cont.stats.resets, s.cont.stats.heads, s.cont.stats.headWhy.marker], [0, 0, 0], 'not taken for a reload');
  assert.equal(s.feed.eof, 1, 'the marker was cut');
  assert.equal(s.feed.refreshes || 0, 0);
  assert.equal(await pg.evaluate(() => document.querySelectorAll('.eof').length), 0, 'Instagram never drew its line');
  assert.deepEqual(await lined(pg), ['F04'], 'one line, above Following\'s first post');
  assert.equal(s.fs.endText && s.fs.endText.title, "You're all caught up", 'the card would carry Instagram\'s words');
  assert.equal(s.fs.cont, true);
  assert.equal(s.fs.ended, false);
  assert.equal(s.feedEnd.some(m => m.on), false, 'no card while Home goes on');
  const ig = S.log.filter(e => e.who === 'ig');
  assert.ok(ig.some(e => e.after === 'm1'), 'Instagram paged on past the marker');
  assert.equal(s.cont.stats.repeats, 0);
  await pg.waitForTimeout(3200);
  const st = (await snap(pg)).cont.stats;
  assert.equal(st.runs.length, 1, 'one run');
  assert.equal(st.runs[0].line, true);
  await context.close();
});

test('B32 a Home with nothing from friends (a hidden anchor only) never starts Following by itself: the card after four pages, as before', async () => {
  const home = {
    head: { edges: [recs('X1'), ad('A1'), recs('X2')], next: 'h1' },
    h1: { edges: [recs('X3'), recs('X4'), ad('A2')], next: 'h2' },
    h2: { edges: [recs('X5'), ad('A3')], next: 'h3' },
    h3: { edges: [recs('X6'), recs('X7')], next: 'm1' },
  };
  const { pg, S, context } = await openIG({ home, follow: range(1, 400), recsPs: null }, { sgCfg: ON });
  await readToEnd(pg, 14);
  assert.ok(await waitFor(pg, async () => (await snap(pg)).fs.ended, 8000), 'Home ended');
  await pg.evaluate(() => { const se = document.scrollingElement; se.scrollTop = se.scrollHeight; });
  assert.ok(await waitFor(pg, async () => { const s = await snap(pg); return s.feedEnd.length && lastEnd(s).on; }, 6000), 'the card shows');
  const s = await snap(pg);
  assert.deepEqual(await shown(pg), [], 'nothing from friends to show');
  assert.deepEqual([s.fs.shownAny, s.fs.shownCount], [true, 0], 'a hidden anchor was handed, no post');
  assert.equal(s.cont.stats.state, 'off');
  assert.equal(s.cont.stats.headWhy.noLine, 0);
  assert.equal(s.feed.stopped, 1);
  assert.equal(own(S).length, 0, 'Following was not read');
  assert.deepEqual(await lined(pg), []);
  assert.equal(lastEnd(s).caughtUp, false);
  await context.close();
});

test('B32 with the marker: unchanged (the line, the start at the marker)', async () => {
  const { pg, context } = await openIG({ home: markerHome(), follow: range(1, 400) }, { sgCfg: ON });
  await readToEnd(pg, 16);
  const s = await snap(pg);
  assert.deepEqual(s.codes.slice(0, 7), HOME_KEPT);
  assert.ok(s.codes.length > 20);
  assert.equal(s.cont.stats.state, 'running');
  assert.equal(s.cont.stats.startVia, 'marker');
  assert.equal(s.cont.stats.headWhy.noLine, 0);
  assert.equal(s.feed.eof, 1);
  assert.deepEqual(await lined(pg), ['F04']);
  assert.equal(s.feedEnd.some(m => m.on), false);
  await context.close();
});

test('B32 one page without friends\' posts between pages with them is a gap in Instagram\'s ranking, not Home\'s end', async () => {
  const home = {
    head: { edges: [friend('F02'), ad('A1'), friend('F01'), friend('F05')], next: 'h1' },
    h1: { edges: [recs('X1'), recs('X2'), ad('A2')], next: 'h2' },
    h2: { edges: [friend('F03'), friend('F08'), recs('X3')], next: 'h3' },
    h3: { edges: [recs('X4'), ad('A3'), marker()], next: 'm1', ps: 'feed_recs' },
  };
  const { pg, context } = await openIG({ home, follow: range(1, 400) }, { sgCfg: ON });
  await readToEnd(pg, 16);
  const s = await snap(pg);
  assert.deepEqual(s.codes.slice(0, 5), ['F02', 'F01', 'F05', 'F03', 'F08'], 'the friends\' posts after the gap all show');
  assert.equal(s.cont.stats.startVia, 'marker');
  assert.equal(s.cont.stats.headWhy.noLine, 0);
  assert.equal(s.cont.stats.state, 'running');
  assert.deepEqual(await lined(pg), [s.codes[5]]);
  await context.close();
});

test('B32 off: without the continuation, Home still ends after four pages without friends\' posts, with the card', async () => {
  const { pg, context } = await openIG({ home: noLineHome(), follow: range(1, 400), recsPs: null }, { sgCfg: { continueHome: false } });
  await readToEnd(pg, 14);
  assert.ok(await waitFor(pg, async () => (await snap(pg)).fs.ended, 8000), 'Home ended');
  await pg.evaluate(() => { const se = document.scrollingElement; se.scrollTop = se.scrollHeight; });
  assert.ok(await waitFor(pg, async () => { const s = await snap(pg); return s.feedEnd.length && lastEnd(s).on; }, 6000), 'the card shows');
  const s = await snap(pg);
  assert.deepEqual(s.codes, HOME_KEPT);
  assert.equal(s.feed.stopped, 1);
  assert.equal(s.hasNext, false);
  assert.equal(s.cont.stats.state, 'off');
  assert.equal(s.cont.stats.headWhy.noLine, 0);
  assert.equal(lastEnd(s).caughtUp, false, 'no line from Instagram: the card without its words');
  await context.close();
});
