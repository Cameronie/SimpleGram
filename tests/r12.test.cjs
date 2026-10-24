// Browser tests for R12: the account, caption, counts and actions over R9's
// full-screen Story Reel, like the app's Reel page.
//
// Touches are real ones from the browser (Chrome DevTools input). Full screen
// is stubbed as in video.test.cjs (the Story is in Instagram's own full screen,
// on <body>). Nothing reaches Instagram: the media lookup and every action's
// endpoint are answered locally, and each request is recorded.
//
// Run: NODE_PATH=/opt/node-tools/node_modules node --test tests/*.test.cjs
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { SCRIPT, ME, sent, waitSent, media, PNG } = require('./helpers.cjs');
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const CLIP = fs.readFileSync(path.join(__dirname, 'reel.webm'));

let browser;
before(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { await browser.close(); });

const STORY_URL = 'https://www.instagram.com/stories/friend/424242/';
// Instagram's mobile Story viewer, as in video.test.cjs: a press pauses, a lift
// lets go; a quick swipe up opens the reply box, down closes. The page's tokens
// sit in an inline script, as on Instagram's pages.
const STORY = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body style="margin:0;background:#000">
  <div id="mount"><section id="viewer" style="position:fixed;inset:0">
    <img id="media" src="/story1.jpg" style="position:absolute;inset:0;width:412px;height:915px">
    <div id="zone" role="button" style="position:absolute;inset:0"></div>
  </section></div>
  <script>require_tokens = ['"LSD",[],{"token":"lsd-tok"}', '"DTSGInitialData",[],{"token":"dtsg-tok"}'];</script>
  <script>
    const S = window.__story = { paused: false, reply: 0, closed: 0, ends: 0, starts: 0, start: null };
    const root = document.getElementById('mount');
    root.addEventListener('touchstart', e => {
      S.starts++;
      if (!S.start) S.start = { t: Date.now(), x: e.touches[0].clientX, y: e.touches[0].clientY };
      S.paused = true;
    });
    root.addEventListener('touchend', e => {
      S.ends++;
      if (e.touches.length === 0) S.paused = false;
      const s = S.start; S.start = null;
      if (!s || Date.now() - s.t > 500) return;
      const dy = e.changedTouches[0].clientY - s.y;
      if (Math.abs(dy) > 50) { if (dy < 0) S.reply++; else S.closed++; }
    });
  </script></body></html>`;

const CREATOR_ID = '9001';
const REEL_PK = '3141592653';
const CAPTION = 'Sunset over the harbour with the whole crew, line one\nline two of the caption\nline three\nline four with #tags';
function creator(extra = {}) {
  return Object.assign({ pk: CREATOR_ID, username: 'creator', is_verified: true,
    profile_pic_url: 'https://scontent.cdninstagram.com/v/t51/creator_pic.jpg', friendship_status: { following: false, outgoing_request: false } }, extra);
}
function reelItem(extra = {}, user = creator()) {
  return media('REELCODE1', user, Object.assign({
    pk: REEL_PK, id: REEL_PK + '_' + user.pk, product_type: 'clips',
    video_versions: [{ url: 'https://scontent.cdninstagram.com/v/t50/reel-720.webm', width: 720, height: 1280 }],
    caption: { text: CAPTION }, like_count: 1234, comment_count: 56, has_liked: false, has_viewer_saved: false,
  }, extra));
}
const STICKER = { x: 0.5, y: 0.5, width: 0.6, height: 0.5, rotation: 0, media_code: 'REELCODE1', media_id: REEL_PK + '_' + CREATOR_ID, product_type: 'clips', id: 's1' };

// Opens the Story with the page script, answering `api` paths locally. Each
// handler gets (url, request) and returns { status, body, raw, delay } (raw: the
// answer's text as it is, for numbers JSON.stringify can't write). `full: false`
// leaves the Story out of full screen (one reached by a full load).
async function openStory({ item = reelItem(), api = {}, init = null, url = STORY_URL, html = STORY, cfg = {}, full = true } = {}) {
  const context = await browser.newContext({
    viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true,
  });
  const page = await context.newPage();
  page.hits = {};
  page.reqs = [];
  const handlers = Object.assign({ '/api/v1/media/*': () => ({ body: { status: 'ok', items: [item] } }) }, api);
  await page.route('**/*', async route => {
    const req = route.request();
    const u = new URL(req.url());
    if (!/instagram\.com$/.test(u.hostname) && !/cdninstagram\.com$/.test(u.hostname)) return route.fulfill({ status: 404, body: '' });
    for (const key of Object.keys(handlers)) {
      if (u.pathname === key || (key.endsWith('*') && u.pathname.startsWith(key.slice(0, -1)))) {
        page.hits[key] = (page.hits[key] || 0) + 1;
        page.reqs.push({ key: key, path: u.pathname, method: req.method(), headers: req.headers(), body: req.postData() || '' });
        const r = handlers[key](u, req) || {};
        if (r.delay) await new Promise(res => setTimeout(res, r.delay));
        return route.fulfill({ status: r.status || 200, contentType: 'application/json', body: r.raw != null ? r.raw : JSON.stringify(r.body || {}) });
      }
    }
    if (u.pathname === new URL(url).pathname) return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    if (/\.(mp4|webm)$/.test(u.pathname)) return route.fulfill({ status: 200, contentType: 'video/webm', body: CLIP });
    if (/\.(jpg|png)/.test(u.pathname)) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    page.hits.other = (page.hits.other || 0) + 1;
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><body>OTHER ' + u.pathname + '</body>' });
  });
  if (init) await page.addInitScript(init);
  await page.addInitScript(() => {
    window.__sent = [];
    window.SGNative = { postMessage: m => window.__sent.push(JSON.parse(m)) };
    try { document.cookie = 'csrftoken=csrf-tok; path=/'; } catch (e) { /* ignore */ }
  });
  await page.addInitScript(`window.__sgCfg=${JSON.stringify(Object.assign({ role: 'main', version: 'test', searchPages: 3, viewerId: ME }, cfg))};\n${SCRIPT}`);
  await page.goto(url);
  if (url !== STORY_URL) return page;
  // Instagram's Story data, with the shared Reel's sticker.
  const story = media('STORYX424242', { pk: '777', username: 'friend', friendship_status: { following: true } },
    { pk: '424242', id: '424242_777', story_feed_media: [STICKER] });
  await page.evaluate(p => JSON.parse(JSON.stringify(p)), { data: { xdt_api__v1__feed__reels_media: { reels_media: [{ id: '777', items: [story] }] } } });
  await page.evaluate(f => {
    window.__fsEl = f ? document.body : null;
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => window.__fsEl });
  }, full);
  return page;
}
async function drag(page, from, to, { steps = 6 } = {}) {
  const c = await page.context().newCDPSession(page);
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from[0], y: from[1] }] });
  for (let i = 1; i <= steps; i++) {
    await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{
      x: from[0] + (to[0] - from[0]) * i / steps, y: from[1] + (to[1] - from[1]) * i / steps }] });
  }
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await c.detach();
  await page.waitForTimeout(60);
}
async function tapAt(page, x, y) {
  const c = await page.context().newCDPSession(page);
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await c.detach();
  await page.waitForTimeout(120);
}
// Swipes up on the Story and waits for the Reel and its details (a long wait:
// on a busy machine, with the whole suite running, 4 s was not always enough).
async function openReel(page) {
  await drag(page, [200, 600], [205, 250], { steps: 4 });
  await page.waitForFunction(() => document.querySelector('#sg-reel #sg-reelinfo'), null, { timeout: 10000 });
}
// The middle of an element inside the overlay's shadow root.
const spot = (page, sel) => page.evaluate(s => {
  const el = document.getElementById('sg-reelinfo').shadowRoot.querySelector(s);
  const r = el.getBoundingClientRect();
  return [r.left + r.width / 2, r.top + r.height / 2];
}, sel);
async function tapOn(page, sel) {
  const [x, y] = await spot(page, sel);
  await tapAt(page, x, y);
}
const ui = page => page.evaluate(() => {
  const root = document.getElementById('sg-reelinfo') && document.getElementById('sg-reelinfo').shadowRoot;
  if (!root) return null;
  const q = s => root.querySelector(s);
  const shown = el => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0;
  const act = s => ({ shown: shown(q(s)), on: q(s).hasAttribute('data-on'), n: q(s + ' .n').textContent, nShown: shown(q(s + ' .n')) });
  return {
    name: q('.name').textContent, nameShown: shown(q('.name')), pic: shown(q('.pic')) ? q('.pic').getAttribute('src') : null,
    badge: shown(q('.badge')), follow: shown(q('.follow')) ? q('.follow').textContent : null,
    caption: shown(q('.cap')) ? q('.cap').textContent : null, capOpen: q('.cap').classList.contains('open'),
    capH: q('.cap').getBoundingClientRect().height, more: shown(q('.more')) ? q('.more').textContent : null,
    like: act('.like'), comment: act('.comment'), share: act('.share'), save: act('.save'),
  };
});
const r12 = page => page.evaluate(() => JSON.parse(JSON.stringify(window.__sg.stats.reelInfo)));
// Instagram's own modules, as its module system serves them (window.require('ifRequired')).
function fakeModules(mods) {
  return `window.__calls = [];
  (function () {
    const mods = ${mods};
    window.require = function (name) {
      if (name === 'ifRequired') return (n, ok, no) => (mods[n] ? ok(mods[n]) : no && no());
      throw new Error('not here: ' + name);
    };
  })();`;
}

test('R12: the Reel shows its account, caption and counts over the bottom, like the app', async () => {
  const page = await openStory();
  await drag(page, [200, 600], [205, 250], { steps: 4 });
  await page.waitForFunction(() => { const v = document.querySelector('#sg-reel video'); return v && v.getAttribute('src'); });
  const videoBox = () => page.evaluate(() => JSON.stringify(document.querySelector('#sg-reel video').getBoundingClientRect()));
  const v0 = await videoBox();
  await page.waitForFunction(() => document.getElementById('sg-reelinfo'));
  const s = await ui(page);
  assert.equal(s.name, 'creator');
  assert.equal(s.pic, 'https://scontent.cdninstagram.com/v/t51/creator_pic.jpg');
  assert.equal(s.badge, true, 'the blue tick');
  assert.equal(s.follow, 'Follow', 'not followed: Follow');
  assert.equal(s.caption, CAPTION);
  assert.equal(s.more, 'more', 'a long caption has "more"');
  assert.ok(s.capH <= 37 && s.capH >= 30, 'collapsed: two lines (' + s.capH + ')');
  assert.deepEqual([s.like.n, s.comment.n, s.share.nShown, s.save.nShown], ['1,234', '56', false, false], 'missing counts are hidden, never 0');
  assert.deepEqual([s.like.on, s.save.on], [false, false]);
  // The video didn't move, and the overlay sits above the bar.
  assert.equal(await videoBox(), v0);
  const geo = await page.evaluate(() => {
    const host = document.getElementById('sg-reelinfo'), root = host.shadowRoot;
    const bar = document.querySelector('#sg-reel [data-sg-bar="story"]').getBoundingClientRect();
    const pic = root.querySelector('.pic').getBoundingClientRect();
    const name = getComputedStyle(root.querySelector('.name'));
    const all = [...root.querySelectorAll('.acct,.cap,.more,.act,.follow')].map(e => e.getBoundingClientRect().bottom);
    return { barTop: bar.top, lowest: Math.max(...all), pic: [pic.width, pic.height], color: name.color, weight: name.fontWeight,
      shadow: name.textShadow, touchAction: getComputedStyle(host).touchAction, parent: host.parentElement.id };
  });
  assert.ok(geo.lowest <= geo.barTop + 1, JSON.stringify(geo));
  assert.deepEqual(geo.pic, [32, 32]);
  assert.equal(geo.color, 'rgb(255, 255, 255)');
  assert.equal(geo.weight, '700');
  assert.match(geo.shadow, /rgba\(0, 0, 0/);
  assert.equal(geo.touchAction, 'auto', 'B25: never touch-action');
  assert.equal(geo.parent, 'sg-reel');
  // "more" opens the whole caption; "less" closes it.
  await tapOn(page, '.more');
  let o = await ui(page);
  assert.deepEqual([o.capOpen, o.more], [true, 'less']);
  assert.ok(o.capH > s.capH + 20, 'expanded ' + o.capH);
  await tapOn(page, '.more');
  o = await ui(page);
  assert.deepEqual([o.capOpen, o.more], [false, 'more']);
  assert.equal(await page.evaluate(() => !!document.getElementById('sg-reel')), true);
  // Shown from the lookup R9 already made: no other request.
  assert.equal(page.hits['/api/v1/media/*'], 1);
  assert.deepEqual(Object.keys(page.hits).sort(), ['/api/v1/media/*']);
  const st = await r12(page);
  assert.deepEqual([st.shown, st.expanded, st.fields.user, st.fields.followState, st.fields.follow, st.fields.caption, st.fields.likes, st.fields.shares],
    [1, 1, 1, 1, 1, 1, 1, undefined]);
});

test('R12: only what is there: no counts, no picture, no Follow when followed or unknown, a short caption without "more"', async () => {
  const bare = reelItem({ like_count: undefined, comment_count: undefined, caption: { text: 'short' }, reshare_count: 7 },
    { pk: CREATOR_ID, username: 'creator' });
  let page = await openStory({ item: bare });
  await openReel(page);
  let s = await ui(page);
  assert.deepEqual([s.name, s.pic, s.badge, s.follow, s.caption, s.more], ['creator', null, false, null, 'short', null]);
  assert.deepEqual([s.like.nShown, s.comment.nShown, s.share.n, s.like.shown, s.save.shown], [false, false, '7', true, true]);
  // Followed: no Follow. Counts hidden by the owner: no like count.
  page = await openStory({ item: reelItem({ like_and_view_counts_disabled: true, like_count: 99999, comment_count: 12345678 },
    creator({ friendship_status: { following: true } })) });
  await openReel(page);
  s = await ui(page);
  assert.deepEqual([s.follow, s.like.nShown, s.comment.n], [null, false, '12.3M']);
  // Your own Reel: no Follow either.
  page = await openStory({ item: reelItem({ like_count: 25400, comment_count: 999999, reshare_count: 12000 }, creator({ pk: ME })) });
  await openReel(page);
  s = await ui(page);
  assert.deepEqual([s.follow, s.like.n, s.comment.n, s.share.n], [null, '25.4K', '999K', '12K']);
});

test('R12: like works in place with the website\'s own request; a second tap unlikes; never sent twice', async () => {
  const page = await openStory({ api: {
    '/api/graphql': (u, req) => {
      const name = new URLSearchParams(req.postData()).get('fb_api_req_friendly_name');
      const root = name === 'PolarisAPILikePostMutation' ? 'xig_media_like' : 'xig_media_unlike';
      return { body: { data: { [root]: { media: { id: REEL_PK, has_liked: root === 'xig_media_like' } } } }, delay: 300 };
    },
  } });
  await openReel(page);
  await tapOn(page, '.like');
  // Shown at once, before Instagram answers.
  let s = await ui(page);
  assert.deepEqual([s.like.on, s.like.n], [true, '1,235']);
  await tapOn(page, '.like');                        // while it's on its way: ignored
  await page.waitForTimeout(350);
  assert.equal(page.hits['/api/graphql'], 1);
  const r = page.reqs.find(x => x.key === '/api/graphql');
  const body = new URLSearchParams(r.body);
  assert.equal(r.method, 'POST');
  assert.equal(body.get('doc_id'), '28051398997871885');
  assert.equal(body.get('fb_api_req_friendly_name'), 'PolarisAPILikePostMutation');
  assert.deepEqual(JSON.parse(body.get('variables')), { input: { media_id: REEL_PK } });
  assert.deepEqual([body.get('lsd'), body.get('fb_dtsg'), body.get('fb_api_caller_class'), body.get('server_timestamps')],
    ['lsd-tok', 'dtsg-tok', 'RelayModern', 'true']);
  assert.equal(r.headers['x-csrftoken'], 'csrf-tok');
  assert.equal(r.headers['x-ig-app-id'], '936619743392459');
  assert.equal(r.headers['x-fb-friendly-name'], 'PolarisAPILikePostMutation');
  assert.equal(r.headers['x-fb-lsd'], 'lsd-tok');
  assert.match(r.headers['content-type'], /application\/x-www-form-urlencoded/);
  s = await ui(page);
  assert.deepEqual([s.like.on, s.like.n], [true, '1,235']);
  // Unlike.
  await tapOn(page, '.like');
  s = await ui(page);
  assert.deepEqual([s.like.on, s.like.n], [false, '1,234']);
  await page.waitForTimeout(400);
  assert.equal(page.hits['/api/graphql'], 2);
  const b2 = new URLSearchParams(page.reqs.filter(x => x.key === '/api/graphql')[1].body);
  assert.deepEqual([b2.get('doc_id'), b2.get('fb_api_req_friendly_name')], ['29100661379564082', 'PolarisAPIUnlikePostMutation']);
  const st = await r12(page);
  assert.deepEqual([st.like.sent, st.like.ok, st.unlike.sent, st.unlike.ok, st.busy, st.via.own], [1, 1, 1, 1, 1, 2]);
  // The Reel was neither paused nor closed; the Story underneath saw none of it.
  const after = await page.evaluate(() => ({ open: !!document.getElementById('sg-reel'), paused: document.querySelector('#sg-reel video').paused,
    story: window.__story }));
  assert.deepEqual([after.open, after.paused, after.story.paused, after.story.reply, after.story.closed], [true, false, true, 0, 0]);
});

test('R12: a refused like or save is put back with a short message, and not retried', async () => {
  const page = await openStory({ api: {
    '/api/graphql': () => ({ body: { errors: [{ message: 'Something went wrong', code: 1357004 }], data: null } }),
  } });
  await openReel(page);
  await tapOn(page, '.like');
  await page.waitForFunction(() => window.__sent.some(m => m.action === 'toast'));
  let s = await ui(page);
  assert.deepEqual([s.like.on, s.like.n], [false, '1,234']);
  assert.match((await sent(page, 'toast'))[0].message, /didn.t like it\. Nothing changed/);
  await tapOn(page, '.save');
  await page.waitForFunction(() => window.__sent.filter(m => m.action === 'toast').length === 2);
  s = await ui(page);
  assert.equal(s.save.on, false);
  await page.waitForTimeout(300);
  assert.equal(page.hits['/api/graphql'], 2, 'one request per tap, never again by itself');
  const st = await r12(page);
  assert.deepEqual([st.like.refused, st.save.refused], [1, 1]);
});

test('R12: save goes through Instagram\'s own code when it is loaded (no request of ours)', async () => {
  const page = await openStory({ init: fakeModules(`{
    PolarisAPISavePost: { savePost: id => { window.__calls.push(['save', id]); return Promise.resolve({}); } },
    PolarisAPIUnsavePost: { unsavePost: id => { window.__calls.push(['unsave', id]); return Promise.reject(Object.assign(new Error('x'), { statusCode: 500 })); } },
  }`) });
  await openReel(page);
  await tapOn(page, '.save');
  await page.waitForTimeout(100);
  assert.deepEqual(await page.evaluate(() => window.__calls), [['save', REEL_PK]]);
  assert.equal((await ui(page)).save.on, true);
  await tapOn(page, '.save');
  await page.waitForFunction(() => window.__sent.some(m => m.action === 'toast'));
  assert.equal((await ui(page)).save.on, true, 'refused unsave: still saved');
  assert.equal(page.hits['/api/graphql'], undefined);
  const st = await r12(page);
  assert.deepEqual([st.save.ok, st.unsave.refused, st.via.page], [1, 1, 2]);
});

test('R12: Follow follows with one tap; Following never unfollows; Requested for a private account', async () => {
  let answer = { body: { status: 'ok', friendship_status: { following: true, outgoing_request: false } }, delay: 200 };
  const page = await openStory({ api: { '/api/v1/friendships/*': () => answer } });
  await openReel(page);
  await tapOn(page, '.follow');
  assert.equal((await ui(page)).follow, 'Following', 'shown at once');
  await page.waitForTimeout(300);
  const r = page.reqs.find(x => x.key === '/api/v1/friendships/*');
  assert.equal(r.path, '/api/v1/friendships/create/' + CREATOR_ID + '/');
  assert.equal(r.method, 'POST');
  const body = new URLSearchParams(r.body);
  assert.deepEqual([body.get('container_module'), body.get('include_follow_friction_check'), body.get('user_id')],
    ['reel_feed_timeline', 'true', CREATOR_ID]);
  assert.deepEqual([r.headers['x-csrftoken'], r.headers['x-ig-app-id'], r.headers['x-requested-with']], ['csrf-tok', '936619743392459', 'XMLHttpRequest']);
  // A second tap (and a third) does nothing: no unfollow from here.
  await tapOn(page, '.follow');
  await tapOn(page, '.follow');
  await page.waitForTimeout(200);
  assert.equal(page.hits['/api/v1/friendships/*'], 1);
  assert.ok(!page.reqs.some(x => /destroy/.test(x.path)));
  assert.equal((await ui(page)).follow, 'Following');
  let st = await r12(page);
  assert.deepEqual([st.follow.sent, st.follow.ok, st.followingTaps], [1, 1, 2]);
  // A private account: Requested.
  answer = { body: { status: 'ok', friendship_status: { following: false, outgoing_request: true } } };
  const p2 = await openStory({ api: { '/api/v1/friendships/*': () => answer } });
  await openReel(p2);
  await tapOn(p2, '.follow');
  await p2.waitForFunction(() => document.getElementById('sg-reelinfo').shadowRoot.querySelector('.follow').textContent === 'Requested');
  st = await r12(p2);
  assert.deepEqual([st.follow.ok, st.follow.requested], [1, 1]);
});

test('R12: a refused follow (or one Instagram wants confirmed) goes back to Follow with a message', async () => {
  const page = await openStory({ api: { '/api/v1/friendships/*': () => ({ status: 400, body: { status: 'fail', message: 'growth_friction_dialog' } }) } });
  await openReel(page);
  await tapOn(page, '.follow');
  const [t] = await waitSent(page, 'toast');
  assert.match(t.message, /confirmed: open their profile/);
  assert.equal((await ui(page)).follow, 'Follow');
  assert.equal((await r12(page)).follow.friction, 1);
  // Through Instagram's own code: its refusal is read the same way.
  const p2 = await openStory({ init: fakeModules(`{ PolarisSharedAPI: { followUser: id => { window.__calls.push(id);
    return Promise.reject({ statusCode: 500, responseObject: { message: 'oops' } }); } } }`) });
  await openReel(p2);
  await tapOn(p2, '.follow');
  await waitSent(p2, 'toast');
  assert.deepEqual(await p2.evaluate(() => window.__calls), [CREATOR_ID]);
  assert.equal((await ui(p2)).follow, 'Follow');
  assert.equal(p2.hits['/api/v1/friendships/*'], undefined);
});

test('R12: nothing is sent while Instagram is slowing requests down', async () => {
  const page = await openStory({ api: {
    '/api/graphql': () => ({ status: 429, body: {} }),
    '/api/v1/friendships/*': () => ({ body: { status: 'ok', friendship_status: { following: true } } }),
  } });
  await openReel(page);
  // A 429 on the first like: put back, and the next taps send nothing.
  await tapOn(page, '.like');
  await page.waitForFunction(() => window.__sent.some(m => m.action === 'toast'));
  assert.match((await sent(page, 'toast'))[0].message, /slowing things down/);
  await tapOn(page, '.like');
  await tapOn(page, '.save');
  await tapOn(page, '.follow');
  await page.waitForTimeout(200);
  assert.equal(page.hits['/api/graphql'], 1);
  assert.equal(page.hits['/api/v1/friendships/*'], undefined);
  const s = await ui(page);
  assert.deepEqual([s.like.on, s.save.on, s.follow], [false, false, 'Follow']);
  assert.equal((await r12(page)).slowed, 3);
  // Instagram's own "please wait" answer elsewhere on the page counts too.
  const p2 = await openStory({ api: { '/api/graphql': () => ({ body: { data: { xig_media_like: {} } } }) } });
  await openReel(p2);
  await p2.evaluate(() => JSON.parse('{"status":"fail","message":"Please wait a few minutes before you try again."}'));
  await tapOn(p2, '.like');
  await p2.waitForTimeout(200);
  assert.equal(p2.hits['/api/graphql'], undefined);
  assert.match((await sent(p2, 'toast'))[0].message, /slowing things down/);
});

test('R12: comment hands the Reel to the comments panel; the Reel fits above it and comes back', async () => {
  const page = await openStory();
  await openReel(page);
  await tapOn(page, '.comment');
  const [c] = await waitSent(page, 'comments');
  assert.equal(c.code, 'REELCODE1');
  assert.equal(c.url, 'https://www.instagram.com/p/REELCODE1/comments/');
  // The app says its panel is up over the Story, its top 384 px down.
  await page.evaluate(() => window.__sg.onNative({ type: 'commentsOver', on: true, top: 384 }));
  let g = await page.evaluate(() => ({ v: document.querySelector('#sg-reel video').getBoundingClientRect().height,
    info: getComputedStyle(document.getElementById('sg-reelinfo')).visibility, open: !!document.getElementById('sg-reel'),
    playing: !document.querySelector('#sg-reel video').paused, story: window.__story.paused }));
  assert.deepEqual(g, { v: 384, info: 'hidden', open: true, playing: true, story: true });
  // Closed: back to the whole screen.
  await page.evaluate(() => window.__sg.onNative({ type: 'splitClosed' }));
  g = await page.evaluate(() => ({ v: document.querySelector('#sg-reel video').getBoundingClientRect().height,
    info: getComputedStyle(document.getElementById('sg-reelinfo')).visibility }));
  assert.deepEqual(g, { v: 915, info: 'visible' });
  const st = await r12(page);
  assert.deepEqual([st.comments, st.commentsOver], [1, 1]);
  // Comments turned off: a short message, no panel.
  const p2 = await openStory({ item: reelItem({ comments_disabled: true }) });
  await openReel(p2);
  await tapOn(p2, '.comment');
  const [t] = await waitSent(p2, 'toast');
  assert.match(t.message, /Comments are turned off/);
  assert.deepEqual(await sent(p2, 'comments'), []);
});

test('R12: share offers the Reel\'s link', async () => {
  const page = await openStory();
  await openReel(page);
  await tapOn(page, '.share');
  const [m] = await waitSent(page, 'share');
  assert.equal(m.url, 'https://www.instagram.com/reel/REELCODE1/');
  assert.equal(await page.evaluate(() => !!document.getElementById('sg-reel')), true);
});

test('R12: the account opens their profile: the layer closes first (the Story is let go), then Instagram\'s router', async () => {
  const page = await openStory({ init: fakeModules(`{
    currentCometRouterInstance: { get_THIS_IS_NOT_WHAT_YOU_WANT: () => ({ getCurrentRouterStatus: () => 'NO_ACTIVE_NAVIGATION' }) },
    browserHistory_DO_NOT_USE: { getCometRouterDispatcher: () => ({}), browserHistory: { push: p => window.__calls.push(['push', p,
      !!document.getElementById('sg-reel'), window.__sent.filter(m => m.action === 'fullVideo').map(m => m.on).join(), window.__story.paused]) } },
  }`) });
  await openReel(page);
  await tapOn(page, '.name');
  await page.waitForFunction(() => window.__calls.length === 1);
  assert.deepEqual(await page.evaluate(() => window.__calls), [['push', '/creator/', false, 'true,false', false]]);
  assert.deepEqual((await r12(page)).profileVia, { router: 1 });
  // Without a readable router: a full load of the profile.
  const p2 = await openStory();
  await openReel(p2);
  await tapOn(p2, '.pic');
  await p2.waitForURL('https://www.instagram.com/creator/');
  assert.match(await p2.evaluate(() => document.body.textContent), /OTHER \/creator\//);
});

test('R12: the overlay\'s touches neither close nor pause the Reel nor reach the Story; the bar still works', async () => {
  const page = await openStory();
  await openReel(page);
  await page.waitForFunction(() => { const v = document.querySelector('#sg-reel video'); return v.readyState >= 1 && !v.paused; });
  const moves = await page.evaluate(() => {
    window.__boxMoves = [];
    document.getElementById('sg-reel').addEventListener('touchmove', e => window.__boxMoves.push(e.defaultPrevented), { passive: true });
    return window.__story.starts;
  });
  // Taps on the caption, the counts and a short drag (not a swipe) on the caption.
  const [cx, cy] = await spot(page, '.cap');
  await drag(page, [cx, cy], [cx, cy - 30]);
  await tapAt(page, cx, cy);
  const [nx, ny] = await spot(page, '.like .n');
  await tapAt(page, nx, ny - 30);
  await page.evaluate(() => { const v = document.querySelector('#sg-reel video'); if (v.paused) window.__pausedAt = 1; });
  const st = await page.evaluate(() => ({ open: !!document.getElementById('sg-reel'), paused: document.querySelector('#sg-reel video').paused,
    story: window.__story, held: window.__boxMoves }));
  assert.equal(st.open, true);
  assert.equal(st.paused, false);
  assert.equal(st.story.starts, moves, 'the Story saw no touch');
  assert.deepEqual([st.story.reply, st.story.closed, st.story.paused], [0, 0, true]);
  assert.equal(st.held.length, 0, 'the layer\'s own swipe never saw them');
  // B25's bookkeeping saw every touch end (none lost).
  const seq = await page.evaluate(() => JSON.parse(JSON.stringify(window.__sg.stats.b25.touchSeq)));
  assert.deepEqual([seq.orphans, seq.starts - seq.ends], [0, 0], JSON.stringify(seq));
  // The bar along the bottom still seeks, and the overlay steps aside while it's in use.
  const bar = await page.evaluate(() => {
    const t = document.querySelector('#sg-reel [data-sg-bar="story"]').shadowRoot.querySelector('.track').getBoundingClientRect();
    return { y: t.bottom - 2, left: t.left, width: t.width };
  });
  const c = await page.context().newCDPSession(page);
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: bar.left + bar.width * 0.5, y: bar.y }] });
  await page.waitForFunction(() => getComputedStyle(document.getElementById('sg-reelinfo')).opacity === '0', null, { timeout: 1000 });
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await c.detach();
  await page.waitForTimeout(150);
  assert.equal((await page.evaluate(() => JSON.parse(JSON.stringify(window.__sg.stats.seekBar)))).taps, 1);
  await page.waitForFunction(() => getComputedStyle(document.getElementById('sg-reelinfo')).opacity === '1', null, { timeout: 2000 });
  // A swipe on the video itself still returns to the Story, which continues.
  await drag(page, [200, 300], [200, 650], { steps: 4 });
  const end = await page.evaluate(() => ({ box: !!document.getElementById('sg-reel'), info: !!document.getElementById('sg-reelinfo'), story: window.__story.paused }));
  assert.deepEqual(end, { box: false, info: false, story: false });
});

test('R12: an opened long caption scrolls under the finger; the page stays still', async () => {
  const long = Array.from({ length: 60 }, (_, i) => 'caption line ' + i).join('\n');
  const page = await openStory({ item: reelItem({ caption: { text: long } }) });
  await openReel(page);
  await tapOn(page, '.more');
  const [cx, cy] = await spot(page, '.cap');
  await drag(page, [cx, cy + 60], [cx, cy - 60], { steps: 6 });
  const top = await page.evaluate(() => document.getElementById('sg-reelinfo').shadowRoot.querySelector('.cap').scrollTop);
  assert.ok(top > 60, 'scrolled ' + top);
  assert.equal(await page.evaluate(() => !!document.getElementById('sg-reel')), true);
});

test('R12: diagnostics carry counts only (no names, captions, codes, ids or links)', async () => {
  const page = await openStory({ api: {
    '/api/graphql': () => ({ body: { data: { xig_media_like: {} } } }),
    '/api/v1/friendships/*': () => ({ body: { status: 'ok', friendship_status: { following: true } } }),
  } });
  await openReel(page);
  await tapOn(page, '.like');
  await tapOn(page, '.follow');
  await tapOn(page, '.share');
  await tapOn(page, '.comment');
  await tapOn(page, '.more');
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__sg.onNative({ type: 'status' }));
  const [m] = await waitSent(page, 'status');
  const d = JSON.stringify(m.stats);
  assert.doesNotMatch(d, /creator|Sunset|harbour|REELCODE1|3141592653|9001|creator_pic|cdninstagram|csrf-tok/);
  assert.equal(m.stats.reelInfo.like.ok, 1);
  assert.equal(m.stats.reelInfo.follow.ok, 1);
});

test('B30: the comment icon is a whole bubble (its arc fills the icon\'s square), like the others', async () => {
  const page = await openStory();
  await openReel(page);
  const boxes = await page.evaluate(() => {
    const root = document.getElementById('sg-reelinfo').shadowRoot;
    const out = {};
    for (const k of ['like', 'comment', 'share', 'save']) {
      const b = root.querySelector('.' + k + ' path').getBBox();
      out[k] = { x: Math.round(b.x * 10) / 10, y: Math.round(b.y * 10) / 10, w: Math.round(b.width * 10) / 10, h: Math.round(b.height * 10) / 10 };
    }
    return out;
  });
  const c = boxes.comment;
  assert.ok(c.w > 16 && c.h > 16, 'spans most of the 24-unit box: ' + JSON.stringify(c));
  assert.ok(c.x >= 0 && c.y >= 0 && c.x + c.w <= 24 && c.y + c.h <= 24, 'inside the icon: ' + JSON.stringify(c));
  // Drawn the same size as its neighbours (the arc's centre is inside the icon, not off to the side).
  for (const k of ['like', 'share', 'save']) assert.ok(Math.abs(boxes[k].w - c.w) < 6 && Math.abs(boxes[k].h - c.h) < 6, k + ' vs comment: ' + JSON.stringify(boxes));
});

// An opened post with a video at the top (as in video.test.cjs).
const POST = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body style="margin:0">
  <main><article><header style="height:60px">creator</header>
    <div style="position:relative;width:412px;height:500px">
      <video id="v" muted playsinline loop src="https://scontent.cdninstagram.com/v/t50/reel-720.webm" style="width:412px;height:500px;display:block;background:#222"></video>
    </div><div style="height:1200px">caption</div></article></main></body></html>`;

