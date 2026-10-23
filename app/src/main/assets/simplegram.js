/*
 * SimpleGram page runtime.
 *
 * Injected at document start into Instagram's own website, before any of
 * Instagram's scripts run. The most important job happens in the data layer:
 * ads, suggested posts, reposts and endless-Reels chains are removed from the
 * JSON Instagram downloads *before* Instagram renders it. Nothing is hidden
 * after the fact in the feed, so posts never jump or get swapped while you read.
 *
 * Everything else (app banners, the Reels tab, comments split view, sound,
 * downloads) uses small, idempotent hooks with fail-safe defaults: if
 * Instagram changes something we do not recognise, we leave it alone.
 */
(function () {
  'use strict';
  if (window.top !== window) return;
  if (window.__sg) return;

  // continueHome (R7): Home goes on into Following past "caught up" (the app's
  // switch; off when the app doesn't say).
  const CFG = Object.assign({ role: 'main', version: 'dev', searchPages: 3, viewerId: null, continueHome: false },
    window.__sgCfg || {});
  const SG = (window.__sg = { cfg: CFG });
  const stats = (SG.stats = {
    payloads: 0, errors: 0,
    feed: { pages: 0, seen: 0, kept: 0, ad: 0, notFollowed: 0, suggested: 0, repost: 0, unit: 0,
      streamed: 0, unknownPages: 0, stopped: 0 },
    ads: 0, chainingTrimmed: 0, exploreBlanked: 0, suggestionsBlanked: 0, searchStopped: 0,
    dom: { ads: 0, suggested: 0, reposts: 0, banners: 0, reelsTab: 0, exploreGrid: 0 },
    swipesBlocked: 0, indexed: 0, autoplayed: 0,
    downloads: { ok: 0, failed: {} },
    // Instagram's bottom bar and header links, and the Favorites star (counts,
    // timings and layout shapes only).
    nav: { homeFull: { bar: 0, header: 0 }, inserted: 0, moved: 0, notBottom: 0, waitReact: 0, waitReactGaveUp: 0,
      igHasFav: 0, taps: 0, top: 0, refresh: 0, refreshHeld: 0, closedSearch: 0, openCancelled: 0, tidyScans: 0,
      obsMs: 0, geo: null },
    // B20: the comment box in the comments panel (pixel sizes and counts only).
    comments: { boxes: 0, gapBefore: null, gapAfter: null, barH: 0, fieldH: 0, fixes: {}, opened: 0, scrolled: 0, reverted: 0 },
  });
  function bump(o, k, n) { o[k] = (o[k] || 0) + (n == null ? 1 : n); }
  // Session storage that never throws (private windows, blocked storage).
  function readSession(key) {
    try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch (e) { return null; }
  }
  function writeSession(key, v) {
    try { sessionStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* storage unavailable */ }
  }

  /* ------------------------------------------------------------------ *
   * Native bridge
   * ------------------------------------------------------------------ */
  function post(action, data) {
    try {
      const bridge = window.SGNative;
      if (bridge && typeof bridge.postMessage === 'function') {
        bridge.postMessage(JSON.stringify(Object.assign({ action: action }, data || {})));
        return true;
      }
    } catch (e) { /* bridge not available in this document */ }
    return false;
  }
  function safe(fn) {
    return function () {
      try { return fn.apply(this, arguments); } catch (e) { stats.errors++; return undefined; }
    };
  }
  // B25 touch rule: SimpleGram holds a touch still with a non-passive touchmove
  // preventDefault, never with touch-action none/pan-x (a touch-action surface
  // touched while the web engine believes a finger is down switches vertical
  // scrolling off for good). Remembered so diagnostics tell ours from Instagram's.
  const sgPrevented = new WeakSet();
  function sgPrevent(e) {
    if (!e.cancelable) return;
    e.preventDefault();
    sgPrevented.add(e);
  }
  // SimpleGram's own surface over the page (R9's Reel layer; R11's bar later):
  // nothing under it scrolls while a finger drags on it.
  function holdStill(el) {
    el.addEventListener('touchmove', e => { e.stopPropagation(); sgPrevent(e); }, { passive: false });
  }

  // B25 census: non-passive touchmove listeners on window, document and body
  // (Instagram's and SimpleGram's), net of removals. Wrapped here, at document
  // start, before any of Instagram's scripts; the wrapper only counts and
  // always calls through, whatever happens in the counting.
  let moveBlockers = 0;
  (function countMoveBlockers() {
    const live = new WeakMap();
    const key = (t, opts) => {
      const k = t === window ? 'w' : t === document ? 'd' : document.body && t === document.body ? 'b' : '';
      return k && k + ((typeof opts === 'boolean' ? opts : !!(opts && opts.capture)) ? 1 : 0);
    };
    try {
      const ET = EventTarget.prototype, add = ET.addEventListener, remove = ET.removeEventListener;
      ET.addEventListener = function addEventListener(type, fn, opts) {
        if (type === 'touchmove' && fn && opts && typeof opts === 'object' && opts.passive === false) {
          try {
            const k = key(this, opts);
            let s = k && live.get(fn);
            if (k && !s) live.set(fn, s = new Set());
            if (s && !s.has(k)) { s.add(k); moveBlockers++; }
          } catch (e) { /* counting only */ }
        }
        return add.apply(this, arguments);
      };
      ET.removeEventListener = function removeEventListener(type, fn, opts) {
        if (type === 'touchmove' && fn) {
          try { const k = key(this, opts), s = k && live.get(fn); if (s && s.delete(k)) moveBlockers--; } catch (e) { /* counting only */ }
        }
        return remove.apply(this, arguments);
      };
    } catch (e) { /* left as it was */ }
  })();

  /* ------------------------------------------------------------------ *
   * Routes
   * ------------------------------------------------------------------ */
  const CODE_RE = /^\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,})(?:\/|$)/;
  function codeFromPath(p) {
    const m = CODE_RE.exec(p || location.pathname);
    return m && m[1] !== 'audio' ? m[1] : null;
  }
  function route(p) {
    p = p || location.pathname;
    if (/^\/stories\//.test(p)) return 'story';
    if (/^\/reels\/?$/.test(p)) return 'reels-tab';
    if (/^\/(?:[^/]+\/)?p\/[^/]+\/comments/.test(p) || /^\/(?:[^/]+\/)?reels?\/[^/]+\/comments/.test(p)) return 'comments';
    if (/^\/(?:[^/]+\/)?(?:reel|reels|tv)\/[A-Za-z0-9_-]{5,}/.test(p) && codeFromPath(p)) return 'reel';
    if (/^\/(?:[^/]+\/)?p\/[A-Za-z0-9_-]{5,}/.test(p)) return 'post';
    if (/^\/explore\/search/.test(p)) return 'search';
    if (/^\/explore\/tags\//.test(p) || /^\/explore\/locations\//.test(p)) return 'search';
    if (/^\/explore\/?$/.test(p)) return 'explore';
    if (/^\/direct\//.test(p)) return 'direct';
    if (p === '/' || p === '') return 'home';
    return 'other';
  }
  function storyPk(p) {
    const m = /^\/stories\/([^/]+)\/(\d+)/.exec(p || location.pathname);
    return m && m[1] !== 'highlights' ? m[2] : null;
  }
  // Whose Stories these are: {user} for /stories/<user>/<id>/, {highlight} for highlights.
  function storyOwner(p) {
    const m = /^\/stories\/([^/]+)\/(\d+)?/.exec(p || location.pathname);
    if (!m) return null;
    return m[1] === 'highlights' ? { highlight: m[2] || null } : { user: decodeURIComponent(m[1]) };
  }
  SG.route = route;

  function viewerId() {
    if (CFG.viewerId) return String(CFG.viewerId);
    try {
      const m = /(?:^|;\s*)ds_user_id=(\d+)/.exec(document.cookie || '');
      if (m) return m[1];
    } catch (e) { /* cookies unavailable */ }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * Media index (for exact downloads)
   * ------------------------------------------------------------------ */
  const index = { byCode: new Map(), byPk: new Map(), byFile: new Map(), children: new WeakSet() };
  const userIds = new Map();
  function cap(map, max) { while (map.size > max) map.delete(map.keys().next().value); }
  function fileOf(url) {
    if (typeof url !== 'string' || !url) return null;
    try {
      const u = new URL(url, location.href);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
      const last = u.pathname.split('/').pop();
      return last && last.length > 8 ? last : null;
    } catch (e) { return null; }
  }
  function bestOf(list) {
    if (!Array.isArray(list) || !list.length) return null;
    let best = null;
    for (const c of list) {
      if (!c || typeof c.url !== 'string') continue;
      if (!best || (c.width || 0) * (c.height || 0) > (best.width || 0) * (best.height || 0)) best = c;
    }
    return best ? best.url : null;
  }
  function looksLikeMedia(o) {
    return !!(o && (o.image_versions2 || o.video_versions || o.carousel_media) &&
      (o.pk || o.id || o.code));
  }
  function mediaPk(o) {
    const raw = o.pk != null ? o.pk : o.id;
    if (raw == null) return null;
    const s = String(raw).split('_')[0];
    return /^\d+$/.test(s) ? s : null;
  }
  function itemOf(o) {
    return {
      pk: mediaPk(o),
      image: bestOf(o.image_versions2 && o.image_versions2.candidates),
      video: bestOf(o.video_versions),
      files: [],
    };
  }
  function indexMedia(o) {
    if (index.children.has(o)) return;
    const rec = itemOf(o);
    rec.code = typeof o.code === 'string' ? o.code : (typeof o.shortcode === 'string' ? o.shortcode : null);
    const user = o.user || o.owner;
    rec.username = user && typeof user.username === 'string' ? user.username : '';
    rec.children = [];
    if (Array.isArray(o.carousel_media)) {
      for (const child of o.carousel_media) {
        if (!child || typeof child !== 'object') continue;
        index.children.add(child);
        rec.children.push(itemOf(child));
      }
    }
    const register = (item, childIndex) => {
      const urls = [];
      if (item === rec) {
        const cands = o.image_versions2 && o.image_versions2.candidates;
        if (Array.isArray(cands)) for (const c of cands) urls.push(c && c.url);
        if (Array.isArray(o.video_versions)) for (const v of o.video_versions) urls.push(v && v.url);
      } else {
        const child = o.carousel_media[childIndex];
        const cands = child.image_versions2 && child.image_versions2.candidates;
        if (Array.isArray(cands)) for (const c of cands) urls.push(c && c.url);
        if (Array.isArray(child.video_versions)) for (const v of child.video_versions) urls.push(v && v.url);
      }
      for (const u of urls) {
        const f = fileOf(u);
        if (f) index.byFile.set(f, { rec: rec, child: childIndex });
      }
    };
    register(rec, -1);
    rec.children.forEach((c, i) => register(c, i));
    if (rec.code) index.byCode.set(rec.code, rec);
    if (rec.pk) index.byPk.set(rec.pk, rec);
    if (rec.pk && Array.isArray(o.story_feed_media)) noteSharedReel(rec.pk, o.story_feed_media);
    for (const c of rec.children) if (c.pk) index.byPk.set(c.pk, { pk: c.pk, image: c.image, video: c.video, username: rec.username, code: rec.code, children: [], parent: rec });
    cap(index.byCode, 1500); cap(index.byPk, 3000); cap(index.byFile, 8000);
    stats.indexed++;
  }
  SG.index = index;
  // R9: a Story item that shares a Reel carries only the Reel's code (its
  // "Watch Reel" sticker, story_feed_media); the Reel's own video is looked
  // up when you swipe up. Story item pk -> { code, pk }.
  const sharedReels = new Map();
  function noteSharedReel(pk, list) {
    for (const s of list) {
      if (!s || typeof s.media_code !== 'string' || !/^[A-Za-z0-9_-]{5,}$/.test(s.media_code)) continue;
      // A shared photo post isn't a Reel; an unknown type is tried (no video: a toast).
      if (s.product_type && s.product_type !== 'clips' && s.product_type !== 'igtv') continue;
      const id = s.media_id != null ? mediaPk({ pk: s.media_id }) : null;
      sharedReels.set(pk, { code: s.media_code, pk: id });
      cap(sharedReels, 500);
      return;
    }
  }

  /* ------------------------------------------------------------------ *
   * Data-layer filtering
   * ------------------------------------------------------------------ */
  const TIMELINE_KEY = /feed__timeline|feed_timeline|timeline__connection|feed__following|feed__favorites/i;
  const CHAINING_KEY = /clips__home|clips_home|clips__chaining|clips_chaining|clips__trending|clips__explore|clips__discover/i;
  const EXPLORE_KEY = /explore_{1,2}grid|topical_explore|explore__sectional|discover__web__explore/i;
  // (^|__)ayml(__|$): the accounts Instagram suggests when Home has nothing new (xdt_api__v1__ayml__strict).
  const SUGGEST_KEY = /^suggested_users(_v2)?$|discover__ayml|^ayml|(^|__)ayml(__|$)|suggested_accounts|similar_accounts|discover__chaining|^chaining_results$|^chaining_users$/i;
  const AD_CONTAINER_KEY = /injected_story|story_ads|ad_media_items|ads_pool|^ads$|xdt_injected/i;
  // Instagram's own search pages, and its place page (xdt_location_get_web_info_tab,
  // a post's location link or "Open Instagram's own page"): 3 pages, then they stop.
  const SEARCH_KEY = /fbsearch|top_serp|keyword_search|^media_grid$|serp_|^xdt_location_get_web_info_tab(_connection)?$/i;
  const AD_LIST_KEY = /^(edges|items|feed_items|reels_media|reels|medias|media|stories|clips|tray|story_items|fill_items)$/;
  let streamed = false;
  let ownFetch = false;     // SimpleGram's own search requests
  let ownFeedRead = false;  // SimpleGram's own Following reads (R7): never Home's pages
  let payloadVia = '', payloadFinal = null; // which hook read the payload, and its is_final (diagnostics)

  function nonEmptyId(v) {
    return v != null && v !== '' && v !== 0 && v !== '0' && v !== false;
  }
  function adLike(x) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
    if (nonEmptyId(x.ad_id)) return true;
    if (x.injected && typeof x.injected === 'object') return true;
    if (x.is_sponsored === true || x.is_ad === true || x.is_ad_media === true) return true;
    if (typeof x.__typename === 'string' && /Ad(?=[A-Z]|$)/.test(x.__typename.replace(/^XDT/, ''))) return true;
    if (x.ad && typeof x.ad === 'object' && !Array.isArray(x.ad) && ('media' in x || 'explore_story' in x)) return true;
    const m = x.media || x.media_or_ad;
    if (m && typeof m === 'object' && m !== x && !Array.isArray(m)) {
      if (nonEmptyId(m.ad_id) || (m.injected && typeof m.injected === 'object') || m.is_sponsored === true || m.is_ad === true) return true;
    }
    return false;
  }
  function mediaOf(node) {
    if (!node || typeof node !== 'object') return null;
    const m = node.media || node.media_or_ad;
    if (m && typeof m === 'object' && !Array.isArray(m)) return m;
    return looksLikeMedia(node) ? node : null;
  }
  function people(m) {
    const list = [m.user, m.owner];
    for (const key of ['coauthor_producers', 'invited_coauthor_producers']) {
      if (Array.isArray(m[key])) list.push.apply(list, m[key]);
    }
    return list.filter(u => u && typeof u === 'object');
  }
  // true: followed or yourself; false: confirmed not followed; null: unknown.
  function followState(m) {
    const me = viewerId();
    let known = false;
    for (const u of people(m)) {
      const id = u.pk != null ? String(u.pk) : (u.id != null ? String(u.id) : '');
      if (me && id === me) return true;
      const fs = u.friendship_status;
      if (fs && typeof fs.following === 'boolean') {
        known = true;
        if (fs.following) return true;
      }
    }
    return known ? false : null;
  }
  const CONTEXT_KEY = /context|header|subtitle|attribution|facepile|label|reason/i;
  function contextText(objs, re) {
    for (const obj of objs) {
      if (!obj || typeof obj !== 'object') continue;
      for (const k in obj) {
        if (!CONTEXT_KEY.test(k) || /caption|accessibility/i.test(k)) continue;
        const v = obj[k];
        if (typeof v === 'string' && re.test(v)) return true;
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          for (const k2 in v) {
            if (typeof v[k2] === 'string' && re.test(v[k2])) return true;
          }
        }
      }
    }
    return false;
  }
  function personLike(v) {
    if (!v || typeof v !== 'object') return false;
    if (Array.isArray(v)) return v.some(personLike);
    return !!(v.username || v.full_name || v.pk || v.user || v.reposter || v.users);
  }
  function repostLike(node, m) {
    for (const obj of [node, m]) {
      for (const k in obj) {
        if (!/repost|reshar/i.test(k)) continue;
        if (personLike(obj[k])) return true;
      }
    }
    return contextText([node, m], /\breposted\b/i);
  }
  function recommendedLike(node, m) {
    const src = m.inventory_source || node.inventory_source;
    // 'mixed_unconnected' is Instagram's own "Suggested for you" rule.
    if (typeof src === 'string' && /recommend|explore|suggest|chaining|netego|unconnected/i.test(src)) return true;
    if (m.is_suggested === true || m.is_recommended === true || node.is_suggested === true) return true;
    return contextText([node, m], /^\s*suggested (for you|posts?|reels?)\s*$/i);
  }
  // The label line Instagram puts on a post it picked for you.
  function exploreTitle(m) {
    const t = m.explore && typeof m.explore === 'object' ? m.explore.title : null;
    return typeof t === 'string' && t.trim() !== '';
  }
  // The units Instagram's Home query selects. A page made only of suggestion
  // units is still a feed page: it is filtered, not taken for a new format.
  const UNIT_KEYS = ['media', 'media_or_ad', 'explore_story', 'ad', 'suggested_users', 'suggested_users_v2',
    'end_of_feed_demarcator', 'stories_netego', 'bloks_netego'];
  function feedVerdict(node) {
    const v = { drop: false, reason: '', media: false, known: false, follow: null };
    const drop = r => { v.drop = true; v.reason = r; return v; };
    if (!node || typeof node !== 'object') return v;
    v.known = UNIT_KEYS.some(k => node[k] != null);
    if (adLike(node)) { v.known = true; return drop('ad'); }
    const m = mediaOf(node);
    if (m) v.media = v.known = true;
    if (node.explore_story || node.suggested_users || node.suggested_users_v2) return drop('suggested');
    if (!m) {
      if (node.end_of_feed_demarcator) return v;
      const live = Object.keys(node).filter(k => node[k] != null && k !== '__typename' && k !== 'cursor');
      return live.length ? drop('unit') : v;
    }
    if (adLike(m)) return drop('ad');
    if (repostLike(node, m)) return drop('repost');
    v.follow = followState(m);
    if (v.follow === false) return drop('notFollowed');
    if (recommendedLike(node, m)) return drop('suggested');
    // Counted on its own, so a wrong guess would show in Filter status.
    if (v.follow !== true && exploreTitle(m)) return drop('exploreTitle');
    return v;
  }
  SG.feedVerdict = feedVerdict;

  // One state per feed (home, following, favorites, past_posts). It survives
  // opening a post, a profile or Stories and coming back, because Instagram
  // keeps the feed it loaded; a reload or a refresh of the feed starts over.
  const feedStates = new Map();
  let lastVariant = 'home';
  // shownAny: this feed has handed Instagram something (a post or an anchor);
  // shownCount: posts handed that show on screen; handed: edges handed;
  // anchorKind: what anchored the first page (seen, marker, recs);
  // cont: Home goes on into Following past its marker (R7).
  function freshFeed(key) {
    return { key: key, emptyStreak: 0, seenStreak: 0, ended: false, caughtUp: false, homePages: 0,
      endText: null, endCursor: null, lastCursor: null, lastPageAt: 0,
      shownAny: false, shownCount: 0, handed: 0, anchorKind: '', resetAt: 0, cont: false };
  }
  function feedFor(key) {
    let fs = feedStates.get(key);
    if (!fs) feedStates.set(key, fs = freshFeed(key));
    return fs;
  }
  // The feed the address shows (the last one, while a post or Story is open).
  function addressVariant() {
    if (route() === 'home') lastVariant = feedVariant();
    return lastVariant;
  }
  function currentFeed() { return feedFor(addressVariant()); }
  SG.feedState = () => Object.assign({}, currentFeed());
  // Which feed a page belongs to. Instagram names Following, Favorites and
  // Older posts pages itself (pagination_source), and the address can lag
  // behind an in-page switch. Home pages carry null; 'feed_recs' is also the
  // server's label for any page holding the "caught up" marker (perhaps on
  // Following too), so both use the address.
  function pageVariant(owner) {
    const ps = owner && owner.pagination_source;
    return ps === 'following' || ps === 'favorites' || ps === 'past_posts' ? ps : addressVariant();
  }
  // The page that ends a feed is remembered: reading it again is still the end.
  function endFeed(fs, caughtUp) {
    fs.ended = true;
    if (caughtUp) fs.caughtUp = true;
    fs.endCursor = fs.lastCursor;
    safe(releaseRoom)();
  }

  // Which home feed is showing: home (Instagram's picks), following, favorites,
  // or past_posts (Instagram's older posts, never cut at its end marker).
  function feedVariant() {
    const v = new URLSearchParams(location.search).get('variant');
    return v === 'following' || v === 'favorites' || v === 'past_posts' ? v : 'home';
  }
  function here() { return location.pathname + location.search; }
  // Posts Home has shown, so Following can skip them when you continue from
  // the end of Home.
  const homeSeen = new Set();
  // Posts Home itself showed (Instagram's ranking, not Following's): a page
  // bringing one back is Home's first page again, never a next page (R7).
  const homeRanked = new Set();
  // homeSeen outlives the page load (the star's round trip to Favorites, Back
  // from the card's Following, a refresh are all full loads), for 30 min and
  // the same account, so Home never shows the same Following posts again
  // after "caught up". homeRanked stays this page's own: it tells reloads apart.
  const HOME_SEEN_KEY = 'sg_home_seen', HOME_SEEN_MS = 30 * 60000;
  let homeSeenDirty = false, homeSeenTimer = 0;
  if (CFG.role === 'main') {
    const saved = readSession(HOME_SEEN_KEY);
    if (saved && Array.isArray(saved.codes) && saved.acct === (viewerId() || '') && Date.now() - saved.at < HOME_SEEN_MS) {
      for (const c of saved.codes) if (typeof c === 'string') homeSeen.add(c);
    }
  }
  function saveHomeSeen() {
    clearTimeout(homeSeenTimer);
    homeSeenTimer = 0;
    if (!homeSeenDirty) return;
    homeSeenDirty = false;
    writeSession(HOME_SEEN_KEY, { acct: viewerId() || '', at: Date.now(), codes: Array.from(homeSeen).slice(-3000) });
  }
  if (CFG.role === 'main') {
    window.addEventListener('pagehide', () => { try { saveHomeSeen(); } catch (e) { /* storage unavailable */ } });
    document.addEventListener('visibilitychange', () => { try { if (document.hidden) saveHomeSeen(); } catch (e) { /* storage unavailable */ } });
  }
  function noteHomeShown(code, ranked) {
    homeSeen.delete(code);
    homeSeen.add(code);
    if (homeSeen.size > 4000) homeSeen.delete(homeSeen.values().next().value);
    if (CFG.role === 'main') {
      homeSeenDirty = true;
      if (!homeSeenTimer) homeSeenTimer = setTimeout(() => { try { saveHomeSeen(); } catch (e) { /* storage unavailable */ } }, 2000);
    }
    if (!ranked) return;
    homeRanked.add(code);
    if (homeRanked.size > 4000) homeRanked.delete(homeRanked.values().next().value);
  }
  const SKIP_KEY = 'sg_skip_seen';
  // B23: what Home's continuation (R7) already read of Following, carried to
  // the card's Following page so its first page starts right past the posts
  // seen in Home: Following's cursor there and the posts read but not shown.
  // Only fresh reads (5 min) of the same account; bounded in size. read: the
  // codes R7 read along the chain that ends at the cursor, nearest Following's
  // head (the proof that no post lies between Following's head and the cursor).
  const CARRY_MS = 5 * 60000, CARRY_POSTS = 48, CARRY_CHARS = 1000000, CARRY_READ = 60;
  // Why a carry was left behind (kept for the next report): too big for
  // storage, too many posts, storage refused, or an error reading it.
  const CARRY_DROPS = ['big', 'many', 'quota', 'error'];
  function carryOk(c) {
    if (!c || typeof c !== 'object') return '';
    if (c.dropped) return CARRY_DROPS.includes(c.dropped) ? c.dropped : 'shape';
    if (!c.acct || c.acct !== (viewerId() || '')) return 'acct';
    if (!(Date.now() - c.at < CARRY_MS && Date.now() >= c.at - 1000)) return 'stale';
    if (typeof c.cursor !== 'string' || !c.cursor || c.cursor.length > 512 || !Array.isArray(c.edges) ||
        c.edges.length > CARRY_POSTS || c.edges.some(e => !e || typeof e !== 'object' || !edgeCode(e))) return 'shape';
    if (c.read !== undefined && (!Array.isArray(c.read) || c.read.length > CARRY_READ ||
        c.read.some(k => typeof k !== 'string' || k.length > 64))) return 'shape';
    return 'ok';
  }
  // Used once, by the page the end-of-Home card opens, then forgotten:
  // opening Following any other way shows everything. passed: seen posts
  // already skipped here; nudgedAt: the skip's own pace (not Home's); carry:
  // the start carried from Home (B23), until Instagram's first page uses it.
  let skip = null;
  try {
    const saved = JSON.parse(sessionStorage.getItem(SKIP_KEY) || 'null');
    sessionStorage.removeItem(SKIP_KEY);
    if (saved && saved.variant === feedVariant() && Array.isArray(saved.codes) && Date.now() - saved.at < 60 * 1000) {
      skip = { variant: saved.variant, path: here(), codes: new Set(saved.codes),
        passed: new Set(), nudgedAt: [], halted: false, status: '', statusTimer: 0, carry: null };
      // Diagnostics: none (nothing carried), used, cursor (only the cursor),
      // new (Instagram's first page was not in R7's reading: B17's skipping),
      // why it was ignored, or why Home left it behind (CARRY_DROPS, with the
      // number of posts and, when too big, its size).
      const ok = saved.variant === 'following' ? carryOk(saved.carry) : '';
      stats.feed.carry = ok || 'none';
      if (ok === 'ok') skip.carry = saved.carry;
      else if (CARRY_DROPS.includes(ok)) {
        if (typeof saved.carry.n === 'number') stats.feed.carryN = saved.carry.n;
        if (typeof saved.carry.chars === 'number') stats.feed.carryChars = saved.carry.chars;
      }
    }
  } catch (e) { /* storage unavailable */ }
  function skipping() {
    return skip && here() === skip.path ? skip.codes : null;
  }
  // The skip is over (a reload or a loop of seen posts, or you went to another
  // feed in the page): what comes next is shown as Instagram sends it.
  function forgetSkip(counter) {
    if (!skip) return;
    clearTimeout(skip.statusTimer);
    if (skip.status) post('skipStatus', { on: false, kind: '', n: 0 });
    skip = null;
    if (counter) bump(stats.feed, counter);
    safe(dropRoom)();
  }
  function continueFeed(variant) {
    const saved = { variant: variant, codes: Array.from(homeSeen).slice(-3000), at: Date.now() };
    let carry = null;
    if (variant === 'following') { try { carry = contCarry(); } catch (e) { carry = { dropped: 'error' }; } }
    // Left behind (B17's skipping only), with why, so the next report can tell it from "nothing read".
    const dropped = (why, chars) => JSON.stringify(Object.assign({ carry: carry ? { dropped: why,
      n: Array.isArray(carry.edges) ? carry.edges.length : (carry.n || 0), chars: chars || 0 } : null }, saved));
    try {
      let text = JSON.stringify(Object.assign({ carry: carry }, saved));
      if (text.length > CARRY_CHARS) text = dropped('big', text.length);
      sessionStorage.setItem(SKIP_KEY, text);
    } catch (e) {
      try { sessionStorage.setItem(SKIP_KEY, dropped(carry && carry.dropped ? carry.dropped : 'quota')); } catch (e2) {
        try { sessionStorage.setItem(SKIP_KEY, JSON.stringify(saved)); } catch (e3) { /* storage unavailable: no skipping */ }
      }
    }
    location.assign('/?variant=' + variant);
  }
  function stopPagination(o) {
    if (!o || typeof o !== 'object') return;
    const pi = o.page_info || o.pageInfo;
    if (pi && typeof pi === 'object') {
      if ('has_next_page' in pi) pi.has_next_page = false;
      if ('hasNextPage' in pi) pi.hasNextPage = false;
    }
    for (const k of ['more_available', 'has_more', 'moreAvailable', 'hasMore', 'has_next_page']) {
      if (k in o) o[k] = false;
    }
  }
  function hasMore(o) {
    const pi = o.page_info || o.pageInfo;
    if (pi && (pi.has_next_page || pi.hasNextPage)) return true;
    return !!(o.more_available || o.has_more || o.moreAvailable);
  }
  // Real paging fields. Instagram's groups and other plain lists have none,
  // so they never say where a feed ends.
  function pagingOwner(o) {
    return !!(o.page_info || o.pageInfo) || ['more_available', 'has_more', 'moreAvailable', 'hasMore'].some(k => k in o);
  }
  function cursorOf(o) {
    const pi = o.page_info || o.pageInfo;
    const c = (pi && (pi.end_cursor || pi.endCursor)) || o.next_max_id || null;
    return typeof c === 'string' || typeof c === 'number' ? String(c) : null;
  }
  function unitOf(e) { return e && e.node ? e.node : e; }

  // Instagram's "You're all caught up" marker, and the lists inside it (its
  // Suggested Posts and Older posts groups), which are not pages of the feed.
  const markerLists = new WeakSet();
  function markerAt(list) {
    for (let i = 0; i < list.length; i++) {
      const n = unitOf(list[i]);
      if (n && typeof n === 'object' && n.end_of_feed_demarcator) return i;
    }
    return -1;
  }
  function markerGroups(n) {
    const d = n && n.end_of_feed_demarcator;
    const groups = d && d.group_set && d.group_set.groups;
    return Array.isArray(groups) ? groups.filter(g => g && Array.isArray(g.feed_items)) : [];
  }
  // A post from someone you follow (or your own), with nothing else against it.
  function followedPost(e) {
    const n = unitOf(e);
    const m = mediaOf(n);
    return !!m && !feedVerdict(n).drop && followState(m) === true;
  }
  // A group inside the marker (Following, Favorites): only posts from people
  // you follow. It never counts as a page and never moves the feed's end.
  function filterMarkerList(list) {
    if (streamed) return;
    const seen = skipping();
    const keep = list.filter(e => followedPost(e) && !(seen && seen.has(edgeCode(e))));
    if (keep.length === list.length) return;
    stats.feed.inMarker = (stats.feed.inMarker || 0) + list.length - keep.length;
    list.splice(0, list.length, ...keep);
  }
  function markerText(s) { return typeof s === 'string' ? s.slice(0, 200) : ''; }
  // Home ends at the marker. Once Instagram sees it, every later page is its
  // suggestions, so the marker and everything after it go and paging stops;
  // the app's own card marks the end and carries Instagram's line.
  // (Kept with emptied groups, Instagram would still advertise more pages.)
  // With R7 on, paging stays on and Following follows the marker instead.
  // Returns the marker it cut (the first page's anchor may put it back).
  function endHome(owner, list, fs, ctx, first) {
    const at = markerAt(list);
    let cut = null;
    if (at >= 0) {
      cut = list[at];
      const marker = unitOf(cut);
      const d = marker.end_of_feed_demarcator;
      fs.endText = { title: markerText(d.title), subtitle: markerText(d.subtitle) };
      for (const g of markerGroups(marker)) stats.feed.inMarker = (stats.feed.inMarker || 0) + g.feed_items.length;
      if (ctx) { noteUnit(list[at], 'end', ctx); for (const e of list.slice(at + 1)) noteUnit(e, 'afterEnd', ctx); }
      stats.feed.eof = (stats.feed.eof || 0) + 1;
      stats.feed.afterEnd = (stats.feed.afterEnd || 0) + list.length - at - 1;
      list.splice(at);
    } else if (owner.pagination_source === 'feed_recs') {
      // Instagram's all-suggestions feed: only posts from people you follow stay.
      const keep = list.filter(followedPost);
      // Home's very first page labelled this way, with nothing to keep: never
      // emptied (Instagram would show its empty-feed screen and stop); the
      // recs anchor keeps it paging until the marker comes.
      if (first && !keep.length) { bump(stats.feed, 'recsFirst'); return null; }
      if (ctx) for (const e of list) if (keep.indexOf(e) < 0) noteUnit(e, 'recs', ctx);
      stats.feed.recsPages = (stats.feed.recsPages || 0) + 1;
      stats.feed.afterEnd = (stats.feed.afterEnd || 0) + list.length - keep.length;
      list.splice(0, list.length, ...keep);
    } else {
      return null;
    }
    if (safe(contArm)(fs, owner) === true) return cut;   // R7: paging stays on, Following comes next
    if (fs.cont) { fs.cont = false; safe(contFail)('error'); }   // a start that broke: the card, as before
    endHomePaging(owner, fs);
    endFeed(fs, true);
    return cut;
  }
  // The one place that stops Home's paging at its end (here and for the
  // anchored marker). The continuation past "caught up" (R7) leaves it on.
  function endHomePaging(owner, fs) {
    if (fs && fs.cont) return;
    stopPagination(owner);
  }

  /* The anchor: a feed's first page is never handed to Instagram empty.
   * An empty first page makes Instagram show its own empty-feed screen
   * (suggested accounts, which SimpleGram blanks, or Favorites' star), and it
   * never asks for a second page. One rule for every feed, in this order:
   *  - seen: the page's oldest post you already saw in Home (the last one; it
   *    sits next to the first new post);
   *  - marker: Instagram's own "caught up" line, without its groups;
   *  - recs: on Home, the first suggestion (never an ad), hidden before it is
   *    drawn, while the scroll room and nudges bring the next page;
   *  - last, on every feed: the first dropped post that is not an ad (a
   *    repost, a suggestion), hidden and paged past the same way, so a
   *    Favorites or Following first page of reposts is never empty. */
  const anchorCodes = [];
  function anchorFirstPage(fs, owner, list, verdicts, cut, home) {
    let at = -1;
    verdicts.forEach((x, i) => { if (x.reason === 'alreadySeen') at = i; });
    if (at >= 0) {
      verdicts[at].drop = false;
      verdicts[at].reason = 'anchor';
      return { kind: 'seen' };
    }
    if (cut) return keepMarker(fs, owner, cut);
    const i = home ? recsAnchorAt(list) : -1;
    if (i >= 0 && hideAnchor(list[i])) {
      verdicts[i].drop = false;
      verdicts[i].reason = 'anchor';
      return { kind: 'recs' };
    }
    for (let j = 0; j < list.length; j++) {
      const n = unitOf(list[j]);
      if (!verdicts[j].drop || verdicts[j].reason === 'ad' || !n) continue;
      if ([n, mediaOf(n), n.explore_story, mediaOf(n.explore_story)].some(adLike)) continue;   // never an ad
      if (!hideAnchor(list[j])) continue;
      verdicts[j].drop = false;
      verdicts[j].reason = 'anchor';
      verdicts[j].media = false;   // hidden: never counted as a post shown
      bump(stats.feed, 'anchorDropped');
      return { kind: 'recs' };
    }
    return null;
  }
  // Instagram's marker, neutralised: no groups, so Instagram neither offers
  // its suggestions nor more pages; the app's card then leaves out its line.
  // With R7 running, more pages stay on: Following comes after it.
  function keepMarker(fs, owner, cut) {
    const d = unitOf(cut).end_of_feed_demarcator;
    if (d.group_set && typeof d.group_set === 'object') { d.group_set.groups = []; d.group_set.active_group_id = null; }
    if (fs.endText) fs.endText.subtitle = '';
    if (fs.cont) cont.anchors++;
    endHomePaging(owner, fs);
    return { kind: 'marker', edge: cut };
  }
  function recsAnchorAt(list) {
    for (let i = 0; i < list.length; i++) {
      const n = unitOf(list[i]);
      if (n && n.explore_story && !adLike(n) && !adLike(n.explore_story)) return i;
    }
    return -1;
  }
  // Hidden by a style rule keyed on the post's own link, so it is never drawn
  // and nothing in Instagram's list changes height later. Returns false when
  // it cannot be hidden (no usable link, or the rule is full): it is not kept.
  // Never unhidden: Instagram may still hold an older one. Only on a feed:
  // the same post opened on its own page (a share, a profile, search) shows.
  const ON_FEED = 'html:not([data-sg-feed=""]) ';
  function hideAnchor(e) {
    const n = unitOf(e);
    const m = n && (mediaOf(n.explore_story) || n.explore_story || mediaOf(n));
    const code = m && (m.code || m.shortcode);
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(code)) return false;
    if (anchorCodes.indexOf(code) < 0) {
      if (anchorCodes.length >= 40) return false;
      anchorCodes.push(code);
    }
    let st = document.getElementById('sg-anchor-style');
    if (!st && document.documentElement) {
      st = document.createElement('style');
      st.id = 'sg-anchor-style';
      (document.head || document.documentElement).appendChild(st);
    }
    if (!st) return false;
    st.textContent = anchorCodes.map(c => ['/p/', '/reel/'].map(k => ON_FEED + 'article:has(a[href*="' + k + c + '/"]),' + ON_FEED + 'div[role="article"]:has(a[href*="' + k + c + '/"])').join(','))
      .join(',') + '{display:none!important}';
    return true;
  }
  function countAnchor(kind) {
    bump(stats.feed, 'anchor');
    const k = stats.feed.anchorKind || (stats.feed.anchorKind = { seen: 0, marker: 0, recs: 0 });
    bump(k, kind);
  }

  // Diagnostics: the shapes of the last 40 Home units, for Filter status.
  // Never names, codes, captions or URLs: only Instagram's type values.
  // pg page, i index in it, k kind (m media, x explore_story, a ad, e end
  // marker, s suggested users, n netego, o other), v verdict, f follow (1/0/null),
  // inv inventory_source, pt product_type, sc social_context types,
  // ps pagination_source, nx has_next as sent, fin is_final, via hook.
  function shapeToken(s) {
    if (s == null) return null;
    return typeof s === 'string' && /^[\w.:-]{1,64}$/.test(s) ? s.slice(0, 32) : '?';
  }
  function unitKind(n) {
    if (!n || typeof n !== 'object') return 'o';
    if (n.end_of_feed_demarcator) return 'e';
    if (adLike(n) || n.ad) return 'a';
    if (n.explore_story) return 'x';
    if (n.suggested_users || n.suggested_users_v2) return 's';
    if (n.stories_netego || n.bloks_netego) return 'n';
    return mediaOf(n) ? 'm' : 'o';
  }
  function unitContext(owner, list) {
    return { pg: stats.feed.pages, ps: shapeToken(owner.pagination_source), nx: hasMore(owner), fin: payloadFinal,
      via: payloadVia, pos: new Map(list.map((e, i) => [e, i])) };
  }
  function noteUnit(e, verdict, ctx) {
    const n = unitOf(e) || {};
    const m = mediaOf(n) || mediaOf(n.explore_story);
    const f = m ? followState(m) : null;
    const sc = m && m.social_context;
    const ring = stats.feedUnits || (stats.feedUnits = []);
    ring.push({ pg: ctx.pg, i: ctx.pos.get(e), k: unitKind(n), v: verdict, f: f === null ? null : f ? 1 : 0,
      inv: shapeToken((m && m.inventory_source) || n.inventory_source || (n.explore_story && n.explore_story.inventory_source)),
      pt: shapeToken(m && m.product_type),
      sc: Array.isArray(sc) ? sc.slice(0, 4).map(c => shapeToken(c && c.social_context_type)) : sc ? ['text'] : [],
      ps: ctx.ps, nx: ctx.nx, fin: ctx.fin, via: ctx.via });
    if (ring.length > 40) ring.splice(0, ring.length - 40);
  }

  /* Diagnostics that survive a restart: a trail of the last feed pages and
   * feed events, mirrored to the app as each entry is written (Copy details).
   * Counts, flags and Instagram's type values only. Page entries: d page load
   * in this session, pg feed page in it, nav how this page load started
   * (navigate, reload, back_forward, bfcache; spa after an in-page address
   * change), va feed by address, vp feed by page, ps pagination_source, in/out
   * edges, k posts kept, sk skipped as seen, ad, sg suggestions, mk marker
   * index, nx0/nx1 has_next in/out, an anchor kind, first, ae after the end;
   * R7: hw why a page after the marker was taken for Home's first page again,
   * ik Instagram's own followed posts kept and cf Following posts handed. */
  const TRAIL_MAX = 30;
  const docN = (readSession('sg_doc_n') | 0) + 1;
  writeSession('sg_doc_n', docN);
  const docHref = location.href;
  let navType = '', fromBfcache = false;
  try {
    const n = performance.getEntriesByType('navigation')[0];
    navType = n && typeof n.type === 'string' ? n.type : '';
  } catch (e) { /* navigation timing unavailable */ }
  function navKind() { return fromBfcache ? 'bfcache' : location.href !== docHref ? 'spa' : shapeToken(navType) || '?'; }
  function tenths() { return Math.round(performance.now() / 100) * 100; }
  function pushTrail(entry) {
    if (CFG.role !== 'main') return;
    entry.d = docN;
    if (entry.pg == null) entry.pg = stats.feed.pages;
    entry.nav = navKind();
    entry.t = tenths();
    const ring = stats.trail || (stats.trail = []);
    ring.push(entry);
    if (ring.length > TRAIL_MAX) ring.splice(0, ring.length - TRAIL_MAX);
    post('trail', { entry: entry });
    if (entry.ev === 'page') sampleDrawnSoon();
  }
  SG.trail = () => (stats.trail || []).slice();
  // What is drawn 3 s after a feed page: posts, the Stories tray, Instagram's
  // Favorites star screen, a list of Follow buttons with no posts (its
  // suggested-accounts screen), its header and bar, and frames drawn in half
  // a second (0: a frozen or white page).
  const STAR_NULL = 'svg[aria-label="Star outline icon in circle."]';
  let drawnTimer = 0;
  function sampleDrawnSoon() {
    if (drawnTimer) return;
    drawnTimer = setTimeout(safe(() => {
      // Bounded by count, never by a clock: a frame loop must always end.
      let frames = 0, done = false;
      const tick = () => { if (done) return; frames++; if (frames < 60) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      setTimeout(safe(() => { done = true; drawnTimer = 0; pushTrail(Object.assign({ ev: 'drawn', raf: frames }, drawnShape())); }), 500);
    }), 2500);
  }
  function followButtons(scope, max) {
    let n = 0;
    if (scope) for (const b of scope.querySelectorAll('button,[role="button"]')) if (/^follow$/i.test(norm(b)) && ++n >= max) break;
    return n;
  }
  function drawnShape() {
    const posts = document.querySelectorAll(POST).length;
    return { posts: Math.min(posts, 99), tray: !!document.querySelector('a[href^="/stories/"],main canvas'),
      star: !!document.querySelector(STAR_NULL), sul: posts ? 0 : followButtons(document.querySelector('main'), 5),
      hdr: !!document.querySelector('header,[role="banner"]'), bar: !!document.querySelector('a[href="/direct/inbox/"],a[href="/explore/"]'),
      hidden: !!document.hidden };
  }
  // Instagram asking for suggested accounts right after a feed's first page
  // came out empty: its empty-feed screen.
  let emptyFirstAt = 0;
  function noteAyml() {
    if (!emptyFirstAt || Date.now() - emptyFirstAt > 3000) return;
    emptyFirstAt = 0;
    bump(stats.feed, 'aymlAfterEmpty');
    pushTrail({ ev: 'ayml' });
  }

  /* Diagnostics for Home jumping back to its top (B16), shapes only: Home's
   * events (Home-tab taps, same-address history writes, the app going to the
   * background, jumps to the top with no touch, leaving and coming back) and
   * Home's pages with the list height in screens when each was read and
   * 1.5 s later (a reload shrinks it, a next page grows it). */
  function screens(px) { return Math.round(px / Math.max(1, innerHeight) * 10) / 10; }
  function homeEvent(e) {
    if (CFG.role !== 'main') return;
    e.t = tenths();
    const ring = stats.homeEvents || (stats.homeEvents = []);
    const last = ring[ring.length - 1];
    if (last && e.e === 'hist' && last.e === 'hist' && last.k === e.k && e.t - last.t < 1000) { last.n = (last.n || 1) + 1; return; }
    ring.push(e);
    if (ring.length > 30) ring.shift();
  }
  let lastHomePageAt = 0;
  // fe: screens from the end when read (how far ahead Instagram pages);
  // am: read after the marker, while Home goes on into Following (R7).
  function noteHomePage(owner, list, fs) {
    if (CFG.role !== 'main') return;
    const se = document.scrollingElement || document.documentElement;
    const pi = owner.page_info || owner.pageInfo || {};
    const now = Date.now();
    const e = { pg: stats.feed.pages, dt: lastHomePageAt ? now - lastHomePageAt : -1, y: screens(se.scrollTop),
      sh0: screens(se.scrollHeight), sh1: null, fe: screens(Math.max(0, se.scrollHeight - se.scrollTop - innerHeight)), am: !!fs.cont,
      seen: list.filter(x => followedPost(x) && homeSeen.has(edgeCode(x))).length,
      hp: [!!(pi.has_previous_page || pi.hasPreviousPage), !!(pi.start_cursor || pi.startCursor)],
      mk: markerAt(list) >= 0, ps: shapeToken(owner.pagination_source), nx: hasMore(owner) };
    lastHomePageAt = now;
    const ring = stats.homeRing || (stats.homeRing = []);
    ring.push(e);
    if (ring.length > 20) ring.shift();
    setTimeout(safe(() => { e.sh1 = screens(se.scrollHeight); }), 1500);
  }
  function yBucket() {
    const se = document.scrollingElement || document.documentElement;
    if (se.scrollTop <= 8) return 'top';
    return se.scrollHeight - (se.scrollTop + innerHeight) < innerHeight ? 'end' : 'mid';
  }

  function filterFeedList(owner, list) {
    if (ownFeedRead) return;   // SimpleGram's own Following read: not one of Home's pages
    if (markerLists.has(list)) { filterMarkerList(list); return; }
    stats.feed.pages++;
    const variant = pageVariant(owner);
    let fs = feedFor(variant);
    const home = variant === 'home';
    const ctx = home ? unitContext(owner, list) : null;
    const sentMore = hasMore(owner);
    // The trail entry for this page (shapes and counts only).
    const tr = { ev: 'page', va: addressVariant(), vp: variant, ps: shapeToken(owner.pagination_source),
      in: list.length, mk: markerAt(list), nx0: sentMore };
    if (home) safe(noteHomePage)(owner, list, fs);
    safe(triedHit)();
    fs.lastPageAt = Date.now();
    if (streamed) {
      stats.feed.streamed++;
      if (ctx) for (const e of list) noteUnit(e, 'streamed', ctx);
      safe(pushTrail)(Object.assign(tr, { out: list.length, st: true }));
      return;
    }
    const cursor = cursorOf(owner);
    // R7: after "caught up", Instagram's next page carries Following, unless
    // it is Home's first page again (a reload replaces the whole list).
    const jump = home && cont.on && contJump();
    const tap = home && cont.on && contTap();
    if (home && fs.cont) {
      // A rule that fails takes the page for a reload: it is then filtered as usual.
      let why = safe(contHead)(owner, list, jump, tap);
      if (why === undefined) why = 'error';
      if (why) {
        cont.heads++;
        // A refresh sends two head loads: the second one, within 2 s of the
        // first one's reset and from the same tap or jump to the top (made
        // before that reset), is the same reload: one reset, one start. Only
        // one is merged, so a real reset loop still counts every time.
        const merge = !fs.contMerged && !!fs.contReset && Date.now() - fs.resetAt < 2000 &&
          ((tap && tapAt <= fs.resetAt) || (jump && topJumpAt <= fs.resetAt));
        safe(contReset)(merge);
        feedStates.set(fs.key, fs = freshFeed(fs.key));
        fs.lastPageAt = fs.resetAt = Date.now();
        fs.contReset = true;
        fs.contMerged = merge;
        if (!merge) stats.feed.refreshes = (stats.feed.refreshes || 0) + 1;
        tr.hw = why;
      } else {
        fs.lastCursor = cursor;
        try {
          contHandover(owner, list, fs, ctx, tr);
        } catch (e) {
          // Never Instagram's suggestions: its new followed posts at most, then Home ends with the card.
          stats.errors++;
          safe(contFail)('error');
          list.splice(0, list.length, ...list.filter(x => safe(followedPost)(x) && !homeSeen.has(edgeCode(x))));
          stopPagination(owner);
          fs.contStopped = true;
          endFeed(fs, true);
        }
        return;
      }
    }
    if (fs.ended && cursor !== fs.endCursor) {
      if (markerAt(list) >= 0 || list.some(followedPost)) {
        // Instagram refreshed the feed (pull to refresh, the Home tab): start over.
        feedStates.set(fs.key, fs = freshFeed(fs.key));
        fs.lastPageAt = fs.resetAt = Date.now();
        stats.feed.refreshes = (stats.feed.refreshes || 0) + 1;
      } else {
        // Instagram's suggestions after the end are never shown. Paging was
        // already stopped, so this may be a reload that replaces Home's whole
        // list (each refresh is one or two): one hidden suggestion stays, never
        // an empty list. Hidden, so stacked ones on appended pages draw nothing.
        let keep = home ? recsAnchorAt(list) : -1;
        if (keep >= 0 && !hideAnchor(list[keep])) keep = -1;
        if (ctx) list.forEach((e, i) => noteUnit(e, i === keep ? 'anchor' : 'afterEnd', ctx));
        stats.feed.afterEnd = (stats.feed.afterEnd || 0) + list.length - (keep >= 0 ? 1 : 0);
        if (keep >= 0) {
          list.splice(0, list.length, list[keep]);
          fs.handed++;
          countAnchor('recs');
          bump(stats.feed, 'anchorAfterEnd');
        } else {
          list.length = 0;
        }
        stopPagination(owner);
        fs.endCursor = cursor;
        safe(pushTrail)(Object.assign(tr, { out: list.length, nx1: false, an: keep >= 0 ? 'recs' : '', ae: true }));
        return;
      }
    }
    // A refresh sends two head loads and Instagram keeps the one that lands
    // last: a Home page right after a refresh reset is a first page too.
    // After a reset of the continuation (R7) only a real head counts (a jump
    // to the top, a passed Home-tab tap): the marker page that follows a
    // short head lands within seconds and must stay cut, never anchored.
    const first = !fs.shownAny || (home && (fs.contReset ? jump || tap : Date.now() - fs.resetAt < 2000));
    const prevCursor = fs.lastCursor;
    fs.lastCursor = cursor;
    const cut = home ? endHome(owner, list, fs, ctx, first) : null;
    if (!home) for (const e of list) for (const g of markerGroups(unitOf(e))) markerLists.add(g.feed_items);
    const verdicts = list.map(e => feedVerdict(unitOf(e)));
    if (list.length && !verdicts.some(x => x.known)) {
      // Nothing recognisable: Instagram probably changed its format. Fail open.
      stats.feed.unknownPages++;
      if (ctx) for (const e of list) noteUnit(e, 'open', ctx);
      fs.shownAny = true;
      fs.handed += list.length;
      safe(pushTrail)(Object.assign(tr, { out: list.length, open: true }));
      return;
    }
    const media = verdicts.filter(x => x.media);
    if (stats.feed.kept === 0 && media.length >= 3 && media.every(x => x.reason === 'notFollowed')) {
      stats.feed.followSuspect = (stats.feed.followSuspect || 0) + 1;
      for (const x of media) { x.drop = false; x.reason = ''; }
    }
    let seenCodes = skip && skip.variant === variant ? skipping() : null;
    if (seenCodes) {
      // Following never repeats a post: a page whose seen posts were all
      // skipped here already is Instagram reloading its first page (pull to
      // refresh) or looping. The skip ends; the page shows as sent.
      const seenHere = verdicts.map((x, i) => x.media && !x.drop ? edgeCode(list[i]) : null).filter(c => c && seenCodes.has(c));
      if (seenHere.length && seenHere.every(c => skip.passed.has(c))) { forgetSkip('skipForgotten'); seenCodes = null; }
      else for (const c of seenHere) skip.passed.add(c);
    }
    if (seenCodes) {
      verdicts.forEach((x, i) => {
        const code = x.media && !x.drop ? edgeCode(list[i]) : null;
        if (code && seenCodes.has(code)) { x.drop = true; x.reason = 'alreadySeen'; }
      });
    }
    // B23: the card's Following page starts where Home's continuation got to.
    let carried = -1;
    if (seenCodes && first && skip.carry) {
      const r = safe(takeCarry)(owner, list, verdicts, seenCodes);
      if (r) { carried = r.n; fs.lastCursor = r.cursor; }
    }
    let anchor = null;
    if (first && !verdicts.some(x => x.media && !x.drop) && (sentMore || cut)) {
      anchor = anchorFirstPage(fs, owner, list, verdicts, cut, home);
      if (anchor) { fs.anchorKind = anchor.kind; countAnchor(anchor.kind); }
    }
    // Home's own page, even when it lands while a Story or post is open.
    const onHome = home;
    const kept = [];
    const tally = {};
    let keptMedia = 0, alreadySeen = 0, lastKept = null;
    verdicts.forEach((x, i) => {
      stats.feed.seen++;
      const code = x.media ? edgeCode(list[i]) : null;
      if (x.drop) {
        stats.feed[x.reason] = (stats.feed[x.reason] || 0) + 1;
        bump(tally, x.reason);
        if (x.reason === 'alreadySeen') alreadySeen++;
      } else {
        kept.push(list[i]);
        if (x.media) {
          keptMedia++;
          if (code) lastKept = code;
          if (home && x.follow === null) stats.feed.followUnknown = (stats.feed.followUnknown || 0) + 1;
          if (onHome && code) { noteHomeShown(code, true); }
        }
      }
      if (ctx) noteUnit(list[i], x.drop ? x.reason : x.reason === 'anchor' ? 'anchor' : 'kept', ctx);
    });
    if (anchor && anchor.kind === 'marker') kept.push(anchor.edge);
    else if (!anchor && cut && !kept.length && (!fs.cont || fs.shownCount === 0 || jump || tap)) {
      // Home cut to nothing at its marker: this may be a head load that
      // replaces the list, so the neutralised marker stays, never [].
      // While Home goes on into Following (R7), an ordinary page appended at
      // the marker stays cut (Following's own line marks the place) unless
      // nothing shows yet or it may be a reload's head (a jump to the top, a
      // tap). Never by time alone: Instagram's line would stay mid-feed.
      anchor = keepMarker(fs, owner, cut);
      kept.push(cut);
      bump(stats.feed, 'markerKept');
    }
    if (lastKept) fs.lastKeptCode = lastKept;
    if (onHome && keptMedia > 0) fs.homePages++;
    stats.feed.kept += keptMedia;
    stats.feed.lastPageKept = keptMedia;
    if (keptMedia > 0 || anchor) fs.shownAny = true;
    fs.shownCount += keptMedia;
    // Diagnostics: ms from the page load to the first new post past the skip.
    if (seenCodes && !stats.feed.skipFirstNewMs && keptMedia > (anchor ? 1 : 0)) stats.feed.skipFirstNewMs = Math.round(performance.now());
    fs.handed += kept.length;
    if (kept.length !== list.length || kept.some((e, i) => e !== list[i])) list.splice(0, list.length, ...kept);
    if (first && !list.length) emptyFirstAt = Date.now();
    const more = hasMore(owner);
    if (home && fs.cont) {
      // Home's last page before Following: Instagram is asked again once posts are ready.
      if (keptMedia <= 2 && cs) { if (!cs.waiting) cs.waitSeen = contSeenPassed; cs.waiting = true; }
    } else if (keptMedia === 0 && more) {
      if (alreadySeen > 0 && seenCodes) {
        // Paging past posts you already saw in Home. Each comes once, so stop
        // when Instagram repeats its cursor, or after more pages than there
        // are seen posts (a loop), at most 80.
        const echo = cursor != null && cursor === prevCursor;
        if (echo) bump(stats.feed, 'cursorEcho');
        if (echo || ++fs.seenStreak >= Math.min(80, seenCodes.size + 3)) { stopPagination(owner); endFeed(fs); }
      } else if (++fs.emptyStreak >= 4) {
        stopPagination(owner); stats.feed.stopped++; endFeed(fs);
      }
      if (!fs.ended) scheduleNudge(true);
    } else if (keptMedia > 0) {
      fs.emptyStreak = 0;
      fs.seenStreak = 0;
      // Only a post or two came through: ask for the next batch early.
      if (keptMedia <= 2 && more) scheduleNudge(!!seenCodes);
    }
    if (!more && pagingOwner(owner)) endFeed(fs);
    safe(syncRoom)(fs, more);
    if (seenCodes) safe(skipProgress)(fs);
    if (carried >= 0) tr.cy = carried;
    if (seenCodes && first && stats.feed.carry) tr.cr = stats.feed.carry;   // B23's outcome, kept across restarts
    safe(pushTrail)(Object.assign(tr, { out: list.length, k: keptMedia, sk: alreadySeen, ad: tally.ad || 0,
      sg: (tally.suggested || 0) + (tally.notFollowed || 0) + (tally.exploreTitle || 0), nx1: more,
      an: anchor ? anchor.kind : '', first: first, ae: false }));
    setTimeout(safe(checkFeedEnd), 300);
  }
  // Instagram's first page of the card's Following page, with what Home's
  // continuation carried (R7's handover rules: never an empty first page, no
  // duplicates, has_next only with a string cursor): this page's own new
  // posts, then the carried posts, and Following's cursor past them, so
  // Instagram's next request starts right past the posts seen in Home. Only
  // when this page holds a post R7 itself read along the chain that ends at
  // the carried cursor (c.read): Following is newest first, so anything newer
  // than R7's reading is then on this page. A post Home showed is no proof
  // (Home can show posts newer than R7's reading: Instagram's own pages, a
  // refreshed Home); otherwise a gap could follow: B17's skipping instead.
  // Returns null to leave the page to B17's skipping.
  function takeCarry(owner, list, verdicts, seen) {
    const c = skip.carry;
    skip.carry = null;
    const pi = owner.page_info;
    if (!pi || typeof pi !== 'object' || list.length !== verdicts.length) { stats.feed.carry = 'shape'; return null; }
    const proof = new Set(Array.isArray(c.read) ? c.read : []);
    const codes = list.map((e, i) => verdicts[i].media ? edgeCode(e) : null);
    if (!codes.some(k => k && proof.has(k))) { stats.feed.carry = 'new'; return null; }
    const have = new Set(codes.filter((k, i) => k && !verdicts[i].drop));
    let n = 0;
    for (const e of c.edges) {
      const k = edgeCode(e);
      if (!k || have.has(k) || seen.has(k)) continue;
      const v = feedVerdict(unitOf(e));
      if (v.drop || !v.media) continue;
      have.add(k);
      list.push(e);
      verdicts.push(v);
      n++;
    }
    pi.end_cursor = c.cursor;
    pi.has_next_page = !!c.more;
    stats.feed.carry = n ? 'used' : 'cursor';
    stats.feed.carried = n;
    return { cursor: c.cursor, n: n };
  }
  function edgeCode(e) {
    const n = e && e.node ? e.node : e;
    const m = mediaOf(n) || n;
    return m && (m.code || m.shortcode) || null;
  }
  // A Reels chain: keep only the Reel you actually opened (the URL's Reel, or
  // the first one, which is the one requested), never the endless rest.
  function trimChaining(v) {
    const want = route() === 'reel' ? codeFromPath() : null;
    const trimList = list => {
      const before = list.length;
      let kept = want ? list.filter(e => edgeCode(e) === want) : [];
      if (!kept.length && list.length) kept = [list[0]];
      list.splice(0, list.length, ...kept.slice(0, 1));
      stats.chainingTrimmed += before - list.length;
    };
    if (Array.isArray(v)) { trimList(v); return; }
    if (!v || typeof v !== 'object') return;
    for (const k of ['edges', 'items', 'medias', 'clips']) {
      if (Array.isArray(v[k])) trimList(v[k]);
    }
    stopPagination(v);
  }
  function blankLists(v, statKey) {
    if (Array.isArray(v)) { if (v.length) { stats[statKey] += v.length; v.length = 0; } return; }
    if (!v || typeof v !== 'object') return;
    for (const k in v) {
      if (Array.isArray(v[k]) && v[k].length && typeof v[k][0] === 'object') {
        stats[statKey] += v[k].length;
        v[k].length = 0;
      }
    }
    stopPagination(v);
  }
  // Only Instagram's own search pages (the "Open Instagram's own page"
  // fallback), which load more by themselves as you scroll. SimpleGram's own
  // grids have no cap: each of their pages needs a tap.
  const searchPages = new Map();
  let searchCounted = false;
  function limitSearch(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return;
    if (!hasMore(v) || searchCounted) return;
    searchCounted = true;
    const key = location.pathname + location.search;
    const n = (searchPages.get(key) || 0) + 1;
    searchPages.set(key, n);
    cap(searchPages, 50);
    if (n >= Math.max(1, CFG.searchPages | 0)) { stopPagination(v); stats.searchStopped++; }
  }
  function dropAds(list) {
    if (streamed) return;
    for (let i = list.length - 1; i >= 0; i--) {
      const el = list[i];
      if (el && typeof el === 'object' && (adLike(el) || (el.node && adLike(el.node)))) {
        list.splice(i, 1);
        stats.ads++;
      }
    }
  }

  function visit(o) {
    for (const k in o) {
      const v = o[k];
      if (!v || typeof v !== 'object') continue;
      if (TIMELINE_KEY.test(k) && Array.isArray(v.edges)) filterFeedList(v, v.edges);
      else if (k === 'feed_items' && Array.isArray(v)) filterFeedList(o, v);
      else if (CHAINING_KEY.test(k)) trimChaining(v);
      else if (EXPLORE_KEY.test(k)) blankLists(v, 'exploreBlanked');
      else if (k === 'sectional_items' && Array.isArray(v) && route() !== 'search' && !ownFetch) { blankLists(v, 'exploreBlanked'); stopPagination(o); }
      else if (SUGGEST_KEY.test(k)) { if (/ayml/i.test(k)) safe(noteAyml)(); blankLists(v, 'suggestionsBlanked'); }
      else if (AD_CONTAINER_KEY.test(k)) blankLists(v, 'ads');
      else if (SEARCH_KEY.test(k) && route() === 'search' && !ownFetch) limitSearch(v);
      if (Array.isArray(v) && v.length && AD_LIST_KEY.test(k)) dropAds(v);
    }
    if (looksLikeMedia(o)) indexMedia(o);
    else if (typeof o.username === 'string' && o.username && !o.image_versions2) {
      const id = o.pk != null ? o.pk : (o.pk_id != null ? o.pk_id : o.id);
      if (id != null && /^\d+$/.test(String(id))) { userIds.set(o.username.toLowerCase(), String(id)); cap(userIds, 5000); }
    }
  }
  function cleanse(root, via) {
    if (!root || typeof root !== 'object') return;
    stats.payloads++;
    searchCounted = false;
    streamed = root.hasNext === true || !!(root.extensions && root.extensions.is_final === false);
    payloadVia = via || (ownFetch ? 'own' : 'other');
    payloadFinal = root.extensions && typeof root.extensions.is_final === 'boolean' ? root.extensions.is_final : null;
    if (Array.isArray(root.sectional_items) && route() !== 'search' && !ownFetch) {
      blankLists(root.sectional_items, 'exploreBlanked');
      stopPagination(root);
    }
    const stack = [root];
    let budget = 400000;
    while (stack.length && budget-- > 0) {
      const o = stack.pop();
      if (Array.isArray(o)) {
        for (let i = 0; i < o.length; i++) { const x = o[i]; if (x && typeof x === 'object') stack.push(x); }
        continue;
      }
      visit(o);
      for (const k in o) { const x = o[k]; if (x && typeof x === 'object') stack.push(x); }
    }
    streamed = false;
  }
  SG.cleanse = cleanse;

  const INTEREST = /"(?:edges|items|feed_items|reels|reels_media|image_versions2|video_versions|ad_id|injected|suggested_users|sectional_items|media_grid|users)"|chaining|ayml|explore_grid|injected_/;
  const nativeParse = JSON.parse;
  // The browser's own fetch, before Instagram's code can wrap it: R7's own
  // reads never go through Instagram's network layer.
  const nativeFetch = window.fetch;
  // Diagnostics: Instagram's "please wait" throttling answers, which often
  // come with an ordinary status. Counted once stats.diag exists; never throws.
  function noteThrottle(o) {
    try {
      if (!o || typeof o !== 'object' || !stats.diag) return;
      const m = typeof o.message === 'string' ? o.message : '';
      const errs = Array.isArray(o.errors) ? o.errors : null;
      if ((o.status === 'fail' && (/please wait|try again|rate limit/i.test(m) || o.spam === true || m === 'feedback_required')) ||
          (errs && errs.some(e => e && (/rate limit|please wait/i.test(String(e.message || '')) || e.code === 1675004 && /rate/i.test(String(e.summary || '')))))) {
        stats.diag.pleaseWait++;
      }
    } catch (e) { /* never throw into Instagram */ }
  }
  const wrappedParse = function parse(text, reviver) {
    const out = nativeParse.apply(this, arguments);
    if (out && typeof out === 'object' && (out.status === 'fail' || out.errors)) noteThrottle(out);
    if (typeof text === 'string' && text.length > 150 && out && typeof out === 'object' && INTEREST.test(text)) {
      try { cleanse(out, 'parse'); } catch (e) { stats.errors++; }
    }
    return out;
  };
  JSON.parse = wrappedParse;

  if (window.Response && Response.prototype.json) {
    const nativeJson = Response.prototype.json;
    Response.prototype.json = function json() {
      return nativeJson.apply(this, arguments).then(out => {
        if (out && typeof out === 'object') { noteThrottle(out); try { cleanse(out, 'fetch'); } catch (e) { stats.errors++; } }
        return out;
      });
    };
  }
  if (window.XMLHttpRequest) {
    const desc = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'response');
    if (desc && desc.get && desc.configurable) {
      const done = new WeakSet();
      Object.defineProperty(XMLHttpRequest.prototype, 'response', {
        configurable: true,
        enumerable: desc.enumerable,
        get: function () {
          const out = desc.get.call(this);
          if (this.responseType === 'json' && out && typeof out === 'object' && !done.has(out)) {
            done.add(out);
            noteThrottle(out);
            try { cleanse(out, 'xhr'); } catch (e) { stats.errors++; }
          }
          return out;
        },
      });
    }
  }

  // Instagram loads the next batch when the end of the list comes into
  // view. When a batch adds little or nothing, the end never "arrives", so
  // give Instagram a scroll signal. `hard` also handles a page too short to scroll.
  let nudgeTimer = 0, touching = false, lastUserScroll = 0, lastTouchEnd = 0;
  // Your own input (a finger or a wheel), and SimpleGram's own scrolls (the
  // jiggle, the pad, the room going), which fire trusted scroll events too.
  let lastInputAt = 0, ownScrollAt = 0;
  window.addEventListener('touchstart', () => { touching = true; lastInputAt = Date.now(); }, { capture: true, passive: true });
  window.addEventListener('touchend', () => { touching = false; lastUserScroll = lastTouchEnd = lastInputAt = Date.now(); }, { capture: true, passive: true });
  window.addEventListener('wheel', () => { lastInputAt = Date.now(); }, { capture: true, passive: true });
  window.addEventListener('touchcancel', () => { touching = false; }, { capture: true, passive: true });
  const nudgedAt = [];
  // Diagnostics: which ways of asking for the next page work on the device
  // (scroll events only, a 2 px jiggle, the pad, your own swipe into the
  // scroll room): each try, and whether a feed page came within 3 s.
  let lastTry = null;
  function noteTry(kind) {
    const k = stats.feed.tries || (stats.feed.tries = {});
    const t = k[kind] || (k[kind] = { n: 0, hit: 0 });
    t.n++;
    lastTry = { t: t, at: Date.now() };
  }
  function triedHit() {
    if (lastTry && Date.now() - lastTry.at < 3000) lastTry.t.hit++;
    lastTry = null;
  }
  // Nudges that keep trying (about 1, 2, 4 and 8 s apart, 8 at most) until a
  // page comes: on the page opened from the end card, on a feed's first
  // page while only its hidden anchor is there, and on Home while Following's
  // posts are ready and Instagram has not asked for them yet (B22: one nudge
  // could be lost under your finger). Elsewhere one nudge, as before.
  function keepsTrying(fs) {
    return !fs.ended && (!!skipping() || (fs.anchorKind === 'recs' && fs.shownCount === 0) ||
      (fs.cont && contAlive() && cs.waiting && cs.buffer.length > 0));
  }
  // Instagram slowing requests down stops the skip's nudges for good.
  function skipThrottled() {
    const d = stats.diag;
    if (!skip || !d) return false;
    if (!skip.halted && d.s429 + d.pleaseWait > 0) { skip.halted = true; bump(stats.feed, 'skipThrottled'); }
    return skip.halted;
  }
  function scheduleNudge(hard, tries) {
    tries = tries || 0;
    clearTimeout(nudgeTimer);
    const at = currentFeed().lastPageAt;
    // Paging past seen posts: quicker, on its own budget (40 a minute), so
    // Home's 10 a minute is left for Home.
    const pacing = !!skipping() && currentFeed().seenStreak > 0;
    // B23: 250 ms between pages of seen posts (it was 400), still stopped by
    // Instagram's slow-downs (skipThrottled) and the 40-a-minute budget.
    const delay = pacing ? 250 : 600;
    nudgeTimer = setTimeout(safe(() => {
      const se = document.scrollingElement;
      const fs = currentFeed();
      // Never after the end of a feed or while the app is in the background.
      if (!se || route() !== 'home' || document.hidden || fs.ended) return;
      if (tries && fs.lastPageAt !== at) return;   // a retry is only for the page it was made for
      if (skipping() && skipThrottled()) return;
      const trying = keepsTrying(fs);
      const later = ms => {
        nudgeTimer = setTimeout(safe(() => {
          const f = currentFeed();
          if (f.lastPageAt === at && keepsTrying(f)) scheduleNudge(true, tries + 1);
        }), Math.max(0, ms - delay));
      };
      if (se.scrollHeight - (se.scrollTop + innerHeight) > innerHeight * 2) {
        if (trying && tries < 8) later(Math.min(8000, 1000 * Math.pow(2, tries)));
        return;
      }
      const now = Date.now();
      // The skip may have been forgotten since: Home's budget then.
      if (pacing && skip && skipping()) {
        skip.nudgedAt = skip.nudgedAt.filter(t => now - t < 60000);
        if (skip.nudgedAt.length >= 40) {
          bump(stats.feed, 'skipCapped');
          later(60000 - (now - skip.nudgedAt[0]) + 50);   // again when the minute frees up
          return;
        }
        skip.nudgedAt.push(now);
        bump(stats.feed, 'skipNudges');
      } else {
        // At most 10 a minute, however many pages come back empty.
        while (nudgedAt.length && now - nudgedAt[0] > 60000) nudgedAt.shift();
        if (nudgedAt.length >= 10) {
          stats.feed.nudgesCapped = (stats.feed.nudgesCapped || 0) + 1;
          if (trying) later(60000 - (now - nudgedAt[0]) + 50);
          return;
        }
        nudgedAt.push(now);
      }
      stats.feed.nudges = (stats.feed.nudges || 0) + 1;
      if (trying && tries < 8) later(Math.min(8000, 1000 * Math.pow(2, tries)));
      window.dispatchEvent(new Event('scroll'));
      document.dispatchEvent(new Event('scroll'));
      // Never move the page under your finger or during a fling.
      if (touching || Date.now() - lastUserScroll < 400) { noteTry('synthetic'); return; }
      const y = se.scrollTop;
      noteTry(se.scrollHeight - innerHeight > 4 ? 'jiggle' : (hard || trying) && document.body ? 'pad' : 'synthetic');
      if (se.scrollHeight - innerHeight > 4) {
        const d = y >= 2 ? -2 : 2;
        ownScrollAt = Date.now();
        se.scrollTop += d;
        requestAnimationFrame(() => { ownScrollAt = Date.now(); se.scrollTop -= d; });
      } else if ((hard || trying) && document.body) {
        // Nothing to scroll: briefly add room below so the list's end leaves and re-enters view.
        const pad = document.createElement('div');
        pad.setAttribute('aria-hidden', 'true');
        pad.style.cssText = 'height:' + (innerHeight * 3) + 'px;pointer-events:none';
        document.body.appendChild(pad);
        ownScrollAt = Date.now();
        se.scrollTop = innerHeight * 2;
        let done = false;
        const restore = () => { if (done) return; done = true; ownScrollAt = Date.now(); se.scrollTop = y; pad.remove(); };
        requestAnimationFrame(() => requestAnimationFrame(restore));
        // Frames can stop (the app going to the background): never leave the room behind.
        setTimeout(restore, 150);
      }
    }), delay);
  }

  // The scroll room: while the page opened from the end card shows fewer
  // than 3 posts (or a feed's first page only its hidden anchor), room below
  // the list lets your own swipe reach Instagram's loader as a real scroll,
  // whether or not synthetic nudges work on the device.
  const ROOM_ID = 'sg-skip-room';
  let roomTimer = 0;
  function roomWanted(fs, more) {
    if (CFG.role !== 'main' || fs.ended || !more || fs !== currentFeed()) return false;
    if (skipping()) return fs.shownCount < 3;
    return fs.anchorKind === 'recs' && fs.shownCount === 0;
  }
  function syncRoom(fs, more) {
    if (fs !== currentFeed()) return;
    const room = document.getElementById(ROOM_ID);
    if (!roomWanted(fs, more)) { if (room) releaseRoom(); return; }
    clearTimeout(roomTimer);
    roomTimer = 0;
    if (room || !document.body) return;
    const el = document.createElement('div');
    el.id = ROOM_ID;
    el.setAttribute('aria-hidden', 'true');
    // Enough to scroll by a good half screen, however short the page is yet.
    const h = innerHeight * 0.6 + Math.max(0, innerHeight - document.body.getBoundingClientRect().height);
    el.style.cssText = 'height:' + Math.round(h) + 'px;pointer-events:none';
    document.body.appendChild(el);
    bump(stats.feed, 'skipRoom');
  }
  // Removed only once that cannot move the page (Instagram draws new posts a
  // moment after their data), checked every 100 ms, 3 s at most.
  function releaseRoom() {
    if (!document.getElementById(ROOM_ID) || roomTimer) return;
    const t0 = Date.now();
    const tick = () => {
      roomTimer = 0;
      const r = document.getElementById(ROOM_ID);
      if (!r) return;
      const se = document.scrollingElement || document.documentElement;
      if (se.scrollHeight - r.offsetHeight >= se.scrollTop + innerHeight - 1 || Date.now() - t0 > 3000) { ownScrollAt = Date.now(); r.remove(); return; }
      roomTimer = setTimeout(safe(tick), 100);
    };
    roomTimer = setTimeout(safe(tick), 0);
  }
  function dropRoom() {
    clearTimeout(roomTimer);
    roomTimer = 0;
    const r = document.getElementById(ROOM_ID);
    if (r) { ownScrollAt = Date.now(); r.remove(); }
  }

  // The app's note on the page opened from the end card (never the end-of-Home
  // card): "Skipping N posts you saw in Home…" once the anchor has stood alone
  // for 3 s, "Nothing new since Home" when the feed ends with only the anchor.
  function onlyAnchor(fs) { return fs.anchorKind === 'seen' && fs.shownCount <= 1; }
  function skipStatus(kind) {
    if (!skip || skip.status === kind) return;
    skip.status = kind;
    post('skipStatus', { on: !!kind, kind: kind, n: kind === 'skipping' ? skip.codes.size : 0 });
  }
  function skipProgress(fs) {
    if (!skip || !skipping() || fs !== currentFeed()) return;
    if (fs.ended) { skipStatus(onlyAnchor(fs) ? 'nothingNew' : ''); return; }
    if (!onlyAnchor(fs)) { skipStatus(''); return; }
    if (skip.status || skip.statusTimer) return;
    skip.statusTimer = setTimeout(safe(() => {
      if (!skip) return;
      skip.statusTimer = 0;
      const f = currentFeed();
      if (skipping() && !f.ended && onlyAnchor(f)) skipStatus('skipping');
    }), 3000);
  }

  /* ------------------------------------------------------------------ *
   * R7: Home goes on into Following, in Instagram's own list.
   *
   * After "You're all caught up" Instagram keeps paging Home with its own
   * next-page request, as the website does. SimpleGram reads Following
   * itself (the website's own Following requests, newest first) and puts
   * those posts in place of the suggestions in each of Instagram's next
   * Home pages, in the data and before Instagram sees the page. Relay
   * appends them to Home's list, so Instagram draws them like any Home
   * post. Posts Home showed are skipped. Anything unexpected ends Home with
   * the app's card (Following), as without the continuation.
   * States (cont.state, sent as feedEnd.cont): off, running, done (Following
   * used up), stopped (Instagram stopped paging first), limit (the required
   * stop; cont.reason posts or requests, sent as contWhy), failed (no more
   * starts this page load). A reload resets done and stopped to off.
   * ------------------------------------------------------------------ */
  const CONT_ROOT = 'PolarisFeedTimelineRootV2Query';
  const CONT_NEXT = 'PolarisFeedRootPaginationCachedQuery_subscribe';
  const CONT_CONN = 'xdt_api__v1__feed__timeline__connection';
  // Posts kept ready before Instagram asks: two of its pages (B22: a fast
  // scroll took a whole page and then waited on the next read).
  function contReady() { return Math.min(48, 2 * contPageSize()); }
  const CONT_GAP = 500;         // ms between own requests (none while Instagram waits)
  const CONT_PER_MIN = 20;      // own requests a minute, whatever they brought, across restarts
  const CONT_STARTS = 4;        // more starts than this in a minute: something is off, the card instead
  const CONT_MAX_HANDED = 200;  // Following posts handed in one page load, then Home stops
  const CONT_MAX_OWN = 25;      // own requests in one page load, then Home stops
  const CONT_NOTE_MS = 3000;    // the app's "Skipping posts you saw in Home…" after this long
  const CONT_READ_MS = 20000;   // an own read that has not answered by then has failed (Instagram's own: 60 s)
  const CONT_IG_WAIT = 40000;   // posts ready but no page from Instagram for this long: it has stopped asking
  const CONT_LOAD_NOTE_MS = 2000; // waiting at the bottom this long: "Loading more from people you follow…"
  // Shapes and counts only (Filter status, Copy details). headWhy: why a page
  // was taken for Home's first page again (resets: one per reload, its two
  // heads merged); recsAnchors: hidden suggestions kept so a reload's list is
  // never empty; igKept: Instagram's own followed
  // posts kept in a handover; keptBuffer: posts read but not shown, kept at
  // the last reset; startsMin: starts in the last minute; peakMin: most own
  // requests in a minute; repeats: handovers holding a post Home already
  // showed (must stay 0); runs: per start, ms from the marker to the first
  // posts handed, whether the first one was drawn within 3 s and showed its
  // line; hand: per handover, posts and the page height in screens before
  // and 1.5 s after (growth: appended; shrink: replaced). waits (B22): times
  // you waited at the bottom while Home went on (1 s or more), how long and
  // why in ms (empty: nothing ready or on its way, read: nothing ready, an own
  // read on its way, pacing: nothing ready, its turn not come, ig: posts
  // ready, Instagram's next page pending), the "Loading more…" notes, the
  // stalled cards while it ran (with the wait so far), and the last few
  // waits (end: posts, up, ended).
  const cont = (stats.cont = { on: CFG.continueHome === true, state: 'off', reason: '', own: 0, ownFail: 0, pages: 0,
    swaps: 0, handed: 0, empty: 0, skippedSeen: 0, heads: 0, anchors: 0, recsAnchors: 0, nudges: 0,
    headWhy: { marker: 0, seen: 0, jump: 0, tap: 0, ended: 0 }, igKept: 0, resets: 0, keptBuffer: 0,
    startsMin: 0, peakMin: 0, repeats: 0, notes: 0, modules: null, runs: [], hand: [],
    waits: { n: 0, ms: 0, longest: 0, why: { empty: 0, read: 0, pacing: 0, ig: 0 }, notes: 0, cards: 0, atCard: null, last: [] } });
  let cs = null;                 // the current run (from one marker on)
  let contGen = 0;               // one counter for the page load: a reset makes every answer on its way stale
  let contInFlight = false;      // one own request at a time, across restarts
  let contAnsweredAt = 0, contFetchAt = 0;
  let contResumeAt = null;       // what a reset kept: where Following had got to, and posts read but not shown
  let contSeenPassed = 0;        // seen posts passed in this page load
  let contRead = [];             // B23: codes read along the current chain of Following, nearest its head (CARRY_READ)
  const contOwnAt = [], contStarts = [], labelCodes = [];
  // Instagram's refresh paths call window.scrollTo(0, 0) right before they
  // reload Home's first page (twice from the Home tab on mobile: b314
  // usePolarisOnHomeClick, b344 PolarisFeed.react and PolarisFeedWrapper).
  let topJumpAt = 0, jumpPages = 0, tapAt = 0, tapPages = 0, scrollWrapped = false;
  function contWatchJumps() {
    if (scrollWrapped || !cont.on || CFG.role !== 'main') return;
    scrollWrapped = true;
    try {
      const nativeScrollTo = window.scrollTo;
      window.scrollTo = function scrollTo(a, b) {
        try {
          const y = a && typeof a === 'object' ? a.top : b;
          if (y === 0) { topJumpAt = Date.now(); jumpPages = 0; }
        } catch (e) { /* never throw into Instagram */ }
        return nativeScrollTo.apply(this, arguments);
      };
    } catch (e) { /* leave scrollTo alone */ }
  }
  contWatchJumps();
  // The ⋮ menu's switch, in this document too (the app also registers it for
  // the next load). Off: a run ends here with the Following card, and no new
  // one starts. On: Home goes on from the next time it reaches its marker.
  function contSet(on) {
    if (CFG.role !== 'main' || on === cont.on) return;
    CFG.continueHome = on;
    cont.on = on;
    if (on) {
      if (cont.state === 'failed' && cont.reason === 'switchedOff') { contUnhalt(); cont.state = 'off'; cont.reason = ''; }
      contWatchJumps();
    } else {
      contFail('switchedOff');
    }
  }
  // Called once for every Home page: the first two within 6 s of a jump to
  // the top, with you less than 2 screens down, are Instagram's reloads (in
  // whichever order they come). Scroll is only read on Home itself.
  function contJump() {
    if (!topJumpAt || Date.now() - topJumpAt > 6000 || jumpPages >= 2 || route() !== 'home') return false;
    const se = document.scrollingElement || document.documentElement;
    if (se.scrollTop > innerHeight * 2) return false;
    jumpPages++;
    return true;
  }
  // The first two Home pages within 20 s of a Home-tab tap passed to Instagram.
  function contTap() {
    if (!tapAt || Date.now() - tapAt > 20000 || tapPages >= 2) return false;
    tapPages++;
    return true;
  }
  function contTapped() { if (cont.on) { tapAt = Date.now(); tapPages = 0; } }
  function contWanted(fs) {
    return cont.on && CFG.role === 'main' && fs.key === 'home' && !streamed;
  }
  // The page's own compiled queries: both Following requests are then built
  // from exactly what Instagram's own code would send (ids, settings).
  function contQueryReady(name) {
    const p = gqlParams(name);
    return !!p && /^\d+$/.test(String(p.id)) && !!p.providedVariables && typeof p.providedVariables === 'object';
  }
  function moduleFn(name) {
    const m = igModule(name);
    return typeof m === 'function' ? m : m && typeof m.default === 'function' ? m.default : null;
  }
  function feedConstants() {
    const m = igModule('PolarisFeedQueryConstants');
    const b = m && (m.FEED_TIMELINE_REQUEST_BODY || (m.default && m.default.FEED_TIMELINE_REQUEST_BODY));
    return b && typeof b === 'object' ? b : null;
  }
  function contPageSize() {
    const m = igModule('PolarisFeedActionConstants');
    const n = m && (m.PAGE_SIZE || (m.default && m.default.PAGE_SIZE));
    return typeof n === 'number' && n > 0 && n <= 50 ? n : 12;
  }
  function contModules() {
    const m = igModule('PolarisFeedActionConstants');
    return { root: contQueryReady(CONT_ROOT), next: contQueryReady(CONT_NEXT), constants: !!feedConstants(),
      actions: !!(m && (m.PAGE_SIZE || (m.default && m.default.PAGE_SIZE))), asyncParams: !!moduleFn('getAsyncParams'),
      asyncHeaders: !!moduleFn('getAsyncHeaders') };
  }
  // At the marker, synchronously: Home goes on only when its own paging does
  // and the page's own query modules are there; otherwise the card, as before.
  function contArm(fs, owner) {
    if (!contWanted(fs) || fs.cont) return false;
    if (cont.state === 'failed' || cont.state === 'limit') return false;   // this page load stays ended
    if (!hasMore(owner) || !cursorOf(owner)) return false;                 // Instagram itself stops here
    cont.modules = contModules();
    if (!cont.modules.root || !cont.modules.next) { cont.state = 'failed'; cont.reason = 'modules'; return false; }
    fs.cont = true;
    fs.caughtUp = true;
    contStart(!!fs.contMerged);
    if (cont.state === 'running') return true;
    fs.cont = false;
    return false;
  }
  function contAlive() { return !!cs && cont.state === 'running'; }
  // An own read on its way (never longer than it may take), one waiting for
  // its turn (pacing, a jump to the top) or just answered: Home is not stalled.
  function contReading() {
    if (!contAlive()) return false;
    const now = Date.now();
    return (contInFlight && now - contFetchAt < CONT_READ_MS) || !!(cs.timer && cs.more) || now - contAnsweredAt < STALL_MS;
  }
  // B22: the continuation is still working for Home, so Home is not stalled:
  // a read on its way or waiting for its turn, the buffer being filled (the
  // next read is started here if it is due), or posts ready while Instagram's
  // own next page is pending (it was nudged), for up to CONT_IG_WAIT since
  // Instagram's last Home page or since reaching the bottom, whichever is
  // later (a slow reader gets the whole wait too). Past that, Instagram has
  // stopped asking: the card. A read that never settles counts only as long
  // as contReading allows it, so a stuck read still ends in the card.
  function contWorking(fs) {
    if (!contAlive()) return false;
    if (contReading()) return true;
    if (contWantsRead()) { contFill(); if (contReading() || cs.timer) return true; }
    return cs.buffer.length > 0 && Date.now() - Math.max(fs.lastPageAt, atBottomSince || 0) < CONT_IG_WAIT;
  }
  // Why Home waits at the bottom (diagnostics): posts ready while Instagram's
  // next page is pending (whatever refill is on its way: the handover never
  // waits for it), or nothing ready and an own read on its way, its turn not
  // come yet (pacing), or nothing on its way.
  function contWhy() {
    if (!contAlive()) return '';
    if (cs.buffer.length) return 'ig';
    if (contInFlight) return 'read';
    if (cs.timer) return 'pacing';
    return 'empty';
  }
  // merged: the second head of the same reload (counted once).
  function contStart(merged) {
    const now = Date.now();
    while (contStarts.length && now - contStarts[0] > 60000) contStarts.shift();
    if (!merged || !contStarts.length) contStarts.push(now);
    cont.startsMin = contStarts.length;
    const carry = contResumeAt && now - contResumeAt.at < 30 * 60000 ? contResumeAt : null;
    contResumeAt = null;
    cs = { gen: ++contGen, cursor: null, more: true, buffer: [], fetching: false, timer: 0, shown: new Set(),
      firstCode: null, waiting: false, resume: carry, startedAt: now, firstMs: -1, capped: false, noteTimer: 0, note: false,
      waitSeen: contSeenPassed };
    cont.state = 'running';
    cont.reason = '';
    if (contStarts.length > CONT_STARTS) { contFail('restarts'); return; }
    contFill();
  }
  // Home starts over (a reload replaces Instagram's list). Kept for the next
  // run: the cursor of the page in flight (or the next one), and the posts
  // read but not shown, so Following has no gaps and nothing repeats.
  function contReset(merged) {
    contGen++;
    contNote(false);
    contWaitEnd('ended');
    if (cs) {
      clearTimeout(cs.timer);
      if (cont.state === 'failed' && cont.reason === 'switchedOff') contUnhalt();   // kept for when it is on again
      const prev = cs.resume;
      const own = cs.cursor != null || !prev;
      const buffer = cs.buffer.concat(prev ? prev.buffer : []);
      contResumeAt = { cursor: own ? cs.cursor : prev.cursor, more: own ? cs.more : prev.more,
        fmore: own ? cs.fmore : prev.fmore, buffer: buffer, at: Date.now() };
      cont.keptBuffer = buffer.length;
      if (!merged) cont.resets++;
    }
    cs = null;
    if (cont.state === 'running' || cont.state === 'done' || cont.state === 'stopped') cont.state = 'off';
  }
  // Following can't go on: Home ends here (once the posts already read are
  // shown), and the card offers Following as before. No retries.
  function contFail(reason) {
    if (cont.state !== 'running') return;
    cont.state = 'failed';
    cont.reason = reason;
    contNote(false);
    // What a reset kept is given up too, so the next handover stops Instagram's paging.
    // The switch can be turned on again in this page: where Following got to is kept for that.
    if (cs && reason === 'switchedOff') cs.halt = { more: cs.more, resume: cs.resume };
    if (cs) { cs.more = false; clearTimeout(cs.timer); cs.timer = 0; cs.resume = null; }
    const fs = feedStates.get('home');
    if (fs && fs.cont && !fs.ended && !(cs && cs.buffer.length)) endFeed(fs, true);
    setTimeout(safe(checkFeedEnd), 0);
  }
  // The switch on again (or Home starting over while it is off): the run's
  // real place in Following comes back, so a later run goes on from there.
  // Nothing is read meanwhile (only a running state reads).
  function contUnhalt() {
    if (!cs || !cs.halt) return;
    cs.more = cs.halt.more;
    cs.resume = cs.halt.resume;
    cs.halt = null;
  }
  // Nothing more to show (done) or the required stop (limit): Home ends now,
  // even if Instagram isn't asking for a page.
  function contEnd(state, reason) {
    if (cont.state !== 'running') return;
    cont.state = state;
    cont.reason = reason;
    contNote(false);
    if (cs) { cs.more = false; clearTimeout(cs.timer); cs.timer = 0; cs.resume = null; }
    const fs = feedStates.get('home');
    if (fs && fs.cont && !fs.ended) endFeed(fs, true);
    setTimeout(safe(checkFeedEnd), 0);
  }
  function feedBody(where) {
    let body = feedConstants();
    if (!body) {
      body = {};
      const c = igModule('PolarisConfig');
      try { const d = c && typeof c.getDeviceId === 'function' ? c.getDeviceId() : null; if (d) body.device_id = d; } catch (e) { /* none */ }
      Object.assign(body, { is_async_ads_double_request: '0', is_async_ads_in_headload_enabled: '0', is_async_ads_rti: '0', rti_delivery_backend: '0' });
    }
    // The website's order: its first page puts the source first, next pages last.
    return where === 'first' ? Object.assign({ pagination_source: 'following' }, body)
      : Object.assign({}, body, { pagination_source: 'following' });
  }
  // The website's own Following requests: the feed's first-page query (3
  // posts, b404 PolarisFeedRoot.entrypoint), then its paging query from the
  // cursor of the page before (b344 PolarisFeed.react loadNext).
  function followingQuery(cursor) {
    return cursor == null
      ? { name: CONT_ROOT, vars: { data: feedBody('first'), first: 3, variant: 'following' } }
      : { name: CONT_NEXT, vars: { after: cursor, before: null, data: feedBody('next'), first: contPageSize(), last: null, variant: 'following' } };
  }
  // Room in the buffer and more to read (never more than Home may still show: the 200-post stop).
  function contWantsRead() {
    return !!cs && cont.state === 'running' && cs.more && cs.buffer.length < contReady() &&
      cont.handed + cs.buffer.length < CONT_MAX_HANDED;
  }
  function contFill() {
    if (!contWantsRead() || contInFlight || cs.timer) return;
    if (route() !== 'home' || document.hidden) return;   // picked up again on return
    if (cont.own >= CONT_MAX_OWN) {
      // The required stop: what was read is still shown, then Home ends.
      cs.more = false;
      cs.capped = true;
      if (!cs.buffer.length) contEnd('limit', 'requests');
      return;
    }
    const run = cs;
    const later = ms => { run.timer = setTimeout(safe(() => { run.timer = 0; if (run === cs) contFill(); }), ms); };
    const now = Date.now();
    if (now - topJumpAt < 3000) { later(3000 - (now - topJumpAt)); return; }   // Instagram may be reloading Home
    while (contOwnAt.length && now - contOwnAt[0] > 60000) contOwnAt.shift();
    const last = contOwnAt.length ? contOwnAt[contOwnAt.length - 1] : 0;
    let wait = cs.waiting ? 0 : last + CONT_GAP - now;
    if (contOwnAt.length >= CONT_PER_MIN) wait = Math.max(wait, 60000 - (now - contOwnAt[0]) + 50);
    if (wait > 0) { later(wait); return; }
    contFetch();
  }
  async function contFetch() {
    const run = cs, gen = contGen, after = run.cursor;
    contInFlight = true;
    run.fetching = true;
    const t0 = contFetchAt = Date.now();
    contOwnAt.push(t0);
    cont.peakMin = Math.max(cont.peakMin, contOwnAt.length);
    cont.own++;
    const q = followingQuery(after);
    let c = null;
    try { c = await igGraphQL(q.name, q.vars, CONT_CONN, { feed: true, timeout: CONT_READ_MS }); } catch (e) { c = null; }
    contInFlight = false;
    run.fetching = false;
    contAnsweredAt = Date.now();
    if (run !== cs || gen !== contGen) { if (cs) contFill(); return; }   // Home started over meanwhile: stale
    if (cont.state === 'failed') return;   // switched off (or failed) meanwhile: nothing more is shown
    try { contTake(c, q, after); } catch (e) { stats.errors++; contFail('error'); }
  }
  // An answer from Following: its new posts go to the buffer (what Home showed is skipped).
  function contTake(c, q, after) {
    if (!c || !Array.isArray(c.edges) || !(c.page_info || c.pageInfo)) { cont.ownFail++; contFail('request'); return; }
    cont.pages++;
    let recognised = c.edges.length === 0, fresh = 0;
    const have = new Set(cs.buffer.map(edgeCode));
    const take = e => {
      const code = edgeCode(e);
      if (!code || homeSeen.has(code) || cs.shown.has(code) || have.has(code)) return false;
      have.add(code);
      cs.buffer.push(e);
      fresh++;
      return true;
    };
    for (const e of c.edges) {
      const v = feedVerdict(unitOf(e));
      if (v.known) recognised = true;
      if (v.drop || !v.media) continue;
      if (!take(e) && edgeCode(e)) { cont.skippedSeen++; contSeenPassed++; }
    }
    if (!recognised) { contFail('format'); return; }
    contNoteRead(c.edges, q.name === CONT_ROOT);
    let next = cursorOf(c);
    if (!hasMore(c) || !next || next === after) cs.more = false;
    cs.fmore = cs.more;
    // After a reset: Following's newest page (for anything new), then the
    // posts read but not shown, then on from where Following had got to.
    if (cs.resume && q.name === CONT_ROOT) {
      for (const e of cs.resume.buffer) take(e);
      if (cs.resume.cursor) {
        next = cs.resume.cursor;
        cs.more = cs.resume.more !== false;
        cs.fmore = typeof cs.resume.fmore === 'boolean' ? cs.resume.fmore : cs.more;
      }
    }
    cs.resume = null;
    cs.cursor = next;
    // Each post comes once in Following: once well past all of Home's, stop looking.
    if (!fresh && contSeenPassed > homeSeen.size + 36) { cs.more = false; cont.reason = 'seenBound'; }
    if (!cs.more && !cs.buffer.length) { contEnd('done', cont.reason || 'followingEnd'); return; }
    // Posts are ready: the note goes now, even if Instagram is not asked yet
    // (you are well above the end). Seen posts passed while it waits: the note.
    if (cs.buffer.length) contNote(false);
    else if (cs.waiting && contSeenPassed > cs.waitSeen) contNote(true);
    if (cs.buffer.length && cs.waiting) { cont.nudges++; scheduleNudge(true); }
    contFill();
  }
  // B23: the codes of a read, for the carried start's proof of no gap. A
  // first read starts a new chain, unless a reset's cursor follows it: then
  // its posts join only when they meet the old chain (else a gap lies between).
  // Further reads go on along the chain; only the first CARRY_READ codes count.
  function contNoteRead(edges, root) {
    const codes = [];
    for (const e of edges) {
      const k = edgeCode(e);
      if (typeof k === 'string' && k.length <= 64 && !codes.includes(k)) codes.push(k);
    }
    if (!root) {
      for (const k of codes) if (contRead.length < CARRY_READ && !contRead.includes(k)) contRead.push(k);
    } else if (!cs.resume || !cs.resume.cursor) {
      contRead = codes.slice(0, CARRY_READ);
    } else if (codes.some(k => contRead.includes(k))) {
      contRead = codes.concat(contRead.filter(k => !codes.includes(k))).slice(0, CARRY_READ);
    }
  }
  // B23: for the card's Following page, where this page load's reading of
  // Following got to: its cursor past the posts read, whether Following has
  // more, and the posts read but not shown yet (in Following's order). Only
  // when a read placed a cursor; nothing is dropped (dropping a post would
  // leave a gap before the cursor): too many posts and nothing is carried
  // (only why, for the report).
  function contCarry() {
    // fmore is Following's own word; more can be a stop of the run (a failure, the request cap).
    const moreOf = r => typeof r.fmore === 'boolean' ? r.fmore : r.more !== false;
    let cursor = null, more = false, edges = [], at = contAnsweredAt;
    if (cs && cs.resume) {
      cursor = cs.resume.cursor; more = moreOf(cs.resume); edges = cs.buffer.concat(cs.resume.buffer);
    } else if (cs) {
      cursor = cs.cursor; more = moreOf(cs); edges = cs.buffer;
    } else if (contResumeAt) {
      cursor = contResumeAt.cursor; more = moreOf(contResumeAt); edges = contResumeAt.buffer;
    }
    if (typeof cursor !== 'string' || !cursor || !at) return null;
    const have = new Set(), out = [];
    for (const e of edges) {
      const code = edgeCode(e);
      if (!code || homeSeen.has(code) || have.has(code)) continue;
      have.add(code);
      out.push(e);
    }
    if (out.length > CARRY_POSTS) return { dropped: 'many', n: out.length };
    return { acct: viewerId() || '', at: at, cursor: cursor, more: more, edges: out, read: contRead.slice(0, CARRY_READ) };
  }
  // Back on Home, or the app back in front: a nudge that was due is given again.
  function contResume() {
    if (contAlive() && cs.waiting && cs.buffer.length) { cont.nudges++; scheduleNudge(true); }
    contFill();
  }
  // The app's note while Instagram waits at the end of Home and SimpleGram is
  // still passing posts you saw in Home (the skip chip's mechanism, on Home).
  function contNote(on) {
    const run = cs;
    if (!run) return;
    if (!on) {
      clearTimeout(run.noteTimer);
      run.noteTimer = 0;
      if (run.note) { run.note = false; homeChip(); }
      return;
    }
    if (run.note || run.noteTimer) return;
    run.noteTimer = setTimeout(safe(() => {
      run.noteTimer = 0;
      if (run !== cs || !contAlive() || run.buffer.length || !run.waiting || route() !== 'home') return;
      // Only when posts you saw were passed during this wait (not a slow or
      // hung read), and only with you near the end (not a page Instagram fetched ahead).
      if (contSeenPassed <= run.waitSeen) return;
      const se = document.scrollingElement || document.documentElement;
      if (se.scrollHeight - (se.scrollTop + innerHeight) > innerHeight) return;
      run.note = true;
      cont.notes++;
      homeChip();
    }), CONT_NOTE_MS);
  }
  // The app's chip on Home: "Skipping posts you saw in Home…" first, else
  // "Loading more from people you follow…" (B22), else none. Sent on change only.
  let homeChipSent = '';
  function homeChip() {
    const kind = cs && cs.note ? 'homeSkipping' : bottomWait && bottomWait.note ? 'homeLoading' : '';
    if (kind === homeChipSent) return;
    homeChipSent = kind;
    post('skipStatus', { on: !!kind, kind: kind, n: 0 });
  }
  /* B22: waiting at the bottom while Home goes on into Following. A wait
   * starts when you are near the end and the continuation runs; it ends when
   * posts are handed to Instagram, you scroll up, or the run ends. Each
   * check adds the time since the last one to the reason found then. After
   * CONT_LOAD_NOTE_MS the quiet note shows (never over the end card: the app
   * hides the chip while the card shows). Shapes and timings only. */
  let bottomWait = null;
  function contWait(fs, near, card) {
    const now = Date.now();
    if (!(near && fs.cont && contAlive() && !card)) { contWaitEnd(card ? 'card' : near ? 'ended' : 'up'); return; }
    const w = bottomWait;
    if (!w) {
      bottomWait = { t0: now, last: now, why: contWhy(), ms: { empty: 0, read: 0, pacing: 0, ig: 0 }, nudges: stats.feed.nudges || 0,
        note: false, timer: setTimeout(safe(() => { if (bottomWait) bottomWait.timer = 0; checkFeedEnd(); }), CONT_LOAD_NOTE_MS + 50) };
      return;
    }
    if (w.why in w.ms) w.ms[w.why] += now - w.last;
    w.last = now;
    w.why = contWhy();
    if (!w.note && now - w.t0 >= CONT_LOAD_NOTE_MS && route() === 'home' && !document.hidden) {
      w.note = true;
      cont.waits.notes++;
      homeChip();
    }
  }
  function contWaitEnd(end) {
    const w = bottomWait;
    if (!w) return;
    bottomWait = null;
    clearTimeout(w.timer);
    const now = Date.now();
    if (w.why in w.ms) w.ms[w.why] += now - w.last;
    const ms = now - w.t0;
    if (w.note) homeChip();
    if (ms < 1000) return;
    const r = v => Math.round(v / 100) * 100;
    const W = cont.waits;
    W.n++;
    W.ms += r(ms);
    W.longest = Math.max(W.longest, r(ms));
    for (const k in w.ms) W.why[k] += r(w.ms[k]);
    const e = { ms: r(ms), e: r(w.ms.empty), r: r(w.ms.read), p: r(w.ms.pacing), i: r(w.ms.ig),
      nd: (stats.feed.nudges || 0) - w.nudges, note: w.note, end: end };
    W.last.push(e);
    if (W.last.length > 6) W.last.shift();
    // Kept across restarts (Copy details): the longer waits only.
    if (ms >= 3000) safe(pushTrail)(Object.assign({ ev: 'wait' }, e));
  }
  // A stalled card while the continuation still runs (it should not happen): the wait so far.
  function contStallCard() {
    const W = cont.waits;
    W.cards++;
    const w = bottomWait;
    W.atCard = { state: cont.state, why: contWhy(), ms: w ? Math.round((Date.now() - w.t0) / 100) * 100 : 0, buffer: cs ? cs.buffer.length : 0 };
  }
  // A page Instagram loads after the marker is either its next page (swap in
  // Following) or Home's first page again (Home tab, refresh), which replaces
  // its whole list. Content first: the marker, or a post Home itself showed
  // (a next page never brings back one the list has). Pages labelled
  // feed_recs are Instagram's suggestions paging: always a next page. Then
  // Instagram's own jump to the top, a Home-tab tap passed to it, or (once
  // Following is over) friends' posts as in 1.2. Returns the reason, or ''.
  function contHead(owner, list, jump, tap) {
    let why = '';
    if (markerAt(list) >= 0) why = 'marker';
    else if (list.some(e => followedPost(e) && homeRanked.has(edgeCode(e)))) why = 'seen';
    else if (owner.pagination_source === 'feed_recs') why = '';
    else if (jump) why = 'jump';
    else if (tap) why = 'tap';
    else if (cont.state !== 'running' && !(cs && cs.buffer.length) && list.some(followedPost)) why = 'ended';
    if (why) bump(cont.headWhy, why);
    return why;
  }
  // Instagram's next page, handed back with Following in place of its
  // suggestions: first the page's own posts from people you follow (never
  // dropped, in Instagram's order), then up to one page from the buffer.
  // page_info and pagination_source stay exactly as Instagram sent them, so
  // its cursor chain (and its next request) stays its own.
  function contHandover(owner, list, fs, ctx, tr) {
    if (ctx) for (const e of list) noteUnit(e, 'cont', ctx);
    const igMore = hasMore(owner) && !!cursorOf(owner);   // Relay pages on only with a cursor
    const run = cs;
    const waited = !!(run && run.waiting);
    if (run) run.waiting = false;
    const out = [], codes = new Set();
    for (const e of list) {
      const code = followedPost(e) ? edgeCode(e) : null;
      if (code && !homeSeen.has(code) && !codes.has(code)) { out.push(e); codes.add(code); }
    }
    const igKept = out.length;
    cont.igKept += igKept;
    if (run && igKept) {
      run.buffer = run.buffer.filter(e => !codes.has(edgeCode(e)));
      if (run.resume) run.resume.buffer = run.resume.buffer.filter(e => !codes.has(edgeCode(e)));
    }
    let room = cont.handed >= CONT_MAX_HANDED ? 0 : Math.min(contPageSize(), CONT_MAX_HANDED - cont.handed);
    while (run && room > 0 && run.buffer.length) {
      const e = run.buffer.shift();
      const code = edgeCode(e);
      if (!code || codes.has(code) || homeSeen.has(code)) { cont.skippedSeen++; continue; }   // shown since it was read
      out.push(e);
      codes.add(code);
      room--;
    }
    if (out.some(e => homeSeen.has(edgeCode(e)))) cont.repeats++;   // guard: never happens
    const handed = out.length - igKept;
    // Never an empty list (as after the end without R7): if this is a reload
    // that replaces Home's whole list, one hidden suggestion stays: once
    // Home's paging was stopped here (any page then is a reload), or while
    // Following runs on a page not labelled as Instagram's suggestions paging
    // (feed_recs is always a next page), a few at most (the style rule holds 40).
    const anchorOk = !out.length && (cont.state !== 'running' ? !!fs.contStopped
      : owner.pagination_source !== 'feed_recs' && cont.recsAnchors < 10);
    const anchorAt = anchorOk ? recsAnchorAt(list) : -1;
    const anchorEdge = anchorAt >= 0 ? list[anchorAt] : null;
    out.forEach((e, i) => {
      const code = edgeCode(e);
      noteHomeShown(code, i < igKept);
      if (i < igKept || !run) return;
      run.shown.add(code);
      if (!run.firstCode) { run.firstCode = code; contLabel(code); }
    });
    list.splice(0, list.length, ...out);
    cont.swaps++;
    cont.handed += handed;
    if (!out.length) cont.empty++;
    stats.feed.kept += out.length;
    stats.feed.lastPageKept = out.length;
    fs.handed += out.length;
    fs.shownCount += out.length;
    if (out.length) { fs.shownAny = true; contNote(false); contWaitEnd('posts'); }
    if (run && handed && run.firstMs < 0) { run.firstMs = Date.now() - run.startedAt; contFirstDrawn(run); }
    safe(noteHandover)(out.length, igKept);
    const drained = !run || (!run.more && !run.fetching && !run.timer && !run.buffer.length && !run.resume);
    const limit = cont.handed >= CONT_MAX_HANDED || (!!run && run.capped && !run.buffer.length);
    let ended = false;
    if (!igMore || drained || limit) {
      ended = true;
      stopPagination(owner);
      fs.contStopped = true;
      endFeed(fs, true);
      contNote(false);
      if (cont.state === 'running') {
        // 'done' only when Following itself is used up; Instagram stopping
        // its paging first is 'stopped' (the Following card, never "everything").
        if (limit) { cont.state = 'limit'; cont.reason = cont.handed >= CONT_MAX_HANDED ? 'posts' : 'requests'; }
        else if (drained) { cont.state = 'done'; cont.reason = cont.reason || 'followingEnd'; }
        else { cont.state = 'stopped'; cont.reason = 'homeEnd'; }
        // The run keeps where Following got to: a later reload goes on from there.
        if (run) { clearTimeout(run.timer); run.timer = 0; }
      }
    } else if (out.length <= 2) {
      if (run) {
        if (!waited || out.length) run.waitSeen = contSeenPassed;   // seen posts passed from here on
        run.waiting = true;                  // ask Instagram again once posts are ready
      }
      if (out.length) scheduleNudge(false);
      else if (run && run.more) contNote(true);
    }
    if (anchorEdge && hideAnchor(anchorEdge)) {
      list.push(anchorEdge);
      cont.recsAnchors++;
      fs.handed++;
      countAnchor('recs');
      bump(stats.feed, 'anchorAfterEnd');
    }
    // Stage 1's scroll room under a recs-anchored first page goes once posts show.
    safe(syncRoom)(fs, !ended);
    contFill();
    safe(pushTrail)(Object.assign(tr, { out: out.length, k: out.length, ik: igKept, cf: handed, nx1: !ended, an: '', first: false, ae: false }));
    setTimeout(safe(checkFeedEnd), 300);
  }
  function screensNow() {
    const se = document.scrollingElement || document.documentElement;
    return screens(se.scrollHeight);
  }
  function noteHandover(n, igKept) {
    const e = { n: n, ik: igKept, sh0: screensNow(), sh1: null };
    cont.hand.push(e);
    if (cont.hand.length > 10) cont.hand.shift();
    setTimeout(safe(() => { e.sh1 = screensNow(); }), 1500);
  }
  function codeSelector(code) {
    return ['/p/', '/reel/'].map(k => ON_FEED + 'article:has(a[href*="' + k + code + '/"])').join(',');
  }
  // Whether the first Following post of a run is drawn within 3 s, and its line.
  function contFirstDrawn(run) {
    const code = run.firstCode;
    const r = { ms: run.firstMs, drawn: null, line: null };
    cont.runs.push(r);
    if (cont.runs.length > 5) cont.runs.shift();
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(code || '')) return;
    setTimeout(safe(() => {
      const el = document.querySelector(codeSelector(code));
      r.drawn = !!el;
      if (el) r.line = getComputedStyle(el, '::before').content !== 'none';
    }), 3000);
  }
  // Where Home ends and Following begins: a line above the first post from
  // Following in each run, drawn by a style rule (nothing is added to
  // Instagram's page), on the feed only (never above the post on its own page).
  // Only these characters ever reach the style rule.
  function contLabel(code) {
    try {
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(code)) return;
      if (labelCodes.indexOf(code) < 0) labelCodes.push(code);
      if (labelCodes.length > 10) labelCodes.shift();
      let st = document.getElementById('sg-cont-style');
      if (!st && document.documentElement) {
        st = document.createElement('style');
        st.id = 'sg-cont-style';
        (document.head || document.documentElement).appendChild(st);
      }
      if (!st) return;
      st.textContent = labelCodes.map(c => codeSelector(c).split(',').map(x => x + '::before').join(',')).join(',') + '{' +
        'content:"You\\2019re all caught up \\00B7  Following, newest first";display:block;padding:14px 16px 10px;' +
        'font:600 13px/1.3 system-ui,sans-serif;color:#a8a8a8;border-top:1px solid rgba(128,128,128,.35);text-align:center}';
    } catch (e) { /* no line */ }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) safe(contResume)(); });
  // For tests: the run's state (never part of the status report).
  SG.cont = () => ({ stats: JSON.parse(JSON.stringify(cont)), buffer: cs ? cs.buffer.length : 0, more: cs ? cs.more : null,
    cursor: cs ? cs.cursor : null, firstCode: cs ? cs.firstCode : null, inFlight: contInFlight, why: contWhy(),
    waiting: cs ? !!cs.waiting : null, bottomWait: !!bottomWait, chip: homeChipSent,
    resume: contResumeAt ? { cursor: contResumeAt.cursor, buffer: contResumeAt.buffer.length } : null });

  /* ------------------------------------------------------------------ *
   * End of Home: offer Following (newest first), skipping what you
   * already saw. Shown by the app, outside Instagram's page.
   * ------------------------------------------------------------------ */
  let feedEndShown = null, feedEndSent = '', atBottomSince = 0;
  const STALL_MS = 15000;  // nothing at all arrived for this long while you wait at the bottom
  const END_ROOM = 170;    // CSS px under the last post: the app's card and a margin
  // Room below the last post while Home is at its end, so the card never covers it.
  function endRoom(on) {
    let el = document.getElementById('sg-end-room');
    if (on && !el && document.body) {
      el = document.createElement('div');
      el.id = 'sg-end-room';
      el.setAttribute('aria-hidden', 'true');
      el.style.cssText = 'height:' + END_ROOM + 'px;pointer-events:none';
      document.body.appendChild(el);
    } else if (!on && el) {
      el.remove();
    }
  }
  function checkFeedEnd(force) {
    if (CFG.role !== 'main') return;
    const fs = currentFeed();
    const onHome = route() === 'home' && feedVariant() === 'home';
    const searching = typeof search !== 'undefined' && search.open;
    let show = false, stalled = false;
    if (onHome && !searching) {
      const se = document.scrollingElement || document.documentElement;
      const gap = se.scrollHeight - (se.scrollTop + innerHeight);
      // Once shown, the card stays until you scroll well away: no flicker.
      const near = gap < (feedEndShown ? innerHeight : Math.max(400, innerHeight * 0.6));
      const now = Date.now();
      if (near) { if (!atBottomSince) atBottomSince = now; } else atBottomSince = 0;
      // The real end: the marker, no more pages, or SimpleGram stopped paging.
      // Never a timer while pages keep arriving; only a stall where nothing does.
      if (fs.ended) show = near;
      // Never while SimpleGram is still working on Following for Home (R7, B22).
      else show = stalled = near && fs.lastPageAt > 0 && now - atBottomSince > STALL_MS && now - fs.lastPageAt > STALL_MS &&
        !(fs.cont && contWorking(fs));
      if (stalled && fs.cont && contAlive() && !feedEndShown) contStallCard();
      contWait(fs, near, show);
    } else {
      atBottomSince = 0;
      contWaitEnd('up');
    }
    endRoom(onHome && (fs.ended || stalled));
    const end = fs.caughtUp && fs.endText;
    // contWhy: why the continuation ended (the card's words for 'limit' depend on it).
    const msg = { on: show, caughtUp: !!fs.caughtUp, stalled: stalled, cont: fs.key === 'home' ? cont.state : 'off',
      contWhy: fs.key === 'home' ? cont.reason : '', title: end ? fs.endText.title : '', subtitle: end ? fs.endText.subtitle : '' };
    const key = JSON.stringify(msg);
    if (key !== feedEndSent || force) {
      feedEndShown = show;
      feedEndSent = key;
      post('feedEnd', msg);
    }
  }
  let feedEndTimer = 0, lastTop = 0, selfScrollAt = 0;
  // Home jumping to its top with no finger on the screen (diagnostics).
  const noteJump = safe(() => {
    if (CFG.role !== 'main' || route() !== 'home') { lastTop = 0; return; }
    const top = (document.scrollingElement || document.documentElement).scrollTop;
    if (lastTop > innerHeight && top < 10 && !touching && Date.now() - lastTouchEnd > 300 && Date.now() - selfScrollAt > 500) {
      homeEvent({ e: 'jump', from: screens(lastTop) });
    }
    lastTop = top;
  });
  let roomSwipeAt = 0;
  window.addEventListener('scroll', e => {
    if (e.isTrusted) lastUserScroll = Date.now();
    noteJump();
    // A swipe into the room: your own input, never SimpleGram's own scrolls.
    const now = Date.now();
    if (e.isTrusted && (touching || now - lastInputAt < 1000) && now - ownScrollAt > 100 && now - roomSwipeAt > 1000 &&
        document.getElementById(ROOM_ID)) { roomSwipeAt = now; safe(noteTry)('swipe'); }
    if (feedEndTimer) return;
    feedEndTimer = setTimeout(() => { feedEndTimer = 0; safe(checkFeedEnd)(); }, 250);
  }, { passive: true, capture: true });
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', safe(() => {
    if (document.hidden) hiddenAt = Date.now();
    if (route() !== 'home') return;
    if (document.hidden) { homeEvent({ e: 'vis', s: 'hidden' }); return; }
    const h = hiddenAt ? Date.now() - hiddenAt : 0;
    homeEvent({ e: 'vis', s: 'visible', h: h < 10000 ? '<10s' : h < 60000 ? '<1m' : h < 600000 ? '<10m' : '>10m' });
  }));
  setInterval(() => {
    if (route() !== 'home' || document.hidden) return;
    safe(checkFeedEnd)();
    safe(sampleFeed)();
    safe(checkNotDrawn)();
  }, 1500);

  /* The Home tab. Instagram's bottom-bar Home and the "< Following" /
   * "< Favorites" link in its header are both a[href="/"]; one dispatcher
   * decides what a tap on them, or on SimpleGram's Favorites star, does.
   * - The star: openFavorites() (R5).
   * - On Home: scrolled down, the tap only goes to the top and keeps the list
   *   (Instagram's answer is to reload the whole feed 30 s after its last load
   *   and jump to the top, which can swap an ended Home for a few posts). At
   *   the top the tap is Instagram's: its own refresh rule applies.
   * - On Following, Favorites or Older posts: a fresh page of Home, never an
   *   in-page switch (Instagram's empty-feed screen and its stored copy of a
   *   feed would follow you there). */
  function swallow(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }
  function homeTab(e, a) {
    if (CFG.role !== 'main' || e.button) return false;
    // The star is SimpleGram's own: Instagram never sees its taps.
    if (a.closest('[data-sg-fav]')) {
      swallow(e);
      stats.nav.taps++;
      openFavorites();
      return true;
    }
    if (a.getAttribute('href') !== '/' || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
    if (route() !== 'home') return false;
    const variant = feedVariant();
    if (variant === 'home') {
      // Search open or a result opening: search's own handling decides.
      if (search.open || leaving) return false;
      const se = document.scrollingElement || document.documentElement;
      const y = yBucket();
      if (se.scrollTop > 8) {
        swallow(e);
        selfScrollAt = Date.now();
        se.scrollTop = 0;
        bump(stats.feed, 'homeTapTop');
        homeEvent({ e: 'tap', a: 'top', y: y });
        return true;
      }
      bump(stats.feed, 'homeTapRefresh');
      homeEvent({ e: 'tap', a: 'passed', y: y });
      contTapped();
      return false;
    }
    swallow(e);
    // Not by <nav>: on a phone Instagram's top header (the "< Favorites"
    // link) sits in a <nav> too (PolarisMobileHeaderWrapper).
    const where = a.closest('header') ? 'header' : homeItem(a) || a.getBoundingClientRect().top > innerHeight / 2 ? 'bar' : 'header';
    bump(stats.nav.homeFull, where);
    openFeedFresh('home');
    return true;
  }
  // A feed as a new page, like the app's menu (which also closes the comments
  // panel and resets zoom); location.assign when the app's bridge is missing.
  function openFeedFresh(variant) {
    cancelOpen();
    // If Instagram's router still finishes the called-off open, it must not
    // be stepped back from (that would cancel this load): the feed replaces it.
    if (calledOff) calledOff.reload = variant === 'home' ? '/' : '/?variant=' + variant;
    if (search.open) { hideSearch(false); search.suspended = false; clearSaved(); }
    if (!post('openFeed', { variant: variant })) location.assign(variant === 'home' ? '/' : '/?variant=' + variant);
  }
  // A search result still opening (B14) is called off first: its watcher's
  // own full load of the result would otherwise replace the page asked for.
  function cancelOpen() {
    if (!leaving) return;
    stopFullLoad(leaving);
    endOpen();
    countOpen('cancelled');
    stats.nav.openCancelled++;
  }
  // The Favorites star (R5). Favorites opens as a new page, like the menu
  // (B18: an in-page switch can bring Instagram's stored copy of a feed or
  // its empty-feed screen along). Already on Favorites, a tap is Instagram's
  // Home-tab answer: search closed first, then to the top, then (at the top)
  // a fresh load, at most once per 30 s after the last load or feed page
  // (Instagram's shouldRefreshOnHomeClick rule). No skip list is written:
  // Favorites shows everything, newest first.
  const FAV_URL = '/?variant=favorites';
  const FAV_REFRESH_MS = 30000;
  function onFavorites() { return route() === 'home' && feedVariant() === 'favorites'; }
  function openFavorites() {
    cancelOpen();
    if (!onFavorites()) {
      post('feedEnd', { on: false });
      openFeedFresh('favorites');
      return;
    }
    if (search.open) {
      hideSearch(true);
      search.suspended = false;
      clearSaved();
      stats.nav.closedSearch++;
      return;
    }
    const se = document.scrollingElement || document.documentElement;
    if (se.scrollTop > 8) {
      selfScrollAt = Date.now();
      se.scrollTop = 0;
      stats.nav.top++;
      return;
    }
    const loadedAt = performance.timeOrigin || Date.now() - performance.now();
    const last = Math.max(loadedAt, feedFor('favorites').lastPageAt || 0);
    if (Date.now() - last <= FAV_REFRESH_MS) { stats.nav.refreshHeld++; return; }
    stats.nav.refresh++;
    location.replace(FAV_URL);
  }



  /* ------------------------------------------------------------------ *
   * Installed-app look: no "Use the app" banners (Instagram treats a
   * standalone web app like its installed PWA).
   * ------------------------------------------------------------------ */
  if (window.matchMedia) {
    const nativeMatch = window.matchMedia;
    window.matchMedia = function matchMedia(query) {
      const real = nativeMatch.apply(window, arguments);
      if (typeof query === 'string' && /display-mode\s*:\s*standalone/i.test(query)) {
        return {
          matches: true, media: real.media, onchange: null,
          addListener() {}, removeListener() {},
          addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
        };
      }
      return real;
    };
  }

  /* ------------------------------------------------------------------ *
   * Small DOM helpers
   * ------------------------------------------------------------------ */
  function norm(el) { return (el && el.textContent || '').replace(/\s+/g, ' ').trim(); }
  function ownText(el) {
    let s = '';
    for (const n of el.childNodes) if (n.nodeType === 3) s += n.nodeValue;
    return s.replace(/\s+/g, ' ').trim();
  }
  function hide(el, reason) {
    if (!el || el.dataset.sgHidden) return false;
    el.dataset.sgHidden = reason;
    el.style.setProperty('display', 'none', 'important');
    return true;
  }
  function unhide(el) {
    if (!el || !el.dataset.sgHidden) return;
    delete el.dataset.sgHidden;
    el.style.removeProperty('display');
  }
  const NAV_SELECTOR = 'a[href="/"],a[href="/explore/"],a[href="/direct/inbox/"],a[href^="/accounts/activity"]';
  function containsNav(el) { return !!(el && el.querySelector && el.querySelector(NAV_SELECTOR)); }
  function visibleBox(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? r : null;
  }

  function addStyle() {
    if (document.getElementById('sg-style') || !document.documentElement) return;
    const s = document.createElement('style');
    s.id = 'sg-style';
    s.textContent = [
      // Tap highlight flashes look out of place in an app.
      '*{-webkit-tap-highlight-color:transparent}',
      // Links to the endless Reels tab (never a specific Reel).
      'a[href="/reels/"],a[href="/reels"]{display:none!important}',
      // R8: the video SimpleGram put full screen is shown whole, on black,
      // with no controls over it (one rule each: an unknown one drops only itself).
      'video[data-sg-full]:fullscreen{object-fit:contain!important;background:#000!important;border-radius:0!important}',
      'video[data-sg-full]:fullscreen::-webkit-media-controls{display:none!important}',
      'video[data-sg-full]:fullscreen::-webkit-media-controls-enclosure{display:none!important}',
      'video[data-sg-full]:fullscreen::-webkit-media-controls-overlay-play-button{display:none!important}',
      // B20: the comment box is one line high while reading; Instagram sizes it while typing.
      'textarea[data-sg-composer]:not([data-sg-open]){max-height:var(--sg-one-line,40px)!important;overflow-y:hidden!important}',
    ].concat(FAV_CSS).join('\n');
    (document.head || document.documentElement).appendChild(s);
  }

  /* ------------------------------------------------------------------ *
   * Tidy the interface: banners, Reels tab, Explore grid, and a
   * conservative backup filter for anything the data layer missed.
   * ------------------------------------------------------------------ */
  const BANNER_TEXT = /^(use the app|open (in )?(the )?app|open instagram|get the app|use app|switch to the app|open the instagram app|get instagram)$/i;
  const STORE_LINKS = 'a[href*="play.google.com"],a[href*="apps.apple.com"],a[href*="itunes.apple.com"],a[href^="intent:"],a[href*="/download/android"]';

  function hideBanner(start) {
    let el = start;
    while (el.parentElement && el.parentElement !== document.body &&
      !containsNav(el.parentElement) && !el.parentElement.querySelector('article,main,input,textarea,form') &&
      el.parentElement.getBoundingClientRect().height < 170) {
      el = el.parentElement;
    }
    if (containsNav(el) || el.querySelector('article,main,input,textarea')) return;
    const close = el.querySelector('[aria-label="Close"],[aria-label="Dismiss"]');
    if (close && !close.dataset.sgClicked) { close.dataset.sgClicked = '1'; try { close.click(); } catch (e) { /* ignore */ } }
    if (hide(el, 'banner')) stats.dom.banners++;
  }
  // The Story check's walk skips posts and anything SimpleGram hid: Home's feed
  // can stay mounted under Stories, and walking all of it there made Stories slow.
  function walkOutsidePosts(show, want) {
    return document.createTreeWalker(document.body, show, { acceptNode: n =>
      n.nodeType === 1 && (n.tagName === 'ARTICLE' || n.hasAttribute('data-sg-hidden')) ? NodeFilter.FILTER_REJECT
        : want(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP });
  }
  function tidyBanners() {
    // In a conversation a message or comment can read exactly like a banner,
    // and Instagram never shows its app banner on DM or comments pages anyway.
    const r = route();
    const skipText = CFG.role !== 'main' || r === 'direct' || r === 'comments';
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n, guard = 0;
    while (!skipText && (n = walker.nextNode()) && guard++ < 20000) {
      const t = n.nodeValue;
      if (!t || t.length > 40 || !BANNER_TEXT.test(t.trim())) continue;
      const el = n.parentElement;
      if (!el || el.closest('[data-sg-hidden],article,[role="dialog"] [role="listbox"]')) continue;
      hideBanner(el);
    }
    for (const a of document.querySelectorAll(STORE_LINKS)) {
      if (!a.closest('[data-sg-hidden],article')) hideBanner(a);
    }
  }
  function tidyReelsTab() {
    for (const a of document.querySelectorAll('a[href="/reels/"],a[href="/reels"]')) {
      let el = a;
      while (el.parentElement && el.parentElement.children.length === 1 && !containsNav(el.parentElement)) el = el.parentElement;
      if (hide(el, 'reels-tab')) stats.dom.reelsTab++;
    }
  }

  /* ------------------------------------------------------------------ *
   * Favorites in Instagram's bottom bar (R5): a star right after Home, in
   * the room the hidden Reels tab left. The star is SimpleGram's own
   * element, one more child of Instagram's flex row (which spaces its
   * items evenly); Instagram's own items are never moved or changed. An
   * observer started at document start puts it in during the same
   * mutation microtask in which React adds the bar, so the bar never
   * shifts on screen. Taps on it go through homeTab().
   * Work stays bounded on a long feed: the observer looks only at added
   * subtrees holding a link to "/", the tidy pass re-checks the stars it
   * knows and searches the page only when there are none, and no ancestor
   * that holds the feed is ever searched.
   * ------------------------------------------------------------------ */
  // Instagram's own star (IGDSStarPanoFilledIcon), 24 x 24. The outline is the
  // same shape at 91% with a 2 px line, like Instagram's Search and Messages icons.
  const STAR_D = 'M18.18 22.51a.99.99 0 0 1-.513-.142L12 18.975l-5.667 3.393a1 1 0 0 1-1.492-1.062l1.37-6.544-4.876-4.347a.999.999 0 0 1 .536-1.737l6.554-.855 2.668-5.755a1 1 0 0 1 1.814 0l2.668 5.755 6.554.855a.999.999 0 0 1 .536 1.737l-4.876 4.347 1.37 6.544a1 1 0 0 1-.978 1.205Z';
  const FAV_CSS = [
    // Instagram's phone items: a 24 px icon in a 48 px box (12 px padding), centred.
    // Flex, not inline: an inline link's line box depends on the phone's fonts.
    '[data-sg-fav] a{display:flex;justify-content:center;color:rgb(var(--ig-primary-text,0,0,0));text-decoration:none;outline:none}',
    '[data-sg-fav] .sg-fav-box{box-sizing:border-box;display:flex;justify-content:center;padding:12px;border-radius:8px;transition:transform .1s}',
    '[data-sg-fav] a:active .sg-fav-box{transform:scale(.97)}',
    '[data-sg-fav] a:focus-visible .sg-fav-box{box-shadow:0 0 0 2px rgb(var(--ig-primary-text,0,0,0))}',
    '[data-sg-fav] svg{display:block;width:24px;height:24px}',
    // Filled on Favorites, an outline elsewhere (Instagram's Home icon is left alone).
    '[data-sg-fav] .sg-on,html[data-sg-feed="favorites"] [data-sg-fav] .sg-off{display:none}',
    'html[data-sg-feed="favorites"] [data-sg-fav] .sg-on{display:block}',
    // Stories and messages never show it (a bar kept under them keeps its star, hidden).
    'html[data-sg-nostar] [data-sg-fav]{display:none!important}',
  ];
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function starSvg(cls, filled) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', cls);
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('viewBox', '0 0 24 24');
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', STAR_D);
    if (filled) svg.setAttribute('fill', 'currentColor');
    else {
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '2.2');
      svg.setAttribute('stroke-linejoin', 'round');
      p.setAttribute('transform', 'matrix(.909 0 0 .909 1.091 1.091)');
    }
    svg.appendChild(p);
    return svg;
  }
  // Own markup, not a copy of Home's: a copy would carry href="/" (and be taken
  // for Home), aria-selected and Instagram's passing press classes.
  function starNode() {
    const slot = document.createElement('div');
    slot.setAttribute('data-sg-fav', '');
    const a = document.createElement('a');
    a.setAttribute('href', FAV_URL);
    a.setAttribute('role', 'link');
    a.setAttribute('aria-label', 'Favorites');
    const box = document.createElement('div');
    box.className = 'sg-fav-box';
    box.appendChild(starSvg('sg-off', false));
    box.appendChild(starSvg('sg-on', true));
    a.appendChild(box);
    const inner = document.createElement('div');
    inner.appendChild(a);
    slot.appendChild(inner);
    markStar(slot);
    return slot;
  }
  function markStar(star) {
    const a = star.querySelector('a');
    if (!a) return;
    if (onFavorites()) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  // Which feed shows (the star's filled state), and whether this page shows no star.
  function markFeed() {
    const root = document.documentElement;
    if (CFG.role !== 'main' || !root) return;
    root.setAttribute('data-sg-feed', route() === 'home' ? feedVariant() : '');
    if (noStarHere()) root.setAttribute('data-sg-nostar', '');
    else root.removeAttribute('data-sg-nostar');
    for (const s of stars) markStar(s);
  }
  function noStarHere() { const r = route(); return r === 'story' || r === 'direct'; }

  const stars = new Set();           // the stars in place (SimpleGram's own nodes)
  // Bar rows without a star for now: not along the bottom (a side bar),
  // Instagram's own Favorites item there, or React never took them over.
  const parked = new Set();
  const waiting = new Set();         // rows React hasn't taken over yet
  const waits = new WeakMap();       // row -> { n, at, gaveUp }
  const notBottomRows = new WeakSet();
  let bottomSeen = new WeakMap();    // row -> { v, at }; cleared on resize
  let rowFlagged = false, lastStarScan = 0, waitTimer = 0, geoTimer = 0, geoTries = 0;
  // A row of Instagram's bar: at least 4 items and a link to Messages (the inbox,
  // or the last chat: DIRECT_THREADS + key) or Explore. The look inside stops
  // after 400 elements (a bar has about 100), so an ancestor that holds the
  // feed is never searched. (Finding the page's <main> to rule it out costs
  // more: about 2 ms after each change on a long feed.)
  function barRow(row) {
    if (row.childElementCount < 4) return false;
    let n = row.firstElementChild, seen = 0;
    while (n && n !== row) {
      if (++seen > 400) return false;
      if (n.tagName === 'A') {
        const h = n.getAttribute('href') || '';
        if (h === '/explore/' || h.startsWith('/direct/')) return true;
      }
      if (n.firstElementChild) { n = n.firstElementChild; continue; }
      while (n && n !== row && !n.nextElementSibling) n = n.parentElement;
      if (n && n !== row) n = n.nextElementSibling;
    }
    return false;
  }
  // Home's item (the row's child) for a link to "/", or null for any other link to "/".
  function homeItem(a) {
    // Instagram's bar row is marked ignore-dynamic (PolarisNavigationIcons).
    let el = a;
    for (let i = 0; i < 6; i++) {
      const row = el.parentElement;
      if (!row || row === document.body) break;
      if (row.getAttribute('data-visualcompletion') === 'ignore-dynamic') {
        if (barRow(row)) return el;
        break;
      }
      el = row;
    }
    // Otherwise a short climb; never from a link in the page or its header
    // (the "< Favorites" link is one, deep in a long feed).
    if (a.closest('main,header')) return null;
    el = a;
    for (let i = 0; i < 6; i++) {
      const row = el.parentElement;
      if (!row || row === document.body || row === document.documentElement) return null;
      if (barRow(row)) return el;
      el = row;
    }
    return null;
  }
  // A row along the bottom of the screen (a phone's bar), not the side bar of
  // a wide screen or a header. Works while the bar is hidden too. Remembered
  // per row until the window changes size (a "no" is looked at again after 2 s:
  // Instagram's styles may not have applied yet).
  function bottomRow(row) {
    const seen = bottomSeen.get(row);
    if (seen && (seen.v || Date.now() - seen.at < 2000)) return seen.v;
    const v = measureBottom(row);
    bottomSeen.set(row, { v: v, at: Date.now() });
    return v;
  }
  function measureBottom(row) {
    const cs = getComputedStyle(row);
    if (cs.display !== 'flex' || cs.flexDirection !== 'row') return false;
    let el = row;
    for (let i = 0; i < 15 && el && el !== document.body; i++, el = el.parentElement) {
      const s = getComputedStyle(el);
      if (s.position === 'fixed') return parseFloat(s.bottom) <= 1 || s.bottom === 'auto' && parseFloat(s.top) > innerHeight / 2;
    }
    return false;
  }
  // React's own key on the nodes it manages. A bar drawn by the server and
  // not yet taken over by React must not get an extra child: React would
  // throw the bar away and draw it again. The key alone is not enough: React
  // sets it while it hydrates, before it commits, and a hydration that is
  // started over (a tap, any update) would meet the star and redraw.
  function reactOwned(el) {
    const k = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
    if (!k) return false;
    const f = el[k];
    if (!f || typeof f !== 'object' || typeof f.tag !== 'number' || !('return' in f)) return true;   // not a fiber we know
    return fiberMounted(f);
  }
  // React's own test (getNearestMountedFiber): a fiber React has rendered
  // before is in the page if its parents lead to the root; a new one only
  // when no fiber on the way still waits to be placed or hydrated
  // (Placement 2, Hydrating 4096; cleared when React commits).
  function fiberMounted(f) {
    let node = f, nearest = f;
    for (let i = 0; ; i++) {
      if (!f.alternate && (node.flags & 4098)) nearest = node.return;
      if (!node.return) break;
      if (i > 5000) return true;   // not a shape we know: as before
      node = node.return;
    }
    return node.tag === 3 && nearest === f;
  }
  function reactLike(el) {
    return Object.keys(el).some(k => k.startsWith('__react'));
  }
  function igFavIn(row) {
    for (const l of row.querySelectorAll('a[href*="variant=favorites"]')) if (!l.closest('[data-sg-fav]')) return true;
    return false;
  }
  function homeChild(row, star) {
    for (const c of row.children) if (c !== star && c.querySelector('a[href="/"]')) return c;
    return null;
  }
  function dropStar(star) {
    stars.delete(star);
    star.remove();
  }
  // Puts (or keeps) one star right after Home's item in this row, or none where it doesn't belong.
  function settleRow(row, item) {
    let star = null;
    for (const c of row.children) if (c.hasAttribute('data-sg-fav')) { star = c; break; }
    if (!reactOwned(row) && !waitForReact(row)) return;
    watchRow(row);
    if (!bottomRow(row)) {
      if (star) dropStar(star);
      parked.add(row);
      if (!notBottomRows.has(row)) { notBottomRows.add(row); stats.nav.notBottom++; }
      return;
    }
    // Instagram's own Favorites item (if it ever adds one) wins.
    if (igFavIn(row)) {
      if (star) dropStar(star);
      parked.add(row);
      stats.nav.igHasFav = 1;
      return;
    }
    parked.delete(row);
    if (star && item.nextElementSibling === star) { stars.add(star); armGeo(); return; }
    if (star) stats.nav.moved++;
    else {
      addStyle();
      if (!document.documentElement.hasAttribute('data-sg-feed')) markFeed();
      star = starNode();
      stats.nav.inserted++;
    }
    row.insertBefore(star, item.nextSibling);
    stars.add(star);
    // The empty Reels item goes in the same moment, so the bar never shifts.
    for (const c of row.children) {
      if (c !== star && c.querySelector('a[href="/reels/"],a[href="/reels"]') && hide(c, 'reels-tab')) stats.dom.reelsTab++;
    }
    armGeo();
  }
  // The geometry sample, about 2 s after the star shows. Armed again by any
  // look that finds the star in place, or a route change, until one
  // measurement is taken (3 tries at most); a star hidden then (Stories,
  // messages) costs no try.
  function armGeo() {
    if (!stats.nav.geo && !geoTimer && geoTries < 3) geoTimer = setTimeout(() => { geoTimer = 0; safe(sampleNav)(); }, 2000);
  }
  // True when the row may take the star now. Otherwise it is looked at again
  // every 400 ms, for 25 tries or 10 s at most; then only a tidy pass that
  // finds it React's (or carrying another of React's keys) puts the star in.
  function waitForReact(row) {
    let w = waits.get(row);
    if (!w) waits.set(row, w = { n: 0, at: Date.now(), gaveUp: false });
    if (w.gaveUp) return reactLike(row);
    if (w.n >= 25 || Date.now() - w.at > 10000) {
      w.gaveUp = true;
      waiting.delete(row);
      parked.add(row);
      stats.nav.waitReactGaveUp++;
      return reactLike(row);
    }
    stats.nav.waitReact++;
    waiting.add(row);
    if (!waitTimer) waitTimer = setTimeout(retryWaiting, 400);
    return false;
  }
  const retryWaiting = safe(() => {
    waitTimer = 0;
    for (const row of Array.from(waiting)) {
      const w = waits.get(row);
      if (w) w.n++;
      if (!row.isConnected) { waiting.delete(row); continue; }
      const item = homeChild(row, null);
      if (!item) { waiting.delete(row); continue; }
      if (reactOwned(row)) waiting.delete(row);
      settleRow(row, item);
    }
  });
  // The observer: only added subtrees holding a link to "/" are looked at.
  function starsAdded(records) {
    if (CFG.role !== 'main') return;
    if (noStarHere()) { rowFlagged = true; return; }   // Stories, messages: nothing to do
    const t0 = performance.now();
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (n.nodeType !== 1 || n.hasAttribute('data-sg-fav')) continue;
        if (n.matches('a[href="/"]')) starFor(n);
        else if (n.firstElementChild) for (const a of n.querySelectorAll('a[href="/"]')) starFor(a);
      }
    }
    const ms = performance.now() - t0;
    if (ms > stats.nav.obsMs) stats.nav.obsMs = Math.round(ms * 100) / 100;
  }
  function starFor(a) {
    const item = homeItem(a);
    if (!item) return;
    const next = item.nextElementSibling;
    if (next && next.hasAttribute('data-sg-fav') && stars.has(next)) return;   // already in place
    settleRow(item.parentElement, item);
  }
  // Every Home link on the page (bounded climbs): only when no bar is known
  // at all, or the observer skipped something (on Stories or in messages).
  function searchStars() {
    lastStarScan = Date.now();
    rowFlagged = false;
    stats.nav.tidyScans++;
    for (const a of document.querySelectorAll('a[href="/"]')) {
      const item = homeItem(a);
      if (item) settleRow(item.parentElement, item);
    }
  }
  // The tidy pass: the known stars (dropped when gone, put back after Home
  // when moved) and the parked rows; the whole page only when nothing is known.
  // force: the layout may have changed (resize), so every star is looked at.
  function tidyStars(force) {
    if (CFG.role !== 'main' || !document.body || noStarHere()) return;
    for (const s of Array.from(stars)) {
      const row = s.parentElement;
      if (!s.isConnected || !row) { stars.delete(s); continue; }
      const prev = s.previousElementSibling;
      if (!force && prev && prev.querySelector('a[href="/"]') && !igFavIn(row)) continue;
      const item = homeChild(row, s);
      if (item) settleRow(row, item); else dropStar(s);
    }
    for (const row of Array.from(parked)) {
      const item = row.isConnected && homeChild(row, null);
      if (!item) { parked.delete(row); continue; }
      settleRow(row, item);
    }
    if (rowFlagged || !stars.size && !parked.size && !waiting.size && Date.now() - lastStarScan > 1000) searchStars();
  }
  // Turning the phone switches Instagram's bar to its side bar, or back: a
  // class or style change on the row or its container, which the observer of
  // added nodes doesn't see. Those few elements are watched, so the star
  // follows in the same moment React makes the change (no frame shows it in
  // the side bar, or the bar without it).
  const watchOf = new WeakMap();     // watched element -> the bar rows under it
  const watchedRows = new WeakSet();
  let rowWatch = null;
  function watchRow(row) {
    if (watchedRows.has(row)) return;
    watchedRows.add(row);
    if (!rowWatch) {
      try { rowWatch = new MutationObserver(safe(rowsChanged)); } catch (e) { return; }
    }
    let el = row;
    for (let i = 0; i < 8 && el && el !== document.body; i++, el = el.parentElement) {
      let set = watchOf.get(el);
      if (!set) watchOf.set(el, set = new Set());
      for (const old of set) if (!old.isConnected) set.delete(old);
      set.add(row);
      rowWatch.observe(el, { attributes: true, attributeFilter: ['class', 'style'] });
    }
  }
  function rowsChanged(records) {
    if (CFG.role !== 'main' || noStarHere()) return;
    const done = new Set();
    for (const r of records) {
      for (const row of watchOf.get(r.target) || []) {
        if (done.has(row) || !row.isConnected) continue;
        done.add(row);
        bottomSeen.delete(row);
        const item = homeChild(row, null);
        if (item) settleRow(row, item);
      }
    }
  }
  // And as a backstop, every star is looked at before each frame for a
  // second after the window changes size; one search of the page at the end.
  let resizeUntil = 0, resizeFrame = 0;
  function resizeFrameCheck() {
    resizeFrame = 0;
    bottomSeen = new WeakMap();
    tidyStars(true);
    if (Date.now() < resizeUntil) resizeFrame = requestAnimationFrame(safe(resizeFrameCheck));
    else if (!noStarHere()) searchStars();   // in Stories or messages the return there looks (rowFlagged)
  }
  // Shapes only: does the star line up with Instagram's items on this phone?
  function sampleNav() {
    if (noStarHere()) return;
    const star = Array.from(stars).find(s => s.isConnected && visibleBox(s));
    if (!star) return;
    geoTries++;
    const row = star.parentElement;
    const items = Array.from(row.children).filter(c => visibleBox(c));
    const home = star.previousElementSibling;
    const homeSvg = home && Array.from(home.querySelectorAll('a[href="/"] svg')).find(s => visibleBox(s));
    const favSvg = Array.from(star.querySelectorAll('svg')).find(s => visibleBox(s));
    if (!homeSvg || !favSvg) return;
    const hb = homeSvg.getBoundingClientRect(), sb = favSvg.getBoundingClientRect();
    const centres = items.map(c => { const r = c.getBoundingClientRect(); return r.left + r.width / 2; });
    const gaps = centres.slice(1).map((x, i) => x - centres[i]);
    const msg = row.querySelector('a[href^="/direct/"]');
    stats.nav.geo = {
      items: items.length, rowW: Math.round(row.getBoundingClientRect().width),
      home: [Math.round(hb.width), Math.round(hb.height)], star: [Math.round(sb.width), Math.round(sb.height)],
      dy: Math.round((sb.top + sb.height / 2) - (hb.top + hb.height / 2)),
      gap: gaps.length ? [Math.round(Math.min.apply(null, gaps)), Math.round(Math.max.apply(null, gaps))] : null,
      sameColour: getComputedStyle(homeSvg).color === getComputedStyle(favSvg).color,
      // Where Messages points (a shape, never the chat): the inbox or a chat.
      msg: !msg ? 'none' : /^\/direct\/inbox\/?$/.test(msg.getAttribute('href')) ? 'inbox' : 'thread',
    };
  }
  // Watches from document start: Instagram may draw its bar before
  // DOMContentLoaded, when the rest of SimpleGram starts.
  if (CFG.role === 'main') {
    try { new MutationObserver(safe(starsAdded)).observe(document, { childList: true, subtree: true }); } catch (e) { /* no observer: the tidy pass places it */ }
    window.addEventListener('resize', safe(() => {
      resizeUntil = Date.now() + 1000;
      if (!resizeFrame) resizeFrame = requestAnimationFrame(safe(resizeFrameCheck));
    }));
  }

  function tidyExplore() {
    if (route() !== 'explore') return;
    const links = Array.from(document.querySelectorAll('main a[href*="/p/"],main a[href*="/reel/"]'))
      .filter(a => !a.closest('[data-sg-hidden]'));
    if (links.length < 6) return;
    let lca = links[0].parentElement;
    while (lca && !links.every(a => lca.contains(a))) lca = lca.parentElement;
    if (!lca || lca === document.body || lca.tagName === 'MAIN' || lca.querySelector('input')) return;
    if (hide(lca, 'explore')) stats.dom.exploreGrid++;
  }

  // A feed post. Instagram uses <article>; some layouts mark posts with a role instead.
  const POST = 'article,div[role="article"]';
  const AD_LABEL = /^(sponsored|ad|advertisement|promoted)$/i;
  const SUGGEST_LABEL = /^suggested (for you|post|posts|reel|reels)$/i;
  const REPOST_LABEL = /^(.{1,60} )?reposted( this)?$|^reposted by .{1,60}$/i;
  function headerLabel(article) {
    const box = article.getBoundingClientRect();
    const media = article.querySelector('img[srcset],video,img[sizes]');
    const mediaTop = media ? media.getBoundingClientRect().top : box.top + 90;
    for (const el of article.querySelectorAll('span,div,a')) {
      if (el.children.length > 1) continue;
      const t = ownText(el) || (el.children.length === 0 ? norm(el) : '');
      if (!t || t.length > 70) continue;
      const r = el.getBoundingClientRect();
      if (r.top > mediaTop + 2) break;
      if (AD_LABEL.test(t)) return 'ads';
      if (SUGGEST_LABEL.test(t)) return 'suggested';
      if (REPOST_LABEL.test(t)) return 'reposts';
    }
    return '';
  }
  const checked = new WeakMap();
  function articleSig(article) {
    const t = article.querySelector('a[href] time');
    const a = t && t.closest('a[href]');
    const img = article.querySelector('img[srcset],video');
    return (a ? a.getAttribute('href') : '') + '|' + (img ? (img.getAttribute('src') || img.getAttribute('poster') || '').slice(-60) : '') + '|' + article.childElementCount;
  }
  // Checks a post once per change. `early` is the first look, as Instagram adds
  // it; when that finds nothing, the regular pass looks once more after the
  // post settles (a label can arrive a moment later). A labelled post is
  // hidden and its video paused (nothing else on the player is touched).
  // True when just hidden.
  function checkPost(article, early) {
    const sig = articleSig(article);
    const prev = checked.get(article);
    if (prev && prev.sig === sig && (early || !prev.early)) return false;
    const reason = headerLabel(article);
    checked.set(article, { sig: sig, reason: reason, early: !!early && !reason });
    if (reason) {
      if (!hide(article, reason)) return false;
      stats.dom[reason]++;
      for (const v of article.querySelectorAll('video')) if (!v.paused) v.pause();
      return true;
    }
    if (!article.dataset.sgHidden) noteFollowButton(article);
    else if (!early) unhide(article);
    return false;
  }
  function tidyFeed() {
    if (route() !== 'home' || CFG.role !== 'main') return;
    let hid = false;
    for (const article of document.querySelectorAll(POST)) if (checkPost(article, false)) hid = true;
    if (hid) checkHiddenRun();
  }
  // Labelled posts are hidden as Instagram adds them, before they are drawn.
  // Hidden later, each one flashed and left black space in Instagram's list.
  function hideAddedPosts(records) {
    if (route() !== 'home' || CFG.role !== 'main') return;
    const posts = new Set();
    for (const r of records) {
      for (const n of r.addedNodes) {
        const el = n.nodeType === 1 ? n : n.parentElement;
        if (!el || !el.closest) continue;
        const up = el.closest(POST);
        if (up) posts.add(up);
        else if (n.nodeType === 1 && n.firstElementChild) for (const a of n.querySelectorAll(POST)) posts.add(a);
      }
    }
    let hid = false;
    for (const a of posts) if (checkPost(a, true)) hid = true;
    if (hid) checkHiddenRun();
  }
  // Hiding is only safe with a stop: several labelled posts in a row at the
  // end of Home means Instagram is paging through suggestions that all get
  // hidden, which never ends. Home ends there instead.
  // Instagram's list draws the posts after a hidden one only once it has
  // measured it, so the run must reach the last post Home has loaded, not
  // just the last one drawn.
  function atLoadedEnd(a, fs) {
    const t = a && a.querySelector('a[href] time');
    const l = t && t.closest('a[href]');
    const m = l && /\/(?:p|reel)\/([^/?#]+)/.exec(l.getAttribute('href') || '');
    return !m || !fs.lastKeptCode || m[1] === fs.lastKeptCode;
  }
  function checkHiddenRun() {
    let run = 0, any = 0, longest = 0, last = null;
    for (const a of document.querySelectorAll(POST)) {
      last = a;
      const why = a.dataset.sgHidden;
      any = why ? any + 1 : 0;
      run = why === 'suggested' || why === 'ads' ? run + 1 : 0;
      if (any > longest) longest = any;
    }
    stats.feed.hiddenRun = Math.max(stats.feed.hiddenRun || 0, longest);
    const fs = currentFeed();
    if (run >= 4 && feedVariant() === 'home' && fs.key === 'home' && !fs.ended && atLoadedEnd(last, fs)) {
      endFeed(fs);
      stats.feed.domStop = (stats.feed.domStop || 0) + 1;
      setTimeout(safe(checkFeedEnd), 0);
    }
  }
  // Diagnostics: Home posts on screen with a "Follow" button in their header
  // (someone you don't follow). Counted once per post; nothing is hidden for it.
  const followCounted = new Set();
  function noteFollowButton(article) {
    if (feedVariant() !== 'home') return;
    const t = article.querySelector('a[href] time');
    const link = t && t.closest('a[href]');
    const key = link && link.getAttribute('href');
    if (!key || followCounted.has(key)) return;
    const media = article.querySelector('img[srcset],video,img[sizes]');
    const top = media ? media.getBoundingClientRect().top : article.getBoundingClientRect().top + 90;
    for (const b of article.querySelectorAll('button,[role="button"]')) {
      if (b.getBoundingClientRect().top > top) break;
      if (!/^follow$/i.test(norm(b))) continue;
      followCounted.add(key);
      cap(followCounted, 2000);
      stats.feed.followButtons = (stats.feed.followButtons || 0) + 1;
      return;
    }
  }
  // Diagnostics, sampled every 1.5 s while Home is open: how much of the feed
  // is mounted, blank screens, and whether Instagram's own JSON parser (its
  // anti-adblock check) may be reading pages instead of the hook.
  const GHOST_OWL_KEYS = ['h4npx7qw', 'v9k2mt7q', 'q9k7m2x', 'k8pq2mnb'];
  let blankChecks = 0;
  function sampleFeed() {
    const f = stats.feed;
    f.peakPosts = Math.max(f.peakPosts || 0, document.querySelectorAll(POST).length);
    f.peakVideos = Math.max(f.peakVideos || 0, document.getElementsByTagName('video').length);
    const env = window.Env;
    stats.ghostOwl = { env: env && typeof env === 'object' ? GHOST_OWL_KEYS.filter(k => k in env) : [],
      hooked: JSON.parse === wrappedParse };
    checkBlank();
  }
  // A blank screen: no post, picture or video under three points down the
  // middle, on two checks in a row while you are not scrolling. Only counted.
  function checkBlank() {
    const searching = typeof search !== 'undefined' && search.open;
    if (!currentFeed().lastPageAt || touching || Date.now() - lastUserScroll < 800 || searching ||
        document.querySelector('[role="dialog"]')) {
      blankChecks = 0;
      return;
    }
    const blank = [0.3, 0.5, 0.7].every(y => !document.elementsFromPoint(innerWidth / 2, innerHeight * y)
      .some(el => el.tagName === 'ARTICLE' || el.tagName === 'IMG' || el.tagName === 'VIDEO'));
    if (!blank) blankChecks = 0;
    else if (++blankChecks === 2) stats.feed.blank = (stats.feed.blank || 0) + 1;
  }

  /* ------------------------------------------------------------------ *
   * Story ads that slip through: skip in the direction you were going.
   * Never closes the viewer.
   * ------------------------------------------------------------------ */
  let storyDirection = 'next';
  let storyAdSkipped = '';
  // B19: a Story's label arrives with the item, so each item is checked often
  // only at first, then once a second: mutations keep coming while it plays.
  let storyChecks = { path: '', n: 0, at: 0, last: 0 };
  function tidyStory() {
    if (route() !== 'story') return;
    const here = location.pathname;
    if (storyAdSkipped === here) return;
    const now = Date.now();
    if (storyChecks.path !== here) storyChecks = { path: here, n: 0, at: now, last: 0 };
    if (storyChecks.n >= 6 && now - storyChecks.at > 3000 && now - storyChecks.last < 1000) {
      // A change in between is still looked at, once, a moment later.
      if (!storyChecks.later) storyChecks.later = setTimeout(() => { storyChecks.later = 0; queueTidy(); }, 1000 - (now - storyChecks.last));
      return;
    }
    storyChecks.n++;
    storyChecks.last = now;
    let isAd = false;
    // Short leaf texts in the viewer (a section, or a dialog's spans); Home's feed underneath is skipped.
    const walker = walkOutsidePosts(NodeFilter.SHOW_ELEMENT, n => !n.firstElementChild && (n.tagName === 'SPAN' || n.tagName === 'DIV'));
    for (let el = walker.nextNode(); el; el = walker.nextNode()) {
      const t = norm(el);
      if (!t || t.length > 20 || !AD_LABEL.test(t)) continue;
      if (!el.closest('section') && !(el.tagName === 'SPAN' && el.closest('[role="dialog"]'))) continue;
      const r = el.getBoundingClientRect();
      if (r.top >= 0 && r.top < innerHeight * 0.2) { isAd = true; break; }
    }
    if (!isAd) return;
    storyAdSkipped = here;
    const label = storyDirection === 'back' ? /^(previous|go back|back)$/i : /^next$/i;
    for (const b of document.querySelectorAll('[aria-label]')) {
      if (label.test(b.getAttribute('aria-label') || '')) {
        const target = b.closest('button,[role="button"]') || b;
        stats.ads++;
        try { target.click(); } catch (e) { /* ignore */ }
        return;
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * Comments viewer child: trim it down to just the comments.
   * ------------------------------------------------------------------ */
  function tidyCommentsChild() {
    if (CFG.role !== 'comments') return;
    for (const a of document.querySelectorAll('a[href="/direct/inbox/"],a[href="/explore/"]')) {
      let el = a;
      for (let i = 0; i < 10 && el.parentElement && el.parentElement !== document.body; i++) {
        el = el.parentElement;
        // B20: never the comment box, even if it shares a fixed layer with the bar.
        if (el.querySelector('textarea')) break;
        const cs = getComputedStyle(el);
        if (cs.position === 'fixed' || cs.position === 'sticky') { hide(el, 'nav'); break; }
      }
    }
    for (const v of document.querySelectorAll('video')) {
      if (!v.paused) v.pause();
      v.muted = true;
    }
    for (const svg of document.querySelectorAll('svg[aria-label="Back"]')) {
      const b = svg.closest('a,button,[role="button"]') || svg;
      if (b.getBoundingClientRect().top < 80) hide(b, 'back');
    }
    safe(fitComposer)();
  }

  /* ------------------------------------------------------------------ *
   * B20: the comment box in the comments panel. Instagram's page keeps room
   * under it for its own bottom bar (hidden above: the main column's bottom
   * margin, or the box's bottom offset) and for the phone's navigation bar
   * (safe-area padding). The panel already sits clear of both, so that room
   * is an empty band. Take it away, keep the box one line high while
   * reading, and let it grow (as Instagram sizes it) only while typing.
   * Never hides the box; only bottom offsets, paddings and margins change.
   * ------------------------------------------------------------------ */
  const composer = { field: null, bar: null, sent: '', posts: 0, keep: 0 };
  function composerField() {
    for (const t of document.querySelectorAll('form textarea, textarea[aria-label], textarea[placeholder]')) {
      if (visibleBox(t)) return t;
    }
    return null;
  }
  // The row holding the box (avatar, field, Post): the highest ancestor still about its size.
  // Stops at a fixed or absolute row: its wrapper is an empty box elsewhere on the page.
  function composerBar(field) {
    const fr = field.getBoundingClientRect();
    const limit = Math.max(160, fr.height + 120);
    let bar = field.closest('form') || field.parentElement || field;
    for (let el = bar.parentElement; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      const pos = getComputedStyle(bar).position;
      if (pos === 'fixed' || pos === 'absolute') break;
      const r = el.getBoundingClientRect();
      if (r.bottom < fr.bottom - 1 || r.top > fr.top + 1 || r.height > limit || el.querySelectorAll('textarea').length > 1) break;
      bar = el;
    }
    return bar;
  }
  // What each changed element had inline before, so it can be put back exactly.
  const fitWas = new WeakMap();
  function setStyle(el, prop, value, kind) {
    const was = fitWas.get(el) || {};
    if (!(prop in was)) was[prop] = [el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)];
    fitWas.set(el, was);
    el.dataset.sgFit = Object.keys(was).join(' ');
    el.style.setProperty(prop, value, 'important');
    if (kind) bump(stats.comments.fixes, kind);
  }
  // Puts back one property setStyle changed.
  function unsetStyle(el, prop) {
    const was = fitWas.get(el);
    if (!was || !(prop in was)) return;
    if (was[prop][0]) el.style.setProperty(prop, was[prop][0], was[prop][1]);
    else el.style.removeProperty(prop);
    delete was[prop];
    if (Object.keys(was).length) el.dataset.sgFit = Object.keys(was).join(' ');
    else { fitWas.delete(el); delete el.dataset.sgFit; }
  }
  const fitRefused = new WeakSet();
  // Puts back everything fitComposer changed (the box ended up covered).
  function unfitComposer() {
    for (const el of document.querySelectorAll('[data-sg-fit]')) {
      const was = fitWas.get(el) || {};
      for (const prop of Object.keys(was)) {
        if (was[prop][0]) el.style.setProperty(prop, was[prop][0], was[prop][1]);
        else el.style.removeProperty(prop);
      }
      fitWas.delete(el);
      delete el.dataset.sgFit;
    }
    for (const el of document.querySelectorAll('[data-sg-hidden="spacer"]')) unhide(el);
  }
  // The box must stay where a finger can reach it: the middle of the field hits the box.
  // null: scrolled off screen, so it cannot be told this time.
  function composerPoint(field) {
    const r = field.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + Math.min(r.height / 2, 12);
    return y < 0 || y > innerHeight || x < 0 || x > innerWidth ? null : { x, y };
  }
  function composerReachable(field, bar) {
    const p = composerPoint(field);
    if (!p) return null;
    const hit = document.elementFromPoint(p.x, p.y);
    return !!hit && (hit === field || bar.contains(hit) || field.contains(hit));
  }
  // What covers the box is a fixed bar along the bottom (not a full-screen loading layer).
  function coveredByBottomBar(field) {
    const p = composerPoint(field);
    for (let el = p && document.elementFromPoint(p.x, p.y); el && el !== document.body; el = el.parentElement) {
      const pos = getComputedStyle(el).position;
      if (pos === 'fixed' || pos === 'sticky') return el.getBoundingClientRect().top > innerHeight * 0.5;
    }
    return false;
  }
  function px(v) { const n = parseFloat(v); return isFinite(n) ? n : 0; }
  // Where the element's content ends on screen (its own padding and border excluded).
  function contentEnd(el, cs) {
    const r = el.getBoundingClientRect();
    if (el.scrollHeight > el.clientHeight + 1 && /auto|scroll|hidden/.test(cs.overflowY)) {
      return r.top + el.clientTop - el.scrollTop + el.scrollHeight - px(cs.paddingBottom);
    }
    return r.bottom - px(cs.borderBottomWidth) - px(cs.paddingBottom);
  }
  function composerGap(bar) {
    const vh = window.visualViewport ? window.visualViewport.height : innerHeight;
    return Math.max(-999, Math.min(999, Math.round(vh - bar.getBoundingClientRect().bottom)));
  }
  function fitComposer() {
    // Only Instagram's comments page (the panel can go on to a profile or post).
    if (CFG.role !== 'comments' || route() !== 'comments') return;
    const field = composerField();
    if (!field) return;
    const c = stats.comments;
    const bar = composerBar(field);
    if (field !== composer.field) {
      composer.field = field;
      composer.blocked = false;
      composer.retries = 0;
      composer.kbSeen = false;
      field.dataset.sgComposer = '1';
      field.addEventListener('focus', safe(composerFocus));
      field.addEventListener('blur', safe(composerBlur));
      // A tap on the box while it has focus (keyboard put away with Back) opens it again.
      field.addEventListener('click', safe(() => { if (document.activeElement === field) field.dataset.sgOpen = '1'; }));
      if (document.activeElement === field) field.dataset.sgOpen = '1';
      c.boxes++;
    }
    composer.bar = bar;
    // One line: Instagram's line height plus the field's own padding and border.
    const fcs = getComputedStyle(field);
    const lh = px(fcs.lineHeight) || px(fcs.fontSize) * 1.3 || 18;
    const extra = fcs.boxSizing === 'border-box'
      ? px(fcs.paddingTop) + px(fcs.paddingBottom) + px(fcs.borderTopWidth) + px(fcs.borderBottomWidth) : 0;
    field.style.setProperty('--sg-one-line', Math.ceil(lh + extra) + 'px');
    noteViewport();
    if (c.gapBefore == null) c.gapBefore = composerGap(bar);
    if (composer.blocked) { c.gapAfter = composerGap(bar); reportComposer(); return; }
    applyFit(field, bar, true);
    // Checked on every pass, so a cover at load, a bar that comes later or a box
    // scrolled into view later is still caught. Under a bottom bar, or covered
    // with the fit but not without it: the fit did it, so put everything back
    // for good (a page that scrolls has its room back to scroll the box clear).
    // Covered both ways by a full-screen layer (loading): keep the fit and look
    // again shortly.
    if (document.querySelector('[data-sg-fit],[data-sg-hidden="spacer"]') && composerReachable(field, bar) === false) {
      const underBar = coveredByBottomBar(field);
      unfitComposer();
      if (underBar || composerReachable(field, bar) === true) {
        composer.blocked = true;
        c.reverted++;
      } else {
        applyFit(field, bar, false);
        if ((composer.retries = (composer.retries || 0) + 1) <= 40) setTimeout(queueTidy, 500);
      }
    }
    c.gapAfter = composerGap(bar);
    c.barH = Math.round(bar.getBoundingClientRect().height);
    c.fieldH = Math.round(field.getBoundingClientRect().height);
    reportComposer();
  }
  // Takes away the room under the box. count: false when re-applying (the stats count each change once).
  function applyFit(field, bar, count) {
    const c = stats.comments;
    const k = kind => (count ? kind : '');
    for (let el = field.parentElement; el; el = el.parentElement) {
      const cs = getComputedStyle(el);
      const inBar = el === bar || bar.contains(el);
      // A bottom offset that lifted the box above Instagram's bar.
      if ((cs.position === 'fixed' || cs.position === 'sticky') && px(cs.bottom) > 0.5 && px(cs.bottom) <= 200) {
        setStyle(el, 'bottom', '0px', k('offset'));
      }
      const pb = px(cs.paddingBottom), pt = px(cs.paddingTop);
      if (inBar) {
        // The row's own padding stays; only room added under it (safe area, the bar's height) goes.
        if (pb - pt > 6) setStyle(el, 'padding-bottom', pt + 'px', k('padding'));
      } else if (pb > 0.5 && Math.abs(contentEnd(el, cs) - bar.getBoundingClientRect().bottom) <= 2) {
        setStyle(el, 'padding-bottom', '0px', k('padding'));
      }
      // A margin under something that ends with the box is only empty space.
      if ((el === bar || !inBar) && px(cs.marginBottom) > 0.5 &&
          Math.abs(el.getBoundingClientRect().bottom - bar.getBoundingClientRect().bottom) <= 2) {
        setStyle(el, 'margin-bottom', '0px', k('margin'));
      }
      // Instagram's main column is capped at the page less its bar
      // (max-height: calc(100% - bar height)) even with the bar hidden. Lift the
      // cap only if the box then ends lower and still on screen (a column that
      // scrolls with the page would grow to its content and push the box away).
      if (!inBar && !fitRefused.has(el) && cs.maxHeight !== 'none' && !('max-height' in (fitWas.get(el) || {})) &&
          Math.abs(el.getBoundingClientRect().bottom - bar.getBoundingClientRect().bottom) <= 2) {
        const was = bar.getBoundingClientRect().bottom;
        // 100%, not none: still capped, so a column that would grow to its content stays put.
        setStyle(el, 'max-height', '100%', '');
        const now = bar.getBoundingClientRect().bottom;
        const vh = window.visualViewport ? window.visualViewport.height : innerHeight;
        if (now > was + 0.5 && now <= vh + 1) { if (count) bump(c.fixes, 'maxHeight'); }
        else { unsetStyle(el, 'max-height'); fitRefused.add(el); }
      }
      // An empty block kept below the box (a stand-in for the bar).
      if (el === bar || !inBar) {
        for (let s = el.nextElementSibling; s; s = s.nextElementSibling) {
          if (s.dataset.sgHidden || !isSpacer(s, bar)) continue;
          if (hide(s, 'spacer') && count) bump(c.fixes, 'spacer');
        }
      }
      if (el === document.documentElement) break;
    }
  }
  function isSpacer(s, bar) {
    if (s.tagName === 'SCRIPT' || s.tagName === 'STYLE' || s.contains(bar)) return false;
    const cs = getComputedStyle(s);
    if (cs.position === 'absolute' || cs.position === 'fixed' || cs.display === 'none') return false;
    const r = s.getBoundingClientRect();
    if (!(r.height > 0 && r.height <= 150) || r.top < bar.getBoundingClientRect().bottom - 1) return false;
    return !(s.textContent || '').trim() && !s.querySelector('img,video,svg,canvas,input,textarea,button,a,[role="button"],iframe');
  }
  // The panel's tallest height at this width: well short of it means the keyboard is up.
  function noteViewport() {
    const h = window.visualViewport ? window.visualViewport.height : innerHeight;
    if (innerWidth !== composer.vvW) { composer.vvW = innerWidth; composer.vvMax = 0; }
    composer.vvMax = Math.max(composer.vvMax || 0, h);
    return h;
  }
  // Back puts the keyboard away without leaving the box: shrink it to one line
  // then too (the draft stays), and open it again when the keyboard comes back.
  // Only after the keyboard was seen during this focus: a hardware keyboard
  // never shrinks the panel, so the box stays open there.
  function composerKeyboard() {
    const f = composer.field;
    const h = noteViewport();
    if (!f || document.activeElement !== f || !composer.vvMax) return;
    if (h < 0.85 * composer.vvMax) {
      composer.kbSeen = true;
      f.dataset.sgOpen = '1';
    } else if (composer.kbSeen && h >= 0.9 * composer.vvMax) {
      composer.kbSeen = false;
      delete f.dataset.sgOpen;
    }
  }
  function composerFocus() {
    composer.kbSeen = false;
    clearTimeout(composer.closing);
    if (composer.field) composer.field.dataset.sgOpen = '1';
    stats.comments.opened++;
    // The keyboard is coming: the panel shrinks, then the box is brought into view.
    composer.keep = Date.now() + 1500;
    setTimeout(safe(keepComposerInView), 350);
  }
  function composerBlur() {
    const f = composer.field;
    composer.kbSeen = false;
    // A moment later, so a tap on Post lands before the box shrinks under the finger.
    clearTimeout(composer.closing);
    composer.closing = setTimeout(safe(() => {
      if (f && document.activeElement !== f) delete f.dataset.sgOpen;
    }), 400);
  }
  function keepComposerInView() {
    const f = composer.field, bar = composer.bar;
    if (!f || !bar || document.activeElement !== f || !bar.isConnected) return;
    const vv = window.visualViewport;
    const top = vv ? vv.offsetTop : 0, bottom = top + (vv ? vv.height : innerHeight);
    const r = bar.getBoundingClientRect();
    if (r.bottom > bottom + 1 || r.top < top - 1) {
      try { bar.scrollIntoView({ block: 'end', inline: 'nearest' }); } catch (e) { /* old engine */ }
      stats.comments.scrolled++;
    }
  }
  // Shapes only (pixel sizes and counts), for the app's Filter status.
  function reportComposer() {
    const c = stats.comments;
    const shape = { boxes: c.boxes, gapBefore: c.gapBefore, gapAfter: c.gapAfter, barH: c.barH, fieldH: c.fieldH,
      fixes: Object.assign({}, c.fixes), opened: c.opened, scrolled: c.scrolled, reverted: c.reverted };
    const key = JSON.stringify(shape);
    if (key === composer.sent || composer.posts >= 30) return;
    composer.sent = key;
    composer.posts++;
    post('commentsLayout', shape);
  }
  if (CFG.role === 'comments') {
    // The keyboard opening or closing resizes the panel's page.
    const resized = safe(() => {
      composerKeyboard();
      if (Date.now() < composer.keep || (composer.field && document.activeElement === composer.field)) keepComposerInView();
      queueTidy();
    });
    window.addEventListener('resize', resized);
    try { if (window.visualViewport) window.visualViewport.addEventListener('resize', resized); } catch (e) { /* no visual viewport */ }
    // A box at the end of a page that scrolls is checked when it comes into view
    // (queueTidy runs at most every 300ms).
    window.addEventListener('scroll', safe(() => { if (composer.field) queueTidy(); }), { passive: true });
  }

  let tidyQueued = false;
  function tidyNow() {
    tidyQueued = false;
    if (!document.body) return;
    addStyle();
    safe(tidyReelsTab)();
    safe(tidyStars)();
    // B19: not in Stories: the scan walks every text on the page (Home's feed
    // stays mounted underneath), and Instagram shows no app banner there.
    if (route() !== 'story' && Date.now() - lastBannerScan > 1000) { lastBannerScan = Date.now(); safe(tidyBanners)(); }
    safe(tidyFeed)();
    safe(tidyExplore)();
    safe(tidyStory)();
    safe(tidyCommentsChild)();
    safe(autoplay)();
  }
  let lastTidy = 0, lastBannerScan = 0;
  function queueTidy() {
    if (tidyQueued) return;
    tidyQueued = true;
    const wait = Math.max(0, 300 - (Date.now() - lastTidy));
    setTimeout(() => { lastTidy = Date.now(); requestAnimationFrame(tidyNow); }, wait);
  }

  /* ------------------------------------------------------------------ *
   * Navigation: hook Instagram's single-page router.
   * ------------------------------------------------------------------ */
  const savedScroll = new Map();
  function scrollableAncestors() {
    const out = [];
    for (const el of document.querySelectorAll('main, main div, section > div')) {
      if (el.scrollTop > 0 && el.scrollHeight > el.clientHeight + 10) out.push(el);
      if (out.length > 4) break;
    }
    return out;
  }
  function pathOf(el) {
    const parts = [];
    while (el && el !== document.body && parts.length < 30) {
      const p = el.parentElement;
      if (!p) return null;
      parts.unshift(Array.prototype.indexOf.call(p.children, el));
      el = p;
    }
    return parts;
  }
  function byPath(parts) {
    let el = document.body;
    for (const i of parts || []) { el = el && el.children[i]; }
    return el || null;
  }
  function rememberScroll() {
    const r = route();
    if (r !== 'search' && r !== 'explore' && r !== 'other') return;
    const key = location.pathname + location.search;
    savedScroll.set(key, {
      doc: (document.scrollingElement || document.documentElement).scrollTop,
      inner: scrollableAncestors().map(el => ({ path: pathOf(el), top: el.scrollTop })),
    });
    cap(savedScroll, 30);
  }
  let restoreTimer = 0;
  function restoreScroll() {
    clearInterval(restoreTimer);
    const key = location.pathname + location.search;
    const saved = savedScroll.get(key);
    if (!saved) return;
    let tries = 0, settled = 0, cancelled = false;
    const cancel = () => { cancelled = true; };
    window.addEventListener('touchstart', cancel, { once: true, capture: true, passive: true });
    restoreTimer = setInterval(safe(() => {
      if (cancelled || ++tries > 50 || location.pathname + location.search !== key) { clearInterval(restoreTimer); return; }
      const se = document.scrollingElement || document.documentElement;
      let ok = true;
      if (saved.doc > 0) {
        if (Math.abs(se.scrollTop - saved.doc) > 2) {
          se.scrollTop = saved.doc;
          ok = Math.abs(se.scrollTop - saved.doc) <= 2;
        }
      }
      for (const s of saved.inner) {
        const el = byPath(s.path);
        if (!el) { ok = false; continue; }
        if (Math.abs(el.scrollTop - s.top) > 2) { el.scrollTop = s.top; ok = ok && Math.abs(el.scrollTop - s.top) <= 2; }
      }
      settled = ok ? settled + 1 : 0;
      if (settled >= 3) clearInterval(restoreTimer);
    }), 100);
  }

  // The feed this page last showed. Switching feeds inside the page
  // (Instagram's logo menu, Back over its own entries) loads the new feed as
  // a fresh page: Instagram's empty-feed screen and its stored, already
  // filtered copy of a feed never follow you. Once per page, and never again
  // within 2 s of the last one.
  const SWITCH_KEY = 'sg_switch';
  let shownFeed = route() === 'home' ? feedVariant() : null, switched = false;
  function switchFeed() {
    if (route() !== 'home') return false;
    const v = feedVariant(), from = shownFeed;
    shownFeed = v;
    if (!from || v === from || leaving) return false;
    const saved = readSession(SWITCH_KEY) || {};
    if (switched || Date.now() - (Number(saved.at) || 0) < 2000) {
      bump(stats.feed, 'switchHeld');
      pushTrail({ ev: 'switchHeld', from: from, to: v });
      return false;
    }
    switched = true;
    const n = (saved.n | 0) + 1;
    writeSession(SWITCH_KEY, { at: Date.now(), n: n });
    stats.feed.switchLoads = n;
    pushTrail({ ev: 'switch', from: from, to: v });
    location.replace(location.href);
    return true;
  }
  // Leaving the page opened from the end card for another feed ends its skip;
  // opening a post or Stories from it and coming back does not (same list).
  function feedRouteChanged(previous) {
    const now = route();
    if ((previous === 'home') !== (now === 'home')) homeEvent({ e: 'route', to: now === 'home' ? 'home' : now });
    lastTop = 0;
    if (skip && now === 'home' && here() !== skip.path) forgetSkip('skipLeft');
    // Back on the feed from a Story or post: the room and the nudges that
    // keep trying come back (their timers end while you are away).
    const back = now === 'home' && previous !== 'home';
    if (back) contResume();
    if (skipping()) {
      const fs = currentFeed();
      syncRoom(fs, !fs.ended);
      if (back && keepsTrying(fs)) scheduleNudge(true);
      skipProgress(fs);
    } else {
      if (skip && skip.status) { clearTimeout(skip.statusTimer); skip.statusTimer = 0; skip.status = ''; post('skipStatus', { on: false, kind: '', n: 0 }); }
      const fs = currentFeed();
      if (back && roomWanted(fs, !fs.ended)) { syncRoom(fs, true); if (keepsTrying(fs)) scheduleNudge(true); }
      if (!(now === 'home' && roomWanted(fs, !fs.ended))) dropRoom();
    }
  }

  // A feed that kept posts but draws none, or shows Instagram's empty-feed
  // screen although SimpleGram handed it something: one reload, at most once
  // per address per app session, and only once posts have been drawn in this
  // session (if Instagram changes its markup, this stays quiet, never loops).
  // Never while the app's end card or Instagram's own "caught up" line is
  // what the feed shows. "Kept but none drawn" needs a page newer than the
  // last posts drawn in this page load and 10 s without any: Instagram's
  // refresh shows a placeholder until its new page lands, and its list can
  // mount seconds after the first page on a slow phone.
  const RECOVER_KEY = 'sg_feed_recover', DRAWN_KEY = 'sg_posts_drawn', DRAW_GRACE = 10000;
  let notDrawn = 0, recoverHeldNoted = false, postsDrawnOnce = !!readSession(DRAWN_KEY), lastDrawnAt = 0;
  function checkNotDrawn() {
    if (CFG.role !== 'main') return;
    if (document.querySelector(POST)) {
      notDrawn = 0;
      lastDrawnAt = Date.now();
      if (!postsDrawnOnce) { postsDrawnOnce = true; writeSession(DRAWN_KEY, 1); }
      return;
    }
    const fs = currentFeed();
    if (route() !== 'home' || document.hidden || search.open || leaving || document.querySelector('[role="dialog"]') ||
        !postsDrawnOnce || feedEndShown || (fs.anchorKind === 'marker' && fs.shownCount === 0)) { notDrawn = 0; return; }
    const stale = fs.shownCount > 0 && fs.lastPageAt > 0 && fs.lastPageAt >= lastDrawnAt && Date.now() - fs.lastPageAt > DRAW_GRACE;
    const emptyScreen = fs.handed > 0 && (!!document.querySelector(STAR_NULL) || followButtons(document.querySelector('main'), 3) >= 3);
    if (!stale && !emptyScreen) { notDrawn = 0; return; }
    if (++notDrawn < 2) return;
    notDrawn = 0;
    const saved = readSession(RECOVER_KEY) || {};
    const paths = Array.isArray(saved.paths) ? saved.paths : [];
    if (paths.indexOf(here()) >= 0) {
      if (!recoverHeldNoted) { recoverHeldNoted = true; bump(stats.feed, 'recoverHeld'); pushTrail({ ev: 'recoverHeld' }); }
      return;
    }
    paths.push(here());
    const n = (saved.n | 0) + 1;
    writeSession(RECOVER_KEY, { paths: paths.slice(-20), n: n });
    stats.feed.recovered = n;
    pushTrail({ ev: 'recover', why: stale ? 'notDrawn' : 'emptyScreen' });
    // The page opened from the end card keeps its one-time skip across the reload.
    if (skipping()) {
      try {
        sessionStorage.setItem(SKIP_KEY, JSON.stringify({ variant: skip.variant, codes: Array.from(skip.codes), at: Date.now() }));
      } catch (e) { /* storage unavailable: no skipping */ }
    }
    location.reload();
  }
  SG.checkNotDrawn = () => safe(checkNotDrawn)();
  {
    // Counted across this session's page loads (each switch or recovery is one).
    const sw = readSession(SWITCH_KEY), rc = readSession(RECOVER_KEY);
    if (sw && sw.n > 0) stats.feed.switchLoads = sw.n | 0;
    if (rc && rc.n > 0) stats.feed.recovered = rc.n | 0;
  }

  let lastUrl = location.href;
  function routeChanged() {
    if (location.href === lastUrl) return;
    const previous = route(new URL(lastUrl).pathname);
    lastUrl = location.href;
    post('route', { url: location.href, route: route() });
    safe(markFeed)();
    // Back from Stories or messages: the observer skipped the bar there.
    if (previous === 'story' || previous === 'direct') rowFlagged = true;
    if (CFG.role === 'main' && stars.size && !noStarHere()) armGeo();
    safe(syncSwipeGuard)();
    safe(noteStoryUrl)();
    if (CFG.role === 'main' && route() === 'reels-tab') {
      // The endless Reels tab is not part of SimpleGram.
      location.replace('/');
      return;
    }
    if (CFG.role === 'main' && safe(switchFeed)()) return;
    if (CFG.role === 'main') safe(feedRouteChanged)(previous);
    if (CFG.role === 'main') {
      // Opening a result keeps search up until the new page is drawn; coming
      // back to the marked entry keeps it up too.
      const backToSearch = !!(history.state && history.state.sgSearch && history.state.sgSearch === search.token);
      if (leaving) safe(leavingRouteChanged)();
      else if (calledOff && safe(lateArrival)()) { /* undone unseen */ }
      else if (search.open && !backToSearch) { hideSearch(false); search.suspended = false; clearSaved(); }
      restoreSearch();
      if (route() === 'explore' && !search.open && !search.suspended) openSearch(true);
      atBottomSince = 0;
      safe(checkFeedEnd)(true);
    }
    if (CFG.role === 'main' && route() === 'story' && previous !== 'story') safe(storyOpened)();
    if (CFG.role === 'main' && route() === 'comments' && previous !== 'comments' && !split) {
      // Instagram opened its full-page comments by itself; show them in the
      // half-screen panel instead and put the post back.
      const code = codeFromPath();
      if (code) {
        setTimeout(() => history.back(), 0);
        setTimeout(safe(() => openComments(code, null)), 400);
      }
    }
    queueTidy();
  }
  const nativePush = history.pushState;
  const nativeReplace = history.replaceState;
  // Diagnostics: Instagram writing the same Home address again (a refresh
  // of the feed by navigation leaves exactly this).
  function noteSameAddress(before, kind) {
    if (location.href === before && route() === 'home') homeEvent({ e: 'hist', k: kind });
  }
  history.pushState = function pushState() {
    safe(rememberScroll)();
    const before = location.href;
    const out = nativePush.apply(this, arguments);
    safe(noteHistoryWrite)();
    safe(noteSameAddress)(before, 'push');
    safe(routeChanged)();
    return out;
  };
  history.replaceState = function replaceState() {
    const before = location.href;
    const out = nativeReplace.apply(this, arguments);
    safe(noteHistoryWrite)();
    safe(noteSameAddress)(before, 'replace');
    safe(routeChanged)();
    return out;
  };
  // Back to the same address (after a same-page result) changes no URL, so
  // routeChanged() doesn't run: bring search back here too.
  window.addEventListener('popstate', safe(() => { routeChanged(); if (!syntheticPop) { restoreScroll(); safe(restoreSearch)(); } }));

  /* ------------------------------------------------------------------ *
   * No endless Reels: vertical swipes cannot move a Reel viewer on to
   * the next Reel. You go back and pick the next one yourself.
   * ------------------------------------------------------------------ */
  function snapScroller(start) {
    let el = start instanceof Element ? start : null;
    for (let i = 0; el && i < 25; i++, el = el.parentElement) {
      if (el === document.body || el === document.documentElement) return null;
      const cs = getComputedStyle(el);
      if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 20) {
        return /(^|\s)(y|both|block)(\s|$)/.test(cs.scrollSnapType) ? el : null;
      }
    }
    return null;
  }
  let swipe = null;
  const guardMove = safe(e => {
    fullVideoMove(e);
    if (!swipe || e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - swipe.x, dy = t.clientY - swipe.y;
    if (swipe.vertical === null && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) swipe.vertical = Math.abs(dy) > Math.abs(dx);
    if (swipe.vertical) {
      sgPrevent(e);
      e.stopPropagation();
    }
  });
  // A blocking touch listener makes every scroll wait for the page, so it is
  // registered only where a Reel viewer can be: never on Home, DMs or Stories.
  // R8's swipe uses the same one (posts and Reels are guarded pages).
  let guardOn = false;
  function syncSwipeGuard() {
    const r = route();
    const want = CFG.role === 'main' && r !== 'home' && r !== 'direct' && r !== 'story';
    if (want === guardOn) return;
    guardOn = want;
    if (want) window.addEventListener('touchmove', guardMove, { capture: true, passive: false });
    else { window.removeEventListener('touchmove', guardMove, true); swipe = null; }
  }
  syncSwipeGuard();
  window.addEventListener('touchstart', safe(e => {
    swipe = null;
    if (!guardOn || e.touches.length !== 1) return;
    const r = route();
    if (r === 'home' || r === 'direct' || r === 'story') return;
    // Only a vertically snapping viewer (one Reel per screen) is guarded;
    // ordinary lists such as Share or comments scroll normally.
    const sc = snapScroller(e.target);
    if (sc) swipe = { sc: sc, x: e.touches[0].clientX, y: e.touches[0].clientY, top: sc.scrollTop, vertical: null };
  }), { capture: true, passive: true });
  window.addEventListener('touchcancel', safe(() => { swipe = null; }), { capture: true, passive: true });
  window.addEventListener('touchend', safe(() => {
    if (swipe && swipe.vertical) {
      stats.swipesBlocked++;
      const s = swipe;
      requestAnimationFrame(() => { if (Math.abs(s.sc.scrollTop - s.top) > 2) s.sc.scrollTop = s.top; });
    }
    swipe = null;
  }), { capture: true, passive: true });

  /* ------------------------------------------------------------------ *
   * Full-screen video.
   * R8: in an opened post or Reel, a swipe down that starts on the video
   * while the page is at the top asks the browser to show that video full
   * screen (the app's full-screen view: just the video, no bars). A swipe up
   * never does, so reading a long description is safe. In full screen a
   * swipe up or down (or Back) returns; a tap pauses or plays.
   * R9: in Stories, a swipe up on a Story that shares a Reel plays the Reel
   * over the whole screen. Instagram's Story stays pressed (its own pause)
   * underneath and continues where it was. A swipe up or down (or Back)
   * returns. No second full-screen request is made: Instagram ends the Story
   * when its own full screen ends.
   * ------------------------------------------------------------------ */
  const FV_SWIPE = 60;                 // px of mostly vertical travel
  const fvStats = { r8: 0, r9: 0, exits: 0, r8Failed: 0, r9Missing: 0, r9Moved: 0, r9Pressed: 0 };
  let gesture = null;                  // the current one-finger touch
  let storyPress = null;               // a touch Instagram's Story saw start
  let appHeld = false;                 // the app is holding a finger on the page (appHold)
  let r8El = null, r8On = false;
  // B25: an R8 request on its way (a late exit event must not lose track of it),
  // and an exit asked of the app that hasn't landed yet.
  let r8Pending = false, r8PendingAt = 0, r8ExitAt = 0;
  const R8_STALE_MS = 400;             // a swipe's lift handled this late switches nothing
  // B25 counts (shapes only): r8Race, a late exit event while a request was on its
  // way; r8Settling, touches that started nothing while a switch settled; r8Adopted,
  // video full screens R8 didn't ask for and took over; r8Stale, lifts handled too
  // late; exitAsked/exitFallback, exits the app made the Back way / the page made.
  const fsCounts = { r8Race: 0, r8Settling: 0, r8Adopted: 0, r8Stale: 0, exitAsked: 0, exitFallback: 0 };
  const fsPageLog = [];                // the last fullscreenchange events
  const downIds = new Set();           // touch identifiers the page saw go down and not up
  let lastTouchEndAt = 0, lastFsChangeAt = 0;
  let reelBox = null;                  // R9's Reel layer
  function searchOpen() { return typeof search !== 'undefined' && !!search.open; }
  function isField(el) {
    return !!(el && el.closest && el.closest('input,textarea,[contenteditable="true"],[contenteditable=""]'));
  }
  // The video under a point (a carousel's visible slide: the others are off to the side).
  function videoAt(x, y) {
    let best = null, area = 0;
    for (const v of document.getElementsByTagName('video')) {
      if (v.dataset.sgOwn) continue;
      const r = v.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      const a = onScreenArea(v);
      if (a > area && a > 90 * 90 && !v.closest('[data-sg-hidden]')) { best = v; area = a; }
    }
    return best;
  }
  // The page and every list holding the video are scrolled to the top. A Reel
  // viewer's snapping list doesn't count: the swipe guard pins it in place.
  function atTop(v) {
    const se = document.scrollingElement || document.documentElement;
    if (se.scrollTop > 2) return false;
    for (let el = v.parentElement, i = 0; el && el !== document.body && i < 40; el = el.parentElement, i++) {
      if (el.scrollTop <= 2) continue;
      const cs = getComputedStyle(el);
      if (/auto|scroll/.test(cs.overflowY) && !/(^|\s)(y|both|block)(\s|$)/.test(cs.scrollSnapType)) return false;
    }
    return true;
  }
  // The touch is on the video's own media box (the video or Instagram's tap
  // layer beside it), not on a sheet, dialog or other list drawn over it.
  // The box is the video's ancestors no taller than the video (give or take
  // its margins) or the screen (a letterboxed Reel), so how deep Instagram
  // nests it doesn't matter; a sheet drawn elsewhere in the page is outside.
  function ownTouch(v, target) {
    if (!target || !target.closest) return false;
    const dlg = target.closest('[role="dialog"],[aria-modal="true"]');
    if (dlg && !dlg.contains(v)) return false;
    const vh = v.getBoundingClientRect().height;
    const tallest = Math.max(vh + Math.max(96, vh * 0.3), innerHeight + 2);
    let box = null;
    for (let el = v.parentElement, i = 0; el && el !== document.body && i < 12; el = el.parentElement, i++) {
      if (el.getBoundingClientRect().height > tallest) break;
      if (el.contains(target)) { box = el; break; }
    }
    if (!box) return false;
    // A list inside the box that is scrolled scrolls back first.
    for (let el = target; el && el !== box; el = el.parentElement) {
      if (el.scrollTop > 2 && /auto|scroll/.test(getComputedStyle(el).overflowY)) return false;
    }
    return true;
  }
  function togglePlay(v) {
    if (v.paused) { const p = v.play(); if (p && p.catch) p.catch(() => {}); } else v.pause();
  }

  window.addEventListener('touchstart', safe(e => {
    gesture = null;
    if (CFG.role !== 'main' || !e.isTrusted) return;
    if (e.touches.length !== 1) return;
    if (reelBox && reelBox.box.contains(e.target)) return;    // the Reel layer has its own
    const t = e.touches[0];
    const g = { x: t.clientX, y: t.clientY, at: Date.now(), target: e.target };
    const r = route();
    const fs = document.fullscreenElement;
    // B25: while a full-screen switch settles, this touch starts none: a quick
    // second swipe would otherwise switch again under the finger, or land in a
    // full screen R8 has lost track of.
    if (fullScreenSettling()) { fsCounts.r8Settling++; return; }
    if (r8On && fs && fs === r8El) g.exit = true;
    else if ((r === 'post' || r === 'reel') && !fs && !searchOpen()) {
      const v = videoAt(g.x, g.y);
      if (v && ownTouch(v, e.target) && atTop(v)) { g.video = v; g.r8 = 'pending'; }
    } else if (r === 'story' && !reelBox) {
      g.story = true;
      storyPress = { target: e.target, x: g.x, y: g.y };
    }
    gesture = g;
  }), { capture: true, passive: true });

  // From the swipe guard's blocking listener (posts and Reels only). The page
  // is held still only while an R8 swipe is armed: a downward swipe at the top
  // (nothing to scroll anyway), or any swipe on the full-screen video.
  function fullVideoMove(e) {
    const g = gesture;
    if (!g || (!g.r8 && !g.exit)) return;
    if (e.touches.length !== 1) { g.r8 = null; g.exit = false; return; }
    if (g.exit) { sgPrevent(e); return; }
    const t = e.touches[0], dx = t.clientX - g.x, dy = t.clientY - g.y;
    if (g.r8 === 'pending') {
      if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      // Sideways (a carousel) or up (reading on) is left alone for the whole touch.
      g.r8 = dy > 0 && dy >= Math.abs(dx) ? 'armed' : null;
    }
    if (g.r8 === 'armed') sgPrevent(e);
  }

  window.addEventListener('touchend', safe(e => {
    const g = gesture;
    gesture = null;
    if (!g || !e.isTrusted || e.touches.length || !e.changedTouches.length) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - g.x, dy = t.clientY - g.y, ms = Date.now() - g.at;
    const vertical = Math.abs(dy) >= FV_SWIPE && Math.abs(dx) < Math.abs(dy) * 0.6;
    // B25: a lift handled long after it happened (a busy page) switches nothing;
    // the next finger may already be down. Swipe again once the page has caught up.
    if ((g.exit || g.r8 === 'armed') && vertical && staleTouch(e)) { fsCounts.r8Stale++; return; }
    if (g.exit) { if (vertical) exitFullVideo('swipe'); return; }
    if (g.r8 === 'armed') { if (vertical && dy > 0 && ms < 1500) enterR8(g.video); return; }
    if (!g.story || route() !== 'story') return;
    storyPress = null;                                         // Instagram sees this end
    if (vertical && dy < 0 && ms < 1000 && !isField(g.target)) {
      const reel = sharedReelHere();
      // Instagram's own swipe up opens the reply box; it never sees this one,
      // so its Story stays pressed (paused) under the Reel.
      if (reel && openStoryReel(reel, g)) {
        // B25's own listener never sees this lift: count it here, or the next touch reads as a lost end.
        noteTouchLift(e, false);
        dseq = null;
        e.stopImmediatePropagation();
        return;
      }
    }
    // Instagram's own thresholds for a swipe to the next or previous person.
    if (Math.abs(dx) > 50 && Math.abs(dy) < 100 && ms <= 500) storySwitchStart(dx > 0 ? 'back' : 'next');
  }), { capture: true, passive: true });

  // Instagram's Story listens for touchend only. A cancelled touch (a pinch
  // that didn't zoom, a system gesture) left the Story paused and its next
  // swipe measured from the old touch, so it was ignored. Let go of it the way
  // a lifted finger would.
  // Not while the app holds the Story (its menu, screenshot mode, a zoom):
  // WebView cancels that touch as soon as a dialog or the notification shade
  // takes focus, so the cancel comes when the hold starts. The Story stays
  // pressed until the app lets go (appHold off).
  window.addEventListener('touchcancel', safe(e => {
    gesture = null;
    if (appHeld) return;
    const p = storyPress;
    storyPress = null;
    if (!e.isTrusted || !p || reelBox || route() !== 'story') return;
    if (releaseStoryPress(p)) stats.diag.storyCancels++;
  }), { capture: true, passive: true });
  // From the app: on before its hold presses the page, off once it has let go.
  function appHold(on) {
    appHeld = on;
    if (on) return;
    const p = storyPress;
    storyPress = null;
    if (!p || reelBox || route() !== 'story') return;
    if (releaseStoryPress(p)) stats.diag.storyCancels++;
  }
  function releaseStoryPress(p) {
    const el = p && p.target;
    if (!el || !el.isConnected || typeof Touch !== 'function' || typeof TouchEvent !== 'function') return false;
    try {
      const t = new Touch({ identifier: 9001, target: el, clientX: p.x, clientY: p.y });
      el.dispatchEvent(new TouchEvent('touchend', { touches: [], targetTouches: [], changedTouches: [t], bubbles: true, cancelable: true, composed: true }));
      return true;
    } catch (e) { return false; }
  }

  // R8 in full screen: Instagram's tap layer isn't shown, so a tap pauses or plays.
  window.addEventListener('click', safe(e => {
    const fs = document.fullscreenElement;
    if (!r8On || !fs || fs !== r8El || !e.isTrusted) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    togglePlay(fs);
  }), true);

  /* B25 touch rules for full screen (R8 now; R10's tap and R11's bar build on
   * them): leaveFullScreen is the one way out; nothing starts while a switch
   * settles (fullScreenSettling); a lift handled too late switches nothing
   * (staleTouch); SimpleGram's own surfaces hold still with holdStill/sgPrevent. */

  // A full-screen switch R8 asked for or was told of hasn't landed yet. Each
  // wait has a limit, so a request that never answers can't block R8 for good.
  function fullScreenSettling() {
    if (r8Pending && performance.now() - r8PendingAt > 3000) r8Pending = false;
    if (r8ExitAt && Date.now() - r8ExitAt > 1500) r8ExitAt = 0;
    const fs = document.fullscreenElement;
    return r8Pending || (r8On && !fs) || (!!r8ExitAt && !!fs);
  }
  // The event's own time (when the finger lifted) is far behind now.
  function staleTouch(e) {
    const lag = performance.now() - e.timeStamp;
    return lag > R8_STALE_MS && lag < 60000;
  }
  // The one way SimpleGram leaves a full screen it is in. The app does it as Back
  // does, its full-screen view first and then the browser, so a finger already
  // down for the next swipe is never split between two views (B25). The page
  // leaves full screen itself only when there is no app to ask (a browser).
  function leaveFullScreen(why) {
    if (!document.fullscreenElement) return false;
    r8ExitAt = Date.now();             // before asking: the app may be done before post() returns
    if (post('fullVideoExitRequest', { why: /^[a-z]{1,12}$/.test(why) ? why : 'other' })) {
      fsCounts.exitAsked++;
      return true;
    }
    r8ExitAt = 0;
    fsCounts.exitFallback++;
    try {
      const p = document.exitFullscreen();
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* already out */ }
    return true;
  }
  SG.leaveFullScreen = leaveFullScreen;

  function enterR8(v) {
    if (!v || !v.isConnected || document.fullscreenElement || fullScreenSettling()) return;
    const req = v.requestFullscreen || v.webkitRequestFullscreen;
    if (typeof req !== 'function') { fvStats.r8Failed++; return; }
    const fail = () => {
      fvStats.r8Failed++;
      if (r8El === v) r8Pending = false;
      if (r8El === v && !r8On) { r8El = null; delete v.dataset.sgFull; }
    };
    r8El = v;
    r8Pending = true;
    r8PendingAt = performance.now();
    v.dataset.sgFull = '1';
    let p;
    try { p = req.call(v, { navigationUI: 'hide' }); } catch (err) { fail(); return; }
    if (p && typeof p.then === 'function') {
      p.then(() => { if (r8El === v && document.fullscreenElement === v) r8Pending = false; },
        () => { if (document.fullscreenElement !== v) fail(); });
    }
  }
  function exitFullVideo(why) {
    if (reelBox) { closeStoryReel(why); return; }
    if (!r8On || document.fullscreenElement !== r8El) return;
    leaveFullScreen(why);
  }
  document.addEventListener('fullscreenchange', safe(() => {
    const el = document.fullscreenElement;
    let via = 'other';
    if (r8El && el === r8El) {
      via = 'r8';
      r8Pending = false;
      if (!r8On) {
        r8On = true;
        fvStats.r8++;
        // A landscape video small in the post played muted; full screen is
        // the sound rule's "opened video". Checked once the layout settles.
        const v = r8El;
        setTimeout(safe(() => {
          if (document.fullscreenElement === v && v.muted && !userMuted && !v.paused && wantsSound(v)) unmute(v);
        }), 150);
      }
    } else if (el && el.tagName === 'VIDEO' && !el.dataset.sgOwn && !r8Pending && CFG.role === 'main' &&
      (route() === 'post' || route() === 'reel')) {
      // B25: a video full screen R8 isn't tracking (Instagram's own player, or a
      // request that landed after R8 lost track of it) is taken over, so a swipe
      // leaves it the safe way and the browser's controls stay hidden.
      if (r8El && r8El !== el) delete r8El.dataset.sgFull;
      r8El = el;
      r8On = true;
      el.dataset.sgFull = '1';
      fsCounts.r8Adopted++;
      via = 'r8-adopted';
    } else if (r8On || r8El) {
      if (r8On) fvStats.exits++;
      r8On = false;
      if (r8Pending && !el) {
        // B25: an exit from before, arriving while the next request is on its
        // way. That request stays tracked (it used to land untracked).
        fsCounts.r8Race++;
        via = 'r8-race';
      } else {
        via = 'r8';
        r8Pending = false;
        if (r8El) delete r8El.dataset.sgFull;
        r8El = null;
      }
    }
    if (!el) r8ExitAt = 0;
    noteFsPage(el, via);
    // The full screen R9's layer lived in ended: Instagram is closing the Story.
    if (reelBox && reelBox.inFull && (!el || !el.contains(reelBox.box))) closeStoryReel('ended');
  }));

  function sharedReelHere() {
    const pk = storyPk();
    return pk ? sharedReels.get(pk) || null : null;
  }
  // Returns false (and changes nothing) when the layer can't be shown.
  function openStoryReel(reel, g) {
    if (reelBox) return false;
    const fs = document.fullscreenElement;
    // Instagram's Story is full screen on the phone (its own request, on
    // <body>): the layer goes inside that, on top of the Story.
    const host = fs ? (/^(VIDEO|IMG|IFRAME|CANVAS|svg)$/i.test(fs.tagName) ? null : fs) : document.body;
    if (!host) return false;
    const box = document.createElement('div');
    box.id = 'sg-reel';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Reel');
    box.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;margin:0;padding:0;z-index:2147483647;' +
      'background:#000;display:flex;align-items:center;justify-content:center';
    const v = document.createElement('video');
    v.dataset.sgOwn = '1';
    v.setAttribute('playsinline', '');
    v.loop = true;
    v.preload = 'auto';
    v.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000';
    const note = document.createElement('div');
    note.textContent = 'Loading the Reel…';
    note.style.cssText = 'position:absolute;color:#fff;font:15px system-ui,sans-serif;opacity:.75;pointer-events:none';
    box.appendChild(v);
    box.appendChild(note);
    const rb = { box: box, video: v, note: note, inFull: !!fs, held: [],
      story: { target: g.target, x: g.x, y: g.y, path: location.pathname } };
    const zone = pressUnderSticker(g);
    if (zone) rb.story.target = zone;               // its touchend lets go on close
    // The layer's own touches: a swipe up or down returns, a tap pauses or plays.
    // Nothing reaches Instagram's page underneath.
    let start = null;
    box.addEventListener('touchstart', e => {
      e.stopPropagation();
      start = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
    }, { passive: true });
    // Held still with a blocking touchmove, not touch-action:none (B25's touch rule).
    holdStill(box);
    box.addEventListener('touchend', safe(e => {
      e.stopPropagation();
      const s = start;
      start = null;
      if (!s || e.touches.length || !e.changedTouches.length) return;
      const dx = e.changedTouches[0].clientX - s.x, dy = e.changedTouches[0].clientY - s.y;
      if (Math.abs(dy) >= FV_SWIPE && Math.abs(dx) < Math.abs(dy) * 0.6) closeStoryReel('swipe');
    }), { passive: true });
    box.addEventListener('click', safe(e => {
      e.stopPropagation();
      e.preventDefault();
      if (reelBox === rb && rb.video.getAttribute('src')) togglePlay(rb.video);
    }));
    host.appendChild(box);
    reelBox = rb;
    fvStats.r9++;
    post('fullVideo', { on: true });
    holdStoryUnder();
    setTimeout(safe(holdStoryUnder), 300);           // a video Instagram started late
    loadStoryReel(reel, rb);
    return true;
  }
  // Instagram's tappable stickers (a shared Reel's card among them) are a
  // layer over the Story's press zone: pointer-events none, each sticker auto.
  // A touch that starts on one never presses the Story, so a photo's timer
  // would run on under the Reel. Press the zone under the finger instead;
  // returns it (null when the touch did press the Story, or no zone is found).
  function pressUnderSticker(g) {
    let layer = null;
    for (let el = g.target && g.target.parentElement, i = 0; el && el !== document.body && i < 16; el = el.parentElement, i++) {
      if (getComputedStyle(el).pointerEvents === 'none') layer = el;
      else if (layer) break;
    }
    if (!layer || typeof Touch !== 'function' || typeof TouchEvent !== 'function') return null;
    for (const el of document.elementsFromPoint(g.x, g.y)) {
      if (layer.contains(el) || el.contains(layer) || el.closest('#sg-reel')) continue;
      try {
        const t = new Touch({ identifier: 9001, target: el, clientX: g.x, clientY: g.y });
        el.dispatchEvent(new TouchEvent('touchstart', { touches: [t], targetTouches: [t], changedTouches: [t], bubbles: true, cancelable: true, composed: true }));
        fvStats.r9Pressed++;
        return el;
      } catch (e) { return null; }
    }
    return null;
  }
  async function loadStoryReel(reel, rb) {
    let rec = index.byCode.get(reel.code) || (reel.pk && index.byPk.get(reel.pk)) || null;
    let fetched = false;
    const lookup = async () => {
      // Instagram's media info, as downloads use it (the Story data has only the code).
      fetched = true;
      try { return await fetchInfo(reel.pk || pkFromCode(reel.code)); } catch (e) { return null; }
    };
    const missing = () => {
      fvStats.r9Missing++;
      closeStoryReel('missing');
      post('toast', { message: 'This Reel couldn’t be loaded.' });
    };
    if (!rec || !rec.video) rec = await lookup();
    if (reelBox !== rb) return;
    if (!rec || !rec.video) { missing(); return; }
    rb.video.addEventListener('playing', () => { rb.note.remove(); }, { once: true });
    // An address that fails (an older page's signed link that expired): ask
    // Instagram once for a fresh one, then say so. Closing empties the video,
    // which can fire this too; by then the layer is gone.
    rb.video.addEventListener('error', safe(async () => {
      if (reelBox !== rb) return;
      const again = fetched ? null : await lookup();
      if (reelBox !== rb) return;
      if (!again || !again.video || again.video === rb.video.getAttribute('src')) { missing(); return; }
      rb.video.src = again.video;
      rb.video.play().catch(() => {});
    }));
    rb.video.src = rec.video;
    rb.video.muted = userMuted;                      // your own mute choice wins here too
    const p = rb.video.play();
    // Sound needs the app's setting; muted beats not playing at all.
    if (p && p.catch) p.catch(() => { if (reelBox === rb) { rb.video.muted = true; rb.video.play().catch(() => {}); } });
  }
  // Instagram pauses a pressed Story. If a Story video still plays under the
  // Reel, that pause didn't take: pause it here and play it again afterwards.
  function holdStoryUnder() {
    const rb = reelBox;
    if (!rb) return;
    for (const v of document.getElementsByTagName('video')) {
      if (v === rb.video || v.paused || v.dataset.sgOwn) continue;
      v.pause();
      rb.held.push(v);
    }
  }
  function closeStoryReel(why) {
    const rb = reelBox;
    if (!rb) return;
    reelBox = null;
    if (why !== 'missing') fvStats.exits++;
    try { rb.video.pause(); rb.video.removeAttribute('src'); rb.video.load(); } catch (e) { /* gone */ }
    rb.box.remove();
    post('fullVideo', { on: false });
    if (why === 'ended' || route() !== 'story') return;
    if (location.pathname !== rb.story.path) fvStats.r9Moved++;
    // Lift the finger Instagram still thinks is down: the Story continues.
    releaseStoryPress(rb.story);
    if (rb.held.length) {
      setTimeout(safe(() => {
        for (const v of rb.held) if (v.isConnected && v.paused && !v.ended && route() === 'story') v.play().catch(() => {});
      }), 350);
    }
  }

  /* ------------------------------------------------------------------ *
   * B25: touch health and the scrolling repair.
   * A touch whose end the web engine never saw leaves it believing a finger
   * is still down; the first surface that doesn't allow vertical panning then
   * switches vertical scrolling off for the web view's lifetime, while taps
   * keep working. The app prevents the known causes. This notices if
   * one-finger drags stop scrolling anyway and tells the app (scrollStuck),
   * which first resets what it holds and then offers to rebuild the web view.
   * Only a drag that should certainly have scrolled counts; anything doubtful
   * (a pinch, a sideways swipe, a surface that doesn't pan vertically, the
   * end of a list, a scroll lock, a held-still drag, a busy page, full screen,
   * Stories, dialogs, zoom, the keyboard) is left out. Counts and shapes only.
   * ------------------------------------------------------------------ */
  const DEAD_TRAVEL = 60;        // CSS px of mostly vertical travel
  const DEAD_WAIT = 800;         // ms after the lift for a scroll to show
  const DEAD_WINDOW = 30000;     // strikes count within this long
  const DEAD_STRIKES = 3;
  const STUCK_EVERY = 60000;     // one report a minute at most, unless the app asks again
  const touchSeq = { starts: 0, ends: 0, cancels: 0, orphans: 0, orphanLast: null };
  const dragStats = { dead: 0, deadLast5: [], scrolled: 0, preventedSG: 0, preventedOther: 0, noMoves: 0,
    maxTouchesAtStart: 0, skipped: {} };
  const stuckStats = { posted: 0, refused: 0, soft: 0, chip: 0, ok: 0, deadAfterSoft: 0 };
  const taSeen = [];             // the last distinct non-auto touch-action values touched
  stats.b25 = { touchSeq: touchSeq, drag: dragStats, taSeen: taSeen, fsPage: fsPageLog, fs: fsCounts, stuck: stuckStats,
    census: null, search: null };
  let dseq = null;               // the one-finger touch being watched
  let strikes = [];              // when the recent dead drags ended
  let lastScrollAt = 0, viewW = 0, maxViewH = 0;
  const longTasks = [];          // recent main-thread stalls over 200 ms: [start, end]
  const report = { at: 0, followUp: false, wasFollowUp: false, open: false };

  function noteScroll() { lastScrollAt = performance.now(); }
  // Scrolls in the page (element scrolls pass the document in the capture
  // phase). The search screen's list is in a shadow root: it has its own.
  document.addEventListener('scroll', noteScroll, { capture: true, passive: true });

  function noteFsPage(el, via) {
    const now = performance.now();
    fsPageLog.push({ tag: el ? String(el.tagName || '?').toLowerCase() : null, route: route(), via: via, on: !!el,
      msSinceTouchEnd: lastTouchEndAt ? Math.round(now - lastTouchEndAt) : -1, touchActive: downIds.size > 0 });
    if (fsPageLog.length > 8) fsPageLog.shift();
    lastFsChangeAt = now;
  }
  function allowsPanY(v) {
    return !v || v === 'auto' || v === 'manipulation' || /(^|\s)pan-y(\s|$)/.test(v);
  }
  // The touched element's chain, through open shadow roots: its touch-action
  // values, whether they all allow vertical panning, the nearest vertical
  // scroller, and whether it is SimpleGram's search screen.
  function touchChain(e) {
    const out = { ta: [], panY: true, scroller: null, reverse: false, overlay: false };
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    for (const n of path) {
      if (!(n instanceof Element)) continue;
      if (n === search.host) out.overlay = true;
      const cs = getComputedStyle(n);
      const v = cs.touchAction;
      if (v && v !== 'auto' && out.ta.indexOf(v) < 0 && out.ta.length < 6) out.ta.push(v.slice(0, 40));
      if (!allowsPanY(v)) out.panY = false;
      if (!out.scroller && n !== document.documentElement && n !== document.body &&
        /^(auto|scroll|overlay)$/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 1) {
        out.scroller = n;
        // A chat-style list: scrollTop runs from -max up to 0 at the newest item.
        out.reverse = /flex/.test(cs.display) && /-reverse$/.test(cs.flexDirection);
      }
    }
    return out;
  }
  function noteTouchActions(list) {
    for (const v of list) {
      const i = taSeen.findIndex(x => x.v === v);
      if (i >= 0) taSeen.splice(i, 1);
      taSeen.push({ v: v, t: tenths(), route: route() });
      if (taSeen.length > 5) taSeen.shift();
    }
  }
  function dialogShown() {
    const list = document.querySelectorAll('[role="dialog"],[aria-modal="true"]');
    for (let i = 0; i < list.length && i < 20; i++) {
      const r = list[i].getBoundingClientRect();
      if (r.width > 1 && r.height > 1 && getComputedStyle(list[i]).visibility !== 'hidden') return true;
    }
    return false;
  }
  function deepActive() {
    let a = document.activeElement;
    for (let i = 0; a && a.shadowRoot && a.shadowRoot.activeElement && i < 5; i++) a = a.shadowRoot.activeElement;
    return a;
  }
  // Only a shrunk viewport says the keyboard is up: a field keeps its focus
  // after Back hides the keyboard, and drags there still count.
  function keyboardLikely() {
    noteViewport();
    const vv = window.visualViewport;
    return !!vv && maxViewH > 0 && vv.height < maxViewH * 0.75;
  }
  // The tallest the viewport has been at this width (a new width starts over).
  function noteViewport() {
    const vv = window.visualViewport;
    if (!vv) return;
    if (innerWidth !== viewW) { viewW = innerWidth; maxViewH = 0; }
    if (vv.height > maxViewH) maxViewH = vv.height;
  }
  if (CFG.role === 'main' && window.visualViewport) {
    window.visualViewport.addEventListener('resize', safe(noteViewport), { passive: true });
    // Its full height known before the first touch, read once the page has its
    // viewport (reading it at document start makes the page resize later).
    document.addEventListener('DOMContentLoaded', safe(noteViewport), { once: true });
  }
  function scrollLocked() {
    const h = document.documentElement, b = document.body;
    return (!!h && /^(hidden|clip)$/.test(getComputedStyle(h).overflowY)) ||
      (!!b && /^(hidden|clip)$/.test(getComputedStyle(b).overflowY));
  }
  function whereOf(d) {
    const r = route();
    return d.chain.overlay ? 'overlay' : r === 'home' ? 'home' : r === 'post' || r === 'reel' ? 'post' : 'other';
  }
  function skipDrag(why) { bump(dragStats.skipped, why); }
  function sawPrevented(d) {
    const m = d.last;
    d.last = null;
    if (m && m.defaultPrevented) { d.prevented++; if (sgPrevented.has(m)) d.sg = true; }
  }

  window.addEventListener('touchstart', safe(e => {
    if (!e.isTrusted || CFG.role !== 'main') return;
    const now = performance.now();
    // Every finger in this touch is new, yet the last touch never ended: the
    // page never saw that touch's end (the lost end, seen from the page).
    if (downIds.size && e.touches.length === e.changedTouches.length) {
      touchSeq.orphans++;
      touchSeq.orphanLast = { route: route(), fs: !!document.fullscreenElement,
        msSinceFsChange: lastFsChangeAt ? Math.round(now - lastFsChangeAt) : -1, appHeld: appHeld };
      downIds.clear();
    }
    if (!downIds.size) touchSeq.starts++;
    for (let i = 0; i < e.changedTouches.length; i++) downIds.add(e.changedTouches[i].identifier);
    if (e.touches.length > dragStats.maxTouchesAtStart) dragStats.maxTouchesAtStart = e.touches.length;
    const chain = touchChain(e);
    noteTouchActions(chain.ta);
    if (e.touches.length !== 1) { if (dseq) dseq.multi = true; return; }
    noteViewport();
    const sc = chain.scroller || document.scrollingElement || document.documentElement;
    const t = e.touches[0];
    // The scroller's real range: [0, max], or [-max, 0] for a reversed one (also
    // when it rests below 0 and its style didn't say so).
    const max = sc.scrollHeight - sc.clientHeight, top0 = sc.scrollTop;
    const rev = (chain.scroller === sc && chain.reverse) || top0 < -1;
    dseq = { t0: now, t1: 0, x: t.clientX, y: t.clientY, ex: t.clientX, ey: t.clientY, moves: 0, firstMove: 0,
      multi: false, last: null, prevented: 0, sg: false, chain: chain, sc: sc, top0: top0,
      lo: rev ? -max : 0, hi: rev ? 0 : max };
  }), { capture: true, passive: true });
  window.addEventListener('touchmove', safe(e => {
    const d = dseq;
    if (!d || !e.isTrusted) return;
    if (e.touches.length !== 1) d.multi = true;
    sawPrevented(d);                 // the previous move has been through every listener by now
    d.last = e;
    d.moves++;
    if (!d.firstMove) d.firstMove = performance.now();
    const t = e.touches[0];
    if (t) { d.ex = t.clientX; d.ey = t.clientY; }
  }), { capture: true, passive: true });
  // A finger (or the whole touch) lifted or cancelled, as far as the page's bookkeeping goes.
  function noteTouchLift(e, cancel) {
    for (let i = 0; i < e.changedTouches.length; i++) downIds.delete(e.changedTouches[i].identifier);
    if (e.touches.length) return;
    downIds.clear();
    if (cancel) touchSeq.cancels++;
    else { touchSeq.ends++; lastTouchEndAt = performance.now(); }
  }
  window.addEventListener('touchend', safe(e => {
    if (!e.isTrusted) return;
    noteTouchLift(e, false);
    const d = dseq;
    if (!d) return;
    if (e.touches.length) { d.multi = true; return; }
    dseq = null;
    const t = e.changedTouches[0];
    if (t) { d.ex = t.clientX; d.ey = t.clientY; }
    d.t1 = performance.now();
    judgeDrag(d);
  }), { capture: true, passive: true });
  window.addEventListener('touchcancel', safe(e => {
    if (!e.isTrusted) return;
    noteTouchLift(e, true);
    dseq = null;                     // a cancelled touch never counts
  }), { capture: true, passive: true });
  if (CFG.role === 'main') {
    try {
      new PerformanceObserver(safe(list => {
        for (const e of list.getEntries()) {
          if (e.duration < 200) continue;
          longTasks.push([e.startTime, e.startTime + e.duration]);
          if (longTasks.length > 8) longTasks.shift();
        }
      })).observe({ type: 'longtask' });
    } catch (e) { /* long task timing unavailable */ }
  }

  // At the lift: only a drag that should certainly scroll is watched further.
  function judgeDrag(d) {
    const dx = d.ex - d.x, dy = d.ey - d.y;
    if (Math.abs(dy) < DEAD_TRAVEL) return;          // a tap or a short touch: nothing to judge
    if (d.multi) return skipDrag('pinch');
    if (Math.abs(dy) < 2 * Math.abs(dx)) return skipDrag('sideways');
    if (!d.moves) { dragStats.noMoves++; return skipDrag('noMoves'); }
    if (d.firstMove - d.t0 > 500) return skipDrag('slowStart');
    const sel = typeof getSelection === 'function' ? getSelection() : null;
    if (sel && !sel.isCollapsed) return skipDrag('selection');
    if (!d.chain.panY) return skipDrag('noPanY');
    if (document.fullscreenElement || r8On || reelBox) return skipDrag('fullScreen');
    if (route() === 'story') return skipDrag('story');
    if (appHeld) return skipDrag('held');
    if (d.x < 16 || d.x > innerWidth - 16 || d.y > innerHeight - 24) return skipDrag('screenEdge');
    const vv = window.visualViewport;
    if (vv && Math.abs(vv.scale - 1) > 0.01) return skipDrag('zoom');
    if (keyboardLikely()) return skipDrag('keyboard');
    if (dialogShown()) return skipDrag('dialog');
    if (d.sc === (document.scrollingElement || document.documentElement) && scrollLocked()) return skipDrag('locked');
    // The list is at its end in the drag's direction: nothing to scroll.
    if (dy < 0 ? d.top0 >= d.hi - 2 : d.top0 <= d.lo + 2) return skipDrag('end');
    setTimeout(safe(() => settleDrag(d)), DEAD_WAIT);
  }
  // A while after the lift: did anything scroll?
  function settleDrag(d) {
    const now = performance.now();
    if (now - d.t1 > DEAD_WAIT + 600) return skipDrag('busy');   // too busy to tell
    sawPrevented(d);
    if (d.prevented) {
      if (d.sg) dragStats.preventedSG++;
      else dragStats.preventedOther++;
      return skipDrag('prevented');
    }
    if (lastScrollAt >= d.t0 || Math.abs(d.sc.scrollTop - d.top0) > 1) {
      dragStats.scrolled++;
      strikes = [];
      if (report.open) { report.open = false; stuckStats.ok++; post('scrollOk'); }
      return;
    }
    for (const lt of longTasks) if (lt[1] > d.t0 && lt[0] < now) return skipDrag('busy');
    if (document.fullscreenElement) return skipDrag('fullScreen');
    dragStats.dead++;
    if (stuckStats.soft) stuckStats.deadAfterSoft++;
    const travel = Math.abs(d.ey - d.y);
    dragStats.deadLast5.push({ route: route(), where: whereOf(d), travel: travel < 120 ? 60 : travel < 240 ? 120 : travel < 480 ? 240 : 480,
      chainTA: d.chain.ta.slice(0, 4) });
    if (dragStats.deadLast5.length > 5) dragStats.deadLast5.shift();
    strikes = strikes.filter(t => now - t < DEAD_WINDOW);
    strikes.push(now);
    maybeReport(d);
  }
  function maybeReport(d) {
    if (strikes.length < (report.followUp ? 2 : DEAD_STRIKES)) return;
    const now = Date.now();
    if (!report.followUp && report.at && now - report.at < STUCK_EVERY) return;
    report.wasFollowUp = report.followUp;
    report.followUp = false;
    report.at = now;
    report.open = true;
    stuckStats.posted++;
    post('scrollStuck', { strikes: strikes.length, where: whereOf(d), moves: d.moves, dead: dragStats.dead });
  }
  // The app's answer to a report.
  function stuckAck(cmd) {
    if (cmd.accepted === false) {
      // The app couldn't trust it (its zoom, a dialog, a finger down): the
      // next dead drag may report again.
      stuckStats.refused++;
      report.at = 0;
      report.followUp = report.wasFollowUp;
      return;
    }
    strikes = [];
    // After the quiet reset, two more dead drags are enough to bring the chip.
    if (cmd.stage === 'soft') { stuckStats.soft++; report.followUp = true; }
    else if (cmd.stage === 'chip') stuckStats.chip++;
  }
  // The app's quiet reset: no gesture of the page's own is left half-done.
  function gestureReset() {
    gesture = null;
    swipe = null;
    storyPress = null;
    dseq = null;
    downIds.clear();
    syncSwipeGuard();
  }
  function touchCensus() {
    const h = document.documentElement, b = document.body;
    const hs = h ? getComputedStyle(h) : null, bs = b ? getComputedStyle(b) : null;
    let dialogs = 0;
    const list = document.querySelectorAll('[role="dialog"],[aria-modal="true"]');
    for (let i = 0; i < list.length && i < 20; i++) {
      const r = list[i].getBoundingClientRect();
      if (r.width > 1 && r.height > 1) dialogs++;
    }
    const vv = window.visualViewport;
    return {
      html: hs ? { overflowY: hs.overflowY, touchAction: hs.touchAction } : null,
      body: bs ? { overflowY: bs.overflowY, touchAction: bs.touchAction } : null,
      moveBlockers: moveBlockers, swipeGuard: guardOn, dialogs: dialogs,
      vvScale: vv ? Math.round(vv.scale * 100) / 100 : null, downNow: downIds.size, strikes: strikes.length,
    };
  }

  /* ------------------------------------------------------------------ *
   * Sound on for Stories, opened Reels and full-screen DM videos.
   * Your own mute choice always wins.
   * ------------------------------------------------------------------ */
  let userMuted = false;
  let lastUserAudioTap = 0;
  const unmuteBudget = new WeakMap();
  function wantsSound(v) {
    if (CFG.role !== 'main') return false;
    if (isOldMedia(v)) return false;
    const r = route();
    if (r === 'story' || r === 'reel') return true;
    if (!(v instanceof HTMLVideoElement)) return false;
    if (r === 'direct' || r === 'post') return onScreenArea(v) > 0.45 * innerWidth * innerHeight;
    return false;
  }
  // Instagram's controls are labelled on the button or on its icon; the
  // icon is not always inside a <button>.
  function controlLabel(el) {
    if (!el || !el.getAttribute) return '';
    const own = el.getAttribute('aria-label');
    if (own) return own.trim();
    const svg = el.querySelector && el.querySelector('svg[aria-label]');
    if (svg) return svg.getAttribute('aria-label').trim();
    const title = el.querySelector && el.querySelector('svg title');
    return title ? norm(title) : '';
  }
  // The control's state. Instagram's "Toggle audio" button says nothing itself;
  // its icon does ("Audio is muted", "Audio is playing", "Video has no audio").
  function controlState(el) {
    const own = controlLabel(el);
    if (/playing|muted|no audio|no sound|is on|is off|^mute$|^unmute$|turn (on|off)/i.test(own)) return own;
    const svg = el.querySelector && el.querySelector('svg[aria-label]');
    return svg ? svg.getAttribute('aria-label').trim() : own;
  }
  function audioLabel(el) {
    const l = controlLabel(el);
    return /audio|sound|mute/i.test(l) ? l : '';
  }
  function shown(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  }
  // How much of an element is on screen, in square pixels.
  function onScreenArea(el) {
    const r = el.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    return w * h;
  }
  function findControl(media, re, wide) {
    const test = el => re.test(controlLabel(el)) && shown(el);
    let scope = media.parentElement;
    for (let i = 0; scope && i < 8; i++, scope = scope.parentElement) {
      for (const el of scope.querySelectorAll('button,[role="button"],svg[aria-label]')) {
        if (test(el)) return el;
      }
    }
    if (!wide) return null;
    for (const el of document.querySelectorAll('button,[role="button"],svg[aria-label]')) {
      if (test(el)) return el;
    }
    return null;
  }
  // Click the control itself. A bare icon's own small button wrapper is
  // used only if it is right around the icon; never a link or the media's tap area.
  function press(el) {
    let target = el;
    const icon = el.getBoundingClientRect();
    let n = el.parentElement;
    for (let i = 0; n && i < 3; i++, n = n.parentElement) {
      if (n.tagName === 'A' || n.querySelector('video,img[srcset]')) break;
      if (n.matches('button,[role="button"]')) {
        const r = n.getBoundingClientRect();
        if (r.width * r.height <= Math.max(icon.width * icon.height * 9, 64 * 64)) target = n;
        break;
      }
    }
    if (typeof target.click === 'function') target.click();
    else target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }
  function unmute(m) {
    const used = unmuteBudget.get(m) || { n: 0, t: Date.now() };
    if (Date.now() - used.t > 10000) { used.n = 0; used.t = Date.now(); }
    if (used.n >= 4) return;
    used.n++;
    unmuteBudget.set(m, used);
    const r = route();
    const toggle = findControl(m, /audio|sound|mute/i, r === 'story' || r === 'reel');
    const label = toggle ? controlState(toggle) : '';
    // "Audio is playing" means Instagram already thinks sound is on; a video
    // with no audio has nothing to turn on (pressing only shows a toast).
    if (toggle && !/playing|is on|^mute$|turn off|no audio|no sound/i.test(label)) {
      try { press(toggle); } catch (e) { /* ignore */ }
      setTimeout(() => { if (m.muted && !userMuted) m.muted = false; }, 300);
    } else {
      m.muted = false;
    }
  }
  document.addEventListener('play', safe(e => {
    const m = e.target;
    if (!(m instanceof HTMLMediaElement) || m.dataset.sgOwn) return;   // R9's Reel sets its own sound
    if (CFG.role !== 'main') { m.pause(); m.muted = true; return; }
    queueAwake();
    if (m.muted && !userMuted && wantsSound(m)) unmute(m);
  }), true);
  document.addEventListener('volumechange', safe(e => {
    const m = e.target;
    if (!(m instanceof HTMLMediaElement) || CFG.role !== 'main' || m.dataset.sgOwn) return;
    if (Date.now() - lastUserAudioTap < 800) { userMuted = m.muted; return; }
    if (m.muted && !userMuted && !m.paused && wantsSound(m)) setTimeout(() => { if (m.muted && !userMuted) unmute(m); }, 150);
  }), true);

  /* ------------------------------------------------------------------ *
   * A video you open (a Reel from a DM, a post's video) starts by
   * itself once. If you pause it, it stays paused.
   * ------------------------------------------------------------------ */
  const autoStarted = new WeakSet();
  function autoplay() {
    if (CFG.role !== 'main') return;
    const r = route();
    if (r !== 'direct' && r !== 'reel' && r !== 'post') return;
    for (const v of document.getElementsByTagName('video')) {
      if (autoStarted.has(v) || v.ended || isOldMedia(v)) continue;
      if (!v.paused) { autoStarted.add(v); continue; }
      // Mostly on screen; a carousel's next slide waiting to the side doesn't count.
      if (onScreenArea(v) < 0.4 * innerWidth * innerHeight) continue;
      autoStarted.add(v);
      if (v.currentTime > 0.3) continue;            // it has played before: you paused it
      stats.autoplayed++;
      const play = findControl(v, /^play$/i, false);
      if (play) { try { press(play); } catch (e) { /* ignore */ } }
      setTimeout(() => { if (v.paused && !v.ended && v.currentTime < 0.3) v.play().catch(() => {}); }, 400);
    }
  }
  ['loadedmetadata', 'canplay'].forEach(t => document.addEventListener(t, e => {
    if (e.target instanceof HTMLVideoElement) setTimeout(safe(autoplay), 50);
  }, true));

  /* ------------------------------------------------------------------ *
   * Keep the screen on while a visible video plays.
   * ------------------------------------------------------------------ */
  let awake = false, awakeTimer = 0;
  function computeAwake() {
    if (document.hidden) return false;
    for (const v of document.getElementsByTagName('video')) {
      if (v.paused || v.ended || v.readyState < 2) continue;
      const r = v.getBoundingClientRect();
      if (r.width > 60 && r.height > 60 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth) return true;
    }
    return false;
  }
  function queueAwake() {
    clearTimeout(awakeTimer);
    awakeTimer = setTimeout(safe(() => {
      const a = computeAwake();
      if (a !== awake) { awake = a; post('awake', { on: a }); }
    }), 300);
  }
  ['playing', 'pause', 'ended', 'emptied', 'waiting'].forEach(t => document.addEventListener(t, queueAwake, true));
  document.addEventListener('visibilitychange', queueAwake);
  setInterval(() => { if (awake || !document.hidden) queueAwake(); }, 5000);

  /* ------------------------------------------------------------------ *
   * Finding the photo/video you are looking at.
   * ------------------------------------------------------------------ */
  function hiddenByStyle(el) {
    for (let n = el, i = 0; n && i < 6; n = n.parentElement, i++) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return true;
    }
    return false;
  }
  function pickMedia(region, scope) {
    const root = scope || document;
    const vw = innerWidth, vh = innerHeight;
    const reg = region || { x: 0, y: 0, w: vw, h: vh };
    let best = null, bestScore = 0;
    for (const el of root.querySelectorAll('img,video')) {
      const r = el.getBoundingClientRect();
      if (r.width < 90 || r.height < 90) continue;
      const ix = Math.max(r.left, reg.x, 0), iy = Math.max(r.top, reg.y, 0);
      const ax = Math.min(r.right, reg.x + reg.w, vw), ay = Math.min(r.bottom, reg.y + reg.h, vh);
      const area = Math.max(0, ax - ix) * Math.max(0, ay - iy);
      if (area < 4000) continue;
      if (el.closest('[data-sg-hidden]') || hiddenByStyle(el)) continue;
      // Blurred backgrounds behind Stories are the same picture, but prefer the sharp one.
      const blurred = /blur/.test(getComputedStyle(el).filter || '');
      let score = area * (el.tagName === 'VIDEO' ? 1.25 : 1) * (blurred ? 0.5 : 1);
      // Prefer what is in the middle of the screen.
      const cx = (ix + ax) / 2 - (reg.x + reg.w / 2), cy = (iy + ay) / 2 - (reg.y + reg.h / 2);
      score /= 1 + Math.hypot(cx, cy) / Math.max(vw, vh);
      if (score > bestScore) { bestScore = score; best = el; }
    }
    return best;
  }
  function codeForElement(el) {
    const art = el && el.closest(POST);
    if (art) {
      const time = art.querySelector('a[href] time');
      const ta = time && time.closest('a[href]');
      if (ta) { const c = codeFromPath(new URL(ta.href, location.href).pathname); if (c) return c; }
    }
    let n = el;
    for (let i = 0; n && n !== document.body && i < 14; i++, n = n.parentElement) {
      const codes = new Set();
      for (const a of n.querySelectorAll('a[href*="/p/"],a[href*="/reel/"],a[href*="/reels/"],a[href*="/tv/"]')) {
        const c = codeFromPath(new URL(a.href, location.href).pathname);
        if (c) codes.add(c);
        if (codes.size > 1) break;
      }
      if (codes.size === 1) return codes.values().next().value;
      if (codes.size > 1) break;
    }
    return codeFromPath(location.pathname);
  }
  function srcsetBest(img) {
    const set = img.getAttribute('srcset');
    let best = img.currentSrc || img.src, bw = 0;
    if (set) {
      for (const part of set.split(',')) {
        const [u, w] = part.trim().split(/\s+/);
        const n = parseFloat(w) || 0;
        if (u && n > bw) { bw = n; best = u; }
      }
    }
    return best;
  }
  const SHORTCODE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  function pkFromCode(code) {
    try {
      let n = 0n;
      for (const ch of code.slice(0, 11)) {
        const i = SHORTCODE.indexOf(ch);
        if (i < 0) return null;
        n = n * 64n + BigInt(i);
      }
      return n.toString();
    } catch (e) { return null; }
  }
  // Instagram's own website requests; responses pass through the hooks
  // above, so whatever they contain is indexed automatically.
  // Parses an Instagram answer: strips "for (;;);", keeps long id lists exact,
  // and merges streamed answers (several JSON objects, one per line).
  function ownCleanse(data) {
    ownFetch = true;
    try { cleanse(data); } finally { ownFetch = false; }
  }
  function parseIg(text) {
    if (typeof text !== 'string') return null;
    text = text.replace(/^for \(;;\);/, '').replace(/"next_media_ids":\[([^\]]*)\]/g,
      (m, inner) => '"next_media_ids":[' + inner.replace(/(^|,)\s*(\d{16,})/g, '$1"$2"') + ']');
    try { return nativeParse(text); } catch (e) { /* maybe several objects */ }
    let merged = null;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let o;
      try { o = nativeParse(line); } catch (e) { continue; }
      if (!merged) { merged = o; continue; }
      if (o && o.data && merged.data && !o.path) Object.assign(merged.data, o.data);
    }
    return merged;
  }
  // Requests that answered 404 (or a search source that proved dead) are not
  // asked again in this session; full page loads keep the list.
  const DEAD_KEY = 'sg_dead_requests';
  const dead = new Set();
  try { for (const k of JSON.parse(sessionStorage.getItem(DEAD_KEY) || '[]')) dead.add(k); } catch (e) { /* ignore */ }
  function markDead(key) {
    dead.add(key);
    cap(dead, 60);
    searchStats.deadRequests = dead.size;
    try { sessionStorage.setItem(DEAD_KEY, JSON.stringify(Array.from(dead))); } catch (e) { /* ignore */ }
  }
  // Search diagnostics for Filter status: counts and shapes only, never names or queries.
  const gqlLog = [];
  const searchStats = (stats.searchData = {
    gqlLog: gqlLog, deadRequests: dead.size, hashtags: { blended: null, topsearch: null },
    tagWebInfo: null, tagGrid: { webInfo: 0, keyword: 0 }, tagRecent: { asked: 0, failed: 0 },
    // SimpleGram's grids: taps, pages read, second pages chained, failed
    // pages, the place page size asked for, and the last pages' new-post counts.
    grid: { taps: 0, pages: 0, chained: 0, failed: 0, chainFailed: 0, placeFirst: 24, sizes: [] },
  });
  SG.gqlLog = gqlLog;
  // `meta`, when given, receives the HTTP status.
  async function igGet(path, meta) {
    try {
      if (dead.has(path)) return null;
      const res = await fetch(path, {
        credentials: 'include',
        headers: { 'X-IG-App-ID': '936619743392459', 'X-Requested-With': 'XMLHttpRequest', 'X-IG-WWW-Claim': '0' },
      });
      if (meta) meta.status = res.status;
      if (res.status === 404) markDead(path);
      if (!res.ok) return null;
      const data = parseIg(await res.text());
      if (data && typeof data === 'object') ownCleanse(data);
      return data && data.status !== 'fail' ? data : null;
    } catch (e) { return null; }
  }

  // The Instagram website's own GraphQL requests. Their ids change every few
  // weeks, so they are looked up in the page's loaded code at run time.
  // A module that isn't defined is reported to Instagram's error logging, so
  // each missing name is asked for once per page (until a bundle defines it).
  const igMiss = new Set();
  function igModule(name) {
    if (igMiss.has(name)) return null;
    try {
      const m = typeof window.require === 'function' ? window.require(name) : null;
      if (m == null) igMiss.add(name);
      return m;
    } catch (e) { igMiss.add(name); return null; }
  }
  const docIds = {}, idSource = {};
  // Ids in Instagram's website code (bundles fetched 2026-10-21), used only
  // when the page's own code doesn't reveal the current one.
  const KNOWN_DOC_IDS = {
    PolarisSearchBoxRefetchableQuery: '27706427925724183',
    PolarisKeywordSearchExplorePageRelayQuery: '37324993597144881',
    PolarisKeywordSearchExplorePageRelayPaginationQuery: '28656899673911396',
    PolarisLocationPageTabContentQuery: '28586113187724473',
    PolarisLocationPageTabContentQuery_connection: '29002281179411948',
    PolarisExploreLocationsContainerQuery: '28572807415659320',
    PolarisAPITopsearchQuery: '29386906664232128',
  };
  // Settings ("provided variables") a query declares; Instagram refuses the
  // query when one is missing. Same date; false is always a valid value.
  const KNOWN_PV = {
    PolarisLocationPageTabContentQuery: ['PolarisShortDramaEnabled', 'PolarisSEOIsCrawler'],
    PolarisLocationPageTabContentQuery_connection: ['PolarisShortDramaEnabled', 'PolarisSEOIsCrawler'],
  };
  function pvKey(provider) { return '__relay_internal__pv__' + provider + 'relayprovider'; }
  // The query's compiled module, when the page has loaded it.
  function gqlParams(name) {
    const m = igModule(name + '.graphql');
    const p = m && (m.params || (m.default && m.default.params));
    return p && typeof p === 'object' ? p : null;
  }
  // Instagram's script files the page already downloaded, read from cache:
  // ids and declared settings. Each file is read once, and only after a miss.
  const scanned = { ops: {}, pv: {}, urls: new Set() };
  let scanning = Promise.resolve();
  function readBundle(text) {
    const ops = /__d\("([A-Za-z0-9_]+)_instagramRelayOperation",\[\],\(function\([^)]*\)\{[^}]*?exports="(\d+)"/g;
    const mods = /__d\("([A-Za-z0-9_]+)\.graphql",\[([^\]]*)\]/g;
    let m;
    while ((m = ops.exec(text))) { scanned.ops[m[1]] = m[2]; igMiss.delete(m[1] + '_instagramRelayOperation'); }
    while ((m = mods.exec(text))) {
      igMiss.delete(m[1] + '.graphql');
      const pv = [];
      const deps = /"([A-Za-z0-9_]+)\.relayprovider"/g;
      let d;
      while ((d = deps.exec(m[2]))) pv.push(d[1]);
      scanned.pv[m[1]] = pv;
    }
  }
  function scanBundles(name) {
    const run = async () => {
      const urls = [];
      for (const sc of document.scripts) if (sc.src) urls.push(sc.src);
      try { for (const e of performance.getEntriesByType('resource')) if (/\.js(\?|$)/.test(e.name)) urls.push(e.name); } catch (e) { /* ignore */ }
      let n = 0;
      for (const u of urls) {
        if (scanned.ops[name] || n >= 40) break;
        if (scanned.urls.has(u) || !/cdninstagram\.com|instagram\.com/.test(u)) continue;
        scanned.urls.add(u);
        n++;
        try { readBundle(await (await fetch(u, { cache: 'force-cache' })).text()); } catch (e) { /* skip this file */ }
      }
    };
    scanning = scanning.then(run, run);
    return scanning;
  }
  function keepId(name, id, source) {
    idSource[name] = source;
    return (docIds[name] = id);
  }
  // Order: this page's memo, the page's own modules, its script files, then KNOWN.
  async function docIdFor(name, p) {
    if (docIds[name]) return docIds[name];
    const op = igModule(name + '_instagramRelayOperation');
    if (typeof op === 'string' && /^\d+$/.test(op)) return keepId(name, op, 'module');
    if (p && /^\d+$/.test(String(p.id))) return keepId(name, String(p.id), 'graphql');
    if (!scanned.ops[name]) await scanBundles(name);
    if (scanned.ops[name]) return keepId(name, scanned.ops[name], 'scan');
    // Remembered like the others; a failed request clears it so Try again looks again.
    if (KNOWN_DOC_IDS[name]) return keepId(name, KNOWN_DOC_IDS[name], 'known');
    idSource[name] = 'known';
    return null;
  }
  // Settings named in an error answer, remembered per query for this page.
  const addedPv = {};
  function providerValue(m) {
    try {
      const o = m && typeof m.get === 'function' ? m : m && m.default;
      const v = o && typeof o.get === 'function' ? o.get() : false;
      return typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string' ? v : !!v;
    } catch (e) { return false; }
  }
  // The query's declared settings with the values Instagram's page uses:
  // from its compiled module, else its script file, else KNOWN_PV (false).
  function providedVars(name, p) {
    const out = {};
    let source = 'none';
    if (p) {
      source = 'graphql';
      const pvs = p.providedVariables;
      if (pvs && typeof pvs === 'object') for (const k of Object.keys(pvs)) out[k] = providerValue(pvs[k]);
    } else if (scanned.pv[name]) {
      source = 'scan';
      for (const x of scanned.pv[name]) out[pvKey(x)] = false;
    } else if (KNOWN_PV[name]) {
      source = 'known';
      for (const x of KNOWN_PV[name]) out[pvKey(x)] = false;
    }
    const added = addedPv[name];
    if (added) for (const k in added) if (!(k in out)) out[k] = added[k];
    return { vars: out, source: source };
  }
  let homeHtml = null;
  async function pageToken(module, re) {
    const m = igModule(module);
    if (m && m.token) return m.token;
    for (const sc of document.querySelectorAll('script:not([src])')) {
      const hit = re.exec(sc.textContent || '');
      if (hit) return hit[1];
    }
    try {
      if (homeHtml === null) homeHtml = await (await fetch('/', { credentials: 'include' })).text();
      const hit = re.exec(homeHtml);
      if (hit) return hit[1];
    } catch (e) { homeHtml = ''; }
    return '';
  }
  function gqlNote(entry) {
    gqlLog.push(entry);
    while (gqlLog.length > 20) gqlLog.shift();
  }
  // Sizes of an answer, for diagnostics.
  function answerShape(out) {
    const shape = {};
    if (Array.isArray(out.edges)) shape.edges = out.edges.length;
    for (const k of ['users', 'hashtags', 'places']) if (Array.isArray(out[k])) shape[k] = out[k].length;
    return shape;
  }
  // R7's own Following reads, built like Instagram's own relay requests
  // (b385 createRelayFBNetworkFetch): its getAsyncParams('POST') body (b25)
  // and getAsyncHeaders (b314: X-FB-LSD, X-ASBD-ID), X-Root-Field-Name from
  // the query's metadata, plus X-CSRFToken and X-IG-App-ID. Whatever the page
  // can't give falls back to the minimal set the search requests use.
  // fid / hdr: 'page' when Instagram's own helper built it, 'min' otherwise.
  function feedRequest(name, id, vars, params, lsd, dtsg, path) {
    const out = { fid: 'min', hdr: 'min' };
    let body = null;
    try {
      const gap = moduleFn('getAsyncParams');
      const p = gap ? gap('POST') : null;
      if (p && typeof p === 'object') {
        body = {};
        const av = viewerId();
        if (av) body.av = av;
        for (const k in p) if (p[k] != null && typeof p[k] !== 'object') body[k] = String(p[k]);
        Object.assign(body, { fb_api_caller_class: 'RelayModern', fb_api_req_friendly_name: name, server_timestamps: 'true',
          variables: JSON.stringify(vars), doc_id: id });
        out.fid = 'page';
      }
    } catch (e) { body = null; }
    if (!body) {
      body = { doc_id: id, variables: JSON.stringify(vars), fb_dtsg: dtsg, lsd: lsd, fb_api_caller_class: 'RelayModern',
        fb_api_req_friendly_name: name, server_timestamps: 'true' };
    }
    let page = null;
    try {
      const gh = moduleFn('getAsyncHeaders');
      const U = igModule('URI');
      const Uri = typeof U === 'function' ? U : U && typeof U.default === 'function' ? U.default : null;
      const h = gh && Uri ? gh(new Uri(path)) : null;
      if (h && typeof h === 'object') {
        page = {};
        for (const k in h) if (typeof h[k] === 'string' && /^[\w-]{1,40}$/.test(k)) page[k] = h[k];
        out.hdr = 'page';
      }
    } catch (e) { page = null; }
    const headers = Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded', 'X-FB-Friendly-Name': name },
      page || { 'X-FB-LSD': lsd });
    const rf = params && params.metadata && Array.isArray(params.metadata.root_field_name) ? params.metadata.root_field_name[0] : null;
    if (typeof rf === 'string' && /^\w{1,80}$/.test(rf)) headers['X-Root-Field-Name'] = rf;
    headers['X-CSRFToken'] = csrf();
    headers['X-IG-App-ID'] = '936619743392459';
    out.init = { method: 'POST', credentials: 'include', headers: headers, body: new URLSearchParams(body).toString() };
    return out;
  }
  // Returns data[root] (the answer's main object), or null. At most 2 POSTs.
  // opts.feed: R7's own Following read (one path, Instagram's own request
  // shape, the browser's own fetch; its answer never counts as Home's page).
  async function igGraphQL(name, variables, root, opts) {
    const feed = !!(opts && opts.feed);
    try {
      const params = gqlParams(name);
      const id = await docIdFor(name, params);
      if (!id) return null;
      const pv = providedVars(name, params);
      // The caller's variables in its order, then the settings, as the website sends them.
      const vars = Object.assign({}, variables);
      for (const k in pv.vars) if (!(k in vars)) vars[k] = pv.vars[k];
      const lsd = await pageToken('LSD', /"LSD",\[\],\{"token":"([^"]+)"/);
      const dtsg = await pageToken('DTSGInitialData', /"DTSGInitialData",\[\],\{"token":"([^"]+)"/);
      // The website uses /api/graphql (/graphql/query for "distillery" queries).
      // The other path is tried only when the first gives no readable answer.
      const paths = params && params.metadata && params.metadata.is_distillery === true
        ? ['/graphql/query', '/api/graphql'] : ['/api/graphql', '/graphql/query'];
      if (feed) paths.length = 1;           // the website's one path for this query
      let p = 0;
      for (let posts = 0; posts < 2 && p < paths.length; posts++) {
        const path = paths[p];
        const note = { query: name, id: id, idSource: idSource[name] || '', providerSource: pv.source, providers: {}, path: path, status: 0 };
        for (const k in vars) {
          if (/^__relay_internal__pv__/.test(k)) note.providers[k.replace(/^__relay_internal__pv__|relayprovider$/g, '')] = vars[k];
        }
        const t0 = Date.now();
        let res = null, text = '', data = null, timer = 0;
        try {
          if (feed) {
            const r = feedRequest(name, id, vars, params, lsd, dtsg, path);
            note.fid = r.fid;
            note.hdr = r.hdr;
            // A read that never answers (a connection gone quiet) is given up
            // in time, answer included, like Instagram's own (60 s): it fails.
            const ms = opts && opts.timeout;
            if (ms > 0 && typeof AbortController === 'function') {
              const ac = new AbortController();
              r.init.signal = ac.signal;
              timer = setTimeout(() => { note.timedOut = true; try { ac.abort(); } catch (e) { /* none */ } }, ms);
            }
            res = await nativeFetch.call(window, path, r.init);
          } else {
            res = await fetch(path, {
              method: 'POST', credentials: 'include',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRFToken': csrf(), 'X-IG-App-ID': '936619743392459',
                'X-FB-LSD': lsd, 'X-FB-Friendly-Name': name,
              },
              body: new URLSearchParams({
                doc_id: id, variables: JSON.stringify(vars), fb_dtsg: dtsg,
                lsd: lsd, fb_api_caller_class: 'RelayModern', fb_api_req_friendly_name: name, server_timestamps: 'true',
              }).toString(),
            });
          }
          note.status = res.status;
          if (res.ok) { text = await res.text(); data = parseIg(text); }
        } catch (e) { note.message = note.timedOut ? 'timed out' : 'network error'; } finally { clearTimeout(timer); }
        note.ms = Date.now() - t0;
        if (res && (res.status === 429 || res.status === 401 || res.status === 403)) {
          note.message = 'refused (HTTP ' + res.status + ')';
          gqlNote(note);
          break;                            // the other path would be refused too
        }
        if (!data || typeof data !== 'object') {
          if (res && res.ok) note.message = 'unreadable answer';
          gqlNote(note);
          p++;
          continue;
        }
        ownFeedRead = feed;
        try { ownCleanse(data); } finally { ownFeedRead = false; }
        const out = data.data && data.data[root];
        if (out) { Object.assign(note, answerShape(out)); gqlNote(note); return out; }
        // Instagram read the request and refused it: never resend it elsewhere.
        const err = Array.isArray(data.errors) ? data.errors[0] : null;
        if (err && (err.code != null || err.api_error_code != null)) note.code = err.code != null ? err.code : err.api_error_code;
        // "Please wait" inside an ordinary answer (as noteThrottle counts it).
        if (err && (/rate limit|please wait/i.test(String(err.message || '') + ' ' + String(err.summary || '')) ||
            (note.code === 1675004 && /rate/i.test(String(err.summary || ''))))) note.wait = true;
        note.message = String(err ? err.message || err.summary || err.description || 'error' : data.message || 'no ' + root).slice(0, 200);
        gqlNote(note);
        // Retry once only when the answer names a setting that wasn't sent.
        const missing = (text.match(/__relay_internal__pv__\w+?relayprovider/g) || []).filter(k => !(k in vars));
        if (!missing.length) break;
        const added = addedPv[name] || (addedPv[name] = {});
        for (const k of missing) { added[k] = false; vars[k] = false; }
      }
      delete docIds[name];                  // look the id up again next time
      return null;
    } catch (e) { return null; }
  }
  function uuid() {
    try { return crypto.randomUUID(); } catch (e) { return String(Date.now()) + Math.random().toString(16).slice(2); }
  }
  async function fetchInfo(pk) {
    if (!pk) return null;
    const data = await igGet('/api/v1/media/' + pk + '/info/');
    const item = data && Array.isArray(data.items) ? data.items[0] : null;
    if (item && looksLikeMedia(item)) indexMedia(item);
    return item ? (index.byPk.get(mediaPk(item)) || null) : null;
  }
  async function userIdFor(username) {
    const key = username.toLowerCase();
    if (!userIds.has(key)) await igGet('/api/v1/users/web_profile_info/?username=' + encodeURIComponent(username));
    return userIds.get(key) || null;
  }
  // Loads a person's current Stories (or a highlight) so the one on screen can be found.
  async function fetchStories(owner) {
    if (!owner) return false;
    let reel = null;
    if (owner.highlight) reel = 'highlight:' + owner.highlight;
    else if (owner.user) { const id = await userIdFor(owner.user); if (id) reel = id; }
    if (!reel) return false;
    return !!(await igGet('/api/v1/feed/reels_media/?reel_ids=' + encodeURIComponent(reel)));
  }
  function httpSrc(v) {
    const s = v.currentSrc || v.src || '';
    return /^https:\/\//.test(s) ? s : null;
  }
  function slideIndex(el) {
    // Position of the visible slide in its carousel list, if the list looks complete.
    const li = el.closest('li');
    if (!li || !li.parentElement) return -1;
    const items = Array.from(li.parentElement.children).filter(x => x.tagName === 'LI');
    return items.indexOf(li);
  }

  // Snapshot taken the moment you open the menu, so a Story that moves on
  // while the menu is open still downloads the one you were watching.
  let snapshot = null;
  function takeSnapshot(focus) {
    const r = route();
    const el = pickMedia(focus, null);
    snapshot = {
      at: Date.now(), route: r, el: el,
      kind: el ? (el.tagName === 'VIDEO' ? 'video' : 'image') : null,
      code: r === 'story' ? null : (el ? codeForElement(el) : codeFromPath()),
      storyPk: r === 'story' ? storyPk() : null,
      owner: r === 'story' ? storyOwner() : null,
      file: el ? fileOf(el.tagName === 'VIDEO' ? (el.poster || httpSrc(el) || '') : srcsetBest(el)) : null,
      imgUrl: el && el.tagName === 'IMG' ? srcsetBest(el) : null,
      videoUrl: el && el.tagName === 'VIDEO' ? httpSrc(el) : null,
      posterFile: null, slide: el ? slideIndex(el) : -1,
      url: location.href,
    };
    if (el && el.tagName === 'VIDEO') {
      const sib = el.parentElement && el.parentElement.querySelector('img');
      snapshot.posterFile = fileOf(el.poster) || (sib ? fileOf(sib.currentSrc || sib.src) : null);
    }
    return snapshot;
  }
  function resolved(s) {
    if (!s.promise) s.promise = resolveSnapshot(s).catch(() => ({ error: 'Download failed.' }));
    return s.promise;
  }
  async function recordFor(s) {
    const hit = (s.file && index.byFile.get(s.file)) || (s.posterFile && index.byFile.get(s.posterFile));
    if (s.route === 'story') {
      const known = () => (s.storyPk && index.byPk.get(s.storyPk)) ||
        ((s.file && index.byFile.get(s.file)) || (s.posterFile && index.byFile.get(s.posterFile)) || {}).rec || null;
      if (known()) return known();
      if (s.storyPk) { const r = await fetchInfo(s.storyPk); if (r) return r; }
      await fetchStories(s.owner);
      if (!known()) s.reason = 'story-not-found';
      return known();
    }
    if (hit && (!s.code || !hit.rec.code || hit.rec.code === s.code)) return hit.rec;
    if (s.code) return index.byCode.get(s.code) || await fetchInfo(pkFromCode(s.code));
    return null;
  }
  function nameFor(rec, i, total, kind) {
    const base = [rec && rec.username, rec && (rec.code || rec.pk)].filter(Boolean).join('_') || 'instagram';
    const part = total > 1 ? '_' + (i + 1) : '';
    return ('SimpleGram_' + base + part).replace(/[^A-Za-z0-9._-]/g, '_') + (kind === 'video' ? '.mp4' : '.jpg');
  }
  async function resolveSnapshot(s) {
    if (!s.el) return { error: 'No photo or video is on screen.' };
    let rec = null;
    try { rec = await recordFor(s); } catch (e) { rec = null; }
    const out = { items: [], all: [], choices: [], carousel: 0 };
    const children = rec && rec.children && rec.children.length ? rec.children : null;
    let current = null;
    if (children) {
      out.carousel = children.length;
      out.all = children.map((c, i) => ({ url: c.video || c.image, kind: c.video ? 'video' : 'image', name: nameFor(rec, i, children.length, c.video ? 'video' : 'image') })).filter(x => x.url);
      let idx = -1;
      const hit = (s.file && index.byFile.get(s.file)) || (s.posterFile && index.byFile.get(s.posterFile));
      if (hit && hit.rec === rec && hit.child >= 0) idx = hit.child;
      if (idx < 0 && s.kind === 'video') {
        const vids = children.map((c, i) => c.video ? i : -1).filter(i => i >= 0);
        if (vids.length === 1) idx = vids[0];
        else if (s.slide >= 0 && s.slide < children.length && children[s.slide].video) idx = s.slide;
        else out.choices = vids.map(i => ({ url: children[i].video, kind: 'video', name: nameFor(rec, i, children.length, 'video'), label: 'Video in slide ' + (i + 1) }));
      }
      if (idx >= 0 && !(s.kind === 'video' && !children[idx].video)) {
        const c = children[idx];
        const kind = s.kind === 'video' && c.video ? 'video' : (c.video && !c.image ? 'video' : (s.kind === 'image' ? 'image' : (c.video ? 'video' : 'image')));
        current = { url: kind === 'video' ? c.video : c.image, kind: kind, name: nameFor(rec, idx, children.length, kind) };
      }
    } else if (rec) {
      if (s.kind === 'video' && rec.video) current = { url: rec.video, kind: 'video', name: nameFor(rec, 0, 1, 'video') };
      else if (rec.image && s.kind !== 'video') current = { url: rec.image, kind: 'image', name: nameFor(rec, 0, 1, 'image') };
      else if (rec.video) current = { url: rec.video, kind: 'video', name: nameFor(rec, 0, 1, 'video') };
    }
    if (!current && s.kind === 'image' && s.imgUrl) {
      current = { url: s.imgUrl, kind: 'image', name: nameFor(rec, 0, 1, 'image') };
    }
    if (!current && s.kind === 'video' && s.videoUrl) {
      current = { url: s.videoUrl, kind: 'video', name: nameFor(rec, 0, 1, 'video') };
    }
    if (current && current.url) out.items = [current];
    if (!out.items.length && !out.choices.length) {
      out.error = s.reason === 'story-not-found'
        ? 'Instagram didn\u2019t share this Story\u2019s file. Try again in a moment, or after reopening the Story.'
        : s.kind === 'video'
          ? 'This video could not be matched to a downloadable file. Try again after it plays for a moment.'
          : 'This photo could not be found.';
      const why = s.reason || (s.kind === 'video' ? 'video-unmatched' : 'photo-unmatched');
      stats.downloads.failed[why] = (stats.downloads.failed[why] || 0) + 1;
    } else {
      stats.downloads.ok++;
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Comments: open as a half-screen panel under the post.
   * ------------------------------------------------------------------ */
  let split = null;
  function isCommentControl(el) {
    const btn = el.closest('button,[role="button"],a');
    if (!btn) return null;
    const svg = btn.querySelector('svg[aria-label]');
    const label = ((svg && svg.getAttribute('aria-label')) || btn.getAttribute('aria-label') || '').trim();
    return /^comments?$/i.test(label) ? btn : null;
  }
  // The post's media, even if it is scrolled partly off screen. Of a
  // carousel, the slide that is horizontally in view.
  function articleMedia(art) {
    let best = null, bestScore = 0;
    for (const el of art.querySelectorAll('img,video')) {
      const r = el.getBoundingClientRect();
      if (r.width < 90 || r.height < 90 || hiddenByStyle(el)) continue;
      const across = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
      const score = across * r.height * (el.tagName === 'VIDEO' ? 1.25 : 1);
      if (score > bestScore) { bestScore = score; best = el; }
    }
    return best;
  }
  function mediaBoxFor(control) {
    const art = control.closest(POST);
    const el = art ? articleMedia(art) : pickMedia(null, null);
    return el ? { el: el, box: el } : null;
  }
  function scrollerOf(el) {
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && n.scrollHeight > n.clientHeight + 10) return n;
    }
    return document.scrollingElement || document.documentElement;
  }
  function openComments(code, control) {
    const found = control ? mediaBoxFor(control) : null;
    const sc = found ? scrollerOf(found.box) : (document.scrollingElement || document.documentElement);
    split = { code: code, scroller: sc, top: sc.scrollTop, docTop: (document.scrollingElement || document.documentElement).scrollTop };
    let rect = null;
    if (found) {
      let r = found.box.getBoundingClientRect();
      if (r.top < 0 || r.bottom > innerHeight) {
        sc.scrollTop += r.top - Math.max(0, (innerHeight - r.height) / 2);
        r = found.box.getBoundingClientRect();
      }
      const left = Math.max(0, r.left), right = Math.min(innerWidth, r.right);
      const top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom);
      if (right - left > 40 && bottom - top > 40) rect = { x: left, y: top, w: right - left, h: bottom - top };
    }
    post('comments', {
      code: code,
      url: 'https://www.instagram.com/p/' + code + '/comments/',
      rect: rect, dpr: window.devicePixelRatio || 1, vw: innerWidth, vh: innerHeight,
    });
  }
  function closeSplit() {
    if (!split) return;
    const s = split;
    split = null;
    requestAnimationFrame(() => {
      s.scroller.scrollTop = s.top;
      const se = document.scrollingElement || document.documentElement;
      if (s.scroller !== se) se.scrollTop = s.docTop;
    });
  }

  window.addEventListener('click', safe(e => {
    if (!e.isTrusted || !(e.target instanceof Element)) return;
    const t = e.target;
    if (findAudioToggleTarget(t)) lastUserAudioTap = Date.now();
    if (route() === 'story') storyDirection = e.clientX < innerWidth / 3 ? 'back' : 'next';
    if (CFG.role !== 'main') return;
    const a = t.closest('a[href]');
    // On its own: a failure here must never skip the Search tab below.
    if (a) {
      let took = false;
      try { took = homeTab(e, a); } catch (err) { stats.errors++; }
      if (took) return;
    }
    if (a && new URL(a.href, location.href).pathname === '/explore/' && a.closest('nav,div')) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      openSearch(true);
      return;
    }
    let code = null, control = null;
    if (a) {
      const p = new URL(a.href, location.href);
      if (p.origin === location.origin && /\/comments\/?$/.test(p.pathname)) { code = codeFromPath(p.pathname); control = a; }
    }
    if (!code) {
      control = isCommentControl(t);
      if (control) code = codeForElement(control);
    }
    if (!code || !control) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    openComments(code, control);
  }), true);
  function findAudioToggleTarget(t) {
    const btn = t.closest('button,[role="button"],svg[aria-label]');
    return btn && audioLabel(btn) ? btn : null;
  }

  /* ------------------------------------------------------------------ *
   * Search with tabs, like the app: Accounts · Posts & Reels · Tags ·
   * Places. Tags and places offer Top / Most recent when Instagram's
   * website still serves recent posts. Every further page needs a
   * "Show more" tap: nothing loads by itself, so no endless scrolling.
   *
   * It is SimpleGram's own screen, drawn in an isolated layer above
   * Instagram's page; it only reads Instagram's own search data.
   * ------------------------------------------------------------------ */
  const SEARCH_STATE = 'sg_search_state';
  const RECENT_KEY = 'sg_recent_searches';
  // About 24 posts a tap: when a page brings fewer than CHAIN_BELOW new posts,
  // the same tap asks for the next page right after it (never more than 2).
  const CHAIN_BELOW = 18;
  const PLACE_PAGE = 24;
  const TABS = [['accounts', 'Accounts'], ['posts', 'Posts & Reels'], ['tags', 'Tags'], ['places', 'Places']];
  const search = {
    host: null, root: null, open: false, suspended: false,
    tab: 'accounts', query: '', view: null,       // view: {kind:'tag'|'place', id, name, sub:'top'|'recent'}
    results: {}, pending: null, posts: null, grid: null, seqTop: 0, seqPosts: 0, seqGrid: 0, timer: 0,
    returnUrl: null, token: null, paused: [],
  };
  SG.search = search;

  function csrf() {
    const m = /(?:^|;\s*)csrftoken=([^;]+)/.exec(document.cookie || '');
    return m ? decodeURIComponent(m[1]) : '';
  }
  async function igPost(path, form) {
    try {
      const res = await fetch(path, {
        method: 'POST', credentials: 'include',
        headers: {
          'X-IG-App-ID': '936619743392459', 'X-Requested-With': 'XMLHttpRequest',
          'X-CSRFToken': csrf(), 'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(form).toString(),
      });
      if (!res.ok) return null;
      const data = parseIg(await res.text());
      if (data && typeof data === 'object') ownCleanse(data);
      return data && data.status !== 'fail' ? data : null;
    } catch (e) { return null; }
  }
  // Every post object inside a results payload, in order, once each.
  function collectMedia(root) {
    const out = [], seen = new Set(), stack = [root];
    let budget = 20000;
    while (stack.length && budget-- > 0) {
      const o = stack.shift();
      if (!o || typeof o !== 'object') continue;
      if (Array.isArray(o)) { for (const x of o) stack.push(x); continue; }
      if (looksLikeMedia(o) && (o.code || o.shortcode)) {
        const code = o.code || o.shortcode;
        if (!seen.has(code)) { seen.add(code); out.push(o); }
        continue;                                  // not its carousel children
      }
      for (const k in o) if (o[k] && typeof o[k] === 'object') stack.push(o[k]);
    }
    return out;
  }
  function thumbOf(m) {
    const c = (m.image_versions2 && m.image_versions2.candidates) ||
      (Array.isArray(m.carousel_media) && m.carousel_media[0] && m.carousel_media[0].image_versions2 &&
        m.carousel_media[0].image_versions2.candidates) || [];
    let best = null;
    for (const x of c) {
      if (!x || !x.url) continue;
      if (!best || (x.width >= 300 && (best.width < 300 || x.width < best.width)) || (best.width < 300 && x.width > best.width)) best = x;
    }
    return best ? best.url : '';
  }
  function postPath(m) {
    const code = m.code || m.shortcode;
    return (m.product_type === 'clips' ? '/reel/' : '/p/') + code + '/';
  }
  function moreState(o) {
    if (!o || typeof o !== 'object') return null;
    const more = o.more_available || o.has_more || (o.page_info && o.page_info.has_next_page);
    if (!more) return null;
    return {
      max_id: o.next_max_id || o.max_id || (o.page_info && o.page_info.end_cursor) || '',
      page: o.next_page != null ? o.next_page : null,
      media_ids: Array.isArray(o.next_media_ids) ? o.next_media_ids : null,
      rank_token: o.rank_token || '',
    };
  }

  /* Data: the website's current requests (GraphQL), plus the older web
     endpoints that still answer; Instagram's own page as the fallback. */
  const LATIN = 'àáâäæãåāăąçćčđďèéêëēėęěğǵḧîïíīįìłḿñńǹňôöòóœøōõőṕŕřßśšşșťțûüùúūǘůűųẃẍÿýžźż·/_,:;';
  const PLAIN = 'aaaaaaaaaacccddeeeeeeeegghiiiiiilmnnnnoooooooooprrsssssttuuuuuuuuuwxyyzzz------';
  // Instagram's own slug rule for place links.
  function slugify(s) {
    return String(s || '').toLowerCase().replace(new RegExp('[' + LATIN + ']', 'g'), ch => PLAIN.charAt(LATIN.indexOf(ch)))
      .replace(/[^\w\s-]+/g, '').trim().replace(/\s+/g, '-').replace(/--+/g, '-');
  }
  function users(list) {
    return (list || []).map(x => x && (x.user || x)).filter(u => u && u.username);
  }
  function hashtags(list) {
    return (list || []).map(x => x && (x.hashtag || x)).filter(h => h && h.name);
  }
  function places(list) {
    return (list || []).map(x => {
      const p = x && (x.place || x);
      const loc = p && (p.location || p);
      const id = loc && (loc.pk || loc.id || loc.location_id);
      if (!id) return null;
      const name = loc.name || p.title || '';
      return { id: String(id), name: p.title || name, sub: p.subtitle || loc.address || loc.city || '', slug: p.slug || slugify(loc.name || name) };
    }).filter(Boolean);
  }
  // One query's answers, shared by the tabs, so switching tabs or retyping
  // the same word asks Instagram again only when needed.
  const topCache = new Map();
  function cacheFor(q) {
    let c = topCache.get(q);
    if (!c) { c = {}; topCache.set(q, c); cap(topCache, 30); }
    return c;
  }
  async function cached(c, key, make) {
    if (!(key in c)) c[key] = make();
    const v = await c[key];
    if (v == null) delete c[key];          // failures are not remembered
    return v;
  }
  // The website's search box request (accounts, and tags or places when it has any),
  // shared by the tabs.
  function blendedSearch(c, q) {
    return cached(c, 'gql', () => igGraphQL('PolarisSearchBoxRefetchableQuery', {
      data: { context: 'blended', include_reel: 'true', query: q, rank_token: '', search_session_id: uuid(), search_surface: 'web_top_search' },
      hasQuery: true,
    }, 'xdt_api__v1__fbsearch__topsearch_connection'));
  }
  // A typed tag as Instagram writes it: no '#' or spaces, lower case,
  // letters with their marks (Hindi vowel signs, accents), digits, '_'.
  let tagChars = null;
  function tagOf(q) {
    if (!tagChars) {
      try { tagChars = new RegExp('[^\\p{L}\\p{M}\\p{N}_\\u200c]', 'gu'); } catch (e) { tagChars = /[^\w\u00c0-\uffff]/g; }
    }
    return String(q || '').replace(/^#+/, '').replace(/\s+/g, '').toLowerCase().replace(tagChars, '');
  }
  // The typed tag first, then the others found, each once; counts filled in when known.
  function tagRows(typed, lists) {
    const out = typed ? [{ name: typed, media_count: null }] : [];
    const seen = new Map(out.map(h => [h.name, h]));
    for (const list of lists) {
      for (const h of list) {
        const key = String(h.name).toLowerCase();
        const have = seen.get(key);
        const count = h.media_count != null ? h.media_count : null;
        if (!have) { const row = { name: String(h.name), media_count: count }; seen.set(key, row); out.push(row); }
        else if (have.media_count == null) have.media_count = count;
      }
    }
    return out;
  }
  async function loadTags(c, q, stale) {
    const typed = tagOf(q);
    if (!typed) return { list: [] };                 // just '#': nothing to look up
    const g = await blendedSearch(c, q);
    const found = g ? hashtags(g.hashtags) : [];
    if (g) searchStats.hashtags.blended = found.length;
    let own = [];
    // The lookup Instagram's '#' suggestions use, only when the search box had no tags.
    if (!found.length && !stale()) {
      const r = await cached(c, 'tagsGql', () => igGraphQL('PolarisAPITopsearchQuery', {
        data: { context: 'hashtag', include_reel: 'true', query: typed, rank_token: '', search_session_id: uuid(), search_surface: 'web_top_search' },
      }, 'xdt_api__v1__fbsearch__topsearch_connection'));
      own = r ? hashtags(r.hashtags) : [];
      if (r) searchStats.hashtags.topsearch = own.length;
    }
    if (stale()) return null;
    return { list: tagRows(typed, [found, own]) };   // never empty, never an error
  }
  // Results for one tab. `stale()` says the user has typed something else:
  // then stop before asking Instagram for anything more.
  async function loadTab(tab, q, stale) {
    const c = cacheFor(q);
    if (tab === 'tags') return loadTags(c, q, stale);
    if (tab === 'places') {
      const r = await cached(c, 'fbplaces', () => igGet('/api/v1/fbsearch/places/?query=' + encodeURIComponent(q)));
      const list = r ? places(r.items) : [];
      if (stale()) return null;
      if (list.length) return { list: list };
      const g = await blendedSearch(c, q);
      if (stale()) return null;
      const more = g ? places(g.places) : [];
      return !more.length && !r && !g ? { error: true, list: [] } : { list: more };
    }
    const g = await blendedSearch(c, q);
    if (stale()) return null;
    return g ? { list: users(g.users) } : { error: true, list: [] };
  }
  // Keyword grid: posts and Reels, and hashtags, which Instagram now shows the same way.
  async function loadKeyword(q, cursor) {
    const session = (cursor && cursor.session) || uuid();
    const vars = { query: q, search_session_id: session, serp_session_id: session };
    const c = cursor && cursor.after
      ? await igGraphQL('PolarisKeywordSearchExplorePageRelayPaginationQuery', Object.assign(vars, { first: 24, after: cursor.after }), 'xdt_fbsearch__top_serp_graphql')
      : await igGraphQL('PolarisKeywordSearchExplorePageRelayQuery', vars, 'xdt_fbsearch__top_serp_graphql');
    if (!c) return null;
    const units = (c.edges || []).map(e => e && e.node).filter(n => n && Array.isArray(n.items));
    const next = nextCursor(c, cursor);
    return { media: collectMedia(units.map(n => n.items)), more: next ? { after: next, session: session } : null };
  }
  // The next page's cursor, unless Instagram has no more or sent back the one we gave it.
  function nextCursor(c, cursor) {
    const pi = c.page_info || {};
    return pi.has_next_page && pi.end_cursor && pi.end_cursor !== (cursor && cursor.after) ? pi.end_cursor : null;
  }
  async function loadPosts(q, cursor) {
    return loadKeyword(q, cursor);
  }
  function sectionsForm(tab, cursor) {
    const form = { tab: tab, surface: 'grid', include_persistent: '0' };
    if (cursor) {
      form.max_id = cursor.max_id || '';
      if (cursor.page != null) form.page = String(cursor.page);
      if (cursor.media_ids) form.next_media_ids = JSON.stringify(cursor.media_ids.map(String));
    }
    return form;
  }
  async function loadTag(view, cursor) {
    const name = view.id.replace(/^#/, '');
    const path = '/api/v1/tags/' + encodeURIComponent(name) + '/sections/';
    if (view.sub === 'recent') {
      // The website dropped Recent for hashtags; the old list still answers
      // for some tags, but it isn't strictly newest first. One try per
      // session: once it fails, say so without asking again.
      if (!cursor && dead.has('tags/sections recent')) return { media: [], more: null, noRecent: true, unordered: true };
      if (!cursor) searchStats.tagRecent.asked++;
      const part = await igPost(path, sectionsForm('recent', cursor));
      if (!part && !cursor) { searchStats.tagRecent.failed++; markDead('tags/sections recent'); }
      const media = part ? collectMedia(part.sections || []) : [];
      if (cursor) return part ? { media: media, more: moreState(part), unordered: true } : null;
      return { media: media, more: media.length ? moreState(part) : null, noRecent: !media.length, unordered: true };
    }
    if (cursor && cursor.rest) {
      const part = await igPost(path, sectionsForm('top', cursor));
      if (!part) return null;
      const m = moreState(part);
      if (m) m.rest = true;
      return { media: collectMedia(part.sections || []), more: m };
    }
    // The old tag page, while it still answers with posts in this session.
    let probed = false;
    if (!cursor && !dead.has('tags/web_info')) {
      probed = true;
      const meta = {};
      const data = await igGet('/api/v1/tags/web_info/?tag_name=' + encodeURIComponent(name), meta);
      searchStats.tagWebInfo = meta.status || 0;
      const body = data && (data.data || data);
      const top = body && body.top;
      if (body && body.media_count != null) view.count = body.media_count;
      const media = top ? collectMedia(top.sections || []) : [];
      if (media.length) {
        searchStats.tagGrid.webInfo++;
        const m = moreState(top);
        if (m) m.rest = true;
        return { media: media, more: m };
      }
      // Gone (404) or answering without a top list: keyword results from now on.
      // A network blip, a 429 or a 5xx is not remembered.
      const code = meta.status || 0;
      if (code === 404 || (code >= 200 && code < 300 && !top)) markDead('tags/web_info');
    }
    // What the website itself shows for a hashtag now.
    if (!cursor) searchStats.tagGrid.keyword++;
    const r = await loadKeyword('#' + name, cursor);
    // The probe was this tap's first request: no chained page after this one.
    if (r && probed) r.spent = 2;
    return r;
  }
  // A place's name and address, when the row it was opened from had none.
  function placeHeader(view) {
    igGraphQL('PolarisExploreLocationsContainerQuery', { location_id_str: String(view.id), show_nearby: false }, 'xdt_location_get_web_info').then(safe(h => {
      const li = h && h.native_location_data && h.native_location_data.location_info;
      if (!li) return;
      view.name = li.name || view.name;
      view.address = [li.location_address, li.location_city].filter(Boolean).join(', ') || view.address || '';
      if (li.slug) view.slug = li.slug;
      const tx = search.view === view && search.wrap && search.wrap.querySelector('.head .tx');
      if (!tx) return;
      tx.textContent = '';
      tx.appendChild(el('div', 'htitle', view.name || ''));
      if (view.address) tx.appendChild(el('div', 'hsub', view.address));
    }));
  }
  // The requests Instagram's own place page makes (Top is "ranked").
  // `first` is the page size (Relay's count; the website sends 12). Ask for
  // PLACE_PAGE; if Instagram refuses that request, ask again at the website's
  // 12 in the same tap, and keep 12 only when that answers (the tap then
  // chains a second page instead). A throttle or a stale id says nothing
  // about the page size: no second request then.
  let placeFirst = PLACE_PAGE;
  function sizeMayBeRefused(name) {
    const last = gqlLog[gqlLog.length - 1];
    if (!last || last.query !== name || last.code == null || last.wait) return false;
    return last.code !== 1675002 && !/PersistedQueryNotFound|missing_required_variable/i.test(last.message || '');
  }
  async function loadPlace(view, cursor, left) {
    const tab = view.sub === 'recent' ? 'recent' : 'ranked';
    const id = String(view.id);
    if (!cursor && (!view.name || !view.address) && !view.headerAsked) { view.headerAsked = true; placeHeader(view); }
    const name = cursor ? 'PolarisLocationPageTabContentQuery_connection' : 'PolarisLocationPageTabContentQuery';
    const ask = first => (cursor
      ? igGraphQL(name, { after: cursor.after, first: first, location_id: id, page_size_override: null, tab: tab }, 'xdt_location_get_web_info_tab')
      : igGraphQL(name, { location_id: id, first: first, after: null, tab: tab, page_size_override: null }, 'xdt_location_get_web_info_tab'));
    const first = placeFirst;
    let c = await ask(first), spent = 1;
    if (!c && first > 12 && (left == null || left >= 2) && sizeMayBeRefused(name)) {
      spent = 2;
      c = await ask(12);
      if (c) searchStats.grid.placeFirst = placeFirst = 12;
    }
    if (!c) return null;
    const media = collectMedia((c.edges || []).map(e => e && e.node));
    const next = nextCursor(c, cursor);
    return { media: media, more: next ? { after: next } : null, noRecent: tab === 'recent' && !media.length && !cursor, spent: spent };
  }
  async function loadTagOrPlace(view, cursor, left) {
    return view.kind === 'tag' ? loadTag(view, cursor) : loadPlace(view, cursor, left);
  }

  /* Recent searches */
  // Recent searches belong to the signed-in account, not to the phone.
  function recentKey() { return RECENT_KEY + ':' + (viewerId() || 'anon'); }
  function recents() {
    try {
      const old = localStorage.getItem(RECENT_KEY);   // 1.2 kept one list for every account
      if (old !== null) {
        localStorage.removeItem(RECENT_KEY);
        if (viewerId() && localStorage.getItem(recentKey()) === null) localStorage.setItem(recentKey(), old);
      }
      return JSON.parse(localStorage.getItem(recentKey()) || '[]').slice(0, 15);
    } catch (e) { return []; }
  }
  function remember(item) {
    try {
      const list = recents().filter(x => !(x.kind === item.kind && x.id === item.id));
      list.unshift(item);
      localStorage.setItem(recentKey(), JSON.stringify(list.slice(0, 15)));
    } catch (e) { /* ignore */ }
  }

  /* Screen */
  const SEARCH_CSS = `
    :host{all:initial}
    .wrap{position:fixed;left:0;right:0;top:0;bottom:var(--sg-bottom,0px);z-index:2147483000;display:flex;flex-direction:column;
      background:#fff;color:#000;font:14px -apple-system,system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-tap-highlight-color:transparent}
    .bar{display:flex;align-items:center;gap:8px;padding:10px 12px 6px}
    .field{flex:1;display:flex;align-items:center;gap:8px;background:#efefef;border-radius:10px;padding:0 10px;height:38px}
    .field svg{flex:none;opacity:.55}
    input{flex:1;border:0;outline:0;background:transparent;font:inherit;font-size:16px;color:inherit;min-width:0}
    input::-webkit-search-cancel-button{display:none}
    .clear{border:0;background:#c7c7c7;color:#fff;width:18px;height:18px;border-radius:50%;font-size:11px;line-height:18px;padding:0;display:none}
    .cancel{border:0;background:none;font:inherit;font-weight:600;color:inherit;padding:6px 2px}
    .tabs{display:flex;border-bottom:1px solid #dbdbdb}
    .tab{flex:1;border:0;background:none;font:inherit;font-weight:600;color:#737373;padding:11px 2px;border-bottom:1px solid transparent;margin-bottom:-1px;white-space:nowrap}
    .tab.on{color:inherit;border-bottom-color:currentColor}
    .head{display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid #dbdbdb}
    .back{border:0;background:none;font:inherit;font-size:22px;line-height:1;color:inherit;padding:2px 8px 2px 0}
    .htitle{font-weight:700;font-size:16px}.hsub{color:#737373;font-size:12px}
    .seg{display:flex;margin:10px 12px 6px;background:#efefef;border-radius:9px;padding:2px}
    .seg button{flex:1;border:0;background:none;font:inherit;font-weight:600;padding:7px;border-radius:8px;color:#737373}
    .seg button.on{background:#fff;color:#000;box-shadow:0 1px 2px rgba(0,0,0,.15)}
    .body{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}
    .row{display:flex;align-items:center;gap:12px;padding:8px 14px;width:100%;border:0;background:none;font:inherit;color:inherit;text-align:left}
    .row:active{background:rgba(0,0,0,.05)}
    .av{width:44px;height:44px;border-radius:50%;object-fit:cover;background:#efefef;flex:none}
    .ic{width:44px;height:44px;border-radius:50%;border:1px solid #dbdbdb;display:flex;align-items:center;justify-content:center;flex:none;font-size:20px}
    .t1{font-weight:600;display:flex;align-items:center;gap:4px}.t2{color:#737373;font-size:13px;margin-top:1px}
    .tx{min-width:0;overflow:hidden}.tx div{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:2px}
    .cell{position:relative;aspect-ratio:3/4;background:#efefef;border:0;padding:0;overflow:hidden}
    .cell img{width:100%;height:100%;object-fit:cover;display:block}
    .badge{position:absolute;top:6px;right:6px;color:#fff;font-size:13px;text-shadow:0 0 3px rgba(0,0,0,.6)}
    .msg{color:#737373;text-align:center;padding:28px 24px;line-height:1.4}
    .more,.link{display:block;margin:14px auto 22px;border:0;border-radius:9px;background:#efefef;color:inherit;font:inherit;font-weight:600;padding:9px 18px}
    .link{background:none;color:#0095f6}
    .label{font-weight:700;font-size:16px;padding:14px 14px 6px}
    .wrap.leaving>*{opacity:.35;pointer-events:none;transition:opacity .15s}
    .wrap.leaving::after{content:"";position:absolute;left:50%;top:40%;width:28px;height:28px;margin:-14px;border:3px solid #dbdbdb;border-top-color:#737373;border-radius:50%;animation:s .8s linear infinite}
    .spin{width:22px;height:22px;margin:28px auto;border:2px solid #dbdbdb;border-top-color:#737373;border-radius:50%;animation:s .8s linear infinite}
    @keyframes s{to{transform:rotate(360deg)}}
    @media (prefers-color-scheme:dark){
      .wrap{background:#000;color:#f5f5f5}.field,.seg,.more,.cell,.av{background:#262626}
      .tabs,.head{border-color:#262626}.ic{border-color:#363636}.seg button.on{background:#000;color:#f5f5f5}
      .row:active{background:rgba(255,255,255,.06)}.clear{background:#555}.spin,.wrap.leaving::after{border-color:#363636;border-top-color:#a8a8a8}
    }`;
  const ICON_SEARCH = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><circle cx="11" cy="11" r="7.5"/><path d="M16.5 16.5 22 22" stroke-linecap="round"/></svg>';
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function navHeight() {
    const a = document.querySelector('a[href="/direct/inbox/"],a[href="/"]');
    let n = a;
    for (let i = 0; n && i < 10; i++, n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.position === 'fixed') {
        const r = n.getBoundingClientRect();
        return r.top > innerHeight / 2 ? Math.max(0, innerHeight - r.top) : 0;
      }
    }
    return 0;
  }
  function buildSearch() {
    if (search.host) return;
    const host = document.createElement('div');
    host.id = 'sg-search';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = SEARCH_CSS;
    root.appendChild(style);
    const wrap = el('div', 'wrap');
    root.appendChild(wrap);
    (document.body || document.documentElement).appendChild(host);
    search.host = host;
    search.root = root;
    search.wrap = wrap;
  }
  function saveSearch() {
    try {
      sessionStorage.setItem(SEARCH_STATE, JSON.stringify({
        tab: search.tab, query: search.query, view: search.view, returnUrl: search.returnUrl, token: search.token,
        results: search.results, posts: search.posts, grid: search.grid,
        scroll: search.body ? search.body.scrollTop : 0, suspended: search.suspended, at: Date.now(),
      }));
    } catch (e) { clearSaved(); }           // storage full (a very long grid): never restore an older copy
  }
  function clearSaved() { try { sessionStorage.removeItem(SEARCH_STATE); } catch (e) { /* ignore */ } }

  function render() {
    const w = search.wrap;
    w.style.setProperty('--sg-bottom', navHeight() + 'px');
    dropGrid(search.body);             // the old list goes; its picture watcher with it
    w.textContent = '';
    if (search.view) return renderView(w);
    const bar = el('div', 'bar');
    const field = el('label', 'field');
    field.innerHTML = ICON_SEARCH;
    const input = el('input');
    input.type = 'search';
    input.placeholder = 'Search';
    input.enterKeyHint = 'search';
    input.autocomplete = 'off';
    input.value = search.query;
    const clear = el('button', 'clear', '✕');
    clear.style.display = search.query ? 'block' : 'none';
    field.append(input, clear);
    const cancel = el('button', 'cancel', 'Cancel');
    bar.append(field, cancel);
    const tabs = el('div', 'tabs');
    for (const [key, label] of TABS) {
      const b = el('button', 'tab' + (search.tab === key ? ' on' : ''), label);
      b.onclick = () => { search.tab = key; render(); runQuery(); };
      tabs.appendChild(b);
    }
    const body = el('div', 'body');
    body.addEventListener('scroll', noteScroll, { passive: true });   // B25: the drag check sees this list scroll
    search.body = body;
    w.append(bar, tabs, body);
    input.addEventListener('input', () => {
      search.query = input.value;
      clear.style.display = input.value ? 'block' : 'none';
      clearTimeout(search.timer);
      search.timer = setTimeout(() => runQuery(), 400);
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { input.blur(); clearTimeout(search.timer); runQuery(); }
    });
    clear.onclick = e => { e.preventDefault(); search.query = ''; search.posts = null; render(); focusInput(); };
    cancel.onclick = () => closeSearch(true);
    search.input = input;
    renderBody();
  }
  function focusInput() {
    if (search.input) { search.input.focus(); const n = search.input.value.length; search.input.setSelectionRange(n, n); }
  }
  function renderBody() {
    const body = search.body;
    if (!body) return;
    dropGrid(body);
    body.textContent = '';
    const q = search.query.trim();
    if (!q) {
      const items = recents();
      if (!items.length) { body.appendChild(el('div', 'msg', 'Search for people, posts, Reels, tags and places.')); return; }
      body.appendChild(el('div', 'label', 'Recent'));
      for (const it of items) body.appendChild(resultRow(it));
      return;
    }
    if (search.tab === 'posts') {
      if (!search.posts || search.posts.q !== q) { body.appendChild(el('div', 'spin')); return; }
      return renderGrid(body, search.posts, () => runPosts(true), q);
    }
    const res = search.results[topKey()];
    if (!res) {
      body.appendChild(el('div', 'spin'));
      if (search.pending !== topKey()) setTimeout(runTop, 0);   // nothing on its way: ask
      return;
    }
    if (res.error) return renderFailure(body, q);
    const top = { users: [], tags: [], places: [] };
    top[search.tab === 'accounts' ? 'users' : search.tab] = res.list;
    let items = [];
    if (search.tab === 'accounts') items = top.users.map(u => ({ kind: 'user', id: u.username, title: u.username, sub: u.full_name || '', pic: u.profile_pic_url || '', verified: !!u.is_verified }));
    if (search.tab === 'tags') items = top.tags.map(h => ({ kind: 'tag', id: h.name, title: '#' + h.name, sub: h.media_count != null ? Number(h.media_count).toLocaleString() + ' posts' : 'Hashtag' }));
    if (search.tab === 'places') items = top.places.map(p => ({ kind: 'place', id: p.id, title: p.name, sub: p.sub, slug: p.slug }));
    if (!items.length) {
      body.appendChild(el('div', 'msg', 'No ' + TABS.find(t => t[0] === search.tab)[1].toLowerCase() + ' found for “' + q + '”.'));
      return;
    }
    for (const it of items) body.appendChild(resultRow(it));
  }
  function resultRow(it) {
    const row = el('button', 'row');
    if (it.kind === 'user') {
      const img = el('img', 'av');
      img.alt = '';
      img.referrerPolicy = 'origin';
      if (it.pic) img.src = it.pic;
      row.appendChild(img);
    } else {
      row.appendChild(el('div', 'ic', it.kind === 'tag' ? '#' : it.kind === 'place' ? '\u{1F4CD}' : '\u{1F50E}'));
    }
    const tx = el('div', 'tx');
    const t1 = el('div', 't1', it.title);
    if (it.verified) { const v = el('span', '', '✔︎'); v.style.cssText = 'color:#0095f6;font-size:11px'; t1.appendChild(v); }
    tx.appendChild(t1);
    if (it.sub) tx.appendChild(el('div', 't2', it.sub));
    row.appendChild(tx);
    row.onclick = () => pick(it);
    return row;
  }
  function pick(it) {
    remember(it);
    if (it.kind === 'user') return openPath('/' + encodeURIComponent(it.id) + '/');
    if (it.kind === 'tag' || it.kind === 'place') {
      search.view = { kind: it.kind, id: it.id, name: it.title, address: it.sub, slug: it.slug || '', sub: 'top' };
      search.grid = null;
      render();
      runGrid(false);
      return;
    }
    if (it.kind === 'query') { search.query = it.id; render(); runQuery(); }
  }
  function renderView(w) {
    const v = search.view;
    const head = el('div', 'head');
    const back = el('button', 'back', '‹');
    back.onclick = () => { search.view = null; search.grid = null; render(); };
    const tx = el('div', 'tx');
    tx.appendChild(el('div', 'htitle', v.kind === 'tag' ? (v.name.startsWith('#') ? v.name : '#' + v.name) : v.name));
    const sub = v.kind === 'tag' ? (v.count != null ? Number(v.count).toLocaleString() + ' posts' : '') : (v.address || '');
    if (sub) tx.appendChild(el('div', 'hsub', sub));
    head.append(back, tx);
    const seg = el('div', 'seg');
    for (const [key, label] of [['top', 'Top'], ['recent', 'Most recent']]) {
      const b = el('button', v.sub === key ? 'on' : '', label);
      b.onclick = () => { if (v.sub === key) return; v.sub = key; search.grid = null; render(); runGrid(false); };
      seg.appendChild(b);
    }
    const body = el('div', 'body');
    body.addEventListener('scroll', noteScroll, { passive: true });
    search.body = body;
    w.append(head, seg, body);
    renderGrid(body, search.grid, () => runGrid(true), null);
  }
  // Thumbnails load as they come within a few screens of the list's view and
  // are let go once they are further away, so a grid hundreds of posts long
  // keeps only a screenful or two of pictures in memory. Cells keep their size.
  let liveWatchers = 0;     // picture watchers not yet let go (diagnostics: a leak shows here)
  function thumbWatcher(body) {
    if (typeof IntersectionObserver !== 'function') return null;
    try {
      const io = new IntersectionObserver(safe(entries => {
        for (const e of entries) {
          const img = e.target.firstChild;
          if (!img || img.tagName !== 'IMG') continue;
          if (e.isIntersecting) { if (img.getAttribute('src') !== img.dataset.src) img.src = img.dataset.src; }
          else if (img.hasAttribute('src')) img.removeAttribute('src');
        }
      }), { root: body, rootMargin: '1600px 0px' });
      liveWatchers++;
      return io;
    } catch (e) { return null; }
  }
  // A list's grid is going (a new search, a new tab, a re-render): its watcher
  // stops, or the detached grid keeps it (and its hundreds of cells) alive.
  function dropGrid(body) {
    const g = body && body.sgGrid;
    if (!g) return;
    if (g.io) { g.io.disconnect(); g.io = null; liveWatchers--; }
    body.sgGrid = null;
  }
  function addCells(g, list) {
    for (let i = g.n; i < list.length; i++) {
      const m = list[i];
      const cell = el('button', 'cell');
      const img = el('img');
      img.alt = '';
      img.decoding = 'async';
      img.dataset.src = m.thumb;
      if (g.io) g.io.observe(cell);
      else { img.loading = 'lazy'; img.src = m.thumb; }
      cell.appendChild(img);
      if (m.reel || m.multi) cell.appendChild(el('span', 'badge', m.reel ? '▶︎' : '❐'));
      cell.onclick = () => openPath(m.path);
      g.grid.appendChild(cell);
    }
    g.n = list.length;
  }
  // Below the grid: a spinner while a page loads, Show more, or Try again
  // after a page that failed (the posts already shown stay).
  function gridFoot(foot, state, more) {
    foot.textContent = '';
    if (state.loading) foot.appendChild(el('div', 'spin'));
    else if (state.more && state.failed) {
      foot.appendChild(el('div', 'msg', 'Instagram didn’t send the next posts.'));
      const b = el('button', 'more', 'Try again');
      b.onclick = more;
      foot.appendChild(b);
    } else if (state.more) {
      const b = el('button', 'more', 'Show more');
      b.onclick = more;
      foot.appendChild(b);
    }
  }
  function renderGrid(body, state, more, q) {
    // The same list, longer: add only the new cells, so a long grid isn't
    // rebuilt on every tap and keeps its scroll position.
    const g = body.sgGrid;
    if (g && state && g.state === state && !state.error && state.media.length >= g.n && g.unordered === !!state.unordered) {
      addCells(g, state.media);
      gridFoot(g.foot, state, more);
      return;
    }
    dropGrid(body);
    body.textContent = '';
    if (!state || state.loading && !state.media.length) { body.appendChild(el('div', 'spin')); return; }
    if (state.error) return renderFailure(body, q);
    if (state.noRecent && !state.media.length) {
      body.appendChild(el('div', 'msg', search.view && search.view.kind === 'tag'
        ? 'Instagram no longer shows most recent posts for hashtags. Top is all it offers now.'
        : 'Instagram isn\u2019t showing most recent posts here right now. Try Top.'));
      return;
    }
    if (state.unordered && state.media.length) {
      body.appendChild(el('div', 'msg', 'Instagram\u2019s recent list for hashtags isn\u2019t strictly newest first.'));
    }
    if (!state.media.length) { body.appendChild(el('div', 'msg', 'No posts found.')); return; }
    const ng = { state: state, unordered: !!state.unordered, grid: el('div', 'grid'), foot: el('div'), n: 0, io: thumbWatcher(body) };
    addCells(ng, state.media);
    body.append(ng.grid, ng.foot);
    body.sgGrid = ng;
    gridFoot(ng.foot, state, more);
  }
  function renderFailure(body, q) {
    body.appendChild(el('div', 'msg', 'Instagram didn’t return results here.'));
    // Asks once more, from scratch (the request id is looked up again too).
    const again = el('button', 'more', 'Try again');
    again.onclick = safe(() => {
      if (search.view) { search.grid = null; runGrid(false); return; }
      if (search.tab === 'posts') { search.posts = null; runPosts(false); return; }
      delete search.results[topKey()];
      runTop();
    });
    body.appendChild(again);
    const fallback = search.view
      ? (search.view.kind === 'tag'
        ? '/explore/search/keyword/?q=' + encodeURIComponent('#' + search.view.id.replace(/^#/, ''))
        : '/explore/locations/' + encodeURIComponent(search.view.id) + '/' + (search.view.slug ? search.view.slug + '/' : '') + (search.view.sub === 'recent' ? 'recent/' : ''))
      : '/explore/search/keyword/?q=' + encodeURIComponent(q || search.query);
    const b = el('button', 'link', 'Open Instagram’s own page');
    b.onclick = () => openPath(fallback);
    body.appendChild(b);
  }
  // Posts not in the grid yet, each once (pages can overlap, chained or not).
  // Keyed by the post's code, whether it opens as a post or a Reel.
  function postKey(m) { return m.path.replace(/^\/(?:p|reel)\//, ''); }
  function addNew(have, more) {
    const seen = new Set(have.map(postKey));
    return have.concat(more.filter(m => !seen.has(postKey(m)) && seen.add(postKey(m))));
  }
  function slim(list) {
    return list.map(m => ({
      path: postPath(m), thumb: thumbOf(m),
      reel: m.product_type === 'clips' || m.media_type === 2, multi: Array.isArray(m.carousel_media) && m.carousel_media.length > 1,
    })).filter(m => m.thumb);
  }
  function topKey() { return search.tab + '\n' + search.query.trim(); }
  async function runQuery() {
    const q = search.query.trim();
    if (!q) { renderBody(); return; }
    if (search.tab === 'posts') {
      if (!search.posts || search.posts.q !== q) runPosts(false);
      else renderBody();
      return;
    }
    runTop();
  }
  async function runTop() {
    const q = search.query.trim(), tab = search.tab, key = topKey();
    if (!q || tab === 'posts' || search.results[key] || search.pending === key) { renderBody(); return; }
    const seq = ++search.seqTop;
    search.pending = key;
    renderBody();
    const res = await loadTab(tab, q, () => seq !== search.seqTop || search.query.trim() !== q);
    if (search.pending === key) search.pending = null;
    if (!res) return;                                   // you typed something else
    search.results[key] = res;
    const keys = Object.keys(search.results);
    if (keys.length > 60) delete search.results[keys[0]];
    if (!search.view && topKey() === key) renderBody();
  }
  // One tap's worth of a grid (opening it, Show more or Try again): a page,
  // and when it brought fewer than CHAIN_BELOW new posts and Instagram has
  // more, the next page right after it. Never more than 2 requests a tap:
  // `load(cursor, left)` is told how many it may send and reports `spent`
  // when a page took more than one (a tag's old-page probe, a place's 12
  // retry). Nothing loads without a tap. `alive()` is false once you have
  // left this grid; closing search (Cancel, an Instagram tab) stops the chain.
  // A failed page keeps every post already shown, and its cursor for Try again.
  async function fillGrid(st, load, alive, draw) {
    const gs = searchStats.grid;
    gs.taps++;
    st.failed = false;
    let fresh = !st.pages;                                 // opening the grid: its first draw is a full one
    let spent = 0;
    for (let n = 0; n < 2; n++) {
      if (n) gs.chained++;
      const res = await load(st.pages ? st.more : null, 2 - spent);
      if (!alive()) return;
      if (!res) {
        if (n) gs.chainFailed++; else gs.failed++;
        if (!st.media.length) st.error = true; else st.failed = true;
        break;
      }
      const had = st.media.length;
      st.media = addNew(st.media, slim(res.media));
      const added = st.media.length - had;
      st.more = added ? res.more : null;                   // a page that adds nothing ends the list
      st.pages++; st.noRecent = !!res.noRecent; st.unordered = !!res.unordered;
      gs.pages++;
      gs.sizes.push(added);
      if (gs.sizes.length > 10) gs.sizes.shift();
      spent += res.spent || 1;
      if (!st.more || added >= CHAIN_BELOW || spent >= 2 || !search.open) break;
      draw(fresh);                                         // show this page while the next one loads
      fresh = false;
    }
    st.loading = false;
    draw(fresh);
  }
  async function runPosts(more) {
    const q = search.query.trim();
    if (!q) return;
    let st = search.posts;
    if (!more || !st || st.q !== q) st = search.posts = { q: q, media: [], more: null, pages: 0, loading: true };
    else { if (!st.more || st.loading) return; st.loading = true; }
    // Later pages refill only the grid, so the list keeps its scroll position.
    const shown = () => search.tab === 'posts' && !search.view && search.posts === st;
    const draw = () => { if (!shown()) return; if (search.body && search.body.sgGrid) renderGrid(search.body, st, () => runPosts(true), q); else renderBody(); };
    if (more) draw(); else renderBody();
    const seq = ++search.seqPosts;
    await fillGrid(st, cursor => loadPosts(q, cursor), () => seq === search.seqPosts && search.posts === st, draw);
  }
  async function runGrid(more) {
    const v = search.view;
    if (!v) return;
    let st = search.grid;
    if (!more || !st) st = search.grid = { media: [], more: null, pages: 0, loading: true };
    else { if (!st.more || st.loading) return; st.loading = true; }
    // The first page redraws the whole view (a tag's header learns its post
    // count); later ones refill only the grid, so the list keeps its scroll.
    const draw = full => { if (!full && search.body) renderGrid(search.body, st, () => runGrid(true), null); else render(); };
    draw(!more);
    const seq = ++search.seqGrid;
    await fillGrid(st, (cursor, left) => loadTagOrPlace(v, cursor, left), () => seq === search.seqGrid && search.grid === st && search.view === v, draw);
  }

  // Open a profile/post from search. Try Instagram's in-app navigation;
  // if Instagram doesn't draw the new page, load it normally. Back to the
  // page search was opened from brings search back as you left it.
  let openTimer = 0, syntheticPop = false, leaving = null, calledOff = null;
  function pageSig() {
    const m = document.querySelector('main') || document.body;
    let txt = '';
    if (m) {
      // A bounded walk: after a long scroll Home's text is huge.
      const w = document.createTreeWalker(m, NodeFilter.SHOW_TEXT);
      while (txt.length < 400 && w.nextNode()) txt += w.currentNode.nodeValue;
    }
    // Instagram's DocumentTitle.badge() adds "(3) " for unread counts: not a new page.
    return document.title.replace(/^\(\d+\+?\)\s*/, '') + '|' + txt.slice(0, 400);
  }
  // An Instagram module that is already running (window.require, Meta's
  // module system). ifRequired never throws or loads anything; a missing or
  // renamed module just means "not available".
  function runningModule(name) {
    try {
      const req = window.require;
      if (typeof req !== 'function') return null;
      const ifRequired = req('ifRequired');
      if (typeof ifRequired !== 'function') return null;
      let out = null;
      ifRequired(name, m => { out = m || null; }, () => {});
      return out;
    } catch (e) { return null; }
  }
  // NO_ACTIVE_NAVIGATION | GOIMPL_TRIGGERED | FETCHING_ROUTE | REACT_PENDING, or null if unknown.
  function igRouterStatus() {
    try {
      const m = runningModule('currentCometRouterInstance');
      const r = m && typeof m.get_THIS_IS_NOT_WHAT_YOU_WANT === 'function' && m.get_THIS_IS_NOT_WHAT_YOU_WANT();
      const s = r && typeof r.getCurrentRouterStatus === 'function' ? r.getCurrentRouterStatus() : null;
      return typeof s === 'string' ? s : null;
    } catch (e) { return null; }
  }
  // The call Instagram's own openURL() makes for in-app links.
  function igPush(path) {
    try {
      const m = runningModule('browserHistory_DO_NOT_USE');
      if (!m || !m.browserHistory || typeof m.browserHistory.push !== 'function') return false;
      if (typeof m.getCometRouterDispatcher === 'function' && !m.getCometRouterDispatcher()) return false;
      m.browserHistory.push(path);
      return true;
    } catch (e) { return false; }
  }
  // Media that was on the page when a result was tapped (usually Home's) and
  // is still there under the cover: never started or unmuted meanwhile.
  function isOldMedia(v) { return !!(leaving && leaving.oldMedia.has(v)); }
  // Instagram (not us) wrote history while a result opens: it picked the open up.
  function noteHistoryWrite() {
    if (leaving && !leaving.self && !leaving.ack) leaving.ack = Date.now();
  }
  function coverSearch(on) {
    if (search.wrap) search.wrap.classList.toggle('leaving', !!on);
  }
  // The opened post's own picture or video, not one that was already there.
  function hasNewMedia(l) {
    for (const m of document.querySelectorAll('main video,main img[srcset],main img[src*="cdninstagram"],article video,article img[srcset]')) {
      if (!l.oldMedia.has(m)) return true;
    }
    return false;
  }
  function armWatch(ms) {
    clearTimeout(openTimer);
    openTimer = setTimeout(safe(watchLeaving), ms);
  }
  // A new mark on the current entry (Instagram's own key kept): Back to it brings search back.
  function markSearch() {
    search.token = String(Date.now()) + Math.random().toString(16).slice(2, 6);
    search.suspended = true;
    try { nativeReplace.call(history, Object.assign({}, history.state || {}, { sgSearch: search.token }), ''); } catch (e) { /* ignore */ }
  }
  function dropMark() {
    try { const st = Object.assign({}, history.state); delete st.sgSearch; nativeReplace.call(history, st, ''); } catch (e) { /* ignore */ }
    search.suspended = false;
  }

  // How results opened, for Filter status. Kept for the tab's session, so a
  // full load (which starts a new page) is counted too.
  const OPENS_KEY = 'sg_search_opens';
  const opens = (stats.searchOpens = { router: 0, popstate: 0, samePage: 0, fullLoad: 0, cancelled: 0, lastMs: 0, lastVia: '' });
  function saveOpens(extra) {
    try { sessionStorage.setItem(OPENS_KEY, JSON.stringify(Object.assign({}, opens, extra || {}))); } catch (e) { /* ignore */ }
  }
  function countOpen(key) { opens[key]++; saveOpens(); }
  function loadOpens() {
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(OPENS_KEY) || 'null'); } catch (e) { saved = null; }
    if (!saved || typeof saved !== 'object') return;
    for (const k in opens) if (typeof saved[k] === typeof opens[k]) opens[k] = saved[k];
    // A full load we started: time it to when this new page has loaded.
    const at = Number(saved.pendingAt) || 0;
    if (!at) return;
    saveOpens();                              // timed once
    if (Date.now() - at > 60000) return;
    const done = safe(() => requestAnimationFrame(safe(() => { opens.lastMs = Date.now() - at; saveOpens(); })));
    if (document.readyState === 'complete') done();
    else window.addEventListener('load', done, { once: true });
  }
  safe(loadOpens)();

  // Search stays on screen (dimmed, with a spinner) until Instagram has drawn
  // the new page, so whatever is underneath (usually Home) never shows in between.
  function openPath(path) {
    if (leaving) {
      // Back was pressed during the spinner and the results are showing:
      // a tap on another result replaces the called-off open.
      if (!leaving.abandoned || here() !== leaving.from) return;   // one open at a time
      endOpen();
      countOpen('cancelled');
    }
    const target = new URL(path, location.href);
    if (target.origin !== location.origin) { location.assign(target.href); return; }
    // The same page, or another tab (Reels, Tagged) of the same profile:
    // what is under the cover is that profile already.
    const tp = target.pathname, lp = location.pathname;
    if (target.pathname + target.search === here() ||
        (/^\/[^/]+\/$/.test(tp) && lp.startsWith(tp) && /^(?:reels|tagged)\/?$/.test(lp.slice(tp.length)))) return openSamePage(path);
    markSearch();
    if (search.body) search.lastScroll = search.body.scrollTop;
    saveSearch();
    leaving = {
      path: target.pathname + target.search, from: here(), before: pageSig(), at: Date.now(), via: '',
      drawnAt: 0, abandoned: false, sawBusy: false, ack: 0, self: false, unloading: false,
      oldMedia: new WeakSet(document.querySelectorAll('video,audio,img')),
    };
    coverSearch(true);
    // Instagram's router only when its state can be read (so a slow start
    // isn't mistaken for a dropped push); otherwise the older way. Never both.
    if (igRouterStatus() && igPush(leaving.path)) {
      leaving.via = 'router';
      countOpen('router');
      const st = igRouterStatus();
      if (st && st !== 'NO_ACTIVE_NAVIGATION') leaving.sawBusy = true;
    } else if (!popOpen()) return;
    armWatch(100);
  }
  // The result is the page search was opened over: nothing wrong can show,
  // so 1.1's way (a new entry, Instagram re-reads the address), and no reload.
  function openSamePage(path) {
    markSearch();
    saveSearch();
    hideSearch(false);
    countOpen('samePage');
    try {
      history.pushState(null, '', path);
      syntheticPop = true;
      window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    } catch (e) { /* ignore */ } finally { syntheticPop = false; }
  }
  // The older way in: put the address in place and tell Instagram's router,
  // which treats a history entry it doesn't know as "go to this address".
  function popOpen() {
    const l = leaving;
    try {
      l.self = true;
      history.pushState(null, '', l.path);
      l.self = false;
      syntheticPop = true;
      window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
      l.via = 'popstate';
      countOpen('popstate');
      return true;
    } catch (e) {
      l.self = false;
      fullLoad();
      return false;
    } finally {
      syntheticPop = false;
    }
  }
  function fullLoad() {
    const l = leaving;
    if (!l) return;
    clearTimeout(openTimer);
    l.via = 'fullLoad';
    l.unloading = true;
    opens.fullLoad++;
    opens.lastVia = 'fullLoad';
    saveOpens({ pendingAt: l.at });
    // Search stays drawn until the new page paints. If our own entry for the
    // target already exists, replace it so Back still lands on search.
    if (here() !== l.from) location.replace(l.path);
    else location.assign(l.path);
  }
  // The open is over (or called off): no watcher, no cover.
  function endOpen() {
    const l = leaving;
    // Called off before Instagram switched: its router may still finish the
    // open later; that late arrival is undone (lateArrival).
    calledOff = l && here() === l.from ? { path: l.path, from: l.from, until: Date.now() + 10000 } : null;
    leaving = null;
    clearTimeout(openTimer);
    coverSearch(false);
  }
  function sameTarget(a, b) {
    const code = p => { const m = /\/(?:p|reel|reels|tv)\/([^/?#]+)/.exec(p); return m ? m[1] : p; };
    return code(a) === code(b);
  }
  // Instagram finished an open that was called off: step back unseen.
  function lateArrival() {
    const c = calledOff;
    if (Date.now() > c.until) { calledOff = null; return false; }
    if (here() === c.from) return false;
    calledOff = null;
    if (!sameTarget(here(), c.path)) return false;
    // A feed was asked for on top of it (already counted as cancelled): a
    // step back would call that load off too, so the feed replaces the result.
    if (c.reload) { setTimeout(() => location.replace(c.reload), 0); return true; }
    countOpen('cancelled');
    setTimeout(() => history.back(), 0);
    return true;
  }
  function settle() {
    const l = leaving;
    calledOff = null;
    leaving = null;
    clearTimeout(openTimer);
    opens.lastMs = Date.now() - l.at;
    opens.lastVia = l.via;
    saveOpens();
    // Two frames, so the new page has painted before search goes.
    requestAnimationFrame(() => requestAnimationFrame(safe(() => {
      if (leaving) return;                    // another open started meanwhile
      coverSearch(false);
      if (search.open) hideSearch(false);
      safe(autoplay)();
    })));
  }
  // Every 100 ms while a result opens: has Instagram drawn the new page?
  function watchLeaving() {
    const l = leaving;
    if (!l || l.unloading) return;
    const now = Date.now(), age = now - l.at;
    const st = igRouterStatus();
    const busy = !!st && st !== 'NO_ACTIVE_NAVIGATION';
    if (busy) l.sawBusy = true;
    // Not "at the target": Instagram may rewrite it (/user/p/CODE/, /reel/).
    const moved = here() !== l.from;
    const drawn = moved && !busy && pageSig() !== l.before;
    if (drawn && !l.drawnAt) l.drawnAt = now;
    if (l.via === 'router' && !l.sawBusy && !l.ack && !moved && !busy && !l.abandoned && !l.docNav) {
      // Instagram's router didn't take the push (nothing started): the older way.
      if (popOpen()) armWatch(100);
      return;
    }
    if (l.abandoned) {
      // Back was pressed before Instagram switched: undo the switch unseen.
      if (moved) { endOpen(); countOpen('cancelled'); history.back(); return; }
      if ((!busy && age > 3000) || age > 10000) { endOpen(); countOpen('cancelled'); return; }
    } else if (drawn) {
      // A post or Reel also waits (a little) for its picture or video.
      const r = route();
      if ((r !== 'post' && r !== 'reel') || hasNewMedia(l) || now - l.drawnAt > 2500) return settle();
    } else if (!busy && !l.sawBusy && !l.ack && age > (st ? 800 : 2500)) {
      return fullLoad();                      // Instagram never picked it up
    } else if (!busy && age > 8000) {
      return fullLoad();                      // picked up, but nothing drawn
    } else if (age > 10000) {
      return fullLoad();                      // still busy after 10 s
    }
    armWatch(100);
  }
  // A full load (ours or Instagram's) leaves this page. If the WebView keeps
  // it in its back/forward cache and Back restores it, show the results again
  // instead of resuming the open.
  window.addEventListener('pagehide', safe(() => { if (leaving) { clearTimeout(openTimer); leaving.unloading = true; } }));
  window.addEventListener('pageshow', safe(e => {
    if (!e.persisted) return;
    fromBfcache = true;
    safe(loadOpens)();                       // the newer page may have counted since
    post('search', { open: !!search.open });  // the app's own flags may be stale
    post('route', { url: location.href, route: route() });
    if (!leaving) return;
    endOpen();
    if (search.open && history.state && history.state.sgSearch === search.token) dropMark();
  }));
  // Our own full load may still be on its way: call it off too.
  // Instagram may also have started a full load itself (beforeunload): only
  // then, never for a router navigation, whose requests window.stop() would abort.
  window.addEventListener('beforeunload', safe(() => { if (leaving) leaving.docNav = true; }));
  function stopFullLoad(l) {
    if (l.via === 'fullLoad' || l.docNav) { try { window.stop(); } catch (e) { /* ignore */ } }
  }
  // The open is called off for the page search was opened over: close search as before.
  function cancelToOrigin() {
    stopFullLoad(leaving);
    endOpen();
    countOpen('cancelled');
    hideSearch(false); search.suspended = false; clearSaved();
  }
  function leavingRouteChanged() {
    // Instagram switched the address (or a redirect did); the watcher decides
    // when the new page is drawn. Search stays up meanwhile.
    if (here() === leaving.from && !leaving.self) {
      // Instagram went (back) to the page search was opened from, e.g. its Home tab.
      cancelToOrigin();
      return;
    }
    armWatch(50);
  }
  // Instagram's tabs stay tappable below the cover. Its tab for the page
  // underneath (usually Home) may not change the address at all, so the tap
  // itself calls the open off; Instagram then handles the tap as usual.
  window.addEventListener('click', safe(e => {
    if (!leaving && e.isTrusted) calledOff = null;   // a later tap of yours is never undone
    if (!leaving || !e.isTrusted || !(e.target instanceof Element)) return;
    const a = e.target.closest('a[href]');
    if (!a) return;
    const u = new URL(a.href, location.href);
    if (u.origin === location.origin && u.pathname + u.search === leaving.from) cancelToOrigin();
  }), true);
  // Back (or the Search tab) while a result opens: back to the results.
  // Returns false when normal search Back should follow.
  function backFromOpen() {
    const l = leaving;
    stopFullLoad(l);
    if (here() !== l.from) {
      // Already switched: going back lands on the marked entry, where search is up.
      endOpen();
      countOpen('cancelled');
      history.back();
      return true;
    }
    if (!l.abandoned && !l.unloading) { l.abandoned = true; coverSearch(false); return true; }
    endOpen();
    countOpen('cancelled');
    return l.unloading;
  }
  function showSearch() {
    buildSearch();
    search.host.style.display = '';
    search.open = true;
    // Nothing keeps playing (or keeps the screen on) behind search.
    search.paused = [];
    for (const m of document.querySelectorAll('video,audio')) {
      if (!m.paused) { m.pause(); search.paused.push(m); }
    }
    post('search', { open: true });
    safe(checkFeedEnd)(true);
  }
  function hideSearch(resume) {
    if (search.body) search.lastScroll = search.body.scrollTop;
    if (search.host) search.host.style.display = 'none';
    search.open = false;
    if (resume) for (const m of search.paused) if (m.isConnected) m.play().catch(() => {});
    search.paused = [];
    post('search', { open: false });
    safe(checkFeedEnd)(true);
  }
  function openSearch(fresh) {
    if (CFG.role !== 'main') return;
    if (leaving) { backFromOpen(); return; }  // Search tab tapped while a result opens: stay
    search.returnUrl = location.pathname + location.search;
    search.suspended = false;
    if (fresh) { search.view = null; search.grid = null; }
    showSearch();
    render();
    // Focus right away, while the tap still counts, so the keyboard opens.
    if (!search.view) focusInput();
    stats.searchOpened = (stats.searchOpened || 0) + 1;
  }
  function closeSearch(leaveExplore) {
    hideSearch(true);
    search.suspended = false;
    clearSaved();
    if (leaveExplore && route() === 'explore') {
      if (history.length > 1) history.back(); else location.assign('/');
    }
  }
  // Back: inside search first (a tag/place page → results → close).
  SG.back = () => {
    if (!search.open) return false;
    if (leaving && backFromOpen()) return true;
    if (search.view) { search.view = null; search.grid = null; render(); return true; }
    closeSearch(true);
    return true;
  };
  // Returning to the page search was opened from brings it back as you left it.
  function restoreSearch() {
    if (CFG.role !== 'main' || syntheticPop) return;
    if (search.open) {
      // Back on the marked entry while search is still up (Back during an open).
      if (!leaving && history.state && history.state.sgSearch === search.token) dropMark();
      return;
    }
    const mark = history.state && history.state.sgSearch;
    if (!mark) return;
    let saved = null;
    if (search.suspended && search.token === mark) saved = { scroll: search.lastScroll };
    else {
      try { saved = JSON.parse(sessionStorage.getItem(SEARCH_STATE) || 'null'); } catch (e) { saved = null; }
      if (!saved || !saved.suspended || saved.token !== mark || Date.now() - saved.at > 30 * 60 * 1000) return;
      Object.assign(search, { tab: saved.tab, query: saved.query, view: saved.view, results: saved.results || {}, posts: saved.posts, grid: saved.grid, returnUrl: saved.returnUrl, token: saved.token });
      for (const st of [search.posts, search.grid]) if (st && st.loading) st.loading = false;
      search.pending = null;
    }
    // Only this one time: later visits to the page don't reopen search.
    dropMark();
    showSearch();
    render();
    // A query edited just before the open (its debounce never fired) has no results yet.
    if (search.tab === 'posts' && !search.view) runQuery();
    const y = saved && saved.scroll;
    if (y && search.body) requestAnimationFrame(() => { search.body.scrollTop = y; });
  }
  // B25's rebuild: the app reads the search screen before it replaces the web
  // view (session storage may not come along) and hands it to the new page.
  // Stays inside the app; never part of the diagnostics.
  SG.searchState = () => {
    if (CFG.role !== 'main' || !search.open && !search.suspended) return null;
    return JSON.stringify({ open: !!search.open, suspended: !!search.suspended, tab: search.tab, query: search.query,
      view: search.view, returnUrl: search.returnUrl, token: search.token, results: search.results, posts: search.posts,
      grid: search.grid, scroll: search.body ? search.body.scrollTop : search.lastScroll || 0 });
  };
  function searchRestore(st) {
    // Search already up with something in it (the page's own restore got there first) stays.
    if (!st || typeof st !== 'object' || CFG.role !== 'main' || search.open && (search.query || search.view)) return;
    if (st.open) {
      Object.assign(search, { tab: TABS.some(t => t[0] === st.tab) ? st.tab : 'accounts', query: String(st.query || ''),
        view: st.view || null, results: st.results || {}, posts: st.posts || null, grid: st.grid || null,
        returnUrl: st.returnUrl || null, token: st.token || null, suspended: false });
      for (const s of [search.posts, search.grid]) if (s && s.loading) s.loading = false;
      search.pending = null;
      if (!search.open) showSearch();
      render();
      const y = st.scroll;
      if (y && search.body) requestAnimationFrame(() => { search.body.scrollTop = y; });
    } else if (st.suspended && st.token) {
      // A result opened from search: Back to the marked page brings search back.
      writeSession(SEARCH_STATE, Object.assign({}, st, { open: false, suspended: true, at: Date.now() }));
      restoreSearch();
    }
  }

  /* ------------------------------------------------------------------ *
   * Story hold while zoomed: keep the same Story; let a video loop.
   * ------------------------------------------------------------------ */
  const looped = new Set();
  function storyHold(on) {
    if (on) {
      setTimeout(safe(() => {
        const v = pickMedia(null, null);
        if (v && v.tagName === 'VIDEO') {
          if (!v.loop) { v.loop = true; looped.add(v); }
          if (v.paused) v.play().catch(() => {});
        }
      }), 250);
    } else {
      for (const v of looped) v.loop = false;
      looped.clear();
    }
  }

  /* ------------------------------------------------------------------ *
   * Diagnostics for Filter status: how long Stories take to show, whether
   * Instagram is slowing requests down, and long main-thread stalls.
   * Counts and timings only; everything is passive (no requests, no shims).
   * ------------------------------------------------------------------ */
  const diag = (stats.diag = { storyMs: [], storyVideos: 0, s429: 0, s5xx: 0, pleaseWait: 0, longTasks: 0, longestTask: 0,
    fullscreen: 0, fullscreenLast: '', fullVideo: fvStats, storySwitch: [], storySwitchSlow: 0, storyCancels: 0 });
  let storyStart = 0;
  // B19: switching people felt slow. Timed from a sideways swipe in Stories
  // to the address changing and to the next person's picture or video showing,
  // so Copy details shows whether the wait is Instagram's.
  let switchRun = null;
  // The Story picture or video in the middle of the screen, once it can be seen.
  function storyMediaKey() {
    for (const el of document.elementsFromPoint(innerWidth / 2, innerHeight / 2)) {
      if (el.tagName !== 'VIDEO' && el.tagName !== 'IMG') continue;
      if (el.dataset.sgOwn) return '';
      const r = el.getBoundingClientRect();
      if (r.width * r.height < innerWidth * innerHeight * 0.3) continue;
      const ready = el.tagName === 'VIDEO' ? el.readyState >= 2 : el.complete && el.naturalWidth > 0;
      return ready ? el.currentSrc || el.src || el.poster || '' : '';
    }
    return '';
  }
  function storySwitchStart(dir) {
    const run = { t0: performance.now(), dir: dir, from: storyMediaKey(), path: location.pathname, urlMs: -1 };
    switchRun = run;
    const done = ms => {
      if (switchRun === run) switchRun = null;
      if (ms < 0) { diag.storySwitchSlow++; return; }
      diag.storySwitch.push({ dir: run.dir, ms: ms, urlMs: run.urlMs });
      if (diag.storySwitch.length > 6) diag.storySwitch.shift();
    };
    // A light check every 50 ms (one hit test), for at most 4 s.
    const tick = safe(() => {
      if (switchRun !== run) return;
      const ms = Math.round(performance.now() - run.t0);
      noteStoryUrl();
      const key = route() === 'story' ? storyMediaKey() : '';
      if (key && key !== run.from) return done(ms);
      // No new address and nothing new: there was no one to go to.
      if (ms > 4000 || route() !== 'story') { if (switchRun === run) switchRun = null; if (run.urlMs >= 0 && route() === 'story') done(-1); return; }
      setTimeout(tick, 50);
    });
    setTimeout(tick, 50);
  }
  function noteStoryUrl() {
    const run = switchRun;
    if (run && run.urlMs < 0 && location.pathname !== run.path) run.urlMs = Math.round(performance.now() - run.t0);
  }
  function storyOpened() {
    storyStart = performance.now();
    diag.storyVideos = document.getElementsByTagName('video').length;
  }
  function storyShown(e) {
    if (!storyStart || route() !== 'story' || (e && e.target && e.target.dataset && e.target.dataset.sgOwn)) return;
    diag.storyMs.push(Math.round(performance.now() - storyStart));
    if (diag.storyMs.length > 5) diag.storyMs.shift();
    storyStart = 0;
  }
  if (CFG.role === 'main') {
    // Media events don't bubble; listen in the capture phase.
    document.addEventListener('playing', safe(storyShown), true);
    // Which pages ask the browser for full screen (Stories are suspected).
    document.addEventListener('fullscreenchange', safe(() => {
      const el = document.fullscreenElement;
      if (el) { diag.fullscreen++; diag.fullscreenLast = (el.tagName || '?').toLowerCase() + ' on ' + route(); }
    }));
    document.addEventListener('load', safe(e => {
      const t = e.target;
      if (!storyStart || !t || t.tagName !== 'IMG') return;
      const r = t.getBoundingClientRect();
      if (r.width * r.height >= innerWidth * innerHeight * 0.5) storyShown();
    }), true);
    try {
      new PerformanceObserver(safe(list => {
        for (const e of list.getEntries()) {
          const st = e.responseStatus;
          if (!st || !/^https:\/\/[^/]*instagram\.com\/(?:api\/|graphql\/|ajax\/)/.test(e.name)) continue;
          if (st === 429) diag.s429++;
          else if (st >= 500) diag.s5xx++;
        }
      })).observe({ type: 'resource' });
    } catch (e) { /* resource timing unavailable */ }
    try {
      new PerformanceObserver(safe(list => {
        for (const e of list.getEntries()) {
          diag.longTasks++;
          diag.longestTask = Math.max(diag.longestTask, Math.round(e.duration));
        }
      })).observe({ type: 'longtask' });
    } catch (e) { /* long task timing unavailable */ }
  }

  /* ------------------------------------------------------------------ *
   * Commands from the Android app.
   * ------------------------------------------------------------------ */
  // Session storage by key family (counts only; key names are never sent):
  // Instagram's screen-time snapshots, its tab ids and scroll positions,
  // SimpleGram's own keys, everything else.
  function storageShape() {
    const out = { screenTime: 0, tabId: 0, scroll: 0, sg: 0, other: 0 };
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i) || '';
      if (/^ig_screen_time|^has_user_dismissed/.test(k)) out.screenTime++;
      else if (/TabId/.test(k)) out.tabId++;
      else if (/routeScrollPos/.test(k)) out.scroll++;
      else if (/^sg_/.test(k)) out.sg++;
      else out.other++;
    }
    return out;
  }
  function shareUrl() {
    const r = route();
    if (r === 'story') return location.origin + location.pathname;
    const code = snapshot && snapshot.code || codeFromPath();
    if (code) return 'https://www.instagram.com/' + (route() === 'reel' ? 'reel/' : 'p/') + code + '/';
    return location.href;
  }
  SG.onNative = safe(cmd => {
    if (!cmd || typeof cmd !== 'object') return;
    switch (cmd.type) {
      case 'menu':
        takeSnapshot(cmd.focus || null);
        post('menuContext', { route: route(), hasMedia: !!(snapshot && snapshot.el), kind: snapshot && snapshot.kind, link: shareUrl() });
        break;
      case 'download': {
        // Uses the snapshot from when the menu opened.
        const s = snapshot && Date.now() - snapshot.at < 10 * 60 * 1000 ? snapshot : takeSnapshot(cmd.focus || null);
        resolved(s).then(res => {
          res = res || { error: 'Download failed.' };
          const one = res.items && res.items.length ? res.items : res.choices || [];
          if (res.all && res.all.length > 1 && one.length <= 1) {
            post('downloadAsk', { current: one[0] || null, all: res.all, kind: s.kind || 'image' });
          } else if (res.items && res.items.length) {
            post('download', { items: res.items });
          } else if (res.choices && res.choices.length) {
            post('downloadChoices', { choices: res.choices });
          } else {
            post('toast', { message: res.error || 'Nothing to download here.' });
          }
        });
        break;
      }
      case 'splitClosed': closeSplit(); break;
      case 'continueFeed':
        // The end card offers Following only (Favorites has its own way in).
        if (cmd.variant === 'following') continueFeed(cmd.variant);
        break;
      case 'storyHold': storyHold(!!cmd.on); break;
      case 'appHold': appHold(!!cmd.on); break;
      case 'fullVideoExit': exitFullVideo('back'); break;
      case 'gestureReset': gestureReset(); break;
      case 'scrollStuckAck': stuckAck(cmd); break;
      // The app's chip is still up from an earlier page: the first drag here that scrolls clears it.
      case 'stuckChipUp': report.open = true; report.at = Date.now(); break;
      case 'searchRestore': searchRestore(cmd.state); break;
      case 'viewer': if (cmd.id) CFG.viewerId = String(cmd.id); break;
      case 'status':
        stats.storage = safe(storageShape)() || null;
        stats.b25.census = safe(touchCensus)() || null;
        stats.b25.search = safe(() => ({ open: !!search.open, leaving: !!leaving,
          cells: search.body && search.body.sgGrid ? search.body.sgGrid.n : 0, liveObservers: liveWatchers }))() || null;
        post('status', { stats: stats, route: route(), version: CFG.version });
        break;
      case 'tidy': queueTidy(); break;
      case 'contSet': if (typeof cmd.on === 'boolean') contSet(cmd.on); break;
      default: break;
    }
  });

  /* ------------------------------------------------------------------ *
   * Start
   * ------------------------------------------------------------------ */
  function start() {
    addStyle();
    safe(markFeed)();
    safe(tidyStars)();
    queueTidy();
    if (CFG.role === 'main') {
      safe(restoreSearch)();
      if (route() === 'explore' && !search.open) safe(openSearch)(true);
    }
    new MutationObserver(records => { safe(hideAddedPosts)(records); queueTidy(); })
      .observe(document.documentElement, { childList: true, subtree: true });
    post('ready', { url: location.href, route: route() });
    if (search.open) post('search', { open: true });   // 'ready' clears the app's searchOpen
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', safe(start), { once: true });
  else safe(start)();
})();
