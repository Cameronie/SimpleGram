// Browser tests for the SimpleGram page script.
//
// Every request is answered locally (nothing reaches Instagram). Payloads are
// modelled on the shapes Instagram's website uses; they are fixtures, not
// captures of a signed-in session, so passing here does not prove live behaviour.
//
// Run: NODE_PATH=/opt/node-tools/node_modules node --test tests/
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'simplegram.js'), 'utf8');
const ME = '1000';
let browser;

before(async () => {
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || undefined,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
});
after(async () => { await browser.close(); });

/** Opens `url` (served from `html`) with the page script injected like the app does. */
async function open(url, html, { role = 'main', api = {} } = {}) {
  const context = await browser.newContext({
    viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true,
  });
  const page = await context.newPage();
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (api[u.pathname]) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(api[u.pathname]) });
    }
    if (u.href.split('#')[0] === url || u.pathname === new URL(url).pathname) {
      return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    }
    if (/\.(jpg|png)/.test(u.pathname)) {
      return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    }
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><body></body>' });
  });
  await page.addInitScript(() => {
    window.__sent = [];
    window.SGNative = { postMessage: m => window.__sent.push(JSON.parse(m)) };
  });
  await page.addInitScript(`window.__sgCfg=${JSON.stringify({ role, version: 'test', searchPages: 3, viewerId: ME })};\n${SCRIPT}`);
  await page.goto(url);
  return page;
}
async function sent(page, action) {
  return page.evaluate(a => window.__sent.filter(m => !a || m.action === a), action);
}
async function waitSent(page, action) {
  await page.waitForFunction(a => window.__sent.some(m => m.action === a), action, { timeout: 5000 });
  return sent(page, action);
}

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const BLANK = '<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body><main></main></body></html>';

/* ---------------- Fixture builders ---------------- */
let pkSeq = 5000;
function user(name, following) {
  const u = { pk: String(pkSeq++), username: name };
  if (following !== undefined) u.friendship_status = { following };
  return u;
}
function media(code, u, extra = {}) {
  return Object.assign({
    pk: String(pkSeq++), id: String(pkSeq) + '_' + u.pk, code, user: u,
    image_versions2: { candidates: [
      { url: `https://scontent.cdninstagram.com/v/t51/${code}_big_n.jpg?stp=1080`, width: 1080, height: 1350 },
      { url: `https://scontent.cdninstagram.com/v/t51/${code}_big_n.jpg?stp=640`, width: 640, height: 800 },
    ] },
  }, extra);
}
function edge(node) { return { node: Object.assign({ __typename: 'XDTFeedItem' }, node), cursor: 'c' }; }
function timeline(edges, more = true) {
  return { data: { xdt_api__v1__feed__timeline__connection: { edges, page_info: { has_next_page: more, end_cursor: 'abc' } } }, extensions: { is_final: true } };
}
function codes(payload) {
  return payload.data.xdt_api__v1__feed__timeline__connection.edges.map(e => e.node.media ? e.node.media.code : Object.keys(e.node).filter(k => e.node[k] && k !== '__typename')[0]);
}

function mixedFeed() {
  return timeline([
    edge({ media: media('FRIEND1', user('friend', true)) }),
    edge({ media: media('ADPOST1', user('brand'), { ad_id: '123', injected: { label: 'Sponsored' } }), ad: { id: 'x' } }),
    edge({ media: media('SUGG001', user('stranger', false)) }),
    edge({ explore_story: { media: media('EXPLOR1', user('other', false)) } }),
    edge({ suggested_users: { users: [user('a'), user('b')] } }),
    edge({ media: media('REPOST1', user('creator', false)), reposter: { username: 'friend2', pk: '77' } }),
    edge({ media: media('MINE001', Object.assign(user('me', false), { pk: ME })) }),
    edge({ media: media('NOINFO1', user('nofollowinfo')) }),
    edge({ media: media('COLLAB1', user('notfollowed', false), { coauthor_producers: [user('friend3', true)] }) }),
    edge({ media: media('REPOSTF', user('friend4', true), { social_context: 'friend5 reposted' }) }),
    edge({ media: media('FRIEND2', user('friend6', true), { caption: { text: 'Suggested for you: reposted this Ad' } }) }),
    edge({ end_of_feed_demarcator: { title: "You're all caught up" } }),
  ]);
}

