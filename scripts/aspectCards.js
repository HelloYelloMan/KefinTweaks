// Aspect Cards -- poster cards sized from a ratio the server puts on them.
//
// A SECOND, SEPARATE IMPLEMENTATION of what True Aspect Cards does. Both exist;
// turn on one or the other, never both. This one is not a refinement of that
// feature and shares no code with it -- it is the same idea built on a
// different foundation, so the bugs that came out of the old foundation cannot
// occur here.
//
// THE DIFFERENCE, AND WHY IT MATTERS
//
// jellyfin-web gives a card SET one shape, from the median aspect ratio of the
// set, and puts nothing about the individual item's ratio in the markup. True
// Aspect Cards therefore has to go and FIND each ratio: per-item API lookups,
// harvesting /Items responses, measuring the image itself when the metadata is
// wrong, and a persisted cache so it does not do all that twice. Every bug that
// feature produced came from that layer -- ratios surviving an artwork change,
// a cache keyed on something that did not identify the card, values outliving a
// hard refresh, whole home rows taking another row's measurements.
//
// This version deletes that layer outright. The File Transformation plugin
// rewrites jellyfin-web as it is served, and jellyfin-web builds its card
// element as a string with the item in scope, so the ratio can simply be
// stamped onto the card at the source. It is then:
//
//   * correct     -- it is the server's own value for that item
//   * current     -- it comes with the card, so changed artwork cannot go stale
//   * early       -- it is in the markup before the card is ever painted
//   * per item    -- not the set's median
//
// There is no cache, nothing persisted, and no lookup. Nothing to invalidate
// means nothing to invalidate wrongly.
//
// WHAT IS LEFT
//
// Only layout. Cards share one row height and take their width from their own
// ratio, so the row height has to be measured once per container -- that part
// is unavoidable and was never the source of trouble. The three layout
// problems that were found the hard way are handled here from the start rather
// than discovered again: the first paint must not be animated, a row must not
// slide under the A-Z picker, and the hover zoom must not be clipped by paint
// containment. Each is commented where it happens.
//
// REQUIREMENTS
//
// The File Transformation plugin, and an administrator to register the rule
// (done automatically, once). Without them no card carries a ratio and this
// feature leaves every card exactly as Jellyfin drew it -- it does not fall
// back to looking ratios up, because not doing that is the entire point.

