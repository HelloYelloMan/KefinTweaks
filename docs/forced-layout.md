# Forced Layout in MutationObservers

**Files:** `scripts/posterAspect.js`, `scripts/skinManager.js`
**Status:** fixed and always active — no option, no visual change
**Applies to:** all engines, but the cost is **much worse in Chromium**
**Commits:** `ba6a8cd` (batching), `f1a6bfb` (ResizeObserver)

---

## The pattern

A `MutationObserver` that walks `addedNodes` and measures something for each one.

`posterAspect.js` did exactly this. Its observer resolved every inserted card to its
**parent** container and measured that container immediately:

```js
// before
for (const r of records) {
    for (const n of r.addedNodes) {
        containersIn(n).forEach((c) => { measureContainer(c); any = true; });
    }
}
```

Cards stream into a row one at a time, so a row receiving N cards was measured N times.
`measureContainer()` opens with a `getBoundingClientRect()` — a **forced synchronous
layout** — plus two document-wide `querySelectorAll`s asking questions about the
*document*, not about the container.

The file has an "already measured" guard, and it works. But it only fires **after** those
three calls, so every repeat still paid for them. The waste was invisible to reading: the
guard makes the code look like it measures once.

Counted on a 276-card home screen:

| call | count |
|---|---|
| `getBoundingClientRect` — `measureContainer` | **883** |
| `document.querySelectorAll` — `skinReady()` | **883** |
| `document.querySelectorAll` — `skinSignature()` | **427** |
| `element.querySelectorAll` — `containersIn()` | 1,394 |

**3,642 of the page's 7,161 DOM calls came from this one 580-line file.**

## Why Chromium suffers more

Two reasons, both structural.

**Blink computes style serially on the main thread.** Firefox's Stylo engine parallelises
style across cores; Blink does not. See [performance-mode.md](performance-mode.md) for the
measurements — style recalculation is already the dominant cost on this page in Chromium,
and forced layout drags a style recalculation along with it.

**A forced read mid-scroll is far more expensive than one on a settled page.** This is the
part that matters, and it is why the same code looked harmless on load and was crippling
during a scroll. `getBoundingClientRect()` must return a correct answer, so the browser
flushes whatever style and layout is pending first. On a settled page almost nothing is
pending and the read is nearly free. While scrolling — with cards streaming in and
`content-visibility` rows flipping in and out — layout is dirty continuously, so *every*
read forces a full flush.

Measured on the same code, same page:

| | forced reads | cost each |
|---|---|---|
| home load | 883 | ~0.1 ms |
| home scroll | — | **~6.7 ms** |

In a pre-fix scroll profile, `posterAspect.js` accounted for **~7.1 s of a 15.9 s trace**:
3,130 ms in `getBoundingClientRect`, 2,206 ms in `skinReady`, 1,730 ms in `skinSignature`.

## What was fixed

### 1. Measure each container once per batch

Collect the batch's containers into a `Set`, then measure each one once.

```js
// after
const targets = new Set();
for (const r of records) {
    for (const n of r.addedNodes) {
        containersIn(n).forEach((c) => targets.add(c));
    }
}
if (!targets.size) return;
inBatch(() => targets.forEach(measureContainer));
```

This keeps the property the observer exists for — the container is still sized in the same
synchronous pass, before the frame paints — while doing it once instead of N times.
`sweep()` had the same shape and got the same treatment.

`inBatch()` memoises `skinReady()` and `skinSignature()` for that one synchronous pass.
Both ask about the document, so within a batch the answer cannot change; nothing in the
callback inserts a stylesheet (the measuring probe is a `div`). **Caching either for longer
would be a bug** — `watchSkin()` compares a *fresh* `skinSignature()` against
`dataset.parSkin` to detect a real skin switch, so it deliberately still calls the uncached
form.

### 2. Resolve the default skin name

`skinSignature()` read `localStorage['kefinTweaks_selectedSkin']` directly. But
`skinManager` only writes that key when a user picks a skin **explicitly** — everywhere
else it resolves `localStorage.getItem(KEY) || getDefaultSkinName()`.

So for everyone on the default skin the read returned `null`, and both callers took their
fallback path:

- `skinSignature()` fingerprinted the skin's stylesheet **hrefs** — a list that changes
  several times while optional includes load, which is precisely the instability the
  name-based signature was introduced to avoid.
- `skinReady()` stopped waiting for the skin at all and returned `true` immediately,
  measuring against Jellyfin's default CSS.

`skinManager` now exposes `getSelectedSkinName()`, which resolves the default. It
deliberately does **not** call `getDefaultSkinName()`, because that logs on every call and
this is called from an observer batch.

### 3. Take widths from a ResizeObserver

