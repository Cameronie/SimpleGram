# B18 diagnosis: all feeds blank until restart

Investigator's diagnosis, then the skeptical review. Experiments referenced here lived in the session scratchpad and are not kept.

## Root cause (investigator, confidence: medium)

No storage carried the broken state from one page load to the next. SimpleGram's sg_skip_seen is used once and removed as every page starts. Instagram's client keeps no feed data across page loads. What actually blanked each feed was Instagram's own empty-feed screen. Instagram shows it when SimpleGram hands it a feed whose first page has zero posts.

How each blank happened:
- **Following (B17):** its first page has 3 items (getPolarisFeedInitialPageSize = 3), and the skip list removed all 3. Instagram got 0 edges with has_next still true.
- **Home after "You're all caught up":** a fresh 3-item first page can have nothing kept before the marker. endHome then hands over 0 edges with has_next false (experiment X3).

What the empty-feed screen does:
- PolarisFeedComponent renders the empty state instead of PolarisFeed: Favorites gets the star null state "Choose the accounts you can't miss out on"; Home and Following get the suggested-users list, which SimpleGram empties. Because PolarisFeed is not mounted, there is no paging and no spinner. That matches B17: 1 nudge, no second page.
- shouldShowStoryTray(variant, showEmptyFeed) returns false, so Home loses its Stories tray too.

Why it spread to every feed (the latch):
- The flag is useState(false) in PolarisFeedContainerLayout (b344). It sits inside PolarisFeedRoot, which is the root for every "/" variant (Home, Following, Favorites).
- Nothing in the public bundles ever sets it back to false. The code that sets it is in a logged-in-only module under PolarisFeedWrapper, and the list component that could clear it is the one that gets unmounted.
- Switching feeds inside the page (Instagram's "< Following" header link, the logo menu, the Home tab, or Back over Instagram's own history entries) keeps that root mounted:
  - routes render through the same entry-point root, keyed by tab key, not route key (CometMainRoutes, getCometRouterTabReactKey);
  - PolarisShell's usePolarisFeedVariantScrollRestore relies on usePrevious(variant) across switches.
- So once Following went empty, Favorites and Home in the same page showed the empty screen. Only a new page cleared it, which is what the restart did.
- A second in-page carrier: Instagram's Relay store keeps SimpleGram's altered feed per variant (parsed objects after our JSON.parse change: cut edges, has_next false). The feed entry point loads with options {}, so Relay's default store-or-network applies, and a revisit in the same page reuses that data without a new request.
- A latent SimpleGram bug makes in-page switches worse. filterFeedList picks the feed state and skip list from location.search when the response is parsed, and Instagram's router changes the address late. A Favorites or Home page parsed while the address still says ?variant=following is filtered as Following: seen posts removed, Home's marker not cut, paging not stopped (X2).

If Home was reached with Android Back instead, that is a new page and the latch cannot follow it. Home is then blank on its own, from the caught-up first page cut to 0 edges (X3). The server's caught-up state persists across loads, restarts included. The cut and the dropped marker do not persist on the client.

## Evidence