/* ---------------- Data-layer filtering ---------------- */

test('feed: JSON.parse keeps friends and removes ads, suggestions and reposts', async () => {
  const page = await open('https://www.instagram.com/', BLANK);
  const out = await page.evaluate(p => JSON.parse(JSON.stringify(p)), mixedFeed());
  assert.deepEqual(codes(out), ['FRIEND1', 'MINE001', 'NOINFO1', 'COLLAB1', 'FRIEND2', 'end_of_feed_demarcator']);
  assert.equal(out.data.xdt_api__v1__feed__timeline__connection.page_info.has_next_page, true);
  const stats = await page.evaluate(() => window.__sg.stats.feed);
  assert.equal(stats.ad, 1);
  assert.equal(stats.notFollowed, 1);
  assert.equal(stats.suggested, 2);
  assert.equal(stats.repost, 2);
});

test('feed: preloaded data in the HTML is filtered before Instagram reads it', async () => {
  const html = `<!doctype html><html><body><main></main>
    <script type="application/json" id="boot">${JSON.stringify({ require: [['ScheduledServerJS', 'handle', null, [{ __bbox: { result: mixedFeed() } }]]] })}</script>
    <script>window.__boot = JSON.parse(document.getElementById('boot').textContent);</script></body></html>`;
  const page = await open('https://www.instagram.com/', html);
  const out = await page.evaluate(() => window.__boot.require[0][3][0].__bbox.result);
  assert.deepEqual(codes(out), ['FRIEND1', 'MINE001', 'NOINFO1', 'COLLAB1', 'FRIEND2', 'end_of_feed_demarcator']);
});

test('feed: fetch().json(), XHR text and XHR json responses are all filtered', async () => {
  const page = await open('https://www.instagram.com/', BLANK, { api: { '/graphql/query': mixedFeed() } });
  const results = await page.evaluate(async () => {
    const a = await (await fetch('/graphql/query', { method: 'POST' })).json();
    const b = await new Promise(res => {
      const x = new XMLHttpRequest(); x.open('POST', '/graphql/query');
      x.onload = () => res(JSON.parse(x.responseText)); x.send();
    });
    const c = await new Promise(res => {
      const x = new XMLHttpRequest(); x.open('POST', '/graphql/query'); x.responseType = 'json';
      x.onload = () => res(x.response); x.send();
    });
    return [a, b, c];
  });
  for (const r of results) assert.deepEqual(codes(r), ['FRIEND1', 'MINE001', 'NOINFO1', 'COLLAB1', 'FRIEND2', 'end_of_feed_demarcator']);
});

test('feed: REST feed_items shape is filtered the same way', async () => {
  const page = await open('https://www.instagram.com/', BLANK);
  const out = await page.evaluate(m => JSON.parse(JSON.stringify(m)), {
    feed_items: [
      { media_or_ad: media('FRIEND1', user('friend', true)) },
      { media_or_ad: media('ADPOST1', user('brand'), { ad_id: '9', injected: {} }) },
      { media_or_ad: media('SUGG001', user('x', false)) },
      { suggested_users: { users: [] } },
    ],
    more_available: true, next_max_id: 'n',
  });
  assert.deepEqual(out.feed_items.map(i => i.media_or_ad && i.media_or_ad.code), ['FRIEND1']);
  assert.equal(out.more_available, true);
});

test('feed: unrecognised format is left alone (fails open, never an empty feed)', async () => {
  const page = await open('https://www.instagram.com/', BLANK);
  const payload = timeline([edge({ post_v2: { code: 'A' } }), edge({ post_v2: { code: 'B' } })]);
  const out = await page.evaluate(p => JSON.parse(JSON.stringify(p)), payload);
  assert.equal(out.data.xdt_api__v1__feed__timeline__connection.edges.length, 2);
  assert.equal(await page.evaluate(() => window.__sg.stats.feed.unknownPages), 1);
});

