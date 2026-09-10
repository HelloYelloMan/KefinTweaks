// KefinTweaks Collection Studios
// Shows the Studios row on a collection (BoxSet) detail page.
//
// Why JS: jellyfin-web refuses to render it. renderStudio in
// src/controllers/itemDetails/index.js opens with
//
//     if ([BaseItemKind.BoxSet, BaseItemKind.Playlist].includes(item.Type)) return;
//
// commented "the list of studios can be massive for collections of items".
// There is no setting and no threshold -- it is an unconditional early return,
// so the row is empty and hidden on every collection, however few studios it
// has. The markup is present and waiting:
//
//     <div class="detailsGroupItem studiosGroup hide">
//         <div class="studiosLabel label"></div>
//         <div class="studios content focuscontainer-x"></div>
//     </div>
//
// so this fills in what renderStudio would have written and drops the `hide`.
// That guard is reasonable for a hand-curated collection of 200 films; it is
// not for the generated ones this exists for, which carry a studio or two set
// by their metadata provider.
//
// Links are built by cloning an anchor jellyfin-web already rendered into a
// neighbouring row (Director, Writer, Genre) rather than by writing the markup
// out. Those anchors are `is="emby-linkbutton"` custom built-in elements, and
// setting that attribute on an anchor created afterwards does not upgrade it --
// only a clone of an already-upgraded element carries the behaviour, and the
// skin's `.content > a` styling, across. A plain anchor is the fallback when
// the page has no other row to clone from; the hash href navigates either way.

(function () {
    'use strict';

    const LOG = (...args) => console.log('[KefinTweaks CollectionStudios]', ...args);
    const WARN = (...args) => console.warn('[KefinTweaks CollectionStudios]', ...args);

    const INJECTED_ATTR = 'data-kefin-studios';

    // The group mounts asynchronously with the rest of the metadata table.
    const POLL_INTERVAL_MS = 150;
    const POLL_TIMEOUT_MS = 5000;
    const SETTLE_MS = 250;

    function buildLink(template, studio, serverId) {
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

    // An anchor from any other row in the metadata table, to clone. Deliberately
    // not from .studios itself -- that is the container being filled, and on a
    // repeat pass it would hold our own clones.
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

    function injectStudios(page, item) {
        const groupEl = page.querySelector('.studiosGroup');
        if (!groupEl) return false;

        const studios = (item && item.Studios) || [];
        const label = groupEl.querySelector('.studiosLabel');
        const content = groupEl.querySelector('.studios');
        if (!content) return false;

        if (!studios.length) {
            // Nothing to show. Leave the row exactly as jellyfin-web left it,
            // including its `hide`, and clear anything a previous item's render
            // put there (the detail page element can be reused across items).
            if (groupEl.getAttribute(INJECTED_ATTR)) {
                content.innerHTML = '';
                groupEl.classList.add('hide');
                groupEl.removeAttribute(INJECTED_ATTR);
            }
            return true;
        }

        const serverId = item.ServerId || (window.ApiClient && ApiClient.serverId && ApiClient.serverId());
        const template = findLinkTemplate(page);

        content.innerHTML = '';
        studios.forEach((studio, i) => {
            if (!studio || !studio.Id) return;
            // ', ' between entries, matching how jellyfin-web joins the other rows.
            if (i > 0) content.appendChild(document.createTextNode(', '));
            content.appendChild(buildLink(template, studio, serverId));
        });

        if (label) {
            label.textContent = studios.length > 1 ? 'Studios' : 'Studio';
        }
        groupEl.classList.remove('hide');
        groupEl.setAttribute(INJECTED_ATTR, '1');
        LOG('Showed', studios.length, 'studio(s)');
        return true;
    }

    // The metadata rows render progressively and a later pass can replace the
    // group's contents, wiping an injection made too early. Same approach as
    // mediaTags.js: watch the group, re-inject when it settles, and stop
    // observing once it goes quiet or the timeout is reached, so nothing
    // observes for the life of the page.
    let activeObserver = null;
    let settleTimer = null;
    let hardStopTimer = null;

    function stopObserving() {
        if (activeObserver) { activeObserver.disconnect(); activeObserver = null; }
        if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
        if (hardStopTimer) { clearTimeout(hardStopTimer); hardStopTimer = null; }
    }

    // Re-inject with the observer paused, so our own writes do not re-trigger it.
    function reinject(page, group, item) {
        if (activeObserver) activeObserver.disconnect();
        injectStudios(page, item);
        if (activeObserver && group.isConnected) {
            activeObserver.observe(group, { childList: true, subtree: true });
        }
    }

    function observeGroup(page, group, item) {
        stopObserving();
        activeObserver = new MutationObserver(() => {
            if (settleTimer) clearTimeout(settleTimer);
            settleTimer = setTimeout(() => reinject(page, group, item), SETTLE_MS);
        });
        activeObserver.observe(group, { childList: true, subtree: true });
        reinject(page, group, item);
        hardStopTimer = setTimeout(stopObserving, POLL_TIMEOUT_MS);
    }

    function beginInjection(page, item, startedAt) {
        startedAt = startedAt || Date.now();
        const group = page.querySelector('.itemDetailsGroup');
        if (group) { observeGroup(page, group, item); return; }
        if (Date.now() - startedAt >= POLL_TIMEOUT_MS) return;
        setTimeout(() => beginInjection(page, item, startedAt), POLL_INTERVAL_MS);
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

                const page = document.querySelector('.itemDetailPage:not(.hide)')
                    || document.querySelector('.libraryPage:not(.hide)');
                if (!page) return;

                let item;
                try {
                    item = await itemPromise;
                } catch (e) {
                    return;
                }

                // Tear down the previous page's observer before starting here.
                stopObserving();

                if (!item || item.Type !== 'BoxSet') return;

                beginInjection(page, item);
            },
            {
                pages: ['details'],
                triggerOnSameHash: false
            }
        );

        LOG('Collection studios hook initialized');
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
