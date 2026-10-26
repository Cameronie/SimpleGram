

######## CLUSTER feed-leak

=== B8 Not-followed and suggested posts reach Home: later Home pages get past the data filter (Instagram's ghost_owl anti-adblock parser, or the streamed-page skip), and Home is never ended at 'You're all caught up', so Instagram switches to its all-recommendations feed (pagination_source=feed_recs)  [medium]

--- rootCause:
The posts that leaked are ones feedVerdict would drop if it saw them. They have friendship_status.following=false (that is why the Follow button shows), or they are explore_story items or end_of_feed_demarcator group items, all of which the filter drops. Experiment S0 shows plain JSON.parse drops all of them, including the after-EOF group. So those pages never went through filterFeedList's verdicts. There are three ways this can happen. The code proves each one; which is active on this account can only be confirmed on the phone.

(1) MOST LIKELY: Instagram's anti-adblock defense, 'ad_blocker_defense_ghost_owl' (b25.js GHLDetectionUtilsPreludeSafe, b385.js GHLRelayJsonParse, b25.js GHLServerJSParse).
- Path of every Relay GraphQL response, including all Home pages: XHRRequest.responseText -> createChunkedResponseParser (split on CRLF) -> RelayGraphQLRequestUtils.parsePayload -> RelayFBJsonParser.parse -> ghlParseRelayResponse(text).
- That parser first checks whether JSON.parse has been replaced. It compares JSON.parse's source, read through a hidden iframe's pristine Function.prototype.toString, with the iframe's own JSON.parse.
- SimpleGram's wrappedParse (simplegram.js:503-510) is always detected: shimDetected=true in every experiment.
- When it detects a replacement, Instagram may parse with the iframe's pristine JSON.parse (getCleanJSONParse, used when window.Env has key 'h4npx7qw') or with json5 (cr:7329). Neither goes through our hook, so cleanse() never runs.
- HTML boot payloads (the first page) go through GHLServerJSParse.loadBootPayload. Same switch, gated on Env key 'v9k2mt7q'; json5 is always available there.
- Response.prototype.json and the XHR 'response' getter hook never see Relay traffic. XHRRequest reads responseText, and our getter only acts when responseType==='json'.
- Logged out, the Env keys are absent and cr:7329 is null, so the bypass is off. Logged-in values are per account and unknown.

(2) Streamed skip. filterFeedList returns early at simplegram.js:347 ('if (streamed) { stats.feed.streamed++; return; }'). cleanse sets streamed at line 481 when root.hasNext===true or extensions.is_final===false. That skips ALL verdicts for the page: experiment S6 kept the ad, the not-followed post, the explore_story and the after-EOF recs. dropAds (line 447) is skipped too. Feed operations have no @defer/@stream (see evidence), so this needs the server to send is_final:false on the data part. Possible, but less likely.

(3) Missing follow info. followState() (line 220) returns null when friendship_status is absent, and the post is kept (the NOINFO1 fixture is kept on purpose). Instagram's header still shows Follow in that case, because a null relationship is not FOLLOWING. This explains (a) only if the server omitted friendship_status. It does not explain the after-EOF section: explore_story edges are dropped regardless of follow state.

Structural part, both (a) and (b):
- SimpleGram keeps the end_of_feed_demarcator edge (line 280) and never ends Home there.
- Instagram's PolarisFeed.react sees the demarcator in the connection and requests every later page with pagination_source 'feed_recs' (100% recommendations, same root field and doc).
- From then on, any page that escapes the filter is entirely suggestions.
- The demarcator also carries an embedded group_set.groups[].feed_items list. Its title is probably the 'Suggested Posts' header: the string is in no client bundle, so it comes from the server.

1.0 vs 1.1: the filter and hooks are identical (see evidence), and the streamed skip existed in 1.0 (1.0 line 302). 1.1 did not create the leak. It made Home page deeper and faster: scheduleNudge(false) after every page with 2 or fewer kept (line 395), hard nudges on empty pages (line 390). That reached the late or EOF/recs pages that 1.0's slow feed (B4) never reached. An Instagram-side rollout of ghost_owl for this account since the 1.0 check is equally possible.

--- alternatives:
[
 "Streamed skip (simplegram.js:347): later pages carry extensions.is_final=false (e.g. an early-flush data part plus a data-less final trailer). The filter then skips the page whole. Feed queries have no @defer/@stream, so this is less likely, but Filter status would show it as 'Pages read' growing while 'Suggested removed' stays flat.",
 "Missing friendship_status: followState() returns null, the post is kept (line 286 only drops === false), and Instagram still shows Follow. This can explain the pre-EOF Follow posts (sportsonprime, hsmarken) but not the explore_story-based after-EOF recs.",
 "followSuspect fail-open (lines 354-358): the first filtered list after a reload, while stats.feed.kept===0, with 3 or more media all following:false (e.g. a demarcator group of recs, or a feed_recs page) is kept whole. The counter exists but is not shown in Filter status.",
 "Our hook is removed: restoreNativeXHRGetters (gkx 999) removes the XHR 'response' getter. Minor, since Relay uses responseText; it matters only for REST JSON over XHR."
]

--- fixPlan:
Covers both the bypass and the streamed path, and ends Home at Instagram's own marker. All of it is in simplegram.js plus small MainActivity additions.

A) Parser-module hook (new, right after the JSON.parse hook at about line 510). Keep the existing JSON.parse, Response.json and XHR hooks as fallback.
1. At document start, define an accessor on window.__d: get returns the current define; set(fn) wraps fn. Instagram's inline bootstrap ('__d_stub=[],__d=function(e,t,n,r){__d_stub.push(...)}') and b13's 't.__d=function...' both go through the setter, and b13 replays __d_stub through the wrapped define.
2. The wrapped define checks the name against WRAP = {GHLRelayJsonParse:['ghlParseRelayResponse'], RelayFBJsonParser:['parse'], RelayGraphQLRequestUtils:['parsePayload'], GHLServerJSParse:['loadBootPayload']}. On a match, it replaces the factory with a wrapper that:
   - calls factory.apply(this, arguments);
   - then scans arguments[1..] and the return value for the target function (as obj[fn], obj.default[fn], obj.exports[fn] or obj.exports.default[fn]);
   - replaces each found function with a wrapper (marked __sgWrapped) that returns the original result after try { cleanse(result, 'module') } catch {}.
3. MUST copy factory.length onto the factory wrapper (Object.defineProperty(w,'length',{value:factory.length})). b13 passes only factory.length arguments.
4. Mark wrapped factories and defines so stub replay does not double-wrap. If a later classic script redefines __d, we silently lose the hook and fall back to JSON.parse.
5. Prototype: scratchpad/wf/feed-leak/fix_prototype.js, validated with Instagram's real module system.

B) Idempotency, needed because the plain path now cleanses twice.
- const filteredLists = new WeakSet(). filterFeedList(owner, list) returns early if filteredLists.has(list), else adds it.
- Same guard for limitSearch(v). trimChaining, blankLists and dropAds are already idempotent.
- Count per path: stats.feed.via = {parse, module, fetch, xhr}, plus stats.feed.moduleOnly++ when a timeline list is first seen from 'module'. That is the direct proof that Instagram used its own parser. Pass the via tag through cleanse(root, via).

C) Streamed pages: filter them in place, never skip.
- Replace line 347 with: compute verdicts as usual; if streamed, for each dropped index set every key of the node except __typename to null, and do NOT splice.
- Instagram's polarisFeedDedupeIdsResolver drops such nodes (proven), and indexes stay stable, so any path-addressed later part still targets the right edge. Count stats.feed.streamedFiltered.
- dropAds (line 447): for streamed lists, neutralise in place instead of returning.
- In cleanse, also handle incremental parts. If root.path is an array, and root.items or root.data is present, and the path contains a TIMELINE_KEY segment followed by 'edges', run feedVerdict on each item (or on root.data as one node) and neutralise in place. Iterate root.incremental[] for the GraphQL-spec format.
- Rejected: remapping later paths per request. Our hooks cannot tie a part to its request, so that is fragile.

D) End Home at the demarcator. In filterFeedList, only when route()==='home' && feedVariant()==='home':
1. If owner.pagination_source==='feed_recs': drop every edge (reason 'recs'), stopPagination(owner), set fs.ended=true and fs.caughtUp=true, stats.feed.recsPages++.
2. Otherwise find eof = the index of the first edge whose node has end_of_feed_demarcator. If found:
   - drop all edges after eof (reason 'afterEnd');
   - set the demarcator's group_set=null, so its embedded suggested groups are neither rendered nor visited. Fallback if the phone shows a broken block: keep group_set and empty each groups[].feed_items;
   - stopPagination(owner), so has_next_page=false and Instagram never sends the feed_recs request;
   - set fs.ended=true and fs.caughtUp=true. checkFeedEnd then shows the Following/Favorites card at the real end, which also helps B11.
3. Exclude demarcator group lists, recs pages and after-EOF lists from the followSuspect fail-open (lines 354-358).
4. The Following/Favorites variants are untouched.

E) Harden verdicts.
- recommendedLike: add 'unconnected' to the inventory_source regex at line 267. This is Instagram's own 'Suggested for you' rule.
- On Home, followState()===null plus a non-empty m.explore.title counts as 'suggested'.
- Count stats.feed.followUnknown for kept media with null follow state. Do not drop on feed_recs_demotion_control until phone data shows it is absent on friends' posts.

F) Diagnostics in Filter status: see phoneDiagnostics.

Edge cases:
- Module names renamed: fall back to the JSON.parse hook. The 'via' counters reveal it.
- A frozen exports object: the try/catch leaves Instagram's function in place.
- Instagram adds @stream to feed edges later: C covers it.
- Do not try to hide the wrapper's toString or patch the iframe realm. ghost_owl has cross-realm toString and stack-trace checks, and patching the iframe does not cover json5.

--- risks:
- The __d accessor depends on Instagram assigning __d, not declaring it with a global function declaration. If that changes, the hook silently falls back to the JSON.parse hook, which only fails open.
- Module names (GHLRelayJsonParse, RelayFBJsonParser, RelayGraphQLRequestUtils, GHLServerJSParse) may change. The 'via' counters make that visible.
- Wrong factory.length would break Instagram modules, hence the explicit copy and a test for it.
- Double filtering skews counters and the emptyStreak stop (4 becomes 2) without the WeakSet guard.
- Setting group_set=null: the logged-in demarcator renderer is not in the downloaded bundles, so the exact look of the caught-up block is unconfirmed. Fallback: empty feed_items.
- Ending Home at the demarcator also removes Instagram's 'older posts' group after it. Following covers that.
- Neutralised streamed edges are proven to be dropped by Instagram's dedupe resolver. Whether the virtual list leaves an empty row cannot be checked without the logged-in bundles.
- The ghost_owl detection still sees our JSON.parse wrapper and may log it server-side (FBLogger 'ad_blocker_defense_ghost_owl'). Removing the JSON.parse shim later would make SimpleGram invisible to it but needs other coverage for non-Relay JSON first.
- Adding 'unconnected' or explore.title rules could drop a friend's post only if Instagram labels it 'Suggested for you' itself, which is unlikely.

--- phoneDiagnostics:
Stage 1, works now with 1.1, no build needed:
1. Open Home fresh and scroll until a not-followed post or the 'Suggested Posts' section appears, without reloading.
2. Open Menu > More > Filter status and send a screenshot.
3. Read it like this:
- 'Pages read' stays at 1-3 while you scrolled many pages, and/or 'Backup filter: Ads' > 0: later pages never reached SimpleGram's filter. This is the ghost_owl bypass (cause 1).
- 'Pages read' keeps growing but 'Suggested removed' stays flat and 'Backup Ads' > 0: streamed pages are being skipped (cause 2). stats.feed.pages++ runs before the streamed return at line 346.
- 'Pages read' and 'Suggested removed' both growing and 'Backup Ads' = 0: the filter sees the pages, and the leaking posts lack follow info (cause 3).

Stage 2, next build: Filter status adds the lines below and a 'Copy details' button (ClipboardManager in MainActivity.showStatus) that copies a shape-only JSON.
- Feed counters: streamed / streamedFiltered, moduleOnly, via{parse,module,fetch,xhr}, followUnknown, followSuspect, afterEnd, recsPages, eof, dupSkips.
- ghl snapshot, computed in the 'status' action (line 2350) inside try/catch:
  - envKeys = the ghost_owl keys present in window.Env: ['h4npx7qw','v9k2mt7q','c6mw9qtk','x8kf2pw6','d3hf9km2','k8pq2mnb','j6dw4ztx','r4wt7kmj','q9k7m2x'];
  - gk = which of ['15342','10092','11953','23657','13760','999','5415','8068'] return true via window.require('gkx');
  - shim = window.require('GHLDetectionUtilsPreludeSafe').isJSONParseShimmed();
  - clean = getCleanJSONParse()!=null;
  - json5 = window.require('cr:7329')!=null.
- A ring buffer of the last 40 Home feed items considered: {pg: page number, i: index, k: m|x|a|e|s|o (media, explore_story, ad, eof, suggested_users, other), v: kept or drop reason, f: 1|0|null|me (follow), inv: inventory_source truncated to 32 characters, pt: product_type, sc: social_context length, rc: feed_recs_demotion_control?1:0, ps: connection pagination_source, fin: extensions.is_final, via}.
- No usernames, ids, codes, captions or URLs.

What confirms what:
- clean=true or json5=true, or moduleOnly>0: cause 1.
- Kept items with fin=false: cause 2.
- Kept items with f=null and the inv values seen: cause 3. This also shows whether rc and inv can safely become drop rules.

--- tests:
Add to tests/page.test.cjs, using fake modules written for the tests, not Instagram's code:
1. 'feed: a page Instagram parses with its own clean parser is still filtered'. Install an Instagram-like stub __d plus a minimal define that caps arguments by factory.length. Define a GHLRelayJsonParse whose ghlParseRelayResponse uses an about:blank iframe's JSON.parse. Assert mixedFeed comes out filtered and stats.feed.moduleOnly===1.
2. 'feed: wrapped factory keeps its length and arguments' (length 7 and 8 factories).
3. 'feed: a page seen by both JSON.parse and the module hook is filtered once' (stats.feed.pages===1, emptyStreak increments once).
4. Replace the test at lines 172-178 with 'feed: streamed page is filtered in place': is_final:false, edges.length stays 12, dropped nodes have all fields null, friends intact, stats.feed.streamedFiltered>0.
5. 'feed: Home ends at the caught-up marker': edges after the demarcator are removed, group_set===null, has_next_page===false, and a feedEnd message with on:true arrives when near the bottom.
6. 'feed: a feed_recs page on Home is emptied and stops paging'.
7. 'feed: Following variant is not cut at a demarcator'.
8. 'feed: inventory_source mixed_unconnected is dropped even without follow info'.
9. 'feed: incremental @stream part under the timeline edges is filtered in place'.
10. 'status: diag contains no usernames, codes or URLs' (JSON.stringify(diag) has no fixture names).

On device: after the build, repeat Stage 1 of the diagnostics and send the 'Copy details' JSON. Expected: no Follow-button posts and no 'Suggested Posts' section, Home stops at 'You're all caught up', and the end card appears there.

