// KefinTweaks Episode Logo (file and feature key keep the old name,
// episodeSeasonTitle, so saved settings and the loader registry still match)
//
// Makes the header logo (.detailLogo) a link one level up:
//   * on an EPISODE page it opens the season;
//   * on a SPECIAL in exactly one virtual special collection, it shows that
//     collection's logo and opens the collection (the same rule Episode Title
//     uses for the heading, through seriesSpecialsData.js);
//   * on a SEASON page it opens the series;
//   * on a VIRTUAL SPECIAL's collection page it opens the series its episodes
//     come from, when there is exactly one (seriesSpecialsData.js).
// On ElegantFin, which hides the logo on episode pages, it also shows it under
// the thumbnail in place of the series name. The title text itself is never
// changed - an earlier version swapped in the season's Original Title.
//
// THE LOGO IS JELLYFIN'S. This script never draws one. On an episode the server
// already gives .detailLogo the SEASON's logo when the season has one: its
// parent-image walk (DtoService.AddInheritedImages) starts at the episode's
// display parent, which is the season, and only falls back to the series. An
// earlier version put the season logo into the series-name heading as well,
// which on skins that show .detailLogo (Default, Abyss) meant the same logo
// twice. ElegantFin hides .detailLogo on episode pages; skins/elegant-kefin.css
// brings it back under the thumbnail, and this script supplies the one thing
// CSS cannot know there - where the title slot is (see EPISODE LOGO SLOT).
//
// Logo navigation notes - none of this is obvious:
//   * .detailLogo is a plain div with a lazy background-image, not a link, so it
//     gets click + keyboard handlers and link semantics added. It also loses the
//     stacking contest to its sibling .detailPageWrapperContainer (position:
//     relative, later in the DOM), which paints over it and swallows both clicks
//     and :hover. Hence the document-level capture listener for clicks and manual
//     pointer tracking for the cursor - neither depends on the logo being the
//     topmost element.
//   * .detailLogo ships in the page's STATIC template, hidden and empty; Jellyfin
//     removes .hide and sets the background only once the lazy image resolves,
//     long after the view event. Measuring the hitbox at bind time therefore reads
//     a 0x0 box, so an observer re-measures when the image lands.
//   * Abyss lays .detailLogo out in normal flow (position:static), where the
//     absolutely positioned hitbox would anchor to some ancestor instead of the
//     logo. Such a logo is made position:relative, which does not move it.
//
// Navigation itself uses the same form as KefinTweaks' breadcrumbs.
//
// Every behaviour is a switch in Item Page Tweaks' settings window (tweakOn).