test('feed: streamed (incremental) responses are not reshuffled', async () => {
  const page = await open('https://www.instagram.com/', BLANK);
  const payload = mixedFeed();
  payload.extensions.is_final = false;
  const out = await page.evaluate(p => JSON.parse(JSON.stringify(p)), payload);
  assert.equal(out.data.xdt_api__v1__feed__timeline__connection.edges.length, 12);
});

test('feed: pages that are entirely ads/suggestions stop loading after a few tries', async () => {
  const page = await open('https://www.instagram.com/', BLANK);
  const flags = await page.evaluate(p => {
    const out = [];
    for (let i = 0; i < 5; i++) out.push(JSON.parse(JSON.stringify(p)).data.xdt_api__v1__feed__timeline__connection.page_info.has_next_page);
    return out;
  }, timeline([edge({ media: media('SUGG001', user('s', false)) })]));
  assert.deepEqual(flags, [true, true, true, false, false]);
});

test('reels: a Reels chain keeps only the opened Reel and stops', async () => {
  const page = await open('https://www.instagram.com/reels/WANTED1/', BLANK);
  const out = await page.evaluate(p => JSON.parse(JSON.stringify(p)), {
    data: { xdt_api__v1__clips__home__connection_v2: {
      edges: ['OTHER01', 'WANTED1', 'OTHER02'].map(c => ({ node: { media: media(c, user('u', true)) } })),
      page_info: { has_next_page: true },
    } },
  });
  const conn = out.data.xdt_api__v1__clips__home__connection_v2;
  assert.deepEqual(conn.edges.map(e => e.node.media.code), ['WANTED1']);
  assert.equal(conn.page_info.has_next_page, false);
});

test('reels: a profile\'s own Reels grid is not trimmed', async () => {
  const page = await open('https://www.instagram.com/someone/reels/', BLANK);
  const out = await page.evaluate(p => JSON.parse(JSON.stringify(p)), {
    data: { xdt_api__v1__clips__user__connection_v2: {
      edges: ['R1AAAAA', 'R2AAAAA', 'R3AAAAA'].map(c => ({ node: { media: media(c, user('someone', true)) } })),
      page_info: { has_next_page: true },
    } },
  });
  assert.equal(out.data.xdt_api__v1__clips__user__connection_v2.edges.length, 3);
});

test('explore: the suggestion grid is emptied but search results are kept', async () => {
  const grid = { sectional_items: [{ layout_content: { medias: [{ media: media('EXPL001', user('x')) }] } }], more_available: true };
  let page = await open('https://www.instagram.com/explore/', BLANK);
  let out = await page.evaluate(p => JSON.parse(JSON.stringify(p)), grid);
  assert.equal(out.sectional_items.length, 0);
  assert.equal(out.more_available, false);
  page = await open('https://www.instagram.com/explore/search/keyword/?q=sharks', BLANK);
  out = await page.evaluate(p => JSON.parse(JSON.stringify(p)), grid);
  assert.equal(out.sectional_items.length, 1);
});

test('search: results load a few pages, then stop (no endless scrolling)', async () => {
  const page = await open('https://www.instagram.com/explore/search/keyword/?q=sharks', BLANK);
  const flags = await page.evaluate(m => {
    const out = [];
    for (let i = 0; i < 4; i++) out.push(JSON.parse(JSON.stringify(m)).media_grid.has_more);
    return out;
  }, { media_grid: { sections: [{ layout_content: { medias: [{ media: media('SRCH001', user('u')) }] } }], has_more: true } });
  assert.deepEqual(flags, [true, true, false, false]);
});

test('stories: injected Story ads and ad items in a Story reel are removed', async () => {
  const page = await open('https://www.instagram.com/stories/friend/123/', BLANK);
  const out = await page.evaluate(p => JSON.parse(JSON.stringify(p)), {
    data: {
      xdt_injected_story_units: { ad_media_items: [{ id: 'ad', ad_id: '1', items: [] }] },
      xdt_api__v1__feed__reels_media: { reels_media: [{ id: '55', items: [
        media('STORY01', user('friend', true)), media('STORYAD', user('brand'), { ad_id: '44' }), media('STORY02', user('friend', true)),
      ] }] },
    },
  });
  assert.equal(out.data.xdt_injected_story_units.ad_media_items.length, 0);
  assert.deepEqual(out.data.xdt_api__v1__feed__reels_media.reels_media[0].items.map(i => i.code), ['STORY01', 'STORY02']);
});

