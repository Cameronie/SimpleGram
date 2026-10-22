# B16 / B17 diagnosis

Investigators' diagnoses and both reviews. Scratchpad paths refer to experiments from the diagnosis session; they are not kept.


######## B16

--- rootCause
Pages 13 and 14 were not "next pages". They were two reloads of Home's first page (head loads), and Instagram's Relay store replaced Home's whole list with the last one. has_next_page=false only stops next-page loads (loadNext). It never gates a reload. SimpleGram's code did not cause the jump.

Sequence:
1. Page 12 was a normal next page, cut at the marker by endHome (simplegram.js 434). stopPagination (445) set has_next_page=false and endFeed (446) set ended/caughtUp. Instagram's list kept its 15 kept posts, and Home showed the end card.
2. Something then made Instagram reload Home. The likeliest trigger is the Home tab:
   - b314 usePolarisOnHomeClick: if more than 30 s have passed since the last head load, it calls go('/',{passthroughProps:{refreshFeed:true}}). It always calls window.scrollTo(0,0).
   - On mobile that one navigation runs two effects. b344 PolarisFeed.react calls window.scrollTo(0,0) and refetch() (head query A, first=3, carrying feed_view_info). b344 PolarisFeedWrapper.react calls window.scrollTo(0,0) and refetchFeed() (head query B, in a transition; meanwhile PolarisFeedComponent shows the glimmer instead of the list). b381 hasRefetchRelayFeed() = isMobile().
   - This is the only path in the downloaded code that sends two head loads at once and jumps to the top.
