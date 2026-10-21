# SimpleGram bug & request ledger

Batches are collected first and built only when Cam says "Apk it".
Status: **open** (recorded, not started) · **fixed (unconfirmed)** (in a build, not yet confirmed on the phone) · **confirmed** (Cam confirmed on the phone).

## Confirmed working on the phone (1.0)

- No ads and no suggested posts in the feed.
- Sound on automatically for a Reel opened from DMs.
- Scrolling (feed, messages, profiles) after an app restart — see B2.

## Confirmed working on the phone (1.1)

- Accounts search.
- Back from an opened search result returns to the results.
- The start of Home: friends only, no ads.

## Batch 3 — open (reported against 1.1)

| # | Report | Likely cause (tentative, diagnosis in progress) | Planned fix |
| --- | --- | --- | --- |
| B8 | Suggested posts in Home (accounts you don't follow, with a Follow button), even one before "You're all caught up", then Instagram's "Suggested Posts" section after it; maybe posts shown because a friend liked them. | Lead: later feed pages arrive in Instagram's "streamed" format, which 1.1 lets through unfiltered (to avoid scrambling them). 1.1's load-ahead reaches those pages sooner. | Filter streamed pages safely; end Home at "You're all caught up" and drop everything after it. |
| B9 | Home went black: a long blank scroll, a post flashed a few times, the spinner at the bottom, nothing new loaded. One post's video shrank to a thin strip. | Under investigation: the page running out of rendering memory or time as the feed grows, and/or SimpleGram's on-screen checks hiding and re-showing posts. | Depends on diagnosis. |
| B10 | After the black feed, Stories took a very long time to load. | Likely the same as B9 (page bogged down), or Instagram slowing requests after heavy paging. | Depends on diagnosis. |
| B11 | The Following / Favorites buttons flashed briefly after the first couple of posts, then vanished; they didn't appear at the real end. | The "4 seconds at the bottom" fallback fires while the next page is still loading. The real end was missed (see B8). | Show the buttons only at a real end of Home (Instagram's "caught up" marker or no more pages). |
| B12 | Places search: no results on Top or Most recent; only "Open Instagram's own page" works. | Instagram removed the place-page request SimpleGram uses first (now "Page Not Found"), and the newer one isn't being found or accepted. | Use the request Instagram's own place page makes now. |
| B13 | Tags search: "No tags found for 'Nba'". | Instagram's old search request is gone ("Page Not Found"), and the website's current search may no longer list hashtags. | Always offer "#nba" itself, opening Instagram's hashtag results; add any tags Instagram returns. |
| B14 | Opening a Posts & Reels result flashes Home before the post or Reel. Back to the results works. | The search screen hides before Instagram has switched to the post. It may also be a full page reload after 1.8 s. | Keep the search screen (or a blank cover) up until the post is on screen; navigate the way Instagram's own links do. |

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
