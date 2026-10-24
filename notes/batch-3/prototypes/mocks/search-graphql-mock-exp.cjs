// Reproduces SimpleGram 1.1 search-overlay behaviour for Places and Tags against a
// mock that follows what the evidence says Instagram does TODAY:
//  - REST /web/search/topsearch/, /api/v1/locations/web_info/, /api/v1/fbsearch/web/top_serp/ -> 404 HTML
//  - /api/v1/fbsearch/places/ -> places (endpoint exists; logged-in shape assumed)
//  - GraphQL: PolarisSearchBoxRefetchableQuery answers users only (no hashtags/places, as in a
//    signed-in capture of 2026-09-27); PolarisLocationPageTabContentQuery only answers the
//    CURRENT doc_id 28586113187724473 and only when BOTH provided variables are present.
// Every request body SimpleGram sends is logged so the exact payloads can be compared.
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const scenario = process.argv[2] || 'module';   // module | nomodule | learn
const SCRIPT = fs.readFileSync(path.join(__dirname, process.argv[3] || 'simplegram.copy.js'), 'utf8');
// In 'learn', Instagram rotated the id again and added a provider; only what its own page sends works.
const CUR_ID = scenario === 'learn' ? '31111111111111111' : '28586113187724473';
const NEED = ['__relay_internal__pv__PolarisShortDramaEnabledrelayprovider', '__relay_internal__pv__PolarisSEOIsCrawlerrelayprovider'].concat(scenario === 'learn' ? ['__relay_internal__pv__PolarisBrandNewrelayprovider'] : []);
const log = [];

