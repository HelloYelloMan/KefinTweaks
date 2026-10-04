// KefinTweaks Pause Screen
// Shows a rich overlay (logo, plot, details, disc/clear art, progress) when
// playback is paused for a few seconds. Supports the HTML5 web player and
// external players (mpv-shim etc.) driven through the Jellyfin OSD.
//
// Ported from the standalone "Custom Pause Screen Injector v5.2".
// Configuration lives in window.KefinTweaksConfig.pauseScreen and is editable
// from the KefinTweaks Configuration page (feature card -> Configure).
// Changes apply on the next page reload.

(function() {
    'use strict';

    const LOG = (...args) => console.log('[KefinTweaks PauseScreen]', ...args);

    // ==========================================
    //        CONFIGURATION (with defaults)
    // ==========================================
    // Every key can be overridden from KefinTweaksConfig.pauseScreen.
    const CONFIG = Object.assign({
        // ---- LAYOUT & TEXT POSITIONING ----
        CONTENT_LEFT_EDGE: '6vw',      // Left margin for all text content
        PLOT_WIDTH:        '50vw',     // Max width of the plot description
        DETAILS_TOP:       '40vh',     // Vertical position: year / rating / runtime
        PLOT_TOP:          '50vh',     // Vertical position: plot text

        // ---- LOGO ----
        LOGO_MIN_WIDTH:  '25vw',
        LOGO_MAX_WIDTH:  '50vw',
        LOGO_MAX_HEIGHT: '35vh',

        // ---- ARTWORK - SHARED (applies to both Disc and ClearArt) ----
        FORCE_CLEARART:         false, // true = prefer ClearArt; false = prefer Disc
        ENABLE_SMART_CENTERING: true,  // Analyze transparent edges for placement
        ENABLE_MIN_WIDTH:       true,  // Enforce a minimum artwork width
        MIN_WIDTH_VAL:          '25vw',
        MAX_WIDTH_VAL:          '42vw', // Base max width (before any expansion)
        MAX_HEIGHT_VAL:         '75vh',

        // ---- DISC ART - POSITIONING ----
        ART_DEFAULT_CENTER: 78,        // Horizontal anchor point (vw)
        ART_RIGHT_MARGIN:   1,         // Min gap between art right edge & screen (vw)

        // ---- DISC ART - EXPANSION ----
        // Wide disc images that would hit max-width before max-height may grow
        // larger; the center shifts left so art never bleeds off-screen.
        // Tall, square, and ClearArt images are never expanded.
        ART_ENABLE_EXPAND:      true,
        ART_MAX_EXPAND_WIDTH:   '50vw', // Hard ceiling for expanded width
        ART_EXPAND_SKIP_SQUARE: true,   // true = square images never expand
        ART_SQUARE_TOLERANCE:   0.02,   // Ratio tolerance for "square" (0.02 = 2%)

        // ---- DISC ART - OVERLAP-AWARE EXPANSION ----
        // The expansion cap above treats the image as its bounding BOX. An
        // image whose opaque pixels sit in one corner (character lower-right,
        // transparent upper-left) can grow far past that cap without actually
        // covering anything. This pass rasterizes a small alpha mask and lets
        // the art keep growing as long as its OPAQUE pixels don't intrude on
        // the text elements (logo, details, plot text). The progress bar is
        // NOT protected - art may pass behind it; the bar carries its own
        // contrast treatment instead. Buttons don't count either.
        ART_OVERLAP_EXPAND:      true,
        ART_OVERLAP_MAX_PERCENT: 0,      // Max % of each text element opaque art may cover (0 = ban)
        ART_OVERLAP_MAX_WIDTH:   '80vw', // Hard width ceiling for overlap-aware growth
        ART_OVERLAP_MAX_HEIGHT:  '95vh', // Hard height ceiling for overlap-aware growth

        // ---- CLEARART - POSITIONING ----
        // Where ClearArt lands when its edges are TRANSPARENT. Opaque edges
        // always snap to 0 (edge detection overrides these).
        //  >= 0 : offset from the respective screen edge (0 = flush).
        //  <  0 : fall back to default centering logic.
        CLEARART_BOTTOM_OFFSET: 4,     // vh above screen bottom
        CLEARART_RIGHT_OFFSET:  -1,    // vw from right edge (-1 = center instead)

        // ---- TIMING ----
        PAUSE_DELAY_MS:      5000,     // ms paused with no input before pause screen appears
        ENDS_AT_REFRESH_MS:  30000,    // ms between "Ends at" refreshes while shown

        // ---- CACHE ----
        ITEM_CACHE_MAX: 50             // Max cached item metadata records
    }, window.KefinTweaksConfig?.pauseScreen || {});

    const {
        CONTENT_LEFT_EDGE, PLOT_WIDTH, DETAILS_TOP, PLOT_TOP,
        LOGO_MIN_WIDTH, LOGO_MAX_WIDTH, LOGO_MAX_HEIGHT,
        FORCE_CLEARART, ENABLE_SMART_CENTERING, ENABLE_MIN_WIDTH,
        MIN_WIDTH_VAL, MAX_WIDTH_VAL, MAX_HEIGHT_VAL,
        ART_DEFAULT_CENTER, ART_RIGHT_MARGIN,
        ART_ENABLE_EXPAND, ART_MAX_EXPAND_WIDTH, ART_EXPAND_SKIP_SQUARE, ART_SQUARE_TOLERANCE,
        ART_OVERLAP_EXPAND, ART_OVERLAP_MAX_PERCENT, ART_OVERLAP_MAX_WIDTH, ART_OVERLAP_MAX_HEIGHT,
        CLEARART_BOTTOM_OFFSET, CLEARART_RIGHT_OFFSET,
        PAUSE_DELAY_MS, ENDS_AT_REFRESH_MS,
        ITEM_CACHE_MAX
    } = CONFIG;

    // UI strings
    const STR = {
        noDescription: 'No description available',
        watchedPercent: (percent) => `${percent}% watched`,
        endsAt: (time) => `Ends at ${time}`
    };

    // Formatting tags kept when rendering an item's Overview. Deliberately no
    // <a>, <img> or anything that can load or navigate.
    const OVERVIEW_ALLOWED_TAGS = new Set([
        'BR', 'P', 'DIV', 'SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'S',
        'SMALL', 'SUB', 'SUP', 'UL', 'OL', 'LI', 'BLOCKQUOTE'
    ]);

    // Dropped with their contents. Everything else that isn't allowed is merely
    // unwrapped (tag discarded, text kept) - right for <a> and unknown wrappers,
    // but these hold code, not prose, so unwrapping would print the source into
    // the overlay.
    const OVERVIEW_DROP_TAGS = new Set([
        'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'TITLE'
    ]);

    // Z-index layer map - disc is always behind all text/UI
    const Z = {
        disc:      5,
        details:   10,
        progress:  10,
        plot:      20,
        logo:      30,
        closeBtn:  40,
    };

    // Per-user on/off switch, set from Settings -> Display. Kept in localStorage
    // per user, like the skin and theme-media toggles on that page: a key in the
    // server's CustomPrefs would be overwritten by jellyfin-web's own Save, which
    // posts back the CustomPrefs it loaded at sign-in.
    function userPrefKey() {
        let uid = '';
        try { uid = ApiClient.getCurrentUserId() || ''; } catch (e) { /* noop */ }
        return 'kefinPauseScreen_enabled_' + uid;
    }
    function isEnabledForUser() {
        try { return localStorage.getItem(userPrefKey()) !== 'false'; } catch (e) { return true; }
    }
    function setEnabledForUser(enabled) {
        try { localStorage.setItem(userPrefKey(), enabled ? 'true' : 'false'); } catch (e) { /* noop */ }
    }

    class JellyfinPauseScreen {
        constructor() {
            // State
            this.currentVideo       = null;
            this.currentItemId      = null;
            this.playerMode         = null;   // 'html5' | 'external' | null
            this.userId             = null;
            this.token              = null;
            this.prevFocused        = null;
            this.pauseScreenTimer   = null;
            this.cleanupListeners   = null;
            this.fetchAbort         = null;
            this.observer           = null;
            this.observerThrottleId = null;
            this._keydownHandler    = null;
            this._hashChangeHandler = null;
            this._popStateHandler   = null;
            this._externalPollId    = null;   // interval ID for external player polling
            this._externalWasPaused = false;  // tracks last-known pause state
            this._userDismissed     = false;  // true = user closed overlay, suppress until next play
            this._endsAtRefreshId   = null;   // interval ID for "Ends at" refresh
            this._resizeHandler     = null;
            this._resizeTimer       = null;
            this._artIsClearArt     = null;   // art type currently laid out, null = no art
            this._itemLoaded        = false;  // true once metadata rendered for currentItemId

            // Caches
            this.itemCache = new Map();
            this._alphaMaskCache = null;   // { src, mask } - overlap-expansion alpha grid

            // DOM references
            this.overlay         = null;
            this.overlayContent  = null;
            this.overlayLogo     = null;
            this.overlayPlot     = null;
            this.overlayDetails  = null;
            this.overlayDisc     = null;
            this.progressWrap    = null;
            this.progressBar     = null;
            this.progressMeta    = null;
            this.focusStart      = null;
            this.focusEnd        = null;

            // Interaction listener tracking for cleanup
            this.boundInteractionListeners = [];

            this.setup();
        }

        // --------------------------------------------------
        //  INITIALIZATION
        // --------------------------------------------------

        setup() {
            const credentials = this.getCredentials();
            if (!credentials) return;
            this.userId = credentials.userId;
            this.token  = credentials.token;

            this.injectStyles();
            this.createOverlay();
            this.setupKeyboardHandler();
            this.setupVideoObserver();
            this.setupNavigationListeners();
            this.setupInteractionListeners();
            this.setupResizeListener();
        }

        // Artwork sizing and placement are viewport-relative, so a resize can
        // change which constraint binds (natural size vs. max-width vs. the
        // screen edges). Re-run the layout instead of leaving stale geometry.
        setupResizeListener() {
            this._resizeHandler = () => {
                if (this._resizeTimer) clearTimeout(this._resizeTimer);
                this._resizeTimer = setTimeout(() => {
                    this._resizeTimer = null;
                    if (this._artIsClearArt !== null) {
                        this.layoutArtwork(this._artIsClearArt);
                    }
                }, 150);
            };
            window.addEventListener('resize', this._resizeHandler, { passive: true });
        }

        // Prefer ApiClient (tracks the actively connected server); fall back
        // to localStorage Servers[0] only if ApiClient isn't available yet.
        getCredentials() {
            try {
                if (typeof ApiClient !== 'undefined') {
                    const token  = ApiClient.accessToken?.();
                    const userId = ApiClient.getCurrentUserId?.();
                    if (token && userId) return { token, userId };
                }
            } catch {
                // fall through to localStorage
            }

            const raw = localStorage.getItem('jellyfin_credentials');
            if (!raw) return null;
            try {
                const parsed = JSON.parse(raw);
                const server = parsed.Servers?.[0];
                return server ? { token: server.AccessToken, userId: server.UserId } : null;
            } catch {
                return null;
            }
        }

        // --------------------------------------------------
        //  STYLES
        // --------------------------------------------------

        injectStyles() {
            const logoLeft = `calc(${CONTENT_LEFT_EDGE} + (${PLOT_WIDTH} / 2))`;
            const logoTop  = `calc(${DETAILS_TOP} / 2)`;

            const existing = document.getElementById('pause-screen-style');
            if (existing) existing.remove();

            const style = document.createElement('style');
            style.id = 'pause-screen-style';
            style.textContent = `
                :root {
                    --pause-screen-overlay-bg: rgba(0, 0, 0, 0.4);
                    --content-left: ${CONTENT_LEFT_EDGE};
                    --plot-width: ${PLOT_WIDTH};
                    --logo-pos-top: ${logoTop};
                    --logo-transform: translate(-50%, -50%);
                    --logo-min-w: ${LOGO_MIN_WIDTH};
                    --logo-max-h: ${LOGO_MAX_HEIGHT};
                    --logo-max-w: ${LOGO_MAX_WIDTH};
                    --details-pos-top: ${DETAILS_TOP};
                    --plot-pos-top: ${PLOT_TOP};
                    --art-pos-left: ${ART_DEFAULT_CENTER}vw;
                    --art-min-width: ${ENABLE_MIN_WIDTH ? MIN_WIDTH_VAL : '0px'};
                    --art-max-width: ${MAX_WIDTH_VAL};
                    --art-max-height: ${MAX_HEIGHT_VAL};
                    --pause-screen-blur: 50px;
                    --pause-screen-progress-width: 48vw;
                    --pause-screen-progress-top: 85vh;
                    --pause-screen-details-gap: 2rem;
                    --pause-screen-text-size: 1.2rem;
                    --pause-screen-plot-font: 1.25rem;
                    --pause-screen-progress-height: 6px;
                    --pause-screen-progress-radius: 999px;
                    --pause-screen-progress-track: rgba(0,0,0,.38);
                    --pause-screen-progress-fill: #fff;
                }

                #pause-screen-overlay {
                    position: fixed; inset: 0; display: none;
                    z-index: 99; color: #fff; font-family: inherit;
                    background: var(--pause-screen-overlay-bg);
                }
                #pause-screen-overlay[aria-hidden="false"] { display: flex; }

                .pause-screen-active .videoOsdBottom { opacity: 0 !important; pointer-events: none !important; }
                .pause-screen-active .skinHeader.osdHeader { visibility: hidden !important; }
                .pause-screen-active .headerBackButton { visibility: visible !important; }

                #pause-screen-content {
                    position: relative; width: 100%; height: 100%;
                    backdrop-filter: blur(var(--pause-screen-blur)) brightness(1.0);
                    outline: none;
                }

                #pause-screen-logo {
                    position: absolute;
                    min-width: var(--logo-min-w);
                    max-height: var(--logo-max-h);
                    width: auto; height: auto;
                    max-width: var(--logo-max-w);
                    top: var(--logo-pos-top);
                    left: ${logoLeft};
                    transform: var(--logo-transform);
                    display: block;
                    object-fit: contain;
                    z-index: ${Z.logo};
                }

                #pause-screen-details {
                    position: absolute; top: var(--details-pos-top); left: var(--content-left);
                    display: flex; gap: var(--pause-screen-details-gap);
                    align-items: center; font-size: var(--pause-screen-text-size);
                    z-index: ${Z.details};
                }

                /* Only for overviews with no markup: their newlines are real and
                   would otherwise collapse. Markup overviews use <br>/<p>, so
                   pre-wrap there would double the spacing. */
                #pause-screen-plot.plain-text { white-space: pre-wrap; }
                #pause-screen-plot p { margin: 0 0 .6em; }
                #pause-screen-plot p:last-child { margin-bottom: 0; }

                #pause-screen-plot {
                    position: absolute; top: var(--plot-pos-top); left: var(--content-left);
                    max-width: var(--plot-width); height: 25vh; display: block;
                    font-size: var(--pause-screen-plot-font); line-height: 1.6;
                    overflow-y: auto; text-align: left;
                    z-index: ${Z.plot};
                }

                #pause-screen-disc {
                    position: absolute;
                    left: var(--art-pos-left);
                    transform: translateX(-50%) translateZ(0);
                    bottom: 0; top: auto;
                    min-width: var(--art-min-width);
                    max-width: var(--art-max-width);
                    max-height: var(--art-max-height);
                    width: auto; height: auto;
                    display: none;
                    object-fit: contain;
                    filter: drop-shadow(0 10px 15px rgba(0,0,0,0.5));
                    pointer-events: none;
                    z-index: ${Z.disc};
                }

                #pause-screen-progress-wrap {
                    position: absolute; top: var(--pause-screen-progress-top);
                    left: var(--content-left); width: var(--pause-screen-progress-width);
                    user-select: none;
                    z-index: ${Z.progress};
                }
                /* Overlap expansion lets light artwork pass behind the bar, so
                   the WATCHED portion can end up white-on-white. The track is
                   lightly tinted rather than scrimmed - art still reads through
                   it - but it darkens the strip just enough that the white fill
                   always has something to sit against. The hairline ring then
                   carries the bar on dark backdrops, where the tint alone would
                   vanish. */
                #pause-screen-progress-bar {
                    width: 100%; height: var(--pause-screen-progress-height);
                    border-radius: var(--pause-screen-progress-radius);
                    background: var(--pause-screen-progress-track);
                    overflow: hidden; position: relative;
                    box-shadow: 0 0 0 1px rgba(255,255,255,.32);
                    /* Hugs the bar's silhouette, so the white fill keeps a dark
                       edge even when it sits directly on white artwork. Costs
                       nothing on dark backdrops, where it is invisible. */
                    filter: drop-shadow(0 0 2px rgba(0,0,0,.85)) drop-shadow(0 1px 3px rgba(0,0,0,.5));
                }
                #pause-screen-progress-bar > span {
                    display: block; height: 100%; width: 0%;
                    background: var(--pause-screen-progress-fill);
                }
                #pause-screen-progress-meta {
                    margin-top: .5rem; font-size: 0.9rem; display: flex;
                    text-shadow: 0 1px 2px rgba(0,0,0,.9), 0 0 10px rgba(0,0,0,.65);
                }
                #pause-screen-progress-meta span:not(:first-child)::before { content: '\\2022'; margin: 1em; }

                #pause-screen-close-btn,
                #pause-screen-back-btn {
                    position: absolute; top: 20px;
                    background: rgba(0,0,0,0.1); border: 1px solid rgba(255,255,255,0.2);
                    color: white; width: 1.5em; height: 1.5em; border-radius: 50%;
                    font-size: 1.5em; display: flex; align-items: center; justify-content: center;
                    cursor: pointer; transition: background 0.2s;
                    z-index: ${Z.closeBtn};
                }
                #pause-screen-close-btn .material-icons,
                #pause-screen-back-btn .material-icons {
                    font-size: inherit; line-height: 1;
                }
                #pause-screen-close-btn { right: 20px; }
                #pause-screen-back-btn  { left: 20px; }
                #pause-screen-close-btn:hover,
                #pause-screen-back-btn:hover { background: rgba(0,0,0,0.8); }

                #pause-screen-focus-start,
                #pause-screen-focus-end {
                    position: fixed; width: 1px; height: 1px;
                    overflow: hidden; clip: rect(0 0 0 0);
                }

                #pause-screen-progress-meta .progress-percentage {
                    font-size: inherit !important; font-weight: normal !important;
                    color: inherit !important; min-width: auto !important; text-align: left !important;
                }

                #pause-screen-logo:not([src]),
                #pause-screen-disc:not([src]) { display: none; }

                @media (max-width: 1400px) {
                    :root {
                        --content-left: 6vw !important; --plot-width: 48vw !important;
                        --logo-pos-top: 18vh !important; --logo-transform: none !important;
                        --details-pos-top: 42vh;
                        --pause-screen-progress-width: 44vw;
                    }
                    #pause-screen-logo {
                        left: var(--content-left) !important; right: auto !important;
                        transform: none !important; min-width: 0 !important;
                        max-width: 60vw !important; height: auto !important; max-height: 18vh !important;
                    }
                    #pause-screen-disc { --art-pos-left: 75vw; }
                }
                @media (max-width: 768px) {
                    :root {
                        --logo-pos-top: 12vh !important; --pause-screen-progress-width: 80vw;
                        --pause-screen-progress-top: 88vh; --plot-width: 85vw !important;
                    }
                    #pause-screen-logo {
                        left: 50% !important; transform: translateX(-50%) !important;
                        max-width: 70vw !important; min-width: 50vw !important;
                        height: auto !important; max-height: 20vh !important;
                    }
                    #pause-screen-details {
                        left: 50% !important; transform: translateX(-50%);
                        top: 32vh; font-size: 14px; justify-content: center;
                    }
                    #pause-screen-plot {
                        top: 40vh; left: 50% !important; transform: translateX(-50%);
                        max-width: 85vw; text-align: center; font-size: 15px; height: 45vh;
                    }
                    #pause-screen-progress-wrap {
                        left: 50% !important; transform: translateX(-50%);
                    }
                    #pause-screen-disc { display: none !important; }
                }
            `;
            document.head.appendChild(style);
        }

        // --------------------------------------------------
        //  OVERLAY DOM
        // --------------------------------------------------

        createOverlay() {
            this.overlay = document.createElement('div');
            this.overlay.id = 'pause-screen-overlay';
            this.overlay.setAttribute('role', 'dialog');
            this.overlay.setAttribute('aria-hidden', 'true');
            this.overlay.setAttribute('aria-modal', 'true');

            this.focusStart = document.createElement('div');
            this.focusStart.id = 'pause-screen-focus-start';
            this.focusStart.tabIndex = 0;

            this.focusEnd = document.createElement('div');
            this.focusEnd.id = 'pause-screen-focus-end';
            this.focusEnd.tabIndex = 0;

            this.overlayContent = document.createElement('div');
            this.overlayContent.id = 'pause-screen-content';
            this.overlayContent.tabIndex = -1;

            this.overlayLogo = document.createElement('img');
            this.overlayLogo.id = 'pause-screen-logo';
            this.overlayLogo.alt = 'Show logo';

            this.overlayDetails = document.createElement('div');
            this.overlayDetails.id = 'pause-screen-details';

            this.overlayPlot = document.createElement('div');
            this.overlayPlot.id = 'pause-screen-plot';

            this.progressWrap = document.createElement('div');
            this.progressWrap.id = 'pause-screen-progress-wrap';

            this.progressBar = document.createElement('div');
            this.progressBar.id = 'pause-screen-progress-bar';
            this.progressBar.appendChild(document.createElement('span'));

            this.progressMeta = document.createElement('div');
            this.progressMeta.id = 'pause-screen-progress-meta';
            this.progressMeta.innerHTML =
                '<span class="progress-time"></span>' +
                '<span class="progress-percentage"></span>' +
                '<span class="progress-ends-at"></span>';

            this.progressWrap.appendChild(this.progressBar);
            this.progressWrap.appendChild(this.progressMeta);

            this.overlayDisc = document.createElement('img');
            this.overlayDisc.id = 'pause-screen-disc';
            this.overlayDisc.alt = 'Artwork';

            const closeBtn = document.createElement('button');
            closeBtn.id = 'pause-screen-close-btn';
            closeBtn.innerHTML = '<span class="material-icons close"></span>';
            closeBtn.setAttribute('aria-label', 'Close pause screen');
            closeBtn.addEventListener('click', () => {
                this._userDismissed = true;
                this.hideOverlay();
            });

            const backBtn = document.createElement('button');
            backBtn.id = 'pause-screen-back-btn';
            backBtn.innerHTML = '<span class="material-icons arrow_back"></span>';
            backBtn.setAttribute('aria-label', 'Leave video');
            backBtn.addEventListener('click', () => {
                this.clearState();
                history.back();
            });

            // Assemble - disc inside overlayContent
            this.overlayContent.appendChild(this.overlayLogo);
            this.overlayContent.appendChild(this.overlayDetails);
            this.overlayContent.appendChild(this.overlayPlot);
            this.overlayContent.appendChild(this.progressWrap);
            this.overlayContent.appendChild(this.overlayDisc);
            this.overlayContent.appendChild(closeBtn);
            this.overlayContent.appendChild(backBtn);

            this.overlay.appendChild(this.focusStart);
            this.overlay.appendChild(this.overlayContent);
            this.overlay.appendChild(this.focusEnd);

            document.body.appendChild(this.overlay);

            // Click / tap to resume.
            // Excluded: close/back buttons (their own handlers) and the plot
            // text (must remain scrollable/selectable). touchstart is NOT
            // used - it fired on scroll attempts and resumed playback.
            let resumeFired = false;
            const tryResume = (event) => {
                if (this.overlay.getAttribute('aria-hidden') !== 'false') return;
                if (event.target.closest('#pause-screen-close-btn, #pause-screen-back-btn, #pause-screen-plot')) return;
                if (resumeFired) return;
                resumeFired = true;
                requestAnimationFrame(() => { resumeFired = false; });
                this._userDismissed = true;
                this.hideOverlay();
                this.resumePlayer();
            };
            this.overlay.addEventListener('click', tryResume);

            // Focus trap
            const trapFocus = () => this.overlayContent.focus();
            this.focusStart.addEventListener('focus', trapFocus);
            this.focusEnd.addEventListener('focus', trapFocus);
        }

        // --------------------------------------------------
        //  KEYBOARD ACCESSIBILITY
        // --------------------------------------------------

        setupKeyboardHandler() {
            this._keydownHandler = (e) => {
                if (this.overlay.getAttribute('aria-hidden') !== 'false') return;

                // Let a focused close/back button receive Enter/Space normally
                if (e.target?.closest?.('#pause-screen-close-btn, #pause-screen-back-btn')) return;

                if (e.code === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    this._userDismissed = true;
                    this.hideOverlay();
                    return;
                }

                if (e.code === 'Space' || e.code === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    this._userDismissed = true;
                    this.hideOverlay();
                    this.resumePlayer();
                }

                if (e.code === 'Tab' && !this.overlay.contains(document.activeElement)) {
                    this.overlayContent.focus();
                    e.preventDefault();
                }
            };
            document.addEventListener('keydown', this._keydownHandler, { capture: true });
        }

        // --------------------------------------------------
        //  NAVIGATION LISTENERS (instant back-button response)
        // --------------------------------------------------

        setupNavigationListeners() {
            this._hashChangeHandler = () => {
                if (this.isPlayerActive()) this.clearState();
            };
            this._popStateHandler = () => {
                if (this.isPlayerActive()) this.clearState();
            };

            window.addEventListener('hashchange', this._hashChangeHandler);
            window.addEventListener('popstate', this._popStateHandler);
        }

        // --------------------------------------------------
        //  VIDEO OBSERVER (throttled, with fast-path removal)
        // --------------------------------------------------

        setupVideoObserver() {
            this.observer = new MutationObserver(() => {
                // Fast path: if tracked video was removed, clear immediately
                if (this.playerMode === 'html5' && this.currentVideo && !document.contains(this.currentVideo)) {
                    this.clearState();
                    return;
                }
                // Fast path: if external player OSD deactivated, clear immediately
                if (this.playerMode === 'external' && !document.querySelector('.skinHeader.osdHeader')) {
                    this.clearState();
                    return;
                }

                if (this.observerThrottleId) return;
                this.observerThrottleId = setTimeout(() => {
                    this.observerThrottleId = null;
                    this.checkForVideoChanges();
                }, 250);
            });
            this.observer.observe(document.body, { childList: true, subtree: true });
            this.checkForVideoChanges();
        }

        // --------------------------------------------------
        //  INTERACTION LISTENERS (pause timer reset + OSD guard)
        // --------------------------------------------------

        setupInteractionListeners() {
            // Movement is measured from where the pointer was when it last
            // counted as activity, not from the previous event. Browsers send
            // one mousemove per frame, so at a high refresh rate consecutive
            // events are a few pixels apart: a per-event threshold almost never
            // tripped, and the pause screen came up under a moving mouse.
            let anchorX = null;
            let anchorY = null;
            const MOUSE_MOVE_THRESHOLD = 15;

            const resetTimer = () => {
                if (!this.isPlayerActive()) return;
                this.clearPauseTimer();
                if (this.isPlayerPaused()) {
                    this.pauseScreenTimer = setTimeout(async () => {
                        this.pauseScreenTimer = null;
                        if (!this.isPlayerActive() || !this.isPlayerPaused()) return;
                        await this.refreshItemIfChanged({ wait: true });
                        if (this.isPlayerActive() && this.isPlayerPaused()) {
                            this.showOverlay();
                        }
                    }, PAUSE_DELAY_MS);
                }
            };

            const discreteEvents = ['mousedown', 'click', 'touchstart', 'touchmove', 'keydown', 'wheel'];
            discreteEvents.forEach(eventName => {
                const handler = () => resetTimer();
                document.addEventListener(eventName, handler, { passive: true });
                this.boundInteractionListeners.push({ event: eventName, handler });
            });

            const handleMouseMove = (e) => {
                if (!this.isPlayerActive()) return;
                const x = e.clientX;
                const y = e.clientY;
                if (anchorX === null || anchorY === null) {
                    anchorX = x;
                    anchorY = y;
                    return;
                }
                if (Math.hypot(x - anchorX, y - anchorY) <= MOUSE_MOVE_THRESHOLD) return;
                anchorX = x;
                anchorY = y;
                if (e.target?.closest?.('.videoOsdBottom, .osdHeader, .videoOsdTop')) {
                    this.clearPauseTimer();
                } else {
                    resetTimer();
                }
            };
            document.addEventListener('mousemove', handleMouseMove, { passive: true });
            this.boundInteractionListeners.push({ event: 'mousemove', handler: handleMouseMove });

            const osdEnterGuard = (e) => {
                if (!this.isPlayerActive()) return;
                if (e.target?.closest?.('.videoOsdBottom, .osdHeader, .videoOsdTop')) {
                    this.clearPauseTimer();
                }
            };
            document.addEventListener('mouseenter', osdEnterGuard, { capture: true, passive: true });
            this.boundInteractionListeners.push({ event: 'mouseenter', handler: osdEnterGuard, capture: true });
        }

        // --------------------------------------------------
        //  VIDEO CHANGE DETECTION
        // --------------------------------------------------

        checkForVideoChanges() {
            const video = document.querySelector('.videoPlayerContainer video');
            const isOsdActive = document.querySelector('.skinHeader.osdHeader') !== null;

            if (video && video !== this.currentVideo) {
                // HTML5 player mode (standard web player)
                this.handleVideoChange(video);
            } else if (!video && isOsdActive && this.playerMode !== 'external') {
                // External player mode (mpv, etc.) - OSD is active but no <video>
                this.handleExternalPlayer();
            } else if (!video && !isOsdActive && this.isPlayerActive()) {
                // Playback ended
                this.clearState();
            }
        }

        async handleVideoChange(video) {
            this.clearState();
            this.playerMode   = 'html5';
            this.currentVideo = video;
            this.cleanupListeners = this.attachVideoListeners(video);

            await this.refreshItemIfChanged({ wait: true });
        }

        // Resolve the currently playing item from the ACTIVE video OSD page only.
        // Jellyfin keeps old, hidden OSD pages cached in the DOM and the URL hash
        // during playback is just #/video, so neither the hash nor an unscoped
        // [data-id] query is reliable - both can return the item from a PREVIOUS
        // playback session (stale logo/plot after switching items).
        checkForItemId() {
            const osdPage = document.querySelector('#videoOsdPage:not(.hide)')
                || document.querySelector('.videoOsdPage:not(.hide)');
            if (!osdPage) return null;

            // The rating button is the canonical carrier, but not every item
            // type renders one - fall back to any [data-id] inside the page.
            const btn = osdPage.querySelector('.btnUserRating[data-id]')
                || osdPage.querySelector('[data-id]');
            const id = btn?.getAttribute('data-id');
            return id || null;
        }

        // The OSD populates its buttons asynchronously after the page swaps in,
        // so a synchronous read right after playback starts can come back empty.
        _waitForItemId(timeoutMs = 2000) {
            return new Promise((resolve) => {
                const deadline = Date.now() + timeoutMs;
                const poll = () => {
                    const id = this.checkForItemId();
                    if (id || Date.now() >= deadline) {
                        resolve(id || null);
                        return;
                    }
                    setTimeout(poll, 100);
                };
                poll();
            });
        }

        // Re-read the item id and refetch metadata if it changed. Called right
        // before the overlay is shown so a stale/late OSD update can't leave the
        // previous item's info on screen.
        //
        // Also refetches when the id is unchanged but the last fetch failed -
        // otherwise a single failed request left the overlay permanently empty
        // for the rest of the playback session.
        async refreshItemIfChanged({ wait = false } = {}) {
            let newItemId = this.checkForItemId();
            if (!newItemId && wait) newItemId = await this._waitForItemId();
            if (!newItemId) {
                if (wait) LOG('no item id found on the active OSD page - overlay will be empty');
                return;
            }
            if (newItemId !== this.currentItemId || !this._itemLoaded) {
                this.currentItemId = newItemId;
                await this.fetchItemInfo(newItemId);
            }
        }

        // --------------------------------------------------
        //  VIDEO EVENT LISTENERS
        // --------------------------------------------------

        attachVideoListeners(video) {
            const handlePause = () => {
                if (video !== this.currentVideo || video.ended) return;

                this.refreshItemIfChanged();
                this.updateProgress();
                this.clearPauseTimer();

                this.pauseScreenTimer = setTimeout(async () => {
                    this.pauseScreenTimer = null;
                    if (video !== this.currentVideo || !video.paused || video.ended) return;
                    await this.refreshItemIfChanged({ wait: true });
                    if (video === this.currentVideo && video.paused && !video.ended) {
                        this.showOverlay();
                    }
                }, PAUSE_DELAY_MS);
            };

            const handlePlay = () => {
                if (video !== this.currentVideo) return;
                this._userDismissed = false;
                this.clearPauseTimer();
                this.hideOverlay();
            };

            const handleLoadedData = () => {
                this.refreshItemIfChanged();
            };

            video.addEventListener('pause', handlePause);
            video.addEventListener('play', handlePlay);
            video.addEventListener('loadeddata', handleLoadedData);

            return () => {
                video.removeEventListener('pause', handlePause);
                video.removeEventListener('play', handlePlay);
                video.removeEventListener('loadeddata', handleLoadedData);
            };
        }

        // --------------------------------------------------
        //  EXTERNAL PLAYER SUPPORT (mpv, etc.)
        //
        //  When no <video> element exists but OSD controls are
        //  present, we enter external mode and detect state via
        //  the Jellyfin web UI's OSD button icons and time text.
        // --------------------------------------------------

        async handleExternalPlayer() {
            this.clearState();
            this.playerMode = 'external';
            this._externalWasPaused = this._detectExternalPause();

            // Start polling OSD button state for pause/play transitions
            this._startExternalPoll();

            await this.refreshItemIfChanged({ wait: true });

            // If already paused when we detected the external player, start the timer
            if (this._externalWasPaused) {
                this._onExternalPause();
            }
        }

        _startExternalPoll() {
            this._stopExternalPoll();
            this._externalPollId = setInterval(() => {
                if (this.playerMode !== 'external') return;

                // If OSD deactivated, playback ended
                if (!document.querySelector('.skinHeader.osdHeader')) {
                    this.clearState();
                    return;
                }

                const isPaused = this._detectExternalPause();

                if (isPaused && !this._externalWasPaused) {
                    this._onExternalPause();
                } else if (!isPaused && this._externalWasPaused) {
                    this._onExternalPlay();
                }

                this._externalWasPaused = isPaused;
            }, 400);
        }

        _stopExternalPoll() {
            if (this._externalPollId) {
                clearInterval(this._externalPollId);
                this._externalPollId = null;
            }
        }

        _onExternalPause() {
            this.refreshItemIfChanged();
            this.updateProgress();
            this.clearPauseTimer();

            this.pauseScreenTimer = setTimeout(async () => {
                this.pauseScreenTimer = null;
                if (this.playerMode !== 'external' || !this._detectExternalPause()) return;
                await this.refreshItemIfChanged({ wait: true });
                if (this.playerMode === 'external' && this._detectExternalPause()) {
                    this.showOverlay();
                }
            }, PAUSE_DELAY_MS);
        }

        _onExternalPlay() {
            this._userDismissed = false;
            this.clearPauseTimer();
            this.hideOverlay();
        }

        // Detect pause state from OSD play/pause button icon.
        // Jellyfin's OSD uses a .btnPause button whose inner icon span
        // toggles between 'pause' (playing) and 'play_arrow' (paused).
        // jellyfin-web keeps up to three views cached, so a previous video's OSD
        // page can still be in the DOM (hidden) and come first in document order.
        _activeOsdQuery(selector) {
            const page = document.querySelector('#videoOsdPage:not(.hide)')
                || document.querySelector('.videoOsdPage:not(.hide)');
            return page ? page.querySelector(selector) : null;
        }

        _detectExternalPause() {
            const osd = this._activeOsdQuery('.videoOsdBottom');
            if (!osd) return false;

            const btn = osd.querySelector('.btnPause, .btnPlay, .playPauseButton');
            if (!btn) return false;

            const icon = btn.querySelector('span.material-icons, span.md-icon, i.md-icon');
            if (icon) {
                // Class-based (newer Jellyfin)
                if (icon.classList.contains('play_arrow')) return true;
                if (icon.classList.contains('pause')) return false;

                // Text-based (material icons ligature)
                const text = icon.textContent.trim();
                if (text === 'play_arrow') return true;
                if (text === 'pause') return false;
            }

            return false;
        }

        _clickPlayButton() {
            const osd = this._activeOsdQuery('.videoOsdBottom');
            if (!osd) return;
            const btn = osd.querySelector('.btnPause, .btnPlay, .playPauseButton');
            if (btn) btn.click();
        }

        // Read progress from OSD time text elements.
        _readExternalProgress() {
            // Try slider value first (0-100 range)
            const slider = this._activeOsdQuery('.osdPositionSlider, #osdPositionSlider');
            if (slider && slider.value !== undefined && slider.max) {
                const pct = parseFloat(slider.value) / parseFloat(slider.max || 100);
                const durText = this._activeOsdQuery('.osdDurationText');
                const dur = durText ? this._parseTimeText(durText.textContent) : 0;
                if (dur > 0) return { current: pct * dur, duration: dur };
            }

            // Fall back to time text elements
            const posEl = this._activeOsdQuery('.osdPositionText');
            const durEl = this._activeOsdQuery('.osdDurationText');
            return {
                current:  posEl ? this._parseTimeText(posEl.textContent) : 0,
                duration: durEl ? this._parseTimeText(durEl.textContent) : 0,
            };
        }

        _parseTimeText(text) {
            if (!text) return 0;
            const parts = text.trim().split(':').map(Number);
            if (parts.some(isNaN)) return 0;
            if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
            if (parts.length === 2) return parts[0] * 60 + parts[1];
            return 0;
        }

        // --------------------------------------------------
        //  ABSTRACT PLAYER METHODS
        //
        //  Unified interface used by overlay, keyboard, click,
        //  interaction listeners, and progress bar. Routes to
        //  either the HTML5 video element or external OSD.
        // --------------------------------------------------

        isPlayerActive() {
            return this.playerMode !== null;
        }

        isPlayerPaused() {
            if (this.playerMode === 'html5') {
                return !!this.currentVideo?.paused && !this.currentVideo?.ended;
            }
            if (this.playerMode === 'external') {
                return this._detectExternalPause();
            }
            return false;
        }

        resumePlayer() {
            if (this.playerMode === 'html5') {
                if (this.currentVideo?.paused) {
                    this.currentVideo.play().catch(err => console.warn('[KefinTweaks PauseScreen] Play blocked:', err));
                }
            } else if (this.playerMode === 'external') {
                this._clickPlayButton();
            }
        }

        getPlayerProgress() {
            if (this.playerMode === 'html5' && this.currentVideo) {
                const cur = Number.isFinite(this.currentVideo.currentTime) ? this.currentVideo.currentTime : 0;
                const dur = Number.isFinite(this.currentVideo.duration) ? this.currentVideo.duration : 0;
                return { current: cur, duration: dur };
            }
            if (this.playerMode === 'external') {
                return this._readExternalProgress();
            }
            return { current: 0, duration: 0 };
        }

        // --------------------------------------------------
        //  OVERLAY SHOW / HIDE
        // --------------------------------------------------

        showOverlay() {
            if (this._userDismissed) return;
            if (!isEnabledForUser()) return;
            // Already up: re-showing would record the overlay itself as the focus
            // to restore on resume, and redo the artwork layout on every mouse move.
            if (this.overlay.getAttribute('aria-hidden') === 'false') return;
            if (!this._activeOsdQuery('.videoOsdBottom')) return;

            this.prevFocused = document.activeElement;
            document.documentElement.classList.add('pause-screen-active');
            this.overlay.setAttribute('aria-hidden', 'false');

            // The artwork is fetched seconds before the overlay is shown, while
            // the overlay is still display:none - everything inside it measures
            // as zero-width there, so the viewport fit can't be computed until
            // now. Re-run the layout with the art actually rendered.
            if (this._artIsClearArt !== null) {
                this.layoutArtwork(this._artIsClearArt);
            }

            this.overlayContent.focus();
            this._startEndsAtRefresh();
        }

        hideOverlay() {
            this._stopEndsAtRefresh();
            const wasVisible = this.overlay.getAttribute('aria-hidden') === 'false';
            document.documentElement.classList.remove('pause-screen-active');
            this.overlay.setAttribute('aria-hidden', 'true');
            // Only restore focus if we actually took it - hideOverlay runs on
            // every play event, and unconditionally refocusing stole focus.
            if (wasVisible && this.prevFocused && document.contains(this.prevFocused)) {
                this.prevFocused.focus();
            }
        }

        // Keep "Ends at" accurate during long pauses
        _startEndsAtRefresh() {
            this._stopEndsAtRefresh();
            this._endsAtRefreshId = setInterval(() => {
                if (this.overlay.getAttribute('aria-hidden') === 'false') {
                    this.updateProgress();
                }
            }, ENDS_AT_REFRESH_MS);
        }

        _stopEndsAtRefresh() {
            if (this._endsAtRefreshId) {
                clearInterval(this._endsAtRefreshId);
                this._endsAtRefreshId = null;
            }
        }

        // --------------------------------------------------
        //  DATA FETCHING
        // --------------------------------------------------

        async fetchItemInfo(itemId) {
            this.clearDisplayData();
            this.fetchAbort?.abort();
            this.fetchAbort = new AbortController();
            const signal = this.fetchAbort.signal;

            try {
                let record = this.itemCache.get(itemId);

                if (!record) {
                    const itemResp = await this.requestItem(itemId, signal);
                    if (signal.aborted) return;

                    const domain = typeof ApiClient !== 'undefined'
                        ? ApiClient.serverAddress()
                        : window.location.origin;

                    // Disc and Art are not inherited into the item DTO; the parents'
                    // tags let the chain request by tag instead of probing blind.
                    itemResp._kefinParentTags = await this.requestParentImageTags(itemResp);
                    if (signal.aborted) return;

                    record = { item: itemResp, domain };
                    this.itemCacheSet(itemId, record);
                }

                await this.displayItemInfo(record.item, record.domain, itemId);
                this._itemLoaded = true;
            } catch (err) {
                if (err.name !== 'AbortError') {
                    console.error('[KefinTweaks PauseScreen] Error fetching item info:', err);
                }
            }
        }

        // Fetch a single item. ApiClient is preferred - it targets the endpoint
        // the connected server version actually exposes and signs the request
        // with the full auth header. The raw REST calls are only a fallback for
        // when ApiClient isn't on the page, and use the Authorization header too:
        // Jellyfin 12 rejects the legacy X-Emby-Token.
        async requestItem(itemId, signal) {
            if (typeof ApiClient !== 'undefined' && typeof ApiClient.getItem === 'function') {
                try {
                    return await ApiClient.getItem(this.userId, itemId);
                } catch (err) {
                    LOG('ApiClient.getItem failed, falling back to REST', err);
                }
            }
            if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });

            const base = typeof ApiClient !== 'undefined'
                ? ApiClient.serverAddress()
                : window.location.origin;
            const options = {
                headers: { 'Authorization': `MediaBrowser Token="${this.token}"`, 'Accept': 'application/json' },
                signal,
            };

            const urls = [
                `${base}/Users/${this.userId}/Items/${itemId}`,
                `${base}/Items/${itemId}?userId=${this.userId}`,
            ];

            let lastErr;
            for (const url of urls) {
                try {
                    return await this.fetchWithRetry(url, options);
                } catch (err) {
                    if (err.name === 'AbortError') throw err;
                    lastErr = err;
                }
            }
            throw lastErr;
        }

        // Retries network errors and 5xx responses only - a 4xx (404 etc.)
        // is deterministic and fails immediately.
        async fetchWithRetry(url, options, maxRetries = 2) {
            for (let attempt = 0; attempt <= maxRetries; attempt++) {
                try {
                    const response = await fetch(url, options);
                    if (!response.ok) {
                        const httpError = new Error(`HTTP ${response.status}`);
                        httpError.status = response.status;
                        throw httpError;
                    }
                    return await response.json();
                } catch (error) {
                    if (error.name === 'AbortError') throw error;
                    if (error.status && error.status < 500) throw error;
                    if (attempt === maxRetries) throw error;
                    await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
                }
            }
        }

        // ImageTags of the item's parent and series, by id; null when unknown,
        // in which case the art chain falls back to probing as before.
        async requestParentImageTags(item) {
            const ids = [...new Set([item.ParentId, item.SeriesId].filter(Boolean))];
            if (!ids.length || typeof ApiClient === 'undefined') return null;
            try {
                const userId = ApiClient.getCurrentUserId?.() || this.userId;
                const res = await ApiClient.getItems(userId, {
                    Ids: ids.join(','), EnableUserData: false, EnableTotalRecordCount: false
                });
                const map = {};
                (res?.Items || []).forEach((i) => { map[i.Id] = i.ImageTags || {}; });
                return map;
            } catch (e) {
                return null;
            }
        }

        itemCacheSet(key, value) {
            if (this.itemCache.size >= ITEM_CACHE_MAX) {
                const firstKey = this.itemCache.keys().next().value;
                this.itemCache.delete(firstKey);
            }
            this.itemCache.set(key, value);
        }

        // --------------------------------------------------
        //  DISPLAY
        // --------------------------------------------------

        async displayItemInfo(item, domain, itemId) {
            const year    = item.ProductionYear || '';
            const rating  = item.OfficialRating || '';
            const runtime = this.formatRuntime(item.RunTimeTicks);

            // Build via DOM so metadata text can't break markup
            this.overlayDetails.replaceChildren();
            if (year) {
                const span = document.createElement('span');
                span.textContent = year;
                this.overlayDetails.appendChild(span);
            }
            if (rating) {
                const span = document.createElement('span');
                span.className = 'mediaInfoOfficialRating';
                span.setAttribute('rating', rating);
                span.textContent = rating;
                this.overlayDetails.appendChild(span);
            }
            if (runtime) {
                const span = document.createElement('span');
                span.textContent = runtime;
                this.overlayDetails.appendChild(span);
            }

            this.renderOverview(this.overlayPlot, item.Overview || STR.noDescription);

            const tagUrl = (type, tag, id) => {
                if (!tag) return null;
                return `${domain}/Items/${id || itemId}/Images/${type}?tag=${tag}&ApiKey=${this.token}`;
            };
            const blindUrl = (type, id) => {
                return `${domain}/Items/${id}/Images/${type}?ApiKey=${this.token}`;
            };

            // --- LOGO URLs ---
            // Most specific first: the item's own logo (episode/movie), then the
            // season's, then the series'. Series was previously tried ahead of
            // season, and since a series almost always has a logo, a
            // season-specific one could never win.
            const logoUrls = [];
            const seenLogos = new Set();
            const addLogo = (id, tag) => {
                if (!id || seenLogos.has(id)) return;
                seenLogos.add(id);
                logoUrls.push(tag ? tagUrl('Logo', tag, id) : blindUrl('Logo', id));
            };

            if (item.ImageTags?.Logo) addLogo(item.Id || itemId, item.ImageTags.Logo);
            if (item.SeriesId) {
                // Server-resolved nearest of season -> series (the same order as
                // above); absent means neither has one, so nothing to probe blind.
                addLogo(item.ParentLogoItemId, item.ParentLogoImageTag);
            } else {
                addLogo(item.ParentId);
            }

            // --- ARTWORK URLs (with type metadata) ---
            const discEntries = [];
            const clearArtEntries = [];

            const parentTags = item._kefinParentTags || null;
            // Known tags: request by tag or skip. Unknown (lookup failed): blind, as before.
            const addParent = (list, type, kind, id) => {
                if (!id) return;
                const tags = parentTags && parentTags[id];
                if (!tags) list.push({ url: blindUrl(type, id), type: kind });
                else if (tags[type]) list.push({ url: tagUrl(type, tags[type], id), type: kind });
            };

            if (item.ImageTags?.Disc) discEntries.push({ url: tagUrl('Disc', item.ImageTags.Disc), type: 'disc' });
            addParent(discEntries, 'Disc', 'disc', item.ParentId);
            addParent(discEntries, 'Disc', 'disc', item.SeriesId);

            if (item.ImageTags?.Art) clearArtEntries.push({ url: tagUrl('Art', item.ImageTags.Art), type: 'clearart' });
            addParent(clearArtEntries, 'Art', 'clearart', item.ParentId);
            addParent(clearArtEntries, 'Art', 'clearart', item.SeriesId);

            const artEntries = FORCE_CLEARART
                ? [...clearArtEntries, ...discEntries]
                : [...discEntries, ...clearArtEntries];

            this.applyImage(this.overlayLogo, logoUrls);
            this.applyArtwork(artEntries);

            this.updateProgress();
        }

        // --------------------------------------------------
        //  IMAGE APPLICATION
        // --------------------------------------------------

        // --------------------------------------------------
        //  OVERVIEW RENDERING
        //
        //  Overviews arrive from the metadata provider and routinely carry
        //  markup - <br> between paragraphs, <i>/<b> emphasis. textContent
        //  printed those tags literally; innerHTML would render whatever the
        //  provider sent, scripts and all. So the markup is parsed in a detached
        //  document (DOMParser runs no scripts and fetches no resources) and
        //  rebuilt from a whitelist, dropping every attribute. Tags that aren't
        //  allowed lose the tag but keep their text, so an <a> or an unknown
        //  wrapper degrades to plain words rather than vanishing.
        // --------------------------------------------------

        renderOverview(el, raw) {
            const text = raw || '';
            el.replaceChildren();

            // No markup: render as text, but preserve the provider's line breaks -
            // they are real newlines, which HTML would otherwise collapse.
            if (!/<[a-z][\s\S]*>/i.test(text)) {
                el.classList.add('plain-text');
                el.textContent = text;
                return;
            }

            el.classList.remove('plain-text');
            const parsed = new DOMParser().parseFromString(text, 'text/html');
            el.appendChild(this.sanitizeNodes(parsed.body));
        }

        sanitizeNodes(root) {
            const frag = document.createDocumentFragment();

            root.childNodes.forEach((node) => {
                if (node.nodeType === Node.TEXT_NODE) {
                    frag.appendChild(document.createTextNode(node.nodeValue));
                    return;
                }
                if (node.nodeType !== Node.ELEMENT_NODE) return;   // comments, etc.
                if (OVERVIEW_DROP_TAGS.has(node.tagName)) return;   // contents too

                const inner = this.sanitizeNodes(node);
                if (OVERVIEW_ALLOWED_TAGS.has(node.tagName)) {
                    // Rebuilt fresh, so no attribute (style, onerror, href...) survives
                    const clean = document.createElement(node.tagName.toLowerCase());
                    clean.appendChild(inner);
                    frag.appendChild(clean);
                } else {
                    frag.appendChild(inner);                        // unwrap
                }
            });

            return frag;
        }

        applyImage(imgEl, urls) {
            if (!urls.length) {
                imgEl.style.display = 'none';
                return;
            }
            let idx = 0;
            const tryNext = () => {
                if (idx >= urls.length) {
                    imgEl.style.display = 'none';
                    return;
                }
                imgEl.style.display = 'block';
                imgEl.onerror = () => { idx++; tryNext(); };
                imgEl.src = urls[idx];
            };
            tryNext();
        }

        applyArtwork(artEntries) {
            if (!artEntries.length) {
                this.overlayDisc.style.display = 'none';
                return;
            }

            let idx = 0;
            const loadArt = () => {
                if (idx >= artEntries.length) {
                    this.overlayDisc.style.display = 'none';
                    return;
                }

                const entry = artEntries[idx];
                const isClearArt = entry.type === 'clearart';

                this.overlayDisc.style.display = 'block';

                this.overlayDisc.onerror = () => {
                    idx++;
                    loadArt();
                };

                this.overlayDisc.onload = () => {
                    this.layoutArtwork(isClearArt);
                };

                this.overlayDisc.crossOrigin = 'Anonymous';
                this.overlayDisc.src = entry.url;
            };

            loadArt();
        }

        // Full sizing + placement pass for the loaded artwork. Runs on load and
        // again on resize, always from a clean slate so nothing compounds.
        layoutArtwork(isClearArt) {
            const disc = this.overlayDisc;
            if (!disc.getAttribute('src') || disc.naturalWidth < 1) return;

            this._artIsClearArt = isClearArt;
            const s = disc.style;

            // Reset sizing overrides
            s.maxWidth  = '';
            s.height    = '';
            s.maxHeight = '';
            disc.style.removeProperty('--art-pos-left');

            if (isClearArt) {
                // ClearArt: skip expansion entirely, apply clearart defaults
                this.applyClearArtDefaults(s);
            } else {
                // Disc art: standard defaults + optional expansion
                s.bottom    = '0px';
                s.top       = 'auto';
                s.left      = 'var(--art-pos-left)';
                s.right     = 'auto';
                s.transform = 'translateX(-50%) translateZ(0)';

                if (ART_ENABLE_EXPAND) {
                    this.applyExpansion();
                }
            }

            if (ENABLE_SMART_CENTERING) {
                this.analyzeImageEdges(disc, isClearArt);
            }

            this.fitArtToViewport();

            // Runs last - it measures the real rects the passes above produced
            if (!isClearArt) this.applyOverlapExpansion();
        }

        // --------------------------------------------------
        //  VIEWPORT FIT (final safety pass)
        //
        //  Centered artwork sits at `center +/- width/2`, so a wide image or a
        //  raised max-width can push its right edge past the screen. Neither
        //  the plain max-width path nor the stretch path bounds that, so this
        //  runs last and enforces it for every placement:
        //
        //    1. Slide the center LEFT until the right edge clears the margin
        //       (the art grows into the empty left area first).
        //    2. Only once the art is too wide to fit at ANY position, shrink
        //       it to the widest size that fits between both margins.
        //
        //  Edge-anchored artwork (right: N) is pinned by definition and is
        //  left untouched.
        // --------------------------------------------------

        fitArtToViewport() {
            const disc = this.overlayDisc;
            const s = disc.style;
            if (!s.left || s.left === 'auto') return;

            const vwPx = window.innerWidth / 100;
            if (vwPx <= 0) return;

            const margin   = Math.max(0, ART_RIGHT_MARGIN);
            const maxFitVw = Math.max(1, 100 - margin * 2);

            let widthVw = disc.getBoundingClientRect().width / vwPx;
            if (!(widthVw > 0)) return;   // hidden (mobile breakpoint) or not laid out yet

            if (widthVw > maxFitVw) {
                // Too wide to fit anywhere. A full-height stretch has no width
                // bound at all, so drop back to bottom-anchored natural sizing
                // rather than letterboxing the art inside an oversized box.
                if (s.height === '100%') {
                    s.height    = '';
                    s.maxHeight = '';
                    s.top       = 'auto';
                    s.bottom    = '0px';
                }
                s.maxWidth = maxFitVw + 'vw';
                widthVw = Math.min(maxFitVw, disc.getBoundingClientRect().width / vwPx);
            }

            const current = parseFloat(getComputedStyle(disc).getPropertyValue('--art-pos-left'));
            const center  = Number.isFinite(current) ? current : ART_DEFAULT_CENTER;

            // width <= maxFitVw here, so minCenter <= maxCenter always holds
            const maxCenter = 100 - margin - widthVw / 2;
            const minCenter = margin + widthVw / 2;
            const fitted    = Math.max(minCenter, Math.min(center, maxCenter));

            if (Math.abs(fitted - center) > 0.01) {
                disc.style.setProperty('--art-pos-left', fitted + 'vw');
            }
        }

        // --------------------------------------------------
        //  CLEARART DEFAULT POSITIONING
        //
        //  Applied when smart centering is disabled, or as the
        //  base before edge detection overrides specific axes.
        //
        //  Negative offset values fall back to disc art defaults.
        // --------------------------------------------------

        applyClearArtDefaults(s) {
            s.top    = 'auto';
            s.bottom = 'auto';
            s.left   = 'auto';
            s.right  = 'auto';

            // Vertical: float above bottom (or disc-style bottom:0 if negative)
            if (CLEARART_BOTTOM_OFFSET >= 0) {
                s.bottom = CLEARART_BOTTOM_OFFSET + 'vh';
            } else {
                s.bottom = '0px';
            }

            // Horizontal: anchor to right edge (or disc-style centered if negative)
            let needsTranslateX = false;
            if (CLEARART_RIGHT_OFFSET >= 0) {
                s.right = CLEARART_RIGHT_OFFSET + 'vw';
            } else {
                s.left = 'var(--art-pos-left)';
                needsTranslateX = true;
            }

            s.transform = needsTranslateX
                ? 'translateX(-50%) translateZ(0)'
                : 'translateZ(0)';
        }

        // --------------------------------------------------
        //  CONDITIONAL ART EXPANSION (DISC ART ONLY)
        //
        //  Checks whether the image is "wide" - meaning it
        //  would hit max-width before max-height. If so, it's
        //  allowed to grow up to max-height instead, and the
        //  horizontal center shifts left so the right edge
        //  stays on screen.
        //
        //  Tall/square images are unaffected.
        //  Square detection uses ART_SQUARE_TOLERANCE (default 2%).
        //
        //  NOTE: This is NEVER called for ClearArt.
        // --------------------------------------------------

        applyExpansion() {
            const disc = this.overlayDisc;
            const natW = disc.naturalWidth;
            const natH = disc.naturalHeight;
            if (natW < 1 || natH < 1) return;

            const ratio = natW / natH;

            // Skip square images - they sit fine at default sizing
            if (ART_EXPAND_SKIP_SQUARE && Math.abs(ratio - 1) <= ART_SQUARE_TOLERANCE) return;

            // Convert config values to pixels for comparison
            const vwPx = window.innerWidth / 100;
            const vhPx = window.innerHeight / 100;
            const maxWPx = parseFloat(MAX_WIDTH_VAL) * vwPx;
            const maxHPx = parseFloat(MAX_HEIGHT_VAL) * vhPx;

            // What width would the image be if it filled max-height?
            const widthAtMaxH = ratio * maxHPx;

            // Only expand if the image is width-constrained
            // (it would hit max-width before max-height at default sizing)
            if (widthAtMaxH <= maxWPx) return;

            // Cap at the configured expansion limit
            const maxExpandPx = parseFloat(ART_MAX_EXPAND_WIDTH) * vwPx;
            const expandedPx  = Math.min(widthAtMaxH, maxExpandPx);
            const expandedWVw = expandedPx / vwPx;
            const halfWVw     = expandedWVw / 2;

            // Shift center left so right edge stays on screen
            // rightEdge = center + halfWidth <= 100 - margin
            const maxCenter = 100 - ART_RIGHT_MARGIN - halfWVw;
            const newCenter = Math.min(ART_DEFAULT_CENTER, maxCenter);

            // Safety: don't let the left edge go off-screen either
            // leftEdge = center - halfWidth >= margin
            // center >= halfWidth + margin
            const minCenter   = halfWVw + ART_RIGHT_MARGIN;
            const finalCenter = Math.max(minCenter, newCenter);

            // Apply expanded sizing via inline overrides
            disc.style.maxWidth = expandedWVw + 'vw';
            disc.style.setProperty('--art-pos-left', finalCenter + 'vw');
        }

        // --------------------------------------------------
        //  OVERLAP-AWARE EXPANSION (DISC ART ONLY)
        //
        //  Grows the art past the normal box ceilings when its opaque pixels
        //  leave the text elements (mostly) uncovered. Binary-searches the
        //  largest width whose opaque coverage of every protected element
        //  stays at or under ART_OVERLAP_MAX_PERCENT.
        //
        //  Runs only while the overlay is visible: inside a display:none
        //  overlay every rect measures 0x0, and showOverlay re-runs the
        //  layout anyway. Never shrinks below the size the earlier passes
        //  produced - it can only grow.
        // --------------------------------------------------

        applyOverlapExpansion() {
            if (!ART_OVERLAP_EXPAND) return;

            const disc = this.overlayDisc;
            const s = disc.style;

            if (this.overlay.getAttribute('aria-hidden') !== 'false') return;
            // Full-height stretch is already as large as it can get
            if (s.height === '100%') return;

            const natW = disc.naturalWidth;
            const natH = disc.naturalHeight;
            if (natW < 1 || natH < 1) return;

            const mask = this.getAlphaMask(disc);
            if (!mask) return;

            const vwPx = window.innerWidth / 100;
            const vhPx = window.innerHeight / 100;
            if (vwPx <= 0 || vhPx <= 0) return;

            const baseWidthVw = disc.getBoundingClientRect().width / vwPx;
            if (!(baseWidthVw > 0)) return;

            // Ceilings: the config caps, the viewport-fit band, and the
            // natural size (width:auto never upscales past it, so growing
            // the boxes further would change nothing).
            const margin = Math.max(0, ART_RIGHT_MARGIN);
            const ratio  = natW / natH;
            const capVw  = Math.min(
                parseFloat(ART_OVERLAP_MAX_WIDTH),
                100 - margin * 2,
                (parseFloat(ART_OVERLAP_MAX_HEIGHT) * vhPx * ratio) / vwPx,
                natW / vwPx
            );
            if (!(capVw > baseWidthVw + 0.5)) return;

            // Elements the art must not cover: logo, details, and the plot's
            // actual TEXT (the plot box is a fixed-height scroll area, so a
            // short plot would otherwise "protect" empty space below itself).
            // The progress bar and the corner buttons are intentionally
            // absent - art passing behind the bar is fine.
            const protectedRects = [
                this.overlayLogo.getBoundingClientRect(),
                this.overlayDetails.getBoundingClientRect(),
                this.getPlotTextRect(),
            ].filter(r => r && r.width > 0 && r.height > 0);

            const limit = Math.max(0, ART_OVERLAP_MAX_PERCENT) / 100;

            // Snapshot inline sizing so a failed search restores it exactly
            const prev = {
                maxWidth:  s.maxWidth,
                maxHeight: s.maxHeight,
                posLeft:   s.getPropertyValue('--art-pos-left'),
            };
            const resetCenter = () => {
                // fitArtToViewport slides the center left; without this reset
                // the slide would compound across candidate attempts
                if (prev.posLeft) s.setProperty('--art-pos-left', prev.posLeft);
                else s.removeProperty('--art-pos-left');
            };

            const tryWidth = (widthVw) => {
                resetCenter();
                s.maxWidth  = widthVw + 'vw';
                s.maxHeight = ART_OVERLAP_MAX_HEIGHT;
                this.fitArtToViewport();
                const rect = disc.getBoundingClientRect();
                for (const er of protectedRects) {
                    if (this.opaqueOverlapFraction(rect, er, mask) > limit) return false;
                }
                return true;
            };

            // Common case for sparse images: the cap itself passes
            if (tryWidth(capVw)) return;

            // Largest passing width between base and cap
            let lo = baseWidthVw;
            let hi = capVw;
            for (let i = 0; i < 6; i++) {
                const mid = (lo + hi) / 2;
                if (tryWidth(mid)) lo = mid;
                else hi = mid;
            }

            if (lo > baseWidthVw + 0.5) {
                tryWidth(lo);
            } else {
                // No meaningful growth possible - put the base sizing back
                resetCenter();
                s.maxWidth  = prev.maxWidth;
                s.maxHeight = prev.maxHeight;
                this.fitArtToViewport();
            }
        }

        // Tight rect around the plot's rendered text, clipped to the plot's
        // scroll box (long plots overflow it; the hidden part needs no
        // protection).
        getPlotTextRect() {
            const el = this.overlayPlot;
            const box = el.getBoundingClientRect();
            if (!(box.width > 0 && box.height > 0) || !el.firstChild) return null;
            const range = document.createRange();
            range.selectNodeContents(el);
            const r = range.getBoundingClientRect();
            const left   = Math.max(box.left,   r.left);
            const top    = Math.max(box.top,    r.top);
            const right  = Math.min(box.right,  r.right);
            const bottom = Math.min(box.bottom, r.bottom);
            if (right <= left || bottom <= top) return null;
            return { left, top, right, bottom, width: right - left, height: bottom - top };
        }

        // Downsampled opacity grid for the loaded artwork, cached per src.
        // Returns null when the canvas is tainted (CORS) - the overlap pass
        // just stays off for that image.
        getAlphaMask(imgElement) {
            const src = imgElement.currentSrc || imgElement.src;
            if (this._alphaMaskCache?.src === src) return this._alphaMaskCache.mask;

            let mask = null;
            try {
                const SIZE   = 64;
                const canvas = document.createElement('canvas');
                canvas.width  = SIZE;
                canvas.height = SIZE;
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                ctx.drawImage(imgElement, 0, 0, SIZE, SIZE);
                const data = ctx.getImageData(0, 0, SIZE, SIZE).data;
                const grid = new Uint8Array(SIZE * SIZE);
                for (let i = 0; i < grid.length; i++) {
                    grid[i] = data[i * 4 + 3] >= 32 ? 1 : 0;
                }
                mask = { size: SIZE, grid };
            } catch {
                mask = null;
            }

            this._alphaMaskCache = { src, mask };
            return mask;
        }

        // Fraction of elRect's area covered by OPAQUE art pixels. Samples a
        // 12x12 grid over the intersection; the img box maps 1:1 onto the
        // image (width/height are auto, so the box always has its aspect).
        opaqueOverlapFraction(artRect, elRect, mask) {
            const left   = Math.max(artRect.left,   elRect.left);
            const top    = Math.max(artRect.top,    elRect.top);
            const right  = Math.min(artRect.right,  elRect.right);
            const bottom = Math.min(artRect.bottom, elRect.bottom);
            if (right <= left || bottom <= top) return 0;
            if (artRect.width < 1 || artRect.height < 1) return 0;

            const N = 12;
            let opaque = 0;
            for (let j = 0; j < N; j++) {
                for (let i = 0; i < N; i++) {
                    const px = left + ((i + 0.5) / N) * (right - left);
                    const py = top  + ((j + 0.5) / N) * (bottom - top);
                    const u = Math.min(mask.size - 1, Math.floor(((px - artRect.left) / artRect.width)  * mask.size));
                    const v = Math.min(mask.size - 1, Math.floor(((py - artRect.top)  / artRect.height) * mask.size));
                    if (mask.grid[v * mask.size + u]) opaque++;
                }
            }
            const interArea = (right - left) * (bottom - top);
            const elArea    = elRect.width * elRect.height;
            return (opaque / (N * N)) * interArea / elArea;
        }

        // --------------------------------------------------
        //  SMART CENTERING - EDGE DETECTION
        //
        //  Checks three edges: top, bottom, right. Only the
        //  three 1px strips are rasterized - the full image is
        //  never drawn to a canvas.
        //
        //  For disc art:
        //    Uses var(--art-pos-left) which may have been
        //    overridden by applyExpansion on the element itself.
        //
        //  For clearart:
        //    When edges are transparent, uses CLEARART_BOTTOM_OFFSET
        //    and CLEARART_RIGHT_OFFSET instead of centering.
        //    Negative offset values fall back to normal centering.
        //    Opaque edges always snap to 0 regardless of art type.
        //
        //  VERTICAL RULES:
        //    Top + Bottom Opaque -> scale full height (top:0, bottom:0, height:100%)
        //    Top Opaque only     -> snap to top (top:0)
        //    Bottom Opaque only  -> snap to bottom (bottom:0)
        //    Neither             -> center vertically (or clearart offset)
        //
        //  HORIZONTAL RULES:
        //    Right Opaque  -> snap right (right:0)
        //    Right Clear   -> h-placement per type
        // --------------------------------------------------

        analyzeImageEdges(imgElement, isClearArt = false) {
            try {
                const w = imgElement.naturalWidth;
                const h = imgElement.naturalHeight;
                if (w < 10 || h < 10) return;

                const THRESHOLD = 230;

                // Rasterize a single 1px strip and check alpha (every 2nd pixel)
                const stripOpaque = (sx, sy, sw, sh) => {
                    const canvas  = document.createElement('canvas');
                    canvas.width  = sw;
                    canvas.height = sh;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(imgElement, sx, sy, sw, sh, 0, 0, sw, sh);
                    const data = ctx.getImageData(0, 0, sw, sh).data;
                    for (let i = 3; i < data.length; i += 8) {
                        if (data[i] >= THRESHOLD) return true;
                    }
                    return false;
                };

                const topOpaque    = stripOpaque(0, 0, w, 1);
                const bottomOpaque = stripOpaque(0, h - 1, w, 1);
                const rightOpaque  = stripOpaque(w - 1, 0, 1, h);

                const s = this.overlayDisc.style;
                s.left = 'auto'; s.right = 'auto'; s.top = 'auto'; s.bottom = 'auto';
                s.height = ''; s.maxHeight = '';

                // --- Determine vertical placement ---
                //  vMode: 'stretch' | 'top' | 'bottom' | 'center'
                let vMode = 'center';

                if (topOpaque && bottomOpaque) {
                    vMode = 'stretch';
                } else if (topOpaque) {
                    vMode = 'top';
                } else if (bottomOpaque) {
                    vMode = 'bottom';
                } else if (isClearArt && CLEARART_BOTTOM_OFFSET >= 0) {
                    vMode = 'bottom';         // clearart floats above bottom by offset
                }

                // --- Determine horizontal placement ---
                let useRight = false;
                let rightVal = '0px';
                let useLeft  = false;

                if (rightOpaque) {
                    useRight = true;
                    rightVal = '0px';
                } else if (isClearArt && CLEARART_RIGHT_OFFSET >= 0) {
                    useRight = true;
                    rightVal = CLEARART_RIGHT_OFFSET + 'vw';
                } else {
                    useLeft = true;
                }

                // --- Apply vertical ---
                switch (vMode) {
                    case 'stretch':
                        s.top       = '0px';
                        s.bottom    = '0px';
                        s.height    = '100%';
                        s.maxHeight = 'none';
                        s.maxWidth  = 'none';
                        break;
                    case 'top':
                        s.top = '0px';
                        break;
                    case 'bottom':
                        s.bottom = (bottomOpaque ? '0px'
                            : (isClearArt ? CLEARART_BOTTOM_OFFSET + 'vh' : '0px'));
                        break;
                    default: // center
                        s.top = '50%';
                        break;
                }

                // --- Apply horizontal ---
                if (useRight) {
                    s.right = rightVal;
                } else if (useLeft) {
                    s.left = 'var(--art-pos-left)';
                }

                // --- Build transform ---
                const needsTX = useLeft;
                const needsTY = (vMode === 'center');

                if (needsTX && needsTY) {
                    s.transform = 'translate(-50%, -50%) translateZ(0)';
                } else if (needsTX) {
                    s.transform = 'translateX(-50%) translateZ(0)';
                } else if (needsTY) {
                    s.transform = 'translateY(-50%) translateZ(0)';
                } else {
                    s.transform = 'translateZ(0)';
                }

            } catch (e) {
                // Canvas failed (CORS etc.) - apply safe defaults per type
                const s = this.overlayDisc.style;
                s.left = 'auto'; s.right = 'auto'; s.top = 'auto'; s.bottom = 'auto';
                s.height = ''; s.maxHeight = '';

                if (isClearArt) {
                    this.applyClearArtDefaults(s);
                } else {
                    s.bottom    = '0px';
                    s.left      = 'var(--art-pos-left)';
                    s.transform = 'translateX(-50%) translateZ(0)';
                }
            }
        }

        // --------------------------------------------------
        //  PROGRESS BAR
        // --------------------------------------------------

        updateProgress() {
            const { current, duration } = this.getPlayerProgress();
            this.setProgress(current, duration);
        }

        setProgress(current, duration) {
            const fill = this.progressBar.firstElementChild;
            const pct  = duration > 0 ? Math.max(0, Math.min(100, (current / duration) * 100)) : 0;
            fill.style.width = `${pct}%`;

            const timeEl       = this.progressMeta.querySelector('.progress-time');
            const percentageEl = this.progressMeta.querySelector('.progress-percentage');
            const endsAtEl     = this.progressMeta.querySelector('.progress-ends-at');

            if (timeEl) {
                timeEl.textContent = `${this.formatClock(current)} / ${this.formatClock(duration)}`;
            }
            if (percentageEl) {
                percentageEl.textContent = STR.watchedPercent(Math.round(pct));
            }
            if (endsAtEl) {
                if (duration > 0 && current < duration) {
                    const remaining = duration - current;
                    const endTime   = new Date(Date.now() + remaining * 1000);
                    const formatted = endTime.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
                    endsAtEl.textContent = STR.endsAt(formatted);
                } else {
                    endsAtEl.textContent = '';
                }
            }
        }

        // --------------------------------------------------
        //  FORMATTING
        // --------------------------------------------------

        formatRuntime(runTimeTicks) {
            if (!runTimeTicks) return '';
            const totalMinutes = Math.floor(runTimeTicks / 600000000);
            const hours   = Math.floor(totalMinutes / 60);
            const minutes = totalMinutes % 60;
            return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
        }

        formatClock(sec) {
            if (!isFinite(sec) || sec <= 0) return '0:00';
            const h = Math.floor(sec / 3600);
            const m = Math.floor((sec / 60) % 60);
            const s = Math.floor(sec % 60);
            const mStr = h > 0 ? String(m).padStart(2, '0') : String(m);
            const sStr = String(s).padStart(2, '0');
            return h > 0 ? `${h}:${mStr}:${sStr}` : `${mStr}:${sStr}`;
        }

        // --------------------------------------------------
        //  CLEANUP
        // --------------------------------------------------

        clearPauseTimer() {
            if (this.pauseScreenTimer) {
                clearTimeout(this.pauseScreenTimer);
                this.pauseScreenTimer = null;
            }
        }

        clearDisplayData() {
            this._artIsClearArt = null;
            this._itemLoaded    = false;
            this.overlayPlot.replaceChildren();
            this.overlayPlot.classList.remove('plain-text');
            this.overlayDetails.replaceChildren();
            this.overlayLogo.removeAttribute('src');
            this.overlayLogo.onerror = null;
            this.overlayLogo.style.display = 'none'; // inline block would beat :not([src])
            this.overlayDisc.removeAttribute('src');
            this.overlayDisc.onerror = null;
            this.overlayDisc.onload  = null;
            this.overlayDisc.style.display  = 'none';
            this.overlayDisc.style.maxWidth = '';
            this.overlayDisc.style.height    = '';
            this.overlayDisc.style.maxHeight = '';
            this.overlayDisc.style.removeProperty('--art-pos-left');
            // Reset positioning to CSS defaults
            this.overlayDisc.style.bottom    = '0';
            this.overlayDisc.style.top       = 'auto';
            this.overlayDisc.style.left      = 'var(--art-pos-left)';
            this.overlayDisc.style.right     = 'auto';
            this.overlayDisc.style.transform = 'translateX(-50%) translateZ(0)';
            this.setProgress(0, 0);
        }

        clearState() {
            this.hideOverlay();
            this.clearDisplayData();
            this.clearPauseTimer();
            this._stopExternalPoll();

            if (this.cleanupListeners) {
                this.cleanupListeners();
                this.cleanupListeners = null;
            }

            if (this.fetchAbort) {
                this.fetchAbort.abort();
                this.fetchAbort = null;
            }

            this.currentItemId      = null;
            this.currentVideo       = null;
            this.playerMode         = null;
            this._externalWasPaused = false;
            this._userDismissed     = false;
        }

        destroy() {
            this.clearState();

            if (this.observer) {
                this.observer.disconnect();
                this.observer = null;
            }

            if (this.observerThrottleId) {
                clearTimeout(this.observerThrottleId);
                this.observerThrottleId = null;
            }

            this.boundInteractionListeners.forEach(({ event, handler, capture }) => {
                document.removeEventListener(event, handler, { capture: !!capture });
            });
            this.boundInteractionListeners = [];

            if (this._keydownHandler) {
                document.removeEventListener('keydown', this._keydownHandler, { capture: true });
                this._keydownHandler = null;
            }

            if (this._hashChangeHandler) {
                window.removeEventListener('hashchange', this._hashChangeHandler);
                this._hashChangeHandler = null;
            }

            if (this._popStateHandler) {
                window.removeEventListener('popstate', this._popStateHandler);
                this._popStateHandler = null;
            }

            if (this._resizeHandler) {
                window.removeEventListener('resize', this._resizeHandler);
                this._resizeHandler = null;
            }

            if (this._resizeTimer) {
                clearTimeout(this._resizeTimer);
                this._resizeTimer = null;
            }

            this.itemCache.clear();

            if (this.overlay?.parentNode) {
                this.overlay.parentNode.removeChild(this.overlay);
            }
            const css = document.getElementById('pause-screen-style');
            if (css) css.remove();

            if (window.KefinTweaksPauseScreen === this) {
                window.KefinTweaksPauseScreen = null;
            }

            LOG('destroyed');
        }
    }

    // ---- Settings -> Display: a "Show pause screen" checkbox for each user.
    // Cloned from the page's own Blurhash row, the last one in its Display
    // section, so it takes that page's styling: emby-checkbox rows on the
    // legacy layout, React/MUI on Jellyfin 12's modern layout. ----
    (function registerDisplaySetting() {
        const ROW_CLASS = 'kefinPauseScreenSetting';
        const HELP_ID = 'kefin-pause-screen-description';
        const LABEL = 'Show pause screen';
        const HELP = 'After playback has been paused for a few seconds, show the title, plot and artwork over the video.';

        // A cloned MUI checkbox has no React behind it, so it has to draw its
        // own box: these are MUI's CheckBox and CheckBoxOutlineBlank icons.
        const MUI_ICONS = {
            checked:   ['CheckBoxIcon', 'M19 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.11 0 2-.9 2-2V5c0-1.1-.89-2-2-2zm-9 14l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z'],
            unchecked: ['CheckBoxOutlineBlankIcon', 'M19 5v14H5V5h14m0-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z']
        };

        function drawMuiBox(row, input) {
            row.querySelector('.MuiCheckbox-root')?.classList.toggle('Mui-checked', input.checked);
            const svg = row.querySelector('.MuiCheckbox-root svg');
            const [testId, d] = MUI_ICONS[input.checked ? 'checked' : 'unchecked'];
            svg?.setAttribute('data-testid', testId);
            svg?.querySelector('path')?.setAttribute('d', d);
        }

        function addRow(scope) {
            if (scope.querySelector('.' + ROW_CLASS)) return true;

            const legacyInput = scope.querySelector('#chkBlurhash');
            const modernHelp = scope.querySelector('#display-settings-blurhash-description');
            const source = legacyInput ? legacyInput.closest('.checkboxContainer')
                : modernHelp ? modernHelp.closest('.MuiFormControl-root') : null;
            const isMui = !legacyInput;
            if (!source) return false;

            const row = source.cloneNode(true);
            const input = row.querySelector('input[type="checkbox"]');
            if (!input) return false;
            row.classList.add(ROW_CLASS);
            // No name, so neither page's own Save picks it up
            input.removeAttribute('name');
            input.id = 'chkKefinPauseScreen';
            input.checked = isEnabledForUser();

            const label = row.querySelector('.checkboxLabel, .MuiFormControlLabel-label')
                || row.querySelector('label > span');
            if (label) label.textContent = LABEL;
            const help = row.querySelector('.fieldDescription, .MuiFormHelperText-root');
            if (help) {
                help.textContent = HELP;
                help.id = HELP_ID;
            }
            row.querySelector('[aria-describedby]')?.setAttribute('aria-describedby', HELP_ID);

            if (isMui) drawMuiBox(row, input);
            input.addEventListener('change', () => {
                setEnabledForUser(input.checked);
                if (isMui) drawMuiBox(row, input);
                LOG('pause screen ' + (input.checked ? 'enabled' : 'disabled') + ' for this user');
            });

            source.parentNode.insertBefore(row, source.nextSibling);
            return true;
        }

        function onViewShow(e) {
            if (!(window.location.hash || '').toLowerCase().includes('mypreferencesdisplay')) return;
            const scope = e?.target instanceof Element ? e.target : document;
            if (addRow(scope)) return;
            // The legacy page fills in its rows after viewshow
            const obs = new MutationObserver(() => {
                if (addRow(scope)) obs.disconnect();
            });
            obs.observe(scope, { childList: true, subtree: true });
            setTimeout(() => obs.disconnect(), 5000);
        }

        document.addEventListener('viewshow', onViewShow, true);
        onViewShow(); // the page may already be open when this script loads
    })();

    // ---- Feature configuration modal (the "Configure" button on the KefinTweaks
    // feature card). ModalSystem + KefinTweaksUtils.saveConfigToJavaScriptInjector.
    // Changes apply on next reload. ----
    (function registerConfigModal() {
        const MODAL_ID = 'kefin-pausescreen-config';

        function checkRow(key, checked, label, desc) {
            return '<div class="listItem" style="border:1px solid rgba(255,255,255,0.1);border-radius:4px;padding:0.75em;margin-bottom:1em;">'
                + '<div class="listItemContent">'
                + '<div class="listItemBodyText" style="margin-bottom:0.5em;">' + label + '</div>'
                + '<div class="listItemBodyText secondary" style="margin-bottom:0.75em;font-size:0.9em;">' + desc + '</div>'
                + '<label class="checkboxContainer" style="display:flex;align-items:center;gap:0.5em;">'
                + '<input type="checkbox" id="pauseScreen_' + key + '"' + (checked ? ' checked' : '') + '>'
                + '<span class="listItemBodyText">Enabled</span></label>'
                + '</div></div>';
        }

        function inputRow(key, value, label, desc, type, min, step) {
            return '<div class="listItem" style="border:1px solid rgba(255,255,255,0.1);border-radius:4px;padding:0.75em;margin-bottom:1em;">'
                + '<div class="listItemContent">'
                + '<div class="listItemBodyText" style="margin-bottom:0.5em;">' + label + '</div>'
                + '<div class="listItemBodyText secondary" style="margin-bottom:0.75em;font-size:0.9em;">' + desc + '</div>'
                + '<input type="' + type + '" id="pauseScreen_' + key + '" value="' + value + '"'
                + (min !== undefined ? ' min="' + min + '"' : '')
                + (step !== undefined ? ' step="' + step + '"' : '')
                + ' style="background:var(--theme-background);color:var(--theme-text-color);padding:.5em;border:1px solid rgba(255,255,255,0.2);border-radius:4px;width:100%;font-size:inherit;">'
                + '</div></div>';
        }

        function textRow(key, value, label, desc)          { return inputRow(key, value, label, desc, 'text'); }
        function numberRow(key, value, label, desc, min, step) { return inputRow(key, value, label, desc, 'number', min, step); }

        function sectionHeader(title) {
            return '<div style="margin:1.5em 0 0.5em;font-weight:bold;font-size:1.1em;">' + title + '</div>';
        }

        function buildConfigHTML(cfg) {
            const v = (key) => cfg[key] !== undefined ? cfg[key] : CONFIG[key];
            return '<div style="max-width:800px;">'
                + sectionHeader('Timing')
                + numberRow('PAUSE_DELAY_MS', v('PAUSE_DELAY_MS'), 'Pause Delay (ms)',
                    'How long playback must stay paused, with no mouse, touch or key input, before the pause screen appears.', 0, 250)
                + numberRow('ENDS_AT_REFRESH_MS', v('ENDS_AT_REFRESH_MS'), '"Ends at" Refresh Interval (ms)',
                    'How often the "Ends at" clock time is refreshed while the overlay is open, so long pauses don\'t show a stale time.', 5000, 1000)

                + sectionHeader('Layout & Text')
                + textRow('CONTENT_LEFT_EDGE', v('CONTENT_LEFT_EDGE'), 'Content Left Edge',
                    'Left margin for all text content (CSS length, e.g. 6vw).')
                + textRow('PLOT_WIDTH', v('PLOT_WIDTH'), 'Plot Width',
                    'Maximum width of the plot description (CSS length, e.g. 50vw).')
                + textRow('DETAILS_TOP', v('DETAILS_TOP'), 'Details Vertical Position',
                    'Vertical position of the year / rating / runtime row (CSS length, e.g. 40vh).')
                + textRow('PLOT_TOP', v('PLOT_TOP'), 'Plot Vertical Position',
                    'Vertical position of the plot text (CSS length, e.g. 50vh).')

                + sectionHeader('Logo')
                + textRow('LOGO_MIN_WIDTH', v('LOGO_MIN_WIDTH'), 'Logo Minimum Width', 'CSS length, e.g. 25vw.')
                + textRow('LOGO_MAX_WIDTH', v('LOGO_MAX_WIDTH'), 'Logo Maximum Width', 'CSS length, e.g. 50vw.')
                + textRow('LOGO_MAX_HEIGHT', v('LOGO_MAX_HEIGHT'), 'Logo Maximum Height', 'CSS length, e.g. 35vh.')

                + sectionHeader('Artwork (Disc & ClearArt)')
                + checkRow('FORCE_CLEARART', v('FORCE_CLEARART') === true, 'Prefer ClearArt',
                    'When enabled, ClearArt images are preferred over Disc art.')
                + checkRow('ENABLE_SMART_CENTERING', v('ENABLE_SMART_CENTERING') !== false, 'Smart Centering',
                    'Analyzes transparent image edges to decide placement (snap to opaque edges, center otherwise).')
                + checkRow('ENABLE_MIN_WIDTH', v('ENABLE_MIN_WIDTH') !== false, 'Enforce Minimum Artwork Width',
                    'Enforces the minimum width below on the artwork.')
                + textRow('MIN_WIDTH_VAL', v('MIN_WIDTH_VAL'), 'Artwork Minimum Width', 'CSS length, e.g. 25vw.')
                + textRow('MAX_WIDTH_VAL', v('MAX_WIDTH_VAL'), 'Artwork Maximum Width', 'Base max width before any expansion (CSS length in vw, e.g. 42vw).')
                + textRow('MAX_HEIGHT_VAL', v('MAX_HEIGHT_VAL'), 'Artwork Maximum Height', 'CSS length in vh, e.g. 75vh.')

                + sectionHeader('Disc Art')
                + numberRow('ART_DEFAULT_CENTER', v('ART_DEFAULT_CENTER'), 'Horizontal Anchor Point (vw)',
                    'Horizontal center position of the disc art, in vw units.', 0, 1)
                + numberRow('ART_RIGHT_MARGIN', v('ART_RIGHT_MARGIN'), 'Screen Edge Margin (vw)',
                    'Minimum gap between the artwork and the left/right screen edges, in vw units. If the art would overflow, it slides left to stay inside this margin, and only shrinks once it no longer fits at any position.', 0, 1)
                + checkRow('ART_ENABLE_EXPAND', v('ART_ENABLE_EXPAND') !== false, 'Expand Wide Disc Images',
                    'Allows wide disc images to grow past the base max width (the center shifts left so art never bleeds off-screen). Tall, square, and ClearArt images are never expanded.')
                + textRow('ART_MAX_EXPAND_WIDTH', v('ART_MAX_EXPAND_WIDTH'), 'Expansion Width Ceiling',
                    'Hard ceiling for the expanded width (CSS length in vw, e.g. 50vw).')
                + checkRow('ART_EXPAND_SKIP_SQUARE', v('ART_EXPAND_SKIP_SQUARE') !== false, 'Never Expand Square Images',
                    'Square images stay at default sizing.')
                + numberRow('ART_SQUARE_TOLERANCE', v('ART_SQUARE_TOLERANCE'), 'Square Detection Tolerance',
                    'Aspect ratio tolerance for treating an image as square (0.02 = 2%).', 0, 0.01)
                + checkRow('ART_OVERLAP_EXPAND', v('ART_OVERLAP_EXPAND') !== false, 'Overlap-Aware Expansion',
                    'Lets large images grow past the ceilings above as long as their opaque pixels stay off the text (e.g. a character render with a transparent upper-left). Coverage is checked against the actual image alpha, not its bounding box. The progress bar is never protected - artwork may pass behind it.')
                + numberRow('ART_OVERLAP_MAX_PERCENT', v('ART_OVERLAP_MAX_PERCENT'), 'Max Text Overlap (%)',
                    'Maximum percentage of each text element (logo, details, plot text) that opaque artwork pixels may cover. 0 bans any overlap with text.', 0, 1)
                + textRow('ART_OVERLAP_MAX_WIDTH', v('ART_OVERLAP_MAX_WIDTH'), 'Overlap Expansion Width Ceiling',
                    'Hard width ceiling for overlap-aware growth (CSS length in vw, e.g. 80vw).')
                + textRow('ART_OVERLAP_MAX_HEIGHT', v('ART_OVERLAP_MAX_HEIGHT'), 'Overlap Expansion Height Ceiling',
                    'Hard height ceiling for overlap-aware growth (CSS length in vh, e.g. 95vh).')

                + sectionHeader('ClearArt')
                + numberRow('CLEARART_BOTTOM_OFFSET', v('CLEARART_BOTTOM_OFFSET'), 'Bottom Offset (vh)',
                    'Distance above the screen bottom when the ClearArt\'s bottom edge is transparent. 0 = flush with the edge; negative = use default centering.', undefined, 1)
                + numberRow('CLEARART_RIGHT_OFFSET', v('CLEARART_RIGHT_OFFSET'), 'Right Offset (vw)',
                    'Distance from the right screen edge when the ClearArt\'s right edge is transparent. 0 = flush; negative = center instead.', undefined, 1)

                + sectionHeader('Advanced')
                + numberRow('ITEM_CACHE_MAX', v('ITEM_CACHE_MAX'), 'Item Metadata Cache Size',
                    'Maximum number of item metadata records kept in memory.', 1, 1)
                + '</div>';
        }

        function collectConfig() {
            const base = (window.KefinTweaksConfig && window.KefinTweaksConfig.pauseScreen) || {};
            const el = (key) => document.getElementById('pauseScreen_' + key);

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
                PAUSE_DELAY_MS:         Math.max(0, num('PAUSE_DELAY_MS', 5000)),
                ENDS_AT_REFRESH_MS:     Math.max(5000, num('ENDS_AT_REFRESH_MS', 30000)),
                CONTENT_LEFT_EDGE:      text('CONTENT_LEFT_EDGE'),
                PLOT_WIDTH:             text('PLOT_WIDTH'),
                DETAILS_TOP:            text('DETAILS_TOP'),
                PLOT_TOP:               text('PLOT_TOP'),
                LOGO_MIN_WIDTH:         text('LOGO_MIN_WIDTH'),
                LOGO_MAX_WIDTH:         text('LOGO_MAX_WIDTH'),
                LOGO_MAX_HEIGHT:        text('LOGO_MAX_HEIGHT'),
                FORCE_CLEARART:         check('FORCE_CLEARART'),
                ENABLE_SMART_CENTERING: check('ENABLE_SMART_CENTERING'),
                ENABLE_MIN_WIDTH:       check('ENABLE_MIN_WIDTH'),
                MIN_WIDTH_VAL:          text('MIN_WIDTH_VAL'),
                MAX_WIDTH_VAL:          text('MAX_WIDTH_VAL'),
                MAX_HEIGHT_VAL:         text('MAX_HEIGHT_VAL'),
                ART_DEFAULT_CENTER:     num('ART_DEFAULT_CENTER', 78),
                ART_RIGHT_MARGIN:       num('ART_RIGHT_MARGIN', 1),
                ART_ENABLE_EXPAND:      check('ART_ENABLE_EXPAND'),
                ART_MAX_EXPAND_WIDTH:   text('ART_MAX_EXPAND_WIDTH'),
                ART_EXPAND_SKIP_SQUARE: check('ART_EXPAND_SKIP_SQUARE'),
                ART_SQUARE_TOLERANCE:   Math.max(0, num('ART_SQUARE_TOLERANCE', 0.02)),
                ART_OVERLAP_EXPAND:      check('ART_OVERLAP_EXPAND'),
                ART_OVERLAP_MAX_PERCENT: Math.max(0, num('ART_OVERLAP_MAX_PERCENT', 0)),
                ART_OVERLAP_MAX_WIDTH:   text('ART_OVERLAP_MAX_WIDTH'),
                ART_OVERLAP_MAX_HEIGHT:  text('ART_OVERLAP_MAX_HEIGHT'),
                CLEARART_BOTTOM_OFFSET: num('CLEARART_BOTTOM_OFFSET', 4),
                CLEARART_RIGHT_OFFSET:  num('CLEARART_RIGHT_OFFSET', -1),
                ITEM_CACHE_MAX:         Math.max(1, num('ITEM_CACHE_MAX', 50))
            });
        }

        async function saveConfig(newCfg) {
            try {
                if (!window.KefinTweaksConfig) window.KefinTweaksConfig = {};
                window.KefinTweaksConfig.pauseScreen = newCfg;
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
                const cfg = (window.KefinTweaksConfig && window.KefinTweaksConfig.pauseScreen) || {};
                const content = document.createElement('div');
                content.innerHTML = buildConfigHTML(cfg);

                const footer = document.createElement('div');
                footer.style.cssText = 'display:flex;gap:0.75em;justify-content:flex-end;';
                footer.innerHTML = '<button class="emby-button raised" onclick="window.ModalSystem.close(\'' + MODAL_ID + '\')">Close</button>'
                    + '<button class="emby-button raised block button-submit" id="save-pausescreen-config-btn">Save</button>';

                const modalInstance = window.ModalSystem.create({
                    id: MODAL_ID,
                    title: 'Pause Screen Configuration',
                    content: content,
                    footer: footer,
                    closeOnBackdrop: true,
                    closeOnEscape: true,
                    showCloseButton: true,
                    onOpen: (modal) => {
                        const saveBtn = modal.dialogFooter.querySelector('#save-pausescreen-config-btn');
                        if (saveBtn) {
                            saveBtn.addEventListener('click', async () => {
                                const ok = await saveConfig(collectConfig());
                                if (ok) {
                                    if (window.KefinTweaksToaster && window.KefinTweaksToaster.toast) {
                                        window.KefinTweaksToaster.toast('Pause Screen configuration saved! Reload to apply.');
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
        window.KefinTweaksFeatureConfigs.pauseScreen = { openConfigModal: openConfigModal };
    })();

    // Double-injection guard: destroy any previous instance first
    if (window.KefinTweaksPauseScreen && typeof window.KefinTweaksPauseScreen.destroy === 'function') {
        try { window.KefinTweaksPauseScreen.destroy(); } catch { /* ignore */ }
    }
    window.KefinTweaksPauseScreen = new JellyfinPauseScreen();
    LOG('initialized');

})();
