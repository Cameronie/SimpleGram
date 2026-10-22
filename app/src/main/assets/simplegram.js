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

  const CFG = Object.assign({ role: 'main', version: 'dev', searchPages: 3, viewerId: null },
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
  });

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
    for (const c of rec.children) if (c.pk) index.byPk.set(c.pk, { pk: c.pk, image: c.image, video: c.video, username: rec.username, code: rec.code, children: [], parent: rec });
    cap(index.byCode, 1500); cap(index.byPk, 3000); cap(index.byFile, 8000);
    stats.indexed++;
  }
  SG.index = index;

  /* ------------------------------------------------------------------ *
   * Data-layer filtering
   * ------------------------------------------------------------------ */
  const TIMELINE_KEY = /feed__timeline|feed_timeline|timeline__connection|feed__following|feed__favorites/i;
  const CHAINING_KEY = /clips__home|clips_home|clips__chaining|clips_chaining|clips__trending|clips__explore|clips__discover/i;
  const EXPLORE_KEY = /explore_{1,2}grid|topical_explore|explore__sectional|discover__web__explore/i;
  // (^|__)ayml(__|$): the accounts Instagram suggests when Home has nothing new (xdt_api__v1__ayml__strict).
  const SUGGEST_KEY = /^suggested_users(_v2)?$|discover__ayml|^ayml|(^|__)ayml(__|$)|suggested_accounts|similar_accounts|discover__chaining|^chaining_results$|^chaining_users$/i;
  const AD_CONTAINER_KEY = /injected_story|story_ads|ad_media_items|ads_pool|^ads$|xdt_injected/i;
  const SEARCH_KEY = /fbsearch|top_serp|keyword_search|^media_grid$|serp_/i;
  const AD_LIST_KEY = /^(edges|items|feed_items|reels_media|reels|medias|media|stories|clips|tray|story_items|fill_items)$/;
  let streamed = false;
  let ownFetch = false;     // SimpleGram's own search requests
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
  function freshFeed(key) {
    return { key: key, emptyStreak: 0, seenStreak: 0, ended: false, caughtUp: false, homePages: 0,
      endText: null, endCursor: null, lastCursor: null, lastPageAt: 0 };
  }
  function currentFeed() {
    if (route() === 'home') lastVariant = feedVariant();
    let fs = feedStates.get(lastVariant);
    if (!fs) feedStates.set(lastVariant, fs = freshFeed(lastVariant));
    return fs;
  }
  SG.feedState = () => Object.assign({}, currentFeed());
  // The page that ends a feed is remembered: reading it again is still the end.
  function endFeed(fs, caughtUp) {
    fs.ended = true;
    if (caughtUp) fs.caughtUp = true;
    fs.endCursor = fs.lastCursor;
  }

  // Which home feed is showing: home (Instagram's picks), following, favorites,
  // or past_posts (Instagram's older posts, never cut at its end marker).
  function feedVariant() {
    const v = new URLSearchParams(location.search).get('variant');
    return v === 'following' || v === 'favorites' || v === 'past_posts' ? v : 'home';
  }
  // Posts Home has shown, so Following/Favorites can skip them when you
  // continue from the end of Home.
  const homeSeen = new Set();
  const SKIP_KEY = 'sg_skip_seen';
  // Used once, by the page the end-of-Home buttons open, then forgotten:
  // opening Following or Favorites any other way shows everything.
  let skip = null;
  try {
    const saved = JSON.parse(sessionStorage.getItem(SKIP_KEY) || 'null');
    sessionStorage.removeItem(SKIP_KEY);
    if (saved && saved.variant === feedVariant() && Array.isArray(saved.codes) && Date.now() - saved.at < 60 * 1000) {
      skip = { variant: saved.variant, path: location.pathname + location.search, codes: new Set(saved.codes) };
    }
  } catch (e) { /* storage unavailable */ }
  function skipping() {
    return skip && location.pathname + location.search === skip.path ? skip.codes : null;
  }
  function continueFeed(variant) {
    try {
      sessionStorage.setItem(SKIP_KEY, JSON.stringify({ variant: variant, codes: Array.from(homeSeen).slice(-3000), at: Date.now() }));
    } catch (e) { /* storage unavailable: no skipping */ }
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
  function endHome(owner, list, fs, ctx) {
    const at = markerAt(list);
    if (at >= 0) {
      const marker = unitOf(list[at]);
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
      if (ctx) for (const e of list) if (keep.indexOf(e) < 0) noteUnit(e, 'recs', ctx);
      stats.feed.recsPages = (stats.feed.recsPages || 0) + 1;
      stats.feed.afterEnd = (stats.feed.afterEnd || 0) + list.length - keep.length;
      list.splice(0, list.length, ...keep);
    } else {
      return;
    }
    stopPagination(owner);
    endFeed(fs, true);
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

  function filterFeedList(owner, list) {
    if (markerLists.has(list)) { filterMarkerList(list); return; }
    stats.feed.pages++;
    let fs = currentFeed();
    const home = fs.key === 'home';
    const ctx = home ? unitContext(owner, list) : null;
    fs.lastPageAt = Date.now();
    if (streamed) {
      stats.feed.streamed++;
      if (ctx) for (const e of list) noteUnit(e, 'streamed', ctx);
      return;
    }
    const cursor = cursorOf(owner);
    if (fs.ended && cursor !== fs.endCursor) {
      if (markerAt(list) >= 0 || list.some(followedPost)) {
        // Instagram refreshed the feed (pull to refresh, the Home tab): start over.
        feedStates.set(fs.key, fs = freshFeed(fs.key));
        fs.lastPageAt = Date.now();
        stats.feed.refreshes = (stats.feed.refreshes || 0) + 1;
      } else {
        // Instagram's suggestions after the end: never shown, never left alone.
        if (ctx) for (const e of list) noteUnit(e, 'afterEnd', ctx);
        stats.feed.afterEnd = (stats.feed.afterEnd || 0) + list.length;
        list.length = 0;
        stopPagination(owner);
        fs.endCursor = cursor;
        return;
      }
    }
    fs.lastCursor = cursor;
    if (home) endHome(owner, list, fs, ctx);
    else for (const e of list) for (const g of markerGroups(unitOf(e))) markerLists.add(g.feed_items);
    const verdicts = list.map(e => feedVerdict(unitOf(e)));
    if (list.length && !verdicts.some(x => x.known)) {
      // Nothing recognisable: Instagram probably changed its format. Fail open.
      stats.feed.unknownPages++;
      if (ctx) for (const e of list) noteUnit(e, 'open', ctx);
      return;
    }
    const media = verdicts.filter(x => x.media);
    if (stats.feed.kept === 0 && media.length >= 3 && media.every(x => x.reason === 'notFollowed')) {
      stats.feed.followSuspect = (stats.feed.followSuspect || 0) + 1;
      for (const x of media) { x.drop = false; x.reason = ''; }
    }
    const seenCodes = skipping();
    // Home's own page, even when it lands while a Story or post is open.
    const onHome = home;
    const kept = [];
    let keptMedia = 0, alreadySeen = 0, lastKept = null;
    verdicts.forEach((x, i) => {
      stats.feed.seen++;
      const code = x.media ? edgeCode(list[i]) : null;
      if (!x.drop && code && seenCodes && seenCodes.has(code)) { x.drop = true; x.reason = 'alreadySeen'; alreadySeen++; }
      if (x.drop) stats.feed[x.reason] = (stats.feed[x.reason] || 0) + 1;
      else {
        kept.push(list[i]);
        if (x.media) {
          keptMedia++;
          if (code) lastKept = code;
          if (home && x.follow === null) stats.feed.followUnknown = (stats.feed.followUnknown || 0) + 1;
          if (onHome && code) { homeSeen.add(code); if (homeSeen.size > 4000) homeSeen.delete(homeSeen.values().next().value); }
        }
      }
      if (ctx) noteUnit(list[i], x.drop ? x.reason : 'kept', ctx);
    });
    if (lastKept) fs.lastKeptCode = lastKept;
    if (onHome && keptMedia > 0) fs.homePages++;
    stats.feed.kept += keptMedia;
    stats.feed.lastPageKept = keptMedia;
    if (kept.length !== list.length) list.splice(0, list.length, ...kept);
    const more = hasMore(owner);
    if (keptMedia === 0 && more) {
      if (alreadySeen > 0) {
        // Paging past posts you already saw in Home: each comes once in Following,
        // so allow about as many pages as Home showed (12 a page), within limits.
        const cap = Math.min(60, Math.max(15, Math.ceil(seenCodes.size / 10)));
        if (++fs.seenStreak >= cap) { stopPagination(owner); endFeed(fs); }
      } else if (++fs.emptyStreak >= 4) {
        stopPagination(owner); stats.feed.stopped++; endFeed(fs);
      }
      if (!fs.ended) scheduleNudge(true);
    } else if (keptMedia > 0) {
      fs.emptyStreak = 0;
      fs.seenStreak = 0;
      // Only a post or two came through: ask for the next batch early.
      if (keptMedia <= 2 && more) scheduleNudge(false);
    }
    if (!more && pagingOwner(owner)) endFeed(fs);
    setTimeout(safe(checkFeedEnd), 300);
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
      else if (SUGGEST_KEY.test(k)) blankLists(v, 'suggestionsBlanked');
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
  let nudgeTimer = 0, touching = false, lastUserScroll = 0;
  window.addEventListener('touchstart', () => { touching = true; }, { capture: true, passive: true });
  window.addEventListener('touchend', () => { touching = false; lastUserScroll = Date.now(); }, { capture: true, passive: true });
  window.addEventListener('touchcancel', () => { touching = false; }, { capture: true, passive: true });
  const nudgedAt = [];
  function scheduleNudge(hard) {
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(safe(() => {
      const se = document.scrollingElement;
      // Never after the end of a feed or while the app is in the background.
      if (!se || route() !== 'home' || document.hidden || currentFeed().ended) return;
      if (se.scrollHeight - (se.scrollTop + innerHeight) > innerHeight * 2) return;
      // At most 10 a minute, however many pages come back empty.
      const now = Date.now();
      while (nudgedAt.length && now - nudgedAt[0] > 60000) nudgedAt.shift();
      if (nudgedAt.length >= 10) { stats.feed.nudgesCapped = (stats.feed.nudgesCapped || 0) + 1; return; }
      nudgedAt.push(now);
      stats.feed.nudges = (stats.feed.nudges || 0) + 1;
      window.dispatchEvent(new Event('scroll'));
      document.dispatchEvent(new Event('scroll'));
      // Never move the page under your finger or during a fling.
      if (touching || Date.now() - lastUserScroll < 400) return;
      const y = se.scrollTop;
      if (se.scrollHeight - innerHeight > 4) {
        const d = y >= 2 ? -2 : 2;
        se.scrollTop += d;
        requestAnimationFrame(() => { se.scrollTop -= d; });
      } else if (hard && document.body) {
        // Nothing to scroll: briefly add room below so the list's end leaves and re-enters view.
        const pad = document.createElement('div');
        pad.setAttribute('aria-hidden', 'true');
        pad.style.cssText = 'height:' + (innerHeight * 3) + 'px;pointer-events:none';
        document.body.appendChild(pad);
        se.scrollTop = innerHeight * 2;
        let done = false;
        const restore = () => { if (done) return; done = true; se.scrollTop = y; pad.remove(); };
        requestAnimationFrame(() => requestAnimationFrame(restore));
        // Frames can stop (the app going to the background): never leave the room behind.
        setTimeout(restore, 150);
      }
    }), 600);
  }

  /* ------------------------------------------------------------------ *
   * End of Home: offer Following and Favorites (newest first), skipping
   * what you already saw. Shown by the app, outside Instagram's page.
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
      else show = stalled = near && fs.lastPageAt > 0 && now - atBottomSince > STALL_MS && now - fs.lastPageAt > STALL_MS;
    } else {
      atBottomSince = 0;
    }
    endRoom(onHome && (fs.ended || stalled));
    const end = fs.caughtUp && fs.endText;
    const msg = { on: show, caughtUp: !!fs.caughtUp, stalled: stalled,
      title: end ? fs.endText.title : '', subtitle: end ? fs.endText.subtitle : '' };
    const key = JSON.stringify(msg);
    if (key !== feedEndSent || force) {
      feedEndShown = show;
      feedEndSent = key;
      post('feedEnd', msg);
    }
  }
  let feedEndTimer = 0;
  window.addEventListener('scroll', e => {
    if (e.isTrusted) lastUserScroll = Date.now();
    if (feedEndTimer) return;
    feedEndTimer = setTimeout(() => { feedEndTimer = 0; safe(checkFeedEnd)(); }, 250);
  }, { passive: true, capture: true });
  setInterval(() => {
    if (route() !== 'home' || document.hidden) return;
    safe(checkFeedEnd)();
    safe(sampleFeed)();
  }, 1500);



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
    ].join('\n');
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
  function tidyStory() {
    if (route() !== 'story') return;
    const here = location.pathname;
    if (storyAdSkipped === here) return;
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
  }

  let tidyQueued = false;
  function tidyNow() {
    tidyQueued = false;
    if (!document.body) return;
    addStyle();
    safe(tidyReelsTab)();
    if (Date.now() - lastBannerScan > 1000) { lastBannerScan = Date.now(); safe(tidyBanners)(); }
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

  let lastUrl = location.href;
  function routeChanged() {
    if (location.href === lastUrl) return;
    const previous = route(new URL(lastUrl).pathname);
    lastUrl = location.href;
    post('route', { url: location.href, route: route() });
    safe(syncSwipeGuard)();
    if (CFG.role === 'main' && route() === 'reels-tab') {
      // The endless Reels tab is not part of SimpleGram.
      location.replace('/');
      return;
    }
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
  history.pushState = function pushState() {
    safe(rememberScroll)();
    const out = nativePush.apply(this, arguments);
    safe(noteHistoryWrite)();
    safe(routeChanged)();
    return out;
  };
  history.replaceState = function replaceState() {
    const out = nativeReplace.apply(this, arguments);
    safe(noteHistoryWrite)();
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
    if (!swipe || e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - swipe.x, dy = t.clientY - swipe.y;
    if (swipe.vertical === null && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) swipe.vertical = Math.abs(dy) > Math.abs(dx);
    if (swipe.vertical) {
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
    }
  });
  // A blocking touch listener makes every scroll wait for the page, so it is
  // registered only where a Reel viewer can be: never on Home, DMs or Stories.
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
    if (!(m instanceof HTMLMediaElement)) return;
    if (CFG.role !== 'main') { m.pause(); m.muted = true; return; }
    queueAwake();
    if (m.muted && !userMuted && wantsSound(m)) unmute(m);
  }), true);
  document.addEventListener('volumechange', safe(e => {
    const m = e.target;
    if (!(m instanceof HTMLMediaElement) || CFG.role !== 'main') return;
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
  // Returns data[root] (the answer's main object), or null. At most 2 POSTs.
  async function igGraphQL(name, variables, root) {
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
      let p = 0;
      for (let posts = 0; posts < 2 && p < paths.length; posts++) {
        const path = paths[p];
        const note = { query: name, id: id, idSource: idSource[name] || '', providerSource: pv.source, providers: {}, path: path, status: 0 };
        for (const k in vars) {
          if (/^__relay_internal__pv__/.test(k)) note.providers[k.replace(/^__relay_internal__pv__|relayprovider$/g, '')] = vars[k];
        }
        const t0 = Date.now();
        let res = null, text = '', data = null;
        try {
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
          note.status = res.status;
          if (res.ok) { text = await res.text(); data = parseIg(text); }
        } catch (e) { note.message = 'network error'; }
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
        ownCleanse(data);
        const out = data.data && data.data[root];
        if (out) { Object.assign(note, answerShape(out)); gqlNote(note); return out; }
        // Instagram read the request and refused it: never resend it elsewhere.
        const err = Array.isArray(data.errors) ? data.errors[0] : null;
        if (err && (err.code != null || err.api_error_code != null)) note.code = err.code != null ? err.code : err.api_error_code;
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
   * website still serves recent posts. Results stop after a few
   * "Show more" taps: no endless scrolling.
   *
   * It is SimpleGram's own screen, drawn in an isolated layer above
   * Instagram's page; it only reads Instagram's own search data.
   * ------------------------------------------------------------------ */
  const SEARCH_STATE = 'sg_search_state';
  const RECENT_KEY = 'sg_recent_searches';
  const MAX_MORE = 3;
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
    if (!cursor && !dead.has('tags/web_info')) {
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
    return loadKeyword('#' + name, cursor);
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
  async function loadPlace(view, cursor) {
    const tab = view.sub === 'recent' ? 'recent' : 'ranked';
    const id = String(view.id);
    if (!cursor && (!view.name || !view.address) && !view.headerAsked) { view.headerAsked = true; placeHeader(view); }
    const c = cursor
      ? await igGraphQL('PolarisLocationPageTabContentQuery_connection',
        { after: cursor.after, first: 12, location_id: id, page_size_override: null, tab: tab }, 'xdt_location_get_web_info_tab')
      : await igGraphQL('PolarisLocationPageTabContentQuery',
        { location_id: id, first: 12, after: null, tab: tab, page_size_override: null }, 'xdt_location_get_web_info_tab');
    if (!c) return null;
    const media = collectMedia((c.edges || []).map(e => e && e.node));
    const next = nextCursor(c, cursor);
    return { media: media, more: next ? { after: next } : null, noRecent: tab === 'recent' && !media.length && !cursor };
  }
  async function loadTagOrPlace(view, cursor) {
    return view.kind === 'tag' ? loadTag(view, cursor) : loadPlace(view, cursor);
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
    } catch (e) { /* storage full or unavailable */ }
  }
  function clearSaved() { try { sessionStorage.removeItem(SEARCH_STATE); } catch (e) { /* ignore */ } }

  function render() {
    const w = search.wrap;
    w.style.setProperty('--sg-bottom', navHeight() + 'px');
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
    search.body = body;
    w.append(head, seg, body);
    renderGrid(body, search.grid, () => runGrid(true), null);
  }
  function renderGrid(body, state, more, q) {
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
    const grid = el('div', 'grid');
    for (const m of state.media) {
      const cell = el('button', 'cell');
      const img = el('img');
      img.alt = '';
      img.loading = 'lazy';
      img.src = m.thumb;
      cell.appendChild(img);
      if (m.reel || m.multi) cell.appendChild(el('span', 'badge', m.reel ? '▶︎' : '❐'));
      cell.onclick = () => openPath(m.path);
      grid.appendChild(cell);
    }
    body.appendChild(grid);
    if (state.loading) body.appendChild(el('div', 'spin'));
    else if (state.more && state.pages < MAX_MORE + 1) {
      const b = el('button', 'more', 'Show more');
      b.onclick = more;
      body.appendChild(b);
    }
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
  function addNew(have, more) {
    const seen = new Set(have.map(m => m.path));
    return have.concat(more.filter(m => !seen.has(m.path) && seen.add(m.path)));
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
  async function runPosts(more) {
    const q = search.query.trim();
    if (!q) return;
    let st = search.posts;
    if (!more || !st || st.q !== q) st = search.posts = { q: q, media: [], more: null, pages: 0, loading: true };
    else { if (!st.more || st.loading) return; st.loading = true; }
    renderBody();
    const seq = ++search.seqPosts;
    const res = await loadPosts(q, more ? st.more : null);
    if (seq !== search.seqPosts || search.posts !== st) return;
    st.loading = false;
    if (!res) { if (!st.media.length) st.error = true; else st.more = null; }   // a failed Show more ends the list
    else {
      const had = st.media.length;
      st.media = addNew(st.media, slim(res.media));
      st.more = st.media.length > had ? res.more : null;     // a page that adds nothing ends the list
      st.pages++;
    }
    if (search.tab === 'posts' && !search.view) renderBody();
  }
  async function runGrid(more) {
    const v = search.view;
    if (!v) return;
    let st = search.grid;
    if (!more || !st) st = search.grid = { media: [], more: null, pages: 0, loading: true };
    else { if (!st.more || st.loading) return; st.loading = true; }
    // Show more refills only the grid, so the list keeps its scroll position.
    const draw = () => { if (more && search.body) renderGrid(search.body, st, () => runGrid(true), null); else render(); };
    draw();
    const seq = ++search.seqGrid;
    const res = await loadTagOrPlace(v, more ? st.more : null);
    if (seq !== search.seqGrid || search.grid !== st || search.view !== v) return;
    st.loading = false;
    if (!res) { if (!st.media.length) st.error = true; else st.more = null; }   // a failed Show more ends the list
    else {
      const had = st.media.length;
      st.media = addNew(st.media, slim(res.media));
      st.more = st.media.length > had ? res.more : null;     // a page that adds nothing ends the list
      st.pages++; st.noRecent = !!res.noRecent; st.unordered = !!res.unordered;
    }
    draw();
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
  function here() { return location.pathname + location.search; }
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
    safe(loadOpens)();                        // the newer page may have counted since
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
    fullscreen: 0, fullscreenLast: '' });
  let storyStart = 0;
  function storyOpened() {
    storyStart = performance.now();
    diag.storyVideos = document.getElementsByTagName('video').length;
  }
  function storyShown() {
    if (!storyStart || route() !== 'story') return;
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
        if (cmd.variant === 'following' || cmd.variant === 'favorites') continueFeed(cmd.variant);
        break;
      case 'storyHold': storyHold(!!cmd.on); break;
      case 'viewer': if (cmd.id) CFG.viewerId = String(cmd.id); break;
      case 'status': post('status', { stats: stats, route: route(), version: CFG.version }); break;
      case 'tidy': queueTidy(); break;
      default: break;
    }
  });

  /* ------------------------------------------------------------------ *
   * Start
   * ------------------------------------------------------------------ */
  function start() {
    addStyle();
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
