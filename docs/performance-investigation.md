# Performance investigation: what to look at

**Date:** 2026-09-24, Jellyfin 12.1, branch `experimental`, Abyss skin, modern layout
**Trigger:** the fans ramp up while browsing Jellyfin, mostly scrolling home, in
Zen and in Chromium. The machine has a 4K 240Hz monitor (scale 1.25) and an RTX 5080.
**Status:** investigation only. Nothing in this document has been changed yet.

> **Read first:** idle fan noise on the same day came from **Zen itself**, not
> Jellyfin. Zen's parent process main thread was stuck at 98%, with its Timer
> thread at ~107k wakeups/s. The Jellyfin tab was at 0.5% CPU, and Helium on the
> same page used 12% in total. Restarting Zen cleared it. Before working any
> lead below for an *idle* complaint, run `top -H -p <zen parent pid>`: a busy
> `zen-bin` thread means the browser. The leads below are about the page's own
> cost while scrolling and animating.

This is a list of leads, ranked, each with the evidence and the experiment that
would settle it. Items marked **measured** have numbers behind them from this
session. Items marked **code** were found by reading the source and still need a
measurement.

---

## 1. What was measured

### GPU (real Zen window, `nvidia-smi` sampled every 200ms, smooth downward scroll)

| page | GPU busy | clock / power | frame rate |
|---|---|---|---|
| plain text page, nothing on it | 28% | 2338MHz / 67W | 239fps |
| home as it is | 70%, peaks 97% | 2728MHz / 89W | ~190fps |
| home, all blur/filter/shadow/animation off | 57% | 84W | 211fps |
| home, also images and border-radius off | 53% | 76W | 213fps |
| home, idle | ~20%, **peaks 98%** | 68W | — |

- Just redrawing a 4K screen 240 times a second costs 28%. That floor is set by
  the display, not by Jellyfin.
- The effects that can be switched off account for about 15 points. The rest is
  page size: hundreds of cards and images.
- **Caveat that affects the first round of numbers:** while the Media Bar's
  progress animation runs, Zen caps the page's rAF at **60fps**. Every
  single-effect toggle measured *without* cancelling that animation (noBackdrop,
  noFilter, kill:kenBurns…) was really a 60fps measurement. Those toggles showed
  no difference, and that result is **not trustworthy**. Only the rows above
  were uncapped. See lead G5.

### Main thread (headless Chromium, 2458x1310 at 1.25 scale, per second of wall time)

Tasks are ms/s of main-thread work; style is the part of that spent recalculating
style. Each variant blocks one thing by URL. `noKT` also removes the skin, because
KefinTweaks loads it.

| phase | full | noKT | noJE | noMBE | noPlugins | Default skin |
|---|---|---|---|---|---|---|
| home, idle | 33 | 23 | 33 | **12** | 6 | 28 |
| home, scroll 1200px/s | **555** (style 318) | stock home¹ | 488 (269) | 565 (332) | stock home¹ | 513 (238) |
| home, idle at the bottom after scrolling | 133 | — | 162 | 161 | — | 151 |
| library, scroll | **203** (style 120) | 44 (1) | 64 (20) | 116 (49) | 34 (0) | **54** (7) |
| series details, load | 56 | 35 | 45 | 54 | 31 | 53 |

¹ Without KefinTweaks, home is jellyfin-web's short stock page, so its scroll
number can't be compared.

What these numbers say:
- **Home scroll** costs about the same on the Default skin (513) as on Abyss (555).
  So it is KefinTweaks' home page, and everything that reacts to it, not the
  skin. The DOM grows from 5.7k to 19.6k nodes as sections stream in.
- **Library scroll** goes from 203 to 54 by switching skin, and to 64 by removing
  Jellyfin Enhanced. It is an interaction: JE's tags change cards, and the Abyss
  CSS makes restyling a card expensive.
- **Home idle** drops to 12 with Media Bar blocked. In two of six runs, idle home
  after a round trip ran **57 style recalcs/s**, one per frame. This happened
  only with Media Bar present and was not reproduced in a targeted run. See C4.

### Structure of the home page (headless Chromium, settled)
- **753 composited layers** (425 drawing, ~16 viewports of layer area at the
  top of home). Cancelling the **8 finished** `abyss-section-fade-up` animations
  cut that to **301** (198 drawing). See G1.
- Media Bar: 8 slides, each with 3 full-hero `mask-image` layers
  (`.backdrop-container`, `.backdrop-overlay`, `.gradient-overlay`), all
  present at once.
