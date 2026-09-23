// KefinTweaks Special Episode Prefix
//
// Removes the "Special - " that Jellyfin prepends to the title of every episode
// in season zero, everywhere it appears.
//
// WHY THIS CANNOT BE CSS. itemHelper.getDisplayName builds one string and it is
// inserted as text:
//
//     if (item.Type === 'Episode' && item.ParentIndexNumber === 0) {
//         name = globalize.translate('ValueSpecialEpisodeName', name);
//     }
//
// There is no wrapper element, no pseudo-element and no attribute for a selector
// to reach, so the only way to remove it is to rewrite the text.
//
// WHY NOT MATCH THE STRING "Special - ". The prefix is localized -- "Extra – {0}"
// in German, "Especial - {0}" in Spanish, and so on -- so a hardcoded match works
// on exactly one server. scripts/virtualSpecials.js sidesteps that on collection
// pages by writing back the item's own Name, which is what getDisplayName started
// from and therefore exact by construction. That is the right answer when the item
// is already in hand; globally it is not, because it would mean fetching an item
// for every title on screen.
//
// SO THE TEMPLATE IS LEARNED ONCE, not assumed. The rendered string is
// template.replace('{0}', name). Given one episode where both the rendered string
// and the raw Name are known, the template falls out:
//
//     rendered  "Special - A Certain Girl's Day Off"
//     Name                 "A Certain Girl's Day Off"
//     template  "Special - {0}"
//
// One API call, once, cached in localStorage per server. After that every title
// is handled by a regex with no further requests, on this page load and all
// later ones, in whatever language the server is set to.
//
// The two obvious alternatives are both closed: globalize is not on window
// (only Emby.Page and ApiClient are), and the translations ship as hashed webpack
// chunks -- en-us-json.<hash>.chunk.js -- rather than a fetchable strings/en-us.json,
// so the template cannot simply be read.
//
// THE ONE FALSE POSITIVE it can produce: an episode genuinely named "Special - X"
// outside season zero would lose its prefix too. Nothing in the DOM says which
// season a card belongs to, so this is the cost of not fetching every item. It is
// a title that reads the same either way, which is why it is an acceptable one.