--- evidence:
* Ghost_owl detects SimpleGram's wrapper, from b25.js GHLDetectionUtilsPreludeSafe. The iframe grab: 'g=U==null||(o=U.JSON)==null?void 0:o.parse'. The check: 'function N(){L();var e=g,t=h;...var n=s(t.call(JSON.parse)),r=s(t.call(e));return n!==r?!0:n!=="function parse() { [native code] }"'. The clean-parse switch: 'function W(){return L(),!v||b?null:g}' with 'c=l!=null&&"h4npx7qw"in l;v=c' (l=window.Env).
* Relay parse paths, from b385.js GHLRelayJsonParse: 'u=(a?o("GHLDetectionUtilsPreludeSafe").isJSONParseShimmed():o("GHLDetectionUtils").isJSONParseShimmed())||...' (GHLDetectionUtils.isJSONParseShimmed falls back to the same toString check). Then 'var _=o("GHLDetectionUtilsPreludeSafe").getCleanJSONParse();if(_!=null)try{c=_(t),d=!0}', then 'n("cr:7329").fromPiece(s(t))', and only last 'return d||(c=JSON.parse(t))'.
* Call chain, b385.js: RelayGraphQLRequestUtils 'function c(e){try{return n("RelayFBJsonParser").parse(e)}'; RelayFBJsonParser 'parse:function(t){return o("GHLRelayJsonParse").ghlParseRelayResponse(t)}'. createRelayFBNetworkFetch: 'C.setResponseChunkHandler(function(e,t,n){...i=r("RelayGraphQLRequestUtils").parsePayload(e)...d.next(i)'. b284.js createChunkedResponseParser splits each part on CRLF ('o.parseStreaming=!0'). XHRRequest (b92/b314): 'a.onprogress=...' then 'return t.responseText'. So each multipart part is a separate parse call, but only JSON.parse-based paths reach our hook.
* HTML first page, b25.js: ServerJSPayloadListener 's=o("GHLServerJSParse").loadBootPayload(e.textContent)'. GHLServerJSParse: 'a=n!=null&&"v9k2mt7q"in n ... R||(t=r("json5").fromPiece(m(p)))' (json5 is a direct dependency). b25.js getSameOriginTransport: 'r("justknobx")._("340")&&r("gkx")("999")&&...isXHRResponseGetterShimmed()&&...restoreNativeXHRGetters()'.
* Logged-out html/home.html gate values: gkx "15342","23657","13760","999" all {"result":false}; justknobx "566","5765","5738","340","3323" all {"r":true}; '"cr:7329",[],{"__rc":[null,null]}'. Env (#envjson) has none of h4npx7qw/v9k2mt7q/c6mw9qtk/x8kf2pw6. The kill switches are on and the gates are per user, so logged-in values are unknown.
* Experiment with Instagram's REAL GHL modules and simplegram.js in Chromium (scratchpad/wf/feed-leak/ghost_owl_experiment.out.txt). S0 plain JSON.parse: 'FRIEND1,FRIEND2,end_of_feed_demarcator | after-EOF group: []', pagesFiltered 2. S2 Env.h4npx7qw: 'FRIEND1,ADPOST1,SUGG001,NOTFOL1,explore_story,FRIEND2,end_of_feed_demarcator | after-EOF group: [RECS001,RECS002]', pagesFiltered 0. S3 json5: same, unfiltered. S5 ServerJS + Env.v9k2mt7q: unfiltered, json5Used 1. S4 boxed parse (gkx 23657): filtered. S6 is_final:false: everything kept, streamedSkips 2. shimDetected=true in all runs.
* Fix prototype validated against Instagram's REAL module system (the define/require IIFE extracted from b13.js) plus the real GHL modules (modsys_experiment.out.txt). Without fix, Env.h4npx7qw or json5: ['FRIEND1','NOTFOL1','explore_story','FRIEND2']. With fix: ['FRIEND1','FRIEND2'] in every scenario. On the plain path with the fix, pagesFiltered=2, i.e. double filtering, so an idempotency guard is needed.
* Module system caps factory arguments by factory.length, from b13.js: 'if(l.special&y){var I=K(l);L=Math.min(f+v.length,I)}' with 'function K(e){...e.factoryLength=e.factory.length...}', y=2. Flags 98/66/null all set it ('(r!=null?r:y)|b'). A wrapper must keep factory.length or the module breaks.
* No incremental delivery in the feed ops: the AST of b385.js PolarisFeedTimelineRootV2Query.graphql and PolarisFeedRootPaginationCachedQuery_subscribe.graphql has 0 Defer and 0 Stream nodes (only ClientExtension 6, Condition 5, InlineFragment 4, RelayResolver 4). metadata {is_distillery:!0,root_field_name:["xdt_api__v1__feed__timeline__connection"]}. Doc ids 28805668309050001 (root) and 28847928918174870 (pagination). Our TIMELINE_KEY matches.
* After-EOF switch, b344.js PolarisFeed.react getExtraVariables: 'm=d.some(function(e){...e.node.end_of_feed_demarcator}),p=l==null?void 0:l.pagination_source,...f=o("PolarisFeedContext.react").getPaginationSourceFromVariant(a,m,p);if(f!=null&&(_=...{pagination_source:f}),f===...FEED_RECS){var g=r("getPolarisFeedRecsPagingToken.next")(d)'. b404.js PolarisFeedContext: 'case"home":return t||r("justknobx")._("2492")&&n==="feed_recs"?...FEED_RECS:null', so the server can also switch it via connection.pagination_source. b344.js getPolarisFeedRecsPagingToken.next builds last_organic_item from 'explore_story.media' and last_non_organic_item from 'ad' among edges AFTER the demarcator. Post-EOF items are explore_story or ad edges in the same connection.
* Demarcator shape (pagination query tree, scratchpad/wf/feed-leak/pagination.tree.txt:2156-3225): end_of_feed_demarcator{id,title,subtitle,style,group_set{__typename,id,active_group_id,connected_group_id,groups[]{next_max_id,id,pagination_source,title,feed_items[]{media,ad,explore_story,stories_netego,bloks_netego,suggested_users}}}}. 'Suggested Posts' and 'all caught up' do not appear in any of the 418 bundles, so they are server strings.
* Follow state fields, tree lines 209-228 and 398-399: media.user.friendship_status{following,is_feed_favorite}; coauthor_producers[].friendship_status{following,blocking,is_feed_favorite,outgoing_request,followed_by,incoming_request,is_restricted,is_bestie}. Selected identically under explore_story.media, ad items and demarcator group feed_items. Also selected: media.inventory_source, media.explore{title}, media.feed_recs_demotion_control, media.social_context[]{social_context_type,...}, top_likers/facepile_top_likers ('Liked by X' is the normal like line, not a recs marker).
* Follow button logic, b353.js PolarisPostFeatures: default 'showFollowButton:!0'; '{overrides:{showFollowButton:!1},predicate:"isFeedAndOwnerFollowedByViewer"}' with '_=i.followedByViewer.state===o("PolarisRelationshipTypes").FOLLOW_STATUS_FOLLOWING'. b385.js polarisRelationshipReducer: 'followedByViewer:u(e.following,e.outgoing_request)', i.e. from the feed data's user dict. The lazy friendships/show_many (b325) is called only by b250 PolarisLikedByListActions, not by feed headers. So Follow is shown for following:false OR missing friendship_status.
* Instagram's own 'Suggested for you' rule, b353.js PolarisPost.react: 'Wt=de.inventorySource==="mixed_unconnected"&&Mt&&!$e ... qt=(Ut=(Vt=de.explore)==null?void 0:Vt.title)!=null?Ut:u._("Suggested for you")'. Our recommendedLike regex /recommend|explore|suggest|chaining|netego/ (simplegram.js:267) does not match 'mixed_unconnected'. Follow button hidden for collabs: 'Dt=!!kt&&(!de.coauthorProducers||de.coauthorProducers.length===0)&&!F'.
* In-place neutralising is safe for rendering. Instagram's real b102.js polarisFeedDedupeIdsResolver maps a node with all fields null to null and filterNulls drops it (dedupe_experiment.out.txt: dedupedItems = F1, F2, eof; the neutralised SUGG/ad/explore edges are gone, order kept).
* 1.0 vs 1.1 (git show e4278e1 vs working tree): adLike, mediaOf, people, followState, contextText, repostLike, recommendedLike, feedVerdict, dropAds, stopPagination, hasMore and the JSON.parse, Response.json and XHR hook lines are identical. cleanse/visit differ only by '!ownFetch' and userIds indexing. The 1.0 file already had 'if (streamed) { stats.feed.streamed++; return; }' (1.0 line 302). tests/page.test.cjs:172-178 asserts a streamed page keeps all 12 edges, i.e. codifies the leak.
* Phone-side tell already in 1.1: the Following/Favorites flash (checkFeedEnd line 589 needs fs.homePages>0, set at line 378 only after a filtered Home page with kept media). So at least the first Home page WAS filtered; the leak is in later pages. That fits a Relay-XHR-only bypass (Env.h4npx7qw/json5) or streamed later pages.

--- notes:
I changed nothing in /home/user/SimpleGram. Everything is under /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf/feed-leak/:

- **Experiments:**
  - ghost_owl_experiment.cjs and ghost_owl_experiment.out.txt: Instagram's real ghost_owl modules plus simplegram.js in Chromium. Runs S0-S8, including the streamed skip (S6) and the fix prototype (S7, S8).
  - modsys_experiment.cjs and modsys_experiment.out.txt: the fix tested against Instagram's real define/require code from b13.js.
  - fix_prototype.js: the module-hook prototype.
  - dedupe_experiment.cjs and dedupe_experiment.out.txt: Instagram's real feed de-dupe step drops edges whose fields were set to null.
- **Extracted Instagram code:** mods/*.js are modules copied out of the downloaded bundles; mods/modsys.js is the module system.
- **Query layout:** pagination.tree.txt is the field tree of the Home paging query.
- **Helpers:** tree.cjs and extract.py.
- **Baselines:** simplegram.1.0.js and simplegram.1.0b.js are the 1.0 script versions used for the comparison.

Finding that matters for other clusters: Instagram's 'ad_blocker_defense_ghost_owl' code always detects SimpleGram's JSON.parse wrapper. When certain per-account switches are on, it parses GraphQL and HTML data with its own untouched parser, and SimpleGram's data filter sees nothing. If that is active on Cam's account:
- **B9 (black feed, flashing post):** many more posts would be hidden on screen by tidyFeed with display:none inside Instagram's scrolling list, a likely cause of the blank area. Fixing B8 should cut those hides sharply.
- **Stories ads:** Stories data goes through the same GraphQL parser, so Story ads could get through too.
- **Search:** Instagram-run search requests get through the same way. SimpleGram's own search requests use fetch().json(), which is not affected.

The Following/Favorites flash (B11) shows that the first Home page did go through the filter. Fix D (stop Home at Instagram's 'caught up' marker and set fs.ended) also gives B11 a real end-of-Home signal.

Not confirmable without the logged-in phone:
- which of the three paths is active;
- the actual Env keys, switches and json5 setting for the account;
- how Instagram draws the caught-up block, since that code is only in logged-in bundles.

Stage 1 of the phone diagnostics works with 1.1 today. Network use: I made no new requests to instagram.com; I used only the files already downloaded.

######## REVIEW

=== B8 verdict=partly
--- corrections:
Summary: the structural part of the diagnosis is right and needed. Home is never ended at Instagram's marker, so Instagram moves on to its feed_recs pages. The stated MOST LIKELY root cause (ghost_owl bypass) does not fit the phone data, and neither does the streamed skip. The real mechanism is a fail-open the investigator never tested.

1. Phone data the investigator did not have. LEDGER.md B8 row, commit 100a717 at 23:16 UTC, one minute after the investigator's last file at 23:15: Cam's Filter status read 'Posts shown 2, Suggested removed 0, Pages read 8 (7 unrecognised)'. I did not see that screenshot myself; the numbers are as the ledger records them. What they prove, from the code:
- 8 lists went through filterFeedList (stats.feed.pages++ at line 346). So the Home pages DID reach the JSON.parse hook. This contradicts cause (1). Under Env.h4npx7qw or json5, Relay pages would never be counted (investigator's S2/S3: pagesFiltered 0).
- The streamed return (line 347) runs before the unknown check (line 349), and at least one page kept media. So 8 = 7 unknown + at least 1 recognised, which leaves streamed = 0. That rules out cause (2) for that session.
- Posts shown 2 means no further media with null follow info was kept. Cause (3) was not active in that session.

2. The real mechanism: unknownPages fail-open (simplegram.js:349-352, identical in 1.0 at line 304).
- feedVerdict returns media:false for ad nodes (line 275 returns before line 277). It also returns media:false for explore_story / suggested_users nodes (line 278; the media sits under explore_story.media, so mediaOf finds nothing) and for the demarcator (line 280).
- So a Home page made only of recommendation units ('if (list.length && !verdicts.some(x => x.media))') counts as 'unrecognised' and is returned untouched. Every suggestion survives, and nothing is counted as 'Suggested removed'.
- Only ads are still removed, by dropAds through AD_LIST_KEY 'edges' (line 469). That is why Cam saw suggestions but no ads.
- The demarcator's group_set.groups[].feed_items is filtered as a separate 'page' (visit line 462, 'k === feed_items'). In the real query those items are explore_story / ad units, so that list is also 'unrecognised' and kept. That is the 'Suggested Posts' section.
- An unrecognised page also skips the emptyStreak / stopPagination / nudge logic (lines 383-397). Paging never stops: the endless suggestions of the second try.
- Instagram's own code confirms the post-EOF units are explore_story / ad edges:
  - b344 getPolarisFeedRecsPagingToken.next reads 'explore_story.media' and 'ad' after the demarcator;
  - PolarisFeedHelpers.preprocessAndFilterFeedItems unwraps explore_story;
  - b102 polarisFeedDedupeIdsResolver renders explore_story as its own feed unit.

3. Reproduced. scratchpad/wf/feed-leak-review/unknown_pages.cjs feeds Relay-shaped pages (every XDTFeedItem key present, null when absent) through the unmodified 1.1 script, in this order:
- 2 friends;
- an explore+ad page;
- [explore hsmarken, demarcator with a group of explore_story items];
- 4 feed_recs explore/ad pages.
Result (unknown_pages.out.txt): 'Posts shown 2 | Suggested removed 0 | Pages read 8 (7 unrecognised) | streamed 0', exactly the phone's numbers. The output is 'ES:HSMARK1 EOF[ES:FANAT1,ES:NBA1] | has_next true': a not-followed post directly before the caught-up block, then the Suggested section, matching screenshots 6 and 7. All ads removed; has_next stays true throughout. One HTTP page that carries a demarcator counts as 2 'pages'.

4. Why the investigator's experiments missed it. Every fixture (ghost_owl_experiment.cjs page()) puts FRIEND1/FRIEND2 on the same page as the suggestions, and fills the after-EOF group with plain media items. So the page is always 'recognised'. The claim 'S0 shows plain JSON.parse drops all of them, including the after-EOF group' holds only for that fixture, and the fixture contradicts the investigator's own b344 evidence about post-EOF item shapes.

5. Ghost_owl. The code reading is accurate: I checked b25 'function W(){return L(),!v||b?null:g}' with 'c=l!=null&&"h4npx7qw"in l', and the b385 ghlParseRelayResponse order (boxed, wrapped, clean iframe parse, cr:7329 json5, then JSON.parse). But 'MOST LIKELY' is not supported. Downgrade it to a dormant risk with no evidence it is active on this account.

6. Streamed. Confirmed: the feed operations have 0 Defer and 0 Stream nodes (PolarisFeedTimelineRootV2Query, pagination and fragment .graphql modules). Together with streamed=0 on the phone, drop it as a cause.

7. Minor corrections.
- The fs.homePages>0 check is at line 585, not 589.
- The Following/Favorites flash proves only that the first page was recognised. It is equally consistent with later pages being 'unrecognised'.
- A further fake-end path the investigator missed: for a recognised demarcator-group list, filterFeedList(group, ...) runs hasMore(group). A group has no paging fields, so that returns false and line 397 sets fs.ended=true. That is a spurious end signal (relevant to B11).
- Null friendship_status (line 286) remains a possible explanation for the pre-EOF Follow posts in the FIRST session only. It is unconfirmed.
--- missedCauses:
* Primary, confirmed by the phone counters and reproduced exactly: the fail-open at simplegram.js:349-352. It treats any list without a plain 'media' node as an 'Instagram format change' and leaves it untouched. Pages made only of suggestion units (explore_story plus ads) and demarcator group lists pass through whole. Ads are still stripped by dropAds at line 469, which is why only suggestions showed. Those pages also bypass the empty-page stop at lines 383-397, so paging never ends.
* Demarcator group lists are filtered as separate pages (visit line 462). That is the 'Suggested Posts' section: it is 'unrecognised' when its items are explore_story, and when recognised it sets a fake fs.ended through hasMore(group)===false (line 397).
* 1.1's added load-ahead (scheduleNudge(false) at line 395) reaches the caught-up point sooner. The fail-open itself is unchanged since 1.0 (1.0 line 304).
--- fixPlanProblems:
* The plan does not fix the confirmed failure. Nothing changes the 'no plain media, so fail open' rule at line 349. Pre-EOF pages made only of suggestions (explore_story/ad) would still pass through whole, and so would demarcator-group lists when they are filtered as their own page.
* Part D does not say where it goes. If the end-at-marker code sits after the fail-open at line 349 (the natural place, next to the verdict loop), it never runs on a page like [explore_story, demarcator]. That page is 'unrecognised' and returns first. My reproduction shows exactly that page shape leaking hsmarken and the Suggested section.
* Part A (wrapping Instagram's module loader through a window.__d accessor) targets a cause the phone data contradicts. It is the most invasive change in the batch. A wrong factory.length, a double-wrapped stub replay, or a later classic-script __d redefinition breaks all of Instagram or silently disables the hook. It also forces Part B (WeakSet idempotency) only to undo its own double filtering. Defer both to a contingency that diagnostics would trigger.
* Part C (neutralise streamed pages in place) changes behaviour that has no evidence of being hit: no @defer/@stream in the feed ops, and streamed=0 on the phone. It also replaces a deliberate, tested design (tests/page.test.cjs:172-178). It adds risk (null-filled nodes going into the Relay store and an unconfirmed virtual list) for no observed gain. Showing the counter is enough.
* D.1 'drop every edge' on a feed_recs page can drop a friend's post if Instagram ever marks a transition page feed_recs (the server can set it through justknobx 2492, b404). Keep followed media there and drop the rest.
* D.2 'group_set = null' risks a null dereference in the logged-in demarcator renderer, which is not in the downloaded bundles. A React error there would blank the feed. Emptying each group's feed_items keeps the shape.
* Leaves in place a spurious end: fs.ended is set from hasMore() of owners that have no paging fields (demarcator groups, line 397).
* Leaves in place the end card's requirement that fs.homePages>0 (line 585). If the first Home page is already past the marker (Cam already caught up), no card appears.
* Test impact is not noticed. The existing test 'feed: JSON.parse keeps friends...' asserts has_next_page===true (tests/page.test.cjs:115) for mixedFeed, which ends with a demarcator on '/'. Any end-at-marker fix flips it, so it must be updated on purpose.
* The diagnostics snapshot calls Instagram's own GHLDetectionUtilsPreludeSafe.isJSONParseShimmed() and getCleanJSONParse(). These can create the hidden iframe and may emit 'ad_blocker_defense_ghost_owl' telemetry; require() of an unloaded module can throw or lazy-load a bundle. Only read window.Env key presence.
* The Stage 1 phone reading guide misses the outcome that actually happened ('Pages read' growing with most of them 'unrecognised'). It would have pointed the reader wrongly to cause 3.
--- revisedFixPlan:
Changes in simplegram.js plus the Filter status in MainActivity. No new request types; net requests go down. A scratch prototype implements steps 1-6: scratchpad/wf/feed-leak-review/make_patched.cjs builds simplegram.patched.js. Against it, the repo's 51 tests pass except the intended change at tests/page.test.cjs:115. Outputs: unknown_pages_patched.out.txt, extra_checks.out.txt, tests_patched.out.txt.

1. Recognise every feed unit Instagram's query selects, so pages of only suggestions are filtered and not failed open.
- Add const UNIT_KEYS = ['media','media_or_ad','explore_story','ad','suggested_users','suggested_users_v2','end_of_feed_demarcator','stories_netego','bloks_netego','ad4ad_in_webfeed','abra_icebreakers_in_feed_unit'].
- In feedVerdict (line 271), add v.known = UNIT_KEYS.some(k => node[k] != null). Also set known=true when adLike(node) or when mediaOf(node) is found.
- Keep v.media exactly as today: it still drives the kept counts, homeSeen, emptyStreak and followSuspect.
- Change line 349 to 'if (list.length && !verdicts.some(x => x.known))'. A page whose units are all unfamiliar keys (the existing post_v2 test) still fails open.
- explore_story stays dropped even when its owner is followed, as since 1.0.
- Result: [explore, ad, explore] pages come out empty and count as 'Suggested removed'. An empty Home page then follows the existing 1.1 rule: up to 4 in a row are nudged, then pagination stops.

2. End Home at Instagram's 'You're all caught up' marker. This goes in filterFeedList BEFORE the fail-open check, right after the verdicts are computed, and only when route()==='home' && feedVariant()==='home'.
- eof = the index of the first item whose node has end_of_feed_demarcator.
- If eof >= 0:
  - every item after eof gets drop:true and reason 'afterEnd';
  - for each group in its group_set.groups: add feed_items.length to stats.feed.afterEnd, empty the list in place (feed_items.length = 0), and set next_max_id = null. Keep group_set and the groups, so a renderer that looks up active_group_id still finds an object;
  - keep the demarcator edge, so Instagram's own 'You're all caught up' text stays;
  - stopPagination(owner) (has_next_page=false, so Instagram never sends the feed_recs request: b344 only switches when a later page is requested);
  - fs.ended = fs.caughtUp = true; stats.feed.eof++.
- Apply these overrides AFTER the followSuspect block, so it cannot undo them.
- Fallback if the phone shows an empty 'Suggested Posts' header or a broken block: drop the demarcator edge too (plain splice; the native end card then marks the end).
- Following and Favorites are untouched.

3. Safety net for recommendation pages on Home.
- Applies when the owner is a real connection (has page_info/pageInfo) and typeof owner.pagination_source==='string' && /recs/i.test(owner.pagination_source).
- Drop every item except media whose followState is true (reason 'afterEnd').
- Skip followSuspect for that page.
- stopPagination(owner); fs.ended = fs.caughtUp = true; stats.feed.recsPages++.
- With step 2 such pages should never be requested. This covers a server-side switch (b404: 'justknobx 2492 && n==="feed_recs"').

4. No fake ends. At line 397, set fs.ended from !more only when the owner is a paging object: page_info/pageInfo, or one of more_available / has_more / moreAvailable / hasMore present. Demarcator groups and other plain holders of feed_items no longer end Home (cross-reference B11).

5. End card at the real end. At line 585, use '(fs.homePages > 0 || fs.caughtUp)', so the Following/Favorites card also appears when Home opens already caught up. The login-screen test stays green, because caughtUp only comes from a real marker.

6. Instagram's own 'Suggested for you' rule. Add 'unconnected' to the inventory_source regex at line 267 (PolarisPost: inventorySource==='mixed_unconnected'). This drops such posts even without follow info. Optional: on Home, a media item with followState===null and a non-empty m.explore.title counts as 'suggested'. Do not drop on null follow state alone (the NOINFO1 behaviour stays).

7. Diagnostics. Shapes only: no usernames, codes, captions or URLs.
- Filter status, new 'Pages read' line: 'Pages read N (U unrecognised, S streamed)', plus a line 'Caught-up marker: E · after it removed: A · recs pages: R'.
- New counter: Home posts kept with unknown follow state.
- New counter: Home posts on screen with a 'Follow' button in the header. Count only, never hidden; this directly measures any remaining leak.
- 'Copy details' button (ClipboardManager in showStatus) copies a JSON ring buffer of the last 40 Home items considered. Each entry records:
  - page number;
  - unit kind: m (media) / x (explore_story) / a (ad) / e (end marker) / s (suggested users) / n (netego) / o (other);
  - verdict;
  - follow state: 1 / 0 / null / me;
  - inventory_source, cut to 32 characters;
  - product_type;
  - the social_context types;
  - the connection's pagination_source and has_next;
  - extensions.is_final.
- Ghost-owl indicator: only whether the keys h4npx7qw, v9k2mt7q, q9k7m2x and k8pq2mnb are present in window.Env, and whether JSON.parse is still our wrapper. Do not call Instagram's detection or require() functions.

8. Deferred (contingency only).
- The parser-module hook (investigator's A plus B idempotency): only if diagnostics show posts on Home while 'Pages read' stays at 0-1, or the ghost-owl Env keys are present.
- In-place filtering of streamed pages (C): only if the 'streamed' counter is ever non-zero on Home.
- Keep the streamed early return (line 347) as it is.

Edge cases:
- A pull-to-refresh on the same Home document keeps fs.ended (already true in 1.1): the card can appear at the bottom of the refreshed first page. Accept for now, or handle with B11.
- Up to 4 nudged loads when 4 suggestion-only pages arrive in a row before the marker, then Home stops. This is the 1.1 rule for ad-only pages; still far fewer requests than today's endless recs paging.
- Pre-EOF not-followed posts that are plain media with no friendship_status stay visible by design. 'Copy details' will show whether they exist and what inventory_source / social_context they carry, so a rule can be added safely.

Tests (tests/page.test.cjs):
- Update line 115. mixedFeed ends with a demarcator on '/', so assert has_next_page===false and stats.feed.eof===1. Lines 129 and 146 are unchanged.
- Add 'feed: a page of only suggestion units is filtered, not left alone'. Use the Relay shape with every unit key present and null when absent; [explore, ad, explore] gives empty edges, unknownPages 0 and suggested 2.
- Add 'feed: Home ends at the caught-up marker even when the page has no posts'. [explore, demarcator with a group of explore items, explore] gives [demarcator]; every group's feed_items is empty; has_next_page is false; and a feedEnd message with on:true arrives after scrolling to the bottom, with no Home post kept before.
- Add 'feed: friends before the marker are kept'. [friend, demarcator, explore] gives [friend, demarcator] with has_next false.
- Add 'feed: a feed_recs page on Home keeps only followed posts and stops'.
- Add 'feed: Following is not cut at a marker'.
- Add 'feed: inventory_source mixed_unconnected without follow info is dropped'.
- Add 'feed: a demarcator group list does not end Home'. fs.ended stays false and no feedEnd on:true message is sent.
- Add 'status: copied details contain no fixture usernames or codes'.
- Keep the existing 'unrecognised format is left alone' and streamed tests unchanged.

On the phone after the build: scroll Home past the caught-up point without reloading, then send Filter status and the 'Copy details' text.
Expected:
- Home stops under 'You're all caught up' with no Suggested section, and the Following/Favorites card appears there;
- 'unrecognised' is 0 or near it;
- 'Suggested removed' is above 0;
- the Follow-button count is 0.
The change cannot touch Accounts search, Back to results, sound, autoplay, downloads, zoom or comments: they do not go through filterFeedList, and the step 2-3 overrides run only when route is 'home' and the variant is 'home'.


######## CLUSTER black-feed

=== B9 Home goes black: long blank scroll, posts flash, spinner at the bottom but nothing new appears  [medium]

--- rootCause:
Most likely: SimpleGram's on-screen backup filter hides posts after they render (tidyFeed sets display:none!important; simplegram.js 636-640, 746-760, labels at 720-722), and it does so inside Instagram's virtualised Home feed. The feed list works like PolarisIGVirtualList: sizes are cached per index, a post not yet rendered reserves estimatedSize, and a post that measures 0 high is always kept mounted. When a run of posts gets hidden: (1) the user scrolls through space reserved for posts that collapse only after each is rendered, measured and hidden, which is black in dark mode, with Instagram's spinner below; (2) each post is drawn for up to about 300 ms before the throttled tidy pass (queueTidy 830-835) hides it: these are the flashes; (3) the list never grows, so Instagram keeps paging and every new post is hidden too ('spinner, nothing new loaded'). This only happens because the data layer lets labelled suggestions through. Two leaks are confirmed. (a) feedVerdict() returns media:false for explore_story nodes (276-278). A page of only explore_story and ad nodes therefore fails open in filterFeedList (349-353), and those are exactly the pages Instagram serves on Home after 'You're all caught up'. (b) Not-followed 'mixed_unconnected' posts pass, because the inventory_source regex at 267 lacks 'unconnected', CONTEXT_KEY (234) does not cover media.explore.title, and friendship_status is often missing. Instagram then shows a 'Suggested for you' line in their header, which tidyFeed matches and hides after they render.

--- alternatives:
[
 "WebView raster, GPU or video-decoder memory pressure: missing tiles show the black background and flicker. Plausible and made worse by hidden posts staying mounted (100+ video elements); it cannot be confirmed without the phone.",
 "Instagram side: recommendation pages that repeat or come back empty. The recs paging token is computed from the edges after the demarcator, and Instagram's client dedupe (polarisFeedDedupeIdsResolver) drops repeats, giving a spinner with nothing new.",
 "A main-thread stall (Instagram plus SimpleGram) delaying the rAF-driven window update during fast flings. Low: SimpleGram adds about 1% while the feed stays virtualised.",
 "Whether Instagram's actual PolarisVirtualFeed uses IGVirtualList cannot be confirmed: PolarisFeedPage.react and PolarisVirtualFeed are logged-in-only bundles. If it uses a different list, the flash still happens, but how much blank space appears depends on how that list estimates heights."
]

--- fixPlan:
1) Data layer, the root fix (shared with the suggested-posts cluster). feedVerdict (271-289): set v.media=true for explore_story nodes that have a media, and for ad-shaped nodes, so a page made only of recommendations is recognised and dropped. Fail open only when no edge matches any known shape (media, explore_story, ad, end_of_feed_demarcator). recommendedLike (265-270): match inventory_source unconnected|recs|recommend|explore|suggest|chaining|netego, and treat a string media.explore.title as suggested. Skip this when followState(m)===true (a followed coauthor). 2) End Home at Instagram's own 'You're all caught up'. In filterFeedList on Home (onHome): keep the end_of_feed_demarcator edge, drop every edge after it, empty its group_set.groups[*].feed_items, call stopPagination(owner), and set fs.ended and fs.caughtUp. Also: when owner.pagination_source==='feed_recs', drop everything and stop. Instagram then never pages into recommendations, and the existing end card offers Following and Favorites. 3) Make the DOM backup filter safe in a virtual list. (a) In the MutationObserver callback (2366), check posts in addedNodes right away, before paint, so a labelled post never flashes; keep queueTidy for re-checks. (b) Count consecutive hidden posts at the end of the feed in DOM order. At 3 or more, set fs.domStop: the next timeline page gets stopPagination, fs.ended is set and checkFeedEnd(true) runs. (c) For a hidden post, pause its videos and set preload='none'. 4) Blank-feed watchdog, run from the 1.5 s interval (604) when the user is not scrolling, there has been no scroll for 800 ms and no search is open. If no visible post, image or video crosses the content area (between the top bar and navHeight()) on 2 consecutive checks: count stats.feed.blank. If fs.ended or fs.domStop, scroll back to the last visible post and show the end card. Otherwise post 'feedBlank', and MainActivity shows a Reload button on the end card, at most once per 5 minutes and never reloading by itself. 5) scheduleNudge (547-573): never nudge after fs.caughtUp. Remove the pad with a setTimeout fallback, not only after 2 rAFs, and skip it when document.hidden. Cap nudges at about 10 per minute. 6) Native: handle 'feedBlank'; record onTrimMemory levels and renderer-gone details (didCrash, rendererPriorityAtExit) for Filter status. Edge cases: the demarcator can be the first item (nothing new), so Home ends right away and the card shows; Instagram's past_posts ('older posts') variant is not affected, and Following covers older posts.

--- risks:
Ending Home at the demarcator removes Instagram's 'Suggested Posts' completely, which is intended, and Home ends earlier on days with few new posts; the end card mitigates this. Checking added posts in the mutation callback forces a layout per batch, about 1-2 ms per post. The consecutive-hidden guard may end Home early if 3 ads or reposts in a row slip through to the screen; Following is still one tap away. Broadening recommendedLike could drop followed coauthor posts unless followState===true is checked first. The watchdog can misfire during flings or while images load, hence the idle requirement, 2 consecutive checks and the button instead of an automatic reload.

--- phoneDiagnostics:
On 1.1 now, with no new build: right after Home goes black, without reloading, open the menu, then More, then Filter status, and take a screenshot. The counts are since the page loaded, and Stories is a same-page navigation, so they survive going to Stories. 'Pages read: N (M unrecognised)' with M > 0 confirms the fail-open recommendation pages. A large 'Backup filter (hidden on screen) Suggested/Ads/Reposts' count confirms that posts were hidden on screen (the blank-space mechanism). Also note the Android System WebView version, and whether the app ever jumped back to the top by itself (a renderer crash, which recreates the activity). In a diagnostics build, add to Filter status (with a Copy button): stats.feed.paginationSources histogram, pages after caughtUp, inventory_source histogram of kept posts (values only), dom.maxConsecutiveHidden, peak posts and video elements in the DOM, blank-feed events and their duration, long tasks (PerformanceObserver 'longtask' count and max), maximum rAF gap, GraphQL requests per minute and HTTP status counts, and native onTrimMemory levels and renderer-gone details. Telling causes apart: many hidden posts plus unrecognised pages point to this bug. A low hidden count with a high peak of videos in the DOM and onTrimMemory events points to WebView memory pressure. Long tasks over 200 ms or large rAF gaps point to a main-thread stall. 429 or 'Please wait' responses point to Instagram throttling.

--- tests:
tests/page.test.cjs: (1) a page with only explore_story and ad nodes is recognised: its suggestions are removed, unknownPages=0. (2) A page containing end_of_feed_demarcator: edges after it removed, group_set feed_items emptied, page_info.has_next_page=false, feedEnd on. (3) Owner pagination_source 'feed_recs': everything dropped and paging stopped. (4) A mixed_unconnected post, or one with explore.title, is removed; a followed coauthor post is kept. (5) An article with a 'Suggested for you' row appended to the feed is already marked data-sg-hidden inside the next requestAnimationFrame (no flash). (6) Three hidden posts in a row: the next timeline payload has has_next_page=false and feedEnd is sent. (7) Port vlist.js (the IGVirtualList algorithm) into a fixture and replay scenario S4: after 20 s of scripted scrolling, 0 blank frames and at most 20 posts in the DOM. (8) Watchdog: a scrolled-to blank area yields one 'feedBlank' message and no reload loop. (9) Nudge cap and no nudge after caughtUp. On device: the Reload button on the end card after 'feedBlank'; onTrimMemory is recorded.

--- evidence:
* exp4-failopen.cjs (Playwright, real simplegram.js): a page with 3 explore_story nodes and 1 ad comes back with all 3 suggestions kept and stats.feed.unknownPages=1 (only the ad is removed, by dropAds). feedVerdict(explore_story node) = {drop:true, reason:'suggested', media:false}. A media node with inventory_source 'mixed_unconnected', explore.title 'Suggested for you' and no friendship_status is kept.
* b344.js PolarisFeed.react: m=d.some(function(e){...e.node.end_of_feed_demarcator}) and getPaginationSourceFromVariant(a,m,p). b404.js PolarisFeedContext: case 'home' returns PaginationSource.FEED_RECS once an end_of_feed_demarcator has been seen. b344.js getPolarisFeedRecsPagingToken.next reads the explore_story nodes after the demarcator: so after 'You're all caught up', Home pages are recommendation pages made of explore_story nodes (and ads).
* b353.js PolarisPost.react: Wt=de.inventorySource==='mixed_unconnected'&&Mt&&!$e; qt=(de.explore.title) or 'Suggested for you'; passed as suggestionText:qt. b250.js PolarisPostHeader.react draws suggestionText as its own row (IGDSTextBody2 children:L) under the username row (div _aaqt). That is exactly what headerLabel/SUGGEST_LABEL (721) hides.
* The feed is virtualised: b385/b102 PolarisFeedTimelineFragmentCachedQuery_items_connection.graphql spreads PolarisVirtualFeed_fragment on every XDTFeedItem node. b138 PolarisVirtualizedWithScrollLogging exports IGVirtualListWithLogging, with no logged-out consumer. b32 PolarisIGVirtualList: e.height===0?a=0; u=this.$14(0,l),c=this.$14(s,o),d=Math.max(0,l-a-u),m=s+a+c (zero-height posts widen the window); paddingBottom from sizeCache.getDistance. PolarisSizeCache.getSize returns estimatedSize until a post is measured. The window updates on rAF (PolarisBatchDOM). Home scrolls the document (b344 PolarisFeedRoot: window.scrollTo(0,C)).
* exp3-vlist.cjs + vlist.js, a vanilla port of IGVirtualList with Relay-style paging and the real script. S1, recommendation pages unfiltered but not hidden: 0/1499 blank frames, at most 8 posts and 5 videos in the DOM, 7 page requests in 25 s. S4, a run of posts hidden by tidyFeed: 360/1484 frames blank (24%), longest blank run 56 frames (855 px), 68 posts flashed on screen before being hidden (hide delay p50 264 ms, max 313 ms, 471 frames with a flash), 213 posts in the DOM (210 hidden) and 107 video elements, 26 page requests, and the native end card toggled on/off. With hidden wrappers 1px high instead of 0: still 29% blank and 148 flashes. S3, in-feed leaks with about half of them hidden: 50 posts and 50 videos mounted (vs 8 and 5) and 47 requests (vs 19) in 25 s.
* Candidate (a), main-thread cost (exp1-cost.cjs): with a virtualised DOM (15 posts), tidyNow averages 2.5-2.9 ms at 4x CPU throttle, under 1% of the main thread, at most 3.3 runs/s even with 20 mutation callbacks/s. Without virtualisation, 360 posts (40k elements): 10.7 ms mean at 1x; 48.9 ms mean and 123 ms max at 4x (14%). It grows linearly but is not enough to explain the blackness.
* Candidate (b), hide/unhide flapping: unhides=0 in every run. A hidden post re-checked after its signature changes scans the whole post (all rects are 0), which is a superset of the visible scan, so it only un-hides if the label text itself changes. Refuted as stated; the real effect is the hide-after-render flash plus zero-height posts.
* Candidate (c), nudges and pad: pads=0 in every run. In the black scenario, scheduleNudge never runs: fail-open pages return at 352, before any nudge (547-573). S2 and S4 with nudges on or off give the same blank frames and request counts.
* Candidate (d), Relay: PolarisFeedRootPaginationCachedQuery_subscribe.graphql has no Stream or Defer nodes, so 'streamed' (481) is never true for feed payloads. Edges are spliced before Relay normalises them, so the data stays consistent. No evidence of broken Relay items.
* Candidate (e), WebView: MainActivity sets no layer type, offscreen pre-raster, renderer priority or cache mode, and has no onTrimMemory. onRenderProcessGone recreates the activity (308-312). ZoomFrame.apply at scale 1 sets identity transforms; no setLayerType. SimpleGram's Maps are capped (99, 172, 373, 474) and its per-video state uses WeakSet/WeakMap. The memory pressure comes from Instagram keeping hidden posts mounted (107 videos in S4), not from SimpleGram's own structures.

=== B10 After the black Home episode, the Stories viewer takes a very long time to load  [low]

--- rootCause:
Most likely a consequence of B9 rather than a separate Stories bug. During the black stretch, Instagram keeps requesting pages (one per scroll, because hidden posts never grow the list), and with B4's early loading every page with 1-2 kept posts triggers the next one. Hidden posts stay mounted in Instagram's virtual list, so dozens to 100+ video elements (players, manifests, segments, decoders) stay alive. On top of that, Instagram prefetches media for each feed page (PolarisFeed.react startMediaPrefetch). When the user then opens Stories, its queries and videos compete with that backlog on the network and in the renderer, and may run into Instagram rate limiting. SimpleGram itself sends no requests of its own on Home or Stories, and nothing in the app detects throttling or memory pressure.

--- alternatives:
[
 "Instagram rate-limiting the account or session after many feed GraphQL requests (429 or 'Please wait a few minutes'), with retry backoff: matches 'eventually loaded'.",
 "Renderer memory or hardware video-decoder exhaustion from many mounted feed videos, so the Story video waits for resources or is decoded more slowly.",
 "Ordinary slow network (screenshot 3 shows Instagram's own spinner on Wi-Fi in another session) unrelated to SimpleGram."
]

--- fixPlan:
1) Fix B9 first: ending Home at the caught-up marker, recognising recommendation pages and the hidden-post guard remove both the paging loop and the mounted hidden videos. 2) Throttle detection: in the Response.json/XHR hooks, or a light fetch wrapper used only for /api/graphql, /graphql/query and /api/v1/, record status 429/5xx and bodies with status 'fail' plus 'wait' in stats.net. On throttling, pause SimpleGram nudges for 5 minutes and show one toast saying Instagram is slowing things down. 3) On leaving Home (routeChanged), pause and set preload='none' on video elements in hidden posts. 4) Native onTrimMemory: at TRIM_MEMORY_RUNNING_LOW or above while not on Stories, send a 'trim' command that unloads offscreen hidden feed videos; record the level for Filter status. 5) Stories timing metric: from the route change to 'story' until the first 'playing' or loaded Story image, kept in stats.story.loadMs (last 5) and shown in Filter status.

--- risks:
Unloading videos in hidden posts could confuse Instagram's player if a post is later un-hidden (rare; un-hiding happens only when the label changes). The throttle toast must not repeat. A fetch wrapper must stay transparent, cloning nothing large; prefer reading the status in the existing hooks.

--- phoneDiagnostics:
Now on 1.1: reproduce, then open Filter status before going to Stories, and again after Stories loads. A large backup-filter count supports the B9 link. Try Stories with mobile data off and on, or after force-stopping the app: if a fresh start loads Stories quickly, it points to in-page backlog or memory rather than the network. A diagnostics build should capture: GraphQL requests per minute and status counts (429, 'Please wait'), the number of video elements in the DOM and how many are still loading when leaving Home, stats.story.loadMs, onTrimMemory levels, renderer-gone details, and the long-task count and maximum.

--- tests:
(1) A mocked 429 on /api/graphql: stats.net.throttled increments and scheduleNudge does nothing for the cooldown. (2) A route change to /stories/x/1/ followed by a 'playing' event records stats.story.loadMs. (3) Leaving Home sets preload='none' and pauses video elements inside data-sg-hidden posts. On device: onTrimMemory delivers 'trim' to the page and the level shows in Filter status.

--- evidence:
* SimpleGram's own requests occur only on the download path (recordFor 1408-1422 calls fetchInfo, fetchStories and userIdFor) and on the search path (igGraphQL calls docIdFor's bundle scan and pageToken's fetch('/')), never on Home or the Stories viewer. The f) request-volume candidate is refuted for SimpleGram's own calls.
* exp3-vlist.cjs request counts per 25 s of scrolling: S4 (posts hidden on screen) 26 page requests vs 7 for S1; S3 47 vs 19 for S2. The video elements kept mounted reach 107 in S4 vs 5 normally.
* No handling of HTTP status or throttling anywhere: igGet returns null on !res.ok (1251); the Response.json and XHR hooks (512-538) only cleanse. MainActivity has no onTrimMemory/onLowMemory handler; only onRenderProcessGone, which calls recreate (308-312).
* SimpleGram's work on the Stories route is light: tidyStory (768-791) checks short texts, and unmute/findControl runs per play event (1064-1087). Measured tidy cost on a small DOM is about 2.5 ms per run at 4x throttle (exp1).

--- notes:
I could not test any of this on the phone. Instagram's real feed list, PolarisVirtualFeed / PolarisFeedPage.react, only loads for logged-in users, so it is not in the downloaded bundles. The virtual-list behaviour comes from b32 PolarisIGVirtualList, which the feed most likely uses through IGVirtualListWithLogging. B9 is therefore medium confidence: I reproduced the effect on a faithful port of that list, but its size on the phone is unconfirmed until the Filter status screenshot.

Overlap with the suggested-posts cluster: the fail-open at simplegram.js 349-353 (pages made only of explore_story/ad nodes) and the 'mixed_unconnected' / explore.title leak are also likely root causes of the suggested posts the user saw, and B9 depends on fixing them. One side effect showed up in the experiments: on the page holding the caught-up marker, filterFeedList also runs on the marker's group_set feed_items (visit 462). That group has no paging info, so hasMore(group) is false and line 397 sets fs.ended=true while Instagram keeps paging. In scenario S4 the native end card then flipped on and off (feedEnd false,true,false,true,false). This belongs with the end-of-Home card cluster.

Scratch files are in /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf/black-feed/:
- instrument.cjs: builds the profiling copy simplegram.instrumented.js
- feedpage.cjs: Instagram-like post DOM and page opener
- exp1-cost.cjs and exp1.out: candidate (a), tidy cost
- vlist.js: port of IGVirtualList, SizeCache and BatchDOM
- exp3-vlist.cjs and exp3.out, exp3b.out, exp3c.out: scenarios S1-S5
- exp3-vlist-1px.cjs: the 1px-wrapper variant
- exp4-failopen.cjs: the direct fail-open and mixed_unconnected check

Run any of them with NODE_PATH=/opt/node-tools/node_modules node <file>. No changes were made in /home/user/SimpleGram, and no requests were sent to instagram.com.

######## REVIEW

=== B9 verdict=partly
--- corrections:
WHAT HOLDS UP
- The data-layer fail-open is real, and phone data now backs it. feedVerdict() sets media only from mediaOf(node) (simplegram.js 276-277), which reads node.media / node.media_or_ad. An explore_story node keeps its media under explore_story.media, so it returns {drop:true, reason:'suggested', media:false} (278). A page made only of explore_story nodes therefore hits the fail-open at 349-353 and is left unfiltered. LEDGER.md (commit 100a717) records the user's Filter status from the second try: 'Posts shown 2, Suggested removed 0, Pages read 8, 7 of them unrecognised'. wf/feed-leak-review/unknown_pages.out.txt reproduces that exactly with explore_story-only pages. The investigator did not cite this phone evidence, but it is the strongest support for the root cause.
- Instagram changes how Home pages after the caught-up marker. b404 PolarisFeedContext: case "home" returns t||...&&n==="feed_recs"?PaginationSource.FEED_RECS:null. b344 PolarisFeed.react: getPaginationSourceFromVariant(a,m,p), where m = edges.some(...end_of_feed_demarcator). The recs token (b344 getPolarisFeedRecsPagingToken.next) is built from the explore_story nodes after the demarcator.
- Line 267's regex has no 'unconnected'. CONTEXT_KEY (234) does not reach media.explore.title. b353 labels a post when inventorySource==="mixed_unconnected"&&onFeedPage&&!ad, using explore.title or 'Suggested for you'. Note: this leak is latent only. With 'Posts shown 2', no mixed_unconnected media was kept in the session the user measured.
- Ruled out, as the investigator said: nudges (fail-open returns at 352, before scheduleNudge at 390/395); streamed payloads (pages 8 = 7 unknown + at least 1 recognised, so streamed = 0); and SimpleGram's own memory structures (all capped).
- The flash timing is right. My run measured hide delay p50 272 ms, max 309 ms (queueTidy, 830-835).
- The vlist port is faithful to b32 PolarisIGVirtualList: $14 counts zero-size items, $15 measures height 0 as 0, and the window is recomputed only on scroll ($16) or itemCount change.

WHAT IS OVERSTATED
1) The black-screen mechanism is not shown to be 'most likely'. It needs a long run of posts with an on-screen header label ('Suggested for you', 'Sponsored'). The user's evidence points the other way. Screenshots 1, 5 and 7 show suggestions with a Follow button and no label, and they were visible, so tidyFeed did not hide them. On the second try, explore_story pages failed open in the same way: suggestions kept loading and stayed visible, and the feed never went black. My experiment (wf/black-feed-review/exp-r1.cjs, exp-r1.out) used the investigator's port with data shaped like the phone's Filter status (2 friend posts, then unlabelled explore_story pages). Result: 0/1502 blank frames, 0 flashes, 8 posts in the DOM, Filter status kept 2 / suggested 0 / 8 unknown. Black frames appear only when I force every recommendation from page 6 on to carry a label: 139/1495 blank frames, 34 posts flashed, 100 posts and 50 videos in the DOM. The investigator's S4 makes every recommendation labelled, which contradicts the screenshots. Their own S1 and S3 runs (visible recommendations, or mixed) also had 0 blank frames.
2) The investigator's 'WebView raster/GPU/video memory' alternative fits just as well. MainActivity sets a black WebView, ZoomFrame and root in dark mode (136, 196; ZoomFrame constructor). Any unpainted area is therefore black, the fixed top bar and nav still paint, and Instagram's spinner animates. That matches screenshots 2 and 4 and 'flashed a few times'. Endless unfiltered recommendations, mostly Reels, put load on the renderer and decoders. Neither mechanism can be confirmed without the phone, so confidence should be 'low to medium, two candidates'. Both start with the same data leak, and ending Home at the caught-up marker removes both.
3) 'Instagram's past_posts variant is not affected' is not true as written. feedVariant() (302-305) maps ?variant=past_posts to 'home'. Also, the plan empties group_set.groups[*].feed_items, which includes the 'past_posts' (Older Posts) group of friends' posts. The fragment selects active_group_id and connected_group_id, so several groups are expected there.
4) The investigator's side note about line 397 applies only when a group list is recognised, meaning it contains a plain media node. An explore_story-only group returns at 352 first.

MISSED / NEW FINDINGS
- Feed state never resets. currentFeed() is keyed only on pathname|variant (293-298), and 'ended' is only ever set to true (386, 388, 397). Instagram re-fetches the Home head on the same URL (b344: refreshFeed -> window.scrollTo(0,0) + refetch), and the old state survives it. Experiment exp-r2.out: after a last page, a refetched head with has_next_page:true and the user at its bottom immediately posts feedEnd {on:true, caughtUp:true}. The plan adds more sticky flags (caughtUp means no nudges, domStop means stop the next page). After a refresh those would block early loading or stop Home after one page, so a reset rule is required.
- checkFeedEnd requires fs.homePages > 0 (585). In the plan's own edge case, where the demarcator comes first with nothing new, the end card would never appear.
- tidyStory scans 'section span, section div' across the whole document (773), and feed posts' action rows are <section>. tidyBanners walks up to 20000 text nodes, including hidden subtrees (687-695). If a large feed stays mounted under the Stories viewer, SimpleGram's tidy work on the Stories route grows with it. exp-r3.out at 4x throttle: 300 mounted posts gives tidy mean 51 ms, max 135 ms, 17.6% of the main thread; 30 posts gives 1.9%.

PROBLEMS IN THE FIX PLAN, CONFIRMED BY EXPERIMENT
- 3(a) (hide in the MutationObserver callback) must not ship without 3(b). It does remove the black frames and flashes (0 blank frames, 0 flashes). But Instagram then pages through the hidden posts unseen and keeps them mounted: 28 requests vs 23 per 25 s, 136 posts and 68 videos in the DOM (exp-r1-more.out). Adding a synthetic scroll to re-window the list floods requests: 61 requests per 25 s and 167 video elements (exp-r1.out). 3(a) plus a 4-post run guard gives 0 blank frames, 8 requests, 17 posts and 9 videos.
- 3(c): setting preload='none' does nothing for Instagram's MSE/DASH videos. Pausing them is enough.
- 4: an automatic scroll back is surprising, so drop it. The watchdog cannot detect a paint/GPU blackout where the posts are in the DOM but not drawn. Its count is still useful for diagnosis: black reported but blank=0 points to WebView rendering.
- 2: emptying every group drops friends' older posts. The group lists also need to stop affecting paging state (this fixes the end-card flapping).
- 1: treating media.explore.title as a suggestion is unproven for followed posts. Gate it on followState(m)!==true and count it under its own stat so false positives show up.
--- missedCauses:
* Possibly no posts were hidden at all: a WebView paint/memory blackout, made worse by endless unfiltered recommendation Reels. This fits the screenshots, where suggestions were visible and unlabelled, and the session-2 run that did not go black, better than a run of labelled posts.
* Feed state (ended/caughtUp) is per URL and never resets, so it survives Instagram's head refetch on the same URL (exp-r2: end card shows at once after the refresh). The plan's new sticky flags would turn this into a stalled Home.
* feedVariant() treats ?variant=past_posts as 'home', so ending Home at the marker, and the end card, would also apply to Instagram's Older Posts feed.
* checkFeedEnd's homePages>0 condition (585) hides the end card when the caught-up marker is the first item.
* tidyStory and tidyBanners scan the whole document, including hidden posts. With a large mounted feed that is up to 18% of the main thread on the Stories route (exp-r3).
--- fixPlanProblems:
* 3(a) alone moves the problem out of sight: Instagram keeps paging through hidden posts and keeps them mounted (exp-r1-more: 28 vs 23 requests per 25 s, 136 posts and 68 videos in the DOM). With a synthetic scroll it becomes a request flood (61 requests per 25 s, 167 videos). It must ship together with the run guard.
* Emptying group_set.groups[*].feed_items also removes the past_posts (Older Posts) group of friends' posts. The claim that past_posts is unaffected is wrong, because feedVariant() maps it to 'home'.
* Sticky fs.caughtUp/domStop flags with no reset would stop or slow Home after Instagram re-fetches the head on the same URL.
* The edge case 'demarcator first, end card shows' fails, because checkFeedEnd requires homePages>0.
* preload='none' on hidden or offscreen videos, and the B10 'trim' unloading, has no effect on MSE videos or risks breaking them.
* Watchdog auto-scroll is unexpected, and the watchdog cannot see a paint-level blackout.
* Treating media.explore.title as suggested could drop friends' posts if Instagram sends 'explore' on them, and friendship_status is often missing.
--- revisedFixPlan:
Goal: Home ends at Instagram's 'You're all caught up', recommendation pages are never left unfiltered, and the on-screen backup filter cannot produce black space or a paging loop. No new requests.

1) Data layer (the root fix; coordinate with the feed-leak cluster). feedVerdict (271-289):
- m = mediaOf(node) || mediaOf(node.explore_story). An explore_story with a media returns {drop:true, reason:'suggested', media:true}.
- adLike(node) with a media or ad payload returns media:true.
- A page counts as recognised if any edge is a media, explore_story, ad, end_of_feed_demarcator, suggested_users, stories_netego or bloks_netego. Fail open (349-353) only when no edge matches any of these.
- recommendedLike: return early if followState(m)===true. Add unconnected|recs to the inventory_source regex. Treat a string media.explore.title as suggested only when followState(m)!==true, and count it as stats.feed.exploreTitle.

2) End Home at the marker, decided per page, never sticky.
- feedVariant() returns 'past_posts' for ?variant=past_posts and leaves that feed alone.
- Give filterFeedList(owner, list, ctx) a ctx.group flag. Calls from k==='feed_items' (462) are group lists. On variant 'home', a group with id or pagination_source !== 'past_posts' is emptied. The past_posts group gets the normal verdict filter. Group lists never touch emptyStreak, seenStreak, ended, homePages or nudges, and never call checkFeedEnd.
- On the timeline owner (461), variant 'home': if a kept edge is end_of_feed_demarcator at index d, splice out every edge after d, stopPagination(owner), set fs.caughtUp=fs.ended=true and call checkFeedEnd(true).
- If owner.pagination_source==='feed_recs': empty the edges, stopPagination, fs.ended=true.
- Reset rule (handles head refetches): a timeline page on 'home' with at least 1 kept followed media, has_next_page true, no demarcator and pagination_source!=='feed_recs' sets fs.ended=fs.caughtUp=fs.domStop=false and resets both streaks.
- checkFeedEnd (585): allow (fs.homePages>0 || fs.caughtUp).

3) DOM backup filter. Ship (a) and (b) together, never (a) alone.
- (a) The MutationObserver callback (2366) collects posts from addedNodes (n.closest(POST), else n.querySelectorAll(POST); a Set per batch). It runs headerLabel on each and hides labelled posts before first paint, filling the checked WeakMap. queueTidy stays for re-checks.
- (b) After each check on variant 'home', count consecutive articles at the end of DOM order hidden as 'suggested' or 'ads' (not reposts). At 4 or more, set fs.domStop. The next Home timeline page gets stopPagination, fs.ended=true and checkFeedEnd(true). Reset by the rule in 2. Do not dispatch synthetic scroll events.
- (c) When hiding a post, pause any playing <video> inside it. Change nothing else on the player.
- (d) The tidyStory selector and the tidyBanners walker skip [data-sg-hidden] subtrees and <article> content (tidyBanners already ignores articles for matching but still walks them).

4) Diagnostics only, no automatic actions.
- On Home's 1.5 s interval (604), when idle (no touch, no scroll for 800 ms, no search, not zoomed, no split view): if no article/img/video rect crosses the band between the top bar and navHeight() on 2 consecutive checks, increment stats.feed.blank. If fs.ended or fs.domStop, call checkFeedEnd(true). Otherwise post 'feedBlank' once; native counts it and may offer a user-tapped Reload on the end card at most once per 5 minutes. No automatic scroll or reload.
- Filter status gains: unknown pages after the marker, domStop, longest hidden run, peak posts and videos in the DOM, blank events, long-task count and max (PerformanceObserver 'longtask', guarded by try/catch), native onTrimMemory levels, and renderer-gone didCrash/rendererPriorityAtExit (minSdk 29). Add a 'Copy diagnostics' button (counts and shapes only, no names).

5) Nudges (547-573):
- No nudge when fs.caughtUp, fs.ended or fs.domStop, or when document.hidden.
- At most 10 per sliding minute.
- Lower the seenStreak cap from 40 to 15. It is the largest automated paging burst in the app.
- Remove the pad with a setTimeout(…,150) fallback as well as the double rAF.

Risks: Home ends earlier on quiet days; the end card offers Following and Favorites. A labelled run of 4 at the end of the feed may end Home early; Following is one tap away and the head reset reopens Home. Checking posts in the observer callback costs about 1-2 ms of layout per new post.

Tests (tests/page.test.cjs):
- explore_story+ad page: recognised, suggestions removed, unknownPages 0.
- Demarcator page: edges after the marker removed, has_next_page false, feedEnd on.
- Demarcator as the first edge: end card shows.
- group_set: the feed_recs group is emptied; past_posts friend items are kept, with not-followed items removed; no fs change from groups.
- pagination_source 'feed_recs': emptied and stopped.
- Head refetch after the end: fs reset, no immediate feedEnd (replay exp-r2).
- ?variant=past_posts untouched.
- A labelled article is marked data-sg-hidden before the next rAF.
- Port exp-r1 into a fixture: run guard gives 0 blank frames, at most 10 requests and at most 20 posts in 25 s; without the guard the test documents the loop.
- Nudge cap.
- feedBlank posted once.

Phone confirmation, no build needed:
- Look at the Filter status screenshot the user already sent from the second try, at the 'Backup filter (hidden on screen) Suggested: N' line, which LEDGER.md does not record.
- Next time Home goes black, open Filter status immediately. Backup Suggested in the tens means the hidden-run mechanism. Backup Suggested near 0 with many unrecognised pages means a WebView paint/memory blackout; it is still prevented by step 2.

=== B10 verdict=unverifiable
--- corrections:
What I could verify:
- SimpleGram sends no requests of its own on Home or Stories. fetch is used only in igGet/igGraphQL/igPost (1245-1366, 1601-1620), called from downloads (recordFor) and search (1706-1841).
- No HTTP status or throttle handling exists (igGet returns null on !res.ok; the hooks at 512-538 only cleanse).
- MainActivity has no onTrimMemory, and onRenderProcessGone just calls recreate (308-312).

What I could not verify: the stated root cause ('consequence of B9') rests on the hidden-run model. With data shaped like the phone's Filter status (unlabelled recommendations), 1.1 makes about 9 page requests in 25 s of fast scrolling and keeps 8 posts and 4 videos in the DOM (exp-r1.out). That is ordinary Instagram behaviour, so in that case SimpleGram adds no paging backlog for Stories to compete with.

A conditional SimpleGram contribution the investigator missed: if a large feed stays mounted (which happens only in the hidden-run case), SimpleGram's tidy pass on the Stories route scans the whole document. tidyStory's 'section span, section div' selector (773) matches every feed post's action row, and tidyBanners walks up to 20000 text nodes per second (687). exp-r3.out at 4x throttle: 300 mounted posts gives tidy mean 51 ms, max 135 ms, 17.6% of the main thread during Stories; 30 posts gives 1.9%.

Other explanations are equally likely and cannot be told apart without the phone: renderer or decoder memory pressure; Instagram rate-limiting after heavy paging into recommendations; and plain network slowness (screenshot 3 shows Instagram's own spinner on Wi-Fi in an unrelated session).

Two plan items are risky and should go: (3) setting preload='none' and pausing videos on leaving Home, and (4) a native 'trim' command that unloads offscreen feed videos. preload does nothing for MSE/DASH players. Removing src or reloading under Instagram's player can break playback and trigger fresh downloads, which is more network traffic, not less.
--- missedCauses:
* SimpleGram's tidyStory (selector 'section span, section div', 773) and tidyBanners (687) scan the whole document on the Stories route. With a large feed still mounted that is about 18% of the main thread at 4x throttle (exp-r3). It matters only if the Home feed stays mounted with many posts, which is the B9 hidden-run case.
* The unfiltered endless recommendations alone, with no hiding, make Instagram prefetch media for every recommendation page (b344 PolarisFeed.react startMediaPrefetch). That competes for bandwidth even with a normal virtualised DOM.
--- fixPlanProblems:
* Setting preload='none' or pausing videos on route leave does nothing for Instagram's MSE/DASH videos, and Instagram already pauses videos that are not visible.
* A native 'trim' command that unloads Instagram's feed videos could break Instagram's player state and cause re-downloads: more network traffic, and a possible regression in feed video playback and sound.
* The plan never says how to tell the causes apart on the phone. A Stories load-time metric is needed alongside the network and memory counters, so that slow network, throttling, memory pressure and a busy main thread can be distinguished.
--- revisedFixPlan:
1) Ship the B9 data-layer fixes. Ending Home at the caught-up marker and recognising recommendation pages removes the endless paging and media prefetch that Stories would compete with. This is the only behaviour change that targets the likely cause.

2) Cheap SimpleGram-side reductions, safe whatever the cause:
- tidyStory searches only inside the Story viewer: elements whose rect top is within the top 20% of the screen, outside any <article> and outside [data-sg-hidden]. Use a TreeWalker or elementsFromPoint over the header band instead of document-wide 'section span, section div'.
- tidyBanners' TreeWalker rejects [data-sg-hidden] and <article> subtrees (NodeFilter.FILTER_REJECT on elements).
- Re-run exp-r3 as a test: tidy at most 10 ms mean at 4x throttle with 300 mounted posts on the Stories route.

3) Passive throttle detection, with no extra requests and nothing cloned. In the Response.prototype.json hook (514) and the XHR response getter (528), read this.status and this.url/responseURL. For /graphql, /api/graphql and /api/v1/, count 429s and 5xx responses in stats.net, plus JSON bodies with status:'fail' and a message matching /wait|try again/i. On the first throttle signal, suspend scheduleNudge for 5 minutes and post one toast: 'Instagram is slowing down requests; try again in a few minutes'. At most one toast per 10 minutes.

4) Stories timing: on a routeChanged into 'story', start a timer. Stop it at the first 'playing' event, or at the first img load whose box is at least 50% of the viewport. Keep the last 5 values in stats.story.loadMs and show them in Filter status, with the number of <video> elements in the document at the moment Stories opened.

5) Native, record only:
- onTrimMemory(level), with a timestamp, kept for the last 10 and shown in Filter status.
- RenderProcessGoneDetail didCrash() and rendererPriorityAtExit(), saved to prefs before recreate().
- No 'trim' command, and no changes to Instagram's video elements beyond B9's pausing of videos in hidden posts.

Phone confirmation:
- On 1.1, right after a slow Stories load, open Filter status: a high 'Backup filter Suggested' count links it to B9's hidden posts.
- Force-stop the app and reopen Stories: if it loads quickly, the cause was in-page (memory or main thread), not the network or the account.
- With the diagnostics build: stats.net 429 or 'wait' responses mean throttling. onTrimMemory events or a high video count mean memory pressure. stats.story.loadMs high with none of these means network.

Tests:
- A mocked 429 on /api/graphql increments stats.net.throttled, scheduleNudge does nothing for the cooldown, and exactly one toast message is sent.
- pushState to /stories/x/1/ followed by a 'playing' event records stats.story.loadMs.
- exp-r3 budget test for tidy on the Stories route.


######## CLUSTER feed-end

=== B11 End-of-Home card flashes early (on a 4 s timer while Instagram is still loading) and is missing at the real end ("You're all caught up" is never used as the end)  [high]

--- rootCause:
There are two separate defects, and both come down to the card never being driven by the data-level end of Home.

(1) Early flash. checkFeedEnd (simplegram.js 580-597) shows the card when `nearBottom && (fs.ended || atBottomSince && now - atBottomSince > 4000)`. The only condition is that one Home page has kept posts (`fs.homePages > 0`, line 585). With 1-2 kept posts the page is short (about 1360px against an 820px viewport), so after the second post the user is within max(400, 0.6*innerHeight) ≈ 490px of the bottom. If Instagram's next page takes more than 4 s, or Instagram's own load trigger is closer to the end than 490px, the 4-second timer fires and the card appears. The next page then renders, nearBottom turns false, and the card hides about 0.25-1.5 s later (the scroll listener at line 599 and the 1.5 s interval at line 604). That is the 'split second' pop-up before more posts load.

(2) Missing at the real end. Four things combine:
(a) `fs.caughtUp` is never part of the show condition (line 589 uses only fs.ended or the timer). It is only passed along in the message (line 595), and MainActivity ignores it: line 483 reads only "on".
(b) When Instagram's own code sees end_of_feed_demarcator in the feed's edges, it switches to pagination_source=FEED_RECS. Those recommendation pages are made of explore_story units. feedVerdict drops explore_story, but mediaOf() returns null for those nodes (lines 206-211 and 276-278), so `v.media` is false and the whole page counts as 'unrecognised' and is left alone (lines 349-353). That return comes before the emptyStreak/ended/nudge bookkeeping, so the feed never ends. Instagram keeps paging (has_next_page true), the page keeps growing, and the user is never at the bottom for 4 s.
(c) If the marker shares a page only with explore_story units (screenshot 6: hsmarken directly before the block), the page is unrecognised and line 376 never runs, so even caughtUp stays false.
(d) The marker's own group_set.groups[].feed_items ('Suggested Posts' / 'Older posts') are walked as separate 'pages' by visit() line 462 (`k === 'feed_items'`). That inflates 'Pages read', and when they hold plain posts, `!hasMore(group)` sets fs.ended from a nested list (line 397).

On top of this, currentFeed() keys the state by `location.pathname + '|' + variant` (lines 292-299). Opening a post, a profile or Stories and coming back creates a fresh state (homePages 0, ended false). Instagram keeps its cached feed and sends no new page, so the card cannot come back after a trip to Stories.

--- alternatives:
[
 "The hsmarken post before the marker is an explore_story in a page without plain posts. That's B8's recognition gap, not B11, but it also kept caughtUp from being set (E3).",
 "Second try ('showed for a couple of seconds, then vanished as more suggestions loaded'): the marker came in the first page. Either the timer, or a nested marker group of plain posts setting fs.ended (E4), showed the card while near the bottom, and Instagram's FEED_RECS pages then grew the page under it.",
 "Less likely: Instagram's mobile renderer may draw the 'Suggested Posts' header from the marker's group_set rather than from the recs pages. Either way, removing the marker and stopping pagination removes both."
]

--- fixPlan:
Page script (simplegram.js); prototype in scratch fix.diff:
1. Feed state per variant, not per path. Replace feedState/currentFeed (292-299) with `feedStates: Map<variant, state>` and `lastVariant` (updated only while route()==='home'). Opening a post, profile or Stories and coming back keeps ended/caughtUp. Start a feed over only on a document load or an Instagram refresh. Detect a refresh by cursor: an ended feed cannot paginate, so a timeline page whose end_cursor (or next_max_id) differs from `fs.endCursor` is a refetch: reset the state and post feedEnd off. The same page parsed twice (same cursor) stays the end. Record `fs.endCursor = cursorOf(owner)` whenever ended is set.
2. Data-level end of Home in filterFeedList. This must run right after the `streamed` return and BEFORE the fail-open return at 349, so it also works on pages the filter doesn't recognise. Find the first edge with end_of_feed_demarcator. On variant 'home' only, if the marker is found OR `owner.pagination_source === 'feed_recs'`:
   - remove the marker edge and everything after it (`list.splice(at)`; for a feed_recs page, all edges);
   - `stopPagination(owner)`;
   - set `fs.caughtUp = fs.ended = true` and keep `fs.endText = {title, subtitle}` from the marker;
   - add a `stats.feed.afterEnd` count.
   Then filter the part before the marker as usual (that part is B8's: explore_story-only content must not fail open). Remove line 376.
   Default choice: drop the marker edge. Dropping edges and has_next_page=false are shapes SimpleGram already sends and that work on the phone. The alternative is to keep Instagram's block with `group_set=null` (tolerated by Instagram's relay-to-redux code, b385), but its renderer can't be checked logged out.
   Groups inside any marker (all variants): add each group's feed_items array to a WeakSet `markerLists`; filterFeedList returns immediately for those, so they are never read as pages or set ended.
3. checkFeedEnd. Drop atBottomSince and the 4 s rule entirely, including line 918 in routeChanged. Drop the homePages condition; the login-screen test still passes because ended is never set. `show = route home && variant home && fs.ended && !searching && gap < (shown ? innerHeight : max(400, 0.6*innerHeight))`; the wider hide distance stops flicker. Post `{on, caughtUp, title, subtitle}`. Keep the scroll listener and the 1.5 s interval; they are cheap and only matter once ended.
4. Card position. Instagram's block is gone, so the native card (bottom-centre, 72dp above the bottom nav, about 110dp tall) is the end marker. While a Home feed is ended, add a body-level spacer `#sg-end-room` (170 CSS px, aria-hidden, pointer-events:none) so the last post's action row and caption can scroll clear above the card. Remove the spacer on any other route; checkFeedEnd(true) already runs on every route change. The nudge code already appends body pads this way.
5. MainActivity (optional, cosmetic). In 'feedEnd', when caughtUp is true and subtitle is non-empty, show Instagram's subtitle ("You've seen all new posts from the past 3 days.") above "Keep going, newest first, without repeats:". That needs fields for the title and sub TextViews made in makeFeedBar (594-607). No change to updateFeedBar logic.
6. Coordination with B8 (feed leak): B8 owns recognising explore_story-only pages as suggestion pages (drop, count towards emptyStreak, never fail open) and the DOM backup. B11's cut runs before B8's fail-open logic and needs nothing from B8. Moving the marker out of mixedFeed() touches the same fixtures B8 will edit. Optional extra backup: if Instagram's 'You're all caught up' text shows up in the DOM on Home while fs.ended is false, set a flag so the next Home page is blanked and stopped.
7. Edge cases:
   - Following/Favorites keep Instagram's marker (Instagram never switches them to recs) and get no card.
   - Pull-to-refresh or a Home-tab tap after the end goes through the cursor-change reset.
   - Menu → Refresh reloads the page, which resets everything.
   - Declare `let feedEndShown` before filterFeedList in the real patch: it's used there, and is safe today only because the JSON.parse hook first fires after the IIFE finishes.

--- risks:
Home now ends at Instagram's marker, which can come after only a few posts when friends post rarely. That is intended (Following continues, newest first), but Instagram's own 'Older posts' group is no longer offered on Home. The refetch detection assumes the refreshed first page has a different end_cursor. If not, the card could linger after a refresh until the next end, and a reload fixes it. The pagination_source === 'feed_recs' rule depends on the response echoing it (unverified, harmless if absent). It would empty Home if Instagram ever labelled a normal first page feed_recs, which still keeps to friends-only. The spacer assumes the document is the scroller, as the existing nudge code already does; otherwise it is a no-op. Dropping the marker means Instagram's own caught-up block isn't shown; the card carries its subtitle instead.

--- phoneDiagnostics:
Already in hand: the 1.1 Filter status (Posts shown 2, Suggested removed 0, Pages read 8, 7 unrecognised) matches the replay exactly. To confirm the remaining details, use the planned 'copy diagnostics' (B8), or a debug build with chrome://inspect. Record per timeline page: the edge node key sets (e.g. [media], [explore_story], [end_of_feed_demarcator]), the marker index, connection.pagination_source, has_next_page, whether end_cursor changes after a pull-to-refresh, and for the marker its group ids, pagination_source and feed_items key sets. No names. After the fix, check on the phone: at the caught-up point the spinner stops, no 'Suggested Posts' header appears, and 'Pages read' stops growing. The card appears only at the very end, does not cover the last post, and comes back after watching Stories and returning. A Home-tab tap or refresh after the end starts a fresh feed with no early card.

--- tests:
Add to tests/page.test.cjs (drafted and run as scratch feed-end.test.cjs; all 8 fail on 1.1 and pass on the prototype):
1. No card while Instagram is still loading: 2 posts, at the bottom for 6.5 s, has_next true → no on:true.
2. The marker ends Home: [F1, F2, marker(with groups), explore, F] → codes [F1, F2], has_next false, stats.feed.pages === 1, card on at the bottom with caughtUp and the subtitle, #sg-end-room present.
3. A marker in a page without plain posts still ends Home.
4. A pagination_source 'feed_recs' page → no edges, has_next false.
5. The card comes back after /p/... and Back, with no spacer while on the post.
6. A refresh with a new cursor after the end starts over: posts kept, has_next true, no card.
7. The same end page parsed twice stays the end.
8. Following keeps the marker, its groups are not counted as pages, and there is no card.
Also move the marker edge out of mixedFeed() and update the expectations: drop 'end_of_feed_demarcator' from 3 code lists, 6→5 in 'injecting twice', 12→11 in the streamed test. With that, the full suite passes 51/51 on both 1.1 and the prototype. On-device check: scroll Home to the end, then Stories and back, then Home-tab refresh.

--- evidence:
* simplegram.js 589: `show = nearBottom && (fs.ended || (atBottomSince && Date.now() - atBottomSince > 4000));`. caughtUp is not a condition. 585: only `fs.homePages > 0` is required. 604: setInterval every 1.5 s.
* MainActivity.java 481-486: `case "feedEnd": ... feedWanted = m.optBoolean("on");`. The caughtUp field is ignored.
* simplegram.js 278 drops explore_story nodes, but 276 `mediaOf(node)` is null for them, so 349-353 `if (list.length && !verdicts.some(x => x.media)) { stats.feed.unknownPages++; return; }` passes the page through untouched, before the lines 376/383-398 that would set caughtUp/emptyStreak/ended.
* b404.js (PolarisFeedContext.react): `case"home":return t||r("justknobx")._("2492")&&n==="feed_recs"?o("PolarisFeedTypes").PaginationSource.FEED_RECS:null`
* b344.js (next-page variables): `m=d.some(function(e){...return ...t.end_of_feed_demarcator}),p=l==null?void 0:l.pagination_source,...f=o("PolarisFeedContext.react").getPaginationSourceFromVariant(a,m,p);if(f!=null&&(_=babelHelpers.extends({},_,{pagination_source:f}),f===...FEED_RECS)){var g=r("getPolarisFeedRecsPagingToken.next")(d)`. Once the marker is in the edges, every next page is a recommendations page.
* b344.js getPolarisFeedRecsPagingToken.next: `n=function(t){var e;return((e=t.explore_story)==null?void 0:e.media)!=null},o=r("findLast")(e,n)`. Recs pages consist of explore_story units.
* b385.js PolarisFeedTimelineRootV2Query.graphql: the connection selects pagination_source. end_of_feed_demarcator selects {id,title,subtitle,group_set{__typename,id,active_group_id,connected_group_id,groups{next_max_id,id,pagination_source,title,feed_items{media,explore_story,ad,suggested_users...}}}}. PolarisFeedTypes: `{FOLLOWING:"following",FAVORITES:"favorites",FEED_RECS:"feed_recs",PAST_POSTS:"past_posts"}`.
* b385.js subscribeToPolarisRelayFeed: `group_set:babelHelpers.extends({},(...group_set)||{},{groups:a})`. Instagram's own plumbing tolerates a null group_set. b344: the feed is a relay usePaginationFragment (hasNext/isLoadingNext/loadNext), so has_next_page=false stops Instagram's paging.
* Experiment exp.cjs E1 (unmodified 1.1 script): 2 kept posts, scrolled to 700/1360px, next page delayed. Messages: `6004ms on=true`, then `6741ms on=false` after the next page rendered. This is the early flash.
* Experiment exp2.cjs: page 1 = [FRIEND1, FRIEND2, marker whose group holds an explore_story], then 6 explore_story-only pages. Result: `Posts shown 2 | Suggested removed 0 | Pages read 8 (7 unrecognised)`. That exactly matches the user's Filter status recorded in LEDGER B8. All 7 pages kept every edge, has_next stayed true, fs.ended stayed false.
* exp.cjs E3: [explore_story hsmarken, marker] → `caughtUp:false, unknownPages 1`. E4: a marker group holding plain posts → nested list counted as a page, `ended:true, homePages:2`. E5: ended, then pushState /p/ABCDEF1/ and back → state `homePages:0, ended:false`, and no card after 6 s at the bottom.
* Prototype in scratch (sg-fix.js): the 8 new tests fail 8/8 on 1.1 and pass 8/8 on the prototype. The existing 51-test suite passes 51/51 on both once the marker is moved out of the mixedFeed() fixture.

=== B15 SimpleGram's floating menu button covers Instagram's Save icon (low priority)  [medium]

--- rootCause:
MainActivity places a 40dp round button on the right edge with a 6dp margin at 58% of the screen height (root.addView at 158-159; placeMenuButton 835-844: `x(left ? margin : w - size - margin)`, `prefs.getFloat("menuY", 0.58f)`). That covers roughly the right 46dp of every post's action row as it scrolls through mid-screen, which is where Instagram's Save button sits (its tap area is about the right 44 CSS px). The left edge would cover the Like heart instead. The button can already be dragged (onTouch 784-827: past touch slop it follows the finger, snaps to the nearest side, and remembers side and Y), but nothing in the app or README says so.

--- alternatives:
[
 "Leave it and document dragging in README and About only.",
 "Fade the button to about 25% while the feed is scrolling. This doesn't help when you stop on a post, as in screenshot 6."
]

--- fixPlan:
Cheap option:
(1) Show a one-time hint on first launch ('Tip: drag ⋮ up, down or to the other side'), stored in prefs.
(2) Make the idle button a slim edge tab instead of a circle: about 18x44dp, flush with the screen edge (margin 0), rounded on the inner side only, same dark background at about 45% alpha. It then stays clear of the Save icon itself (about 12-36px from the edge), while the full-size press feedback (alpha 0.8) stays as now.
(3) Call setSystemGestureExclusionRects for the tab's bounds (API 29+) so dragging it with gesture navigation doesn't trigger system Back. Keep the existing snap and persistence. Optionally move the default Y to about 0.72 (below mid-screen).
Not worth it: following Instagram's action rows from the page script.

--- risks:
A thinner tap target is easier to miss. On Samsung, a right-edge tab can sit near the Edge Panel handle; the user can drag it to the left.

--- phoneDiagnostics:
None needed. After the change, check on the S25 Edge (gesture navigation, Samsung Edge Panel handle on the right) that a tap on a post's Save icon under the tab saves the post, the tab still opens the menu, and dragging it doesn't trigger Back or the Edge Panel.

--- tests:
Native/manual only: tap Save under the tab, tap the tab, drag the tab with gesture navigation on, and check the hint shows once.

--- evidence:
* MainActivity.java 835-844: right side by default, 6dp margin, Y = 0.58*h clamped to [56dp, h-100dp].
* MainActivity.java 800-818: dragging moves it, and on release it snaps to left or right and saves menuLeft/menuY.
* README.md only mentions the ⋮ menu for downloads and screenshots (lines 26, 39); dragging is not documented anywhere.
* Screenshot 6: the button sits over the Save icon of the hsmarken post.

--- notes:
Read-only on the repo; nothing was edited or committed. No requests were made to www.instagram.com in this cluster (bundle grep only).

Everything below is in /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf/feed-end/:
- exp.cjs / exp.out: experiments E1-E5 against an instrumented copy (sg-probe.js only adds SG.__feed).
- exp2.cjs / exp2.out: exact replay of the user's Filter status numbers (2 shown / 0 suggested / 8 pages / 7 unrecognised).
- make-fix.py builds sg-fix.js from sg-orig.js; fix.diff is the prototype diff (about 160 lines).
- feed-end.test.cjs: the 8 proposed tests. Run with `SG_SCRIPT=<script> NODE_PATH=/opt/node-tools/node_modules node --test feed-end.test.cjs`.
- suite/page2.test.cjs: the existing suite with the marker moved out of mixedFeed(). It passes 51/51 on 1.1 and on the prototype.

Points for the other clusters:
- B8: the recs pages Instagram loads after the marker are explore_story units (b344 getPolarisFeedRecsPagingToken.next). feedVerdict drops them but marks them non-media, so whole pages fail open at simplegram.js 349-353. That is the mechanism behind '7 unrecognised'.
- B9/B10: stopping pagination at the marker removes the endless recs growth that came right before the black feed.

Could not be confirmed logged out: how Instagram's mobile renderer (PolarisFeedPage.react, not in the logged-out bundles) draws the marker's group_set and the 'Suggested Posts' header. Whether the recs page response echoes pagination_source 'feed_recs' is also unconfirmed.

######## REVIEW

=== B11 verdict=confirmed
--- corrections:
Every code citation checks out against the 1.1 source. The checks are at simplegram.js 585/589/604/918; caughtUp is set only at line 376; the fail-open return at 349-353 runs before the bookkeeping at 383-398; visit() line 462 walks the marker's group feed_items; currentFeed() is keyed on pathname at 292-299; MainActivity 481-486 reads only "on". The bundle snippets are accurate. b404 PolarisFeedContext.react getPaginationSourceFromVariant: `case"home":return t||r("justknobx")._("2492")&&n==="feed_recs"?...FEED_RECS:null`. b344 PolarisFeed.react computes the next-page variables from the relay edges (`m=d.some(...e.node.end_of_feed_demarcator)`), and the feed is `CometRelay.usePaginationFragment`. b344 getPolarisFeedRecsPagingToken.next treats explore_story as the organic item after the marker. b385 subscribeToPolarisRelayFeed tolerates `group_set||{}`. I re-ran the 8 proposed tests: 0/8 pass on 1.1 and 8/8 on sg-fix.js. The existing suite passes 51/51 on both once the marker is moved out of mixedFeed(). With the unchanged suite, sg-fix.js fails exactly the 4 expected tests (1, 2, 3, 27).

Corrections and overstatements:
(a) Early flash. The timer explanation is right but incomplete; see missedCauses #1. The most likely trigger is not "the next page takes >4 s". It is pages that keep arriving but add nothing (B4: most pages are ads and suggestions that get removed). atBottomSince is never reset when a page arrives. Experiment R1 on 1.1: 2 friend posts, then 3 all-dropped pages 1.3 s apart while at the bottom. Result: `5120ms on=true`, then `6003ms on=false` once the friend page lands.
(b) "exp2 exactly matches the Filter status" proves nothing either way. With no marker at all, 1 friend page + 7 explore-only pages gives the same "Posts shown 2 / Suggested 0 / Pages 8 (7 unrecognised)". R8: 8 recs pages give unknownPages 8. So the phone numbers don't show whether a marker was involved in that session. Screenshots 6/7 do show a marker in the first session.
(c) 2c (hsmarken is an explore_story sharing a page with the marker) is one possibility, not established. A plain media node without friendship_status (followState null, kept) is equally consistent. Then the page is recognised and caughtUp=true, but the card still doesn't show because caughtUp is never a show condition. The fix covers both cases.
(d) The marker cut doesn't depend on B8, but the real-end card in the no-marker case does (R8: neither 1.1 nor the prototype ever ends Home on explore-only pages).
(e) More evidence for dropping the marker rather than only setting has_next_page=false. In b385 polarisFeedReducer, FEED_PAGE_LOADED_V2/FEED_NEXT_PAGE_LOADED_V2 use `paginationInfo:m(n.paginationInfo,n.groups)` with `function m(e,t){var n=...FEED_RECS,r=t==null?void 0:t[n];return r!=null?{cursor:r.nextMaxID,moreAvailable:!0,paginationSource:...FEED_RECS}:...}`. While the marker carries a feed_recs group, Instagram's redux mirror sets moreAvailable:true no matter what has_next_page says.

No requests to www.instagram.com in this review. My files are in /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf/feed-end-review/: rexp.cjs (R1-R10), rexp-orig.out, rexp-fix.out, rexp-rev.out, make-rev.py, and sg-rev.js (the revised plan prototyped on top of sg-fix.js). sg-rev.js passes the 8 proposed tests (8/8) and page2.test.cjs (51/51).
--- missedCauses:
* Early flash, main trigger: pages that arrive but add nothing keep the 4 s clock running, because atBottomSince (589/588) is never reset when a page arrives. R1 on 1.1: card on at 5120 ms while all-dropped pages kept arriving every 1.3 s, off at 6003 ms when friends' posts landed. This fits B4 (pages mostly ads/suggestions, 1-2 posts per load) better than a single slow page.
* Card missing for the whole rest of the session, not just 'after a trip to Stories'. The single feedState slot is replaced by any route, because checkFeedEnd runs from the scroll listener on every page and from routeChanged. Routes that do this include Stories (the user watched Stories before scrolling: 'going back to watch stories again'), a profile, a post, and Instagram's own /p/…/comments route, which SimpleGram bounces off with history.back() (930-937). Coming back gives homePages=0. All later recs pages are unrecognised, so they never increment homePages. That blocks even the 4 s fallback, which explains why no card appeared while the spinner sat at the bottom (screenshots 3/4). R2 on 1.1: after /stories/ and back, homePages 0, 3 explore-only pages, 7 s at the bottom → no on:true.
* Instagram's redux mirror (b385 polarisFeedReducer `paginationInfo:m(n.paginationInfo,n.groups)`) forces moreAvailable:true with the marker's feed_recs group cursor. A plan that keeps the marker and only sets has_next_page=false would not be enough if that path drives loading anywhere.
* Side effect of the cut on an empty first page. In b385 subscribeToPolarisRelayFeed: `p?(m.length===0&&(!justknobx(6493)||!gkx(25302))&&n(loadSULV2(...)),...FEED_PAGE_LOADED_V2)`. When the first Home page ends up with 0 edges, Instagram requests suggested accounts. That is likely after the change, whenever the marker is the first item (no new posts in 3 days). The response key `xdt_api__v1__ayml__strict` (PolarisUserActionLoadSULV2Query.graphql) is NOT matched by SUGGEST_KEY (line 183: `discover__ayml|^ayml`; checked with node: false), so those accounts would pass unfiltered.
--- fixPlanProblems:
* Removing every timer leaves real stalls without a way forward. R3: Home has friends' posts, Instagram's next request never answers. 1.1 shows the card at 6 s; sg-fix.js never shows it (16 s at the bottom: no on:true). Screenshot 3 (spinner, nothing below) is exactly this case. Fix: a stall fallback whose clock restarts on every Home page, including empty ones. sg-rev.js R10: all-dropped pages every 5 s for 15 s → no card; then 15 s with no page → card at 31.5 s.
* The markerLists early return skips filtering entirely, which regresses Following/Favorites. R4 (?variant=following, marker group holding a not-followed plain post, an ad and a followed post): 1.1 keeps only [FRNDGRP]; sg-fix.js keeps [STRANGE, FRNDGRP]. The ad is still caught by dropAds through AD_LIST_KEY. Nested group lists should still be filtered strictly; they just shouldn't be counted as pages or touch feed state.
* The blanket cut on `pagination_source==='feed_recs'` drops friends' posts on that page. R5: [FRIEND1, FRIEND2, REC] with pagination_source feed_recs → sg-fix.js keeps [] (1.1 keeps both friends). Per b404 the server can send this flag WITHOUT a marker to switch the client to recs, and that page can still carry the last organic posts. Keep posts from followed accounts, drop the rest, then stop.
* Resetting whenever the cursor changes after the end assumes only a refresh can bring a new page. Instagram's end-of-feed UI (setShowEOFRecs in PolarisFeedContext; its consumer PolarisFeedPage.react isn't in the logged-out bundles) could fetch recs with a new cursor. The reset would then un-end Home and, until B8 lands, let them fail open. Treat a new-cursor page after the end as a refresh only if it holds a marker or a post from a followed account. Otherwise blank it and stay ended (R9 on sg-rev.js: blanked, has_next false, card stays). This is also what the Ledger's B8 plan says: 'Never leave unrecognised pages alone after the caught-up point.'
* An empty first Home page after the cut makes Instagram call loadSULV2. Its `xdt_api__v1__ayml__strict` payload isn't blanked, so add `(^|__)ayml(__|$)` to SUGGEST_KEY (coordinate with B8).
* The plan says 'needs nothing from B8'. That holds only for the marker case. Without a marker (R8), the real-end card needs B8's rule that explore-only pages count towards emptyStreak.
* Smaller points: (1) a streamed payload (is_final:false) is never cut, in both 1.1 and the prototype (R6). That's acceptable because the phone counted 0 streamed, but keep it as a known gap and leave the DOM backup in place. (2) If a timeline payload for another variant arrives while Home is ended and holds followed posts, it still resets Home (R7). That's rare and acceptable. (3) Agreed: move the `let feedEndShown`/`atBottomSince` declarations above filterFeedList.
--- revisedFixPlan:
Page script (simplegram.js), building on the investigator's sg-fix.js. All of it is prototyped in /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf/feed-end-review/sg-rev.js (make-rev.py), which passes the 8 proposed tests and the 51 existing ones (marker moved out of mixedFeed).

1. Feed state per variant, as proposed: `feedStates: Map<variant,state>` plus `lastVariant`, updated only while route()==='home'. freshFeed = {emptyStreak, seenStreak, ended, caughtUp, homePages, endText:null, endCursor:null, lastPageAt:0}. Declare `let feedEndShown = null, atBottomSince = 0` above filterFeedList.

2. filterFeedList(owner, list), in this order:
 a. If list is in markerLists (any variant): keep only items where feedVerdict is not drop, it is media, and followState(mediaOf(node)) === true. Add the removed count to stats.feed.inMarker and return. Do not count it in stats.feed.pages and do not touch feed state. This replaces the plain skip, so Following/Favorites marker groups stay filtered.
 b. stats.feed.pages++, then the streamed return (unchanged; streamed payloads are a known gap).
 c. fs = currentFeed(); cursor = cursorOf(owner); fs.lastPageAt = Date.now().
 d. After the end: if fs.ended && cursor && cursor !== fs.endCursor, then:
    - if the page has a marker, or at least one plain media that is not dropped and whose followState === true, it is a refresh: reset fs and post feedEnd {on:false};
    - otherwise: `stats.feed.afterEnd += list.length; list.length = 0; stopPagination(owner); fs.endCursor = cursor; return`. Never fail open after the end.
 e. For every marker edge on the page, add each group's feed_items array to markerLists.
 f. Variant 'home' only (feedVariant()==='home' && fs.key==='home'):
    - marker at index `at`: fs.endText = {title, subtitle}; stats.feed.afterEnd += list.length - at; list.splice(at); stopPagination(owner); fs.caughtUp = fs.ended = true.
    - no marker but owner.pagination_source === 'feed_recs': keep only plain media that is not dropped and has followState === true, count the rest in afterEnd, stopPagination(owner), fs.caughtUp = fs.ended = true.
 g. If fs.ended: fs.endCursor = cursor; setTimeout(checkFeedEnd, 300).
 h. Then the existing verdict, fail-open and bookkeeping code, with line 376 removed, and `if (fs.ended) fs.endCursor = cursor` at the end.

3. checkFeedEnd. Compute `near = gap < (feedEndShown ? innerHeight : max(400, 0.6*innerHeight))`; atBottomSince is set while near and cleared otherwise. On Home (variant home, not searching): show = near && (fs.ended || stalled), where stalled = !fs.ended && fs.homePages > 0 && now - atBottomSince > 15000 && now - fs.lastPageAt > 15000. Post {on, caughtUp, stalled, title, subtitle}. While fs.ended on Home, keep the #sg-end-room spacer (170 CSS px, aria-hidden, pointer-events:none) on body; remove it on every other route (checkFeedEnd(true) already runs on route change). Keep the scroll listener, the 1.5 s interval, and the atBottomSince reset in routeChanged. This sends no new requests: the existing nudge is unchanged, and pagination now stops earlier.

4. SUGGEST_KEY (line 183): add `|(^|__)ayml(__|$)`. Instagram's empty-feed 'Suggested for you' accounts (xdt_api__v1__ayml__strict, requested by loadSULV2 when the first Home page has 0 edges) then get blanked by blankLists. Coordinate with B8, which also edits these regexes and fixtures.

5. MainActivity. Keep TextView fields for the card's title and sub (makeFeedBar 594-608). In 'feedEnd':
 - stalled → title "Home isn't loading more", sub "Keep going, newest first:";
 - caughtUp with a non-empty subtitle → show Instagram's subtitle above "Keep going, newest first, without repeats:";
 - otherwise unchanged.
 updateFeedBar logic is unchanged.

6. Dependency on B8, stated plainly: the marker cut works on its own. In the no-marker case, the end of Home comes only from emptyStreak, once B8 counts explore_story-only pages as dropped suggestion pages (no fail-open, emptyStreak++).

7. Tests (tests/page.test.cjs). Add the investigator's 8 and move the marker out of mixedFeed() (3 code lists, 6→5, 12→11), plus:
 - (a) all-dropped pages every 1.3 s while at the bottom → no on:true (R1);
 - (b) Following: marker group with a not-followed post, an ad and a followed post → only the followed post is left, stats.feed.pages === 1 (R4);
 - (c) a feed_recs page with friends → friends kept, has_next false, ended (R5);
 - (d) after the end, a new-cursor page with only recs or strangers → blanked, has_next false, card stays on (R9);
 - (e) stall: 15 s at the bottom with no page → on:true with stalled:true; all-dropped pages every 5 s → never (R10);
 - (f) an xdt_api__v1__ayml__strict payload → groups emptied.
 On the device: scroll Home to the caught-up point (spinner stops, no 'Suggested Posts', 'Pages read' stops growing, card only at the very end and not covering the last post); then Stories and back (card returns); then a Home-tab refresh (fresh feed, no early card).

Phone diagnostics to confirm (data shapes only, no names): for each timeline page, the edge node key sets, the marker index, connection.pagination_source on ordinary pages (so we know whether 'feed_recs' is ever sent on non-recs pages), has_next_page, and whether end_cursor changes on refresh. Also: the count of pages arriving after the end (stats.feed.afterEnd), and whether an ayml__strict payload appears when Home's first page is empty.

=== B15 verdict=confirmed
--- corrections:
Verified in MainActivity.java. The button is added at 158-159 as a 40dp TextView; placeMenuButton 835-844 uses `x(left ? margin : w - size - margin)`, margin dp(6), `prefs.getFloat("menuY", 0.58f)` clamped to [56dp, h-100dp]. Dragging and snapping are in the onTouch listener (784-829: drag past touch slop, snap to the nearer side on ACTION_UP, persist menuLeft/menuY). README.md mentions the ⋮ menu only for downloads and screenshots (lines 26, 39) and never mentions dragging. The overlap with the Save icon in screenshot 6 is consistent with these coordinates. Low priority. It doesn't affect the feed or search bugs.
--- fixPlanProblems:
* Moving the default Y to ~0.72 would make things worse elsewhere. In an opened Reel, Instagram's like/comment/share/save column sits on the right edge in roughly the lower 40% of the screen, so 0.72 lands on it. This is likely but not verifiable logged out; check on the phone. If the default moves at all, move it up (~0.35), where it covers media rather than controls.
* An 18dp tab flush with the edge covers 0-18dp, which still clips the left part of the Save icon's tap area (the icon is about 12-36 CSS px from the edge). Keep the visible tab at 14-16dp. Don't add an invisible wider touch target, which would bring the overlap back.
* setSystemGestureExclusionRects (API 29+): the rect is in the view's own coordinates, so it follows setX/setY. Android caps exclusion at 200dp per edge, which a 44dp tab fits within. Keep the 40dp circle on API < 29, where there is no gesture-navigation conflict.
--- revisedFixPlan:
Native only (MainActivity.java), low priority:
(1) When idle, the button becomes a slim edge tab, 14-16dp x 44dp, margin 0 on the side it is snapped to, rounded on the inner side only, background 0x8C1C1C1C at about 45% alpha. While pressed or dragged it shows at full size with alpha 0.8, as now. Keep the existing drag, snap and menuLeft/menuY persistence.
(2) On API 29+, call setSystemGestureExclusionRects(List.of(new Rect(0,0,w,h))) on the tab, so a drag doesn't trigger Back with gesture navigation. On API < 29, keep the current 40dp circle.
(3) Show a one-time hint after the first launch: 'Tip: drag ⋮ up, down or to the other side' (prefs flag). Add one line to README and About.
(4) Leave the default Y at 0.58, or move it up to ~0.35. Don't move it down: that covers the Reel action column.
On-device check (S25 Edge, gesture navigation, Edge Panel handle on the right): a tap on Save under the tab saves the post; a tap on the tab opens the menu; dragging doesn't trigger Back or the Edge Panel; the tab clears the Reel action column; the hint shows only once.


######## CLUSTER search-places-tags

=== B12 Places: the place grid fails on both Top and Most recent ("Instagram didn't return results here"), but Instagram's own place page works  [high]

--- rootCause:
loadPlace (simplegram.js 1812-1840) has only two data sources, and today neither one can work. (1) REST GET /api/v1/locations/web_info/ (line 1818) is gone: it answers 404 "Page Not Found", while endpoints that still exist answer 302 to login when logged out. (2) The GraphQL fallback (lines 1830-1833) is built for an older version of Instagram's query. KNOWN_DOC_IDS (line 1270) has PolarisLocationPageTabContentQuery = 28211016731901625, but today's bundles define 28586113187724473. Today's query also declares a second provided variable, __relay_internal__pv__PolarisSEOIsCrawlerrelayprovider, which SimpleGram never sends; it sends only the ShortDrama one. The runtime lookup probably does return the new id on Home: the op-id module sits in the always-loaded shell bundle b314 (6th <script src> of the shell), and require() and the bundle-scan regex both match its format. But the provider list lives only in the .graphql module, in the lazily loaded 4 MB bundle b385, which Home never loads. So on Home SimpleGram either sends the current id with an incomplete variable set (most likely; Instagram then answers missing_required_variable_value or 'execution error'), or the stale id. Either way igGraphQL returns null on both /api/graphql and /graphql/query. Then `part` and `c` are both null at line 1838, so the function returns null, runGrid sets st.error (line 2184), and renderFailure shows the message on both tabs. The pagination path, POST /api/v1/locations/<id>/sections/, is never reached and is unverified. Instagram's own page works because its Relay client sends the current doc_id with every provided variable.

--- alternatives:
[
 "The stale doc_id 28211016731901625 was sent (the op-id module is not loaded on logged-in Home, so the line-1297 KNOWN fallback was used) and Instagram has retired it. Same symptom, same fix.",
 "Unlike the logged-out case, the logged-in place grid needs distillery-style routing (/graphql/query with X-BLOKS-VERSION-ID and X-Root-Field-Name), as the 2026-09-27 capture of the OLD id described. Unlikely for the new id, whose metadata is is_fully_www_executable only.",
 "Missing body params (av, __a, __comet_req, jazoest) or the X-ASBD-ID header. Unlikely: the same igGraphQL path serves Posts & Reels successfully."
]

--- fixPlan:
Shared request plumbing (B13 uses it too):
(a) Learn Instagram's own GraphQL requests. Wrap XMLHttpRequest.prototype.open/send and window.fetch. When the path is /api/graphql or /graphql/query and the body (string, URLSearchParams or FormData) has fb_api_req_friendly_name and doc_id, record learned[name] = {id, path, pv: every __relay_internal__pv__* key with its value, varKeys, at}. Copy pv to the sibling `<name>_connection` (and back) when that one has none. Persist in localStorage 'sg_ops' (try/catch; a per-viewer cache only). Skip SimpleGram's own calls with SG.ownRequest = true, set synchronously around igGraphQL's fetch() call. This self-heals as soon as the user opens Instagram's own place page through the fallback link.
(b) docIdFor(name) order: learned, then require(name+'_instagramRelayOperation'), then require(name+'.graphql').params.id, then an incremental bundle scan, then KNOWN_DOC_IDS. The scan should only look at script URLs not scanned before, re-run when performance resource entries grow, cap about 40 files and stop when found; the current code scans once ever, at most 26 files. Refresh KNOWN: PolarisLocationPageTabContentQuery 28586113187724473, PolarisLocationPageTabContentQuery_connection 29002281179411948, PolarisExploreLocationsContainerQuery 28572807415659320, PolarisAPITopsearchQuery 29386906664232128 (b417), PolarisSearchBoxRefetchableQuery 27706427925724183 (unchanged). Record which source gave the id.
(c) providedVars(name): start from KNOWN_PV = {PolarisLocationPageTabContentQuery and _connection: [PolarisShortDramaEnabled, PolarisSEOIsCrawler]}, all false. Override with require(name+'.graphql').params.providedVariables when loaded (value = provider.get() or provider.default.get(), else false), then with learned pv. igGraphQL sends Object.assign(providedVars(name), variables).
(d) igGraphQL error handling. Keep the text and record {name, id, idSource, path, status, errors[0].code/message truncated} in SG.gqlLog (ring of 20). If the error text names `__relay_internal__pv__\w+?relayprovider` keys that were not sent, add them as false, remember them per query, and retry once. If the answer has no data and the id came from learned or the scan, drop that id and retry once with the next source. Try learned.path first, otherwise /api/graphql, then /graphql/query.
(e) Optional parity, not the cause: X-ASBD-ID from require('BDHeaderConfig').ASBD_ID (today '359341'), __a=1, __comet_req=7, jazoest.
(f) Remember dead endpoints per session: a 404 means do not ask again. Today every tab switch re-asks /web/search/topsearch/ (failures are not cached, line 1702).
loadPlace(view, cursor): remove the web_info and sections REST calls. First page: igGraphQL('PolarisLocationPageTabContentQuery', {after:null, first:12, location_id:String(view.id), page_size_override:null, tab: view.sub==='recent'?'recent':'ranked'}, 'xdt_location_get_web_info_tab'). Show more: the same variables with after = page_info.end_cursor, via 'PolarisLocationPageTabContentQuery_connection'. Stop when !has_next_page, when end_cursor is missing, when end_cursor equals the cursor sent, or when a page adds nothing new (the cursor echo seen in the signed-in capture), plus the existing MAX_MORE. Header, in parallel and non-blocking: igGraphQL('PolarisExploreLocationsContainerQuery', {location_id_str:String(id), show_nearby:false}, 'xdt_location_get_web_info'), giving native_location_data.location_info name, location_address + location_city and slug. collectMedia, thumbOf and postPath already handle the nodes. Empty Recent keeps the noRecent message. A null answer keeps renderFailure and the link, and adds a 'Try again' button so ids learned from Instagram's page get used.
Places list (loadTab): keep /api/v1/fbsearch/places/ (still exists, 302 when logged out), skip the dead topsearch REST, keep the typeahead's places as a secondary source.
Dev tooling (not shipped): a script that downloads the shell and resource-mapped bundles before each 'Apk it' and greps `_instagramRelayOperation` ids and each `.graphql` module's providedVariables for the query names SimpleGram uses. KNOWN entries record their harvest date.
Edge cases: ids stay strings; a FormData body is read with .get(); the learning hook never throws; learned entries older than ~30 days rank below require() ids; a place with 0 recent posts; no endless paging.

--- risks:
The XHR/fetch wrappers run on every Instagram request, so they must stay trivial and never throw. A learned id that Instagram later rotates is dropped on its first failure. The provider auto-retry depends on the error text naming the variable (unconfirmed). Pagination via _connection may echo its cursor, so the guard is required. The first page size of 12 matches the browser capture; 24 is untested. Today's tests (tests/page.test.cjs 599-609, 666-676) mock the removed REST endpoints as working, which is why 1.1 passed; they must be rewritten or they will keep hiding this.

--- phoneDiagnostics:
Add a 'Search' section to Filter status or to the planned copy-diagnostics, built from SG.gqlLog, with no names or ids of people: query name, doc_id, its source (learned/module/scan/known), path, HTTP status, Instagram error code + message (first 200 characters), edge count. Also show whether require('PolarisLocationPageTabContentQuery_instagramRelayOperation') resolves on Home, and the learned-ops table after the user opens Instagram's own place page once. That separates 'current id but missing provider' from 'stale id'. It also confirms the provider names and values Instagram's own client sends (ShortDrama true or false), and whether an error message names the missing variable (which the auto-retry relies on).

--- tests:
Change the fixtures to today's reality: /web/search/topsearch/, /api/v1/locations/web_info/ and /api/v1/fbsearch/web/top_serp/ return 404 HTML. Add a GraphQL route handler keyed by fb_api_req_friendly_name that rejects unknown doc_ids and any request missing a declared provider (the mock in exp.cjs). New tests: (1) the place Top grid loads via PolarisLocationPageTabContentQuery with both providers and first:12, and the header updates from PolarisExploreLocationsContainerQuery; (2) Show more uses _connection and stops when the cursor is echoed; (3) Most recent sends tab 'recent', and an empty answer shows the noRecent message; (4) an Instagram-style XHR (urlencoded body, rotated doc_id, an extra provider) is learned and used, and SimpleGram's own requests are not learned; (5) an error naming a missing provider triggers exactly one retry with it added, and it is remembered; (6) everything failing still shows renderFailure with the link, and gqlLog holds the entries; (7) a dead endpoint is asked once per session. The scratch prototype (simplegram.proto.js, built by make_proto.py) passes (1) to (5) against the mock: out-proto-module.txt, out-proto-learn.txt and the retry run.

--- evidence:
* simplegram.js:1270 `PolarisLocationPageTabContentQuery: '28211016731901625'`. Today in b205.js and b314.js: `__d("PolarisLocationPageTabContentQuery_instagramRelayOperation",[],(function(t,n,r,o,a,i){a.exports="28586113187724473"})`. In b385.js: `PolarisLocationPageTabContentQuery_connection_instagramRelayOperation` = "29002281179411948" and `PolarisExploreLocationsContainerQuery_instagramRelayOperation` = "28572807415659320" (that one is also in b205/b314).
* b385.js `PolarisLocationPageTabContentQuery.graphql`: argumentDefinitions after, first, location_id, page_size_override and tab (defaultValue "ranked"), plus `__relay_internal__pv__PolarisShortDramaEnabledrelayprovider` and `__relay_internal__pv__PolarisSEOIsCrawlerrelayprovider`. params: `providedVariables:{__relay_internal__pv__PolarisShortDramaEnabledrelayprovider:n("PolarisShortDramaEnabled.relayprovider"),__relay_internal__pv__PolarisSEOIsCrawlerrelayprovider:n("PolarisSEOIsCrawler.relayprovider")}`, metadata {is_fully_www_executable:!0}. Root field `xdt_location_get_web_info_tab` (XDTLocationGetWebInfoRecentTabConnection: edges[].node XDTMediaDict with code, pk, image_versions2, product_type, carousel_media, video_versions; page_info end_cursor, has_next_page). The `_connection` query has the same root, arguments and providers.
* simplegram.js:1830-1833 sends `{location_id, first: 24, after: null, tab, page_size_override: null, __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: false}`. The SEOIsCrawler provider is missing.
* b385.js subscribeToPolarisRelayLocationTimeline: route tracePolicy "polaris.locationPage", `s.main.route.params.location_id`, and subscriptions for `{location_id:c,tab:"ranked"}` and `{location_id:c,tab:"recent"}`. Header: subscribeToPolarisRelayExploreLocationLoggedOut uses PolarisExploreLocationsContainerQuery with `{location_id_str:c.location_id,show_nearby:...isRedesignEnabled===!0}`, root xdt_location_get_web_info.native_location_data.location_info (name, location_address, location_city, location_zip, slug, media_count, lat, lng, category, phone). Route link (b207.js PolarisLinkBuilder.buildLocationLink): "/explore/locations/"+id+"/"+slug+"/".
* Providers (b314.js): `PolarisShortDramaEnabled.relayprovider` get = justknobx("14"); `PolarisSEOIsCrawler.relayprovider` get = gkx("27688")===!0. Both are booleans that only toggle fields, so false is always a valid value.
* Module placement: the shell bundles b205/b314 hold op ids for route-preload queries only (FeedTimelineRootV2, PostRoot, ProfilePage, LocationPageTabContent, ExploreLocationsContainer, HashtagHeaderActionButtons, ...). The `.graphql` modules with providedVariables are only in b385, which no page shell references. regex.cjs, which applies docIdFor's line-1285 regex to the 418 bundles, finds 28586113187724473, 29002281179411948 and 28572807415659320.
* Instagram's own transport: b207.js makeIGWebRelayEnvironment uses graphURI `new URI("/api/graphql")` for www queries, and API_WWW_INSTAGRAM+"/graphql/query" plus X-BLOKS-VERSION-ID for distillery ones. createRelayIGNetwork: `t.metadata.is_distillery===!0?i:a`. The location queries are not distillery, so they go to /api/graphql.
* Experiment exp.cjs (Playwright with a mock that encodes the findings above). With unchanged 1.1 code it reproduces screenshots 10/11 exactly: '[Place Top] ... Instagram didn't return results here. | Open Instagram's own page', and the same on Most recent. Request log: `POST /api/graphql name=PolarisLocationPageTabContentQuery doc_id=28586113187724473 vars={...,"__relay_internal__pv__PolarisShortDramaEnabledrelayprovider":false} -> ERROR missing_required_variable_value`, then the same on /graphql/query (out-module.txt). Without the op-id module, the stale 28211016731901625 is sent (out-nomodule.txt).
* Third-party signed-in capture (dumpsta notes in scratchpad hashtag-research/raw/dumpsta_web-request-contract.md, 2026-09-27). The old id 28211016731901625 was sent with `first` 12, `after` null, `tab` ranked, `page_size_override` null and the ShortDrama provider, and returned 21 edges. That id and variable set is what 1.1 still sends, and today's query declares one more provider. The same notes say `_connection` echoed back the cursor it was given (no progress). A second scraper (omkarcloud queries.py, 2026-09-22) says a /graphql/query doc_id fails 'missing_required_variable_value' or 'execution error' when any declared provider is missing.
* Transport is very likely fine. Posts & Reels works on the phone, and its REST path /api/v1/fbsearch/web/top_serp/ answers 404 logged out (probe today, probe/hdr1), so its results must come from igGraphQL(PolarisKeywordSearchExplorePageRelayQuery). That means SimpleGram's minimal header and body set is accepted.

=== B13 Tags: "No tags found for 'Nba'": no hashtag results at all  [high]

--- rootCause:
loadTab('tags') (simplegram.js 1711-1718, 1731-1738) relies on (1) REST /web/search/topsearch/?context=blended and ?context=hashtag, which now answer 404 "Page Not Found", and (2) the web search box query PolarisSearchBoxRefetchableQuery (doc 27706427925724183, still current) in blended context. That query still selects `hashtags`, but Instagram's server no longer returns hashtags or places to the web typeahead: a signed-in capture of 2026-09-27 got '5 accounts, 1 keyword and no hashtag or place'. The "No tags found" text itself proves the GraphQL call succeeded with an empty hashtags list. With both REST calls 404 (blended null) and g also null, line 1738 would return {error:true} and show renderFailure instead. The same cached answer serves the Accounts tab, which is why Accounts works. SimpleGram never offers the typed tag itself, and never asks the query the website still uses for hashtag lookup: PolarisAPITopsearchQuery with context 'hashtag', used by the '#' typeahead in Instagram's comment and caption composers. Hashtags no longer have their own grid on the website. The link builder still points to /explore/tags/<tag>/, which shows the keyword search page for '#tag' with a hashtag header (PolarisHashtagHeaderActionButtonsQuery). loadTag already falls back to that (loadKeyword('#'+name), line 1810), but the user can never reach it because the list is empty.

--- alternatives:
[
 "Instagram also dropped hashtags from PolarisAPITopsearchQuery for web. Then the always-present '#query' row is the whole fix, and it still opens a working grid.",
 "Hashtags come back from the blended typeahead only when the query starts with '#'. This is cheap to test on the phone; the merge in step (3) would pick them up."
]

--- fixPlan:
loadTab('tags'):
(1) Normalise the typed text: strip leading '#', remove whitespace, lowercase, keep only [\p{L}\p{N}_] (unicode regex). If anything is left, the list always starts with {name: t} (shown as '#t', subtitle 'Hashtag', or 'N posts' once known). The tab can never be empty for a valid word.
(2) Ask the website's own hashtag lookup through the shared plumbing from B12: igGraphQL('PolarisAPITopsearchQuery', {data:{context:'hashtag', include_reel:'true', query:t (no '#', as the site sends it), rank_token:'', search_session_id:uuid(), search_surface:'web_top_search'}}, 'xdt_api__v1__fbsearch__topsearch_connection'). Read hashtags[].hashtag{name, media_count}, cache it per query, merge case-insensitively, and fill the typed tag's media_count when it comes back.
(3) Also merge any hashtags in the already cached blended PolarisSearchBoxRefetchableQuery answer, in case Instagram brings them back.
(4) Stop calling /web/search/topsearch/ (dead-endpoint memo or remove).
(5) A failed or empty typeahead is not an error state: still show '#t'.
loadTag(view): Top keeps /api/v1/tags/web_info/ only while it answers (it still exists; logged-in behaviour unknown), otherwise loadKeyword('#'+t). That is what the website shows for a hashtag now: PolarisKeywordSearchExplorePageRelayQuery with query '#t', which already works on the phone (Posts & Reels). Most recent: keep the single sections POST attempt with the existing honest message ('Instagram no longer shows most recent posts for hashtags'), and hide the Most recent button for tags after one failure per session. The renderFailure fallback (/explore/search/keyword/?q=%23tag) is already right.
Edge cases: input '#' or '##' only gives no item; multi-word input is joined ('new york' -> '#newyork'); non-Latin tags; stale-query guard (stale()) before rendering; the Accounts and Tags tabs share the cache, so typing does not double the requests.

--- risks:
Low. The '#query' row is fully local. One extra GraphQL call per new query on the Tags tab only. The keyword grid for '#nba' is Instagram's mix of top posts and Reels for that tag, not a strict hashtag feed, and Recent is no longer offered by Instagram. The text says so honestly.

--- phoneDiagnostics:
From the gqlLog in the Search section of the diagnostics: hashtag counts returned by PolarisAPITopsearchQuery(context 'hashtag', 'nba') and by PolarisSearchBoxRefetchableQuery(blended, 'nba' and '#nba'). Also whether /api/v1/tags/web_info/?tag_name=nba answers logged in (status only), and whether the tag grid came from web_info or from the keyword search. One manual check needs no new build: in Instagram's own comment box, type '#nb' and see whether hashtag suggestions appear. Those suggestions come from PolarisAPITopsearchQuery with context 'hashtag'.

--- tests:
Fixtures: topsearch REST returns 404; the blended GraphQL answer has users only. Tests: (1) typing 'Nba' on the Tags tab shows '#nba' first even when no hashtags come back (fails on 1.1); (2) PolarisAPITopsearchQuery is sent with data.context 'hashtag' and query 'nba' without '#', and its hashtags are merged and deduped, with the typed tag's media_count shown; (3) tapping '#nba' with tags/web_info returning 404 loads the grid through PolarisKeywordSearchExplorePageRelayQuery with query '#nba'; (4) Most recent for a tag shows the honest message when the sections POST fails, and the button hides afterwards; (5) input '#' alone shows the plain 'No tags found' text; (6) the topsearch 404 is requested at most once per session. The prototype passes (1) and (2) against the mock (out-proto-module.txt).

--- evidence:
* simplegram.js:1709 and 1715 call /web/search/topsearch/?context=blended|hashtag. Probes from this machine: 404 "Page Not Found" HTML. Endpoints that still exist answer 302 to login, e.g. /api/v1/tags/web_info/ and /api/v1/fbsearch/places/.
* simplegram.js:1733-1738: the GraphQL fallback runs only when the list is empty, and `if (!list.length && !blended && !g) return { error: true }`. The screenshot shows 'No tags found', not 'Instagram didn't return results here', so g was non-null with no hashtags.
* b233.js `PolarisSearchBoxRefetchableQuery.graphql`: root `xdt_api__v1__fbsearch__topsearch_connection(_request_data: $data)` with see_more.list[].keyword{name,id}, inform_module, hashtags[].hashtag{name, media_count, search_result_subtitle, id}, places[].place{location{pk,name,facebook_places_id}, subtitle, title}, users[].user{...}, rank_token. The site sends `j({data:{context:e,include_reel:String(!0),query:t,rank_token:n,search_session_id:V,search_surface:"web_top_search"},hasQuery:!0})` with e = SEARCH_CONTEXT.BLENDED (b233 search box: `t==="@"||t==="#"||(...C(SEARCH_CONTEXT.BLENDED,t,...))`).
* Signed-in capture (scratchpad hashtag-research/raw/dumpsta_search.py): `PolarisSearchBoxRefetchableQuery ... 27706427925724183 ... 5 accounts, 1 keyword and no hashtag or place on both replays of 2026-09-27`.
* b417.js `PolarisAPITopsearch`: `fetchQuery(PolarisRelayEnvironment, PolarisAPITopsearchQuery, {data:{context:e,include_reel:String(!0),query:t,rank_token:a,search_session_id:i,search_surface:"web_top_search"}})`, op id `PolarisAPITopsearchQuery_instagramRelayOperation` = "29386906664232128", metadata is_fully_www_executable, no providers. Same root field, with hashtags[].hashtag{id,name,media_count}. b260.js PolarisTypeahead: `function R(e){return f.test(e)?SEARCH_CONTEXT.HASHTAG:...}` with f = PolarisIGHashtagRegex.HASH_CHARS; after a typed '#' it calls `G(i)` and searches `B.slice(H,i)`, i.e. the text after '#', with context 'hashtag'. PolarisSearchConstants (b314): SEARCH_CONTEXT {BLENDED:'blended', HASHTAG:'hashtag', LOCATION:'location', USER:'user'}.
* b207.js PolarisLinkBuilder: `function U(e){return encodeURI("/explore/tags/"+e+"/")}` (buildTagLink), used by b233 PolarisSearchResultHashtagItem.next.react. The deep-link table still has path "/explore/tags/:tag". The shell bundles b205/b314 preload only `PolarisHashtagHeaderActionButtonsQuery` (op id 35337906325853853, variable tag_name) for tags, and no hashtag grid query exists in the 418 bundles. The signed-in notes say the keyword page's load sends that header query 'with tag_name empty on a keyword and the tag on a hashtag'; third-party notes say /explore/tags/<name>/ redirects to /explore/search/keyword/?q=%23<name>.
* Probes: /explore/tags/nba/ and /explore/search/keyword/?q=%23nba both serve the logged-out PolarisErrorRoute shell (page_type null), so they cannot be told apart logged out.
* Experiment exp.cjs (1.1 code, mock as above) reproduces screenshot 12: '[Tags tab] ... No tags found for “Nba”.' (out-module.txt). The prototype (always '#query' first, plus PolarisAPITopsearchQuery context 'hashtag') shows '#nba | 51,234,567 posts | #nbafinals' (out-proto-module.txt).

--- notes:
Work stayed read-only on /home/user/SimpleGram (git status is clean). Network: 3 GETs to www.instagram.com (logged out; outputs in .../wf/search-places-tags/probe/) and 1 GET to static.cdninstagram.com to check CORS. That check shows ACAO https://www.instagram.com, and Instagram's CSP connect-src allows *.cdninstagram.com, so the bundle-scan fetches are allowed.

Scratch files (all under /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf/search-places-tags/):
- exp.cjs: Playwright reproduction against a mock that encodes the findings. Usage: `NODE_PATH=/opt/node-tools/node_modules node exp.cjs <module|nomodule|learn> [script]`.
- Outputs: out-module.txt and out-nomodule.txt (1.1 code reproduces screenshots 10-12), out-proto-module.txt and out-proto-learn.txt (prototype fix).
- make_proto.py builds simplegram.proto.js (prototype of the design: learning hook, provided-variable resolution, retry, new loadPlace, Tags '#query' + context 'hashtag'). simplegram.proto-retry.js tests the error-driven retry.
- regex.cjs runs docIdFor's scan regex over the 418 bundles.

Exact ids found today:
- PolarisLocationPageTabContentQuery 28586113187724473 (b205/b314, shell)
- PolarisLocationPageTabContentQuery_connection 29002281179411948 (b385, lazy)
- PolarisExploreLocationsContainerQuery 28572807415659320 (b205/b314)
- PolarisSearchBoxRefetchableQuery 27706427925724183 (b233, unchanged)
- PolarisSearchBoxNonProfiledRefetchableQuery 27634848489527274
- PolarisSearchBoxContainerQuery 28034859679513798
- PolarisAPITopsearchQuery 29386906664232128 (b417)
- PolarisAPILocationSearchQuery 28700062289635266 (b417; returns Facebook page ids in meta_places[].best_page_fbid, not Instagram location pks, so it is not a reliable source of place-page ids)
- PolarisHashtagHeaderActionButtonsQuery 35337906325853853

PolarisKeywordSearchExplorePageRelayQuery and its pagination query are not in any downloaded bundle, so they could not be checked. KNOWN 37324993597144881 matches a signed-in capture from 2026-09-27 and evidently still works (Posts & Reels).

Helper comparison: SimpleGram sends doc_id, variables, fb_dtsg, lsd, fb_api_caller_class, fb_api_req_friendly_name and server_timestamps, plus headers X-CSRFToken, X-IG-App-ID, X-FB-LSD and X-FB-Friendly-Name. Instagram's client adds getAsyncParams (av, __a, __comet_req, jazoest, __user, ...), X-ASBD-ID 359341 (BDHeaderConfig), X-IG-Max-Touch-Points, and for distillery queries only, X-BLOKS-VERSION-ID on /graphql/query. These differences are not the cause.

Considered and rejected: running queries through Instagram's own Relay (require('CometRelay').fetchQuery with PolarisRelayEnvironment). The location .graphql module is not loaded on Home, and that route would put results into Relay's store and through SimpleGram's own data hooks unflagged. Possible extra fallback, needs the phone: GET the place page HTML and read its `RelayPrefetchedStreamCache` entry `adp_PolarisLocationPageTabContentQueryRelayPreloader_*`. A third-party sample shows that entry carries the first grid page, but it is unknown whether logged-in mobile pages include it.

Unrelated observation, for the B14 cluster: loadTab repeats the dead topsearch 404s on every tab switch, because failures are deliberately not cached (line 1702). That adds latency to every search.

######## REVIEW

=== B12 verdict=partly
--- corrections:
WHAT HOLDS
- REST /api/v1/locations/web_info/ is gone. My control probes (logged out, same mobile UA and X-IG-App-ID; outputs in /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf/search-places-tags-review/probe/):
  - A made-up /api/v1/zz_no_such_thing/ answers 404 "Page Not Found", exactly like locations/web_info, /web/search/topsearch/ and /api/v1/fbsearch/web/top_serp/.
  - Endpoints that exist but need a login answer 302 to the login page: /api/v1/friendships/pending/, /api/v1/media/<id>/info/ and /api/v1/tags/web_info/. web_profile_info answers 401.
  - None of the 418 current bundles mentions locations/web_info, topsearch, top_serp, fbsearch/places or /sections/.
- simplegram.js line 1270 holds the stale id 28211016731901625. Today's ids are confirmed: the main query is 28586113187724473 (b205/b314) and _connection is 29002281179411948 (b385).
- Both .graphql modules declare providedVariables {PolarisShortDramaEnabled, PolarisSEOIsCrawler} with metadata {is_fully_www_executable:!0}. So they go to /api/graphql: b207 createRelayIGNetwork has `e=t.metadata.is_distillery,s=e===!0?i:a`, and only distillery queries use API_WWW_INSTAGRAM+"/graphql/query" with X-BLOKS-VERSION-ID.
- The 2026-09-27 capture says the OLD id was a distillery query, answered on /graphql/query with x-bloks-version-id and x-root-field-name. Instagram has since moved the query to www.
- The phone matches. The places list works: the Hyatt id came from /api/v1/fbsearch/places/ and opens correctly through Instagram's own link. So the id is right and only the grid request fails. Both tabs show renderFailure, which needs loadPlace to return null (line 1838, `part` and `c` both null). An empty but successful answer would show 'No posts found.' or the noRecent text instead. So igGraphQL returned null.

REFUTED PREMISE
The diagnosis says the provider list lives only in b385, which no page shell references and Home never loads. That is false for every shell we have. home/location/post/search/tag/login.html all load b385 as their 2nd `<script src>` (after b25), together with b314, b417, b233 and b319.

Offline experiment, my own and not a mock: /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf/search-places-tags-review/exp/shell.cjs loads location.html plus the local bundles with all network blocked. Output in out-shell.txt:
- window.require('PolarisLocationPageTabContentQuery_instagramRelayOperation') = '28586113187724473'
- require('PolarisLocationPageTabContentQuery.graphql').params gives id 28586113187724473 and providedVariables {ShortDrama:{get}, SEOIsCrawler:{get}}. get() returns ShortDrama = TRUE and SEOIsCrawler = false.
- _connection is the same, with id 29002281179411948.
- PolarisAPITopsearchQuery.graphql is 29386906664232128 and has no providers.

So 1.1 sends the CURRENT id with only ShortDrama:false. The 'most likely' branch is right, but for a different reason: line 1279 reads only params.id and never params.providedVariables. The module is available. The logged-in shell is still unknown.

OTHER CORRECTIONS
- ShortDrama's live value is true (justknobx 14), but 1.1 hard-codes false. False is probably still accepted, since the flag only toggles fields.
- exp.cjs is circular: its mock encodes the hypothesis, so it shows the hypothesis is consistent, not that it is the cause.
- That the server rejects a missing provider rests on third-party notes: loc/omkarcloud_instagram-scraper/instagram/queries.py lines 18-22, 'missing one -> missing_required_variable_value or data: null with "execution error"'. In the second form the variable is not named, so a retry driven by the error text cannot be relied on.
- Missed: igGraphQL (lines 1325-1341) re-POSTs the same body to /graphql/query after any answer from /api/graphql that has no data. So every failed place tab costs 2 POSTs; the investigator's own out-module.txt shows this. The website never does that for www queries.
- Small: the 'failures are not remembered' delete is on line 1701, not 1702.
--- missedCauses:
* igGraphQL (simplegram.js 1325-1341) falls through to /graphql/query after a GraphQL-level error on /api/graphql. So each failed place tab sends 2 identical POSTs, and switching Top/Most recent repeats them. That is a request pattern the website never produces for www-executable queries.
* loadPlace line 1831 hard-codes the ShortDrama provider as false, while the page's own provider returns true today. The page's provider getters are never consulted for any query.
--- fixPlanProblems:
* (a) The XHR/fetch learning hook is justified by the refuted premise (that b385 is never loaded). It wraps XMLHttpRequest.open/send and window.fetch for every Instagram request, including the feed's own GraphQL transport, which the feed filter (the core feature) depends on. It also persists data to localStorage, and it only self-heals if the user opens Instagram's own place page. It is not needed: require('<name>.graphql').params.providedVariables is available in the shell. Drop it, or defer it as an optional later layer.
* (b) Putting learned ids first lets a cached id up to 30 days old outrank the live id from the page's require().
* (c) Every provider defaults to false even when the page's get() returns true. Also, `Object.assign(providedVars(name), variables)` puts provider keys BEFORE the regular variables, while Instagram's argumentDefinitions order and the captured browser order put them LAST.
* (d) As written there is a retry for a named provider, another retry with the next id source, and two paths. That allows about 4-6 POSTs per tab open. It needs a hard cap of 2 POSTs per igGraphQL call, and no switch to /graphql/query after a parsed GraphQL error.
* (f) Remembering dead endpoints per session still sends one 404 per session to endpoints the website no longer calls, and they 404 like a random path. Remove the calls instead.
* The incremental scan leans on performance resource entries. The resource-timing buffer defaults to 250 entries and fills early in a session heavy with images and video, so bundles loaded later are not listed. require() has to stay the main source, with the scan as a fallback only.
* (e) Adding X-ASBD-ID, __a, __comet_req and jazoest changes the requests that already work for Accounts and Posts & Reels. It is out of scope and a regression risk.
* Always firing PolarisExploreLocationsContainerQuery adds a request to every place open, even though the list row already supplied the name and address. Make it conditional.
* The test 'prototype passes (1)-(5)' runs against the investigator's own mock, so it proves the code matches the hypothesis, not that it matches Instagram.
--- revisedFixPlan:
SHARED GRAPHQL PLUMBING (B13 uses it too)

1. docIdFor(name). Lookup order:
   1. the per-page memo docIds;
   2. require(name+'_instagramRelayOperation');
   3. require(name+'.graphql').params.id;
   4. bundle scan;
   5. KNOWN_DOC_IDS.
   Record which source answered in idSource[name].
   Bundle scan: run it only after a miss. Fetch only script URLs not scanned before, taken from document.scripts plus performance entries, with cache:'force-cache'. Cap it at about 40 files per pass and stop once the name is found. Besides the op-id regex (line 1285), also capture every `.graphql` module's dependency list with /__d\("([A-Za-z0-9_]+)\.graphql",\[([^\]]*)\]/g and keep the deps that end in '.relayprovider'.
   Refresh KNOWN_DOC_IDS (harvested 2026-10-22):
   - PolarisLocationPageTabContentQuery 28586113187724473
   - PolarisLocationPageTabContentQuery_connection 29002281179411948
   - PolarisExploreLocationsContainerQuery 28572807415659320
   - PolarisAPITopsearchQuery 29386906664232128
   - keep PolarisSearchBoxRefetchableQuery 27706427925724183 and the two keyword ids.
   When a call fails, delete docIds[name] so that 'Try again' resolves the id again.

2. providedVars(name). Build it in this order:
   1. From require(name+'.graphql').params.providedVariables: for each key, value = !!(p.get ? p.get() : p.default && p.default.get()), wrapped in try/catch with false on error. Also read params.metadata.
   2. Otherwise, from the scanned dependency list: each '<X>.relayprovider' becomes '__relay_internal__pv__<X>relayprovider' = false.
   3. Otherwise KNOWN_PV: PolarisLocationPageTabContentQuery and _connection get [PolarisShortDramaEnabled, PolarisSEOIsCrawler] = false.
   4. Then add any providers remembered from step 4 below.

3. igGraphQL(name, variables, root):
   - Variables are the caller's variables in the caller's order, with provider keys appended after them. Never overwrite a variable the caller set.
   - Delete the hard-coded ShortDrama from loadPlace.
   - Path: /api/graphql. Every query SimpleGram sends is www-executable. Fall back to /graphql/query only when /api/graphql returns a non-OK HTTP status or a body that cannot be parsed (as 1.1 does), or when the module metadata says is_distillery. Never fall back after a parsed GraphQL error.

4. On a parsed error:
   - If the text names __relay_internal__pv__\w+?relayprovider keys that were not sent, add them as false, remember them for that query, and retry once on the same path.
   - Otherwise, if the id came from the scan or from KNOWN, drop it from docIds and do not retry inside this call.
   - Hard cap: 2 POSTs per igGraphQL call.
   - Record {name, id, idSource, provider names and values, path, HTTP status, errors[0] code and message (200 characters max), edge count} in SG.gqlLog, a ring of 20 entries.

5. igGet: memoise a 404 per session per path, as a safety net for legacy endpoints.

6. Remove these calls outright: /api/v1/locations/web_info/ (line 1818), the /api/v1/locations/<id>/sections/ POST (line 1815), and every /web/search/topsearch/ call (lines 1709, 1715, 1722).

loadPlace(view, cursor)

- tab = view.sub==='recent' ? 'recent' : 'ranked'.
- First page: igGraphQL('PolarisLocationPageTabContentQuery', {location_id:String(view.id), first:12, after:null, tab, page_size_override:null}, 'xdt_location_get_web_info_tab'). Keep this key order; it is the browser's.
- Show more: igGraphQL('PolarisLocationPageTabContentQuery_connection', {after:cursor.after, first:12, location_id, page_size_override:null, tab}, same root).
- more = {after:end_cursor} only if all of these hold: page_info.has_next_page is true, end_cursor is set, and end_cursor differs from the cursor just sent. The signed-in capture saw the cursor echoed back.
- In runGrid, also clear st.more when addNew added nothing. Keep MAX_MORE = 3.
- Media: collectMedia(edges.map(e=>e.node)). The query selects code, pk, image_versions2.candidates, product_type and carousel_media, so thumbOf and postPath work unchanged.
- If igGraphQL returns null: return null. renderFailure keeps the 'Open Instagram's own page' link; add a 'Try again' button.
- If the answer has 0 edges: on Recent, show the noRecent text; on Top, show 'No posts found.'
- Header (optional): only when view.name or view.address is missing, e.g. an old recent search. Call igGraphQL('PolarisExploreLocationsContainerQuery', {location_id_str:String(view.id), show_nearby:false}, 'xdt_location_get_web_info') without blocking the grid, and read native_location_data.location_info for name, location_address + location_city and slug.

Places list (loadTab 'places')

Use /api/v1/fbsearch/places/ (alive; it produced the working Hyatt id on the phone). Only if it gives nothing, use places from the cached blended GraphQL answer. Do not use PolarisAPILocationSearchQuery: it returns Facebook page ids (best_page_fbid), not Instagram location pks.

Deferred, not in this fix: the XHR/fetch learning hook, and the extra body params and headers.

Diagnostics: add a 'Search' section to Filter status built from SG.gqlLog, with no usernames. Also show whether require('PolarisLocationPageTabContentQuery.graphql') resolved, and the provider values that were sent.

Tests

The fixtures must reflect today:
- topsearch, locations/web_info and top_serp return a 404 HTML page;
- the GraphQL mock rejects unknown doc_ids and any declared provider that is missing.

Cases:
1. The Top grid uses PolarisLocationPageTabContentQuery with first:12 and both providers, appended after the regular variables. Values come from a mocked window.require('...graphql') (ShortDrama true). Without the mock, KNOWN_PV is used.
2. Show more uses _connection and stops when the cursor is echoed.
3. Recent sends tab 'recent'; an empty answer shows the noRecent text.
4. An error that names a missing provider causes exactly one retry, and the provider is remembered.
5. At most 2 POSTs per call, and no /graphql/query after a parsed error.
6. When everything fails, renderFailure shows the link and Try again, and gqlLog has the entries.
7. Zero requests to the removed endpoints.
8. Regression: Accounts (users come from GraphQL) and Posts & Reels still work.
9. Rewrite tests/page.test.cjs lines 599-609 and 666-676, which mock dead endpoints as working.

=== B13 verdict=confirmed
--- corrections:
WHAT HOLDS
- /web/search/topsearch/ 404s exactly like a made-up path (my control probe), so `blended` is null on the phone.
- So the 'No tags found for "Nba"' text (renderBody, about lines 2017-2019) rather than renderFailure (line 1738, `!list.length && !blended && !g`) means the PolarisSearchBoxRefetchableQuery answer `g` came back non-null with no hashtags. The deduction holds. Accounts working fits, because users come from the same cached `g` (cache key 'gql').
- b417 PolarisAPITopsearch is confirmed: fetchQuery(PolarisAPITopsearchQuery, {data:{context:e, include_reel:String(!0), query:t, rank_token:a, search_session_id:i, search_surface:"web_top_search"}}), op id 29386906664232128, no providers. require() resolves both in my offline shell run (exp/out-shell.txt).
- b260 PolarisTypeahead: when the typed character n matches HASH_CHARS, it calls G(i), so the query starts after the '#', and K(R(n)) with R returning SEARCH_CONTEXT.HASHTAG. The query is B.slice(H,i), without the '#'. The callers are the comment input (b260), the caption composer (b53, b376) and creation popovers (b241).
- b233's search box always uses BLENDED and skips a bare '#' or '@'.
- b417 defines SEARCH_CONTEXT as {BLENDED:"blended",HASHTAG:"hashtag",LOCATION:"location",USER:"user"}.
- The only hashtag op id in the 418 bundles is PolarisHashtagHeaderActionButtonsQuery 35337906325853853. loadTag already falls back to loadKeyword('#'+name) on line 1810.

CAVEATS
- 'The server no longer returns hashtags to the web typeahead' rests on one third-party capture (query unknown) plus the phone's 'Nba' result. Whether context 'hashtag' still returns hashtags is unverified. The local '#query' row is what makes the fix work in any case.
- The suggested manual check (typing '#nb' in Instagram's comment box) must be done without posting the comment.
--- fixPlanProblems:
* Step (1) keeps only [\p{L}\p{N}_], which strips combining marks: '#हिंदी' becomes 'हद' (/tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf/search-places-tags-review/exp/out-normalise.txt), and a decomposed 'café' loses its accent. Instagram's own PolarisIGHashtagRegex allows combining ranges (̀-ͯ, Hebrew and Arabic marks, Thai ก-ฺ) and ‌.
* Step (2) runs PolarisAPITopsearchQuery even when the cached blended answer already has hashtags. It should run only when that answer has none.
* Step (4) offers 'dead-endpoint memo or remove'. Remove: the calls should be zero, not one per session.
* Most recent: keep the single sections POST, because the user's R1 request asks for Most recent. But after the first failure or 404 in a session, skip the POST and show the honest message directly. Hiding the button is optional.
--- revisedFixPlan:
loadTag reuses the B12 plumbing (igGraphQL with providers appended, the 2-POST cap, gqlLog, the 404 memo in igGet).

loadTab('tags')

1. Normalise. t = q.replace(/^#+/,'').replace(/\s+/g,'').toLowerCase().replace(/[^\p{L}\p{M}\p{N}_‌]/gu,''). Joined words are fine: 'new york' becomes 'newyork'. If t is empty (input '#' or '##'), show no typed row.
2. Start the list with {name:t}, shown as '#'+t with subtitle 'Hashtag', or 'N posts' once a count is known. The tab is never empty and never an error for a valid t.
3. Merge hashtags(g.hashtags) from the cached blended PolarisSearchBoxRefetchableQuery answer (cache key 'gql', shared with Accounts, so no extra request).
4. Only if step 3 gave no hashtags and !stale(): cached(c, 'tagta', () => igGraphQL('PolarisAPITopsearchQuery', {data:{context:'hashtag', include_reel:'true', query:t, rank_token:'', search_session_id:uuid(), search_surface:'web_top_search'}}, 'xdt_api__v1__fbsearch__topsearch_connection')). Merge its hashtags case-insensitively and fill the typed row's media_count.
5. Remove both /web/search/topsearch/ calls (lines 1709 and 1715).
6. Check stale() before rendering. A failed or empty typeahead still shows '#'+t.

loadTag(view)

- Top: try /api/v1/tags/web_info/ first (it still exists: 302 when logged out). igGet's per-session memo makes a dead or empty answer cost at most one try per session. Otherwise use loadKeyword('#'+t), which is what the website shows for a hashtag now and already works on the phone. loadKeyword's dead top_serp REST call is the B14 cluster's to remove.
- Most recent: one user-triggered POST to /api/v1/tags/<t>/sections/ with tab 'recent'. On failure, show 'Instagram no longer shows most recent posts for hashtags...' and remember the failure for the session, so later taps show the message without a request.
- The renderFailure link (/explore/search/keyword/?q=%23tag) stays.

Tests

Fixtures: topsearch returns a 404 HTML page; the blended GraphQL answer has users only.

1. Typing 'Nba' on the Tags tab shows '#nba' first, even with no hashtags returned (fails on 1.1).
2. PolarisAPITopsearchQuery is sent with data.context 'hashtag' and query 'nba' (no '#'); its results are merged and deduplicated, and the count is shown.
3. It is NOT sent when the blended answer already has hashtags.
4. Tapping '#nba' while tags/web_info returns 404 loads the grid through PolarisKeywordSearchExplorePageRelayQuery with query '#nba'.
5. Most recent shows the honest message, and a second tap sends no POST.
6. '#' alone shows 'No tags found'.
7. 'हिंदी' keeps its vowel signs.
8. Zero /web/search/topsearch/ requests.
9. Regression: Accounts still lists users from the shared GraphQL answer.

Phone diagnostics, from gqlLog: the hashtag count from PolarisAPITopsearchQuery('nba') and from the blended query for 'nba' and '#nba'; the status of tags/web_info; and whether the tag grid came from web_info or from the keyword search.


######## CLUSTER search-open-flash

=== B14 Opening a search result (Posts & Reels, also Accounts and "Open Instagram's own page") briefly shows Home before the post/Reel; Back to the results works  [high]

--- rootCause:
Two things in openPath() (simplegram.js 2197-2219) add up. (1) Search is hidden before the navigation even starts. Line 2202 calls hideSearch(false) synchronously, before the history.pushState(null,'',path) at 2207 and the synthetic PopStateEvent at 2209. The search overlay is drawn on top of whatever page you were on. Tapping Instagram's Search tab is intercepted (1553-1559: preventDefault + openSearch(true), no navigation), so that page is almost always Home. Instagram's router does pick up the synthetic popstate; it does not ignore our foreign state. But its CometRouter applies route changes inside React useTransition. The new route first needs a route-definition round trip (POST /ajax/route-definition/), because our result cells are not Instagram links and are never prefetched. Then its code and GraphQL data must load. During all of that React keeps the old screen (Home) on screen. Only after the post route commits does the router mark the navigation committed. So Home is exposed for the whole route load. (2) When that load takes longer than 1.8 s (slow phone or network), the fallback at 2216-2218 sees pageSig() unchanged and calls location.replace(path). That kills Instagram's in-flight client navigation and starts a full reload. Home stays on screen until the new document paints (paint holding), so the flash gets longer and the open gets slower. Back works because openPath keeps Instagram's own history.state.key (Object.assign at 2200) and adds sgSearch. Instagram restores Home from its known key, and restoreSearch (2268-2285) reopens the overlay from the marker (live state or sessionStorage).

--- fixPlan:
simplegram.js only; MainActivity needs no change. Prototype: /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf/search-open-flash/sg-fix.js (diff: sg-fix.diff, generator: make_fix.py).
1) Never hide search before Instagram has drawn the new page. openPath(path) keeps the overlay and adds a 'leaving' state. The CSS class .wrap.leaving dims the results (opacity .35, pointer-events none) and shows a centred spinner. A module-level `leaving = {path, from: here(), before: pageSig(), at, via, sawBusy, ack, self, drawnAt, abandoned, unloading}` is kept. Still nativeReplace the current entry with Object.assign(history.state, {sgSearch: token}); keeping Instagram's `key` matters for Back. Then saveSearch().
2) Navigate like Instagram does. igModule(name) uses window.require('ifRequired')(name, yes, no), inside try, with no throw. If browserHistory_DO_NOT_USE is running, its browserHistory.push exists and getCometRouterDispatcher() is non-null, call browserHistory.push(path). That is PolarisNavigationUtils.openURL's own call, and it creates Instagram's own history entry. Read igRouterStatus() through currentCometRouterInstance.get_THIS_IS_NOT_WHAT_YOU_WANT().getCurrentRouterStatus(); if it is not NO_ACTIVE_NAVIGATION, set sawBusy. If the module is missing, or the push started nothing (still idle, URL unchanged, nothing written to history on the next 100 ms tick), use popOpen(): the 1.1 pushState(null) plus a synthetic PopStateEvent, which CometRouter's me() turns into go(currentURL, {replace:true}).
3) Arrival watcher watchLeaving() replaces the 1.8 s timer and polls every 100 ms. busy = router status known and not NO_ACTIVE_NAVIGATION. moved = here() !== from. Do not compare against the exact target: Instagram may canonicalise to /user/p/CODE/ or /reel/. drawn = moved && !busy && pageSig() !== before. On drawn: for post/reel routes also wait for media (main video, main img[srcset], img[src*=cdninstagram], article video/img), with a 2.5 s grace period. Then settle(): two rAFs, coverSearch(false), hideSearch(false), leaving = null; search.suspended stays true so Back restores. Full-load rules (fullLoad(): location.replace(path) if the address already changed, else location.assign(path); the cover stays painted until the new document paints, and the unloading flag stops timers): (a) nothing picked up: !busy && !sawBusy && no ack && age > 800 ms when the router status is readable, 2500 ms when not; (b) picked up but nothing drawn and router idle: 8 s; (c) still busy: 10 s. ack = any pushState/replaceState made by the page itself (not us) while leaving; set it in the history hooks at 934-944 with a self flag around our own pushState. This replaces 1.1's 1.8 s rule, which killed slow but working client navigations.
4) routeChanged() (915): if leaving -> leavingRouteChanged(): do not hide. If Instagram moved back to `from` by itself (its Home tab, still tappable under the overlay), cancel: leaving = null, hideSearch, suspended = false, clearSaved. Otherwise re-arm the watcher at 50 ms. When not leaving, do not hide search if history.state.sgSearch === search.token (returning to the marked entry). restoreSearch(): if search is already open, only drop the marker from the entry and set suspended = false.
5) Back during the cover. SG.back: if leaving and the address already changed -> leaving = null, uncover, history.back() (lands on the marked entry; search is already up). If not yet changed -> abandoned = true and uncover to the results. The watcher then calls history.back() unseen once Instagram finishes, or gives up after 1.5 s idle. Always return true. MainActivity.onBackPressed already routes Back to __sg.back while searchOpen; searchOpen stays true during the cover, which also keeps the end-of-Home card hidden.
6) bfcache: on pagehide, stop the watcher. On pageshow(persisted) with leaving set, drop leaving, uncover, and clear the marker, so a restored page shows the results instead of resuming the open.
7) Diagnostics: stats.searchOpens = {router, popstate, fullLoad, lastMs}. Optionally show it in MainActivity's Filter status (~1030).
Optional speed-up, not required: on pointerdown on a result row or cell, call getCometRouterDispatcher().prefetchRouteDefinition(path), which is what Instagram's links do on mount and press. It saves the /ajax/route-definition/ round trip but adds a POST per touched result.
Edge cases covered: canonical redirects; Instagram's own forced full reloads ('unmatched', 'navigation_limit', 'session_time_limit') happen behind the cover, and Back restores from sessionStorage as in 1.1; another nav tab tapped during the cover counts as arrival; Accounts and the 'Open Instagram's own page' links share openPath and are fixed too.

--- risks:
Uses Instagram-internal module names (browserHistory_DO_NOT_USE, currentCometRouterInstance, ifRequired) and status strings that Meta can rename at any time. All access goes through ifRequired in try/catch and falls back to the popstate way and DOM signals, so the worst case is a longer spinner (up to 8-10 s) and then a covered full load, never Home. Without router status, a slow route-definition fetch (>2.5 s) on a bad network may trigger a full load early, still behind the cover. The ack heuristic can be set by unrelated Instagram history writes; that only lengthens the wait. pageSig() and the media check can mis-detect if Instagram draws the post as a modal outside <main>; document.title in pageSig plus router idle make the cover drop anyway. Instagram's bottom nav stays tappable under the cover: Home cancels the open, other tabs count as arrival. browserHistory.push uses navigationType 'navigation' instead of 1.1's 'popstate', so the post opens at its top, as when Instagram opens it itself. Calling Instagram modules may add their normal telemetry; ifRequired itself does not log.

--- phoneDiagnostics:
What can't be confirmed from here: whether the 1.8 s full-reload fallback also fired on the S25 Edge, or only the transition hold. Both expose Home, and the fix covers both. 1.1 records nothing about this. In the next build, Filter status should show 'Search opens: router N / popstate N / full load N, last N ms' (stats.searchOpens). router > 0 confirms browserHistory_DO_NOT_USE and currentCometRouterInstance are running on the logged-in page; full load > 0 with lastMs > 8000 would mean the route really is stuck. With a debug build (setWebContentsDebuggingEnabled(BuildConfig.DEBUG), MainActivity:133) over chrome://inspect on the logged-in Home, run: require('ifRequired')('browserHistory_DO_NOT_USE', m => typeof m.browserHistory.push, () => 'missing') and require('ifRequired')('currentCometRouterInstance', m => m.get_THIS_IS_NOT_WHAT_YOU_WANT().getCurrentRouterStatus(), () => 'missing'), and log history.state (expected shape {key:...}). A simple question for the user on 1.1: does Instagram's logo or splash screen appear between Home and the post? If yes, that open was a full reload.

--- tests:
New file (prototype: /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf/search-open-flash/tests/b14.test.cjs, also copied to wf/search-open-flash/b14.test.cjs). It uses a page-side stand-in for CometRouter, wf/search-open-flash/mockapp.js: one popstate listener, unknown key -> go(url, {replace}), FETCHING_ROUTE -> history write -> REACT_PENDING that keeps the old DOM -> render. Options: window.require/ifRequired + browserHistory_DO_NOT_USE + currentCometRouterInstance, ignoreForeign, dropPush. A rAF recorder logs every frame, also across full loads via sessionStorage. Tests: (1) router push: no frame shows Home without search, the cover was shown, no synthetic popstate, no reload, Back -> results; (2) no modules, slow route via popstate: Home never shows and no reload cuts it short, /reel/ result; (3) router that ignores foreign states: full load, the old page's last frame is the cover, Back -> results; (4) Back before the address changes: search never leaves the screen, URL ends at '/', no stale marker; (5) Back after the address changes but before the post draws -> results, no Home frame; (6) account result covered until the profile is drawn; (7) bfcache pageshow(persisted) -> results, no full load resumed; (8) dropped push -> popstate way, searchOpens = [router 1, popstate 1, fullLoad 0]. Result: 0/8 pass on 1.1, 8/8 on the prototype. Update the existing test 'search: Posts & Reels shows a grid; opening one and coming back restores search': after the click assert .wrap.leaving is present instead of searchText === null, and await page.waitForEvent('load') instead of the fixed 2600 ms wait (diff: wf/search-open-flash/page.test.diff). With that change the existing suite passes 51/51 against the prototype. The existing test 'after opening a result, going Home later does not reopen search' passes unchanged thanks to the cancel-on-return-to-origin rule. On device: open a Posts & Reels, an Accounts and an 'Open Instagram's own page' result over Home and watch for any Home frame; check Back -> results, and Back while the spinner shows.

--- evidence:
* simplegram.js 1553-1559: a click on an a[href=/explore/] link calls preventDefault and openSearch(true), so search opens over the current page (Home). Existing test 'search: the Search tab opens SimpleGram search...' asserts the pathname stays '/' ('stays on the page underneath').
* simplegram.js 2197-2219 openPath: 2200 nativeReplace(...{sgSearch}); 2201 saveSearch(); 2202 hideSearch(false) <- reveals Home immediately; 2207 history.pushState(null,'',path); 2208-2209 syntheticPop + dispatchEvent(new PopStateEvent('popstate',{state:null})); 2216-2218 setTimeout 1800: if same path && pageSig()===before -> location.replace(path). Also 915: routeChanged() hides search on any URL change.
* tests/page.test.cjs ~684-686 ('Posts & Reels shows a grid; opening one and coming back restores search') asserts searchText(page) === null right after the click. The current suite codifies the hide-before-navigate behaviour.
* b385 buildCometHistory: one listener, window.addEventListener("popstate",function(){n==null||n()}), with getState = window.history.state. It reacts to untrusted (synthetic) events too.
* b385 buildCometRouter popstate handler me(): `var n=...J.getState(),i=n==null?void 0:n.key;if(i==null||!V[i]){De.withContext({from:...}).go(""+window.location.pathname+window.location.search+window.location.hash,{navigationType:"popstate",replace:!0});return}`. An unknown or null key means 'navigate to the current URL with replace'. It is not ignored. b385 CometHistoryManagerStack d(): for an unknown key it appends a phantom entry, which the later replaceState truncates (harmless).
* b385 buildCometRouter Ce(): `L=t!=null?t:a.getRoute(b)`; if the route is not cached: `var Ce=re.fetchingRoute();... var Se=await a.fetchForNavigation(e,...)`. Only then Ee() -> `ye(re,e.stripParams,ce||n)` (history push/replace) followed by `pe(ne,...)` (router state update). Invalid route -> cometRouterNavigateOnWindow(url,'unmatched') = full page load. Forced reloads also happen for 'navigation_limit' / 'session_time_limit'.
* b385 buildBaseCometRouterStateProvider: `I=g()` (useTransition); `e.listen(function(t,n,r){... t===!0?D(function(){P(o),v(o),L(a),...}):...})` and `m(function(){e.markNavigationAsCommitted_INTERNAL_ONLY(s.routeKey)},[s.routeKey])` (useLayoutEffect). Router state is applied in a transition, so the old screen stays until the new route renders. b385 CometRouter.flow: RouterStatus = NO_ACTIVE_NAVIGATION | GOIMPL_TRIGGERED | FETCHING_ROUTE | REACT_PENDING (cometRouterCreateRouterStatusManager).
* Supported client-side path, b207 browserHistory_DO_NOT_USE: `push:function(t,n){... (a=C)==null||a.withContext({url:window.location.pathname}).go(o,{passthroughProps:n})}` (C is set by setCometRouterDispatcher). b207 PolarisNavigationUtils.openURL (Instagram's own in-app URL opener) for www.*.instagram.com: `o("browserHistory_DO_NOT_USE").browserHistory.push(i)`.
* Anchors: b207 useCometRouterLinkEventHandlersBase. Instagram links navigate from their React onPress handler (`d(function(){R==null||R(),U(t)})` -> `P.go(i,...)`) and prefetch route definitions on mount (`P.prefetchRouteDefinition(i)`). Grepping all 418 bundles for document/window 'click' listeners finds no global href interceptor, so a plain <a> we add would cause a full page load.
* Module access, b25: the global gets `t.require=G`; `Oe("ifRequired",qe)`; `function qe(e,t,n){var r=o[e];if(r&&r.factoryFinished){...return t(H(r))}else if(typeof n=="function")return n()}`. This is a no-throw probe; plain require of an unknown module throws 'Requiring unknown module'. b25 currentCometRouterInstance: get_THIS_IS_NOT_WHAT_YOU_WANT/register. buildCometRouter registers {dispatcher,getCurrentRouterState,getCurrentRouterStatus,listen,...}.
* Live check: the saved logged-out shell plus Instagram's real cached bundles, all served locally (0 requests reached www.instagram.com, every POST answered locally). Script: wf/search-open-flash/live-check.cjs. PROBE: require=function, history.state={"key":"initial"}, browserHistory.push=function, dispatcher=true, router status NO_ACTIVE_NAVIGATION at url '/'. PolarisNavigationUtils is 'not running' on the logged-out page. ifRequired on an unknown module runs only the 'no' callback.
* Live check, continued. After pushState(null,'/p/DUMMYCODE01/') plus a synthetic popstate, the status is FETCHING_ROUTE at 0 ms and the first request is POST /ajax/route-definition/. So the router routes; it does not ignore our state. (My junk local answer then made it do an 'unmatched' full load, which is an artefact.) browserHistory.push('/p/DUMMYCODE02/') also gives FETCHING_ROUTE at 0 ms, the URL stays '/' while the route is fetched, and the same POST /ajax/route-definition/ follows.
* Mock Comet-like router experiment (wf/search-open-flash/exp.cjs, output exp-out3.jsonl). 1.1 with fetch 300 + render 500 ms: Home visible 800 ms (15..798 ms), post at 815 ms. 1.1 slow (900 + 1300): Home 1801 ms, then a full reload (fullLoads=1); the last frame of the old page was Home without search; post at 2230 ms. 1.1 with a router that ignores foreign states: Home 1.8 s plus a reload. Prototype: Home visible 0 ms in all 6 variants (router push, popstate, slow, ignoring router -> full load behind the cover, dead dispatcher); Back returned to the results in every case.

--- notes:
I changed nothing in /home/user/SimpleGram (read-only), and no request reached www.instagram.com: the live check served the saved logged-out shell and Instagram's real bundles from disk and answered every POST locally.

Answer to the router question: Instagram's CometRouter does not ignore our pushed null state. Its only popstate listener (buildCometHistory) calls me(). When history.state.key is null or unknown, me() runs go(current URL, {replace:true}), and the live check shows FETCHING_ROUTE at 0 ms. The flash comes from openPath hiding search before navigating, combined with the router's useTransition hold. The 1.8 s reload is a second problem for slow loads. Instagram's own in-app navigation is browserHistory_DO_NOT_USE.browserHistory.push (what PolarisNavigationUtils.openURL calls). It is reachable through window.require('ifRequired'), which is present and safe on the current page. No global anchor interception exists, so an anchor we inject would cause a full page load.

Files in /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf/search-open-flash/:
- sg-fix.js: the prototype patch; diff in sg-fix.diff, generated by make_fix.py from sg-orig.js
- mockapp.js: the mock Comet router
- b14.test.cjs and tests/b14.test.cjs: the new tests
- tests/page.test.cjs: the full suite, which reads the script from the SG_SCRIPT env var; page.test.diff is the update to the existing test
- exp.cjs: the timing experiment; results in exp-out3.jsonl
- live-check.cjs: the probe of the real bundles
- buildCometRouter.js: the extracted router module

Commands:
- New tests: SG_SCRIPT=<script> NODE_PATH=/opt/node-tools/node_modules node --test tests/b14.test.cjs
- Full suite: SG_SCRIPT=<script> NODE_PATH=/opt/node-tools/node_modules node --test tests/page.test.cjs

Accounts results go through the same openPath, so they have the same flash. The user may not have noticed it there.

######## REVIEW

=== B14 verdict=confirmed
--- corrections:
The root cause holds. Every cited location checks out against the code. Click intercept: simplegram.js 1551-1558 (the investigator said 1553-1559, off by one). openPath: 2197-2219; hideSearch(false) at 2202 runs before history.pushState at 2207 and the synthetic popstate at 2209. routeChanged hides search on any URL change at 915. History hooks: 932-945. The existing test asserting searchText===null after the click: tests/page.test.cjs 686.

The bundle claims also check out:
- b385 buildCometHistory has a single window popstate listener.
- me() handles an unknown or null key with `go(pathname+search+hash,{navigationType:"popstate",replace:!0})`.
- Ce awaits `a.fetchForNavigation` for uncached routes.
- cometRouterCreateRouterStatusManager has the states GOIMPL_TRIGGERED, FETCHING_ROUTE, REACT_PENDING and NO_ACTIVE_NAVIGATION.
- buildBaseCometRouterStateProvider uses `g=c.useTransition` and `t===!0?D(function(){P(o),v(o),...})`, plus `m(function(){e.markNavigationAsCommitted_INTERNAL_ONLY(s.routeKey)})`.
- b207 browserHistory_DO_NOT_USE.push calls `C.withContext({url:...}).go(o,{passthroughProps:n})`.
- b25 registers `Oe("ifRequired",qe)`.
- No bundle has a global href click interceptor; the document click listeners in b224, b44, b242 and b257 are for logging or UI.

I re-ran everything:
- tests/b14.test.cjs: 0/8 on 1.1, 8/8 on sg-fix.js.
- Full suite with page.test.diff: 51/51.
- My timing run, mock router with fetch 300 ms and render 500 ms: 1.1 shows Home with no search on top for 783 ms (48 frames), in both popstate and router mode. The prototype shows it for 0 ms.

Three things the investigator could not confirm, or got slightly wrong:
(a) Mechanism 2, the 1.8 s location.replace, cannot be confirmed without the phone. The user mentions no logo or splash screen, so mechanism 1 is the dominant cause. Mechanism 1 alone explains 'every time, briefly'. 1.1 also does a needless full reload when the result is the page under search: pageSig never changes, and my R7b run gave loads=2.
(b) 'Back restores from sessionStorage after a full load as in 1.1' holds, but only by timing. Instagram's boot does replaceState({key:'initial'}) and wipes our sgSearch marker. On the logged-out shell with the real bundles (search-open-flash-review/boot-state.cjs) that replace ran at 332-366 ms, after DOMContentLoaded at 117-150 ms. So restoreSearch in start() reads the marker first. The order on the logged-in page is not proven.
(c) 'MainActivity needs no change' is true for the core fix, but not for the diagnostics. showStatus (MainActivity 1010-1040) prints only explicitly named keys. Page stats reset on every document load ('Counts since the page last loaded'), so a fullLoad++ made just before location.replace never reaches Filter status.

I changed nothing in /home/user/SimpleGram; git status is clean.
--- missedCauses:
* Not a cause of the flash itself, but a side effect in the same window that the diagnosis missed. During the window the address is already /p/<code>/ or /reel/<code>/ while Home's DOM is still on screen, because the popstate path pushes the URL first and the router path pushes before React commits. SimpleGram's route-based logic therefore treats Home as the opened post. wantsSound() (simplegram.js 1001-1002) returns true for ANY media element on a 'reel' route, with no on-screen check. The 'play' listener (1081-1086) then unmutes a Home feed video that starts in that window. In R6, 1.1 and sg-fix.js both left the Home video unmuted after a play event; my amended version kept it muted. autoplay() (1100-1116) can also start an on-screen Home video on 'post'/'reel'. Under the prototype's cover this would be audio with nothing visible playing it.
* Small 1.1 bug: opening a result that is the very page search was opened over (for example a friend's profile, then tapping that same account) leaves pageSig unchanged. The 1.8 s rule then forces a pointless full reload (R7b on 1.1: loads=2).
--- fixPlanProblems:
* Regression for a same-page result. moved = here() !== from can never become true, so the cover spins for 8 s and then does a full load. R7 (search-open-flash-review/tests/review4.test.cjs, opened over /sanjosesharks/ and tapping sanjosesharks): sg-fix.js took 8128 ms and 8165 ms to remove search, with loads=2. 1.1 takes 5-10 ms. Accounts search is confirmed working, so this regresses it.
* Back gets 'eaten'. Press Back before the address moves, then the router stays busy (slow post render): the abandoned branch only acts when moved && !busy, has no time limit, and SG.back keeps setting abandoned and returning true. R1 (renderMs 12000): Back presses at 1.6 s and 4.1 s returned true but did nothing. Search stayed open over /p/KEYW001/ until the render finished, so the user could not close search for the whole slow load.
* Double navigation when browserHistory_DO_NOT_USE is present but the router status cannot be read. The 100 ms 'push started nothing' check cannot tell 'still fetching the route' from 'dropped', so it also runs popOpen(). R2 (noStatus mock): go() was called twice, one router push plus one synthetic popstate. On Instagram that means an extra /ajax/route-definition/ POST and two competing navigations.
* False arrival when the router status is unknown. pageSig includes document.title. Instagram's DocumentTitle.badge (b252: `o=n?"("+n+") "+e:e`) turns 'Instagram' into '(1) Instagram' when a notification arrives. The hasPostMedia() check does not help, because Home itself has article img[srcset]. R3b (popstate mode, Home with a feed image, title badge at 150 ms): 76 Home frames, about 1.25 s of Home, which is the very bug. Router mode is safe (R3c: 0 frames) because !busy holds the cover.
* Under the cover, media already on Home can still be autoplayed or unmuted, because the address already says post/reel (see missedCauses, R6). This was invisible in 1.1, where Home was on screen anyway. With a cover it becomes sound with nothing visible playing it.
* Diagnostics: stats.searchOpens.fullLoad is incremented in the document that is about to unload. Stats reset per page, so 'full load N' would always read 0. Showing it also needs a MainActivity.showStatus change, which the plan calls optional while also saying MainActivity needs no change.
* Drop the optional prefetchRouteDefinition on pointerdown. pointerdown fires on every touch, including scroll gestures across the results grid, so it would send a burst of POSTs per scroll. That is a request pattern Instagram's own UI does not produce from touches, and it saves only one round trip.
* pageSig() builds main.textContent, a string of the entire subtree, before slicing it to 400 characters. In popstate mode without router status it runs every 100 ms for up to 10 s, over a Home DOM that can be very large after deep scrolling (the user scrolled a long way). Use a bounded text walk instead.
* Minor native hazard the plan does not mention. MainActivity.onBackPressed (1188-1203) falls back to pageBack() if __sg.back does not answer within 600 ms. In router mode, until the address moves, MainActivity.route is still 'home', so a late answer (main thread busy rendering the route) means moveTaskToBack: the app is minimised. 1.1 had no such window, because search was already hidden (searchOpen=false).
--- revisedFixPlan:
Only simplegram.js needs to change for the fix; the native changes in 9 are optional. A tested reference is in /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/wf/search-open-flash-review/: sg-fix4.js is the investigator's sg-fix.js plus items 1-6 below, and review-amendments.diff is the diff. Results: b14 8/8, full suite 51/51 with the investigator's page.test.diff, and R1/R2/R3b/R6/R7/R7b all fixed.

1) openPath(path)
- If the target is on another origin: location.assign.
- NEW: if target.pathname+search === here(), call openSamePage(path). It does 1.1's sequence: new token, suspended=true, marker added with nativeReplace keeping Instagram's key, saveSearch, hideSearch(false), then pushState(null,'',path) plus the synthetic PopStateEvent with syntheticPop set. Leave out the 1.8 s reload timer. The page underneath is already the result, so nothing wrong can show.
- Otherwise:
  - Set a new token and suspended=true.
  - nativeReplace(Object.assign({}, history.state, {sgSearch: token})), keeping `key`.
  - Remember lastScroll, then saveSearch.
  - Create leaving = {path, from: here(), before: pageSig(), at, via, sawBusy, ack, self, drawnAt, abandoned, unloading, oldMedia: new WeakSet(document.querySelectorAll('video,audio'))}.
  - coverSearch(true): .wrap.leaving dims the children (opacity .35, pointer-events none) and draws a centred spinner. The wrap background stays opaque.
- How to navigate: use the router only when its status can be read. If igRouterStatus() !== null and igPush(path) succeeds, use browserHistory_DO_NOT_USE.browserHistory.push (Instagram's own openURL call; only when getCometRouterDispatcher() is non-null), and set sawBusy if the status is already not NO_ACTIVE_NAVIGATION. Otherwise popOpen(): 1.1's pushState(null) plus synthetic popstate, with leaving.self=true around our own pushState. Read every module through window.require('ifRequired')(name, yes, no) inside try/catch.

2) pageSig()
Use the title with Instagram's badge stripped, document.title.replace(/^\(\d+\+?\)\s*/, ''), plus at most 400 characters gathered with a TreeWalker(SHOW_TEXT) over <main> (or body), not main.textContent.

3) Watcher (every 100 ms; replaces the 1.8 s timer)
Each tick computes:
- busy = status known and not NO_ACTIVE_NAVIGATION
- moved = here() !== from
- drawn = moved && !busy && pageSig() !== before

