// KefinTweaks Virtual Specials Tweaks
//
// Three fixes to the collection (BoxSet) detail page, sharing one fetch of the
// collection's children. Written for the generated per-work specials
// collections, but every one of them is just as right on a hand-curated
// collection, and none of them look at where the collection came from.
//
//   1. ARTWORK FALLBACK. A generated collection has a poster and nothing else:
//      of 300 here, 253 have no backdrop and 254 no logo. The page still lays
//      out .itemBackdrop at full size, so it renders as a large empty box, and
//      .detailLogo stays hidden so the title is plain text. This walks a chain
//      of increasingly distant sources and borrows the first artwork it finds.
//
//   2. STUDIOS. jellyfin-web's renderStudio opens with an unconditional early
//      return for BoxSet and Playlist -- "the list of studios can be massive
//      for collections of items" -- so the row is built, left empty, and
//      hidden however few studios the collection has.
//
//   3. THE "Special - " PREFIX. getDisplayName prepends
//      ValueSpecialEpisodeName to every episode with ParentIndexNumber === 0,
//      everywhere, with no option. On a collection built to group a series'
//      specials it is on every card and distinguishes nothing.
//
// THE FALLBACK CHAIN, and why it is shaped this way
// -------------------------------------------------
// In order, stopping per image type at the first source that has one:
//
//   1. the collection itself          -- nothing to do if it already has one
//   2. the first child                -- a movie collection's child carries a
//                                        full set; an episode has only a still
//   3. the series sharing the collection's AniDB id
//   4. the child's season             -- the Specials folder
//   5. the child's series             -- the show the Specials folder is in
//
// Step 3 is the interesting one. These collections carry TWO ids: ProviderIds
// .AniDB is the anime the release actually IS, and .AnimePipelineSeries is the
// show whose Specials folder holds it. They differ when a special is itself a
// separate work that the library also has as a series -- the collection named
// "Steins;Gate" sits in Steins;Gate 0's specials and carries AniDB 7729, the
// ORIGINAL Steins;Gate, whose artwork is the right artwork for it. Step 5
// would give it Steins;Gate 0's instead, which is a different show.
//
// Step 3 needs an AniDB id to resolve to a Jellyfin item, and there is no
// server-side way to ask: the AnyProviderIdEquals filter is accepted and then
// ignored on this endpoint (measured -- a real id, a nonsense id and no filter
// at all each returned all 488 series). So the map is built client side, from
// one Series query with ProviderIds and images and user data switched off, and
// cached for a day. It is only ever fetched when a collection's own AniDB id
// differs from its parent's AND the artwork is actually missing, which today
// is a single collection out of 300.
//
// Step 3 is CONDITIONAL, and that is not an optimisation. It runs only when the
// two ids differ. pauseScreen.js carries the lesson in its own logo chain: it
// used to try the series before the season, and since a series almost always
// has a logo, a season-specific one could never win. Step 3 resolves to the
// containing series in 83 of the 84 collections where it resolves at all, so
// running it unguarded would put the series ahead of the season and shadow it
// exactly the same way. Guarded, it fires only where it points somewhere step 5
// would not have reached.
//
// Step 4 almost never contributes -- a Specials folder had a backdrop in 0 of
// 60 sampled and a logo in 4 -- but the child fetch already returns its id, so
// checking it costs nothing.
//
// WHY THIS CHECKS METADATA WHERE pauseScreen.js DOES NOT
// ------------------------------------------------------
// The pause screen builds "blind" candidate URLs with no tag and no existence
// check, then walks them with an <img>'s onerror handler until one loads --
// zero metadata requests, because the image request IS the test. That is not
// available here: .itemBackdrop and .detailLogo are divs carrying a
// background-image, and a background that 404s reports nothing. So each
// candidate is checked through its ImageTags instead, at a cost of up to two
// small requests, on a page that is already making several. The upside is that
// the URLs written are tagged, so they cache and invalidate correctly, which
// the blind ones do not.