3. Relay's ConnectionHandler (b385) replaces the edges whenever a page is loaded with after==null (T=E). It appends only when after==end_cursor. It also copies the connection's other fields, including pagination_source, on every update. The root query and the refetch query share one list ("PolarisFeedPage__xdt_api__v1__feed__timeline__connection", filtered by _variant), so the last head answer wins.
4. Page 13 is the first head load. It has 3 posts plus 1 ad, matching getPolarisFeedInitialPageSize()=3 (Following's first page also had 3 posts). Normal next pages had 6 items plus 2 ads (pages 9–11). These were the top of Home, so the user had seen them earlier ("a friend's post I previously saw").
   - SimpleGram's after-end rule (498–504) saw a new cursor and a followed post, counted a refresh (refreshes 1) and reset Home's state.
5. Page 14 is the other head load: 1 post, an ad, then the marker. The server tags any page that carries the marker with pagination_source 'feed_recs' (pages 12 and 14 have it, every page without a marker has null), so this is a label, not an echo of the request.
   - endHome cut it at the marker (eof 2) and ended Home again. Relay put that 1 post in place of everything.
   - The user was already at the top because of Instagram's scrollTo(0,0). With a 1-post list the bottom is in view, so checkFeedEnd showed the card.

What page 13 is not:
- **Instagram's past_posts list:** it can only be opened from the marker's groups (b385 PolarisFeedActionBuildPastPostsAction reads groups.past_posts), and SimpleGram drops the marker. Its pages would carry ps past_posts, and these pages were logged under variant home.
- **The recs feed shown after the marker:** that is a loadNext with pagination_source feed_recs, which returns explore_story items. Page 13 holds followed, organic posts with ps null.

What SimpleGram did not do:
- The reset touches only SimpleGram's own state.
- Nudges never run once Home has ended (745), and page 13 had 3 kept posts, so none ran.
- Removing the end spacer can move the page by at most 170 px.
- SimpleGram never scrolls Home to the top and never navigates to '/'.

Should SimpleGram clear connection.pagination_source='feed_recs' on the marker page? No.
- It is only read by getExtraVariables (b344, for next pages) and by redux paginationInfo.
- Reloads send FEED_TIMELINE_REQUEST_BODY without it, and a reload overwrites the field anyway.
- Clearing it would turn any next page after the end from a recs page (which SimpleGram blanks while staying ended) into a page of friends' posts that the refresh rule would take for a refresh.

What only the phone can confirm:
- That the trigger was a Home-tab tap. Other possible triggers live in logged-in modules that are not in the downloaded bundles: PolarisFeedPage.react and PolarisLightweightNewPostsPill.react (a new-posts pill, maybe acting when the app returns from the background).
- That both head requests were actually sent. Query A may be cancelled when the list is swapped for the glimmer, but its answer would still pass through SimpleGram's parse hook.

--- evidence
[
 "Phone ring (/home/user/SimpleGram/notes/batch-4/home-jump-details.json). Page 12: [x,x,ad,end@3], ps feed_recs. Page 13: [kept,ad,kept,kept], ps null. Page 14: [kept,ad,end@2], ps feed_recs. nx is true on all three. nx is hasMore(owner) read before endHome changes the page (unitContext, simplegram.js 469). eof 2, afterEnd 0, refreshes 1, lastPageKept 1.",
 "Experiment, reproduced exactly. With 1.2 (SG_SCRIPT=scratchpad/wf4/b16/proto/simplegram.1.2.js), /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf4/b16/tests/b16.test.cjs uses a mock Home that follows Relay's ConnectionHandler and the mobile Home-tab path. Output (run-1.2.txt): ring '3:3:e:end:feed_recs 3:0:x:suggested 3:1:x:suggested 3:2:a:ad | 4:0:m:kept:null 4:1:a:ad 4:2:m:kept 4:3:m:kept | 5:2:e:end:feed_recs 5:0:m:kept 5:1:a:ad'. Counters: eof 2, refreshes 1, afterEnd 0. Afterwards codes ['NEWPOST'], y 0, ended true, card on. This is the phone's sequence for pages 12\u201314.",
 "b314 usePolarisOnHomeClick: 'r(\"shouldRefreshOnHomeClick\")(t)?i==null||i.go(u,{passthroughProps:{refreshFeed:!0}}):(n(a),l()),window.scrollTo(0,0)'. shouldRefreshOnHomeClick: 'var e=3e4;...return n>e'. It is wired to the Home tab in PolarisFeedNavItem.react (href FEED_PATH, onClick \u2192 h()).",
 "b344 PolarisFeed.react effect: 'routeKey!==h&&h!=null&&refreshFeed===!0&&o(\"PolarisPanavisionQEHelpers\").hasRefetchRelayFeed()===!0){window.scrollTo(0,0),...k({data:e,variant:String(i)})'. b344 PolarisFeedWrapper.react: '...T!==!0&&refreshFeed===!0&&(window.scrollTo(0,0),x())', where x = usePolarisRefetchFeedQueryLoader 'i(function(){c({data:e,variant:String(m)})})'. b381: 'function c(){return!!o(\"PolarisUA\").isMobile()}...l.hasRefetchRelayFeed=c'.",
 "b385 relay-runtime/handlers/connection/ConnectionHandler: 'L.copyFieldsFrom(_)' runs on every update. 'if(D.after!=null){...}else if(D.before!=null){...}else T=E' means a load with after==null replaces the edges. 'if(D.after==null&&D.before==null)v.copyFieldsFrom(f)'. b385 RootV2Query.graphql and b102 RootPaginationCachedQuery_subscribe.graphql both have 'filters:[\"_variant\"],handle:\"connection\",key:\"PolarisFeedPage__xdt_api__v1__feed__timeline__connection\"', so both queries write to the same list.",
 "Page size. b205: 'var e=3;function s(){return r(\"gkx\")(\"8953\")?e:null}'. b404 entrypoint: 'first:...getPolarisFeedInitialPageSize()'. Page 13 has 3 posts and 1 ad with has_next true. Pages 9\u201311 each have 6 items and 2 ads (ads at i=2 and i=7). Following's first page had 3 posts.",
 "b385 useLoadMoreFunction(_EXPERIMENTAL), with ENABLE_ACTIVITY_COMPATIBILITY=!0: loadMore has no hasMore guard ('if(I.current.kind===\"fetching\"||W)return'). Whether has_next_page=false stops paging depends on PolarisFeedPage.react, which is logged-in only and not downloadable: the rsrcMap in /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/ig/html/home.html lists no JS beyond the 418 already fetched. The phone's afterEnd 0 fits with it being stopped.",
 "Ruled out as triggers:\n- **Background fetch:** b385 ConsumerEntrypoint runs PolarisBackgroundFeedDataFetchEager only at document start, when the landing path is not '/'.\n- **past_posts:** b385 PolarisFeedActionBuildPastPostsAction builds it only from 'e.groups.past_posts', which come from the marker.\n- **feed_recs:** b404 getPaginationSourceFromVariant and b344 getExtraVariables feed only next-page variables. The reload body is FEED_TIMELINE_REQUEST_BODY (b385 PolarisFeedQueryConstants), which has no pagination_source.",
 "simplegram.js 1.2:\n- After-end rule 498\u2013514: a new cursor plus a marker or a followed post triggers freshFeed.\n- endHome 424\u2013447.\n- scheduleNudge returns when ended (745).\n- endRoom adds/removes a 170 px spacer under body (786\u2013797, 818).\n- The click interceptor (2059\u20132086) already swallows Search-tab taps with stopImmediatePropagation.\n- SimpleGram has no scrollTo(0,0) and no navigation to '/' on Home.",
 "Prototype fix (/tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf4/b16/proto/b16-prototype.diff), results in run-fix.txt:\n- A tap while scrolled down keeps the 7 posts, sends no requests, Home stays ended, y goes to 0 and the card hides.\n- A second tap at the top lets Instagram reload: headA+headB, NEWPOST shown, homeTapRefresh 1.\n- An unrequested reload of repeats keeps 3 posts with has_next false and ended true (repeatPages 1).\n- A post Home hasn't shown still counts as a refresh.\n- The full suite passes 124/124 with SG_SCRIPT=the prototype (run-suite-fix.txt)."
]

--- confidence
medium

--- fixPlan
Prototype: /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf4/b16/proto/b16-prototype.diff, against 1.2 simplegram.js (72 lines). It sends no new requests; it only removes some.

1. **The Home tab first goes to the top. Only a tap at the top lets Instagram reload.** This is the main fix.
   - Add homeTap(e,a) inside the existing capture click listener (2059), before the Search-tab check.
   - It acts when:
     - the tapped link's pathname is '/' and location.pathname is '/';
     - route()==='home' and feedVariant()==='home';
     - search is closed and no result is opening (!search.open && !leaving).
   - If scrollTop > 8 px: preventDefault, stopPropagation and stopImmediatePropagation, then set scrollTop=0 and count stats.feed.homeTapTop.
     - Instagram's onClick never runs: no reload, no new-posts check, no second head query.
     - The loaded list and fs.ended stay. The card hides because the bottom is out of view.
   - If already at the top: let the tap through (Instagram reloads if more than 30 s have passed), set homeTapAt=Date.now() and count homeTapRefresh.
   - This matches the native app. It also applies when Home has not ended, so a tap mid-feed never throws away the loaded list.
   - A narrower variant is to swallow the tap only while fs.ended.
   - Taps from other routes or variants are not touched, and neither are taps while search is open or a result is opening (the cancel-to-origin listener at about 3064 still runs).
2. **After the end, repeats don't reopen Home** (hardening in filterFeedList 498–514). When fs.ended and the cursor is new:
   - If any of these hold, start over as 1.2 does:
     - asked: homeTapAt is within 20 s;
     - fresh: a followed post not yet in homeSeen;
     - the page has a marker.
   - Else, if the page has followed posts but all of them were already shown on Home: count stats.feed.repeatPages, call stopPagination(owner), keep fs.ended, and filter the page normally.
     - The posts are kept, never emptied: if Instagram is replacing its list with this page, emptying it would blank Home.
     - Paging can't walk back through what the user saw.
   - Else: blank the page (1.2's afterEnd path).
   - Genuinely new posts and an explicit refresh still show everything.
3. **No change to connection.pagination_source.** Do not clear it (see rootCause).
4. **Leave the rest alone:** the endHome marker cut, the end-room spacer, nudges, and the refresh test with new codes.
5. **Ship the diagnostics below in the same build.** If the phone shows a reload with no Home tap, find that trigger (for example Instagram's new-posts pill or a return from the background) and give it the same scroll-first treatment there. Rejected approaches are listed under alternatives.

User rule: record only; build on "Apk it".

--- alternatives
[
 "Page 13 was a next page sent even though has_next_page was false, with pagination_source null (Relay's loadMore has no hasMore check, so the check is up to PolarisFeedPage). It would have returned older friends' posts, seen on earlier days, and been added at the end ('a post coming up'). Page 14 would then have been a separate reload. This is less likely: it needs two unrelated events, and page 13's size (3 posts and 1 ad) matches a first page, not a 6+2 next page. Fix 2 doesn't cover it, because older posts are not in homeSeen.",
 "Another refresh path in logged-in-only code: PolarisLightweightNewPostsPill.react (tap, or acting when the app comes back from the background; it records SET_DOCUMENT_VISIBILITY_HIDDEN_TIMESTAMP), or pull-to-refresh in PolarisFeedPage.react. Neither is in the downloaded bundles. Fix 1 would not cover these.",
 "Ruled out:\n- **past_posts (Older posts) list:** it can only be opened from the marker's groups, which SimpleGram removed. Its pages would carry ps past_posts, and these pages were logged under variant home.\n- **Recs feed after the marker (setShowEOFRecs/FEED_RECS):** page 13 is followed, organic posts with ps null.\n- **PolarisBackgroundFeedDataFetchEager:** runs only at document start on a non-feed path.\n- **SimpleGram itself (state reset, nudges, spacer, scroll):** see rootCause.",
 "Rejected fixes:\n- **Re-inserting Home's old posts into the reloaded page:** replays stale data into Relay's store, costs memory, and Instagram has already scrolled to the top.\n- **Blocking or aborting the reload through XHR hooks:** ghost_owl checks for shimmed XHR (b25 GHLDetectionUtilsPreludeSafe isXHRResponseGetterShimmed and send() stack checks), and Relay would be left in an error state.\n- **Blanking a reloaded first page:** Relay replaces the list, so Home would be empty.\n- **Clearing pagination_source:** no effect on reloads, and it makes a next page after the end look like a refresh."
]

--- phoneDiagnostics
Phone-only questions:
- Did a Home-tab tap come right before page 13?
- Were both head requests sent?
- Does PolarisFeedPage respect hasNext?

Add to Copy details, shapes only:
1. **Home events ring** (last 30). Each entry has t = ms since page load, rounded to 100 ms.
   - Home-tab taps: y bucket (top / mid / end), and whether SimpleGram swallowed or passed the tap.
   - visibilitychange: hidden/visible, and how long the page was hidden.
   - Jumps to the top: a scroll from more than 1 screen down to under 10 px with no touch active.
   - Route changes away from and back to Home.
2. **New fields in each feedUnits entry:**
   - dt: ms since the previous Home page;
   - y: scroll bucket when the page arrived;
   - seen: number of the page's followed posts already in homeSeen;
   - hp: has_previous_page and whether start_cursor is present, as sent.
3. **repl, 1 s after each Home page:** posts on screen before vs after, and whether the first post's link changed. True means Instagram replaced its list (a reload).
4. **Counters:** homeTapTop, homeTapRefresh, repeatPages.

How to read it:
- A passed Home tap at y=end, then within about 1 s two pages with seen≥3 and repl true: the Home tab is confirmed.
- No tap, but a visibility return or a jump with no touch just before: another path. Fix that trigger.
- A page arriving at y=end with repl false after the end: Instagram is loading next pages despite has_next_page=false (the first alternative).

Manual check on the phone with 1.2: scroll Home to the end card, tap the Home tab once, and see whether it reloads to a short list.

--- risks
- **Behaviour change:** one Home tap no longer reloads when scrolled down. Reloading takes a tap at the top, like the native app.
- **The swallowing assumes** Instagram's Home tab is an a[href="/"] that navigates from a React click handler, the same assumption as the Search-tab interception that works on the phone.
- **If the real trigger is not the Home tab,** Fix 1 does nothing for B16. A reloaded page that carries the marker would still swap Home to its few posts, because nothing on the data side can keep Relay's old list. The diagnostics are needed to find out.
- **Repeat rule:**
  - An unrequested reload of posts the user already saw shows those few posts with the card and stops paging, until the user taps Home at the top.
  - Older posts from earlier days are not in homeSeen, so they still reopen Home, as in 1.2.
- **20 s window:** an explicit reload slower than 20 s is judged by the fresh/marker checks instead (still correct in the common case).
- **Interplay with B17/B18:** none directly. Fewer reloads means homeSeen and ended states stay stable.

--- tests
Port /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf4/b16/tests/b16.test.cjs into tests/feed.test.cjs. Its mock Home follows Relay's ConnectionHandler (a load with after==null replaces the list, after==end_cursor appends), and the Home tab behaves like usePolarisOnHomeClick (30 s rule plus two head loads plus scrollTo(0,0)).

1. Ended Home, scrolled down, tap Home. The list (7 posts) stays, no requests are sent, Home stays ended, y=0, card off.
2. A second tap at the top sends headA+headB and shows the friend's new post. refreshes 1, homeTapRefresh 1.
3. An unrequested reload of posts Home already showed keeps its posts with has_next_page false, ended true, repeatPages 1.
4. An unrequested page with a followed post Home hasn't shown counts as a refresh (has_next true, ended false).
5. A tap within 8 px of the top is left to Instagram.
6. To add: the Home tab on ?variant=following and during a search open or result open is not swallowed. The existing search-open tests already cover the second part.

Results:
- 1.2: the B16 test reproduces the phone (ring, eof 2, refreshes 1, 1 post).
- Prototype: 4/4 pass, and the full suite passes 124/124 with SG_SCRIPT pointing at /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf4/b16/proto/simplegram.fix.js.
- Nothing in /home/user/SimpleGram was changed.

On the phone: reach the end card, tap Home (the feed should stay, at the top), tap Home again at the top (it should reload), then send Copy details.


######## B17

--- rootCause
The skip in 1.2 removed every post from Instagram's 3-post first page. With an empty first page, Instagram's feed never asks for another page, and 1.2's only way to make it page is a single nudge, which cannot get past this.

1) The first page really is this small. Every feed variant's first request asks for 3 items (b404 PolarisFeedRoot.entrypoint `first: getPolarisFeedInitialPageSize()`, which is 3 when gkx 8953 is on). The phone saw exactly 3, all of them already seen in Home (19 kept on Home). simplegram.js:530/537 dropped all 3 as alreadySeen.

2) Instagram treats an empty first page as an empty feed, not as a page to scroll past. b385 subscribeToPolarisRelayFeed: on the first page, `m.length===0` triggers loadSULV2, a suggested-accounts request whose results SimpleGram blanks (suggestionsBlanked 2 on the phone). b344 PolarisFeedComponent.react: when showEmptyFeed is set, the feed list (PolarisFeed) is replaced. Favorites gets PolarisFavoritesFeedNullStateView ("Choose the accounts you can't miss out on"). Everything else gets PolarisFeedEmptySULWrapper, whose account list SimpleGram empties, so the page is black. No list means no loadNext and no spinner, which matches the screenshot.
   - The code that sets showEmptyFeed is logged-in only (PolarisFeedPage) and not in the bundles. This is H1 and it is not fully proven.
   - H2 is the fallback: the list mounts with 0 items. Instagram's lists page only from scroll events. b32 PolarisIGVirtualList calls onScroll only from a window scroll and does not call it when the item count changes. PolarisGenericVirtualFeed loads when numScreensFromEnd <= 1 and shows a spinner while hasNext. An empty page cannot scroll, so the user cannot trigger it.

3) The nudge fires once. After the empty page, simplegram.js:565 scheduled one hard nudge, 600 ms later (lines 740-778). There is no retry, and a capped nudge is dropped (line 750). The end card's button does a full page load (location.assign, line 358), and Instagram's feed page component is deferred. So that one nudge most likely fired before the list existed (H2), or there was no list at all (H1). Nothing ever re-arms it, which gives nudges 1, pages 1, blank 4.

