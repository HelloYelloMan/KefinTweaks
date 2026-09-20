// KefinTweaks True Aspect Cards
//
// Sizes each poster card to its own image instead of forcing every one into the
// same box. Fanart posters are 1000x1426 rather than a true 2:3, DVD and case
// scans are wider again, and a handful of collections carry a still rather than
// a poster -- all of which get centre-cropped today.
//
// THE MODEL: one row height, width from the ratio. Cards keep a single height so
// rows still line up, and each card's WIDTH becomes height x ratio, so a wide
// poster takes more horizontal space rather than losing its edges. The height is
// measured from an untouched card before the feature switches on, so a 2:3
// poster ends up exactly the size it was.
//
// This works because .itemsContainer is a wrapping flex row of `flex: 0 0 auto`
// items -- variable widths need no other layout change, and rows keep wrapping
// normally.
//
// THREE THINGS ENFORCE THE FIXED SHAPE TODAY, and all three have to give:
//
//   1. The server crops. Card images are requested as
//      `fillHeight=446&fillWidth=297`; fill with both axes returns a cropped
//      image. Dropping fillWidth is enough -- `fillHeight=446` alone returns
//      460x690 for a poster whose stored file is 2:3, i.e. the true ratio.
//   2. The CSS crops what survives, via background-size: cover on a container
//      whose box is a fixed shape. Once the box matches the image, cover fills
//      it exactly and crops nothing.
//   3. The box is fixed, by the card width ladder plus an aspect-ratio on
//      .cardScalable -- which on this server comes from the user's own custom
//      CSS with !important, hence the !important in the companion stylesheet.
//
// WHERE THE RATIO COMES FROM. PrimaryImageAspectRatio, fetched for the ids on
// screen in one batched Ids= query and cached for the session. Cards carry
// data-id, so no per-card requests.
//
// A CAVEAT WORTH KNOWING: that field is metadata, and it goes stale when an
// item's image is replaced without a metadata refresh. Measured here, two of the
// ten widest collections report 1.78 while their stored image is now a plain
// 2:3. Those cards will be drawn wide and the image will fill the box, because
// cover is kept rather than contain. A metadata refresh on the affected item
// fixes it at the source; nothing here can tell the difference without
// downloading every image to measure it.

