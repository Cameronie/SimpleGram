// Harness for the R7 tests (Home going on into Following): a mock Instagram
// server (Home, its suggestions after the marker, and Following) plus the
// Home page model in r7-page.js, with SimpleGram injected like the app does.
// Nothing reaches Instagram. Payload shapes follow the website's feed query
// (XDTFeedItem units, end_of_feed_demarcator with group_set); fixtures, not
// captures. SG_SCRIPT overrides the script under test.
'use strict';
const { before, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const SCRIPT = fs.readFileSync(process.env.SG_SCRIPT || path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'simplegram.js'), 'utf8');
const IGPAGE = fs.readFileSync(path.join(__dirname, 'r7-page.js'), 'utf8');
const ME = '1000';
const ROOT_DOC = '28805668309050001', PAGING_DOC = '28847928918174870';
let browser;
function useBrowser() {
  before(async () => { browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined }); });
  after(async () => { await browser.close(); });
}

/* ---------------- Units ---------------- */
let pk = 7000;
const users = new Map();
function userFor(name, following) {
  if (!users.has(name)) users.set(name, String(pk++));
  const u = { pk: users.get(name), id: users.get(name), username: name };
  if (following !== undefined) u.friendship_status = { following, is_feed_favorite: false };
  return u;
}
const mid = code => '3' + Buffer.from(code).toString('hex').slice(0, 14);
function mediaDict(code, u, extra) {
  return Object.assign({ id: mid(code) + '_' + u.pk, pk: mid(code), code, user: u, taken_at: 1760000000, product_type: 'feed',
    inventory_source: 'media_or_ad', image_versions2: { candidates: [{ url: 'https://scontent.cdninstagram.com/v/' + code + '_n.jpg', width: 1080, height: 1350 }] } }, extra || {});
}
const unit = node => ({ node: Object.assign({ __typename: 'XDTFeedItem' }, node), cursor: null });
const friend = code => unit({ media: mediaDict(code, userFor('f_' + code.toLowerCase(), true)) });
const recs = code => unit({ explore_story: { id: 'x' + code, media: mediaDict(code, userFor('r_' + code.toLowerCase(), false), { inventory_source: 'mixed_unconnected' }) } });
const ad = code => unit({ ad: { ad_id: 'ad' + code, items: [mediaDict(code, userFor('brand'), { ad_id: 'ad' + code })] } });
// The phone's markers carried no group items (1.2 never counted inMarker), so
// the groups here have feed_items null; next_max_id and pagination_source as in the query.
function marker(groups) {
  return unit({ end_of_feed_demarcator: { id: 'eof1', title: "You're all caught up", subtitle: "You've seen all new posts from the past 3 days.",
    style: null, group_set: { __typename: 'XDTGroupSet', id: 'gs1', active_group_id: 'feed_recs', connected_group_id: null,
      groups: groups || [
        { id: 'feed_recs', title: 'Suggested Posts', pagination_source: 'feed_recs', next_max_id: 'R0', feed_items: null },
        { id: 'past_posts', title: 'Older posts', pagination_source: 'past_posts', next_max_id: 'P0', feed_items: null }] } } });
}
function page(edges, cursor, { ps = null, more = true } = {}) {
  return { data: { xdt_api__v1__feed__timeline__connection: { pagination_source: ps, edges,
    page_info: { has_next_page: more, end_cursor: cursor, has_previous_page: false, start_cursor: null } } },
    extensions: { is_final: true } };
}

