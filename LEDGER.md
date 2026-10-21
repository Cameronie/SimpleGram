# SimpleGram bug & request ledger

Batches are collected first and built only when Cam says "Apk it".
Status: **open** (recorded, not started) · **fixed (unconfirmed)** (in a build, not yet confirmed on the phone) · **confirmed** (Cam confirmed on the phone).

## Confirmed working on the phone (1.0)

- No ads and no suggested posts in the feed.
- Sound on automatically for a Reel opened from DMs.
- Scrolling (feed, messages, profiles) after an app restart — see B2.

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