(function () {
    'use strict';

    const LOG = (...args) => console.log('[KefinTweaks SpecialPrefix]', ...args);
    const WARN = (...args) => console.warn('[KefinTweaks SpecialPrefix]', ...args);

    const DONE_ATTR = 'data-kefin-special-prefix';
    const STORAGE_PREFIX = 'kefinTweaks_specialEpisodeTemplate_';

    // Where a display name produced by getDisplayName actually lands. Card text,
    // the detail page subtitle, and the episode rows on a season page.
    const TEXT_SELECTORS = [
        '.cardText-first',
        '.cardText > bdi',
        '.listItemBodyText:not(.secondary)',
        '.nameContainer .itemName.subtitle bdi',
        '.nameContainer .itemName.subtitle'
    ].join(', ');

    let template = null;          // e.g. 'Special - {0}'
    let pattern = null;           // RegExp built from it
    let deriving = false;

    function storageKey() {
        try {
            // The wording is Jellyfin's translation, so it differs per display
            // language; globalize sets <html lang>.
            return STORAGE_PREFIX + (ApiClient.serverId() || 'unknown')
                + '_' + (document.documentElement.lang || '');
        } catch (e) {
            return STORAGE_PREFIX + 'unknown';
        }
    }

    function escapeRegExp(s) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * Turn 'Special - {0}' into /(^|\s-\s)Special - (.+?)$/.
     *
     * Anchored to the start of the text OR to Jellyfin's own ' - ' separator.
     * The detail page subtitle is built as `tvSeasonHtml + ' - ' + name`, so the
     * prefix sits in the middle of "Specials - Special - Title" there, and a
     * start-only anchor would miss it. Unanchored, though, it cut the words out
     * of any title that merely contains them: "The Holiday Special - Part 1"
     * became "The Holiday Part 1". getDisplayName only ever puts the prefix at
     * the start of the name, and the name is only ever joined on with ' - ', so
     * those two positions are the only ones it can occupy.
     */
    function setTemplate(value) {
        if (!value || value.indexOf('{0}') === -1) return false;
        const [before, after] = value.split('{0}');
        if (!before && !after) return false; // '{0}' alone strips nothing
        template = value;
        pattern = new RegExp('(^|\\s-\\s)' + escapeRegExp(before) + '(.+?)' + escapeRegExp(after) + '$');
        return true;
    }

    function loadCachedTemplate() {
        try {
            return localStorage.getItem(storageKey());
        } catch (e) {
            return null;
        }
    }

    function cacheTemplate(value) {
        try {
            localStorage.setItem(storageKey(), value);
        } catch (e) {
            // A full or blocked localStorage only costs us the cache, not the feature.
        }
    }

    /**
     * Learn the template from whatever special is already on screen.
     *
     * Any card carrying a data-id gives both halves of the comparison: its
     * rendered text, and -- from one lookup -- the raw Name the server holds.
     * The first season-zero episode whose rendered text merely ENDS with its Name
     * yields the prefix.
     *
     * Two things keep this from becoming chatty. The ids go out in a single Ids=
     * query rather than one request per card, and every id examined is remembered,
     * so a page with no specials on it costs exactly one request and then nothing
     * -- not one request per card, and not a fresh round on every mutation batch.
     * A home page holding 873 card titles and no specials is the case that makes
     * the difference.
     */
    /**
     * Only ever look at the page that is actually on screen.
     *
     * Jellyfin is a single-page app and keeps previous views in the DOM with
     * .hide rather than removing them, so after browsing the home screen the
     * document holds 1500+ elements carrying data-id, of which about 24 belong to
     * the page you are looking at. Scanning the document therefore sampled the
     * home screen's library cards -- "Anime", "Anime Movies", "Collections" --
     * and never reached the specials on the episode page, whatever the budget.
     * That is what made the prefix survive when arrived at by navigation but not
     * on a direct load.
     */
    function visibleScopes() {
        const pages = document.querySelectorAll('[data-role="page"]:not(.hide)');
        return pages.length ? Array.from(pages) : [document];
    }

    const triedIds = new Set();
    // A library with no specials would otherwise keep probing for the life of the
    // page as new cards scroll in. Five batches is plenty to find one where any
    // exist, and an episode or season page derives from the first round anyway.
    //
    // PER VIEW, not per page load. This is a single-page app: browsing home and
    // then opening an episode is one page load, so a session-wide budget spent on
    // a home screen full of ordinary cards left nothing for the episode page --
    // where the specials actually are. Reported as the prefix surviving on the
    // episode page and its More from Specials row, with template: [] and nothing
    // marked, while a direct load of that same page derived on the first round.
    const MAX_TRIED_IDS = 200;

    async function deriveFromVisibleCard() {
        if (triedIds.size >= MAX_TRIED_IDS) return false;
        const candidates = [];
        outer:
        for (const scope of visibleScopes()) {
            for (const card of scope.querySelectorAll('[data-id]')) {
                const id = card.getAttribute('data-id');
                if (!id || triedIds.has(id)) continue;
                const el = card.querySelector('.cardText-first, .cardText > bdi, .listItemBodyText:not(.secondary)');
                const rendered = (el ? el.textContent : '').trim();
                if (!rendered) continue;
                candidates.push({ id, rendered });
                if (candidates.length >= 40) break outer;
            }
        }
        if (!candidates.length) return false;

        candidates.forEach((c) => triedIds.add(c.id));

        let items;
        try {
            const result = await ApiClient.getItems(ApiClient.getCurrentUserId(), {
                Ids: candidates.map((c) => c.id).join(','),
                Fields: 'ParentIndexNumber',
                EnableImages: false,
                EnableUserData: false,
                EnableTotalRecordCount: false
            });
            items = result?.Items || [];
        } catch (err) {
            WARN('Lookup for template derivation failed:', err);
            return false;
        }

        const byId = new Map(items.map((item) => [item.Id, item]));
        for (const { id, rendered } of candidates) {
            const item = byId.get(id);
            if (!item || item.Type !== 'Episode' || item.ParentIndexNumber !== 0) continue;
            if (!item.Name || rendered === item.Name || !rendered.endsWith(item.Name)) continue;
            const derived = rendered.slice(0, rendered.length - item.Name.length) + '{0}';
            if (setTemplate(derived)) {
                cacheTemplate(derived);
                LOG(`Derived template: ${JSON.stringify(derived)}`);
                return true;
            }
        }
        return false;
    }

    function stripIn(root) {
        if (!pattern) return 0;
        if (observer) observer.disconnect();
        try {
            return stripInUnobserved(root);
        } finally {
            if (observer) observer.observe(document.body, OBSERVE_OPTIONS);
        }
    }

    /**
     * Rewrite TEXT NODES, never elements.
     *
     * Two shapes have to survive this, and writing textContent on the matched
     * element wrecks both:
     *
     *   a card title   div.cardText-first > bdi > a.itemAction > "Special - Title"
     *   the subtitle   h3.itemName.subtitle > bdi > [ a "Specials", " - Special - Title" ]
     *
     * On the card, assigning to the div or the bdi replaces the <a> with a text
     * node and the card stops being a link. On the subtitle the prefix is not in
     * any element at all -- it is in a text node sitting next to the season link,
     * so there is nothing to assign to and an element-level pass skips it
     * entirely. Both were reported: the title still prefixed on the episode page,
     * and the More from Specials row with it.
     *
     * Walking to the text nodes handles both, changes nothing structural, and
     * leaves every link intact.
     */
    function stripTextNodes(container) {
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
        let changed = 0;
        const pending = [];
        let node;
        while ((node = walker.nextNode())) {
            const text = node.nodeValue;
            if (!text) continue;
            const next = text.replace(pattern, '$1$2');
            if (next !== text) pending.push([node, next]);
        }
        pending.forEach(([n, value]) => { n.nodeValue = value; changed++; });
        return changed;
    }

    function stripInUnobserved(root) {
        const scopes = root && root.querySelectorAll ? [root] : visibleScopes();
        let changed = 0;
        const seen = new Set();
        scopes.forEach((scope) => scope.querySelectorAll(TEXT_SELECTORS).forEach((el) => {
            if (seen.has(el) || el.hasAttribute(DONE_ATTR)) return;
            seen.add(el);
            if (!pattern.test(el.textContent || '')) {
                // Nothing here now, and it cannot start matching without being
                // rebuilt -- and a rebuilt node arrives without the marker.
                el.setAttribute(DONE_ATTR, '1');
                return;
            }
            changed += stripTextNodes(el);
            el.setAttribute(DONE_ATTR, '1');
        }));
        return changed;
    }

    let observer = null;
    const OBSERVE_OPTIONS = { childList: true, subtree: true };
    let sweepTimer = null;
    function scheduleSweep() {
        if (sweepTimer) return;
        sweepTimer = setTimeout(async () => {
            sweepTimer = null;
            if (!pattern) {
                const cached = loadCachedTemplate();
                if (cached && setTemplate(cached)) {
                    LOG(`Using cached template: ${JSON.stringify(cached)}`);
                } else if (!deriving) {
                    deriving = true;
                    let ok = false;
                    try {
                        ok = await deriveFromVisibleCard();
                    } finally {
                        deriving = false;
                    }
                    if (!ok) return;
                }
            }
            const n = stripIn(document);
            if (n) LOG(`Stripped the special prefix from ${n} title(s)`);
        }, 150);
    }

    function initializeHook() {
        // The loader can run a feature script more than once; a second observer
        // would double every sweep.
        if (window.__kefinSpecialPrefixActive) return;
        window.__kefinSpecialPrefixActive = true;

        const cached = loadCachedTemplate();
        if (cached) setTemplate(cached);

        // Jellyfin rebuilds these containers constantly -- cards stream in, the
        // detail page re-renders on navigation -- so watch rather than sweep once.
        // The observer is detached across our own writes: setting textContent and
        // the marker attribute are themselves mutations, and feeding them back in
        // would schedule a sweep for every title we fix.
        observer = new MutationObserver(() => scheduleSweep());
        observer.observe(document.body, OBSERVE_OPTIONS);

        if (window.KefinTweaksUtils?.onViewPage) {
            window.KefinTweaksUtils.onViewPage(() => {
                if (!pattern) triedIds.clear(); // a fresh budget for each view
                scheduleSweep();
            }, { pages: [] });
        }

        scheduleSweep();
        LOG('Special episode prefix hook initialized');
    }

    function initialize(attempt = 0) {
        if (typeof ApiClient === 'undefined' || !ApiClient || !window.KefinTweaksUtils) {
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
