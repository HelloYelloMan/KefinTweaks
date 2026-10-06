// KefinTweaks Episode Title (part of Series & Specials)
//
// The big heading above an episode's title is the series name, linking to the
// series. This makes it name and open the level the episode actually sits in:
//
//   * An episode: the SEASON's Original Title, opening the season. Every show,
//     single-season ones too, so the heading always does the same thing; the
//     series is one more click away (the season page's own heading, or the
//     breadcrumb). A season with no Original Title keeps the series name as
//     text but still opens the season - "Season 2" in heading type is a
//     downgrade, the link is not.
//   * A special in exactly one virtual special collection: that collection's
//     name, opening the collection. With none or several there is no single
//     answer, and it is treated as the episode it is (its Specials season).
//
// Why: Jellyfin's renderName() builds that heading from the series alone, which
// is fine for western TV and wrong for anime, where seasons are distinctly titled
// works and specials belong to the release they came with.
//
// Navigation notes - neither is obvious:
//   * The heading's link is rendered with a literal href="#"; the destination
//     lives in data-action="link" + data-id, read by Jellyfin's DELEGATED
//     itemAction handler (it walks up from the event target). Rewriting href
//     does nothing, so a click handler on the anchor itself runs first and
//     stopPropagation() keeps the delegated one from going to the series.
//     data-id/data-type are updated too, so keyboard activation agrees.
//   * The heading is re-rendered by React after the view event and can replace
//     our text, so the name container is watched for a few seconds and the
//     change re-applied.