(function() {
    'use strict';

    const LOG = (...a) => console.log('[KefinTweaks AspectCards]', ...a);
    const WARN = (...a) => console.warn('[KefinTweaks AspectCards]', ...a);
    const ERR = (...a) => console.error('[KefinTweaks AspectCards]', ...a);

    const ACTIVE_CLASS = 'kefin-aspect';
    const CARD_SELECTOR = '.card.portraitCard, .card.overflowPortraitCard';

    // Fanart's 1000x1426. The fallback for a card with no ratio of its own, and
    // the basis the row height is solved for, so an ordinary poster comes out
    // exactly the width Jellyfin's ladder intended and the cards-per-row count
    // is unchanged.
    const FANART_RATIO = 1000 / 1426;
    const PICKER_CLEARANCE = 4;

    // ---------------------------------------------------------------- plugin

    const PLUGIN_ALIASES = ['File Transformation', '5e87cc92-571a-4d8d-8d98-d2d4147f9f90'];
    const ENTRY_ID = '7ca51d3e-9b24-4f80-a6d1-0c8e5b2f4a91';

    /* The two configuration fields are NOT the same kind of string, and this is
     * the single detail that makes the rule work or silently do nothing.
     *
     *   FilenamePattern IS a regex -- the plugin runs it through
     *     GetOrCreateRegex(...).IsMatch(path), so `\.` is correct here.
     *
     *   SearchText is NOT a regex. The plugin does:
     *         currentContent.Replace(SearchText, ReplaceText)
     *     which is string.Replace, a literal substring replace. Escaping it
     *     produces a string that does not occur in the file, and the rule then
     *     quietly matches nothing.
     *
     * So the search text is the minified source, verbatim.
     */
    const ENTRY = {
        Id: ENTRY_ID,
        FilenamePattern: String.raw`.*\.chunk\.js`,
        SearchText: `data-type="'+r.Type+'"'`,
        ReplaceText: `data-type="'+r.Type+'" data-ar="'+(r.PrimaryImageAspectRatio||'')+'"'`
    };

    function normId(id) {
        // Jellyfin stores GUIDs without dashes, so what is written is not what
        // is read back. Compare normalised or the entry is never recognised.
        return String(id || '').replace(/-/g, '').toLowerCase();
    }

    const isOurs = (e) => !!e && (normId(e.Id) === normId(ENTRY_ID) || e.ReplaceText === ENTRY.ReplaceText);
    const sameEntry = (a) => !!a && a.FilenamePattern === ENTRY.FilenamePattern
        && a.SearchText === ENTRY.SearchText && a.ReplaceText === ENTRY.ReplaceText;

    let registering = null;
    function ensureTransformation() {
        if (!registering) registering = registerOnce().finally(() => { registering = null; });
        return registering;
    }

    async function registerOnce() {
        const pluginId = await window.KefinTweaksUtils.resolvePluginId(PLUGIN_ALIASES);
        if (!pluginId) {
            WARN('The File Transformation plugin is not installed, so no card will carry a ratio.');
            return false;
        }

        // ApiClient does not always expose the plugin-configuration helpers
        // (it varies by Jellyfin build), and calling a missing one threw
        // "Could not register the ratio transformation: undefined" in testing.
        const config = typeof ApiClient.getPluginConfiguration === 'function'
            ? await ApiClient.getPluginConfiguration(pluginId)
            : await window.KefinTweaksUtils.getPluginConfiguration(pluginId);
        const list = Array.isArray(config?.Transformations) ? config.Transformations : [];
        const mine = list.filter(isOurs);
        if (mine.length === 1 && sameEntry(mine[0])) return true;

        // Everything that is not ours is preserved untouched; every copy of ours
        // collapses back into one.
        const next = list.filter((t) => t && !isOurs(t));
        next.push({ ...ENTRY });
        if (typeof ApiClient.updatePluginConfiguration !== 'function') {
            WARN('This build has no updatePluginConfiguration; add the rule from the '
                + 'File Transformation plugin page instead.');
            return false;
        }
        await ApiClient.updatePluginConfiguration(pluginId, { ...config, Transformations: next });
        LOG(mine.length ? 'Ratio transformation updated' : 'Ratio transformation registered');
        LOG('Reload for jellyfin-web to be served with ratios on its cards.');
        return true;
    }

    // ---------------------------------------------------------------- layout

    function visibleScopes() {
        // The SPA keeps hidden pages in the DOM; measuring one gives zeroes.
        const pages = document.querySelectorAll('[data-role="page"]:not(.hide)');
        return pages.length ? Array.from(pages) : [document];
    }

    function skinSignature() {
        return Array.from(document.querySelectorAll('link[data-kefin-skin], link[data-kefin-optional-include]'))
            .map((l) => l.getAttribute('href') || '').sort().join('|');
    }

    /**
     * Establish the row height for a container, from its own first card.
     *
     * Measured with the class OFF, so the card is at the width the skin's
     * ladder gave it. The height is then solved so that a FANART poster fills
     * that width exactly -- taking the height straight off the card would tie
     * the row to whatever shape Jellyfin's padder happens to be, and every
     * wider poster would then grow the row and cost a card per line.
     *
     * Keyed on the container's width AND the skin, because a skin change alters
     * both the ladder width and the padding inside the card without altering
     * the container.
     */
    function measure(container) {
        const probe = container.querySelector(CARD_SELECTOR);
        if (!probe) return false;

        const width = Math.round(container.getBoundingClientRect().width);
        const sig = skinSignature();
        if (container.dataset.kefinAt === String(width) && container.dataset.kefinSkin === sig) return true;

        const wasActive = container.classList.contains(ACTIVE_CLASS);
        if (wasActive) container.classList.remove(ACTIVE_CLASS);

        const scalable = probe.querySelector('.cardScalable');
        const cardRect = probe.getBoundingClientRect();
        const imgRect = scalable ? scalable.getBoundingClientRect() : null;
        if (!imgRect || !imgRect.width || !cardRect.width) {
            if (wasActive) container.classList.add(ACTIVE_CLASS);
            return false;
        }

        // .cardScalable sits inside a padded .cardBox, so the card is wider than
        // its image. The width formula has to carry that difference or the ratio
        // lands on the card instead of on the picture.
        const pad = Math.max(0, Math.round(cardRect.width - imgRect.width));
        const height = Math.round((cardRect.width - pad) / FANART_RATIO);
        if (!(height > 0)) {
            if (wasActive) container.classList.add(ACTIVE_CLASS);
            return false;
        }

        container.style.setProperty('--kac-h', height + 'px');
        container.style.setProperty('--kac-pad', pad + 'px');
        container.dataset.kefinAt = String(width);
        container.dataset.kefinSkin = sig;
        container.dataset.kefinBaseH = String(height);
        container.classList.add(ACTIVE_CLASS);
        return true;
    }

    /**
     * Keep the end of a row clear of the A-Z picker.
     *
     * On a phone there is no .padded-right-withalphapicker and the container's
     * padding-right is 0, so the picker floats over the content and the last
     * card in a row sits under the letters.
     *
     * Reserving padding is the wrong fix: the row is packed to within a pixel or
     * two of the edge, so taking the ~15px the picker wants pushes a whole card
     * onto the next line. Taking it out of the HEIGHT shrinks every card in the
     * row proportionally instead -- about 1.7px each at phone sizes, invisible
     * -- and the row ends before the picker with its card count intact.
     *
     * Solved rather than scaled: a card's width is `height x ratio + pad`, and
     * pad is fixed pixels that do not shrink with the height, so scaling the
     * height by a ratio of widths always under-corrects. To pull a row in by
     * `over`, each of its n cards gives up over/n of width, so the height gives
     * up (over / n) / ratio.
     */
    function fitInsidePicker(container) {
        const base = parseFloat(container.dataset.kefinBaseH);
        if (!(base > 0)) return;

        const picker = document.querySelector('[data-role="page"]:not(.hide) .alphaPicker')
            || document.querySelector('.alphaPicker');
        if (!picker) return;
        const pr = picker.getBoundingClientRect();
        if (!pr.width) return;

        const cards = container.querySelectorAll(CARD_SELECTOR);
        if (!cards.length) return;

        let right = 0, top = null;
        cards.forEach((c) => {
            const r = c.getBoundingClientRect();
            if (r.right > right) { right = r.right; top = Math.round(r.top); }
        });
        if (!right) return;

        let perRow = 0;
        cards.forEach((c) => { if (Math.round(c.getBoundingClientRect().top) === top) perRow++; });
        if (perRow < 1) return;

        const limit = pr.left - PICKER_CLEARANCE;
        const current = parseFloat(container.style.getPropertyValue('--kac-h')) || base;
        const over = right - limit;

        if (over > 0.5) {
            const next = Math.max(Math.floor(base * 0.9), Math.floor(current - (over / perRow) / FANART_RATIO));
            if (next > 0 && next < Math.round(current)) container.style.setProperty('--kac-h', next + 'px');
            return;
        }
        // An 8px deadband, or restoring would re-create the overlap it just
        // removed and the two would trade places on every pass.
        if (right < limit - 8 && Math.round(current) < Math.round(base)) {
            const next = Math.min(Math.round(base), Math.floor(current + (limit - 8 - right) / perRow / FANART_RATIO));
            if (next > Math.round(current)) container.style.setProperty('--kac-h', next + 'px');
        }
    }

    /**
     * Give a card its ratio, and let it animate only AFTERWARDS.
     *
     * Something in the stack puts `transition: width 0.5s` on cards. A card is
     * inserted at the ladder width and gets its ratio a moment later, which is a
     * width change as far as CSS is concerned, so every card visibly slid from
     * the ladder width to its own width as it appeared. The stylesheet kills the
     * transition until this attribute is set, a frame later, by which time the
     * real size is already committed. Later changes -- a resize, a skin swap --
     * still ease.
     */
    let settleBatch = null;
    function markSettled(card) {
        if (card.dataset.kefinSettled) return;
        if (!settleBatch) {
            settleBatch = [];
            requestAnimationFrame(() => {
                const batch = settleBatch;
                settleBatch = null;
                batch.forEach((c) => { if (c.isConnected) c.dataset.kefinSettled = '1'; });
            });
        }
        settleBatch.push(card);
    }

    function applyRatio(card) {
        if (card.dataset.kefinDone) return;
        const ar = parseFloat(card.dataset.ar);
        card.dataset.kefinDone = '1';
        // No ratio on this card: an episode showing its series' poster, an item
        // the server has no ratio for, or the transformation is not in place.
        // Leave it at the row default rather than guessing.
        if (!(ar > 0)) return;
        card.style.setProperty('--kac-ar', ar.toFixed(4));
        markSettled(card);
    }

    function sweepScope(scope) {
        const containers = new Set();
        scope.querySelectorAll(CARD_SELECTOR).forEach((card) => {
            if (card.parentElement) containers.add(card.parentElement);
            applyRatio(card);
        });
        containers.forEach((c) => { measure(c); fitInsidePicker(c); });
    }

    let timer = null;
    function scheduleSweep() {
        if (timer) return;
        timer = setTimeout(() => { timer = null; visibleScopes().forEach(sweepScope); }, 120);
    }

    /**
     * Do the work in the observer, before the browser paints.
     *
     * A MutationObserver callback is a microtask, so it runs after the cards are
     * in the DOM and before the frame is drawn. Sizing here means the first
     * painted frame is already correct; leaving it to the debounced sweep means
     * painting once at the wrong size and correcting after, which is exactly the
     * flicker this feature exists to avoid.
     */
    function onMutations(records) {
        const containers = new Set();
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (node.nodeType !== 1) continue;
                const cards = node.matches?.(CARD_SELECTOR)
                    ? [node]
                    : node.querySelectorAll?.(CARD_SELECTOR) || [];
                for (const card of cards) {
                    const holder = card.parentElement;
                    if (holder && !holder.classList.contains(ACTIVE_CLASS)) measure(holder);
                    if (holder) containers.add(holder);
                    applyRatio(card);
                }
            }
        }
        containers.forEach(fitInsidePicker);
        if (containers.size) scheduleSweep();
    }

    function invalidate() {
        document.querySelectorAll('.' + ACTIVE_CLASS).forEach((c) => {
            delete c.dataset.kefinAt;
            delete c.dataset.kefinSkin;
        });
        scheduleSweep();
    }

    function watchSkin() {
        const observer = new MutationObserver((records) => {
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

            // Wait for the sheets themselves. A stylesheet that has not applied
            // yet measures as the skin being left, so a fixed delay is a bet on
            // network speed -- and winning that bet writes the old skin's height
            // back and makes the container look freshly measured.
            const settle = () => requestAnimationFrame(() => requestAnimationFrame(invalidate));
            if (!links.length) return settle();
            let outstanding = links.length;
            const done = () => { if (--outstanding <= 0) settle(); };
            links.forEach((l) => {
                if (l.sheet) return done();
                l.addEventListener('load', done, { once: true });
                l.addEventListener('error', done, { once: true });
            });
            setTimeout(invalidate, 2000);
        });
        // skinManager inserts after #cssTheme when it can, but its fallback puts
        // the link in the BODY, which a head-only observer never sees.
        observer.observe(document.documentElement, { childList: true, subtree: true });
    }

    // ------------------------------------------------------------------ init

    async function initialize(attempt = 0) {
        if (typeof ApiClient === 'undefined' || !ApiClient || !window.KefinTweaksUtils) {
            if (attempt < 40) return void setTimeout(() => initialize(attempt + 1), 250);
            WARN('Dependencies not available, giving up');
            return;
        }

        try {
            const user = await ApiClient.getCurrentUser();
            if (user?.Policy?.IsAdministrator) await ensureTransformation();
        } catch (error) {
            // A failure here costs the ratios, not the page. Report something
            // useful: a bare rejection prints as "undefined" and says nothing.
            ERR('Could not register the ratio transformation:',
                error?.message || error?.statusText || error?.status || error);
        }

        new MutationObserver(onMutations).observe(document.body, { childList: true, subtree: true });
        window.addEventListener('resize', invalidate, { passive: true });
        watchSkin();
        if (window.KefinTweaksUtils.onViewPage) {
            window.KefinTweaksUtils.onViewPage(() => scheduleSweep(), { pages: [] });
        }
        scheduleSweep();
        LOG('Aspect cards initialized');
    }

    window.KefinTweaksAspectCards = { ensureTransformation };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => initialize());
    } else {
        initialize();
    }
})();
