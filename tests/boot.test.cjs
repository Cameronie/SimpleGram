// B33, the page half: SimpleGram's watch on Instagram's start. The page here is
// modelled on the saved logged-out Home HTML (the logo screen, six start-up
// files from the static host with their loader hashes, the loader stubs, the
// start-up payloads with data-content-len and the listener call after each,
// the end marker as the last element); it is a fixture, not a capture. Every
// request is answered locally (nothing reaches Instagram), and a start-up file
// can be made to fail or to stall. Time runs on Playwright's clock, installed
// before the page script so the watch's own timers are the faked ones.
// Also here: plainBoot, and the three latent risks the B33 diagnosis closed
// (feed rules only on feed data, the continuation's module check outside
// Instagram's parse, one cleansed object per XHR response).
//
// Run: NODE_PATH=/opt/node-tools/node_modules node --test tests/*.test.cjs
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SCRIPT, ME, useBrowser, getBrowser, open, sent, waitSent, BLANK, user, media, edge, mixedFeed, codes, NAV, article } = require('./helpers.cjs');

useBrowser();

/* ---------------- Instagram's Home HTML, as saved ---------------- */
const STATIC = 'https://static.cdninstagram.com/rsrc.php/v4/';
const HASHES = ['QVQHOxj', '56M+JUn', 'Z9/htLJ', 'aB1cD2e', 'fG3hI4j', 'kL5mN6o'];
const SPLASH = '<div id="splash-screen" style="position:fixed;z-index:100;top:0;left:0;width:100%;height:100%;background:#fff"></div>';
const END = "<div id='has-finished-comet-page' hidden style='display: none;'></div>";
// The loader stubs Instagram's HTML defines before its loader arrives.
const STUBS = '<script>__d_stub=[],__d=function(e,t,n,r){__d_stub.push([e,t,n,r])},__rl_stub=[],requireLazy=function(){__rl_stub.push(arguments)};</script>';
const bootFile = i => `<script src="${STATIC}y${i}/r/f${i}.js" data-bootloader-hash="${HASHES[i]}" async="1" crossorigin="anonymous"></script>`;
// A start-up payload as the HTML carries it, and the listener call after it; cut: the document ended inside it.
function sjs(obj, cut) {
  const t = JSON.stringify(obj);
  return `<script type="application/json" data-content-len="${t.length}" data-sjs>${cut ? t.slice(0, t.length >> 1) : t}</script>` +
    (cut ? '' : '\n<script>requireLazy(["ServerJSPayloadListener"],function(m){m.process();},null,0x100);</script>');
}
// Module configuration (a define list), the shape the feed rules must never touch.
const config = i => ({ require: [['ScheduledServerJS', 'handle', null, [{ __bbox: {
  define: [['Config' + i, [], { items: [{ id: i, items: [{ ad_id: '7' }] }], ads: { items: [{ k: 1 }] } }, 100 + i]],
  require: [['Module' + i, 'run', [], [{ items: [{ __typename: 'AdUnit', n: i }] }]]] } }]]] });
function igHome({ files = 6, splash = true, cutOff = false, body = '' } = {}) {
  const head = Array.from({ length: files }, (_, i) => bootFile(i)).join('\n');
  const payloads = [0, 1, 2].map(i => sjs(config(i))).join('\n');
  return `<!DOCTYPE html><html class="_9dls touch" lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${STUBS}
${head}
</head><body style="margin:0">${splash ? SPLASH : ''}<div id="mount_0_0"></div>
${payloads}
${body}
${cutOff ? sjs(config(3), true) : sjs(config(3)) + '\n' + END + '</body></html>'}`;
}

// Opens Instagram's Home with the page script, on Playwright's clock (paused
// once the page is in). abort: start-up files that fail; stall: files that
// never answer; hang: paths on Instagram's host never answered (a request of
// the page's that stays on its way); init: a script run before SimpleGram's.
async function openBoot(html, { abort = [], stall = [], hang = [], cfg = {}, init = null } = {}) {
  const context = await getBrowser().newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const served = [];
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.hostname === 'static.cdninstagram.com') {
      const i = +(/\/f(\d+)\.js$/.exec(u.pathname) || [])[1];
      served.push(i);
      if (abort.includes(i)) return route.abort('failed');
      if (stall.includes(i)) return undefined;   // never answered: a stalled download
      return route.fulfill({ status: 200, contentType: 'application/javascript', body: '/* start-up file ' + i + ' */' });
    }
    if (u.hostname === 'www.instagram.com' && u.pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    if (u.hostname === 'www.instagram.com' && hang.includes(u.pathname)) return undefined;
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><body></body>' });
  });
  await page.clock.install();
  if (init) await page.addInitScript(init);
  await page.addInitScript(() => { window.__sent = []; window.SGNative = { postMessage: m => window.__sent.push(JSON.parse(m)) }; });
  await page.addInitScript(`window.__sgCfg=${JSON.stringify(Object.assign({ role: 'main', version: 'test', searchPages: 3, viewerId: ME }, cfg))};\n${SCRIPT}`);
  await page.goto('https://www.instagram.com/', { waitUntil: stall.length ? 'domcontentloaded' : 'load' });
  if (stall.length) await page.waitForTimeout(200);   // the other files answer in real time
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 50));
  return { page, context, served };
}
const record = page => page.evaluate(() => window.__sg.bootRecord());
const token = page => page.evaluate(() => window.__sg.stats.boot.token);
// A page whose visibility the test switches (hidden from the start, or not).
function visibilityInit(hidden) {
  return `(function () {
    let hidden = ${hidden};
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
    window.__hide = () => { hidden = true; document.dispatchEvent(new Event('visibilitychange')); };
    window.__show = () => { hidden = false; document.dispatchEvent(new Event('visibilitychange')); };
  })();`;
}
// Nothing in a boot message may name a file, a host or a module.
function shapesOnly(o) {
  const json = JSON.stringify(o);
  for (const bad of ['http', 'rsrc', 'cdninstagram', 'instagram.com', '.js', 'Config', 'Module', 'ScheduledServerJS']) assert.ok(!json.includes(bad), 'must not contain ' + bad);
}