(function () {
    'use strict';

    const LOG  = (...args) => console.log('[KefinTweaks EpisodeSeasonTitle]', ...args);
    const WARN = (...args) => console.warn('[KefinTweaks EpisodeSeasonTitle]', ...args);

    // ==========================================
    //              CONFIGURATION
    // ==========================================
    // Each behaviour is its own switch in the Item Page Tweaks settings window
    // (config.itemPageTweaks); unset means on, which is what every install ran
    // before the switches existed. With all of them off the window turns this
    // script's own flag off and the loader does not load it at all.
    //   episodeLogoToSeason       episode page: logo opens the season
    //   specialLogoFromCollection special: its virtual special's logo, opening it
    //   elegantfinEpisodeLogo     ElegantFin: episode logo under the thumbnail
    //   seasonLogoToSeries        season page: logo opens the series
    //   collectionLogoToSeries    virtual special's page: logo opens the series
    function tweakOn(key) {
        const tweaks = window.KefinTweaksConfig && window.KefinTweaksConfig.itemPageTweaks;
        return !tweaks || tweaks[key] !== false;
    }

    const LINK_CLASS  = 'kefin-logo-link';
    const HIT_CLASS   = 'kefin-logo-hit';
    const HOVER_CLASS = 'kefin-logo-hovering';
    const STYLE_ID    = 'kefin-episode-season-title-style';

    // Set on the page by the EPISODE LOGO SLOT code below; only
    // skins/elegant-kefin.css has rules for them.
    const SLOT_CLASS   = 'kefin-episode-logo';
    const PLACED_CLASS = 'kefin-episode-logo-placed';
    const SLOT_TOP_VAR = '--kefin-episode-logo-top';

    // Bounds for waiting on elements Jellyfin mounts asynchronously.
    const POLL_INTERVAL_MS = 150;
    const POLL_TIMEOUT_MS  = 5000;

    // --------------------------------------------------
    //  STYLES
    // --------------------------------------------------

    function injectStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            /* .detailLogo is absolutely positioned with z-index:auto and sits
               BEFORE .detailPageWrapperContainer (position:relative) in the DOM,
               so the wrapper paints over it and swallows clicks. Lift it above -
               but leave the box itself click-through, so its large transparent
               area never steals clicks from the controls underneath. Only the
               hitbox, sized to the painted logo, is interactive. */
            .detailLogo.${LINK_CLASS} { pointer-events: none; z-index: 2; }
            .${HIT_CLASS} {
                position: absolute; display: block;
                pointer-events: auto; cursor: pointer;
                border-radius: 4px;
            }
            .${HIT_CLASS}:focus-visible { outline: 2px solid currentColor; outline-offset: 4px; }

            /* The logo loses the stacking contest to .detailPageWrapperContainer,
               so :hover never reaches our hitbox and the cursor stays default. The
               pointer is tracked manually instead, flagging the document while it
               is over the logo - so this blanket cursor rule is only ever live in
               that moment. */
            html.${HOVER_CLASS}, html.${HOVER_CLASS} * { cursor: pointer !important; }
        `;
        document.head.appendChild(style);
    }

    // --------------------------------------------------
    //  DATA
    // --------------------------------------------------

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

    // Whether Jellyfin will put a logo in .detailLogo for this item - the same
    // two sources its renderLogo() reads.
    function hasHeaderLogo(item) {
        return !!((item.ImageTags && item.ImageTags.Logo) || item.ParentLogoImageTag);
    }

    // A special in a virtual special shows that collection's logo, not the
    // series' or the Specials season's. Jellyfin's renderLogo() has already run
    // by the time the page is found (pageFor waits for the same reload), but it
    // hands the URL to the lazy loader, which paints it LATER from data-src -
    // so both are pointed at the collection's logo, or the lazy load would paint
    // the series logo back over ours. Returns whether a logo is now shown.
    function showCollectionLogo(page, collection) {
        const tag = collection.ImageTags && collection.ImageTags.Logo;
        const logo = page.querySelector('.detailLogo');
        if (!tag || !logo) return false;
        let url;
        try {
            url = ApiClient.getScaledImageUrl(collection.Id, { type: 'Logo', tag: tag });
        } catch (err) {
            WARN('Could not build the collection logo URL', err);
            return false;
        }
        const paint = () => {
            if (logo.hasAttribute('data-src') && logo.getAttribute('data-src') !== url) {
                logo.setAttribute('data-src', url);
            }
            // Only when it differs: this also runs from the observer below,
            // which our own write would otherwise re-trigger forever.
            if (!(logo.style.backgroundImage || '').includes(url)) {
                logo.style.backgroundImage = 'url("' + url + '")';
            }
        };
        paint();
        logo.classList.remove('hide');   // an episode with no logo of its own

        // A lazy load already in flight when we swapped data-src still paints
        // the URL it read, so put ours back if anything replaces it - for as
        // long as such a load can take.
        if (collectionLogoObserver) collectionLogoObserver.disconnect();
        collectionLogoObserver = new MutationObserver(paint);
        collectionLogoObserver.observe(logo, { attributes: true, attributeFilter: ['style', 'data-src'] });
        if (collectionLogoStop) clearTimeout(collectionLogoStop);
        collectionLogoStop = setTimeout(stopCollectionLogo, POLL_TIMEOUT_MS);
        return true;
    }

    let collectionLogoObserver = null;
    let collectionLogoStop     = null;

    function stopCollectionLogo() {
        if (collectionLogoObserver) { collectionLogoObserver.disconnect(); collectionLogoObserver = null; }
        if (collectionLogoStop)     { clearTimeout(collectionLogoStop);   collectionLogoStop = null; }
    }

    // --------------------------------------------------
    //  NAVIGATION
    // --------------------------------------------------

    // Same form KefinTweaks' breadcrumbs use to move between detail pages.
    function navigateToItem(itemId) {
        const base     = (typeof ApiClient !== 'undefined' && ApiClient._serverAddress) || '';
        const serverId = (typeof ApiClient !== 'undefined' && ApiClient.serverId) ? ApiClient.serverId() : '';
        window.location.href = base + '/web/#/details?id=' + encodeURIComponent(itemId)
            + (serverId ? '&serverId=' + encodeURIComponent(serverId) : '');
    }

    // --------------------------------------------------
    //  EPISODE LOGO SLOT (ElegantFin)
    // --------------------------------------------------
    //
    // ElegantFin hides .detailLogo on episode pages and keeps the series name as
    // text. skins/elegant-kefin.css undoes that: on a page carrying SLOT_CLASS it
    // turns the series-name heading into an empty slot of fixed height, and lays
    // .detailLogo over it once PLACED_CLASS is set too. The slot is in normal
    // flow, so ElegantFin's own layout decides where it lands - the ribbon under
    // the thumbnail centres its content, and the phone layout pulls the thumbnail
    // up with a negative margin. .detailLogo, though, is absolutely positioned
    // against the page, so its offset has to be measured from the slot and handed
    // over as SLOT_TOP_VAR.
    //
    // Both classes are set on every skin; only elegant-kefin.css gives them
    // meaning, so Default and Abyss keep their logo exactly where it is.

    let slotPage     = null;
    let slotObserver = null;
    let slotTimers   = [];

    function placeEpisodeLogo(page) {
        if (!page || page !== slotPage || !page.classList.contains(SLOT_CLASS)) return;
        const slot = page.querySelector('.nameContainer > h1.parentName');
        if (!slot) return;
        const slotRect = slot.getBoundingClientRect();
        if (!slotRect.height) return;                    // not laid out yet
        const top = Math.round(slotRect.top - page.getBoundingClientRect().top);
        if (page.style.getPropertyValue(SLOT_TOP_VAR) !== top + 'px') {
            page.style.setProperty(SLOT_TOP_VAR, top + 'px');
        }
        page.classList.add(PLACED_CLASS);
    }

    function clearEpisodeLogoSlot(page) {
        if (slotObserver) { slotObserver.disconnect(); slotObserver = null; }
        slotTimers.forEach(clearTimeout);
        slotTimers = [];
        slotPage = null;
        if (!page) return;
        page.classList.remove(SLOT_CLASS, PLACED_CLASS);
        page.style.removeProperty(SLOT_TOP_VAR);
    }

    function markEpisodeLogoSlot(page) {
        slotPage = page;
        page.classList.add(SLOT_CLASS);
        const place = () => placeEpisodeLogo(page);

        // The slot moves when anything above it changes size - the thumbnail
        // loading, the window resizing, the ribbon re-rendering. ElegantFin's
        // phone header also slides in by animation, which resizes nothing, so a
        // few timed passes cover the time it takes to settle.
        if (typeof ResizeObserver !== 'undefined') {
            slotObserver = new ResizeObserver(place);
            slotObserver.observe(page);
            ['.detailRibbon', '.detailImageContainer', '.nameContainer'].forEach(sel => {
                page.querySelectorAll(sel).forEach(el => slotObserver.observe(el));
            });
        }
        [0, 300, 800, 1500, 3000].forEach(ms => slotTimers.push(setTimeout(place, ms)));
    }

    document.addEventListener('animationend', () => {
        if (slotPage && slotPage.isConnected) placeEpisodeLogo(slotPage);
    }, true);

    // --------------------------------------------------
    //  HEADER LOGO LINK (season -> series, episode -> season)
    // --------------------------------------------------

    function detailHref(itemId) {
        const base     = (typeof ApiClient !== 'undefined' && ApiClient._serverAddress) || '';
        const serverId = (typeof ApiClient !== 'undefined' && ApiClient.serverId) ? ApiClient.serverId() : '';
        return base + '/web/#/details?id=' + encodeURIComponent(itemId)
            + (serverId ? '&serverId=' + encodeURIComponent(serverId) : '');
    }

    // Computed background-position as [x%, y%]. Browsers normalise to lengths or
    // percentages, but keywords are mapped too in case one slips through.
    function parseBgPos(value) {
        const KEYWORDS = { left: '0%', top: '0%', center: '50%', right: '100%', bottom: '100%' };
        const VERTICAL = { top: true, bottom: true };
        const raw = String(value || '50% 50%').trim().split(/\s+/);

        // A single keyword names one axis and centres the other: "bottom" is
        // "center bottom", not "bottom center". ElegantFin declares exactly that.
        if (raw.length === 1 && VERTICAL[raw[0]]) raw.unshift('center');

        const parts = raw.map(p => KEYWORDS[p] || p);
        const pct = (v, fallback) => {
            const n = parseFloat(v);
            return (typeof v === 'string' && v.endsWith('%') && Number.isFinite(n)) ? n : fallback;
        };
        return [pct(parts[0], 50), pct(parts[1], 50)];
    }

    // Size the hitbox to the logo's PAINTED area. The div is a background-image
    // with background-size:contain, so the artwork occupies only a sub-rect of a
    // box that is 40% x 25vh - covering the whole box would block clicks on
    // everything beneath it. Falls back to the full box if the image can't be
    // measured (then the transparent margins are clickable, which is the old
    // behaviour but still better than nothing).
    function sizeHitbox(logo, hit) {
        const cs = getComputedStyle(logo);
        const match = (cs.backgroundImage || '').match(/url\(["']?(.*?)["']?\)/);

        const cover = () => {
            hit.style.left = '0'; hit.style.top = '0';
            hit.style.width = '100%'; hit.style.height = '100%';
        };
        if (!match || !match[1]) { cover(); return; }

        const img = new Image();
        img.onload = () => {
            const bw = logo.clientWidth, bh = logo.clientHeight;
            if (!bw || !bh || !img.naturalWidth || !img.naturalHeight) { cover(); return; }
            const scale = Math.min(bw / img.naturalWidth, bh / img.naturalHeight);
            const w = img.naturalWidth * scale;
            const h = img.naturalHeight * scale;
            const [px, py] = parseBgPos(cs.backgroundPosition);
            hit.style.left   = ((bw - w) * px / 100) + 'px';
            hit.style.top    = ((bh - h) * py / 100) + 'px';
            hit.style.width  = w + 'px';
            hit.style.height = h + 'px';
        };
        img.onerror = cover;
        img.src = match[1];
    }

    // .detailLogo is a div, so link semantics have to be added by hand - via a
    // real <a> child, which also gives middle-click / open-in-new-tab for free.
    // The target id lives on the node and is refreshed per view: detail pages are
    // recycled, so a stale id here would send a later page to the wrong item.
    function bindLogoLink(page, targetId, label) {
        const logo = page.querySelector('.detailLogo');
        if (!logo) return false;

        logo._kefinLogoTargetId = targetId || null;
        let hit = logo.querySelector('a.' + HIT_CLASS);

        if (!targetId) {
            logo.classList.remove(LINK_CLASS);
            if (logo._kefinAnchored) {
                logo._kefinAnchored = false;
                ANCHOR_PROPS.forEach(([prop]) => logo.style.removeProperty(prop));
            }
            if (hit) hit.remove();
            boundLogo = null;
            document.documentElement.classList.remove(HOVER_CLASS);
            return true;
        }

        logo.classList.add(LINK_CLASS);
        if (!hit) {
            hit = document.createElement('a');
            hit.className = HIT_CLASS;
            hit.addEventListener('click', (e) => {
                const id = logo._kefinLogoTargetId;
                if (!id) return;
                e.preventDefault();
                e.stopPropagation();
                navigateToItem(id);
            });
            logo.appendChild(hit);
        }
        hit.setAttribute('aria-label', label);
        hit.setAttribute('href', detailHref(targetId));
        boundLogo = logo;

        // A static logo (Abyss) is no containing block for the hitbox, so it is
        // made relative. Inline, because Abyss sets static from
        // #itemDetailPage .detailLogo, which outranks any class rule here. The
        // offsets are cleared with it: Jellyfin's own .detailLogo rule gives
        // top/left values that static ignores and relative would apply, which
        // moved Abyss's logo hundreds of pixels. Once only: this runs from the
        // attribute observer below, so a write that did not take would
        // re-trigger it forever.
        const anchor = () => {
            if (logo._kefinAnchored || getComputedStyle(logo).position !== 'static') return;
            logo._kefinAnchored = true;
            ANCHOR_PROPS.forEach(([prop, value]) => logo.style.setProperty(prop, value));
        };
        anchor();
        sizeHitbox(logo, hit);

        // .detailLogo ships in the page's static template, but Jellyfin only
        // removes .hide and sets the background-image once the lazy image
        // resolves - well after the view event. Sizing the hitbox at bind time
        // therefore measures a 0x0 box. Watch for that late update and re-measure.
        if (logoAttrObserver) logoAttrObserver.disconnect();
        logoAttrObserver = new MutationObserver(() => {
            const h = logo.querySelector('a.' + HIT_CLASS);
            anchor();
            if (h) sizeHitbox(logo, h);
        });
        logoAttrObserver.observe(logo, { attributes: true, attributeFilter: ['class', 'style'] });
        if (logoAttrStop) clearTimeout(logoAttrStop);
        logoAttrStop = setTimeout(() => {
            if (logoAttrObserver) { logoAttrObserver.disconnect(); logoAttrObserver = null; }
        }, POLL_TIMEOUT_MS);

        return true;
    }

    let logoAttrObserver = null;
    let logoAttrStop     = null;

    // Inline styles that make a static logo a containing block without moving it.
    const ANCHOR_PROPS = [['position', 'relative'], ['top', 'auto'], ['left', 'auto'], ['right', 'auto'], ['bottom', 'auto']];

    // Stacking-proof click fallback.
    //
    // .detailLogo's own sibling .detailPageWrapperContainer (position:relative,
    // min-height:60vh, later in the DOM) paints over it, and skins can add more
    // layers - so a listener on the logo may never see the click at all. A
    // CAPTURE listener on the document sees every click before any of that, so we
    // hit-test the painted rect ourselves and navigate. Independent of z-index,
    // pointer-events, and whatever is layered on top.
    document.addEventListener('click', (e) => {
        const logo = boundLogo;
        if (!logo || !logo.isConnected) return;
        const id = logo._kefinLogoTargetId;
        if (!id) return;

        // Never hijack a real control that happens to overlap the logo.
        const onControl = e.target && e.target.closest
            && e.target.closest('a,button,input,select,textarea,[data-action]');
        if (onControl && !e.target.closest('a.' + HIT_CLASS)) return;

        // Prefer the measured hitbox, but fall back to the logo box itself: if the
        // lazy image had not loaded when we measured, the hitbox is still 0x0 and
        // testing against it would reject every click.
        const hit = logo.querySelector('a.' + HIT_CLASS);
        let rect  = hit ? hit.getBoundingClientRect() : null;
        if (!rect || !rect.width || !rect.height) rect = logo.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        if (e.clientX < rect.left || e.clientX > rect.right
            || e.clientY < rect.top || e.clientY > rect.bottom) return;

        e.preventDefault();
        e.stopPropagation();
        navigateToItem(id);
    }, true);

    // Cursor + hover affordance, hit-tested against the same rect the click
    // handler uses. rAF-throttled, so a mousemove storm costs one test per frame.
    let hoverRaf = null;
    document.addEventListener('mousemove', (e) => {
        if (hoverRaf) return;
        hoverRaf = requestAnimationFrame(() => {
            hoverRaf = null;
            const logo = boundLogo;
            let over = false;
            if (logo && logo.isConnected && logo._kefinLogoTargetId) {
                const hit = logo.querySelector('a.' + HIT_CLASS);
                let rect  = hit ? hit.getBoundingClientRect() : null;
                if (!rect || !rect.width || !rect.height) rect = logo.getBoundingClientRect();
                over = rect.width > 0 && rect.height > 0
                    && e.clientX >= rect.left && e.clientX <= rect.right
                    && e.clientY >= rect.top  && e.clientY <= rect.bottom;
            }
            document.documentElement.classList.toggle(HOVER_CLASS, over);
        });
    }, { passive: true });

    // Run KefinTweaksEpisodeSeasonTitleDebug() in the console on a season or
    // episode page to see what the script found and, crucially, which element
    // actually sits on top of the logo (elementAtLogoCentre) - that is what
    // intercepts the click.
    window.KefinTweaksEpisodeSeasonTitleDebug = function () {
        const page = document.querySelector('.itemDetailPage:not(.hide)')
            || document.querySelector('.libraryPage:not(.hide)');
        const logo = page && page.querySelector('.detailLogo');
        const hit  = logo && logo.querySelector('a.' + HIT_CLASS);
        const rect = hit ? hit.getBoundingClientRect() : (logo ? logo.getBoundingClientRect() : null);
        const mid  = (rect && rect.width && rect.height)
            ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
            : null;
        const cs = logo ? getComputedStyle(logo) : null;
        const info = {
            pageFound: !!page,
            logoFound: !!logo,
            logoHidden: logo ? logo.classList.contains('hide') : null,
            logoRect: logo ? JSON.stringify(logo.getBoundingClientRect()) : null,
            logoStyle: cs ? {
                display: cs.display, position: cs.position, zIndex: cs.zIndex,
                pointerEvents: cs.pointerEvents, backgroundSize: cs.backgroundSize,
                backgroundPosition: cs.backgroundPosition,
                backgroundImage: (cs.backgroundImage || '').slice(0, 70)
            } : null,
            hitFound: !!hit,
            hitRect: rect ? JSON.stringify(rect) : null,
            targetId: logo ? logo._kefinLogoTargetId : null,
            boundLogoSet: !!boundLogo,
            episodeSlot: page ? {
                slot: page.classList.contains(SLOT_CLASS),
                placed: page.classList.contains(PLACED_CLASS),
                top: page.style.getPropertyValue(SLOT_TOP_VAR) || null
            } : null,
            elementAtLogoCentre: mid ? (mid.tagName + ' | ' + String(mid.className).slice(0, 70)) : null
        };
        console.log('[KefinTweaks EpisodeSeasonTitle] debug', info);
        return info;
    };

    // Currently bound logo, for resize repositioning.
    let boundLogo   = null;
    let resizeTimer = null;
    window.addEventListener('resize', () => {
        if (!boundLogo || !boundLogo.isConnected) return;
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            resizeTimer = null;
            const hit = boundLogo && boundLogo.querySelector('a.' + HIT_CLASS);
            if (hit) sizeHitbox(boundLogo, hit);
        }, 150);
    }, { passive: true });

    // Detail pages are reused across navigations, so always clear the binding for
    // the incoming view before deciding whether to set it again.
    function clearLogoLink(page) {
        if (!page) return;
        bindLogoLink(page, null);
    }

    // Containers mount asynchronously; wait for one, bounded.
    function whenPresent(page, selector, onFound, startedAt) {
        startedAt = startedAt || Date.now();
        const el = page.querySelector(selector);
        if (el) { onFound(el); return; }
        if (Date.now() - startedAt >= POLL_TIMEOUT_MS) return;   // never appeared
        setTimeout(() => whenPresent(page, selector, onFound, startedAt), POLL_INTERVAL_MS);
    }

    // The visible detail page Jellyfin has rendered this item into, identified by
    // the played button its reloadFromItem() hands the item to (data-id). Our item
    // fetch and Jellyfin's are separate, so ours can land before the page is shown
    // - and, coming from another item page, while the outgoing page is still the
    // visible one. Waits for the match, bounded; on timeout it falls back to the
    // visible page, which is what this code did before.
    function pageFor(item) {
        const visible = () => document.querySelector('.itemDetailPage:not(.hide)')
            || document.querySelector('.libraryPage:not(.hide)');
        const startedAt = Date.now();
        return new Promise(resolve => {
            const look = () => {
                const page = visible();
                if (page && page.querySelector('.btnPlaystate[data-id="' + item.Id + '"]')) {
                    resolve(page);
                } else if (Date.now() - startedAt >= POLL_TIMEOUT_MS) {
                    resolve(visible());
                } else {
                    setTimeout(look, POLL_INTERVAL_MS);
                }
            };
            look();
        });
    }

    // --------------------------------------------------
    //  INITIALIZATION
    // --------------------------------------------------

    // The page and item the handler last set up, to skip repeat notifications.
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
                try {
                    item = await itemPromise;
                } catch (e) {
                    return;
                }
                // A slow fetch can resolve after the next page's handler has
                // started; tearing down here would remove that page's guard.
                // Judged by the URL, which names the item this call is for.
                const current = () => window.location.hash.includes(item.Id);
                if (!item || !item.Id || !current()) return;

                // The page is looked up only now, not before the await, and is
                // the one Jellyfin has rendered THIS item into. Going from one item
                // page to another (season -> episode), this handler is called from
                // the History API as the URL changes - before jellyfin-web has
                // swapped the views - so the visible page at that moment is the
                // OUTGOING one. Checking that page made the handler give up, and
                // the second notification, from the view show, was suppressed
                // (this used triggerOnSameHash: false) because the hash had not
                // changed since. Result: nothing applied when arriving from the
                // season page, while a refresh of the same episode worked.
                const page = await pageFor(item);
                if (!page || !current()) return;

                // Registered with triggerOnSameHash: true, so one navigation can
                // call this two or three times (History API, then view show). With
                // false, utils drops every call whose URL equals the last one it
                // reported - and when this script loads after Jellyfin has already
                // reported the page, that drops the immediate call on registration
                // AND the view show, so a refresh sometimes did nothing at all. A
                // repeat for the same navigation (previousHash === hash) is skipped
                // once this page is set up for this item; a later return to the
                // same item (episode -> Home -> episode) still re-applies, since
                // Jellyfin re-renders the header then.
                if (previousHash === hash && applied.page === page && applied.itemId === item.Id) return;
                applied = { page, itemId: item.Id };

                // Tear down the previous page's logo binding and slot.
                clearLogoLink(page);
                clearEpisodeLogoSlot(page);
                stopCollectionLogo();

                // ---- Virtual special's page: logo navigates up to its series ----
                if (item.Type === 'BoxSet') {
                    const pipelineMade = !!(item.ProviderIds && item.ProviderIds.AnimePipelineSeries);
                    if (!tweakOn('collectionLogoToSeries') || !pipelineMade) return;
                    const data = await seriesSpecialsData();
                    const seriesId = data ? await data.seriesOfVirtualSpecial(item) : null;
                    if (!seriesId || !current() || page.classList.contains('hide')) return;
                    whenPresent(page, '.detailLogo', () => bindLogoLink(page, seriesId, 'Go to series'));
                    return;
                }

                // ---- Season page: logo navigates up to the series ----
                if (item.Type === 'Season') {
                    if (tweakOn('seasonLogoToSeries') && item.SeriesId) {
                        whenPresent(page, '.detailLogo', () => bindLogoLink(page, item.SeriesId, 'Go to series'));
                    }
                    return;
                }

                if (item.Type !== 'Episode' || !item.SeasonId) return;

                // ---- Special in one virtual special: that collection's logo ----
                // Same rule as Episode Title's heading, so the two agree: exactly
                // one virtual special, or the episode is treated as any other.
                const wantSpecial = item.ParentIndexNumber === 0 && tweakOn('specialLogoFromCollection');
                const data = wantSpecial ? await seriesSpecialsData() : null;
                const special = (data && data.isSpecialEpisode(item)) ? await data.virtualSpecialOf(item) : null;
                if (!current() || page.classList.contains('hide')) return;

                const elegantfinSlot = tweakOn('elegantfinEpisodeLogo');
                if (special) {
                    const shown = showCollectionLogo(page, special);
                    whenPresent(page, '.detailLogo', () => bindLogoLink(page, special.Id, 'Go to collection'));
                    if (elegantfinSlot && (shown || hasHeaderLogo(item))) markEpisodeLogoSlot(page);
                    return;
                }

                // ---- Episode page: logo navigates to the season ----
                if (tweakOn('episodeLogoToSeason')) {
                    whenPresent(page, '.detailLogo', () => bindLogoLink(page, item.SeasonId, 'Go to season'));
                }
                if (elegantfinSlot && hasHeaderLogo(item)) markEpisodeLogoSlot(page);
            },
            {
                pages: ['details'],
                triggerOnSameHash: true
            }
        );

        LOG('Episode/season header hook initialized');
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
        injectStyles();
        initializeHook();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => initialize());
    } else {
        initialize();
    }

    LOG('Script loaded');
})();