test('suggestions: suggested-account lists are emptied, DM recipients are not', async () => {
  const page = await open('https://www.instagram.com/someone/', BLANK);
  const out = await page.evaluate(p => JSON.parse(JSON.stringify(p)), {
    data: {
      xdt_api__v1__discover__chaining: { users: [user('a'), user('b')] },
      xdt_api__v1__direct_v2__ranked_recipients: { ranked_recipients: [{ user: user('friend', true) }, { user: user('mom', true) }] },
    },
  });
  assert.equal(out.data.xdt_api__v1__discover__chaining.users.length, 0);
  assert.equal(out.data.xdt_api__v1__direct_v2__ranked_recipients.ranked_recipients.length, 2);
});

/* ---------------- Interface ---------------- */

const NAV = `<div style="position:fixed;bottom:0;left:0;right:0;height:50px;display:flex" id="nav">
  <div><a href="/">Home</a></div><div><a href="/explore/">Search</a></div><div><a href="/reels/">Reels</a></div>
  <div><a href="/direct/inbox/">DM</a></div><div><a href="/me/">Profile</a></div></div>`;

test('chrome: "Use the app" bar and the Reels tab are hidden; navigation stays', async () => {
  const html = `<!doctype html><html><body><main><a href="/someone/reels/" id="profileReels">Reels</a></main>
    <div style="position:fixed;bottom:50px;left:0;right:0;height:40px" id="banner"><span>Use the app</span><div role="button" aria-label="Close">x</div></div>
    ${NAV}</body></html>`;
  const page = await open('https://www.instagram.com/', html);
  await page.waitForFunction(() => document.getElementById('banner').style.display === 'none');
  const vis = await page.evaluate(() => ({
    nav: getComputedStyle(document.getElementById('nav')).display,
    reels: getComputedStyle(document.querySelector('a[href="/reels/"]')).display,
    reelsItem: getComputedStyle(document.querySelector('a[href="/reels/"]').parentElement).display,
    home: getComputedStyle(document.querySelector('a[href="/"]')).display,
    profileReels: getComputedStyle(document.getElementById('profileReels')).display,
    standalone: matchMedia('(display-mode: standalone)').matches,
  }));
  assert.deepEqual(vis, { nav: 'flex', reels: 'none', reelsItem: 'none', home: 'inline', profileReels: 'inline', standalone: true });
});

function article(code, header, opts = {}) {
  return `<article id="a-${code}" style="display:block">
    <header style="height:56px"><a href="/u/">user</a>${header ? `<div><span>${header}</span></div>` : ''}</header>
    <div class="media" style="width:412px;height:412px;overflow:hidden;position:relative">
      ${opts.video ? `<video id="v-${code}" muted playsinline style="width:412px;height:412px" src="${opts.video}"></video>`
        : `<img id="i-${code}" src="https://scontent.cdninstagram.com/v/t51/${code}_big_n.jpg?stp=640" srcset="https://scontent.cdninstagram.com/v/t51/${code}_big_n.jpg?stp=640 640w, https://scontent.cdninstagram.com/v/t51/${code}_big_n.jpg?stp=1080 1080w" style="width:412px;height:412px">`}
    </div>
    <section><div role="button" class="comment"><svg aria-label="Comment"></svg></div></section>
    <div>${opts.caption || ''}</div>
    <a href="/p/${code}/"><time>1h</time></a>
    <a href="/p/${code}/comments/" class="all">View all 9 comments</a>
  </article>`;
}

test('backup filter: a post labelled Sponsored/Suggested is hidden, captions are not misread', async () => {
  const html = `<!doctype html><html><body><main>
    ${article('FRIEND1', 'Original audio', { caption: '<span>Sponsored</span> by nobody' })}
    ${article('ADPOST1', 'Sponsored')}
    ${article('SUGG001', 'Suggested for you')}
    ${article('FRIEND2', '')}
  </main></body></html>`;
  const page = await open('https://www.instagram.com/', html);
  await page.waitForFunction(() => document.getElementById('a-ADPOST1').style.display === 'none');
  const shown = await page.evaluate(() => Array.from(document.querySelectorAll('article')).filter(a => a.style.display !== 'none').map(a => a.id));
  assert.deepEqual(shown, ['a-FRIEND1', 'a-FRIEND2']);
});