test('R12: R10\'s full screen stays clean: a post\'s video full screen has no details over it', async () => {
  const page = await openStory({ url: 'https://www.instagram.com/p/REELCODE1/', html: POST });
  // Indexed with all its details, as a post's data would be.
  await page.evaluate(p => JSON.parse(JSON.stringify(p)), { status: 'ok', items: [reelItem()] });
  await page.evaluate(() => {
    window.__fsEl = null;
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => window.__fsEl });
    HTMLElement.prototype.requestFullscreen = function () {
      window.__fsEl = this;
      document.dispatchEvent(new Event('fullscreenchange'));
      return Promise.resolve();
    };
  });
  await drag(page, [200, 200], [210, 420]);
  await page.waitForFunction(() => document.getElementById('sg-fullbar'), null, { timeout: 3000 });
  assert.equal(await page.evaluate(() => !!document.getElementById('sg-reelinfo')), false);
  assert.equal((await r12(page)).shown, 0);
});

/* ---------------- Review fixes ---------------- */

const closeReel = page => drag(page, [200, 300], [200, 650], { steps: 4 });
const toasts = page => page.evaluate(() => window.__sent.filter(m => m.action === 'toast').map(m => m.message));

test('R12: a Story that isn\'t in full screen: the layer is over the page, comments come up over the Reel', async () => {
  const page = await openStory({ full: false });
  await openReel(page);
  assert.equal(await page.evaluate(() => document.getElementById('sg-reel').parentElement.tagName), 'BODY');
  assert.deepEqual((await sent(page, 'fullVideo')).map(m => m.on), [true]);
  await tapOn(page, '.comment');
  const [c] = await waitSent(page, 'comments');
  assert.deepEqual([c.code, c.rect], ['REELCODE1', null], 'the app takes it as the Reel\'s (it is in its Reel mode)');
  // The app's panel over the page: the Reel fits above it, its details and bar step aside.
  await page.evaluate(() => window.__sg.onNative({ type: 'commentsOver', on: true, top: 384 }));
  const g = await page.evaluate(() => ({ v: document.querySelector('#sg-reel video').getBoundingClientRect().height,
    info: getComputedStyle(document.getElementById('sg-reelinfo')).visibility,
    bar: getComputedStyle(document.querySelector('#sg-reel [data-sg-bar="story"]')).visibility, story: window.__story.paused }));
  assert.deepEqual(g, { v: 384, info: 'hidden', bar: 'hidden', story: true });
  await page.evaluate(() => window.__sg.onNative({ type: 'splitClosed' }));
  assert.equal(await page.evaluate(() => document.querySelector('#sg-reel video').getBoundingClientRect().height), 915);
  assert.equal(await page.evaluate(() => !!document.getElementById('sg-reel')), true);
});