- Images are fine on cards (decoded ≈ 1.2x shown). Media Bar logos decode 12MP
  to show 2.6MP.
- Series details with a theme video: `filter: blur(23px) saturate(1.2)` on a
  full-viewport **playing** `<video>`.

### Load
- 471 script responses on one sign-in and home load: jellyfin-web 88 files,
  **Jellyfin Enhanced 153 files (~1MB)**, **KefinTweaks 71 files (~1.3MB)**,
  plus a **155KB** inline `KefinTweaks-Config` from the JS Injector.
- 592 requests by the time home settles.

---

## 2. GPU leads (the fans)

### G1. Abyss section fade-up keeps ~450 layers alive forever. Measured.
- **Where:** `abyss.css:2840-2870`:
  `.verticalSection:nth-child(n) { animation: abyss-section-fade-up 0.7s … both }`.
- **Why:** `fill-mode: both` keeps the finished animation in effect, so Chromium
  keeps each section on its own compositor layer. Cards overlapping those layers
  get promoted too ("Overlap"). The animation also restarts on every skeleton →
  real `replaceWith`.
- **Measured:** 753 → 301 layers after cancelling 8 finished animations.
- **Experiment:**
  1. In `abyss-kefin.css`, add
     `.homeSectionsContainer > .verticalSection { animation-fill-mode: backwards !important }`.
     The alternative is `animation: none`, which Abyss Lite already does.
  2. Count layers again.
  3. Re-run the Zen GPU probe uncapped.
- Firefox layerizes differently, so the Zen number is the one that matters.

### G2. Media Bar hero never stops animating. Code + measured.
- **What runs:**
  - `kenBurnsZoomIn`: 10s, `will-change: transform`, on a full-width backdrop
    `<img>`. The next slide comes after 7s, so it never finishes.
  - The progress bar animation: always running.
  - All of this sits under three full-hero masked layers per slide.
  - `mediaBarEnhanced.css:28-64, 379-464, 2875-2940`; JS at `:4884` and
    `:4965-5040`.
- **Measured:**
  - Idle GPU spikes to 98%.
  - Zen caps rAF at 60fps while it runs.
  - Blocking Media Bar takes idle home from 33 to 12ms/s.
  - Zen scroll: noMediaBar 60% vs 70%.
- **Trailers:** the defaults allow full-width trailer backdrops (YouTube iframe,
  no quality cap). That is 4K video decode at idle. Check whether any are
  present: `document.querySelectorAll('#slides-container iframe, #slides-container video')`.
- **Settings (no code):** Media Bar Settings → *Enable Animations*
  (`slideAnimations`), *Show Progress Bar*, *Video Backdrops*, *Sync Page
  Backdrop*.
- **Experiment:** in a real Zen window with `nvidia-smi dmon -s pu`, turn these
  off one at a time on idle home, then while scrolling.

### G3. Abyss glass over scrolling content. Code.
- **App bar** (`abyss.css:494, 522, 541, 420, 453, 2621-2636`):
  - `blur(15px)` on the header `::after`: fixed, full width, masked. Library
    pages only.
  - The same blur on the nav pill and on every header IconButton.
  - Cards scroll underneath, so each frame re-blurs about 8-12 regions, nested.
- **Per-card blurs `noBadgeBlur.css` misses:**
  - `.itemProgressBar { backdrop-filter: blur(4px) }` on `#indexPage`,
    `.libraryPage` and `#itemDetailPage` (`abyss.css:2655-2660`). That is one
    per Continue Watching card and per partly watched card.
- **Media Bar pills** (`abyss-mbe.css`): blur(8px) on the counter, ratings,
  runtime and date, plus the favourite and detail buttons. **Ours** adds
  `#slides-container .watchlist-button` at `abyss-kefin.css:79`. These re-blur
  whenever the slide underneath moves (G2).
- **Experiment:** toggle each group with `backdrop-filter: none !important` in a
  real Zen window, **with the progress bar paused** so the measurement isn't
  capped at 60fps.
- **Direction:**
  - Extend `noBadgeBlur.css` with `.itemProgressBar`.
  - A "No glass" Abyss option for the app bar and the Media Bar pills.

### G3b. jellyfin-web's own page backdrop, blurred at 4K. Code; check first.
- **What:** home is a `backdropPage`. When the user's *Backdrops* display
  setting is on, jellyfin-web rotates random backdrops into `.backdropContainer`:
  fixed, full viewport, requested at `maxWidth = screen width`, which is
  3840px.
