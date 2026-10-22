# SimpleGram

Distraction-free Instagram for Android. Your friends' posts, Stories, Reels and
messages — without ads, suggested posts, reposts, the Reels tab or endless scrolling.

**Download:** [`dist/SimpleGram-1.2.apk`](dist/SimpleGram-1.2.apk) · Android 10 or newer.
It installs over an earlier version and keeps your login.

## What it does

| Kept | Removed |
| --- | --- |
| Posts from people you follow (and your own) | Ads and "Sponsored" posts, including Story ads |
| Stories, DMs, profiles, notifications, comments | "Suggested for you" posts and account carousels |
| Reels opened from a DM, Story, profile, post or search | Friends' reposts and posts surfaced because a friend liked/commented |
| Search: Accounts · Posts & Reels · Tags · Places | The Reels tab and the Explore suggestion grid |
| Instagram's own look, buttons and settings | Swiping from one Reel on to the next (go back and pick another) |
| | Instagram's all-suggestions feed after "You're all caught up": Home ends there |
| | Endless search results (3 "Show more" taps, then it stops) |
| | "Use the app" banners |

Extras:

- **Pinch to zoom** anything (up to 5×, never smaller than the screen) — photos, carousels,
  videos, Stories, Reels, DMs. One finger pans, double-tap or the chip at the top resets. A zoomed Story stays put
  (videos loop) until you let go of the zoom.
- **Download** the photo or video on screen from the ⋮ tab on the screen edge (drag it up,
  down or to the other side) (full resolution;
  carousels offer "this one" or "all"). Saved to `Downloads/SimpleGram`. If a Story's
  file wasn't loaded yet, SimpleGram looks it up from the account's Stories.
- **Comments in a half-screen panel** under the post, like the app — the video keeps playing.
- **Sound on** for Stories and opened Reels; your own mute is respected.
- **Opened videos play by themselves** (a Reel from a DM, an opened post or Reel), once,
  unless you already played or paused it.
- **Search with tabs** like the app: Accounts · Posts & Reels · Tags · Places. The tag you
  type is always offered ("#nba"). Places have Top / Most recent. A result opens behind a
  dimmed search screen, and Back returns to your search.
- **End of Home**: Home stops at Instagram's "You're all caught up". A card then offers
  **Following** and **Favorites** side by side (newest first). Opened from there, they skip
  posts you already saw in Home.
- **Screen stays on** while a video plays.
- **Following** (newest first) and **Favorites** feeds in the menu too (these show everything).
- **Clean screenshots**: hide the menu button and system bars, tap to bring them back.
- **Instagram links** from texts and other apps open in SimpleGram (menu → More → Open Instagram
  links…), or use Share → SimpleGram / "Open copied Instagram link".

## How it works

SimpleGram is a small Android app around Instagram's own mobile website, signed in
with your account (log in once; the session is kept). There is no server and nothing
is sent anywhere but Instagram.

The important difference from earlier attempts (QuietGram, FreeInstaGram): filtering
happens in the **data**, not on the screen. A script injected before Instagram's own
code removes ads, suggestions, reposts and Reel chains from the JSON that Instagram's
page downloads, so Instagram simply renders a feed that never contained them. Nothing
is hidden after it appears, which is what made the old feeds jump, swap posts and
snap carousels back. If Instagram ever changes its data format so that SimpleGram no
longer recognises posts, it leaves the feed alone instead of showing an empty one; a
cautious on-screen backup filter still hides posts labelled Sponsored/Ad/Suggested.
Suggestion units (Instagram's explore_story items) count as recognised, so a page made only
of suggestions is filtered, not left alone. Home ends at Instagram's caught-up marker, so
Instagram never switches to its all-suggestions pages.

Zoom is a native magnifier over the page — the page underneath is never resized, so
the feed position, carousel photo and video playback are untouched.

Menu → More → **Filter status** shows counts of what was removed, how search requests
went and how long Stories took to load. **Copy details** copies the counts and data shapes
(never names, captions or links) for a bug report.

| File | Role |
| --- | --- |
| `app/src/main/assets/simplegram.js` | Page script: data filter, media index for downloads, banner/Reels-tab tidy-up, comments hand-off, sound and autoplay, screen-awake, Reel swipe guard, search screen, end of Home |
| `app/src/main/java/.../MainActivity.java` | WebViews, menu, downloads, links, Back, screenshot mode, end-of-Home card |
| `app/src/main/java/.../ZoomFrame.java` | Pinch/pan magnifier, Story hold, comments split view |
| `app/src/main/java/.../CommentsPanel.java` | The half-screen comments sheet |
| `tests/*.test.cjs` | Browser tests for the page script (Chromium, fixture data); `helpers.cjs` holds the shared fixtures |

## Limits

- Tested against fixture data shaped like Instagram's (124 browser tests), checked against
  the code of Instagram's current website, and on an Android 10 emulator (9 native tests).
  It is not tested against a signed-in Instagram account, so your phone is the real test.
- Instagram's website, not the app: calls, music on Stories, and some posting features
  are as limited as they are on instagram.com in a phone browser.
- Saving to a specific collection works only as far as Instagram's website offers it.
- Hashtags: Instagram's website no longer has hashtag pages or Most recent for tags. A tag
  opens Instagram's results for "#tag" (top posts and Reels). Most recent is tried once and
  says so honestly when Instagram doesn't answer.
- Home loads the page size Instagram chooses. Most of each page is ads and suggestions,
  so SimpleGram loads ahead rather than bigger. Following is the faster feed.
- Home ends at "You're all caught up", so it can be short on quiet days; Following and
  Favorites continue from there.
- Instants and the Map in messages are app-only; Instagram's website doesn't have them.
- Some videos (protected or audio-separate streams) can't be downloaded; you'll get a message.
- Android decides which app opens instagram.com links; SimpleGram can't force it.

## Build

Requires JDK 17+ and the Android SDK (platform 35, build-tools 35.0.0).

```sh
echo "sdk.dir=/path/to/android-sdk" > local.properties
./gradlew assembleRelease        # → app/build/outputs/apk/release/app-release.apk
```

Tests (Node 18+ and Playwright's Chromium):

```sh
npm install playwright && npx playwright install chromium
node --test tests/*.test.cjs
```

On-device tests for the native shell (pinch zoom, comments split view, menu,
screenshot mode, Back, incoming links, end-of-Home card, edge tab) run on a phone or emulator:

```sh
./gradlew connectedDebugAndroidTest
```

Signing: release builds use `signing/simplegram.jks` with its passwords in
`signing/keystore.properties` (`storeFile`, `storePassword`, `keyAlias`, `keyPassword`).
Both are git-ignored and are never committed. A build signed with the same key installs
as an update over the previous one and keeps your Instagram login; a different key means
uninstalling first and logging in again. Without the files the build falls back to a
debug key.