test('R12: a Reel saved into a collection isn\'t unsaved by one tap (the website asks first); an ordinary save still is', async () => {
  const mods = fakeModules(`{
    PolarisAPIUnsavePost: { unsavePost: id => { window.__calls.push(['unsave', id]); return Promise.resolve({}); } },
  }`);
  const page = await openStory({ init: mods, item: reelItem({ has_viewer_saved: true, saved_collection_ids: ['17900000000000001'] }) });
  await openReel(page);
  assert.equal((await ui(page)).save.on, true);
  await tapOn(page, '.save');
  await page.waitForTimeout(150);
  assert.deepEqual(await page.evaluate(() => window.__calls), []);
  assert.equal(page.hits['/api/graphql'], undefined);
  assert.equal((await ui(page)).save.on, true, 'still saved');
  assert.match((await toasts(page))[0], /in one of your collections/);
  assert.equal((await r12(page)).inCollection, 1);
  // Saved, but in no collection: one tap unsaves.
  for (const extra of [{ has_viewer_saved: true, saved_collection_ids: [] }, { has_viewer_saved: true }]) {
    const p2 = await openStory({ init: mods, item: reelItem(extra) });
    await openReel(p2);
    await tapOn(p2, '.save');
    await p2.waitForTimeout(150);
    assert.deepEqual(await p2.evaluate(() => window.__calls), [['unsave', REEL_PK]]);
    assert.equal((await ui(p2)).save.on, false);
  }
});