const NOT_FOUND = '<!DOCTYPE html><html><head><title>Page Not Found &bull; Instagram</title></head><body>Sorry, this page isn\'t available.</body></html>';
const NAVPAGE = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Instagram</title></head><body style="margin:0"><main>home</main>
<div style="position:fixed;bottom:0;left:0;right:0;height:50px;display:flex" id="nav"><div><a href="/" style="display:block;width:60px;height:50px">Home</a></div><div><a id="searchlink" href="/explore/" style="display:block;width:60px;height:50px">Search</a></div></div>
<script>
// Instagram's module system, as defined by its bundles: window.require(name) returns the module,
// throws for an unknown one.
(function(){
  var mods = {};
  if (${JSON.stringify(scenario)} === 'module') {
    // b314.js / b205.js (always-loaded shell bundles) define the route-preload op ids:
    mods['PolarisLocationPageTabContentQuery_instagramRelayOperation'] = '28586113187724473';
    mods['PolarisExploreLocationsContainerQuery_instagramRelayOperation'] = '28572807415659320';
    // b233.js defines the search box query id:
    mods['PolarisSearchBoxRefetchableQuery_instagramRelayOperation'] = '27706427925724183';
  }
  window.require = function(n){ if (n in mods) return mods[n]; throw new Error('Requiring unknown module "' + n + '"'); };
  window.require('LSD') // noop guard
})();
</script></body></html>`.replace("window.require('LSD') // noop guard", '');

function gqlAnswer(form) {
  const name = form.get('fb_api_req_friendly_name');
  const id = form.get('doc_id');
  let vars = {};
  try { vars = JSON.parse(form.get('variables') || '{}'); } catch (e) { /* ignore */ }
  if (name === 'PolarisSearchBoxRefetchableQuery') {
    return { data: { xdt_api__v1__fbsearch__topsearch_connection: {
      users: [{ position: 0, user: { pk: '1', username: 'nba', full_name: 'NBA', is_verified: true, profile_pic_url: '' } }],
      hashtags: [], places: [], see_more: { list: [{ position: 1, keyword: { name: 'nba', id: 'k1' } }] }, rank_token: 'r',
    } }, extensions: { is_final: true } };
  }
  if (name === 'PolarisKeywordSearchExplorePageRelayQuery') {
    return { data: { xdt_fbsearch__top_serp_graphql: { edges: [], page_info: { has_next_page: false } } } };
  }
  if (name === 'PolarisAPITopsearchQuery') {
    const d = vars.data || {};
    return { data: { xdt_api__v1__fbsearch__topsearch_connection: { users: [], places: [],
      hashtags: d.context === 'hashtag' ? [{ position: 0, hashtag: { id: 'h1', name: 'nba', media_count: 51234567 } }, { position: 1, hashtag: { id: 'h2', name: 'nbafinals', media_count: 1234567 } }] : [] } } };
  }
  if (name === 'PolarisExploreLocationsContainerQuery') {
    return { data: { xdt_location_get_web_info: { native_location_data: { location_info: { name: 'Hyatt Regency Waikiki Beach Resort and Spa', location_id: vars.location_id_str, location_address: '2424 Kalakaua Ave', location_city: 'Honolulu, Hawaii', slug: 'hyatt-regency-waikiki' } } } } };
  }
  if (name === 'PolarisLocationPageTabContentQuery_connection') {
    return { data: { xdt_location_get_web_info_tab: { edges: [{ node: { pk: '10', id: '10_1', code: 'PLACE02', media_type: 1, user: { pk: '1', username: 'x' },
      image_versions2: { candidates: [{ url: 'https://scontent.cdninstagram.com/v/q.jpg', width: 640, height: 640 }] } } }], page_info: { has_next_page: true, end_cursor: vars.after } } } };
  }
  if (name === 'PolarisLocationPageTabContentQuery') {
    if (id !== CUR_ID) {
      return { errors: [{ message: 'PersistedQueryNotFound', severity: 'CRITICAL', code: 1675002 }], data: null };
    }
    const missing = NEED.filter(k => !(k in vars));
    if (missing.length) {
      return { errors: [{ message: 'missing_required_variable_value: ' + missing.join(','), severity: 'CRITICAL', code: 1675030 }], data: null };
    }
    return { data: { xdt_location_get_web_info_tab: { edges: [{ node: { pk: '9', id: '9_1', code: 'PLACE01', media_type: 1, user: { pk: '1', username: 'x' },
      image_versions2: { candidates: [{ url: 'https://scontent.cdninstagram.com/v/p.jpg', width: 640, height: 640 }] } }, cursor: null }],
      page_info: { has_next_page: true, end_cursor: 'abc' } } } };
  }
  return { errors: [{ message: 'unexpected ' + name }], data: null };
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.route('**/*', route => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.pathname === '/' && req.method() === 'GET') return route.fulfill({ status: 200, contentType: 'text/html', body: NAVPAGE });
    if (/^\/(web\/search\/topsearch|api\/v1\/locations\/web_info|api\/v1\/fbsearch\/web\/top_serp)\//.test(u.pathname)) {
      log.push(`${req.method()} ${u.pathname}${u.search} -> 404`);
      return route.fulfill({ status: 404, contentType: 'text/html', body: NOT_FOUND });
    }
    if (u.pathname === '/api/v1/fbsearch/places/') {
      log.push(`GET ${u.pathname}${u.search} -> 200 (1 place)`);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [{ location: { pk: '213385402', name: 'Hyatt Regency Waikiki Beach Resort and Spa', address: '2424 Kalakaua Ave' }, title: 'Hyatt Regency Waikiki Beach Resort and Spa', subtitle: '2424 Kalakaua Ave' }], status: 'ok' }) });
    }
    if (u.pathname === '/api/graphql' || u.pathname === '/graphql/query') {
      const form = new URLSearchParams(req.postData() || '');
      const ans = gqlAnswer(form);
      const h = req.headers();
      log.push(`POST ${u.pathname} name=${form.get('fb_api_req_friendly_name')} doc_id=${form.get('doc_id')} vars=${form.get('variables')}\n     body keys=[${[...form.keys()].join(',')}]\n     headers=[${Object.keys(h).filter(k => /^x-/.test(k)).join(',')}]\n     -> ${ans.errors ? 'ERROR ' + ans.errors[0].message : 'data'}`);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ans) });
    }
    if (/\.(jpg|png)/.test(u.pathname)) return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.alloc(0) });
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><body></body>' });
  });
  await page.addInitScript(() => { window.SGNative = { postMessage: () => {} }; });
  await page.addInitScript(`window.__sgCfg=${JSON.stringify({ role: 'main', version: 'exp', searchPages: 3, viewerId: '1000' })};\n${SCRIPT}`);
  await page.goto('https://www.instagram.com/');
  if (scenario === 'learn') {
    await page.evaluate(id => new Promise(r => {
      const x = new XMLHttpRequest();
      x.open('POST', '/api/graphql');
      x.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
      x.onloadend = r;
      x.send(new URLSearchParams({ av: '17841400000000000', __a: '1', __comet_req: '7', fb_dtsg: 't', jazoest: '1', lsd: 'l', fb_api_caller_class: 'RelayModern', fb_api_req_friendly_name: 'PolarisLocationPageTabContentQuery', server_timestamps: 'true', doc_id: id,
        variables: JSON.stringify({ after: null, first: 12, location_id: '1', page_size_override: null, tab: 'ranked', __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: true, __relay_internal__pv__PolarisSEOIsCrawlerrelayprovider: false, __relay_internal__pv__PolarisBrandNewrelayprovider: false }) }).toString());
    }), CUR_ID);
    console.log('learned:', JSON.stringify(await page.evaluate(() => window.__sg.learned)));
  }
  await page.evaluate(() => { document.cookie = 'csrftoken=abc; path=/'; });
  const text = () => page.evaluate(() => { const h = document.getElementById('sg-search'); if (!h || h.style.display === 'none') return null; const c = h.shadowRoot.querySelector('.wrap') || h.shadowRoot; return Array.from(c.querySelectorAll('*')).filter(e => !e.children.length && e.tagName !== 'STYLE').map(e => e.textContent.trim()).filter(Boolean).join(' | '); });
  const click = t => page.evaluate(t => {
    const b = Array.from(document.getElementById('sg-search').shadowRoot.querySelectorAll('button'));
    const x = b.find(y => y.textContent.trim() === t) || b.find(y => y.textContent.includes(t));
    if (!x) throw new Error('no button ' + t); x.click();
  }, t);
  const settle = () => page.waitForTimeout(1200);

  await page.tap('#searchlink');
  await page.waitForFunction(() => { const h = document.getElementById('sg-search'); return h && h.style.display !== 'none'; });
  await page.keyboard.type('Nba');
  await settle();
  console.log('[Accounts tab]', (await text()).replace(/\s+/g, ' ').slice(0, 160));
  await click('Tags'); await settle();
  console.log('[Tags tab]    ', (await text()).replace(/\s+/g, ' ').slice(0, 160));
  // Places: new query
  await page.evaluate(() => { const i = document.getElementById('sg-search').shadowRoot.querySelector('input'); i.value = 'hyatt'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await settle();
  await click('Places'); await settle();
  console.log('[Places tab]  ', (await text()).replace(/\s+/g, ' ').slice(0, 200));
  await click('Hyatt Regency'); await settle();
  console.log('[Place Top]   ', (await text()).replace(/\s+/g, ' ').slice(0, 200));
  if (/Show more/.test(await text())) { await click('Show more'); await settle(); console.log('[Place Top+1]', (await text()).replace(/\s+/g, ' ').slice(0, 200), 'cells=', await page.evaluate(() => document.getElementById('sg-search').shadowRoot.querySelectorAll('.cell').length)); }
  await click('Most recent'); await settle();
  console.log('[Place Recent]', (await text()).replace(/\s+/g, ' ').slice(0, 200));
  console.log('gqlLog:', JSON.stringify(await page.evaluate(() => window.__sg.gqlLog || null)));
  console.log('\nREQUESTS (' + scenario + '):\n' + log.map(l => ' - ' + l).join('\n'));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