- **The skins:**
  - Abyss blurs it: `.backdropImage { filter: blur(23px) saturate(120%) contrast(120%) brightness(25%) }`
    (`abyss.css` ~780 on the CDN copy).
  - ElegantFin draws it three times: base, a 110% `blur(20px)` `::before`, and
    a masked `::after`. All of that sits under a 90%-opaque container.
- The headless test user has backdrops off, so this was **not** in the
  measurements. Check the real browser:
  `document.querySelector('.backdropContainer .backdropImage')`.
- **Experiment:** measure GPU with `unblurredBackdrop.css` on and then off. Then
  `ab('html:not(#_) .backdropContainer{display:none!important}')` (helper in §6).
- **Direction:** request a ~800px backdrop when it will be blurred; at 25%
  brightness it looks the same. Or default the unblurred option on.

### G4. Full-screen blur on a playing theme video (ours). Code + seen.
- **Where:** `skins/abyss-kefin.css:208`:
  `.kefin-theme-video { filter: blur(var(--abyss-backdrop-blur)) … }`, which is
  23px at full viewport. The blur is recomputed for every video frame, on top of
  4K video decode. `themeMediaCastFix.js` `syncPageTransparency` also makes the
  page transparent over it.
- Also:
  - `abyss.css:2663`: a full-viewport `backdrop-filter` on the background while
    the now-playing bar is up.
  - `abyss.css:761`: the static backdrop blur.
- **Experiment:** measure GPU on a series page with a theme video, with the
  *Unblurred Backdrop and Theme Video* option on and then off.
- **Direction:** blur a downscaled copy, or default the unblurred option on.

### G5. 240Hz itself
- A plain text page costs 28% to scroll at 4K and 240Hz. Every cost above is
  multiplied by the refresh rate.
- **Experiment:** set `layout.frame_rate` = 120 in Zen's `about:config`, then
  re-measure. This is a browser-wide setting, not a Jellyfin fix. It gives the
  baseline for judging everything else.

### G5b. Per-card paint and hover. Code.
- **Abyss** (`abyss.css`):
  - `border-radius: 12px` on about 10 parts of every card (~1779-1817);
  - an inset shadow on every `.cardImageContainer` (~1047);
  - `.cardText { opacity: .8 }`, 2-3 opacity groups per card (~311);
  - a `filter` on every blurhash canvas (~922).
- The images-and-radius-off Zen run put the whole group at about 4 points.
- **Hover while wheel-scrolling:** with the pointer parked over the grid, every
  card that slides under it fades its overlay in and out. That is a .37s
  transition on 4 properties, plus the full-card dark overlay (`abyss.css`
  ~2457, ~2800-2817).
  - The harness never has a pointer over the page, so this was **not**
    measured.
  - **Experiment:** scroll once with the pointer outside the window and once
    over the cards.
- **ElegantFin:** a card `box-shadow`, hover `scale(1.02/1.025)` with transitions,
  and `transition: .5s` on all overlay properties. KefinTweaks' *Disable Card
  Hover Effect* removes only the sweep, not the scale.

### G6. Images
- Media Bar logos: 1200x185 decoded for 1225x189 shown, 8 of them, 12MP decoded
  vs 2.6MP shown. Backdrops are requested at original size with no `maxWidth`
  (`mediaBarEnhanced.js:3899`).
- Low priority. Card images are sized correctly.

---

## 3. Main-thread leads

### C1. Home scroll: 555ms/s, 318 of it style recalc. Measured.
Contributors found by instrumenting every observer, timer and listener, grouped
by the script that created it:

| source | while scrolling | notes |
|---|---|---|
| jellyfin-web MUI `useScrollTrigger` | 123ms/s | Reads `pageYOffset` on every scroll event, which forces pending style and layout. It *pays for* the others' DOM changes; it isn't the cause. |
| `posterAspect.js` document observer | **38 calls/s, 101ms/s, up to 76ms each** | Forced layout per new section (`getBoundingClientRect` at `:436`, probe cards `:560-563`). A 100ms sweep over every card on the page (`:703-722`). Rejected and zero-width containers are re-measured on **every** sweep because the check at `:527` comes after the read. `getComputedStyle` per measure in `publishColumnGap` (`:638`). |
| `cardBuilder.js` IntersectionObservers | 18/s, 19ms/s | 925 `observe()` calls per 10s scroll, 1412 in total. Targets are only released on image load, so clipped and replaced cards stay observed (`:6674, 6766-6788`). Spotlight `visibilitychange` listener added per render and never removed (`:5135`). |
| JE `dom-observer.js` / `item-details-info` | 107 calls/s, 14ms/s | Whole document, `attributeFilter: ['class','style']`. Debounce called once **per record** (`features-details-page.js:299-317`). 980 timers in 15s on a details page. No setting turns it off. |
| `utils.js` customMenuLinkObserver | rAF per mutation batch | Failing whole-document `querySelector`s for the drawer and `.customMenuOptions`, plus remove/add of `active` on the nav links, every frame while the DOM changes (`:1640-1658`, `:1602`). |
| `hamburgerMenu.js` | rAF per mutation batch | A whole-document `querySelectorAll` per frame (`:704-716`), even after the button exists. |
| ~15 whole-document subtree observers | small each | posterAspect ×2, cardBuilder, utils, hamburgerMenu, elegantfin-haspatch, specialEpisodePrefix, homeScreenPin ×2, watchlist ×3 (one watches **every class change**, `:7109`), removeContinue, playlist, pauseScreen. JE and Media Bar add their own. |

- **posterAspect has since been measured in detail:** see
  `docs/poster-aspect-performance.md`. It costs +73ms/s on home scroll, net of
  what would happen anyway. A home-row cache prototype recovers most of that
  without changing any card sizes.
- **Experiment:** repeat the instrumented scroll with each of the others
  disabled.
- **Direction:**
  - posterAspect: move the reject check before the read, and skip the sweep
    unless a container lacks `par-on`.
  - One shared, page-scoped mutation dispatcher.

### C2. Library scroll: Abyss CSS × card mutations. Measured.
- 203ms/s on Abyss vs 54 on Default. JE removed: 64.
- Suspects, all in `abyss.css`:
  - `body:has(#videoOsdPage:not(.hide)) …` (`:462`),
    `body:has(.nowPlayingBar:not(.hide)) …` (`:2663`) and
    `body:has(#videoOsdPage) …` (`:1937`). These have the same whole-document
    `:has()` shape we removed from our own CSS, which measured about 40% of
    home-scroll recalc then (`utils.js:2513`).
  - `.homeSectionsContainer .verticalSection:has([data-type="CollectionFolder"]) .cardText`
    (`:929` in the local clone, `:949` on the CDN). Every card carries
    `data-type`, so every card insertion re-checks its whole section. The
    equivalent without `:has()` is `.card[data-type="CollectionFolder"] .cardText`.
    An override in `abyss-kefin.css` cannot remove the invalidation; it needs a
    patched Abyss.
  - Rule volume: about 775 selectors in the Abyss stack are keyed on classes
    every card carries. About 60% of them are ours, from `cardBuilder.css`
    (231 scoped to `[data-border*]`).
  - Ours, per card or per row: `cardBuilder.css:2214, 2218, 2222-2225` (the
    `.layout-mobile` ones are registered on desktop too) and `:3974`.
- **ElegantFin:** the jf12 companion sheet has **77** `body:has()` rules, 8 of
  them with `:not(.hide)`, and `elegantfin-haspatch.js` doesn't cover them.
- **Experiment:**
  1. Record a library scroll in Chromium DevTools with *Enable CSS selector
     stats*.
  2. Sort by `body:has(`.
  3. Or use a local override of `abyss.css` with those rules removed.
- **Direction:** a locally patched Abyss build with marker classes, as done for
  ElegantFin (`elegantfin-haspatch.js`).

### C3. Idle at the bottom of home: 133-162ms/s. Measured.
- After a scroll stops, home keeps working: 19 running animations, nodes still
  growing (19.6k → 20.6k).
- Probably sections still arriving, plus skeleton pulses within 300px
  (`cardBuilder.js:6592`).
- **Experiment:** trace 10s of idle at the bottom and see what is still running.

### C4. Idle home, 57 recalcs/s (intermittent). Measured, not pinned down.
- Seen in 2 of 6 runs, only with Media Bar present, after home → other pages →
  home.
- A targeted rerun did not reproduce it: 1.3/s after the round trip. Pausing the
  progress bar, turning off Ken Burns, or hiding the slides changed nothing there.
- Hypotheses:
  - The progress animation loses compositor eligibility after
    `display:none` → visible.
  - `updateVisibility` flaps on a stale `.emby-tab-button-active` from a cached
    page (`mediaBarEnhanced.js:3071-3080`), rebuilding slides.