test('R12: comments limited for you can still be read: the panel opens; turned off for everyone, they can\'t', async () => {
  const page = await openStory({ item: reelItem({ commenting_disabled_for_viewer: true, comment_count: 900 }) });
  await openReel(page);
  assert.equal((await ui(page)).comment.n, '900');
  await tapOn(page, '.comment');
  const [c] = await waitSent(page, 'comments');
  assert.equal(c.code, 'REELCODE1');
  assert.deepEqual(await toasts(page), []);
});

test('R12: an action on its way belongs to the Reel: closed and opened again, a tap sends nothing more; a late refusal shows on the open one', async () => {
  let refuse = false;
  const page = await openStory({ api: {
    // Long enough that the reopened Reel's tap surely lands while the like is still on its way.
    '/api/graphql': () => refuse ? { body: { errors: [{ message: 'no', code: 1357004 }], data: null }, delay: 4000 }
      : { body: { data: { xig_media_like: { media: { id: REEL_PK } } } }, delay: 4000 },
  } });
  await openReel(page);
  await tapOn(page, '.like');
  await closeReel(page);
  assert.equal(await page.evaluate(() => !!document.getElementById('sg-reel')), false);
  await openReel(page);
  let s = await ui(page);
  assert.deepEqual([s.like.on, s.like.n], [true, '1,235'], 'the opened-again Reel shows the like on its way');
  await tapOn(page, '.like');
  await page.waitForTimeout(1300);
  assert.equal(page.hits['/api/graphql'], 1, 'one request at a time for the Reel');
  assert.equal((await r12(page)).busy, 1);
  s = await ui(page);
  assert.deepEqual([s.like.on, s.like.n], [true, '1,235']);
  // Refused after the Reel was opened again: the open overlay is put back.
  refuse = true;
  const p2 = await openStory({ api: { '/api/graphql': () => ({ body: { errors: [{ message: 'no', code: 1357004 }], data: null }, delay: 1200 }) } });
  await openReel(p2);
  await tapOn(p2, '.like');
  await closeReel(p2);
  await openReel(p2);
  await p2.waitForFunction(() => window.__sent.some(m => m.action === 'toast'), null, { timeout: 4000 });
  s = await ui(p2);
  assert.deepEqual([s.like.on, s.like.n], [false, '1,234']);
  assert.equal(p2.hits['/api/graphql'], 1);
  // A follow refused after the Reel was opened again: Follow is back on the open one.
  // Long enough that the second tap surely lands while the first follow is still on its way, even on a busy machine.
  const p3 = await openStory({ api: { '/api/v1/friendships/*': () => ({ status: 400, body: { status: 'fail', message: 'oops' }, delay: 4000 }) } });
  await openReel(p3);
  await tapOn(p3, '.follow');
  await closeReel(p3);
  await openReel(p3);
  assert.equal((await ui(p3)).follow, 'Following', 'on its way: shown as Following');
  await tapOn(p3, '.follow');
  await p3.waitForFunction(() => window.__sent.some(m => m.action === 'toast'), null, { timeout: 9000 });
  // The refusal's toast can trail another note on a busy machine: wait for the button itself.
  for (let i = 0; i < 40 && (await ui(p3)).follow !== 'Follow'; i++) await p3.waitForTimeout(100);
  assert.equal((await ui(p3)).follow, 'Follow');
  assert.equal(p3.hits['/api/v1/friendships/*'], 1);
});

