// Poster Aspect -- true-aspect poster cards, sized in the first painted frame.
//
// A rewrite of True Aspect Poster Cards, which it replaced; that feature was
// removed on 2026-09-23 (git history has it).
//
// WHY A REWRITE, AND WHAT IS ACTUALLY DIFFERENT
//
// The first implementation gave every card its ratio from JavaScript, in a
// MutationObserver callback. That callback is a microtask, so in principle it
// runs after the cards are in the DOM and before the frame is painted -- but
// only if the script is already running when the cards appear. On a hard
// refresh Jellyfin is booting at the same moment, and it often is not. The
// result is the thing that could never quite be chased down: cards paint at the
// default ratio and visibly correct themselves afterwards.
//
// Chasing that timing is a losing game, so this does not try. The ratio arrives
// as a CLASS in the card's own markup -- par-68 for 0.68 -- put there by the
// File Transformation rule, and the stylesheet turns each class into a number.
// A card is sized the instant the browser parses it. There is no observer in
// that path, nothing to be late for, and no per-card JavaScript at all.
//
// WHAT JAVASCRIPT IS STILL FOR
//
// Exactly one thing: the row height in pixels. That cannot come from CSS,
// because it is the skin's own ladder width -- a percentage, or a variable that
// differs per skin -- and converting it to pixels requires a laid-out card.
//
// So this measures it once per container, from a throwaway probe, and writes
// --par-h. Crucially it does that when the CONTAINER appears, which is before
// the container has cards -- so by the time a card exists, the height it needs
// is already there. The first implementation measured off the first CARD, which
// is necessarily too late to help that card.
//
// Three rules this follows that the first one had to learn the hard way:
//
//   * The row height is the SKIN's, read from a real card, and is never
//     adjusted afterwards. Nothing here shrinks a row.
//   * Measuring never disturbs a live card. The probe is a separate element the
//     stylesheet deliberately does not size.
//   * Nothing is persisted. There is no cache, so nothing can go stale when
//     artwork changes.

