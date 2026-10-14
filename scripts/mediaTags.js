// KefinTweaks Media Tags
// Adds a "Tags" row to the item-details metadata table (.itemDetailsGroup) on
// Movie/Series/etc. detail pages, matching the Genres/Studios rows.
//
// Why JS (not CSS): Jellyfin builds .itemDetailsGroup only from a fixed set of
// metadata types — Author, Creator, Director, Writer, Studio, Genre — via the
// ItemDetailsMetadataList component. Tags are NOT in that set; they render only
// into the separate .itemTags paragraph under the overview. So there is no
// hidden tags row in the table for CSS to reveal — one has to be created.
//
// ElegantFin only: it hides that paragraph, while Default and Abyss show it and
// a row there would list the tags twice. The skin declares it in skinConfig.js
// (`mediaTagsRow: true` on its entry), the way Abyss declares requiresBaseTheme;
// skinWantsRow() reads that from the active skin's merged config.
//
// Approach: clone the existing Genres row (so the injected row inherits the exact
// markup/classes/styling of the metadata table on any skin), relabel it "Tags",
// and fill its .content with tag links. The links themselves are built by cloning
// one of the row's own <a> elements (so they get the exact `.content > a` styling)
// and copying each tag's text + href from the ones Jellyfin already rendered into
// .itemTags (correct hrefs, no route reconstruction). Links are joined with ", "
// text nodes, matching how Jellyfin renders genres/studios (`.join(', ')`).
//
// Position: directly after the Genres row (see injectTagsRow). .itemDetailsGroup
// is a plain container React only mounts into (each row is its own mount), so
// inserting a child is safe; on item change Jellyfin clears the group
// (innerHTML='') and we re-inject on the next view.