/* ---------------- Server ---------------- */
// cfg.home: { head: [units], <cursor>: { edges, next, ps } ... }, cfg.follow: [codes newest first]
// (or a function of the server state); cfg.followUnit(code, S) builds one
// Following page's units for a code (default: the friend's post);
// cfg.followFirst: codes per Following page after the first (default: as asked).
function makeServer(cfg) {
  const S = { log: [], t0: Date.now(), caughtUp: false, recsN: 0, inflight: { sg: 0, ig: 0, maxSg: 0 } };
  S.handle = (req) => {
    const body = new URLSearchParams(req.postData() || '');
    const h = req.headers();
    const vars = JSON.parse(body.get('variables') || '{}');
    const data = vars.data || {};
    // SimpleGram's own requests carry its CSRF header; the page model's XHR doesn't.
    const who = h['x-csrftoken'] ? 'sg' : 'ig';
    const entry = { who, t: Date.now() - S.t0, name: body.get('fb_api_req_friendly_name'), doc: body.get('doc_id'),
      variant: vars.variant, after: vars.after == null ? null : vars.after, first: vars.first == null ? null : vars.first,
      ps: data.pagination_source || null, token: !!data.recs_paging_token, referer: h.referer || '', path: new URL(req.url()).pathname,
      keys: Object.keys(vars).filter(k => !/^__relay_internal__pv__/.test(k)), pv: Object.keys(vars).filter(k => /^__relay_internal__pv__/.test(k)).length,
      dataKeys: Object.keys(data), bodyKeys: Array.from(body.keys()),
      headers: { root: h['x-root-field-name'] || null, asbd: h['x-asbd-id'] || null, lsd: h['x-fb-lsd'] || null, app: h['x-ig-app-id'] || null,
        csrf: h['x-csrftoken'] || null, friendly: h['x-fb-friendly-name'] || null } };
    S.log.push(entry);
    let out, delay = 0, status = 200;
    if (vars.variant === 'following') {
      delay = cfg.delay && cfg.delay.following || 150;
      const n = S.log.filter(e => e.variant === 'following').length;
      if (cfg.followFail && n >= cfg.followFail.at) {
        status = cfg.followFail.status || 200;
        out = cfg.followFail.body || { errors: [{ message: 'Please wait a few minutes before you try again.', code: 1675004 }], data: null };
        return { status, body: out, delay, entry };
      }
      const list = typeof cfg.follow === 'function' ? cfg.follow(S) : cfg.follow;
      const k = vars.after == null ? 0 : Number(String(vars.after).slice(1));
      const first = vars.after == null ? 3 : (cfg.followFirst || vars.first || 12);
      const codes = list.slice(k, k + first);
      const units = cfg.followUnit ? [].concat(...codes.map(c => cfg.followUnit(c, S))) : codes.map(friend);
      out = page(units, 'f' + (k + codes.length), { ps: 'following', more: k + codes.length < list.length });
    } else {
      delay = cfg.delay && cfg.delay.home || 100;
      if (vars.after == null) {
        const isA = entry.doc === PAGING_DOC;
        const h0 = S.caughtUp ? (isA ? cfg.home.headA : cfg.home.headB) : cfg.home.head;
        if (S.caughtUp) delay = (cfg.headOrder === 'BA') === isA ? 400 : 100;
        out = page(h0.edges, h0.next, { ps: h0.ps || null });
      } else if (cfg.home[vars.after]) {
        const p = cfg.home[vars.after];
        if (p.edges.some(e => e.node.end_of_feed_demarcator)) S.caughtUp = true;
        out = page(p.edges, p.next, { ps: p.ps || null, more: p.more !== false });
      } else {
        // Instagram's suggestions after the marker: explore_story units and ads.
        const n = ++S.recsN;
        // cfg.delay.recs: Instagram's own after-marker pages (a number, or a function of the page number).
        if (cfg.delay && cfg.delay.recs != null) delay = typeof cfg.delay.recs === 'function' ? cfg.delay.recs(n) : cfg.delay.recs;
        out = page([recs('XR' + n + 'A'), recs('XR' + n + 'B'), ad('AR' + n), recs('XR' + n + 'C'), recs('XR' + n + 'D'), ad('AS' + n)],
          'r' + n, { ps: cfg.recsPs === undefined ? 'feed_recs' : cfg.recsPs, more: cfg.recsMore !== false });
      }
    }
    return { status, body: out, delay, entry };
  };
  return S;
}

const HTML = `<!doctype html><html><head><meta name="viewport" content="width=device-width">
<script>/* page config, like Instagram's */ var __cfg=[["LSD",[],{"token":"LSDTOKEN"}],["DTSGInitialData",[],{"token":"DTSGTOKEN"}]];</script></head>
<body style="margin:0;background:#000;color:#fff"><div id="tray" style="height:120px">stories</div><main id="main"></main>
<nav id="nav" style="position:fixed;bottom:0;left:0;right:0;height:50px;background:#111;display:flex">
<div><a id="home" href="/">Home</a></div><div><a href="/explore/">Search</a></div><div><a href="/direct/inbox/">DM</a></div><div><a href="/me/">Profile</a></div></nav>
<script>${IGPAGE.replace(/<\/script/g, '<\\/script')}</script></body></html>`;

