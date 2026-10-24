# Batch 6 → SimpleGram 1.5: the build plan

Cam's go-ahead: "fix everything and push out the next updated apk". Everything in
batch 6 of LEDGER.md ships except R14 (Cam's decision is still pending: keep the
R10 full screen clean). Where this file and a diagnosis note differ, this file
wins. Diagnoses: [B28](b28-diagnosis.md), [B33](b33-diagnosis.md), Copy details
[fields](details-1.4-b28.md); Data Saver findings land in `data-saver.md`.

Version: `versionCode 6`, `versionName '1.5'`.

## Rules for every change

- Instagram's look and behaviour stay; SimpleGram only takes what the item needs.
- No request to any Instagram/Meta host from the build machine or the tests.
- Copy details carries counts, shapes and kinds only: never names, captions,
  codes or URLs.
- Page script: wrap new listeners in `safe()`, no `touch-action` (B25: hold
  still with a blocking `touchmove`), no new top-level name that already exists
  (tests/structure.test.cjs fails on duplicates), comments in the file's voice.
- Native: the signing key files are git-ignored and never committed; nothing new
  that needs a permission; strings in Cam's register (short, plain).
- Every item gets tests: Playwright for page behaviour (tests/*.test.cjs, run
  only the files you touch while developing; the full suite runs at release),
  ShellTest/B25Test/B28Test for the app. Mocks model Instagram from its public
  code (see tests/r10.test.cjs, tests/ig-feed-mock.js) and the research notes.

## Streams

Three worktrees. B and C both edit simplegram.js in different regions; keep
each change local to its region and add new functions near their callers.

### Stream A: native (MainActivity, ZoomFrame, tests/androidTest)

**B26: the Android buttons never go.**
- `setSystemBarsHidden(hidden)` hides only the status bar: API 30+
  `hide(WindowInsets.Type.statusBars())`; below 30 only
  `SYSTEM_UI_FLAG_FULLSCREEN` (no `HIDE_NAVIGATION`, no `IMMERSIVE*`). Keep
  `BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE` for the status bar.
- This covers every caller: full-screen video (R8/R10), R9's Reel layer,
  Instagram's own full screens (Stories), and "Hide controls for screenshot".
  The navigation bar stays in all of them.
- The custom view and the page's lifted video must end above the buttons:
  check that the window's content area excludes the navigation bar when it is
  shown (the app opts out of edge-to-edge; `guardEdgeToEdge` pads root when a
  device forces it). Nothing may draw under the buttons.
- Test (ShellTest): with a custom view shown, the decor's system-UI flags
  don't include `HIDE_NAVIGATION`; on API 30+ `getRootWindowInsets()
  .isVisible(navigationBars())` is true; the custom view's bottom edge is above
  the navigation inset. Same in screenshot mode.

**B27: a dead zone around the ⋮ tab.**
- The page needs to know where the tab is. App → page message `menuTab`
  `{on, side: 'left'|'right', yFrac, hFrac}` (tab top and height as fractions
  of root height), sent after `placeMenuButton()` lays it out, after a drag
  ends, when the tab is hidden or shown (`on`), and on the page's `ready`.
- The page (stream B owns the page side; the message name and shape are fixed
  here) refuses R10's one-tap full screen and R8's swipe arm for a trusted
  touch that lands in the zone: 56 CSS px from the tab's edge, from
  `(yFrac·innerHeight − 24)` to `((yFrac + hFrac)·innerHeight + 24)`. The
  synthetic tap from ⋮ → Full-screen video is never refused.
- Native: a `TouchDelegate` on root extends the tab's hit area 8 dp inward and
  8 dp above and below (the tab stays 16 dp wide visually; Instagram's own
  edge icons start about 16 dp in). Keep `setSystemGestureExclusionRects`
  covering the extended rect. Reverse it if ShellTest's drag tests break.
- Test (ShellTest): `menuTab` arrives with the right fractions after a drag;
  a tap 4 dp inside the tab's inner edge opens the menu.

**B33: Instagram didn't start (native half; stream C does the page half).**
Read `b33-diagnosis.md` ("Fix plan" and the reviewers' risks) and
`data-saver.md` first. Interface with the page:
- page → app `boot` `{token, ms, how}` (`how`: `removed` | `hidden` | `none`),
  `bootStuck` `{token, rule, record}`, `bootRecord` `{token, record}` (pushed
  by the page at 10 s and 30 s while the logo is up). `token` is the page's own
  per-document id (a random string made at document start).
- app: on each main-frame `onPageStarted` on an Instagram host, arm a watch
  bound to that WebView instance and a native sequence number, with a clock
  that only runs while the Activity is resumed. Disarm on `boot`, on a start on
  a non-Instagram host, on destroy/rebuild. At 30 s of foreground time with no
  `boot` and no `bootStuck`, probe with `evaluateJavascript` (works without the
  page script: logo present and displayed, `readyState`, `typeof require`,
  `__d` stub length, `location.href`); no answer within 2 s twice → "busy",
  record it, offer Try again, no reload.
- Recovery ladder (record each step in prefs before it runs):
  1. one automatic `web.reload()` per document chain, never while a dialog,
     full screen, screenshot mode, comments or a focused field is up, at most
     2 per 10 minutes per process (persisted). If no `onPageStarted` follows in
     3 s, `loadUrl` of the address from `onPageStarted` (not `loadMain`, which
     closes comments). Offline (no validated network): no reload; a chip
     "No connection. SimpleGram will reload when you're back online", then one
     reload when a `NetworkCallback` reports a validated, unblocked network.
  2. still stuck: chip "Instagram didn't start" with **Try again** (a rebuild
     via `swapWebView` using `loadUrl`, not `restoreState`) and **Details**
     (Copy details that works from the app alone).
  3. still stuck: same chip, "Still not starting. Check your connection, then
     Try again." plus a third button **Load without filters** that loads once
     with SimpleGram's data hooks off (a per-document flag in `__sgCfg`, e.g.
     `plainBoot: true`, which the page script honours by skipping its
     JSON.parse/fetch/XHR data hooks and its boot-time DOM rules; the bridge and
     diagnostics stay). Recorded, and shown in Copy details.
  Never clear cookies or the HTTP cache. The new chip replaces the B25 stuck
  chip's slot (one chip at a time).
- Diagnostics in prefs (survive a rebuild; shapes and counts only):
  `bootLog` ring of 10 page starts (how it began: cold, restore, rebuild
  restore/loadUrl, menu, Refresh, auto-reload, Back, page-initiated; clock;
  outcome: booted in N ms / stuck rule / left), `lastStuck` (the page's record
  or the native probe), `netErrors` ring of 20 from new `onReceivedError`,
  `onReceivedHttpError` and `onReceivedSslError` overrides (ms since page
  start, main frame or not, host kind: www / static / scontent / other,
  resource kind by extension, error code; keep the default cancel on SSL
  errors), `lifecycle` ring of 20 pause/resume/stop/start/trim events with
  times (UI_HIDDEN included; the restore in `onCreate` counted as a start),
  `rebuildLog` of 5 (why: manual Fix scrolling / Try again; state when chosen:
  route kind, logo up, full-screen view up, chip up; whether the old page
  answered and in how many ms), `reloadLog` of 10, `network` (transport, metered,
  validated, `getRestrictBackgroundStatus`, blocked-status changes with times).
- Copy details opens even when the page doesn't answer: after 1 s without a
  `status` reply, show the device-only details.
- Fix scrolling copies the old page's boot record (`window.__sg.bootRecord()`)
  along with its search state before destroying it, and logs the rebuild.
- Data Saver and the background block: follow `data-saver.md` "Design for 1.5" (it refines this section: the `ACCESS_NETWORK_STATE` permission, `NetWatch`, `whenNetReady` gating, hurt page tokens, recovery on unblock, the watchdog clock counting only resumed and unblocked time, the one-time tip, `netErrors` keys, the `net` block of Copy details).
- Tests (ShellTest): a local page whose `#splash-screen` never goes → the
  watch fires (timings shortened through a static test knob), one reload,
  then the chip; `netErrors` records a 503 from a local URL; Copy details
  without a page answer; the rebuild log entry.

### Stream B: page script, full screen (simplegram.js lines ~4350–5120, 5590–5900, 6190–6320; the R12 layer ~5270–5420)

**B28 + B31: the full-screen video stays the one playing.**
1. *Scroll hold (the core).* In page mode, from `enterR8` until the exit
   branch of `fullscreenchange`: remember the scrolling element's `scrollTop`
   at the request. A capture `scroll` listener restores it **synchronously
   inside the event** (scroll events run before IntersectionObserver updates
   in the same frame) whenever it moved by more than 1 px and the move wasn't
   SimpleGram's own; also check at landing, on `resize`, and in the 150 ms
   check. Off before the exit is processed, so WebView's own restore on exit
   finds the page where it left it. While a full screen is up, SimpleGram's
   own Home nudges and jiggles don't run. Count `fvStats.scrollHeld` and the
   largest move held.
2. *Only the full-screen video plays.* While `fullVideoOn()` in page mode: a
   capture `play` listener pauses any other `<video>` that starts (not
   `data-sg-own`), counting `othersPaused`. If the full-screen video is paused
   by anyone but SimpleGram's own tap (track `fullUserPaused` in `togglePlay`),
   play it again, at most 6 times per full screen (`replays`, `replaysGaveUp`).
3. *R10 takes the tap.* Instagram must not run its single-tap action (the
   feed-wide sound toggle, or pause on a Reel) when a tap opens full screen,
   and its double tap must still like. In the capture `click` listener, when
   `r10Video` matches a trusted tap: `stopImmediatePropagation` and
   `preventDefault` the click and arm the 300 ms wait as now. If a second touch
   comes within the window at the same spot (a double tap), dispatch one
   synthetic `click` on the original target just before the real second click
   is let through, so Instagram sees click, click (its timer arms and clears,
   its touch-counted double tap likes). If no second touch comes, full screen
   opens and Instagram never sees the click. Instagram's own icons on the video
   keep their taps as now (`videoControl`).
4. *Sound without touching Instagram's feed setting.* For R10/R8's full-screen
   video set `muted = false` on the element directly; never press Instagram's
   audio control for it. If Instagram re-mutes it while full screen is up
   (its product-initiated effect runs on every paused change), set it back
   (budget 8, count `remuted`). On exit, put the element's `muted` back to the
   snapshot value directly. Stories/Reels/DM sound rules are unchanged.
5. *What you did in full screen is kept.* `restoreAfterFull`: `muted` back to
   the snapshot; the play state is left as it is when the user paused in full
   screen (`fullUserPaused`); otherwise, if it was playing before the tap and
   is paused now, play it. Count `r10KeptPaused`.
6. *A lifted video that stops showing.* In `syncPageBar`'s check: not
   connected, or no longer `:popover-open`, or `display:none`, or a rect under
   40×40 → `leaveFullScreen` with why `gone` / `unlifted` / `hidden`.
7. *B27's page side.* Keep `menuTab` from the app (shape in stream A); refuse
   R10's tap and R8's arm in the zone for trusted touches; count
   `r10DeadZone`. Clear it on `on:false`.
8. *Diagnostics.* `leaveFullScreen` passes its `why` and the app keeps it
   (stream A logs it; the page also counts `exitsBy[why]`). `fsPage` entries
   add `y` (scrollTop), `vh` (innerHeight), `t` (seconds since page start),
   `playing` (how many videos play, whether the full-screen one does, whether
   any other is unmuted). Every 250 ms while full screen is up, note whether
   the full-screen video presents new frames (`requestVideoFrameCallback`
   count) → `framesStalled` when the clock runs but frames don't.
- Tests (tests/r10.test.cjs or a new tests/b28.test.cjs): the fixture gets a
  three-post feed with an Instagram-like player (see
  app/src/androidTest/assets/b28/feed.html: IntersectionObserver on the media
  box, one video at a time, feed-wide sound, pause on <25%, re-pause on a
  paused change) and a simulated WebView reset (`scrollTo(0,0)` 16 ms after
  `fullscreenchange`, restore 30 ms after exit). Expect: scroll within 2 px of
  the entry value during full screen; the tapped video the only one playing and
  the only one unmuted; no play of the others; a pause in full screen kept after
  Back; Instagram's single tap never runs on an R10 tap; a double tap still
  likes and opens nothing; the dead zone refuses; `unlifted` exits.
- Also port `B28Probe` into a real `B28Test` (assume popovers; it passes on the
  emulator only with the WebView 158 bind mount described in b28-diagnosis.md).

**B29: a Story Reel's swipe up opens the comments.** In the R12 layer's
`touchend` handlers (the host and `rb.box`): a mostly vertical swipe **up** of
≥ `FV_SWIPE` opens the comments exactly as the Comment button does (same
function; if comments are off for that Reel, do nothing); a swipe **down**
returns to the Story as now. Back and the caption's own scrolling are
unchanged. Count `reelInfo.swipeComments`. Test in tests/r12.test.cjs.

**B30: the comment icon.** `R12_ICONS.comment`: the arc's sweep flag is wrong
(centre lands at 25.3, 24.8, outside the icon). Use
`M20.7 16.8A9.2 9.2 0 1 0 17.2 20.4L21.8 21.9Z` (centre 12.6, 12.4): a full
bubble with the tail at the bottom right. Test: the rendered `<path>`'s bbox
spans most of the 24-unit box (width and height > 16).

### Stream C: page script, feed and boot (simplegram.js lines ~1–1100, 1800–2550, 3700–3950, 8400–8600)

**B32: Home carries on into Following without Instagram's line.** Today the
continuation starts only at Instagram's `end_of_feed_demarcator` (`contArm`
from the marker handling). New: with the continuation on, on Home, when a page
brings no friends' posts and Instagram has moved on to suggestions
(`pagination_source === 'feed_recs'`), or the second page in a row brings
none (today's `emptyStreak` reaches 2, not 4), arm the continuation as at the
marker: `fs.caughtUp = true`, `fs.cont = true`, paging stays on, Following
posts are swapped into the next pages as R7 does. Without a marker there is no
line from Instagram, so SimpleGram draws its own thin "You're all caught up ·
Following, newest first" line above the first Following post (a SimpleGram
element inserted when that post is drawn; same look as today's). `cont.headWhy
.noLine++`, `cont.startVia = 'marker' | 'noLine'`. The end card and B22's
notes behave as today. Tests in tests/cont-*.test.cjs: a Home that never
sends a marker and turns to `feed_recs` → continuation runs, line drawn once,
no card; a Home with the marker is unchanged.

**B33: the page half.** Read `b33-diagnosis.md` ("Fix plan", the detection
rules and the reviewers' risks). At document start, before Instagram's
scripts, for role `main` only:
- make a per-document `token`; capture the native `setTimeout`,
  `requestAnimationFrame` and `MutationObserver` first (Instagram swaps the
  window timers);
- capture-phase `error`/`load` on `SCRIPT`/`LINK` whose URL is on Instagram's
  static host (`rsrc.php`), keeping hash, time, visible/hidden;
- watch `body` for `#splash-screen` removal or `display:none` → post `boot`
  `{token, ms, how}` once; `DOMContentLoaded` with no `#splash-screen` ever →
  `how: 'none'`;
- stuck rules (visible, online time only): (a) a boot script errored and the
  logo is still up 3 s later with no retry of that hash in flight and no
  pending boot script; (b) `DOMContentLoaded` fired, Instagram's end marker
  (`#has-finished-comet-page`) is missing and the logo is up 3 s later; (c)
  no progress for 10 s after 20 s of logo (progress: new `script[data-sjs]`,
  processed count change, a resource entry completing, `readyState` change,
  an in-flight fetch/XHR from the existing hooks); (d) 60 s of logo with no
  progress in the last 15 s. Post `bootStuck` `{token, rule, record}` once;
- `bootRecord` posted at 10 s and 30 s of logo, and `window.__sg.bootRecord()`
  for the app's rebuild. The record: rule, logo state, `readyState`,
  `DOMContentLoaded` yes/no, `typeof require`, `__d`/`requireLazy` stub lengths,
  `script[data-sjs]` total and processed, last payload length vs its
  `data-content-len`, end marker present, boot scripts (count, errored,
  loaded, pending), resource entries for `rsrc.php` (count, failed, longest
  ms), window errors and unhandled rejections (count; first 3 as kind, host
  kind, line), `navigator.onLine`, visible time, SimpleGram's own part (hooks
  on, payloads counted, errors, how many boot payloads `cleanse` changed and
  which rule keys fired, whether the continuation touched `require` during a
  parse), how the logo went on every normal boot (`removed` / `hidden`, ms;
  this shows how Cam's signed-in Home starts);
- `plainBoot` (set by the app in `__sgCfg` for one load): skip the
  JSON.parse/fetch/XHR data hooks and the boot-time DOM rules; keep the bridge,
  route messages and diagnostics; report `plainBoot: true` in status.
- Close the latent risks: `cleanse`'s feed rules (`^ads$`, `AD_LIST_KEY`,
  `dropAds`) apply only to feed-shaped payloads (an api/v1 feed response, or a
  `__bbox.result.data` subtree), never to Instagram's module configuration;
  the continuation's module check runs outside Instagram's `JSON.parse` (a
  microtask after the first Home payload, cached; inside `contArm` use the
  cache and fall back to today's call only if it never ran); the XHR
  `response` getter returns the same cleansed object for repeated reads
  (WeakMap keyed by the XHR). Existing feed tests must still pass.
- Tests (new tests/boot.test.cjs): the saved logged-out Home HTML shape with
  a never-removed `#splash-screen` and one aborted boot script → rule (a) and
  the record; a cut-off document → rule (b); a slow drip that boots in 30 s →
  no `bootStuck`; hidden page → clock paused; no-splash page → `how: 'none'`;
  `plainBoot` leaves payloads untouched; the latent-risk fixes.

## Release (after the streams merge)

Full Playwright suite (`NODE_PATH=/opt/node-tools/node_modules node --test
tests/*.test.cjs`, in the background, over 10 minutes); debug build; emulator
`sg29` with the WebView 158 bind mount (b28-diagnosis.md "Reproducing it";
never run the emulator alongside Gradle; `./gradlew --stop` first):
ShellTest, B25Test, B28Test; then the signed release build, `dist/
SimpleGram-1.5.apk`, README, LEDGER ("fixed (unconfirmed) in 1.5"),
`notes/batch-6/phone-checks-1.5.md`.
