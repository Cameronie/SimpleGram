// Proposed B11 tests (end-of-Home card). Same harness as tests/page.test.cjs.
// Run: SG_SCRIPT=<path to simplegram.js> NODE_PATH=/opt/node-tools/node_modules node --test feed-end.test.cjs
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');

const SCRIPT = fs.readFileSync(process.env.SG_SCRIPT, 'utf8');
const ME = '1000';
let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser.close(); });

async function open(url, html) {
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
  await page.addInitScript(() => { window.__sent = []; window.SGNative = { postMessage: m => window.__sent.push(JSON.parse(m)) }; });
  await page.addInitScript(`window.__sgCfg=${JSON.stringify({ role: 'main', version: 'test', searchPages: 3, viewerId: ME })};\n${SCRIPT}`);
  await page.goto(url);
  return page;
}
const sent = (page, a) => page.evaluate(a => window.__sent.filter(m => m.action === a), a);
const lastOn = async page => { const m = await sent(page, 'feedEnd'); return m.length ? m[m.length - 1].on : null; };
const everOn = async page => (await sent(page, 'feedEnd')).some(m => m.on);

let pkSeq = 9000;
function user(name, following) { const u = { pk: String(pkSeq++), username: name }; if (following !== undefined) u.friendship_status = { following }; return u; }
function media(code, u) { return { pk: String(pkSeq++), id: String(pkSeq) + '_' + u.pk, code, user: u, image_versions2: { candidates: [{ url: `https://scontent.cdninstagram.com/v/t51/${code}_n.jpg`, width: 1080, height: 1350 }] } }; }
function edge(node) { return { node: Object.assign({ __typename: 'XDTFeedItem' }, node), cursor: 'c' }; }
function timeline(edges, more = true, extra = {}, cursor = 'abc') {
  return { data: { xdt_api__v1__feed__timeline__connection: Object.assign({ edges, page_info: { has_next_page: more, end_cursor: cursor } }, extra) }, extensions: { is_final: true } };
}
const friend = c => edge({ media: media(c, user('f' + c, true)) });
const recs = c => edge({ explore_story: { media: media(c, user('r' + c)) } });
// Shaped like Instagram's XDTEndOfFeedDemarcator (PolarisFeedTimelineRootV2Query.graphql): its groups carry the first suggestions.
const marker = () => edge({ end_of_feed_demarcator: { id: 'eof', title: "You're all caught up", subtitle: "You've seen all new posts from the past 3 days.",
  group_set: { __typename: 'XDTGroupSet', id: 'gs', active_group_id: 'feed_recs', groups: [
    { id: 'feed_recs', title: 'Suggested Posts', pagination_source: 'feed_recs', next_max_id: 'r1', feed_items: [{ explore_story: { media: media('GRPREC1', user('fanatics')) } }] },
    { id: 'past_posts', title: 'Older posts', pagination_source: 'past_posts', next_max_id: 'p1', feed_items: [{ media: media('OLDPOST', user('old', true)) }] }] } } });
const conn = out => out.data.xdt_api__v1__feed__timeline__connection;
const keys = out => conn(out).edges.map(e => { const n = e.node; return n.media ? n.media.code : n.explore_story ? 'explore:' + n.explore_story.media.code : Object.keys(n).filter(k => k !== '__typename')[0]; });
// A page that grows as Instagram renders each kept post (650px each).
const FEED_HTML = '<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body style="margin:0"><main id="feed"></main></body></html>';
async function deliver(page, payload) {
  return page.evaluate(p => {
    const out = JSON.parse(JSON.stringify(p));
    for (const e of out.data.xdt_api__v1__feed__timeline__connection.edges) {
      const a = document.createElement('article'); a.style.height = '650px'; document.getElementById('feed').appendChild(a);
    }
    return out;
  }, payload);
}
const toBottom = page => page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));

test('feed end: no card while Instagram is still loading the next page (no timer)', async () => {
  const page = await open('https://www.instagram.com/', FEED_HTML);
  await deliver(page, timeline([friend('FRIEND1'), friend('FRIEND2')]));
  await toBottom(page);
  await page.waitForTimeout(6500); // 1.1 showed the card after 4 s at the bottom
  assert.equal(await everOn(page), false);
  await deliver(page, timeline([friend('FRIEND3')], true, {}, 'def'));
  await toBottom(page);
  await page.waitForTimeout(2000);
  assert.equal(await everOn(page), false);
});