The pad trick is not broken: in experiments, once a list is mounted, both the synthetic scroll events and the pad work. The VLIST port in tests/feed.test.cjs, and the C1 review experiment built on it, missed this because the list is always mounted and pages on any scroll event.

Favorites hits the same code path:
- Under H1 it shows Instagram's misleading "Choose the accounts…" view.
- Under H2 it is blank with a spinner.

Two more problems turned up for heavy Home sessions (review fix C1):
- Paging past seen posts relies on one nudge per empty page. The 10-a-minute nudge cap stops it for good after 10 pages, so the screen stays blank, or shows only the anchor with the fix.
- The seen-page cap, ceil(seen/10) pages (line 560), assumes 12-post pages. With 8-post pages, which matches Home's observed 8 units per page, Following ends before reaching any new post.

--- evidence
[
 "Phone (notes/batch-4/following-blank-details.json): feed pages 1, seen 3, kept 0, alreadySeen 3, nudges 1, blank 4, suggestionsBlanked 2, streamed 0, errors 0. No second page was ever parsed. The screenshot shows a black page and no spinner.",
 "b404 PolarisFeedRoot.entrypoint getPreloadProps: `l=i!=null&&i!==\"home\"?{pagination_source:String(i)}:{}` ... `first:o(\"getPolarisFeedInitialPageSize.entrypointutils\").getPolarisFeedInitialPageSize(),variant:...`. b205/b314 getPolarisFeedInitialPageSize: `var e=3;function s(){return r(\"gkx\")(\"8953\")?e:null}`. So the first page is 3 items for home, following, favorites and past_posts alike. Later pages on the phone's Home carried 8 units (feedUnits i=0..7 on pages 9-11), not 12.",
 "b385 subscribeToPolarisRelayFeed: `p?(m.length===0&&(!r(\"justknobx\")._(\"6493\")||!r(\"gkx\")(\"25302\"))&&n(o(\"PolarisUserActionLoadSULV2\").loadSULV2({environment:i,isPaginatedCall:!0})),n(...FEED_PAGE_LOADED_V2)):m.length!==0&&n(...FEED_NEXT_PAGE_LOADED_V2)`. Instagram's own data flow treats an empty first page as an empty feed and fetches suggested accounts, which SimpleGram blanks via SUGGEST_KEY (simplegram.js:184).",
 "b344 PolarisFeedComponent.react: `if(l){if(d===\"favorites\"){...PolarisFavoritesFeedNullStateView.react...}return s.jsx(u /*PolarisFeedEmptySULWrapper*/,...)}if(i!=null&&n!==!0){...PolarisFeed.react...}`. b344 PolarisFeedContainerLayout: `f=c(!1),g=f[0],h=f[1]` passed as setShowEmptyFeed/showEmptyFeed to PolarisFeedContextProvider. b404 PolarisFeedVariantsStrings: \"Choose the accounts you can't miss out on\", \"Add accounts to your favorites\u2026\", \"No posts yet\". The caller of setShowEmptyFeed is logged-in code that is not in the bundles, and no resource map lists it.",
 "b32 PolarisIGVirtualList: componentDidUpdate `this.props.itemCount!==t.itemCount&&this.$6()` measures but does not call onScroll. onScroll only runs via `$7=function(){this.$6().then(this.props.onScroll)}` from the window scroll listener ($16). onInitialize runs once at mount. PolarisGenericVirtualFeed (scratchpad/bundles/1d0d19b3.js): onScroll is throttled 250 ms, `h&&!i&&(c<=j?...k(...)` with FEED_NEXT_PAGE_THRESHOLD=1 and no onInitialize. The spinner `$4` returns null only when `!hasNextPage&&!isFetching`. IGDSSpinner (b207) has role=\"progressbar\".",
 "simplegram.js: 530 `const seenCodes = skipping();` and 537 drops seen posts. 556-565: keptMedia===0 && more \u2192 seenStreak cap (560: `Math.min(60, Math.max(15, Math.ceil(seenCodes.size / 10)))`) \u2192 a single scheduleNudge(true). 740-778: the nudge fires once after 600 ms with no retry, and 750 drops a capped nudge without re-arming. 354-358: continueFeed uses location.assign (full load, so the list mounts late). 801: the card only shows for variant home, so Following and Favorites get no message.",
 "Experiment harness (scratch wf4/b17/igmock.js + exp.cjs): a model of Instagram's feed page built from the bundle facts above, running the real 1.2 script and patched copies. 1.2 with H1 reproduces the phone exactly: 1 request, 1 nudge, suggestionsBlanked 2, empty view, no spinner, blank for the whole run. Favorites shows \"Choose the accounts you can't miss out on\". 1.2 with H2 and the list mounting 1.5 s after the data is blank with a spinner and 1 request. 1.2 with H2 and an immediate mount pages fine, which is the case the VLIST port and the C1 review modelled.",
 "S1 (phone case: 19 seen, 3-post first page, 8-post pages, 800 ms per page, list mounts after 1.5 s, user idle or reading): anchor only (A) stays at 1 post plus spinner forever (1 request) because its soft nudge fires before mount and a 1-post page cannot scroll. Anchor + retrying nudge (AR/ARX): 1 repeat, first new post at 5-6 s, under both H1 and H2. Skipping from page 2 onward (F): 3 repeats, new post in view at 10.5 s. No skip (N): 19 repeats before anything new. Retry without anchor (R): still blank under H1.",
 "S4 (first page = 2 seen + 1 new): 1.2 with a delayed mount is stuck at 1 post plus spinner (the soft nudge is lost). The retrying nudge fixes it.",
 "C1 (190 seen, 800 ms per page): 1.2 and A stall after 10 nudges (nudgesCapped 1, 11 requests, blank or anchor only). AR (cap re-arm only): first new post at 67.8 s. With paging past seen posts exempt from the cap and a 200 ms nudge (ARX/ARSX): 16-17 s at 800 ms and 29.8 s at 1500 ms latency. With 8-post pages (S2_8), the C1 page cap of 19 ends Following after 20 requests with only the anchor shown (ended:true). A seen-count bound (ARSXC) reaches new posts at request 25.",
 "Proposed tests (scratch wf4/b17/b17-proposed.test.cjs, using the real tests/helpers.cjs): 0/5 pass on 1.2 and 5/5 on the fix (ARSXC). The repo suite on the fix is 123/124: only 'feed: paging past posts already seen stops after 15 pages, not 40' fails, as expected, since the anchor and the new bound change its premise. The baseline on 1.2 is 124/124. The repo was left unmodified (git status clean)."
]