- **Experiment:** repeat the round trip several times with a recalc counter
  running. When it trips, count `updateCurrentSlide` calls and inspect the
  animation in DevTools.

### C5. Load cost for every user, every full load. Code + measured.
- **Admin and editor code loads for everyone:** about 1.5MB of JS and 107KB of
  CSS.
  - `configuration.js` (347KB);
  - `homeScreen-configuration` (256KB), `homeScreenSectionEditor` (238KB),
    `homeScreenAdvancedEditor` (177KB + 56KB CSS) and `homescreenBenchmark`,
    via the `homeScreen` dependencies;
  - chart.js (209KB) and `statistics.js`, via `watchlist`;
  - pickr;
  - 9 feature `*-configuration.js` files via `CONFIG_DEPENDENCY_NAMES`
    (`kefinTweaks-loader.js:646-653, 914-927`).
  - Only `getConfig`/`getSections` from `homeScreen-configuration` are used at
    runtime.
- **`KefinTweaks-Config` is 155KB because it is pretty-printed.** It stores fully
  merged defaults, about 99KB of that, and it keeps the legacy `homeScreen` after
  migration (`utils.js:2290`).
- **Library caches, each load:**
  - Whole-library IndexedDB reads are done 2-3 times each: `isCacheValid` then
    `get`.
  - The whole library is written back even when nothing changed
    (`moviesCache.js:276`, `seriesCache.js:240`, `peopleCache.js:418`).
  - This starts about 3s after home paints, right when scrolling starts.
- **`apiHelper.getQuery`:** every fetch is written to IndexedDB, awaited before
  returning, and **never evicted** (`:469-512`). The database grows without
  limit. Check its size.
- **Possible double execution:** `../configuration/*.js` may run twice if the
  baked loader joins a site-relative root without normalising
  (`kefinTweaks-loader.js:1106` vs `:771`). Check with
  `document.querySelectorAll('script[src*="homeScreen-configuration.js"]').length`.
- **JE:** all 153 files load regardless of which features are on.
- **Experiment:**
  - A Performance recording of a cold load.
  - Time IndexedDB `get`/`put` by key.
  - Check the IndexedDB size in the real browser.

### C6. Things that run forever once triggered. Code.
- `subtitleSearch.js:1036, 1118-1131`: a 500ms interval starts on the first
  video and is **never stopped**. The stop is inside a `pages:['video']`
  handler.
- `episodeSeasonTitle.js:609-625`: after visiting a Season page, **every
  mouse-move frame on every page** does `getBoundingClientRect` on the hidden
  logo. Also `html.kefin-logo-hovering *` restyles the whole document on each
  hover crossing (`:276`).
- `elegantfin-haspatch.js`:
  - It runs under Abyss: a document observer, 159 timers during home load,
    `:has()` scans and document mouseover listeners.
  - Only `body.kefin-home-active` and `kefin-borderless-spotlight` matter
    outside ElegantFin.
- `cardBuilder.js:6848`: `--kefin-home-row-height` on `.homeSectionsContainer`
  restyles all of home each time it changes. Its only consumer is Blink-only
  `chromiumPerf.css`, so Firefox pays for nothing.
- `cardBuilder.js:5811-6902`: `--scroll-x` and `--max-scroll` are written on
  every drag frame. They are inherited but no CSS reads them. About 600 elements
  are restyled per frame of a row drag.
- JE `getSidebarContainer`: a forced flush roughly every 2s while mutations
  flow, because `jeSidebarMemo.js` caches null for only 2s. Cache it until
  `viewshow` instead.

### C7. Firefox gets none of the Chromium mitigations
- `chromiumPerf.css` (`content-visibility: auto` on home rows) is gated to
  `html.kefin-blink`. Firefox 125+ supports `content-visibility`, and Zen is
  where the fans are.
- **Experiment:** apply it in Zen and compare scroll cost.

---

## 4. Settings to try before any code