async function openIG(cfg, { url = 'https://www.instagram.com/', sgCfg = {}, igP = {} } = {}) {
  const S = makeServer(cfg);
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true });
  const pg = await context.newPage();
  S.navs = 0;
  pg.on('framenavigated', f => { if (f === pg.mainFrame()) S.navs++; });
  await pg.route('**/*', async route => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.pathname === '/graphql/query' || u.pathname === '/api/graphql') {
      const r = S.handle(req);
      S.inflight[r.entry.who]++;
      if (r.entry.who === 'sg') S.inflight.maxSg = Math.max(S.inflight.maxSg, S.inflight.sg);
      if (r.delay) await new Promise(res => setTimeout(res, r.delay));
      S.inflight[r.entry.who]--;
      r.entry.done = Date.now() - S.t0;
      return route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.body) }).catch(() => {});
    }
    if (u.pathname === '/api/ayml') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { xdt_api__v1__ayml__strict: { users: [] } } }) });
    if (u.hostname === 'www.instagram.com' && (u.pathname === '/' || u.pathname === '')) return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><body></body>' });
  });
  await pg.addInitScript(p => {
    window.__sent = [];
    window.SGNative = { postMessage: m => window.__sent.push(JSON.parse(m)) };
    window.__igP = p;
    document.cookie = 'csrftoken=CSRF1; path=/';
  }, igP);
  await pg.addInitScript(`window.__sgCfg=${JSON.stringify(Object.assign({ role: 'main', version: 'test', searchPages: 3, viewerId: ME }, sgCfg))};\n${SCRIPT}`);
  await pg.goto(url);
  await pg.waitForFunction(() => window.__ig && window.__ig.conn, null, { timeout: 5000 });
  return { pg, S, context };
}

// A reader scrolling to the bottom again and again (each a real scroll).
async function readToEnd(pg, rounds = 20, pause = 350) {
  for (let i = 0; i < rounds; i++) {
    // A swipe: a little up, then down to the end (each a real scroll event).
    await pg.evaluate(() => new Promise(res => { const se = document.scrollingElement; se.scrollTop = Math.max(0, se.scrollTop - 40);
      requestAnimationFrame(() => { se.scrollTop = se.scrollHeight; res(); }); }));
    await pg.waitForTimeout(pause);
  }
}
// A fast reader: flings down about `screens` screens a second, in steps.
async function readScreens(pg, ms, screens = 2.5) {
  const step = 100;
  for (let t = 0; t < ms; t += step) {
    await pg.evaluate(d => { const se = document.scrollingElement; se.scrollTop = Math.min(se.scrollTop + d, se.scrollHeight); }, Math.round(915 * screens * step / 1000));
    await pg.waitForTimeout(step);
  }
}
const snap = pg => pg.evaluate(() => ({
  codes: window.__ig.codes(),
  edges: window.__ig.conn ? window.__ig.conn.edges.length : 0,
  hasNext: window.__ig.conn ? window.__ig.conn.pi.has_next_page : null,
  cursor: window.__ig.conn ? window.__ig.conn.pi.end_cursor : null,
  empty: window.__ig.empty, ignored: window.__ig.ignored, doc: window.__ig.doc,
  navs: performance.getEntriesByType('navigation').length,
  fs: window.__sg.feedState(), cont: window.__sg.cont ? window.__sg.cont() : null, feed: window.__sg.stats.feed,
  feedEnd: window.__sent.filter(m => m.action === 'feedEnd'),
  skipStatus: window.__sent.filter(m => m.action === 'skipStatus'),
  y: Math.round(document.scrollingElement.scrollTop),
}));
async function waitFor(pg, fn, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await pg.waitForTimeout(50); }
  return false;
}

module.exports = { useBrowser, openIG, readToEnd, readScreens, snap, waitFor, friend, recs, ad, marker, page, ROOT_DOC, PAGING_DOC };
