# Poster Aspect: what it costs and how to make it cheaper

**Date:** 2026-09-24, Jellyfin 12.1, branch `experimental`
**Status:** option A (the home-row cache) is **implemented** in
`scripts/posterAspect.js` and deployed. A single run of the final code matched
the prototype: scroll 479ms/s, streaming idle 86, home return 71 (style 16).
224 of 224 shared home cards came out the same size. The appendix keeps the
original prototype diff.

## Summary

- **Poster Aspect costs nothing at rest and nothing on the GPU.** It costs main
  thread time only while new rows arrive:

  | Abyss, headless Chromium, 3 runs each, ms per second | posterAspect on | off | cost |
  |---|---|---|---|
  | scrolling home (1200px/s) | 505 | 432 | **+73 (+17%)**, almost all style recalc (281 vs 210) |
  | idle while home sections still stream in at the bottom | 152 | 72 | **+80** |
  | returning to home | 79 | 69 | +10 |
  | scrolling a library | 74 | 57 | +17 |
  | series details | 57 | 52 | +5 |
  | first load, idle | ≈0 | | |

  The Default skin shows the same thing (scroll 493 vs 424).
- **The CSS on its own is free.** CSS-only matches off: 433. Almost all the cost
  comes from the script: script-only is 488.
- **Nearly all of the script's time is forced style recalculation.** Its reads
  make the browser style freshly inserted rows early, and then style them again.
  Nothing is measured twice, so an earlier de-duplication fix could not help.
- **A prototype that measures one home row and reuses the answer for the rest**
  gets most of the cost back, and draws identical cards:
  - scroll 466ms/s (style 232);
  - idle while streaming 76;
  - returning home 17 style (was 27);
  - **zero** forced reads while scrolling (was 187 reads, 807ms).

## How it spends the time

What happens per row, measured with a per-container trace during a 10s home
scroll (Abyss):

1. **Rows arrive already full.** The design comment in `posterAspect.js` assumes
   rows are measured "before they have cards". That holds for jellyfin-web's own
   builder. KefinTweaks' home builds each section off-document and inserts it
   whole, 16 to 48 cards at once.
2. The observer's first `getBoundingClientRect(container)` (`:436`) forces the
   browser to style and lay out that whole new section **without** `par-on`.
3. It adds two probes and reads them (`:560-563`): one more forced layout.
4. It writes `--par-h`, `--par-pad`, `--par-hb` and `--par-padb`, and adds
   `par-on` (`:593-611`). Every card in the row matches different rules now, so
   the section is **styled a second time** in the next frame.

In the trace, posterAspect initiated **86 forced recalcs touching 93,000
elements, 862ms in 10s**. That is as much as MUI's scroll handler (893ms) and
more than all frame-driven recalcs (704ms). The same pattern at the bottom of
home, where sections keep streaming in, is the +80ms/s idle cost: 17 forced
recalcs, 430ms per 10s.

Two things make most of that work unnecessary:

- **Every home row gets the same answer.** It depends on the skin and the
  viewport width, not on the row, because row cards are sized in `vw`:

  | skin | home rows | `--par-h` / `--par-pad` / `--par-hb` |
  |---|---|---|
  | Abyss | 22, all | 303px / 27px / 244px |
  | Default | 22, all | 316px / 18px / 249px |
  | ElegantFin | 26, all | 353px / 11px / 206px |

  Row widths were 2275 to 2298px and made no difference.
- **More than half the measured rows were skeletons.** 30 of 55 were measured,
  probed and then discarded when the real section replaced them.

Other pages are different. Detail pages hold rows with different answers: on
Abyss, a 336px row next to 303px ones; on ElegantFin, 237px next to 353px. So
per-container measurement stays right there. It is also cheap there: 5 reads
on a library, 32 on a details page.

Small items, measured and not worth a change on their own:
- the 100ms sweep re-queries the visible page after each batch;
- the `watchSkin` document observer;
- `publishColumnGap` (`:638`), which runs a `getComputedStyle` on grids only.

Together they are about 6ms/s while scrolling.

## Options

### A. Cache the home-row answer (prototyped, recommended)
- In `measureContainer`, after the skin checks:
  - if the container is a `.scrollSlider` inside `.homeSectionsContainer`, look
    up `skin signature | innerWidth`;
  - on a hit, write the four variables, `par-on` and the dataset markers, then
    return. There is no read, no probe and no forced layout.
  - The first home row on a page, and the first after a resize, measures as
    today and fills the cache.
- The prototype is about 25 lines. The cached rows are marked
  `data-par-cached`, so the settled-container fast path skips them in sweeps
  too.
- **Why it restores single styling:** a MutationObserver callback runs as a
  microtask, before the browser styles the frame. Once nothing in it forces a
  read, `par-on` and the variables are in place before the new section is
  styled even once.
- **Measured** (3 runs):

  | per second | current | prototype | off |
  |---|---|---|---|
  | home scroll | 505 | 466 | 432 |
  | streaming idle | 152 | 76 | 72 |
  | home return (style) | 27 | 17 | 15 |

  Library and details are unchanged, as expected. One of the three scroll runs
  was noisy (436 / 447 / 516).
- **Verified:** the same card sizes as the current code. 194 home cards present
  in both runs, 0 differing by more than 1px.
- **Risk:**
  - A skin that sized home row cards relative to the **row** rather than the
    viewport would need a row-width term in the key. No such skin was seen, and
    all three skins tested gave identical answers across 2275 to 2298px rows.
  - The cheap guard is to add the `.homeSectionsContainer` width, which a
    ResizeObserver can supply without forcing layout.

