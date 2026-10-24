# B28 / B31 diagnosis: R10's full screen pauses the video and another one plays

**Status: cause found and reproduced on a real Android WebView (158, the phone has 156).**

## In one paragraph

To show a feed video full screen with its progress bar, 1.4 puts the whole page in full screen and lifts the video over it ("page mode"). Android's WebView then **scrolls the page under the video to the very top**. Instagram's feed keeps running underneath, and its player judges what's on screen from where each post sits in the page, not from the lifted video. So it decides the tapped post has left the screen, **pauses the full-screen video** (the still picture) and **plays the video at the top of Home, with sound** (sound was on), which is usually one Cam had already watched ("the audio of the previous video"). Every attempt to play the full-screen video again is undone by Instagram within a moment ("it wouldn't play"), and a jump on the progress bar shows a time but no new picture (B31). Leaving full screen puts the scroll back, so Home looks normal again and the tapped video plays on, now at a later moment than the frozen picture.

## How it was found

1. **Cam's Copy details** (`details-1.4-b28.md`): two "jumps" of Home to its top with no finger on the screen, in the same minutes as the full screens. A full screen is the only thing that runs then.
2. **Instagram's own player code** (the public website bundles saved in batch 4; nothing fetched):
   - Each feed player watches **its own wrapper box** in the post (`VideoPlayerOnViewability`, an IntersectionObserver), not the `<video>`. Lifting the video doesn't move that box; scrolling does.
   - The feed rules **pause any playing video less than 25% on screen** (`PauseOnInvisible(.25)`), with no exception for a play Instagram didn't start.
   - One video plays at a time: the one nearest the middle of the screen; on a tie, the higher one, then the one mounted first.
   - Sound is one setting for the whole feed. Once it is on, every video Instagram starts plays with sound. Its "one sound at a time" guard is off.
   - Instagram's full-screen code only recognises its own player element (a strict `===` test), so `<html>` in full screen changes nothing on Instagram's side. It never scrolls on full screen or resize. The scroll comes from the WebView.
3. **Desktop Chromium** (the Playwright tests) never moves the scroll, and the old emulator WebView (74) had no popovers, so it used the other method. That's why page mode had never run on a real Android WebView before 1.4.
4. **The emulator with WebView 158** (installed for this; `B28Probe`, run with `-e probe 1`). This is a three-video feed with a player built on Instagram's rules (`app/src/androidTest/assets/b28/feed.html`), with sound turned on while A plays, B scrolled into view and a real tap on B. Timeline (`scrollY`, viewport, full screen, lifted, active video; P/> = paused/playing, m/S = muted/sound):

   ```
   119290  738 411x842 html lift B   A PS4.9  B >S0.8      full screen lands, B playing with sound
   123669    0 411x914 html lift B   A PS4.9  B >S2.1      the WebView scrolls the page to the top
   123764  player: B -> A  (ratios A 1, B 0.06)
   125865    0 411x914 html lift A   A >S4.9  B PS2.1      B paused (still picture), A heard
   ...      a tap in full screen plays B: both play with sound (Instagram would pause B again)
   167957  738 411x914              after Back: the WebView puts the scroll back, B plays on
   ```

   The screenshots show B's picture stuck at second 2 in full screen while A plays.

## Each report, explained

| Report | What happened |
| --- | --- |
| (3) "It just paused the video and I started hearing the audio of the previous video" | Exactly the timeline above. |
| (2) a still picture while "its audio kept playing" | The still picture is B, paused by Instagram. The sound was most likely the video at the top of Home, which can be the one just before. |
| (1) after a pause in full screen and Back, the next full screen "was still paused, it wouldn't play", the music video heard | Same, on the second full screen. Back from the first one, SimpleGram had also played B again, undoing the pause (a separate defect, below). |
| (2) taps in full screen went back to Home, then every tap flipped between Home and full screen | **Not reproduced.** Copy details show those exits were asked for by SimpleGram's page within 40–50 ms of a finger lifting (its swipe rule; its "video gone" rule would have fired without a tap). Likeliest cause: with the system bars hidden, reaching for Back/Home means swiping up from the bottom edge to bring the bars back, and that swipe also reaches the page as a swipe that leaves full screen (B26 removes the need). On Home, every tap on the video is R10 again, so it went straight back into full screen. Copy details will record the reason next time. |
| B31: scrubbing moved the time but the picture froze | Same cause. The bar shows where you drag. Instagram keeps the video paused, and its streaming doesn't fetch the new part for a video it has stopped, so the picture never catches up. |
| (3) the "You're all caught up" card after coming back | Probably not the full screen itself. In that WebView Home had ended without carrying on into Following (Copy details: the continuation never started; see B32), and the app holds the card back while full screen is up, so it shows the moment you come back. |

