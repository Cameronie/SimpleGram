# B25: scrolling stopped everywhere until restart (diagnosis and plan for 1.4)

## Ledger summary (plain language)

**What happened.** SimpleGram 1.3 added R8: swipe down on a video for full screen, swipe again to leave. When a swipe asks to leave full screen, the page tells WebView to do it. WebView then switches its touch input from the full-screen view back to the normal page view. If Cam's next finger is already on the screen at that moment, the rest of that touch is thrown away. That is easy to do on a busy page, where the swipe's "leave" can run half a second late. Chromium sees the finger go down but never sees it lift, so it thinks a finger is still on the page from then on.

Nothing looks wrong at first. Scrolling keeps working, which is why Cam could still scroll the first place grid. The damage shows the first time he touches any of Instagram's surfaces that don't allow vertical panning, such as a sheet, a slider or a dialog. Because Chromium believes the old finger is still down, it never clears that "no vertical panning" setting. After that, no scroll works on any page, including SimpleGram's own search screen. Taps still work. Refresh, a new page and putting the app in the background don't help. Only a new WebView fixes it, and restarting the app gives you one.

**How sure.** Fairly sure, roughly 3 in 4. The whole chain was reproduced on an emulator using SimpleGram 1.3's own R8 code and MainActivity:

- taps worked and nothing scrolled, on the page and in an inner scroller like the search screen;
- reload, a new document and background/foreground did not fix it.

It also explains why B25 is new in 1.3: R8 is the first feature that leaves full screen from inside the page while fingers are busy. Leaving with Back was tested and is safe.

What is not proven:

- That this exact thing happened on Cam's phone. The details can't show a lost touch.
- The emulator runs WebView 74, while Cam has 155. The 155 sources do the input switch in the same order and keep the same counter.
- Which touch was lost, and which element turned panning off.

**Fix in 1.4.**

1. When full screen starts or ends while a finger is down, the app sends Chromium the missing "touch cancelled" itself.
2. R8 leaves full screen the same way Back does (safe), not by asking the page to do it.
3. If drags stop scrolling anyway, SimpleGram notices and offers a one-tap "Scrolling stopped. Tap to fix", which rebuilds the WebView. A matching ⋮ item, Fix scrolling, is always available.
4. Copy details gains a touch/full-screen block that would name the cause directly next time.

---

## 1. Verdict on the candidates

| Candidate | Verdict | Why |
|---|---|---|
| **A page-initiated full-screen exit while a finger is down loses that touch's end. Chromium's `TouchActionFilter` touch count then stays at 1 or more, `allowed_touch_action_` is never reset, and the first touch on an element without pan-y removes vertical panning for the WebView's lifetime.** | **Best fit. Reproduced (y1, y2, y3, r3).** | It is the only mechanism that matches every symptom: taps work; scrolling dies on the document scroller *and* inside overflow scrollers (the search overlay's shadow-root `.body`); it survives SPA navigation, reload, a new document and a background trip; restart fixes it. It explains why it shows up late. It explains why this is new in 1.3, because R8 exits through `exitFullscreen()` from a `touchend` (simplegram.js:3299, 3368). It has the same shape as B2. |
| Enter-side straddle (a finger down when `onShowCustomView` swaps the WebView to `NullAwViewMethods`) | Possible on 155, not seen on 74 | On 74, starting full screen cancelled the touch cleanly (x1, x2: tc 1). The 155 `enterFullScreen` (AwContents.java:643-656) still swaps before `onShowCustomView`. Whether 155 still sends that cancel is unknown. The fix covers it anyway. |
| ZoomFrame stuck (zoomed with the chip hidden, `owned`, split view) | Ruled out | A zoomed `owned` gesture eats taps too (ZoomFrame.java:99-104). Split view eats everything outside the top 42%. The screenshot shows Home at 1x with the bottom bar usable. |
| Story hold / `releaseHold` across a full screen | Unlikely | h0 and h1 were balanced on the emulator. Starting full screen cancelled the held touch. Stories never went full screen this session: the Story at t=845 s did not change `fullScreenLast`. |
| Page CSS (`overflow:hidden`, `touch-action` on html/body) | Ruled out | Playwright: blocks Home but not the overlay scroller. Cam lost both. |
| SimpleGram's `guardMove` / R8 left armed | Ruled out | `guardMove` is never registered on Home, and `g.exit` needs a live full screen. |
| Instagram's document `touchmove` preventDefault (IGCoreSheet drag ref never cleared) | Unlikely | It would block both scrollers with taps still working, but an armed sheet follows the finger and the screenshot shows clean Home. Instagram unmounts it on route change. The new diagnostics settle it (`preventedOther`). |
| Search grid size, `thumbWatcher`, memory | Ruled out | 843-cell grids, a re-search mid-drag and closing search all left scrolling working in Playwright. The memory warnings all come before the break. |