(function () {
    'use strict';

    const LOG = (...args) => console.log('[KefinTweaks TrueAspect]', ...args);
    const WARN = (...args) => console.warn('[KefinTweaks TrueAspect]', ...args);

    const ACTIVE_CLASS = 'kefin-true-aspect';
    const RATIO_PROP = '--kefin-card-ratio';
    const CARD_SELECTOR = '.card.portraitCard, .card.overflowPortraitCard';

    // Ratios this far from the container default are the whole point; anything
    // closer is visually identical and not worth a reflow.
    const MIN_DELTA = 0.005;

    /** @type {Map<string, number>} itemId -> PrimaryImageAspectRatio */
    const ratioCache = new Map();
    const pending = new Set();

    function visibleScopes() {
        const pages = document.querySelectorAll('[data-role="page"]:not(.hide)');
        return pages.length ? Array.from(pages) : [document];
    }

    /**
     * Stop the server cropping the image.
     *
     * `fillHeight=H&fillWidth=W` returns a centre-cropped H x W; the same request
     * without fillWidth returns the image scaled to that height with its own
     * ratio intact. Only the width parameter is dropped, so the requested
     * resolution -- and therefore the cache entry Jellyfin already has -- stays
     * the same on the axis that matters.
     */
    function uncroppedUrl(url) {
        if (!url || url.indexOf('fillWidth=') === -1) return url;
        return url
            .replace(/[?&]fillWidth=\d+/, (m) => (m[0] === '?' ? '?' : ''))
            .replace(/\?&/, '?')
            .replace(/&&/g, '&')
            .replace(/[?&]$/, '');
    }

    function applyUncroppedImage(card) {
        const holder = card.querySelector('.cardImageContainer');
        if (!holder || holder.dataset.kefinUncropped) return;
        const bg = holder.style.backgroundImage || '';
        const match = bg.match(/url\(["']?(.*?)["']?\)/);
        if (!match) return;
        const next = uncroppedUrl(match[1]);
        if (next !== match[1]) holder.style.backgroundImage = `url("${next}")`;
        holder.dataset.kefinUncropped = '1';
    }

    /**
     * What is this card actually showing?
     *
     * The ratio has to describe the PICTURE on the card, which is not always the
     * card's own item. A Recently Added episode is drawn as a portrait card
     * holding its SERIES poster, so sizing it by the episode's
     * PrimaryImageAspectRatio -- the 16:9 still -- turned every one of them into
     * a letterbox. Reported as exactly that, and measured: overflowPortraitCard
     * episodes carrying --kefin-card-ratio 1.7778.
     *
     * So the id and the image type come from the URL the card is displaying,
     * not from data-id. An episode showing its series' poster is then looked up
     * as the series, which is the right answer rather than a special case.
     *
     * Returns null when the card has no image yet -- cards load lazily, and a
     * card that is not ready must be retried rather than settled, or it keeps
     * whatever default it started with forever.
     *
     * @returns {{ id: string, type: string }|null}
     */
    function displayedImage(card) {
        const holder = card.querySelector('.cardImageContainer');
        const bg = holder ? (holder.style.backgroundImage || '') : '';
        const m = bg.match(/\/Items\/([a-f0-9-]+)\/Images\/([A-Za-z]+)/);
        return m ? { id: m[1], type: m[2] } : null;
    }

    /**
     * Switch a container on, remembering the height its cards had first.
     *
     * The measurement has to happen before the class lands: afterwards every
     * height comes from the variable this is trying to establish. Re-measuring
     * later therefore means taking the class off, reading, and putting it back,
     * which is what the resize path does.
     */
    function measureAndActivate(container) {
        const probe = container.querySelector(CARD_SELECTOR);
        if (!probe) return false;

        const wasActive = container.classList.contains(ACTIVE_CLASS);
        if (wasActive) container.classList.remove(ACTIVE_CLASS);

        const scalable = probe.querySelector('.cardScalable');
        if (!scalable) {
            if (wasActive) container.classList.add(ACTIVE_CLASS);
            return false;
        }
        const rect = scalable.getBoundingClientRect();
        if (!rect.height || !rect.width) {
            if (wasActive) container.classList.add(ACTIVE_CLASS);
            return false;
        }

        // The image box is narrower than the card: .cardScalable sits inside a
        // padded .cardBox. Width has to carry that difference or the ratio lands
        // on the card and not on the picture.
        const cardRect = probe.getBoundingClientRect();
        const pad = Math.max(0, Math.round(cardRect.width - rect.width));

        container.style.setProperty('--kefin-card-h', Math.round(rect.height) + 'px');
        container.style.setProperty('--kefin-card-r-default', (rect.width / rect.height).toFixed(4));
        container.style.setProperty('--kefin-card-pad', pad + 'px');
        container.classList.add(ACTIVE_CLASS);
        return true;
    }

    function cardsNeedingRatio(scope) {
        const out = [];
        scope.querySelectorAll(CARD_SELECTOR).forEach((card) => {
            if (card.dataset.kefinRatioSet) return;
            const shown = displayedImage(card);
            if (!shown) return;                 // not loaded yet: try again next sweep
            if (shown.type !== 'Primary') {     // a thumb or backdrop is not a poster
                card.dataset.kefinRatioSet = '1';
                return;
            }
            out.push({ card, id: shown.id });
        });
        return out;
    }

    function setRatio(card, ratio, containerDefault) {
        card.dataset.kefinRatioSet = '1';
        if (!ratio || !isFinite(ratio) || ratio <= 0) return;
        if (containerDefault && Math.abs(ratio - containerDefault) < MIN_DELTA) return;
        card.style.setProperty(RATIO_PROP, ratio.toFixed(4));
        applyUncroppedImage(card);
    }

    async function fetchRatios(ids) {
        const wanted = ids.filter((id) => !ratioCache.has(id) && !pending.has(id));
        if (!wanted.length) return;
        wanted.forEach((id) => pending.add(id));
        try {
            const result = await ApiClient.getItems(ApiClient.getCurrentUserId(), {
                Ids: wanted.join(','),
                Fields: 'PrimaryImageAspectRatio',
                EnableUserData: false,
                EnableTotalRecordCount: false
            });
            (result?.Items || []).forEach((item) => {
                if (typeof item.PrimaryImageAspectRatio === 'number') {
                    ratioCache.set(item.Id, item.PrimaryImageAspectRatio);
                }
            });
            // Remember the misses too, so they are not asked for again.
            wanted.forEach((id) => { if (!ratioCache.has(id)) ratioCache.set(id, 0); });
        } catch (err) {
            WARN('Ratio lookup failed:', err);
        } finally {
            wanted.forEach((id) => pending.delete(id));
        }
    }

    async function processScope(scope) {
        const containers = new Set();
        scope.querySelectorAll(CARD_SELECTOR).forEach((c) => {
            if (c.parentElement) containers.add(c.parentElement);
        });
        if (!containers.size) return;

        containers.forEach((container) => {
            if (!container.classList.contains(ACTIVE_CLASS)) measureAndActivate(container);
        });

        const todo = cardsNeedingRatio(scope);
        if (!todo.length) return;

        // Batch the lookups: Jellyfin accepts a comma separated Ids list, so a
        // screenful of cards is one request rather than one per card.
        const ids = [...new Set(todo.map((t) => t.id))];
        for (let i = 0; i < ids.length; i += 100) {
            await fetchRatios(ids.slice(i, i + 100));
        }

        let applied = 0;
        todo.forEach(({ card, id }) => {
            const container = card.parentElement;
            const def = container
                ? parseFloat(getComputedStyle(container).getPropertyValue('--kefin-card-r-default'))
                : null;
            const before = card.style.getPropertyValue(RATIO_PROP);
            setRatio(card, ratioCache.get(id), def);
            if (card.style.getPropertyValue(RATIO_PROP) !== before) applied++;
        });
        if (applied) LOG(`Sized ${applied} card(s) to their own aspect ratio`);
    }

    let sweepTimer = null;
    function scheduleSweep() {
        if (sweepTimer) return;
        sweepTimer = setTimeout(() => {
            sweepTimer = null;
            visibleScopes().forEach((scope) => { processScope(scope); });
        }, 200);
    }

    /**
     * On resize the row height changes with the card width ladder, so the
     * measurement has to be retaken -- see measureAndActivate for why that means
     * removing the class first.
     */
    let resizeTimer = null;
    function onResize() {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            resizeTimer = null;
            document.querySelectorAll('.' + ACTIVE_CLASS).forEach(measureAndActivate);
        }, 250);
    }

    function initializeHook() {
        if (window.__kefinTrueAspectActive) return;
        window.__kefinTrueAspectActive = true;

        const observer = new MutationObserver(() => scheduleSweep());
        observer.observe(document.body, { childList: true, subtree: true });
        window.addEventListener('resize', onResize, { passive: true });
        // Card images are set lazily as they come into view, and that is a style
        // change rather than a DOM insertion, so the observer above does not see
        // it. Scrolling is what reveals them; the sweep is debounced either way.
        window.addEventListener('scroll', scheduleSweep, { passive: true, capture: true });

        if (window.KefinTweaksUtils?.onViewPage) {
            window.KefinTweaksUtils.onViewPage(() => scheduleSweep(), { pages: [] });
        }

        scheduleSweep();
        LOG('True aspect cards initialized');
    }

    function initialize(attempt = 0) {
        if (typeof ApiClient === 'undefined' || !ApiClient || !window.KefinTweaksUtils) {
            if (attempt < 40) {
                setTimeout(() => initialize(attempt + 1), 250);
                return;
            }
            WARN('Dependencies not available, giving up');
            return;
        }
        initializeHook();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => initialize());
    } else {
        initialize();
    }
})();