### B. Make it part of the KefinTweaks home sections (the idea you raised)
- `cardBuilder` would stamp `par-on` and the four variables onto the row's
  `itemsContainer` **while building it off-document**, taking the numbers from
  posterAspect through a small API, e.g. `KefinTweaksPosterAspect.homeRowVars()`.
  That returns the cached values, or null before the first row is measured.
- posterAspect's observer then ignores rows that arrive already marked.
- **Performance over A: small.** A already styles each section once. B also
  covers the case where something reads layout synchronously right after the
  insert, before posterAspect's microtask. In the trace, `cardBuilder.js`
  itself forced 8 recalcs (117ms) in 10s of scrolling, so the upper bound on
  B's extra gain is roughly that.
- **Costs:**
  - It couples `cardBuilder` to a feature that is off by default.
  - It needs A's cache anyway to have numbers to stamp.
  - It still needs the observer for jellyfin-web's pages: library grids, detail
    rows and the item cover.
- **Verdict:** worth doing only as a follow-up to A, if a profile after A still
  shows `cardBuilder` forcing layout on new sections. It is not a substitute for
  A.

### C. Skip skeleton rows
- Don't measure containers inside skeleton sections: 30 of 55 on the traced
  scroll.
- Redundant once A is in, because skeleton rows then hit the cache for free.
- Only useful if A is rejected.

### D. Trim the per-card CSS (the remaining +20ms/s)
- After A, home scroll style is 232 against 210 with posterAspect off. Library
  scroll carries a similar +11 (28 vs 17).
- That is the price of the rules applying to `par-on` cards. The chain
  `.par-on:not(.detailImageContainer) > .card.X:not([data-par-probe]) .cardPadder`
  is repeated across `.cardPadder`, `.cardScalable` and `.cardImageContainer`.
  Each card's width also comes from `calc(var(--par-h) * var(--par-ar))`.
- A leaner form: put a single marker on the card and use shorter child
  selectors.
- It is a restyle cost, so measure it first. At about 20ms/s it is the smallest
  item here.

### E. Leave it
- The cost is real but bounded: about 15% of home-scroll main-thread time, only
  while rows arrive, and nothing at rest or on the GPU.
- If the fans while scrolling are the concern, most of that load is rendering
  (see `docs/performance-investigation.md`, G*), which this does not touch.

## Recommendation

- **Do A.** It is small and local to `posterAspect.js`, keeps the
  sized-in-the-first-frame property, is measured to recover about 70% of the
  scroll cost and all of the streaming-idle cost, and doesn't change a pixel.
- Then re-measure before considering B or D.

## Method

- Headless Chromium over CDP, 2458x1310 at 1.25, Abyss, test user `claude`.
- Phases:
  - load 25s;
  - idle 15s;
  - smooth scroll at 1200px/s for 10s;
  - idle 10s;
  - library 15s and scroll 8s;
  - series details;
  - home again.
- Each variant was run 3 times. Variants block `posterAspect.js`,
  `posterAspect.css` or both by URL.
- An injected script wrapped `getBoundingClientRect`/`getComputedStyle`,
  `appendChild` of probes and custom-property writes, attributing each by stack.
- A trace with `devtools.timeline.stack` attributed each `UpdateLayoutTree` to
  its initiator.
- The prototype was served in place of the real file through CDP `Fetch`
  interception. The repo and the server were not touched.
- **Limits:**
  - Chromium only. The mechanism (styling a fresh section early, then again) is
    not engine-specific, but Firefox's numbers were not taken.
  - The home page's discovery sections are random per load, so runs differ in
    content. The ranges are shown.

## Appendix: the prototype (option A), as tested

Applied to `scripts/posterAspect.js` at commit `c981bda`. It is harness-only and was not committed.

```diff
--- a/scripts/posterAspect.js
+++ b/scripts/posterAspect.js
@@ -404,6 +404,7 @@
         widthObserver.observe(container);
     }
 
+    const homeRowCache = new Map();
     function measureContainer(container) {
         if (!skinReadyCached()) return false;
 
@@ -430,6 +431,23 @@
             }
         }
 
+        // PROTOTYPE: home rows share one answer per skin + viewport width.
+        const homeKey = (container.classList.contains('scrollSlider') && container.closest('.homeSectionsContainer'))
+            ? sig + '|' + window.innerWidth : null;
+        if (homeKey) {
+            if (container.dataset.parCached === homeKey) return true;
+            const hit = homeRowCache.get(homeKey);
+            if (hit) {
+                container.style.setProperty('--par-h', hit.h);
+                container.style.setProperty('--par-pad', hit.pad);
+                if (hit.hb) { container.style.setProperty('--par-hb', hit.hb); container.style.setProperty('--par-padb', hit.padb); container.dataset.parHb = '1'; }
+                container.dataset.parSkin = sig;
+                container.dataset.parCached = homeKey;
+                container.classList.add(ON_CLASS);
+                return true;
+            }
+        }
+
         // Inside Jellyfin's .hide the answer is 0 wide; get it without forcing
         // layout. The sweep retries once the section is shown.
         if (container.closest('.hide')) return false;
@@ -606,6 +624,11 @@
             container.style.removeProperty('--par-padb');
         }
         delete container.dataset.parReject;
+        if (homeKey) {
+            homeRowCache.set(homeKey, { h: container.style.getPropertyValue('--par-h'), pad: container.style.getPropertyValue('--par-pad'),
+                hb: container.dataset.parHb ? container.style.getPropertyValue('--par-hb') : '', padb: container.style.getPropertyValue('--par-padb') });
+            container.dataset.parCached = homeKey;
+        }
         container.dataset.parAt = String(width);
         container.dataset.parSkin = sig;
         container.classList.add(ON_CLASS);
```