The guard needs a current width, and `getBoundingClientRect` forces layout to get one. A
`ResizeObserver` reports the width the browser **has already computed**, so the guard costs
nothing. Only a container with no reading yet still falls through to a real measurement.

Two details that are easy to get wrong:

- **Border box, not content box.** `applyPickerSlack()` writes `padding-right`; observing
  the content box would make the observer retrigger on its own write. The border box does
  not move for padding, and it is also what `getBoundingClientRect` reports, so the cached
  value stays directly comparable to `dataset.parAt`.
- **`tracked` is a `Set`, not a `WeakSet`.** `ResizeObserver` holds its targets
  **strongly**, so containers detached by a page change would be kept alive by the observer
  regardless. Holding them somewhere iterable is what lets `sweep()` unobserve the
  disconnected ones.

## Results

Call counts, 276-card home screen:

| | before | after batching | after ResizeObserver |
|---|---|---|---|
| `getBoundingClientRect` (load) | 883 | **89** | 89 |
| `skinReady` document queries | 883 | **25** | 25 |
| `skinSignature` document queries | 427 | **0** | 0 |
| `getBoundingClientRect` (scroll) | — | 331 | **123** |

Time inside this file's observer callback:

| | before ResizeObserver | after |
|---|---|---|
| load | 508 ms | **301 ms** |
| scroll | 2,205 ms | **1,159 ms** |

Home scroll, end to end:

| | before both fixes | after |
|---|---|---|
| script time | 4.35 s | **0.19 s** |
| task time | 13.73 s | **5.28 s** |
| long tasks | 60 (9,424 ms) | **19 (1,357 ms)** |
| worst task | 499 ms | **107 ms** |

## What did *not* improve — read this

**Style recalculation on load did not move.** 1.92 s / 595 recalcs before, 2.00 s / 598
after (mean of 3 matched runs, same 276 cards). Script time fell 34%, and that is the whole
gain on load.

Blocking `posterAspect.js` entirely *does* save ~1 s of recalc, and it is tempting to read
that as the cost of the redundancy. It is not. That second is the cost of what the file
**does** — setting `--par-h`/`--par-pad` and adding `par-on` brings `posterAspect.css`'s 284
rules to bear on every card. It is inherent to the feature and survives any amount of
batching. *Blocking a file and fixing a file are different experiments.*

**The ResizeObserver change did not clearly improve end-to-end scroll timings** (task
5.28 s → 5.35 s, recalc 3.23 s → 3.16 s), and that run loaded 19% more cards so the
comparison is not matched. The synchronous work is provably gone; whether it makes
scrolling *feel* better is unproven here. The likely reading is that the layout still
happens, just in the frame rather than in the callback — better for responsiveness in
principle, but not something this harness demonstrated.

## A false lead — do not refactor this

Seven other observers re-query every inserted node, three of them for the *same*
`.cardOverlayContainer` selector:

| file | selector |
|---|---|
| `homeScreenPin.js` ×3 | `.actionSheetContent`, `.cardOverlayContainer`, `.card[data-id]` |
| `cardBuilder.js` ×2 | `.cardImageContainer[data-src]`, `canvas.blurhash-canvas[…]` |
| `watchlist.js` | `.cardOverlayContainer` |
| `playlist.js` | `.cardOverlayContainer` |

That is ~3,000 queries per home load and ~2,000 per scroll. It looks alarming and it is
**not worth fixing**. Timed per observer callback, all seven together cost **~14 ms on load
and ~11 ms on scroll** — against `posterAspect`'s 508 ms and 2,205 ms. Each query runs
against a single card subtree, so each is microseconds.

The lesson: **count and cost are different units.** A query count tells you nothing about
time until you measure the time.

## How to re-measure

Counting beats profiling here, because sampled self-time attributes to the *native*
function, not the caller — `getBoundingClientRect` shows up as a hot native with no
indication of who called it.

Wrap the natives before any page script runs (via CDP
`Page.addScriptToEvaluateOnNewDocument`) and bucket calls by `new Error().stack`:

```js
const orig = Element.prototype.getBoundingClientRect;
Element.prototype.getBoundingClientRect = function (...a) {
    counts[site()] = (counts[site()] || 0) + 1;
    return orig.apply(this, a);
};
```

For per-observer cost, wrap `MutationObserver` itself and time each callback, attributing
it to the site that constructed the observer. That is what produced the 508 ms / 2,205 ms
figures above, and it is the measurement that settled the false lead.

Note that `ScriptDuration` in Chrome's own metrics **excludes** the layout a forced read
triggers — which is why script time fell to 0.19 s while the observer callback still cost
1,159 ms of wall clock.
