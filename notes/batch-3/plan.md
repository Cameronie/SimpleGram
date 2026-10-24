# Batch 3 build plan (for 1.2)

Diagnosis of the 1.1 report (ledger B8–B15). Nothing here is built yet: the
user's rule is to build only on "Apk it".

- `diagnosis.md`: the full investigation and the skeptical review of each cluster,
  with the evidence: simplegram.js line numbers (1.1), Instagram bundle snippets,
  and experiment results.
- `prototypes/*.diff`: prototype patches against 1.1 `simplegram.js`, one per
  cluster. They were written independently, so they overlap and conflict.
  Use them as references; implement from this plan.
- `prototypes/tests`, `prototypes/mocks`: the experiments and tests behind
  the diagnosis. Some read the script path from `SG_SCRIPT`, and some still
  point at the session scratchpad. Adjust the paths before running.

Instagram facts below come from the website's current bundles (fetched
2026-10-21, logged out). The Filter status the user sent from the phone
confirmed the feed diagnosis: Posts shown 2, Suggested removed 0,
Pages read 8 (7 unrecognised), streamed 0, Backup filter 0.

## 1. Feed data layer (B8, and the trigger for B9/B10/B11)

**Cause (confirmed, reproduced with the phone's exact counters).**

- `feedVerdict` marks explore_story and ad units `media:false`.
- A Home page made only of such units hits the fail-open in `filterFeedList`
  (`!verdicts.some(x => x.media)`). The page is left untouched, and only
  `dropAds` strips the ads.
- After Instagram's `end_of_feed_demarcator`, `PolarisFeed.react` (b344) and
  `PolarisFeedContext` (b404) switch Home to `pagination_source: feed_recs`.
  Every later page is explore_story/ad units, so the suggestions are endless.
- Those pages return before the emptyStreak/ended/nudge bookkeeping, so
  paging never stops.
- The marker's `group_set.groups[].feed_items` lists are visited as separate
  "pages" (visit: `k === 'feed_items'`). That is the "Suggested Posts" section.
  When a group holds plain posts, `!hasMore(group)` sets a false `fs.ended`.
- Ruled out by the phone: Instagram's ghost_owl clean-parser bypass (pages
  did reach the hook) and the streamed skip (0 streamed).

**Fix.**

1. **Recognise every unit.** `UNIT_KEYS` = media, media_or_ad, explore_story,
   ad, suggested_users(_v2), end_of_feed_demarcator, stories_netego,
   bloks_netego.
   - Add `v.known`, true when a unit key is non-null, `adLike`, or `mediaOf`.
   - Fail open only when no verdict is known.
   - Keep `v.media` as it is. It drives kept counts, homeSeen, streaks and
     followSuspect.
2. **End Home at the marker.** Variant `home` only. Add `'past_posts'` to
   `feedVariant()` and leave that variant alone.
   - This runs before the fail-open check.
   - Drop the marker edge and everything after it, then `stopPagination(owner)`.
   - Set `fs.ended = fs.caughtUp = true` and keep `{title, subtitle}` for the
     native card.
   - Drop the marker rather than keeping it with emptied groups:
     `polarisFeedReducer` (b385) reports `moreAvailable:true` whenever a
     FEED_RECS group exists.
3. **Group lists.** Remember each marker group list in `markerLists`
   (WeakSet). Never count it as a page and never let it touch feed state.
   Filter it strictly: keep only non-dropped media with `followState === true`.
   This keeps Following/Favorites marker groups clean.
4. **`pagination_source === 'feed_recs'` page** (Home, no marker): keep only
   followed media, then stop paging and set ended.
5. **After the end.** A page with a new cursor counts as a refresh only if it
   has a marker or a followed post. In that case reset the feed state.
   Otherwise blank it, stop paging and stay ended. Never fail open after the
   end.
6. **Fake ends.** Set `fs.ended` from `!more` only when the owner has real
   paging fields (page_info / more_available / …).
7. **Instagram's own "Suggested for you" rule** (b353):
   `inventory_source === 'mixed_unconnected'`. Add `unconnected` to the
   `recommendedLike` regex. `explore.title` counts as suggested only when
   `followState !== true`, under its own stat.
8. **`SUGGEST_KEY`.** Add `(^|__)ayml(__|$)`. With an empty first Home page,
   Instagram calls loadSULV2, whose result is `xdt_api__v1__ayml__strict`.
