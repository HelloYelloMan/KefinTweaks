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
    const lastCollections = { id: null, at: 0, promise: null };

    function collectionsOf(itemId) {
        const slot = lastCollections;
        if (slot.id !== itemId || Date.now() - slot.at > SHARED_FETCH_MS) {
            slot.id = itemId;
            slot.at = Date.now();
            slot.promise = ApiClient.getJSON(ApiClient.getUrl(`Items/${itemId}/Collections`, {
                userId: ApiClient.getCurrentUserId(),
                fields: 'ProviderIds'
            }))
                .then(r => (r && r.Items) || [])
                .catch(error => { WARN('Could not read the item\'s collections:', error); return []; });
        }
        return slot.promise;
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

    window.KefinTweaksSeriesSpecialsData = {
        collectionsOf,
        isSpecialEpisode,
        isVirtualSpecial,
        virtualSpecialOf
    };
})();
