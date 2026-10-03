// KefinTweaks Collection Sections As Season Lists
//
// On a collection (BoxSet) page, draws each section (Episodes, Movies, Series...)
// the way a season page draws its episodes: a vertical list of large-image rows
// with the overview, the media info line and the played/favourite/more buttons,
// instead of jellyfin-web's grid of cards.
//
// One of two alternative layouts for these sections; the other is
// collectionSectionRows.js. With both features on, this one wins and the rows
// feature stands down.
//
// WHY JELLYFIN'S OWN MARKUP. The rows reproduce what jellyfin-web's
// listView.getListViewHtml emits for a season page (itemDetails renderChildren,
// the Season branch: imageSize 'large', enableOverview, enableSideMediaInfo
// false, highlight false, imagePlayButton, includeParentInfoInTitle false). Every
// skin styles a season page through those classes -- .listItem-largeImage,
// .listItemImage-large, .listItemBody, .listItem-overview -- and none scope them
// to #childrenContent, so matching the markup is what makes this inherit the
// skin's season-page look with no CSS of its own. listView is a webpack module
// jellyfin-web never exposes, so it cannot be called; the markup is reproduced,
// and was checked against a season page captured from 12.1 in the desktop,
// legacy and mobile layouts (same classes, same image box: 91x160 on a phone).
//
// Desktop and mobile differ the same way they do on a season page: on a phone
// the whole row is a link, and there are no Info or Played buttons. The TV
// layout is left as jellyfin-web draws it, since its list rows are buttons with
// focus handling this does not reproduce.
//
// THE GRIDS STAY, HIDDEN. collections.js sorts a collection by moving the cards
// inside the first .itemsContainer. Leaving each grid in place keeps that
// working: its list sits after it and re-orders its rows to match whenever the
// grid's cards move. jellyfin-web lazy-loads card images by IntersectionObserver,
// so a hidden grid fetches no artwork.
(function () {
    'use strict';

    const LOG = (...args) => console.log('[KefinTweaks CollectionSectionList]', ...args);
    const WARN = (...args) => console.warn('[KefinTweaks CollectionSectionList]', ...args);

    const LIST_ATTR = 'data-kefin-section-list';
    const GRID_HIDDEN_CLASS = 'kefin-section-grid-replaced';
    const SPECIAL_TEMPLATE_KEY = 'kefinTweaks_specialEpisodeTemplate_';
    const WAIT_MS = 15000;

    let viewToken = 0;
    let teardown = [];
    const observedGrids = new WeakSet();

    function stopAll() {
        viewToken++;
        teardown.forEach((fn) => { try { fn(); } catch (e) { /* already gone */ } });
        teardown = [];
    }

    function injectStyle() {
        if (document.getElementById('kefin-collection-section-list-style')) return;
        const style = document.createElement('style');
        style.id = 'kefin-collection-section-list-style';
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
        if (item.Type !== 'Episode') return name;
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

    function yearOf(date) {
        const year = date ? new Date(date).getFullYear() : NaN;
        return Number.isFinite(year) ? year : null;
    }

    function infoItem(text, cssClass) {
        return `<div class="${cssClass ? cssClass + ' ' : ''}mediaInfoItem">${esc(text)}</div>`;
    }

    // mediainfo.getPrimaryMediaInfoHtml with episodeTitle, originalAirDate and
    // subtitles off, which is how the season list calls it.
    function mediaInfoHtml(item) {
        let html = '';
        if (item.Type === 'BoxSet' && (item.ChildCount || 0) > 0) {
            html += infoItem(`${item.ChildCount} items`);
        }
        if (item.Type === 'Series' && item.ProductionYear) {
            const end = yearOf(item.EndDate);
            if (item.Status === 'Continuing') html += infoItem(`${item.ProductionYear} - Present`);
            else html += infoItem(end && end !== item.ProductionYear ? `${item.ProductionYear} - ${end}` : String(item.ProductionYear));
        } else if (!['Series', 'Episode', 'Person', 'Season', 'Program'].includes(item.Type) && item.MediaType !== 'Photo') {
            const year = item.ProductionYear || yearOf(item.PremiereDate);
            if (year) html += infoItem(String(year));
        }
        if (item.RunTimeTicks && !['Series', 'Program', 'Book', 'BoxSet'].includes(item.Type)) {
            html += infoItem(displayDuration(item.RunTimeTicks));
        }
        if (item.OfficialRating && item.Type !== 'Season' && item.Type !== 'Episode') {
            html += infoItem(item.OfficialRating, 'mediaInfoText mediaInfoOfficialRating');
        }
        if (item.Video3DFormat) html += infoItem('3D');
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
            html += infoItem(`Ends at ${displayTime(new Date(Date.now() + remainingMs))}`, 'endsAt');
        }
        if (item.Type === 'Episode' && item.LocationType === 'Virtual') {
            const unaired = item.PremiereDate && new Date(item.PremiereDate).getTime() > Date.now();
            html += unaired ? '<div class="unairedIndicator">Unaired</div>' : '<div class="missingIndicator">Missing</div>';
        }
        return html;
    }

    // listview.getImageUrl at the large size: the item's own Primary, else the
    // album's, the series', or the parent's.
    function imageUrl(item) {
        let itemId = null;
        let tag = null;
        if (item.ImageTags?.Primary) {
            itemId = item.Id; tag = item.ImageTags.Primary;
        } else if (item.AlbumId && item.AlbumPrimaryImageTag) {
            itemId = item.AlbumId; tag = item.AlbumPrimaryImageTag;
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

    // cardBuilderUtils.getDefaultBackgroundClass, and the icon getDefaultText
    // falls back to.
    function defaultBackgroundClass(name) {
        let hash = 0;
        for (const ch of String(name || '')) hash = (hash + ch.charCodeAt(0)) % 5;
        return 'defaultCardBackground defaultCardBackground' + (hash + 1);
    }

    function defaultIcon(item) {
        return ({ Movie: 'movie', Series: 'tv', Episode: 'tv', MusicAlbum: 'album', Audio: 'audiotrack',
            Book: 'book', AudioBook: 'book', BoxSet: 'collections', MusicVideo: 'music_video' })[item.Type] || 'folder';
    }

    function canMarkPlayed(item) {
        return !['Person', 'Program', 'TvChannel', 'Studio', 'Genre'].includes(item.Type);
    }

    function playedIndicatorHtml(item) {
        const userData = item.UserData || {};
        if (userData.UnplayedItemCount) {
            return `<div class="countIndicator indicator">${userData.UnplayedItemCount >= 100 ? '99+' : userData.UnplayedItemCount}</div>`;
        }
        if (userData.Played || userData.PlayedPercentage >= 100) {
            return '<div class="playedIndicator indicator"><span class="material-icons indicatorIcon check" aria-hidden="true"></span></div>';
        }
        return '';
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
                + `<span class="cardImageIcon material-icons ${defaultIcon(item)}" aria-hidden="true"></span>`;
        }
        if ((item.MediaSourceCount || 1) > 1) {
            html += `<div class="mediaSourceIndicator">${item.MediaSourceCount}</div>`;
        }
        const indicator = playedIndicatorHtml(item);
        if (indicator) html += `<div class="indicators listItemIndicators">${indicator}</div>`;
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
        if (options.playedButton && canMarkPlayed(item)) {
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

    async function fetchChildren(collectionId) {
        const result = await ApiClient.getItems(ApiClient.getCurrentUserId(), {
            ParentId: collectionId,
            Fields: 'Overview,MediaSourceCount,PrimaryImageAspectRatio,ChildCount,ProductionYear,PremiereDate,EndDate,Status,OfficialRating,CriticRating',
            EnableImageTypes: 'Primary'
        });
        return new Map((result?.Items || []).map((child) => [child.Id, child]));
    }

    let applying = false;

    async function apply(page, item, token) {
        const mode = currentLayout();
        if (mode === 'tv' || applying) return;
        const collectionItems = page.querySelector('.collectionItems');
        if (!collectionItems) return;
        const grids = Array.from(collectionItems.querySelectorAll('.collectionItemsContainer'))
            .filter((grid) => grid.querySelector(':scope > .card[data-id]'));
        if (!grids.length) return;

        const pending = grids.filter((grid) => !grid.parentElement.querySelector(`:scope > [${LIST_ATTR}]`));
        if (pending.length) {
            applying = true;
            let children;
            try {
                children = await fetchChildren(item.Id);
            } catch (e) {
                WARN('Could not fetch the collection\'s items; leaving the grids', e);
                return;
            } finally {
                applying = false;
            }
            if (token !== viewToken || !children.size) return;

            const options = {
                action: mode === 'desktop' ? 'none' : 'link',
                infoButton: mode === 'desktop',
                playedButton: mode === 'desktop',
                collectionId: item.Id,
                plainSpecials: window.KefinTweaksConfig?.scripts?.virtualSpecials !== false,
                specialTemplate: specialTemplate()
            };
            const padding = mode === 'mobile' ? '' : ' padded-right';
            for (const grid of pending) {
                if (!grid.isConnected) continue;
                const rows = Array.from(grid.querySelectorAll(':scope > .card[data-id]'))
                    .map((card) => children.get(card.getAttribute('data-id')))
                    .filter(Boolean)
                    .map((child) => rowHtml(child, options))
                    .join('');
                if (!rows) continue;
                // style="text-align: left" as jellyfin-web sets on a season's list.
                grid.insertAdjacentHTML('afterend',
                    `<div is="emby-itemscontainer" class="itemsContainer vertical-list${padding}" style="text-align: left;" ${LIST_ATTR}="">${rows}</div>`);
                grid.classList.add(GRID_HIDDEN_CLASS);
                lazyLoadImages(grid.nextElementSibling);
            }
            LOG(`Listed ${pending.length} section(s) for collection ${item.Id}`);
        }

        for (const grid of grids) {
            const list = grid.parentElement.querySelector(`:scope > [${LIST_ATTR}]`);
            if (!list) continue;
            syncOrder(grid, list);
            if (observedGrids.has(grid)) continue;
            observedGrids.add(grid);
            const gridObserver = new MutationObserver(() => syncOrder(grid, list));
            gridObserver.observe(grid, { childList: true });
            teardown.push(() => { gridObserver.disconnect(); observedGrids.delete(grid); });
        }
    }

    // .collectionItems is part of the page template; jellyfin-web fills it once
    // the children arrive and refills it from scratch when the collection
    // changes, which takes the lists with it. Watching its direct children
    // covers both.
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
                let item;
                try { item = await itemPromise; } catch (e) { return; }
                // Judged by the URL, and the page looked up only now: going from
                // one item page to another this is called before jellyfin-web
                // swaps the views (see virtualSpecials.js).
                if (!item || !item.Id || !window.location.hash.includes(item.Id)) return;
                const page = document.querySelector('.itemDetailPage:not(.hide)');
                if (!page) return;

                stopAll();
                if (item.Type !== 'BoxSet') return;
                watch(page, item, viewToken);
            },
            {
                pages: ['details'],
                // true, unlike virtualSpecials.js: this script can register
                // after the first view of a page has been announced (it waits
                // for cardBuilder, which loads late), and with false the call
                // made on registration is dropped as a repeat of that hash, so
                // a page opened directly was never handled. A repeat is
                // harmless here: apply() finds its work already done.
                triggerOnSameHash: true
            }
        );

        LOG('Collection section list hook initialized');
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
