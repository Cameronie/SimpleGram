// Shared fixtures and helpers for the SimpleGram browser tests.
//
// Every request is answered locally (nothing reaches Instagram). Payloads are
// modelled on the shapes Instagram's website uses; they are fixtures, not
// captures of a signed-in session. SG_SCRIPT overrides the script under test.
'use strict';
const { before, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const SCRIPT = fs.readFileSync(process.env.SG_SCRIPT || path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'simplegram.js'), 'utf8');
const ME = '1000';
let browser;

// Registers the shared browser for the calling test file.
function useBrowser() {
  before(async () => {
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || undefined,
      args: ['--autoplay-policy=no-user-gesture-required'],
    });
  });
  after(async () => { await browser.close(); });
}

/** Opens `url` (served from `html`) with the page script injected like the app does. */
async function open(url, html, { role = 'main', api = {} } = {}) {
  const context = await browser.newContext({
    viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true,
  });
  const page = await context.newPage();
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    const hit = api[u.pathname];
    if (hit !== undefined) {
      const r = typeof hit === 'function' ? hit(u, route.request()) : { body: hit };
      return route.fulfill({ status: r.status || 200, contentType: 'application/json', body: typeof r.body === 'string' ? r.body : JSON.stringify(r.body) });
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

const NAV = `<div style="position:fixed;bottom:0;left:0;right:0;height:50px;display:flex" id="nav">
  <div><a href="/">Home</a></div><div><a href="/explore/">Search</a></div><div><a href="/reels/">Reels</a></div>
  <div><a href="/direct/inbox/">DM</a></div><div><a href="/me/">Profile</a></div></div>`;

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

function grid(codesList) {
  return { sections: [{ layout_type: 'media_grid', layout_content: { medias: codesList.map(c => ({ media: media(c, user('u' + c, true)) })) } }], more_available: true, next_max_id: 'm1', next_page: 1 };
}

const NAVPAGE = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Instagram</title></head><body style="margin:0"><main>home</main>
  <div style="position:fixed;bottom:0;left:0;right:0;height:50px;display:flex" id="nav"><div><a href="/" style="display:block;width:60px;height:50px">Home</a></div><div><a id="searchlink" href="/explore/" style="display:block;width:60px;height:50px">Search</a></div><div><a href="/direct/inbox/" style="display:block;width:60px;height:50px">DM</a></div></div></body></html>`;
async function openSearchTab(page) {
  await page.tap('#searchlink');
  await page.waitForFunction(() => {
    const h = document.getElementById('sg-search');
    return h && h.style.display !== 'none' && h.shadowRoot.activeElement && h.shadowRoot.activeElement.tagName === 'INPUT';
  });
}
async function searchText(page) {
  return page.evaluate(() => { const h = document.getElementById('sg-search'); return h && h.style.display !== 'none' ? h.shadowRoot.textContent : null; });
}
async function shadowClick(page, text) {
  await page.evaluate(t => {
    const root = document.getElementById('sg-search').shadowRoot;
    const buttons = Array.from(root.querySelectorAll('button'));
    const b = buttons.find(x => x.textContent.trim() === t) || buttons.find(x => x.textContent.includes(t));
    if (!b) throw new Error('no button ' + t);
    b.click();
  }, text);
}

module.exports = { SCRIPT, ME, useBrowser, open, sent, waitSent, PNG, BLANK, user, media, edge, timeline, codes, mixedFeed, NAV, article, SNAP, swipe, grid, NAVPAGE, openSearchTab, searchText, shadowClick };
