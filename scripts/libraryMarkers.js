// KefinTweaks Library Markers
// Publishes the library an item belongs to as a class on <body>, so stylesheets
// can be scoped to one library.
//
// WHY THIS EXISTS. Nothing on a detail page says which library you are in. The
// page element carries `page libraryPage itemDetailPage ...` and a handful of
// dataset flags, none of which mention the parent; the item's own id and type are
// in the URL, but the library is not. So a rule like "only on the Anime library"
// cannot be written in CSS alone, however the selector is arranged.
//
// The answer is one request. /Items/{id}/Ancestors returns the chain up to the
// user root, and the entry of type CollectionFolder IS the library:
//
//     Anime (CollectionFolder) -> Media Folders (UserRootFolder)
//
// Two classes are published for each, because they fail differently:
//
//     kefin-library-anime                     from the name, readable, but it
//                                             changes if the library is renamed
//     kefin-library-id-0c41907140d802bb...    from the id, stable but opaque
//
// Prefer the name in hand-written CSS and the id when something must not break
// on a rename.
//
// Cost is one request per distinct item viewed, cached for the session, and the
// answer never changes for an item that is not moved between libraries. Nothing
// blocks on it: the class arrives after the page renders, so a rule using it must
// be one that can apply late without a visible jump. Hiding something qualifies;
// changing a layout height would not.

(function () {
    'use strict';

    const LOG = (...args) => console.log('[KefinTweaks LibraryMarkers]', ...args);
    const WARN = (...args) => console.warn('[KefinTweaks LibraryMarkers]', ...args);

    const PREFIX = 'kefin-library-';
    const cache = new Map();          // itemId -> { slug, id } | null

    function slugify(name) {
        return String(name || '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
    }

    function clearMarkers() {
        const body = document.body;
        if (!body) return;
        Array.from(body.classList)
            .filter(c => c.startsWith(PREFIX))
            .forEach(c => body.classList.remove(c));
    }

    async function resolveLibrary(itemId) {
        if (cache.has(itemId)) return cache.get(itemId);
        let found = null;
        try {
            const userId = ApiClient.getCurrentUserId();
            const ancestors = await ApiClient.getJSON(
                ApiClient.getUrl('Items/' + itemId + '/Ancestors', { userId })
            );
            const library = (ancestors || []).find(a => a.Type === 'CollectionFolder');
            if (library) found = { slug: slugify(library.Name), id: library.Id };
        } catch (error) {
            WARN('Could not resolve the library for', itemId, error);
        }
        cache.set(itemId, found);
        return found;
    }

    function initializeHook() {
        if (!window.KefinTweaksUtils || !window.KefinTweaksUtils.onViewPage) {
            WARN('KefinTweaksUtils.onViewPage not available, retrying in 1 second');
            setTimeout(initializeHook, 1000);
            return;
        }

        let viewToken = 0;

        window.KefinTweaksUtils.onViewPage(
            async (view, element, hash, itemPromise) => {
                if (ApiClient._loggedIn === false) return;

                const token = ++viewToken;
                clearMarkers();

                let item;
                try { item = await itemPromise; } catch (e) { return; }
                if (!item || !item.Id) return;

                const library = await resolveLibrary(item.Id);
                // The view may have changed while that was in flight; marking then
                // would label one page with another's library.
                if (token !== viewToken || !library) return;

                const body = document.body;
                if (!body) return;
                if (library.slug) body.classList.add(PREFIX + library.slug);
                body.classList.add(PREFIX + 'id-' + library.id);
            },
            {
                pages: ['details'],
                triggerOnSameHash: false
            }
        );

        LOG('Library markers hook initialized');
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
