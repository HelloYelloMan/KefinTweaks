// KefinTweaks Virtual Specials Tweaks
//
// Fixes to the collection (BoxSet) detail page, sharing one fetch of the
// collection's children. Written for the generated per-work specials
// collections, but each is just as right on a hand-curated collection, and none
// of them look at where the collection came from. A third, on a special's own
// episode page, is described in its section.
//
//   1. STUDIOS. jellyfin-web's renderStudio opens with an unconditional early
//      return for BoxSet and Playlist -- "the list of studios can be massive
//      for collections of items" -- so the row is built, left empty, and
//      hidden however few studios the collection has.
//
//   2. THE "Special - " PREFIX. getDisplayName prepends
//      ValueSpecialEpisodeName to every episode with ParentIndexNumber === 0,
//      everywhere, with no option. On a collection built to group a series'
//      specials it is on every card and distinguishes nothing.
//
// It also sets the single-item marker that collectionSingleItem.css reads to
// hide a one-item collection's count and Shuffle button.
//
// There used to be an artwork fallback here, borrowing a backdrop and logo from
// the first child, the matching AniDB series, the Specials season or the series
// for collections that had neither. The pipeline now symlinks artwork into every
// virtual special -- 325 of 325 had both on 2026-10-03 -- and the fallback only
// ever filled a blank, so it could no longer fire and was removed.