## Other defects found on the way (all to fix with B28)

- **A pause in full screen isn't kept.** Back from full screen, SimpleGram restores the video to how it was *before the tap* (playing), so it plays on (reproduced without any scroll change).
- **Sound gets toggled twice.** R10 lets Instagram's own single tap through, and on Home that tap toggles the feed's sound just as full screen starts. SimpleGram then presses Instagram's sound button to turn it back on. With the page scrolled, that press can reach another post's button.
- **Nothing keeps the full-screen video the only one playing.** SimpleGram checks once, 150 ms in. Nothing stops another video Instagram starts.
- **A lifted video that drops out of the top layer while still in the page isn't noticed.** The full screen would then show the feed under it. Only a removed video is noticed.
- **Copy details can't tell why full screen ended** (the reason is dropped), and its full-screen log has no times to line up with Home's jumps.

## Fix plan (for the build after "Apk it")

1. **Keep the page where it was under a full-screen video.** Note the scroll position at the tap and put it back whenever the WebView moves it while page mode is on (tried on the emulator; see below). Instagram then still sees the tapped post on screen, so it keeps that video playing and never starts another.
2. **Belt and braces:** while SimpleGram's full screen is up, any other video that starts is paused, and only the full-screen video has sound.
3. **R10 takes the tap.** Instagram's single tap no longer toggles the feed's sound at the same moment. Sound comes on for the full-screen video alone, and the feed's sound setting is left as it was.
4. **Back from full screen keeps what you did:** paused stays paused. The feed video's sound goes back to how it was.
5. **If the lifted video ever stops showing,** full screen ends instead of showing the feed.
6. **Copy details:** why each full screen ended, the scroll position and viewport at each switch, which videos played or had sound during it, and times.
7. **Tests:** the emulator probe becomes a real test (with WebView 158 installed as above). The Playwright fixture gets an Instagram-like player and a simulated scroll reset.

## Fix candidate tried on the emulator

`B28Probe#boxHold`: the same run, with a small page script that remembers the scroll position before full screen and puts it back when it moves while `<html>` is full screen.

```
128775  738 411x842 html -    B   A PS6.4  B >S4.4      full screen lands
129926  738 411x842 html lift B   A PS6.4  B >S4.4
132480  738 411x914 html lift B   A PS6.4  B >S4.4      bars hidden; the scroll stays (holds: 1)
145650  738 411x914 html lift B   A PS6.4  B >S7.0      B plays with sound, A stays paused
156491  738 411x914 html lift B   A PS6.4  B PS1.0      a tap pauses B; nothing else starts
166818  738 411x842 -    -    B   A PS6.4  B >m1.0      after Back: SimpleGram plays B again (the separate defect)
```

The WebView moved the page once; it was put back in the same moment (it never showed in the 100 ms samples) and the WebView didn't fight it. Instagram's model player kept B as its video, so A never played. This is the core of fix step 1, now confirmed on a real WebView.

## Reproducing it

The emulator image's WebView is 74. To run the probe on a current one:

1. Download `SystemWebView.apk` (x86_64, package `com.android.webview`) from Chromium's `AndroidDesktop_x64` snapshots. It sits inside `chrome-android-desktop.zip`; a range request fetches just that entry.
2. Boot `sg29` normally. Then: `adb root`, push the APK to `/data/local/tmp/wv/webview.apk`, `setenforce 0`, `chcon -R u:object_r:system_file:s0 /data/local/tmp/wv`, `mount -o bind /data/local/tmp/wv /system/product/app/webview`, then `stop; start`. `dumpsys webviewupdate` should then show 158. The mount lasts until the emulator stops.
3. Don't use `-writable-system` with `adb disable-verity`: the emulator stopped booting, and only deleting the AVD's `*.qcow2` overlays brought it back.
4. `adb shell am instrument -w -r -e probe 1 -e class com.cam.simplegram.B28Probe#box com.cam.simplegram.test/androidx.test.runner.AndroidJUnitRunner`. Screenshots are in `/sdcard/Android/data/com.cam.simplegram/files/b28/`.
