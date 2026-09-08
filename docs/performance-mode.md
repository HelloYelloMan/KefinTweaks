# Performance Mode

**Skin option:** *"Performance Mode (skip offscreen home rows)"* — Display settings → Optional Includes
**File:** `skins/optional/global/chromiumPerf.css`
**Default:** enabled
**Applies to:** Chromium-based browsers only (Chrome, Edge, Opera, Brave, Vivaldi, Helium, …)

---

## What it does

Adds `content-visibility: auto` to off-screen home-screen rows so the browser can skip
style, layout and paint for them entirely.

```css
html.kefin-blink .homeSectionsContainer > .verticalSection.emby-scroller-container {
    content-visibility: auto;
    contain-intrinsic-width: auto none;
    contain-intrinsic-height: auto var(--kefin-home-row-height, 420px);
}

html.kefin-blink .homeSectionsContainer > .spotlight-section {
    content-visibility: visible;
}
```

That is the whole option. It changes no colours, no spacing, no animations.

## Why it exists

Style recalculation dominates Chromium's cost on the KefinTweaks home screen.

A single card is **30 DOM nodes carrying 80 class names**, so a home screen is roughly
**9,000 nodes** and a library grid after scrolling around **30,000**. Profiling a
12-second home-screen scroll in Chromium measured:

| | |
|---|---|
| main thread busy | 88.6% |
| `UpdateLayoutTree` (Recalculate Style) | **6,925 ms — 56% of the trace** |
| `Paint` | 145 ms |
| `Layout` | 32 ms |
| element restyles | **1,395,731** |

Paint and layout are nearly free. The cost is the browser re-matching selectors against
the accumulated card tree as new cards stream in.

This is much worse in Chromium than in Firefox for an architectural reason: Firefox's
style engine (**Stylo**) computes style **in parallel across CPU cores**, while Blink does
it **serially on the main thread** — the same thread that runs JavaScript and delivers
`IntersectionObserver` callbacks. In Chromium, style cost therefore also delays the
observer callbacks that *start image requests*, which is why heavy style work shows up as
slow-loading card artwork.

`content-visibility: auto` is the only mechanism that **removes** that work rather than
moving it around.

## The trade-off — read this

Content inside a skipped subtree has no boxes, so `IntersectionObserver` reports it as
**not intersecting**. KefinTweaks lazy-loads card artwork with an `IntersectionObserver`
using a 2000px `rootMargin`, and that lead time is what hides image latency. Chromium
decides "relevance" for `content-visibility` on a much tighter margin (roughly half a
viewport), so a row can stay skipped until well inside that 2000px window.

**Scrolling gets smoother; card artwork may start loading later.**

If images begin popping in visibly late, this option is the cause — turn it off.

## Implementation notes

### The placeholder height is measured, not guessed

`contain-intrinsic-height` needs a placeholder size for skipped rows. A hard-coded value
is wrong for most layouts, because row height depends on viewport width and card format —
and **every wrong placeholder shifts the rows below it**, which is visible as the spacing
between rows changing as you scroll.

So `scripts/cardBuilder.js` measures a real rendered row with a `ResizeObserver` and
publishes `--kefin-home-row-height` on the container (`publishHomeRowHeight()`). A
`ResizeObserver` reports a size the browser has already computed, so this costs **no
forced layout** — unlike `getBoundingClientRect()`. It re-publishes on viewport resize.

`420px` in the CSS is only a bootstrap value for the first paint, before any row has been
measured.

### Only the block axis is constrained

`contain-intrinsic-size` with a single value sets **both** axes. That would give skipped
rows a 420px intrinsic *width*; rows are stretched flex items, so width must be left
alone. Hence the `contain-intrinsic-width: auto none` longhand.

### `auto` matters

`auto` makes the browser remember each row's real rendered size and prefer it over the
placeholder, so the fallback only ever applies to a row that has never been on screen.
Without it, expect visible scrollbar jitter.

### The spotlight is excluded

It is full-bleed, normally on screen anyway, and runs its own animations. Skipping it
buys nothing and risks a flash on load.

## Why it is a global option, not a per-skin one

Nothing here is tied to a particular skin. Every selector it uses comes from either
Jellyfin core or KefinTweaks itself:

| Selector / value | Defined by |
|---|---|
| `.homeSectionsContainer` | Jellyfin core |
| `.verticalSection.emby-scroller-container` | KefinTweaks — `cardBuilder.js` builds the row |
| `.spotlight-section` | KefinTweaks |
| `--kefin-home-row-height` | KefinTweaks — `cardBuilder.js` publishes it |
| `html.kefin-blink` | KefinTweaks — `injector.js` sets it |

So it applies under any skin, or none, and is registered in `globalOptionalIncludes`.

Earlier revisions *were* skin-specific: they overrode ElegantFin's `--blurLarge`,
`.ef-btn-hover` and `.itemProgressBar` rules, and would have belonged under the ElegantFin
skin entries. Those overrides were removed (see the last section), and with them the only
reason this had to be skin-scoped.

## Engine gating

`injector.js` detects the engine before any script or skin CSS loads and sets:

- `html.kefin-blink` — the class this stylesheet is scoped to
- `window.KefinTweaksIsBlink` — for JS

Detection prefers `navigator.userAgentData.brands` (only Chromium engines list
`"Chromium"`), falling back to user-agent matching. Firefox-family and WebKit/Safari are
excluded — Safari is a different engine with different costs, not a Blink variant.

Gating is set this early so the rules apply on the **first paint**. A rule that changes
layout and arrives late causes a visible shift.

Two JavaScript behaviours are gated the same way, both in `scripts/cardBuilder.js`:

| Behaviour | Chromium | Others |
|---|---|---|
| lazy-image `rootMargin` | `2000px` | `800px` |
| `img.fetchPriority` | `'high'` | unset |

An `Image()` that is never inserted into the document is treated as a speculative load by
Chromium and given **Low** priority — in one profile *all 238* card-image requests came
back Low while every API call was High. Firefox does not deprioritise them, so it needs
neither change, and the wider margin costs extra concurrent requests for no benefit
there.

## Turning it off

Display settings → Optional Includes → untick **"Performance Mode (skip offscreen home
rows)"**. It takes effect immediately, with no redeploy.

Because it is a registered optional include, it can be A/B'd inside a single session,
which is the cleanest way to judge the scrolling-vs-image-loading trade-off on your own
library and hardware.

## What this option is *not*

Earlier revisions of this file also overrode `backdrop-filter`, `transition: width` and
bare `transition: all` shorthands. Those were **removed**: profiling showed `Paint` was
only 145 ms of a 6,925 ms style-dominated trace, so they targeted roughly 1.5% of the
problem while costing real visual fidelity (card widths snapped instead of animating,
hover blur was lost). The theme's own styling is used for all of that now.

The larger performance wins are **not** in this option and are always active, because
they are free — no visual or behavioural change:

- memoising Jellyfin Enhanced's `getSidebarContainer()` (`scripts/jeSidebarMemo.js`) — it
  read `offsetParent`, a forced full-document style flush, on every DOM mutation
- replacing the home-screen infinite-scroll `scrollHeight` poll with a sentinel
  `IntersectionObserver`, and fixing a `scroll` listener that leaked once per home visit
- batching the per-section scroll-button measurement so 22 forced flushes became 1
- deleting a body-wide `MutationObserver` that only called a function that returned
  immediately
- replacing document-scope and per-card `:has()` selectors with marker classes and
  ancestor scoping