(function() {
    'use strict';

    const LOG = (...a) => console.log('[KefinTweaks PosterAspect]', ...a);
    const WARN = (...a) => console.warn('[KefinTweaks PosterAspect]', ...a);

    const ON_CLASS = 'par-on';
    /* Posters, plus EPISODE cards on the backdrop shapes.
     *
     * Only episodes, deliberately. Movies and series are also drawn as backdrop
     * cards in thumb-style sections, but there they show a Thumb while their
     * PrimaryImageAspectRatio describes the POSTER (~0.67) -- sized by it, a
     * 16:9 thumb would become a sliver. An episode's Primary is the still it
     * actually shows, so its ratio is the picture's. */
    const CARD_SELECTOR = '.card.portraitCard, .card.overflowPortraitCard, '
        + '.card.backdropCard[data-type="Episode"], .card.overflowBackdropCard[data-type="Episode"]';
    const PICKER_GAP = 12;
    const SKIN_KEY = 'kefinTweaks_selectedSkin';
    const SKIN_DEADLINE = Date.now() + 8000;

    // ------------------------------------------------------- the server rule

    const PLUGIN = ['File Transformation', '5e87cc92-571a-4d8d-8d98-d2d4147f9f90'];
    const ENTRY_ID = 'c41e8a76-2b95-4d1e-9f30-5a7d6c8b2e14';

    /* SearchText is NOT a regex -- the plugin applies it with string.Replace --
     * so it is the minified source verbatim. FilenamePattern IS a regex.
     *
     * The class goes into the card's existing class attribute rather than a new
     * style attribute, because the builder may already append one and a second
     * would be ignored. Verified against the deployed chunk: the search string
     * occurs exactly once and the patched file still parses.
     *
     * THE PATTERN NAMES ONE CHUNK, and must keep naming one chunk. It used to be
     * `.*\.chunk\.js`, which matches every chunk jellyfin-web serves, and that is
     * not a harmless over-reach: WebFileTransformationService.RunTransformation
     * picks the pipeline with
     *
     *     m_fileTransformations.Keys.FirstOrDefault(k => regex(k).IsMatch(path))
     *
     * and runs THAT KEY'S PIPELINE ONLY. Patterns are dictionary keys, so a rule
     * claiming every chunk silently swallows any other plugin's chunk rule the
     * moment ours is found first -- and since each plugin registers in its own
     * constructor, which one that is depends on plugin start order and changes
     * across a restart. Custom Tabs patches through the same service, and its
     * four tabs rendered blank.
     *
     * Unanchored on purpose: IsMatch is a search, and the path it is handed may
     * carry a /web/ prefix, so ^ would stop it matching. The chunk id is the
     * specific part; the content hash is left open so a jellyfin-web rebuild that
     * only rehashes the file still matches.
     *
     * A jellyfin-web upgrade that renumbers the chunk WILL break this, quietly --
     * cards keep rendering, they just lose their ratio class. If that happens,
     * find the chunk that contains the SearchText and put its id here.
     */
    /* TWO rules, because two different builders draw poster cards.
     *
     * Rows and grids come from the card builder in chunk 24468. An item page's
     * cover does NOT -- it is built in itemDetails.<hash>.chunk.js by its own
     * function, which picks a shape from the item's ratio and then writes the
     * class itself. That is why the cover carried no par-NN and fell to the
     * 0.7013 default: measured on Black Rock Shooter: Dawn Fall, a true 2:3, the
     * cover rendered 593x846 where its ratio calls for 593x890. Armitage III
     * looked right only because its poster really is 0.7013.
     *
     * The item is `t` at that point in the minified source -- the same scope
     * reads t.PrimaryImageAspectRatio to choose the shape and t.Type to pick the
     * placeholder -- so the ratio is in hand exactly where the class is written.
     *
     * Separate pattern keys on purpose. One key matching both files would have
     * to be broad enough to catch every chunk, which is the mistake that blanked
     * Custom Tabs. The cost of two keys is that each is its own pipeline, so a
     * plugin patching either of these two files could still shadow us or be
     * shadowed -- narrow patterns make that less likely, not impossible.
     */
    const COVER_ENTRY_ID = 'b7d4f1a0-3c68-4e92-8a15-6f0b9d2c7e83';
    const MODERN_CARD_ENTRY_ID = 'e2a9c4d7-5b18-4f63-9c0e-8d3f6a1b2c45';

    const ENTRIES_V11 = [
        {
            Id: ENTRY_ID,
            FilenamePattern: String.raw`24468\.[0-9a-f]+\.chunk\.js`,
            SearchText: `class="'+re+'"'`,
            ReplaceText: `class="'+(r.PrimaryImageAspectRatio>0?'par-'+Math.round(r.PrimaryImageAspectRatio*100)+' ':'')+re+'"'`
        },
        {
            Id: COVER_ENTRY_ID,
            FilenamePattern: String.raw`itemDetails\.[0-9a-f]+\.chunk\.js`,
            SearchText: `'<div class="card '.concat(n,'Card">`,
            ReplaceText: `'<div class="card '.concat(n,'Card ',(t.PrimaryImageAspectRatio>0?'par-'+Math.round(t.PrimaryImageAspectRatio*100):''),'">`
        }
    ];

    /* The same two rules against jellyfin-web 12.1 (the official
     * jellyfin-web_12.1+ubu2404 package), where the minifier renamed the
     * variables: the card builder is still chunk 24468 with the item in `r`, but
     * the class string is now `ae`; the cover is still built in the itemDetails
     * chunk (components/cardbuilder/cardImage.ts, inlined there) with the item
     * in `t` and the shape in `i`. Each SearchText occurs exactly once in its
     * file. A later 12.x build can rename them again -- same symptom and same
     * fix as described above. The ids are shared with the 10.11 rules, so an
     * upgraded server's rules are replaced in place rather than duplicated. */
    const ENTRIES_V12 = [
        {
            Id: ENTRY_ID,
            FilenamePattern: String.raw`24468\.[0-9a-f]+\.chunk\.js`,
            SearchText: `class="'+ae+'"'`,
            ReplaceText: `class="'+(r.PrimaryImageAspectRatio>0?'par-'+Math.round(r.PrimaryImageAspectRatio*100)+' ':'')+ae+'"'`
        },
        {
            Id: COVER_ENTRY_ID,
            FilenamePattern: String.raw`itemDetails\.[0-9a-f]+\.chunk\.js`,
            SearchText: `'<div class="card '.concat(i,'Card">`,
            ReplaceText: `'<div class="card '.concat(i,'Card ',(t.PrimaryImageAspectRatio>0?'par-'+Math.round(t.PrimaryImageAspectRatio*100):''),'">`
        },
        /* Jellyfin 12's modern layout draws library grids with React cards
         * (components/cardbuilder/Card/useCard.ts), which the card builder rule
         * never reaches, so every poster there fell back to the default ratio.
         * useCard builds the card's class list with classNames(); in the 12.1
         * build that is chunk 52197, the item is `c`, and the list ends with
         * {itemAction:...}. The ratio class goes in as one more argument. The
         * library queries request PrimaryImageAspectRatio (hooks/useFetchItems). */
        {
            Id: MODERN_CARD_ENTRY_ID,
            FilenamePattern: String.raw`52197\.[0-9a-f]+\.chunk\.js`,
            SearchText: `{itemAction:H.A.tv}),C=L()("cardBox"`,
            ReplaceText: `{itemAction:H.A.tv},c.PrimaryImageAspectRatio>0?"par-"+Math.round(100*c.PrimaryImageAspectRatio):""),C=L()("cardBox"`
        }
    ];

    const ALL_ENTRIES = ENTRIES_V11.concat(ENTRIES_V12);

    /* An earlier approach wrote data-ar onto every card through a second rule,
     * under that same all-chunks pattern. It was abandoned -- cardBuilder sets
     * data-ar itself now -- but isOurs() matches on our id or our ReplaceText, so
     * it never recognised that rule as ours and it has sat in the plugin config
     * ever since, claiming every chunk. Remove it by id. */
    const STALE_IDS = ['7ca51d3e-9b24-4f80-a6d1-0c8e5b2f4a91'];

    const normId = (id) => String(id || '').replace(/-/g, '').toLowerCase();
    const isOurs = (e) => !!e && (
        ALL_ENTRIES.some((x) => normId(e.Id) === normId(x.Id))
        || ALL_ENTRIES.some((x) => e.ReplaceText === x.ReplaceText)
    );
    const isStale = (e) => !!e && STALE_IDS.some((id) => normId(e.Id) === normId(id));

    let registering = null;
    function ensureTransformation() {
        if (registering) return registering;
        registering = (async () => {
            const major = await window.KefinTweaks?.getJellyfinMajorVersion?.();
            if (major == null) {
                WARN('Jellyfin version unknown, so the ratio class rule was left as it is.');
                return false;
            }
            const ENTRIES = major >= 12 ? ENTRIES_V12 : ENTRIES_V11;
            const id = await window.KefinTweaksUtils.resolvePluginId(PLUGIN);
            if (!id) {
                WARN('File Transformation is not installed, so cards carry no ratio class.');
                return false;
            }
            const read = typeof ApiClient.getPluginConfiguration === 'function'
                ? ApiClient.getPluginConfiguration.bind(ApiClient)
                : window.KefinTweaksUtils.getPluginConfiguration;
            const cfg = await read(id);
            const list = Array.isArray(cfg?.Transformations) ? cfg.Transformations : [];
            const mine = list.filter(isOurs);
            const stale = list.filter(isStale);
            const complete = mine.length === ENTRIES.length && ENTRIES.every((x) => mine.some((m) =>
                normId(m.Id) === normId(x.Id)
                && m.FilenamePattern === x.FilenamePattern
                && m.SearchText === x.SearchText
                && m.ReplaceText === x.ReplaceText));
            if (complete && stale.length === 0) return true;

            if (typeof ApiClient.updatePluginConfiguration !== 'function') {
                WARN('No updatePluginConfiguration on this build; add the rule by hand.');
                return false;
            }
            // Everything that is not ours is preserved; duplicates of ours collapse,
            // and the abandoned data-ar rule goes with them.
            await ApiClient.updatePluginConfiguration(id, {
                ...cfg,
                Transformations: list.filter((t) => t && !isOurs(t) && !isStale(t))
                    .concat(ENTRIES.map((x) => ({ ...x })))
            });
            LOG('Ratio class rule registered. Reload for jellyfin-web to be served with it.');
            return true;
        })().finally(() => { registering = null; });
        return registering;
    }

    // ------------------------------------------------------------ the height

    /* One batch = one answer for "which skin, and has it landed".
     *
     * Both questions are about the DOCUMENT, not about a container, but they
     * were being asked once per container -- and containers are measured once
     * per card, so a 276-card home screen asked them 883 and 427 times. Each ask
     * is a document-wide querySelectorAll.
     *
     * A batch is one synchronous pass: a MutationObserver callback, or one
     * sweep. The records have already been applied by the time we run, and
     * nothing in here inserts a stylesheet (the probe is a div), so the answer
     * cannot change midway. Caching for longer than that would be wrong --
     * watchSkin compares a fresh signature against dataset.parSkin to decide
     * whether a skin actually changed, so a stale value there would miss a real
     * skin switch.
     */
    let batchDepth = 0;
    let batchReady;
    let batchSig;

    function inBatch(fn) {
        if (batchDepth++ === 0) { batchReady = undefined; batchSig = undefined; }
        try { return fn(); }
        finally { if (--batchDepth === 0) { batchReady = undefined; batchSig = undefined; } }
    }

    function skinReadyCached() {
        if (batchDepth && batchReady !== undefined) return batchReady;
        const v = skinReady();
        if (batchDepth) batchReady = v;
        return v;
    }

    function skinSignatureCached() {
        if (batchDepth && batchSig !== undefined) return batchSig;
        const v = skinSignature();
        if (batchDepth) batchSig = v;
        return v;
    }

    /* The skin that is applied, asked of the component that applies it.
     *
     * Reading localStorage directly answers "did the user PICK a skin", which is
     * null for everyone on the default -- and then both callers below took their
     * fallback path: skinReady stopped waiting for the skin at all, and
     * skinSignature fingerprinted the href list. skinManager resolves the
     * default for us and is registered ahead of this file in the loader.
     */
    function selectedSkinName() {
        try {
            const resolved = window.KefinTweaksSkinManager?.getSelectedSkinName?.();
            if (resolved) return resolved;
        } catch (e) { /* skinManager absent or mid-init */ }
        try { return localStorage.getItem(SKIN_KEY); } catch (e) { return null; }
    }

    function skinReady() {
        const links = document.querySelectorAll('link[data-kefin-skin], link[data-kefin-optional-include]');
        if (!links.length) {
            /* No links YET is not the same as no skin: on a fresh load
               skinManager has not inserted them when the first containers
               appear. Measuring then reads Jellyfin's default CSS and the row
               has to be measured again when the skin lands -- the double sizing.
               If a skin is selected, wait for it; the deadline stops that
               becoming a hang when skinManager is off or the key is stale. */
            const selected = selectedSkinName();
            if (!selected || selected === 'Default') return true;
            return Date.now() > SKIN_DEADLINE;
        }
        for (const l of links) {
            if (!l.sheet && !l.dataset.parFailed) return false;
        }
        return true;
    }

    /**
     * WHICH skin is selected -- not how many of its stylesheets have arrived.
     *
     * This used to be the sorted list of skin link hrefs. skinManager adds a
     * skin's optional includes progressively, so that list changes several
     * times during a page load, and each change looked like a skin switch: the
     * "already measured" guard was bypassed, the container was measured again,
     * and because a later sheet had made the skin's own card taller the row
     * height moved. Caught on Robert's machine with a ResizeObserver -- every
     * card growing 442px to 449px at the same instant, 1.2s in, with the
     * container's width already final (jfClass true, padding 48px). Nothing
     * about the container changed; the skin did, underneath us.
     *
     * The selected skin's name is stable while its sheets load and changes only
     * when someone actually switches skins, which is the question this guard is
     * really asking. The href list remains the fallback for when skinManager is
     * not present to have stored anything.
     */
    function skinSignature() {
        const selected = selectedSkinName();
        if (selected) return 'skin:' + selected;
        return Array.from(document.querySelectorAll('link[data-kefin-skin], link[data-kefin-optional-include]'))
            .map((l) => l.getAttribute('href') || '').sort().join('|');
    }

    /**
     * Build a card the skin will size as it sizes any other, measure it, bin it.
     *
     * Not a clone of a live card -- at container-insertion time there may not be
     * one yet, which is the whole point of measuring this early. The markup is
     * the minimum Jellyfin's own builder emits for a portrait card, so the
     * skin's rules apply to it identically. [data-par-probe] keeps the
     * stylesheet's own sizing off it, or it would measure our arithmetic rather
     * than the skin's.
     */
    /* Container widths, reported rather than asked for.
     *
     * The "already measured" guard needs a current width, and a
     * getBoundingClientRect to get one forces layout. On a settled page that is
     * nearly free, but during a scroll the layout tree is dirty constantly and
     * each forced read is expensive: 331 of them across one home scroll cost
     * ~2.2s, which was the whole remaining cost of this file.
     *
     * A ResizeObserver hands back the width the browser has already computed,
     * so the guard costs nothing. Only a container we have never had a reading
     * for still falls through to a real measurement.
     *
     * BORDER box, not content box: applyPickerSlack writes padding-right, which
     * moves the content box and would make this observer re-trigger on its own
     * write. The border box does not move for padding, and it is also what
     * getBoundingClientRect reports, so the cached value and dataset.parAt stay
     * directly comparable.
     */
    const knownWidth = new WeakMap();
    /* A real Set, not a WeakSet: ResizeObserver holds its targets STRONGLY, so
     * containers detached by a page change would be kept alive by the observer
     * whatever we did here. Holding them somewhere iterable is what lets sweep
     * drop them again. */
    const tracked = new Set();
    let widthObserver = null;

    function pruneTracked() {
        if (!widthObserver || !tracked.size) return;
        for (const c of tracked) {
            if (c.isConnected) continue;
            widthObserver.unobserve(c);
            tracked.delete(c);
        }
    }

    function trackWidth(container) {
        if (!window.ResizeObserver || tracked.has(container)) return;
        if (!widthObserver) {
            widthObserver = new ResizeObserver((entries) => {
                let changed = false;
                for (const e of entries) {
                    const w = Math.round(
                        e.borderBoxSize && e.borderBoxSize[0]
                            ? e.borderBoxSize[0].inlineSize
                            : e.contentRect.width
                    );
                    // A row inside a skipped content-visibility subtree has no
                    // box. Keep the last good width rather than recording zero.
                    if (!w) continue;
                    knownWidth.set(e.target, w);
                    const was = Number(e.target.dataset.parAt);
                    if (was && Math.abs(w - was) / was >= 0.05) changed = true;
                }
                if (changed) scheduleSweep();
            });
        }
        tracked.add(container);
        widthObserver.observe(container);
    }

    function measureContainer(container) {
        if (!skinReadyCached()) return false;

        /* Before the settled-container fast path, not after it.
         *
         * The gap is `1em` in ElegantFin, so it resolves late -- observed at
         * 7.2px and then 14.88px within one load as fonts settled. Publishing
         * it only alongside a full measurement meant the container was measured
         * once, early, with the gap still unresolved, and the value never
         * caught up. It is one getComputedStyle on one container per page. */
        publishColumnGap(container);

        const sig = skinSignatureCached();

        /* Fast path: settled container, width from the observer, no layout.
         * Same tolerance as below -- this only decides HOW the width is
         * obtained, never what counts as settled. */
        if (container.dataset.parSkin === sig && container.classList.contains(ON_CLASS)) {
            const seen = knownWidth.get(container);
            const settled = Number(container.dataset.parAt);
            if (seen && settled) {
                if (seen === settled) return true;
                if (Math.abs(seen - settled) / settled < 0.05) return true;
            }
        }

        // Inside Jellyfin's .hide the answer is 0 wide; get it without forcing
        // layout. The sweep retries once the section is shown.
        if (container.closest('.hide')) return false;
        const width = Math.round(container.getBoundingClientRect().width);
        if (!width) return false;
        if (container.dataset.parSkin === sig) {
            const was = Number(container.dataset.parAt);
            /* Once measured, the height is settled.
             *
             * A page shifts by a few pixels while it finishes loading -- the
             * picker's reservation arriving, a scrollbar, a header resolving --
             * and re-measuring on each of those is what resizes the covers a
             * moment after everything looks right. The height is the skin's for
             * this layout; small width changes do not change what the skin
             * wants, they are just the page settling.
             *
             * 5% is comfortably above that noise and far below a real window
             * resize or a sidebar opening, which still re-measure.
             */
            if (was && Math.abs(width - was) / was < 0.05) return true;
            if (was === width) return true;
        }

        /* Pin the picker reservation BEFORE measuring.
         *
         * Jellyfin adds .padded-right-withalphapicker after the first render, so
         * a container is briefly unreserved and then reserved. Measured in both
         * states it yields two different row heights, and the second one is what
         * resizes the covers a moment after the page has settled.
         *
         * Marking the container here makes the stylesheet apply the same
         * reservation we will end up with either way, synchronously, before the
         * probe is read. Jellyfin's own class is overridden to the same value,
         * so when it does arrive the width does not move and there is nothing to
         * re-measure.
         */
        /* Only the wrapping grid, not every container on the page.
         *
         * The reservation this pins exists because Jellyfin pads the LIBRARY
         * GRID for the A-Z picker (.padded-right-withalphapicker). A horizontal
         * row on the same page never gets that padding, so marking it here gave
         * it `padding-right: 0 !important` against a padding it never had --
         * a layout change to rows that have nothing to do with the picker. The
         * test was on the page having a picker, not on this container being the
         * thing the picker pads.
         *
         * .vertical-wrap is the wrapping grid and the only layout Jellyfin
         * applies the reservation to; it cannot be tested for the class itself,
         * since the whole point is to pin the reservation BEFORE Jellyfin adds
         * it. */
        const ownerPage = container.closest('[data-role="page"]') || document;
        if (container.classList.contains('vertical-wrap') && ownerPage.querySelector('.alphaPicker')) {
            container.dataset.parPicker = '1';
        }

        /* Probe with the SAME card class the container actually holds.
         *
         * The two portrait card types are sized by different rules --
         * jellyfin-web gives `.overflowPortraitCard { width: 31.2vw }` and lets
         * the padder turn that into a height, while `.portraitCard` has no width
         * rule of its own and takes one from its container. Probing an overflow
         * row with a plain portraitCard therefore measures a box the row never
         * uses: on a series page it read 245px where the skin's own cards were
         * 394px, so every poster row on that page came out about a quarter
         * shorter than the skin drew it. The row height is the skin's, so the
         * probe has to be the skin's card.
         */
        const sample = container.querySelector(
            '.card.portraitCard:not([data-par-probe]), .card.overflowPortraitCard:not([data-par-probe])'
        );
        /* A sample is the truth when there is one, but usually there is not:
         * containers are measured as they appear, BEFORE their cards arrive, so
         * that the row is the right size on its first paint. So fall back to
         * what the container itself says. A horizontal row is .scrollSlider
         * inside an .emby-scroller and holds overflowPortraitCard; a wrapping
         * grid (.vertical-wrap, the library view) holds portraitCard.
         *
         * Getting this from a sample alone silently did nothing for exactly the
         * rows that needed it -- More Like This and Recommended are measured
         * empty, so they kept probing as portraitCard and stayed short, while
         * Specials, injected by a plugin after its cards, picked the right class
         * and came out correct. */
        const overflow = sample
            ? sample.classList.contains('overflowPortraitCard')
            : (container.classList.contains('scrollSlider')
                || !!(container.closest && container.closest('.emby-scroller')));

        /* The probe already failed here under the same skin, width, card shape,
         * picker and gap, so it would fail the same way again: ElegantFin hides
         * the portrait cover on every item page, and that container was probed,
         * forced and rejected on every sweep. invalidate() clears this, and any
         * change to the key's inputs retries naturally. */
        const rejectKey = [sig, width, overflow ? 'o' : 'p',
            container.dataset.parPicker || '', container.dataset.parGap || ''].join('|');
        if (container.dataset.parReject === rejectKey) return false;

        const makeProbe = (cardClass, padderClass) => {
            const p = document.createElement('div');
            p.className = 'card ' + cardClass;
            p.setAttribute('data-par-probe', '1');
            p.style.visibility = 'hidden';
            // Belt and braces alongside the stylesheet rule: in a grid the
            // container's `flex: auto` would stretch a lone probe to the full width.
            p.style.setProperty('flex', '0 0 auto', 'important');
            p.innerHTML = '<div class="cardBox cardBox-bottompadded"><div class="cardScalable">'
                + '<div class="cardPadder ' + padderClass + '"></div></div></div>';
            return p;
        };

        /* A second probe for episode cards, taken in the same forced layout.
         *
         * The container cannot say which shape it will hold: a .scrollSlider
         * row carries posters on one page and episodes on the next, and it is
         * measured before either arrives. Guessing is what shrank the detail
         * rows by a quarter. So measure both and publish both -- posters read
         * --par-h, episodes read --par-hb -- and whichever cards turn up find
         * the skin's own height for their shape already waiting. Two probes cost
         * one layout, not two: both are inserted before either is read. */
        const probe = makeProbe(
            overflow ? 'overflowPortraitCard' : 'portraitCard',
            overflow ? 'cardPadder-overflowPortrait' : 'cardPadder-portrait');
        const bprobe = makeProbe(
            overflow ? 'overflowBackdropCard' : 'backdropCard',
            overflow ? 'cardPadder-overflowBackdrop' : 'cardPadder-backdrop');
        container.appendChild(probe);
        container.appendChild(bprobe);

        const box = probe.querySelector('.cardScalable').getBoundingClientRect();
        const card = probe.getBoundingClientRect();
        const bbox = bprobe.querySelector('.cardScalable').getBoundingClientRect();
        const bcard = bprobe.getBoundingClientRect();
        // Insert, read, remove, all synchronously: layout is forced, but no
        // frame containing the probes is ever painted.
        probe.remove();
        bprobe.remove();

        if (!box.height || !box.width || !card.width) {
            container.dataset.parReject = rejectKey;
            return false;
        }

        /* Sanity: a card is never most of the container.
         *
         * If the probe somehow stretched -- a layout mode that grows flex items,
         * a skin rule reaching it -- the height solved from it would be wildly
         * too big and every card in the row would balloon. Better to leave the
         * container alone and measure again next sweep than to apply a number
         * that is obviously wrong. */
        if (card.width > width * 0.9) {
            WARN('Probe measured ' + Math.round(card.width) + 'px in a '
                + width + 'px container; ignoring this measurement.');
            container.dataset.parReject = rejectKey;
            return false;
        }

        // .cardScalable sits inside a padded .cardBox, so the card is wider than
        // its picture. The width formula must carry that difference or the ratio
        // lands on the card instead of on the image.
        const pad = Math.max(0, Math.round(card.width - box.width));

        container.style.setProperty('--par-h', Math.round(box.height) + 'px');
        container.style.setProperty('--par-pad', pad + 'px');

        // Episode shape: same sanity as the poster probe, applied separately.
        // data-par-hb gates the episode rules, so a container whose backdrop
        // probe failed leaves its episode cards entirely to the skin.
        if (bbox.height && bbox.width && bcard.width && bcard.width <= width * 0.9) {
            container.style.setProperty('--par-hb', Math.round(bbox.height) + 'px');
            container.style.setProperty('--par-padb', Math.max(0, Math.round(bcard.width - bbox.width)) + 'px');
            container.dataset.parHb = '1';
        } else {
            delete container.dataset.parHb;
            container.style.removeProperty('--par-hb');
            container.style.removeProperty('--par-padb');
        }
        delete container.dataset.parReject;
        container.dataset.parAt = String(width);
        container.dataset.parSkin = sig;
        container.classList.add(ON_CLASS);
        applyPickerSlack(container);
        /* Seed the cache from the reading we already forced, then let the
         * observer keep it current -- so the next visit to this container takes
         * the fast path above instead of forcing layout again. Registered after
         * applyPickerSlack, whose padding write must not be the first thing the
         * observer sees as a change. */
        knownWidth.set(container, width);
        trackWidth(container);
        return true;
    }

    /**
     * Publish the grid's column gap, so CSS can subtract it.
     *
     * Jellyfin sizes a wrapping grid's cards as an exact fraction of the
     * container -- `.portraitCard { width: 33.333% }` -- which fills the row
     * with nothing left over. A skin that adds `column-gap` (ElegantFin sets
     * `column-gap: var(--itemColumnGap)`, 1em) therefore pushes the last card
     * of every row onto the next one: three 33.333% cards plus two gaps is
     * wider than the container by exactly the gaps.
     *
     * The gap cannot be read in CSS, and it is the skin's value rather than
     * ours, so read it once per measurement and hand it to the stylesheet.
     * Only the wrapping grid needs it; a horizontal row scrolls and does not
     * care how many fit.
     */
    function publishColumnGap(container) {
        if (!container.classList.contains('vertical-wrap')) return;
        const gap = parseFloat(getComputedStyle(container).columnGap);
        const next = gap > 0 ? gap + 'px' : '';
        // Only write on a change: this runs on every measure call now, and a
        // custom property is a style invalidation for the whole subtree.
        if (container.dataset.parGap === next) return;
        container.dataset.parGap = next;
        if (next) container.style.setProperty('--par-gap', next);
        else container.style.removeProperty('--par-gap');
    }

    /**
     * Keep rows clear of the A-Z picker, by reserving WIDTH.
     *
     * The row height is the skin's and is never touched, so horizontal room is
     * the only thing left to give -- on a narrow screen that can cost a card per
     * row, which is the accepted trade.
     */
    function applyPickerSlack(container) {
        // Same scope as the reservation above: the wrapping grid is what the
        // picker overlaps. Applied to every measured container it padded
        // horizontal rows -- episode rows, cast, More Like This -- for a picker
        // that does not reach them.
        if (!container.classList.contains('vertical-wrap')) return;
        const picker = document.querySelector('[data-role="page"]:not(.hide) .alphaPicker')
            || document.querySelector('.alphaPicker');
        if (!picker) return;
        const pr = picker.getBoundingClientRect();
        if (!pr.width) return;

        const current = parseFloat(getComputedStyle(container).paddingRight) || 0;
        const rect = container.getBoundingClientRect();
        // To the picker's LEFT EDGE, not its width: it is not flush to the edge,
        // so reserving its width alone still leaves content under the letters.
        const needed = Math.round((rect.right - current) - pr.left) + PICKER_GAP;

        if (needed <= 0) {
            delete container.dataset.parSlack;
            container.style.removeProperty('--par-slack');
            return;
        }
        if (String(needed) === container.dataset.parSlack) return;
        container.style.setProperty('--par-slack', needed + 'px');
        container.dataset.parSlack = String(needed);
    }

    // ------------------------------------------------------------- discovery

    function containersIn(root) {
        const out = new Set();
        if (root.nodeType !== 1) return out;
        // The container itself may be the inserted node, or contain them, or be
        // a card whose parent is the container (when cards arrive separately).
        if (root.querySelectorAll) {
            root.querySelectorAll(CARD_SELECTOR).forEach((c) => {
                if (c.parentElement && !c.hasAttribute('data-par-probe')) out.add(c.parentElement);
            });
        }
        if (root.matches && root.matches(CARD_SELECTOR) && root.parentElement) out.add(root.parentElement);
        if (root.classList && root.classList.contains('itemsContainer')) out.add(root);
        if (root.querySelectorAll) root.querySelectorAll('.itemsContainer').forEach((c) => out.add(c));
        return out;
    }

    function sweep() {
        const pages = document.querySelectorAll('[data-role="page"]:not(.hide)');
        const scopes = pages.length ? pages : [document];
        /* Collect first, measure once.
         *
         * Every card resolves to its PARENT, so walking the cards of a 276-card
         * page called measureContainer 276 times across ~21 real containers.
         * The dataset guard made the repeats cheap-looking, but it only fires
         * after a getBoundingClientRect -- a forced layout each time. */
        const targets = new Set();
        scopes.forEach((scope) => {
            scope.querySelectorAll('.itemsContainer').forEach((c) => targets.add(c));
            scope.querySelectorAll(CARD_SELECTOR).forEach((c) => {
                if (c.parentElement && !c.hasAttribute('data-par-probe')) targets.add(c.parentElement);
            });
        });
        if (!targets.size) return;
        inBatch(() => targets.forEach(measureContainer));
        pruneTracked();
    }

    let pending = null;
    function scheduleSweep() {
        if (pending) return;
        pending = setTimeout(() => { pending = null; sweep(); }, 100);
    }

    function invalidate() {
        document.querySelectorAll('.' + ON_CLASS).forEach((c) => {
            delete c.dataset.parAt;
            delete c.dataset.parSkin;
        });
        document.querySelectorAll('[data-par-reject]').forEach((c) => { delete c.dataset.parReject; });
        scheduleSweep();
    }

    function watchSkin() {
        new MutationObserver((records) => {
            const links = [];
            let removed = false;
            records.forEach((r) => {
                r.addedNodes.forEach((n) => {
                    if (n.nodeType === 1 && n.matches?.('link[data-kefin-skin], link[data-kefin-optional-include]')) links.push(n);
                });
                r.removedNodes.forEach((n) => {
                    if (n.nodeType === 1 && n.matches?.('link[data-kefin-skin], link[data-kefin-optional-include]')) removed = true;
                });
            });
            if (!links.length && !removed) return;

            /* A skin's sheets arriving is not a skin CHANGE.
             *
             * This observer used to invalidate on any skin link being added,
             * which deletes the recorded measurement and forces a re-measure --
             * so the stable signature above would be bypassed anyway. During a
             * page load skinManager adds several sheets, each one triggering
             * this, and a later sheet that makes the skin's card taller then
             * moves the row height. Only act when the selected skin actually
             * differs from the one the containers were measured under.
             */
            const now = skinSignature();
            const measured = document.querySelector('.' + ON_CLASS);
            if (measured && measured.dataset.parSkin === now) return;

            // Wait for the sheets themselves. A stylesheet that has not applied
            // measures as the skin being left, so a fixed delay is a bet on
            // network speed.
            const settle = () => requestAnimationFrame(() => requestAnimationFrame(invalidate));
            links.forEach((l) => l.addEventListener('error', () => { l.dataset.parFailed = '1'; }, { once: true }));
            if (!links.length) return settle();
            let outstanding = links.length;
            const done = () => { if (--outstanding <= 0) settle(); };
            links.forEach((l) => {
                if (l.sheet) return done();
                l.addEventListener('load', done, { once: true });
                l.addEventListener('error', done, { once: true });
            });
            /* Fallback for a sheet that never fires load or error. Guarded the
               same way: if the selected skin still matches what the containers
               were measured under, there is nothing to redo, and firing blind
               two seconds in is its own late resize. */
            setTimeout(() => {
                const sig = skinSignature();
                const done = document.querySelector('.' + ON_CLASS);
                if (done && done.dataset.parSkin === sig) return;
                invalidate();
            }, 2000);
        // skinManager inserts after #cssTheme when it can, but falls back to the
        // BODY, which a head-only observer never sees.
        }).observe(document.documentElement, { childList: true, subtree: true });
    }

    function start() {
        if (window.__kefinPosterAspect) return;
        window.__kefinPosterAspect = true;

        /* Measure containers the moment they appear, before they have cards.
         *
         * This is the whole difference. A container is inserted, gets its height
         * here in the same microtask, and the cards that follow are sized by CSS
         * as they are parsed. Nothing has to catch the cards themselves. */
        new MutationObserver((records) => {
            /* Cards arrive one record at a time and every one of them resolves
             * to the SAME row container, so measuring as we walk the records
             * measured that row once per card. Collecting across the whole
             * batch first keeps the property this observer exists for -- the
             * container is still sized in the same synchronous pass, before the
             * frame is painted -- while doing it once instead of N times. */
            const targets = new Set();
            for (const r of records) {
                for (const n of r.addedNodes) {
                    containersIn(n).forEach((c) => targets.add(c));
                }
            }
            if (!targets.size) return;
            inBatch(() => targets.forEach(measureContainer));
            scheduleSweep();
        }).observe(document.documentElement, { childList: true, subtree: true });

        /* A resize SWEEPS; it does not invalidate.
         *
         * invalidate() deletes the recorded width, which is what the "already
         * measured" tolerance compares against -- so wiring it to resize made
         * every resize event re-measure unconditionally, tolerance and all.
         * And the window fires resize for trivia: a scrollbar appearing as more
         * cards load is a resize. Caught on Robert's machine at 1247ms, every
         * card going 456px to 463px with the container's width already final.
         *
         * Sweeping instead lets measureContainer decide: a scrollbar's worth of
         * width is inside the tolerance and changes nothing, while a real window
         * resize is well outside it and re-measures properly.
         */
        window.addEventListener('resize', scheduleSweep, { passive: true });
        watchSkin();
        sweep();
        LOG('Poster aspect watching');
    }

    async function initialize(attempt = 0) {
        // Watching needs nothing, so it starts immediately -- the registration
        // below is the only part that waits for Jellyfin to boot.
        start();

        if (typeof ApiClient === 'undefined' || !ApiClient || !window.KefinTweaksUtils) {
            if (attempt < 40) return void setTimeout(() => initialize(attempt + 1), 250);
            WARN('Dependencies unavailable; cannot register the ratio rule.');
            return;
        }
        try {
            // This runs as the page boots, before sign-in has finished on 12, and
            // there is no second attempt -- so without the wait the rule was never
            // registered and no card carried a ratio class.
            await window.userHelper?.waitForLogin?.();
            const user = await ApiClient.getCurrentUser();
            if (user?.Policy?.IsAdministrator) await ensureTransformation();
        } catch (e) {
            WARN('Could not register the ratio rule:', e?.message || e);
        }
        if (window.KefinTweaksUtils.onViewPage) {
            window.KefinTweaksUtils.onViewPage(() => scheduleSweep(), { pages: [] });
        }
        scheduleSweep();
    }

    window.KefinTweaksPosterAspect = { ensureTransformation, sweep };

    if (document.body) start();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => initialize());
    } else {
        initialize();
    }
})();