/* ---------------- The watch ---------------- */

test('boot (a): one start-up file fails and the logo stays: bootStuck with rule a after 3 s, and the record', async () => {
  const { page, context, served } = await openBoot(igHome(), { abort: [2] });
  assert.deepEqual(served.slice().sort(), [0, 1, 2, 3, 4, 5]);
  await page.clock.runFor(2500);
  assert.equal((await sent(page, 'bootStuck')).length, 0, 'not before 3 s');
  await page.clock.runFor(1000);
  const [m] = await sent(page, 'bootStuck');
  assert.ok(m, 'bootStuck posted');
  assert.equal(m.rule, 'a');
  assert.equal(m.token, await token(page));
  assert.equal(await page.evaluate(() => window.__sg.stats.boot.rule), 'a');
  const r = m.record;
  assert.deepEqual(r.scripts, { n: 6, loaded: 5, errored: 1, pending: 0, retries: 0 });
  assert.equal(r.logo.present, true);
  assert.equal(r.logo.up, true);
  assert.equal(r.logo.display, '', 'no inline display on the logo');
  assert.equal(r.dcl, true);
  assert.equal(r.endMarker, true);
  assert.equal(r.ready, 'complete');
  assert.deepEqual(r.stubs, { d: 0, rl: 4 }, 'the loader stubs\' queues');
  assert.equal(r.require, 'undefined');
  assert.equal(r.sjs.n, 4);
  assert.equal(r.sjs.processed, 0);
  assert.equal(r.sjs.lastLen, r.sjs.lastWant, 'the last payload is whole');
  assert.equal(r.hidden, false);
  assert.equal(r.online, true);
  assert.ok(r.vis >= 3000 && r.vis < 6000, String(r.vis));
  assert.equal(r.own.hooks, true);
  assert.equal(r.own.plain, false);
  assert.equal(r.own.requireInHook, 0);
  shapesOnly(m);
  // Once only; the logo still up later brings no second one, and no 'boot'.
  await page.clock.runFor(5000);
  assert.equal((await sent(page, 'bootStuck')).length, 1);
  assert.equal((await sent(page, 'boot')).length, 0);
  await context.close();
});

test('boot (a) waits for a retry: a failed file asked for again holds the rule until the retry settles', async () => {
  const { page, context } = await openBoot(igHome(), { abort: [1] });
  // Instagram's loader retries with a new element of the same hash (here, one that loads).
  await page.evaluate(h => {
    const s = document.createElement('script');
    s.src = 'https://static.cdninstagram.com/rsrc.php/v4/yR/r/f9.js';
    s.setAttribute('data-bootloader-hash', h);
    document.head.appendChild(s);
  }, HASHES[1]);
  await page.waitForFunction(() => window.__sg.bootRecord().scripts.pending === 0);
  await page.clock.runFor(4000);
  const r = await record(page);
  assert.deepEqual(r.scripts, { n: 6, loaded: 6, errored: 0, pending: 0, retries: 1 }, 'the retry loaded: nothing failed any more');
  assert.equal((await sent(page, 'bootStuck')).length, 0);
  await context.close();
});

test('boot (b): a cut-off document (no end marker) with the logo up: rule b 3 s after DOMContentLoaded', async () => {
  const { page, context } = await openBoot(igHome({ cutOff: true }));
  await page.clock.runFor(3500);
  const [m] = await sent(page, 'bootStuck');
  assert.ok(m, 'bootStuck posted');
  assert.equal(m.rule, 'b');
  assert.equal(m.record.endMarker, false);
  assert.equal(m.record.dcl, true);
  assert.ok(m.record.sjs.lastLen < m.record.sjs.lastWant, 'the last payload is shorter than it says');
  assert.deepEqual(m.record.scripts, { n: 6, loaded: 6, errored: 0, pending: 0, retries: 0 });
  await context.close();
});