- B17 Copy details (notes/batch-4/following-blank-details.json): pages 1, seen 3, alreadySeen 3, kept 0, nudges 1, blank 4, suggestionsBlanked 2, s429/s5xx/pleaseWait 0, rendererGone 0, memoryWarnings []. Fresh counters mean Doc B was a new page. One nudge with no second page and no spinner fits PolarisFeed not being mounted.
- getPolarisFeedInitialPageSize.entrypointutils (b205): first page is 3 items when gkx 8953 is on. PolarisFeedRoot.entrypoint (b404): polarisFeedTimelineQuery has options:{}, so Relay's default store-or-network applies; variables are {data:{pagination_source for non-home,...}, first:3, variant}.
- PolarisFeedContainerLayout.react (b344): `f=c(!1),g=f[0],h=f[1]` is useState(false), passed as showEmptyFeed/setShowEmptyFeed to PolarisFeedContextProvider. No other code in the public bundles writes it (grep setShowEmptyFeed: only b344/b404 plumbing). The setter is in a missing logged-in module (PolarisFeedPage.react / PolarisFeedEmptySULWrapper.react).
- PolarisFeedComponent.react (b344): `if(showEmptyFeed){ if(variant==='favorites') return PolarisFavoritesFeedNullStateView; return PolarisFeedEmptySULWrapper }`, so PolarisFeed (the paging list) is not rendered. PolarisFeedUtils.shouldShowStoryTray(e,t): `t?!1:...`, so there is no Stories tray while the empty screen is up.
- The root stays mounted across feed switches: PolarisShell.react calls usePolarisFeedVariantScrollRestore (b314), which uses usePrevious(variant) to handle home↔variant. PolarisFeedWrapper and PolarisFeed use usePrevious(routeKey). CometMainRoutes keys main routes by getCometRouterTabReactKey (tabKey / entity key / '__main_tab'), never routeKey. CometRouteRootRenderer renders the entry-point root with no key.
- subscribeToPolarisRelayFeed (b385): on FEED_STATE_INIT with 0 edges it dispatches loadSULV2 (query xdt_api__v1__ayml__strict, alias ayml). SimpleGram's SUGGEST_KEY (simplegram.js:184) empties it, which fits suggestionsBlanked 2. The entry point's PolarisSuggestedUserListQuery uses the same root, so this alone does not prove it.
- Feed connection is per variant (PolarisFeedTimelineRootV2Query.graphql: handle connection, key PolarisFeedPage__xdt_api__v1__feed__timeline__connection, filters ['_variant']). It is filled from JSON already changed by our parse hook (simplegram.js:679-701), so stored records carry cut edges and has_next false.
- Instagram has no saved feed cache across page loads. sessionStorage users in the bundles hold only routeScrollPos (PolarisScrollPositionHistory b381, scroll only, saved only by profile tabs b83), IGTabId/TabId (IGWebSession b207 / WebSession b25, sent as __s by getAsyncParams), QPL saved state, NUX and support flags. IndexedDB is used only by messaging (MAWLogIndexedDb b140) and WA code (b342). Cache Storage holds only SW translations/logging/shared-data (b385), and the service worker is push-only (home.html: service-worker.js?s=push). PolarisFeedSeenStateManagerSingleton (b230) is an in-memory Map, sent as feed_view_info on next-page/refetch.
- SimpleGram's own storage cannot carry it. simplegram.js:343-350 reads and unconditionally removes sg_skip_seen at every page start; it is written only by continueFeed (354-358) from the native card, and the card shows only on Home (checkFeedEnd 801, 813). Experiments: X1 shows the key consumed at load; X5 shows a key written for Favorites discarded by a Following load (the 60 s window never matters); X6 shows no card on Following; X4 shows Favorites opened as a new page (menu: MainActivity 949-952 loadMain, i.e. web.loadUrl) inherits nothing (sessionStorage empty) and keeps its posts.
- Variant misattribution: filterFeedList uses currentFeed() and skipping() from location (simplegram.js:317-322, 351-353, 488, 530-531). X2: a Favorites page parsed under ?variant=following lost HOME002 and HOME001 to the skip list; a Home head parsed there came out as ['end_of_feed_demarcator'] with has_next true (not cut). The router changes the address late (notes/batch-3/diagnosis.md:1094).
- X3: a Home page at '/' with [ad, recs, marker, recs] is handed over with 0 edges and has_next false, and Home is ended and caught up. B16 shows Instagram's caught-up pages put recs/ads before the marker (pg 12 marker at index 3, pg 14 [kept, ad, marker]).
- Experiments: /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf4/b18/b18-replay.test.cjs (X1-X6, all pass on 1.2). Extracted Instagram modules: /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf4/b18/mods/

## Alternatives