Normal open:
- On drawn: for 'post'/'reel', also wait for media (main video, main img[srcset], img[src*=cdninstagram], article video/img), for at most 2.5 s. Then settle(): two rAFs, coverSearch(false), hideSearch(false), leaving=null, then safe(autoplay)(). search.suspended stays true so that Back restores search.
- Router mode only: if the first tick still shows nothing started (!sawBusy, !ack, !moved, !busy), switch to popOpen(). This now only runs when the status is readable.

Full-load rules (location.replace if the address already moved, else location.assign; set unloading first; the cover stays painted until the new document paints):
- (a) Never picked up: !busy && !sawBusy && !ack, after 800 ms if the status is readable, 2500 ms if not.
- (b) Picked up, router idle, nothing drawn: 8 s.
- (c) Still busy: 10 s.

Abandoned open (Back was pressed before the address moved):
- As soon as moved is true, busy or not: leaving=null, then history.back(). The router cancels its pending navigation when it gets a popstate to a known key.
- If it never moves: leaving=null after 3 s with the router idle, or after 10 s total.

ack = any pushState/replaceState made by the page itself while leaving (not while leaving.self), recorded in the hooks at 934-944.

4) Routing
- routeChanged (915): if leaving, call leavingRouteChanged() instead of hiding. If Instagram returns to `from` by itself (its Home tab), cancel: leaving=null, uncover, hideSearch, suspended=false, clearSaved. Otherwise re-arm the watcher in 50 ms.
- When not leaving, do not hide if history.state.sgSearch === search.token.
- restoreSearch(): if search is already open, only drop the marker from the entry and set suspended=false.
- NEW: the popstate listener (945) also calls safe(restoreSearch)() when !syntheticPop. routeChanged returns early on a same-URL traversal, so without this Back after a same-page open would not restore search (R7b).

