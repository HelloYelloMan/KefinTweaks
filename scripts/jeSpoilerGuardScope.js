// Jellyfin Enhanced Spoiler Guard scope fix (KefinTweaks patch)
//
// WHAT IT FIXES
// -------------
// With Spoiler Guard enabled, marking anything watched made every image on the
// page blank and reload — cards, My Media tiles, and the detail-page backdrop —
// on the home screen, library pages and detail pages alike.
//
// Jellyfin Enhanced blurs artwork for unwatched items on the SERVER, so the bytes
// behind an image URL change when its watched state does, and the browser's copy
// goes stale. To force a re-fetch, the plugin hooks fetch and XMLHttpRequest, and
// 200ms after any successful POST or DELETE to the mark-played route it runs
// (js/enhanced/spoilerguard/image-refresh.js):
//
//     internal.refreshSpoilerableImages = function() {
//         const cacheBuster = `_sbcb=${Date.now()}`;
//         document.querySelectorAll('img[src*="/Items/"]')...
//         document.querySelectorAll('source[srcset*="/Items/"]')...
//         document.querySelectorAll('[style*="/Items/"]')...
//     };
//
// That rewrites the URL of EVERY Jellyfin image in the document, not just the one
// whose watched state changed. A changed URL is a different resource, so the
// browser drops what it has and fetches again — hence the page-wide flicker. The
// third selector is why it reaches everything KefinTweaks draws: cards carry their
// artwork as an inline background-image, and so does the backdrop.
//
// It is also global rather than limited to guarded series: the only gate is
// "Spoiler Guard is on and has at least one entry".
//
// WHAT THIS DOES
// --------------
// Narrows the refresh to the items that actually changed, and leaves everything
// else alone. Two ids sources are merged, because either alone is incomplete:
//
//   * The mark-played request URL (/Users/<user>/PlayedItems/<item>) names the
//     item the user clicked. Available immediately.
//   * The following UserDataChanged websocket message names every item the server
//     considers affected — the episode plus its season and series, or every child
//     when a series is marked watched. Jellyfin batches those notifications on a
//     500ms timer, so this arrives AFTER the plugin would have refreshed, which is
//     why the bust is deferred rather than run at once.
//
// The plugin's own refreshSpoilerableImages is left intact for the OTHER caller,
// the Spoiler Guard toggle button, where refreshing broadly is the intent (and is
// followed by a full page reload when strict refresh mode is on).
//
// SAFETY
// ------
// * Everything is feature-detected and wrapped in try/catch. If Jellyfin Enhanced
//   is absent, Spoiler Guard is off, or a plugin update renames any of this, the
//   script silently does nothing and the plugin behaves exactly as shipped.
// * Idempotent, and it will not double-hook.
// * Claiming the plugin's own hook flag is preferred, which also avoids a second
//   wrapper around fetch and XHR. If the plugin got there first, the wrapper
//   around refreshSpoilerableImages narrows the watched path anyway.
//
// If spoiler-blurred artwork ever stops clearing after you mark something watched,
// disable this script (`jeSpoilerGuardScope: false`) to rule it out.
(function () {
    'use strict';

    const LOG = (...args) => console.log('[KefinTweaks JESpoilerScope]', ...args);
    const WARN = (...args) => console.warn('[KefinTweaks JESpoilerScope]', ...args);

    // Matches the plugin's own route test, so we trigger on exactly what it does.
    const PLAYED_ROUTE = /\/(?:Users\/[a-f0-9-]+\/PlayedItems|UserPlayedItems)\/([a-f0-9-]+)/i;
    const IMAGE_PATH = /\/Items\/([a-f0-9-]+)\/Images\//i;

    // How long after a mark-played request a refresh still counts as "caused by
    // that click", and how long to let the batched websocket message arrive.
    const PENDING_MS = 5000;
    const SETTLE_MS = 700;

    let pending = null;   // { ids: Set<string>, at: number, timer: number|null }

    function jeSpoilerGuard() {
        const je = window.JellyfinEnhanced;
        const internal = je && je.internals && je.internals.spoilerGuard;
        return internal || null;
    }

    // Deliberately does NOT require the plugin's internals to be reachable. Once
    // the hook below is claimed, this function alone decides whether a refresh
    // happens at all, so it must not go quiet because an internal surface was
    // renamed. The internals are used opportunistically, for the plugin's own
    // "nothing is guarded, nothing to do" early-out.
    function spoilerGuardActive() {
        const je = window.JellyfinEnhanced;
        if (!je || je.pluginConfig?.SpoilerBlurEnabled !== true) return false;
        try {
            const internal = jeSpoilerGuard();
            if (internal?.isStateLoaded?.() && !internal.hasAnyState?.()) return false;
        } catch (e) { /* fall through and refresh */ }
        return true;
    }

    // ---- Scoped cache bust --------------------------------------------------

    function idVariants(id) {
        const bare = String(id).replace(/-/g, '').toLowerCase();
        const out = new Set([String(id), bare]);
        if (bare.length === 32) {
            out.add(bare.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'));
        }
        return [...out];
    }

    function bustUrl(url, cacheBuster) {
        const internal = jeSpoilerGuard();
        if (internal && typeof internal.bustSpoilerImageUrl === 'function') {
            return internal.bustSpoilerImageUrl(url, cacheBuster);
        }
        if (typeof url !== 'string' || !IMAGE_PATH.test(url)) return url;
        const cleaned = url.replace(/([?&])_sbcb=\d+&?/g, '$1').replace(/[?&]$/, '');
        return `${cleaned}${cleaned.includes('?') ? '&' : '?'}${cacheBuster}`;
    }

    function urlIsForIds(url, idSet) {
        const match = IMAGE_PATH.exec(url || '');
        if (!match) return false;
        return idSet.has(match[1].replace(/-/g, '').toLowerCase());
    }

    /**
     * Re-request only the artwork belonging to the given item ids. Queries are
     * keyed on the id itself rather than on "/Items/", so this touches a handful
     * of elements instead of every image in the document.
     */
    function bustImagesFor(ids) {
        if (!ids || !ids.size) return 0;

        const cacheBuster = `_sbcb=${Date.now()}`;
        const idSet = new Set([...ids].map(id => String(id).replace(/-/g, '').toLowerCase()));
        const selector = [...ids]
            .flatMap(idVariants)
            .flatMap(id => [`img[src*="${id}"]`, `source[srcset*="${id}"]`, `[style*="${id}"]`])
            .join(',');

        let changed = 0;
        let elements;
        try {
            elements = document.querySelectorAll(selector);
        } catch (e) {
            WARN('bad selector, skipping refresh:', e);
            return 0;
        }

        elements.forEach(el => {
            const src = el.getAttribute('src');
            if (src && urlIsForIds(src, idSet)) {
                el.setAttribute('src', bustUrl(src, cacheBuster));
                changed++;
            }

            const srcset = el.getAttribute('srcset');
            if (srcset && IMAGE_PATH.test(srcset)) {
                const next = srcset.replace(/([^\s,]+)(?=\s*[\d.]+x|\s*,|\s*$)/g,
                    url => (urlIsForIds(url, idSet) ? bustUrl(url, cacheBuster) : url));
                if (next !== srcset) { el.setAttribute('srcset', next); changed++; }
            }

            const style = el.getAttribute('style');
            if (style && IMAGE_PATH.test(style)) {
                const next = style.replace(/url\((["']?)([^"')]+)\1\)/gi,
                    (match, quote, url) => (urlIsForIds(url, idSet)
                        ? `url(${quote}${bustUrl(url, cacheBuster)}${quote})`
                        : match));
                if (next !== style) { el.setAttribute('style', next); changed++; }
            }
        });

        return changed;
    }

    // ---- Pending-refresh bookkeeping ---------------------------------------

    function pendingIsFresh() {
        return !!pending && (Date.now() - pending.at) < PENDING_MS;
    }

    function runPendingBust() {
        if (!pending) return;
        const ids = pending.ids;
        pending.timer = null;
        const changed = bustImagesFor(ids);
        LOG(`refreshed ${changed} image reference(s) for ${ids.size} item(s)`);
    }

    function scheduleBust() {
        if (!pending) return;
        if (pending.timer) clearTimeout(pending.timer);
        pending.timer = setTimeout(runPendingBust, SETTLE_MS);
    }

    function notePlayedItem(itemId) {
        if (!spoilerGuardActive()) return;
        if (!pendingIsFresh()) pending = { ids: new Set(), at: Date.now(), timer: null };
        pending.at = Date.now();
        if (itemId) pending.ids.add(itemId);
        scheduleBust();
    }

    // The server's own view of what changed. Adds the season and series alongside
    // an episode, and every child when a whole series is marked watched.
    function noteUserDataMessage(msg) {
        if (!pendingIsFresh()) return;                    // not our click; ignore
        const list = msg?.Data?.UserDataList;
        if (!Array.isArray(list)) return;
        let added = 0;
        for (const userData of list) {
            if (userData?.ItemId && !pending.ids.has(userData.ItemId)) {
                pending.ids.add(userData.ItemId);
                added++;
            }
        }
        if (added) scheduleBust();
    }

    // ---- Hooks --------------------------------------------------------------

    function installRequestHooks() {
        if (window.__kefinJeSpoilerScopeHooked) return;
        window.__kefinJeSpoilerScopeHooked = true;

        try {
            const originalFetch = window.fetch;
            if (typeof originalFetch === 'function') {
                window.fetch = function (input, init) {
                    const url = typeof input === 'string' ? input
                        : input instanceof URL ? input.href
                            : input?.url;
                    const method = String(
                        init?.method || (input instanceof Request ? input.method : 'GET')
                    ).toUpperCase();
                    const promise = originalFetch.apply(this, arguments);

                    if (typeof url === 'string' && (method === 'POST' || method === 'DELETE')) {
                        const match = PLAYED_ROUTE.exec(url);
                        if (match) {
                            promise.then(response => {
                                if (response?.ok) notePlayedItem(match[1]);
                            }).catch(() => { });
                        }
                    }
                    return promise;
                };
            }
        } catch (e) {
            WARN('fetch hook failed:', e);
        }

        try {
            const originalOpen = XMLHttpRequest.prototype.open;
            const originalSend = XMLHttpRequest.prototype.send;

            XMLHttpRequest.prototype.open = function (method, url) {
                this.__kefinSpoilerMethod = String(method || '').toUpperCase();
                this.__kefinSpoilerUrl = typeof url === 'string' ? url : '';
                return originalOpen.apply(this, arguments);
            };

            XMLHttpRequest.prototype.send = function () {
                const request = this;
                const method = request.__kefinSpoilerMethod;
                const match = PLAYED_ROUTE.exec(request.__kefinSpoilerUrl || '');
                if (match && (method === 'POST' || method === 'DELETE')) {
                    request.addEventListener('loadend', function () {
                        if (request.status >= 200 && request.status < 300) notePlayedItem(match[1]);
                    });
                }
                return originalSend.apply(this, arguments);
            };
        } catch (e) {
            WARN('XHR hook failed:', e);
        }
    }

    function installMessageListener() {
        if (window.__kefinJeSpoilerScopeListening) return;
        if (!window.websocketHelper) return;
        window.__kefinJeSpoilerScopeListening = true;
        window.websocketHelper.listen('UserDataChanged', noteUserDataMessage);
    }

    /**
     * Narrow the plugin's own refresh, but only while a mark-played is pending.
     * The Spoiler Guard toggle button calls the same function and does want the
     * broad refresh, so that path is passed straight through.
     *
     * Only reached if the plugin installed its watched hook before we could claim
     * the flag below.
     */
    function wrapRefresh() {
        const internal = jeSpoilerGuard();
        if (!internal || typeof internal.refreshSpoilerableImages !== 'function') return false;
        if (internal.refreshSpoilerableImages.__kefinScoped) return true;

        const original = internal.refreshSpoilerableImages;

        function scopedRefreshSpoilerableImages() {
            if (pendingIsFresh()) {
                scheduleBust();     // our deferred, id-scoped bust covers this
                return;
            }
            return original.apply(this, arguments);
        }
        scopedRefreshSpoilerableImages.__kefinScoped = true;

        try {
            internal.refreshSpoilerableImages = scopedRefreshSpoilerableImages;
        } catch (e) {
            return false;           // non-writable; leave the plugin alone
        }
        return true;
    }

    // ---- Boot ---------------------------------------------------------------

    // Claim the plugin's watched-refresh hook before its Spoiler Guard boots, so
    // it never installs the document-wide version and never wraps fetch and XHR a
    // second time. Harmless if Spoiler Guard is off or absent, since then nothing
    // would have been installed anyway.
    let claimedHook = false;
    try {
        if (!window.__je_spoilerBlurWatchedHookInstalled) {
            window.__je_spoilerBlurWatchedHookInstalled = true;
            claimedHook = true;
        }
    } catch (e) { /* leave claimedHook false and fall back to wrapping */ }

    installRequestHooks();
    installMessageListener();

    // The plugin loads ~149 component scripts asynchronously, so its internals may
    // not exist yet. Poll briefly, then give up rather than spin for the session.
    let attempts = 0;
    const timer = setInterval(() => {
        attempts++;
        installMessageListener();
        const done = claimedHook ? !!window.JellyfinEnhanced : wrapRefresh();
        if (done || attempts >= 120) {                 // ~30s ceiling
            clearInterval(timer);
            if (done) {
                LOG(claimedHook
                    ? 'Spoiler Guard watched-refresh claimed; image refresh is now item-scoped'
                    : 'Spoiler Guard refresh wrapped; watched-path image refresh is now item-scoped');
            }
        }
    }, 250);
})();