- **Fresh-load-only explanation (no carry-over).** Each step was a new page: Back is web.goBack() across pages, and the menu uses loadUrl. Each feed went blank on its own: Following from the skip list, Home from a caught-up first page cut to 0 edges (X3). The restart then simply got a first page with a post before the marker. This fits Home, but not Favorites: a new-page Favorites keeps its posts (X4) unless the card's skip list happened to cover all 3 of its first items. Fixes 1 and 4 cover it either way.
- **Session-scoped server state** (low). The only session-scoped values Instagram sends are IGTabId/TabId inside the __s request parameter (getAsyncParams b25). If Instagram's server tied feed state to it, Menu → Refresh would not fix it but a restart would. There is no evidence for this.
- **Instagram throttling or empty server pages** (low). B17 shows no 429s, 5xx errors or "please wait" answers, and Following's page arrived with 3 posts. The trail's raw edge count ('in') would show 0 if the server sent nothing.
- **WebView renderer, GPU or bfcache** (low). rendererGone is 0 and memoryWarnings is empty; renderer trouble would not produce B17's exact counters. bfcache is not enabled (androidx.webkit 1.12.1, no setBackForwardCacheEnabled); pageshow.persisted in the trail would show it if it happened.
- **SimpleGram's other session keys** (ruled out). sg_search_state only restores with a history.state.sgSearch mark; sg_dead_requests and sg_search_opens concern search only. routeScrollPos (Instagram) holds scroll offsets only and is not restored on feed pages.

## Fix plan

Prototype, all tested: /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf4/b18/proto/b18-proto.diff (built by make-proto.cjs; tests in proto.test.cjs, P1-P6 pass). The full repo suite on the prototype gives 123 of 124 passing; the one failure is the intended change to "the marker as the very first item" test.

1. **Never hand Instagram an empty first page, for any feed.** "First page" means a feed's first page in this page load, or after a refresh reset.
   - Following and Favorites: if the skip list would remove everything, keep one anchor, the newest already-seen post. Coordinate with the B17 fix, which may choose a "you've seen these" marker instead. Later all-seen pages are still emptied.
   - Home: if nothing is kept before "You're all caught up", keep Instagram's own marker with group_set.groups = []. With no FEED_RECS group, polarisFeedReducer's m() does not advertise more. Paging stays stopped and the card still shows.
   - Track fs.handed per feed so this applies only while Instagram's list would otherwise be empty.
   - This removes the trigger for both loadSULV2 and the empty screen.
2. **Each page says which feed it belongs to.**
   - pageVariant(owner): pagination_source following / favorites / past_posts means that feed; feed_recs means Home; otherwise fall back to the address.
   - Use it for the feed state, homeSeen and the Home rules.
   - Apply the skip list only when skip.variant equals that feed.
3. **In-page switches between feeds become full loads.** In routeChanged: if the route is Home and feedVariant() differs from the feed this page last showed, call location.replace(location.href). That covers Instagram's header link, logo menu, Home tab and Back over its own history entries. Instagram's empty screen, its stored feed and SimpleGram's per-page state then never follow you to another feed. SimpleGram's own card and menu already open feeds as full loads, and there is a precedent for location.replace (reels-tab).
4. **Recovery.** On a feed route, visible, not searching, no dialog: if the current feed kept at least one post, the last page is older than 2.5 s, and no post (article / div[role=article]) is drawn on 2 checks in a row, reload once.
   - Guard: sessionStorage sg_feed_recover {path, at}, at most once per path per 3 minutes. Count stats.feed.recovered and recoverHeld.
   - A Home that only shows the caught-up marker has kept 0 posts, so it never reloads.
5. **Diagnostics that survive page loads**, counts and shapes only. Details are in phoneDiagnostics. Mirror them to native prefs so a restart doesn't erase them.

Order: 1 and 2 with B17; then 3 and 4; then 5. Run the full suite and the on-device tests after each step.