test('boot (c): a start-up file that never answers: no progress, so rule c at about 20 s (not a or b)', async () => {
  const { page, context } = await openBoot(igHome(), { stall: [3] });
  await page.clock.runFor(18000);
  assert.equal((await sent(page, 'bootStuck')).length, 0, 'not yet');
  const early = await record(page);
  assert.equal(early.ready, 'interactive', 'the document waits on the file');
  assert.equal(early.scripts.pending, 1);
  await page.clock.runFor(3000);
  const [m] = await sent(page, 'bootStuck');
  assert.ok(m, 'bootStuck posted');
  assert.equal(m.rule, 'c');
  assert.ok(m.record.progress.quiet >= 10000, String(m.record.progress.quiet));
  // The records on the way: at 10 s, and nothing more yet.
  const recs = await sent(page, 'bootRecord');
  assert.equal(recs.length, 1);
  assert.equal(recs[0].token, m.token);
  assert.equal(recs[0].record.rule, '');
  await context.close();
});

test('boot: a slow drip that starts in about 28 s (progress every few seconds) is never stuck', async () => {
  // Instagram's listener processes payloads and more arrive; the logo goes at 28 s.
  const drip = `<script>(function(){var n=0;var t=setInterval(function(){n++;
    var s=document.createElement('script');s.type='application/json';s.setAttribute('data-sjs','');var j=JSON.stringify({require:[['Later'+n,null,null,[]]]});
    s.setAttribute('data-content-len',String(j.length));s.textContent=j;document.body.appendChild(s);
    document.querySelectorAll('script[data-sjs]:not([data-processed])')[0].setAttribute('data-processed','1');
    if(n===7){clearInterval(t);document.getElementById('splash-screen').remove();}},4000);})();</script>`;
  const { page, context } = await openBoot(igHome({ body: drip }));
  await page.clock.runFor(27000);
  assert.equal((await sent(page, 'boot')).length, 0, 'the logo is still up');
  assert.equal((await sent(page, 'bootStuck')).length, 0);
  await page.clock.runFor(3000);
  const [m] = await sent(page, 'boot');
  assert.ok(m, 'boot posted');
  assert.equal(m.how, 'removed');
  assert.ok(m.ms >= 27500 && m.ms <= 30000, String(m.ms));
  assert.equal(m.token, await token(page));
  assert.equal((await sent(page, 'bootStuck')).length, 0);
  assert.equal((await sent(page, 'bootRecord')).length, 1, 'the 10 s record; at 30 s the logo was gone');
  const r = await record(page);
  assert.deepEqual([r.logo.present, r.logo.how, r.logo.ms], [false, 'removed', m.ms]);
  assert.ok(r.sjs.processed >= 7);
  // The watch is over: no more records, whatever the clock does.
  await page.clock.runFor(40000);
  assert.equal((await sent(page, 'bootRecord')).length, 1);
  await context.close();
});

test('boot: the logo hidden rather than removed (PolarisSplashScreenController) is a boot too', async () => {
  const body = '<script>setTimeout(function(){document.getElementById("splash-screen").style.display="none";},1200);</script>';
  const { page, context } = await openBoot(igHome({ body }));
  await page.clock.runFor(1500);
  const [m] = await sent(page, 'boot');
  assert.ok(m, 'boot posted');
  assert.equal(m.how, 'hidden');
  assert.ok(m.ms >= 1200 && m.ms < 2000, String(m.ms));
  assert.deepEqual([(await record(page)).logo.up, (await record(page)).logo.display], [false, 'none']);
  await context.close();
});

test('boot (c) waits for a request on its way: an XHR and a fetch Instagram sent count as progress for 20 s after they started', async () => {
  // A start-up file stalls (no progress), and at 15 s Instagram asks for something that never answers.
  const body = `<script>setTimeout(function () { var x = new XMLHttpRequest(); x.open('GET', '/api/v1/never/'); x.send(); fetch('/api/v1/never/'); }, 15000);</script>`;
  const { page, context } = await openBoot(igHome({ body }), { stall: [3], hang: ['/api/v1/never/'] });
  await page.clock.runFor(14000);
  assert.deepEqual([(await record(page)).progress.requests, (await record(page)).progress.inflight], [0, 0]);
  await page.clock.runFor(16000);
  const r = await record(page);
  assert.deepEqual([r.progress.requests, r.progress.inflight], [2, 2], 'both on their way');
  assert.ok(r.progress.quiet < 1000, 'a request on its way is progress: ' + r.progress.quiet);
  assert.equal((await sent(page, 'bootStuck')).length, 0, 'not at 30 s: Instagram is still asking');
  await page.clock.runFor(14000);
  assert.equal((await sent(page, 'bootStuck')).length, 0, 'not at 44 s either');
  await page.clock.runFor(2000);
  const [m] = await sent(page, 'bootStuck');
  assert.ok(m, 'then the rule: a request on its way for 20 s is a stall');
  assert.equal(m.rule, 'c');
  assert.ok(m.record.progress.quiet >= 10000, String(m.record.progress.quiet));
  assert.equal(m.record.progress.inflight, 2);
  await context.close();
});