(function () {
    'use strict';

    const LOG = (...args) => console.log('[KefinTweaks VirtualSpecials]', ...args);
    const WARN = (...args) => console.warn('[KefinTweaks VirtualSpecials]', ...args);

    const POLL_INTERVAL_MS = 150;
    const POLL_TIMEOUT_MS = 8000;
    const SETTLE_MS = 220;
    const OBSERVE_MS = 15000;

    const ANIDB_CACHE_NAME = 'virtualSpecials_anidbSeries';
    const ART_FLAG = 'kefinFallbackArt';
    const ART_FLAG_ATTR = 'kefin-fallback-art';

    // ======================================================================
    // Shared data
    // ======================================================================

    function getItem(itemId) {
        if (!itemId) return Promise.resolve(null);
        return ApiClient.getItem(ApiClient.getCurrentUserId(), itemId).catch(() => null);
    }

    function fetchChildren(collectionId) {
        return ApiClient.getItems(ApiClient.getCurrentUserId(), { ParentId: collectionId })
            .then(r => r.Items || [])
            .catch(error => { WARN('Could not read collection children:', error); return []; });
    }

    // ======================================================================
    // 1. Artwork fallback
    // ======================================================================

    let aniDbSeriesMap = null;

    async function getAniDbSeriesMap() {
        if (aniDbSeriesMap) return aniDbSeriesMap;

        let cache = null;
        try {
            if (window.LocalStorageCache) cache = new window.LocalStorageCache();
            const cached = cache && cache.get(ANIDB_CACHE_NAME);
            if (cached) { aniDbSeriesMap = cached; return aniDbSeriesMap; }
        } catch (e) { /* cache unavailable; fall through and fetch */ }

        try {
            const res = await ApiClient.getItems(ApiClient.getCurrentUserId(), {
                IncludeItemTypes: 'Series',
                Recursive: true,
                Fields: 'ProviderIds',
                EnableImages: false,
                EnableUserData: false,
                Limit: 5000
            });
            const map = {};
            (res.Items || []).forEach(s => {
                const anidb = (s.ProviderIds || {}).AniDB;
                if (anidb && !map[anidb]) map[anidb] = s.Id;
            });
            aniDbSeriesMap = map;
            try { if (cache) cache.set(ANIDB_CACHE_NAME, map); } catch (e) { /* quota */ }
            LOG('Indexed', Object.keys(map).length, 'series by AniDB id');
            return map;
        } catch (error) {
            WARN('Could not index series by AniDB id:', error);
            aniDbSeriesMap = {};
            return aniDbSeriesMap;
        }
    }

    const hasBackdrop = item => !!(item && item.BackdropImageTags && item.BackdropImageTags.length);
    const hasLogo = item => !!(item && item.ImageTags && item.ImageTags.Logo);

    function backdropUrlOf(item) {
        return ApiClient.getImageUrl(item.Id, {
            type: 'Backdrop', index: 0, tag: item.BackdropImageTags[0], maxWidth: 1920
        });
    }

    function logoUrlOf(item) {
        return ApiClient.getImageUrl(item.Id, {
            type: 'Logo', tag: item.ImageTags.Logo, maxWidth: 600
        });
    }

    // The chain as thunks, so a source is only fetched while something is still
    // missing. Steps 3 to 5 each cost a request; step 2 is already in hand.
    function buildChain(item, children) {
        const child = children[0];
        const pids = item.ProviderIds || {};
        const steps = [];

        if (child) steps.push(() => Promise.resolve(child));

        if (pids.AniDB && pids.AniDB !== pids.AnimePipelineSeries) {
            steps.push(async () => {
                const map = await getAniDbSeriesMap();
                const seriesId = map[pids.AniDB];
                if (!seriesId) return null;
                LOG('AniDB', pids.AniDB, 'resolves to a series distinct from the parent show');
                return getItem(seriesId);
            });
        }

        if (child && child.SeasonId) steps.push(() => getItem(child.SeasonId));
        if (child && child.SeriesId) steps.push(() => getItem(child.SeriesId));

        return steps;
    }

    async function resolveArtwork(item, children) {
        let needBackdrop = !hasBackdrop(item);
        let needLogo = !hasLogo(item);
        if (!needBackdrop && !needLogo) return null;

        const result = { backdrop: null, logo: null };
        const steps = buildChain(item, children);

        for (let i = 0; i < steps.length; i++) {
            if (!needBackdrop && !needLogo) break;
            let source;
            try { source = await steps[i](); } catch (e) { source = null; }
            if (!source) continue;
            if (needBackdrop && hasBackdrop(source)) {
                result.backdrop = backdropUrlOf(source);
                needBackdrop = false;
            }
            if (needLogo && hasLogo(source)) {
                result.logo = logoUrlOf(source);
                needLogo = false;
            }
        }
        return (result.backdrop || result.logo) ? result : null;
    }

    // WHERE THE BACKDROP ACTUALLY GOES.
    //
    // Not on .itemBackdrop. That element exists on every detail page and stays
    // empty even when the item HAS a backdrop -- measured on a series page,
    // where its background-image is `none` -- because ElegantFin uses it purely
    // to reserve header height. Painting it produced a second, in-flow,
    // wrongly-sized copy of the image sitting ABOVE the gradient layers instead
    // of beneath them, which is what made the page look wrong compared to a
    // series page.
    //
    // Jellyfin's real mechanism is components/backdrop/backdrop.js: a
    // .backdropImage div appended to the body-level .backdropContainer, fixed
    // and full-viewport at z-index -1, under both the gradient .backdropContainer
    // paints and the fade on .detailPageWrapperContainer. Its presence is then
    // announced by `withBackdrop` on .backgroundContainer, which is what every
    // theme keys its page background off. Miss that class and the gradient is
    // drawn for a page that has no backdrop. All three parts are reproduced
    // below, class for class.
    //
    // Preloading through an Image() first is jellyfin's own order and it earns
    // its keep twice: no half-painted backdrop fading in, and a source whose
    // image 404s never gets inserted at all -- the only load check available,
    // since a background-image that fails reports nothing.

    // Both images are preloaded before anything is revealed (see scheduleArtwork),
    // so by the time these run the bytes are in cache and the insert is instant.
    function applyBackdrop(url) {
        const container = document.querySelector('.backdropContainer');
        if (!container) return;

        const existing = container.querySelector('.displayingBackdropImage');
        if (existing) {
            // Already showing the right thing, or showing the item's OWN
            // backdrop -- which outranks anything borrowed. Leave both alone.
            if (existing.getAttribute('data-url') === url) return;
            if (!existing.dataset[ART_FLAG]) return;
            existing.remove();
        }

        const el = document.createElement('div');
        el.className = 'backdropImage displayingBackdropImage backdropImageFadeIn';
        el.style.backgroundImage = "url('" + url + "')";
        el.setAttribute('data-url', url);
        el.dataset[ART_FLAG] = '1';
        container.appendChild(el);

        const background = document.querySelector('.backgroundContainer');
        if (background) background.classList.add('withBackdrop');
    }

    function removeBorrowedBackdrop() {
        const container = document.querySelector('.backdropContainer');
        if (!container) return;
        container.querySelectorAll('.backdropImage[data-' + ART_FLAG_ATTR + ']')
            .forEach(el => el.remove());

        // Jellyfin only clears `withBackdrop` when IT changes the backdrop, so
        // taking ours away can leave the class behind and style the next page as
        // though it had a backdrop it does not have.
        if (!container.querySelector('.backdropImage')) {
            const background = document.querySelector('.backgroundContainer');
            if (background) background.classList.remove('withBackdrop');
        }
    }

    function removeBorrowedLogo() {
        document.querySelectorAll('.detailLogo[data-' + ART_FLAG_ATTR + ']').forEach(logo => {
            logo.style.backgroundImage = '';
            delete logo.dataset[ART_FLAG];
            logo.classList.add('hide');
        });
    }

    // WHEN A BORROWED LOGO IS SAFE TO SHOW.
    //
    // ElegantFin positions .detailLogo for one layout: the standard
    // portrait-poster page, with `top: calc(100vh - ...)` and
    // `transform: translateY(-100%)` so it sits at the foot of a full-height
    // header. When the detail image is NOT a portrait card it shrinks that
    // header to 73vh, and then only handles the logo for some of those cases --
    // hidden for .album and .backdropCard, moved for .person. .squareCard is
    // not among them, so a logo shown there keeps its 100vh position, lands
    // below the shortened header and sits on top of the description.
    //
    // That combination never arose before this feature: a collection with a
    // non-portrait poster had no logo to place. It arises now because 19 of the
    // 300 collections here have a non-portrait Primary -- AniDB hands back a
    // landscape picture for some releases, 400x331 for the Sagacious Wisdom
    // one -- and jellyfin-web renders any Primary wider than about 0.85 as a
    // squareCard.
    //
    // So a logo is only borrowed where the page is in the layout the skin
    // positions logos for. Declining is not a degradation: ElegantFin restores
    // the text title through
    // `.detailLogo.hide ~ .detailPageWrapperContainer .nameContainer h1`,
    // so the page reads exactly as it did before, just with a backdrop.
    function logoLayoutIsSafe(page) {
        const card = page.querySelector('.detailImageContainer .card');
        return !!card && card.classList.contains('portraitCard');
    }

    // renderLogo does exactly this: drop `hide`, set the image. Only ever fills
    // a blank -- an element already carrying an image belongs to the item.
    function applyLogo(page, url) {
        const logo = page.querySelector('.detailLogo');
        if (!logo) return;
        if (logo.style.backgroundImage && !logo.dataset[ART_FLAG]) return;

        if (!logoLayoutIsSafe(page)) {
            // Undo an earlier tick that ran before the poster card existed.
            if (logo.dataset[ART_FLAG]) {
                logo.style.backgroundImage = '';
                delete logo.dataset[ART_FLAG];
                logo.classList.add('hide');
            }
            return;
        }

        logo.style.backgroundImage = "url('" + url + "')";
        logo.dataset[ART_FLAG] = '1';
        logo.classList.remove('hide');
    }

    function preload(url) {
        return new Promise(resolve => {
            const img = new Image();
            img.onload = () => resolve(true);
            img.onerror = () => resolve(false);
            img.src = url;
        });
    }

    // The detail view finishes rendering in passes and can re-hide the logo
    // after we write it, so re-apply on a few bounded ticks rather than
    // observing. Both apply functions are idempotent, so repeating is cheap.
    const ART_RETRIES_MS = [0, 250, 800, 2000, 3500];
    let artTimers = [];

    function stopArtRetries() {
        artTimers.forEach(clearTimeout);
        artTimers = [];
    }

    // NOTHING IS REVEALED UNTIL IT HAS LOADED, and for the logo that is not a
    // nicety. ElegantFin swaps the text title for the logo the moment
    // .detailLogo loses `hide`
    // (`.detailLogo:not(.hide) ~ ... .nameContainer h1 { display: var(--itemTitleVisibility) }`,
    // and the rule beside it puts the title back for `.detailLogo.hide`). So a
    // borrowed logo whose URL 404s would hide the title and show nothing in its
    // place, leaving the page with no title at all. Verifying the load first is
    // also the only check available: a background-image that fails reports
    // nothing to the page.
    async function scheduleArtwork(page, art, alive) {
        stopArtRetries();

        const [backdropOk, logoOk] = await Promise.all([
            art.backdrop ? preload(art.backdrop) : Promise.resolve(false),
            art.logo ? preload(art.logo) : Promise.resolve(false)
        ]);
        if (!alive()) return;

        const backdrop = backdropOk ? art.backdrop : null;
        const logo = logoOk ? art.logo : null;
        if (!backdrop && !logo) return;

        artTimers = ART_RETRIES_MS.map(delay => setTimeout(() => {
            if (!alive()) return;
            if (backdrop) applyBackdrop(backdrop);
            if (logo) applyLogo(page, logo);
        }, delay));

        LOG('Borrowed artwork:', [backdrop && 'backdrop', logo && 'logo']
            .filter(Boolean).join(' + ') || 'none (nothing loaded)');
    }


    // ======================================================================
    // 2. Studios row
    // ======================================================================

    const STUDIOS_ATTR = 'data-kefin-studios';

    function findLinkTemplate(page) {
        const group = page.querySelector('.itemDetailsGroup');
        if (!group) return null;
        const rows = group.querySelectorAll('.detailsGroupItem:not(.studiosGroup)');
        for (let i = 0; i < rows.length; i++) {
            const a = rows[i].querySelector('.content a');
            if (a) return a;
        }
        return null;
    }

    // Cloned, not written out: these anchors are is="emby-linkbutton" custom
    // built-in elements, and setting that attribute on an anchor created
    // afterwards does not upgrade it. Only a clone of an already-upgraded
    // element carries both the behaviour and the skin's `.content > a` styling.
    function buildStudioLink(template, studio, serverId) {
        const href = '#/details?id=' + encodeURIComponent(studio.Id)
            + '&serverId=' + encodeURIComponent(serverId);
        let link;
        if (template) {
            link = template.cloneNode(true);
        } else {
            link = document.createElement('a');
            link.className = 'button-link emby-button';
            link.setAttribute('style', 'color:inherit;');
        }
        link.setAttribute('href', href);
        link.textContent = studio.Name;
        return link;
    }

    function injectStudios(page, item) {
        const groupEl = page.querySelector('.studiosGroup');
        if (!groupEl) return;

        const studios = (item && item.Studios) || [];
        const label = groupEl.querySelector('.studiosLabel');
        const content = groupEl.querySelector('.studios');
        if (!content) return;

        if (!studios.length) {
            // Leave the row as jellyfin-web left it, and undo a previous item's
            // injection if this page element is being reused.
            if (groupEl.getAttribute(STUDIOS_ATTR)) {
                content.innerHTML = '';
                groupEl.classList.add('hide');
                groupEl.removeAttribute(STUDIOS_ATTR);
            }
            return;
        }

        const serverId = item.ServerId
            || (window.ApiClient && ApiClient.serverId && ApiClient.serverId());
        const template = findLinkTemplate(page);

        content.innerHTML = '';
        studios.forEach((studio, i) => {
            if (!studio || !studio.Id) return;
            if (i > 0) content.appendChild(document.createTextNode(', '));
            content.appendChild(buildStudioLink(template, studio, serverId));
        });

        if (label) label.textContent = studios.length > 1 ? 'Studios' : 'Studio';
        groupEl.classList.remove('hide');
        groupEl.setAttribute(STUDIOS_ATTR, '1');
    }

    // ======================================================================
    // 3. The "Special - " prefix
    // ======================================================================
    //
    // Not stripped as a string: the prefix is localized ("Extra – {0}" in de,
    // "Especial - {0}" in es), so a text match would work in one language.
    // The item's own Name is written back instead -- what getDisplayName
    // started from, so it is exact by construction and idempotent. The same
    // fetch supplies the condition, jellyfin-web's own rather than an
    // approximation of it, so a collection of ordinary episodes keeps the
    // "S1:E5 - " numbering that a different branch produces.

    function specialNamesFrom(children) {
        const names = new Map();
        children.forEach(child => {
            if (child.Type === 'Episode' && child.ParentIndexNumber === 0 && child.Name) {
                names.set(child.Id, child.Name);
            }
        });
        return names;
    }

    // A card can hold more than one text anchor, so pick the one whose text ENDS
    // WITH the real name: that is the one carrying "<prefix>Name".
    function retitleCard(card, name) {
        const anchors = card.querySelectorAll('a.textActionButton');
        for (let i = 0; i < anchors.length; i++) {
            const text = (anchors[i].textContent || '').trim();
            if (text === name) return false;
            if (text.endsWith(name)) { anchors[i].textContent = name; return true; }
        }
        return false;
    }

    function applyNames(container, names) {
        container.querySelectorAll('.card[data-id]').forEach(card => {
            const name = names.get(card.getAttribute('data-id'));
            if (name) retitleCard(card, name);
        });
    }

    // ======================================================================
    // Observers
    // ======================================================================
    //
    // Two, because the two targets settle on different schedules: the metadata
    // table re-renders in passes and can wipe the studios row, and the items row
    // re-renders on lazy load and on a sort applied by collections.js. Both are
    // bounded so nothing observes for the life of the page, and both re-apply
    // with the observer disconnected so our own writes cannot re-trigger them.

    function makeBoundedObserver(target, apply, lifetimeMs) {
        let observer = null;
        let settleTimer = null;
        let stopTimer = null;

        const stop = () => {
            if (observer) { observer.disconnect(); observer = null; }
            if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
            if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
        };
        const run = () => {
            if (observer) observer.disconnect();
            apply();
            if (observer && target.isConnected) {
                observer.observe(target, { childList: true, subtree: true });
            }
        };

        observer = new MutationObserver(() => {
            if (settleTimer) clearTimeout(settleTimer);
            settleTimer = setTimeout(run, SETTLE_MS);
        });
        observer.observe(target, { childList: true, subtree: true });
        run();
        stopTimer = setTimeout(stop, lifetimeMs);
        return stop;
    }

    // Every async continuation below outlives the navigation that started it, and
    // several of them write to elements shared across views -- .backdropContainer
    // and .backgroundContainer are body-level, and the waitFor() polls query the
    // document rather than a page. Navigate from one collection to another
    // quickly and the first page's fetches land after the second has rendered,
    // painting it with the wrong show's backdrop. So each view takes a token,
    // stopAll() invalidates it, and nothing touches the DOM once it is stale.
    let viewToken = 0;

    let teardown = [];
    function stopAll() {
        viewToken++;
        stopArtRetries();
        // These live outside the view, so a borrowed backdrop or logo would
        // otherwise follow the user to the next item. Jellyfin clears the
        // backdrop container itself on navigation, but only ours is ours to
        // remove, and this runs before we know what the next page needs.
        removeBorrowedBackdrop();
        removeBorrowedLogo();
        teardown.forEach(fn => { try { fn(); } catch (e) { /* already stopped */ } });
        teardown = [];
    }

    function waitFor(selector, startedAt) {
        return new Promise(resolve => {
            const tick = () => {
                const el = document.querySelector(selector);
                if (el) { resolve(el); return; }
                if (Date.now() - startedAt >= POLL_TIMEOUT_MS) { resolve(null); return; }
                setTimeout(tick, POLL_INTERVAL_MS);
            };
            tick();
        });
    }

    // ======================================================================
    // View hook
    // ======================================================================

    function initializeHook() {
        if (!window.KefinTweaksUtils || !window.KefinTweaksUtils.onViewPage) {
            WARN('KefinTweaksUtils.onViewPage not available, retrying in 1 second');
            setTimeout(initializeHook, 1000);
            return;
        }

        window.KefinTweaksUtils.onViewPage(
            async (view, element, hash, itemPromise) => {
                if (ApiClient._loggedIn === false) return;

                const page = document.querySelector('.itemDetailPage:not(.hide)')
                    || document.querySelector('.libraryPage:not(.hide)');
                if (!page) return;

                let item;
                try { item = await itemPromise; } catch (e) { return; }

                stopAll();
                if (!item || item.Type !== 'BoxSet' || !item.Id) return;

                const token = viewToken;
                const alive = () => token === viewToken;

                // One fetch, three consumers.
                const children = await fetchChildren(item.Id);
                if (!alive()) return;

                // --- artwork -------------------------------------------------
                resolveArtwork(item, children).then(art => {
                    if (!art || !alive()) return;
                    scheduleArtwork(page, art, alive);
                });

                // --- studios -------------------------------------------------
                waitFor('.itemDetailsGroup', Date.now()).then(group => {
                    if (!group || !alive()) return;
                    teardown.push(makeBoundedObserver(
                        group, () => injectStudios(page, item), POLL_TIMEOUT_MS));
                });

                // --- names ---------------------------------------------------
                const names = specialNamesFrom(children);
                if (names.size) {
                    waitFor('.collectionItemsContainer', Date.now()).then(container => {
                        if (!container || !alive()) return;
                        teardown.push(makeBoundedObserver(
                            container, () => applyNames(container, names), OBSERVE_MS));
                    });
                }
            },
            {
                pages: ['details'],
                triggerOnSameHash: false
            }
        );

        LOG('Virtual specials hook initialized');
    }

    function initialize(attempt = 0) {
        if (typeof ApiClient === 'undefined' || !window.KefinTweaksUtils) {
            if (attempt < 40) { setTimeout(() => initialize(attempt + 1), 250); return; }
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

    LOG('Script loaded');
})();
