// Search data (B12 Places, B13 Tags): the requests SimpleGram's search makes,
// against a mock of today's website (tests/search-mock.cjs). The mock refuses
// unknown doc_ids and requests that leave out a declared setting, and the old
// REST search endpoints answer 404 HTML.
//
// Run: NODE_PATH=/opt/node-tools/node_modules node --test tests/*.test.cjs
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useBrowser, open, waitSent, NAVPAGE, BLANK, openSearchTab, searchText, shadowClick, media, user } = require('./helpers.cjs');
const { NOT_FOUND, DEAD_RE, SD, SEO, IDS, site, keywordGrid } = require('./search-mock.cjs');

useBrowser();

const BRAND = '__relay_internal__pv__PolarisBrandNewrelayprovider';
const NBA = { pk: '1', username: 'nba', full_name: 'NBA', is_verified: true, profile_pic_url: '' };
const HYATT = { location: { pk: '213385402', name: 'Hyatt Regency Waikiki' }, title: 'Hyatt Regency Waikiki', subtitle: '2424 Kalakaua Ave' };
const PLACE_KEYS = ['location_id', 'first', 'after', 'tab', 'page_size_override'];

// Opens search on a page served with `api`; `urls` collects every request made.
async function start(api, html = NAVPAGE) {
  const page = await open('https://www.instagram.com/', html, { api });
  const urls = [];
  page.on('request', r => urls.push(r.method() + ' ' + r.url()));
  await openSearchTab(page);
  return { page, urls };
}
async function query(page, q) {
  await page.evaluate(q => {
    const i = document.getElementById('sg-search').shadowRoot.querySelector('input');
    i.value = q;
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }, q);
}
function waitText(page, s) {
  return page.waitForFunction(s => document.getElementById('sg-search').shadowRoot.textContent.includes(s), s);
}
function waitCells(page, n) {
  return page.waitForFunction(n => document.getElementById('sg-search').shadowRoot.querySelectorAll('.cell').length === n, n);
}
// Nothing loading (no spinner) in search.
function waitIdle(page) {
  return page.waitForFunction(() => !document.getElementById('sg-search').shadowRoot.querySelector('.spin'));
}
function rows(page) {
  return page.evaluate(() => Array.from(document.getElementById('sg-search').shadowRoot.querySelectorAll('.row'))
    .map(r => Array.from(r.querySelectorAll('.t1,.t2')).map(x => x.textContent).join(' | ')));
}
function deadRequests(urls) { return urls.filter(u => DEAD_RE.test(u)); }
async function openPlace(page, title = 'Hyatt Regency') {
  await shadowClick(page, 'Places');
  await waitText(page, title);
  await shadowClick(page, title);
}
const placesApi = (...items) => ({ '/api/v1/fbsearch/places/': { items: items, status: 'ok' } });

/* ---------------- Accounts and Posts & Reels (regression) ---------------- */

test('search data: Accounts and Posts & Reels come from the website\'s GraphQL requests, never the dead endpoints', async () => {
  const s = site({ users: [NBA], keyword: ['KEYW001', 'KEYW002'] });
  const { page, urls } = await start(s.api);
  await query(page, 'nba');
  await waitText(page, 'NBA');
  await shadowClick(page, 'Posts & Reels');
  await waitCells(page, 2);
  assert.deepEqual(s.log.map(r => r.name), ['PolarisSearchBoxRefetchableQuery', 'PolarisKeywordSearchExplorePageRelayQuery']);
  assert.ok(s.log.every(r => r.path === '/api/graphql' && r.result === 'data'), JSON.stringify(s.log));
  assert.deepEqual(deadRequests(urls), []);
});

/* ---------------- Tags (B13) ---------------- */

test('search data: Tags lists the typed tag first, even when Instagram returns no hashtags', async () => {
  const s = site({ users: [NBA] });
  const { page, urls } = await start(s.api);
  await shadowClick(page, 'Tags');
  await query(page, 'Nba');
  await waitText(page, '#nba');
  assert.deepEqual(await rows(page), ['#nba | Hashtag']);
  const lookup = s.log.filter(r => r.name === 'PolarisAPITopsearchQuery');
  assert.equal(lookup.length, 1);
  assert.equal(lookup[0].vars.data.context, 'hashtag');
  assert.equal(lookup[0].vars.data.query, 'nba');
  assert.equal(lookup[0].id, IDS.PolarisAPITopsearchQuery);
  assert.deepEqual(deadRequests(urls), []);
});

test('search data: hashtags from Instagram\'s "#" lookup are added once each, with post counts', async () => {
  const s = site({ users: [NBA], tags: [{ name: 'nba', media_count: 51234567 }, { name: 'nbafinals', media_count: 1234567 }, { name: 'NBA', media_count: 3 }] });
  const { page } = await start(s.api);
  await shadowClick(page, 'Tags');
  await query(page, '#Nba');
  await waitText(page, '#nbafinals');
  assert.deepEqual(await rows(page), ['#nba | 51,234,567 posts', '#nbafinals | 1,234,567 posts']);
  assert.equal(await page.evaluate(() => window.__sg.stats.searchData.hashtags.topsearch), 3);
});

