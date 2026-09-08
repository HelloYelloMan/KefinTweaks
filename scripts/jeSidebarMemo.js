// Jellyfin Enhanced getSidebarContainer memoiser (KefinTweaks performance patch)
//
// WHY THIS EXISTS
// ---------------
// Jellyfin Enhanced's settings-panel entry point registers a body-mutation
// subscriber (js/enhanced/settingspanel/ui-entry-points.js:64) that runs on EVERY
// structural DOM change in the app:
//
//     JE.helpers.onBodyMutation('ui-menu-button', () => {
//         const sidebar = JE.helpers.getSidebarContainer();
//         if (sidebar && !sidebar.querySelector('#jellyfinEnhancedSettingsLink')) ...
//     });
//
// getSidebarContainer() (js/enhanced/helpers.js:568) begins:
//
//     const legacy = document.querySelector('.mainDrawer-scrollContainer');
//     if (legacy && legacy.offsetParent !== null) return legacy;
//
// `offsetParent` is a forced synchronous style/layout flush. On a page this size
// that means recalculating style for the whole document. Chrome tracing of a
// single navigation into a series page and back measured:
//
//     getSidebarContainer  ->  3,202 ms across 104 calls, 669,787 elements
//                              restyled — 55% of ALL style-recalc time in the
//                              trace, and the single largest cost of navigating.
//
// The check is re-run on every mutation even long after the settings link has
// been injected and nothing can have changed. Memoising the lookup collapses
// those 104 flushes to a handful.
//
// SAFETY
// ------
// * Only POSITIVE results are cached, and only while the element is still
//   connected. A null result is never cached, so nothing is delayed during the
//   window before the drawer exists — JE's own "wait and retry" behaviour is
//   untouched.
// * The cache is dropped on every `viewshow`, so a navigation always revalidates.
// * Everything is feature-detected and wrapped in try/catch: if Jellyfin Enhanced
//   is absent, renamed, or restructured by an update, this silently does nothing.
// * Idempotent — it will not double-wrap.
//
// If the Jellyfin Enhanced settings link ever stops appearing in the sidebar,
// disable this script (`jeSidebarMemo: false`) to rule it out.
(function () {
    'use strict';

    // Long enough to collapse a navigation burst, short enough that a sidebar
    // which genuinely disappears is noticed promptly.
    const TTL_MS = 2000;

    let cached = null;
    let cachedAt = 0;

    function patch() {
        const helpers = window.JellyfinEnhanced && window.JellyfinEnhanced.helpers;
        if (!helpers || typeof helpers.getSidebarContainer !== 'function') return false;
        if (helpers.getSidebarContainer.__kefinMemoised) return true;

        const original = helpers.getSidebarContainer;

        function memoisedGetSidebarContainer() {
            const now = Date.now();
            // isConnected is a plain DOM flag — it does not force layout.
            if (cached && cached.isConnected && (now - cachedAt) < TTL_MS) {
                return cached;
            }
            const result = original.apply(this, arguments);
            if (result && result.isConnected) {
                cached = result;
                cachedAt = now;
            } else {
                cached = null;
            }
            return result;
        }
        memoisedGetSidebarContainer.__kefinMemoised = true;

        try {
            helpers.getSidebarContainer = memoisedGetSidebarContainer;
        } catch (e) {
            return false; // non-writable property; leave JE alone
        }
        return true;
    }

    // Any navigation may swap the drawer out entirely.
    document.addEventListener('viewshow', () => {
        cached = null;
        cachedAt = 0;
    }, true);

    if (!patch()) {
        // JE loads ~149 component scripts asynchronously, so helpers may not exist
        // yet. Poll briefly, then give up rather than spin for the session.
        let attempts = 0;
        const timer = setInterval(() => {
            attempts++;
            if (patch() || attempts >= 120) clearInterval(timer); // ~30s ceiling
        }, 250);
    }
})();