--- confidence
high

--- fixPlan
Fix: an anchor post plus nudges that keep going. All in app/src/main/assets/simplegram.js. The prototype patches are in scratch wf4/b17/variants.cjs as options A, R, S, X and C.

1. Anchor (option A), in filterFeedList after the verdict loop (~line 549).
   - Trigger: the skip is active, keptMedia===0, alreadySeen>0, and this feed state has not shown a post yet (new flag fs.shownAny, set whenever keptMedia>0).
   - Put back the page's last alreadySeen post (the oldest one), in list order, and count stats.feed.anchor.
   - Instagram then never sees an empty first page, under either hypothesis.
   - Only a post dropped as alreadySeen can be the anchor, never an ad or a suggestion.
   - Optional "Seen in Home" label: a CSS-only rule such as `article:has(a[href*="/p/<code>/"])::before{content:"Seen in Home"}` in SimpleGram's style tag. It adds nothing inside Instagram's React tree.

2. Nudges that keep going (option R), in scheduleNudge (740-778).
   - Remember fs.lastPageAt when scheduling. While no new page has arrived and the feed has not ended, retry at about 1, 2, 4 and 8 s (up to 8 tries).
   - Scope: Following/Favorites opened from the end card (skipping()), plus ideally the first page of any feed. With that scope the existing 'at most 10 a minute' test still passes. An unscoped retry broke it (14 nudges instead of 11).
   - A capped nudge re-arms when the minute frees up instead of being dropped (line 750).

3. Paging past seen posts (option X): while skipping() && seenStreak>0, nudge after 200 ms and do not count against the 10-a-minute cap. Point 4 bounds it instead. Pause if stats.diag.pleaseWait or s429 rises.

4. Replace the page-count cap (lines 560-561) with a seen-count bound (option C). Stop when the seen posts passed exceed seenCodes.size + 30, or the end_cursor repeats, or after 60-80 pages. Each seen post appears only once in Following, so this does not depend on page size.

5. Optional scroll room (option S): while only the anchor shows and more pages remain, add a #sg-skip-room spacer of about 0.6×innerHeight. A swipe then produces real scroll events, which is Instagram's own trigger, even if synthetic nudges turn out not to work on the device. Remove it when new posts arrive, the feed ends or the route changes.

6. A message on Following/Favorites (today checkFeedEnd only shows on variant home, line 801):
   - "Skipping N posts you saw in Home…" while paging past seen posts takes long (heavy Home).
   - A short end note if the skip ended with nothing new.

7. Tests:
   - Update 'paging past posts already seen stops after 15 pages, not 40' to the new bound and the anchor.
   - Port b17-proposed.test.cjs, which uses an IG-page mock with the 3-post first page, a deferred list mount, onScroll-only paging and the empty-feed view, into tests/feed.test.cjs.
   - Extend the VLIST port with a mount delay and no paging until mounted, so it stops being optimistic.

Rejected:
- Stopping the skip entirely: 19 repeats on this phone, about 190 for a heavy Home. That defeats B7.
- Scrolling past the seen posts: Instagram still makes the same requests and renders and downloads every seen post, and the page jumps (B16 is a jump complaint).
- Driving paging ourselves: own Following requests plus injecting `after` into Instagram's preload request is request rewriting nobody can verify here.

Fallback if the anchor proves flaky on the phone: skip from page 2 onward (option F). That is 3 repeats, but the page is scrollable from the start, so Instagram's own loader runs on the user's swipes.

--- phoneDiagnostics
Only the phone can confirm the following:
- Whether Instagram switched Following to its empty-feed view (H1) or mounted an empty list (H2). The code that sets showEmptyFeed is logged-in only.
- How long the list takes to mount after a full page load.
- Whether synthetic nudges reach Instagram's real Home list. There is no direct phone evidence that any nudge ever caused a page load.
- The real page size of Following/Favorites after the first page.