**Corrections to the investigators' timelines.**

- **What `grid.taps` counts.** `searchData.grid.taps` counts `fillGrid` calls (grid opens plus Show more taps; simplegram.js:5097), not taps on grid cells. So 17 calls, 16 pages, `failed` 0 and `chained` 0 means one load was abandoned: the grid changed or closed before the page arrived.
- **Grid B's scroll after 19:36 is not established.** Grid B (24 then 63) reached a Show more button, which takes about 400 px of scrolling. That proves scrolling worked during grid B, but nothing in the details timestamps grid B against the 19:36 full screen. The latent theory fits either order: the leak happens at or before 19:36, and the break happens at the first touch without pan-y after it.
- **The last full screen.** `fullScreenLast` "reel at 19:36" lines up only with the 4-second Reel visit at t=527.1→531.1 s (page start ≈ 19:27:30–19:28:10). The 30 s Reel visit at 716 s is about 19:40, and no full screen happened there.

**The unmatched 5th full screen (a VIDEO on a reel page, not counted by R8).** Not resolved.

- Rotate-to-fullscreen is ruled out: `media_controls_rotate_to_fullscreen_delegate.cc:192` returns unless `ShouldShowControls()`, and Instagram's videos have no controls.
- Stories are ruled out (they would report `body`).
- Two candidates remain:
  - **(a) R8's own accounting race.** Confirmed possible in Playwright, not hit on the emulator (r2). A late exit `fullscreenchange` clears `r8El` after a quick re-swipe has already called `enterR8`.
  - **(b) Instagram's player full-screen button** (`CometFullScreen.requestFullScreen(n)` in b317). It is unclear whether `n` is the `<video>` or a wrapper.
- It matters only as evidence. A 4-second Reel visit with a full screen in it points to quick back-to-back swipes around a full-screen switch, which is exactly the rhythm that causes the leak. The diagnostics below name it next time.

**One aggravating factor for 1.4.** R10 (one tap opens full screen, a swipe up or down leaves it, on Home too) would add many more page-initiated exits. R11 (a scrub bar) would add a likely `touch-action:none` surface that turns a latent leak into a break. Both must land *after* fix 1a/1b below.

## 2. Mechanism in detail (what the plan relies on)

1. **The swap happens before the app hears about it.**
   - On exit, `AwWebContentsDelegateAdapter.exitFullscreen()` calls `mAwContents.exitFullScreen()` first. That puts `NullAwViewMethods` on the `FullScreenView` (AwContents.java:658-673; `NullAwViewMethods.onTouchEvent` returns false).
   - Only then does it call `onHideCustomView()` (MainActivity.java:513). `root.removeView(customView)` then sends its `ACTION_CANCEL` to the now-inert `FullScreenView`, so the cancel is lost.
   - Back is safe. `onBackPressed` → `new Chrome().onHideCustomView()` (MainActivity.java:1682) removes the view *before* `onCustomViewHidden()` asks Chromium to exit, so the cancel reaches live input (b1: tc 1).
2. **The count never comes back down.**
   - `InputRouterImpl::OnTouchEventAck` (input_router_impl.cc:516/525-526) increments the count on a sequence-start ack and decrements it on a sequence-end ack.
   - `ReportAndResetTouchAction` resets only at a count of 0 or below (touch_action_filter.cc ~347).
   - `OnSetTouchAction` ANDs each new touch's touch-action into the allowed set, so the set can only shrink.
   - `GestureProvider` accepts a new DOWN without cancelling the orphaned sequence. A lone CANCEL later is dropped because there is no current down event.
   - Only `ResetGestureDetection()` repairs it, and only before the next touch. Navigation calls it (y4/r1: a new document before the next touch clears the latent state). Once another touch has replaced the down event, nothing short of a new RenderWidgetHost (a new WebView) clears it (y1 F/G/H, r3 G).
3. **Why it is latent.** Elements whose touch-action includes pan-y (auto, manipulation, pan-y) do nothing harmful. The first `none` or `pan-x` element (y1/y2) removes pan-y for good.

## 3. Plan for 1.4

### 3.1 Root-cause fixes

