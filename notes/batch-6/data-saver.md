# Data Saver and the background: what Android does to SimpleGram's network (B33)

Cam had Data Saver on and switches away from SimpleGram often (to send
screenshots). Two researchers read Android 16's source (AOSP
`android-16.0.0_r1`: NetworkPolicyManagerService, ActivityManagerService,
ActivityThread, netd, DnsResolver, the Connectivity module) and Chromium's
network code; a reviewer checked their claims. What follows is what they
verified, with the inferred parts marked. The sources are named in the
workflow results; nothing was run on a device.

## Verified

1. **Data Saver cuts a non-exempt app off mobile data the moment it leaves the
   foreground.** Allowed only while the process is TOP (or runs a foreground
   service, which SimpleGram doesn't). Switching apps or the screen turning
   off (TOP_SLEEPING) both count, and the rule is applied at once, with no
   grace period. Only metered networks (5G) are affected; Wi-Fi isn't.
2. **Android 15 and 16 add a second block that Data Saver's exemption doesn't
   lift:** every network, Wi-Fi included, is blocked for an app at TOP_SLEEPING
   or worse after a short delay (5 s by default; 2 s or 20 s with a newer
   flag), and the app's TCP sockets are destroyed (possibly only once the
   cell radio is active, which sending a screenshot makes likely). Cached apps
   are also frozen.
3. **Blocked connections fail fast; open ones stall.** The firewall REJECTs
   new connections (Chromium: `ERR_CONNECTION_REFUSED`), DNS fails at once
   (`ERR_NAME_NOT_RESOLVED`). A download already running on an open connection
   gets no error: it stalls (inferred from kernel behaviour, not captured).
   A failed script fires the page's `error` event; a stalled one fires nothing.
   Both are exactly the two cases that leave Instagram's logo up for good.
4. **Coming back has its own window.** Android unfreezes the app before the
   network rules are re-applied, and the only guard is a wait of at most
   200 ms on the main thread; WebView's network thread isn't held. Chromium
   carries a workaround for this very window (crbug 677365). Requests sent in
   the first moments after a return can hit the old block.
5. **Chromium doesn't retry a failed connect or lookup and doesn't remember a
   block.** It retries only reset/closed/aborted errors on a reused connection,
   and heals an idle stalled HTTP/2 session only after a 10 s ping plus 10 s.
   A new page, or the new WebView from Fix scrolling, shares the same
   connection pools in the same process.
6. **WebView in SimpleGram can't see any of this.** Its network-change notifier
   runs only when the app holds `ACCESS_NETWORK_STATE`; SimpleGram holds only
   `INTERNET`. So `navigator.onLine` is meaningless and there are no
   online/offline events.
7. **The APIs.** `getRestrictBackgroundStatus()` (no permission) reports the
   policy: DISABLED, ENABLED (Data Saver on and not exempt, or the app's own
   "background data" switch off), WHITELISTED (exempt). It says nothing about
   now. `registerDefaultNetworkCallback` with `onBlockedStatusChanged`
   (API 29+, needs `ACCESS_NETWORK_STATE`, a normal install-time permission)
   is the live "blocked for me" signal; on Android 15+ it follows the kernel's
   firewall state. Callbacks can arrive late and in a burst after an
   unfreeze. `getActiveNetwork()` returns null while blocked (synchronous).
   `Settings.ACTION_IGNORE_BACKGROUND_DATA_RESTRICTIONS_SETTINGS` with
   `package:com.cam.simplegram` opens the app's data screen in AOSP (not
   verified on One UI 8; guard with `resolveActivity`). Samsung's manual path:
   Settings → Connections → Data usage → Data saver → "Allowed to use data
   while Data saver is on".

## What this means for Cam's reports

- *Right after opening the app:* probably not a plain cold start in the
  foreground (that path is guarded, and a blocked cold start fails the whole
  page, which shows WebView's error page, not the logo). More likely a page
  left loading when Cam last switched away (its files failed or stalled while
  blocked), or a return that landed in the window of point 4.
- *After a Fix scrolling:* Data Saver alone doesn't explain it (the rebuild
  runs in the foreground). Two fits: Cam switched away or the screen went off
  while the new page was still starting, or the new page reused stale
  connections from the shared pool (point 5).
- Exempting SimpleGram from Data Saver (Cam has done this) removes the instant
  cut, but not Android 15+'s background block and socket destruction. The
  watchdog and the reload stay the main fix. If B33 never returns with the
  exemption on, Data Saver was the trigger.