5) SG.back while leaving
- If the address has moved: leaving=null, uncover, history.back(), return true.
- If it has not moved and the open is not yet abandoned: abandoned=true, uncover (the results show), return true.
- If it has not moved and is already abandoned: leaving=null, then fall through to normal search Back (close the tag/place view, or close search). Back is never swallowed.

6) Media under the cover
isOldMedia(v) = leaving && leaving.oldMedia.has(v). Declare it as `let isOldMedia = () => false` next to lastUrl (903) and assign the real function in the search section. wantsSound() returns false for old media, and autoplay() skips it. Media on the newly opened page is unaffected, so autoplay and sound for the opened Reel/video work as before.

7) bfcache
On pagehide while leaving: stop the watcher and set unloading. On pageshow(persisted) with leaving set: drop leaving, uncover, and remove the marker if search is open, so the results show instead of the open resuming.

8) Diagnostics that survive reloads
Keep {router, popstate, fullLoad, cancelled, lastMs, lastVia} in sessionStorage key 'sg-search-opens'. Increment fullLoad before leaving the page. Merge the counts into stats.searchOpens in start(); compute lastMs for a full load from SEARCH_STATE.at when the new document is drawn.

9) Optional
- MainActivity.showStatus: add one line, 'Search opens: router N / popstate N / full load N / last N ms'.
- MainActivity.onBackPressed: while searchOpen, if __sg.back has not answered within 600 ms, do not moveTaskToBack. Do nothing on that press; a second press can use pageBack.
- restoreSearch: if the marker is missing but the navigation entry type is 'back_forward', SEARCH_STATE is suspended and less than 30 minutes old, and saved.returnUrl === here(), restore anyway. This covers Instagram's boot replaceState({key:'initial'}) winning the race on the logged-in page.