test('feed end: "You\'re all caught up" ends Home: suggestions after it are dropped and paging stops', async () => {
  const page = await open('https://www.instagram.com/', FEED_HTML);
  const out = await deliver(page, timeline([friend('FRIEND1'), friend('FRIEND2'), marker(), recs('AFTER01'), friend('AFTER02')]));
  assert.deepEqual(keys(out), ['FRIEND1', 'FRIEND2']);
  assert.equal(conn(out).page_info.has_next_page, false);
  assert.equal(await page.evaluate(() => window.__sg.stats.feed.pages), 1); // the marker's groups are not extra pages
  assert.equal(await everOn(page), false); // not yet: the end isn't on screen
  await toBottom(page);
  await page.waitForFunction(() => { const m = window.__sent.filter(x => x.action === 'feedEnd'); return m.length && m[m.length - 1].on; }, null, { timeout: 3000 });
  const m = (await sent(page, 'feedEnd')).pop();
  assert.equal(m.caughtUp, true);
  assert.match(m.subtitle, /past 3 days/);
  // Room below the last post, so the card never covers it.
  assert.equal(await page.evaluate(() => !!document.getElementById('sg-end-room')), true);
});

test('feed end: a marker in a page without plain posts still ends Home', async () => {
  const page = await open('https://www.instagram.com/', FEED_HTML);
  await deliver(page, timeline([friend('FRIEND1')]));
  const out = await deliver(page, timeline([recs('HSMARK1'), marker(), recs('AFTER01')], true, {}, 'p2'));
  assert.equal(conn(out).page_info.has_next_page, false);
  assert.ok(!keys(out).includes('end_of_feed_demarcator') && !keys(out).includes('explore:AFTER01'));
  // (HSMARK1, before the marker, is B8's job: a page of only suggestions must not fail open.)
  await toBottom(page);
  await page.waitForFunction(() => window.__sent.some(x => x.action === 'feedEnd' && x.on), null, { timeout: 3000 });
});

test('feed end: Instagram\'s suggestion pages (pagination_source feed_recs) never reach Home', async () => {
  const page = await open('https://www.instagram.com/', FEED_HTML);
  await deliver(page, timeline([friend('FRIEND1')]));
  const out = await deliver(page, timeline([recs('REC0001'), recs('REC0002')], true, { pagination_source: 'feed_recs' }, 'p2'));
  assert.deepEqual(keys(out), []);
  assert.equal(conn(out).page_info.has_next_page, false);
});

test('feed end: the card comes back after opening a post (or Stories) and returning to Home', async () => {
  const page = await open('https://www.instagram.com/', FEED_HTML);
  await deliver(page, timeline([friend('FRIEND1'), marker()]));
  await toBottom(page);
  await page.waitForFunction(() => window.__sent.some(x => x.action === 'feedEnd' && x.on), null, { timeout: 3000 });
  await page.evaluate(() => { history.pushState(null, '', '/p/ABCDEF1/'); dispatchEvent(new PopStateEvent('popstate')); });
  await page.waitForFunction(() => { const m = window.__sent.filter(x => x.action === 'feedEnd'); return !m[m.length - 1].on; });
  assert.equal(await page.evaluate(() => !!document.getElementById('sg-end-room')), false); // no blank room under a post page
  await page.evaluate(() => history.back());
  await page.waitForURL('https://www.instagram.com/');
  await toBottom(page);
  await page.waitForFunction(() => { const m = window.__sent.filter(x => x.action === 'feedEnd'); return m[m.length - 1].on; }, null, { timeout: 3000 });
});

test('feed end: refreshing Home after the end starts over (no early card on the new feed)', async () => {
  const page = await open('https://www.instagram.com/', FEED_HTML);
  await deliver(page, timeline([friend('FRIEND1'), marker()]));
  await toBottom(page);
  await page.waitForFunction(() => window.__sent.some(x => x.action === 'feedEnd' && x.on), null, { timeout: 3000 });
  // Instagram scrolls to the top and reloads the feed: a first page with a new cursor.
  await page.evaluate(() => { document.getElementById('feed').textContent = ''; window.scrollTo(0, 0); });
  const out = await deliver(page, timeline([friend('NEW0001'), friend('NEW0002')], true, {}, 'fresh1'));
  assert.deepEqual(keys(out), ['NEW0001', 'NEW0002']);
  assert.equal(conn(out).page_info.has_next_page, true);
  await toBottom(page);
  await page.waitForTimeout(2000);
  assert.equal(await lastOn(page), false);
});

test('feed end: the same end page read twice stays the end', async () => {
  const page = await open('https://www.instagram.com/', FEED_HTML);
  const p = timeline([friend('FRIEND1'), marker(), recs('AFTER01')]);
  await deliver(page, p);
  const again = await deliver(page, p);
  assert.deepEqual(keys(again), ['FRIEND1']);
  assert.equal(conn(again).page_info.has_next_page, false);
});

test('feed end: Following keeps Instagram\'s marker; its group lists are not read as pages', async () => {
  const page = await open('https://www.instagram.com/?variant=following', FEED_HTML);
  const out = await deliver(page, timeline([friend('FRIEND1'), marker()]));
  assert.deepEqual(keys(out), ['FRIEND1', 'end_of_feed_demarcator']);
  assert.equal(conn(out).page_info.has_next_page, true);
  assert.equal(await page.evaluate(() => window.__sg.stats.feed.pages), 1);
  await toBottom(page);
  await page.waitForTimeout(2000);
  assert.equal(await everOn(page), false); // the card is for Home only
});