test('boot: the clock never credits time away: frozen in the background for 8 minutes (no ticks), back on screen the page is not stuck', async () => {
  // A normal start under way (the logo up 2 s, the files just loaded) when Cam switches apps; Android
  // freezes the app, or the timer is throttled while hidden, so no tick runs until the page is back.
  const { page, context } = await openBoot(igHome(), { init: visibilityInit(false) });
  await page.clock.runFor(2000);
  const before = await record(page);
  assert.ok(before.vis >= 2000 && before.vis < 3000, String(before.vis));
  await page.evaluate(() => window.__hide());
  await page.clock.runFor(1000);
  await page.clock.setSystemTime(await page.evaluate(() => Date.now()) + 8 * 60 * 1000);
  await page.evaluate(() => window.__show());
  await page.clock.runFor(300);   // the one tick that was due
  const after = await record(page);
  assert.ok(after.vis < before.vis + 1000, 'the time away never counted: ' + after.vis);
  assert.equal((await sent(page, 'bootStuck')).length, 0);
  assert.equal((await sent(page, 'bootRecord')).length, 0, 'not 10 s on screen yet');
  // The same with no visibility change at all (the tick itself comes late): two ticks' worth at most.
  await page.clock.setSystemTime(await page.evaluate(() => Date.now()) + 5 * 60 * 1000);
  await page.clock.runFor(300);
  const later = await record(page);
  assert.ok(later.vis < after.vis + 1000, 'a late tick credits two ticks\' worth at most: ' + later.vis);
  assert.equal((await sent(page, 'bootStuck')).length, 0);
  // Back on screen the clock runs again, and the start still counts when it comes.
  await page.clock.runFor(1000);
  assert.ok((await record(page)).vis >= later.vis + 900, 'on screen: the clock runs');
  await page.evaluate(() => document.getElementById('splash-screen').remove());
  await page.clock.runFor(300);
  const [m] = await sent(page, 'boot');
  assert.ok(m, 'boot posted');
  assert.equal(m.how, 'removed');
  assert.equal((await sent(page, 'bootStuck')).length, 0);
  await context.close();
});

test('boot: a page that is hidden keeps the clock paused; visible again, a failed file is reported after 3 s on screen', async () => {
  const { page, context } = await openBoot(igHome(), { abort: [0], init: visibilityInit(true) });
  await page.clock.runFor(12000);
  assert.equal((await sent(page, 'bootStuck')).length, 0, 'nothing while hidden');
  assert.equal((await sent(page, 'bootRecord')).length, 0, 'no 10 s record while hidden');
  const r = await record(page);
  assert.ok(r.vis < 1000, 'the clock did not run: ' + r.vis);
  assert.equal(r.hidden, true);
  await page.evaluate(() => window.__show());
  await page.clock.runFor(2500);
  assert.equal((await sent(page, 'bootStuck')).length, 0);
  await page.clock.runFor(1000);
  const [m] = await sent(page, 'bootStuck');
  assert.ok(m, 'bootStuck once on screen long enough');
  assert.equal(m.rule, 'a');
  await context.close();
});

test('boot: offline time does not count either', async () => {
  const { page, context } = await openBoot(igHome(), { abort: [0] });
  await context.setOffline(true);
  await page.waitForFunction(() => navigator.onLine === false);
  await page.clock.runFor(10000);
  assert.equal((await sent(page, 'bootStuck')).length, 0);
  assert.equal((await record(page)).online, false);
  await context.setOffline(false);
  await page.waitForFunction(() => navigator.onLine === true);
  await page.clock.runFor(3500);
  assert.equal((await sent(page, 'bootStuck')).length, 1);
  await context.close();
});

test('boot: a page without Instagram\'s logo screen posts boot with how none at DOMContentLoaded', async () => {
  const page = await open('https://www.instagram.com/', BLANK);
  const [m] = await waitSent(page, 'boot');
  assert.equal(m.how, 'none');
  assert.equal(m.token, await token(page));
  assert.ok(m.ms >= 0 && m.ms < 5000);
  const r = await record(page);
  assert.deepEqual([r.logo.present, r.logo.how, r.rule], [false, 'none', '']);
  assert.deepEqual(r.scripts, { n: 0, loaded: 0, errored: 0, pending: 0, retries: 0 });
  assert.deepEqual(r.stubs, { d: null, rl: null });
  // The record is part of the status too, in counts: no rule, no stuck.
  await page.evaluate(() => window.__sg.onNative({ type: 'status' }));
  const [st] = await sent(page, 'status');
  assert.equal(st.plainBoot, false);
  assert.deepEqual([st.stats.boot.how, st.stats.boot.rule, st.stats.boot.stuck, st.stats.boot.plain], ['none', '', 0, false]);
  shapesOnly(st.stats.boot);
});

