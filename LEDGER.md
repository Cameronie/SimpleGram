# SimpleGram bug & request ledger

Batches are collected first and built only when Cam says "Apk it".
Status: **open** (recorded, not started) · **fixed (unconfirmed)** (in a build, not yet confirmed on the phone) · **confirmed** (Cam confirmed on the phone).

## Confirmed working on the phone (1.0)

- No ads and no suggested posts in the feed.
- Sound on automatically for a Reel opened from DMs.
- Scrolling (feed, messages, profiles) after an app restart — see B2.

## Confirmed working on the phone (1.2)

- No suggested posts: none slipped through (Suggested removed 48, 0 unrecognised pages, 0 posts with a Follow button). Posts shown because a friend liked them are removed too.
- Home ends at "You're all caught up" with the Following / Favorites card and Instagram's "You've seen all new posts from the past 3 days."
- Copy details works.

## Batch 4 — open (reported against 1.2)

| # | Report | Likely cause (tentative, diagnosis in progress) | Planned fix |
| --- | --- | --- | --- |
| B16 | Scrolling Home: a friend's post I'd already seen came up, then Home jumped back to the top with only 1 post and the end card. | From Copy details: Home ended at Instagram's "caught up" marker. Then a page of posts already seen arrived, and SimpleGram took it for a refresh and reopened Home. Then a second "caught up" page came with 1 post, so Home ended again with just that one. The jump to the top looks like Instagram replacing its list (its own refresh, or its "older posts" list), not SimpleGram scrolling. | Depends on diagnosis: keep Home ended (and where you were) when Instagram loads after the end, and never let it swap the list for a 1-post one. |
| B17 | Following from the end card was completely blank. | From Copy details: Following's first page had only 3 posts, all already seen in Home. SimpleGram skipped all 3, leaving an empty list, and Instagram doesn't load more for an empty list (1 nudge, no second page). | Never leave the list empty: show where Home left off (or a "you've seen these" marker) so Instagram keeps loading, and skip the rest as before. |

## Confirmed working on the phone (1.1)

- Accounts search.
- Back from an opened search result returns to the results.
- The start of Home: friends only, no ads.

## Batch 3 — fixed (unconfirmed) in 1.2 (reported against 1.1)

Full diagnosis and build plan: [`notes/batch-3/plan.md`](notes/batch-3/plan.md).

New in 1.2 for reporting: Menu → More → **Filter status** shows the new counts, and **Copy details** copies them (counts and data shapes only, no names) to paste into a message.

