// KefinTweaks Episode / Season Header
// Two related fixes to the season <-> series relationship in detail page headers:
//
//   1. EPISODE pages show the SEASON's title (Original Title by default) where
//      Jellyfin shows the series name, and clicking it goes to the season. When
//      the season has its own Logo image, that logo is shown instead of the text.
//   2. SEASON pages get a clickable header logo that navigates up to the series.
//
// Why: Jellyfin's episode header is built from the series only - renderName()
// pushes a single link for item.SeriesName and never consults the season. That is
// fine for western TV, where seasons are just "Season 1", but for anime (and any
// show whose seasons are distinctly titled or separately branded) the season
// carries the title and artwork people actually recognise.
//
// Why JS (not CSS): none of this is in the DOM to reveal. The season's title and
// logo are simply absent from an episode page, so they have to be fetched
// (/Items/{SeasonId}) and written in.
//
// Navigation notes - both matter, and neither is obvious:
//   * The episode header's parent link is rendered with a literal href="#"; the
//     real destination lives in data-action="link" + data-id, read by Jellyfin's
//     DELEGATED itemAction handler (it walks up from the event target via
//     parentWithAttribute). Rewriting href alone does nothing. So we bind a click
//     handler on the anchor - which runs before the ancestor's delegated handler -
//     and stopPropagation() keeps that handler from overriding us. data-id/
//     data-type are updated too, matching the season links Jellyfin builds itself,
//     so keyboard activation lands in the right place.
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
//
// Navigation itself uses the same form as KefinTweaks' breadcrumbs.
//
// SKIN INTERACTIONS (ElegantFin) - all three cost real debugging time:
//   * It clamps .parentName's <a> and <bdi> with display:-webkit-box !important +
//     -webkit-line-clamp:3 + overflow:hidden. -webkit-box is legacy flexbox, so
//     the <a> becomes a FLEX ITEM: shrink-wrapped and pinned to the start of a box
//     whose width is set by the longest sibling (the episode title). Long title =
//     wide box = logo visibly stuck to the left. text-align cannot move a flex
//     item, so the fix is forcing the elements back to display:block.
//   * !important does NOT beat !important - specificity does. ElegantFin's
//     selector is (0,2,2); a bare .kefin-logo-host is (0,1,0) and loses even with
//     !important. Every override below is written specific enough to win.
//   * .emby-button:active applies brightness+scale, which the logo inherits by
//     virtue of the class Jellyfin puts on that anchor.
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

        // Point the retargeted episode-page link at the season's detail page. Set
        // false to keep it navigating to the series, as Jellyfin does by default.
        LINK_TO_SEASON: true,

        // On episode pages, show the season's own Logo image in place of the
        // season title text when that season has one set. Only a logo set on the
        // SEASON counts - the series logo is never used here, since that would
        // put the series' branding back where we just removed its name. Seasons
        // without their own logo keep the text title.
        USE_SEASON_LOGO: true,

        // Size caps. Viewport units, NOT em: skins set wildly different heading
        // sizes (ElegantFin puts font-size:4em on .parentName), so an em cap
        // means something different on every skin.
        SEASON_LOGO_MAX_HEIGHT: '20vh',
        SEASON_LOGO_MAX_WIDTH:  '38vw',

        // Horizontal alignment of the logo within the heading.
        //   'center'  - centred (default; matches skins that centre the header)
        //   'left' / 'right' - pinned to that edge
        //   'inherit' - follow the heading's text-align, as plain text would
        //
        // Why this needs saying at all: .nameContainer shrink-to-fits around its
        // WIDEST child, which is the episode title. Both headings then stretch to
        // that width, so the title fills its box while the narrower logo sits at
        // the box's left edge. With a short title the box is narrow and the logo
        // looks centred; with a long one it drifts left. Explicit alignment makes
        // it independent of the title's length.
        SEASON_LOGO_ALIGN: 'center',

        // Margin around the logo (CSS shorthand). Overlapping the thumbnail was
        // tried and abandoned - ElegantFin clips .parentName's descendants, so the
        // bleed never rendered cleanly. Negative values still overlap on skins
        // that don't clip.
        SEASON_LOGO_MARGIN_TOP:    '0',
        SEASON_LOGO_MARGIN_BOTTOM: '0',

        // On SEASON pages, make the header logo (.detailLogo) navigate to the
        // series - whether it is showing the season's own logo or the series logo
        // Jellyfin falls back to.
        SEASON_LOGO_LINKS_TO_SERIES: true,
    };

    // Mark the anchor we rewrote and store what was there before, so a repeat
    // pass is idempotent and the original is always recoverable.
    const ORIGINAL_ATTR      = 'data-kefin-series-title';
    const ORIGINAL_HREF_ATTR = 'data-kefin-series-href';
    const ORIGINAL_ID_ATTR   = 'data-kefin-series-dataid';
    const ORIGINAL_TYPE_ATTR = 'data-kefin-series-datatype';

    const LOGO_CLASS = 'kefin-season-logo';
    const LINK_CLASS = 'kefin-logo-link';
    const HIT_CLASS  = 'kefin-logo-hit';
    const HOST_CLASS  = 'kefin-logo-host';
    const HOVER_CLASS = 'kefin-logo-hovering';
    const STYLE_ID   = 'kefin-episode-season-title-style';

    // Headers re-render asynchronously (React) and can replace their contents
    // after our write, so we watch, re-apply, then stop.
    const POLL_INTERVAL_MS = 150;
    const POLL_TIMEOUT_MS  = 5000;
    const SETTLE_MS        = 250;

    const seasonCache = new Map();   // seasonId -> season item (or null when unavailable)

    // --------------------------------------------------
    //  STYLES
    // --------------------------------------------------

    // Auto margins centre/pin a BLOCK image inside its containing block, which
    // works regardless of the heading's text-align - the alignment there is
    // emergent from the flex layout, not something text-align controls.
    // Alignment must land on the <h1>: it is the only element in the chain wider
    // than the logo. ElegantFin leaves the <bdi> and <a> as shrink-to-fit
    // inline-blocks, so margin:auto on the image has no free space to distribute
    // and text-align on anything below the h1 has nothing to align against.
    function hostAlignCss() {
        switch (CONFIG.SEASON_LOGO_ALIGN) {
            case 'left':    return 'text-align: left !important;';
            case 'right':   return 'text-align: right !important;';
            case 'inherit': return '';
            case 'center':
            default:        return 'text-align: center !important;';
        }
    }

    function logoAlignCss() {
        switch (CONFIG.SEASON_LOGO_ALIGN) {
            case 'left':  return 'display: block; margin-right: auto;';
            case 'right': return 'display: block; margin-left: auto;';
            case 'inherit': return 'display: inline-block; vertical-align: middle;';
            case 'center':
            default:      return 'display: block; margin-left: auto; margin-right: auto;';
        }
    }

    function injectStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            /* inline-block (not block) so the logo inherits whatever text
               alignment the skin gives the heading, instead of forcing left */
            .${LOGO_CLASS} {
                ${logoAlignCss()}
                max-height: ${CONFIG.SEASON_LOGO_MAX_HEIGHT};
                max-width: ${CONFIG.SEASON_LOGO_MAX_WIDTH};
                width: auto; height: auto;
                object-fit: contain;
                /* vertical only: horizontal margins carry the alignment above */
                margin-top: ${CONFIG.SEASON_LOGO_MARGIN_TOP};
                margin-bottom: ${CONFIG.SEASON_LOGO_MARGIN_BOTTOM};
            }

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

            /* ElegantFin clamps .parentName's <a> AND the <bdi> Jellyfin wraps it
               in to three text lines via display:-webkit-box + overflow:hidden.
               That crops the logo to a line box and clips away the negative-margin
               overlap. Undone only on elements we actually put a logo inside, so
               text titles keep their clamping. */
            /* block, NOT inline-block: these are block-level natively, and
               shrink-wrapping them to the image removes the free space that
               margin:auto needs to centre it. block still defeats ElegantFin's
               display:-webkit-box clamp, which is the only reason we touch
               display here at all. */
            .${HOST_CLASS} {
                display: block !important;
                /* fallback: if a skin still forces -webkit-box, centre the box's
                   contents the only way that layout understands */
                -webkit-box-pack: center;
                justify-content: center;
                overflow: visible !important;
                -webkit-line-clamp: unset !important;
                line-clamp: unset !important;
                -webkit-box-orient: unset !important;
                max-height: none !important;
            }
            h1.${HOST_CLASS} {
                display: block !important;
                ${hostAlignCss()}
            }

            /* SPECIFICITY, not !important, is what decides here. ElegantFin's
               rule is:
                   .nameContainer>h1.parentName a,
                   .nameContainer>h1.parentName bdi { display:-webkit-box !important }
               at (0,2,2). A bare .kefin-logo-host is (0,1,0), so even with
               !important it loses - between two !important declarations the more
               specific one wins. These selectors are (0,4,2) and actually apply.

               It matters because -webkit-box is legacy flexbox: it makes the <a>
               a FLEX ITEM, which shrink-wraps and pins to the start of the line.
               text-align cannot move a flex item, which is why centring the text
               did nothing. Forcing block restores normal flow, where the image's
               auto margins centre it. */
            /* The logo's anchor carries ElegantFin's .emby-button class, which adds
               a press effect:
                   .emby-button:active { filter:brightness(1.2)!important; transform:scale(.98) }
               That reads as a button being pushed, which is wrong for artwork.
               Same specificity trap as below - (0,2,0) with !important - so the
               override has to out-specify it rather than just repeat !important. */
            .nameContainer > h1.parentName.${HOST_CLASS} a.${HOST_CLASS}:active,
            .nameContainer > h1.parentName.${HOST_CLASS} a.${HOST_CLASS}:hover {
                filter: none !important;
                transform: none !important;
            }

            .nameContainer > h1.parentName.${HOST_CLASS} bdi.${HOST_CLASS},
            .nameContainer > h1.parentName.${HOST_CLASS} a.${HOST_CLASS} {
                display: block !important;
                width: auto !important;
                overflow: visible !important;
                -webkit-line-clamp: unset !important;
                line-clamp: unset !important;
                -webkit-box-orient: unset !important;
                max-height: none !important;
            }


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

    // A logo URL only when the SEASON itself has one. Built with Jellyfin's own
    // helper so it respects the server address, auth and image scaling.
    function seasonLogoUrl(season) {
        if (!CONFIG.USE_SEASON_LOGO) return null;
        const tag = season && season.ImageTags && season.ImageTags.Logo;
        if (!tag) return null;
        try {
            return ApiClient.getScaledImageUrl(season.Id, { type: 'Logo', tag: tag, maxHeight: 200 });
        } catch (err) {
            WARN('Could not build season logo URL', err);
            return null;
        }
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
    //  EPISODE PAGE: SEASON TITLE / LOGO ON THE PARENT LINK
    // --------------------------------------------------

    // The series link inside .parentName. Episodes get exactly one link there, but
    // match on the series name first so we never rewrite the wrong one if a skin or
    // a future Jellyfin version adds more. Once we have replaced the text (or
    // swapped in a logo), the stored original is what identifies it.
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

    function retargetLink(link, seasonId) {
        // Keep the latest season id on the node, so the (single) click handler
        // below stays correct across re-renders and item changes.
        link._kefinSeasonId = seasonId;

        // Bound to the anchor itself, so it runs before Jellyfin's delegated
        // itemAction handler; stopPropagation then keeps that handler from
        // navigating to the series.
        if (!link._kefinSeasonNav) {
            link._kefinSeasonNav = true;
            link.addEventListener('click', (e) => {
                const id = link._kefinSeasonId;
                if (!id) return;
                e.preventDefault();
                e.stopPropagation();
                navigateToItem(id);
            }, true);
        }

        // Also point the native path at the season, so keyboard activation and any
        // code path that bypasses the handler above still lands on the right page.
        if (link.getAttribute('data-action') === 'link' && link.hasAttribute('data-id')) {
            if (!link.hasAttribute(ORIGINAL_ID_ATTR)) {
                link.setAttribute(ORIGINAL_ID_ATTR, link.getAttribute('data-id') || '');
                link.setAttribute(ORIGINAL_TYPE_ATTR, link.getAttribute('data-type') || '');
            }
            if (link.getAttribute('data-id') !== seasonId)   link.setAttribute('data-id', seasonId);
            if (link.getAttribute('data-type') !== 'Season') link.setAttribute('data-type', 'Season');
            link.setAttribute('data-isfolder', 'true');
            return;
        }

        // Older builds put a real URL on the anchor - swap the id parameter of the
        // ORIGINAL href (never one we already rewrote, so repeat passes are
        // idempotent), which inherits the route shape and every other param.
        if (!link.hasAttribute(ORIGINAL_HREF_ATTR)) {
            link.setAttribute(ORIGINAL_HREF_ATTR, link.getAttribute('href') || '');
        }
        const original = link.getAttribute(ORIGINAL_HREF_ATTR);
        let href;
        if (original && /[?&]id=/.test(original)) {
            href = original.replace(/([?&]id=)[^&]*/, '$1' + encodeURIComponent(seasonId));
        } else {
            const serverId = (typeof ApiClient !== 'undefined' && ApiClient.serverId) ? ApiClient.serverId() : '';
            href = '#/details?id=' + encodeURIComponent(seasonId)
                + (serverId ? '&serverId=' + encodeURIComponent(serverId) : '');
        }
        if (link.getAttribute('href') !== href) link.setAttribute('href', href);
    }

    function applyTitle(page, item, title, logoUrl) {
        const link = findSeriesLink(page, item);
        if (!link) return false;

        if (!link.hasAttribute(ORIGINAL_ATTR)) {
            link.setAttribute(ORIGINAL_ATTR, link.textContent || '');
        }

        // The anchor, the <bdi> around it, and the <h1> each clip their overflow
        // under ElegantFin - all three must be opened up or the tightest one crops
        // the logo.
        const hosts = [link, link.parentElement, link.closest('.parentName')]
            .filter(el => el && el.nodeType === 1);

        if (logoUrl) {
            let img = link.querySelector('img.' + LOGO_CLASS);
            if (!img) {
                link.textContent = '';                       // drop the series text
                img = document.createElement('img');
                img.className = LOGO_CLASS;
                link.appendChild(img);
            }
            if (img.getAttribute('src') !== logoUrl) img.setAttribute('src', logoUrl);
            img.alt = title || '';
            hosts.forEach(el => el.classList.add(HOST_CLASS));
        } else {
            hosts.forEach(el => el.classList.remove(HOST_CLASS));
            if (link.textContent !== title) {
                // Also clears a logo left over from a previous item.
                link.textContent = title;
            }
        }

        if (CONFIG.LINK_TO_SEASON && item.SeasonId) {
            retargetLink(link, item.SeasonId);
        }
        return true;
    }

    // --------------------------------------------------
    //  SEASON PAGE: LOGO LINKS UP TO THE SERIES
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
    // recycled, so a stale id here would send a later page to the wrong series.
    function bindLogoLink(page, seriesId) {
        const logo = page.querySelector('.detailLogo');
        if (!logo) return false;

        logo._kefinLogoTargetId = seriesId || null;
        let hit = logo.querySelector('a.' + HIT_CLASS);

        if (!seriesId) {
            logo.classList.remove(LINK_CLASS);
            if (hit) hit.remove();
            boundLogo = null;
            document.documentElement.classList.remove(HOVER_CLASS);
            return true;
        }

        logo.classList.add(LINK_CLASS);
        if (!hit) {
            hit = document.createElement('a');
            hit.className = HIT_CLASS;
            hit.setAttribute('aria-label', 'Go to series');
            hit.addEventListener('click', (e) => {
                const id = logo._kefinLogoTargetId;
                if (!id) return;
                e.preventDefault();
                e.stopPropagation();
                navigateToItem(id);
            });
            logo.appendChild(hit);
        }
        hit.setAttribute('href', detailHref(seriesId));
        boundLogo = logo;
        sizeHitbox(logo, hit);

        // .detailLogo ships in the page's static template, but Jellyfin only
        // removes .hide and sets the background-image once the lazy image
        // resolves - well after the view event. Sizing the hitbox at bind time
        // therefore measures a 0x0 box. Watch for that late update and re-measure.
        if (logoAttrObserver) logoAttrObserver.disconnect();
        logoAttrObserver = new MutationObserver(() => {
            const h = logo.querySelector('a.' + HIT_CLASS);
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

    // Stacking-proof click fallback.
    //
    // .detailLogo's own sibling .detailPageWrapperContainer (position:relative,
    // min-height:60vh, later in the DOM) paints over it, and skins can add more
    // layers - so a listener on the logo may never see the click at all. A
    // CAPTURE listener on the document sees every click before any of that, so we
    // hit-test the painted rect ourselves and navigate. Independent of z-index,
    // pointer-events, and whatever is layered on top.
    document.addEventListener('click', (e) => {
        if (!CONFIG.SEASON_LOGO_LINKS_TO_SERIES) return;
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
            if (CONFIG.SEASON_LOGO_LINKS_TO_SERIES && logo && logo.isConnected && logo._kefinLogoTargetId) {
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

    // Run KefinTweaksEpisodeSeasonTitleDebug() in the console on a season page to
    // see what the script found and, crucially, which element actually sits on top
    // of the logo (elementAtLogoCentre) - that is what intercepts the click.
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

                const page = document.querySelector('.itemDetailPage:not(.hide)')
                    || document.querySelector('.libraryPage:not(.hide)');
                if (!page) return;

                let item;
                try {
                    item = await itemPromise;
                } catch (e) {
                    return;
                }

                // Tear down the previous page's observer and logo binding first.
                stopObserving();
                clearLogoLink(page);

                if (!item) return;

                // ---- Season page: logo navigates up to the series ----
                if (item.Type === 'Season') {
                    if (CONFIG.SEASON_LOGO_LINKS_TO_SERIES && item.SeriesId) {
                        whenPresent(page, '.detailLogo', () => bindLogoLink(page, item.SeriesId));
                    }
                    return;
                }

                // ---- Episode page: season title / logo on the parent link ----
                if (item.Type !== 'Episode' || !item.SeasonId) return;

                const season  = await getSeason(item.SeasonId);
                const title   = resolveTitle(season);
                const logoUrl = seasonLogoUrl(season);
                // Nothing to show: no usable season title AND no season logo.
                if (!title && !logoUrl) return;

                whenPresent(page, '.nameContainer', (container) => {
                    observeContainer(page, container, () => applyTitle(page, item, title, logoUrl));
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
