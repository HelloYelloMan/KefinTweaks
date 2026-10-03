// KefinTweaks Collection Episode List
//
// On a collection (BoxSet) page, draws the Episodes group the way a season page
// draws its episodes: a vertical list of large-image rows with the overview,
// runtime, rating and the played/favourite/more buttons, instead of jellyfin-web's
// grid of portrait cards.
//
// WHY JELLYFIN'S OWN MARKUP. The rows are built to match what jellyfin-web's
// listView.getListViewHtml emits for a season page (itemDetails renderChildren,
// the Season branch: imageSize 'large', enableOverview, enableSideMediaInfo
// false, highlight false, imagePlayButton, includeParentInfoInTitle false). Every
// skin styles a season page through those classes -- .listItem-largeImage,
// .listItemImage-large, .listItemBody, .listItem-overview -- and none of them
// scope those rules to #childrenContent, so matching the markup is what makes
// this inherit whatever the skin does there, with no CSS of its own. listView is
// a webpack module jellyfin-web never exposes, so it cannot be called; the markup
// is reproduced instead, and checked against a season page captured from 12.1.
//
// Desktop and mobile differ the same way they do on a season page: on a phone
// the whole row is a link, and there are no Info or Played buttons. The TV layout
// is left as jellyfin-web draws it, since its list rows are buttons with focus
// handling this does not reproduce.
//
// THE GRID STAYS, HIDDEN. collections.js sorts a collection by moving the cards
// inside the first .itemsContainer, and its observer re-sorts whenever the page
// re-renders. Leaving the grid in place keeps that working untouched: the list
// sits after it and re-orders its rows to match the grid whenever the grid's
// children move. jellyfin-web lazy-loads card images by IntersectionObserver, so
// a hidden grid fetches no artwork.
(function () {
    'use strict';

    const LOG = (...args) => console.log('[KefinTweaks CollectionEpisodeList]', ...args);
    const WARN = (...args) => console.warn('[KefinTweaks CollectionEpisodeList]', ...args);

    const LIST_ATTR = 'data-kefin-episode-list';
    const GRID_HIDDEN_CLASS = 'kefin-episode-grid-replaced';
    const SPECIAL_TEMPLATE_KEY = 'kefinTweaks_specialEpisodeTemplate_';
    const WAIT_MS = 15000;

    let viewToken = 0;
    let teardown = [];
    let observedGrid = null;

    function stopAll() {
        viewToken++;
        teardown.forEach((fn) => { try { fn(); } catch (e) { /* already gone */ } });
        teardown = [];
        observedGrid = null;
    }

    function injectStyle() {
        if (document.getElementById('kefin-collection-episode-list-style')) return;
        const style = document.createElement('style');
        style.id = 'kefin-collection-episode-list-style';
        style.textContent = `.${GRID_HIDDEN_CLASS} { display: none !important; }`;
        (document.head || document.documentElement).appendChild(style);
    }

    // jellyfin-web's layoutManager, read from the class it puts on <html>.
    function currentLayout() {
        const classes = document.documentElement.classList;
        if (classes.contains('layout-tv')) return 'tv';
        if (classes.contains('layout-mobile')) return 'mobile';
        return 'desktop';
    }

    // ======================================================================
    // Markup, after listview.js, mediainfo.js, indicators.js and itemHelper.js
    // ======================================================================

    function esc(value) {
        return String(value ?? '').replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    // jellyfin-web renders the overview as markdown and sanitises it. Overviews
    // here are plain prose, so paragraphs are enough, and escaping stands in
    // for the sanitiser.
    function overviewHtml(overview) {
        if (!overview) return '';
        return overview.split(/\n\s*\n/)
            .map((p) => p.trim())
            .filter(Boolean)
            .map((p) => `<p>${esc(p)}</p>\n`)
            .join('');
    }

    function specialTemplate() {
        try {
            const cached = localStorage.getItem(SPECIAL_TEMPLATE_KEY + (ApiClient.serverId() || 'unknown'));
            if (cached && cached.indexOf('{0}') !== -1) return cached;
        } catch (e) { /* storage blocked */ }
        return 'Special - {0}';
    }

    // itemHelper.getDisplayName with includeParentInfo false, as a season page
    // calls it. Virtual Specials removes the "Special - " prefix from collection
    // pages; its renamer only knows cards, so when it is on, specials get their
    // own Name here, matching the cards they replace.
    function displayName(item, options) {
        const name = item.Name || '';
        if (item.ParentIndexNumber === 0) {
            return options.plainSpecials ? name : options.specialTemplate.replace('{0}', name);
        }
        if (item.IndexNumber != null && item.ParentIndexNumber != null) {
            let number = String(item.IndexNumber);
            if (item.IndexNumberEnd) number += '-' + item.IndexNumberEnd;
            return name ? `${number}. ${name}` : number;
        }
        return name;
    }

    function displayDuration(ticks) {
        const totalMinutes = Math.round(ticks / 600000000) || 1;
        const hours = Math.floor(totalMinutes / 60);
        return (hours > 0 ? `${hours}h ` : '') + `${totalMinutes % 60}m`;
    }

    function displayTime(date) {
        const locale = document.documentElement.lang || undefined;
        try {
            return date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
        } catch (e) {
            return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        }
    }

    // mediainfo.getPrimaryMediaInfoHtml with episodeTitle, originalAirDate and
    // subtitles off: for an episode that is runtime, 3D, stars, critic rating,
    // "Ends at" and the missing/unaired marker.
    function mediaInfoHtml(item) {
        let html = '';
        if (item.RunTimeTicks) html += `<div class="mediaInfoItem">${displayDuration(item.RunTimeTicks)}</div>`;
        if (item.Video3DFormat) html += '<div class="mediaInfoItem">3D</div>';
        if (item.CommunityRating) {
            html += '<div class="starRatingContainer mediaInfoItem"><span class="material-icons starIcon star" aria-hidden="true"></span>'
                + item.CommunityRating.toFixed(1) + '</div>';
        }
        if (item.CriticRating) {
            const freshness = item.CriticRating >= 60 ? 'Fresh' : 'Rotten';
            html += `<div class="mediaInfoItem mediaInfoCriticRating mediaInfoCriticRating${freshness}">${item.CriticRating}</div>`;
        }
        if (item.MediaType === 'Video' && item.RunTimeTicks && !item.StartDate) {
            const remainingMs = (item.RunTimeTicks - (item.UserData?.PlaybackPositionTicks || 0)) / 10000;
            html += `<div class="endsAt mediaInfoItem">Ends at ${esc(displayTime(new Date(Date.now() + remainingMs)))}</div>`;
        }
        if (item.LocationType === 'Virtual') {
            const unaired = item.PremiereDate && new Date(item.PremiereDate).getTime() > Date.now();
            html += unaired ? '<div class="unairedIndicator">Unaired</div>' : '<div class="missingIndicator">Missing</div>';
        }
        return html;
    }

    // listview.getImageUrl at the large size: the item's own Primary, else the
    // series poster.
    function imageUrl(item) {
        let itemId = null;
        let tag = null;
        if (item.ImageTags?.Primary) {
            itemId = item.Id; tag = item.ImageTags.Primary;
        } else if (item.SeriesId && item.SeriesPrimaryImageTag) {
            itemId = item.SeriesId; tag = item.SeriesPrimaryImageTag;
        } else if (item.ParentPrimaryImageTag) {
            itemId = item.ParentPrimaryImageItemId; tag = item.ParentPrimaryImageTag;
        }
        if (!itemId) return null;
        const options = { type: 'Primary', fillWidth: 500, fillHeight: 500, tag };
        return typeof ApiClient.getScaledImageUrl === 'function'
            ? ApiClient.getScaledImageUrl(itemId, options)
            : ApiClient.getImageUrl(itemId, options);
    }

    // cardBuilderUtils.getDefaultBackgroundClass
    function defaultBackgroundClass(name) {
        let hash = 0;
        for (const ch of String(name || '')) hash = (hash + ch.charCodeAt(0)) % 5;
        return 'defaultCardBackground defaultCardBackground' + (hash + 1);
    }

    function rowHtml(item, options) {
        const userData = item.UserData || {};
        const overview = overviewHtml(item.Overview);
        const mediaType = item.MediaType ? ` data-mediatype="${esc(item.MediaType)}"` : '';
        const position = userData.PlaybackPositionTicks ? ` data-positionticks="${userData.PlaybackPositionTicks}"` : '';

        let html = `<div class="listItem listItem-largeImage listItem-withContentWrapper" data-action="${options.action}"`
            + ` data-isfolder="${!!item.IsFolder}" data-id="${esc(item.Id)}" data-serverid="${esc(item.ServerId)}"`
            + ` data-type="${esc(item.Type)}"${mediaType}${position} data-collectionid="${esc(options.collectionId)}">`;
        html += '<div class="listItem-content">';

        const img = imageUrl(item);
        if (img) {
            html += `<div data-action="link" class="listItemImage listItemImage-large itemAction lazy" data-src="${esc(img)}" item-icon>`;
        } else {
            html += `<div class="listItemImage listItemImage-large itemAction cardImageContainer ${defaultBackgroundClass(item.Name)}">`
                + '<span class="cardImageIcon material-icons tv" aria-hidden="true"></span>';
        }
        if ((item.MediaSourceCount || 1) > 1) {
            html += `<div class="mediaSourceIndicator">${item.MediaSourceCount}</div>`;
        }
        if (userData.Played || userData.PlayedPercentage >= 100) {
            html += '<div class="indicators listItemIndicators"><div class="playedIndicator indicator">'
                + '<span class="material-icons indicatorIcon check" aria-hidden="true"></span></div></div>';
        }
        html += '<button is="paper-icon-button-light" class="listItemImageButton itemAction" data-action="resume" title="Play">'
            + '<span class="material-icons listItemImageButton-icon play_arrow" aria-hidden="true"></span></button>';
        if (userData.PlayedPercentage && userData.PlayedPercentage < 100) {
            html += '<div class="itemProgressBar listItemProgressBar"><div class="itemProgressBarForeground" style="width:'
                + userData.PlayedPercentage + '%;"></div></div>';
        }
        html += '</div>';

        html += '<div class="listItemBody itemAction">';
        html += `<div class="listItemBodyText"><bdi>${esc(displayName(item, options))}</bdi></div>`;
        html += `<div class="secondary listItemMediaInfo listItemBodyText">${mediaInfoHtml(item)}</div>`;
        if (overview) html += `<div class="secondary listItem-overview listItemBodyText"><bdi>${overview}</bdi></div>`;
        html += '</div>';

        html += '<div class="listViewUserDataButtons">';
        if (options.infoButton) {
            html += '<button is="paper-icon-button-light" class="listItemButton itemAction" data-action="link" title="Info">'
                + '<span class="material-icons info_outline" aria-hidden="true"></span></button>';
        }
        if (options.playedButton) {
            html += `<button is="emby-playstatebutton" type="button" class="listItemButton paper-icon-button-light" data-id="${esc(item.Id)}"`
                + ` data-serverid="${esc(item.ServerId)}" data-itemtype="${esc(item.Type)}" data-played="${!!userData.Played}">`
                + '<span class="material-icons check" aria-hidden="true"></span></button>';
        }
        const likes = userData.Likes == null ? '' : userData.Likes;
        html += `<button is="emby-ratingbutton" type="button" class="listItemButton paper-icon-button-light" data-id="${esc(item.Id)}"`
            + ` data-serverid="${esc(item.ServerId)}" data-itemtype="${esc(item.Type)}" data-likes="${likes}" data-isfavorite="${!!userData.IsFavorite}">`
            + '<span class="material-icons favorite" aria-hidden="true"></span></button>';
        html += '<button is="paper-icon-button-light" class="listItemButton itemAction" data-action="menu" title="More">'
            + '<span class="material-icons more_vert" aria-hidden="true"></span></button>';
        html += '</div>';

        html += '</div>';
        if (overview) html += `<div class="listItem-bottomoverview secondary"><bdi>${overview}</bdi></div>`;
        html += '</div>';
        return html;
    }

    // ======================================================================
    // Images: loaded as rows near the viewport, as jellyfin-web's imageLoader does
    // ======================================================================

    function loadImage(el) {
        const url = el.getAttribute('data-src');
        if (!url) return;
        el.removeAttribute('data-src');
        el.style.backgroundImage = `url("${url}")`;
        el.classList.add('non-blurhashable', 'lazy-image-fadein-fast');
    }

    function lazyLoadImages(list) {
        const images = list.querySelectorAll('.listItemImage[data-src]');
        if (typeof IntersectionObserver !== 'function') {
            images.forEach(loadImage);
            return;
        }
        const observer = new IntersectionObserver((entries) => {
            entries.forEach((entry) => {
                if (!entry.isIntersecting) return;
                observer.unobserve(entry.target);
                loadImage(entry.target);
            });
        }, { rootMargin: '50%' });
        images.forEach((img) => observer.observe(img));
        teardown.push(() => observer.disconnect());
    }

    // ======================================================================
    // The page
    // ======================================================================

    // The Episodes group: jellyfin-web makes one per item type, so it is the
    // grid whose cards are all episodes.
    function findEpisodeGrid(collectionItems) {
        for (const grid of collectionItems.querySelectorAll('.collectionItemsContainer')) {
            const cards = grid.querySelectorAll(':scope > .card[data-id]');
            if (cards.length && Array.from(cards).every((c) => c.getAttribute('data-type') === 'Episode')) {
                return grid;
            }
        }
        return null;
    }

    // Rows follow the grid: collections.js sorts by moving cards.
    function syncOrder(grid, list) {
        const rows = new Map(Array.from(list.querySelectorAll(':scope > .listItem[data-id]'))
            .map((row) => [row.getAttribute('data-id'), row]));
        const order = Array.from(grid.querySelectorAll(':scope > .card[data-id]'))
            .map((card) => rows.get(card.getAttribute('data-id')))
            .filter(Boolean);
        const current = Array.from(list.children);
        if (order.length === current.length && order.every((row, i) => row === current[i])) return;
        order.forEach((row) => list.appendChild(row));
    }

    async function fetchEpisodes(collectionId) {
        const result = await ApiClient.getItems(ApiClient.getCurrentUserId(), {
            ParentId: collectionId,
            IncludeItemTypes: 'Episode',
            Fields: 'Overview,MediaSourceCount,PrimaryImageAspectRatio',
            EnableImageTypes: 'Primary'
        });
        return (result?.Items || []).filter((item) => item.Type === 'Episode');
    }

    let applying = false;

    async function apply(page, item, token) {
        const mode = currentLayout();
        if (mode === 'tv' || applying) return;
        const collectionItems = page.querySelector('.collectionItems');
        const grid = collectionItems && findEpisodeGrid(collectionItems);
        if (!grid) return;

        let list = grid.parentElement.querySelector(`:scope > [${LIST_ATTR}]`);
        if (!list) {
            applying = true;
            let episodes;
            try {
                episodes = await fetchEpisodes(item.Id);
            } catch (e) {
                WARN('Could not fetch the collection\'s episodes; leaving the grid', e);
                return;
            } finally {
                applying = false;
            }
            if (token !== viewToken || !grid.isConnected || !episodes.length) return;

            const options = {
                action: mode === 'desktop' ? 'none' : 'link',
                infoButton: mode === 'desktop',
                playedButton: mode === 'desktop',
                collectionId: item.Id,
                plainSpecials: window.KefinTweaksConfig?.scripts?.virtualSpecials !== false,
                specialTemplate: specialTemplate()
            };
            const padding = mode === 'mobile' ? '' : ' padded-right';
            grid.insertAdjacentHTML('afterend',
                `<div is="emby-itemscontainer" class="itemsContainer vertical-list${padding}" ${LIST_ATTR}="">`
                + episodes.map((episode) => rowHtml(episode, options)).join('')
                + '</div>');
            list = grid.nextElementSibling;
            grid.classList.add(GRID_HIDDEN_CLASS);
            lazyLoadImages(list);
            LOG(`Listed ${episodes.length} episode(s) for collection ${item.Id}`);
        }

        syncOrder(grid, list);
        if (observedGrid === grid) return;
        observedGrid = grid;
        const gridObserver = new MutationObserver(() => syncOrder(grid, list));
        gridObserver.observe(grid, { childList: true });
        teardown.push(() => gridObserver.disconnect());
    }

    // .collectionItems is part of the page template; jellyfin-web fills it once
    // the children arrive and refills it from scratch (innerHTML = '') when the
    // collection changes, which takes the list with it. Watching its direct
    // children covers both.
    function watch(page, item, token) {
        const start = Date.now();
        const tick = () => {
            if (token !== viewToken) return;
            const collectionItems = page.querySelector('.collectionItems');
            if (!collectionItems) {
                if (Date.now() - start < WAIT_MS) setTimeout(tick, 200);
                return;
            }
            let timer = null;
            const observer = new MutationObserver(() => {
                clearTimeout(timer);
                timer = setTimeout(() => apply(page, item, token), 50);
            });
            observer.observe(collectionItems, { childList: true });
            teardown.push(() => { observer.disconnect(); clearTimeout(timer); });
            apply(page, item, token);
        };
        tick();
    }

    function initializeHook() {
        if (!window.KefinTweaksUtils || !window.KefinTweaksUtils.onViewPage) {
            setTimeout(initializeHook, 1000);
            return;
        }
        injectStyle();

        window.KefinTweaksUtils.onViewPage(
            async (view, element, hash, itemPromise) => {
                if (ApiClient._loggedIn === false) return;
                const page = document.querySelector('.itemDetailPage:not(.hide)')
                    || document.querySelector('.libraryPage:not(.hide)');
                if (!page) return;

                let item;
                try { item = await itemPromise; } catch (e) { return; }
                // A slow item fetch can resolve after the next page's handler
                // has started; stopAll() here would cancel that page's work.
                if (page.classList.contains('hide')) return;

                stopAll();
                if (!item || item.Type !== 'BoxSet' || !item.Id) return;
                watch(page, item, viewToken);
            },
            {
                pages: ['details'],
                triggerOnSameHash: false
            }
        );

        LOG('Collection episode list hook initialized');
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
