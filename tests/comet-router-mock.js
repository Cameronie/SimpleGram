// A small stand-in for Instagram's CometRouter, modelled on the website's
// bundles (notes/batch-3/diagnosis.md, B14). Runs inside the test page:
//  - buildCometHistory: one window 'popstate' listener -> router handler me()
//  - me(): key = history.state.key; unknown/null key -> go(current URL, {replace:true})
//  - go(): GOIMPL_TRIGGERED -> FETCHING_ROUTE (route definition) -> push/replaceState({key})
//          -> REACT_PENDING (useTransition keeps the OLD screen) -> render -> NO_ACTIVE_NAVIGATION
//  - window.require('ifRequired') + browserHistory_DO_NOT_USE + currentCometRouterInstance (optional)
//  - a newer navigation replaces a pending one; nav links can be router links (linkNav)
// Options (window.__mockcfg): exposeRequire, noStatus, dropPush, ignoreForeign, linkNav,
// fetchMs, renderMs, bootMs, restoreMs, homeImg, reelVideo.
(function () {
  const CFG = window.__mockcfg || {};
  const loads = +(sessionStorage.getItem('loads') || 0) + 1;
  sessionStorage.setItem('loads', loads);
  const routes = {};
  let seq = 0;
  const newKey = () => 'state-key-' + Date.now() + '-' + (seq++);
  let status = 'NO_ACTIVE_NAVIGATION';
  function pageFor(p) {
    if (p === '/') return { title: 'Instagram', html: '<div>HOME FEED: friend posts</div>' + (CFG.homeImg ? '<article><img srcset="https://scontent.cdninstagram.com/v/home_n.jpg 640w" src="https://scontent.cdninstagram.com/v/home_n.jpg" width="300" height="300"></article>' : '') };
    const m = /\/(p|reel)\/([^/]+)/.exec(p);
    if (m) {
      const video = CFG.reelVideo && m[1] === 'reel' ? '<video id="rv" muted playsinline style="display:block;width:400px;height:700px"></video>' : '';
      return { title: 'Post ' + m[2], html: '<article>POST ' + m[2] + '<img src="https://scontent.cdninstagram.com/v/' + m[2] + '_n.jpg" width="300" height="300">' + video + '</article>' };
    }
    // A profile whose tabs share the title and the first 400 characters (a long header).
    if (CFG.sameHeader) { const u = p.split('/')[1]; return { title: 'Profile ' + u, html: '<div>OTHER /' + u + '/ header ' + 'x'.repeat(400) + '</div><div>' + p + '</div>' }; }
    return { title: 'Other ' + p, html: '<div>OTHER ' + p + '</div>' };
  }
  function render(p) {
    const pg = pageFor(p);
    document.querySelector('main').innerHTML = pg.html;
    document.title = pg.title;
  }
  function boot() {
    const k0 = newKey();
    history.replaceState(Object.assign({}, history.state || {}, { key: k0 }), '', location.href);
    routes[k0] = location.pathname;
    // A full load takes a while before anything is drawn.
    setTimeout(() => render(location.pathname), loads > 1 ? (CFG.bootMs || 400) : 0);
  }
  const wait = ms => new Promise(r => setTimeout(r, ms));
  let latest = 0;
  async function go(url, opts) {
    opts = opts || {};
    window.__goCalls = (window.__goCalls || 0) + 1;
    // Instagram's forced full loads (ClientConsistency refresh, navigation_limit): goForceFullPageRedirectTo.
    if (CFG.forceReload && loads === 1 && opts.navigationType !== 'popstate') { status = 'GOIMPL_TRIGGERED'; if (opts.replace) location.replace(url); else window.location = url; return; }
    const nav = ++latest;                 // a newer navigation replaces a pending one
    status = 'GOIMPL_TRIGGERED';
    await wait(0);
    status = 'FETCHING_ROUTE';
    await wait(CFG.fetchMs == null ? 300 : CFG.fetchMs);
    if (nav !== latest) return;
    const key = newKey();
    routes[key] = new URL(url, location.href).pathname;
    if (opts.replace) history.replaceState({ key }, '', url); else history.pushState({ key }, '', url);
    status = 'REACT_PENDING';
    await wait(CFG.renderMs == null ? 500 : CFG.renderMs);
    if (nav !== latest) return;
    if (history.state && history.state.key === key) render(routes[key]);
    status = 'NO_ACTIVE_NAVIGATION';
  }
  // Instagram's own links navigate with the router (React onPress), not the browser.
  if (CFG.linkNav) {
    document.addEventListener('click', e => {
      const a = e.target.closest && e.target.closest('#nav a[href]');
      if (!a) return;
      e.preventDefault();
      go(a.getAttribute('href'), {});
    });
  }
  window.__mockLog = [];
  window.addEventListener('popstate', e => {
    const st = history.state, key = st && st.key;
    window.__mockLog.push({ t: Date.now(), trusted: e.isTrusted, key: key || null, known: !!(key && routes[key]) });
    if (key == null || !routes[key]) {
      if (CFG.ignoreForeign) return;
      go(location.pathname + location.search + location.hash, { replace: true, navigationType: 'popstate' });
      return;
    }
    status = 'REACT_PENDING';
    setTimeout(() => { render(routes[key]); status = 'NO_ACTIVE_NAVIGATION'; }, CFG.restoreMs || 60);
  });
  if (CFG.exposeRequire) {
    const mods = {
      browserHistory_DO_NOT_USE: { browserHistory: { push: p => { if (!CFG.dropPush) go(p, {}); } }, getCometRouterDispatcher: () => ({}) },
      currentCometRouterInstance: CFG.noStatus ? undefined : { get_THIS_IS_NOT_WHAT_YOU_WANT: () => ({ getCurrentRouterStatus: () => status }) },
    };
    const ifRequired = (name, yes, no) => mods[name] ? (typeof yes === 'function' ? yes(mods[name]) : undefined) : (typeof no === 'function' ? no() : undefined);
    window.require = name => { if (name === 'ifRequired') return ifRequired; if (mods[name]) return mods[name]; throw new Error('Requiring unknown module "' + name + '"'); };
  }
  boot();
})();
