// Poster Aspect -- true-aspect poster cards, sized in the first painted frame.
//
// A SECOND, SEPARATE implementation of what True Aspect Poster Cards does. Both
// exist so they can be compared; run one or the other, never both.
//
// WHY A REWRITE, AND WHAT IS ACTUALLY DIFFERENT
//
// The first implementation gives every card its ratio from JavaScript, in a
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
    const CARD_SELECTOR = '.card.portraitCard, .card.overflowPortraitCard';
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
    const ENTRY = {
        Id: ENTRY_ID,
        FilenamePattern: String.raw`24468\.[0-9a-f]+\.chunk\.js`,
        SearchText: `class="'+re+'"'`,
        ReplaceText: `class="'+(r.PrimaryImageAspectRatio>0?'par-'+Math.round(r.PrimaryImageAspectRatio*100)+' ':'')+re+'"'`
    };

    /* An earlier approach wrote data-ar onto every card through a second rule,
     * under that same all-chunks pattern. It was abandoned -- cardBuilder sets
     * data-ar itself now -- but isOurs() matches on our id or our ReplaceText, so
     * it never recognised that rule as ours and it has sat in the plugin config
     * ever since, claiming every chunk. Remove it by id. */
    const STALE_IDS = ['7ca51d3e-9b24-4f80-a6d1-0c8e5b2f4a91'];

    const normId = (id) => String(id || '').replace(/-/g, '').toLowerCase();
    const isOurs = (e) => !!e && (normId(e.Id) === normId(ENTRY_ID) || e.ReplaceText === ENTRY.ReplaceText);
    const isStale = (e) => !!e && STALE_IDS.some((id) => normId(e.Id) === normId(id));

    let registering = null;
    function ensureTransformation() {
        if (registering) return registering;
        registering = (async () => {
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
            if (mine.length === 1
                && stale.length === 0
                && mine[0].FilenamePattern === ENTRY.FilenamePattern
                && mine[0].SearchText === ENTRY.SearchText) return true;

            if (typeof ApiClient.updatePluginConfiguration !== 'function') {
                WARN('No updatePluginConfiguration on this build; add the rule by hand.');
                return false;
            }
            // Everything that is not ours is preserved; duplicates of ours collapse,
            // and the abandoned data-ar rule goes with them.
            await ApiClient.updatePluginConfiguration(id, {
                ...cfg,
                Transformations: list.filter((t) => t && !isOurs(t) && !isStale(t)).concat([{ ...ENTRY }])
            });
            LOG('Ratio class rule registered. Reload for jellyfin-web to be served with it.');
            return true;
        })().finally(() => { registering = null; });
        return registering;
    }

    // ------------------------------------------------------------ the height

    function skinReady() {
        const links = document.querySelectorAll('link[data-kefin-skin], link[data-kefin-optional-include]');
        if (!links.length) {
            /* No links YET is not the same as no skin: on a fresh load
               skinManager has not inserted them when the first containers
               appear. Measuring then reads Jellyfin's default CSS and the row
               has to be measured again when the skin lands -- the double sizing.
               If a skin is selected, wait for it; the deadline stops that
               becoming a hang when skinManager is off or the key is stale. */
            let selected = null;
            try { selected = localStorage.getItem(SKIN_KEY); } catch (e) { /* blocked */ }
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
        try {
            const selected = localStorage.getItem(SKIN_KEY);
            if (selected) return 'skin:' + selected;
        } catch (e) { /* storage blocked */ }
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
    function measureContainer(container) {
        if (!skinReady()) return false;

        const width = Math.round(container.getBoundingClientRect().width);
        if (!width) return false;
        const sig = skinSignature();
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

        const probe = document.createElement('div');
        probe.className = overflow ? 'card overflowPortraitCard' : 'card portraitCard';
        probe.setAttribute('data-par-probe', '1');
        probe.style.visibility = 'hidden';
        // Belt and braces alongside the stylesheet rule: in a grid the
        // container's `flex: auto` would stretch a lone probe to the full width.
        probe.style.setProperty('flex', '0 0 auto', 'important');
        probe.innerHTML = '<div class="cardBox cardBox-bottompadded"><div class="cardScalable">'
            + '<div class="cardPadder '
            + (overflow ? 'cardPadder-overflowPortrait' : 'cardPadder-portrait')
            + '"></div></div></div>';
        container.appendChild(probe);

        const scalable = probe.querySelector('.cardScalable');
        const box = scalable.getBoundingClientRect();
        const card = probe.getBoundingClientRect();
        // Insert, read, remove, all synchronously: layout is forced, but no
        // frame containing the probe is ever painted.
        probe.remove();

        if (!box.height || !box.width || !card.width) return false;

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
            return false;
        }

        // .cardScalable sits inside a padded .cardBox, so the card is wider than
        // its picture. The width formula must carry that difference or the ratio
        // lands on the card instead of on the image.
        const pad = Math.max(0, Math.round(card.width - box.width));

        container.style.setProperty('--par-h', Math.round(box.height) + 'px');
        container.style.setProperty('--par-pad', pad + 'px');
        container.dataset.parAt = String(width);
        container.dataset.parSkin = sig;
        container.classList.add(ON_CLASS);
        applyPickerSlack(container);
        return true;
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
        scopes.forEach((scope) => {
            scope.querySelectorAll('.itemsContainer').forEach(measureContainer);
            scope.querySelectorAll(CARD_SELECTOR).forEach((c) => {
                if (c.parentElement && !c.hasAttribute('data-par-probe')) measureContainer(c.parentElement);
            });
        });
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
            let any = false;
            for (const r of records) {
                for (const n of r.addedNodes) {
                    containersIn(n).forEach((c) => { measureContainer(c); any = true; });
                }
            }
            if (any) scheduleSweep();
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