**1a. Native: never let a full-screen swap split a touch (MainActivity).**

- Override `Activity.dispatchTouchEvent`. Track `touchOpen` (DOWN until UP/CANCEL), keep a copy of the last event, and record which side got the DOWN (`web` or `custom`).
- **`onShowCustomView`:** if `touchOpen` and the DOWN went to the page, build an `ACTION_CANCEL` from the last event with all its pointers. Dispatch it straight to the `FullScreenView`, `((ViewGroup) view).getChildAt(0).dispatchTouchEvent(cancel)`, which now holds the live `AwViewMethodsImpl`. Then swallow the rest of that gesture at Activity level until UP/CANCEL.
- **`onHideCustomView`:** if `touchOpen` and the DOWN went to the custom view:
  - after `root.removeView(customView)`, call `web.dispatchTouchEvent(cancel)`, because the WebView has its live methods back once Chromium has swapped;
  - before the removal, also send it to the `FullScreenView` child, which covers the Back path where that child is still live;
  - swallow the rest of the gesture.
  
  Extra cancels are harmless: the count only goes to 0 or below, and `GestureProvider` drops a CANCEL that has no current down event.
- Same treatment for a held finger: if `zoom.isHolding()` at show or hide, send the hold's CANCEL to whichever view is live. `releaseHold` should dispatch to `page().dispatchTouchEvent` directly, not through the FrameLayout's touch target.
- Never call the custom-view path with a fake view in tests to check this (s1): it does not reproduce the bug. Tests must use real `requestFullscreen` / `exitFullscreen`.

**1b. Page: R8 leaves full screen the Back way.**

- `exitFullVideo('swipe')` (simplegram.js:3368) posts `fullVideoExitRequest` to the app.
- The app runs the same code as Back (`new Chrome().onHideCustomView()`): remove the view first, then `onCustomViewHidden()` → `requestExitFullscreen()`.
- Fall back to `document.exitFullscreen()` only when the bridge is missing.
- R10's swipe exits must use the same route.

**1c. Page: R8 bookkeeping race.**

- In `touchstart`, if `r8On && !document.fullscreenElement` (an exit still settling), set no gesture.
- Add `r8Pending`: set in `enterR8`, cleared on grant or failure. In the `fullscreenchange` else-branch (simplegram.js:3389), don't clear `r8El` while a request is pending.
- Adopt any `<video>` full screen on post/reel that R8 isn't tracking: set `r8El`/`r8On`/`data-sg-full` and count `r8Adopted`. A swipe then leaves it and Chrome's native controls stay hidden.

**1d. Defence in depth.**

- SimpleGram's own surfaces (R11's bar, R9's `#sg-reel`, simplegram.js:3416) should block scrolling with a non-passive `touchmove` `preventDefault`, not with `touch-action:none`/`pan-x`. A prevented `touchmove` does not feed the persistent filter.
- Optional: ignore an R8 `touchend` whose `e.timeStamp` is more than 400 ms behind `performance.now()`. That avoids switching full screen on a stale swipe while the next one is already down.

**Hygiene (not B25).** `render()` (simplegram.js:4815-4818) should disconnect `search.body.sgGrid.io` before clearing `.wrap`. The detached 843-cell grid keeps its observer.

### 3.2 Self-repair (safe on a real phone)

There is a page-side detector and a native gate. The automatic part is harmless. The real repair needs a tap.

**Page: what counts as a "dead drag".** Capture-phase passive listeners on `window`. A drag counts only if all of these hold:

