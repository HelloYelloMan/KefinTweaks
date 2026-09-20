// KefinTweaks Episode Thumb Cards
//
// Shows an episode's own still on its card instead of its series' poster.
//
// Jellyfin draws episodes in Recently Added, Next Up and similar rows as
// portrait cards carrying the SERIES poster, so every episode of a show looks
// identical and tells you nothing about the episode. Each episode has its own
// Primary image -- a 16:9 still from the episode itself -- and this puts that on
// the card instead.
//
// TWO HALVES, and both are needed. Swapping the image alone would leave a 16:9
// still cropped into a 2:3 box; changing the shape alone would letterbox the
// poster. So the image URL is repointed at the episode and the card is switched
// to the backdrop shape at the same moment.
//
// HOW THE SHAPE CHANGES. Jellyfin's card classes carry the shape --
// portraitCard/overflowPortraitCard against backdropCard/overflowBackdropCard,
// plus a matching cardPadder-* whose percentage padding is what actually sets
// the height. Swapping both class families is how the rest of the codebase does
// it, so the card picks up every rule that already exists for backdrop cards
// rather than needing a parallel set of its own.
//
// WORKS WITH OR WITHOUT trueAspectCards. On its own this produces a normal
// 16:9 backdrop card. With that feature on, the card is no longer in the
// portrait family it looks at, so the two do not fight: this one owns the
// episode cards, that one owns the posters.
//
// ONLY WHERE THERE IS A STILL. An episode with no Primary image of its own
// keeps the series poster, because a card with no picture is worse than a
// repeated one.

(function () {
    'use strict';

    const LOG = (...args) => console.log('[KefinTweaks EpisodeThumbs]', ...args);
    const WARN = (...args) => console.warn('[KefinTweaks EpisodeThumbs]', ...args);

    const DONE_ATTR = 'data-kefin-episode-thumb';

    /** @type {Map<string, boolean>} episodeId -> has its own Primary image */
    const hasStill = new Map();
    const pending = new Set();

    function visibleScopes() {
        const pages = document.querySelectorAll('[data-role="page"]:not(.hide)');
        return pages.length ? Array.from(pages) : [document];
    }

    function candidateCards(scope) {
        const out = [];
        scope.querySelectorAll('.card[data-type="Episode"]').forEach((card) => {
            if (card.hasAttribute(DONE_ATTR)) return;
            if (!card.classList.contains('portraitCard')
                && !card.classList.contains('overflowPortraitCard')) return;
            const id = card.getAttribute('data-id');
            if (!id) return;
            // Only once the card has an image; they load lazily, and a card with
            // nothing to rewrite has to be retried rather than settled.
            const holder = card.querySelector('.cardImageContainer');
            const bg = holder ? (holder.style.backgroundImage || '') : '';
            if (!bg || bg === 'none') return;
            out.push({ card, id, holder, bg });
        });
        return out;
    }

    async function fetchStillFlags(ids) {
        const wanted = ids.filter((id) => !hasStill.has(id) && !pending.has(id));
        if (!wanted.length) return;
        wanted.forEach((id) => pending.add(id));
        try {
            const result = await ApiClient.getItems(ApiClient.getCurrentUserId(), {
                Ids: wanted.join(','),
                Fields: 'PrimaryImageAspectRatio',
                EnableUserData: false,
                EnableTotalRecordCount: false
            });
            (result?.Items || []).forEach((item) => {
                hasStill.set(item.Id, !!(item.ImageTags && item.ImageTags.Primary));
            });
            wanted.forEach((id) => { if (!hasStill.has(id)) hasStill.set(id, false); });
        } catch (err) {
            WARN('Episode image lookup failed:', err);
        } finally {
            wanted.forEach((id) => pending.delete(id));
        }
    }

    /**
     * Repoint the background at this episode's own Primary.
     *
     * The existing URL is reused rather than rebuilt so the server address,
     * the size parameters and the quality the card already asked for all carry
     * over; only the item and the tag change. The tag has to go: it belongs to
     * the series' image and would return a stale or missing file against the
     * episode.
     */
    function repointImage(holder, bg, episodeId) {
        const match = bg.match(/url\(["']?(.*?)["']?\)/);
        if (!match) return false;
        const url = match[1];
        const next = url
            .replace(/\/Items\/[a-f0-9-]+\/Images\/[A-Za-z]+/, `/Items/${episodeId}/Images/Primary`)
            .replace(/[?&]tag=[^&]*/, (m) => (m[0] === '?' ? '?' : ''))
            .replace(/\?&/, '?')
            .replace(/[?&]$/, '');
        if (next === url) return false;
        holder.style.backgroundImage = `url("${next}")`;
        return true;
    }

    /** portrait -> backdrop, on the card and on its padder. */
    function reshape(card) {
        const overflow = card.classList.contains('overflowPortraitCard');
        card.classList.remove('portraitCard', 'overflowPortraitCard');
        card.classList.add(overflow ? 'overflowBackdropCard' : 'backdropCard');

        const padder = card.querySelector('.cardPadder');
        if (padder) {
            padder.classList.remove('cardPadder-portrait', 'cardPadder-overflowPortrait');
            padder.classList.add(overflow ? 'cardPadder-overflowBackdrop' : 'cardPadder-backdrop');
        }
    }

    async function processScope(scope) {
        const todo = candidateCards(scope);
        if (!todo.length) return;

        const ids = [...new Set(todo.map((t) => t.id))];
        for (let i = 0; i < ids.length; i += 100) {
            await fetchStillFlags(ids.slice(i, i + 100));
        }

        let changed = 0;
        todo.forEach(({ card, id, holder, bg }) => {
            card.setAttribute(DONE_ATTR, '1');
            if (!hasStill.get(id)) return;      // no still of its own; leave the poster
            if (!repointImage(holder, bg, id)) return;
            reshape(card);
            changed++;
        });
        if (changed) LOG(`Switched ${changed} episode card(s) to their own still`);
    }

    let sweepTimer = null;
    function scheduleSweep() {
        if (sweepTimer) return;
        sweepTimer = setTimeout(() => {
            sweepTimer = null;
            visibleScopes().forEach((scope) => { processScope(scope); });
        }, 200);
    }

    function initializeHook() {
        if (window.__kefinEpisodeThumbsActive) return;
        window.__kefinEpisodeThumbsActive = true;

        const observer = new MutationObserver(() => scheduleSweep());
        observer.observe(document.body, { childList: true, subtree: true });
        // Images arrive lazily as a style change, which the observer above does
        // not see; scrolling is what reveals them.
        window.addEventListener('scroll', scheduleSweep, { passive: true, capture: true });

        if (window.KefinTweaksUtils?.onViewPage) {
            window.KefinTweaksUtils.onViewPage(() => scheduleSweep(), { pages: [] });
        }

        scheduleSweep();
        LOG('Episode thumb cards initialized');
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
