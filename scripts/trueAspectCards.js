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

// THE EPISODE STILLS SETTING. Off by default, in this feature's own settings
// panel. Jellyfin draws episodes as portrait cards carrying their SERIES poster,
// so every episode of a show looks identical and the card says nothing about the
// episode. Switched on, the card is repointed at the episode's own Primary -- a
// 16:9 still -- and moved to the backdrop shape at the same time.
//
// Both halves are needed: swapping the image alone leaves a 16:9 still cropped
// into a 2:3 box, and changing the shape alone letterboxes the poster.
//
// It lives here rather than as a feature of its own because it is the same
// question this feature already answers -- what shape should this card be, given
// the picture on it -- and because the two have to agree: once a card is moved
// to the backdrop family the ratio pass stops looking at it, which is what keeps
// them from fighting over the same card.

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

    // Clear space left between the last card and the A-Z letters.
    const ALPHA_PICKER_GAP = 12;

    // Fanart's poster shape, 1000x1426. The fallback when a container cannot be
    // measured, and the shape the card builder now requests images at, so the
    // common case needs no correction after first paint.
    const FANART_RATIO = 1000 / 1426;

    /**
     * itemId -> PrimaryImageAspectRatio, kept for the tab rather than the view.
     *
     * Ratios do not change while you browse, and the same items come back on
     * every navigation -- home, then a library, then back. Holding them in
     * sessionStorage means the lookup happens once per item per tab instead of
     * once per page, which is most of this feature's request cost on a session
     * that moves around.
     *
     * @type {Map<string, number>}
     */
    const ratioCache = new Map();
    const pending = new Set();
    const RATIO_STORE = 'kefinTweaks_cardRatios';

    function loadRatioCache() {
        try {
            const raw = sessionStorage.getItem(RATIO_STORE);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            Object.entries(parsed).forEach(([id, r]) => ratioCache.set(id, r));
            LOG(`Reusing ${ratioCache.size} cached ratio(s) from this session`);
        } catch (e) {
            // A corrupt or blocked store costs a refetch, nothing more.
        }
    }

    let persistTimer = null;
    function persistRatioCache() {
        if (persistTimer) return;
        persistTimer = setTimeout(() => {
            persistTimer = null;
            try {
                sessionStorage.setItem(RATIO_STORE, JSON.stringify(Object.fromEntries(ratioCache)));
            } catch (e) {
                // Full or blocked: the in-memory cache still works for this page.
            }
        }, 2000);
    }

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

    /**
     * Believe the picture, not the metadata.
     *
     * PrimaryImageAspectRatio is a recorded field, and it goes stale when an
     * item's image is replaced without a metadata refresh. Reported on "Black
     * Lagoon: Roberta's Blood Trail": the field says 1.7778, the stored image is
     * 600x900, and the card was drawn 16:9 around a portrait cover.
     *
     * The image itself settles it. This only runs for cards whose requested box
     * disagreed with the metadata enough that the URL was rewritten -- so the
     * picture being measured is the one already being displayed, and reading it
     * costs a cache hit rather than a request.
     *
     * A correction is written back to the cache as well as the card, so every
     * other card for the same item, and the rest of the session, uses the truth
     * rather than repeating the measurement.
     */
    function verifyAgainstImage(card, url, claimed) {
        const probe = new Image();
        probe.onload = () => {
            const w = probe.naturalWidth, h = probe.naturalHeight;
            if (!w || !h) return;
            const actual = w / h;
            if (!isFinite(actual) || actual <= 0) return;
            if (Math.abs(actual - claimed) / claimed <= 0.02) return;

            const id = card.getAttribute('data-id');
            const shown = displayedImage(card);
            const key = shown ? shown.id : id;
            if (key) {
                ratioCache.set(key, actual);
                persistRatioCache();
            }
            card.style.setProperty(RATIO_PROP, actual.toFixed(4));
            LOG(`Metadata said ${claimed.toFixed(3)}, the image is ${actual.toFixed(3)} - corrected`);
        };
        probe.src = url;
    }

    /**
     * Only rewrite a URL that is actually asking for a crop.
     *
     * fillWidth+fillHeight crops to that box -- but only if the box disagrees
     * with the image. Jellyfin's own card builder derives the box from the item:
     * a 0.701 poster is requested as fillWidth=220&fillHeight=314, which is
     * 0.7006, so nothing is cropped and rewriting it changes nothing except
     * forcing the browser to fetch the same picture again.
     *
     * That refetch was the choppiness: entering a library, cards painted, then
     * visibly reloaded. Measured before this check -- 180 Primary image requests
     * for 103 items, 77 of them fetched twice, every double being
     * `fillHeight=314&fillWidth=220` followed by `fillHeight=314`.
     *
     * So the box is compared against the item's ratio first, and left alone when
     * they already agree. What remains rewritten is the genuine case: a card
     * whose requested box is a different shape from its picture.
     */
    function applyUncroppedImage(card, ratio) {
        const holder = card.querySelector('.cardImageContainer');
        if (!holder || holder.dataset.kefinUncropped) return;
        const bg = holder.style.backgroundImage || '';
        const match = bg.match(/url\(["']?(.*?)["']?\)/);
        if (!match) return;

        const url = match[1];
        const w = parseInt((url.match(/fillWidth=(\d+)/) || [])[1], 10);
        const h = parseInt((url.match(/fillHeight=(\d+)/) || [])[1], 10);
        if (w && h && ratio) {
            const requested = w / h;
            if (Math.abs(requested - ratio) / ratio <= 0.02) {
                // Already asking for the right shape; a rewrite would only refetch.
                holder.dataset.kefinUncropped = '1';
                return;
            }
        }

        const next = uncroppedUrl(url);
        if (next !== url) {
            holder.style.backgroundImage = `url("${next}")`;
            // The box and the metadata disagreed, which is exactly when the
            // metadata is worth checking against the picture itself.
            if (ratio) verifyAgainstImage(card, next, ratio);
        }
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
     * Hand back the space the A-Z picker reserves but does not use.
     *
     * A library page pads its right edge by 7.5% for the picker, which is 21px
     * wide. That leaves tens of pixels idle -- 52 at 1167px, and proportionally
     * more on a bigger screen -- while the row next to it is a pixel or two short
     * of fitting one more card. Measuring the picker and reserving only what it
     * occupies returns that room to the row.
     *
     * The gap is deliberate: the cards stop short of the letters rather than
     * running into them.
     */
    function applyAlphaPickerSlack(container) {
        if (!container.classList.contains('padded-right-withalphapicker')) return;
        const picker = document.querySelector('[data-role="page"]:not(.hide) .alphaPicker')
            || document.querySelector('.alphaPicker');
        if (!picker) return;

        // Measure to the picker's LEFT EDGE from the container's right edge, not
        // the picker's width. The picker is not flush to that edge -- it sits 14px
        // inside it -- so reserving its width alone left the content 2px under the
        // letters.
        const containerRight = container.getBoundingClientRect().right;
        const needed = Math.round(containerRight - picker.getBoundingClientRect().left) + ALPHA_PICKER_GAP;
        if (!(needed > 0)) return;

        /* Only ever hand room back, never take it.
         *
         * The reservation is 7.5% of the width, which is generous on a desktop
         * and tight on a phone. Measured at a 480px viewport: Jellyfin reserved
         * less than this calculation asked for, so setting it cost 4px of content
         * -- and 4px was the difference between three cards across and two.
         * Reported as exactly that, mobile going from three wide to two.
         *
         * Clamping to what is already reserved keeps the desktop win (87px down
         * to 47px there) and makes the narrow case a no-op.
         */
        const current = parseFloat(getComputedStyle(container).paddingRight);
        if (isFinite(current) && needed >= current) return;

        container.style.setProperty('--kefin-alpha-slack', needed + 'px');
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

        /* Do not re-measure a container that is already set up at this width.
         *
         * Measuring means taking the class off, reading a card, and putting it
         * back -- which reverts every card to the ladder width and returns it,
         * one frame later. Jellyfin keeps pages in the DOM and re-shows them, so
         * coming back to a library ran that again and made all hundred cards
         * visibly jump. Measured: 100 of 100 cards changing width on a second
         * visit, none on the first.
         *
         * The measurement only depends on the container's width, so recording it
         * is enough to know when the answer would be the same. A real resize
         * still re-measures, via the resize handler.
         */
        if (wasActive && container.style.getPropertyValue('--kefin-card-h')) {
            const width = Math.round(container.getBoundingClientRect().width);
            if (String(width) === container.dataset.kefinMeasuredAt) return true;
        }

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

        applyAlphaPickerSlack(container);

        /* Size the row so a FANART card fills exactly the slot the ladder gave it.
         *
         * Taking the height straight off the probe ties the row to whatever shape
         * Jellyfin's padder happens to be -- 2:3, measured here. Every fanart
         * poster is wider than that, so every card grew by a few pixels, and on a
         * narrow screen that is a whole card per row: mobile went from three
         * across to two, cards 126px wide into 354px of content where Jellyfin's
         * were 118.
         *
         * Solving the height from the slot instead keeps the count. A 0.7013
         * poster comes out exactly the ladder width, anything narrower is
         * narrower, and only a genuinely wide cover is wider -- which is the
         * point of the feature and rare enough not to cost a column.
         *
         * The row ends up slightly shorter than Jellyfin's 2:3 box, because that
         * is what it costs to fit a wider picture in the same width.
         */
        const slotWidth = cardRect.width;
        const solved = (slotWidth - pad) / FANART_RATIO;
        const height = solved > 0 ? solved : rect.height;

        container.style.setProperty('--kefin-card-h', Math.round(height) + 'px');
        // The fallback ratio has to match the basis the height was solved for, or
        // a card whose ratio is not known yet would not fill its slot.
        container.style.setProperty('--kefin-card-r-default', FANART_RATIO.toFixed(4));
        container.style.setProperty('--kefin-card-pad', pad + 'px');
        container.dataset.kefinMeasuredAt = String(Math.round(container.getBoundingClientRect().width));
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
        applyUncroppedImage(card, ratio);
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
            persistRatioCache();
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


    function settings() {
        return (window.KefinTweaksConfig && window.KefinTweaksConfig.trueAspectCards) || {};
    }

    function episodeStillsEnabled() {
        return settings().episodeStills === true;
    }

    // ---- episode stills -------------------------------------------------
    // Off unless the setting says otherwise; see the note at the top of the file.

    const EPISODE_DONE_ATTR = 'data-kefin-episode-thumb';
    /** @type {Map<string, boolean>} episodeId -> has a Primary image of its own */
    const hasStill = new Map();
    const stillPending = new Set();

    function episodeCandidates(scope) {
        const out = [];
        scope.querySelectorAll('.card[data-type="Episode"]').forEach((card) => {
            if (card.hasAttribute(EPISODE_DONE_ATTR)) return;
            if (!card.classList.contains('portraitCard')
                && !card.classList.contains('overflowPortraitCard')) return;
            const id = card.getAttribute('data-id');
            if (!id) return;
            const holder = card.querySelector('.cardImageContainer');
            const bg = holder ? (holder.style.backgroundImage || '') : '';
            if (!bg || bg === 'none') return;   // lazy: retry once it loads
            out.push({ card, id, holder, bg });
        });
        return out;
    }

    async function fetchStillFlags(ids) {
        const wanted = ids.filter((id) => !hasStill.has(id) && !stillPending.has(id));
        if (!wanted.length) return;
        wanted.forEach((id) => stillPending.add(id));
        try {
            const result = await ApiClient.getItems(ApiClient.getCurrentUserId(), {
                Ids: wanted.join(','),
                Fields: 'PrimaryImageAspectRatio',
                EnableUserData: false,
                EnableTotalRecordCount: false
            });
            (result?.Items || []).forEach((item) => {
                hasStill.set(item.Id, !!(item.ImageTags && item.ImageTags.Primary));
            });
            wanted.forEach((id) => { if (!hasStill.has(id)) hasStill.set(id, false); });
        } catch (err) {
            WARN('Episode image lookup failed:', err);
        } finally {
            wanted.forEach((id) => stillPending.delete(id));
        }
    }

    /**
     * Repoint the background at this episode's own Primary.
     *
     * The existing URL is edited rather than rebuilt, so the server address, the
     * size parameters and the quality the card already asked for carry over.
     * The tag has to go with it: it belongs to the series' image and would
     * return a stale or missing file against the episode.
     */
    function repointImage(holder, bg, episodeId) {
        const match = bg.match(/url\(["']?(.*?)["']?\)/);
        if (!match) return false;
        const url = match[1];
        const next = url
            .replace(/\/Items\/[a-f0-9-]+\/Images\/[A-Za-z]+/, `/Items/${episodeId}/Images/Primary`)
            .replace(/[?&]tag=[^&]*/, (m) => (m[0] === '?' ? '?' : ''))
            .replace(/\?&/, '?')
            .replace(/[?&]$/, '');
        if (next === url) return false;
        holder.style.backgroundImage = `url("${next}")`;
        return true;
    }

    /**
     * portrait -> backdrop, on the card and on its padder.
     *
     * Swapping the class families Jellyfin already uses means the card picks up
     * every backdrop rule that exists rather than needing a parallel set. The
     * padder matters as much as the card: its percentage padding is what sets
     * the height.
     */
    function reshapeToBackdrop(card) {
        const overflow = card.classList.contains('overflowPortraitCard');
        card.classList.remove('portraitCard', 'overflowPortraitCard');
        card.classList.add(overflow ? 'overflowBackdropCard' : 'backdropCard');

        const padder = card.querySelector('.cardPadder');
        if (padder) {
            padder.classList.remove('cardPadder-portrait', 'cardPadder-overflowPortrait');
            padder.classList.add(overflow ? 'cardPadder-overflowBackdrop' : 'cardPadder-backdrop');
        }
    }

    async function applyEpisodeStills(scope) {
        const todo = episodeCandidates(scope);
        if (!todo.length) return;

        const ids = [...new Set(todo.map((t) => t.id))];
        for (let i = 0; i < ids.length; i += 100) {
            await fetchStillFlags(ids.slice(i, i + 100));
        }

        let changed = 0;
        todo.forEach(({ card, id, holder, bg }) => {
            card.setAttribute(EPISODE_DONE_ATTR, '1');
            // No still of its own: keep the series poster. A card with no picture
            // is worse than a repeated one.
            if (!hasStill.get(id)) return;
            if (!repointImage(holder, bg, id)) return;
            reshapeToBackdrop(card);
            changed++;
        });
        if (changed) LOG(`Switched ${changed} episode card(s) to their own still`);
    }

    /**
     * Apply ratios we already know, before the frame is painted.
     *
     * A MutationObserver callback is a microtask: it runs at the end of the task
     * that inserted the cards, ahead of the next paint. Setting the variable here
     * means a card whose ratio is already known is never drawn at the wrong size
     * -- as opposed to the debounced sweep below, which by definition runs a
     * couple of hundred milliseconds after the card is on screen, which is the
     * resize you can see.
     *
     * Only cards whose ratio is already cached, and never Episodes. Their image
     * is usually a parent's poster, so their own ratio describes the wrong
     * picture; the unhurried pass resolves those from the image URL once it has
     * loaded. Everything else -- movies, series, collections -- lands immediately
     * on a second visit, and on the first from the session cache.
     *
     * Cards our own builder made already carry the variable and the done flag
     * from build time, so they are skipped here and never touched at all.
     */
    function applyKnownRatiosNow(records) {
        if (!ratioCache.size) return;
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (node.nodeType !== 1) continue;
                const cards = node.matches?.(CARD_SELECTOR)
                    ? [node]
                    : node.querySelectorAll?.(CARD_SELECTOR) || [];
                for (const card of cards) {
                    if (card.dataset.kefinRatioSet) continue;
                    if (card.getAttribute('data-type') === 'Episode') continue;
                    const id = card.getAttribute('data-id');
                    if (!id) continue;
                    const ratio = ratioCache.get(id);
                    if (!ratio) continue;
                    card.style.setProperty(RATIO_PROP, ratio.toFixed(4));
                    card.dataset.kefinRatioSet = '1';
                }
            }
        }
    }

    let sweepTimer = null;
    function scheduleSweep() {
        if (sweepTimer) return;
        sweepTimer = setTimeout(() => {
            sweepTimer = null;
            visibleScopes().forEach(async (scope) => {
                // Stills first: a card it reshapes leaves the portrait family, so
                // the ratio pass below correctly ignores it.
                if (episodeStillsEnabled()) await applyEpisodeStills(scope);
                processScope(scope);
            });
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

    /**
     * A skin change invalidates every measurement.
     *
     * The row height and the card padding are measured from a real card, so they
     * describe the skin that was loaded at the time. Skins differ a lot -- Abyss
     * gives a card 27px of horizontal padding and a 257px row, ElegantFin 11px
     * and 221px -- and the guard that stops needless re-measuring keys on the
     * container's width, which a skin change does not alter. So switching skins
     * left the cards at the old skin's size until the page was reloaded, which is
     * exactly what was reported.
     *
     * Watching for the skin's own link elements is the reliable signal:
     * skinManager tags them data-kefin-skin, and swaps them on every change.
     * Re-measuring waits for the sheet to actually apply -- a stylesheet that has
     * not loaded yet would be measured as the old one.
     */
    function invalidateMeasurements() {
        document.querySelectorAll('.' + ACTIVE_CLASS).forEach((container) => {
            delete container.dataset.kefinMeasuredAt;
        });
        scheduleSweep();
    }

    function watchForSkinChanges() {
        const observer = new MutationObserver((records) => {
            const touchedSkin = records.some((r) =>
                [...r.addedNodes, ...r.removedNodes].some((n) =>
                    n.nodeType === 1 && n.matches?.('link[data-kefin-skin], link[data-kefin-optional-include]')));
            if (!touchedSkin) return;
            // Give the new sheet a moment to apply; measuring it before it lands
            // would just record the old skin again.
            setTimeout(invalidateMeasurements, 250);
            setTimeout(invalidateMeasurements, 1200);
        });
        observer.observe(document.head, { childList: true });
    }

    /**
     * Take the ratios out of Jellyfin's own replies, before it builds the cards.
     *
     * A library page renders about a hundred cards in one go, and until now we
     * knew nothing about any of them: they were painted at the default and then
     * corrected once our own lookup came back. Measured, that was 75 of 100
     * visibly moving, the worst by 301px.
     *
     * But Jellyfin has already asked for exactly what we need. Its item queries
     * include PrimaryImageAspectRatio, because setCardData takes the median of
     * it to choose the row's shape. So the numbers arrive in a response that
     * lands BEFORE a single card exists -- we simply were not listening.
     *
     * Reading them on the way past fills the cache in time for
     * applyKnownRatiosNow, which runs in the observer microtask ahead of the
     * frame being painted. No extra request, no new API surface.
     *
     * DELIBERATELY TIMID. It only looks at same-origin item replies, only reads,
     * never alters the response or the timing, and any failure is swallowed --
     * the worst case is an empty cache and today's behaviour. json() gives a
     * promise on a CLONE, so the caller's body is untouched.
     */
    const ITEM_RESPONSE = /\/(Items|Users\/[^/]+\/Items|Shows\/NextUp|Shows\/Upcoming)(\?|$)/;

    function harvestRatios(payload) {
        const items = payload && (payload.Items || (Array.isArray(payload) ? payload : null));
        if (!Array.isArray(items)) return;
        let added = 0;
        for (const item of items) {
            if (!item || !item.Id) continue;
            if (typeof item.PrimaryImageAspectRatio !== 'number') continue;
            if (ratioCache.has(item.Id)) continue;
            ratioCache.set(item.Id, item.PrimaryImageAspectRatio);
            added++;
        }
        if (added) persistRatioCache();
    }

    function watchItemResponses() {
        const nativeFetch = window.fetch;
        if (typeof nativeFetch !== 'function' || nativeFetch.__kefinTrueAspect) return;

        const wrapped = function (...args) {
            const result = nativeFetch.apply(this, args);
            try {
                const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
                if (url && ITEM_RESPONSE.test(url) && !/^https?:\/\//.test(url.replace(location.origin, ''))) {
                    return result.then((response) => {
                        try {
                            response.clone().json().then(harvestRatios).catch(() => {});
                        } catch (e) { /* not json, or already consumed */ }
                        return response;
                    });
                }
            } catch (e) {
                // Never let this get between the caller and its response.
            }
            return result;
        };
        wrapped.__kefinTrueAspect = true;
        window.fetch = wrapped;
        LOG('Reading aspect ratios from Jellyfin\'s own item responses');
    }

    function initializeHook() {
        if (window.__kefinTrueAspectActive) return;
        window.__kefinTrueAspectActive = true;

        loadRatioCache();
        watchItemResponses();

        const observer = new MutationObserver((records) => {
            applyKnownRatiosNow(records);   // before paint
            scheduleSweep();                // the rest, unhurried
        });
        observer.observe(document.body, { childList: true, subtree: true });
        window.addEventListener('resize', onResize, { passive: true });
        watchForSkinChanges();
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
