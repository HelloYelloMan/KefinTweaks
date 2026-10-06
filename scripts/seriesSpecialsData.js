// KefinTweaks Series & Specials - shared data
//
// What the Series & Specials tweaks need to know about a special episode's
// virtual special collection, asked for once. Virtual Specials (its breadcrumb
// and the Collections row title), Episode Title and Episode Logo all want it on
// the same page within moments of each other; without this each would make its
// own request.
//
// The source is stock Jellyfin 12: GET /Items/{id}/Collections. One call gives
// each collection's name, id, Logo image tag and provider ids. A collection is a
// VIRTUAL SPECIAL when the anime metadata pipeline made it, which it marks with
// the AnimePipelineSeries provider id. (A plugin endpoint was considered and
// decided against on 2026-10-05; nothing here needs more than this call.)
//
// No UI and no switch of its own: the loader brings it in as a dependency of the
// tweaks that use it, and only while the Series & Specials group is on.

(function () {
    'use strict';

    const WARN = (...args) => console.warn('[KefinTweaks SeriesSpecialsData]', ...args);

    // The breadcrumb, the page title and the logo ask for the same item within a
    // moment of each other, so one answer serves them all. Kept for seconds, not
    // for the session, so a revisit still sees the collections as they are now.
    const SHARED_FETCH_MS = 10000;

    function sharedFetch(slot, id, fetch) {
        if (slot.id !== id || Date.now() - slot.at > SHARED_FETCH_MS) {
            slot.id = id;
            slot.at = Date.now();
            slot.promise = fetch();
        }
        return slot.promise;
    }

    const lastCollections = { id: null, at: 0, promise: null };
    const lastChildren    = { id: null, at: 0, promise: null };

    function collectionsOf(itemId) {
        return sharedFetch(lastCollections, itemId, () =>
            ApiClient.getJSON(ApiClient.getUrl(`Items/${itemId}/Collections`, {
                userId: ApiClient.getCurrentUserId(),
                fields: 'ProviderIds'
            }))
                .then(r => (r && r.Items) || [])
                .catch(error => { WARN('Could not read the item\'s collections:', error); return []; }));
    }

    // A collection's own items. Virtual Specials reads them for the Studios row,
    // the special names, the single-item marker and its breadcrumb; Episode Logo
    // for the series a virtual special belongs to.
    function childrenOf(collectionId) {
        return sharedFetch(lastChildren, collectionId, () =>
            ApiClient.getItems(ApiClient.getCurrentUserId(), { ParentId: collectionId })
                .then(r => (r && r.Items) || [])
                .catch(error => { WARN('Could not read the collection\'s items:', error); return []; }));
    }

    function isSpecialEpisode(item) {
        return !!item && item.Type === 'Episode' && item.ParentIndexNumber === 0;
    }

    function isVirtualSpecial(collection) {
        return !!collection && collection.Type === 'BoxSet'
            && !!(collection.ProviderIds && collection.ProviderIds.AnimePipelineSeries);
    }

    // The one virtual special a special episode belongs to, or null - for an
    // episode that is not a special, or one in none or in several (there is no
    // single answer to show or link to then).
    async function virtualSpecialOf(item) {
        if (!isSpecialEpisode(item)) return null;
        const specials = (await collectionsOf(item.Id)).filter(isVirtualSpecial);
        return specials.length === 1 ? specials[0] : null;
    }

    // The series a virtual special belongs to: the one series all its episodes
    // come from, or null when they come from several (the breadcrumb lists them
    // then; there is no single place to send the logo) or there are none.
    async function seriesOfVirtualSpecial(collection) {
        if (!isVirtualSpecial(collection)) return null;
        const ids = new Set((await childrenOf(collection.Id)).map(c => c.SeriesId).filter(Boolean));
        return ids.size === 1 ? [...ids][0] : null;
    }

    window.KefinTweaksSeriesSpecialsData = {
        collectionsOf,
        childrenOf,
        seriesOfVirtualSpecial,
        isSpecialEpisode,
        isVirtualSpecial,
        virtualSpecialOf
    };
})();
