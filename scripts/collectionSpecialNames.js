// KefinTweaks Collection Special Names
// Removes the "Special - " prefix from item titles on a collection detail page.
//
// Where the prefix comes from. getDisplayName in src/components/itemHelper.js:
//
//     if (item.Type === 'Episode' && item.ParentIndexNumber === 0) {
//         name = globalize.translate('ValueSpecialEpisodeName', name);
//     }
//
// ValueSpecialEpisodeName is "Special - {0}" in en-us. Every episode in season
// 0 gets it, everywhere jellyfin-web draws a name, with no option to turn it
// off. On a collection built specifically to group a series' specials, the word
// is on every single card and distinguishes nothing -- and it eats the width the
// actual title needs, which is why titles were being ellipsised.
//
// Scope is deliberately narrow: only cards inside .collectionItemsContainer, so
// Continue Watching, Next Up, season pages and search results keep the prefix
// they have today. Nothing here reaches outside a collection detail page.
//
// How the real title is recovered. Not by stripping a string: the prefix is
// localized ("Extra – {0}" in de, "Especial - {0}" in es), so matching on
// "Special - " would work on exactly one server language. Instead the item's own
// Name is read from the API and written into the card. That is what jellyfin-web
// started from, so it is exact by construction and idempotent -- running twice
// changes nothing the second time.
//
// The same fetch supplies the condition. Only items where jellyfin-web WOULD
// have added the prefix are touched, which is Type === 'Episode' and
// ParentIndexNumber === 0 -- its test, not an approximation of it. A collection
// of ordinary episodes keeps its "S1:E5 - " numbering, which getDisplayName
// produces from a different branch and which is genuinely informative.

(function () {
    'use strict';

    const LOG = (...args) => console.log('[KefinTweaks CollectionSpecialNames]', ...args);
    const WARN = (...args) => console.warn('[KefinTweaks CollectionSpecialNames]', ...args);

    const POLL_INTERVAL_MS = 150;
    const POLL_TIMEOUT_MS = 8000;
    const SETTLE_MS = 200;
    // The row can re-render (lazy loading, a sort applied by collections.js), so
    // the observer outlives the first pass -- but not the page.
    const OBSERVE_MS = 15000;

    async function fetchSpecialNames(collectionId) {
        const names = new Map();
        try {
            const userId = ApiClient.getCurrentUserId();
            const response = await ApiClient.getItems(userId, { ParentId: collectionId });
            (response.Items || []).forEach(child => {
                // jellyfin-web's own condition for adding the prefix.
                if (child.Type === 'Episode' && child.ParentIndexNumber === 0 && child.Name) {
                    names.set(child.Id, child.Name);
                }
            });
        } catch (error) {
            WARN('Could not read collection children:', error);
        }
        return names;
    }

    // The title is a text anchor in the card footer area. A card can hold more
    // than one such anchor (a series link, for instance), so pick the one whose
    // text ENDS WITH the real name: that is the one carrying "<prefix>Name", and
    // it excludes anchors that are about something else entirely.
    function retitleCard(card, name) {
        const anchors = card.querySelectorAll('a.textActionButton');
        for (let i = 0; i < anchors.length; i++) {
            const a = anchors[i];
            const text = (a.textContent || '').trim();
            if (text === name) return false;              // already correct
            if (text.endsWith(name)) {
                a.textContent = name;
                return true;
            }
        }
        return false;
    }

    function applyNames(container, names) {
        if (!names.size) return 0;
        let changed = 0;
        container.querySelectorAll('.card[data-id]').forEach(card => {
            const name = names.get(card.getAttribute('data-id'));
            if (name && retitleCard(card, name)) changed++;
        });
        return changed;
    }

    let activeObserver = null;
    let settleTimer = null;
    let hardStopTimer = null;

    function stopObserving() {
        if (activeObserver) { activeObserver.disconnect(); activeObserver = null; }
        if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
        if (hardStopTimer) { clearTimeout(hardStopTimer); hardStopTimer = null; }
    }

    // Re-apply with the observer paused: setting textContent is a mutation the
    // observer would otherwise see, and it would schedule itself forever.
    function reapply(container, names) {
        if (activeObserver) activeObserver.disconnect();
        applyNames(container, names);
        if (activeObserver && container.isConnected) {
            activeObserver.observe(container, { childList: true, subtree: true });
        }
    }

    function observeContainer(container, names) {
        stopObserving();
        activeObserver = new MutationObserver(() => {
            if (settleTimer) clearTimeout(settleTimer);
            settleTimer = setTimeout(() => reapply(container, names), SETTLE_MS);
        });
        activeObserver.observe(container, { childList: true, subtree: true });
        reapply(container, names);
        hardStopTimer = setTimeout(stopObserving, OBSERVE_MS);
    }

    function waitForCards(startedAt) {
        return new Promise(resolve => {
            const tick = () => {
                const container = document.querySelector('.collectionItemsContainer');
                if (container && container.querySelector('.card')) { resolve(container); return; }
                if (Date.now() - startedAt >= POLL_TIMEOUT_MS) { resolve(null); return; }
                setTimeout(tick, POLL_INTERVAL_MS);
            };
            tick();
        });
    }

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
                try {
                    item = await itemPromise;
                } catch (e) {
                    return;
                }

                stopObserving();

                if (!item || item.Type !== 'BoxSet' || !item.Id) return;

                // Fetch and render race each other, so start both and wait for
                // the slower one rather than ordering them.
                const [names, container] = await Promise.all([
                    fetchSpecialNames(item.Id),
                    waitForCards(Date.now())
                ]);
                if (!container || !names.size) return;

                observeContainer(container, names);
                LOG('Trimmed the special prefix from', names.size, 'title(s)');
            },
            {
                pages: ['details'],
                triggerOnSameHash: false
            }
        );

        LOG('Collection special names hook initialized');
    }

    function initialize(attempt = 0) {
        if (typeof ApiClient === 'undefined' || !window.KefinTweaksUtils) {
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

    LOG('Script loaded');
})();