(function () {
    'use strict';

    const LOG  = (...args) => console.log('[KefinTweaks EpisodeTitle]', ...args);
    const WARN = (...args) => console.warn('[KefinTweaks EpisodeTitle]', ...args);

    // Mark the anchor we rewrote and keep what was there, so repeat passes are
    // idempotent and the original stays recoverable.
    const ORIGINAL_TEXT_ATTR = 'data-kefin-title-original';
    const ORIGINAL_HREF_ATTR = 'data-kefin-title-href';

    const POLL_INTERVAL_MS = 150;
    const POLL_TIMEOUT_MS  = 5000;
    const SETTLE_MS        = 250;

    const seasonCache = new Map();   // seasonId -> season item, or null

    // --------------------------------------------------
    //  DATA
    // --------------------------------------------------

    async function getSeason(seasonId) {
        if (seasonCache.has(seasonId)) return seasonCache.get(seasonId);
        let season = null;
        try {
            season = await ApiClient.getItem(ApiClient.getCurrentUserId(), seasonId);
        } catch (err) {
            WARN('Could not fetch season', seasonId, err);
        }
        seasonCache.set(seasonId, season);
        return season;
    }

    // seriesSpecialsData.js is a dependency, but the loader does not promise it
    // has RUN by the time this handler does - it is a separate file, and was
    // seen to land after this one on vault. So it is waited for, bounded, and
    // only for a special: no other episode needs it.
    function seriesSpecialsData() {
        const startedAt = Date.now();
        return new Promise(resolve => {
            const look = () => {
                if (window.KefinTweaksSeriesSpecialsData) resolve(window.KefinTweaksSeriesSpecialsData);
                else if (Date.now() - startedAt >= POLL_TIMEOUT_MS) resolve(null);
                else setTimeout(look, POLL_INTERVAL_MS);
            };
            look();
        });
    }

    // What the heading should say and open, or null to leave it as Jellyfin
    // rendered it. text null = keep the series name, retarget only.
    async function resolveHeading(item) {
        const data = item.ParentIndexNumber === 0 ? await seriesSpecialsData() : null;
        if (data && data.isSpecialEpisode(item)) {
            const special = await data.virtualSpecialOf(item);
            if (special) return { text: special.Name || null, id: special.Id, type: 'BoxSet' };
        }
        if (!item.SeasonId) return null;
        const season = await getSeason(item.SeasonId);
        const original = season && (season.OriginalTitle || '').trim();
        return { text: original || null, id: item.SeasonId, type: 'Season' };
    }

    // --------------------------------------------------
    //  THE HEADING
    // --------------------------------------------------

    function navigateToItem(itemId) {
        const base     = (typeof ApiClient !== 'undefined' && ApiClient._serverAddress) || '';
        const serverId = (typeof ApiClient !== 'undefined' && ApiClient.serverId) ? ApiClient.serverId() : '';
        window.location.href = base + '/web/#/details?id=' + encodeURIComponent(itemId)
            + (serverId ? '&serverId=' + encodeURIComponent(serverId) : '');
    }

    // The series link inside .parentName. Episodes get exactly one, but match on
    // the series name first so a skin or a later Jellyfin adding more never gets
    // the wrong one rewritten; once rewritten, the stored original identifies it.
    function findSeriesLink(page, item) {
        const parentName = page.querySelector('.nameContainer .parentName');
        if (!parentName) return null;
        const links = parentName.querySelectorAll('a');
        if (!links.length) return null;
        if (item.SeriesName) {
            for (const link of links) {
                const text = link.getAttribute(ORIGINAL_TEXT_ATTR) || link.textContent;
                if ((text || '').trim() === item.SeriesName.trim()) return link;
            }
        }
        return links[0];
    }

    function retargetLink(link, target) {
        // The latest target lives on the node, so the single click handler stays
        // right across re-renders and recycled pages.
        link._kefinTitleTarget = target.id;
        if (!link._kefinTitleNav) {
            link._kefinTitleNav = true;
            link.addEventListener('click', (e) => {
                const id = link._kefinTitleTarget;
                if (!id) return;
                e.preventDefault();
                e.stopPropagation();
                navigateToItem(id);
            }, true);
        }

        if (link.getAttribute('data-action') === 'link' && link.hasAttribute('data-id')) {
            if (link.getAttribute('data-id') !== target.id)     link.setAttribute('data-id', target.id);
            if (link.getAttribute('data-type') !== target.type) link.setAttribute('data-type', target.type);
            link.setAttribute('data-isfolder', 'true');
            return;
        }

        // Older builds put a real URL on the anchor: swap the id in the ORIGINAL
        // href, so repeat passes stay idempotent.
        if (!link.hasAttribute(ORIGINAL_HREF_ATTR)) {
            link.setAttribute(ORIGINAL_HREF_ATTR, link.getAttribute('href') || '');
        }
        const original = link.getAttribute(ORIGINAL_HREF_ATTR);
        const serverId = (typeof ApiClient !== 'undefined' && ApiClient.serverId) ? ApiClient.serverId() : '';
        const href = (original && /[?&]id=/.test(original))
            ? original.replace(/([?&]id=)[^&]*/, '$1' + encodeURIComponent(target.id))
            : '#/details?id=' + encodeURIComponent(target.id) + (serverId ? '&serverId=' + encodeURIComponent(serverId) : '');
        if (link.getAttribute('href') !== href) link.setAttribute('href', href);
    }

    function applyHeading(page, item, heading) {
        const link = findSeriesLink(page, item);
        if (!link) return;
        if (!link.hasAttribute(ORIGINAL_TEXT_ATTR)) {
            link.setAttribute(ORIGINAL_TEXT_ATTR, link.textContent || '');
        }
        const text = heading.text || link.getAttribute(ORIGINAL_TEXT_ATTR);
        if (text && link.textContent !== text) link.textContent = text;
        retargetLink(link, heading);
    }

    // --------------------------------------------------
    //  RE-RENDER GUARD
    // --------------------------------------------------

    let activeObserver = null;
    let settleTimer    = null;
    let hardStopTimer  = null;

    function stopObserving() {
        if (activeObserver) { activeObserver.disconnect(); activeObserver = null; }
        if (settleTimer)    { clearTimeout(settleTimer);   settleTimer = null; }
        if (hardStopTimer)  { clearTimeout(hardStopTimer); hardStopTimer = null; }
    }

    // Re-apply with the observer paused, so our own write does not re-trigger it.
    function reapply(container, apply) {
        if (activeObserver) activeObserver.disconnect();
        apply();
        if (activeObserver && container.isConnected) {
            activeObserver.observe(container, { childList: true, subtree: true });
        }
    }

    function observeContainer(container, apply) {
        stopObserving();
        activeObserver = new MutationObserver(() => {
            if (settleTimer) clearTimeout(settleTimer);
            settleTimer = setTimeout(() => reapply(container, apply), SETTLE_MS);
        });
        activeObserver.observe(container, { childList: true, subtree: true });
        reapply(container, apply);
        hardStopTimer = setTimeout(stopObserving, POLL_TIMEOUT_MS);
    }

    function whenPresent(page, selector, onFound, startedAt) {
        startedAt = startedAt || Date.now();
        const el = page.querySelector(selector);
        if (el) { onFound(el); return; }
        if (Date.now() - startedAt >= POLL_TIMEOUT_MS) return;
        setTimeout(() => whenPresent(page, selector, onFound, startedAt), POLL_INTERVAL_MS);
    }

    // The visible detail page Jellyfin has rendered this item into, identified by
    // the played button reloadFromItem() hands the item to (data-id). Our fetch
    // and Jellyfin's are separate, so ours can land before the page is shown -
    // and, coming from another item page, while the outgoing page is still the
    // visible one. Bounded; on timeout, the visible page.
    function pageFor(item) {
        const visible = () => document.querySelector('.itemDetailPage:not(.hide)')
            || document.querySelector('.libraryPage:not(.hide)');
        const startedAt = Date.now();
        return new Promise(resolve => {
            const look = () => {
                const page = visible();
                if (page && page.querySelector('.btnPlaystate[data-id="' + item.Id + '"]')) resolve(page);
                else if (Date.now() - startedAt >= POLL_TIMEOUT_MS) resolve(visible());
                else setTimeout(look, POLL_INTERVAL_MS);
            };
            look();
        });
    }

    // --------------------------------------------------
    //  INITIALIZATION
    // --------------------------------------------------

    // The page and item last set up, to skip repeat notifications.
    let applied = { page: null, itemId: null };

    function initializeHook() {
        if (!window.KefinTweaksUtils || !window.KefinTweaksUtils.onViewPage) {
            WARN('KefinTweaksUtils.onViewPage not available, retrying in 1 second');
            setTimeout(initializeHook, 1000);
            return;
        }

        window.KefinTweaksUtils.onViewPage(
            async (view, element, hash, itemPromise, previousHash) => {
                if (ApiClient._loggedIn === false) return;

                let item;
                try { item = await itemPromise; } catch (e) { return; }
                // A slow fetch can resolve after the next page's handler started.
                const current = () => window.location.hash.includes(item.Id);
                if (!item || !item.Id || !current()) return;

                const page = await pageFor(item);
                if (!page || !current()) return;

                // triggerOnSameHash is true: with false, utils drops a call whose
                // URL equals the last one it reported, and a script that loads
                // after Jellyfin reported the page then never runs for it. A
                // repeat for the same navigation is skipped once set up; a return
                // visit has a different previousHash and re-applies.
                if (previousHash === hash && applied.page === page && applied.itemId === item.Id) return;
                applied = { page, itemId: item.Id };

                stopObserving();
                if (item.Type !== 'Episode') return;

                const heading = await resolveHeading(item);
                if (!heading || !current() || page.classList.contains('hide')) return;

                whenPresent(page, '.nameContainer', (container) => {
                    observeContainer(container, () => applyHeading(page, item, heading));
                });
            },
            {
                pages: ['details'],
                triggerOnSameHash: true
            }
        );

        LOG('Episode title hook initialized');
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
})();
