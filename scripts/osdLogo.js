// KefinTweaks OSD Logo
// Shows the media's logo (or ClearArt) on the video OSD while playback
// controls are visible, with optional transparency trimming and OSD shadows.
//
// Ported from the standalone "OSD Logo Injector v2.0".
// Configuration lives in window.KefinTweaksConfig.osdLogo and is editable
// from the KefinTweaks Configuration page (feature card -> Configure).
// Changes apply on the next page reload.

(function () {
    'use strict';

    const LOG = (...args) => console.log('[KefinTweaks OsdLogo]', ...args);

    // ==========================================
    //        CONFIGURATION (with defaults)
    // ==========================================
    // Every key can be overridden from KefinTweaksConfig.osdLogo.
    const CONFIG = Object.assign({
        USE_CLEARART: false,          // true = ClearArt, false = Standard Logo

        // Sizing limits - STANDARD LOGO
        LOGO_MAX_WIDTH:  '18vw',
        LOGO_MAX_HEIGHT: '13vh',

        // Sizing limits - CLEARART (usually needs to be taller)
        CLEARART_MAX_WIDTH:  '25vw',
        CLEARART_MAX_HEIGHT: '40vh',

        // Opacity (0.1 - 1.0)
        LOGO_OPACITY: 1.0,

        // Logo alignment (only for standard logo mode, not ClearArt)
        GAP_BELOW_BUTTONS: '10px',
        RIGHT_EDGE_OFFSET: '10px',

        // Features
        TRIM_TRANSPARENCY: true,      // Auto-crop transparent borders from the image
        ADD_OSD_SHADOW:    true,      // Drop shadows on OSD buttons/text for readability

        // Timing
        ITEM_ID_TIMEOUT_MS: 3000      // How long to wait for the item ID before giving up
    }, window.KefinTweaksConfig?.osdLogo || {});

    const {
        USE_CLEARART,
        LOGO_MAX_WIDTH, LOGO_MAX_HEIGHT,
        CLEARART_MAX_WIDTH, CLEARART_MAX_HEIGHT,
        LOGO_OPACITY,
        GAP_BELOW_BUTTONS, RIGHT_EDGE_OFFSET,
        TRIM_TRANSPARENCY, ADD_OSD_SHADOW,
        ITEM_ID_TIMEOUT_MS
    } = CONFIG;

    // State
    let headerObserver = null;
    let osdItemObserver = null;         // watches the active OSD page for item changes
    let osdItemObserverTarget = null;
    let osdItemThrottleId = null;
    let currentAbort  = null;
    let currentItemId = null;
    let trimCache     = new Map();      // sourceUrl -> blobUrl
    let blobUrls      = [];             // track for revocation

    // --------------------------------------------------
    //  INITIALIZATION
    // --------------------------------------------------

    function init() {
        if (ADD_OSD_SHADOW) injectShadowStyles();
        injectContainerStyles();
        waitForHeader();
    }

    function waitForHeader() {
        const header = document.querySelector('.skinHeader');
        if (header) {
            setupHeaderObserver(header);
            // Initial check in case OSD is already showing
            handleHeaderChange(header);
        } else {
            setTimeout(waitForHeader, 500);
        }
    }

    // --------------------------------------------------
    //  STYLES
    // --------------------------------------------------

    function injectShadowStyles() {
        const styleId = 'osd-ui-shadows';
        if (document.getElementById(styleId)) return;

        const style = document.createElement('style');
        style.id = styleId;
        /* Scoped to the playback OSD so shadows only apply during video playback.
         *
         * These selectors used to be built around a `.videoOsd` class and class
         * names like .videoOsd-text / .videoOsdDurationText. None of them exist
         * in jellyfin-web -- the only videoOsd* classes it ships are
         * .videoOsdBottom, .videoOsdBottom-maincontrols, .videoOsdBottom-hidden
         * and #videoOsdPage -- so every rule that depended on them matched
         * nothing and the shadows were never drawn. The bottom-controls block
         * was the exception and did work, because .videoOsdBottom is real.
         *
         * The header during playback is .skinHeader.osdHeader (the same class
         * handleHeaderChange and pauseScreen.js test for), and the text lives in
         * .videoOsdBottom as .osdTitle / .osdMediaInfo / .osdPositionText /
         * .osdDurationText, per the shipped markup:
         *
         *   <div class="videoOsdBottom videoOsdBottom-maincontrols">
         *     <div class="osdControls">
         *       <div class="osdTextContainer osdMainTextContainer">
         *         <h3 class="osdTitle"></h3>
         *
         * .pageTitle is included because the header title sits over the video as
         * well; it is the element Jellyfin's setTitle() writes the series and
         * episode name into.
         */
        style.textContent = `
            /* Drop Shadow for Top Header Icons - only inside the playback OSD */
            .skinHeader.osdHeader .paper-icon-button-light,
            .skinHeader.osdHeader .headerButton,
            .skinHeader.osdHeader .headerLeft,
            .videoOsd-appBar .MuiIconButton-root {
                filter: drop-shadow(0 1px 3px rgba(0,0,0,0.8));
            }

            /* Drop Shadow for Bottom OSD Controls */
            .videoOsdBottom .paper-icon-button-light,
            .videoOsdBottom .btnPlay,
            .videoOsdBottom .btnPause,
            .videoOsdBottom .slider-container {
                filter: drop-shadow(0 1px 3px rgba(0,0,0,0.8));
            }

            /* Text Shadows for Title and Time */
            .skinHeader.osdHeader .pageTitle,
            .videoOsd-appBar .MuiTypography-root,
            .videoOsdBottom .osdTitle,
            .videoOsdBottom .osdTitleSmall,
            .videoOsdBottom .osdMediaInfo,
            .videoOsdBottom .osdText,
            .videoOsdBottom .osdMainText,
            .videoOsdBottom .osdTimeText,
            .videoOsdBottom .osdPositionText,
            .videoOsdBottom .osdDurationText {
                text-shadow: 0 1px 3px rgba(0,0,0,0.9);
            }
        `;
        document.head.appendChild(style);
    }

    function injectContainerStyles() {
        const styleId = 'osd-logo-container-styles';
        if (document.getElementById(styleId)) return;

        const style = document.createElement('style');
        style.id = styleId;
        // Use classes instead of mutating inline styles on OSD containers
        style.textContent = `
            .osd-logo-container-clearart { overflow: visible !important; }
            .osd-logo-container-logo { overflow: visible !important; position: relative !important; }
        `;
        document.head.appendChild(style);
    }

    // --------------------------------------------------
    //  OBSERVERS
    // --------------------------------------------------

    function setupHeaderObserver(header) {
        if (headerObserver) headerObserver.disconnect();

        headerObserver = new MutationObserver(() => handleHeaderChange(header));
        headerObserver.observe(header, { attributes: true, attributeFilter: ['class'] });
    }

    // Watch the ACTIVE OSD page for item changes while playback is running.
    // Jellyfin reuses the OSD page across items (next episode, play-from-home
    // after a previous session), updating button data-id attributes and title
    // text in place - the header class never changes, so without this the logo
    // would keep showing the previously played item.
    function attachOsdItemObserver(osdPage) {
        if (osdItemObserverTarget === osdPage && osdItemObserver) return;
        detachOsdItemObserver();

        osdItemObserver = new MutationObserver(() => {
            if (osdItemThrottleId) return;
            osdItemThrottleId = setTimeout(() => {
                osdItemThrottleId = null;
                const header = document.querySelector('.skinHeader');
                if (header?.classList.contains('osdHeader')) {
                    handleHeaderChange(header);
                }
            }, 250);
        });
        // The item arrives as data-id on .btnUserRating (setItem). childList only
        // ever caught the ~0.7s position/duration text rewrites, each one running
        // the whole header check for the length of playback.
        osdItemObserver.observe(osdPage, {
            subtree: true,
            attributes: true,
            attributeFilter: ['data-id']
        });
        osdItemObserverTarget = osdPage;
    }

    function detachOsdItemObserver() {
        if (osdItemObserver) { osdItemObserver.disconnect(); osdItemObserver = null; }
        osdItemObserverTarget = null;
        if (osdItemThrottleId) { clearTimeout(osdItemThrottleId); osdItemThrottleId = null; }
    }

    function getActiveOsdPage() {
        return document.querySelector('#videoOsdPage:not(.hide)');
    }

    function handleHeaderChange(header) {
        const isOsdMode = header.classList.contains('osdHeader');

        if (isOsdMode) {
            const osdPage = getActiveOsdPage();
            if (osdPage) attachOsdItemObserver(osdPage);

            let targetContainer;

            if (USE_CLEARART) {
                targetContainer = osdPage && osdPage.querySelector('.videoOsdBottom');
                // Fallback: .videoOsd does not exist, and .skinHeader is not inside
                // the OSD page anyway, so closest() could never have found anything.
                if (!targetContainer) targetContainer = getActiveOsdPage();
            } else {
                // Jellyfin 12's modern layout draws its own OSD header (a MUI
                // toolbar, .videoOsd-appBar) and keeps the legacy .skinHeader
                // mounted but hidden -- a logo put there is never seen. The
                // legacy header still gets osdHeader toggled, so it stays the
                // thing to watch; only the logo goes into the visible bar.
                targetContainer = document.querySelector('.videoOsd-appBar')
                    || header.querySelector('.headerRight') || header;
            }

            if (targetContainer) ensureLogo(targetContainer);
        } else {
            detachOsdItemObserver();
            removeLogo();
        }
    }

    // --------------------------------------------------
    //  LOGO MANAGEMENT
    // --------------------------------------------------

    async function ensureLogo(container) {
        // Apply container class (instead of inline style mutation)
        const containerClass = USE_CLEARART ? 'osd-logo-container-clearart' : 'osd-logo-container-logo';
        if (!container.classList.contains(containerClass)) {
            container.classList.add(containerClass);
        }

        let logoImg = document.getElementById('forced-osd-logo');
        if (!logoImg) {
            logoImg = createLogoElement(container);
        } else if (!USE_CLEARART && !container.contains(logoImg)) {
            // The modern OSD header is remounted on every visit to the player.
            container.appendChild(logoImg);
        }

        const itemId = await getReliableItemId();
        if (!itemId) return;

        if (logoImg.getAttribute('data-loaded-id') !== itemId) {
            logoImg.style.opacity = '0';
            currentItemId = itemId;
            updateLogoSource(logoImg, itemId);
        }
    }

    function createLogoElement(container) {
        const logoImg = document.createElement('img');
        logoImg.id = 'forced-osd-logo';
        logoImg.alt = 'Logo';

        // --- POSITIONING ---
        if (USE_CLEARART) {
            Object.assign(logoImg.style, {
                position: 'absolute',
                bottom: '0px',
                right: '0px',
                top: 'auto',
                left: 'auto',
                margin: '0',
                objectPosition: 'bottom right',
                zIndex: '0',
            });
            // Prepend = behind OSD controls
            container.insertBefore(logoImg, container.firstChild);
        } else {
            Object.assign(logoImg.style, {
                position: 'absolute',
                top: '100%',
                marginTop: GAP_BELOW_BUTTONS,
                right: RIGHT_EDGE_OFFSET,
                bottom: 'auto',
                left: 'auto',
                objectPosition: 'top right',
                zIndex: '100',
            });
            container.appendChild(logoImg);
        }

        // --- SIZING ---
        Object.assign(logoImg.style, {
            width: 'auto',
            height: 'auto',
            maxWidth: USE_CLEARART ? CLEARART_MAX_WIDTH : LOGO_MAX_WIDTH,
            maxHeight: USE_CLEARART ? CLEARART_MAX_HEIGHT : LOGO_MAX_HEIGHT,
            objectFit: 'contain',
            pointerEvents: 'none',
            filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.8))',
            opacity: '0',
            transition: 'opacity 0.2s ease-in-out',
        });

        // Handle broken images
        logoImg.onerror = () => {
            logoImg.style.opacity = '0';
        };

        return logoImg;
    }

    function removeLogo() {
        const logo = document.getElementById('forced-osd-logo');
        if (logo) logo.remove();

        // Clean up container classes
        document.querySelectorAll('.osd-logo-container-clearart, .osd-logo-container-logo').forEach(el => {
            el.classList.remove('osd-logo-container-clearart', 'osd-logo-container-logo');
        });

        currentItemId = null;
    }

    // --------------------------------------------------
    //  LOGO SOURCE RESOLUTION
    // --------------------------------------------------

    async function updateLogoSource(img, itemId) {
        // Cancel any in-flight work
        if (currentAbort) currentAbort.abort();
        currentAbort = new AbortController();
        const signal = currentAbort.signal;

        try {
            img.setAttribute('data-loaded-id', itemId);

            const logoUrl = await getSmartLogoUrl(itemId, signal);

            // Check if we were cancelled while awaiting
            if (signal.aborted) return;

            if (!logoUrl) {
                img.style.opacity = '0';
                return;
            }

            let finalUrl = logoUrl;

            if (TRIM_TRANSPARENCY) {
                finalUrl = await trimTransparentPixels(logoUrl);
                if (signal.aborted) return;
            }

            img.onload = () => {
                if (signal.aborted) return;
                applyResponsiveSizing(img);
                img.style.opacity = String(LOGO_OPACITY);
            };

            img.src = finalUrl;
        } catch (err) {
            if (err.name !== 'AbortError') {
                console.error('[KefinTweaks OsdLogo] fetch error:', err);
                img.style.opacity = '0';
            }
        }
    }

    // Blind-fetch approach: try URLs in priority order, return first that responds 200.
    // Priority: the item's own image (episode/movie) -> Season -> Series, most
    // specific first. Anything else the item hangs off (a library folder for a
    // movie) is only a last resort.
    async function getSmartLogoUrl(itemId, signal) {
        // First, get the item metadata to find SeasonId / SeriesId / ParentId
        const apiUrl = typeof ApiClient !== 'undefined'
            ? ApiClient.getUrl(`/Items/${itemId}`)
            : `${window.location.origin}/Items/${itemId}`;

        const token = getToken();
        if (!token) return null;

        const resp = await fetch(apiUrl, {
            headers: { 'Authorization': `MediaBrowser Token="${token}"`, 'Accept': 'application/json' },
            signal,
        });
        if (!resp.ok) return null;
        const item = await resp.json();

        const domain = typeof ApiClient !== 'undefined'
            ? ApiClient.serverAddress()
            : window.location.origin;

        const type = USE_CLEARART ? 'Art' : 'Logo';

        // Build the candidate list, most specific first, skipping duplicates
        // (an episode's ParentId is its SeasonId, a season's is its SeriesId).
        const urls = [];
        const seen = new Set();
        const addCandidate = (id, tag) => {
            if (!id || seen.has(id)) return;
            seen.add(id);
            urls.push(`${domain}/Items/${id}/Images/${type}?ApiKey=${token}`
                + (tag ? `&tag=${tag}` : ''));
        };

        // ImageTags is authoritative for the item itself, so only probe when
        // the image actually exists - most episodes carry no logo of their own.
        if (item.ImageTags?.[type]) {
            addCandidate(item.Id || itemId, item.ImageTags[type]);
            return urls[0];               // tagged = exists; no probe
        }
        // The server walks season -> series itself: ParentLogoItemId is the NEAREST
        // one with a logo (this list's order), and its absence on an episode means
        // neither has one. Tagged, the URL is also cached for a year. The server
        // never fills ParentArt*, so ClearArt mode still probes below.
        if (type === 'Logo' && item.SeriesId) {
            addCandidate(item.ParentLogoItemId, item.ParentLogoImageTag);
            return urls[0] || null;
        }
        addCandidate(item.SeasonId);
        addCandidate(item.SeriesId);
        addCandidate(item.ParentId);

        // Probe each URL with a HEAD request
        for (const url of urls) {
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
            try {
                const probe = await fetch(url, { method: 'HEAD', signal });
                if (probe.ok) return url;
            } catch (err) {
                if (err.name === 'AbortError') throw err;
                // URL doesn't exist, try next
            }
        }

        return null;
    }

    // Prefer ApiClient (tracks the actively connected server); fall back to
    // localStorage Servers[0] only if ApiClient isn't available yet.
    function getToken() {
        try {
            if (typeof ApiClient !== 'undefined') {
                const token = ApiClient.accessToken?.();
                if (token) return token;
            }
        } catch {
            // fall through to localStorage
        }

        const raw = localStorage.getItem('jellyfin_credentials');
        if (!raw) return null;
        try {
            const parsed = JSON.parse(raw);
            return parsed.Servers?.[0]?.AccessToken || null;
        } catch {
            return null;
        }
    }

    // --------------------------------------------------
    //  ITEM ID RESOLUTION (with timeout)
    //
    //  Reads the item id from the ACTIVE video OSD page only. Jellyfin keeps
    //  old, hidden OSD pages cached in the DOM and the URL hash during
    //  playback is just #/video, so neither the hash nor an unscoped
    //  [data-id] query is reliable - both can return the item from a PREVIOUS
    //  playback session (stale logo after switching items).
    // --------------------------------------------------

    function readOsdItemId() {
        const osdPage = getActiveOsdPage();
        if (!osdPage) return null;
        const btn = osdPage.querySelector('.btnUserRating[data-id], button[data-id]');
        return btn ? btn.getAttribute('data-id') : null;
    }

    function getReliableItemId() {
        return new Promise((resolve) => {
            const immediate = readOsdItemId();
            if (immediate) {
                resolve(immediate);
                return;
            }

            // Poll DOM with timeout
            let attempts = 0;
            const maxAttempts = Math.ceil(ITEM_ID_TIMEOUT_MS / 16); // ~60fps

            const checkDOM = () => {
                const itemId = readOsdItemId();
                if (itemId) {
                    resolve(itemId);
                    return;
                }

                attempts++;
                if (attempts >= maxAttempts) {
                    console.warn('[KefinTweaks OsdLogo] Could not find item ID within timeout');
                    resolve(null);
                    return;
                }

                requestAnimationFrame(checkDOM);
            };

            checkDOM();
        });
    }

    // --------------------------------------------------
    //  CANVAS AUTO-CROPPER (optimized)
    // --------------------------------------------------

    function trimTransparentPixels(imageUrl) {
        // Return cached result if available
        if (trimCache.has(imageUrl)) {
            return Promise.resolve(trimCache.get(imageUrl));
        }

        return new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = 'Anonymous';
            img.src = imageUrl;

            img.onload = () => {
                const w = img.width;
                const h = img.height;

                if (w < 4 || h < 4) {
                    resolve(imageUrl);
                    return;
                }

                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                canvas.width = w;
                canvas.height = h;
                ctx.drawImage(img, 0, 0);

                try {
                    const imageData = ctx.getImageData(0, 0, w, h);
                    const data = imageData.data;
                    let minX = w, minY = h, maxX = 0, maxY = 0;
                    let found = false;

                    // Scan every pixel for accurate bounds
                    for (let y = 0; y < h; y++) {
                        for (let x = 0; x < w; x++) {
                            const alpha = data[(y * w + x) * 4 + 3];
                            if (alpha > 0) {
                                if (x < minX) minX = x;
                                if (x > maxX) maxX = x;
                                if (y < minY) minY = y;
                                if (y > maxY) maxY = y;
                                found = true;
                            }
                        }
                    }

                    if (!found) {
                        resolve(imageUrl);
                        return;
                    }

                    const cropW = maxX - minX + 1;
                    const cropH = maxY - minY + 1;
                    canvas.width = cropW;
                    canvas.height = cropH;
                    ctx.drawImage(img, minX, minY, cropW, cropH, 0, 0, cropW, cropH);

                    // Use blob URL instead of data URL for better performance
                    canvas.toBlob((blob) => {
                        if (blob) {
                            const blobUrl = URL.createObjectURL(blob);
                            trimCache.set(imageUrl, blobUrl);
                            blobUrls.push(blobUrl);
                            resolve(blobUrl);
                        } else {
                            resolve(imageUrl);
                        }
                    }, 'image/png');
                } catch (e) {
                    // Canvas tainted or other error
                    resolve(imageUrl);
                }
            };

            img.onerror = () => resolve(imageUrl);
        });
    }

    // --------------------------------------------------
    //  RESPONSIVE SIZING
    // --------------------------------------------------

    function applyResponsiveSizing(img) {
        if (USE_CLEARART) {
            img.style.maxHeight = CLEARART_MAX_HEIGHT;
            img.style.maxWidth  = CLEARART_MAX_WIDTH;
        } else {
            img.style.maxHeight = LOGO_MAX_HEIGHT;
            img.style.maxWidth  = LOGO_MAX_WIDTH;
        }

        // Mobile override for tall logos
        if (window.innerWidth < 1000) {
            const ratio = img.naturalWidth / img.naturalHeight;
            if (ratio < 2.0) {
                img.style.maxHeight = '20vh';
            }
        }
    }

    // Re-evaluate sizing on resize
    let resizeTimer = null;
    const onResize = () => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            resizeTimer = null;
            const logo = document.getElementById('forced-osd-logo');
            if (logo && logo.naturalWidth > 0) {
                applyResponsiveSizing(logo);
            }
        }, 200);
    };
    window.addEventListener('resize', onResize, { passive: true });

    // --------------------------------------------------
    //  CLEANUP
    // --------------------------------------------------

    function destroy() {
        if (headerObserver) { headerObserver.disconnect(); headerObserver = null; }
        detachOsdItemObserver();
        if (currentAbort)   { currentAbort.abort(); currentAbort = null; }
        if (resizeTimer)    { clearTimeout(resizeTimer); resizeTimer = null; }
        window.removeEventListener('resize', onResize);

        removeLogo();

        // Revoke all blob URLs
        blobUrls.forEach(url => URL.revokeObjectURL(url));
        blobUrls = [];
        trimCache.clear();

        // Remove injected styles
        ['osd-ui-shadows', 'osd-logo-container-styles'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.remove();
        });

        currentItemId = null;
        LOG('destroyed');
    }

    // ---- Feature configuration modal (the "Configure" button on the KefinTweaks
    // feature card). ModalSystem + KefinTweaksUtils.saveConfigToJavaScriptInjector.
    // Changes apply on next reload. ----
    (function registerConfigModal() {
        const MODAL_ID = 'kefin-osdlogo-config';

        function checkRow(key, checked, label, desc) {
            return '<div class="listItem" style="border:1px solid rgba(255,255,255,0.1);border-radius:4px;padding:0.75em;margin-bottom:1em;">'
                + '<div class="listItemContent">'
                + '<div class="listItemBodyText" style="margin-bottom:0.5em;">' + label + '</div>'
                + '<div class="listItemBodyText secondary" style="margin-bottom:0.75em;font-size:0.9em;">' + desc + '</div>'
                + '<label class="checkboxContainer" style="display:flex;align-items:center;gap:0.5em;">'
                + '<input type="checkbox" id="osdLogo_' + key + '"' + (checked ? ' checked' : '') + '>'
                + '<span class="listItemBodyText">Enabled</span></label>'
                + '</div></div>';
        }

        function inputRow(key, value, label, desc, type, min, max, step) {
            return '<div class="listItem" style="border:1px solid rgba(255,255,255,0.1);border-radius:4px;padding:0.75em;margin-bottom:1em;">'
                + '<div class="listItemContent">'
                + '<div class="listItemBodyText" style="margin-bottom:0.5em;">' + label + '</div>'
                + '<div class="listItemBodyText secondary" style="margin-bottom:0.75em;font-size:0.9em;">' + desc + '</div>'
                + '<input type="' + type + '" id="osdLogo_' + key + '" value="' + value + '"'
                + (min !== undefined ? ' min="' + min + '"' : '')
                + (max !== undefined ? ' max="' + max + '"' : '')
                + (step !== undefined ? ' step="' + step + '"' : '')
                + ' style="background:var(--theme-background);color:var(--theme-text-color);padding:.5em;border:1px solid rgba(255,255,255,0.2);border-radius:4px;width:100%;font-size:inherit;">'
                + '</div></div>';
        }

        function textRow(key, value, label, desc) { return inputRow(key, value, label, desc, 'text'); }
        function numberRow(key, value, label, desc, min, max, step) { return inputRow(key, value, label, desc, 'number', min, max, step); }

        function sectionHeader(title) {
            return '<div style="margin:1.5em 0 0.5em;font-weight:bold;font-size:1.1em;">' + title + '</div>';
        }

        function buildConfigHTML(cfg) {
            const v = (key) => cfg[key] !== undefined ? cfg[key] : CONFIG[key];
            return '<div style="max-width:800px;">'
                + checkRow('USE_CLEARART', v('USE_CLEARART') === true, 'Use ClearArt Instead of Logo',
                    'Shows ClearArt anchored to the bottom-right of the player instead of the standard logo below the header buttons.')

                + sectionHeader('Standard Logo Sizing')
                + textRow('LOGO_MAX_WIDTH', v('LOGO_MAX_WIDTH'), 'Logo Maximum Width', 'CSS length, e.g. 18vw.')
                + textRow('LOGO_MAX_HEIGHT', v('LOGO_MAX_HEIGHT'), 'Logo Maximum Height', 'CSS length, e.g. 13vh.')
                + textRow('GAP_BELOW_BUTTONS', v('GAP_BELOW_BUTTONS'), 'Gap Below Header Buttons', 'Space between the header buttons and the logo (CSS length, e.g. 10px).')
                + textRow('RIGHT_EDGE_OFFSET', v('RIGHT_EDGE_OFFSET'), 'Right Edge Offset', 'Distance from the right screen edge (CSS length, e.g. 10px).')

                + sectionHeader('ClearArt Sizing')
                + textRow('CLEARART_MAX_WIDTH', v('CLEARART_MAX_WIDTH'), 'ClearArt Maximum Width', 'CSS length, e.g. 25vw.')
                + textRow('CLEARART_MAX_HEIGHT', v('CLEARART_MAX_HEIGHT'), 'ClearArt Maximum Height', 'CSS length, e.g. 40vh.')

                + sectionHeader('Appearance')
                + numberRow('LOGO_OPACITY', v('LOGO_OPACITY'), 'Opacity',
                    'Logo opacity from 0.1 (nearly transparent) to 1.0 (fully opaque).', 0.1, 1, 0.05)
                + checkRow('TRIM_TRANSPARENCY', v('TRIM_TRANSPARENCY') !== false, 'Trim Transparent Borders',
                    'Auto-crops transparent padding from the image so sizing and alignment are based on the visible artwork.')
                + checkRow('ADD_OSD_SHADOW', v('ADD_OSD_SHADOW') !== false, 'OSD Drop Shadows',
                    'Adds drop shadows to the OSD buttons and text for readability over bright video.')

                + sectionHeader('Advanced')
                + numberRow('ITEM_ID_TIMEOUT_MS', v('ITEM_ID_TIMEOUT_MS'), 'Item ID Timeout (ms)',
                    'How long to wait for the playing item to be identified before giving up.', 500, undefined, 100)
                + '</div>';
        }

        function collectConfig() {
            const base = (window.KefinTweaksConfig && window.KefinTweaksConfig.osdLogo) || {};
            const el = (key) => document.getElementById('osdLogo_' + key);

            const text = (key) => {
                const node = el(key);
                const val = node ? node.value.trim() : '';
                return val || CONFIG[key];
            };
            const num = (key, fallback) => {
                const node = el(key);
                const val = node ? parseFloat(node.value) : NaN;
                return Number.isFinite(val) ? val : fallback;
            };
            const check = (key) => {
                const node = el(key);
                return node ? node.checked : CONFIG[key];
            };

            return Object.assign({}, base, {
                USE_CLEARART:        check('USE_CLEARART'),
                LOGO_MAX_WIDTH:      text('LOGO_MAX_WIDTH'),
                LOGO_MAX_HEIGHT:     text('LOGO_MAX_HEIGHT'),
                GAP_BELOW_BUTTONS:   text('GAP_BELOW_BUTTONS'),
                RIGHT_EDGE_OFFSET:   text('RIGHT_EDGE_OFFSET'),
                CLEARART_MAX_WIDTH:  text('CLEARART_MAX_WIDTH'),
                CLEARART_MAX_HEIGHT: text('CLEARART_MAX_HEIGHT'),
                LOGO_OPACITY:        Math.min(1, Math.max(0.1, num('LOGO_OPACITY', 1.0))),
                TRIM_TRANSPARENCY:   check('TRIM_TRANSPARENCY'),
                ADD_OSD_SHADOW:      check('ADD_OSD_SHADOW'),
                ITEM_ID_TIMEOUT_MS:  Math.max(500, num('ITEM_ID_TIMEOUT_MS', 3000))
            });
        }

        async function saveConfig(newCfg) {
            try {
                if (!window.KefinTweaksConfig) window.KefinTweaksConfig = {};
                window.KefinTweaksConfig.osdLogo = newCfg;
                if (window.KefinTweaksUtils && window.KefinTweaksUtils.saveConfigToJavaScriptInjector) {
                    await window.KefinTweaksUtils.saveConfigToJavaScriptInjector();
                    return true;
                }
                return false;
            } catch (e) {
                LOG('config save error', e);
                return false;
            }
        }

        async function openConfigModal() {
            try {
                if (!window.ModalSystem || !window.ModalSystem.create) {
                    alert('KefinTweaks modal system unavailable.');
                    return;
                }
                const cfg = (window.KefinTweaksConfig && window.KefinTweaksConfig.osdLogo) || {};
                const content = document.createElement('div');
                content.innerHTML = buildConfigHTML(cfg);

                const footer = document.createElement('div');
                footer.style.cssText = 'display:flex;gap:0.75em;justify-content:flex-end;';
                footer.innerHTML = '<button class="emby-button raised" onclick="window.ModalSystem.close(\'' + MODAL_ID + '\')">Close</button>'
                    + '<button class="emby-button raised block button-submit" id="save-osdlogo-config-btn">Save</button>';

                const modalInstance = window.ModalSystem.create({
                    id: MODAL_ID,
                    title: 'Player Logo Configuration',
                    content: content,
                    footer: footer,
                    closeOnBackdrop: true,
                    closeOnEscape: true,
                    showCloseButton: true,
                    onOpen: (modal) => {
                        const saveBtn = modal.dialogFooter.querySelector('#save-osdlogo-config-btn');
                        if (saveBtn) {
                            saveBtn.addEventListener('click', async () => {
                                const ok = await saveConfig(collectConfig());
                                if (ok) {
                                    if (window.KefinTweaksToaster && window.KefinTweaksToaster.toast) {
                                        window.KefinTweaksToaster.toast('Player Logo configuration saved! Reload to apply.');
                                    }
                                    window.ModalSystem.close(MODAL_ID);
                                } else {
                                    alert('Error saving configuration. Ensure the JavaScript Injector plugin is installed and you have administrator permissions.');
                                }
                            });
                        }
                    }
                });
                if (modalInstance && modalInstance.dialog) {
                    modalInstance.dialog.style.maxWidth = '90vw';
                    modalInstance.dialog.style.width = '800px';
                    modalInstance.dialog.style.height = 'auto';
                }
            } catch (e) {
                LOG('error opening config modal', e);
                alert('Error opening configuration: ' + e.message);
            }
        }

        window.KefinTweaksFeatureConfigs = window.KefinTweaksFeatureConfigs || {};
        window.KefinTweaksFeatureConfigs.osdLogo = { openConfigModal: openConfigModal };
    })();

    // Double-injection guard: destroy any previous instance first
    if (window.KefinTweaksOsdLogo && typeof window.KefinTweaksOsdLogo.destroy === 'function') {
        try { window.KefinTweaksOsdLogo.destroy(); } catch { /* ignore */ }
    }
    window.KefinTweaksOsdLogo = { destroy };

    // --- Start ---
    init();
    LOG('initialized');

})();