Shape-only additions to Copy details that would settle these:
(a) For variant pages, a snapshot 3 s and 10 s after the first feed page:
   - number of `article` elements;
   - whether Instagram's `[role="progressbar"]` is visible;
   - scrollHeight minus innerHeight;
   - an enum for which Instagram null-state text is present in main (can't-miss-out / no-posts-yet / suggested / none). Never names.
(b) Time from the first feed page being parsed to the first `article` in the DOM (mount latency).
(c) Nudge outcomes: nudgeHits (a feed page arrived within 3 s) vs nudgeMisses, and nudges that fired before any article existed.
(d) Number of ayml__strict payloads, and whether one arrived within 2 s after an empty first page. That would mean loadSULV2 ran, i.e. Instagram's empty-first-page path, as opposed to the entrypoint's preloaded suggestions.
(e) Per feed variant:
   - units per page;
   - posts kept on the first page;
   - anchor count;
   - seen posts passed;
   - pages paged past seen posts;
   - nudgesCapped.
   These size the bound.
(f) For Favorites opened from the end card, the same snapshot. If 'can't-miss-out' shows while the user does have favorites, that confirms H1.

--- tests
Scratch, all under /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf4/b17/:
- igmock.js: a model of Instagram's feed page built from the bundles.
- exp.cjs: runs the matrix, scenario × option × H1/H2 × mount delay. Env READ=1 makes the user scroll, LAT=ms adds page latency. Results are in out-*.json.
- variants.cjs: builds the patched copies, options A/R/S/X/C/F/N. Ready-built: sg-orig.js, sg-ARX.js, sg-ARSX.js, sg-ARSXC.js.
- b17-proposed.test.cjs: 5 node:test cases (Following H1/H2, Favorites H1/H2, C1 with 190 seen and 8-post pages). They fail on 1.2 (0/5) and pass on ARSXC (5/5).
  Run: `SG_SCRIPT=<script> NODE_PATH=/opt/node-tools/node_modules node --test b17-proposed.test.cjs`

Repo suite:
- 1.2: 124/124.
- ARSX/ARSXC: 123/124. The one failure is the expected 'paging past posts already seen stops after 15 pages, not 40', which must be updated.

Recommended new repo tests:
1. Following and Favorites opened from the end card with an all-seen 3-post first page, in both models (empty-feed view, and late-mounted list): one anchor post, at most 1 repeat, new posts reached, and Favorites never shows the null-state text.
2. First page of 2 seen + 1 new with a late mount: paging continues (retry).
3. 190 seen, 8-post pages: new posts are reached and nudgesCapped stays 0 while paging past seen posts.
4. Cursor echo while paging past seen posts: stops.
5. The nudge retry does not change Home's 10-a-minute behaviour.

--- risks
- The trigger for Instagram's empty-feed view is not in the bundles. If it reacts to something other than an empty first page (for example the count after its own client dedupe), the anchor still gives it one edge, but this is unverified.
- With only the anchor showing, the page cannot scroll, so the anchor depends on nudges reaching Instagram's real list. Hence the retrying nudge plus the optional scroll room. If the phone shows nudgeMisses, fall back to option F (3 repeats, page scrollable).
- A pull-to-refresh or Home-tab refetch on the page opened from the end card re-applies the skip in the same document (skipping() is per path, line 351). fs.shownAny is already true at that point, so the first page could come back empty again. Mitigation: end the skip once a new post has been kept, or reset the anchor flag when Instagram refetches.
- Faster paging past seen posts (about 1 page/s, up to the bound) could provoke Instagram's 'please wait'. Pause on stats.diag.pleaseWait or s429.
- The same nudge-before-mount race applies to any feed whose first page keeps only 1-2 posts, for example Home with ads or suggestions among its 3 head items. This is outside B17 but the same mechanism.
- Cross-link for B18: showEmptyFeed is React state in b344 PolarisFeedContainerLayout. If it survives an in-app variant switch, Favorites would show the null state and Home the blanked suggested-accounts view until a reload. The B18 investigation should check this.
- B16 fixes change what goes into homeSeen, and so what gets skipped.
- The mock simplifies Instagram: no virtualization window, instant renders, and the Home-specific PolarisVirtualFeed is assumed to behave like PolarisGenericVirtualFeed.

--- alternatives
[
 "Skip from page 2 onward, leaving the 3-post first page alone (option F): 3 repeats. Robust, because the page can scroll and Instagram's own loader runs on the user's swipes. Experiments: new post in view at about 10 s in S1, and it also needs the cap exemption for heavy Homes. This is the fallback if the anchor plus nudges proves flaky on the phone.",
 "Stop skipping and open Following/Favorites normally (option N): never blank, but 19 repeats here and about 190 after a long Home session, which defeats B7's 'without repeats'.",
 "Keep all seen posts but scroll past them programmatically: Instagram still makes the same number of page requests, renders and downloads every seen post, IGVirtualList's estimated sizes make the jump inaccurate, and repeats stay above. Rejected.",
 "Drive paging another way: SimpleGram fetches Following pages itself to find the cursor after the seen posts, then injects `after` (the root query does accept it, b385 PolarisFeedTimelineRootV2Query.graphql) into Instagram's preload request. This is request rewriting plus extra traffic, and the cursor semantics cannot be verified without a logged-in capture. Not now.",
 "Retry the nudge only, without the anchor (option R): fixes the late-mounted-list case but stays blank if Instagram shows its empty-feed view (H1), which the phone's 'no spinner' favours."
]


######## REVIEW partly

--- verdict
partly

--- corrections
Confirmed against the code and bundles:
- **Head loads replace Home's list.** relay-runtime ConnectionHandler (in both b284 and b385): an update with after==null and before==null sets T=E, which replaces the edges. `L.copyFieldsFrom(_)` runs on every update. The root query and the refetch query share the key PolarisFeedPage__xdt_api__v1__feed__timeline__connection with filters ["_variant"] (b385 x2, b102).
- **One Home-tab tap sends two head loads on mobile.**
  - b314 usePolarisOnHomeClick: shouldRefreshOnHomeClick uses 3e4 ms. It calls go('/', {passthroughProps:{refreshFeed:true}}) and always window.scrollTo(0,0).
  - b344 PolarisFeed.react effect (gated on hasRefetchRelayFeed() = isMobile(), b381) and b344 PolarisFeedWrapper.react effect both fire on that navigation.
  - "refreshFeed" appears only in b314 and b344, so this is the only producer in the downloaded code.
  - New support: b385 cometRouterPrefetchRouteQueries skips the route-query prefetch when cometRouterIsNavigationRefresh is true (`b=...(g,a());if(!b){...}`). A same-URL go('/') therefore adds no third head load.
- **Page 12's pagination_source 'feed_recs' is a server label.** Page 11 had ps null and no marker, so page 12's request carried no pagination_source (b404 getPaginationSourceFromVariant).
- **SimpleGram neither scrolls Home to the top nor navigates to '/'.** Checked:
  - nudge (740-778): ±2 px, or a pad that is put back.
  - endRoom (785-797): a 170 px spacer.
  - restoreScroll: only for search/explore/other.
  - routeChanged: location.replace('/') runs only for the reels-tab route, and stats would reset on a full load.
  - pageBack on Home: moveTaskToBack.
  - Line numbers cited are right: 424-447, 445/446, 469, 498-514, 745, 2059-2086.
- **Repo is untouched.** Baseline is 124/124. The prototype base is byte-identical to the repo's simplegram.js.

Corrections:
1. **The user never saw page 13's posts under the investigator's model.** PolarisFeedComponent (b344) renders `i!=null&&n!==!0 ? PolarisFeed : Glimmer`, with n = isRefetching = the useTransition pending flag of refetchFeed. From B's start until it commits, PolarisFeed is unmounted and the glimmer shows. A's answer (page 13) only lands in the store and is replaced by B. So "a friend's post I previously saw" is not page 13. Under this model it was in the old list, most likely its top after Instagram's scrollTo(0,0) at the tap. The user's words ("coming up", "instantly refreshed", no tap mentioned) fit page 13 being appended at the bottom at least as well.
2. **The two head loads differ in size.** B (usePolarisRefetchFeedQueryLoader) loads with only {data, variant}. `first` falls back to its argumentDefinitions default of null, so B's size is the server's choice. Only A (refetch from usePaginationFragment) keeps the root query's first=3. A also clears the seen-state manager (b.clear()), so B carries no feed_view_info. This fits A = page 13 (3 posts) and B = page 14 (short because the server had 1 more post and then the marker). The investigator didn't use this point.
3. **Page size and ad position don't tell a head page from a next page.** Page 12, a known next page, also had 4 units. The ad at i=1 on page 13 fits an ad-gap rule that counts the marker (ads at page-12 i=2 and page-13 i=1). The main argument against the alternative is not evidence.
4. **The phone ring can't tell the two theories apart (my experiment).** Run against 1.2:
   - R1a: a Home-tab double head load.
   - R1b: a next page after the end (has_next ignored, older friends' posts appended), then one unasked head reload.
   - Both give the same ring for pages 12-14 (`3:3:e:end:feed_recs ... 4:0:m:kept:null ... 5:2:e:end:feed_recs 5:0:m:kept:feed_recs 5:1:a:ad`) and the same counters (eof 2, refreshes 1, afterEnd 0, lastPageKept 1, final ['NEWPOST'], card on).
   - What does differ is invisible to 1.2's diagnostics. Scroll height: a head load shrinks it (5.3 → 2.5 screens), a next page grows it (5.3 → 7.5). Time between pages 13 and 14: about 1 ms versus seconds.
   - Output: /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf4/b16-review/run-1.2.txt
5. **Fix 2 does nothing for the phone's sequence.** R2 (prototype): an unasked double head load with no tap still ends at ['NEWPOST'], ended, card on (repeatPages 1). The marker page always starts over.
6. **The prototype has a regression.** R3: homeTap matches on URL pathname only, so a tap on `<a href="/?variant=following">` while Home is scrolled down is swallowed (nav [], y 3969 → 0). In 1.2 that link navigates. Instagram builds its variant links with XPolarisFeedControllerRouteBuilder.buildURL inside PolarisFastLink (b344 PolarisFeedVariantsHeader uses it for '/'). The logo menu (PolarisFeedVariantsMenu.react, logged-in only) very likely uses the same for Following/Favorites, so Instagram's own Following/Favorites menu would break while scrolled.
7. **Fix 2 has a regression too.** R5: a single unasked reload of posts already shown (if B is lost, or a pill or background refresh) stops paging. The friend's new post on the next page never loads: prototype shows ['TOP0001','TOP0002','TOP0003'] plus the card; 1.2 shows TOP×3 + NEWPOST. The phone data itself shows a head page of 3 seen posts while a new post existed.
8. **Minor issues.**
   - The "repl" diagnostic (whether the first post's link changed) fails in exactly this case: a reloaded head starts with the same top posts as the old list. Use scroll height instead.
   - The investigator's test 4, "another variant, search open", only tests a tap within the 8 px slop.
   - The click listener (2059) runs before `search` (2106) and `leaving` (2765) are declared. This is harmless after init, but if init throws in between, homeTap's ReferenceError would also kill the Search-tab interception.

Root cause, revised: every reading agrees that page 14 was a head load. Relay replaced the list with it, and the collapse alone puts the user at the top. Page 13 being the other half of a Home-tab double load is plausible: it is the only path in the code that sends two head loads. The other reading fits equally well: a next page appended after the end, then a separate reload. The trigger is unconfirmed. Confidence: medium-low for the Home tab specifically.

Experiments:
- /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf4/b16-review/tests/review.test.cjs
- Outputs: run-1.2.txt and run-fix.txt in the same b16-review folder.

Only the phone can tell:
- whether a Home tap, a same-URL navigation, a visibility return or a jump to the top came just before page 13;
- whether page 13 grew or shrank the list;
- the time between pages 13 and 14.

--- missedCauses
[
 "Page 13 as a next page appended after the end: Instagram's PolarisFeedPage (logged-in only) may not honour has_next_page=false, and Relay's loadMore has no hasMore guard (b385). With justknobx 2492 off, the request would carry no pagination_source, and the server would return older friends' posts (ps null, followed, \"seen before\", \"coming up\" at the bottom). The 1.2 after-end rule takes that page for a refresh and reopens Home. Page 14 is then a separate head reload. This gives the phone's exact ring and counters (R1b) and fits the user's words better. The investigator's reason for dismissing it (page size) is not diagnostic.",
 "Refresh or refetch triggers in logged-in-only code that are not the Home tab: PolarisLightweightNewPostsPill.react, rendered by b344 PolarisFeedRoot on Home and tied to SET_DOCUMENT_VISIBILITY_HIDDEN_TIMESTAMP, which suggests action on return from the background; or PolarisFeedPage.react's own end-of-list or refresh logic. Any one of them gives page 14's list replacement. Fix 1 covers none of them.",
 "Under the Home-tab model, the friend's post the user saw was in the old list: its top, shown by Instagram's synchronous scrollTo(0,0) in onClick before the route commits. It was not page 13, which is never rendered because PolarisFeedComponent shows the glimmer while refetchFeed's transition is pending."
]

--- fixPlanProblems
[
 "Fix 1's homeTap matches only `new URL(a.href).pathname === '/'`, so it also swallows '/?variant=following' and '/?variant=favorites' links while Home is scrolled. Reproduced in R3: the link didn't navigate and the page went to the top. Instagram builds its variant links with buildURL inside PolarisFastLink, and its logo menu (logged-in) very likely links this way, so Instagram's own Following/Favorites menu would break. It must match the exact Home href '/', with no search and no hash.",
 "Fix 2 (repeat rule) doesn't change the observed outcome. R2: an unasked double head load still ends at 1 post with the card, because the marker page always starts over.",
 "Fix 2 regresses a lone unasked head reload. It stops paging after a first page of already-shown posts, so a friend's new post on the next page never loads. R5: the prototype shows TOP\u00d73 plus the card; 1.2 shows TOP\u00d73 + NEWPOST. The phone's own pages show exactly this shape: a head page of 3 seen posts while a new post existed.",
 "The whole fix rests on the Home-tab trigger, which the phone evidence cannot confirm. R1a and R1b give identical rings and counters. The build must carry diagnostics that can actually tell a head reload from an appended next page.",
 "Proposed diagnostic 'repl' (whether the first post's link changed) fails in the B16 case: the reloaded head starts with the same top posts. Scroll-height change and time between pages are reliable, shape-only signals.",
 "The 20 s 'asked' window uses homeTapAt even when Instagram does not reload (the <30 s path). It is only relevant to Fix 2.",
 "Test 4 claims coverage for another variant and search open, but only taps within the 8 px slop. The variant link, ?variant=following and search-open cases are untested.",
 "Minor: homeTap reads `search` (declared at 2106) and `leaving` (2765) from a listener registered at 2059. It is safe after init, but an init failure in between would make it throw and take the Search-tab interception down with it. Guard it with a ready flag or a try/catch around homeTap only."
]

--- revisedFixPlan
Record only. Build on "Apk it". All changes go against 1.2 simplegram.js.

1. **Home tab scrolls first** (Fix 1, corrected). This is the only behaviour change in this batch.
   - Add homeTap(e, a) in the capture click listener (2059), before the Search-tab check. Wrap it in its own try/catch so a failure there can't skip the Search interception.
   - It acts only when all of these hold:
     - the anchor's raw href is exactly '/' (`a.getAttribute('href') === '/'`, or URL pathname '/' with empty search and hash), so '/?variant=…' links are never matched;
     - location.pathname === '/' and location.search has no variant, i.e. feedVariant() === 'home';
     - route() === 'home';
     - CFG.role === 'main';
     - !search.open, !leaving, and no comments split open.
   - If the scroll top is more than 8 px:
     - preventDefault, stopPropagation, stopImmediatePropagation;
     - set the scroll top to 0;
     - count stats.feed.homeTapTop and log a 'tap:swallowed' Home event with its y bucket.
     - No request is sent, the list stays, fs.ended stays, and the card hides at the top and comes back at the bottom.
   - At the top: pass the tap to Instagram (it reloads if more than 30 s have passed), count homeTapRefresh and log 'tap:passed'.
   - This applies whether or not Home has ended, like the native app. If the user wants the smallest change, a narrower option is to swallow only while fs.ended.

2. **No change to the after-end refresh rule** (filterFeedList 498-514). Drop the prototype's repeat rule: R2 shows no benefit and R5 shows a regression.

3. **No change to connection.pagination_source, the endHome cut, the end-room spacer or the nudges.**

4. **Diagnostics in the same build** (shapes only, in Copy details):
   - (a) A Home events ring (last 30), each entry with t = ms since load, rounded to 100 ms:
     - Home-tab taps: swallowed or passed, with y bucket (top / mid / end);
     - history pushState/replaceState to the same URL while on Home (push or replace), which catches a refreshFeed navigation from any source if Comet writes history;
     - visibilitychange: hidden/visible, with the hidden-time bucket;
     - jumps to the top: from more than 1 screen to under 10 px with no touch within 300 ms;
     - route changes away from and back to Home.
   - (b) A separate ring of Home pages (last 20), one entry per page:
     - pg, and dt = ms since the previous Home page;
     - y: scroll top in screens (1 decimal) when parsed;
     - sh0: scroll height in screens when parsed, and sh1 1.5 s later (shrink = list replaced, i.e. a head load; growth = appended);
     - seen: the page's followed posts already in homeSeen;
     - hp: has_previous_page and whether start_cursor is present;
     - marker yes/no, ps, nx.
   - (c) Counters: homeTapTop and homeTapRefresh.
   - Not adding: XHR send/open hooks (ghost_owl checks send stacks), and the 'first post link changed' check.

5. **How to read the next Copy details:**
   - **Home tab confirmed:** a passed tap (or a same-URL write or a jump to the top), then within about 2 s two pages that both shrink sh, the first with seen equal to all its posts. Fix 1 covers it.
   - **Next page after the end (H2):** page 13 grows sh at a deep y with seen 0, then page 14 shrinks sh after a visibility, history or jump event and no tap. Instagram is paging past has_next_page=false and a separate reload follows. Go to 6A and 6B.
   - **Another refreshFeed trigger:** no tap, but a same-URL write or a jump to the top (for example the new-posts pill). Go to 6B.

6. **Only if 5 points there** (do not build blind):
   - **6A.** After the end, treat a new-cursor page as a refresh only with evidence of a reload: a passed Home tap or a same-URL navigation within 10 s, or y under 1 screen at parse (Instagram's refresh paths scroll to the top before the request). Otherwise use 1.2's afterEnd path: blank the page, stop pagination, stay ended.
     - Never blank a real head load: Relay would show an empty Home.
     - Tests must cover a head reload after scrolling to the top that is never blanked, and an appended page at the bottom that is blanked.
   - **6B.** Give the identified trigger the same scroll-first treatment, or record that it can't be intercepted. Nothing on the data side can keep Relay's old list after an unasked reload. Say so in the ledger: "never swap to a 1-post list" can't be promised for reloads Instagram makes on its own.

7. **Tests** to put in tests/feed.test.cjs, reusing the investigator's mock plus /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf4/b16-review/tests/review.test.cjs:
   - (1) Ended Home, scrolled down, Home tab: the list stays, no request, ended, y=0, card off. After scrolling back to the bottom the card is on again.
   - (2) A tap at the top sends headA+headB; homeTapRefresh is 1.
   - (3) A tap within 8 px of the top is passed.
   - (4) A '/?variant=following' link while scrolled navigates and is not swallowed (R3).
   - (5) The Home tab on ?variant=following is not swallowed.
   - (6) The Home tab with search open or a result opening is not swallowed.
   - (7) R5 guard: a lone unasked repeat reload keeps paging, so the new post shows.
   - (8) The diagnostics ring records sh shrink for a head load and sh growth for a next page (R1a and R1b).
   - Run the full suite (124) with SG_SCRIPT set to the build.

8. **On the phone with the new build:**
   - reach the end card, tap Home (it should stay, at the top), tap Home again at the top (it may reload to a short list, which is Instagram's own caught-up), then send Copy details;
   - separately, if the jump happens again without a tap, send Copy details right away.


######## B17 REVIEW (verdict: confirmed)

--- corrections
The root cause holds. I tried to refute it and could not. The 1.2 skip removed all 3 items of Following's first page. Instagram then has no list, or a list that cannot scroll, so it never asks for page 2. 1.2's only way out is one 600 ms nudge (simplegram.js:565, 740-776), which is lost, and a capped nudge is never re-armed (line 750). Instagram never pages from an empty first page.

I re-checked these claims and they are correct:
- first:3 from getPolarisFeedInitialPageSize (b205: `var e=3;function s(){return r("gkx")("8953")?e:null}`).
- The showEmptyFeed branch in PolarisFeedComponent.react (b344).
- PolarisFeed.react renders the deferred PolarisFeedPage.react (b344).
- IGVirtualList (b32) attaches a window scroll listener with capture, and onScroll runs only from $7 (scroll, or a containerSize change). An itemCount change only measures.
- GenericVirtualFeed (1d0d19b3.js) pages from its throttled onScroll and shows the spinner while hasNext or fetching.
- The cited simplegram.js line numbers.
- Experiment reproductions: the proposed tests fail 0/5 on 1.2 and pass 5/5 on ARSXC. The repo suite gives 124/124 on 1.2 and 123/124 on ARSXC.

Corrections to the evidence:
1. suggestionsBlanked 2 is not evidence that loadSULV2 ran.
   - PolarisFeedRoot.entrypoint (b404) preloads PolarisSuggestedUserListQuery on every feed page load when `gkx("25302") || routeProps.enable_mobile_suggested_user_cta`. Its root is the same `xdt_api__v1__ayml__strict` (alias "ayml"; b344 PolarisSuggestedUserListQuery.graphql).
   - b385 skips loadSULV2 when JK 6493 and gkx 25302 are both on.
   - The mock's "suggestionsBlanked 2" matches the phone only because igmock.js serves 2 fake users. It reproduces nothing.
   - Only an ayml payload count with timing relative to the first feed page would tell these apart.
2. "1.2 with H1 reproduces the phone exactly" leaves out `blank 4`.
   - In checkBlank (simplegram.js:1098-1108), `blank` goes up once per run of blank checks. A touch, or a scroll within 800 ms, resets the run (touchend sets lastUserScroll, line 737).
   - So blank 4 means the user touched or swiped the black page at least 3 times.
   - My run with swipes (scratch b17-skeptic/exp3.cjs, USER_MODE=swipe, 1.2, H1 and H2 with a 1500 ms mount) gave blank 2-3 in 16 s, 0 trusted scroll events and 1 request. With no swipes, blank stays at 1.
   - This is new evidence: the page had no scroll room, under either hypothesis, and the user's own gestures could not reach Instagram's loader. It also makes the scroll-room part of the fix mandatory (see fixPlanProblems).
3. The phone cannot tell H1 from H2.
   - "No spinner" fits H1, or a logged-in PolarisVirtualFeed whose spinner shows only while fetching. That module is not in the bundles.
   - H2 with the list mounting before 600 ms is ruled out: in the mock it pages fine.
4. The C1 claim stands. The 10-a-minute cap drops nudges and never re-arms. The page cap of ceil(seen/10) with 8-post pages ends before any new post.
   - But the proposed "seen-count bound" (seenPassed > seenCodes.size + 30) never fires in normal paging, because each seen post appears only once in Following.
   - It only stops a server loop, and only after about 17 requests in about 10 s (LOOP/ECHO runs: 18 requests, 17 within 10 s).
   - The cursor-echo check named in the plan is not in the prototype.
   - In normal paging the only real limit is the 80-page cap.
5. Extra bundle fact: Instagram's client dedupe (b385 polarisFeedDedupeIdsResolver) works only within one connection, by media id plus unfollowed_users. So an anchor post is not removed for having been seen in Home.

Still unverifiable without the phone:
- Which of H1 or H2 happens.
- When the list mounts.
- Whether synthetic scroll events page the logged-in list.
- Following's page size after page 1.

--- missedCauses
* blank 4 means the user touched or swiped the blank page at least 3 times (simplegram.js:737 and 1100-1108 reset blankChecks), and none of it produced a page. The page had no scroll room under either hypothesis. This is Instagram's own trigger, and SimpleGram has to restore it (scroll room); retrying synthetic nudges alone is not enough.
* suggestionsBlanked 2 can come from the route's own preload of PolarisSuggestedUserListQuery (b404 entrypoint: gkx 25302 or enable_mobile_suggested_user_cta; root xdt_api__v1__ayml__strict). It is not evidence of loadSULV2 or of the empty-first-page path.
* Short-page variant, outside the anchor case: a first page of 2 seen + 1 new keeps 1 post. 1.2 and ARSXC then send only a soft nudge (hard=false), which never adds the pad, and the anchor-only spacer does not appear. If the real list reacts only to real scroll events, the user is stuck with 1 post and a spinner even when swiping. Experiment S4, TRUSTED=1: ARSXC 1 request, 4-5 nudges, stuck; review variant Zg pages.

--- fixPlanProblems
* The scroll room (option S) is presented as optional, but it is the only part that works through Instagram's own trigger. With a list that ignores synthetic scroll events (igmock3 trustedOnly), ARX, which has no room, stays at the anchor plus a spinner with 1 request and 5 nudges even while the user swipes. ARSXC reaches new posts at 1.75-2.25 s. Make it mandatory.
* The room appears only while the anchor is alone. A first page that keeps 1-2 new posts (S4) gets no room and only soft nudges with no pad, so it is stuck under a list that needs real scroll events (review test 1 fails on ARSXC and passes on Zf/Zg).
* The room is removed while the JSON is parsed, before React draws the new posts. The document shrinks, the browser clamps scrollTop, and the page jumps back to the top of the anchor. Trace with RENDER=120: scrollY 400 to 0 at 1.75 s for ARSXC and for Zf; Zg, which waits until removal cannot move the page, stays at 400. This is a B16-type jump. Review test 3 fails on ARSXC and passes on Zg.
* The room is left behind after the feed ends on the seen cap (LOOP/ECHO runs: ended:true, room:true). It also stays after an in-page switch to Home (review test 6 fails on ARSXC). On Home it adds about 0.6×innerHeight below the last post, so checkFeedEnd's `near` (gap < max(400, 0.6×innerHeight), line 806) is not reached at the real end. That delays Home's end card. The plan says to remove the room on end and on route change, but the prototype does neither.
* The bound: seenPassed > size+30 never fires in normal paging, the cursor echo is missing from the prototype, and a server loop costs about 17 requests in about 10 s at the 200 ms uncapped pace. Zf/Zg instead treat 'every seen post on this page was already passed' as a reload or loop, and add a cursor-echo stop: 2 requests.
* Pull to refresh or a Home-tab refetch on the page opened from the end card: in ARSXC the refetched first page is emptied again (shownAny is already true), giving about 0.5 s of blank under H2 and an unknown result under H1, where Instagram may show its empty view (review test 5 fails on ARSXC). This needs a rule (Zf: forget the skip; Z: re-anchor), not just a listed risk.
* X still pushes skip nudges into nudgedAt (ARSXC lines 779-782), so paging past seen posts uses up the 10-a-minute budget of whichever feed comes next in the same document. Its 200 ms uncapped pace gave 20 requests per 10 s at 300 ms latency. A 400 ms pace with its own 40-a-minute cap gave 15 per 10 s, at a cost of about 4 s to the first new post (18 s versus 14 s; 29 s versus 24.5 s at 800 ms). The plan's 'pause on pleaseWait/s429' is not in the prototype.
* 'Retry, plus ideally the first page of any feed' would change Home and Following/Favorites opened from the menu. That breaks the rule that menu-opened feeds stay unchanged. Keep every new behaviour behind skipping(). (With MENU=1, 1.2 and Zf behave identically, which is the current state.)
* The anchor rule has to match B18's fix 1. B18 says the newest already-seen post; B17 says the oldest. Pick one and implement it once.
* The optional '::before Seen in Home' label changes the article's height inside IGVirtualList's measured items. If a label is wanted, use a non-layout cue, or put the text in the native message.
* Repo test 62, 'pages of only already-seen posts keep loading', serves the same SEEN001 8 times. A loop guard in Z style breaks it (it fails on Z). With Zf/Zg's 'forget the skip' it passes. If Z is chosen, rewrite the test with distinct seen codes.

--- revisedFixPlan
Revised B17 fix. Everything is in app/src/main/assets/simplegram.js unless noted. Every new behaviour is gated by skipping(), so it applies only to the page opened from the end-of-Home card. Home and Following/Favorites opened from the menu keep 1.2 behaviour. Prototype: scratch wf4/b17-skeptic/variants3.cjs, variant Zg (built file sg-Zg.js). Results: repo suite 123/124, the only failure being the expected 15-pages test; the investigator's b17-proposed tests 5/5; my b17-review tests 6/6 (1.2: 0/6, ARSXC: 1/6).

1. Anchor (unchanged from option A).
   - Placement: in filterFeedList after the verdict loop (after line 549).
   - Trigger: seenCodes, keptMedia===0, alreadySeen>0, and !fs.shownAny.
   - Action: put back exactly one post that was dropped as alreadySeen, in list order. Count stats.feed.anchor. Set fs.shownAny whenever keptMedia>0.
   - Line 537 only marks posts with !x.drop, so an anchor is always a followed post that passed every other filter. Ads, suggestions and strangers never come back.
   - Pick the same post rule as B18 fix 1 (the page's oldest seen post is closest to what follows) and implement it once.
   - No layout-changing label.

2. Scroll room (mandatory, generalised from option S).
   - While skipping(), the feed has not ended, has_next is true and fewer than 3 posts have been kept (fs.shownCount), keep `#sg-skip-room` at the end of body: about 0.6×innerHeight, aria-hidden, pointer-events:none.
   - Release it only when removing it cannot move the page: scrollHeight − room ≥ scrollTop + innerHeight, polled every 100 ms after the page, or after 3 s at most.
   - Also release it from endFeed (line 325), when the skip is forgotten, and in routeChanged (line 1255) when !skipping().
   - Never on Home or on a menu-opened feed.
   - Why: a user's swipe then produces a real scroll event, which is Instagram's own paging trigger. This works even if synthetic nudges do nothing on the device.

3. Nudges while skipping (option R, scoped).
   - In scheduleNudge (740-776), remember fs.lastPageAt.
   - While skipping(), no newer page has arrived and the feed has not ended, retry after about 1, 2, 4 and 8 s, up to 8 tries.
   - While skipping(), every nudge is hard: the pad when the page cannot scroll, the ±2 px jiggle when it can. Either way a real scroll event happens.
   - Home and menu-opened feeds keep the 1.2 nudge: no retry, and the existing 10-a-minute cap with its test unchanged.

4. Pace while paging past seen posts (option X, softened).
   - After a page of only seen posts, nudge after 400 ms.
   - These nudges do not go into nudgedAt (Home's 10-a-minute list). They have their own cap of 40 a minute; a capped one re-arms when the minute frees up.
   - Stop nudging, and end with the note in point 6, if stats.diag.s429 or pleaseWait rises after the skip started.
   - Measured, 190 seen and 8-post pages: first new post at 18 s with 300 ms latency and 29 s with 800 ms; at most 15 requests per 10 s.

5. Bounds (replacing lines 559-561).
   - (a) Cursor echo: a page of only seen posts whose end_cursor equals the previous one → stopPagination + endFeed.
   - (b) Reload or loop: Following never repeats a post. If every seen post on a page was already passed in this skip run (skip.passed Set), Instagram reloaded the first page (pull to refresh, Home-tab refetch) or is looping. Forget the one-time skip (skip=null), leave the page as Instagram sent it, release the room, and count stats.feed.skipForgotten.
     - Alternative if repeats after a refresh are unwanted: re-arm the anchor at most twice, then stop.
     - Measured: loop and echo cost 2 requests (ARSXC 18, 1.2 15). A refetch is never blank.
   - (c) Page cap: seenStreak ≥ min(80, seenCodes.size + 3).
   - The natural end (has_next false) is unchanged.

6. Messages (native and JS).
   - Use a separate 'skipStatus' message, never 'feedEnd', so Home's card logic (checkFeedEnd at line 801, and the card itself) is untouched.
   - Show "Skipping N posts you saw in Home…" when the anchor has stood alone for more than 3 s while paging past seen posts.
   - Show "Nothing new since Home" when a skipped feed ends showing only the anchor.
   - MainActivity shows it only on Following/Favorites.

7. One-time skip (coordinate with B18): also forget the skip when the route leaves the skip page inside the page, so an in-page return is an ordinary open.

8. Tests.
   - Update 'paging past posts already seen stops after 15 pages, not 40' to the min(80, seen+3) cap, using enough distinct seen codes.
   - Keep 'pages of only already-seen posts keep loading'. It passes with rule 5b.
   - Port the investigator's 5 tests (b17/b17-proposed.test.cjs).
   - Port my 6 tests (b17-skeptic/b17-review.test.cjs):
     - list that reacts only to real scrolls, first page 2 seen + 1 new;
     - a swipe into the room pages;
     - releasing the room never moves the page when React draws later;
     - a loop costs at most 5 requests;
     - a pull to refresh is never blank;
     - the room is gone after an in-page switch to Home.
   - Add to the VLIST port options for a mount delay, trusted-only paging and a render delay.

9. Fallback, if phone diagnostics show the anchor or the room failing: skip from page 2 onward (option F). That gives 3 repeats, but the page can scroll from the start. Measured with a swiping user: first new post at about 6.25 s under H1 and H2, with real or synthetic scroll events.

Phone diagnostics (shape-only), in addition to the investigator's (a)-(f):
- Nudge results by kind (synthetic only / jiggle / pad / swipe into the room), each with "a feed page arrived within 3 s". This settles whether synthetic events alone ever page the logged-in list.
- Touches while blank, and the scroll room (px) at that moment.
- Count and timing of ayml payloads relative to the first feed page. Do not rely on suggestionsBlanked for this.
- anchor, skipForgotten, cursorEcho, skipThrottled, skipRoom, and time to the first new post.
- A per-page trail: edges in/out and has_next in/out, as B18 proposes.