Do not add a prefetch on pointerdown.

Requests: the router path and the popstate path each make exactly the requests a tap on an Instagram link makes (one route definition plus the post's GraphQL). There are no double navigations. Full loads happen less often than in 1.1, and none on the slow-but-working path. The watcher makes no requests.

What stays as before:
- The feed filter, nudges and the end-of-Home card are untouched. The card stays hidden because searchOpen remains true while covered.
- Accounts results open through the same path, now without the flash.
- Back returns to the results.
- Comments, zoom and downloads are untouched.

Tests
- Add the investigator's b14 tests (1-8).
- Update the existing Posts & Reels test as in page.test.diff: assert .wrap.leaving and wait for the load event.
- New tests:
  - R7/R7b: a same-page account result removes search within 300 ms, with no full load, and Back returns to the results.
  - R1: Back before the address moves, with a 12 s render: the second Back closes search.
  - R2: browserHistory present but no status: exactly one go().
  - R3b: popstate mode, Home with feed images, title becomes '(1) Instagram' during the load: zero Home frames.
  - R6: a Home video's 'play' during a Reel open is not unmuted, while the opened page's own video still is.
  - The full-load counter survives the reload.
- On the phone, test four opens: a Posts & Reels result, a Reel result, an Accounts result, and an 'Open Instagram's own page' result. For each, check that no Home frame shows and that Back returns to the results. Also check Back while the spinner is showing, and a second Back.


######## CRITIQUE
(1) Things no cluster explained

- Screenshot 2 (the sportsonprime media shrinks to a ~2px strip while its like row and caption stay visible) is still unexplained. Inside an article, tidyFeed hides only whole posts (simplegram.js 755-760). tidyBanners skips articles (692). The one SimpleGram hide that could remove part of a post is tidyReelsTab (700-705) plus the CSS rule at 662: neither is limited to outside articles, and tidyReelsTab climbs through single-child parents. I found no feed anchor to "/reels/" in the logged-out bundles. The only "/reels/" opener is a click handler in PolarisLoggedOutReelsBrandedContent (b294), so this is unlikely but unchecked. The other candidates are Instagram's virtual list and a WebView paint or memory failure. Filter status does not show stats.dom.reelsTab.
- "Posts because a friend liked or commented": no cluster wrote a rule for these. They are fixed only if they are explore_story units or have friendship_status following:false. The planned diagnostics record social_context types; add a rule only once real shapes are seen.
- The not-followed posts before the caught-up marker (sportsonprime, hsmarken) have two explanations: an all-suggestions page that fails open, or plain media with no friendship_status. The fix covers only the first. The second stays visible on purpose and diagnostics must settle it.
- Every Posts & Reels query, and the tag grid, first calls the dead REST endpoint /api/v1/fbsearch/web/top_serp/ (loadKeyword 1745), which costs a 404 round trip. It was handed to the search-open-flash cluster, which never took it up. Remove it with the topsearch calls.

(2) Shared root causes and contradictions

One cause sits behind the suggested posts, the endless spinner, most of the black-feed risk, the slow Stories, and the missing or flapping end card:
- filterFeedList fails open at 349-353, because feedVerdict marks explore_story and ads as media:false (276-278).
- Home is never ended at end_of_feed_demarcator, so Instagram switches to feed_recs pages.
- The phone counters (8 pages read, 7 unrecognised, streamed 0) rule out the ghost_owl and streamed theories.

The marker's group lists cause trouble of their own: they are filtered as separate "pages" (visit 462), and when recognised, hasMore(group) makes 397 set a false fs.ended. Search has a second shared cause: dead REST endpoints, plus GraphQL calls with a stale doc_id or missing provided variables.

Contradictions to settle before building:
- Keep or drop the marker. The feed-leak and black-feed plans keep it and empty its groups. I checked b385: polarisFeedReducer `m(n.paginationInfo,n.groups)` returns moreAvailable:true whenever a FEED_RECS group entity exists, even with nextMaxID null. Groups are normalised by id. So a kept but emptied group can still advertise more pages. Drop the marker edge by default (feed-end plan) and let the native card show Instagram's subtitle.
- Group handling. Never count group lists as pages and never let them change feed state. Filter them strictly to followed posts instead of skipping them (the plain skip regresses Following).
- feed_recs page: black-feed empties it, the other two keep followed posts. Keep followed posts.
- Recognising explore_story: use a separate v.known flag (feed-leak plan), not media:true, so kept counts and followSuspect keep their meaning.
- State reset: the plans propose two different rules. Use one: a page with a new cursor after the end counts as a refresh only if it has a marker or a followed post; otherwise blank it and stay ended.
- Stall handling: the 15 s stall card and the feedBlank watchdog overlap. Merge them into one native card state, with no automatic scrolling or reloading.
- feedVariant() treats ?variant=past_posts as 'home' (line 304). Every end-at-marker rule must exclude it.
- Tests: either move the marker out of mixedFeed or update line 115. I recommend keeping the marker in and updating the assertions.

(3) Fix order for the next build

1. Feed data layer, as one change:
   - recognise all unit types before the fail-open;
   - end Home at the marker (marker dropped, stopPagination, ended and caughtUp set), running before the fail-open and only on variant home;
   - feed_recs pages keep only followed posts;
   - after-end rule as above;
   - line 397 counts only real paging owners;
   - add 'unconnected' to the inventory_source rule at 267;
   - add `(^|__)ayml(__|$)` to SUGGEST_KEY: an empty first Home page triggers loadSULV2 → xdt_api__v1__ayml__strict, which line 183 does not match.
2. End card (B11):
   - feed state per variant;
   - remove the 4 s rule;
   - show when ended or caughtUp;
   - stall fallback whose clock restarts on every page;
   - spacer under the last post.
3. Search plumbing (B12/B13):
   - read providedVariables from require('<name>.graphql');
   - refresh the KNOWN ids;
   - at most 2 POSTs per call, and no /graphql/query after a parsed GraphQL error;
   - remove topsearch, locations/web_info, sections and top_serp;
   - Tags always shows the typed '#tag' row, plus PolarisAPITopsearchQuery with context 'hashtag'.
4. Search-open cover (B14) with all reviewer amendments: same-page results, Back never swallowed, router only when its status is readable, badge-stripped pageSig, guard on old media. Medium risk because it relies on Instagram-internal modules.
5. B15 edge tab: low priority, native.

Defer as risky or unproven:
- __d/module hook and the WeakSet guard (ghost_owl);
- in-place neutralising of streamed pages;
- hiding posts inside the MutationObserver callback, unless it ships with the run guard;
- video unloading and preload changes;
- XHR/fetch learning hook;
- extra headers and params;
- prefetch on pointerdown;
- the B10 throttle toast (counting only for now).

(4) Minimal phone diagnostics (counts and shapes only)

First, look at the Filter status screenshot the user already sent: its "Backup filter Suggested" line separates hidden posts from a paint blackout.

New in Filter status, plus a "Copy details" JSON. MainActivity.showStatus prints only keys it names, so each line needs native code:
- Feed counters: pages, unrecognised, streamed, marker seen, removed after the end, recs pages, removed inside marker groups, kept posts with unknown follow state, Home posts on screen with a "Follow" header button, longest hidden run, peak articles and videos in the DOM, blank events, dom.reelsTab, and dom hides inside articles.
- Ring of the last 40 Home units: page number, unit kind, verdict, follow 1/0/null, inventory_source (32 characters), product_type, social_context types, the connection's pagination_source, has_next, is_final, and which hook saw it (parse/fetch/xhr).
- Ghost_owl: only whether the window.Env keys are present and whether JSON.parse is still ours. No require of Instagram's detection modules.
- Search: a gqlLog ring of 20 entries: query name, id source, provider names and values, path, HTTP status, error code and message (200 characters), edge count. Also hashtag counts per source.
- Search opens: router / popstate / full load / last ms, kept in sessionStorage so full loads are counted.
- Stories: load ms for the last 5 opens, and the number of video elements when Stories opens. Network: counts of 429, 5xx and "wait" responses.
- Native: onTrimMemory levels, renderer-gone didCrash and priority, WebView version.

No files were written. The evidence is the simplegram.js lines cited above and b385.js / b294.js in /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/ig/js/.