test('comments: tapping the comment button opens the half-screen panel for that post', async () => {
  const html = `<!doctype html><html><body><main>${article('FRIEND1', '')}${article('FRIEND2', '')}</main>
    <script>window.__igClicks=0;document.addEventListener('click',()=>window.__igClicks++);</script></body></html>`;
  const page = await open('https://www.instagram.com/', html);
  await page.evaluate(() => window.scrollTo(0, 500));
  await page.tap('#a-FRIEND2 .comment');
  const [msg] = await waitSent(page, 'comments');
  assert.equal(msg.code, 'FRIEND2');
  assert.equal(msg.url, 'https://www.instagram.com/p/FRIEND2/comments/');
  assert.ok(msg.rect && msg.rect.w > 300 && msg.rect.h > 300, JSON.stringify(msg.rect));
  assert.equal(await page.evaluate(() => window.__igClicks), 0, 'Instagram must not also open its full-page comments');
  // "View all comments" link does the same.
  await page.evaluate(() => { window.__sent.length = 0; });
  await page.tap('#a-FRIEND1 a.all');
  const [msg2] = await waitSent(page, 'comments');
  assert.equal(msg2.code, 'FRIEND1');
  assert.equal(page.url(), 'https://www.instagram.com/');
});

test('downloads: the visible carousel slide downloads at full size', async () => {
  const carousel = media('CAROUS1', user('friend', true), { carousel_media: [0, 1, 2].map(i => ({
    pk: String(900 + i),
    image_versions2: { candidates: [
      { url: `https://scontent.cdninstagram.com/v/t51/slide${i}_n.jpg?stp=1440`, width: 1440, height: 1440 },
      { url: `https://scontent.cdninstagram.com/v/t51/slide${i}_n.jpg?stp=640`, width: 640, height: 640 }] },
    video_versions: i === 2 ? [{ url: 'https://scontent.cdninstagram.com/v/t50/slide2.mp4', width: 720, height: 720 }] : undefined,
  })) });
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body><main><article><header>friend</header>
    <div style="width:412px;height:412px;overflow:hidden;position:relative"><ul style="display:flex;margin:0;padding:0;transform:translateX(-412px)">
      ${[0, 1, 2].map(i => `<li style="flex:0 0 412px;list-style:none"><img src="https://scontent.cdninstagram.com/v/t51/slide${i}_n.jpg?stp=640" style="width:412px;height:412px"></li>`).join('')}
    </ul></div><a href="/p/CAROUS1/"><time>1h</time></a></article></main></body></html>`;
  const page = await open('https://www.instagram.com/', html);
  await page.evaluate(p => JSON.parse(JSON.stringify(p)), timeline([edge({ media: carousel })]));
  await page.evaluate(() => { window.__sg.onNative({ type: 'menu' }); window.__sg.onNative({ type: 'download' }); });
  const [ask] = await waitSent(page, 'downloadAsk');
  assert.equal(ask.current.url, 'https://scontent.cdninstagram.com/v/t51/slide1_n.jpg?stp=1440');
  assert.equal(ask.all.length, 3);
  assert.equal(ask.all[2].kind, 'video');
  assert.match(ask.current.name, /^SimpleGram_friend_CAROUS1_2\.jpg$/);
});

test('downloads: a Story video downloads the Story you were watching', async () => {
  const story = media('STORY01', user('friend', true), { pk: '424242', video_versions: [
    { url: 'https://scontent.cdninstagram.com/v/t50/story-low.mp4', width: 480, height: 854 },
    { url: 'https://scontent.cdninstagram.com/v/t50/story-high.mp4', width: 720, height: 1280 }] });
  const html = `<!doctype html><html><body><section><video src="blob:https://www.instagram.com/x" style="width:412px;height:732px"></video></section></body></html>`;
  const page = await open('https://www.instagram.com/stories/friend/424242/', html);
  await page.evaluate(p => JSON.parse(JSON.stringify(p)), { data: { xdt_api__v1__feed__reels_media: { reels_media: [{ items: [story] }] } } });
  await page.evaluate(() => { window.__sg.onNative({ type: 'menu' }); window.__sg.onNative({ type: 'download' }); });
  const [dl] = await waitSent(page, 'download');
  assert.deepEqual(dl.items.map(i => [i.url, i.kind]), [['https://scontent.cdninstagram.com/v/t50/story-high.mp4', 'video']]);
});

test('downloads: an unindexed post is looked up once through Instagram\'s media info', async () => {
  const info = { items: [media('ABCDEFG', user('friend', true), { video_versions: [{ url: 'https://scontent.cdninstagram.com/v/t50/reel.mp4', width: 720, height: 1280 }] })] };
  const html = `<!doctype html><html><body><video src="blob:https://www.instagram.com/y" style="width:412px;height:732px"></video></body></html>`;
  const page = await open('https://www.instagram.com/reel/ABCDEFG/', html, { api: {} });
  await page.route('**/api/v1/media/*/info/', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(info) }));
  await page.evaluate(() => { window.__sg.onNative({ type: 'menu' }); window.__sg.onNative({ type: 'download' }); });
  const [dl] = await waitSent(page, 'download');
  assert.equal(dl.items[0].url, 'https://scontent.cdninstagram.com/v/t50/reel.mp4');
});

/* ---------------- Reels, sound and screen ---------------- */

const SNAP = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body style="margin:0">
  <div id="viewer" style="height:915px;overflow-y:scroll;scroll-snap-type:y mandatory">
    <div style="height:915px;scroll-snap-align:start"><video id="r1" muted playsinline loop style="width:412px;height:915px"></video>
      <div role="button" id="mute" style="position:absolute;top:20px;right:20px;width:40px;height:40px"><svg aria-label="Audio is muted"></svg></div></div>
    <div style="height:915px;scroll-snap-align:start">next reel</div>
  </div>
  <div id="share" role="dialog" style="position:fixed;top:300px;height:200px;overflow-y:scroll;width:412px"><div style="height:900px">people</div></div>
  <script>document.getElementById('mute').addEventListener('click',()=>{const v=document.getElementById('r1');v.muted=!v.muted;window.__toggled=(window.__toggled||0)+1;});</script>
  </body></html>`;

async function swipe(page, selector, dy) {
  return page.evaluate(([sel, d]) => {
    const el = document.querySelector(sel);
    const mk = (type, y) => {
      const t = new Touch({ identifier: 1, target: el, clientX: 200, clientY: y });
      return new TouchEvent(type, { touches: type === 'touchend' ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true });
    };
    el.dispatchEvent(mk('touchstart', 600));
    const move = mk('touchmove', 600 + d);
    el.dispatchEvent(move);
    el.dispatchEvent(mk('touchend', 600 + d));
    return move.defaultPrevented;
  }, [selector, dy]);
}

test('reels: swiping up in a Reel viewer is blocked; other lists still scroll', async () => {
  const page = await open('https://www.instagram.com/reel/ABCDEFG/', SNAP);
  assert.equal(await swipe(page, '#viewer > div', -300), true);
  assert.equal(await swipe(page, '#share > div', -300), false);
  assert.equal(await page.evaluate(() => window.__sg.stats.swipesBlocked), 1);
});

test('reels: swipes on the home feed are never touched', async () => {
  const page = await open('https://www.instagram.com/', SNAP);
  assert.equal(await swipe(page, '#viewer > div', -300), false);
});

test('sound: an opened Reel plays with sound using Instagram\'s own toggle', async () => {
  const page = await open('https://www.instagram.com/reel/ABCDEFG/', SNAP);
  await page.evaluate(() => {
    const v = document.getElementById('r1');
    v.src = '/clip.webm';
    v.dispatchEvent(new Event('play'));
  });
  await page.waitForFunction(() => window.__toggled === 1);
  assert.equal(await page.evaluate(() => document.getElementById('r1').muted), false);
});

test('sound: your own mute is respected', async () => {
  const page = await open('https://www.instagram.com/reel/ABCDEFG/', SNAP);
  await page.evaluate(() => { document.getElementById('r1').dispatchEvent(new Event('play')); });
  await page.waitForFunction(() => window.__toggled === 1);
  await page.tap('#mute');             // a real tap: you mute it
  await page.waitForTimeout(400);
  await page.evaluate(() => { document.getElementById('r1').dispatchEvent(new Event('play')); });
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => document.getElementById('r1').muted), true);
});