(function () {
    'use strict';

    const LOG = (...args) => console.log('[KefinTweaks VirtualSpecials]', ...args);
    const WARN = (...args) => console.warn('[KefinTweaks VirtualSpecials]', ...args);

    const POLL_INTERVAL_MS = 150;
    const POLL_TIMEOUT_MS = 8000;
    const SETTLE_MS = 220;
    const OBSERVE_MS = 15000;

    // ======================================================================
    // Shared data
    // ======================================================================

    // The page and its breadcrumb ask for the same item within a moment of each
    // other, so one answer serves both. It is kept for seconds, not for the
    // session, so a revisit still sees the collection as it is now.
    const SHARED_FETCH_MS = 10000;

    function sharedFetch(slot, id, fetch) {
        if (slot.id !== id || Date.now() - slot.at > SHARED_FETCH_MS) {
            slot.id = id;
            slot.at = Date.now();
            slot.promise = fetch();
        }
        return slot.promise;
    }

    const lastChildren = {};

    function fetchChildren(collectionId) {
        return sharedFetch(lastChildren, collectionId, () =>
            ApiClient.getItems(ApiClient.getCurrentUserId(), { ParentId: collectionId })
                .then(r => r.Items || [])
                .catch(error => { WARN('Could not read collection children:', error); return []; }));
    }

    // ======================================================================
    // The single-item marker
    // ======================================================================

    // THE SINGLE-ITEM MARKER, read by skins/optional/global/collectionSingleItem.css.
    //
    // It lives here rather than in elegantfin-haspatch.js so that the stylesheet
    // depends on a feature the user can actually see and switch in the Feature
    // Configuration list, instead of on a script that is deliberately not listed
    // there. Taken from the child count rather than from `:only-child` in the
    // DOM, which is both authoritative and available before the row renders --
    // so the row never appears and then vanishes.
    const SINGLE_CLASS = 'kefin-collection-single';

    function setSingleItemMarker(isSingle) {
        document.body.classList.toggle(SINGLE_CLASS, !!isSingle);
    }

    // ======================================================================
    // 1. Studios row
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

    // Jellyfin 12 renders the metadata rows with React: .itemDetailsGroup holds
    // one wrapper div per type, always in the order Author, Creator, Director,
    // Writer, Studio, Genre, each `.detailsGroupItem > p.label +
    // .focuscontainer-x > span > a.button-link` or empty when the item has none.
    // Studios render nothing at all for a BoxSet, so there is no row to fill.
    // Our row goes in its own wrapper after the Studio slot; the React roots
    // themselves are left alone.
    const V12_STUDIO_SLOT = 4;

    function injectStudiosV12(group, item) {
        group.querySelectorAll(':scope > [' + STUDIOS_ATTR + ']').forEach(el => el.remove());

        const studios = ((item && item.Studios) || []).filter(studio => studio && studio.Id);
        if (!studios.length) return;

        const serverId = item.ServerId
            || (window.ApiClient && ApiClient.serverId && ApiClient.serverId());
        const template = group.querySelector('.detailsGroupItem .focuscontainer-x a');
        const sampleRow = group.querySelector('.detailsGroupItem');

        let row;
        let label;
        let content;
        if (sampleRow) {
            // A clone keeps the MUI and skin classes the other rows carry.
            row = sampleRow.cloneNode(true);
            label = row.querySelector('.label');
            content = row.querySelector('.focuscontainer-x');
        }
        if (!row || !label || !content) {
            row = document.createElement('div');
            row.className = 'detailsGroupItem';
            label = document.createElement('p');
            label.className = 'label';
            content = document.createElement('div');
            content.className = 'focuscontainer-x';
            row.append(label, content);
        }

        content.innerHTML = '';
        studios.forEach((studio, i) => {
            const span = document.createElement('span');
            if (i > 0) span.appendChild(document.createTextNode(', '));
            span.appendChild(buildStudioLink(template, studio, serverId));
            content.appendChild(span);
        });
        label.textContent = studios.length > 1 ? 'Studios' : 'Studio';

        const wrapper = document.createElement('div');
        wrapper.setAttribute(STUDIOS_ATTR, '1');
        wrapper.appendChild(row);
        const slot = group.children[V12_STUDIO_SLOT];
        group.insertBefore(wrapper, slot ? slot.nextSibling : null);
    }

    function injectStudios(page, item) {
        const groupEl = page.querySelector('.studiosGroup');
        if (!groupEl) {
            const group = page.querySelector('.itemDetailsGroup');
            if (group && !group.querySelector('.content')) injectStudiosV12(group, item);
            return;
        }

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
    // 2. The "Special - " prefix
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
    // 3. Breadcrumbs, and a special's episode page
    // ======================================================================
    //
    // A virtual special sits between a series and its specials, and the
    // breadcrumbs say so: Shows > series > virtual special on the collection's
    // own page, which breadcrumbs.js gives no trail at all, and Shows > series >
    // virtual special > episode on a special, instead of going through the
    // Specials season. A virtual special is recognised by the
    // AnimePipelineSeries id the pipeline gives every one it generates, not by
    // its name.
    //
    // Neither side is assumed to be single. An episode in several virtual
    // specials keeps the season's name on its crumb and opens a list of them;
    // a virtual special whose episodes come from several series opens a list
    // of those. With none, the trail is left as breadcrumbs.js built it.
    //
    // The episode's collections also size the title of jellyfin-web's
    // collections row, which is plural however many cards it holds.

    const lastCollections = {};

    function collectionsOf(itemId) {
        return sharedFetch(lastCollections, itemId, () =>
            ApiClient.getJSON(ApiClient.getUrl(`Items/${itemId}/Collections`, {
                userId: ApiClient.getCurrentUserId(),
                fields: 'ProviderIds'
            }))
                .then(r => (r && r.Items) || [])
                .catch(error => { WARN('Could not read the episode\'s collections:', error); return []; }));
    }

    function detailsUrl(itemId) {
        return `${ApiClient._serverAddress}/web/#/details?id=${itemId}&serverId=${ApiClient.serverId()}`;
    }

    // The Shows crumb opens the library the episode is in, as breadcrumbs.js
    // does for a series.
    async function showsCrumb(episode) {
        let library = null;
        try {
            const ancestors = await ApiClient.getJSON(ApiClient.getUrl(`Items/${episode.Id}/Ancestors`, {
                userId: ApiClient.getCurrentUserId()
            }));
            library = (ancestors || []).find(a => a.Type === 'CollectionFolder') || null;
        } catch (e) { /* the library is optional */ }
        const query = library
            ? `?topParentId=${library.Id}&serverId=${ApiClient.serverId()}`
            : `?serverId=${ApiClient.serverId()}`;
        return { text: 'Shows', url: `#/tv${query}&tab=0`, clickable: true };
    }

    async function virtualSpecialBreadcrumbs(item) {
        if (!item || item.Type !== 'BoxSet' || !isVirtualSpecial(item)) return null;
        const episodes = (await fetchChildren(item.Id)).filter(c => c.SeriesId);
        if (!episodes.length) return null;

        const series = new Map();
        episodes.forEach(e => {
            if (!series.has(e.SeriesId)) series.set(e.SeriesId, { Id: e.SeriesId, Name: e.SeriesName });
        });
        // Named from the series items themselves, as breadcrumbs.js names the
        // series on its own trails. An episode's SeriesName is a copy that is
        // not always refreshed: Aria: The Animation's specials still carry
        // "Aria", so this crumb read "Aria" while the series page's said
        // "Aria: The Animation".
        try {
            const result = await ApiClient.getItems(ApiClient.getCurrentUserId(), {
                Ids: [...series.keys()].join(','),
                EnableImageTypes: 'None',
                EnableUserData: false
            });
            (result?.Items || []).forEach(s => {
                if (series.has(s.Id) && s.Name) series.get(s.Id).Name = s.Name;
            });
        } catch (e) {
            WARN('Could not read the series names; using the episodes\' copies:', e);
        }
        const list = [...series.values()];
        const seriesCrumb = list.length === 1
            ? { text: list[0].Name, url: detailsUrl(list[0].Id), clickable: true }
            : { text: 'Series', url: null, clickable: true, popover: true, popoverItems: list };

        return [
            await showsCrumb(episodes[0]),
            seriesCrumb,
            { text: item.Name, url: null, clickable: false }
        ];
    }

    function isSpecialEpisode(item) {
        return !!item && item.Type === 'Episode' && item.ParentIndexNumber === 0;
    }

    function isVirtualSpecial(collection) {
        return collection.Type === 'BoxSet'
            && !!(collection.ProviderIds && collection.ProviderIds.AnimePipelineSeries);
    }

    async function specialsBreadcrumbs(item, elements) {
        if (!isSpecialEpisode(item)) return null;
        const specials = (await collectionsOf(item.Id)).filter(isVirtualSpecial);
        if (!specials.length) return null;

        // The season crumb is the episode trail's only popover.
        const at = elements.findIndex(e => e.popover);
        if (at < 0) return null;

        const crumb = specials.length === 1
            ? { text: specials[0].Name, url: detailsUrl(specials[0].Id), clickable: true }
            : { text: elements[at].text, url: null, clickable: true, popover: true, popoverItems: specials };
        return elements.map((e, i) => (i === at ? crumb : e));
    }

    (window.KefinTweaksBreadcrumbOverrides = window.KefinTweaksBreadcrumbOverrides || [])
        .push(virtualSpecialBreadcrumbs, specialsBreadcrumbs);

    const TITLE_ATTR = 'data-kefin-original-title';

    // null puts back what jellyfin-web wrote, for a page element being reused.
    function setCollectionsTitle(page, text) {
        const title = page.querySelector('#collectionsCollapsible .sectionTitle');
        if (!title) return;
        if (text == null) {
            if (title.hasAttribute(TITLE_ATTR)) {
                title.textContent = title.getAttribute(TITLE_ATTR);
                title.removeAttribute(TITLE_ATTR);
            }
            return;
        }
        if (!title.hasAttribute(TITLE_ATTR)) title.setAttribute(TITLE_ATTR, title.textContent);
        title.textContent = text;
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
        setSingleItemMarker(false);
        teardown.forEach(fn => { try { fn(); } catch (e) { /* already stopped */ } });
        teardown = [];
    }

    // Scoped to the page: jellyfin-web keeps up to three views cached, and an
    // older collection page can come first in the document.
    function waitFor(root, selector, startedAt) {
        return new Promise(resolve => {
            const tick = () => {
                const el = root.querySelector(selector);
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

                let item;
                try { item = await itemPromise; } catch (e) { return; }
                // A slow item fetch can resolve after the next page's handler has
                // started; stopAll() here would cancel that page's work. Judged by
                // the URL, which names the item this call is for.
                if (!item || !item.Id || !window.location.hash.includes(item.Id)) return;

                // The page is looked up only now, not before the await. Going from
                // one item page to another, this handler is called from the
                // History API as the URL changes -- before jellyfin-web has
                // swapped the views -- so the visible page at that moment is the
                // OUTGOING one, hidden by the time the item arrives. Checking that
                // page made the handler give up, and the second notification, from
                // the view show, is suppressed (triggerOnSameHash: false) because
                // the hash has not changed since. Seen in the app opening a
                // collection from a series page's Collections row: no marker, so
                // the count and Shuffle of a one-item collection stayed visible.
                const page = document.querySelector('.itemDetailPage:not(.hide)')
                    || document.querySelector('.libraryPage:not(.hide)');
                if (!page) return;

                stopAll();
                setCollectionsTitle(page, null);

                if (isSpecialEpisode(item)) {
                    const token = viewToken;
                    collectionsOf(item.Id).then(collections => {
                        if (token !== viewToken || page.classList.contains('hide')) return;
                        if (collections.length === 1) setCollectionsTitle(page, 'Collection');
                    });
                    return;
                }

                if (!item || item.Type !== 'BoxSet' || !item.Id) return;

                // The single-item marker, from the count the item already carries.
                // It used to wait for the children fetch below, and stopAll() above
                // clears it on every details view event -- jellyfin-web can fire
                // more than one for a single navigation -- so the count and the
                // Shuffle button showed until that request came back, or for good
                // when a later event cleared it. Set here, in the same task as the
                // clear, there is no gap. The children fetch still confirms it.
                if (typeof item.ChildCount === 'number') setSingleItemMarker(item.ChildCount === 1);

                const token = viewToken;
                // stopAll() only runs when another details page opens, so leaving
                // for Home or a library must also count.
                const alive = () => token === viewToken
                    && page.isConnected && !page.classList.contains('hide');

                // One fetch, two consumers.
                const children = await fetchChildren(item.Id);
                if (!alive()) return;

                if (children.length) setSingleItemMarker(children.length === 1);

                // --- studios -------------------------------------------------
                waitFor(page, '.itemDetailsGroup', Date.now()).then(group => {
                    if (!group || !alive()) return;
                    teardown.push(makeBoundedObserver(
                        group, () => injectStudios(page, item), POLL_TIMEOUT_MS));
                });

                // --- names ---------------------------------------------------
                const names = specialNamesFrom(children);
                if (names.size) {
                    // The stable parent, not the first .collectionItemsContainer:
                    // there is one per item type, and a refresh rebuilds them.
                    waitFor(page, '.collectionItems', Date.now()).then(container => {
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
