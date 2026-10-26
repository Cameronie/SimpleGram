# SimpleGram

Distraction-free Instagram for Android. Your friends' posts, Stories, Reels and
messages — without ads, suggested posts, reposts, the Reels tab or endless scrolling.

**Download:** [`dist/SimpleGram-1.5.apk`](dist/SimpleGram-1.5.apk) · Android 10 or newer.
It installs over an earlier version and keeps your login.

## What it does

| Kept | Removed |
| --- | --- |
| Posts from people you follow (and your own) | Ads and "Sponsored" posts, including Story ads |
| Stories, DMs, profiles, notifications, comments | "Suggested for you" posts and account carousels |
| Reels opened from a DM, Story, profile, post or search | Friends' reposts and posts surfaced because a friend liked/commented |
| Search: Accounts · Posts & Reels · Tags · Places | The Reels tab and the Explore suggestion grid |
| Instagram's own look, buttons and settings | Swiping from one Reel on to the next, including the suggested Reels after one sent in a DM |
| | Instagram's all-suggestions feed after "You're all caught up": Home carries on with posts from people you follow instead |
| | Endless scrolling in search (results load about 24 at a time, only when you tap "Show more") |
| | "Use the app" banners |

Extras:

- **Pinch to zoom** anything (up to 5×, never smaller than the screen) — photos, carousels,
  videos, Stories, Reels, DMs. One finger pans, double-tap or the chip at the top resets. A zoomed Story stays put
  (videos loop) until you let go of the zoom.
- **Download** the photo or video on screen from the ⋮ tab on the screen edge (drag it up,
  down or to the other side) (full resolution;
  carousels offer "this one" or "all"). Saved to `Downloads/SimpleGram`. If a Story's
  file wasn't loaded yet, SimpleGram looks it up from the account's Stories.
- **Comments in a half-screen panel** under the post, like the app — the video keeps playing. The comment box stays one line high until you type.
- **Sound on** for Stories and opened Reels; your own mute is respected.
- **Opened videos play by themselves** (a Reel from a DM, an opened post or Reel), once,
  unless you already played or paused it.
- **Search with tabs** like the app: Accounts · Posts & Reels · Tags · Places. The tag you
  type is always offered ("#nba"). Places have Top / Most recent. A result opens behind a
  dimmed search screen, and Back returns to your search. Show more has no limit and loads
  about 24 posts a tap; nothing loads without a tap.
- **Home goes on into Following**: after Instagram's "You're all caught up", Home carries on
  with posts from people you follow, newest first, with no repeats, under a thin
  "You're all caught up · Following, newest first" line. After about 200 posts, or if anything
  goes wrong, a card offers **Following** (skipping posts you already saw in Home). It also starts
  when Home simply runs out of friends' posts without Instagram's line. Switch it
  off in ⋮ → More… → Continue Home into Following; Home then ends at "caught up" with the card.
- **Home tab scrolls first**: tapping Instagram's Home tab while you're down the feed takes you
  to the top and keeps everything; a tap at the top refreshes, like the app.
- **Favorites star** in the bottom bar, next to Home. It opens Favorites; on Favorites it scrolls
  to the top, and at the top refreshes. Going back to Home from Favorites loads Home fresh.
- **Full-screen video**: one tap on a video in the feed or an opened post shows it alone on the
  whole screen, with sound (a double tap still likes; the tap doesn't change the feed's sound
  setting). In an opened post a swipe down at the top does the same, and ⋮ → Full-screen video
  works for the video on screen. Swipe up or down, or Back, to return; tap to pause, and a pause
  is kept when you go back. Only that video plays while it's up. The Android buttons stay on
  screen (only the status bar hides), and a tap near the ⋮ tab never opens full screen.
- **Progress bar** like the app's Reels: drag it or tap a point to rewind or skip, in full screen,
  in an opened post, in a Reel sent in a DM and on a Story's Reel.