| where | setting | why |
|---|---|---|
| Media Bar | Enable Animations off | Ken Burns (G2) |
| Media Bar | Show Progress Bar off | the always-running animation; also the Zen 60fps cap |
| Media Bar | Video Backdrops off, or local trailers only | trailer decode at idle |
| Media Bar | Sync Page Backdrop off | an extra full-viewport crossfade layer |
| Media Bar | Loading Screen off | intervals that can outlive the splash |
| Jellyfin Enhanced | Letterboxd, Elsewhere, Arr tag links, Coloured ratings | each adds a whole-document attribute observer; Coloured ratings also polls every 1s |
| Jellyfin Enhanced | Coloured activity icons, Plugin icons | per-record subtree queries on every page |
| Jellyfin Enhanced | `*UseNativeTab` / custom-tab options | a body-level `:has()` and a forced layout per tab |
| Jellyfin Enhanced | unused tag types; *Tag cache server mode* on | fewer card mutations (C2) |
| KefinTweaks | Abyss: No Blur Behind Card Badges (already on) | extend it per G3 |
| KefinTweaks | Unblurred Backdrop and Theme Video | G3b, G4 |
| KefinTweaks | ElegantFin: Solid App Bar | **does not remove the blur**: it only sets `--appBarHeight`. The fix is `:root{--appBarSeamlessBlur:none}` plus an opaque `--appBarColor` |
| Jellyfin | Display → Backdrops off | G3b |
| Zen | `layout.frame_rate` 120 or 144 | G5 |

---

## 5. Suggested order

1. **G5 baseline:** measure Zen uncapped at 240 and at 120, so there is a
   reference.
2. **G3b:** check whether the page backdrop is on in the real browser. If it
   is, measure it first; it may be the biggest single item.
3. **G1:** change the Abyss section fill-mode and re-measure layers and Zen
   GPU. It's cheap and the measured effect is large.
4. **G2:** Media Bar settings toggles, idle and scrolling, in a real Zen window.
5. **G3:** redo the backdrop-filter toggles with the progress bar paused, since
   the earlier 60fps runs were invalid.
6. **C1:** posterAspect's forced layout, then the observer stack.
7. **C2:** selector stats for the Abyss `body:has()` rules.
8. **C5:** lazy-load the editors and chart.js; minify and diff the config.
9. The rest of C6, as cleanup.

---

## 6. How this was measured

- **Main thread:**
  - Headless Chromium over CDP.
  - A script injected before page scripts wraps `setTimeout`/`setInterval`, rAF,
    the three observer types, hot event listeners, `fetch` and XHR. It
    attributes each registration and callback to the calling script by stack.
  - Callbacks are timed with `performance.now()`.
  - Phases were recorded with `Performance.getMetrics` plus a V8 sampling
    profile.
  - Variants block plugins with `Network.setBlockedURLs`.
  - Home scroll is a rAF loop at 1200px/s.
  - The same method as `docs/forced-layout.md`, extended.
- **GPU:**
  - A real Zen window with the user's own profile (`zen-browser
    --remote-debugging-port=9223`), driven over WebDriver BiDi.
  - Smooth rAF scroll, with `nvidia-smi` sampling utilisation, clocks and power.
  - Headless cannot measure GPU. Wheel-notch scrolling looked choppy and did not
    reproduce the load.
- **Structure:**
  - Layer counts from CDP `LayerTree`.
  - Effects and images from `getComputedStyle`, pseudo-elements included.
- **A/B helper for the console:**
  ```js
  window.ab = c => { let s = document.getElementById('ab-css') || document.head.appendChild(Object.assign(document.createElement('style'), { id: 'ab-css' })); s.textContent = c; }   // ab('') reverts
  ```
  Prefix selectors with `html:not(#_)` to beat the skins' `!important` rules.
- **Line numbers:**
  - `abyss.css` line numbers differ by ~20 between the CDN `@main` copy and the
    local clone in `~/dev/abyss-jellyfin`.
  - The others are as of commit `c981bda`.
- **Limits:**
  - Each variant ran once. Differences under about 20% are noise.
  - Main-thread numbers are Chromium's. Firefox's style engine differs.
  - The test user's home is not identical to the real user's.

## 7. Functional bugs found along the way (not performance)
- `castSessionWatchdog.js`: on Jellyfin 12 there is no `_webSocket`, so
  `hookSocket` never attaches. It re-sends `SessionsStart` and warns the user to
  reload whenever the now-playing bar shows without local playback.
- `watchlist.js`:
  - `getElementByIdSafe` is declared twice. The later one (`:1090`) wins, and it
    recurses forever when no page is visible.
  - The Media Bar observer (`:7918`) never re-attaches to a newly mounted
    `#slides-container`.
- `cardBuilder.css:997`: a `//` comment is invalid CSS and swallows the next
  rule (`.emby-scrollbuttons.padded-right`).
- `homeScreen-configuration.css:54-58`: hides `[data-type="Collections"|"Playlists"|"Generic Parent"]`
  site-wide, unscoped.
- `ui.js:258`: adds a document click listener per autocomplete setup, never
  removed (settings editor only).
