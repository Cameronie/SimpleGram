# Copy details sent with B28–B31 (1.4, about 2:20 pm)

Cam pasted Copy details after the full-screen glitches (B28) and the frozen
scrub (B31). The paste was cut off near the end of `trail`. The fields that
matter are below, copied as sent; counts and shapes only, no names.

## Device

- app 1.4, Android 36, **WebView 156.0.8078.47** (not 155).
- `fullScreens` 11, `fullScreenLast` "home at 14:14", `fullScreenNested` 0.
- `pageStarts`: all 4, loadUrl 3. `b25.repair`: `rebuilds` 2, `manualFix` 2 (⋮ → Fix scrolling used twice), `stuckPosts` 0, `softResets` 0, `chipShown` 0.
- `b25.touch`: web started/ended 75/75, custom 30/30, no cancels sent, nothing swallowed.
- `b25.fsLog.last` (oldest first): show page → hide **back**; show page → hide **back**; show page → hide **r8bridge**; show page → hide **r8bridge**. All on route home, no finger down at any switch.

## Page (the WebView after the last rebuild)

- `diag.fullVideo`: r10 5, exits 5, r10Restored 5, r10Skipped 0, r10Doubles 0, liftFailed 0, r8 0, r9 0.
- `b25.fs`: exitAsked 3, exitFallback 0, r8Race 0, r8Settling 0, r8Adopted 0, r8Stale 0.
- `b25.fsPage` (on/off pairs, ms since the last touch ended):
  on 378 → off 897; on 340 → off 622; on 362 → **off 37**; on 393 → **off 51**.
  The "on" times are R10's 300 ms double-tap wait. The last two exits came 37 and 51 ms after a touch ended: a tap in full screen ended it through the page (r8bridge), not Back.
- `seekBar`: attached 5, taps 1, drags 3, where {full: 5}. All in R10's full screen; `reelInfo.shown` 0 and `fullVideo.r9` 0 in this WebView (the Story Reel of B29 was before a rebuild).
- `homeEvents`: hist, **jump from 1.1 screens** (t 60.7 s), vis hidden/visible ×2, **jump from 3.5 screens** (t 452 s), vis hidden/visible. A "jump" is Home's scroll position going to the top with no finger on the screen for 300 ms (B16's detector, which only counts a jump from more than one screen down).
- `homeRing` `y` (scroll position in screens when each Home page arrived): …, pg 8 1.1, **pg 9 0**, pg 10 1, **pg 11 0**.
- `b25.drag.skipped`: fullScreen 6, end 9. `taSeen` manipulation on html.
- `feed`: pages 11, seen 98, kept 5, ad 19, notFollowed 23, suggested 51, stopped 1, peakPosts 5, peakVideos 3.
- `cont`: on true, **state "off"**, reason "", modules null, own 0, pages 0, resets 0. The continuation never started in this WebView (the end card showed, as in the 2:14 screenshot).
- `covers.framed` 3 (B21 working).