- **Story Reels**: on a Story that shares a Reel, swipe up to watch the Reel full screen with its
  account, caption, counts, like, save, comments and share; the Story waits. Swipe up again for
  the comments; swipe down or Back to return.
- **Self-repair**: if scrolling ever stops working, a "Scrolling stopped. Tap to fix" button (or
  ⋮ → Fix scrolling) rebuilds the page view in place. If Instagram's logo screen stays up (a
  start-up file lost while you switched apps, for instance), SimpleGram reloads once by itself,
  waits for the network if you're offline, and otherwise offers "Try again"; Copy details works
  even then. A one-time tip explains Data Saver if it's cutting SimpleGram off.
- **Screen stays on** while a video plays.
- **Following** (newest first) and **Favorites** feeds in the menu too (these show everything).
- **Clean screenshots**: hide the menu button and the status bar, tap to bring them back.
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
of suggestions is filtered, not left alone. At Instagram's caught-up marker, SimpleGram reads
Following itself and puts those posts in place of the suggestions in Instagram's next Home
pages, in the data, so Instagram appends them like any Home post. A feed is never handed an
empty first page (Instagram would show its empty-feed screen and stop loading).

Zoom is a native magnifier over the page — the page underneath is never resized, so
the feed position, carousel photo and video playback are untouched.

Menu → More → **Filter status** shows counts of what was removed, how search requests
went, how long Stories took to load and to swipe, and how Home's continuation went.
**Copy details** copies the counts and data shapes (never names, captions or links) for a
bug report, including a short trail of the last feed pages that survives a restart.

| File | Role |
| --- | --- |
| `app/src/main/assets/simplegram.js` | Page script: data filter, media index for downloads, banner/Reels-tab tidy-up, comments hand-off, sound and autoplay, screen-awake, Reel swipe guard, full-screen video, search screen, end of Home and its continuation into Following, Favorites star |
| `app/src/main/java/.../MainActivity.java` | WebViews, menu, downloads, links, Back, screenshot mode, full-screen views, end-of-Home card and skip note |
| `app/src/main/java/.../ZoomFrame.java` | Pinch/pan magnifier, Story hold, comments split view |
| `app/src/main/java/.../CommentsPanel.java` | The half-screen comments sheet |
| `tests/*.test.cjs` | Browser tests for the page script (Chromium, fixture data); `helpers.cjs` holds the shared fixtures |

## Limits

- Tested against fixture data shaped like Instagram's (510 browser tests), checked against
  the code of Instagram's current website, and on an Android 10 emulator running a current Android WebView (58 native tests; `tools/emu-webview.py` mounts the WebView).
  It is not tested against a signed-in Instagram account, so your phone is the real test.
- Instagram's website, not the app: calls, music on Stories, and some posting features
  are as limited as they are on instagram.com in a phone browser.
- Saving to a specific collection works only as far as Instagram's website offers it.
- Hashtags: Instagram's website no longer has hashtag pages or Most recent for tags. A tag
  opens Instagram's results for "#tag" (top posts and Reels). Most recent is tried once and
  says so honestly when Instagram doesn't answer.
- Home loads the page size Instagram chooses. Most of each page is ads and suggestions,
  so SimpleGram loads ahead rather than bigger. Following is the faster feed.
- Home's continuation into Following stops after about 200 posts in one visit; the Following
  page continues from there.
- Coming back to Home from Favorites starts Home at the top (it loads fresh).
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
screenshot mode, Back, incoming links, end-of-Home card and skip note, full-screen views,
edge tab) run on a phone or emulator:

```sh
./gradlew connectedDebugAndroidTest
```

Signing: release builds use `signing/simplegram.jks` with its passwords in
`signing/keystore.properties` (`storeFile`, `storePassword`, `keyAlias`, `keyPassword`).
Both are git-ignored and are never committed. A build signed with the same key installs
as an update over the previous one and keeps your Instagram login; a different key means
uninstalling first and logging in again. Without the files the release APK is left
unsigned, so it can't be installed by mistake with the wrong key.
