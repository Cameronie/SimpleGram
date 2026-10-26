# B33 diagnosis: stuck on Instagram's logo screen

**Status: likely cause found from Instagram's own start-up code. Not reproduced. The stuck page's data was lost when Fix scrolling rebuilt the page view.**

## Likeliest cause

The logo screen is part of Instagram's page (`<div id="splash-screen">`). Instagram's code removes it once the website has started. Starting needs the page's HTML and about six script files from Instagram's file server (static.cdninstagram.com).

If one of those files fails or stalls while a page is loading, Instagram marks it "done" anyway and never asks again. This happens to:
- any failure before its loader has started, which takes until a large part of the HTML has arrived;
- any stall at all.

Its two quick retries (0.2 s and 0.5 s) cover only the in-between case.

After that, the code that removes the logo waits forever. Instagram has no timeout and no error screen. A cut-off HTML download ends the same way (its partial data is silently skipped).

Moments that make this likely:
- a page starting to load while the app goes to the background or comes back (Copy details show five trips to the background between 13:57 and 14:15);
- Wi-Fi and mobile data handing over;
- poor signal.

A brand-new page fetches everything again, which is why ⋮ → Fix scrolling got past it. ⋮ → Refresh would very likely have worked too.

Sources: Instagram's public website code saved in batch 4 (nothing fetched): the logo removal in `CometSSRClientInjector`/`CometSSRContentRevealer`, the loader's handling of failed files (`Bootloader`, `_btldr`, `jsRetries [200,500]`, "retry when back online" off), and `ServerJSPayloadListener` skipping cut-off data.

## Less likely

- **An Instagram start-up module threw once.** There are at least four separate routes that remove the logo, so it would take several failing together.
- **SimpleGram's own changes at start.** SimpleGram rewrites data as Instagram reads it. The same script runs in the rebuilt page, so a cause here should repeat every time. Offline checks on saved logged-out pages found no changes to Instagram's start-up data. Two latent risks are worth closing anyway:
  - the feed rules are applied to every piece of data Instagram reads, including its start-up configuration;
  - 1.3's continuation can start one of Instagram's modules from inside Instagram's own data reading.
- **The page view stopped drawing after a trip to the background,** so the logo was an old frame. A stale frame would normally show blank, so this fits poorly.
- **SimpleGram's own launch screen** (its camera icon). Ruled out: that covers the whole app, and Cam could reach ⋮.

## What SimpleGram is missing (defects)

- No record of network errors for the page or its files: no `onReceivedError`, `onReceivedHttpError` or `onReceivedSslError`. A TLS failure (captive portal, VPN, wrong clock) is silently cancelled.
- No idea of "Instagram has started", no watchdog, and no recovery. The only self-repair, "posts not drawn", needs posts to have been drawn already.
- Copy details only works if the page answers. A stuck or dead page can't produce it.
- ⋮ → Fix scrolling destroys the old page view after reading only its search state, so the evidence goes with it. Nothing records why a rebuild happened (B28 escape or B33 escape).
- A page restored when Android recreates the screen isn't counted as such. Pause/resume times and memory warnings live only in memory.
- Minor: the XHR "already cleaned" check never matches on Chromium, because it returns a new object on every read, so some data is cleaned and counted twice.

## Fix plan (for the build after "Apk it")

1. **Detect "Instagram didn't start"**, counting only time the app is on screen and online:
   - one of Instagram's start-up files failed and the logo is still up 3 s later, with no retry of that file still running;
   - the HTML was cut off (Instagram's end marker is missing) and the logo is still up;
   - no start-up progress for a long while (in-flight requests count as progress);
   - a generous cap.

   A check from the app side also covers a page where SimpleGram's script didn't run, or a busy page. Each page load carries its own token, so a late message can never reload a newer page. Only the main page counts, not the comments panel.
2. **Recover:**
   - First, reload once by itself, never while you're typing or have comments open; at most twice in 10 minutes.
   - If you're offline, a small "No connection: SimpleGram will reload when you're back online" note, then a reload when the network returns.
   - If it's still stuck, a chip, "Instagram didn't start": Try again (a fresh page view) or Details.
   - As a last step, one load with SimpleGram's data changes switched off. That rescues Cam if SimpleGram were the cause, and shows whether it is.
3. **Diagnostics kept in the app** (they survive Fix scrolling and show in Copy details; counts and kinds only):
   - the last 10 page starts and how each began;
   - network errors by host kind;
   - the stuck page's state (logo, start-up files, Instagram's loader, script errors by kind);
   - network type and changes, Data Saver and background restrictions;
   - pause/resume times;
   - why each rebuild happened, and its outcome;
   - how the logo went away on every normal start (this is useful at once: it shows how Cam's signed-in Home starts).

   Copy details will open even when the page doesn't answer. Fix scrolling copies the old page's record before rebuilding.
4. **Close the latent risks:**
   - feed rules only on feed data;
   - no Instagram module started from inside its own data reading;
   - the XHR double-clean.

## Questions for Cam

- When did it happen: right after opening the app, after switching back to it, or after the other (B28) Fix scrolling?
- Roughly how long did you wait?
- Is Data Saver on, or "background data" off for SimpleGram? Is there a VPN, Private DNS or ad-blocking DNS?
- Next time: give it a minute, try ⋮ → Refresh first, then send Copy details.
