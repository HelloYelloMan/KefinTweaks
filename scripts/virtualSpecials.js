// KefinTweaks Virtual Special Breadcrumbs
//
// The breadcrumbs of a virtual special and of the specials in one, added to
// breadcrumbs.js's trails through its override hook
// (window.KefinTweaksBreadcrumbOverrides). Each is its own switch in Item Page
// Tweaks (tweakOn below).
//
// The rest of what this script did on collection and special-episode pages
// (the Studios row, the one-item collection marker, the Collections row
// title) moved to Vault Tweaks with the other Item Page Tweaks on
// 2026-10-15. These two stay here because they change KefinTweaks' own
// breadcrumbs.

(function () {
    'use strict';

    const WARN = (...args) => console.warn('[KefinTweaks VirtualSpecials]', ...args);

    // Each breadcrumb is its own switch in the Item Page Tweaks settings
    // window (config.itemPageTweaks). Unset means on: that is what every
    // install ran before the switches existed. With both off the window turns
    // this script's own flag off, and the loader does not load it at all.
    function tweakOn(key) {
        const tweaks = window.KefinTweaksConfig && window.KefinTweaksConfig.itemPageTweaks;
        return !tweaks || tweaks[key] !== false;
    }

    // ======================================================================
    // Shared data
    // ======================================================================

    // Asks for the same item within a few seconds share one answer. It is
    // kept for seconds, not for the session, so a revisit still sees the
    // collection as it is now.
    const SHARED_FETCH_MS = 10000;

    function sharedFetch(slot, id, fetch) {
        if (slot.id !== id || Date.now() - slot.at > SHARED_FETCH_MS) {
            slot.id = id;
            slot.at = Date.now();
            slot.promise = fetch();
        }
        return slot.promise;
    }

    // Vault Tweaks' Item Page Tweaks ask for the same collections and
    // children on the same pages and share their answers as
    // window.VaultTweaksSeriesSpecialsData. When it is loaded its answers are
    // used, so a page makes each request once; without it this asks itself.
    function vaultTweaksData() {
        return window.VaultTweaksSeriesSpecialsData || null;
    }

    const lastChildren = {};

    function fetchChildren(collectionId) {
        const shared = vaultTweaksData();
        if (shared && typeof shared.childrenOf === 'function') return shared.childrenOf(collectionId);
        return sharedFetch(lastChildren, collectionId, () =>
            ApiClient.getItems(ApiClient.getCurrentUserId(), { ParentId: collectionId })
                .then(r => r.Items || [])
                .catch(error => { WARN('Could not read collection children:', error); return []; }));
    }

    // ======================================================================
    // Breadcrumbs
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

    const lastCollections = {};

    function collectionsOf(itemId) {
        const shared = vaultTweaksData();
        if (shared && typeof shared.collectionsOf === 'function') return shared.collectionsOf(itemId);
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
        if (!tweakOn('collectionBreadcrumb')) return null;
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
        if (!tweakOn('specialBreadcrumb') || !isSpecialEpisode(item)) return null;
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
})();
