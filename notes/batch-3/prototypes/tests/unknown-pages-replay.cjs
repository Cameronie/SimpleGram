// Review experiment: Relay-shaped Home pages (every XDTFeedItem key present, null when absent)
// fed through 1.1's simplegram.js via plain JSON.parse. Reports what survives and the Filter-status counters.
'use strict';
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const SCRIPT = fs.readFileSync(path.join(__dirname, 'simplegram.copy.js'), 'utf8');
const ME = '1000';
let pk = 5000;
const KEYS = ['media','ad','explore_story','end_of_feed_demarcator','stories_netego','suggested_users','bloks_netego','abra_icebreakers_in_feed_unit','ad4ad_in_webfeed'];
function user(name, following) { const u = { pk: String(pk++), id: String(pk), username: name, __typename: 'XDTUserDict' }; u.friendship_status = following === undefined ? null : { following, is_feed_favorite: false }; return u; }
function media(code, u, extra = {}) { return Object.assign({ id: (pk++) + '_' + u.pk, pk: String(pk), code, inventory_source: null, explore: null, user: u, coauthor_producers: [], social_context: [],
  image_versions2: { candidates: [{ url: 'https://scontent.cdninstagram.com/v/t51/' + code + '_big_n.jpg', width: 1080, height: 1350 }] } }, extra); }
function node(fields) { const n = { __typename: 'XDTFeedItem' }; for (const k of KEYS) n[k] = null; return { node: Object.assign(n, fields), cursor: 'c' + (pk++) }; }
function friend(c) { return node({ media: media(c, user('friend_' + c, true)) }); }
function explore(c, name) { return node({ explore_story: { id: 'es' + c, inventory_source: 'explore_recs', media: media(c, user(name, false), { inventory_source: 'explore_recs' }) } }); }
function ad(c) { return node({ ad: { ad_id: '777' + c, id: 'ad' + c, items: [media(c, user('brand', false))] } }); }
function eof(groupItems) { return node({ end_of_feed_demarcator: { id: 'eof', title: "You're all caught up", subtitle: "You've seen all new posts from the past 3 days.",
  group_set: { __typename: 'XDTGroupSet', id: 'gs', active_group_id: 'recs', connected_group_id: null, groups: [ { id: 'recs', title: 'Suggested Posts', pagination_source: 'feed_recs', next_max_id: 'n', feed_items: groupItems } ] } } }); }
function page(edges, src = null, more = true) { return { data: { xdt_api__v1__feed__timeline__connection: { pagination_source: src, edges, page_info: { has_next_page: more, end_cursor: 'x' + (pk++) } } }, extensions: { is_final: true } }; }
function label(e) { const n = e.node || e; if (n.media) return n.media.code; if (n.explore_story) return 'ES:' + n.explore_story.media.code; if (n.ad) return 'AD'; if (n.end_of_feed_demarcator) { const g = n.end_of_feed_demarcator.group_set.groups; return 'EOF[' + (g.length ? g[0].feed_items.map(label).join(',') || 'feed_items emptied' : 'groups emptied') + ']'; } return '?'; }
const groupItem = (c, name) => { const e = explore(c, name).node; return e; };
const PAGES = [
  ['P1 friends (first page)', page([friend('FRIEND1'), friend('FRIEND2')])],
  ['P2 recs only before EOF', page([explore('SPORTS1', 'sportsonprime'), ad('A1'), explore('X1', 'someone')])],
  ['P3 rec + caught-up marker (+ group of explore_story items)', page([explore('HSMARK1', 'hsmarken'), eof([groupItem('FANAT1', 'fanaticssports'), groupItem('NBA1', 'nba')])])],
  ['P4 feed_recs', page([explore('R1', 'a'), explore('R2', 'b'), ad('A2'), explore('R3', 'c')], 'feed_recs')],
  ['P5 feed_recs', page([explore('R4', 'd'), explore('R5', 'e')], 'feed_recs')],
  ['P6 feed_recs', page([explore('R6', 'f'), ad('A3'), explore('R7', 'g')], 'feed_recs')],
  ['P7 feed_recs', page([explore('R8', 'h'), explore('R9', 'i')], 'feed_recs')],
];
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  await p.route('**/*', r => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body><main></main></body></html>' }));
  await p.addInitScript(() => { window.__sent = []; window.SGNative = { postMessage: m => window.__sent.push(JSON.parse(m)) }; });
  await p.addInitScript(`window.__sgCfg=${JSON.stringify({ role: 'main', version: 'exp', searchPages: 3, viewerId: ME })};\n${SCRIPT}`);
  await p.goto('https://www.instagram.com/');
  for (const [name, pl] of PAGES) {
    const r = await p.evaluate(t => { const out = JSON.parse(t); const f = window.__sg.stats.feed; return { out, f: JSON.parse(JSON.stringify(f)), ads: window.__sg.stats.ads }; }, JSON.stringify(pl));
    const c = r.out.data.xdt_api__v1__feed__timeline__connection;
    console.log(name.padEnd(58), '->', c.edges.map(label).join(' '), '| has_next', c.page_info.has_next_page);
  }
  const f = await p.evaluate(() => ({ feed: window.__sg.stats.feed, ads: window.__sg.stats.ads }));
  console.log('ended', await p.evaluate(() => JSON.stringify({ afterEnd: window.__sg.stats.feed.afterEnd, eof: window.__sg.stats.feed.eof, recsPages: window.__sg.stats.feed.recsPages, suggested: window.__sg.stats.feed.suggested, ad: window.__sg.stats.feed.ad })));
  console.log('Filter status: Posts shown', f.feed.kept, '| Suggested removed', (f.feed.suggested || 0) + (f.feed.notFollowed || 0), '| Pages read', f.feed.pages, '(' + f.feed.unknownPages + ' unrecognised) | streamed', f.feed.streamed, '| Ads removed (Stories etc.)', f.ads);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