- trusted; `touches.length` was 1 for the whole sequence (any second finger at any point excludes it, which covers pinches);
- the sequence ended with `touchend`, not `touchcancel`;
- vertical travel of at least 60 CSS px with `|dy| >= 2|dx|` (rules out carousel swipes);
- the first move came within 500 ms of `touchstart` (rules out long-press and text selection), and no non-collapsed selection is present;
- no `touchmove` was `defaultPrevented`, read in a `queueMicrotask` after dispatch (rules out SimpleGram's R8 guard and any Instagram drag handler);
- **every element in the touched element's composed chain allows pan-y**, from `getComputedStyle().touchAction` walking through shadow hosts. A no-pan-y surface such as a slider, sheet or Instagram's pan-x strips is *expected* not to scroll, so it never counts;
- the nearest vertical scroller in the chain (else the document) has room in the drag's direction and isn't `overflow:hidden`. A drag at the top or bottom edge, or under a body scroll lock, doesn't count;
- nothing scrolled. No `scroll` event (document capture plus a direct listener on `search.body`) and no change in that scroller's `scrollTop` within 800 ms of `touchend`;
- no long task over 200 ms overlapped that 800 ms window (PerformanceObserver);
- `document.fullscreenElement` is null; the route is not `story` and no `#sg-reel` is present; no visible `[role=dialog]`/`[aria-modal]`; `visualViewport.scale` is 1; the keyboard is not up (visualViewport height is not shrunk).

**Page: when to report.** After 3 dead drags in a row within 30 s with no successful scroll between them, post `scrollStuck {strikes, where: home|overlay|post|other, ...}` once, then rate-limit to once per 60 s.

**Native gate.** Ignore `scrollStuck` unless all of these hold:

- zoom scale is exactly 1; `!owned`, `!pinching`, `!holding`, `!split`;
- `customView == null`, `!pageVideo`, `!screenshotMode`, comments closed, no menu or dialog showing, Activity resumed;
- no finger down;
- ZoomFrame forwarded those drags' MOVEs to the WebView (a native per-sequence counter).

Anything that fails the gate is logged as `stuckIgnored` with its reason.

**Repair.**

1. **Automatic, harmless:** `ZoomFrame.forceIdle()`.
   - Stop the animator; set scale 1, tx and ty 0; clear `owned`, `pinching` and `panPointer`.
   - Release any hold even when the zoom guard says not to, with `onHoldChanged(false)`.
   - Turn split off if comments are closed.
   - Send one `ACTION_CANCEL` straight to `web`.
   
   Then tell the page to clear `gesture`, `swipe` and `storyPress` and to call `syncSwipeGuard()`. This fixes any native or page state; it cannot fix Chromium's count. Record whether later strikes stop.
2. **If strikes continue:** show a chip, "Scrolling stopped. Tap to fix". Never act on its own mid-use. On tap, rebuild the WebView:
   1. Read the page's search state via `evaluateJavascript`.
   2. `web.saveState(bundle)`, remove the WebView from ZoomFrame and `destroy()` it.
   3. Create a new WebView with the same settings, clients and JS bridges, and put it in ZoomFrame at the same index.
   4. `restoreState(bundle)`, or `loadUrl(savedUrl)`, then hand the search state back.
   
   Cookies are shared. sessionStorage may not be: it belongs to the old WebContents, which is why the search state is read and handed back by hand.
3. **⋮ → "Fix scrolling":** always present and runs step 2 directly. It is the manual escape hatch and a clean test of the diagnosis.

**Check on an emulator first.** Find out whether a cross-document navigation (`loadUrl("about:blank")` then back) gives WebView 155 a new RenderWidgetHost. If it does, that is a lighter repair that keeps sessionStorage. On 74 it did not (y1 G).

### 3.3 Diagnostics for Copy details (shape only, a `b25` block)

**Native:**
- `touch`: sequences started and ended per receiver (`web`, `custom`); `refused`, the MOVE/UP events the receiver returned false for after a DOWN it accepted (`NullAwViewMethods` returns false, so this directly flags a dropped end); `cancelsSent {show, hide, hold}`; `swallowed`.
- `fsLog`: the last 8 show/hide events, each `{kind, route, initiator: back|page|r8bridge, touchOpen, pointers, downOn: web|custom, msSinceDown, holding, rotation}`; plus `showDuringTouch` and `hideDuringTouch` totals.
- `zoom`: `{scale (0.01), owned, pinching, holding, split, animating, chipVisible, fullHidTab, pageVideo, screenshotMode}`.
- `repair`: `{stuckPosts, stuckIgnored{reason:n}, softResets, strikesAfterSoft, chipShown, rebuilds, strikesAfterRebuild, manualFix}`.

**Page:**
- `touchSeq`: `{starts, ends, cancels, orphans, orphanLast{route, fs, msSinceFsChange, appHeld}}`. An orphan is a trusted `touchstart` whose touches are all new while the previous sequence never ended; it is the lost end seen from the page.
- `drag`: `{dead, deadLast5[{route, where, travel bucket, chainTA: distinct values}], preventedSG, preventedOther, noMoves, maxTouchesAtStart}`.
- `taSeen`: the last 5 distinct non-auto touch-action values touched (values only, such as `none` or `pan-x`) with tenths and route. This names the kind of surface that removed pan-y.
- `fsPage`: the last 8 `fullscreenchange` events, each `{tag, route, via: r8|r8-adopted|r8-race|other, on, msSinceTouchEnd, touchActive}`; plus `r8Pending`, `r8LateExit` and `r8Adopted` counters.
- Census: html/body computed `overflowY`/`touchAction`; live non-passive `touchmove` listeners on window/document/body (net count, by wrapping `addEventListener` at document start); visible dialog count; `visualViewport.scale`.
- `search`: `{open, leaving, cells, liveObservers}`.

**How to read the next report:**

| Reading | Means |
|---|---|
| `hideDuringTouch`/`showDuringTouch` with `refused` > 0 and `cancelsSent` 0 | The fix missed a path |
| `orphans` > 0 followed by a no-pan-y entry in `taSeen` and then dead drags | This mechanism |
| `preventedOther` | An Instagram listener |
| `noMoves` | The native layer ate the moves |
| `maxTouchesAtStart` ≥ 2 | A held pointer |
| `strikesAfterSoft` 0 | Native or page state |
| Strikes stop only after a rebuild | Chromium's input state |

### 3.4 What Cam can try before restarting (in this order)

1. **⋮ → Copy details right away**, while it is still broken, and send it. This is the most useful step.
2. **⋮ → Refresh**, then try to scroll. If scrolling comes back, it was page state (most likely an Instagram listener) and this diagnosis is wrong. Expected: still stuck.
3. **Pinch to zoom in a little, let go, then double tap.** If scrolling comes back, it was the app's zoom layer. Expected: still stuck.
4. **Back a few times, then the Home tab.** Expected: still stuck.
5. **⋮ → Fix scrolling (new in 1.4).** Expected: fixed. That would confirm the diagnosis.
6. **⋮ → Copy details again** after step 5, then restart only if it is still stuck.

### 3.5 Tests for 1.4

- Move B25Test into `androidTest`:
  - **Regression cases** (must scroll after tapping the `none`/`pan-x` probes once the fix is in): y1, y2, y3, r3, and an enter-side x1 variant.
  - **Controls:** b1, c0, r0.
  - **Repair path:** use y1 plus a `pan-x` tap to make the stuck state on purpose. Then assert that the chip appears, the soft reset leaves it stuck, and Fix scrolling restores scrolling.
- Playwright tests for the dead-drag detector. None of these may count as a strike:
  - a pinch;
  - a carousel swipe;
  - a drag on a `pan-x` or `none` element;
  - a drag at the top or bottom edge;
  - a body scroll lock;
  - a prevented drag;
  - the Story route;
  - full screen;
  - a long press or selection;
  - a slow page.
  
  A stand-in "dead" WebView (scroll suppressed with nothing prevented) must post `scrollStuck` after 3 strikes.
- Playwright tests for the R8 race fix, using the async full-screen stub from `b25-race.test.cjs`.
- Get a working newer WebView: fix the API 34 image, or sideload a current WebView on API 29. Then re-run x1/x2 (enter side), y1, and the cheap-navigation repair check on WebView 155.

## 4. Remaining uncertainty

- No direct trace from Cam's session shows a lost touch end. The 1.4 diagnostics are designed to show one.
- All reproductions ran on WebView 74. The 155 sources keep the same swap order and the same count logic, but the enter side and whether navigation clears the state are unconfirmed on 155.
- The element that removed pan-y is unknown: Instagram's touch-action class definitions are not in the saved bundles. `taSeen` would name its value next time.
- Where the 5th full screen came from (R8 race or Instagram's player) is open. It does not change the fix.

---

Emulator experiments (scratch, not kept): Test class (scratch copy; the repo is untouched): /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/b25/repro-src/app/src/androidTest/java/com/cam/simplegram/B25Test.java, with a copy at /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/b25/repro/B25Test.java. Runner script: /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/b25/repro/run.sh. Per-experiment results are in /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/b25/repro/ as <method>.log (step results), <method>.am.txt (instrumentation output) and <method>.logcat.txt. Key files: /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/b25/repro/y1_exitWhileFingerDown.log, /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/b25/repro/y3_exitFromBusyTouchendNextSwipeDown.log, /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/b25/repro/r3_r8QuickSecondSwipeSameDocument.log. The control runs are c0.log/c0.txt in the same folder. Emulator logs: /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/b25/repro/emulator.log (API 29) and /tmp/claude-0/-home-user-SimpleGram/2826c533-1961-5845-8f73-882b17711860/scratchpad/b25/repro/emulator34.log (API 34, failed boot). Run an experiment with: run.sh <method>. Both emulators have been stopped with adb emu kill.
