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
    swipesBlocked: 0, indexed: 0,
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

  const feedState = { emptyStreak: 0 };
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
    const kept = [];
    let keptMedia = 0;
    verdicts.forEach((x, i) => {
      stats.feed.seen++;
      if (x.drop) stats.feed[x.reason]++;
      else { kept.push(list[i]); if (x.media) keptMedia++; }
    });
    stats.feed.kept += keptMedia;
    if (kept.length !== list.length) list.splice(0, list.length, ...kept);
    if (keptMedia === 0 && hasMore(owner)) {
      feedState.emptyStreak++;
      if (feedState.emptyStreak >= 4) { stopPagination(owner); stats.feed.stopped++; }
      else scheduleNudge();
    } else if (keptMedia > 0) {
      feedState.emptyStreak = 0;
    }
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
      else if (k === 'sectional_items' && Array.isArray(v) && route() !== 'search') { blankLists(v, 'exploreBlanked'); stopPagination(o); }
      else if (SUGGEST_KEY.test(k)) blankLists(v, 'suggestionsBlanked');
      else if (AD_CONTAINER_KEY.test(k)) blankLists(v, 'ads');
      else if (SEARCH_KEY.test(k) && route() === 'search') limitSearch(v);
      if (Array.isArray(v) && v.length && AD_LIST_KEY.test(k)) dropAds(v);
    }
    if (looksLikeMedia(o)) indexMedia(o);
  }
  function cleanse(root) {
    if (!root || typeof root !== 'object') return;
    stats.payloads++;
    searchCounted = false;
    streamed = root.hasNext === true || !!(root.extensions && root.extensions.is_final === false);
    if (Array.isArray(root.sectional_items) && route() !== 'search') {
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

  let nudgeTimer = 0;
  function scheduleNudge() {
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(safe(() => {
      const se = document.scrollingElement;
      if (!se) return;
      if (se.scrollHeight - (se.scrollTop + innerHeight) > innerHeight * 1.5) return;
      window.dispatchEvent(new Event('scroll'));
      const y = se.scrollTop;
      if (y > 2) {
        se.scrollTop = y - 1;
        requestAnimationFrame(() => { se.scrollTop = y; });
      }
    }), 700);
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
    for (const article of document.querySelectorAll('article')) {
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
  window.addEventListener('popstate', safe(() => { routeChanged(); restoreScroll(); }));

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
    const b = v.getBoundingClientRect();
    if (r === 'direct' || r === 'post') return b.width * b.height > 0.45 * innerWidth * innerHeight;
    return false;
  }
  function audioLabel(el) {
    const own = el.getAttribute && el.getAttribute('aria-label');
    if (own && /audio|sound|mute/i.test(own)) return own;
    const svg = el.querySelector && el.querySelector('svg[aria-label]');
    const l = svg && svg.getAttribute('aria-label');
    return l && /audio|sound|mute/i.test(l) ? l : '';
  }
  function findAudioToggle(v) {
    let scope = v.parentElement;
    for (let i = 0; scope && i < 8; i++, scope = scope.parentElement) {
      for (const el of scope.querySelectorAll('button,[role="button"]')) {
        if (audioLabel(el)) return el;
      }
    }
    return null;
  }
  function unmute(v) {
    const used = unmuteBudget.get(v) || { n: 0, t: Date.now() };
    if (Date.now() - used.t > 10000) { used.n = 0; used.t = Date.now(); }
    if (used.n >= 4) return;
    used.n++;
    unmuteBudget.set(v, used);
    const toggle = findAudioToggle(v);
    if (toggle) {
      try { toggle.click(); } catch (e) { /* ignore */ }
      setTimeout(() => { if (v.muted && !userMuted) v.muted = false; }, 300);
    } else {
      v.muted = false;
    }
  }
  document.addEventListener('play', safe(e => {
    const v = e.target;
    if (!(v instanceof HTMLVideoElement)) return;
    if (CFG.role !== 'main') { v.pause(); v.muted = true; return; }
    queueAwake();
    if (v.muted && !userMuted && wantsSound(v)) unmute(v);
  }), true);
  document.addEventListener('volumechange', safe(e => {
    const v = e.target;
    if (!(v instanceof HTMLVideoElement) || CFG.role !== 'main') return;
    if (Date.now() - lastUserAudioTap < 800) { userMuted = v.muted; return; }
    if (v.muted && !userMuted && !v.paused && wantsSound(v)) setTimeout(() => { if (v.muted && !userMuted) unmute(v); }, 150);
  }), true);

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
    const art = el && el.closest('article');
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
  async function fetchInfo(pk) {
    if (!pk) return null;
    const res = await fetch('/api/v1/media/' + pk + '/info/', {
      credentials: 'include',
      headers: { 'X-IG-App-ID': '936619743392459', 'X-Requested-With': 'XMLHttpRequest' },
    });
    if (!res.ok) return null;
    const data = await res.json();          // indexed by the Response.json hook
    const item = data && Array.isArray(data.items) ? data.items[0] : null;
    if (item && looksLikeMedia(item)) indexMedia(item);
    return item ? (index.byPk.get(mediaPk(item)) || null) : null;
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
      if (s.storyPk && index.byPk.has(s.storyPk)) return index.byPk.get(s.storyPk);
      if (hit) return hit.rec;
      return s.storyPk ? await fetchInfo(s.storyPk) : null;
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
      out.error = s.kind === 'video'
        ? 'This video could not be matched to a downloadable file. Try again after it plays for a moment.'
        : 'This photo could not be found.';
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
    const art = control.closest('article');
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
    const btn = t.closest('button,[role="button"]');
    return btn && audioLabel(btn) ? btn : null;
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
    new MutationObserver(queueTidy).observe(document.documentElement, { childList: true, subtree: true });
    post('ready', { url: location.href, route: route() });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', safe(start), { once: true });
  else safe(start)();
})();