test('search data: the "#" lookup is skipped when the search box already has hashtags', async () => {
  const s = site({ users: [NBA], blendedTags: [{ name: 'nbatwitter', media_count: 5 }] });
  const { page } = await start(s.api);
  await query(page, 'nba');
  await waitText(page, 'NBA');
  await shadowClick(page, 'Tags');
  await waitText(page, '#nbatwitter');
  assert.deepEqual(await rows(page), ['#nba | Hashtag', '#nbatwitter | 5 posts']);
  assert.equal(s.log.filter(r => r.name === 'PolarisAPITopsearchQuery').length, 0);
  assert.equal(s.log.filter(r => r.name === 'PolarisSearchBoxRefetchableQuery').length, 1, 'the Accounts answer is shared');
});

test('search data: "#" alone asks nothing; tags in other scripts keep their vowel signs', async () => {
  const s = site({ users: [NBA] });
  const { page } = await start(s.api);
  await shadowClick(page, 'Tags');
  await query(page, '#');
  await waitText(page, 'No tags found');
  assert.equal(s.log.length, 0);
  await query(page, '#हिंदी गाने');
  await waitText(page, '#हिंदीगाने');
  assert.deepEqual(await rows(page), ['#हिंदीगाने | Hashtag']);
  assert.equal(s.log.find(r => r.name === 'PolarisAPITopsearchQuery').vars.data.query, 'हिंदीगाने');
});

test('search data: a tag opens Instagram\'s keyword results for "#tag" when the old tag page is gone', async () => {
  const s = site({ users: [NBA], tags: [{ name: 'nbafinals', media_count: 9 }], keyword: ['TAGK001', 'TAGK002', 'TAGK003'] });
  const api = Object.assign(s.api, { '/api/v1/tags/web_info/': () => ({ status: 404, body: NOT_FOUND }) });
  const { page, urls } = await start(api);
  await shadowClick(page, 'Tags');
  await query(page, 'nba');
  await waitText(page, '#nbafinals');
  await shadowClick(page, '#nba');
  await waitCells(page, 3);
  const kw = s.log.filter(r => r.name === 'PolarisKeywordSearchExplorePageRelayQuery');
  assert.equal(kw.length, 1);
  assert.equal(kw[0].vars.query, '#nba');
  // Another tag: the old tag page isn't asked again this session.
  await shadowClick(page, '‹');
  await waitText(page, '#nbafinals');
  await shadowClick(page, '#nbafinals');
  await waitCells(page, 3);
  assert.equal(urls.filter(u => u.includes('/api/v1/tags/web_info/')).length, 1);
  const st = await page.evaluate(() => window.__sg.stats.searchData);
  assert.equal(st.tagWebInfo, 404);
  assert.deepEqual(st.tagGrid, { webInfo: 0, keyword: 2 });
});

test('search data: a tag\'s Most recent is asked once per session, then explained without asking', async () => {
  const s = site({ users: [NBA], keyword: ['TAGK001'] });
  let posts = 0;
  const api = Object.assign(s.api, {
    '/api/v1/tags/web_info/': () => ({ status: 404, body: NOT_FOUND }),
    '/api/v1/tags/nba/sections/': () => { posts++; return { status: 404, body: NOT_FOUND }; },
  });
  const { page } = await start(api);
  await shadowClick(page, 'Tags');
  await query(page, 'nba');
  await waitText(page, '#nba');
  await shadowClick(page, '#nba');
  await waitCells(page, 1);
  await shadowClick(page, 'Most recent');
  await waitText(page, 'no longer shows most recent');
  await shadowClick(page, 'Top');
  await waitCells(page, 1);
  await shadowClick(page, 'Most recent');
  await waitText(page, 'no longer shows most recent');
  assert.equal(posts, 1);
  assert.deepEqual(await page.evaluate(() => window.__sg.stats.searchData.tagRecent), { asked: 1, failed: 1 });
});

/* ---------------- Places (B12) ---------------- */

test('search data: a place\'s grid uses the place page\'s request, with both settings after the variables', async () => {
  const s = site({ place: ['PLCE001', 'PLCE002'] });
  const { page, urls } = await start(Object.assign(s.api, placesApi(HYATT)));
  await query(page, 'hyatt');
  await openPlace(page);
  await waitCells(page, 2);
  const grid = s.log.filter(r => r.name === 'PolarisLocationPageTabContentQuery');
  assert.equal(grid.length, 1);
  assert.equal(grid[0].id, IDS.PolarisLocationPageTabContentQuery);
  assert.deepEqual(grid[0].keys, PLACE_KEYS.concat([SD, SEO]));
  assert.deepEqual(grid[0].vars, { location_id: '213385402', first: 24, after: null, tab: 'ranked', page_size_override: null, [SD]: false, [SEO]: false });
  assert.equal(s.log.filter(r => r.name === 'PolarisExploreLocationsContainerQuery').length, 0, 'the row already had the address');
  assert.deepEqual(deadRequests(urls), []);
  const note = (await page.evaluate(() => window.__sg.gqlLog)).find(e => e.query === 'PolarisLocationPageTabContentQuery');
  assert.equal(note.idSource, 'known');
  assert.equal(note.providerSource, 'known');
  assert.equal(note.edges, 2);
});