test('boot: the comments page (role comments) has no watch: no boot, and nothing kept about the files it loads', async () => {
  const page = await open('https://www.instagram.com/p/ABCDEFG/comments/', BLANK, { role: 'comments' });
  await page.route('https://static.cdninstagram.com/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: '/* f */' }));
  // Files from Instagram's static host with loader hashes, loaded and removed, as the panel's own routes do.
  await page.evaluate(() => new Promise(res => {
    let n = 0;
    for (let i = 0; i < 5; i++) {
      const s = document.createElement('script');
      s.src = 'https://static.cdninstagram.com/rsrc.php/v4/y' + i + '/r/g' + i + '.js';
      s.setAttribute('data-bootloader-hash', 'H' + i);
      s.onload = s.onerror = () => { s.remove(); if (++n === 5) res(); };
      document.head.appendChild(s);
    }
  }));
  await page.waitForTimeout(600);
  assert.equal((await sent(page, 'boot')).length, 0);
  assert.equal((await record(page)).scripts.n, 0, 'the watch\'s listeners are not installed here');
});

test('boot record: window errors and unhandled rejections are counted, the first three by kind, host kind and line', async () => {
  // An inline script of the page that throws, and one whose promise is never handled.
  const body = '<script>Promise.reject(new RangeError(\'y\'));</script>\n<script>\nnull.x;</script>';
  const { page, context } = await openBoot(igHome({ body }));
  await page.waitForTimeout(100);
  const r = await record(page);
  assert.equal(r.errors.n, 1);
  assert.deepEqual(r.errors.first[0].kind, 'TypeError');
  assert.equal(r.errors.first[0].host, 'www');
  assert.ok(r.errors.first[0].line > 0);
  assert.equal(r.rejections.n, 1);
  assert.deepEqual(r.rejections.first, [{ kind: 'RangeError' }]);
  shapesOnly(r);
  await context.close();
});

/* ---------------- plainBoot ---------------- */

test('plainBoot: no data hook touches a payload, no DOM rule runs; the bridge, routes and status still work', async () => {
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body style="margin:0"><main>${article('ADPOST1', 'Sponsored')}</main>${NAV}</body></html>`;
  const feedApi = { '/api/v1/feed/x/': () => ({ body: { items: [{ media_or_ad: media('ADPOST1', user('brand'), { ad_id: '1' }) }, { media_or_ad: media('FRIEND1', user('a', true)) }], status: 'ok', more_available: true } }) };
  const page = await open('https://www.instagram.com/', html, { cfg: { plainBoot: true }, api: feedApi });
  await waitSent(page, 'ready');
  const parsed = await page.evaluate(p => JSON.parse(JSON.stringify(p)), mixedFeed());
  assert.equal(codes(parsed).length, 12, 'every edge stays, the marker included');
  assert.equal(parsed.data.xdt_api__v1__feed__timeline__connection.page_info.has_next_page, true);
  const viaFetch = await page.evaluate(() => fetch('/api/v1/feed/x/').then(r => r.json()));
  assert.equal(viaFetch.items.length, 2);
  const viaXhr = await page.evaluate(() => new Promise(res => {
    const x = new XMLHttpRequest(); x.open('GET', '/api/v1/feed/x/'); x.responseType = 'json';
    x.onload = () => res(x.response.items.length); x.send();
  }));
  assert.equal(viaXhr, 2);
  assert.equal(await page.evaluate(() => window.__sg.stats.payloads), 0, 'nothing was cleansed');
  await page.waitForTimeout(700);
  assert.equal(await page.evaluate(() => !!document.getElementById('sg-style')), false, 'no SimpleGram styles');
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('a-ADPOST1')).display), 'block', 'the labelled post is left alone');
  assert.deepEqual(await page.evaluate(() => window.__sg.stats.dom), { ads: 0, suggested: 0, reposts: 0, banners: 0, reelsTab: 0, exploreGrid: 0 });
  // The bridge and the route messages.
  await page.evaluate(() => history.pushState(null, '', '/explore/'));
  const routes = await waitSent(page, 'route');
  assert.equal(routes[routes.length - 1].route, 'explore');
  await page.evaluate(() => window.__sg.onNative({ type: 'status' }));
  const [st] = await sent(page, 'status');
  assert.equal(st.plainBoot, true);
  assert.equal(st.stats.boot.plain, true);
  const r = await record(page);
  assert.deepEqual([r.own.hooks, r.own.plain, r.own.payloads], [false, true, 0]);
  const [boot] = await sent(page, 'boot');
  assert.equal(boot.how, 'none', 'the watch still runs');
});

/* ---------------- The latent risks ---------------- */

const conn = out => out.data.xdt_api__v1__feed__timeline__connection;
const friend = c => edge({ media: media(c, user('f' + c, true)) });
const adUnit = c => edge({ ad: { ad_id: '1' }, media: media(c, user('brand'), { ad_id: '1' }) });
function feedPage(edges) {
  return { data: { xdt_api__v1__feed__timeline__connection: { edges, page_info: { has_next_page: true, end_cursor: 'c1' } } }, extensions: { is_final: true } };
}

test('latent risk 1: the feed rules leave Instagram\'s start-up configuration alone, and still filter the query result it carries and api answers', async () => {
  const page = await open('https://www.instagram.com/', BLANK);
  const payload = { require: [['ScheduledServerJS', 'handle', null, [{ __bbox: {
    define: [
      ['AdsConfig', [], { ads: { items: [{ id: 1 }, { id: 2 }], more_available: true }, items: [{ ad_id: '9', k: 1 }, { __typename: 'AdPlacement' }], edges: [{ node: { is_sponsored: true } }] }, 11],
      ['FeedConfig', [], { stories: [{ injected: {} }], reels: [{ is_ad: true }] }, 12],
    ],
    require: [
      ['Module', 'run', [], [{ items: [{ ad_id: '3' }], media: [{ is_ad_media: true }] }]],
      ['RelayPrefetchedStreamCache', 'next', [], ['adp_Feed', { __bbox: { complete: true, result: feedPage([friend('FRIEND1'), adUnit('ADPOST1'), friend('FRIEND2')]), sequence_number: 0 } }]],
    ] } }]]] };
  const out = await page.evaluate(p => JSON.parse(JSON.stringify(p)), payload);
  const bbox = out.require[0][3][0].__bbox;
  const [ads, feedCfg] = bbox.define.map(d => d[2]);
  assert.equal(ads.ads.items.length, 2, 'the ads key in configuration is not blanked');
  assert.equal(ads.ads.more_available, true);
  assert.equal(ads.items.length, 2, 'ad-like entries in a configuration list stay');
  assert.equal(ads.edges.length, 1);
  assert.deepEqual([feedCfg.stories.length, feedCfg.reels.length], [1, 1]);
  assert.deepEqual(bbox.require[0][3][0], { items: [{ ad_id: '3' }], media: [{ is_ad_media: true }] });
  const result = bbox.require[1][3][1].__bbox.result;
  assert.deepEqual(conn(result).edges.map(e => e.node.media.code), ['FRIEND1', 'FRIEND2'], 'the query result inside it is feed data: filtered');
  let stats = await page.evaluate(() => window.__sg.stats);
  assert.equal(stats.ads, 0, 'no configuration list was taken for an ad list');
  assert.equal(stats.feed.pages, 1);
  assert.equal(stats.feed.ad, 1);
  const r = await record(page);
  assert.deepEqual([r.own.bootPayloads, r.own.bootChanged], [1, 1]);
  assert.deepEqual(r.own.bootKeys, ['xdt_api__v1__feed__timeline__con', 'edges'], 'the rules that ran, by key (names cut at 32)');
  // A define-only payload with nothing but configuration: unchanged, counted as such.
  const cfgOnly = await page.evaluate(() => JSON.parse(JSON.stringify({ define: [['X', [], { ads: { items: [{ a: 1 }] }, items: [{ ad_id: '1' }, { x: 2 }], pad: 'p'.repeat(200) }, 1]], instances: [], markup: [] })));
  assert.deepEqual([cfgOnly.define[0][2].ads.items.length, cfgOnly.define[0][2].items.length], [1, 2]);
  assert.deepEqual((await record(page)).own.bootPayloads, 2);
  assert.deepEqual((await record(page)).own.bootChanged, 1);
  // An api answer is filtered as before: the ads key blanked, ad-like entries dropped.
  const api = await page.evaluate(() => JSON.parse(JSON.stringify({ items: [{ ad_id: '5', pk: '1' }, { pk: '2', code: 'KEEP001', user: { username: 'u' } }], ads: { items: [{ a: 1 }] }, status: 'ok', more_available: true, next_max_id: 'm' })));
  assert.deepEqual(api.items.map(i => i.pk), ['2']);
  assert.equal(api.ads.items.length, 0);
  stats = await page.evaluate(() => window.__sg.stats);
  assert.equal(stats.ads, 2);
  assert.equal((await record(page)).own.bootPayloads, 2, 'an api answer is not a start-up payload');
  // The same configuration in an ajax answer's shape (define and require
  // lists under jsmods): untouched; the answer's payload beside it is data.
  const ajax = await page.evaluate(() => JSON.parse(JSON.stringify({ __ar: 1, payload: { items: [{ ad_id: '2', pk: '3' }, { pk: '4', k: 1 }] },
    jsmods: { define: [['SomeConfig', [], { ads: { items: [{ a: 1 }] }, items: [{ ad_id: '1' }, { x: 2 }] }, 1]], require: [['M', 'run', [], [{ items: [{ ad_id: '4' }] }]]] }, lid: '7' })));
  const under = ajax.jsmods.define[0][2];
  assert.deepEqual([under.ads.items.length, under.items.length, ajax.jsmods.require[0][3][0].items.length], [1, 2, 1], 'configuration under jsmods stays');
  assert.deepEqual(ajax.payload.items.map(i => i.pk), ['4'], 'the answer beside it is data, as before');
  assert.deepEqual([(await record(page)).own.bootPayloads, (await record(page)).own.bootChanged], [3, 2]);
  // A start-up payload carrying a feed page with nothing to drop: counted, not changed.
  await page.evaluate(p => JSON.parse(JSON.stringify(p)), { require: [['RelayPrefetchedStreamCache', 'next', [], ['adp_Feed', { __bbox: { complete: true, result: feedPage([friend('FRIEND3'), friend('FRIEND4')]), sequence_number: 0 } }]]] });
  assert.deepEqual([(await record(page)).own.bootPayloads, (await record(page)).own.bootChanged], [4, 2]);
});

test('latent risk 3: an XHR json response is one cleansed object, read as often as Instagram likes; a request opened again starts over', async () => {
  const body = { items: [{ media_or_ad: media('ADPOST1', user('brand'), { ad_id: '1' }) }, { media_or_ad: media('FRIEND1', user('a', true)) }], status: 'ok', more_available: true, next_max_id: 'm1' };
  const page = await open('https://www.instagram.com/', BLANK, { api: { '/api/v1/feed/x/': () => ({ body }) } });
  const r = await page.evaluate(() => new Promise(res => {
    const x = new XMLHttpRequest(); x.open('GET', '/api/v1/feed/x/'); x.responseType = 'json';
    x.onload = () => {
      const a = x.response, b = x.response, c = x.response;
      const first = { same: a === b && b === c, codes: a.items.map(i => i.media_or_ad.code), payloads: window.__sg.stats.payloads };
      // The same request, opened and sent again: a fresh answer, cleansed afresh.
      x.onload = () => {
        const d = x.response;
        res({ first, again: { fresh: d !== a, codes: d.items.map(i => i.media_or_ad.code), payloads: window.__sg.stats.payloads, same: d === x.response } });
      };
      x.open('GET', '/api/v1/feed/x/'); x.responseType = 'json'; x.send();
    };
    x.send();
  }));
  assert.deepEqual(r.first, { same: true, codes: ['FRIEND1'], payloads: 1 });
  assert.deepEqual(r.again, { fresh: true, codes: ['FRIEND1'], payloads: 2, same: true });
  // Text responses are untouched by the getter (Instagram parses them itself).
  const text = await page.evaluate(() => new Promise(res => {
    const x = new XMLHttpRequest(); x.open('GET', '/api/v1/feed/x/');
    x.onload = () => res([typeof x.response, x.response === x.response, window.__sg.stats.payloads]); x.send();
  }));
  assert.deepEqual(text, ['string', true, 2]);
});

// Instagram's two compiled feed queries, as the page's own require gives them,
// with a count of require calls made from inside a JSON.parse (the page wraps
// SimpleGram's parse, so the depth is seen by both). P.late: the modules are
// defined only when window.__defineModules() runs (a lazy bundle).
function modulesHtml(late) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width"><script>(function () {
  const pv = { __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: { get: () => false } };
  const q = (name, id) => ({ params: { id, name, metadata: { is_distillery: true, root_field_name: ['xdt_api__v1__feed__timeline__connection'] }, providedVariables: pv } });
  const M = { LSD: { token: 'LSDTOKEN' }, DTSGInitialData: { token: 'DTSGTOKEN' } };
  const feed = () => { M['PolarisFeedTimelineRootV2Query.graphql'] = q('PolarisFeedTimelineRootV2Query', '28805668309050001');
    M['PolarisFeedRootPaginationCachedQuery_subscribe.graphql'] = q('PolarisFeedRootPaginationCachedQuery_subscribe', '28847928918174870'); };
  ${late ? 'window.__defineModules = feed;' : 'feed();'}
  let depth = 0;
  window.__req = { calls: 0, inParse: 0 };
  const inner = JSON.parse;
  JSON.parse = function (t, r) { depth++; try { return inner.call(this, t, r); } finally { depth--; } };
  window.require = n => { window.__req.calls++; if (depth) window.__req.inParse++; if (!(n in M)) throw new Error('unknown module ' + n); return M[n]; };
})();</script></head><body style="margin:0"><main id="feed"></main></body></html>`;
}
let seq = 0;
function homePage(edges, { cursor = 'cur' + (seq++), source } = {}) {
  const c = { edges, page_info: { has_next_page: true, end_cursor: cursor } };
  if (source !== undefined) c.pagination_source = source;
  return { data: { xdt_api__v1__feed__timeline__connection: c }, extensions: { is_final: true } };
}
function marker() {
  return edge({ end_of_feed_demarcator: { id: 'eof', title: "You're all caught up", subtitle: 'seen all',
    group_set: { __typename: 'XDTGroupSet', id: 'gs', active_group_id: 'feed_recs', groups: [] } } });
}
const FOL = n => 'FOL' + String(n).padStart(4, '0');
function followingApi() {
  let fol = 0;
  return { '/graphql/query': (u, req) => {
    const vars = JSON.parse(new URLSearchParams(req.postData() || '').get('variables') || '{}');
    if (vars.variant !== 'following') return { body: homePage([]) };
    const list = Array.from({ length: vars.after == null ? 3 : 12 }, () => friend(FOL(++fol)));
    const out = homePage(list, { cursor: 'fol' + fol, source: 'following' });
    return { body: out };
  } };
}
const parseIn = (pg, payload) => pg.evaluate(p => JSON.parse(JSON.stringify(p)), payload);
const tick = pg => pg.evaluate(() => new Promise(r => setTimeout(r, 0)));
const contOf = pg => pg.evaluate(() => window.__sg.cont().stats);
const req = pg => pg.evaluate(() => window.__req);

test('latent risk 2: the continuation\'s module check runs after the first Home page, outside Instagram\'s parse; the marker uses it', async () => {
  const page = await open('https://www.instagram.com/', modulesHtml(false), { cfg: { continueHome: true }, api: followingApi() });
  assert.equal((await contOf(page)).modules, null, 'nothing asked before a Home page');
  await parseIn(page, homePage([friend('FRIEND1'), friend('FRIEND2')]));
  assert.equal((await req(page)).inParse, 0, 'nothing asked inside the parse');
  await tick(page);
  const after = await contOf(page);
  assert.deepEqual(after.modules, { root: true, next: true, constants: false, actions: false, asyncParams: false, asyncHeaders: false });
  const calls = (await req(page)).calls;
  assert.ok(calls >= 2, 'asked once the parse was over: ' + calls);
  const out = await parseIn(page, homePage([friend('FRIEND3'), marker()]));
  assert.deepEqual(conn(out).edges.map(e => e.node.media.code), ['FRIEND3']);
  assert.equal(conn(out).page_info.has_next_page, true, 'Home goes on');
  const st = await contOf(page);
  assert.equal(st.state, 'running');
  assert.equal(st.startVia, 'marker');
  assert.equal((await req(page)).inParse, 0, 'the marker page asked nothing inside the parse');
  assert.equal((await record(page)).own.requireInHook, 0);
});

test('latent risk 2: modules missing at the first page (a lazy bundle) are looked for again once the page has more scripts, still outside the parse', async () => {
  const page = await open('https://www.instagram.com/', modulesHtml(true), { cfg: { continueHome: true }, api: followingApi() });
  await parseIn(page, homePage([friend('FRIEND1')]));
  await tick(page);
  assert.equal((await contOf(page)).modules, null, 'not there yet');
  const asked = (await req(page)).calls;
  assert.ok(asked >= 1);
  // Another page, nothing new loaded: not asked again.
  await parseIn(page, homePage([friend('FRIEND2')]));
  await tick(page);
  assert.equal((await req(page)).calls, asked, 'no new script file: no new ask');
  // The lazy bundle arrives (a new script element defines the modules).
  await page.evaluate(() => { window.__defineModules(); const s = document.createElement('script'); s.textContent = '/* bundle */'; document.head.appendChild(s); });
  await parseIn(page, homePage([friend('FRIEND3')]));
  await tick(page);
  assert.ok((await contOf(page)).modules, 'found after the bundle');
  const out = await parseIn(page, homePage([marker()]));
  assert.equal(conn(out).page_info.has_next_page, true);
  assert.equal((await contOf(page)).state, 'running');
  assert.equal((await req(page)).inParse, 0);
  assert.equal((await record(page)).own.requireInHook, 0);
});

test('latent risk 2: the bundle arrives after a miss and the marker page is next: the two query modules alone are asked inside the parse, the full check follows', async () => {
  const page = await open('https://www.instagram.com/', modulesHtml(true), { cfg: { continueHome: true }, api: followingApi() });
  await parseIn(page, homePage([friend('FRIEND1')]));
  await tick(page);
  assert.equal((await contOf(page)).modules, null, 'a miss');
  await page.evaluate(() => { window.__defineModules(); const s = document.createElement('script'); s.textContent = '/* bundle */'; document.head.appendChild(s); });
  const out = await parseIn(page, homePage([friend('FRIEND2'), marker()]));
  assert.deepEqual(conn(out).edges.map(e => e.node.media.code), ['FRIEND2']);
  assert.equal(conn(out).page_info.has_next_page, true, 'Home goes on');
  assert.equal((await contOf(page)).state, 'running');
  assert.equal((await req(page)).inParse, 2, 'the two query modules, nothing else, inside the parse');
  assert.equal((await record(page)).own.requireInHook, 2);
  await tick(page);
  assert.deepEqual((await contOf(page)).modules, { root: true, next: true, constants: false, actions: false, asyncParams: false, asyncHeaders: false }, 'the full check once the parse was over');
  assert.equal((await req(page)).inParse, 2);
});

test('latent risk 2: when no check could run before the marker, today\'s look from inside the parse still arms Home, and the record says so', async () => {
  const page = await open('https://www.instagram.com/', modulesHtml(false), { cfg: { continueHome: true }, api: followingApi() });
  // The marker on Home's very first page: the microtask check has had no page to follow.
  const out = await parseIn(page, homePage([friend('FRIEND1'), marker()]));
  assert.equal(conn(out).page_info.has_next_page, true);
  assert.equal((await contOf(page)).state, 'running');
  assert.ok((await req(page)).inParse >= 2, 'asked inside the parse, as before');
  assert.ok((await record(page)).own.requireInHook >= 2);
});
