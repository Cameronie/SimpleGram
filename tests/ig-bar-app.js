// A model of Instagram's logged-in mobile bottom bar for tests/star.test.cjs,
// rebuilt from its web bundles (PolarisPageLayoutHandler > PolarisNavigation
// (bottom) > PolarisNavigationIcons > Polaris*NavItem > PolarisNavigationItem)
// with the same atomic class names, so the CSS subset in ig-bar.css lays it
// out as Instagram's does. React 19 renders it, so the star SimpleGram adds
// meets a real reconciler. It is a model, not Instagram's code.
//
// window.__mockMode: 'client' (default), 'hydrate' (the bar is in the page as
// plain HTML first and React takes it over after __hydrateDelay ms), 'static'
// (plain HTML React never takes over). With window.__suspense, 'hydrate' puts
// the bar and 400 slow posts (5 ms each) in one Suspense boundary beside a
// ticker, so React hydrates them in time slices (window.__tickAt: the ticker
// updates then, from outside the boundary).
(function () {
  'use strict';
  const h = React.createElement;
  window.__igClicks = [];      // hrefs whose React onClick ran (Instagram saw the tap)
  window.__renderErrors = [];
  window.__goCalls = [];

  const P = {
    homeOn: 'm21.762 8.786-7-6.68a3.994 3.994 0 0 0-5.524 0l-7 6.681A4.017 4.017 0 0 0 1 11.68V19c0 2.206 1.794 4 4 4h3.005a1 1 0 0 0 1-1v-7.003a2.997 2.997 0 0 1 5.994 0V22a1 1 0 0 0 1 1H19c2.206 0 4-1.794 4-4v-7.32a4.02 4.02 0 0 0-1.238-2.894Z',
    homeOff: 'm21.762 8.786-7-6.68C13.266.68 10.734.68 9.238 2.106l-7 6.681A4.017 4.017 0 0 0 1 11.68V20c0 1.654 1.346 3 3 3h5.005a1 1 0 0 0 1-1L10 15c0-1.103.897-2 2-2 1.09 0 1.98.877 2 1.962L13.999 22a1 1 0 0 0 1 1H20c1.654 0 3-1.346 3-3v-8.32a4.021 4.021 0 0 0-1.238-2.894ZM21 20a1 1 0 0 1-1 1h-4.001L16 15c0-2.206-1.794-4-4-4s-4 1.794-4 4l.005 6H4a1 1 0 0 1-1-1v-8.32c0-.543.226-1.07.62-1.447l7-6.68c.747-.714 2.013-.714 2.76 0l7 6.68c.394.376.62.904.62 1.448V20Z',
    reels: 'M2 3h20v18H2Z',
    direct: 'M13.973 20.046 21.77 6.928C22.8 5.195 21.55 3 19.535 3H4.466C2.138 3 .984 5.825 2.646 7.456l4.842 4.752 1.723 7.121c.548 2.266 3.571 2.721 4.762.717Z',
    profile: 'M12 .5C5.66.5.5 5.66.5 12S5.66 23.5 12 23.5 23.5 18.34 23.5 12 18.34.5 12 .5Z',
  };
  // IGDSSVGIconBase: class root (x1lliihq x1n2onr6) + colour ig-primary-text (x5n08af), fill currentColor.
  function Svg(props) {
    return h('svg', { 'aria-label': props.alt, className: 'x1lliihq x1n2onr6 x5n08af', fill: 'currentColor', height: 24, role: 'img', viewBox: '0 0 24 24', width: 24 },
      h('title', null, props.alt), props.children);
  }
  const icons = {
    Feed: on => h(Svg, { alt: 'Home' }, h('path', { d: on ? P.homeOn : P.homeOff })),
    Search: on => h(Svg, { alt: 'Explore' },
      h('path', { d: 'M19 10.5A8.5 8.5 0 1 1 10.5 2a8.5 8.5 0 0 1 8.5 8.5Z', fill: 'none', stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round', strokeWidth: on ? '3' : '2' })),
    Reels: () => h(Svg, { alt: 'Reels' }, h('path', { d: P.reels })),
    Direct: () => h(Svg, { alt: 'Messages' }, h('path', { d: P.direct, fill: 'none', stroke: 'currentColor', strokeLinejoin: 'round', strokeWidth: '2' })),
    Profile: () => h(Svg, { alt: 'Profile' }, h('path', { d: P.profile })),
    Create: () => h(Svg, { alt: 'New post' }, h('path', { d: 'M2 2h20v20H2Z', fill: 'none', stroke: 'currentColor', strokeWidth: '2' })),
  };

  function go(href) {
    window.__goCalls.push(href);
    history.pushState({}, '', href);
    window.dispatchEvent(new Event('mockroute'));
  }

  // PolarisNavigationItem (bottom, phone): wrapper div > BaseLink a > container > icon box.
  function NavItem(props) {
    const [pressed, setPressed] = React.useState(false);
    const container = 'x9f619 x3nfvp2 x1xmf6yo x1e56ztr x1rl75mt x19t5iym xz7t8uv x13xmedi xz9dl7a xpdmqnj xsag5q8 x1g0dm76 x1dn74xm xif99yt x172qv1o x4afuhf x1lhsz42 x10v4vz6 xdoji71 x1dejxi8 x9k3k5o x8st7rj x11hdxyr x1eunh74 x1wj20lx' + (pressed ? ' x1har8x' : '');
    return h('div', { className: 'x1n2onr6' },
      h('a', {
        className: 'x1i10hfl xjbqb8w x1ejq31n x18oe1m7 x1sy0etr xstzfhl x972fbf x10w94by x1qhh985 x14e42zd x9f619 x1ypdohk xt0psk2 x3ct3a4 xdj266r x14z9mp xat24cr x1lziwak xexx8yu xyri2b x18d9i69 x1c1uobl x16tdsg8 x1hl2dhg xggy1nq x1a2a7pz _a6hd',
        href: props.href, role: 'link', tabIndex: 0,
        onPointerDown: () => setPressed(true), onPointerUp: () => setPressed(false), onPointerLeave: () => setPressed(false),
        onClick: e => { e.preventDefault(); window.__igClicks.push(props.href); if (props.onClick) props.onClick(e); else go(props.href); },
      },
      h('div', { className: container },
        h('div', null, h('div', { className: 'x78zum5 x1n2onr6' },
          h('div', { 'aria-selected': !!props.active, className: 'x9f619 xxk0z11 xii2z7h x11xpdln x19c4wfv xvy4d1p' }, props.icon))),
        h('div', { className: 'x6s0dn4 x9f619 xxk0z11 x6ikm8r xeq5yr9 xf7dkkf x1s85apg xzzcqpx' },
          h('div', { style: { width: '100%' } }, h('div', { style: { width: '100%' } }, h('span', { className: 'x1lliihq x1plvlek xryxfnj' }, props.label)))))));
  }

  // PolarisNavigationIcons, bottomNavigation (a flex row) or the side bar (not a flex row).
  function Icons(props) {
    const path = props.path, onFeed = path === '/';
    return h('div', { className: props.side ? 'x1iyjqo2 xh8yej3' : 'x78zum5 xaw8158 xh8yej3', 'data-visualcompletion': 'ignore-dynamic' },
      h('div', { key: 'feed' }, h('div', { className: 'x1n2onr6' },
        h(NavItem, { href: '/', label: 'Home', active: onFeed, icon: icons.Feed(onFeed) }))),
      props.igFav ? h('div', { key: 'igfav' }, h(NavItem, { href: '/?variant=favorites', label: 'Favorites', icon: icons.Profile() })) : null,
      h('div', { key: 'explore' }, h(NavItem, { href: '/explore/', label: 'Explore', active: path === '/explore/', icon: icons.Search(path === '/explore/') })),
      h('div', { key: 'reels' }, h(NavItem, { href: '/reels/', label: 'Reels', icon: icons.Reels() })),
      props.showCreate ? h('div', { key: 'desktop-creation' }, h(NavItem, { href: '#create', label: 'Create', icon: icons.Create(), onClick: () => {} })) : null,
      h('div', { key: 'direct' }, h(NavItem, { href: '/direct/inbox/', label: 'Messages', icon: icons.Direct() })),
      h('div', { key: 'profile' }, h('div', { className: 'x1n2onr6' },
        h(NavItem, { href: '/me/', label: 'Profile', active: path === '/me/', icon: icons.Profile() }))));
  }

  // PolarisNavigation inside PolarisPageLayoutHandler's fixed IGDSBox: at the
  // bottom on a phone, a column at the start on a wide screen.
  function Navigation(props) {
    const style = props.side ? { position: 'fixed', top: 0, left: 0, bottom: 0, width: '72px' } : { position: 'fixed', bottom: 0, left: 0 };
    return h('div', { style: style, className: 'x1dr59a3 xeq5yr9 x1n327nk xg7h5cd xh8yej3 xhtitgo x6w1myc x1jeouym', 'data-mock': 'nav' },
      h('div', { className: 'x78zum5 x1q0g3np x1gvbg2u x1qughib x1n2onr6 xleuxlb xxfw5ft x1mh60rb x1f91t4q' },
        h('div', { className: 'xvbhtw8 xh8yej3' },
          h('div', { className: 'x1o5hw5a xaeubzz x1yvgwvq x13fuv20 x178xt8z x9f619 x78zum5 x1q0g3np xaw8158 x1n2onr6 xh8yej3' },
            h(Icons, props)))));
  }

  function Shell(props) {
    return h('div', { className: 'x78zum5 xdt5ytf', 'data-mock': 'shell-' + props.name },
      h(Navigation, props),
      h('div', { className: 'xh8yej3 x8vgawa' }, props.children));
  }
  // The feed page. On Following and Favorites, PolarisFeedVariantsHeader's
  // "< Favorites" link is a PolarisFastLink to "/" (an in-page switch), in
  // the mobile header, which on a phone is a <nav> holding a <header>.
  function Feed() {
    const v = new URLSearchParams(location.search).get('variant') || 'home';
    const posts = [];
    for (let i = 0; i < 12; i++) posts.push(h('article', { key: i, style: { height: '420px', margin: '8px 0', background: 'rgba(128,128,128,.25)' } }, v + ' post ' + i));
    return h('section', { id: 'feedcol' },
      // PolarisMobileHeaderWrapper's <nav> > PolarisGenericMobileHeader's <header> > IGDSBox > the link.
      v === 'home' ? null : h('nav', { id: 'variants-header' }, h('header', null, h('div', null,
        h('a', { id: 'variants-back', href: '/', onClick: e => { e.preventDefault(); window.__igClicks.push('header /'); go('/'); } }, '< ' + v)))),
      h('div', null, 'stories tray'),
      h('main', { 'data-variant': v }, h('div', { id: 'feed' }, posts)));
  }

  // Instagram's bar follows the window: below 768 px a bottom bar, wider a side bar.
  const small = window.matchMedia('(max-width: 767px)');
  function App() {
    const [, force] = React.useState(0);
    const [opts, setOpts] = React.useState({ showCreate: false, remount: 0, maintainFeed: false, side: !small.matches });
    React.useEffect(() => {
      const f = () => force(x => x + 1);
      const mq = () => setOpts(p => Object.assign({}, p, { side: !small.matches }));
      window.addEventListener('mockroute', f);
      window.addEventListener('popstate', f);
      small.addEventListener('change', mq);
      window.__app = { set: o => setOpts(p => Object.assign({}, p, o)), rerender: f };
      return () => { window.removeEventListener('mockroute', f); window.removeEventListener('popstate', f); small.removeEventListener('change', mq); };
    }, []);
    const path = location.pathname;
    const common = { path: path, showCreate: opts.showCreate, side: opts.side, igFav: opts.igFav };
    const feed = h(Shell, Object.assign({ key: 'feed-' + opts.remount, name: 'feed' }, common), h(Feed));
    if (path === '/') return feed;
    const other = h(Shell, Object.assign({ key: 'other-' + opts.remount, name: 'other' }, common), h('main', null, 'page ' + path));
    // A kept-alive route keeps Home mounted (hidden) under the other page.
    return opts.maintainFeed ? h(React.Fragment, null, h('div', { key: 'kept', style: { display: 'none' } }, feed), other) : other;
  }

  // The Suspense case: a server-drawn boundary React hydrates in slices.
  function Post(p) {
    if (window.__spin) { const t = performance.now(); while (performance.now() - t < 5) { /* a slow post */ } }
    return h('article', { style: { height: '40px' }, onClick: () => { window.__postClicks = (window.__postClicks || 0) + 1; } }, 'slow ' + p.i);
  }
  function Slow() { const out = []; for (let i = 0; i < 400; i++) out.push(h(Post, { key: i, i: i })); return h('div', { id: 'slow' }, out); }
  function Ticker() {
    const [n, set] = React.useState(0);
    React.useEffect(() => { if (window.__tickAt) setTimeout(() => set(1), window.__tickAt); }, []);
    return h('span', { id: 'tick' }, String(n));
  }
  function Done() { React.useEffect(() => { window.__boundaryDone = true; }, []); return null; }   // after React commits the boundary
  function SuspenseTree() { return h(React.Fragment, null, h(Ticker), h(React.Suspense, { fallback: null }, h(App), h(Slow), h(Done))); }

  const rootOpts = {
    onUncaughtError: e => window.__renderErrors.push(String(e && e.message || e)),
    onCaughtError: e => window.__renderErrors.push(String(e && e.message || e)),
    onRecoverableError: e => window.__renderErrors.push('recoverable: ' + String(e && e.message || e)),
  };
  const mount = document.getElementById('mount');
  const mode = window.__mockMode || 'client';
  if (mode === 'hydrate' || mode === 'static') {
    // The bar as plain HTML first, like a server-drawn page: React's own
    // output, copied without React's keys on the nodes.
    const tmp = document.createElement('div');
    const r = ReactDOMClient.createRoot(tmp);
    const susp = mode === 'hydrate' && window.__suspense;
    ReactDOM.flushSync(() => r.render(susp ? h(React.Fragment, null, h(Ticker), h(App), h(Slow)) : h(App)));
    let html = tmp.innerHTML;
    if (susp) html = html.replace('<span id="tick">0</span>', '<span id="tick">0</span><!--$-->') + '<!--/$-->';
    r.unmount();
    mount.innerHTML = html;
    window.__beforeHydrate = { home: mount.querySelector('a[href="/"]') };
    if (mode === 'hydrate') {
      setTimeout(() => {
        if (susp) window.__spin = true;
        ReactDOMClient.hydrateRoot(mount, h(susp ? SuspenseTree : App), rootOpts);
        window.__hydrateCalled = true;
      }, window.__hydrateDelay || 600);
    }
    return;
  }
  const root = ReactDOMClient.createRoot(mount, rootOpts);
  // Drawn during parsing, before DOMContentLoaded (when the rest of SimpleGram starts).
  if (window.__syncRender) ReactDOM.flushSync(() => root.render(h(App)));
  else root.render(h(App));
  window.__renderedBeforeDCL = document.readyState === 'loading' && !!document.querySelector('[data-mock="nav"]');
})();