test('search data: settings take the values from Instagram\'s own compiled query when the page has it', async () => {
  const mods = `<script>(function(){var mods={
    'PolarisLocationPageTabContentQuery_instagramRelayOperation':'${IDS.PolarisLocationPageTabContentQuery}',
    'PolarisLocationPageTabContentQuery.graphql':{params:{id:'${IDS.PolarisLocationPageTabContentQuery}',metadata:{is_fully_www_executable:true},providedVariables:{
      ${SD}:{get:function(){return true;}},${SEO}:{get:function(){return false;}}}}}};
    window.require=function(n){if(n in mods)return mods[n];throw new Error('Requiring unknown module "'+n+'"');};})();</script>`;
  const s = site({ place: ['PLCE001'] });
  const { page } = await start(Object.assign(s.api, placesApi(HYATT)), NAVPAGE.replace('</body>', mods + '</body>'));
  await query(page, 'hyatt');
  await openPlace(page);
  await waitCells(page, 1);
  const grid = s.log.find(r => r.name === 'PolarisLocationPageTabContentQuery');
  assert.deepEqual(grid.keys, PLACE_KEYS.concat([SD, SEO]));
  assert.equal(grid.vars[SD], true);
  assert.equal(grid.vars[SEO], false);
  const note = (await page.evaluate(() => window.__sg.gqlLog)).find(e => e.query === 'PolarisLocationPageTabContentQuery');
  assert.equal(note.idSource, 'module');
  assert.equal(note.providerSource, 'graphql');
  assert.deepEqual(note.providers, { PolarisShortDramaEnabled: true, PolarisSEOIsCrawler: false });
});

test('search data: ids and settings are read from the page\'s script files when its modules can\'t be reached', async () => {
  const rotated = '31111111111111111';
  const bundle = `__d("PolarisLocationPageTabContentQuery_instagramRelayOperation",[],(function(t,n,r,o,a,i){a.exports="${rotated}"}),null);
__d("PolarisLocationPageTabContentQuery.graphql",["PolarisLocationPageTabContentQuery_instagramRelayOperation","PolarisBrandNew.relayprovider","PolarisSEOIsCrawler.relayprovider","PolarisShortDramaEnabled.relayprovider"],(function(t,n,r,o,a,i){a.exports={}}),null);`;
  const providers = [SD, SEO, BRAND];
  const s = site({ place: ['PLCE001'], ids: { PolarisLocationPageTabContentQuery: rotated }, providers: { PolarisLocationPageTabContentQuery: providers } });
  const api = Object.assign(s.api, placesApi(HYATT), { '/static/b385.js': () => ({ body: bundle }) });
  const { page } = await start(api, NAVPAGE.replace('</body>', '<script src="https://www.instagram.com/static/b385.js"></script></body>'));
  await query(page, 'hyatt');
  await openPlace(page);
  await waitCells(page, 1);
  const grid = s.log.filter(r => r.name === 'PolarisLocationPageTabContentQuery');
  assert.equal(grid.length, 1, 'no retry needed');
  assert.equal(grid[0].id, rotated);
  for (const k of providers) assert.equal(grid[0].vars[k], false, k);
  const note = (await page.evaluate(() => window.__sg.gqlLog)).find(e => e.query === 'PolarisLocationPageTabContentQuery');
  assert.equal(note.idSource, 'scan');
  assert.equal(note.providerSource, 'scan');
});

test('search data: the next page uses the _connection query and stops when Instagram sends the cursor back', async () => {
  // One post on the first page: the same tap reads the next page (R4).
  const s = site({ place: ['PLCE001'], placeMore: 'cur1', placeNext: ['PLCE002'] });
  const { page } = await start(Object.assign(s.api, placesApi(HYATT)));
  await query(page, 'hyatt');
  await openPlace(page);
  await waitCells(page, 2);
  await waitIdle(page);
  const more = s.log.filter(r => r.name === 'PolarisLocationPageTabContentQuery_connection');
  assert.equal(more.length, 1);
  assert.equal(more[0].id, IDS.PolarisLocationPageTabContentQuery_connection);
  assert.deepEqual(more[0].keys, ['after', 'first', 'location_id', 'page_size_override', 'tab', SD, SEO]);
  assert.equal(more[0].vars.after, 'cur1');
  assert.equal(more[0].vars.first, 24);
  assert.ok(!(await searchText(page)).includes('Show more'), 'the echoed cursor ends the list');
});

test('search data: a place\'s Most recent sends tab "recent"; an empty answer says so', async () => {
  const s = site({ place: ['PLCE001'], placeRecent: [] });
  const { page } = await start(Object.assign(s.api, placesApi(HYATT)));
  await query(page, 'hyatt');
  await openPlace(page);
  await waitCells(page, 1);
  await shadowClick(page, 'Most recent');
  await page.waitForFunction(() => /isn.t showing most recent/.test(document.getElementById('sg-search').shadowRoot.textContent));
  assert.deepEqual(s.log.filter(r => r.name === 'PolarisLocationPageTabContentQuery').map(r => r.vars.tab), ['ranked', 'recent']);
});