## Design for 1.5 (stream A; refines plan.md's B33 native half)

1. Add `ACCESS_NETWORK_STATE` to the manifest. **Side effect to test on the
   emulator (WebView 158):** WebView's network-change notifier starts, so
   `navigator.onLine` and online/offline events become live and Instagram's
   code may react to them. The page's boot record notes every `online`/
   `offline` event. If Instagram's start changes for the worse, keep the
   permission (the callbacks need it) but check what the page does with the
   events.
2. `NetWatch`, a small class owned by MainActivity: the default network
   callback (registered in `onCreate` on the UI handler, unregistered in
   `onDestroy`), state `{net, blocked, known, metered, validated, transport}`,
   `netOk()` = known ? (net != null && !blocked) : getActiveNetwork() != null,
   a static event ring (last 30: time, avail/lost/caps/blocked, value,
   resumed, page token) and, for the last 10 resumes, ms from `onResume` to
   `netOk()`.
3. `whenNetReady(why, go)` gates the app's own loads: `onCreate`'s first load
   or restore, `onNewIntent`, the rebuild's load, ⋮ → Refresh, and the
   automatic reload. Runs at once when `netOk()`; otherwise keeps the newest
   pending runnable and runs it on the first callback that makes `netOk()`
   true while resumed, with a cap of 1.5 s counted from `onResume` (in the
   background it waits). Dropped in `onDestroy`. Never `setNetworkAvailable`.
4. Tainted page starts: each main-frame page start gets a native token. If
   the page hasn't reported `boot` and any of these happen, the token is
   marked hurt: `onBlockedStatusChanged(true)`, `onLost`, a pause/stop, a
   `netErrors` entry for a static-host script or the main document.
5. Recovery on unblock: on a callback that makes `netOk()` true, or in
   `onResume`, if the current token is hurt and has no `boot`: settle 1 s;
   re-check resumed, `netOk()`, same token, the guards (no comments, no search
   open, keyboard not up, no menu/dialog, no custom view, no screenshot mode,
   an Instagram address); ask the page whether `#splash-screen` is still there
   (700 ms); if it is, or there's no answer, or the page is WebView's error
   page, one `reload()` through the same budget as the watchdog's.
6. The watchdog's clock counts only time that is resumed **and** `netOk()`.
   While blocked or offline it shows "No connection. SimpleGram will reload
   when you're back online" and leaves the reload to step 5.
7. The Data Saver tip shows once, only after a B33 event tied to a block (a
   hurt page, or an automatic reload with why `unblock`), when the status is
   ENABLED and the network is metered: "Data Saver is on, so Android cuts
   SimpleGram off the moment you switch apps. That can leave Instagram stuck
   on its logo. Let SimpleGram use data while Data Saver is on?" with
   **Open settings** (the intent above, else the manual path in a toast) and
   **Not now**. Re-read the status in `onResume` and on
   `ACTION_RESTRICT_BACKGROUND_CHANGED` (a registered receiver; it is a
   protected broadcast and can't be in the manifest).
8. `netErrors` (plan.md) keys each entry by host kind (main / static / media /
   api / other), the `net::ERR_*` name from `getDescription()` plus the code,
   and whether the app was blocked at the time. Expected signatures:
   `ERR_CONNECTION_REFUSED` and `ERR_NAME_NOT_RESOLVED` (Data Saver),
   `ERR_CONNECTION_ABORTED` (sockets destroyed), `ERR_HTTP2_PING_FAILED` /
   `ERR_QUIC_PROTOCOL_ERROR` (stale sessions). A start-up file with neither
   an error nor a completion is a stall.
9. Copy details gets a `net` block built natively: restrict-background status
   now and its changes, the default network now (transport, metered,
   validated, blocked) and `getActiveNetwork()==null` at copy time, the event
   ring, the resume-to-ok times, gate stats, `netErrors` by kind, and the
   tip's state.

## To reproduce later on the emulator (not done)

`adb shell cmd netpolicy set restrict-background true` on a metered network
(the emulator's cellular is metered), start a load, press Home within a
second, come back after 5–30 s; `dumpsys netpolicy`, `dumpsys connectivity`
and logcat ("network access blocked", "Total time waited for network rules")
show the block. `cmd netpolicy add restrict-background-whitelist <uid>`
separates Data Saver from the Android 15+ background chain (the sg29 image is
Android 10, so only the Data Saver part can be reproduced there).