Open item: an Instagram refresh of an already-ended Home that brings no marker and no followed post still goes through the after-end branch (simplegram.js:503-512) and is emptied. Fix 4 covers the visible case (posts were kept, none drawn). Count these pages before deciding whether to anchor there.

## Risks

- **Anchors (fix 1)** show one already-seen post at the top of Following or Favorites. Agree the presentation with the B17 fix.
- **The neutralised marker** relies on Instagram's logged-in "caught up" component accepting group_set.groups = []. A crash would show Instagram's error page instead of a blank one. Test on the device before release.
- **Switch reloads (fix 3)** add about 1–2 s whenever you change feeds through Instagram's own controls. They also drop Instagram's in-page Home state when you go from Following back to Home with the "<" link; today Back already loads Home afresh.
- **Recovery reloads (fix 4)** depend on posts being drawn as article or div[role=article]. If Instagram changes that markup, the detector stays quiet rather than looping: it fires at most once per path per 3 minutes and only after posts were kept.
- **pageVariant (fix 2)** falls back to the address when pagination_source is missing. In that case the misattribution window remains, but fix 3 makes it irrelevant.
- **Uncertainty:** the code that turns on the empty screen is in a logged-in module we can't download. The latch is inferred from its owner (useState, never reset in visible code) and the mount structure, not observed.
- **Unproven:** the user's exact path (in-page vs. Back) is unknown. The plan covers both.

## Tests

- **Experiments on 1.2** (/tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf4/b18/b18-replay.test.cjs, all pass):
  - X1: B17 reproduced (pages 1, seen 3, kept 0, alreadySeen 3; 0 edges, has_next true; key consumed).
  - X2: misattribution under ?variant=following.
  - X3: a caught-up Home head is handed over with 0 edges and has_next false.
  - X4: a menu-opened Favorites inherits nothing.
  - X5: the key never outlives one page start.
  - X6: no card on Following.
- **Prototype tests** (proto.test.cjs, run with SG_SCRIPT=proto/simplegram.js, all pass):
  - P1: Following anchor kept, later all-seen pages still emptied.
  - P2: Home keeps the marker with groups [] and has_next false; Home is ended and caught up.
  - P3: a page's pagination_source decides its feed.
  - P4: an in-page switch triggers location.replace; a same-feed replaceState does not.
  - P5: one recovery reload, then held with no loop.
  - P6: no reload when posts are drawn.
- **Repo suite on the prototype:** 123 of 124 pass. The only failure is 'feed: the marker as the very first item ends Home and the card shows', whose expected keys change from [] to ['end_of_feed_demarcator'].
- **Tests to add for the real build:** an anchor after a refresh reset; the trail's shape (no names, codes or URLs); trail persistence across goto; switch reload from a non-feed route back to a different feed; recovery skipped while searching, while a dialog is open, or while the page is hidden.
- **On-device:** reproduce B16 → B17, then switch to Favorites and Home with Instagram's own controls (expect a fresh page and content). Check the caught-up marker draws with no groups.
- The repo was not modified (git status clean).

## Phone diagnostics

Only the phone can confirm these:
1. **How Favorites and Home were opened:** in-page through Instagram's header, logo menu or Home tab; through SimpleGram's menu (a new page); or with Back (a new page).
2. **What Favorites showed:** completely empty, or Instagram's star with "Choose the accounts you can't miss out on". The star is the latched empty screen. Also, whether the blank Home had a Stories tray: no tray means Instagram's empty-feed screen.
3. **Next time it happens, try Menu → Refresh before restarting.** Refresh (web.reload()) makes a new page but keeps sessionStorage. If Refresh fixes it, the cause lives in the page (latch or Relay store). If only a restart fixes it, the cause is session-scoped (sessionStorage/TabId or the server).
4. **Whether Following and Favorites pages carry pagination_source 'following' / 'favorites'.** Fix 2 needs this; it falls back to the address otherwise.
5. **Whether Instagram's logged-in "caught up" component draws cleanly with groups: [].** Test on the device.

