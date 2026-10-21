# SimpleGram bug & request ledger

Batches are collected first and built only when Cam says "Apk it".
Status: **open** (recorded, not started) · **fixed (unconfirmed)** (in a build, not yet confirmed on the phone) · **confirmed** (Cam confirmed on the phone).

## Confirmed working on the phone (1.0)

- No ads and no suggested posts in the feed.
- Sound on automatically for a Reel opened from DMs.
- Scrolling (feed, messages, profiles) after an app restart — see B2.

## Batch 2 — open (reported against 1.0)

| # | Report | Likely cause (tentative) | Planned fix |
| --- | --- | --- | --- |
| B1 | Pinching lets the page zoom out smaller than the screen; it stays shrunk with a black border. | Zoom allowed down to 0.85×; when the pinch ended below 1× the release never reached the zoom handler, so it never snapped back. | Never allow below 1×; the zoom handler owns the whole gesture until the last finger lifts. |
| B2 | Scrolling stopped working everywhere (feed "stuck on one post", messages, profiles). Fixed by restarting the app. | Most likely B1: after that pinch the page received a broken touch sequence. Secondary suspect: the "installed web app" mode used to hide app banners. | Fix B1's gesture handling; consider dropping the installed-web-app mode. |
| B3 | Reel sent in a DM opens paused; have to press Play. (Sound was on.) | Instagram's DM viewer doesn't autoplay; SimpleGram never starts it. | Start the opened video once when the viewer appears, unless you paused it. |
| B4 | Home feed scroll is slow and clunky: wait for one post to load, then the next. | Each page Instagram sends is mostly ads/suggestions that get removed, leaving 1–2 real posts per load, so you keep hitting the loading spinner. | Load more ahead of time / ask for bigger pages; consider the Following feed (no suggestions) as the start page. |
| B5 | Search only shows accounts; no photo/Reel results. | Instagram's mobile site shows accounts in the search dropdown; posts/Reels live on a separate results page. | Search with choices: Accounts · Posts & Reels · Tags · Places (see R1). |
| B6 | One Story video wouldn't download (others did). | That Story's data wasn't in what SimpleGram had seen. | Backup lookup through the account's Stories; clearer error. |
| B7 | At the end of the feed, show older posts and/or Favorites. | — | "Older posts" (Following feed) and "Favorites" buttons at the end of the feed. |

## Requests

| # | Request | Notes |
| --- | --- | --- |
| R1 | Search: see accounts, photos/Reels, hashtags and places, or pick which. Places (and tags) with Most recent / Top toggle like old Instagram. | Decided: **tabs** (Accounts · Posts & Reels · Tags · Places), like Instagram. Recent depends on Instagram's website still serving it; verify when building. |
| R2 | Instants. | App-only (launched May 2026 in the app's DM inbox, needs the in-app camera); not on Instagram's website. Not possible in SimpleGram unless the website adds it. |
| R3 | Map (from the messages page). | App-only; not on Instagram's website. Same as R2. |
