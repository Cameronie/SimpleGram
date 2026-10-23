# What to try on the phone with 1.3

Nothing in 1.3 could be tried against a signed-in Instagram before release; your phone is the real test. After each try, **⋮ → More… → Filter status → Copy details** and paste it into a message. Copy details holds counts and data shapes only, never names, captions or links.

## Home and the feeds

1. **Home into Following (R7, on by default).** Scroll Home to the end. Posts should carry on under a thin line, "You're all caught up · Following, newest first", with no repeats and no card. Instagram's own "caught up" block should not appear in the middle of the feed.
   - Open a post and go back, and switch apps and come back: it should keep going.
   - At the end, tap Home (it goes to the top), then tap again at the top (Instagram may refresh). Scroll down again: it should continue with posts you haven't seen, with no gaps.
   - Turn on airplane mode while it continues: the Following card should appear.
   - Past about 200 posts, the card should say "Keep going in Following".
   - Turn it off (⋮ → More… → Continue Home into Following) and reload Home: Home should end at "caught up" with the Following card.
2. **Home tab (B16).** Scroll down Home and tap Instagram's Home tab: Home should only go to the top, keeping everything. A second tap at the top is Instagram's own refresh. If Home ever jumps to the top by itself, send Copy details right away.
3. **Following from the card (B17).** Turn R7 off, reach the end card and tap Following. Expect at most one post you've seen at the top, then new posts. After a long Home, expect "Skipping N posts you saw in Home…" for a while.
4. **Never blank (B18).** Open Favorites and Following from Instagram's logo menu, then go back with Back, the Home tab and the "< Following" / "< Favorites" link. Every feed should load with posts, never the star screen ("Choose the accounts you can't miss out on") or a blank page. If one goes blank anyway, try ⋮ → Refresh before restarting, then send Copy details.

## Favorites star (R5)

5. The bar should show five evenly spaced items with the star right after Home, the same size and colour as Instagram's icons, in light and dark mode. Filter status should read "Favorites star: in the bar (5 items, off by 0 px)".
6. Tap the star: Favorites opens with posts and the star is filled. On Favorites: scrolled down, a tap goes to the top; at the top, a second tap within 30 s does nothing, a later one refreshes; with search open, a tap only closes search.
7. From Favorites, the Home tab, the "< Favorites" link and Back load Home fresh, at the top, with posts (not blank).
8. Turn the phone sideways: no star in the side bar; back in portrait it returns without a flicker. No star on Stories or in messages.

## Video (R8, R9) and Stories (B19)

9. **Full-screen video (R8).** Open a post or Reel with a video, at the top of the page, and swipe down on the video. It should fill the screen on black, with no icons or bars. Tap to pause and play. Swipe up or down, or press Back, to return. Scrolled down a little, a swipe down only scrolls up; the next one goes full screen. A swipe up never goes full screen. Carousel swipes and Instagram's taps (sound, pause) work as before.
10. **A Reel shared to a Story (R9).** On a Story with a "Watch Reel" sticker, swipe up: the Reel plays full screen (with sound unless you muted) and the Story waits. Swipe down, swipe up or Back: you're back on the same Story item, which continues. On an ordinary Story, swipe up still opens the reply box and swipe down still closes Stories.
11. **Stories swipes (B19).** Swipe back to the previous person and forward a few times, then send Copy details: it now times each swipe. Also open the ⋮ menu inside a Story and close it: the Story should continue right away and the next swipe should work first time.
12. Opening a Story should raise "Full-screen views" in Filter status → App, with "page: body on story". That confirms Stories run in the app's full-screen view.

## Search (R4)

13. Search a place, open it and tap Show more five or more times on Top and on Most recent: it keeps going, about 24 posts a tap. Same for a tag and for Posts & Reels (ten taps: it should stay smooth).
14. With poor signal, a failed page keeps the grid and offers Try again.

## Still working as before

Downloads (photos, videos, Stories), sound on in Stories and Reels, pinch zoom (a zoomed Story holds), comments in the half-screen panel, DMs and DM videos, and the ⋮ tab.

## Copy details fields, for reference

- R7: `page.cont` (state, reason, modules, own, ownFail, handed, repeats must be 0, headWhy), `page.cont.runs`, `page.cont.hand`, `page.homeRing`, the PolarisFeed entries of `page.searchData.gqlLog`, `device.continueHome`.
- B16: `page.feed.homeTapTop` / `homeTapRefresh`, `page.homeEvents`, `page.homeRing`.
- B17 / B18: `page.feed.anchorKind`, `skipFirstNewMs`, `tries`, `switchLoads`, `recovered` / `recoverHeld`, the top-level `trail`, `device.pageStarts`.
- R5: `page.nav` (geo, waitReact, waitReactGaveUp, top, refresh, refreshHeld, homeFull).
- R8 / R9: `page.diag.fullVideo` (r8, r8Failed, r9, r9Missing, r9Moved, exits), `device.fullScreens`, `device.fullScreenNested`.
- B19: `page.diag.storySwitch`, `storySwitchSlow`, `storyCancels`, `longTasks`.
- R4: `page.searchData.grid` (placeFirst, sizes, chained, failed).
