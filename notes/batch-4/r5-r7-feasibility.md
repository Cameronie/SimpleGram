# R5-R7 feasibility (Favorites star, Following-only end, seamless continuation)

Investigator designs and skeptical reviews. Scratchpad paths refer to prototypes from the session; they are not kept.


# R5-R6: feasible = yes

## Recommendation

Build R5 as SimpleGram's own star element placed in Instagram's bottom-bar row, straight after Home's item. Instagram's items are not moved or changed. The row is `display:flex; justify-content:space-evenly`, so with Reels hidden the star lands exactly where a fifth item would.

How it behaves:
- **Placement:** the star goes in during the same mutation microtask in which React commits the bar, from an observer started at document start. The bar is never painted without the star, so nothing shifts on screen.
- **Server-drawn bar:** if the bar row has no `__reactFiber$` key yet (a server-drawn bar React hasn't taken over), the star waits until it has one.
- **Tapping the star:** SimpleGram's existing window-capture click listener takes the tap. Instagram never sees it, and Favorites opens as a full page load (`location.assign('/?variant=favorites')`), with no skip list. A full load avoids B18's in-page carry-over: the stored, already-filtered feed and the empty-feed screen.
- **Already on Favorites:** a tap first scrolls to the top. A tap at the top reloads Favorites (`location.replace`).
- **Instagram's Home tab on Following or Favorites:** it also becomes a full load of `/`, so Instagram's in-page feed switch never happens.
- **Selected state:** on Favorites the star is drawn filled. Instagram still marks Home as current, so a CSS-only rule draws Home's outline there; React's DOM is not touched.

R6: the end card offers only Following. The Favorites button is removed, and `continueFeed` accepts only `following`. If R7 makes Home continue by itself, the card stays only for the "Home isn't loading more" case.

Keep the menu's "Favorites feed" entry as a fallback, and leave screenshot mode unchanged (details under design).

All of this is prototyped and tested:
- Prototype: /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf5/r5r6/r5r6-prototype.diff
- Native change: /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf5/r5r6/r6-native.diff

The test bar is rebuilt in React 19 from Instagram's real b314 modules and laid out by Instagram's real CSS.

## Design

HOW INSTAGRAM BUILDS THE BAR (from the bundles, logged in, phone)
- **Which component:** b314 PolarisPageLayoutHandler renders `IGDSBox position=fixed bottom`, which holds:
  - `PolarisNavigation.react` when gkx 4150 is on;
  - otherwise `PolarisMobileNav.react`, which returns null for logged-in users.
  - So a logged-in phone gets PolarisNavigation, with navigationPosition='bottom' when usePolarisIsSmallScreen (max-width 767px).
- **Bar layers:**
  - an outer wrapper div (height `--revamp-nav-bottom-toolbar-height`, 50px);
  - an animated div (`mobileNavItemWrapper`: background `--ig-primary-background`, 1px top border `--ig-elevated-separator`);
  - **the row**, from PolarisNavigationIcons(bottomNavigation): `div.x78zum5.xaw8158.xh8yej3[data-visualcompletion=ignore-dynamic]`, i.e. `display:flex; justify-content:space-evenly; width:100%`.
- **Row children:** keyed plain `<div>` slots:
  - `feed` (PolarisFeedNavItem, a[href="/"])
  - `explore` (a[href="/explore/"], IGDSSearchPano icon)
  - `reels` (a[href="/reels/"])
  - optional `desktop-creation`
  - `direct`: href is `/direct/inbox/`, or `DIRECT_THREADS + threadKey` when there is a recent chat tab
  - `profile`
- **Each item:** PolarisNavigationItem renders `div.x1n2onr6 > a(BaseLink, role=link) > container`.
  - Container on a phone: `display:flex`, `justify-content:center`, margin 0, padding 12px, border-radius 8px. That is a 48x48 box.
  - Inside it: an icon box (24x24) with `aria-selected={isActive}`, holding the svg.
  - The label is `display:none` below 1264px.
- **Pressed state:** scale(97%).
- **Icons:** IGDSSVGIconBase draws `fill=currentColor` with color `rgb(var(--ig-primary-text))`. Instagram's theme code switches `_aa4c` (light, 0,0,0) and `_aa4d` (dark, 245,245,245) on `<html>`.
  - Active Home = filled shape; inactive Home = outline shape (Prism 24dp).
  - Search and Direct are 2px strokes with round joins.
- **Active state:** Home is active whenever entity_type is 'feed', so it stays filled on Following and Favorites.
- **Today's Reels hiding:** SimpleGram's CSS hides a[href="/reels/"], and tidyReelsTab hides the reels slot (`data-sg-hidden`). space-evenly then spreads 4 items, which is the "lots of space".
- **One bar per page root:** PolarisShell, and with it the bar, is rendered per page root (PolarisFeedRoot, withPolarisShell, …). Bars are recreated on route remounts, and a kept-alive route can leave a hidden second bar in the DOM.

DESIGN (all in app/src/main/assets/simplegram.js unless noted; prototype = the diff above)

1. **Star markup (`starNode`):**
   ```html
   <div data-sg-fav><div><a href="/?variant=favorites" role="link" aria-label="Favorites"><div class="sg-fav-box">
     <svg class="sg-off" aria-hidden="true" …>…</svg>
     <svg class="sg-on" aria-hidden="true" …>…</svg>
   </div></a></div></div>
   ```
   - Outline: Instagram's IGDSStarPanoFilledIcon path, scaled 0.909 about the centre, `stroke=currentColor`, `stroke-width 2.2` (2px effective), `linejoin round`. That matches Search and Direct, and the outer edge sits at 1..23 like Home.
   - Filled: the same path with `fill=currentColor`.
   - CSS added in addStyle (`FAV_CSS`):
     - `.sg-fav-box`: inline-flex, padding 12px, radius 8px, `:active` scale(.97).
     - svg 24x24.
     - color `rgb(var(--ig-primary-text))`, which gives light and dark for free.
     - `.sg-on` / `.sg-off` toggled by `html[data-sg-feed="favorites"]`.
   - Own markup, not a clone of Home: a clone would carry `href="/"` (which B16's homeTap and NAV_SELECTOR would mistake for Home), `aria-selected`, and transient press classes.

2. **`homeItem(a)`:** climbs from an a[href="/"] to the row child.
   - Row = an ancestor with at least 4 element children that contains `a[href^="/direct/"]` or `a[href="/explore/"]`.
   - `bottomRow(row)`: the row's computed `display:flex` + `flex-direction:row`, and its nearest fixed ancestor has bottom ≈ 0 (or is hidden with top below half the screen).
   - This excludes the wide-screen side bar (not a flex row) and a fixed top header. It works on hidden bars, so a kept-alive bar gets its star before it is revealed.

3. **`placeStars(records)`:**
   - Gets its own `MutationObserver` on `document`, started at script start (document start), role main only.
   - Also runs as a backstop in tidyNow, plus a resize → queueTidy for rotation into the side bar.
   - Quick path in the observer: act only when an added node contains a[href="/"]; if the star is already right after Home, skip.
   - For each bar row, in order:
     - (a) wait (retry via queueTidy in 400 ms) unless `Object.keys(row)` has a `__reactFiber$` key (hydration guard);
     - (b) if not a bottom row, remove the star;
     - (c) if Instagram itself shows an `a[href*="variant=favorites"]` in the row, remove the star and step aside;
     - (d) otherwise insert the star (or move it back) with `row.insertBefore(star, homeItem.nextSibling)`. In the same microtask, call `addStyle()` and `markFeed()`, and hide the row's Reels slot with the existing `hide(…,'reels-tab')`. Doing it here, rather than in the 300 ms tidy, removes the shift the bar has today.
   - Instagram's DOM is otherwise untouched. React only inserts or removes its own fibers' nodes relative to its own host siblings, so an extra sibling is safe. A remount or recreated row arrives as added nodes and gets a new star synchronously.
   - Measured cost: about 0.19 ms per mutation batch with a 58k-node DOM.

4. **Selected state (`markFeed` / `markStar`):**
   - `html[data-sg-feed] = route()==='home' ? feedVariant() : ''`, set at start, on every routeChanged (after `post('route')`), and on star creation.
   - The star link gets `aria-current="page"` on Favorites.
   - Home outline, CSS only:
     ```css
     html[data-sg-feed=favorites] :has(+[data-sg-fav]) a[href="/"] [aria-selected=true] svg>path:only-of-type { d: path("<IGDSHomePanoOutline24dpIcon>") }
     ```
   - The rule is bucketed by `path`, so it is cheap. Without `:has()` or the CSS `d` property, Home just stays filled (cosmetic only).
   - A `:has()` rule for the Reels slot was rejected: as a universal-bucket rule it would be checked against every element on each style recalc.

5. **Taps:** in the existing `window` capture click listener (main role, `e.isTrusted`), before the Explore interception:
   - `t.closest('[data-sg-fav]')` → preventDefault + stopPropagation + stopImmediatePropagation → `openFavorites()`.
   - `homeTabElsewhere(a)`, meaning a[href="/"] in the bar while route home has a variant other than `home` → same stops, `stats.nav.homeFull++`, close search, `location.assign('/')`.
   - This sits beside B16's planned homeTap: that only acts when the variant is `home`.
   - `openFavorites()`:
     - Already on Favorites: if scrollTop > 8, scroll to 0 (`nav.top++`); else `location.replace(FAV_URL)` (`nav.refresh++`).
     - Otherwise: hide search if open (`hideSearch(false)`, clearSaved), `post('feedEnd',{on:false})`, `location.assign(FAV_URL)`.
   - No `sg_skip_seen` is written, so Favorites shows everything newest first. It never gets B17/B18's emptied first page (X4: a freshly loaded Favorites keeps its posts).
   - TalkBack double-tap and keyboard Enter produce trusted clicks, so they take the same path.

6. **R6:**
   - MainActivity.makeFeedBar: drop the Favorites button and its 10dp gap (`r6-native.diff`). The text "Keep going, newest first, without repeats:" still fits.
   - `onNative 'continueFeed'`: accept only `following`.
   - Update page.test.cjs "pages of only already-seen posts keep loading" to use following.
   - Keep the menu's "Favorites feed" entry as a fallback for pages where the bar is hidden, or if the star is missing.
   - If R7 lands, the card shows only when Home stalls.

7. **Edge cases:**
   - The comments child (`role 'comments'`) never places a star. The CSS is inert there, and tidyCommentsChild still hides Instagram's bar.
   - The Story, Direct thread and search-result pages hide the bar themselves, and the star goes with it.
   - Search overlay: it stops at `navHeight()`, so the star stays tappable, and a tap closes search first.
   - Zoom: the star is part of the page, so it zooms with it.
   - Wide or landscape (side bar): no star.
   - Multiple or hidden bars each get exactly one star.
   - Screenshot mode: no change recommended. The star is part of Instagram's bar, not a floating SimpleGram control. Hiding it would reflow the bar, and the shield already blocks taps. If Cam wants stock-looking shots: native `js('screenshot',on)` → `html[data-sg-shot] [data-sg-fav]{visibility:hidden}`, which keeps the slot and avoids a reflow.

8. **Diagnostics:** shapes only, in `stats.nav`, so Copy details picks them up automatically. Add one Filter status line, e.g. "Favorites star: in bar, N items, off by dy px · taps".
   - Counters: `inserted`, `moved`, `notBottom`, `waitReact`, `igHasFav`, `taps`, `top`, `refresh`, `homeFull`.
   - `geo`, sampled once when visible (better: about 2 s after it first appears, once Instagram's CSS has loaded): `items`, `rowW`, `home [w,h]`, `star [w,h]`, `dy` (icon centre difference), `gap [min,max]` between item centres, `sameColour`, `has` (`:has` support), `dProp` (CSS `d` support).
   - Polish for the real build: count `notBottom` once per row (a WeakSet), not on every tidy pass.

## Evidence

- Logged-in mobile bar path (b314 PolarisPageLayoutHandler.react): `o("PolarisUA").isDesktop()?…PolarisNavigationSimple…:r("gkx")("4150")?u.jsx(r("PolarisNavigation.react"),…):u.jsx(r("PolarisMobileNav.react"),{})`; b314 PolarisMobileNav.react: `if(o("PolarisIsLoggedIn").isLoggedIn())return null` → logged in on a phone it must be PolarisNavigation. PolarisNavigationLayoutContext: `navigationPosition = usePolarisIsSmallScreen()?"bottom":"start"` (BOTTOM_STYLING_MAX_WIDTH; item classes switch at max-width 767px).
- Row and items (b314 PolarisNavigationIcons.react, bottom branch): container class `x78zum5 xaw8158 xh8yej3` + CometVisualCompletionAttributes.IGNORE_DYNAMIC. Keyed children feed, (search only if !bottom), explore, reels (`PolarisUA.isDesktop()?null:` Reels), channels, desktop-creation (hasFeedCreation&&bottom), direct, profile. Real CSS (downloaded to /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf5/r5r6/css/): `.x78zum5{display:flex}`, `.xaw8158{justify-content:space-evenly}`, `.xh8yej3{width:100%}`; item container at max-width 767px: display:flex, justify-content:center, margin 0 (x1dn74xm, xif99yt, x172qv1o…), padding 12px (xz9dl7a xpdmqnj xsag5q8 x1g0dm76); icon box 24x24 (xxk0z11 xvy4d1p) with `aria-selected`; pressed `.x1har8x{transform:scale(97%)}`; bar height `--revamp-nav-bottom-toolbar-height:50px`, `--mobile-nav-height:45px`.
- Icons and colour: PolarisNavigationIcon 'Feed' under PrismVariant BORDERED (getPrismVariant always returns BORDERED) = IGDSHomePanoFilled24dpIcon when active, IGDSHomePanoOutline24dpIcon otherwise (both fill shapes). Search/Direct are 2px strokes with round joins (active Search 3px). IGDSSVGIconBase default color 'ig-primary-text' (`.x5n08af{color:rgb(var(--ig-primary-text))}`), `fill=currentColor`. Theme: b383/b385 `n="_aa4c",r="_aa4d"` toggled on documentElement; c5.css `._aa4c{…--ig-primary-text:0, 0, 0…}` and `._aa4d{…--ig-primary-text:245, 245, 245…}`. Instagram's own star: b20 IGDSStarPanoFilledIcon (path used for the star; bbox 1..23 x 1.49..22.51, same footprint as filled Home 1..23).
- Home stays 'active' on Following/Favorites: PolarisFeedNavItem `isActive = … && usePolarisIsOnFeedPage()` and b383 usePolarisIsOnFeedPage = `useCurrentRouteEntityKey().entity_type === "feed"` (no variant check). Hence the CSS-only Home outline while Favorites shows.
- The Messages item's href is not always the inbox: IGDBadgeIconOffMsys `y=g!=null?PolarisRoutes.DIRECT_THREADS+g.threadKey:PolarisRoutes.DIRECT_INBOX`. The row test therefore accepts `a[href^="/direct/"]` or `a[href="/explore/"]`. (Today's NAV_SELECTOR and tidyCommentsChild match only /direct/inbox/.)
- One bar per page root: PolarisShell (which renders PolarisPageLayoutHandler) is rendered by PolarisFeedRoot (b344), withPolarisShell (b314), PolarisDesktopPostRoot (b100), PolarisActivityFeedPage (b411) and others. Bars are recreated on root changes, and kept-alive roots can leave a hidden bar, so the star logic handles every bar row and re-inserts on added nodes.
- Comet can hydrate server HTML: b385 `o("ReactDOM").hydrateRoot(e,…{onRecoverableError:o("CometSSRHydrationHelpers").onRecoverableError})`, and home.html config has `mwp_ssr_enabled:true`. The saved pages contain no server-drawn bar (0 matches of x78zum5). Experiment /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf5/r5r6/tests/hydrate.exp.cjs (results in hydrate-exp.txt):
- **Without the guard:** a star added before hydration makes React 19 report 'Hydration failed … tree will be regenerated on the client' and recreate the bar.
- **With the `__reactFiber$` guard:** no hydration error, Home's node is kept, and the star arrives after hydration (waitReact 3).
- Instagram's React uses the same key: `"__reactFiber$"+…` in b102/b385.
- Prototype tests: /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf5/r5r6/tests/nav.test.cjs. **12/12 pass, stable over 6 runs.**
- **Bar mock:** React 19 rebuild of PolarisNavigation(bottom), with Instagram's class names and real CSS (proto/ignav-app.js).
- **Light-mode geometry:** order [Home, STAR, Explore, Messages, Profile]. Centres 52.7/129.3/206/282.6/359.3 at 412 px, gaps 77/77, same y (890). Star icon 24x24, box equal to Home's, same colour. 0 frames show the bar without the star or with the empty Reels slot.
- **Dark mode:** rgb(245,245,245) for both.
- **React 19 changes:** an added creation item, a remount, a kept-alive hidden bar plus Instagram's in-page tabs. Exactly 1 star per bar, always right after Home, no React errors; Instagram's own tabs still work.
- **Star tap:** a full 'navigate' load of /?variant=favorites. React never saw the tap. Star filled, aria-current=page, Home redrawn as its outline.
- **Second tap on Favorites:** goes to the top first, then reloads with replace (no extra history entry).
- **Home tab on Favorites:** a full load of '/' (no router go, no React click).
- **Where it never appears:** not in the side bar after rotating to 900 px, not in a fixed header, and not in the comments child.
- **Accessibility and keyboard:** role link named 'Favorites'; Enter works.
- **Search open:** the star works.
- **A bar drawn before DOMContentLoaded:** has its star from the first frame. Proven necessary: an observer started at DOMContentLoaded gives 2 frames without it.
- **Instagram's own Favorites item:** the star steps aside.
- **Screenshots:** shots/combined.png (light Home, light Favorites, dark).
- Repo suite on the prototype (SG_SCRIPT=…/wf5/r5r6/proto/simplegram.js): 123/124. The only failure is 'feed: pages of only already-seen posts keep loading instead of stopping', which calls continueFeed with 'favorites' (an intended R6 change). With that test switched to 'following' and a new R6 test added (copy in …/wf5/r5r6/repo-tests/page.test.cjs): 125/125 (suite-proto-adjusted.txt). Repo untouched (git status clean).
- Cost: …/wf5/r5r6/tests/perf.exp.cjs. While 240 posts (58k nodes) were added in 40 batches, the document-start observer spent 7.4 ms total, about 0.19 ms per batch.
- B18 basis for full loads: notes/batch-4/b18-diagnosis.md. In-page switches keep PolarisFeedRoot mounted and reuse Relay's per-variant store (options {}), plus the possible showEmptyFeed latch. X4: a freshly loaded Favorites with no skip inherits nothing and keeps its posts. Existing precedents: continueFeed (location.assign) and the menu's loadMain(FAVORITES).

## Alternatives

- Reuse the hidden Reels slot: unhide it and swap its icon and href. Rejected:
- It rewrites React-owned DOM that React re-renders.
- Instagram's onClick would still route to /reels/.
- The slot sits 3rd, after Search, not next to Home.
- A native Android overlay aligned to the bar. Rejected:
- The bar's position would have to be tracked from JS across route remounts, hidden-bar pages (Stories, Direct), the search overlay, ZoomFrame scaling, the keyboard and rotation.
- Instagram's theme can differ from Android's uiMode.
- With space-evenly there is no fixed gap beside Home, so the page would have to make room anyway.
- CSS-only, a ::after star on Home's item. Rejected: a pseudo-element cannot take its own taps, so taps would hit Instagram's Home link.
- Clone Home's DOM (cloneNode) to inherit its exact classes. Rejected:
- It copies href="/", aria-selected and transient press classes.
- SimpleGram's own Home logic (NAV_SELECTOR, B16 homeTap) would treat it as Home.
- Own markup with Instagram's measured metrics, plus geometry diagnostics, is safer.
- Open Favorites inside the page through Instagram's router (go('/?variant=favorites')). Faster, but B18: it reuses Relay's per-variant store and possibly the empty-feed screen. B18 fix 3 would turn it into a full load anyway.
- Run the star from the existing DOMContentLoaded observer or the 300 ms tidy pass only. Rejected: measured 2 frames with the bar drawn without the star (a visible shift) when Instagram renders before DOMContentLoaded.
- Hide the Reels slot with CSS `[data-sg-fav]~:has(a[href="/reels/"])`. Rejected for cost: a universal-bucket :has() is checked against every element on each style recalc in a large feed DOM. It is done synchronously in JS instead.
- Optional variant: openFavorites posts {action:'openFeed'} so native loadMain(FAVORITES) runs, which closes comments and resets zoom like the menu, with location.assign as the fallback. Needs a native message type; not required.

## Risks

- **Instagram markup changes:** for example, the row is no longer a flex row, Home's href changes, or items are wrapped differently.
  - The design fails safe: no star, the bar is untouched, and the menu's Favorites entry still works.
  - Misalignment shows up in `stats.nav.geo` (dy, gap, items).
- **The logged-in DOM was not observed directly.** The bar path rests on public b314 code plus gkx 4150, which must be on for a logged-in phone to have a bar at all. Only the phone confirms it (`geo.items` 5, dy 0).
- **Hydration:** if Instagram ever draws the bar on the server, the star waits for React (`waitReact`). That page then sees one small shift when the star appears.
- **The guard depends on React's `__reactFiber$` key prefix.**
  - If a future React renamed it, the star would never appear (safe failure, visible as `waitReact` growing).
  - A fallback could be to insert anyway after load + 2 s.
- **Full loads cost about 1–2 s per switch.** Going to Favorites drops Home's loaded list and scroll position; Back reloads Home from the top. This matches the end card and menu today, but is slower than Instagram's in-page tabs.
- **Home tab on Following or Favorites becomes a full load.** This complements B18 fix 3, which still covers the logo menu and Back over Instagram's in-page history entries.
- **Cosmetic dependencies:** the Home-outline-on-Favorites rule needs `:has()` (Chrome 105+) and the CSS `d` property. Without them Home stays filled while the star is filled too. Both are recorded in `geo.has` / `geo.dProp`.
- **Theme:** colours come from Instagram's variables. If Instagram's theme and Android's dark mode disagree, the star follows Instagram, as its icons do.
- **The Reels slot is now hidden synchronously, at the star's insertion.** It is the same `hide()` as 1.2's tidyReelsTab, only earlier, so the bar no longer shifts.
- **The document-start observer adds work on every DOM change.** It is small (measured 0.19 ms per batch) but runs for the page's life.
- **Accessibility:** focus styling is removed (`outline:none`). Add a `:focus-visible` ring if keyboard or switch access matters.
- **R6:** the Favorites button leaves the card; `continueFeed('favorites')` from an old native build is ignored.

## Phone checks

Only the logged-in phone can confirm:
1. **That the bar is PolarisNavigation(bottom) with the assumed row:** a flex space-evenly row, Home a[href="/"], Messages a[href^="/direct/"]. Read `stats.nav.geo` in Copy details:
   - expect items 5;
   - home and star [24,24];
   - dy 0;
   - gap min ≈ max (within 1 px);
   - sameColour true, in both light and dark mode;
   - has and dProp true (the WebView supports `:has()` and the CSS `d` property).
2. **Whether Instagram draws the bar on the server:** `waitReact` 0 means a client-drawn bar (no wait); above 0 means the star waited for hydration.
3. **Favorites:** opened from the star it shows posts, not "Choose the accounts you can't miss out on" or a blank page. The star is filled and Home is drawn as its outline.
4. **Home tab from Favorites:** lands on a normal Home (`homeFull` 1).
5. **Messages link:** whether it ever points at a /direct/t/<id>/ thread. That breaks today's NAV_SELECTOR and tidyCommentsChild assumptions, not the star.
6. **No visible shift of the bar** on page loads and route changes.
7. **Long-press on the star:** no unexpected link menu.
8. **Behaviour checks:**
   - a tap while Favorites is scrolled goes to the top; a tap at the top refreshes;
   - landscape: the star disappears with the side bar (`notBottom`) and returns in portrait.

Shape-only diagnostics to add: `stats.nav`, so Copy details carries it automatically. Add one Filter status line, e.g. "Favorites star: in bar (5 items, aligned) · taps N".
- **Counters:** `inserted`, `moved`, `notBottom` (count once per row), `waitReact`, `igHasFav`, `taps`, `top`, `refresh`, `homeFull`.
- **`geo`** (sample about 2 s after the star first becomes visible, and once more on the first Favorites page): `items`, `rowW`, `home [w,h]`, `star [w,h]`, `dy`, `gap [min,max]`, `sameColour`, `has`, `dProp`.
- **Optional:** `hrefShapes` of the row's links as categories (home / explore / direct-inbox / direct-thread / reels / profile / other), with no usernames or thread ids.

## Tests

Port /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf5/r5r6/tests/nav.test.cjs into tests/nav.test.cjs. Also commit:
- the bar mock (proto/ignav-app.js);
- a React 19 browser bundle, built by tools/build-react.cjs from npm react/react-dom/scheduler 19.1.0 (or vendor its output);
- the CSS subset the bar needs: c5.css plus the files holding the theme variables, or extract only the bar's classes.

The 12 cases:
1. **Light geometry:** order Home, star, Explore, Messages, Profile. Equal gaps (≤1 px spread), same centre line, 24x24 icon and 48x48 box like Home, same colour. No frame without the star or with the empty Reels slot.
2. **Dark colour:** rgb(245,245,245).
3. **React changes:** a creation item added, a remount, a kept-alive hidden bar plus Instagram's in-page tabs. Exactly 1 star per bar, after Home, no React errors, Instagram's tabs still work.
4. **Star tap:** a full 'navigate' load of /?variant=favorites. React never sees the tap. aria-current=page, filled star, Home's path computed as the outline.
5. **Second tap on Favorites:** scrolls to the top, then reloads with replace (history length unchanged).
6. **Home tab on Favorites:** a full load of '/'; no router go and no React click.
7. **Side bar and header:** no star in the side bar after rotating to 900 px; no star in a fixed top header with Home and Direct links.
8. **Comments child:** no star.
9. **Accessibility:** role link named Favorites; Enter opens Favorites.
10. **Search open:** the star closes it and loads Favorites.
11. **Drawn before DOMContentLoaded:** the bar has its star in the first frame. This case fails if the observer starts at DOMContentLoaded.
12. **Instagram's own Favorites item:** the star steps aside, and comes back when that item is gone.

Repo test changes:
- page.test.cjs "pages of only already-seen posts keep loading": continueFeed variant 'following'.
- Add an R6 test: continueFeed('favorites') does nothing and writes no sg_skip_seen.
- Results: 125/125 with SG_SCRIPT set to the prototype; 123/124 before adjusting the one test.

Experiments to keep in notes:
- hydrate.exp.cjs: the server-drawn bar, ungated vs gated.
- perf.exp.cjs: observer cost.

On-device checks (Android WebView):
- Home and Favorites, light and dark: screenshots of the bar.
- Rotate to landscape: the star disappears with the side bar and returns in portrait.
- Open a post, a profile and Stories, then go back: one star, no shift.
- TalkBack: the star reads "Favorites, link".

## Review: needs-changes

### Problems

- CONFIRMED BUG (B14 regression), experiment E3a. Setup: a search result is still opening (B14 cover up) when the user taps the star. openFavorites never ends the open, so the 100 ms leaving watcher keeps running. If Instagram never takes the open, or is slow (the 800 ms, 8 s and 10 s rules), watchLeaving() calls fullLoad(), whose location.replace('/p/...') cancels the pending Favorites load. Reproduced: the page landed on /p/KEYW001/, not /?variant=favorites. Even when Instagram's router does finish (E3b), hideSearch(false) drops the cover at once, so Home and then the result flash before Favorites loads. The Home-on-Following/Favorites full load has the same race. Fix, verified (E3a then lands on Favorites): `if (leaving) { stopFullLoad(leaving); endOpen(); countOpen('cancelled'); }` before navigating. Files: /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf5/r5r6-review/leaving.exp.cjs and /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf5/r5r6-review/sg-fixed-leaving.js.
- CONFIRMED BUG, experiment E6. On Favorites with SimpleGram's search open, a star tap takes the 'already on Favorites' branch. It scrolls the hidden page underneath to the top (nav.top 1) and leaves search open, so the user sees nothing happen. A tap at the top reloads without clearSaved. Fix: if search is open, close it the way closeSearch does (hideSearch, suspended=false, clearSaved) and stop there. File: /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf5/r5r6-review/favsearch2.exp.cjs.
- PERFORMANCE (measured, experiment E4, 58k-node DOM, desktop Chromium; a phone is several times slower).
- On Following and Favorites, Instagram's header back link '< Favorites' is itself an a[href="/"]: PolarisFeedVariantsHeader renders a PolarisFastLink whose href is XPolarisFeedControllerRouteBuilder.buildURL({}), which is '/'.
- homeItem() climbs up to 10 levels from that link and runs row.querySelector on ancestors that contain the whole feed. One header re-render then costs about 5 ms inside the observer's microtask, against 0.1 ms without the link.
- Every tidy pass costs about 2.2-3 ms: a document-wide querySelectorAll('a[href="/"]'), getComputedStyle on every candidate row and these climbs. Tidy passes run about every 300 ms while the feed loads.
- The design's 0.19 ms figure covers only the observer's quick path. It was also measured on an older revision (simplegram.timed.js has a different quick path and no igHasFav check).
- Files: /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf5/r5r6-review/scan.exp.cjs and scan-nohdr.exp.cjs.
- The Home-tab interception depends on DOM depth. homeTabElsewhere(a) acts only when homeItem(a) succeeds. For the header '< Favorites' / '< Following' link (also an a[href="/"]), that depends on whether some ancestor within 10 levels happens to have at least 4 children and a Direct or Explore link. When it doesn't, that tap stays an in-page switch to Home, which is the B18 path. The fix needs no geometry: on route home with a variant other than home, any trusted, unmodified tap on a same-origin a[href="/"] becomes a full load of '/'.
- Retry loop with no end. If a matching row never gets a __reactFiber$ key (React renames its internal key, or a bar is static or never hydrated), placeStars re-arms a 400 ms timer, then queueTidy, then a full tidyNow, every 400 ms for the life of the page. The design calls this a safe failure, but it keeps the CPU busy indefinitely. Bound it, for example give up after about 10 s (25 tries) and count waitReactGaveUp, or insert after load + 2 s as the design's own fallback suggests.
- Conflict with planned fixes.
- B16's test plan item 6 says the Home tab on ?variant=following 'is not swallowed'. R5 now swallows it and does a full load, so B16's homeTap notes and tests must change with R5.
- B18 fix 3 (switch reload in routeChanged) overlaps with homeTabElsewhere. Keep both, since fix 3 still covers the logo menu and Back over Instagram's own entries, but count them separately.
- More fresh Home loads, and a known blank Home. Each star round trip (Home, star, then Back or Home) reloads Home from its first page. That loses Home's position and its homeSeen set, which R7's no-repeat logic relies on. It also exposes the user more often to B18's still-open blank fresh Home: the B18 review's R2 case, a first page of [rec, rec, ad] with the marker on the next page, which becomes 0 edges with has_next true. The B18 prototype's fix 1 does not cover R2. R5 should not ship before a complete B18 fix 1, and Cam should be told that going back to Home from Favorites starts Home over at the top (B16 history).
- Refresh without Instagram's guard. A tap at the top of Favorites always does a full location.replace load. Instagram's own Home tab refreshes only when more than 30 s have passed since the last head load (shouldRefreshOnHomeClick, 3e4 in b314). Mirror that 30 s rule so a double or habitual tap doesn't reload the page.
- Minor.
- **Rotation (E5):** the star stays in the side bar, and the portrait bar is drawn without it, for at least 2 frames (up to about 300 ms if a tidy pass just ran). A className change is not a childList mutation. Run placeStars directly in a requestAnimationFrame on resize.
- **Native parity:** location.assign does not reset zoom or close the comments split, as the menu's loadMain does. Use a native openFeed message, with location.assign as the fallback.
- **Link display:** `[data-sg-fav] a{display:inline}` around an inline-flex box depends on line-box font metrics. It measured 48 px here (E1: box 50, row 48, every slot 48 in stock, 1.2 and the prototype), but phone fonts differ. Use display:flex on the link.
- **Home outline on Favorites:** the CSS `d:` rule changes Instagram's drawn Home icon to its outline for a cosmetic gain. Instagram itself treats Favorites as part of Home. Optional; can be dropped.
- Re-checked and found sound:
- The b314 bar path (gkx 4150 gives PolarisNavigation; logged in, PolarisMobileNav returns null) and the row's classes and keyed slots.
- Home is active on every feed variant (usePolarisIsOnFeedPage is entity_type === 'feed').
- The __reactFiber$ key (b102 and b206; b206 is Instagram's own Hyperion fiber lookup).
- React 19 reconciliation with a foreign sibling node.
- No new API request types: only document loads of URLs the menu and the end card already load.
- nav.test 12/12 pass. The repo suite on the prototype is 123/124, and the only failure is the intended continueFeed('favorites') test (/tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf5/r5r6-review/suite-proto.txt). The repo is untouched.

### Revised design

Keep R5's architecture: SimpleGram's own star, a sibling right after Home's slot in Instagram's flex row. Place it from a document-start MutationObserver, add the hydration guard, open Favorites as a full page load, take taps in the window capture listener, and keep R6 (end card offers Following only). Change the following.

1. Finding rows cheaply and with bounded work
- **homeItem(a):**
  - First try `row = a.closest('[data-visualcompletion="ignore-dynamic"]')` (PolarisNavigationIcons sets it on the bar row) and accept it if it is at most 6 levels up, has at least 4 children and contains an a[href^="/direct/"] or a[href="/explore/"].
  - Otherwise fall back to a climb capped at 6 levels, skipping any link inside main or header. Never querySelector an ancestor that contains main.
- **Observer:** keep the quick path (act only when an added subtree contains a[href="/"]). Remember placed stars in a Set.
- **Tidy pass:** stop scanning the whole document. For each known star: drop it if it is disconnected; re-insert it if its previous sibling no longer holds a[href="/"]. Do a full search only when the Set is empty or the observer flagged a new row.
- **Layout checks:** cache bottomRow(row) per row in a WeakMap and recompute only on resize. On resize, run placeStars in a requestAnimationFrame, not queueTidy, so a rotation shows no frame with the star in the side bar or a portrait bar without it.
- **Hydration guard:** stop retrying after 25 tries or 10 s (count waitReactGaveUp). Optionally insert once after load + 2 s.
- **Stories:** skip the observer's work there (the bar is hidden; B10's lighter checks).

2. Taps (window capture listener, trusted events, main role only, before the Explore interception)
- **Star tapped:** preventDefault, stopPropagation, stopImmediatePropagation, then openFavorites():
  - (a) If a search result is opening (`leaving` set): stopFullLoad(leaving), endOpen(), countOpen('cancelled').
  - (b) If on Favorites and search is open: close search (hideSearch(true), suspended=false, clearSaved), count nav.closedSearch, and return.
  - (c) If on Favorites and scrollTop > 8: scroll to 0 (nav.top).
  - (d) If on Favorites at the top: reload with location.replace only when this page loaded, or last received a feed page, more than 30 s ago (Instagram's shouldRefreshOnHomeClick rule); otherwise do nothing (nav.refreshHeld).
  - (e) Otherwise: close search if open (clearSaved), post feedEnd off, and open Favorites. Prefer a native message {action:'openFeed', variant:'favorites'} handled by loadMain(FAVORITES), which closes the comments split and resets zoom like the menu. Fall back to location.assign('/?variant=favorites') when the bridge is missing. Write no sg_skip_seen.
- **Home elsewhere:** on route home with a variant other than home, a trusted, unmodified tap on any same-origin a[href="/"] (the bar's Home or the '< Favorites' / '< Following' header link) gets the same three stops, then the same (a) step, close search, and location.assign('/'). Count it in nav.homeFull, split as bar or header. No homeItem() or geometry here.
- **B16's homeTap:** still acts only on the home variant. Update B16's planned test 6: the Home tab on Following or Favorites is a full load, not left to Instagram.
- **B18 fix 3:** keep it in routeChanged for the logo menu and Back over Instagram's own history entries.

3. Markup and CSS
- Same star markup and icons, but `[data-sg-fav] a{display:flex}` (no inline line box).
- Keep the colour from --ig-primary-text and the filled or outline star from html[data-sg-feed].
- The Home-outline `d:` override is optional polish. Default: leave Instagram's filled Home alone, since Instagram treats Favorites as part of Home. If Cam wants it, keep it behind the :has / d support checks as designed.

4. Order with other batch-4 work
- Ship R5 only with a complete B18 fix 1. Every empty first page needs an anchor, including Home's [rec, rec, ad] first page with the marker on the next page (the review's R2). Star round trips make fresh Home loads routine.
- Say in the release notes that coming back to Home from Favorites starts Home at the top.
- R6 as designed: the card shows only Following, continueFeed accepts only 'following', the menu keeps Favorites. If R7 lands, the card stays only for 'Home isn't loading more'.

5. Tests to add on top of the prototype's 12
- A star tap while a result opens and Instagram never takes the open (800 ms rule, slow document): lands on /?variant=favorites, and opens.cancelled is 1 (the E3a setup).
- The same with Instagram's router mid-open: lands on Favorites, and the result never draws as a full load.
- On Favorites with search open: the star closes search, does not navigate, and does not scroll.
- At the top of Favorites, a second tap within 30 s of load does not reload; after 30 s it reloads with replace.
- The '< Favorites' header link (an a[href="/"] inside the header, deep in a feed) becomes a full load of '/'.
- Cost: with 58k nodes, a header re-render batch takes 0.5 ms or less, and a tidy pass does no document-wide a[href="/"] scan (count it).
- Rotation: 0 frames with the star in a non-flex row, 0 portrait frames without it.
- A static bar with no fiber key stops retrying after the limit (tidy is not called every 400 ms forever).
- Keep the repo suite change (page.test 'pages of only already-seen posts keep loading' uses following) and the R6 test.

6. Diagnostics
Keep stats.nav, adding:
- counters closedSearch, refreshHeld, waitReactGaveUp and openCancelled;
- homeFull split into bar and header;
- a tidyScans count.
Sample geo once, about 2 s after the star first becomes visible.

Phone checks stay as the design lists them. Add:
- whether the '< Favorites' header back link reloads Home;
- after a Favorites → Home round trip, whether Home shows posts (not blank: the B18 R2 case).


# R7: feasible = likely

## Recommendation

Yes, this looks doable with route 2: Home can carry on into posts from people you follow, in the same list, with no repeats. Instagram's own continuation (route 1) cannot do it, and nothing else in Instagram's code appends another feed to Home (route 3).

How route 2 works: after "You're all caught up", SimpleGram leaves Instagram's paging on. SimpleGram reads Following itself in the background, using the same two requests the website sends on its own Following page. When Instagram's next Home page arrives, SimpleGram swaps its suggestions for the next Following posts. That happens in the data, before Instagram sees the page. Instagram's list store (Relay) then appends those posts to Home's list and Instagram draws them like any Home post. Nothing is inserted into or moved around on the page, which is what broke the old apps.

Proof so far: a prototype on top of 1.2 passes 15/15 tests, twice in a row, against a mock built from the bundle facts. With the feature off, the repo suite still passes 124/124. With it on, 7 tests change, all on purpose (paging stays on at the marker).

What it needs:
- An app setting to switch it on (CFG.continueHome, default off).
- The card (R6): hidden while Home goes on. It appears only when the continuation fails, stalls or ends, and then offers only Following.
- Diagnostics in the build. The logged-in phone has to confirm four things: what Instagram's post-marker pages contain, that SimpleGram's own Following request works from Home, that the appended posts are drawn, and that the divider line shows.
- If any of those fail, Home falls back to today's end card.

Why route 1 is out: on Home, Instagram's next-page request can only ask for Suggested posts or nothing (b404 getPaginationSourceFromVariant). "Older posts" exists only as its own page, /?variant=past_posts, with a "Past Posts" header and a back arrow. Editing the marker's groups or active_group_id does not change what Home asks for.

## Design

Scope: all changes are in simplegram.js plus a few lines in MainActivity.

Prototype files:
- /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf5/r7/proto/simplegram.cont.js (diff: cont.diff, about 400 lines)
- Built by make-proto.cjs from cont-module.js, using exact, unique string replacements.

0. ON/OFF
- New setting CFG.continueHome, default false. MainActivity.config() would pass true.
- contWanted(fs) requires all of: role main, feed key home, route home, variant home, and not streamed.

1. At the marker (endHome)
- The marker and everything after it are still cut, as in 1.2 (the cut is confirmed working on the phone).
- New: when contWanted, do not call stopPagination. Instead set fs.caughtUp, fs.cont and fs.markerEdge, then call contStart().
- The 'feed_recs' branch (a suggestions page with no marker) does the same, keeping the followed posts.
- The marker page itself is not nudged. cs.waiting is set instead, so Instagram is asked again once Following posts are ready.
- B18 anchor: if nothing at all has been shown on Home yet (keptMedia 0 and !fs.shownAny), the marker edge goes back in as the only item. Its group_set.groups is set to [] and active_group_id to null, and has_next_page is left true. Instagram never gets an empty first page, keeps paging, and asks for feed_recs.

2. SimpleGram's own Following reads (contFill / contFetch)
- They go through igGraphQL, which uses its own fetch and native JSON.parse (never Instagram's parse hook).
- filterFeedList now starts with `if (ownFetch) return;`, so these pages never touch Home's state.
- First page: PolarisFeedTimelineRootV2Query, sent exactly as the entrypoint sends it: {data:{pagination_source:'following', ...FEED_TIMELINE_REQUEST_BODY}, first:3, variant:'following'}.
- Next pages: PolarisFeedRootPaginationCachedQuery_subscribe, exactly as loadNext sends it: {after:<Following end_cursor>, before:null, data:{...BODY, pagination_source:'following'}, first:PAGE_SIZE (12), last:null, variant:'following'}.
- Values are read from the page where possible:
  - BODY from window.require('PolarisFeedQueryConstants') (device_id included);
  - PAGE_SIZE from 'PolarisFeedActionConstants';
  - doc ids and provider variables from the compiled .graphql modules. Fallback ids (bundles of 2026-10-21): 28805668309050001 and 28847928918174870.
- Requests go to /graphql/query, with Referer /?variant=following (optional).
- Each answer is filtered with feedVerdict (no ads, reposts, suggestions or unfollowed accounts). Codes already in homeSeen, already shown, or already buffered are skipped.
- A buffer of about 12 posts (one Instagram page) is kept ready.
- Pacing:
  - one request at a time;
  - 500 ms apart, or no gap while Instagram is waiting;
  - at most 20 pages that brought posts per minute;
  - skipping stops once more than homeSeen.size + 36 seen posts have been passed;
  - reads pause off Home or in the background and resume on return;
  - reads are held for 3 s after Instagram scrolls to the top (it may be reloading).

3. Instagram's next Home pages after the marker (the cont block in filterFeedList, before 1.2's after-end rule)
- If the page is a reload of Home (rules in step 4): contReset, freshFeed, count a refresh, then filter it as a normal Home page.
- Otherwise contHandover:
  - The only response field changed is `edges` of xdt_api__v1__feed__timeline__connection. It is replaced in place by up to 12 buffered Following edges, which are added to homeSeen and the shown set.
  - page_info and pagination_source are left exactly as Instagram sent them. Instagram's cursor chain stays its own, so its next request is still one the website makes: its own paging query, variant home, pagination_source 'feed_recs' or none (justknobx 2492).
  - If the buffer is empty: hand over an empty page with has_next still true. Set cs.waiting; when the buffer fills, nudge once (re-armed on return to Home).
  - Ending: when Instagram says no more (has_next false or no string cursor), or Following is used up, set has_next_page=false and endFeed. The card shows.
  - Never set has_next true without a string end_cursor. Relay would then send after=null, which is a reload that replaces the whole list.
- Relay ConnectionHandler (b385): appends when args.after matches the client end_cursor, or when the client and server end_cursors are equal. Feed item nodes have no id, so SimpleGram must never hand over a duplicate. The code sets guarantee that.

4. Telling a reload from a next page (contHead). A page counts as a reload if any of these holds:
- (a) it contains a marker;
- (b) it is one of the first two Home pages within 6 s of Instagram's window.scrollTo(0,0) (SimpleGram wraps scrollTo; every refresh path calls it), with the user less than 2 screens down. This covers heads A and B in either order;
- (c) the user is less than 1 screen down a list longer than 3 screens (Instagram only loads next pages near the end);
- (d) the user is at the top, the page has friends' own posts, no explore_story units, and pagination_source is not feed_recs;
- (e) the continuation is over and the page has followed posts (1.2's rule).
- Production should add the B16 fix's homeTapAt as a further reload signal.

5. Home reload during the continuation (B16)
- Relay replaces the whole list (Instagram's own behaviour, which nothing on the data side can stop).
- SimpleGram starts Home over. At the next marker the continuation reads Following's newest page (for anything new), then jumps back to the saved Following cursor. Nothing is re-read.
- Everything shown before, Home and Following, stays in homeSeen, so nothing repeats.

6. Divider line
- contLabel(code) adds a style rule: `article:has(a[href*="/p/CODE/"])::before{content:"You're all caught up · Following, newest first"...}` on the first Following post.
- It is CSS only; nothing is added to Instagram's React tree. The code is limited to [A-Za-z0-9_-].

7. Fallback
- Triggers:
  - any own request returns null (HTTP error, 429, please-wait, network failure);
  - the answer has no edges or page_info;
  - the units are not recognised.
- Then: state 'failed', fs.ended at once (the card shows at the bottom), and the next Instagram page gets has_next_page=false. No retries.
- If Following simply runs out: state 'done', the same ending.
- A stall (nothing for 15 s at the bottom) shows the existing "stalled" card.
- The feedEnd message gains `cont: state`, so MainActivity can show:
  - nothing while 'running';
  - a Following-only card on 'failed' or a stall;
  - "That's everything new from people you follow" on 'done'.

8. Before building, add
- Arm only when the page's own modules supplied the doc id and providers (idSource module/graphql, providerSource graphql). Otherwise the shapes may differ, so use the card instead.
- Counters for why a page was taken as a reload (marker, jump, top, organic, ended).
- The diagnostics listed under phoneChecks.

Request count per appended page (steady state):
- 1 request from Instagram. This is its own next-page request, the same one the stock website makes when you scroll past "caught up".
- 1 from SimpleGram (one Following page of 12).
- Start-up: about seenPosts/12 + 1 of SimpleGram's own. In R7-3, 30 seen posts were passed in 4 requests.
- After a reload: 2.
- R7-2 totals: Instagram 10 requests (1 head, 2 Home pages, 7 after the marker); SimpleGram 6 requests for 53 Following posts shown.

## Evidence

- Route 1 cannot work inside Home. b344 PolarisFeed.react builds next-page variables with getPaginationSourceFromVariant(variant, markerInEdges, connection.pagination_source). For home, b404 PolarisFeedContext returns only `t||justknobx(2492)&&n==='feed_recs' ? FEED_RECS : null`. PAST_POSTS is returned only when the route variant is past_posts.
- Past posts are a separate page. PolarisFeedVariantsHeader gives it the 'Past Posts' header with hasBackButton, and its entrypoint (b404 PolarisFeedRoot.entrypoint) sends pagination_source 'past_posts' with first:3 and no cursor.
- The marker's groups only feed the legacy redux store. b385 PolarisFeedActionBuildPastPostsAction reads groups.past_posts.nextMaxID only for feedToUpdate:'past_posts'. polarisFeedReducer m() reads only the FEED_RECS group. In the public bundles, activeGroupId is written by PolarisNormalizeEndOfFeedDemarcator and read nowhere.
- What the marker block draws is unknowable from the bundles: its renderer is in logged-in-only code. On the phone, 1.2 never set stats.feed.inMarker on marker pages 12 and 14 (home-jump-details.json), so the real markers carried no group feed_items arrays.
- Route 3 does not exist. Each variant has its own Relay connection (b102/b385 key PolarisFeedPage__xdt_api__v1__feed__timeline__connection, filters ['_variant']; the server argument _variant comes from variables.variant). A refetch replaces the list. The only built-in append after the marker is FEED_RECS (suggestions), and the redux transform appends only the feed_recs group's items.
- Route 2's shape safety: Home's next page and the Following page are the same GraphQL documents with different variables. Root query 28805668309050001 (b205/b314) and paging query 28847928918174870 (b102/b385) both spread PolarisFeedTimelineFragmentCachedQuery_items_connection and have the same 6 provided variables.
- Page size and request body: b344 PolarisFeedActionConstants.PAGE_SIZE = 12. b385 PolarisFeedQueryConstants.FEED_TIMELINE_REQUEST_BODY = {device_id, is_async_ads_double_request:'0', is_async_ads_in_headload_enabled:'0', is_async_ads_rti:'0', rti_delivery_backend:'0'}.
- Relay's append rule (b385 ConnectionHandler): it appends when args.after equals the client end_cursor, or when the client end_cursor equals the server's; otherwise the page is ignored. has_next_page comes from the server; end_cursor is updated only when it is a string; after==null replaces the list; copyFieldsFrom runs on every update. Feed item nodes have no id, so mergeEdges never dedupes; b102 client__feedDedupedIds dedupes by media id when drawing.
- The swap must be synchronous: on the phone every Home page was read through JSON.parse (feedUnits via 'parse'). That is why Following must be fetched ahead of time.
- Post-marker pages are suggestions: B8's phone data (1.1, marker not cut) showed explore_story-only pages after it, with pagination_source 'feed_recs' (b344 getPolarisFeedRecsPagingToken.next reads explore_story and ad units after the marker).
- Prototype results (/tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf5/r7/out/r7-final4-1.txt and r7-final4-2.txt): 15/15 pass twice. R7-1: Home's 7 posts, then 128 Following posts newest first; 0 repeats, one document, no card, divider on F04. R7-2: request shapes as described, one at a time, nothing of SimpleGram's before the marker. R7-3: 30 seen posts passed in 4 requests and never an empty list. R7-4: 0–1 empty pages for a scrolling reader; up to 11 in 9 s for a reader who jumps to the end every 0.3 s while Following takes 1.5 s to answer. R7-5 and R7-5c: Home-tab reload with heads in either order; Instagram's head is kept and Following resumes from the saved cursor without repeats. R7-5b, R7-6, R7-6b, R7-7: card shown when Following is refused, malformed or used up. R7-8: B18 anchor. R7-9: off and other feeds untouched. R7-10: reads pause off Home.
- Repo suite with the prototype: 124/124 with the feature off (suite-final-off.txt). With it on, 117/124 (suite-final-on.txt); the 7 that change all assert has_next false at the marker, or the marker as the very first item. /home/user/SimpleGram is unmodified (clean git status).

## Alternatives

- Route 1, Instagram's 'Older posts' via the marker's past_posts group: not possible in the same list. Home's requests can only ask for feed_recs or nothing. past_posts is a separate page (/?variant=past_posts), and it is Instagram's ranked older posts, not chronological Following. It could only replace today's card button, which is not seamless.
- Route 2b: write Following pages straight into Relay's store with window.require('PolarisRelayEnvironment').commitPayload, using the paging query with after = Home's end_cursor. This avoids Instagram's suggestion requests and the race, but it depends on Relay internals and Instagram's private environment, and it adds data rather than filtering it. Not recommended.
- Route 2c: send SimpleGram's request through Instagram's own network layer, so it is byte-identical. The answer would then pass through the JSON.parse hook and could not be told apart from Home's own pages. Not recommended.
- Start reading Following early, for example after Home's 3rd page. This removes the race at the marker and the wait when Home was heavy, but costs requests when the user stops before the end. A tunable.
- Keep Instagram's own marker as the divider instead of the CSS line. It is a more native look, but its logged-in renderer is unknown (it may show a 'Suggested Posts' heading or a 'View older posts' link). Decide after a phone check.
- Rejected: merging on screen (DOM), which is what broke the old apps; blocking scroll events to Instagram while waiting, which would freeze its virtual list; hooking XHR send to rewrite requests (ghost_owl checks for that).

## Risks

- **Untested against a real logged-in session.** The mock follows the bundle facts, but the logged-in modules (PolarisFeedPage, PolarisVirtualFeed, the marker renderer) are missing.
- **Shape mismatch.** If the provider-variable values differ from Instagram's, a Following edge could lack an @include'd field and Relay could draw the post incomplete. Arm only when the page's own .graphql modules supplied the ids and providers.
- **Reload detection is a heuristic.**
  - Worst case one way: a reload is taken for a next page, and Home's list is replaced by one page of Following posts. Not blank, but wrong order.
  - Worst case the other way: a next page is taken for a reload, the continuation stops and the card shows.
  - A short Home list where a reload arrives without scrollTo(0,0) is the remaining gap. The B16 Home-tab fix (homeTapAt) narrows it.
- **Unknown post-marker content when the marker is cut and justknobx 2492 is off.** The request then carries no pagination_source, and the server might return older friends' posts rather than suggestions. Those are swapped too (unless the user is at the top), so it still works, but it is unverified.
- **More requests than 1.2.** Instagram's own post-marker requests return (1.2 stopped them; the stock website makes them). SimpleGram adds about 1 Following request per 12 posts shown. Empty pages cost one Instagram request each, at Instagram's own one-at-a-time pace. Bounded and paced, but a server could still treat a Following read from the Home page as unusual.
- **Request params.** SimpleGram's request has the same minimal parameters as the search features, which already work on the phone. It is not byte-identical to Instagram's (no __req, __dyn, jazoest).
- **Seen-state logging.** Following posts are logged as seen in Home's context (feed_view_info, client_view_state). They become part of Instagram's view of what the user saw.
- **Divider depends on markup.** It relies on article markup and :has() (WebView 155 supports it). If it fails, there is simply no line.
- **B18 anchor drawing is unverified.** The neutralised marker kept as the only item is drawn by unknown logged-in code. It is used only when Home would otherwise be empty.
- **Endless Following.** Following goes back indefinitely, though Instagram's loader only pages as the user scrolls. Consider a soft stop (for example about 300 posts), then the card's Following button.
- **Interplay with other fixes.** The B17 anchor and nudge fixes for the separate Following page stay needed for the card's fallback. B16's homeTap and diagnostics are complementary.

## Phone checks

Only the logged-in phone can confirm:
1. What Instagram's next Home pages contain once the marker is cut and paging stays on: suggestions (explore_story with ps feed_recs) or friends' posts with ps null. This decides how robust the reload rule is.
2. That SimpleGram's own Following request works from the Home page: HTTP 200, edges present, page_info.end_cursor and has_next present, ps 'following'.
3. That Relay draws the swapped posts after Home's last post, in order.
4. That the divider line renders.
5. That Instagram's virtual list honours has_next false at the end.
6. If the B18 anchor triggers: that the neutralised marker draws without an error page.

Diagnostics to add to Copy details (counts and shapes only, never names or codes):
- stats.cont (already in the prototype): state, reason, own, ownFail, pages, swaps, handed, empty, skippedSeen, heads, anchors, nudges. Add heads split by reason: marker, jump, top, organic, ended.
- The existing gqlLog entries for the Following requests: query, idSource, providerSource, path, status, edges, ms. Also booleans for whether these resolved from the page: PolarisFeedQueryConstants, PolarisFeedActionConstants, PolarisConfig.
- The feedUnits ring keeps Instagram's swapped post-marker pages under verdict 'cont': unit kinds, ps, follow and nx.
- Per handover:
  - ms from the marker page to the first handover with posts;
  - whether the first Following article is in the DOM within 3 s;
  - whether its ::before content is not 'none';
  - page scroll height in screens just before the handover and 1.5 s after (growth means appended, shrink means replaced).
- afterEnd page count once the continuation ends; s429 and pleaseWait during the continuation.

Manual test on the phone:
- Scroll Home to the end: posts should continue under 'You're all caught up · Following, newest first', with no repeats.
- Open a post and come back: it should keep going.
- At the end, tap Home twice (B16): it reloads; scroll down again and it continues with posts not shown before.
- Turn on airplane mode while it is continuing: the card should appear.
- Send Copy details.

## Tests

Scratch: /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf5/r7/

**Mock**
- tests/igpage.js models Instagram's Home page from the bundles:
  - XHR plus JSON.parse;
  - root and paging queries;
  - getExtraVariables with a justknobx 2492 switch and recs_paging_token;
  - Relay ConnectionHandler semantics and media-id dedupe when drawing;
  - paging only on scroll (250 ms throttle, ≤1 screen from the end);
  - the empty-feed view;
  - the Home tab's double head load with scrollTo(0,0) and the glimmer.
- tests/harness.cjs is the mock server: Home pages, post-marker suggestion pages, Following pages by cursor, latency and failure injection. It logs every request: who sent it, doc, variant, after, first, ps, token, referer.

**Run**
`NODE_PATH=/opt/node-tools/node_modules node --test --test-concurrency=1 tests/r7.test.cjs`
- SG_SCRIPT defaults to proto/simplegram.cont.js.
- The 15 tests are R7-1 to R7-10 plus R7-5b and R7-5c; R7-4 runs three times, once per reader speed. What each one shows is under evidence.
- Results: 15/15 in two consecutive runs (out/r7-final4-1.txt, out/r7-final4-2.txt; numbers in the matching .jsonl files).

**Repo suite**
- 124/124 with the feature off (out/suite-final-off.txt).
- With it on (proto/simplegram.cont-on.js), 7 tests change as intended (out/suite-final-on.txt). They need new expectations when this is built:
  - feed.test.cjs: 'Home ends at…', 'a marker in a page without plain posts…', 'the marker as the very first item…', 'an all-suggestions page…', 'after the end, a refresh starts over…', 'replaying the phone's pages…';
  - page.test.cjs: 'JSON.parse keeps friends…'.

**For the build**
- Port igpage.js, harness.cjs and r7.test.cjs into tests/.
- Add tests for:
  - arming only when the page modules resolved;
  - the reload-reason counters;
  - card states in MainActivity for running, failed, done and stalled.

## Review: needs-changes

### Problems

- Following posts SimpleGram has already read but not yet shown are lost whenever Home starts over. contReset saves only cs.cursor, which points past the buffer, and throws cs.buffer away. In E2 a Home-tab reload with a full buffer skipped F88-F98 (11 posts) and resumed at F99. The same loss shows in E1 (F16-F27) and E3 (F32-F51). Nothing repeats, but Following has gaps.
- The generation counter lives on cs. contReset sets cs to null and the next contStart begins again at gen 1, so an answer that was on its way before a reload passes the `cs.gen === gen` check in the new run. In E1, a Following request in flight during a Home-tab reload was accepted by the new run: it set the cursor and cleared `resume`, so the promised 'newest page first' read after a reload never happened. Two of SimpleGram's requests could also end up in flight at once.
- Reload rule 4(c) uses only scroll position (less than 1 screen down a list longer than 3 screens). It misfires when one of Instagram's next pages lands after the user has gone to the top. Two ways this happens: B16's planned Home-tab fix sets scrollTop=0, and Instagram's own Home tab within 30 s calls scrollTo(0,0) without reloading. In E3 the page was taken for a reload, the continuation reset, and 20 Following posts were skipped. The rule also assumes Home's logged-in list loads only within 1 screen of the end. That is unverified: PolarisGenericVirtualFeed has enablePrefetch with PREFETCH_FEED_NEXT_PAGE_THRESHOLD=10, other feeds turn it off explicitly, and Home's PolarisVirtualFeed is not in the bundles. In E5 (mock with a 10-screen prefetch), a user reading the top two screens caused 38 resets and 115 SimpleGram plus 41 Instagram requests in 10 s, with nothing appended.
- Pacing has holes. CONT_PER_MIN counts only own pages that brought new posts, not pages that were all already seen, and restarts are not limited. seenBound is reset with every cs. A reset loop is therefore unbounded (E5). The claim 'at most 20 pages a minute' does not hold.
- When a reload is taken for a next page, the result is worse than 'wrong order'. The handover replaces Instagram's page with Following posts, so Relay replaces Home's whole list and Instagram's new Home posts are lost. In E4, a refresh with no scroll, and one with smooth scrollTo({top:0}) (still more than 2 screens down when the page arrived), both turned the list into F112...; NEW01 and NEW02 were never shown. Home's page 2, which carries the marker, then restarted Home and appended old Home posts after the Following ones.
- Gap in homeSeen: Home posts are recorded only while route()==='home' (onHome). A Home page that lands while a post is open is filtered but its posts are not recorded, so the continuation hands them over again. In E6, F03, F08, F13 and F21 were handed twice; only Instagram's draw-time dedupe (b102 client__feedDedupedIds) kept them off screen. The claim that 'the code sets guarantee' no duplicate is handed over is false. This bug already exists in 1.2, and it also weakens the card's skip list.
- False 'Home isn't loading more' card. While SimpleGram slowly skips posts already seen on Home, Instagram is not asked for pages (the buffer is empty and nothing nudges it), so 1.2's 15 s stall rule fires. In E7 (30 posts seen, Following answering in 4.5 s) the card showed with cont 'running', and posts F31... arrived after it. Tapping the card takes the user out of the seamless Home to the separate Following page.
- The request-shape claim is overstated. With the marker cut, getExtraVariables (b344) sends pagination_source feed_recs only when justknobx 2492 is on, and never sends a recs_paging_token (getPolarisFeedRecsPagingToken.next returns null when there is no marker). The website itself sends a token from the second page after the marker onward. So the post-marker requests are a shape the website can make, not the sequence it actually makes after 'caught up', and the server's answers to them are unknown. SimpleGram's Following request also lacks things Instagram's relay layer sends and the page can supply: X-Root-Field-Name (metadata.root_field_name, b385), X-ASBD-ID (getAsyncHeaders, b385), and the getAsyncParams body (__user, __a, __req, __hs, dpr, __ccg, __rev, __s, __hsi, __dyn, __csr, __comet_req, jazoest; b25). 'first:12 exactly as loadNext' is unverified: PAGE_SIZE=12 is a constant in PolarisFeedActionConstants, and the count Home's loadNext passes is in the logged-in PolarisFeedPage.
- B18 interplay gaps. R7's anchor covers only a first page that contains the marker. A Home first page of suggestions with no marker (B18 review case R2) still gives Instagram 0 posts, so it shows its empty-feed screen and never pages, and the continuation can never start. PolarisFeedContextProvider passes showEOFRecs (state set by logged-in code, probably the marker renderer) as the first argument of getPaginationSourceFromVariant. The B18 anchor, and the 'keep Instagram's marker as the divider' alternative, could put Home into end-of-feed-suggestions mode and draw the Following posts after it as suggestions. Only the phone can check this.
- The continuation has no end. The soft stop is only 'consider'. Following goes back indefinitely, much of it Reels, and B9 already lists WebView drawing memory with endless Reels as a suspect for the black feed. A limit must be part of the build, not optional.

### Revised design

Keep R7's route 2. After the marker, SimpleGram reads Following itself and puts those posts in place of the suggestions in Instagram's own next Home pages, in the data and before Relay sees them. Keep the marker cut, CFG.continueHome (default off), the fallback card (R6, Following only) and the divider. Change the following.

1. Tell a reload from a next page by what the page contains first, then by scroll. This replaces rules 4(b)-(d). A page arriving while fs.cont is set:
- contains a marker: it is a reload;
- contains a followed post that Home itself showed in this page load: it is a reload. Use a new set homeRanked (posts kept by Home's own filtering, not Following's), because a next page never sends back a post the list already has;
- has pagination_source 'feed_recs' and no marker: it is a next page, wherever the user is. On the phone, Home pages without a marker came with ps null, and the suggestion pages after the marker with ps feed_recs;
- otherwise (ps null, no marker): it is a reload only if it is one of the first two pages within 6 s of Instagram's scrollTo(0,0) with the user less than 2 screens down, or within 20 s of B16's homeTapAt, or 1.2's 'ended' rule applies. Otherwise it is a next page.
Drop the scroll-only rules (c) and (d), and never use scroll position while route() is not 'home'.

2. Never drop a followed post Instagram sent. Each handover first keeps the page's followed posts that are not in homeSeen, in Instagram's order, and adds them to homeSeen. It then appends up to one page from the Following buffer, with duplicates removed. A reload that is still misjudged then keeps Instagram's new posts (E4). The divider goes on the first Following post of each run.

3. State across resets:
- one generation counter for the whole page, incremented on every reset and start, so any answer from before a reset is dropped (E1);
- contReset keeps the unshown buffer and the cursor of the page in flight, not the cursor after the buffer. A restart reads Following's newest page, then the kept posts, then continues from the cursor (E1, E2, E3).

4. Pacing that holds across resets:
- every own request counts toward 20 a minute, whether or not it brought new posts;
- more than 4 starts in 60 s means 'failed' and the card;
- the bound on skipping seen posts applies per page load, not per cs;
- one request at a time, as now;
- a required stop after about 200 Following posts handed (or about 25 own requests) in one page load: end Home and show the card with 'Keep going in Following'.

5. Record Home posts in homeSeen by feed (fs.key==='home'), not by the current route (E6). This also fixes the card's skip list.

6. Stall: while the continuation is running and an own read is in flight or answered within STALL_MS, never show the stalled card (E7). MainActivity shows 'Skipping posts you saw in Home…' when the skip takes more than about 3 s.

7. Request fidelity:
- build SimpleGram's body with Instagram's own getAsyncParams('POST') (b25), and headers with getAsyncHeaders (X-FB-LSD, X-ASBD-ID), X-Root-Field-Name from params.metadata.root_field_name, X-CSRFToken and X-IG-App-ID; wrap all of it in try/catch and fall back to today's minimal set;
- keep parsing with nativeParse and never route these requests through Instagram's network layer;
- drop the Referer override.
State plainly in the ledger: the post-marker requests are feed_recs without a recs_paging_token (justknobx 2492 on) or carry no pagination_source (2492 off); the website sends a token from the second post-marker page on; and the feed_view_info / client_view_state Instagram sends with Home requests will list Following posts.

8. Arm synchronously at the marker, and only when both PolarisFeedTimelineRootV2Query.graphql and PolarisFeedRootPaginationCachedQuery_subscribe.graphql are loaded with params.id and providedVariables. Otherwise end with the 1.2 card.

9. Keep R7's failure states (failed, done, stalled, sent as feedEnd.cont), its B18 marker anchor (still unverified), the cut and the CSS divider. A first page of suggestions with no marker remains B18's to fix: R7 cannot start without a mounted list.

Diagnostics on top of R7's list (counts and shapes only):
- headWhy {marker, seen, jump, tap, ended};
- igKept;
- resets, kept-buffer size and starts per minute;
- peak own requests per minute;
- for every Home page, before and after the marker: screens from the end when it is parsed, and scroll height 1.5 s later. This shows Home's real paging distance (prefetch or not) and growth versus replacement;
- handovers that contained a code already in homeSeen (should be 0).

Phone checks on top of R7's:
- Home's paging distance (above);
- the answers to post-marker requests when the marker is cut: ps, kinds of item, has_next, and whether the cursor moves on;
- with the B18 anchor, whether the posts after the kept marker are drawn as 'Suggested'.

Prototype and evidence (the repo is untouched; git status is clean):
- revised script: /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf5/r7-review/proto/simplegram.rev4.js, built from the R7 prototype by make-proto2.py plus the stall rule; diff in rev4-vs-cont.diff in the same folder (about 100 lines). The stall rule is not in make-proto2.py: rev4 is rev3 (make-proto2.py's output) with one edit to checkFeedEnd's stall condition, so add that edit before regenerating rev4;
- experiments: /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf5/r7-review/tests/review.test.cjs (E1-E7), on copies of R7's harness with three additions: a reload without a Home tap (no scroll or smooth scroll), a prefetch distance, and a count of own requests in flight;
- outputs: /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf5/r7-review/out/.

Results:
- R7's prototype fails E2, E3, both E4 cases, E5, E6 and E7 (review-run1.txt, e6b-cont, e7-cont). E1 passes its 'one at a time' assertion but shows the stale answer accepted and 11 posts skipped.
- rev4: review experiments 8/8 (review-rev4.txt).
- R7's own 15 tests pass on rev3 and rev4 (r7-on-rev3.txt, r7-on-rev4.txt).
- Repo suite with the feature off: 124/124 on rev3 (suite-rev3-off.txt); not run on rev4, whose extra change only applies while the continuation is running.

Port E1-E7 into tests/ together with R7's tests.
