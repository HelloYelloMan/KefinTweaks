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
    // How much daylight to leave between the last card and the picker.
    // Smaller than ALPHA_PICKER_GAP because this one is paid for out of
    // card size rather than out of padding the layout already reserved.
    const PICKER_CLEARANCE = 4;

    // Fanart's poster shape, 1000x1426. The fallback when a container cannot be
    // measured, and the shape the card builder now requests images at, so the
    // common case needs no correction after first paint.
    const FANART_RATIO = 1000 / 1426;

    /**
     * itemId -> PrimaryImageAspectRatio, kept across visits rather than per view.
     *
     * Ratios do not change while you browse, and the same items come back on
     * every navigation -- home, then a library, then back. Persisting them
     * means the lookup happens once per item rather than once per page, which
     * is most of this feature's request cost on a session that moves around --
     * and, more importantly, that an item whose true ratio had to be learned
     * from its image is never re-learned. See loadRatioCache.
     *
     * @type {Map<string, number>}
     */
    const ratioCache = new Map();
    const pending = new Set();
    const RATIO_STORE = 'kefinTweaks_cardRatios';

    /* Ratios live in localStorage, not sessionStorage.
     *
     * A ratio here is not free information. Where the server's recorded
     * PrimaryImageAspectRatio disagrees with the actual picture -- 26 of 100
     * items measured on this library -- the only way to learn the truth is to
     * load the image and look, which happens AFTER the card has been painted at
     * the size the metadata claimed. So the card visibly resizes once.
     *
     * In sessionStorage that "once" was once per tab. A phone browser discards
     * and restores tabs constantly, so the cache was empty almost every time
     * Jellyfin was opened and the whole library re-learned itself on every
     * visit -- reported as cards starting large and shrinking down, every time,
     * never settling.
     *
     * localStorage makes it once per item, for real. The entries are tiny (an
     * id and a number) and the whole blob is dropped after CACHE_TTL_MS so
     * replaced artwork cannot be described by a stale measurement forever.
     */
    const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

    /* Cache entries are { r: ratio, t: imageTag }, not a bare number.
     *
     * Replacing an item's artwork leaves its id alone, so an id-keyed cache
     * went on describing the OLD picture -- and once these moved to
     * localStorage, not even a hard refresh cleared it. Reported exactly so.
     *
     * Jellyfin already solves this for its own image caching: every Primary
     * image URL carries `tag=<hash>`, and the item payload carries the same
     * value in ImageTags.Primary. It changes when the artwork changes. Storing
     * it alongside the ratio means new art invalidates the entry by itself,
     * with no TTL to wait out and nothing for anyone to clear by hand.
     */
    function tagOfUrl(url) {
        const m = /[?&]tag=([^&]+)/.exec(url || '');
        return m ? m[1] : null;
    }

    function knownRatio(id) {
        const entry = ratioCache.get(id);
        return entry && typeof entry.r === 'number' ? entry.r : undefined;
    }

    function loadRatioCache() {
        try {
            const raw = localStorage.getItem(RATIO_STORE)
                || sessionStorage.getItem(RATIO_STORE);   // migrate an old session's work
            if (!raw) return;
            const parsed = JSON.parse(raw);
            // Older builds stored a bare id->ratio map; accept both shapes.
            const entries = parsed && parsed.r ? parsed.r : parsed;
            const stamped = parsed && parsed.t;
            if (stamped && (Date.now() - parsed.t) > CACHE_TTL_MS) {
                localStorage.removeItem(RATIO_STORE);
                return;
            }
            Object.entries(entries).forEach(([id, v]) => {
                // Accept the old bare-number shape; it simply has no tag, so
                // the next item payload will replace it.
                if (typeof v === 'number') ratioCache.set(id, { r: v, t: null });
                else if (v && typeof v.r === 'number') ratioCache.set(id, { r: v.r, t: v.t || null });
            });
            LOG(`Reusing ${ratioCache.size} known ratio(s)`);
        } catch (e) {
            // A corrupt or blocked store costs a refetch, nothing more.
        }
    }

    let persistTimer = null;
    function writeRatioCache(map) {
        localStorage.setItem(RATIO_STORE, JSON.stringify({
            v: 1, t: Date.now(), r: Object.fromEntries(map)
        }));
    }

    function persistRatioCache() {
        if (persistTimer) return;
        persistTimer = setTimeout(() => {
            persistTimer = null;
            try {
                writeRatioCache(ratioCache);
            } catch (e) {
                /* Out of quota. Keeping the newest half is better than keeping
                   nothing: a Map iterates in insertion order, so the tail is
                   what was learned most recently and is most likely to be
                   looked at again. If even that fails, the in-memory cache
                   still carries this page. */
                try {
                    const all = [...ratioCache.entries()];
                    const keep = new Map(all.slice(Math.floor(all.length / 2)));
                    writeRatioCache(keep);
                } catch (e2) { /* nothing more to do */ }
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
                ratioCache.set(key, { r: actual, t: tagOfUrl(url) });
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
            /* The width alone is not enough to know the answer would be the same.
               A skin change does not alter the container's width, but it does
               alter both things the measurement depends on: the ladder width a
               card is given and the padding between the card and its image box.
               Keyed on width only, switching skins hit this guard and kept the
               old skin's row height -- cards sized for a height that no longer
               matched, which is a ratio applied to the wrong box, so art came out
               cut off, and rows fitted 11-12 cards where 10 was right. */
            if (String(width) === container.dataset.kefinMeasuredAt
                && skinSignature() === container.dataset.kefinSkinSig) return true;
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
        const settledWidth = Math.round(container.getBoundingClientRect().width);
        container.dataset.kefinMeasuredAt = String(settledWidth);
        container.dataset.kefinSkinSig = skinSignature();
        // The height before any picker correction. fitInsidePicker always works
        // from this, so the correction cannot compound on itself each sweep.
        container.dataset.kefinBaseH = String(Math.round(height));
        container.classList.add(ACTIVE_CLASS);
        return true;
    }

    /* The width-keyed measurement cache that used to live here has been removed.
     *
     * It keyed a solved row height on (skin, CONTAINER width) and reused it for
     * the next container of that width. On a library page, where there is one
     * container, that was harmless. On the home screen it was not: every row is
     * the full width of the page, so every row collided on one key, and the
     * first row to be measured stamped its height onto all of them. Dumped from
     * a phone-sized home screen, 17 rows, every one of them
     * `containerW 379, cardH_var 170px, measuredAt 379` out of a cache holding
     * exactly one entry -- while the rows' real card heights ranged from 220 to
     * 239. A row whose cards were not the size of that first row rendered too
     * large, and stayed too large: activating from the cache also stamped
     * kefinMeasuredAt and kefinSkinSig, so measureAndActivate's guard
     * short-circuited and the row never corrected itself. Refreshing the section
     * rebuilt the container, which is why that was the only thing that worked.
     *
     * The cache existed to avoid painting once at the ladder width before the
     * measurement landed. Measuring the container's own first card in the
     * pre-paint observer achieves the same thing and cannot be wrong about which
     * row it is describing, so there is nothing left for a cache to do.
     */

    function fitInsidePicker(container) {
        const base = parseFloat(container.dataset.kefinBaseH);
        if (!(base > 0)) return;

        const readH = () => parseFloat(container.style.getPropertyValue('--kefin-card-h')) || base;

        const picker = document.querySelector('[data-role="page"]:not(.hide) .alphaPicker')
            || document.querySelector('.alphaPicker');
        if (!picker) return;
        const pr = picker.getBoundingClientRect();
        if (!pr.width) return;

        const cards = container.querySelectorAll(CARD_SELECTOR);
        if (!cards.length) return;

        const limit = pr.left - PICKER_CLEARANCE;

        // The row that reaches furthest right is the one that has to fit, and
        // how many cards are on it decides how much each has to give up.
        let worstRight = 0;
        let worstTop = null;
        cards.forEach((c) => {
            const r = c.getBoundingClientRect();
            if (r.right > worstRight) { worstRight = r.right; worstTop = Math.round(r.top); }
        });
        if (!worstRight) return;

        let rowCount = 0;
        cards.forEach((c) => {
            if (Math.round(c.getBoundingClientRect().top) === worstTop) rowCount++;
        });
        if (rowCount < 1) return;

        const ratio = parseFloat(container.style.getPropertyValue('--kefin-card-r-default')) || FANART_RATIO;
        const current = readH();
        const overhang = worstRight - limit;

        /* Solve the shrink instead of scaling by a ratio of spans.
         *
         * Scaling the height by room/span under-corrects, and measurably so:
         * 4.9px of overlap became 2.8px rather than none. A card's width is
         * `height x ratio + pad`, and the pad is a fixed number of pixels that
         * does not shrink with the height, so a proportional scale never removes
         * a proportional amount of width.
         *
         * Going the other way is exact. To pull the row in by `overhang`, each
         * of the n cards on it must lose overhang/n of width, and width comes
         * from height through the ratio -- so the height gives up
         * (overhang / n) / ratio. Computed from the CURRENT height, so a row
         * that is still over after one pass keeps closing on the next.
         */
        if (overhang > 0.5) {
            const deltaH = (overhang / rowCount) / ratio;
            const floorH = Math.floor(base * 0.9);   // never shrink beyond a tenth
            const next = Math.max(floorH, Math.floor(current - deltaH));
            if (next > 0 && next < Math.round(current)) {
                container.style.setProperty('--kefin-card-h', next + 'px');
            }
            return;
        }

        /* Give the height back when the row is comfortably clear.
         *
         * The 8px deadband is what stops this fighting the branch above:
         * restoring the moment the overlap is gone would re-create it, and the
         * two would trade places every sweep.
         */
        if (worstRight < limit - 8 && Math.round(current) < Math.round(base)) {
            const gain = (limit - 8 - worstRight) / rowCount / ratio;
            const next = Math.min(Math.round(base), Math.floor(current + gain));
            if (next > Math.round(current)) {
                container.style.setProperty('--kefin-card-h', next + 'px');
            }
        }
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

    /**
     * Let a card animate future width changes, but not the first one.
     *
     * Deferred by a frame so the size being applied right now is committed
     * without a transition; anything that changes afterwards eases. Batched
     * through one rAF so a screenful of cards costs a single callback.
     */
    let settleQueue = null;
    function markSettled(card) {
        if (card.dataset.kefinSettled) return;
        if (!settleQueue) {
            settleQueue = [];
            requestAnimationFrame(() => {
                const batch = settleQueue;
                settleQueue = null;
                batch.forEach((c) => { if (c.isConnected) c.dataset.kefinSettled = '1'; });
            });
        }
        settleQueue.push(card);
    }

    function setRatio(card, ratio, containerDefault) {
        card.dataset.kefinRatioSet = '1';
        markSettled(card);
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
                    ratioCache.set(item.Id, {
                        r: item.PrimaryImageAspectRatio,
                        t: (item.ImageTags && item.ImageTags.Primary) || null
                    });
                }
            });
            // Remember the misses too, so they are not asked for again.
            wanted.forEach((id) => { if (!ratioCache.has(id)) ratioCache.set(id, { r: 0, t: null }); });
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
            /* An ACTIVE container still needs re-measuring when its recorded
               measurement no longer describes the page.
               Gating on the class alone meant a container was measured exactly
               once, ever. Invalidating after a skin change deletes
               kefinMeasuredAt, but the container keeps the class, so this was
               the line that refused to act on it -- and the resize path is the
               only other caller. Worse, the invalidation lands while the library
               page is HIDDEN (the skin is changed from the preferences page, and
               a hidden page measures zero), so that attempt fails by design and
               the only chance to recover is here, on the way back.
               measureAndActivate's own guard makes the settled case a cheap
               width-and-signature comparison, so calling it every sweep costs
               nothing when nothing has changed. */
            const active = container.classList.contains(ACTIVE_CLASS);
            const stale = !container.dataset.kefinMeasuredAt
                || container.dataset.kefinSkinSig !== skinSignature();
            if (!active || stale) measureAndActivate(container);
            fitInsidePicker(container);
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
            setRatio(card, knownRatio(id), def);
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
        // No early return on an empty cache: this pass also activates the
        // container and fits the rows inside the picker, both of which have to
        // happen whether or not any ratio is known yet.
        const touched = new Set();
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (node.nodeType !== 1) continue;
                const cards = node.matches?.(CARD_SELECTOR)
                    ? [node]
                    : node.querySelectorAll?.(CARD_SELECTOR) || [];
                for (const card of cards) {
                    /* Size this container from its OWN first card, in the same
                       frame that card arrives, so it is never painted at the
                       ladder width first. measureAndActivate measures the probe
                       directly when the container is not yet active, which is
                       exactly the situation here -- there is no class to take
                       off, so it costs one layout read and is exact. */
                    const holder = card.parentElement;
                    if (holder && !holder.classList.contains(ACTIVE_CLASS)) measureAndActivate(holder);
                    if (holder) touched.add(holder);
                    if (card.dataset.kefinRatioSet) continue;
                    if (card.getAttribute('data-type') === 'Episode') continue;
                    const id = card.getAttribute('data-id');
                    if (!id) continue;

                    /* Prefer a ratio the card was BORN with.
                     *
                     * Inert today -- nothing emits data-ar yet. This is the hook
                     * for the File Transformation route: jellyfin-web builds its
                     * card markup as a string with the item in scope, so one
                     * substitution can stamp each card with its own
                     * PrimaryImageAspectRatio. If that lands, the ratio arrives
                     * WITH the card -- correct, current, before paint -- and the
                     * whole discovery layer below (API lookups, the response
                     * harvest, the persisted cache and its tag bookkeeping) has
                     * nothing left to do. It is also the layer every staleness
                     * bug has come out of.
                     *
                     * If the patch ever stops applying -- a Jellyfin update
                     * renaming minified identifiers, say -- the attribute is
                     * simply absent and this falls through to the existing path,
                     * so the feature degrades instead of breaking.
                     */
                    const born = parseFloat(card.dataset.ar);
                    if (isFinite(born) && born > 0) {
                        card.style.setProperty(RATIO_PROP, born.toFixed(4));
                        card.dataset.kefinRatioSet = '1';
                        markSettled(card);
                        continue;
                    }

                    const ratio = knownRatio(id);
                    if (!ratio) continue;
                    card.style.setProperty(RATIO_PROP, ratio.toFixed(4));
                    card.dataset.kefinRatioSet = '1';
                    markSettled(card);
                }
            }
        }

        /* Fit the rows inside the picker NOW, while this batch is still unpainted.
         *
         * This used to run only from the debounced sweep, 200ms later -- which
         * is to say after the cards had been drawn. The correction shrinks the
         * row height, so every card in the container changed width a moment
         * after appearing: measured on a phone, 100 of 100 cards with
         * --kefin-card-h going 170px to 165px, ratios already correct and
         * unchanged. The sizing was right both times; the second one just
         * arrived too late to be invisible.
         *
         * Jellyfin inserts a container's cards in one batch, so by the time this
         * runs the row geometry is already there to measure -- it just has not
         * been painted yet, which is exactly the moment to adjust it.
         */
        touched.forEach(fitInsidePicker);
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
    /**
     * What the current skin is, as far as sizing is concerned.
     *
     * The href list is the honest answer: skinManager removes every skin link
     * and inserts fresh ones on each change, a skin can contribute several
     * sheets, and the optional per-skin includes are switched independently but
     * change card metrics just the same. Sorting keeps the signature stable when
     * only the insertion order moves.
     */
    function skinSignature() {
        return Array.from(document.querySelectorAll('link[data-kefin-skin], link[data-kefin-optional-include]'))
            .map((l) => l.getAttribute('href') || '')
            .sort()
            .join('|');
    }

    function invalidateMeasurements() {
        document.querySelectorAll('.' + ACTIVE_CLASS).forEach((container) => {
            delete container.dataset.kefinMeasuredAt;
        });
        scheduleSweep();
    }

    function watchForSkinChanges() {
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

            /* Wait for the sheets themselves, not for a guessed delay.
             *
             * This used to re-measure on 250ms and 1200ms timers. A stylesheet
             * that has not applied yet measures as the skin being left, so the
             * timers were a bet on network speed -- and when the 250ms pass won
             * that bet, it wrote the OLD skin's height back and the container
             * looked freshly measured. Waiting on each new sheet's own load
             * event removes the guess. The frame after gives style resolution a
             * chance to land before anything is read.
             */
            const settle = () => requestAnimationFrame(() =>
                requestAnimationFrame(invalidateMeasurements));
            if (!links.length) { settle(); return; }
            let outstanding = links.length;
            const done = () => { if (--outstanding <= 0) settle(); };
            links.forEach((l) => {
                if (l.sheet) { done(); return; }         // already applied
                l.addEventListener('load', done, { once: true });
                l.addEventListener('error', done, { once: true });
            });
            // A sheet that never fires either event must not strand the sweep.
            setTimeout(invalidateMeasurements, 2000);
        });
        /* Watch the whole document, not just head. skinManager inserts after
           #cssTheme when it can, but its fallback is `#reactRoot.after(link)`,
           which puts the link in the BODY -- invisible to a head-only observer,
           and that is the path a skin change takes when cssTheme is missing. */
        observer.observe(document.documentElement, { childList: true, subtree: true });
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
            const tag = (item.ImageTags && item.ImageTags.Primary) || null;
            const prev = ratioCache.get(item.Id);
            /* Same artwork: keep what we have. It may be a ratio measured from
               the image itself, which is better than the server's record.
               Different tag -- new art, or an entry from before tags were
               stored -- take the server's value and let it be re-verified. */
            if (prev && prev.t === tag) continue;
            ratioCache.set(item.Id, { r: item.PrimaryImageAspectRatio, t: tag });
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