test('search data: a place opened without an address gets its name and address from Instagram', async () => {
  const s = site({ place: ['PLCE001'], placeInfo: { name: 'Hyatt Regency Waikiki Beach Resort', location_address: '2424 Kalakaua Ave', location_city: 'Honolulu, Hawaii', slug: 'hyatt-waikiki' } });
  const bare = { location: { pk: '213385402', name: 'Hyatt Regency Waikiki' }, title: 'Hyatt Regency Waikiki' };
  const { page } = await start(Object.assign(s.api, placesApi(bare)));
  await query(page, 'hyatt');
  await openPlace(page);
  await waitText(page, '2424 Kalakaua Ave, Honolulu, Hawaii');
  await waitCells(page, 1);
  const head = s.log.filter(r => r.name === 'PolarisExploreLocationsContainerQuery');
  assert.equal(head.length, 1);
  assert.deepEqual(head[0].vars, { location_id_str: '213385402', show_nearby: false });
  assert.ok((await searchText(page)).includes('Hyatt Regency Waikiki Beach Resort'));
});

/* ---------------- Request rules ---------------- */

test('search data: a setting named in Instagram\'s refusal is added in exactly one retry and remembered', async () => {
  const providers = [SD, SEO, BRAND];
  const s = site({ place: ['PLCE001'], providers: { PolarisLocationPageTabContentQuery: providers } });
  const { page } = await start(Object.assign(s.api, placesApi(HYATT)));
  await query(page, 'hyatt');
  await openPlace(page);
  await waitCells(page, 1);
  let grid = s.log.filter(r => r.name === 'PolarisLocationPageTabContentQuery');
  assert.deepEqual(grid.map(r => r.path), ['/api/graphql', '/api/graphql']);
  assert.deepEqual(grid.map(r => r.result.slice(0, 5)), ['error', 'data']);
  assert.equal(grid[1].vars[BRAND], false);
  // Remembered: Most recent is one request.
  await shadowClick(page, 'Most recent');
  await page.waitForFunction(() => /isn.t showing most recent/.test(document.getElementById('sg-search').shadowRoot.textContent));
  grid = s.log.filter(r => r.name === 'PolarisLocationPageTabContentQuery');
  assert.equal(grid.length, 3);
  assert.equal(grid[2].result, 'data');
});

test('search data: at most 2 POSTs per request; never /graphql/query after Instagram refused one', async () => {
  // Both paths fail at the HTTP level: one POST each, then stop.
  let s = site({ users: [NBA], status: 500 });
  let { page } = await start(s.api);
  await query(page, 'nba');
  await waitText(page, 'Try again');
  assert.deepEqual(s.log.map(r => r.path), ['/api/graphql', '/graphql/query']);
  // A refusal that names nothing: no retry, no other path.
  s = site({ users: [NBA], unnamedMissing: true, providers: { PolarisLocationPageTabContentQuery: [SD, SEO, BRAND] } });
  ({ page } = await start(Object.assign(s.api, placesApi(HYATT))));
  await query(page, 'hyatt');
  await openPlace(page);
  await waitText(page, 'Try again');
  assert.ok((await searchText(page)).includes('Open Instagram’s own page'));
  const grid = s.log.filter(r => r.name === 'PolarisLocationPageTabContentQuery');
  assert.deepEqual(grid.map(r => r.path), ['/api/graphql']);
  assert.equal(s.log.filter(r => r.path === '/graphql/query').length, 0);
});

test('search data: a throttled or refused request (429/401/403) is not resent to the other path', async () => {
  const s = site({ users: [NBA], status: 429 });
  const { page } = await start(s.api);
  await query(page, 'nba');
  await waitText(page, 'Try again');
  assert.deepEqual(s.log.map(r => r.path), ['/api/graphql']);
});

test('search data: Show more keeps the place grid where you scrolled; a failed page keeps it and offers Try again', async () => {
  const many = Array.from({ length: 30 }, (_, i) => 'PLCE' + String(i).padStart(3, '0'));
  const state = { fail: false, n: 0 };
  const s = site({ place: many, placeMore: 'cur1',
    answers: { PolarisLocationPageTabContentQuery_connection: v => (state.fail ? null
      : { edges: [{ node: keywordGrid(['PLCX00' + (++state.n)]).edges[1].node.items[0] }], page_info: { has_next_page: true, end_cursor: 'cur' + (state.n + 1) } }) } });
  const { page } = await start(Object.assign(s.api, placesApi(HYATT)));
  await query(page, 'hyatt');
  await openPlace(page);
  await waitCells(page, 30);
  const before = await page.evaluate(() => { const b = document.getElementById('sg-search').shadowRoot.querySelector('.body'); b.scrollTop = b.scrollHeight; return b.scrollTop; });
  assert.ok(before > 0);
  await shadowClick(page, 'Show more');
  await waitCells(page, 32);                       // one post a page: the tap reads two
  const after = await page.evaluate(() => document.getElementById('sg-search').shadowRoot.querySelector('.body').scrollTop);
  assert.ok(after >= before - 2, `kept ${after} of ${before}`);
  state.fail = true;
  await shadowClick(page, 'Show more');
  await waitText(page, 'Try again');
  assert.ok(!(await searchText(page)).includes('Show more'));
  assert.equal(await page.evaluate(() => document.getElementById('sg-search').shadowRoot.querySelectorAll('.cell').length), 32);
  // Try again asks for the same page again.
  const asked = s.log.filter(r => r.name === 'PolarisLocationPageTabContentQuery_connection').map(r => r.vars.after);
  state.fail = false;
  await shadowClick(page, 'Try again');
  await waitCells(page, 34);
  const again = s.log.filter(r => r.name === 'PolarisLocationPageTabContentQuery_connection').map(r => r.vars.after);
  assert.equal(again[asked.length], asked[asked.length - 1]);
});

