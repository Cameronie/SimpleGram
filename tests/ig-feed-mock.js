// A model of Instagram's feed page for the batch-4 feed tests (not Instagram's
// code). Runs inside the test page. What it copies, from Instagram's bundles:
// - The first page comes from the route's preloader before the feed page
//   component exists (PolarisFeedRoot.entrypoint: first = 3).
// - The feed page component is deferred (PolarisFeed.react), so the list
//   mounts a while after the data: __igParams.mountMs.
// - An empty first page: Instagram asks for suggested accounts (loadSULV2 ->
//   xdt_api__v1__ayml__strict). In mode 'H1' it also shows its empty-feed
//   screen instead of the list (PolarisFeedComponent: showEmptyFeed ->
//   Favorites' star screen, or the suggested-accounts list). Who sets
//   showEmptyFeed is logged-in code we don't have, so H1 is a hypothesis;
//   'H2' mounts an empty list instead.
// - The list pages only from its onScroll: PolarisIGVirtualList listens to
//   window 'scroll' (capture), measures in a frame and calls
//   onScroll({numScreensFromEnd}); nothing on an item count change. The feed
//   throttles it (250 ms) and loads when numScreensFromEnd <= 1, with a
//   spinner while there is more or a load runs.
// Options (window.__igParams): mode 'H1'|'H2', mountMs, trustedOnly (the list
// reacts only to real scroll events), renderDelay (React draws a while after
// the data), onInitialize. IG.refetch() reloads the 3-item head in place
// (pull to refresh). Posts and suggestions are drawn as <article> with a
// /p/<code>/ link; suggestions carry data-rec.
(function () {
  const P = window.__igParams || {};
  const variant = new URLSearchParams(location.search).get('variant') || 'home';
  const IG = window.__ig = { variant, items: [], hasNext: true, loading: false, page: 0, requests: [], mountedAt: 0,
    empty: false, firstLen: null, sul: null, onScrollCalls: 0, loadsFromScroll: 0, t0: performance.now() };
  async function fetchPage(n) {
    IG.requests.push({ n, t: Math.round(performance.now() - IG.t0) });
    const r = await fetch('/api/graphql?variant=' + variant + '&page=' + n, { method: 'POST' });
    const data = await r.json();
    return data.data.xdt_api__v1__feed__timeline__connection;
  }
  function addEdges(c) {
    for (const e of c.edges) {
      const n = e.node;
      const m = n.media || (n.explore_story && n.explore_story.media);
      if (m) IG.items.push({ code: m.code, rec: !n.media });
      else if (n.end_of_feed_demarcator) IG.items.push({ code: '', marker: true });
    }
    IG.hasNext = !!c.page_info.has_next_page;
  }
  let main, outer, inner, spinner;
  function article(it) {
    if (it.marker) return '<div class="eof" style="height:120px">caught up</div>';
    return '<article data-code="' + it.code + '"' + (it.rec ? ' data-rec="1"' : '') + ' style="display:block"><header style="height:56px">user</header>' +
      '<div style="height:515px;background:#333"></div><section style="height:48px">actions</section>' +
      '<div style="height:70px">caption</div><a href="/p/' + it.code + '/"><time>1d</time></a></article>';
  }
  function render() {
    if (!inner) return;
    while (inner.children.length < IG.items.length) {
      const d = document.createElement('div');
      d.innerHTML = article(IG.items[inner.children.length]);
      inner.appendChild(d);
    }
    spinner.style.display = IG.hasNext || IG.loading ? 'block' : 'none';
  }
  async function loadNext() {
    IG.loading = true; render();
    try { addEdges(await fetchPage(IG.page++)); } finally {
      IG.loading = false;
      if (P.renderDelay) setTimeout(render, P.renderDelay); else render();
    }
  }
  // Instagram's throttle: a leading call, then one trailing call per window.
  function throttle(fn, ms) {
    let last = 0, timer = 0, pending = null;
    return function (arg) {
      const now = Date.now();
      if (!timer && now - last >= ms) { last = now; fn(arg); return; }
      pending = arg;
      if (!timer) timer = setTimeout(() => { timer = 0; last = Date.now(); const a = pending; pending = null; fn(a); }, ms - (now - last));
    };
  }
  const onScroll = throttle(s => {
    IG.onScrollCalls++;
    if (IG.hasNext && !IG.loading && s.numScreensFromEnd <= 1) { IG.loadsFromScroll++; loadNext(); }
  }, 250);
  let measureQueued = false;
  function measureThenOnScroll(ev) {
    if (P.trustedOnly && ev && ev.isTrusted === false) return;
    if (measureQueued) return;
    measureQueued = true;
    requestAnimationFrame(() => {
      measureQueued = false;
      const r = outer.getBoundingClientRect();
      const start = Math.max(0, -r.top);
      onScroll({ numScreensFromEnd: (outer.scrollHeight - start) / innerHeight - 1 });
    });
  }
  function emptyView() {
    if (!IG.empty || !main) return;
    if (variant === 'favorites') {
      main.innerHTML = '<div id="null-state" style="padding:40px;text-align:center"><svg aria-label="Star outline icon in circle."></svg>' +
        '<h2>Choose the accounts you can\'t miss out on</h2></div>';
    } else {
      // The suggested-accounts list; SimpleGram empties it, so nothing shows.
      main.innerHTML = '<div id="sul">' + Array.from({ length: IG.sul || 0 }, () => '<div style="height:60px">account</div>').join('') + '</div>';
    }
  }
  IG.refetch = async () => {
    const c = await fetchPage(0);
    IG.page = 1; IG.items = []; if (inner) inner.innerHTML = '';
    addEdges(c);
    IG.refetchLen = c.edges.length;
    render();
  };
  function mount() {
    IG.mountedAt = Math.round(performance.now() - IG.t0);
    main = document.getElementById('main');
    if (IG.empty) { emptyView(); return; }
    outer = document.createElement('div');
    inner = document.createElement('div');
    inner.style.cssText = 'display:flex;flex-direction:column';
    spinner = document.createElement('div');
    spinner.id = 'ig-spinner';
    spinner.style.cssText = 'height:60px';
    spinner.textContent = 'spinner';
    outer.appendChild(inner);
    main.appendChild(outer);
    main.appendChild(spinner);
    window.addEventListener('scroll', measureThenOnScroll, { capture: true, passive: true });
    render();
    if (P.onInitialize) measureThenOnScroll();
  }
  (async () => {
    const c = await fetchPage(0);
    IG.page = 1;
    IG.firstLen = c.edges.length;
    addEdges(c);
    if (c.edges.length === 0) {
      fetch('/api/ayml', { method: 'POST' }).then(r => r.json()).then(d => {
        const v = d.data.xdt_api__v1__ayml__strict;
        IG.sul = v && Array.isArray(v.users) ? v.users.length : 0;
        emptyView();
      });
      if (P.mode === 'H1') IG.empty = true;
    }
    setTimeout(mount, P.mountMs || 0);
  })();
  // What is on screen: posts in view (not hidden), the spinner, the empty view.
  IG.screen = () => {
    const arts = Array.from(document.querySelectorAll('article'));
    const shown = a => getComputedStyle(a).display !== 'none';
    const inView = arts.filter(a => { const r = a.getBoundingClientRect(); return shown(a) && r.bottom > 60 && r.top < innerHeight - 50; });
    const sp = document.getElementById('ig-spinner');
    const spR = sp && sp.style.display !== 'none' ? sp.getBoundingClientRect() : null;
    const nul = document.getElementById('null-state');
    return { posts: arts.length, inView: inView.map(a => a.dataset.code), recsShown: arts.filter(a => a.dataset.rec && shown(a)).length,
      spinner: !!(spR && spR.top < innerHeight && spR.bottom > 0), nullState: nul ? nul.textContent.slice(0, 40) : '',
      scrollable: document.scrollingElement.scrollHeight - innerHeight };
  };
})();
