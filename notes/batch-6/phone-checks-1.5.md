# What to try on the phone with 1.5

Nothing in 1.5 could be tried against a signed-in Instagram before release; the
full-screen fix was proved on an emulator with a current Android WebView and a
stand-in for Instagram's player. When something looks wrong, go to **⋮ → More…
→ Filter status → Copy details** and paste the result into a message. Copy
details now works even when the page is stuck, and holds counts and shapes
only, never names, captions or links.

## Full-screen video (B28, B31, B26, B27)

1. **Tap a video in Home.** It opens full screen, playing, with sound, with the
   progress bar; **the Android buttons stay at the bottom** and the picture
   sits above them. No other video's sound should ever be heard.
2. Tap once: it pauses. Tap again: it plays. Drag the progress bar: the
   picture follows and plays on.
3. Pause it, then press Back: it stays paused in the feed. Open it again: it
   plays from there. Nothing in the feed should jump.
4. Scroll on: the feed's sound setting should be as you left it (the tap that
   opens full screen no longer flips Instagram's sound).
5. **The ⋮ tab:** tap it over a video: the menu opens and nothing goes full
   screen. A tap just beside it does nothing either (the dead zone). Drag the
   tab somewhere else: the zone moves with it.
6. Stories and screenshot mode keep the Android buttons too.

## Story Reels (B29, B30)

7. Swipe up on a Story that shares a Reel: the Reel plays full screen with the
   account, caption and buttons. The comment bubble is a whole bubble.
8. **Swipe up on the Reel:** the comments open (with the one-line box at the
   bottom). Back closes them. **Swipe down** (or Back) returns to the Story.

## Home into Following (B32)

9. On a Home that ends without Instagram's "You're all caught up" line (only
   suggestions follow your friends' posts), Home should still carry on into
   Following under the thin "You're all caught up · Following, newest first"
   line, with no card. Filter status says how it started (`startVia`).

## Instagram's logo screen (B33)

10. If the logo ever stays up, wait: after about 20 s on screen SimpleGram
    reloads once by itself. If you're offline it says "No connection…" and
    reloads when you're back. If it's still stuck, the "Instagram didn't
    start" chip offers **Try again**, **Details** and, last, **Load without
    filters**.
11. If Data Saver is on and SimpleGram isn't exempt, a one-time tip explains
    and offers the setting. You've already exempted SimpleGram, so you may
    never see it.
12. Switch to another app while Home is still starting, then come back: it
    should finish or reload by itself, never stay on the logo.

## Copy details fields, for reference

| What | Field |
| --- | --- |
| Full screen (B28) | `page.diag.fullVideo` (scrollHeld, othersPaused, replays, remuted, r10KeptPaused, r10DeadZone, exitsBy), `page.b25.fsPage` (y, vh, t, playing), `device.b25.fsLog` (why, time) |
| Progress bar (B31) | `page.seekBar` |
| Story Reel swipes (B29) | `page.reelInfo.swipeComments` |
| Continuation (B32) | `page.cont.startVia`, `page.cont.headWhy.noLine` |
| Logo screen (B33) | `device.bootLog`, `device.lastStuck`, `device.netErrors`, `device.net`, `device.lifecycle`, `device.rebuildLog`, `device.reloadLog` |