test('R12: a tap that began on the loading Reel and lifts after the details came is the video\'s, never a follow or a like', async () => {
  // Where the buttons are, from a Reel that is already showing.
  const p0 = await openStory();
  await openReel(p0);
  const at = { follow: await spot(p0, '.follow'), like: await spot(p0, '.like'), name: await spot(p0, '.name') };
  for (const k of Object.keys(at)) {
    const page = await openStory({ api: {
      '/api/v1/media/*': () => ({ body: { status: 'ok', items: [reelItem()] }, delay: 700 }),
      '/api/graphql': () => ({ body: { data: { xig_media_like: {} } } }),
      '/api/v1/friendships/*': () => ({ body: { status: 'ok', friendship_status: { following: true } } }),
    } });
    await drag(page, [200, 600], [205, 250], { steps: 4 });
    const c = await page.context().newCDPSession(page);
    await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at[k][0], y: at[k][1] }] });
    await page.waitForFunction(() => document.getElementById('sg-reelinfo'), null, { timeout: 4000 });
    await page.waitForTimeout(30);
    await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await c.detach();
    await page.waitForTimeout(250);
    assert.equal(page.hits['/api/v1/friendships/*'], undefined, k);
    assert.equal(page.hits['/api/graphql'], undefined, k);
    assert.equal(page.url(), STORY_URL, k);
    assert.equal(await page.evaluate(() => !!document.getElementById('sg-reel')), true, k);
    assert.equal((await r12(page)).strayTaps, 1, k);
    if (k !== 'follow') continue;
    // A tap that starts on the details acts.
    await tapOn(page, '.follow');
    await page.waitForTimeout(150);
    assert.equal(page.hits['/api/v1/friendships/*'], 1);
    assert.equal((await ui(page)).follow, 'Following');
  }
  // A click with no touch (TalkBack) acts.
  const p2 = await openStory({ api: { '/api/graphql': () => ({ body: { data: { xig_media_like: {} } } }) } });
  await openReel(p2);
  await p2.evaluate(() => document.getElementById('sg-reelinfo').shadowRoot.querySelector('.like').click());
  await p2.waitForTimeout(150);
  assert.equal(p2.hits['/api/graphql'], 1);
});