test('search data: Try again asks once more, and the diagnostics record each try without the search words', async () => {
  const state = { fail: true };
  const s = site({ users: [NBA], answers: { PolarisKeywordSearchExplorePageRelayQuery: () => (state.fail ? null : keywordGrid(['KEYW001'], null)) } });
  const { page } = await start(s.api);
  await shadowClick(page, 'Posts & Reels');
  await query(page, 'sharks');
  await waitText(page, 'Try again');
  assert.equal(s.log.filter(r => r.name === 'PolarisKeywordSearchExplorePageRelayQuery').length, 1);
  state.fail = false;
  await shadowClick(page, 'Try again');
  await waitCells(page, 1);
  const log = await page.evaluate(() => window.__sg.gqlLog);
  const kw = log.filter(e => e.query === 'PolarisKeywordSearchExplorePageRelayQuery');
  assert.equal(kw.length, 2);
  assert.deepEqual(Object.assign({}, kw[0], { ms: 0 }), {
    query: 'PolarisKeywordSearchExplorePageRelayQuery', id: IDS.PolarisKeywordSearchExplorePageRelayQuery, idSource: 'known',
    providerSource: 'none', providers: {}, path: '/api/graphql', status: 200, code: 1675004, message: 'execution error', ms: 0,
  });
  assert.equal(kw[1].edges, 2);
  assert.ok(!JSON.stringify(log).includes('sharks'), 'no search words in diagnostics');
  await page.evaluate(() => window.__sg.onNative({ type: 'status' }));
  const [status] = await waitSent(page, 'status');
  assert.equal(status.stats.searchData.gqlLog.length, log.length);
});

test('search data: after a refused request id, Try again looks the id up again', async () => {
  const op = 'PolarisKeywordSearchExplorePageRelayQuery_instagramRelayOperation';
  const html = NAVPAGE.replace('</body>', `<script>window.__mods={'${op}':'1111'};
    window.require=function(n){if(n in window.__mods)return window.__mods[n];throw new Error('Requiring unknown module "'+n+'"');};</script></body>`);
  const s = site({ users: [NBA], keyword: ['KEYW001'] });
  const { page } = await start(s.api, html);
  await shadowClick(page, 'Posts & Reels');
  await query(page, 'nba');
  await waitText(page, 'Try again');
  await page.evaluate(([op, id]) => { window.__mods[op] = id; }, [op, IDS.PolarisKeywordSearchExplorePageRelayQuery]);
  await shadowClick(page, 'Try again');
  await waitCells(page, 1);
  assert.deepEqual(s.log.filter(r => r.name === 'PolarisKeywordSearchExplorePageRelayQuery').map(r => r.id), ['1111', IDS.PolarisKeywordSearchExplorePageRelayQuery]);
});

test('search data: "Open Instagram\'s own page" for a place uses Instagram\'s own slug and the Most recent path', async () => {
  const s = site({ answers: { PolarisLocationPageTabContentQuery: () => null } });
  const { page } = await start(Object.assign(s.api, placesApi(HYATT)));
  await query(page, 'hyatt');
  await openPlace(page);
  await waitText(page, 'Try again');
  await shadowClick(page, 'own page');
  assert.equal(await page.evaluate(() => location.pathname), '/explore/locations/213385402/hyatt-regency-waikiki/');
  await page.evaluate(() => window.__sg.back());
  await waitText(page, 'Try again');
  await shadowClick(page, 'Most recent');
  await waitText(page, 'Try again');
  await shadowClick(page, 'own page');
  assert.equal(await page.evaluate(() => location.pathname), '/explore/locations/213385402/hyatt-regency-waikiki/recent/');
});

/* ---------------- R4: no Show more cap, about 24 posts a tap ---------------- */

function codes(prefix, n, from = 0) { return Array.from({ length: n }, (_, i) => prefix + String(from + i).padStart(3, '0')); }
function placePage(list, next) {
  return { edges: list.map(c => ({ node: media(c, user('u' + c, true)) })), page_info: { has_next_page: !!next, end_cursor: next || null } };
}
// A place whose pages come from `at(after)` (after is null for the first page).
function placeSite(at) {
  return site({ answers: {
    PolarisLocationPageTabContentQuery: () => at(null),
    PolarisLocationPageTabContentQuery_connection: v => at(v.after),
  } });
}
async function openPlaceWith(s) {
  const { page } = await start(Object.assign(s.api, placesApi(HYATT)));
  await query(page, 'hyatt');
  await openPlace(page);
  return page;
}
const conn = s => s.log.filter(r => r.name === 'PolarisLocationPageTabContentQuery_connection');
const firsts = s => s.log.filter(r => r.name === 'PolarisLocationPageTabContentQuery');
function cellInfo(page) {
  return page.evaluate(() => {
    const imgs = Array.from(document.getElementById('sg-search').shadowRoot.querySelectorAll('.cell img'));
    return { n: imgs.length, unique: new Set(imgs.map(i => i.dataset.src)).size };
  });
}
const gridStats = page => page.evaluate(() => window.__sg.stats.searchData.grid);

