# What to try on the phone with 1.4

Nothing in 1.4 could be tried against a signed-in Instagram before release, so your phone is the real test. When something looks wrong, go to **⋮ → More… → Filter status → Copy details** and paste the result into a message. Copy details holds counts and data shapes only, never names, captions or links.

## The big one: scrolling never gets stuck (B25)

1. Use full-screen video a lot: a tap on a feed video (R10), the swipe down at the top of a post (R8), and a Story's Reel (R9). Leave it with swipes and with Back, including quick swipes one after another.
2. Scrolling should keep working everywhere afterwards, including search results.
3. If scrolling ever stops anyway, **don't restart**:
   - First take Copy details right away (⋮ → More… → Filter status → Copy details) and send it.
   - Then try the "Scrolling stopped. Tap to fix" button if it shows, or ⋮ → Fix scrolling.
   - Tell me whether that brought scrolling back.

## Videos (R10, R11, B21)

4. **One tap on a video** in Home opens it full screen with sound. You should see just the video and the progress bar. Swipe up or down, or press Back, to return. The feed video should be as it was (muted if it was).
5. **A double tap** still likes the post and doesn't open full screen.
6. **Instagram's own buttons** on the video (sound, tagged people) still work as before.
7. **⋮ → Full-screen video** opens the video that's on screen.
8. **The progress bar** shows in full screen, in an opened post, in a Reel sent in a DM, and on a Story's Reel.
   - Touch it: it thickens and shows a round handle and the time.
   - Drag it, or tap a point, to jump.
9. **No snap:** a vertical video post shouldn't jump narrower when it starts playing.

## Story Reels (R12)

10. Swipe up on a Story that shares a Reel. Over the Reel you should see:
    - the account and the caption, with "more" to expand it;
    - like, comment, share and save, with their counts;
    - Follow, if you don't already follow the account.
11. Like it, then unlike it. Open comments: they show over the Story, and Back closes them first.
12. Tap the account name to open their profile. Back should return to the Story.

## DMs (B24)

13. Open a Reel a friend sent in a DM. Swiping up or down should not move on to a "Suggested" Reel. Chats still scroll normally.

## Home and Following (B22, B23)

14. Scroll fast past "You're all caught up". Posts from Following should keep coming, and the "Home isn't loading more" card shouldn't pop up while they load. A quiet "Loading more from people you follow…" note is fine.
15. With the continuation switched off (⋮ → More…), tap Following on the end card. It should open past the posts you saw in Home, and quickly.

## Comments (B20)

16. Open a post's comments. The comment box is one line high, with no empty band under it.
    - Tap the box and type: it grows.
    - Leave it: it shrinks back, and your draft is kept.

## Copy details fields, for reference

| What | Field |
| --- | --- |
| Stuck scrolling (B25) | `b25` (device and page): touch, fsLog, repair, touchSeq, drag, taSeen, fsPage |
| Full screen | `page.diag.fullVideo` |
| Progress bar | `page.bars` (or similar bar counts) |
| Story Reels (R12) | `page.reelInfo` |
| DMs (B24) | `page.dmReel` |
| Home continuation (B22) | `page.cont` with its wait reasons |
| Following from the card (B23) | carry status in Filter status ("start from Home") |
| Comment box (B20) | "Comment box" line and `commentsLayout` |