Diagnostics that would settle it, counts and shapes only:
- **A trail of the last 30 events**, kept in sessionStorage (sg_feed_trail) and mirrored to native SharedPreferences so it survives a restart. Copy details includes it. Each feed page logs:
  - page number in the session, and how the page was opened (performance navigation type navigate / reload / back_forward; 'spa' for in-page address changes; 'bfcache' when pageshow.persisted)
  - feed by address and feed by page, plus pagination_source
  - edges in and out, kept posts, posts skipped as already seen, has_next in and out, and whether an anchor was used
- **Events in the same trail:** switch reloads, recover, recoverHeld, and an ayml (suggested users) payload arriving within 3 s of an empty first page, which means Instagram took the feed as empty.
- **A drawn sample 3 s after each feed page:** count of articles; Stories tray present on Home; favorites null-state icon present (svg[aria-label="Star outline icon in circle."], or the null-state text by shape); a spinner present.
  - Signature of the latch: SimpleGram kept posts in the data, but 0 articles are drawn, there is no tray, and the address changed in-page.
- **Developer check:** with a debug build over chrome://inspect, read the showEmptyFeed state on PolarisFeedContainerLayout with React DevTools after reproducing B17, then switch feeds in-page.

# Review (verdict: partly)

## Corrections

**What holds up (re-checked):**
- SimpleGram's own storage cannot carry the state. simplegram.js:343-350 reads sg_skip_seen and removes it at every page start. Only continueFeed (354-358) writes it, and the card only shows on Home (801, 813).
- X1-X6 and P1-P6 pass. The repo suite on the prototype gives 123/124; the only failure is 'the marker as the very first item'.
- These bundle facts match the investigator's reading: first page is 3 items (b205); options {} (b404); showEmptyFeed is useState(false) in PolarisFeedContainerLayout (b344); the PolarisFeedComponent empty branch and shouldShowStoryTray; loadSULV2 when the first page has 0 edges (b385); the feed connection's filters are ['_variant'].
- The feed root stays mounted across variant switches. PolarisFeedRoot dispatches selectFeedVariant when the variant changes, and PolarisShell's usePolarisFeedVariantScrollRestore uses usePrevious(variant).
- My own scan of sessionStorage, IndexedDB and Cache Storage users in all 419 bundles found no feed cache that survives a page load. Nothing persists the cut, has_next false or the dropped marker into the next load.

**1. The latch is not established.**
- The code that sets showEmptyFeed is in a missing logged-in module. "Nothing resets it" is absence of evidence.
- Counterweight: if the flag stuck for the whole root, stock Instagram would show the suggestions empty screen on Home for every user without favorites who opens Favorites (null state) and taps "< Favorites". That is a common path, so a reset probably exists in the code we can't see.
- What is certain for in-page revisits: Relay's store-or-network reuse of the per-variant connection, which SimpleGram has already altered.

**2. Fresh pages alone can produce all three blanks** (R1-R3 on 1.2, in /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf4/b18r/review.test.cjs).
- Favorites from the end card on a fresh Home that showed Favorites' 3 newest posts: 0 edges, has_next true. This is B17's skip on another feed, which the investigator rated unlikely.
- Home after Back, two shapes:
  - X3: [rec, ad, marker].
  - R2: [rec, rec, ad] with the marker on the next page, as in B16 pg 12 (marker at index 3). This gives 0 edges with has_next true.
- Only a Favorites page opened from SimpleGram's menu (loadMain, a new page with no skip) is unexplained by every SimpleGram mechanism. How the user opened it decides between latch, card skip and an outside cause.

**3. "Restart fixed it" is not explained on the Back path.**
- A restart doesn't change the server's caught-up first page, so there it was coincidence (different first page or new posts).
- On the in-page path, any new page (Menu → Refresh) would have fixed it.
- The diagnosis should say this.