test('R12: while the bar is in use the faded details take no taps: a tap there pauses or plays the video', async () => {
  const page = await openStory({ api: { '/api/graphql': () => ({ body: { data: { xig_media_like: {}, xig_media_save: {} } } }) } });
  await openReel(page);
  await page.waitForFunction(() => { const v = document.querySelector('#sg-reel video'); return v.readyState >= 1 && !v.paused; });
  const saveAt = await spot(page, '.save'), likeAt = await spot(page, '.like');
  const bar = await page.evaluate(() => {
    const t = document.querySelector('#sg-reel [data-sg-bar="story"]').shadowRoot.querySelector('.track').getBoundingClientRect();
    return [t.left + t.width * 0.3, t.bottom - 2];
  });
  const paused = () => page.evaluate(() => document.querySelector('#sg-reel video').paused);
  await tapAt(page, bar[0], bar[1]);
  await tapAt(page, saveAt[0], saveAt[1]);
  assert.equal(await paused(), true, 'the tap paused the video');
  await tapAt(page, likeAt[0], likeAt[1]);
  assert.equal(await paused(), false, 'and played it again');
  const st = await r12(page);
  assert.deepEqual([st.save.sent, st.like.sent], [0, 0]);
  assert.equal(page.hits['/api/graphql'], undefined);
  // Once it is back, its buttons work again.
  await page.waitForFunction(() => !document.getElementById('sg-reelinfo').hasAttribute('data-faded'), null, { timeout: 3000 });
  await tapOn(page, '.like');
  await page.waitForTimeout(150);
  assert.equal((await r12(page)).like.sent, 1);
});

