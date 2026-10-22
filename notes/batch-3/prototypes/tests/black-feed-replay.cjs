// Reviewer experiment: is the blank/flash effect tied to runs of DOM-hidden posts,
// and does a cheaper DOM-side mitigation (hide in the MutationObserver callback +
// one synthetic scroll so the virtual list re-windows) remove it?
'use strict';
const path = require('node:path');
const BF = '/tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf/black-feed';
const fs = require('node:fs');
const { launch, openPage, stats } = require(path.join(BF, 'feedpage.cjs'));
const { build } = require(path.join(BF, 'instrument.cjs'));
const VLIST = fs.readFileSync(path.join(BF, 'vlist.js'), 'utf8');
const HTML = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>body{margin:0;background:#000;color:#fff}article{background:#111;border-bottom:1px solid #333}</style></head><body><div id="root">
<div style="position:fixed;top:0;left:0;right:0;height:50px;background:#222;z-index:5">Instagram</div>
<nav style="position:fixed;bottom:0;left:0;right:0;height:50px;background:#222;z-index:5"><a href="/">Home</a> <a href="/explore/">Explore</a> <a href="/direct/inbox/">DM</a></nav>
<main style="padding-top:50px"><div style="height:120px">stories tray</div><div id="feed"></div><div id="spin" style="height:60px;text-align:center">spinner</div><div style="height:60px"></div></main></div>
<script>${VLIST}</script><script>addEventListener('DOMContentLoaded',()=>__vl.start())</script></body></html>`;

function rep(s, a, b) { if (!s.includes(a)) throw new Error('nf ' + a.slice(0, 60)); return s.replace(a, b); }
function patched(opts) {
  opts = opts || { scroll: true, guard: false };
  let s = build();
  s = rep(s, "    new MutationObserver(queueTidy).observe(document.documentElement, { childList: true, subtree: true });",
`    new MutationObserver(safe(records => {
      if (route() === 'home' && CFG.role === 'main') {
        const arts = new Set();
        for (const r of records) for (const n of r.addedNodes) {
          const e = n.nodeType === 1 ? n : n.parentElement;
          if (!e || !e.closest) continue;
          const up = e.closest(POST);
          if (up) arts.add(up); else if (n.nodeType === 1) for (const a of e.querySelectorAll(POST)) arts.add(a);
        }
        let hid = 0;
        for (const a of arts) {
          if (a.dataset.sgHidden) continue;
          const reason = headerLabel(a);
          checked.set(a, { sig: articleSig(a), reason: reason });
          if (reason && hide(a, reason)) { stats.dom[reason]++; hid++; }
        }
        if (hid && __OPT_SCROLL__) requestAnimationFrame(() => window.dispatchEvent(new Event('scroll')));
        if (__OPT_GUARD__) { const all = document.querySelectorAll(POST); let run = 0; for (let i = all.length - 1; i >= 0 && all[i].dataset.sgHidden; i--) run++; window.__sgDomRun = run; }
      }
      queueTidy();
    })).observe(document.documentElement, { childList: true, subtree: true });`);
  if (opts.guard) s = rep(s, "    const verdicts = list.map(e => feedVerdict(e && e.node ? e.node : e));",
    "    if ((window.__sgDomRun || 0) >= 4 && route() === 'home') { stopPagination(owner); currentFeed().ended = true; stats.feed.domStop = (stats.feed.domStop || 0) + 1; }\n    const verdicts = list.map(e => feedVerdict(e && e.node ? e.node : e));");
  s = s.split('__OPT_SCROLL__').join(String(!!opts.scroll)).split('__OPT_GUARD__').join(String(!!opts.guard));
  return s;
}

let pk = 1;
function user(name, following) { const u = { pk: String(1000000 + pk++), username: name }; if (following !== undefined) u.friendship_status = { following }; return u; }
function media(code, u, video, extra) {
  const m = Object.assign({ pk: String(3000000 + pk++), id: String(3000000 + pk) + '_' + u.pk, code, user: u,
    image_versions2: { candidates: [{ url: 'https://scontent.cdninstagram.com/v/' + code + '_n.jpg', width: 1080, height: 1350 }] } }, extra || {});
  if (video) m.video_versions = [{ url: 'https://scontent.cdninstagram.com/v/' + code + '_v.mp4', width: 720, height: 1280, type: 101 }];
  return m;
}
// Shaped like the phone's Filter status: 1 friend page (2 posts), then
// explore_story-only pages (fail open). Labels on screen: none for the first
// recs pages (what the screenshots show); from page `runFrom` on, every rec carries
// a header label (the only way tidyFeed hides a run).
function page(n, runFrom) {
  const edges = [];
  const E = node => edges.push({ node: Object.assign({ __typename: 'XDTFeedItem' }, node), cursor: 'c' + n });
  if (n === 0) { E({ media: media('F0', user('friend0', true), false) }); E({ media: media('F1', user('friend1', true), true) }); }
  else if (n === 2) { E({ explore_story: { media: media('H' + n, user('hsmarken', false), false) } }); E({ end_of_feed_demarcator: { id: 'eof', title: "You're all caught up" } }); }
  else {
    for (let k = 0; k < 6; k++) {
      const m = media('R' + n + '_' + k, user('rec' + k, false), k % 2 === 0);
      if (runFrom >= 0 && n >= runFrom) m.__domtag = 'Suggested for you';
      E({ explore_story: { media: m } });
    }
  }
  return { data: { xdt_api__v1__feed__timeline__connection: { edges, page_info: { has_next_page: n < 60, end_cursor: 'p' + n } } }, extensions: { is_final: true } };
}
async function run(label, script, runFrom, { seconds = 25, speed = 45, throttle = 2 } = {}) {
  const api = { '/api/graphql': u => ({ body: page(+u.searchParams.get('page'), runFrom) }) };
  const browser = await launch();
  const { page: pg } = await openPage(browser, HTML, { api, throttle, script });
  await pg.waitForTimeout(1500);
  const res = await pg.evaluate(({ seconds, speed }) => new Promise(done => {
    const out = { frames: 0, blank: 0, longestBlank: 0, cur: 0, flashFrames: 0, maxVideos: 0 };
    const t0 = performance.now();
    function frame(now) {
      const el = now - t0;
      if (Math.floor(el / 600) % 2 === 0) window.scrollBy(0, speed);
      out.frames++;
      if (window.__vl.flashCheck()) out.flashFrames++;
      out.maxVideos = Math.max(out.maxVideos, document.getElementsByTagName('video').length);
      if (window.__vl.blankCheck()) { out.blank++; out.cur++; out.longestBlank = Math.max(out.longestBlank, out.cur); } else out.cur = 0;
      if (el < seconds * 1000) requestAnimationFrame(frame); else done(out);
    }
    requestAnimationFrame(frame);
  }), { seconds, speed });
  const p = await pg.evaluate(() => ({ items: __vl.items.length, requests: __vl.requests, flashes: __vl.flashes || 0, hideDelays: __vl.hideDelays || [],
    inDom: document.querySelectorAll('article').length, hidden: document.querySelectorAll('article[data-sg-hidden]').length,
    feed: window.__sg.stats.feed, dom: window.__sg.stats.dom, errors: window.__sg.stats.errors }));
  await browser.close();
  return { label, runFrom, blankFrames: res.blank + '/' + res.frames, longestBlank: res.longestBlank, flashFrames: res.flashFrames, postsFlashed: p.flashes,
    hideDelay: stats(p.hideDelays), maxVideos: res.maxVideos, items: p.items, requests: p.requests, articlesInDom: p.inDom, hiddenInDom: p.hidden,
    filterStatus: { errors: p.errors, domStop: p.feed.domStop || 0, kept: p.feed.kept, suggested: (p.feed.suggested || 0) + (p.feed.notFollowed || 0), pages: p.feed.pages, unknown: p.feed.unknownPages, domSuggested: p.dom.suggested } };
}
(async () => {
  const which = process.argv[2] || 'all';
  const orig = build();
  if (which === 'all' || which === 'base') {
    console.log(JSON.stringify(await run('1.1, recs never labelled', orig, -1)));
    console.log(JSON.stringify(await run('1.1, labelled run from page 6', orig, 6)));
    console.log(JSON.stringify(await run('MO-hide+scroll, labelled run from page 6', patched({ scroll: true, guard: false }), 6)));
  }
  if (which === 'all' || which === 'more') {
    console.log(JSON.stringify(await run('MO-hide only, labelled run from page 6', patched({ scroll: false, guard: false }), 6)));
    console.log(JSON.stringify(await run('MO-hide + run guard(4), labelled run from page 6', patched({ scroll: false, guard: true }), 6)));
    console.log(JSON.stringify(await run('MO-hide+scroll + run guard(4), labelled run from page 6', patched({ scroll: true, guard: true }), 6)));
  }
})();