(function () {
    'use strict';

    const LOG = (...args) => console.log('[KefinTweaks MediaTags]', ...args);
    const WARN = (...args) => console.warn('[KefinTweaks MediaTags]', ...args);

    const INJECTED_CLASS = 'kefin-tags-row';
    const SUPPORTED_TYPES = ['Movie', 'Series', 'Season', 'Episode', 'BoxSet', 'MusicAlbum', 'MusicArtist', 'Book', 'AudioBook', 'MusicVideo'];

    // Bounded readiness poll: the metadata table mounts asynchronously (React) and
    // .itemTags is populated during the same render pass, so wait for both.
    const POLL_INTERVAL_MS = 150;
    const POLL_TIMEOUT_MS = 5000;

    // The active skin's entry in the merged skin list (admin over defaults) says
    // whether it wants the row: `mediaTagsRow: true`, set on ElegantFin only.
    function skinWantsRow() {
        const name = window.KefinTweaksSkinManager?.getSelectedSkinName?.();
        if (!name) return false;
        const skins = window.KefinTweaksSkinConfig
            || window.KefinTweaksDefaultSkinsConfig?.skins || [];
        const skin = skins.find(s => s.name === name);
        return skin?.mediaTagsRow === true;
    }

    function getTagLinks(page) {
        const itemTags = page.querySelector('.itemTags');
        if (!itemTags) return [];
        return Array.from(itemTags.querySelectorAll('a'));
    }

    // Find a row in the group whose label matches `re` (e.g. /genre/i). Labels are
    // localized, so this is best-effort — callers fall back gracefully when null.
    function findRowByLabel(group, re) {
        const rows = group.querySelectorAll('.detailsGroupItem');
        for (let i = 0; i < rows.length; i++) {
            const label = rows[i].querySelector('.label');
            if (label && re.test((label.textContent || '').trim())) return rows[i];
        }
        return null;
    }

    function injectTagsRow(page) {
        const group = page.querySelector('.itemDetailsGroup');
        if (!group) return false;

        // Remove any row we injected on a previous pass (recycled page / re-render).
        const prev = group.querySelector('.' + INJECTED_CLASS);
        if (prev) prev.remove();

        // After the removal above, so a row drawn under another skin goes too.
        if (!skinWantsRow()) return true;

        const tagLinks = getTagLinks(page);
        if (!tagLinks.length) return true; // no tags on this item — nothing to add, but we're "done"

        // Prefer the Genres row as the clone template (its <a>s have the exact link
        // styling we want to replicate); otherwise any row will do for structure.
        const genresRow = findRowByLabel(group, /genre/i);
        const template = genresRow || group.querySelector('.detailsGroupItem');
        if (!template) return false; // no rows at all — nothing to clone / attach to

        const row = template.cloneNode(true);
        row.className = 'detailsGroupItem ' + INJECTED_CLASS; // drop any group-specific classes

        const label = row.querySelector('.label');
        if (label) label.textContent = 'Tags';

        const values = row.querySelector('.content') || row.children[1];
        if (!values) return false;

        // Grab one existing link as a styling template BEFORE clearing the container,
        // so tag links render identically to genre/studio links.
        const linkTemplate = values.querySelector('a');
        values.className = 'content';
        values.innerHTML = '';

        tagLinks.forEach((a, i) => {
            if (i > 0) values.appendChild(document.createTextNode(', '));
            let link;
            if (linkTemplate) {
                link = linkTemplate.cloneNode(true);
                link.textContent = a.textContent;
                const href = a.getAttribute('href');
                if (href != null) link.setAttribute('href', href);
            } else {
                link = a.cloneNode(true); // no template available — use the tag link as-is
            }
            values.appendChild(link);
        });

        // Position: directly after Genres (i.e. between Genres and Studios, since
        // Genres renders before Studios). Fall back to just before Studios, else
        // append.
        // Jellyfin 12 wraps each row in its own div, so position against the
        // group's direct child that holds the row, not the row itself.
        const topLevel = (el) => {
            while (el && el.parentElement !== group) el = el.parentElement;
            return el;
        };
        if (genresRow) {
            group.insertBefore(row, topLevel(genresRow).nextSibling);
        } else {
            const studiosRow = topLevel(findRowByLabel(group, /studio|network/i));
            if (studiosRow) group.insertBefore(row, studiosRow);
            else group.appendChild(row);
        }
        LOG('Injected Tags row with', tagLinks.length, 'tag(s)');
        return true;
    }

    // The metadata rows render progressively and in an unpredictable order: on a
    // movie with Director/Writer, those rows can appear BEFORE Genres, and a later
    // render pass for Genres/Studios replaces the group's contents — wiping a row we
    // injected too early. So instead of a one-shot inject, watch the group and
    // re-inject on every change (debounced to let a render burst settle), which both
    // waits for the Genres anchor to exist and re-places our row if it gets clobbered.
    //
    // Bounded, per the perf audit: the observer disconnects after SETTLE_MS of quiet
    // and, as a hard backstop, after POLL_TIMEOUT_MS total — so nothing observes the
    // group for the life of the page.
    const SETTLE_MS = 250;

    let activeObserver = null;
    let settleTimer = null;
    let hardStopTimer = null;

    function stopObserving() {
        if (activeObserver) { activeObserver.disconnect(); activeObserver = null; }
        if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
        if (hardStopTimer) { clearTimeout(hardStopTimer); hardStopTimer = null; }
    }

    // Re-inject with the observer paused, so our own DOM writes don't re-trigger it.
    function reinject(page, group) {
        if (activeObserver) activeObserver.disconnect();
        injectTagsRow(page);
        if (activeObserver && group.isConnected) {
            activeObserver.observe(group, { childList: true, subtree: true });
        }
    }

    function observeGroup(page, group) {
        stopObserving();
        activeObserver = new MutationObserver(() => {
            if (settleTimer) clearTimeout(settleTimer);
            settleTimer = setTimeout(() => reinject(page, group), SETTLE_MS);
        });
        activeObserver.observe(group, { childList: true, subtree: true });
        reinject(page, group);                              // initial attempt
        hardStopTimer = setTimeout(stopObserving, POLL_TIMEOUT_MS);
    }

    function beginInjection(page, startedAt) {
        startedAt = startedAt || Date.now();
        const group = page.querySelector('.itemDetailsGroup');
        if (group) { observeGroup(page, group); return; }
        if (Date.now() - startedAt >= POLL_TIMEOUT_MS) return; // group never appeared
        setTimeout(() => beginInjection(page, startedAt), POLL_INTERVAL_MS);
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
                // A slow item fetch can resolve after the next page's handler has
                // started; leave that page's observer alone.
                if (!page.isConnected || page.classList.contains('hide')) return;
                // Tear down any observer from the previous details page before
                // (re)starting for this one.
                stopObserving();

                if (!item || !SUPPORTED_TYPES.includes(item.Type)) return;

                beginInjection(page);
            },
            {
                pages: ['details'],
                // triggerOnSameHash must stay true. With false, utils drops every
                // call whose URL equals the last one it reported - and when this
                // script loads after Jellyfin has already reported the page, that
                // drops both the immediate call on registration and the view show,
                // so a refresh sometimes did nothing at all. It also starved the
                // outgoing-page case: going from one item page to another, the
                // first call finds the page being left and gives up, and the view
                // show that would find the new one has the same hash. Repeat calls
                // are harmless - injectTagsRow() replaces its own row.
                triggerOnSameHash: true
            }
        );

        LOG('Media tags hook initialized');
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
