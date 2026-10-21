# SimpleGram

Distraction-free Instagram for Android. Your friends' posts, Stories, Reels and
messages — without ads, suggested posts, reposts, the Reels tab or endless scrolling.

**Download:** [`dist/SimpleGram-1.0.apk`](dist/SimpleGram-1.0.apk) · Android 10 or newer.

## What it does

| Kept | Removed |
| --- | --- |
| Posts from people you follow (and your own) | Ads and "Sponsored" posts, including Story ads |
| Stories, DMs, profiles, notifications, comments | "Suggested for you" posts and account carousels |
| Reels opened from a DM, Story, profile, post or search | Friends' reposts and posts surfaced because a friend liked/commented |
| Search for accounts, posts and Reels | The Reels tab and the Explore suggestion grid |
| Instagram's own look, buttons and settings | Swiping from one Reel on to the next (go back and pick another) |
| | Endless search results (a few pages, then it stops) |
| | "Use the app" banners |

Extras:

- **Pinch to zoom** anything (up to 5×) — photos, carousels, videos, Stories, Reels, DMs.
  One finger pans, double-tap or the chip at the top resets. A zoomed Story stays put
  (videos loop) until you let go of the zoom.
- **Download** the photo or video on screen from the ⋮ menu (full resolution;
  carousels offer "this one" or "all"). Saved to `Downloads/SimpleGram`.
- **Comments in a half-screen panel** under the post, like the app — the video keeps playing.
- **Sound on** for Stories and opened Reels; your own mute is respected.
- **Screen stays on** while a video plays.
- **Following** (newest first) and **Favorites** feeds in the menu.
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

Zoom is a native magnifier over the page — the page underneath is never resized, so
the feed position, carousel photo and video playback are untouched.

Menu → More → **Filter status** shows counts of what was removed (no names or post
details are stored).

| File | Role |
| --- | --- |
| `app/src/main/assets/simplegram.js` | Page script: data filter, media index for downloads, banner/Reels-tab tidy-up, comments hand-off, sound, screen-awake, Reel swipe guard, search position |
| `app/src/main/java/.../MainActivity.java` | WebViews, menu, downloads, links, Back, screenshot mode |
| `app/src/main/java/.../ZoomFrame.java` | Pinch/pan magnifier, Story hold, comments split view |
| `app/src/main/java/.../CommentsPanel.java` | The half-screen comments sheet |
| `tests/page.test.cjs` | Browser tests for the page script (Chromium, fixture data) |

## Limits

- Tested against fixture data shaped like Instagram's, not against a signed-in account
  (Instagram can't be reached from the build machine). Your phone is the real test.
- Instagram's website, not the app: calls, music on Stories, and some posting features
  are as limited as they are on instagram.com in a phone browser.
- Saving to a specific collection works only as far as Instagram's website offers it.
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
node --test tests/
```

Signing: release builds use `signing/simplegram.jks` with its passwords in
`signing/keystore.properties` (`storeFile`, `storePassword`, `keyAlias`, `keyPassword`).
Both are git-ignored and are never committed. A build signed with the same key installs
as an update over the previous one and keeps your Instagram login; a different key means
uninstalling first and logging in again. Without the files the build falls back to a
debug key.