**4. Evidence timing.**
- rendererGone 0, memoryWarnings [] and s429/5xx/pleaseWait 0 come from Copy details taken on the B17 Following page, before the Favorites and Home blanks. They rule nothing out for those.

**5. Minor.**
- suggestionsBlanked counts items, not lists: blankLists adds v[k].length.
- Home pages carry pagination_source null (B16 trail pg 9-11 and 13), so pageVariant falls back to the address on most Home pages.
- The cited note (diagnosis.md:1094) says the address waits while a route definition is fetched. A variant switch on the same '/' route probably has its route cached, so X2's window may not happen at all.

**6. A session-scoped carrier the list missed (low).**
- PolarisScreenTimeUtils (b314) writes these to sessionStorage, and a restart clears them:
  - ig_screen_time_sleep_mode_snapshot_v1_<id>
  - ig_screen_time_daily_limit_snapshot_v1_<id>
  - has_user_dismissed_* keys
- What reads them is in logged-in modules, and it would show a screen, not a blank page.
- A count of key-name prefixes would settle it.

## Missed causes

- Favorites blank on a fresh page through the end card: its skip list covers Favorites' 3-item first page (R1). Same mechanism as B17, no carrier needed.
- A Home first page [rec, rec, ad] with the marker on the next page gives 0 edges with has_next true (R2, on 1.2 and the prototype). B16 pg 12 shows Instagram puts the marker after three recs and ads.
- Instagram's own Home refetch after Home has ended is emptied by the after-end branch. That is an in-page path to a blank Home that needs no latch.
- The restart may have fixed nothing. On the Back path the server's caught-up first page is unchanged by a restart, so recovery was timing or a different first page. Only a Refresh-vs-restart test tells these apart.
- Instagram's screen-time snapshots in sessionStorage (ig_screen_time_*_snapshot_v1_*, has_user_dismissed_*, from b314) are session-scoped and cleared by a restart. Low likelihood (teen, supervised or daily-limit accounts, and they show a screen rather than a blank page), but cheap to rule out.
- An outside cause for a Favorites page opened from SimpleGram's menu, such as server throttling after B16/B17. The only throttle counters (s429/s5xx/pleaseWait 0) were taken before that page loaded.

## Problems in the fix plan

- Fix 1 is incomplete. R2: a Home first page [rec, rec, ad] with no marker and has_next true is still handed over with 0 edges in the prototype (anchors 0). R3: a Following first page dropped for reasons other than 'already seen' (ads, suggestions) also gets 0 edges. In both cases fix 4 never fires, because kept is 0 (R6), so a realistic caught-up Home stays blank.
- The after-end branch (simplegram.js:503-512) still empties pages. Once has_next false has been handed, Instagram makes no next-page request, so a page arriving there is a first page or refetch that replaces the list (Home-tab refresh after 30 s, shouldRefreshOnHomeClick b314, or pull to refresh). Emptying it blanks Home in the page. The plan leaves this to fix 4 instead of anchoring it.
- The neutralised marker keeps group_set.active_group_id 'feed_recs' while groups is [] (R4). If Instagram's logged-in caught-up component looks up the active group, it could throw into the fatal CometErrorBoundary around PolarisFeedComponent (PolarisHttp500UnexpectedErrorPage). Set active_group_id to null too. It also shows the caught-up text twice, Instagram's line and the native card.
- Fix 4 can loop. The guard is per path per 3 minutes, and R5 reloads 3 times in about 9 minutes when posts are on screen but in markup the POST selector misses. A periodic reload is worse than the blank.
- Fix 4 only acts on 'posts kept but none drawn', which is the unverified latch. None of the observed or reproduced blanks (B17, X3, R1, R2) qualify, because each kept 0 posts.
- Fix 3 is worth keeping, since the Relay store reuse is certain even if the latch isn't. But it needs a bound: at most one switch reload per page, and none if the reloaded page switches again within about 2 s. P4 tests one hop only. Each switch costs one wasted feed request plus a reload.
- Anchors widen B17's all-seen paging. With one post on screen, Following pages through up to min(60, max(15, ceil(seen/10))) all-seen pages, paced only by nudges (10 a minute). That can mean minutes of a single post and up to 60 requests. Lower the cap, or end Following with the card once it runs into seen posts.
- pageVariant is not a fix for Home misattribution. Home pages carry pagination_source null, so the address fallback is normal there. The X2 case is covered only by fix 3.