| # | Report | Cause | Fix in 1.2 |
| --- | --- | --- | --- |
| B8 | Suggested posts in Home (accounts you don't follow, with a Follow button), even one before "You're all caught up", then Instagram's "Suggested Posts" section after it; maybe posts shown because a friend liked them. Second try: new posts kept loading without end, and nearly all of them were random suggestions. | **Confirmed** (your Filter status: Posts shown 2, Suggested removed 0, Pages read 8 with 7 unrecognised; reproduced exactly). Once you're caught up, Instagram switches Home to an all-suggestions feed. Those pages contain only "suggestion" units, no plain posts. SimpleGram took such a page for an unknown format and left it alone; that safety net is meant to stop an Instagram change from blanking the feed. Leaving those pages alone also skipped the "stop loading" logic, so it never ended. | Recognise suggestion units, so those pages get filtered. End Home at "You're all caught up" and stop loading there. Keep only posts from people you follow on any suggestions page. After the end, never let a page through unfiltered. Also apply Instagram's own "Suggested for you" rule, and block the suggested-accounts list Instagram shows when Home has nothing new. Add a "Copy details" diagnostic (data shapes only, no names). |
| B9 | Home went black: a long blank scroll, a post flashed a few times, the spinner at the bottom, nothing new loaded. One post's video shrank to a thin strip. Second try: not reproduced (the feed kept loading instead). | Not confirmed on the phone; two candidates, both set off by B8's endless suggestions. (1) SimpleGram's on-screen backup filter hid labelled suggestions after Instagram had drawn them. Instagram's scrolling list keeps their space, which shows black, and each one flashed for about 0.3 s first. (2) The WebView ran out of drawing memory with endless Reels. The thin strip is unexplained. | B8's fix removes the trigger. Hide labelled posts before they're drawn, and stop loading if several hidden posts pile up. Pause videos in hidden posts. Record blank-screen, memory-warning and crash counts in Filter status. |
| B10 | After the black feed, Stories took a very long time to load. | Not confirmed. Most likely the same endless suggestions: Instagram kept loading and preloading them. SimpleGram's own checks also scanned the whole long feed while Stories was open. Instagram slowing requests is possible. SimpleGram itself sends no requests on Home or Stories. | B8's fix. Lighter SimpleGram checks while Stories is open. Record Stories load time and any "slow down" answers from Instagram in Filter status. |
| B11 | The Following / Favorites buttons flashed briefly after the first couple of posts, then vanished; they didn't appear at the real end. Second try: they showed for a couple of seconds, then vanished as more suggestions loaded. | **Confirmed.** The 4-second fallback kept running while Instagram sent pages that added nothing. The real end ("You're all caught up") was never used. A trip to Stories or a post also made SimpleGram forget where Home stood. | The buttons appear at the real end of Home, with Instagram's "You've seen all new posts from the past 3 days." Home's state is kept across Stories and posts. If nothing loads for 15 seconds, the card says "Home isn't loading more". Room under the last post so the card doesn't cover it. |
| B12 | Places search: no results on Top or Most recent; only "Open Instagram's own page" works. | **Confirmed.** Instagram removed the old place request (it now answers like a nonexistent page). The newer request SimpleGram falls back to uses an outdated ID and lacks a setting Instagram added. | Read the current request ID and settings from Instagram's own page code, with updated built-in values as backup. Use the request Instagram's place page makes for Top and Most recent. At most 2 tries per tap; a "Try again" button. |
| B13 | Tags search: "No tags found for 'Nba'". | **Confirmed.** Instagram's website search no longer returns hashtags, and the old search request is gone. | Always offer the tag you typed ("#nba") first; it opens Instagram's hashtag results, which is what the website shows. Also ask the lookup Instagram uses for "#" suggestions in comments, and add any tags it returns with post counts. Remove calls to dead endpoints, which also speeds up every search. |
| B14 | Opening a Posts & Reels result flashes Home before the post or Reel. Back to the results works. | **Confirmed.** SimpleGram hid the search screen before Instagram started switching pages, and Instagram keeps the old screen (Home) up until the post is ready. On slow loads, SimpleGram also forced a full reload after 1.8 s. Accounts results have the same flash. | Keep the search screen up, dimmed with a spinner, until the post is on screen. Navigate the way Instagram's own links do. No forced reload while a slow load is still working. Back during the spinner returns to the results. |
| B15 | (Spotted in your screenshot, low priority.) SimpleGram's round ⋮ button can sit on top of a post's Save icon. | The button sits on the right edge at mid-height. It can already be dragged up, down or to the other side; that isn't explained anywhere. | A slimmer tab flush with the screen edge, and a one-time "drag me" tip. |

## Batch 2 — fixed (unconfirmed) in 1.1 (reported against 1.0)

| # | Report | Cause | Fix in 1.1 |
| --- | --- | --- | --- |
| B1 | Pinching lets the page zoom out smaller than the screen; it stays shrunk with a black border. | Zoom allowed down to 0.85×; when the pinch ended below 1× the release never reached the zoom handler, so it never snapped back. | Zoom never goes below 1×. Once a pinch starts, the zoom handler owns the whole gesture until the last finger lifts. |
| B2 | Scrolling stopped working everywhere (feed "stuck on one post", messages, profiles). Fixed by restarting the app. | B1: after that pinch the page got a broken touch sequence. | Fixed with B1. The page now always gets a complete touch sequence, or none. |
| B3 | Reel sent in a DM opens paused; have to press Play. (Sound was on.) | Instagram's DM viewer doesn't autoplay. | The opened video starts once, when it is mostly on screen, unless you already played or paused it. This also applies to opened posts and Reels. Carousel slides off screen don't start. |
| B4 | Home feed scroll is slow and clunky: wait for one post to load, then the next. | Each page Instagram sends is mostly ads/suggestions, which get removed. That leaves 1–2 real posts per load. Instagram's server ignores requests for bigger pages. | SimpleGram asks for the next page early, and keeps asking while a page brings nothing new. The end-of-Home buttons (B7) lead to Following, which has no suggestions to remove. |
| B5 | Search only shows accounts; no photo/Reel results. | Instagram's mobile site shows only accounts in the search dropdown. | Search has its own screen with tabs (see R1). |
| B6 | One Story video wouldn't download (others did). | That Story's data wasn't in what SimpleGram had seen. | Backup lookups: the Story item itself, then the account's current Stories (or the highlight). A clearer message if all of them fail. |
| B7 | At the end of the feed, show older posts and/or Favorites. Keep Home (Instagram's picks first) as the start; continue into Following when Home runs out, without repeats. | Merging two feeds into one scrolling page is what broke the old apps' feeds. | At the end of Home, a card shows two buttons side by side: **Following** and **Favorites** (both newest first). Each skips posts you already saw in Home, but only when you arrive from these buttons; the menu entries show everything. Back returns to Home. |

## Requests

| # | Request | Notes |
| --- | --- | --- |
| R1 | Search: see accounts, photos/Reels, hashtags and places, or pick which. Places (and tags) with Most recent / Top toggle like old Instagram. | **Fixed (unconfirmed) in 1.1.** Tabs: Accounts · Posts & Reels · Tags · Places. Places have Top / Most recent. Hashtags: Instagram's website removed Most recent for tags. SimpleGram shows the older recent list when Instagram still sends one, and says it isn't strictly newest first. Each grid stops after 3 "Show more" taps. |
| R2 | Instants. | App-only (launched May 2026 in the app's DM inbox, needs the in-app camera); not on Instagram's website. Not possible in SimpleGram unless the website adds it. |
| R3 | Map (from the messages page). | App-only; not on Instagram's website. Same as R2. |
