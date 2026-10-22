# Batch 4: decisions that settle conflicts between the plans

The B16/B17/B18 diagnoses and the R5–R7 feasibility notes were written
separately and disagree in places. A fresh review before the build found these
conflicts; this is how they are resolved. Where this file and a diagnosis
note differ, this file wins.

1. **One anchor rule, one function (B17 + B18).** A feed's first page is never
   handed to Instagram empty. `anchorFirstPage(fs, list, verdicts)` runs once
   in `filterFeedList` after the verdict loop, gated on `!fs.shownAny`,
   `keptMedia === 0` and `hasMore(owner)`. Tiers, in order:
   - **seen:** put back the page's *oldest* already-seen post (last in list
     order; it sits next to the first new post). Count it in `keptMedia` so the
     follow-suspect fail-open can never arm on that page.
   - **marker:** keep Instagram's own "caught up" marker, neutralised
     (`group_set.groups = []`, `active_group_id = null`). The native card then
     shows without Instagram's subtitle, so the line isn't drawn twice.
     `has_next` false, unless R7's continuation is on (then left true).
   - **recs:** a Home first page of suggestions with no marker (B18 review case
     R2): keep the first dropped explore_story unit (never an ad), hide it by
     code before paint, leave `has_next` as sent, and run the scroll room and
     nudges so page 2 (with the marker) arrives. Count `anchorKind`.
   The **recs** tier is provisional and needs the on-device check before release.
   B18's "newest seen" wording is superseded.

2. **R5 (the Favorites star) ships only with a working recs anchor.** Star
   round trips reload Home from its first page, which is exactly the shape that
   blanks today. If the recs tier doesn't pass on the phone, R5 slips to the
   next release; the rest of batch 4 ships.

3. **One Home-tab dispatcher** in the capture click listener, for a trusted tap
   on an `a[href="/"]` while `route()` is home, search is closed and no result
   is opening:
   - variant **home** → B16: scrolled down, swallow the tap and scroll to the
     top; at the top, let Instagram refresh (its own 30 s rule).
   - any **other variant** → R5: stop the tap, cancel a pending open, full load
     of `/`.
   B18 fix 3 (a full load when the address switches feeds in-page) stays only
   for the logo menu and Back over Instagram's own entries. Counters:
   `homeTapTop`, `homeTapRefresh`, `homeFull` (bar / header), `switchLoads`.
   B16's planned test "the Home tab on ?variant=following is not swallowed" is
   replaced by "the Home tab on ?variant=following is a full load of /".

4. **Posts seen on Home are recorded by feed, not by the address** at parse
   time (a Home page that lands while a Story or post is open). Done in the
   pre-batch audit; B18 fix 2 and R7 item 5 refer to that change.

5. **R6 and the on-device tests.** The card is found by its content description
   "End of Home" (done in the audit). With R6, the tests assert Following is
   present and Favorites absent; add a case for B17's `skipStatus` message
   ("Skipping N posts you saw in Home…") and one that a `feedEnd` with `on:true`
   is ignored on `?variant=following`.

6. **R4 scope.** SimpleGram's own grids (Posts & Reels, Tags, Places) lose the
   3-tap cap: every page still needs a tap. Instagram's own search page (the
   "Open Instagram's own page" fallback) keeps `limitSearch` at 3 pages, because
   it loads by itself. Places ask for 24 a page; when a page brings fewer than
   18, one tap chains a second page. README and the R1 row change in the same
   commit.

7. **R8 / R9 / B19 wait for one fact.** Instagram's mobile Story viewer asks the
   browser for full screen, which the app answers with `onShowCustomView`.
   If Stories really run inside that view on the phone, R9 (a nested full-screen
   request from a Story) collides with the "refuse while one is active" guard,
   and B19's suspects (zoom layer, swipe guard) are out of the touch path.
   Full-screen counters were added to Filter status in the audit; design R8/R9
   and investigate B19 after the next Copy details shows whether Stories go
   full screen. Whatever the answer, the guard must never cancel the current
   view when a nested request arrives.