## Revised fix plan

**0. Diagnostics first** (ship with 1). Counts and shapes only. Mirror every entry to native SharedPreferences as it is written, so a restart keeps it, and include it in Copy details.
- Per feed page:
  - page number, navigation type, and 'spa' for in-page address changes
  - feed by address and feed by page (pagination_source)
  - edges in and out; kept, skipped, ad and suggestion counts
  - marker index; has_next in and out
  - anchor kind (seen / marker / none); whether it was the first page or came after the end
- A drawn sample 3 s later:
  - number of posts drawn
  - Stories tray present
  - Favorites star null state present (svg aria-label "Star outline icon in circle.")
  - suggested-users list present
  - Instagram header and nav present, and a requestAnimationFrame heartbeat, to tell an empty feed from a white WebView
- A count of sessionStorage key-name prefixes (ig_screen_time*, IGTabId, routeScrollPos, other).
- On the native side: page starts since the process started, split by loadUrl, goBack and reload.

**1. Never hand any feed an empty list** (with B17). This applies to:
- a feed's first page in this page load;
- any first page after a refresh reset;
- every Home page that arrives after the end. Paging is already stopped then, so such a page is a refetch that replaces the list; anchor it instead of emptying it at simplegram.js:503-512.

Anchor, in this order:
1. Following/Favorites: the newest already-seen post. Paging stays on.
2. This response's own marker, neutralised: groups = [] and active_group_id = null. Paging stops and the card shows.
3. Home with neither, as in R2:
   - (A) a clone of the last real marker seen in this page, neutralised, with paging stopped; or
   - (B) keep the first dropped explore_story unit (never an ad) and collapse it in the DOM before paint, with paging on.
   - Pick A or B only after the trail shows how often this shape happens, and check on the device which one Instagram draws cleanly.

Tests: X3, R2, R3, a refetch after the end, an anchor after a refresh reset, and the full suite. Also lower the all-seen paging cap (about 15 pages), or end Following with the card when it runs into seen posts.

**2. pageVariant as proposed**, keeping the address fallback. Home pages carry pagination_source null.

**3. Switch reload as proposed.** It also covers Relay reusing a feed SimpleGram already altered.
- At most one switch reload per page.
- Count switchLoads, and count a second one within 2 s without reloading.

**4. Recovery, narrowed.**
- At most once per path per app session.
- Only after the POST selector has matched at least once this session.
- Never while the native card or the anchored marker is the content.
- Also trigger on Instagram's empty-screen signature (star or suggested-users list) when SimpleGram handed this feed at least one edge.
- Count recovered and recoverHeld.

**Order:** 0+1+2 together, then 3, then 4. Run the full suite and the device checks after each step.

**Only the phone can confirm:**
- How Favorites was opened: Instagram's logo menu, the end card, or SimpleGram's menu.
- How Home was reached: Back, Instagram's Home tab, or the "<" link.
- What the screens showed: the star or a fully empty page for Favorites; whether the end card and the Stories tray showed on the blank Home.
- Next time it happens, try Menu → Refresh before restarting: a fix by Refresh points to the page (latch or Relay store); no fix by either points to the server's first page.
- Whether Instagram draws the neutralised marker cleanly.

**Files:**
- Experiments: /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf4/b18r/review.test.cjs
- Bundle module grep helper: /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf4/b18r/mod.cjs
- The repo was not modified.
