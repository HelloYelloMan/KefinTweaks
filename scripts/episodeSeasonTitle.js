// KefinTweaks Episode / Season Header
// Two related fixes to the season <-> series relationship in detail page headers:
//
//   1. EPISODE pages show the SEASON's title (Original Title by default) where
//      Jellyfin shows the series name. That title keeps Jellyfin's own link to
//      the series; the header logo (.detailLogo) goes to the season.
//   2. SEASON pages get a clickable header logo that navigates up to the series.
//
// Why: Jellyfin's episode header is built from the series only - renderName()
// pushes a single link for item.SeriesName and never consults the season. That is
// fine for western TV, where seasons are just "Season 1", but for anime (and any
// show whose seasons are distinctly titled or separately branded) the season
// carries the title and artwork people actually recognise.
//
// Why JS (not CSS): the season's title is simply absent from an episode page, so
// it has to be fetched (/Items/{SeasonId}) and written in.
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
// Configuration is the CONFIG block below (internal, not exposed in the
// KefinTweaks configuration UI).

(function () {
    'use strict';

    const LOG  = (...args) => console.log('[KefinTweaks EpisodeSeasonTitle]', ...args);
    const WARN = (...args) => console.warn('[KefinTweaks EpisodeSeasonTitle]', ...args);

    // ==========================================
    //              CONFIGURATION
    // ==========================================
    const CONFIG = {
        // Which field of the SEASON to display in place of the series title.
        //   'OriginalTitle' - the season's Original Title (default)
        //   'Name'          - the season's regular title (e.g. "Season 2")
        USE_SEASON_FIELD: 'OriginalTitle',

        // When the chosen field is empty on that season, leave Jellyfin's series
        // title alone instead of falling back to the other field. A bare
        // "Season 2" in place of the show's name is usually a downgrade, so this
        // defaults to true. Set false to always show the season, empty-or-not.
        KEEP_SERIES_WHEN_EMPTY: true,

        // On EPISODE pages, make the header logo (.detailLogo) navigate to the
        // season - whether it is showing the season's own logo or the series logo
        // Jellyfin falls back to.
        EPISODE_LOGO_LINKS_TO_SEASON: true,

        // On SEASON pages, make the header logo (.detailLogo) navigate to the
        // series - whether it is showing the season's own logo or the series logo
        // Jellyfin falls back to.
        SEASON_LOGO_LINKS_TO_SERIES: true,
    };

    // Mark the anchor we rewrote and store what was there before, so a repeat
    // pass is idempotent and the original is always recoverable.
    const ORIGINAL_ATTR = 'data-kefin-series-title';

    const LINK_CLASS  = 'kefin-logo-link';
    const HIT_CLASS   = 'kefin-logo-hit';
    const HOVER_CLASS = 'kefin-logo-hovering';
    const STYLE_ID    = 'kefin-episode-season-title-style';

    // Set on the page by the EPISODE LOGO SLOT code below; only
    // skins/elegant-kefin.css has rules for them.
    const SLOT_CLASS   = 'kefin-episode-logo';
    const PLACED_CLASS = 'kefin-episode-logo-placed';
    const SLOT_TOP_VAR = '--kefin-episode-logo-top';

    // Headers re-render asynchronously (React) and can replace their contents
    // after our write, so we watch, re-apply, then stop.
    const POLL_INTERVAL_MS = 150;
    const POLL_TIMEOUT_MS  = 5000;
    const SETTLE_MS        = 250;

    const seasonCache = new Map();   // seasonId -> season item (or null when unavailable)

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

    // The title to show, or null to leave the series title as Jellyfin rendered it.
    function resolveTitle(season) {
        if (!season) return null;

        const primary = (season[CONFIG.USE_SEASON_FIELD] || '').trim();
        if (primary) return primary;

        if (CONFIG.KEEP_SERIES_WHEN_EMPTY) return null;

        const other = CONFIG.USE_SEASON_FIELD === 'OriginalTitle' ? 'Name' : 'OriginalTitle';
        return (season[other] || '').trim() || null;
    }

    // Whether Jellyfin will put a logo in .detailLogo for this item - the same
    // two sources its renderLogo() reads.
    function hasHeaderLogo(item) {
        return !!((item.ImageTags && item.ImageTags.Logo) || item.ParentLogoImageTag);
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
    //  EPISODE PAGE: SEASON TITLE ON THE SERIES LINK
    // --------------------------------------------------

    // The series link inside .parentName. Episodes get exactly one link there, but
    // match on the series name first so we never rewrite the wrong one if a skin or
    // a future Jellyfin version adds more. Once we have replaced the text, the
    // stored original is what identifies it.
    function findSeriesLink(page, item) {
        const parentName = page.querySelector('.nameContainer .parentName');
        if (!parentName) return null;

        const links = parentName.querySelectorAll('a');
        if (!links.length) return null;

        if (item.SeriesName) {
            for (const link of links) {
                const text = link.getAttribute(ORIGINAL_ATTR) || link.textContent;
                if ((text || '').trim() === item.SeriesName.trim()) return link;
            }
        }
        return links[0];
    }

    function applyTitle(page, item, title) {
        const link = findSeriesLink(page, item);
        if (!link) return false;

        if (!link.hasAttribute(ORIGINAL_ATTR)) {
            link.setAttribute(ORIGINAL_ATTR, link.textContent || '');
        }
        if (link.textContent !== title) link.textContent = title;
        // A re-render can move the heading the logo is laid over.
        placeEpisodeLogo(page);
        return true;
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

    // Re-apply with the observer paused, so our own write doesn't re-trigger it.
    function reapply(page, container, apply) {
        if (activeObserver) activeObserver.disconnect();
        apply();
        if (activeObserver && container.isConnected) {
            activeObserver.observe(container, { childList: true, subtree: true });
        }
    }

    function observeContainer(page, container, apply) {
        stopObserving();
        activeObserver = new MutationObserver(() => {
            if (settleTimer) clearTimeout(settleTimer);
            settleTimer = setTimeout(() => reapply(page, container, apply), SETTLE_MS);
        });
        activeObserver.observe(container, { childList: true, subtree: true });
        reapply(page, container, apply);                    // initial attempt
        hardStopTimer = setTimeout(stopObserving, POLL_TIMEOUT_MS);
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

    function initializeHook() {
        if (!window.KefinTweaksUtils || !window.KefinTweaksUtils.onViewPage) {
            WARN('KefinTweaksUtils.onViewPage not available, retrying in 1 second');
            setTimeout(initializeHook, 1000);
            return;
        }

        window.KefinTweaksUtils.onViewPage(
            async (view, element, hash, itemPromise) => {
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
                // the second notification, from the view show, is suppressed
                // (triggerOnSameHash: false) because the hash has not changed
                // since. Result: nothing applied when arriving from the season
                // page, while a refresh of the same episode worked.
                const page = await pageFor(item);
                if (!page || !current()) return;

                // Tear down the previous page's observer, logo binding and slot.
                stopObserving();
                clearLogoLink(page);
                clearEpisodeLogoSlot(page);

                // ---- Season page: logo navigates up to the series ----
                if (item.Type === 'Season') {
                    if (CONFIG.SEASON_LOGO_LINKS_TO_SERIES && item.SeriesId) {
                        whenPresent(page, '.detailLogo', () => bindLogoLink(page, item.SeriesId, 'Go to series'));
                    }
                    return;
                }

                if (item.Type !== 'Episode' || !item.SeasonId) return;

                // ---- Episode page: logo navigates to the season ----
                if (CONFIG.EPISODE_LOGO_LINKS_TO_SEASON) {
                    whenPresent(page, '.detailLogo', () => bindLogoLink(page, item.SeasonId, 'Go to season'));
                }
                if (hasHeaderLogo(item)) markEpisodeLogoSlot(page);

                // ---- Episode page: season title on the parent link ----
                const season = await getSeason(item.SeasonId);
                if (page.classList.contains('hide') || !current()) return;
                const title = resolveTitle(season);
                if (!title) return;

                whenPresent(page, '.nameContainer', (container) => {
                    observeContainer(page, container, () => applyTitle(page, item, title));
                });
            },
            {
                pages: ['details'],
                triggerOnSameHash: false
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