test('R12: a swipe down that starts on the details returns to the Story, which continues (B29: up opens the comments)', async () => {
  for (const sel of ['.like', '.save', '.comment', '.cap', '.name']) {
    const page = await openStory();
    await openReel(page);
    const [x, y] = await spot(page, sel);
    await drag(page, [x, y], [x, y + 200]);
    const st = await page.evaluate(() => ({ open: !!document.getElementById('sg-reel'), story: window.__story }));
    assert.equal(st.open, false, sel);
    assert.deepEqual([st.story.paused, st.story.closed, st.story.reply], [false, 0, 0], sel);
    const r = await r12(page);
    assert.deepEqual([r.like.sent, r.save.sent, r.comments, r.profile], [0, 0, 0, 0], sel);
    assert.deepEqual(await sent(page, 'comments'), [], sel);
  }
  // An opened caption scrolls instead (the long-caption test); a drag of a few px is no swipe.
  const page = await openStory();
  await openReel(page);
  const [x, y] = await spot(page, '.like');
  await drag(page, [x, y], [x, y - 25]);
  assert.equal(await page.evaluate(() => !!document.getElementById('sg-reel')), true);
  assert.deepEqual(await sent(page, 'comments'), []);
});

const reelOpen = page => page.evaluate(() => !!document.getElementById('sg-reel'));
test('B29: a swipe up on a Story\'s Reel (or its details) opens the comments as the Comment button does; the Reel stays, the Story waits', async () => {
  const reelState = page => page.evaluate(() => ({ open: !!document.getElementById('sg-reel'), story: window.__story.paused,
    playing: !document.querySelector('#sg-reel video').paused, fs: document.fullscreenElement && document.fullscreenElement.tagName }));
  for (const [where, from] of [['the video', [200, 400]], ['the like count', '.like'], ['the caption', '.cap'], ['the name', '.name']]) {
    const page = await openStory();
    await openReel(page);
    await page.waitForFunction(() => { const v = document.querySelector('#sg-reel video'); return v.readyState >= 1 && !v.paused; });
    const [x, y] = Array.isArray(from) ? from : await spot(page, from);
    await drag(page, [x, y], [x + 4, y - 260]);
    const [c] = await waitSent(page, 'comments');
    assert.equal(c.code, 'REELCODE1', where);
    assert.equal(c.url, 'https://www.instagram.com/p/REELCODE1/comments/', where);
    assert.deepEqual(await reelState(page), { open: true, story: true, playing: true, fs: 'BODY' }, where);
    const r = await r12(page);
    assert.deepEqual([r.swipeComments, r.comments, r.like.sent, r.profile], [1, 1, 0, 0], where);
    // The panel is up over the Story (the app says so): another swipe up asks for nothing more.
    await page.evaluate(() => window.__sg.onNative({ type: 'commentsOver', on: true, top: 384 }));
    await drag(page, [200, 300], [200, 40]);
    assert.equal((await sent(page, 'comments')).length, 1, where);
    assert.equal((await r12(page)).swipeComments, 1, where);
    // Closed again: a swipe down returns to the Story as ever.
    await page.evaluate(() => window.__sg.onNative({ type: 'splitClosed' }));
    await drag(page, [200, 300], [200, 650], { steps: 4 });
    assert.deepEqual(await page.evaluate(() => [!!document.getElementById('sg-reel'), window.__story.paused]), [false, false], where);
    await page.context().close();
  }
  // Comments turned off: the swipe does nothing (no panel, no message), the Reel plays on.
  const off = await openStory({ item: reelItem({ comments_disabled: true }) });
  await openReel(off);
  await drag(off, [200, 400], [200, 140]);
  await off.waitForTimeout(200);
  assert.deepEqual([await sent(off, 'comments'), (await sent(off, 'toast')).length], [[], 0]);
  assert.deepEqual(await reelOpen(off), true);
  assert.equal((await r12(off)).swipeComments, 0);
  // Back from the app still closes the Reel.
  await off.evaluate(() => window.__sg.onNative({ type: 'fullVideoExit' }));
  assert.equal(await reelOpen(off), false);
});