test('R4: no Show more cap: the 5th and the 10th Show more still load, one request each at 24 a page', async () => {
  const s = placeSite(after => {
    const n = after == null ? 0 : Number(after.slice(1));
    return placePage(codes('P' + n + 'X', 24), 'c' + (n + 1));
  });
  const page = await openPlaceWith(s);
  await waitCells(page, 24);
  // The first cell is kept (not redrawn) as the grid grows.
  await page.evaluate(() => { document.getElementById('sg-search').shadowRoot.querySelector('.cell').__first = true; });
  for (let i = 1; i <= 10; i++) {
    await waitText(page, 'Show more');
    await shadowClick(page, 'Show more');
    await waitCells(page, 24 * (i + 1));
    if (i === 5) assert.equal(conn(s).length, 5);
  }
  await waitIdle(page);
  assert.ok((await searchText(page)).includes('Show more'), 'still offered after 10 taps');
  assert.equal(conn(s).length, 10, '24 new posts: no second page in the tap');
  assert.deepEqual(conn(s).map(r => r.vars.first), Array(10).fill(24));
  assert.equal(await page.evaluate(() => document.getElementById('sg-search').shadowRoot.querySelector('.cell').__first), true);
  const g = await gridStats(page);
  assert.equal(g.taps, 11);
  assert.equal(g.pages, 11);
  assert.equal(g.chained, 0);
  assert.equal(await page.evaluate(() => window.__sg.stats.searchStopped), 0);
});

test('R4: a long grid stays light: thumbnails load near the screen and are let go far from it', async () => {
  const s = placeSite(after => {
    const n = after == null ? 0 : Number(after.slice(1));
    return placePage(codes('L' + n + 'X', 24), n < 9 ? 'c' + (n + 1) : null);
  });
  const page = await openPlaceWith(s);
  for (let i = 1; i <= 9; i++) {
    await waitCells(page, 24 * i);
    await waitText(page, 'Show more');
    await shadowClick(page, 'Show more');
  }
  await waitCells(page, 240);
  const has = i => page.evaluate(i => document.getElementById('sg-search').shadowRoot.querySelectorAll('.cell img')[i].hasAttribute('src'), i);
  const loaded = () => page.evaluate(() => Array.from(document.getElementById('sg-search').shadowRoot.querySelectorAll('.cell img')).filter(i => i.hasAttribute('src')).length);
  await page.waitForFunction(() => document.getElementById('sg-search').shadowRoot.querySelectorAll('.cell img')[0].hasAttribute('src'));
  assert.equal(await has(239), false, 'far below the screen: not loaded');
  assert.ok(await loaded() < 100, 'only the cells near the screen');
  await page.evaluate(() => { const b = document.getElementById('sg-search').shadowRoot.querySelector('.body'); b.scrollTop = b.scrollHeight; });
  await page.waitForFunction(() => {
    const imgs = document.getElementById('sg-search').shadowRoot.querySelectorAll('.cell img');
    return imgs[239].hasAttribute('src') && !imgs[0].hasAttribute('src');
  });
  assert.ok(await loaded() < 100);
  // A cell keeps its size while its picture is let go.
  const h = await page.evaluate(() => Array.from(document.getElementById('sg-search').shadowRoot.querySelectorAll('.cell')).slice(0, 3).map(c => Math.round(c.getBoundingClientRect().height)));
  assert.ok(h.every(x => x > 100), JSON.stringify(h));
});

test('R4: Posts & Reels has no cap either; SimpleGram\'s own pages never count toward the fallback page\'s stop', async () => {
  const s = site({ users: [NBA], keyword: codes('K0X', 24), keywordMore: 'k1',
    answers: { PolarisKeywordSearchExplorePageRelayPaginationQuery: v => {
      const n = Number(v.after.slice(1));
      return keywordGrid(codes('K' + n + 'X', 24), 'k' + (n + 1));
    } } });
  // Search opened over Instagram's own search page, where limitSearch is active.
  const page = await open('https://www.instagram.com/explore/search/keyword/?q=x', NAVPAGE, { api: s.api });
  await openSearchTab(page);
  await shadowClick(page, 'Posts & Reels');
  await query(page, 'nba');
  await waitCells(page, 24);
  for (let i = 1; i <= 5; i++) {
    await waitText(page, 'Show more');
    await shadowClick(page, 'Show more');
    await waitCells(page, 24 * (i + 1));
  }
  await waitIdle(page);
  assert.ok((await searchText(page)).includes('Show more'));
  const pages = s.log.filter(r => r.name === 'PolarisKeywordSearchExplorePageRelayPaginationQuery');
  assert.equal(pages.length, 5);
  assert.ok(pages.every(r => r.vars.first === 24));
  assert.equal(await page.evaluate(() => window.__sg.stats.searchStopped), 0);
});

