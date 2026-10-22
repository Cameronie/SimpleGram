// A model of Instagram's Home feed page for the R7 tests (not Instagram's
// code). What it copies, with sources (bundles of 2026-10-21):
// - First page: the root query (doc PolarisFeedTimelineRootV2Query) with
//   {data:{[pagination_source for non-home], device_id, is_async_*:'0'}, first:3, variant}
//   (b404 PolarisFeedRoot.entrypoint, b205 getPolarisFeedInitialPageSize = 3).
// - Next pages: the paging query (doc PolarisFeedRootPaginationCachedQuery_subscribe)
//   with {after:end_cursor, before:null, data:getExtraVariables(), first:12, last:null, variant}
//   (b344 PolarisFeed.react getExtraVariables; b344 PolarisFeedActionConstants.PAGE_SIZE = 12).
//   getExtraVariables: pagination_source = getPaginationSourceFromVariant(variant,
//   markerInEdges, connection.pagination_source) (b404): home -> 'feed_recs' when the
//   marker is in the edges or (justknobx 2492 && ps==='feed_recs'), else none; other
//   variants -> their own name. recs_paging_token from the units after the marker
//   (b344 getPolarisFeedRecsPagingToken.next: null when no marker or marker last).
// - Relay ConnectionHandler.update (b385): after==null replaces edges and page_info;
//   after===client end_cursor (or client end_cursor === server end_cursor) appends
//   (mergeEdges dedupes by node record id; feed nodes have no id, so no dedupe);
//   otherwise ignored. has_next from the server; end_cursor only if a string.
//   copyFieldsFrom copies pagination_source on every update.
// - Rendering: client__feedDedupedIds (b102) drops repeated media ids.
// - Paging only from window scroll (b32 PolarisIGVirtualList; PolarisGenericVirtualFeed:
//   throttle 250 ms, load when hasNext && !fetching && numScreensFromEnd <= 1;
//   P.threshold models a prefetch distance).
// - Empty first page: loadSULV2 (b385 subscribeToPolarisRelayFeed) and the empty-feed
//   view instead of the list (b344 PolarisFeedComponent; who sets it is logged-in code).
// - Home tab (b314 usePolarisOnHomeClick): if 30 s since the last head load,
//   scrollTo(0,0) + refetch A (paging doc, after null, first 3) + refetchFeed B
//   (root doc, first null, list replaced by the glimmer until B commits); always scrollTo(0,0).
// - Network: XHR + JSON.parse(responseText), as on the phone (feedUnits via 'parse').
// - window.require: the modules SimpleGram reads (the two compiled feed queries
//   with params.id, metadata and providedVariables; PolarisFeedQueryConstants,
//   PolarisFeedActionConstants, getAsyncParams (b25), getAsyncHeaders (b314), URI,
//   LSD). P.missing lists modules to leave out; P.badAsync makes the request
//   helpers throw. An unknown name throws, as Instagram's require does.
(function () {
  const P = window.__igP || {};
  const variant = new URLSearchParams(location.search).get('variant') || 'home';
  const BODY = { device_id: 'DEV-1', is_async_ads_double_request: '0', is_async_ads_in_headload_enabled: '0', is_async_ads_rti: '0', rti_delivery_backend: '0' };
  const ROOT = '28805668309050001', PAGING = '28847928918174870';
  const CONN = 'xdt_api__v1__feed__timeline__connection';
  const IG = window.__ig = { variant, doc: Math.random().toString(36).slice(2), conn: null, loading: false, empty: false, glimmer: false,
    ignored: 0, lastHeadLoad: Date.now(), loads: 0, heads: 0, req: 0 };
  let reqN = 0;
  const PV = ['PolarisShortDramaEnabled', 'PolarisMultiCaptionCarouselEnabled', 'PolarisThreadsStyleCommentsEnabled',
    'PolarisReelsRecoDebugOverlayEnabled', 'PolarisAdDebugToolEnabled', 'PolarisSuggestedUserFeedUnitCardsEnabled'];
  const provider = () => ({ get: () => false });
  const query = (name, id) => ({ params: { id, metadata: { is_distillery: true, root_field_name: [CONN] }, name, operationKind: 'query', text: null,
    providedVariables: Object.fromEntries(PV.map(p => ['__relay_internal__pv__' + p + 'relayprovider', provider()])) } });
  class URI {
    constructor(s) { this.s = String(s); }
    toString() { return this.s; }
    isEmpty() { return this.s === ''; }
    getDomain() { return /^https?:/.test(this.s) ? new URL(this.s).hostname : ''; }
    getProtocol() { return /^https?:/.test(this.s) ? new URL(this.s).protocol.replace(':', '') : ''; }
    getOrigin() { return /^https?:/.test(this.s) ? new URL(this.s).origin : location.origin; }
  }
  const MODULES = {
    'PolarisFeedTimelineRootV2Query.graphql': query('PolarisFeedTimelineRootV2Query', ROOT),
    'PolarisFeedRootPaginationCachedQuery_subscribe.graphql': query('PolarisFeedRootPaginationCachedQuery_subscribe', PAGING),
    PolarisFeedTimelineRootV2Query_instagramRelayOperation: ROOT,
    PolarisFeedRootPaginationCachedQuery_subscribe_instagramRelayOperation: PAGING,
    PolarisFeedQueryConstants: { FEED_TIMELINE_REQUEST_BODY: BODY, NON_ORGANIC_FEED_ITEMS: new Set() },
    PolarisFeedActionConstants: { PAGE_SIZE: 12, FEED_VIEW: 'FEED' },
    getAsyncParams: { default: method => {
      if (P.badAsync) throw new Error('getAsyncParams');
      const p = { __user: '1000', __a: 1, __req: (++reqN).toString(36), __hs: '20380.HYP:instagram_web_pkg.2.1...0', dpr: '3',
        __ccg: 'EXCELLENT', __rev: '1028000000', __s: 'a1b2c3:d4e5f6:g7h8i9', __hsi: '7560000000000000000', __dyn: '7xeUjG1mxu1syUbFp41twpUnwgU7SbzEdF8aUco2qwJw5ux609vCwjE1EE2Cw8G11wBz81s8hwGxu786a3a1YwBgao6C0Mo2swtUd8-U2zxe2GewGw9a361qw8Xxm16wa-0oa2-azo7u3C2u2J0bS1LwTwKG1pg2fwxyo6O1FwlA3a3zhA6bwIxe6V8aUuwm8',
        __csr: '', __comet_req: '7', fb_dtsg: 'DTSGTOKEN', jazoest: '26214', lsd: 'LSDTOKEN', __spin_r: '1028000000', __spin_b: 'trunk', __spin_t: '1760000000' };
      if (method !== 'POST') { delete p.fb_dtsg; delete p.lsd; }
      return p;
    } },
    getAsyncHeaders: { default: uri => {
      if (P.badAsync) throw new Error('getAsyncHeaders');
      if (!uri || typeof uri.isEmpty !== 'function') throw new TypeError('t.isEmpty is not a function');
      return { 'X-FB-LSD': 'LSDTOKEN', 'X-ASBD-ID': '359341' };
    } },
    URI: { default: URI },
    LSD: { token: 'LSDTOKEN' },
    DTSGInitialData: { token: 'DTSGTOKEN' },
  };
  if (!P.noRequire) {
    window.require = name => {
      if (P.noModules && /\.graphql$|_instagramRelayOperation$|^Polaris/.test(name)) throw new Error('Requiring unknown module "' + name + '"');
      if ((P.missing || []).includes(name) || !(name in MODULES)) throw new Error('Requiring unknown module "' + name + '"');
      return MODULES[name];
    };
  }
  function gql(doc, name, vars) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('POST', '/graphql/query');
      x.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
      x.setRequestHeader('X-FB-Friendly-Name', name);
      x.onload = () => { try { resolve(JSON.parse(x.responseText)); } catch (e) { reject(e); } };
      x.onerror = reject;
      x.send(new URLSearchParams({ av: '1000', __a: '1', __req: (++reqN).toString(36), fb_api_caller_class: 'RelayModern',
        fb_api_req_friendly_name: name, variables: JSON.stringify(vars), server_timestamps: 'true', doc_id: doc }).toString());
    });
  }
  function apply(server, after) {
    const c = IG.conn;
    if (!c || after == null) {
      IG.conn = { edges: server.edges.slice(), pi: Object.assign({ has_next_page: false, end_cursor: null }, server.page_info), ps: server.pagination_source };
      return;
    }
    c.ps = server.pagination_source;
    if (!(after === c.pi.end_cursor || c.pi.end_cursor === server.page_info.end_cursor)) { IG.ignored++; return; }
    c.edges = c.edges.concat(server.edges);
    c.pi.has_next_page = !!server.page_info.has_next_page;
    if (typeof server.page_info.end_cursor === 'string') c.pi.end_cursor = server.page_info.end_cursor;
  }
  function recsToken(edges) {
    const n = edges.map(e => e.node);
    const r = n.findIndex(x => x && x.end_of_feed_demarcator != null);
    if (r === -1 || r === n.length - 1) return null;
    return JSON.stringify({ total_num_items: n.length - 1 - r });
  }
  function extra() {
    const edges = IG.conn.edges;
    const m = edges.some(e => e && e.node && e.node.end_of_feed_demarcator);
    let f = null;
    if (variant === 'home') f = m || (P.jk2492 && IG.conn.ps === 'feed_recs') ? 'feed_recs' : null;
    else f = variant;
    let data = Object.assign({}, BODY);
    if (f) {
      data = Object.assign({}, data, { pagination_source: f });
      if (f === 'feed_recs') { const t = recsToken(edges); if (t) data.recs_paging_token = t; }
    }
    return data;
  }
  // What Instagram draws: posts, the marker, the spinner, or the empty-feed view.
  let main, list, spinner;
  function key(n) {
    if (n.media) return 'm:' + n.media.id;
    if (n.explore_story && n.explore_story.media) return 'x:' + n.explore_story.media.id;
    if (n.ad) return 'a:' + (n.ad.ad_id || '');
    return null;
  }
  function render() {
    if (!main) return;
    if (IG.empty) {
      main.innerHTML = '<div id="null-state" style="padding:40px">' + (variant === 'favorites' ? "Choose the accounts you can't miss out on" : '') + '</div>';
      return;
    }
    if (IG.glimmer) { list.innerHTML = '<div id="glimmer" style="height:600px">glimmer</div>'; spinner.style.display = 'none'; return; }
    const seen = new Set();
    const html = [];
    for (const e of (IG.conn ? IG.conn.edges : [])) {
      const n = e.node, k = key(n);
      if (k && seen.has(k)) continue;
      if (k) seen.add(k);
      if (n.media) html.push('<article data-code="' + n.media.code + '" style="display:block"><header style="height:56px">' + n.media.user.username +
        '</header><div style="height:476px;background:#333"></div><section style="height:48px">actions</section><div style="height:70px">caption</div>' +
        '<a href="/p/' + n.media.code + '/"><time>1d</time></a></article>');
      else if (n.explore_story) html.push('<article data-code="' + n.explore_story.media.code + '" style="height:650px">Suggested<a href="/p/' + n.explore_story.media.code + '/"></a></article>');
      else if (n.end_of_feed_demarcator) html.push('<div class="eof" style="height:120px">' + n.end_of_feed_demarcator.title + '</div>');
    }
    list.innerHTML = html.join('');
    spinner.style.display = IG.conn && (IG.conn.pi.has_next_page || IG.loading) ? 'block' : 'none';
  }
  IG.render = render;
  async function loadNext() {
    if (IG.loading || !IG.conn || !IG.conn.pi.has_next_page || IG.conn.pi.end_cursor == null) return;
    IG.loading = true; IG.loads++;
    const after = IG.conn.pi.end_cursor;
    try {
      const out = await gql(PAGING, 'PolarisFeedRootPaginationCachedQuery_subscribe',
        { after, before: null, data: extra(), first: 12, last: null, variant });
      apply(out.data[CONN], after);
    } catch (e) { IG.error = String(e); } finally { IG.loading = false; render(); }
  }
  function throttle(fn, ms) {
    let last = 0, timer = 0;
    return function () {
      const now = Date.now();
      if (!timer && now - last >= ms) { last = now; fn(); return; }
      if (!timer) timer = setTimeout(() => { timer = 0; last = Date.now(); fn(); }, Math.max(0, ms - (now - last)));
    };
  }
  const onScroll = throttle(() => {
    if (!list || IG.empty || IG.glimmer) return;
    const r = list.getBoundingClientRect();
    const fromEnd = (list.scrollHeight - Math.max(0, -r.top)) / innerHeight - 1;
    if (fromEnd <= (P.threshold || 1)) loadNext();
  }, 250);
  let measureQueued = false;
  addEventListener('scroll', () => {
    if (measureQueued) return;
    measureQueued = true;
    requestAnimationFrame(() => { measureQueued = false; onScroll(); });
  }, { capture: true, passive: true });
  async function head(doc, name, vars) {
    IG.heads++;
    const out = await gql(doc, name, vars);
    const c = out.data[CONN];
    apply(c, null);
    return c;
  }
  // usePolarisOnHomeClick + PolarisFeed.react refetch + PolarisFeedWrapper refetchFeed (mobile).
  IG.homeTap = () => {
    if (Date.now() - IG.lastHeadLoad > 30000) {
      window.scrollTo(0, 0);
      IG.lastHeadLoad = Date.now();
      head(PAGING, 'PolarisFeedRootPaginationCachedQuery_subscribe', { after: null, before: null, data: Object.assign({}, BODY), first: 3, last: null, variant }).then(render);
      window.scrollTo(0, 0);
      IG.glimmer = true; render();
      head(ROOT, 'PolarisFeedTimelineRootV2Query', { data: Object.assign({}, BODY), variant }).then(() => { IG.glimmer = false; render(); });
    }
    window.scrollTo(0, 0);
  };
  // A reload from another refresh path (new-posts pill, return from background):
  // kind 'none' = no scroll, 'smooth' = smooth scroll to the top first.
  IG.silentReload = (kind) => {
    if (kind === 'smooth') window.scrollTo({ top: 0, behavior: 'smooth' });
    IG.lastHeadLoad = Date.now();
    return head(ROOT, 'PolarisFeedTimelineRootV2Query', { data: Object.assign({}, BODY), first: 3, variant }).then(render);
  };
  document.addEventListener('click', e => {
    const a = e.target.closest && e.target.closest('a#home');
    if (!a) return;
    e.preventDefault();
    IG.homeTap();
  });
  (async () => {
    const first = Object.assign(variant !== 'home' ? { pagination_source: variant } : {}, BODY);
    const c = await head(ROOT, 'PolarisFeedTimelineRootV2Query', { data: first, first: 3, variant });
    main = document.getElementById('main');
    if (c.edges.length === 0) {
      IG.empty = true;
      fetch('/api/ayml', { method: 'POST' }).then(r => r.json());
      render();
      return;
    }
    list = document.createElement('div');
    spinner = document.createElement('div');
    spinner.id = 'ig-spinner';
    spinner.style.cssText = 'height:60px';
    spinner.setAttribute('role', 'progressbar');
    main.appendChild(list);
    main.appendChild(spinner);
    render();
  })();
  IG.codes = () => Array.from(document.querySelectorAll('article[data-code]')).map(a => a.dataset.code);
})();
