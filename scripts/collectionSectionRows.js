// KefinTweaks Collection Sections As Rows
//
// On a collection (BoxSet) page, draws each section (Episodes, Movies, Series...)
// as a horizontal row of cards, built exactly the way the flat season row on a
// series page is: cardBuilder.renderProgressiveSections with an overflow card
// section, given the series-episodes-section class and the same adjustments
// seriesEpisodes.js makes. So it has that row's cards, scroll buttons and
// section controls, and every skin that styles the season row (about ten carry
// a .series-episodes-section rule) styles these the same way.
//
// Episodes use the season row's Thumb cards; albums and tracks Square; the rest
// Poster.
//
// The original section stays in the page, hidden: collections.js sorts a
// collection by moving the cards inside the first .itemsContainer. When a
// grid's cards move, its row is rebuilt in the new order.
(function () {
    'use strict';

    const LOG = (...args) => console.log('[KefinTweaks CollectionSectionRows]', ...args);
    const WARN = (...args) => console.warn('[KefinTweaks CollectionSectionRows]', ...args);

    const ROW_ATTR = 'data-kefin-section-row';
    const SECTION_HIDDEN_CLASS = 'kefin-section-replaced-by-row';
    const WAIT_MS = 15000;

    let viewToken = 0;
    let teardown = [];
    const observedGrids = new WeakSet();

    function stopAll() {
        viewToken++;
        teardown.forEach((fn) => { try { fn(); } catch (e) { /* already gone */ } });
        teardown = [];
    }

    function injectStyle() {
        if (document.getElementById('kefin-collection-section-rows-style')) return;
        const style = document.createElement('style');
        style.id = 'kefin-collection-section-rows-style';
        style.textContent = `.${SECTION_HIDDEN_CLASS} { display: none !important; }`;
        (document.head || document.documentElement).appendChild(style);
    }

    function cardFormatFor(items) {
        if (items.every((i) => i.Type === 'Episode')) return 'Thumb';
        if (items.every((i) => ['MusicAlbum', 'Audio', 'MusicArtist'].includes(i.Type))) return 'Square';
        return 'Poster';
    }

    async function fetchChildren(collectionId) {
        const result = await ApiClient.getItems(ApiClient.getCurrentUserId(), {
            ParentId: collectionId,
            Fields: 'PrimaryImageAspectRatio,MediaSourceCount,ChildCount,ProductionYear,PremiereDate',
            ImageTypeLimit: 1,
            EnableImageTypes: 'Primary,Backdrop,Thumb'
        });
        return new Map((result?.Items || []).map((child) => [child.Id, child]));
    }

    function gridOrder(grid) {
        return Array.from(grid.querySelectorAll(':scope > .card[data-id]')).map((card) => card.getAttribute('data-id'));
    }

    // One section, as seriesEpisodes.js builds the season row: a config and a
    // result whose data is already in hand.
    async function renderRow(collectionId, index, title, items) {
        const config = {
            id: `kefin-collection-${collectionId}-${index}`,
            type: 'collection-section',
            name: title,
            enabled: true,
            order: 0,
            cardFormat: cardFormatFor(items),
            overflowCard: true,
            userConfigurable: false,
            queries: [],
            items
        };
        const result = {
            data: items,
            isStale: false,
            ensureData: () => Promise.resolve(items)
        };
        Object.defineProperty(result, 'dataPromise', {
            configurable: true,
            enumerable: true,
            get() { return Promise.resolve(items); }
        });

        const staging = document.createElement('div');
        await window.cardBuilder.renderProgressiveSections(staging, [Promise.resolve({ config, result })],
            { showStaleDataBeforeRefresh: true });
        const row = staging.querySelector('.emby-scroller-container') || staging.firstElementChild;
        if (!row) return null;

        // What seriesEpisodes.js does to its season row, so the two match.
        row.classList.add('series-episodes-section');
        row.style.cssText = 'overflow: hidden; display: block;';
        row.querySelector('.emby-scroller')?.classList.add('no-padding');
        row.querySelector('.sectionTitleContainer')?.classList.add('no-padding');
        row.setAttribute(ROW_ATTR, '');
        return row;
    }

    let applying = false;

    async function apply(page, item, token) {
        if (applying) return;
        if (!window.cardBuilder?.renderProgressiveSections) {
            WARN('cardBuilder.renderProgressiveSections unavailable');
            return;
        }
        const collectionItems = page.querySelector('.collectionItems');
        if (!collectionItems) return;
        const sections = Array.from(collectionItems.querySelectorAll(':scope > .verticalSection'))
            .filter((section) => section.querySelector('.collectionItemsContainer > .card[data-id]'));
        if (!sections.length) return;

        const pending = sections.filter((section) => {
            const row = section.nextElementSibling;
            const grid = section.querySelector('.collectionItemsContainer');
            return !(row && row.hasAttribute(ROW_ATTR) && row.dataset.kefinOrder === gridOrder(grid).join(','));
        });
        if (!pending.length) return;

        applying = true;
        try {
            const children = await fetchChildren(item.Id);
            if (token !== viewToken || !children.size) return;
            for (const section of pending) {
                if (!section.isConnected) continue;
                const grid = section.querySelector('.collectionItemsContainer');
                const order = gridOrder(grid);
                const items = order.map((id) => children.get(id)).filter(Boolean);
                if (!items.length) continue;
                const title = section.querySelector('.sectionTitle')?.textContent.trim() || '';
                const index = Array.from(collectionItems.children).indexOf(section);
                const row = await renderRow(item.Id, index, title, items);
                if (!row || token !== viewToken || !section.isConnected) continue;
                row.dataset.kefinOrder = order.join(',');

                const old = section.nextElementSibling;
                if (old && old.hasAttribute(ROW_ATTR)) old.remove();
                section.after(row);
                section.classList.add(SECTION_HIDDEN_CLASS);

                if (!observedGrids.has(grid)) {
                    observedGrids.add(grid);
                    let timer = null;
                    const gridObserver = new MutationObserver(() => {
                        clearTimeout(timer);
                        timer = setTimeout(() => apply(page, item, token), 100);
                    });
                    gridObserver.observe(grid, { childList: true });
                    teardown.push(() => { gridObserver.disconnect(); clearTimeout(timer); observedGrids.delete(grid); });
                }
            }
            LOG(`Rendered ${pending.length} row(s) for collection ${item.Id}`);
        } catch (e) {
            WARN('Could not build the rows; leaving the grids', e);
        } finally {
            applying = false;
        }
    }

    // .collectionItems is part of the page template; jellyfin-web fills it once
    // the children arrive and refills it from scratch when the collection
    // changes, which takes the rows with it.
    function watch(page, item, token) {
        const start = Date.now();
        const tick = () => {
            if (token !== viewToken) return;
            const collectionItems = page.querySelector('.collectionItems');
            if (!collectionItems) {
                if (Date.now() - start < WAIT_MS) setTimeout(tick, 200);
                return;
            }
            let timer = null;
            const observer = new MutationObserver((mutations) => {
                // Our own rows are inserted here too; only jellyfin-web's sections count.
                const theirs = mutations.some((m) => Array.from(m.addedNodes).some((n) =>
                    n.nodeType === 1 && !n.hasAttribute(ROW_ATTR)));
                if (!theirs) return;
                clearTimeout(timer);
                timer = setTimeout(() => apply(page, item, token), 50);
            });
            observer.observe(collectionItems, { childList: true });
            teardown.push(() => { observer.disconnect(); clearTimeout(timer); });
            apply(page, item, token);
        };
        tick();
    }

    function initializeHook() {
        if (!window.KefinTweaksUtils || !window.KefinTweaksUtils.onViewPage) {
            setTimeout(initializeHook, 1000);
            return;
        }
        injectStyle();

        window.KefinTweaksUtils.onViewPage(
            async (view, element, hash, itemPromise) => {
                if (ApiClient._loggedIn === false) return;
                let item;
                try { item = await itemPromise; } catch (e) { return; }
                // Judged by the URL, and the page looked up only now: going from
                // one item page to another this is called before jellyfin-web
                // swaps the views (see virtualSpecials.js).
                if (!item || !item.Id || !window.location.hash.includes(item.Id)) return;
                const page = document.querySelector('.itemDetailPage:not(.hide)');
                if (!page) return;

                stopAll();
                if (item.Type !== 'BoxSet') return;
                watch(page, item, viewToken);
            },
            {
                pages: ['details'],
                // true, unlike virtualSpecials.js: this script can register
                // after the first view of a page has been announced (it waits
                // for cardBuilder, which loads late), and with false the call
                // made on registration is dropped as a repeat of that hash, so
                // a page opened directly was never handled. A repeat is
                // harmless here: apply() finds its work already done.
                triggerOnSameHash: true
            }
        );

        LOG('Collection section rows hook initialized');
    }

    function initialize(attempt = 0) {
        if (typeof ApiClient === 'undefined' || !window.KefinTweaksUtils || !window.cardBuilder) {
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
