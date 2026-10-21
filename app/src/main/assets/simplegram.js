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
  const SUGGEST_KEY = /^suggested_users(_v2)?$|discover__ayml|^ayml|suggested_accounts|similar_accounts|discover__chaining|^chaining_results$|^chaining_users$/i;
  const AD_CONTAINER_KEY = /injected_story|story_ads|ad_media_items|ads_pool|^ads$|xdt_injected/i;
  const SEARCH_KEY = /fbsearch|top_serp|keyword_search|^media_grid$|serp_/i;
  const AD_LIST_KEY = /^(edges|items|feed_items|reels_media|reels|medias|media|stories|clips|tray|story_items|fill_items)$/;
  let streamed = false;
  let ownFetch = false;     // SimpleGram's own search requests

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
    if (typeof src === 'string' && /recommend|explore|suggest|chaining|netego/i.test(src)) return true;
    if (m.is_suggested === true || m.is_recommended === true || node.is_suggested === true) return true;
    return contextText([node, m], /^\s*suggested (for you|posts?|reels?)\s*$/i);
  }
  function feedVerdict(node) {
    const v = { drop: false, reason: '', media: false };
    const drop = r => { v.drop = true; v.reason = r; return v; };
    if (!node || typeof node !== 'object') return v;
    if (adLike(node)) return drop('ad');
    const m = mediaOf(node);
    if (m) v.media = true;
    if (node.explore_story || node.suggested_users || node.suggested_users_v2) return drop('suggested');
    if (!m) {
      if (node.end_of_feed_demarcator) return v;
      const live = Object.keys(node).filter(k => node[k] != null && k !== '__typename' && k !== 'cursor');
      return live.length ? drop('unit') : v;
    }
    if (adLike(m)) return drop('ad');
    if (repostLike(node, m)) return drop('repost');
    if (followState(m) === false) return drop('notFollowed');
    if (recommendedLike(node, m)) return drop('suggested');
    return v;
  }
  SG.feedVerdict = feedVerdict;

  let feedState = null;
  function currentFeed() {
    const key = location.pathname + '|' + feedVariant();
    if (!feedState || feedState.key !== key) {
      feedState = { key: key, emptyStreak: 0, seenStreak: 0, ended: false, caughtUp: false, homePages: 0 };
    }
    return feedState;
  }

  // Which home feed is showing: home (Instagram's picks), following or favorites.
  function feedVariant() {
    const v = new URLSearchParams(location.search).get('variant');
    return v === 'following' || v === 'favorites' ? v : 'home';
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
  function filterFeedList(owner, list) {
    stats.feed.pages++;
    if (streamed) { stats.feed.streamed++; return; }
    const verdicts = list.map(e => feedVerdict(e && e.node ? e.node : e));
    if (list.length && !verdicts.some(x => x.media)) {
      // Nothing recognisable: Instagram probably changed its format. Fail open.
      stats.feed.unknownPages++;
      return;
    }
    const media = verdicts.filter(x => x.media);
    if (stats.feed.kept === 0 && media.length >= 3 && media.every(x => x.reason === 'notFollowed')) {
      stats.feed.followSuspect = (stats.feed.followSuspect || 0) + 1;
      for (const x of media) { x.drop = false; x.reason = ''; }
    }
    const seenCodes = skipping();
    const onHome = route() === 'home' && feedVariant() === 'home';
    const fs = currentFeed();
    const kept = [];
    let keptMedia = 0, alreadySeen = 0;
    verdicts.forEach((x, i) => {
      stats.feed.seen++;
      const code = x.media ? edgeCode(list[i]) : null;
      if (!x.drop && code && seenCodes && seenCodes.has(code)) { x.drop = true; x.reason = 'alreadySeen'; alreadySeen++; }
      if (x.drop) stats.feed[x.reason] = (stats.feed[x.reason] || 0) + 1;
      else {
        kept.push(list[i]);
        if (x.media) {
          keptMedia++;
          if (onHome && code) { homeSeen.add(code); if (homeSeen.size > 4000) homeSeen.delete(homeSeen.values().next().value); }
        }
      }
      if (!x.drop && list[i] && (list[i].node || list[i]).end_of_feed_demarcator) fs.caughtUp = true;
    });
    if (onHome && keptMedia > 0) fs.homePages++;
    stats.feed.kept += keptMedia;
    stats.feed.lastPageKept = keptMedia;
    if (kept.length !== list.length) list.splice(0, list.length, ...kept);
    const more = hasMore(owner);
    if (keptMedia === 0 && more) {
      if (alreadySeen > 0) {
        // Paging past posts you already saw in Home: keep going (a while).
        if (++fs.seenStreak >= 40) { stopPagination(owner); fs.ended = true; }
      } else if (++fs.emptyStreak >= 4) {
        stopPagination(owner); stats.feed.stopped++; fs.ended = true;
      }
      if (!fs.ended) scheduleNudge(true);
    } else if (keptMedia > 0) {
      fs.emptyStreak = 0;
      fs.seenStreak = 0;
      // Only a post or two came through: ask for the next batch early.
      if (keptMedia <= 2 && more) scheduleNudge(false);
    }
    if (!more) fs.ended = true;
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
  function cleanse(root) {
    if (!root || typeof root !== 'object') return;
    stats.payloads++;
    searchCounted = false;
    streamed = root.hasNext === true || !!(root.extensions && root.extensions.is_final === false);
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
  const wrappedParse = function parse(text, reviver) {
    const out = nativeParse.apply(this, arguments);
    if (typeof text === 'string' && text.length > 150 && out && typeof out === 'object' && INTEREST.test(text)) {
      try { cleanse(out); } catch (e) { stats.errors++; }
    }
    return out;
  };
  JSON.parse = wrappedParse;

  if (window.Response && Response.prototype.json) {
    const nativeJson = Response.prototype.json;
    Response.prototype.json = function json() {
      return nativeJson.apply(this, arguments).then(out => {
        if (out && typeof out === 'object') { try { cleanse(out); } catch (e) { stats.errors++; } }
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
            try { cleanse(out); } catch (e) { stats.errors++; }
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
  function scheduleNudge(hard) {
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(safe(() => {
      const se = document.scrollingElement;
      if (!se || route() !== 'home') return;
      if (se.scrollHeight - (se.scrollTop + innerHeight) > innerHeight * 2) return;
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
        requestAnimationFrame(() => requestAnimationFrame(() => { se.scrollTop = y; pad.remove(); }));
      }
    }), 600);
  }

  /* ------------------------------------------------------------------ *
   * End of Home: offer Following and Favorites (newest first), skipping
   * what you already saw. Shown by the app, outside Instagram's page.
   * ------------------------------------------------------------------ */
  let feedEndShown = null, atBottomSince = 0;
  function checkFeedEnd(force) {
    if (CFG.role !== 'main') return;
    let show = false;
    const fs = currentFeed();
    const searching = typeof search !== 'undefined' && search.open;
    if (route() === 'home' && feedVariant() === 'home' && fs.homePages > 0 && !searching) {
      const se = document.scrollingElement || document.documentElement;
      const nearBottom = se.scrollHeight - (se.scrollTop + innerHeight) < Math.max(400, innerHeight * 0.6);
      if (nearBottom) { if (!atBottomSince) atBottomSince = Date.now(); } else atBottomSince = 0;
      show = nearBottom && (fs.ended || (atBottomSince && Date.now() - atBottomSince > 4000));
    } else {
      atBottomSince = 0;
    }
    if (show !== feedEndShown || force) {
      feedEndShown = show;
      post('feedEnd', { on: show, caughtUp: fs.caughtUp || fs.ended });
    }
  }
  let feedEndTimer = 0;
  window.addEventListener('scroll', e => {
    if (e.isTrusted) lastUserScroll = Date.now();
    if (feedEndTimer) return;
    feedEndTimer = setTimeout(() => { feedEndTimer = 0; safe(checkFeedEnd)(); }, 250);
  }, { passive: true, capture: true });
  setInterval(() => { if (route() === 'home' && !document.hidden) safe(checkFeedEnd)(); }, 1500);



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
  function tidyBanners() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n, guard = 0;
    while ((n = walker.nextNode()) && guard++ < 20000) {
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
  function tidyFeed() {
    if (route() !== 'home' || CFG.role !== 'main') return;
    for (const article of document.querySelectorAll(POST)) {
      const sig = articleSig(article);
      const prev = checked.get(article);
      if (prev && prev.sig === sig) continue;
      const reason = headerLabel(article);
      checked.set(article, { sig: sig, reason: reason });
      if (reason) {
        if (hide(article, reason)) stats.dom[reason]++;
      } else if (article.dataset.sgHidden) {
        unhide(article);
      }
    }
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
    for (const el of document.querySelectorAll('section span, section div, [role="dialog"] span')) {
      if (el.children.length) continue;
      const t = norm(el);
      if (!t || t.length > 20 || !AD_LABEL.test(t)) continue;
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
    if (CFG.role === 'main' && route() === 'reels-tab') {
      // The endless Reels tab is not part of SimpleGram.
      location.replace('/');
      return;
    }
    if (CFG.role === 'main') {
      if (search.open) { hideSearch(false); search.suspended = false; clearSaved(); }
      restoreSearch();
      if (route() === 'explore' && !search.open && !search.suspended) openSearch(true);
      atBottomSince = 0;
      safe(checkFeedEnd)(true);
    }
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
    safe(routeChanged)();
    return out;
  };
  history.replaceState = function replaceState() {
    const out = nativeReplace.apply(this, arguments);
    safe(routeChanged)();
    return out;
  };
  window.addEventListener('popstate', safe(() => { routeChanged(); if (!syntheticPop) restoreScroll(); }));

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
  window.addEventListener('touchstart', safe(e => {
    swipe = null;
    if (CFG.role !== 'main' || e.touches.length !== 1) return;
    const r = route();
    if (r === 'home' || r === 'direct' || r === 'story') return;
    // Only a vertically snapping viewer (one Reel per screen) is guarded;
    // ordinary lists such as Share or comments scroll normally.
    const sc = snapScroller(e.target);
    if (sc) swipe = { sc: sc, x: e.touches[0].clientX, y: e.touches[0].clientY, top: sc.scrollTop, vertical: null };
  }), { capture: true, passive: true });
  window.addEventListener('touchmove', safe(e => {
    if (!swipe || e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - swipe.x, dy = t.clientY - swipe.y;
    if (swipe.vertical === null && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) swipe.vertical = Math.abs(dy) > Math.abs(dx);
    if (swipe.vertical) {
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
    }
  }), { capture: true, passive: false });
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
    const label = toggle ? controlLabel(toggle) : '';
    // "Audio is playing" means Instagram already thinks sound is on.
    if (toggle && !/playing|is on|^mute$|turn off/i.test(label)) {
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
      if (autoStarted.has(v) || v.ended) continue;
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
  async function igGet(path) {
    try {
      const res = await fetch(path, {
        credentials: 'include',
        headers: { 'X-IG-App-ID': '936619743392459', 'X-Requested-With': 'XMLHttpRequest', 'X-IG-WWW-Claim': '0' },
      });
      if (!res.ok) return null;
      const data = parseIg(await res.text());
      if (data && typeof data === 'object') ownCleanse(data);
      return data && data.status !== 'fail' ? data : null;
    } catch (e) { return null; }
  }

  // The Instagram website's own GraphQL requests. Their ids change every few
  // weeks, so they are looked up in the page's loaded code at run time.
  function igModule(name) {
    try { return typeof window.require === 'function' ? window.require(name) : null; } catch (e) { return null; }
  }
  const docIds = {};
  // Last ids seen in public captures (Sept–Oct 2026), used only when the
  // page's own code doesn't reveal the current one.
  const KNOWN_DOC_IDS = {
    PolarisSearchBoxRefetchableQuery: '27706427925724183',
    PolarisKeywordSearchExplorePageRelayQuery: '37324993597144881',
    PolarisKeywordSearchExplorePageRelayPaginationQuery: '28656899673911396',
    PolarisLocationPageTabContentQuery: '28211016731901625',
  };
  let scannedBundles = null;
  async function docIdFor(name) {
    if (docIds[name]) return docIds[name];
    const op = igModule(name + '_instagramRelayOperation');
    if (typeof op === 'string' && /^\d+$/.test(op)) return (docIds[name] = op);
    const gql = igModule(name + '.graphql');
    if (gql && gql.params && /^\d+$/.test(String(gql.params.id))) return (docIds[name] = String(gql.params.id));
    // Last resort: find it in the script files the page already downloaded (from cache).
    if (!scannedBundles) {
      scannedBundles = {};
      const urls = new Set();
      for (const sc of document.scripts) if (sc.src) urls.add(sc.src);
      try { for (const e of performance.getEntriesByType('resource')) if (/\.js(\?|$)/.test(e.name)) urls.add(e.name); } catch (e) { /* ignore */ }
      const re = /__d\("([A-Za-z0-9_]+)_instagramRelayOperation",\[\],\(function\([^)]*\)\{[^}]*?exports="(\d+)"/g;
      let n = 0;
      for (const u of urls) {
        if (!/cdninstagram\.com|instagram\.com/.test(u) || n++ > 25) continue;
        try {
          const text = await (await fetch(u, { cache: 'force-cache' })).text();
          let m;
          while ((m = re.exec(text))) scannedBundles[m[1]] = m[2];
        } catch (e) { /* skip this file */ }
      }
    }
    if (scannedBundles[name]) return (docIds[name] = scannedBundles[name]);
    return KNOWN_DOC_IDS[name] || null;
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
  // Returns data[root] (the answer's main object), or null.
  async function igGraphQL(name, variables, root) {
    const id = await docIdFor(name);
    if (!id) return null;
    const lsd = await pageToken('LSD', /"LSD",\[\],\{"token":"([^"]+)"/);
    const body = new URLSearchParams({
      doc_id: id, variables: JSON.stringify(variables),
      fb_dtsg: await pageToken('DTSGInitialData', /"DTSGInitialData",\[\],\{"token":"([^"]+)"/),
      lsd: lsd, fb_api_caller_class: 'RelayModern', fb_api_req_friendly_name: name, server_timestamps: 'true',
    }).toString();
    // The website uses /api/graphql; some requests only answer on /graphql/query.
    for (const path of ['/api/graphql', '/graphql/query']) {
      try {
        const res = await fetch(path, {
          method: 'POST', credentials: 'include',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRFToken': csrf(), 'X-IG-App-ID': '936619743392459',
            'X-FB-LSD': lsd, 'X-FB-Friendly-Name': name,
          },
          body: body,
        });
        if (!res.ok) continue;
        const data = parseIg(await res.text());
        if (data && typeof data === 'object') ownCleanse(data);
        const out = data && data.data && data.data[root];
        if (out) return out;
      } catch (e) { /* try the other path */ }
    }
    return null;
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
      if (idx >= 0) {
        const c = children[idx];
        const kind = s.kind === 'video' && c.video ? 'video' : (c.video && !c.image ? 'video' : (s.kind === 'image' ? 'image' : (c.video ? 'video' : 'image')));
        current = { url: kind === 'video' ? c.video : c.image, kind: kind, name: nameFor(rec, idx, children.length, kind) };
      }
    } else if (rec) {
      if (s.kind === 'video' && rec.video) current = { url: rec.video, kind: 'video', name: nameFor(rec, 0, 1, 'video') };
      else if (rec.image && (s.kind === 'image' || !rec.video)) current = { url: rec.image, kind: 'image', name: nameFor(rec, 0, 1, 'image') };
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

  /* Data: Instagram's long-standing web endpoints first, then the
     website's current GraphQL requests, then Instagram's own page. */
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
  // Results for one tab. `stale()` says the user has typed something else:
  // then stop before asking Instagram for anything more.
  async function loadTab(tab, q, stale) {
    const c = cacheFor(q);
    const enc = encodeURIComponent;
    const blended = await cached(c, 'blended', () => igGet('/web/search/topsearch/?context=blended&include_reel=true&query=' + enc(q)));
    let list = [];
    if (tab === 'accounts') list = blended ? users(blended.users) : [];
    if (tab === 'tags') {
      list = blended ? hashtags(blended.hashtags) : [];
      if (!list.length && !stale()) {
        const r = await cached(c, 'tags', () => igGet('/web/search/topsearch/?context=hashtag&query=' + enc(q.replace(/^#/, ''))));
        if (r) list = hashtags(r.hashtags);
      }
    }
    if (tab === 'places') {
      list = blended ? places(blended.places) : [];
      if (!list.length && !stale()) {
        const r = await cached(c, 'places', () => igGet('/web/search/topsearch/?context=place&query=' + enc(q)));
        if (r) list = places(r.places);
      }
      if (!list.length && !stale()) {
        const r = await cached(c, 'fbplaces', () => igGet('/api/v1/fbsearch/places/?query=' + enc(q)));
        if (r) list = places(r.items);
      }
    }
    if (stale()) return null;
    if (!list.length) {
      // The website's own search request, only when the older ones gave nothing.
      const g = await cached(c, 'gql', () => igGraphQL('PolarisSearchBoxRefetchableQuery', {
        data: { context: 'blended', include_reel: 'true', query: q, rank_token: '', search_session_id: uuid(), search_surface: 'web_top_search' },
        hasQuery: true,
      }, 'xdt_api__v1__fbsearch__topsearch_connection'));
      if (g) list = tab === 'accounts' ? users(g.users) : tab === 'tags' ? hashtags(g.hashtags) : places(g.places);
      if (!list.length && !blended && !g) return { error: true, list: [] };
    }
    return { list: list };
  }
  // Keyword grid: posts and Reels, and hashtags, which Instagram now shows the same way.
  async function loadKeyword(q, cursor) {
    if (!cursor || cursor.rest) {
      let path = '/api/v1/fbsearch/web/top_serp/?enable_metadata=true&query=' + encodeURIComponent(q) +
        '&search_session_id=' + encodeURIComponent((cursor && cursor.session) || '');
      if (cursor && cursor.max_id) path += '&next_max_id=' + encodeURIComponent(cursor.max_id) + '&rank_token=' + encodeURIComponent(cursor.rank_token || '');
      const data = await igGet(path);
      const grid = data && (data.media_grid || data);
      const media = grid ? collectMedia(grid.sections || grid) : [];
      if (media.length) {
        const more = grid.has_more || grid.more_available;
        return { media: media, more: more ? { rest: true, max_id: grid.next_max_id || '', rank_token: grid.rank_token || data.rank_token || '' } : null };
      }
      if (cursor) return null;
    }
    const session = (cursor && cursor.session) || uuid();
    const vars = { query: q, search_session_id: session, serp_session_id: session };
    const c = cursor && cursor.after
      ? await igGraphQL('PolarisKeywordSearchExplorePageRelayPaginationQuery', Object.assign(vars, { first: 24, after: cursor.after }), 'xdt_fbsearch__top_serp_graphql')
      : await igGraphQL('PolarisKeywordSearchExplorePageRelayQuery', vars, 'xdt_fbsearch__top_serp_graphql');
    if (!c) return null;
    const units = (c.edges || []).map(e => e && e.node).filter(n => n && Array.isArray(n.items));
    const pi = c.page_info || {};
    return { media: collectMedia(units.map(n => n.items)), more: pi.has_next_page && pi.end_cursor ? { after: pi.end_cursor, session: session } : null };
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
      // for some tags, but it isn't strictly newest first.
      const part = await igPost(path, sectionsForm('recent', cursor));
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
    if (!cursor) {
      const data = await igGet('/api/v1/tags/web_info/?tag_name=' + encodeURIComponent(name));
      const body = data && (data.data || data);
      const top = body && body.top;
      if (body && body.media_count != null) view.count = body.media_count;
      const media = top ? collectMedia(top.sections || []) : [];
      if (media.length) {
        const m = moreState(top);
        if (m) m.rest = true;
        return { media: media, more: m };
      }
    }
    // What the website itself shows for a hashtag now.
    return loadKeyword('#' + name, cursor);
  }
  async function loadPlace(view, cursor) {
    const tab = view.sub === 'recent' ? 'recent' : 'ranked';
    if (cursor) {
      const part = await igPost('/api/v1/locations/' + encodeURIComponent(view.id) + '/sections/', sectionsForm(tab, cursor));
      return part ? { media: collectMedia(part.sections || []), more: moreState(part) } : null;
    }
    const data = await igGet('/api/v1/locations/web_info/?location_id=' + encodeURIComponent(view.id) + '&show_nearby=false');
    const body = data && (data.native_location_data || data);
    if (body && body.location_info) {
      const li = body.location_info;
      view.name = li.name || view.name;
      view.address = [li.location_address, li.location_city].filter(Boolean).join(', ') || view.address || '';
      if (li.slug) view.slug = li.slug;
    }
    const part = body && body[tab];
    const media = part ? collectMedia(part.sections || []) : [];
    if (media.length) return { media: media, more: moreState(part) };
    // The website's current request for a place's grid.
    const c = await igGraphQL('PolarisLocationPageTabContentQuery', {
      location_id: String(view.id), first: 24, after: null, tab: tab, page_size_override: null,
      __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: false,
    }, 'xdt_location_get_web_info_tab');
    if (c) {
      const gm = collectMedia((c.edges || []).map(e => e && e.node));
      if (gm.length) return { media: gm, more: null };
    }
    if (part || c) return { media: [], more: null, noRecent: tab === 'recent' };
    return null;
  }
  async function loadTagOrPlace(view, cursor) {
    return view.kind === 'tag' ? loadTag(view, cursor) : loadPlace(view, cursor);
  }

  /* Recent searches */
  function recents() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').slice(0, 15); } catch (e) { return []; }
  }
  function remember(item) {
    try {
      const list = recents().filter(x => !(x.kind === item.kind && x.id === item.id));
      list.unshift(item);
      localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 15)));
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
    .spin{width:22px;height:22px;margin:28px auto;border:2px solid #dbdbdb;border-top-color:#737373;border-radius:50%;animation:s .8s linear infinite}
    @keyframes s{to{transform:rotate(360deg)}}
    @media (prefers-color-scheme:dark){
      .wrap{background:#000;color:#f5f5f5}.field,.seg,.more,.cell,.av{background:#262626}
      .tabs,.head{border-color:#262626}.ic{border-color:#363636}.seg button.on{background:#000;color:#f5f5f5}
      .row:active{background:rgba(255,255,255,.06)}.clear{background:#555}.spin{border-color:#363636;border-top-color:#a8a8a8}
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
    if (search.tab === 'tags') items = top.tags.map(h => ({ kind: 'tag', id: h.name, title: '#' + h.name, sub: h.media_count != null ? Number(h.media_count).toLocaleString() + ' posts' : '' }));
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
    if (!res) { if (!st.media.length) st.error = true; }
    else { st.media = addNew(st.media, slim(res.media)); st.more = res.more; st.pages++; }
    if (search.tab === 'posts' && !search.view) renderBody();
  }
  async function runGrid(more) {
    const v = search.view;
    if (!v) return;
    let st = search.grid;
    if (!more || !st) st = search.grid = { media: [], more: null, pages: 0, loading: true };
    else { if (!st.more || st.loading) return; st.loading = true; }
    render();
    const seq = ++search.seqGrid;
    const res = await loadTagOrPlace(v, more ? st.more : null);
    if (seq !== search.seqGrid || search.grid !== st || search.view !== v) return;
    st.loading = false;
    if (!res) { if (!st.media.length) st.error = true; }
    else { st.media = addNew(st.media, slim(res.media)); st.more = res.more; st.pages++; st.noRecent = !!res.noRecent; st.unordered = !!res.unordered; }
    render();
  }

  // Open a profile/post from search. Try Instagram's in-app navigation;
  // if Instagram doesn't draw the new page, load it normally. Back to the
  // page search was opened from brings search back as you left it.
  let openTimer = 0, syntheticPop = false;
  function pageSig() {
    const m = document.querySelector('main') || document.body;
    return document.title + '|' + (m ? m.textContent.slice(0, 400) : '');
  }
  function openPath(path) {
    search.token = String(Date.now()) + Math.random().toString(16).slice(2, 6);
    search.suspended = true;
    try { nativeReplace.call(history, Object.assign({}, history.state || {}, { sgSearch: search.token }), ''); } catch (e) { /* ignore */ }
    saveSearch();
    hideSearch(false);
    const target = new URL(path, location.href);
    const before = pageSig();
    clearTimeout(openTimer);
    try {
      history.pushState(null, '', path);
      syntheticPop = true;
      window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    } catch (e) {
      location.assign(path);
      return;
    } finally {
      syntheticPop = false;
    }
    openTimer = setTimeout(() => {
      if (location.pathname + location.search === target.pathname + target.search && pageSig() === before) location.replace(path);
    }, 1800);
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
    if (search.view) { search.view = null; search.grid = null; render(); return true; }
    closeSearch(true);
    return true;
  };
  // Returning to the page search was opened from brings it back as you left it.
  function restoreSearch() {
    if (CFG.role !== 'main' || search.open || syntheticPop) return;
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
    try { const st = Object.assign({}, history.state); delete st.sgSearch; nativeReplace.call(history, st, ''); } catch (e) { /* ignore */ }
    search.suspended = false;
    showSearch();
    render();
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
    new MutationObserver(queueTidy).observe(document.documentElement, { childList: true, subtree: true });
    post('ready', { url: location.href, route: route() });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', safe(start), { once: true });
  else safe(start)();
})();