9. **Tests.**
   - Keep the marker in `mixedFeed()` and update the assertions:
     has_next false, eof counted.
   - Add: a suggestion-only page is filtered; a marker in a page without
     posts; the marker as the first edge; feed_recs keeps friends; groups
     don't end Home; Following isn't cut; the refresh rule; mixed_unconnected.
   - Replay `prototypes/tests/unknown-pages-replay.cjs`. It must no longer
     produce "7 unrecognised".

Not doing (no evidence): the `__d` module hook for ghost_owl, in-place
neutralising of streamed pages, and an XHR/fetch learning hook.

## 2. End-of-Home card (B11)

**Cause (confirmed).**

- `checkFeedEnd`'s 4 s fallback keeps running while pages that add nothing
  keep arriving.
- `caughtUp` was never a show condition.
- `feedState` is keyed by pathname, so a trip to Stories or a post wipes it.
  After that `homePages` is 0 and the card can never show.

**Fix.**

- Feed state per variant (`Map`), updated only on Home.
- Show when `fs.ended`, which now comes from the marker, the empty streak or
  a feed_recs stop. Drop the `homePages > 0` requirement.
- Keep a stall fallback, used only when nothing arrives: 15 s at the bottom
  and 15 s since the last page (any page). The card then says "Home isn't
  loading more".
- Use a wider hide distance once shown, to stop flicker.
- While ended on Home, add a `#sg-end-room` spacer (about 170 CSS px) so the
  last post scrolls clear of the card. Remove it on other routes.
- MainActivity: when caughtUp, show Instagram's subtitle ("You've seen all
  new posts from the past 3 days.") on the card.

Tests: `prototypes/tests/feed-end.test.cjs` plus the review's R1–R10 cases.

## 3. Black feed and slow Stories (B9, B10)

**Cause.** Not confirmed on the phone; there are two candidates, and both
start from the endless suggestions.

- (a) The on-screen backup filter hides labelled suggestions after Instagram
  has drawn them. Inside Instagram's virtual list (b32 PolarisIGVirtualList)
  that leaves black reserved space, and each post flashes for ~300 ms before
  it is hidden.
- (b) WebView paint/memory exhaustion from endless Reels. The page is black
  wherever nothing is painted.

