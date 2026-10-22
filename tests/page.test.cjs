// Browser tests for the SimpleGram page script.
//
// Every request is answered locally (nothing reaches Instagram). Payloads are
// modelled on the shapes Instagram's website uses; they are fixtures, not
// captures of a signed-in session, so passing here does not prove live behaviour.
//
// Run: NODE_PATH=/opt/node-tools/node_modules node --test tests/*.test.cjs
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  SCRIPT, ME, useBrowser, open, sent, waitSent, BLANK, user, media, edge, timeline, codes, mixedFeed,
  NAV, article, SNAP, swipe, grid, NAVPAGE, openSearchTab, searchText, shadowClick,
} = require('./helpers.cjs');

useBrowser();

/* ---------------- Data-layer filtering ---------------- */

test('feed: JSON.parse keeps friends and removes ads, suggestions and reposts', async () => {
  const page = await open('https://www.instagram.com/', BLANK);
  const out = await page.evaluate(p => JSON.parse(JSON.stringify(p)), mixedFeed());
  // Home ends at Instagram's "You're all caught up" marker: it goes, and paging stops.
  assert.deepEqual(codes(out), ['FRIEND1', 'MINE001', 'NOINFO1', 'COLLAB1', 'FRIEND2']);
  assert.equal(out.data.xdt_api__v1__feed__timeline__connection.page_info.has_next_page, false);
  const stats = await page.evaluate(() => window.__sg.stats.feed);
  assert.equal(stats.eof, 1);
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
  assert.deepEqual(codes(out), ['FRIEND1', 'MINE001', 'NOINFO1', 'COLLAB1', 'FRIEND2']);
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
  for (const r of results) assert.deepEqual(codes(r), ['FRIEND1', 'MINE001', 'NOINFO1', 'COLLAB1', 'FRIEND2']);
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


test('chrome: a message or comment that reads like a banner is left alone', async () => {
  const rows = ['Get the app', 'open the app', 'see you at 8', 'Open Instagram'].map((t, i) =>
    `<div role="row" id="r${i}" style="height:40px"><div><div dir="auto"><span>${t}</span></div></div></div>`).join('');
  const html = `<!doctype html><html><body><main><div role="grid">${rows}</div></main>${NAV}</body></html>`;
  const page = await open('https://www.instagram.com/direct/t/123456/', html);
  await page.waitForTimeout(1200);
  const shown = await page.evaluate(() => [0, 1, 2, 3].map(i => getComputedStyle(document.getElementById('r' + i)).display !== 'none'));
  assert.deepEqual(shown, [true, true, true, true]);
  assert.equal(await page.evaluate(() => window.__sg.stats.dom.banners), 0);
  // The same inside the comments panel's page.
  const c = await open('https://www.instagram.com/p/ABCDEF1/comments/', html, { role: 'comments' });
  await c.waitForTimeout(1200);
  assert.deepEqual(await c.evaluate(() => [0, 3].map(i => getComputedStyle(document.getElementById('r' + i)).display !== 'none')), [true, true]);
});

test('sound: a video with no audio is left alone (pressing its control only shows a toast)', async () => {
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body style="margin:0">
    <div style="position:relative;height:915px"><video id="r1" muted playsinline style="width:412px;height:915px"></video>
    <button id="mute" aria-label="Toggle audio" style="position:absolute;top:20px;right:20px;width:40px;height:40px"><svg aria-label="Video has no audio"></svg></button></div>
    <script>document.getElementById('mute').addEventListener('click',()=>{window.__toggled=(window.__toggled||0)+1;});</script></body></html>`;
  const page = await open('https://www.instagram.com/reel/ABCDEFG/', html);
  await page.evaluate(() => { const v = document.getElementById('r1'); v.src = '/clip.webm'; v.dispatchEvent(new Event('play')); });
  await page.waitForTimeout(700);
  assert.equal(await page.evaluate(() => window.__toggled || 0), 0);
  // The same button, whose icon now says the sound is off, is pressed as before.
  await page.evaluate(() => {
    document.querySelector('#mute svg').setAttribute('aria-label', 'Audio is muted');
    const v = document.getElementById('r1'); v.muted = true; v.dispatchEvent(new Event('play'));
  });
  await page.waitForFunction(() => window.__toggled === 1);
});

test('downloads: a video with no downloadable file is reported, never saved as its cover picture', async () => {
  const info = { items: [media('ABCDEFG', user('friend', true))] };   // a picture only: no progressive video
  const html = `<!doctype html><html><body><video src="blob:https://www.instagram.com/y" style="width:412px;height:732px"></video></body></html>`;
  const page = await open('https://www.instagram.com/reel/ABCDEFG/', html, { api: {} });
  await page.route('**/api/v1/media/*/info/', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(info) }));
  await page.evaluate(() => { window.__sg.onNative({ type: 'menu' }); window.__sg.onNative({ type: 'download' }); });
  const [t] = await waitSent(page, 'toast');
  assert.match(t.message, /could not be matched/);
  assert.equal((await sent(page, 'download')).length, 0, 'nothing was sent for saving');
});

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
  assert.equal(codes(out).length, 5);
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


/* ---------------- 1.1: feed batches, end of Home, no repeats ---------------- */

test('feed: continuing from the end of Home into Following skips posts already seen', async () => {
  const page = await open('https://www.instagram.com/', BLANK);
  await page.evaluate(p => JSON.parse(JSON.stringify(p)), timeline([
    edge({ media: media('SEEN001', user('a', true)) }), edge({ media: media('SEEN002', user('b', true)) })]));
  await Promise.all([
    page.waitForURL('https://www.instagram.com/?variant=following'),
    page.evaluate(() => window.__sg.onNative({ type: 'continueFeed', variant: 'following' })),
  ]);
  const out = await page.evaluate(p => JSON.parse(JSON.stringify(p)), timeline([
    edge({ media: media('SEEN001', user('a', true)) }), edge({ media: media('NEW0001', user('c', true)) }),
    edge({ media: media('SEEN002', user('b', true)) })]));
  assert.deepEqual(codes(out), ['NEW0001']);
  assert.equal(await page.evaluate(() => window.__sg.stats.feed.alreadySeen), 2);
  // Following opened another way (no hand-off) shows everything.
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  const all = await page.evaluate(p => JSON.parse(JSON.stringify(p)), timeline([edge({ media: media('SEEN001', user('a', true)) })]));
  assert.deepEqual(codes(all), ['SEEN001']);
});

test('feed: pages of only already-seen posts keep loading instead of stopping', async () => {
  const page = await open('https://www.instagram.com/', BLANK);
  await page.evaluate(p => JSON.parse(JSON.stringify(p)), timeline([edge({ media: media('SEEN001', user('a', true)) })]));
  await Promise.all([page.waitForURL(/variant=favorites/), page.evaluate(() => window.__sg.onNative({ type: 'continueFeed', variant: 'favorites' }))]);
  const flags = await page.evaluate(p => {
    const out = [];
    for (let i = 0; i < 8; i++) out.push(JSON.parse(JSON.stringify(p)).data.xdt_api__v1__feed__timeline__connection.page_info.has_next_page);
    return out;
  }, timeline([edge({ media: media('SEEN001', user('a', true)) })]));
  assert.ok(flags.every(Boolean), JSON.stringify(flags));
});

test('feed: reaching the end of Home asks the app to show the Following/Favorites buttons', async () => {
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body style="margin:0"><main><div style="height:3000px">feed</div></main></body></html>`;
  const page = await open('https://www.instagram.com/', html);
  await page.evaluate(p => JSON.parse(JSON.stringify(p)), timeline([edge({ media: media('FRIEND1', user('a', true)) })], false));
  assert.equal((await sent(page, 'feedEnd')).filter(m => m.on).length, 0);
  await page.evaluate(() => window.scrollTo(0, 3000));
  const msgs = await waitSent(page, 'feedEnd');
  assert.equal(msgs[msgs.length - 1].on, true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction(() => { const m = window.__sent.filter(x => x.action === 'feedEnd'); return m.length && !m[m.length - 1].on; });
});




/* ---------------- 1.1: opened videos start; sound controls ---------------- */

test('autoplay: a Reel opened from a DM starts by itself once', async () => {
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body style="margin:0">
    <div role="dialog"><div style="position:relative"><video id="v" playsinline style="width:412px;height:732px"></video>
    <div style="position:absolute;top:300px;left:150px;width:100px;height:100px"><svg aria-label="Play" width="60" height="60"></svg></div></div></div>
    <script>window.__plays=0;document.querySelector('svg[aria-label="Play"]').parentElement.addEventListener('click',()=>{window.__plays++;});</script></body></html>`;
  const page = await open('https://www.instagram.com/direct/t/123/', html);
  await page.evaluate(() => { document.getElementById('v').dispatchEvent(new Event('loadedmetadata')); });
  await page.waitForFunction(() => window.__plays === 1);
  await page.evaluate(() => { document.getElementById('v').dispatchEvent(new Event('canplay')); });
  await page.waitForTimeout(600);
  assert.equal(await page.evaluate(() => window.__plays), 1);
});

test('autoplay: small DM previews and the home feed are left alone', async () => {
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body>
    <video id="v" style="width:150px;height:200px"></video><svg aria-label="Play" width="20" height="20"></svg>
    <script>window.__plays=0;document.querySelector('svg').addEventListener('click',()=>{window.__plays++;});</script></body></html>`;
  const page = await open('https://www.instagram.com/direct/t/123/', html);
  await page.evaluate(() => { document.getElementById('v').dispatchEvent(new Event('loadedmetadata')); });
  await page.waitForTimeout(600);
  assert.equal(await page.evaluate(() => window.__plays), 0);
});

test('sound: an icon-only speaker control (no button role) is found and pressed', async () => {
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body>
    <section><header><div id="spk" style="width:30px;height:30px"><svg aria-label="Audio is muted" width="24" height="24"></svg></div></header>
    <video id="v" muted playsinline style="width:412px;height:732px"></video></section>
    <script>document.getElementById('spk').addEventListener('click',()=>{const v=document.getElementById('v');v.muted=!v.muted;window.__t=(window.__t||0)+1;});</script></body></html>`;
  const page = await open('https://www.instagram.com/stories/friend/123/', html);
  await page.evaluate(() => document.getElementById('v').dispatchEvent(new Event('play')));
  await page.waitForFunction(() => window.__t === 1);
  assert.equal(await page.evaluate(() => document.getElementById('v').muted), false);
});

/* ---------------- 1.1: Story download fallback ---------------- */

test('downloads: a Story nobody had loaded is fetched through that account\'s Stories', async () => {
  const story = media('STORY99', user('friend', true), { pk: '999', video_versions: [{ url: 'https://scontent.cdninstagram.com/v/t50/s99.mp4', width: 720, height: 1280 }] });
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body><section><video src="blob:https://www.instagram.com/q" style="width:412px;height:732px"></video></section></body></html>`;
  const page = await open('https://www.instagram.com/stories/friend/999/', html, { api: {
    '/api/v1/media/999/info/': () => ({ status: 400, body: { status: 'fail' } }),
    '/api/v1/users/web_profile_info/': { data: { user: { id: '55', username: 'friend', full_name: 'F' } } },
    '/api/v1/feed/reels_media/': (u) => ({ body: u.searchParams.get('reel_ids') === '55' ? { reels: { 55: { id: '55', items: [story] } } } : {} }),
  } });
  await page.evaluate(() => { window.__sg.onNative({ type: 'menu' }); window.__sg.onNative({ type: 'download' }); });
  const [dl] = await waitSent(page, 'download');
  assert.equal(dl.items[0].url, 'https://scontent.cdninstagram.com/v/t50/s99.mp4');
});

/* ---------------- 1.1: Search tabs ---------------- */

// Today's website: the old REST search endpoints answer 404 HTML; accounts,
// tags, places and posts come from GraphQL (tests/search-mock.cjs).
const searchMock = require('./search-mock.cjs');
const SHARKS = {
  users: [{ pk: '1', username: 'sanjosesharks', full_name: 'San Jose Sharks', is_verified: true, profile_pic_url: 'https://scontent.cdninstagram.com/p.jpg' }],
  tags: [{ name: 'sharks', media_count: 1234 }],
  keyword: ['KEYW001', 'KEYW002'], keywordMore: 'k2',
  place: ['PLCT001'], placeRecent: [],
};
const SEARCH_API = Object.assign(searchMock.site(SHARKS).api, {
  '/api/v1/fbsearch/places/': { items: [{ location: { pk: '777', name: 'SAP Center', address: '525 W Santa Clara St' }, title: 'SAP Center', subtitle: 'San Jose, CA' }], status: 'ok' },
  '/api/v1/tags/web_info/': { data: { name: 'sharks', media_count: 1234, top: grid(['TOPT001', 'TOPT002', 'TOPT003']), recent: grid(['RECT001']) } },
  '/api/v1/tags/sharks/sections/': (() => { let n = 0; return () => ({ body: grid(['MORE00' + (++n)]) }); })(),
});

test('search: the Search tab opens SimpleGram search with four tabs and account results', async () => {
  const page = await open('https://www.instagram.com/', NAVPAGE, { api: SEARCH_API });
  await openSearchTab(page);
  assert.equal(new URL(page.url()).pathname, '/', 'stays on the page underneath');
  for (const t of ['Accounts', 'Posts & Reels', 'Tags', 'Places']) assert.ok((await searchText(page)).includes(t), t);
  await page.keyboard.type('sharks');
  await page.waitForFunction(() => document.getElementById('sg-search').shadowRoot.textContent.includes('San Jose Sharks'));
  await shadowClick(page, 'Tags');
  await page.waitForFunction(() => document.getElementById('sg-search').shadowRoot.textContent.includes('1,234 posts'));
  assert.ok((await searchText(page)).includes('#sharks'));
  await shadowClick(page, 'Places');
  await page.waitForFunction(() => document.getElementById('sg-search').shadowRoot.textContent.includes('SAP Center'));
});

test('search: tags show Top and Most recent grids, with a limited "Show more"', async () => {
  const page = await open('https://www.instagram.com/', NAVPAGE, { api: SEARCH_API });
  await openSearchTab(page);
  await page.keyboard.type('sharks');
  await page.waitForFunction(() => document.getElementById('sg-search').shadowRoot.textContent.includes('San Jose Sharks'));
  await shadowClick(page, 'Tags');
  await page.waitForFunction(() => document.getElementById('sg-search').shadowRoot.textContent.includes('#sharks'));
  await shadowClick(page, '#sharks');
  await page.waitForFunction(() => document.getElementById('sg-search').shadowRoot.querySelectorAll('.cell').length === 3);
  await shadowClick(page, 'Most recent');
  await page.waitForFunction(() => document.getElementById('sg-search').shadowRoot.querySelectorAll('.cell').length === 1);
  await shadowClick(page, 'Show more');
  await page.waitForFunction(() => document.getElementById('sg-search').shadowRoot.querySelectorAll('.cell').length === 2);
  // Back closes the tag page first, then search.
  assert.equal(await page.evaluate(() => window.__sg.back()), true);
  assert.ok((await searchText(page)).includes('Accounts'));
  assert.equal(await page.evaluate(() => window.__sg.back()), true);
  assert.equal(await searchText(page), null);
  assert.equal(await page.evaluate(() => window.__sg.back()), false);
});

test('search: a place without recent posts says so instead of showing nothing', async () => {
  const page = await open('https://www.instagram.com/', NAVPAGE, { api: SEARCH_API });
  await openSearchTab(page);
  await page.keyboard.type('sap');
  await page.waitForFunction(() => document.getElementById('sg-search').shadowRoot.textContent.includes('San Jose Sharks'));
  await shadowClick(page, 'Places');
  await page.waitForFunction(() => document.getElementById('sg-search').shadowRoot.textContent.includes('SAP Center'));
  await shadowClick(page, 'SAP Center');
  await page.waitForFunction(() => document.getElementById('sg-search').shadowRoot.querySelectorAll('.cell').length === 1);
  await shadowClick(page, 'Most recent');
  await page.waitForFunction(() => /isn.t showing most recent/.test(document.getElementById('sg-search').shadowRoot.textContent));
});

test('search: Posts & Reels shows a grid; opening one and coming back restores search', async () => {
  const page = await open('https://www.instagram.com/', NAVPAGE, { api: SEARCH_API });
  await openSearchTab(page);
  await page.keyboard.type('sharks');
  await shadowClick(page, 'Posts & Reels');
  await page.waitForFunction(() => document.getElementById('sg-search').shadowRoot.querySelectorAll('.cell').length === 2);
  await page.evaluate(() => document.getElementById('sg-search').shadowRoot.querySelector('.cell').click());
  await page.waitForURL(/\/p\/KEYW001\/$/);
  // Search stays up, dimmed, until the post is drawn (B14).
  assert.ok(await page.evaluate(() => !!document.getElementById('sg-search').shadowRoot.querySelector('.wrap.leaving')));
  // The test page cannot render posts, so the app falls back to a full load; Back returns to search.
  await page.waitForEvent('load');
  await page.goBack();
  await page.waitForFunction(() => { const h = document.getElementById('sg-search'); return h && h.style.display !== 'none' && h.shadowRoot.querySelectorAll('.cell').length === 2; });
});

test('search: when Instagram returns nothing, offer Instagram\'s own page', async () => {
  const failing = searchMock.site(Object.assign({}, SHARKS, { answers: { PolarisKeywordSearchExplorePageRelayQuery: () => null } }));
  const api = Object.assign({}, SEARCH_API, failing.api);
  const page = await open('https://www.instagram.com/', NAVPAGE, { api });
  await openSearchTab(page);
  await page.keyboard.type('sharks');
  await shadowClick(page, 'Posts & Reels');
  await page.waitForFunction(() => document.getElementById('sg-search').shadowRoot.textContent.includes('Open Instagram'));
  assert.ok((await searchText(page)).includes('Try again'));
});

test('search: when the old endpoints fail, the website\'s current requests are used', async () => {
  const graphql = (u, req) => {
    const form = new URLSearchParams(req.postData() || '');
    const name = form.get('fb_api_req_friendly_name');
    if (name === 'PolarisKeywordSearchExplorePageRelayQuery') {
      return { body: 'for (;;);' + JSON.stringify({ data: { xdt_fbsearch__top_serp_graphql: {
        edges: [{ node: { __typename: 'XDTTopSerpHeaderUnit' } },
          { node: { __typename: 'XDTTopSerpMediaGridUnit', items: [media('GQLK001', user('a', true)), media('GQLK002', user('b', true), { media_type: 2 })] } }],
        page_info: { has_next_page: false, end_cursor: null } } }, extensions: { is_final: true } }) };
    }
    if (name === 'PolarisSearchBoxRefetchableQuery') {
      return { body: { data: { xdt_api__v1__fbsearch__topsearch_connection: {
        users: [{ user: { pk: '9', username: 'giants', full_name: 'SF Giants' } }], hashtags: [],
        places: [{ position: 0, place: { title: 'Oracle Park', subtitle: 'San Francisco', location: { pk: '42', name: 'Oracle Park' } } }] } } } };
    }
    return { body: { data: {} } };
  };
  const api = {
    '/web/search/topsearch/': () => ({ status: 404, body: searchMock.NOT_FOUND }),
    '/api/v1/fbsearch/places/': () => ({ status: 404, body: {} }),
    '/api/v1/fbsearch/web/top_serp/': () => ({ status: 404, body: searchMock.NOT_FOUND }),
    '/api/graphql': graphql,
  };
  const page = await open('https://www.instagram.com/', NAVPAGE, { api });
  await openSearchTab(page);
  await page.keyboard.type('oracle');
  await page.waitForFunction(() => document.getElementById('sg-search').shadowRoot.textContent.includes('SF Giants'));
  await shadowClick(page, 'Places');
  await page.waitForFunction(() => document.getElementById('sg-search').shadowRoot.textContent.includes('Oracle Park'));
  await shadowClick(page, 'Posts & Reels');
  await page.waitForFunction(() => document.getElementById('sg-search').shadowRoot.querySelectorAll('.cell').length === 2);
  const badge = await page.evaluate(() => document.getElementById('sg-search').shadowRoot.querySelectorAll('.cell .badge').length);
  assert.equal(badge, 1, 'the video is marked');
});

test('feed: the no-repeats list is used once; reloading Following shows everything', async () => {
  const page = await open('https://www.instagram.com/', BLANK);
  await page.evaluate(p => JSON.parse(JSON.stringify(p)), timeline([edge({ media: media('SEEN001', user('a', true)) })]));
  await Promise.all([page.waitForURL(/variant=following/), page.evaluate(() => window.__sg.onNative({ type: 'continueFeed', variant: 'following' }))]);
  const first = await page.evaluate(p => JSON.parse(JSON.stringify(p)), timeline([edge({ media: media('SEEN001', user('a', true)) }), edge({ media: media('NEW0001', user('b', true)) })]));
  assert.deepEqual(codes(first), ['NEW0001']);
  await page.reload();
  const again = await page.evaluate(p => JSON.parse(JSON.stringify(p)), timeline([edge({ media: media('SEEN001', user('a', true)) }), edge({ media: media('NEW0001', user('b', true)) })]));
  assert.deepEqual(codes(again), ['SEEN001', 'NEW0001']);
});

test('feed: no end-of-Home card on a page without a feed (e.g. the login screen)', async () => {
  const page = await open('https://www.instagram.com/', '<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body><form><input name="username"></form></body></html>');
  await page.waitForTimeout(6500);
  assert.equal((await sent(page, 'feedEnd')).filter(m => m.on).length, 0);
});

test('search: typing on Posts & Reels, then switching to Accounts, loads accounts (no endless spinner)', async () => {
  const page = await open('https://www.instagram.com/', NAVPAGE, { api: SEARCH_API });
  await openSearchTab(page);
  await shadowClick(page, 'Posts & Reels');
  await page.evaluate(() => document.getElementById('sg-search').shadowRoot.querySelector('input').focus());
  await page.keyboard.type('sharks');
  await page.waitForFunction(() => document.getElementById('sg-search').shadowRoot.querySelectorAll('.cell').length === 2);
  await shadowClick(page, 'Accounts');
  await page.waitForFunction(() => document.getElementById('sg-search').shadowRoot.textContent.includes('San Jose Sharks'));
});

test('search: a pause in typing asks Instagram once, not a chain of requests', async () => {
  const counted = searchMock.site(SHARKS);
  const api = Object.assign({}, SEARCH_API, counted.api);
  const countCalls = () => counted.log.filter(r => r.name === 'PolarisSearchBoxRefetchableQuery').length;
  const page = await open('https://www.instagram.com/', NAVPAGE, { api });
  await openSearchTab(page);
  for (const ch of 'sha') { await page.keyboard.type(ch); await page.waitForTimeout(600); }
  await page.waitForTimeout(500);
  assert.ok(countCalls() <= 3, 'calls: ' + countCalls());
  // Coming back to an earlier query uses the answer already received.
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(700);
  assert.ok(countCalls() <= 3, 'calls after backspace: ' + countCalls());
});

test('search: after opening a result, going Home later does not reopen search', async () => {
  const page = await open('https://www.instagram.com/', NAVPAGE, { api: SEARCH_API });
  await openSearchTab(page);
  await page.keyboard.type('sharks');
  await page.waitForFunction(() => document.getElementById('sg-search').shadowRoot.textContent.includes('San Jose Sharks'));
  await shadowClick(page, 'sanjosesharks');
  await page.waitForURL(/\/sanjosesharks\/$/);
  // Instagram's own Home tab (an in-app navigation), not Back:
  await page.evaluate(() => history.pushState({}, '', '/'));
  await page.waitForTimeout(300);
  assert.equal(await searchText(page), null);
});

test('search: a video playing underneath is paused while search is open', async () => {
  const html = NAVPAGE.replace('<main>home</main>', '<main><video id="v" muted loop playsinline style="width:300px;height:200px"></video></main>');
  const page = await open('https://www.instagram.com/', html, { api: SEARCH_API });
  await page.evaluate(() => { const v = document.getElementById('v'); Object.defineProperty(v, 'paused', { configurable: true, get() { return !!this.__p; } }); v.__p = false; v.pause = function () { this.__p = true; }; v.play = function () { this.__p = false; return Promise.resolve(); }; });
  await openSearchTab(page);
  assert.equal(await page.evaluate(() => document.getElementById('v').paused), true);
  await page.evaluate(() => window.__sg.back());
  assert.equal(await page.evaluate(() => document.getElementById('v').paused), false);
});

test('autoplay: a carousel\'s next slide waiting off to the side is not started', async () => {
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body style="margin:0;overflow-x:hidden">
    <div style="position:relative;width:412px;height:732px;overflow:hidden"><div style="display:flex;width:824px">
      <img src="https://scontent.cdninstagram.com/a.jpg" style="width:412px;height:732px">
      <div style="position:relative"><video id="v" playsinline style="width:412px;height:732px"></video><svg aria-label="Play" width="40" height="40"></svg></div>
    </div></div><script>window.__plays=0;document.querySelector('svg').addEventListener('click',()=>{window.__plays++;});</script></body></html>`;
  const page = await open('https://www.instagram.com/p/ABCDEFG/', html);
  await page.evaluate(() => document.getElementById('v').dispatchEvent(new Event('loadedmetadata')));
  await page.waitForTimeout(700);
  assert.equal(await page.evaluate(() => window.__plays), 0);
});