test('sound: home feed videos keep Instagram\'s default (muted until tapped)', async () => {
  const page = await open('https://www.instagram.com/', SNAP);
  await page.evaluate(() => { document.getElementById('r1').dispatchEvent(new Event('play')); });
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => window.__toggled || 0), 0);
});

test('navigation: the endless Reels tab sends you back home', async () => {
  const page = await open('https://www.instagram.com/', BLANK);
  await page.evaluate(() => history.pushState({}, '', '/reels/'));
  await page.waitForURL('https://www.instagram.com/');
  assert.equal(new URL(page.url()).pathname, '/');
});

test('search: going back to results restores your place', async () => {
  const html = `<!doctype html><html><body style="margin:0"><main><div style="height:5000px">results</div></main></body></html>`;
  const page = await open('https://www.instagram.com/explore/search/keyword/?q=sharks', html);
  await page.evaluate(() => window.scrollTo(0, 2200));
  await page.evaluate(() => { history.pushState({}, '', '/p/ABCDEFG/'); window.scrollTo(0, 0); });
  await page.evaluate(() => history.back());
  await page.waitForFunction(() => location.pathname.startsWith('/explore/search'));
  await page.waitForFunction(() => Math.abs(document.scrollingElement.scrollTop - 2200) < 3, null, { timeout: 4000 });
});