Screenshot 2 (a post's media collapsed to a strip) is unexplained.

SimpleGram makes no requests of its own on Home or Stories.

**Fix.**

- Section 1 removes the trigger.
- Hide labelled posts in the MutationObserver callback, before paint. Always
  ship this together with the run guard: 4 or more hidden posts in a row at
  the end of Home stops paging and ends Home.
- Pause videos inside hidden posts. Don't touch preload, and don't unload
  videos.
- `tidyStory` and `tidyBanners` skip `[data-sg-hidden]` and `<article>`
  subtrees. On the Stories route they scanned the whole mounted feed: up to
  18% of the main thread with 300 posts.
- Nudges: none after the end or while hidden; at most 10 per minute;
  seenStreak cap 40 → 15; remove the pad on a timeout as well as after 2 rAFs.

## 4. Search data (B12 Places, B13 Tags)

**Cause (confirmed).** These endpoints answer 404 like a made-up path:

- `/web/search/topsearch/`
- `/api/v1/locations/web_info/`
- `/api/v1/fbsearch/web/top_serp/`

Separately, the place query fails:

- `PolarisLocationPageTabContentQuery` now has doc_id 28586113187724473;
  KNOWN still holds 28211016731901625.
- It also declares a second provided variable,
  `__relay_internal__pv__PolarisSEOIsCrawlerrelayprovider`, which SimpleGram
  never sent.

For tags, the web search box (`PolarisSearchBoxRefetchableQuery`) no longer
returns hashtags.

**Fix.**

- `docIdFor` order: memo, `require(name+'_instagramRelayOperation')`,
  `require(name+'.graphql').params.id`, bundle scan, KNOWN.
- `providedVars(name)` reads
  `require(name+'.graphql').params.providedVariables` (value = `get()`),
  else the scan's `.relayprovider` deps, else KNOWN_PV. Append the providers
  after the caller's variables.
  The `.graphql` modules sit in b385, which every shell loads.
- At most 2 POSTs per `igGraphQL` call. Never fall back to `/graphql/query`
  after a parsed GraphQL error. Keep a `gqlLog` ring for diagnostics.
- Remove the dead calls: topsearch, locations/web_info, locations sections,
  fbsearch/web/top_serp. Memoise 404s per session in `igGet`.
- Refresh KNOWN: LocationPageTabContent 28586113187724473; its `_connection`
  29002281179411948; ExploreLocationsContainer 28572807415659320;
  APITopsearch 29386906664232128. Keep SearchBoxRefetchable
  27706427925724183 and the two keyword ids.
- **Places:**
  - First page: `PolarisLocationPageTabContentQuery {location_id, first:12,
    after:null, tab: ranked|recent, page_size_override:null}`, root
    `xdt_location_get_web_info_tab`.
  - Show more: `_connection` with `after`. Stop when the cursor is echoed back
    or a page adds nothing.
  - Header (only when missing): `PolarisExploreLocationsContainerQuery
    {location_id_str, show_nearby:false}`.
  - Places list: keep `/api/v1/fbsearch/places/`, which still exists.
  - Add a "Try again" button.
- **Tags:**
  - Always list the typed tag first. Normalise with
    `/[^\p{L}\p{M}\p{N}_‌]/gu`, so marks are kept.
  - Merge hashtags from the blended answer. Only if it has none, also ask
    `PolarisAPITopsearchQuery {data:{context:'hashtag', query, ...}}`, the
    lookup Instagram's `#` typeahead uses.
  - Tag grid: `tags/web_info` once, else `loadKeyword('#'+tag)`, which is what
    the website shows.
  - Most recent: one POST to sections. On failure, show the honest message
    and remember it for the session.

Not doing: the XHR/fetch learning hook; extra headers or params.

## 5. Opening a search result (B14)

**Cause (confirmed).**

- `openPath()` hides search before navigating.
- Instagram's CometRouter (b385) does route our synthetic popstate. But it
  applies routes in a React transition, after a `/ajax/route-definition/`
  round trip, and the old screen (Home) stays up until then.
- On slow loads, the 1.8 s `location.replace` fallback kills the working
  navigation and reloads the page.

**Fix.** Reference: `prototypes/search-open-cover.diff`, which includes the
review's amendments.

- Keep search up, dimmed with a spinner, until the new page is drawn and its
  media is present.
- Navigate with `browserHistory_DO_NOT_USE.browserHistory.push`, which is
  Instagram's own `openURL`. Reach it through
  `require('ifRequired')(name, yes, no)`, and only when the router status
  (`currentCometRouterInstance`) is readable. Otherwise use the 1.1 popstate
  way. Never both.
- The watcher replaces the 1.8 s timer. Full loads happen only when nothing
  was picked up (0.8 s / 2.5 s), the router is idle with nothing drawn (8 s),
  or the router is still busy (10 s).
- A result on the same page shows at once, without a cover or a reload.
- Strip Instagram's `(1)` badge from the title in `pageSig`, and walk the
  text with a bounded walker.
- Back during the cover returns to the results and is never swallowed. Old
  Home media under the cover is never autoplayed or unmuted.
- Keep the counters in sessionStorage so full loads are counted.
- No prefetch on pointerdown.
- MainActivity: while searchOpen, a slow `__sg.back` answer never minimises
  the app.

## 6. Menu button over Save (B15, low priority)

Make the idle button a 14–16dp × 44dp edge tab, and set the gesture-exclusion
rect on API 29+. Show a one-time "drag me" tip. Keep the default height or
move it up, never down: lower down it covers the Reel actions.

## 7. Diagnostics in Filter status (all clusters)

Counts and data shapes only, never names, codes, captions or URLs. Add a
"Copy details" button that copies JSON.

- **Feed:** pages, unrecognised, streamed, marker seen, removed after the end,
  recs pages, removed inside groups, kept with unknown follow state, Home posts
  on screen with a Follow button, longest hidden run, peak articles and videos
  in the DOM, blank events.
- **Last 40 Home units:** page, kind, verdict, follow 1/0/null,
  inventory_source (32 chars), product_type, social_context types,
  pagination_source, has_next, is_final, hook.
- **Ghost_owl:** whether the `window.Env` keys h4npx7qw, v9k2mt7q, q9k7m2x and
  k8pq2mnb are present, and whether JSON.parse is still ours. Never `require`
  Instagram's detection modules.
- **Search:** the gqlLog (query, id source, providers, path, status, error
  code/message, edge count). Search opens: router / popstate / full load /
  last ms.
- **Stories and network:** Stories load ms (last 5) and video count at open;
  counts of 429, 5xx and "please wait" responses.
- **Native:** onTrimMemory levels, renderer-gone didCrash and priority,
  WebView version.

## Order

1. Feed data layer.
2. End card.
3. Search data.
4. Search-open cover.
5. Backup filter and Stories trims.
6. Diagnostics.
7. B15.

Run the full suite after each step, and the on-device tests before release.