test('R4: Instagram\'s own search page (the fallback) still stops after 3 pages', async () => {
  const page = await open('https://www.instagram.com/explore/search/keyword/?q=sharks', BLANK);
  const flags = await page.evaluate(p => {
    const out = [];
    for (let i = 0; i < 4; i++) out.push(JSON.parse(JSON.stringify(p)).data.xdt_fbsearch__top_serp_graphql.page_info.has_next_page);
    return out;
  }, { data: { xdt_fbsearch__top_serp_graphql: keywordGrid(['SRCH001'], 'next') } });
  assert.deepEqual(flags, [true, true, false, false]);
  assert.equal(await page.evaluate(() => window.__sg.stats.searchStopped), 2);
});

test('R4: a page with fewer than 18 new posts chains one more in the same tap; never more than 2 a tap', async () => {
  const s = placeSite(after => {
    const n = after == null ? 0 : Number(after.slice(1));
    return placePage(codes('C' + n + 'X', 12), 'c' + (n + 1));
  });
  const page = await openPlaceWith(s);
  await waitCells(page, 24);
  await waitIdle(page);
  assert.equal(firsts(s).length, 1);
  assert.deepEqual(conn(s).map(r => r.vars.after), ['c1']);
  await shadowClick(page, 'Show more');
  await waitCells(page, 48);
  await waitIdle(page);
  assert.deepEqual(conn(s).map(r => r.vars.after), ['c1', 'c2', 'c3']);
  assert.ok((await searchText(page)).includes('Show more'));
  const g = await gridStats(page);
  assert.deepEqual({ taps: g.taps, pages: g.pages, chained: g.chained, failed: g.failed, chainFailed: g.chainFailed, placeFirst: g.placeFirst },
    { taps: 2, pages: 4, chained: 2, failed: 0, chainFailed: 0, placeFirst: 24 });
  assert.deepEqual(g.sizes, [12, 12, 12, 12]);
  // Counts only: nothing from the place, the posts or the search words.
  const json = JSON.stringify(g);
  assert.ok(!/hyatt|C0X|c1/i.test(json), json);
});

test('R4: a page with 18 or more new posts is not chained', async () => {
  const s = placeSite(after => (after == null ? placePage(codes('E0X', 18), 'c1') : placePage(codes('E1X', 18), 'c2')));
  const page = await openPlaceWith(s);
  await waitCells(page, 18);
  await waitText(page, 'Show more');
  assert.equal(conn(s).length, 0);
  await shadowClick(page, 'Show more');
  await waitCells(page, 36);
  await waitText(page, 'Show more');
  assert.equal(conn(s).length, 1);
});

test('R4: chaining stops when Instagram has no more pages', async () => {
  // No next page at all: one request.
  let s = placeSite(() => placePage(codes('N0X', 5), null));
  let page = await openPlaceWith(s);
  await waitCells(page, 5);
  await waitIdle(page);
  assert.equal(conn(s).length, 0);
  assert.ok(!(await searchText(page)).includes('Show more'));
  // The chained page is the last one: two requests, then the list ends.
  s = placeSite(after => (after == null ? placePage(codes('N1X', 5), 'c1') : placePage(codes('N2X', 5), null)));
  page = await openPlaceWith(s);
  await waitCells(page, 10);
  await waitIdle(page);
  assert.equal(conn(s).length, 1);
  assert.ok(!(await searchText(page)).includes('Show more'));
});

test('R4: no duplicates when pages overlap, chained or not', async () => {
  const s = placeSite(after => ({
    first: placePage(codes('D0X', 12), 'c1'),
    c1: placePage(codes('D0X', 12, 6), 'c2'),              // 6 new, 6 already shown
    c2: placePage(codes('D0X', 18, 12), 'c3'),             // 12 new
    c3: placePage(codes('D0X', 10, 25), null),             // 5 new
  })[after == null ? 'first' : after]);
  const page = await openPlaceWith(s);
  await waitCells(page, 18);
  await waitIdle(page);
  assert.deepEqual(await cellInfo(page), { n: 18, unique: 18 });
  await shadowClick(page, 'Show more');
  await waitCells(page, 35);
  await waitIdle(page);
  assert.deepEqual(await cellInfo(page), { n: 35, unique: 35 });
  assert.deepEqual(conn(s).map(r => r.vars.after), ['c1', 'c2', 'c3']);
  assert.deepEqual((await gridStats(page)).sizes, [12, 6, 12, 5]);
});

test('R4: a failed chained page keeps the first page\'s posts and offers Try again (a 429 is not resent)', async () => {
  const state = { fail: true };
  const s = placeSite(after => {
    if (after == null) return placePage(codes('F0X', 12), 'c1');
    if (state.fail) return { status: 429, body: '<html>wait</html>' };
    return placePage(codes('F1X', 12), null);
  });
  const page = await openPlaceWith(s);
  await waitCells(page, 12);
  await waitText(page, 'Try again');
  const text = await searchText(page);
  assert.ok(text.includes('didn’t send the next posts'), text);
  assert.ok(!text.includes('Show more'));
  assert.ok(!text.includes('Open Instagram’s own page'), 'the grid stays: not the empty-grid failure');
  assert.deepEqual(conn(s).map(r => r.path), ['/api/graphql'], 'a 429 is not sent again to the other path');
  const g = await gridStats(page);
  assert.equal(g.chainFailed, 1);
  assert.equal(g.placeFirst, 24, 'a 429 is not a refusal of the page size');
  state.fail = false;
  await shadowClick(page, 'Try again');
  await waitCells(page, 24);
  await waitIdle(page);
  assert.deepEqual(conn(s).map(r => r.vars.after), ['c1', 'c1']);
  assert.ok(!(await searchText(page)).includes('Try again'));
});