test('script: injecting twice is harmless', async () => {
  const page = await open('https://www.instagram.com/', BLANK);
  await page.evaluate(s => { (0, eval)(s); }, SCRIPT);
  const out = await page.evaluate(p => JSON.parse(JSON.stringify(p)), mixedFeed());
  assert.equal(codes(out).length, 6);
  assert.equal(await page.evaluate(() => window.__sg.stats.feed.pages), 1);
});

test('comments child: Instagram navigation bar is hidden and videos stay paused', async () => {
  const html = `<!doctype html><html><body><main>comments</main>${NAV.replace('position:fixed', 'position:fixed')}</body></html>`;
  const page = await open('https://www.instagram.com/p/ABCDEFG/comments/', html, { role: 'comments' });
  await page.waitForFunction(() => document.getElementById('nav').style.display === 'none');
});

test('feed: if no post at all looks followed, keep them (never an empty feed)', async () => {
  const page = await open('https://www.instagram.com/', BLANK);
  const out = await page.evaluate(p => JSON.parse(JSON.stringify(p)), timeline(
    ['AAAAAA1', 'AAAAAA2', 'AAAAAA3', 'AAAAAA4'].map(c => edge({ media: media(c, user('u' + c, false)) }))));
  assert.equal(codes(out).length, 4);
  assert.equal(await page.evaluate(() => window.__sg.stats.feed.followSuspect), 1);
});

test('downloads: a Story highlight video is matched by its picture', async () => {
  const story = media('HILITE1', user('friend', true), { pk: '777', video_versions: [{ url: 'https://scontent.cdninstagram.com/v/t50/hl.mp4', width: 720, height: 1280 }] });
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body><section><div>
    <img src="https://scontent.cdninstagram.com/v/t51/HILITE1_big_n.jpg?stp=640" style="position:absolute;width:412px;height:732px">
    <video src="blob:https://www.instagram.com/z" style="position:absolute;width:412px;height:732px"></video></div></section></body></html>`;
  const page = await open('https://www.instagram.com/stories/highlights/1799999/', html);
  await page.evaluate(p => JSON.parse(JSON.stringify(p)), { data: { xdt_api__v1__feed__reels_media: { reels_media: [{ items: [story] }] } } });
  await page.evaluate(() => { window.__sg.onNative({ type: 'menu' }); window.__sg.onNative({ type: 'download' }); });
  const [dl] = await waitSent(page, 'download');
  assert.equal(dl.items[0].url, 'https://scontent.cdninstagram.com/v/t50/hl.mp4');
});
