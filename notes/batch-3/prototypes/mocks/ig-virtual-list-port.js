// A vanilla port of Instagram's PolarisIGVirtualList window/measure logic
// (b32.js "PolarisIGVirtualList.react", "PolarisSizeCache"; b383.js
// "PolarisBatchDOM"), driven like a Relay paginated feed. Window-scroll mode
// (containerSize == null), as the mobile Home feed scrolls the document.
(function () {
  const measureQ = [], mutateQ = [];
  let scheduled = false;
  function flush() { scheduled = false; while (measureQ.length || mutateQ.length) { while (mutateQ.length) mutateQ.shift()(); while (measureQ.length) measureQ.shift()(); } }
  function sched() { if (!scheduled) { scheduled = true; requestAnimationFrame(flush); } }
  const BatchDOM = { measure(f) { measureQ.push(f); sched(); }, mutate(f) { mutateQ.push(f); sched(); } };

  class SizeCache {
    constructor(est) { this.m = new Map(); this.est = est; }
    setSize(i, s) { this.m.set(i, s); }
    getSize(i) { const v = this.m.get(i); return v != null ? v : this.est; }
    getDistance(a, b) { let e = 0; for (let r = a; r < b; r++) e += this.getSize(r); return e; }
    getIndex(t, n) { let e = 0; for (let r = 0; r < n; r++) { e += this.getSize(r); if (e > t) return r; } return n; }
    getLastIndex(t, n) { let e = 0; for (let r = 0; r < n; r++) { e += this.getSize(r); if (e > t) { if (r + 1 < n && this.getSize(r + 1) === 0) continue; return r; } } return n; }
  }

  const V = window.__vl = {
    items: [], hasNext: true, loading: false, cursor: 0, requests: 0, mounts: 0, unmounts: 0, renders: 0,
    state: { renderStart: 0, renderEnd: 0, visibleStart: 0, visibleEnd: 0 },
    cache: new SizeCache(900), overscan: 3, els: new Map(), screensThreshold: 3,
  };
  let outer, inner, spinner;
  function measureWindow() {
    return new Promise(res => BatchDOM.measure(() => {
      const r = outer.getBoundingClientRect();
      res({ scrollStart: Math.max(0, -r.top), viewportSize: innerHeight, scrollSize: outer.scrollHeight });
    }));
  }
  function zeros(a, b) { let e = 0; for (let r = a; r < b; r++) if (V.cache.getSize(r) === 0) e++; return e; }
  function computeWindow(t) {
    const r = Math.abs(t.scrollStart), n = V.items.length, a = V.overscan, i = r + t.viewportSize;
    const l = V.cache.getIndex(r, n), s = V.cache.getLastIndex(i, n) + 1;
    const u = zeros(0, l), c = zeros(s, n);
    return { renderStart: Math.max(0, l - a - u), renderEnd: s + a + c, visibleStart: l, visibleEnd: s };
  }
  function setWindow(t) {
    const w = computeWindow(t), st = V.state;
    if (w.renderStart !== st.renderStart || w.renderEnd !== st.renderEnd || w.visibleStart !== st.visibleStart || w.visibleEnd !== st.visibleEnd) { V.state = w; render(); }
  }
  function update() {
    return measureWindow().then(t => {
      setWindow(t);
      const a = Math.abs(t.scrollStart);
      return { numScreensFromEnd: (t.scrollSize - a) / t.viewportSize - 1, numScreensFromStart: a / t.viewportSize, numItemsFromEnd: V.items.length - V.state.visibleEnd };
    });
  }
  function render() {
    V.renders++;
    const st = V.state, n = V.items.length;
    const end = Math.min(st.renderEnd, n);
    inner.style.paddingTop = V.cache.getDistance(0, st.renderStart) + 'px';
    inner.style.paddingBottom = V.cache.getDistance(st.renderEnd, n) + 'px';
    // keyed reconcile like React
    const want = [];
    for (let i = st.renderStart; i < end; i++) {
      let el = V.els.get(i);
      if (!el) {
        const d = document.createElement('div');
        d.className = 'item';
        d.innerHTML = window.__mkArticle(V.items[i].i, V.items[i].opts);
        el = d; V.els.set(i, el); V.mounts++;
        if (V.items[i].opts.label) { V.labelMounts = (V.labelMounts || 0) + 1; d.dataset.lab = '1'; d.dataset.mt = performance.now(); }
      }
      want.push(el);
    }
    const keep = new Set(want);
    for (const [i, el] of V.els) if (!keep.has(el)) { el.remove(); V.els.delete(i); V.unmounts++; }
    want.forEach((el, k) => { if (inner.children[k] !== el) inner.insertBefore(el, inner.children[k] || null); });
    spinner.style.display = V.hasNext ? 'block' : 'none';
    // componentDidUpdate -> $8 measure children
    BatchDOM.measure(() => {
      const rs = V.state.renderStart, vs = V.state.visibleStart;
      for (let l = 0; l < inner.children.length; l++) {
        const c = inner.children[l], e = c.getBoundingClientRect(), nx = c.nextElementSibling;
        let a;
        if (e.height === 0) a = 0;
        else if (nx) a = nx.getBoundingClientRect().top - e.top;
        else a = inner.getBoundingClientRect().bottom - parseFloat(inner.style.paddingBottom) - e.top;
        if (V.cache.getSize(rs + l) !== a) V.cache.setSize(rs + l, a);
      }
    });
  }
  function onScroll(info) {
    if (info.numScreensFromEnd < V.screensThreshold && info.numScreensFromStart >= 0 && V.hasNext && !V.loading) loadNext();
  }
  async function loadNext() {
    V.loading = true; V.requests++;
    try {
      const res = await fetch('/api/graphql?page=' + V.cursor, { method: 'POST' });
      const data = await res.json();       // SimpleGram's Response.json hook filters here
      const conn = data.data.xdt_api__v1__feed__timeline__connection;
      for (const e of conn.edges) {
        const n = e.node;
        const m = n.media || (n.explore_story && n.explore_story.media);
        if (m) V.items.push({ i: V.items.length, code: m.code, opts: { video: !!m.video_versions, label: m.__domtag || '', user: m.user && m.user.username } });
        else if (n.end_of_feed_demarcator) V.items.push({ i: V.items.length, opts: { h: 200, label: '' }, demarcator: true });
      }
      V.hasNext = !!(conn.page_info && conn.page_info.has_next_page);
      V.cursor++;
    } finally {
      V.loading = false;
      render();
      update();          // componentDidUpdate on itemCount change: window only, no onScroll
    }
  }
  V.loadNext = loadNext;
  V.start = function () {
    outer = document.getElementById('feed');
    inner = document.createElement('div');
    inner.style.cssText = 'display:flex;flex-direction:column;position:relative';
    outer.appendChild(inner);
    spinner = document.getElementById('spin');
    window.addEventListener('scroll', () => { update().then(onScroll); }, { capture: true, passive: true });
    loadNext();
  };
  V.flashCheck = function () {
    // a labelled post that SimpleGram will hide is on screen and not hidden yet
    let n = 0;
    for (const el of inner.children) {
      if (!el.dataset.lab) continue;
      const a = el.firstElementChild;
      if (a && a.dataset.sgHidden) { if (!el.dataset.hd) { el.dataset.hd = '1'; (V.hideDelays = V.hideDelays || []).push(performance.now() - +el.dataset.mt); } continue; }
      const r = el.getBoundingClientRect();
      if (r.height > 0 && r.bottom > 50 && r.top < innerHeight - 50) { n++; if (!el.dataset.fl) { el.dataset.fl = '1'; V.flashes = (V.flashes || 0) + 1; } }
    }
    return n;
  };
  V.blankCheck = function () {
    // Is any rendered item visible between the top bar (50px) and bottom nav?
    const top = 50, bottom = innerHeight - 50;
    for (const el of inner.children) {
      const r = el.getBoundingClientRect();
      if (r.height > 0 && r.bottom > top && r.top < bottom) return false;
    }
    const sp = spinner.getBoundingClientRect();
    return !(sp.height > 0 && sp.bottom > top && sp.top < bottom);
  };
})();