test('R4: Places ask for 24 a page; if Instagram refuses that, Try again asks for the website\'s 12', async () => {
  const s = placeSite(after => (after == null ? null : placePage(codes('G1X', 12), null)));
  const handler = s.api['/api/graphql'];
  s.api['/api/graphql'] = (u, req) => {
    const r = handler(u, req);
    const e = s.log[s.log.length - 1];
    if (e.name === 'PolarisLocationPageTabContentQuery' && e.vars.first === 12) {
      e.result = 'data';
      return { body: { data: { xdt_location_get_web_info_tab: placePage(codes('G0X', 12), null) } } };
    }
    return r;
  };
  const page = await openPlaceWith(s);
  await waitText(page, 'Try again');
  assert.equal((await gridStats(page)).placeFirst, 12);
  await shadowClick(page, 'Try again');
  await waitCells(page, 12);
  assert.deepEqual(firsts(s).map(r => r.vars.first), [24, 12]);
});

test('R4: the keyword grid and a tag\'s pages chain the same way', async () => {
  const s = site({ users: [NBA], keyword: codes('W0X', 10), keywordMore: 'k1', keywordNext: codes('W1X', 10) });
  let sections = 0;
  const forms = [];
  const api = Object.assign(s.api, {
    '/api/v1/tags/web_info/': () => ({ status: 404, body: NOT_FOUND }),
    '/api/v1/tags/nba/sections/': (u, req) => {
      forms.push(Object.fromEntries(new URLSearchParams(req.postData() || '')));
      sections++;
      return { body: { sections: [{ layout_type: 'media_grid', layout_content: { medias: codes('R' + sections + 'X', 3).map(c => ({ media: media(c, user('u' + c, true)) })) } }],
        more_available: true, next_max_id: 'm' + sections, next_page: sections } };
    },
  });
  const { page } = await start(api);
  await shadowClick(page, 'Posts & Reels');
  await query(page, 'nba');
  await waitCells(page, 20);
  await waitIdle(page);
  const kw = s.log.filter(r => r.name === 'PolarisKeywordSearchExplorePageRelayPaginationQuery');
  assert.equal(kw.length, 1);
  assert.equal(kw[0].vars.after, 'k1');
  assert.equal(kw[0].vars.first, 24);
  // A tag's Most recent (the old sections list): two pages a tap.
  await shadowClick(page, 'Tags');
  await waitText(page, '#nba');
  await shadowClick(page, '#nba');
  await waitIdle(page);
  await shadowClick(page, 'Most recent');
  await waitCells(page, 6);
  await waitIdle(page);
  assert.equal(sections, 2);
  assert.equal(forms[0].max_id, undefined);
  assert.deepEqual([forms[1].tab, forms[1].max_id, forms[1].page], ['recent', 'm1', '1']);
});

test('R4: when storage refuses a long grid\'s saved state, no older copy is left to restore', async () => {
  const s = placeSite(() => placePage(codes('S0X', 24), null));
  const page = await openPlaceWith(s);
  await waitCells(page, 24);
  const left = await page.evaluate(() => {
    sessionStorage.setItem('sg_search_state', JSON.stringify({ old: true }));
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (k === 'sg_search_state') throw new DOMException('full', 'QuotaExceededError');
      return set.call(this, k, v);
    };
    try { document.getElementById('sg-search').shadowRoot.querySelector('.cell').click(); } finally { Storage.prototype.setItem = set; }
    return sessionStorage.getItem('sg_search_state');
  });
  assert.equal(left, null);
});

test('R4: leaving the grid before its first page arrives asks for no second page', async () => {
  const s = placeSite(after => placePage(codes('Q' + (after || '0') + 'X', 6), after == null ? 'c1' : 'c2'));
  const { page } = await start(Object.assign(s.api, placesApi(HYATT)));
  // Hold the place page's first answer until the grid is closed.
  let release;
  const held = new Promise(r => { release = r; });
  await page.route('**/api/graphql', async route => {
    if ((route.request().postData() || '').includes('=PolarisLocationPageTabContentQuery&')) await held;
    await route.fallback();
  });
  await query(page, 'hyatt');
  await openPlace(page);
  await page.waitForFunction(() => document.getElementById('sg-search').shadowRoot.querySelector('.spin'));
  await shadowClick(page, '‹');
  release();
  await page.waitForFunction(() => window.__sg.gqlLog.some(e => e.query === 'PolarisLocationPageTabContentQuery'));
  await page.waitForTimeout(400);
  assert.equal(firsts(s).length, 1);
  assert.equal(conn(s).length, 0);
});