test('R12: like and save send the Reel\'s exact id, though Instagram\'s answer has it as a bare 19-digit number', async () => {
  const BIG = '3456789012345678901';
  const raw = JSON.stringify({ status: 'ok', items: [reelItem({ pk: 'PK_HERE', id: BIG + '_' + CREATOR_ID })] })
    .replace('"pk":"PK_HERE"', '"pk":' + BIG);
  assert.ok(raw.includes('"pk":' + BIG + ','));
  const page = await openStory({ api: {
    '/api/v1/media/*': () => ({ raw }),
    '/api/graphql': (u, req) => {
      const name = new URLSearchParams(req.postData()).get('fb_api_req_friendly_name');
      const root = { PolarisAPILikePostMutation: 'xig_media_like', PolarisAPIUnlikePostMutation: 'xig_media_unlike',
        PolarisAPISavePostMutation: 'xig_media_save', PolarisAPIUnsavePostMutation: 'xig_media_unsave' }[name];
      return { body: { data: { [root]: {} } } };
    },
  } });
  await openReel(page);
  for (const sel of ['.like', '.like', '.save', '.save']) {
    await tapOn(page, sel);
    await page.waitForTimeout(150);
  }
  const sentIds = page.reqs.filter(x => x.key === '/api/graphql').map(x => {
    const b = new URLSearchParams(x.body);
    return [b.get('fb_api_req_friendly_name'), JSON.parse(b.get('variables')).input.media_id];
  });
  assert.deepEqual(sentIds, [['PolarisAPILikePostMutation', BIG], ['PolarisAPIUnlikePostMutation', BIG],
    ['PolarisAPISavePostMutation', BIG], ['PolarisAPIUnsavePostMutation', BIG]]);
  // Through Instagram's own code: the same exact id.
  const p2 = await openStory({ api: { '/api/v1/media/*': () => ({ raw }) }, init: fakeModules(`{
    PolarisAPILikePost: { likePost: id => { window.__calls.push(['like', id]); return Promise.resolve({}); } },
    PolarisAPISavePost: { savePost: id => { window.__calls.push(['save', id]); return Promise.resolve({}); } },
  }`) });
  await openReel(p2);
  await tapOn(p2, '.like');
  await tapOn(p2, '.save');
  await p2.waitForTimeout(150);
  assert.deepEqual(await p2.evaluate(() => window.__calls), [['like', BIG], ['save', BIG]]);
});

test('R12: Instagram\'s action block (GraphQL codes 1404006/1404078) counts as slowing down: nothing more is sent', async () => {
  const page = await openStory({ api: {
    '/api/graphql': () => ({ body: { errors: [{ code: 1404078, summary: 'Action blocked', description: 'We restrict certain activity to protect our community.' }], data: null } }),
    '/api/v1/friendships/*': () => ({ body: { status: 'ok', friendship_status: { following: true } } }),
  } });
  await openReel(page);
  await tapOn(page, '.like');
  await page.waitForFunction(() => window.__sent.some(m => m.action === 'toast'));
  assert.match((await toasts(page))[0], /slowing things down/);
  await tapOn(page, '.like');
  await tapOn(page, '.save');
  await tapOn(page, '.follow');
  await page.waitForTimeout(200);
  assert.equal(page.hits['/api/graphql'], 1);
  assert.equal(page.hits['/api/v1/friendships/*'], undefined);
  let st = await r12(page);
  assert.deepEqual([st.slowed, st.blocked, st.like.refused], [3, 1, 1]);
  // Through Instagram's own code: its raw GraphQL error, or a network error carrying it.
  for (const rejection of ['({ code: 1404006, summary: "Action blocked" })', 'Object.assign(new Error("x"), { source: { code: 1404078 } })']) {
    const p2 = await openStory({ init: fakeModules(`{
      PolarisAPILikePost: { likePost: id => { window.__calls.push(id); return Promise.reject(${rejection}); } },
    }`) });
    await openReel(p2);
    await tapOn(p2, '.like');
    await p2.waitForFunction(() => window.__sent.some(m => m.action === 'toast'));
    await tapOn(p2, '.like');
    await p2.waitForTimeout(150);
    assert.equal((await p2.evaluate(() => window.__calls)).length, 1, rejection);
    assert.match((await toasts(p2))[0], /slowing things down/);
    st = await r12(p2);
    assert.equal(st.slowed, 1);
  }
});

test('R12: an action Instagram\'s own code never answers is given up on: Follow comes back with a message', async () => {
  const page = await openStory({ cfg: { actionWaitMs: 300 }, init: fakeModules(`{
    PolarisSharedAPI: { followUser: id => { window.__calls.push(['follow', id]); return new Promise(() => null); } },
    PolarisAPILikePost: { likePost: id => { window.__calls.push(['like', id]); return new Promise(() => null); } },
  }`) });
  await openReel(page);
  await tapOn(page, '.follow');
  assert.equal((await ui(page)).follow, 'Following');
  await page.waitForFunction(() => window.__sent.some(m => m.action === 'toast'), null, { timeout: 3000 });
  assert.equal((await ui(page)).follow, 'Follow');
  assert.match((await toasts(page))[0], /Couldn.t confirm the follow/);
  await tapOn(page, '.like');
  assert.equal((await ui(page)).like.on, true);
  await page.waitForFunction(() => window.__sent.filter(m => m.action === 'toast').length === 2, null, { timeout: 3000 });
  const s = await ui(page);
  assert.deepEqual([s.like.on, s.like.n], [false, '1,234']);
  const st = await r12(page);
  assert.deepEqual([st.follow.unconfirmed, st.follow.refused, st.like.unconfirmed, st.like.refused], [1, 0, 1, 0]);
  assert.deepEqual(await page.evaluate(() => window.__calls), [['follow', CREATOR_ID], ['like', REEL_PK]]);
});
