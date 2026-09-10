// KefinTweaks Script Injector
// Dynamically loads scripts and CSS files based on user configuration
// Usage: Configuration is now managed in kefinTweaks.js - this script reads from window.KefinTweaksConfig

(function() {
    'use strict';

    // ---- Console client gate ----------------------------------------------
    // Game consoles run the Jellyfin web client inside a locked-down WebView on
    // hardware with a fraction of a desktop browser's CPU and memory, driven by a
    // gamepad rather than a pointer. The KefinTweaks payload -- dozens of scripts,
    // a skin, observers and caches -- is more than that hardware carries well, and
    // several features assume hover. So load nothing at all there and leave the
    // stock client in place.
    //
    // Escape hatches, in precedence order:
    //   localStorage 'kefinTweaks.allowConsole' = '1'  -- per device, for testing
    //   config `disableOnConsoles: false`              -- server-wide opt-in
    function isConsoleClient() {
        // Xbox (UWP WebView), PlayStation 3/4/5/Vita, Nintendo Switch/Wii U.
        const CONSOLE_UA = /\bXbox\b|PlayStation|PLAYSTATION|\bNintendo\b|WiiU|NintendoBrowser/i;
        if (CONSOLE_UA.test(navigator.userAgent || '')) {
            return true;
        }
        // Fall back to the device name Jellyfin itself reports, which covers
        // wrappers whose UA says nothing useful ("Xbox One", "PlayStation 5", ...).
        try {
            const device = (window.ApiClient && typeof ApiClient.deviceName === 'function')
                ? ApiClient.deviceName() : '';
            if (/xbox|playstation|nintendo/i.test(device || '')) {
                return true;
            }
        } catch (e) { /* ApiClient not ready; the UA test above is the answer */ }
        return false;
    }

    try {
        if (localStorage.getItem('kefinTweaks.allowConsole') !== '1'
            && window.KefinTweaksConfig?.disableOnConsoles !== false
            && isConsoleClient()) {
            console.log('[KefinTweaks Injector] Console client detected - KefinTweaks will not load.');
            return;
        }
    } catch (e) { /* localStorage can throw in a sandboxed WebView; carry on */ }

    console.log('[KefinTweaks Injector] Initializing...');    
    // Cache for resolved root URL (to avoid multiple API calls)
    let resolvedRootCache = null;
    
    /**
     * Extracts version string from root URL
     * @param {string} root - The root URL (e.g., "https://cdn.jsdelivr.net/gh/ranaldsgift/KefinTweaks@v0.3.3/")
     * @returns {string} Version string (e.g., "0.3.3", "latest", "development", or commit hash)
     */
    function extractVersionFromRoot(root) {
        if (!root) {
            return "Pending Install"; // Fallback
        }
        
        // Match version patterns: @commitHash, @latest, @main, @experimental, or @v0.3.3
        // Note: check for hash first to avoid partial numeric matches (e.g. hash starting with digits)
        const versionMatch = root.match(/@([a-f0-9]{7,}|latest|main|experimental|v?[\d.]+)/i);
        
        if (versionMatch) {
            const version = versionMatch[1];
            
            // Handle version tags (v0.3.3 -> 0.3.3)
            if (version.startsWith('v') && /^\d+\.\d+\.\d+/.test(version.substring(1))) {
                return version.substring(1); // Remove 'v' prefix
            }
            
            // Handle @main -> "development"
            if (version.toLowerCase() === 'main') {
                return 'development';
            }
            
            // Handle @experimental -> "experimental"
            if (version.toLowerCase() === 'experimental') {
                return 'experimental';
            }
            
            // Handle @latest -> "latest"
            if (version.toLowerCase() === 'latest') {
                return 'latest';
            }
            
            // Handle commit hash -> show as "Dev (#hash)"
            if (/^[a-f0-9]{7,}$/i.test(version)) {
                return `Dev (#${version.substring(0, 7)})`;
            }
            
            // Return as-is for other patterns
            return version;
        }
        
        // No version found in URL, this is a custom install
        return "Custom Install";
    }
    
    // ---- Engine detection -------------------------------------------------
    // Several KefinTweaks optimisations target costs specific to Blink: its style
    // recalculation is single-threaded and serialised on the same thread that runs
    // JS and fires IntersectionObservers, whereas Gecko computes style in parallel
    // across cores (Stylo). Some of those optimisations are a net NEGATIVE outside
    // Blink — content-visibility trades image pre-load lead time for lower style
    // cost, which is a bad trade when style was never the bottleneck.
    //
    // Publish the engine as a class on <html> so both CSS and JS can gate on it.
    // Set as early as possible (before any skin CSS loads) so gated rules apply on
    // the first paint and cannot cause a layout shift by arriving late.
    const IS_BLINK = (function () {
        try {
            const brands = navigator.userAgentData && navigator.userAgentData.brands;
            if (Array.isArray(brands)) {
                // Chromium-based engines always list "Chromium" among their brands.
                return brands.some(b => b && b.brand === 'Chromium');
            }
        } catch (e) { /* userAgentData unavailable; fall through to UA sniffing */ }
        const ua = (navigator.userAgent || '');
        // Covers Chrome, Edge, Opera, Brave, Vivaldi, Helium, etc. Excludes Firefox
        // family; Safari/WebKit does not match either, which is intended — it is a
        // different engine with different costs.
        return /Chrome|Chromium|CriOS|Edg|OPR/.test(ua) && !/Firefox|FxiOS/.test(ua);
    })();

    window.KefinTweaksIsBlink = IS_BLINK;
    if (IS_BLINK && document.documentElement) {
        document.documentElement.classList.add('kefin-blink');
    }

    // Configuration: Start with defaults, then merge user config
    // This allows new scripts to work out of the box without requiring config updates
    const ENABLED_SCRIPTS = {
        // UI and functional enhancements
        watchlist: true,          // Watchlist functionality
        homeScreen: true,         // Custom home screen sections
        search: true,             // Enhanced search functionality
        headerTabs: true,         // Header tab enhancements
        customMenuLinks: true,    // Custom menu links functionality
        updoot: false,             // Upvote functionality
        backdropLeakFix: true,    // Memory leak fixes
        dashboardButtonFix: true, // Dashboard button fix
        infiniteScroll: true,     // Infinite scroll functionality
        removeContinue: true,     // Remove from continue watching functionality
        subtitleSearch: true,     // Subtitle search functionality
        playlist: true,           // Playlist view page modifications
        itemDetailsCollections: true, // Add related collections to item details pages
        flattenSingleSeasonShows: true, // Flatten series with only 1 season to show episodes directly
        seriesInfo: true,         // Add series and season information to details pages
        collections: true,         // Collection sorting functionality
        skinManager: true,        // Skin selection and management
        thumbnailScrubber: false,  // Trickplay thumbnail scrub on hover (bottom 20px of video cards)
        themeMediaCastFix: true,  // Theme media playback while a remote/cast target is connected
        castSessionWatchdog: true, // Re-subscribe the Sessions feed when a stale now playing bar shows a dead cast target
        pauseScreen: true,        // Rich pause screen overlay (logo, plot, artwork, progress)
        osdLogo: true,            // Media logo/ClearArt on the video OSD
        elegantfinHaspatch: true, // ElegantFin :has() hotfix marker classes (needs the local ElegantFin build)
        mediaTags: true,          // Add a Tags row to the item-details metadata table
        episodeSeasonTitle: true, // Season title/logo on episode headers + season-page logo links to series
        jeSidebarMemo: true,      // Memoise Jellyfin Enhanced's getSidebarContainer (forced style flush on every DOM mutation)
        jeSpoilerGuardScope: true, // Scope Jellyfin Enhanced's Spoiler Guard image refresh to the item that changed
        collectionStudios: true,  // Show the Studios row on collection (BoxSet) detail pages
        collectionSpecialNames: true, // Drop the "Special - " prefix from titles on collection pages
        
        // Note: Core functionality scripts (utils, cardBuilder, localStorageCache, modal) 
        // are automatically enabled when needed by other scripts
        
        // Merge user config on top of defaults (allows users to override defaults)
        ...window.KefinTweaksConfig?.scripts
    };
    
    // Script definitions with dependencies and metadata
    const SCRIPT_DEFINITIONS = [
        {
            name: 'utils',
            script: 'utils.js',
            css: null,
            dependencies: [],
            description: 'Common utilities for page view management and MutationObserver conversion'
        },
        {
            name: 'skinConfigLegacyDefaults',
            script: 'skinConfig-0.3.5-defaults.js',
            css: null,
            dependencies: [],
            description: 'Legacy skin defaults (v0.3.5) for duplicate detection'
        },
        {
            name: 'skinConfig',
            script: 'skinConfig.js',
            css: null,
            dependencies: [],
            description: 'Default skin configuration for KefinTweaks'
        },
        {
            name: 'ui',
            script: 'ui.js',
            css: null,
            dependencies: [],
            description: 'UI helper functions for KefinTweaks'
        },
        {
            name: 'homeScreenConfig',
            script: 'homeScreenConfig.js',
            css: null,
            dependencies: [],
            description: 'Default home screen configuration for KefinTweaks'
        },
        {
            name: 'homeScreenConfig2',
            script: 'homeScreenConfig2.js',
            css: null,
            dependencies: [],
            description: 'Default home screen configuration for KefinTweaks'
        },
        {
            name: 'homeScreen-migration',
            script: '../configuration/homeScreen-migration.js',
            css: null,
            dependencies: [],
            description: 'Home screen migration for KefinTweaks'
        },
        {
            name: 'homeScreen-configuration',
            script: '../configuration/homeScreen-configuration.js',
            css: '../configuration/homeScreen-configuration.css',
            dependencies: ['modal', 'toaster', 'utils', 'cardBuilder', 'ui'],
            description: 'Home screen configuration for KefinTweaks'
        },
        {
            name: 'search-configuration',
            script: '../configuration/search-configuration.js',
            css: null,
            dependencies: ['modal', 'toaster', 'utils'],
            description: 'Search configuration for KefinTweaks'
        },
        {
            name: 'seriesEpisodes-configuration',
            script: '../configuration/seriesEpisodes-configuration.js',
            css: null,
            dependencies: ['modal', 'toaster', 'utils'],
            description: 'Series episodes configuration for KefinTweaks'
        },
        {
            name: 'seriesInfo-configuration',
            script: '../configuration/seriesInfo-configuration.js',
            css: null,
            dependencies: ['modal', 'toaster', 'utils'],
            description: 'Series info configuration for KefinTweaks'
        },
        {
            name: 'skinManager-configuration',
            script: '../configuration/skinManager-configuration.js',
            css: null,
            dependencies: ['modal', 'toaster', 'utils'],
            description: 'Skin manager configuration for KefinTweaks'
        },
        {
            name: 'customMenuLinks-configuration',
            script: '../configuration/customMenuLinks-configuration.js',
            css: null,
            dependencies: ['modal', 'toaster', 'utils'],
            description: 'Custom menu links configuration for KefinTweaks'
        },
        {
            name: 'homeScreenConfigCommunity',
            script: 'homeScreenConfig-community.js',
            css: null,
            dependencies: [],
            description: 'Community home screen sections for KefinTweaks'
        },
        {
            name: 'peopleCache',
            script: 'peopleCache.js',
            css: null,
            dependencies: [],
            description: 'People cache for KefinTweaks'
        },
        {
            name: 'studiosCache',
            script: 'studiosCache.js',
            css: null,
            dependencies: [],
            description: 'Studios cache for KefinTweaks'
        },
        {
            name: 'moviesCache',
            script: 'moviesCache.js',
            css: null,
            dependencies: [],
            description: 'Movies cache for KefinTweaks'
        },
        {
            name: 'skinManager',
            script: 'skinManager.js',
            css: 'defaultSkin.css',
            dependencies: ['utils', 'skinConfigLegacyDefaults', 'skinConfig', 'modal'],
            priority: true, // Load immediately after dependencies to reduce UI disruption
            description: 'Adds skin selection dropdown to display preferences page and manages skin CSS loading'
        },
        {
            name: 'apiHelper',
            script: 'apiHelper.js',
            css: null,
            dependencies: ['dataHelper'],
            description: 'API helper functions for common Jellyfin operations'
        },
        {
            name: 'cardBuilder',
            script: 'cardBuilder.js',
            css: 'cardBuilder.css',
            dependencies: ['apiHelper', 'userHelper'],
            description: 'Core card building functionality (required by other scripts)'
        },
        {
            name: 'localStorageCache',
            script: 'localStorageCache.js',
            css: null,
            dependencies: [],
            description: 'localStorage-based caching layer with 24-hour TTL and manual refresh'
        },
        {
            name: 'indexedDBCache',
            script: 'indexedDBCache.js',
            css: null,
            dependencies: [],
            description: 'IndexedDB-based caching layer for large datasets with TTL support'
        },
        {
            name: 'modal',
            script: 'modal.js',
            css: 'modal.css',
            dependencies: [],
            description: 'Generic modal system for Jellyfin-style dialogs'
        },
        {
            name: 'userHelper',
            script: 'userHelper.js',
            css: null,
            dependencies: [],
            description: 'User helper functions for Jellyfin operations'
        },
        {
            name: 'dataHelper',
            script: '../helpers/dataHelper.js',
            css: null,
            dependencies: [],
            description: 'Data helper functions for Jellyfin operations'
        },
        {
            name: 'websocketHelper',
            script: '../helpers/websocketHelper.js',
            css: null,
            dependencies: [],
            description: 'WebSocket helper functions for Jellyfin operations'
        },
        {
            name: 'toaster',
            script: 'toaster.js',
            css: null,
            dependencies: [],
            description: 'Toast notification system using Jellyfin\'s existing toast functionality'
        },
        {
            name: 'watchlist',
            script: 'watchlist.js',
            css: 'watchlist.css',
            dependencies: ['cardBuilder', 'localStorageCache', 'modal', 'utils'],
            description: 'Adds watchlist functionality throughout Jellyfin interface'
        },
        {
            name: 'homeScreen',
            script: 'homeScreen3.js',
            css: 'homeScreen.css',
            dependencies: ['cardBuilder', 'localStorageCache', 'utils', 'homeScreenConfig2', 'homeScreen-configuration', 'peopleCache', 'studiosCache', 'moviesCache', 'indexedDBCache', 'homeScreenConfigCommunity', 'dataHelper', 'apiHelper', 'homeScreen-migration', 'homeScreen-user-configuration'],
            priority: true, // Load immediately after dependencies to reduce UI disruption
            description: 'Adds custom home screen sections'
        },
        {
            name: 'search',
            script: 'search.js',
            css: 'search.css',
            dependencies: ['cardBuilder', 'utils'],
            description: 'Enhanced search functionality'
        },
        {
            name: 'headerTabs',
            script: 'headerTabs.js',
            css: null,
            dependencies: [],
            description: 'Header tab improvements'
        },
        {
            name: 'customMenuLinks',
            script: 'customMenuLinks.js',
            css: null,
            dependencies: ['utils'],
            description: 'Load and add custom menu links from configuration'
        },
        {
            name: 'backdropLeakFix',
            script: 'backdropLeakFix.js',
            css: null,
            dependencies: [],
            description: 'Fixes issue that causes backdrop images to be continuously added to the page if the tab isn\'t focused.'
        },
        {
            name: 'elegantfinHaspatch',
            script: 'elegantfin-haspatch.js',
            css: null,
            dependencies: ['utils'],
            description: 'Maintains the .ef-* marker classes that replace the Chromium-hot :has() selectors in the local ElegantFin build.'
        },
        {
            name: 'jeSidebarMemo',
            script: 'jeSidebarMemo.js',
            css: null,
            dependencies: [],
            description: "Memoises Jellyfin Enhanced's getSidebarContainer(), which reads offsetParent (a forced full-document style flush) on every body mutation. Measured at 3.2s of style recalc across 104 calls when navigating into a series page. No-ops if Jellyfin Enhanced is absent."
        },
        {
            name: 'collectionStudios',
            script: 'collectionStudios.js',
            css: null,
            dependencies: ['utils'],
            description: "Shows the Studios row on a collection (BoxSet) detail page. jellyfin-web's renderStudio returns early for BoxSet and Playlist, so the row is built but left empty and hidden however few studios the collection has. This fills it in from item.Studios and removes the hide."
        },
        {
            name: 'collectionSpecialNames',
            script: 'collectionSpecialNames.js',
            css: null,
            dependencies: ['utils'],
            description: "Removes the \"Special - \" prefix jellyfin-web prepends to every season-0 episode title, on collection detail pages only. Reads each item's real Name from the API rather than stripping a string, so it is correct in any server language, and leaves Continue Watching, Next Up and season pages untouched."
        },
        {
            name: 'jeSpoilerGuardScope',
            script: 'jeSpoilerGuardScope.js',
            css: null,
            dependencies: ['websocketHelper'],
            priority: true, // Must claim the plugin's watched-refresh hook before its Spoiler Guard boots
            description: "Scopes Jellyfin Enhanced's Spoiler Guard image refresh to the items whose watched state changed. As shipped it rewrites the URL of every Jellyfin image in the document after any mark-played, which makes all card artwork and the detail-page backdrop reload at once. No-ops if Jellyfin Enhanced or Spoiler Guard is absent."
        },
        {
            name: 'updoot',
            script: 'updoot.js',
            css: null,
            dependencies: [],
            description: 'Upvote functionality provided by https://github.com/BobHasNoSoul/jellyfin-updoot'
        },
        {
            name: 'dashboardButtonFix',
            script: 'dashboardButtonFix.js',
            css: null,
            dependencies: [],
            description: 'Fixes the dashboard button to redirect to the home page when the back button is clicked and there is no history to go back to'
        },
        {
            name: 'thumbnailScrubber-configuration',
            script: '../configuration/thumbnailScrubber-configuration.js',
            css: null,
            dependencies: ['modal', 'toaster', 'utils'],
            description: 'Thumbnail scrubber configuration for KefinTweaks'
        },
        {
            name: 'thumbnailScrubber',
            script: 'thumbnailScrubber.js',
            css: null,
            dependencies: ['thumbnailScrubber-configuration'],
            description: 'Shows trickplay thumbnail preview when hovering in the bottom 20px of a video card for 2+ seconds'
        },
        {
            name: 'infiniteScroll',
            script: 'infiniteScroll.js',
            css: null,
            dependencies: ['cardBuilder'],
            description: 'Adds infinite scroll functionality to media library pages'
        },
        {
            name: 'removeContinue',
            script: 'removeContinue.js',
            css: null,
            dependencies: [],
            description: 'Adds remove from continue watching functionality to cards with data-position-ticks'
        },
        {
            name: 'subtitleSearch',
            script: 'subtitleSearch.js',
            css: 'subtitleSearch.css',
            dependencies: ['toaster'],
            description: 'Adds subtitle search functionality to the video OSD, allowing users to search and download subtitles from remote sources'
        },
        {
            name: 'breadcrumbs',
            script: 'breadcrumbs.js',
            css: 'breadcrumbNav.css',
            dependencies: ['utils'],
            description: 'Adds breadcrumb navigation to item detail pages for Movies, Series, Seasons, Episodes, Music Artists, and Music Albums'
        },
        {
            name: 'playlist',
            script: 'playlist.js',
            css: null,
            dependencies: ['cardBuilder', 'utils', 'modal'],
            description: 'Modifies playlist view page behavior to navigate to item details instead of playing, adds play button to playlist items, and adds sorting functionality'
        },
        {
            name: 'itemDetailsCollections',
            script: 'itemDetailsCollections.js',
            css: null,
            dependencies: ['indexedDBCache', 'utils', 'cardBuilder'],
            description: 'Adds related collections to item details pages showing which collections contain the current item'
        },
        {
            name: 'mediaTags',
            script: 'mediaTags.js',
            css: null,
            dependencies: ['utils'],
            description: 'Adds a Tags row to the item-details metadata table, matching the Genres/Studios rows.'
        },
        {
            name: 'episodeSeasonTitle',
            script: 'episodeSeasonTitle.js',
            css: null,
            dependencies: ['utils'],
            description: "Season title/logo on episode headers, and a season-page logo that links to the series."
        },
        {
            name: 'flattenSingleSeasonShows',
            script: 'seriesEpisodes.js',
            css: 'seriesEpisodes.css',
            dependencies: ['cardBuilder', 'utils'],
            description: 'Displays episodes directly on series page with season selection. Works for both single and multi-season shows when enabled.'
        },
        {
            name: 'seriesInfo',
            script: 'seriesInfo.js',
            css: null,
            dependencies: ['utils'],
            description: 'Adds series and season information (seasons count, episodes count, end time) to details pages'
        },
        {
            name: 'collections',
            script: 'collections.js',
            css: null,
            dependencies: ['utils', 'modal'],
            description: 'Adds sorting functionality to collection pages'
        },
        {
            name: 'themeMediaCastFix',
            script: 'themeMediaCastFix.js',
            css: null,
            dependencies: [],
            description: 'Restores theme song/video playback in the web client while a remote/cast player (e.g. mpv-shim) is the selected target.'
        },
        {
            name: 'castSessionWatchdog',
            script: 'castSessionWatchdog.js',
            css: null,
            dependencies: [],
            description: 'Re-subscribes the Sessions WebSocket feed when it goes silent while the now playing bar is up, so a cast target that stopped playing cannot leave a frozen seek bar on screen.'
        },
        {
            name: 'pauseScreen',
            script: 'pauseScreen.js',
            css: null,
            dependencies: [],
            description: 'Shows a rich overlay (logo, plot, details, disc/clear art, progress) when playback is paused for a few seconds. Supports the HTML5 player and external players (mpv-shim etc.).'
        },
        {
            name: 'osdLogo',
            script: 'osdLogo.js',
            css: null,
            dependencies: [],
            description: 'Shows the media\'s logo (or ClearArt) on the video OSD while playback controls are visible, with optional transparency trimming and OSD shadows.'
        },
    ];

    // Use this for development
    const urlSuffix = '';
    //const urlSuffix = `?v=${new Date().getTime()}`;

    // Inject dashboard drawer version badge CSS using dynamic version number
    async function injectVersionBadgeCSS() {
        const styleId = 'kefinTweaks-version-css';
        if (document.getElementById(styleId)) return;
        
        // Get version from root URL in config
        let displayVersion = "";
        try {
            const configRoot = window.KefinTweaksConfig?.kefinTweaksRoot || '';
            if (configRoot) {
                // Resolve the root to get the actual version (if @latest or @main)
                const resolvedRoot = await resolveRootVersion(configRoot);
                displayVersion = extractVersionFromRoot(resolvedRoot);
            }
        } catch (error) {
            console.warn('[KefinTweaks Injector] Could not extract version, using fallback:', error);
        }
        
        // Format version for display (add 'v' prefix if it's a version number, not for 'latest' or 'development')
        let versionDisplay = displayVersion;
        if (!displayVersion.startsWith('v') && 
            !displayVersion.includes('latest') && 
            !displayVersion.includes('development') &&
            /^\d+\.\d+/.test(displayVersion)) {
            versionDisplay = 'v' + displayVersion;
        }
        
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
            body:not(:has(.libraryPage:not(.hide))) .MuiPaper-root.MuiDrawer-paperAnchorLeft::after {
                content: 'KefinTweaks ${versionDisplay}';
                font-style: italic;
                text-align: center;
                margin-top: 10px;
                color: #b7b7b7;
                font-size: 0.9em;
                display: block;
            }
            `;
        document.head.appendChild(style);
    }

    // Auto-enable dependencies for enabled scripts (iteratively to handle transitive dependencies)
    function autoEnableDependencies() {
        let hasChanges = false;
        let maxIterations = 10; // Prevent infinite loops
        let iterations = 0;
        
        // Keep running until no more dependencies need to be enabled
        while (iterations < maxIterations) {
            let iterationChanges = false;
            
            SCRIPT_DEFINITIONS.forEach(script => {
                if (ENABLED_SCRIPTS[script.name]) {
                    script.dependencies.forEach(dep => {
                        if (!ENABLED_SCRIPTS[dep]) {
                            ENABLED_SCRIPTS[dep] = true;
                            iterationChanges = true;
                            hasChanges = true;
                            console.log(`[KefinTweaks Injector] Auto-enabled dependency '${dep}' for '${script.name}'`);
                        }
                    });
                }
            });
            
            if (!iterationChanges) {
                break; // No more dependencies to enable
            }
            
            iterations++;
        }
        
        if (iterations >= maxIterations) {
            console.warn('[KefinTweaks Injector] Reached max iterations while auto-enabling dependencies');
        }
        
        return hasChanges;
    }
    
    // Configuration validation
    function validateConfiguration() {
        const errors = [];
        
        // Auto-enable dependencies first
        const dependenciesEnabled = autoEnableDependencies();
        if (dependenciesEnabled) {
            console.log('[KefinTweaks Injector] Auto-enabled required dependencies');
        }
        
        // Check dependencies - only validate if the script is enabled
        SCRIPT_DEFINITIONS.forEach(script => {
            if (ENABLED_SCRIPTS[script.name]) {
                script.dependencies.forEach(dep => {
                    if (!ENABLED_SCRIPTS[dep]) {
                        errors.push(`Script '${script.name}' requires '${dep}' to be enabled`);
                    }
                });
            }
        });
        
        if (errors.length > 0) {
            console.error('[KefinTweaks Injector] Configuration errors:', errors);
            return false;
        }
        
        return true;
    }
    
    // Resolve @latest, @main, or @experimental to actual version/commit hash (so user always loads latest from that ref)
    async function resolveRootVersion(root) {
        // Check if root contains @latest, @main, or @experimental
        const latestMatch = root.match(/@latest(\/|$)/);
        const mainMatch = root.match(/@main(\/|$)/);
        const experimentalMatch = root.match(/@experimental(\/|$)/);
        
        if (latestMatch) {
            // Fetch the latest release version number
            try {
                const response = await fetch('https://api.github.com/repos/ranaldsgift/KefinTweaks/releases/latest');
                if (response.ok) {
                    const data = await response.json();
                    if (data && data.tag_name) {
                        const versionTag = data.tag_name.startsWith('v') ? data.tag_name : 'v' + data.tag_name;
                        return root.replace('@latest', `@${versionTag}`);
                    } else {
                        console.warn('[KefinTweaks Injector] Could not fetch latest version, using @latest');
                        return root;
                    }
                } else {
                    console.warn('[KefinTweaks Injector] Failed to fetch latest version, using @latest');
                    return root;
                }
            } catch (error) {
                console.warn('[KefinTweaks Injector] Error fetching latest version:', error);
                return root;
            }
        } else if (mainMatch) {
            // Fetch the latest commit hash from the main branch
            try {
                const response = await fetch('https://api.github.com/repos/ranaldsgift/KefinTweaks/commits/main');
                if (response.ok) {
                    const commit = await response.json();
                    if (commit && commit.sha) {
                        return root.replace('@main', `@${commit.sha}`);
                    } else {
                        console.warn('[KefinTweaks Injector] Could not fetch commit hash, using @main');
                        return root;
                    }
                } else {
                    console.warn('[KefinTweaks Injector] Failed to fetch commit hash, using @main');
                    return root;
                }
            } catch (error) {
                console.warn('[KefinTweaks Injector] Error fetching commit hash:', error);
                return root;
            }
        } else if (experimentalMatch) {
            // Fetch the latest commit hash from the experimental branch
            try {
                const response = await fetch('https://api.github.com/repos/ranaldsgift/KefinTweaks/commits/experimental');
                if (response.ok) {
                    const commit = await response.json();
                    if (commit && commit.sha) {
                        return root.replace('@experimental', `@${commit.sha}`);
                    } else {
                        console.warn('[KefinTweaks Injector] Could not fetch experimental commit hash, using @experimental');
                        return root;
                    }
                } else {
                    console.warn('[KefinTweaks Injector] Failed to fetch experimental commit hash, using @experimental');
                    return root;
                }
            } catch (error) {
                console.warn('[KefinTweaks Injector] Error fetching experimental commit hash:', error);
                return root;
            }
        }
        
        // No resolution needed
        return root;
    }
    
    // Get the root path for scripts from configuration
    async function getScriptRoot() {
        const kefinTweaksRoot = window.KefinTweaksConfig?.kefinTweaksRoot;
        
        // If kefinTweaksRoot is not set or empty, return null (scripts should not load)
        if (!kefinTweaksRoot || kefinTweaksRoot === '') {
            console.warn('[KefinTweaks Injector] kefinTweaksRoot is not configured');
            return null;
        }
        
        // Ensure root ends with /
        let root = kefinTweaksRoot.endsWith('/') ? kefinTweaksRoot : kefinTweaksRoot + '/';
        
        // Resolve @latest, @main, or @experimental if needed (with caching)
        if (resolvedRootCache === null) {
            root = await resolveRootVersion(root);
            resolvedRootCache = root;
        } else {
            root = resolvedRootCache;
        }
        
        // Return scripts path
        return root + 'scripts/';
    }
    
    // Load a CSS file
    async function loadCSS(filename) {
        return new Promise(async (resolve, reject) => {
            const scriptRoot = await getScriptRoot();
            if (!scriptRoot) {
                reject(new Error('kefinTweaksRoot is not configured'));
                return;
            }
            
            // Check if CSS is already loaded (match by root and filename, ignore suffix)
            const existingLink = document.querySelector(`link[href*="${scriptRoot}${filename}"]`);
            if (existingLink) {
                console.log(`[KefinTweaks Injector] CSS already loaded: ${filename}`);
                resolve();
                return;
            }
            
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.type = 'text/css';
            link.href = `${scriptRoot}${filename}${urlSuffix}`;
            
            link.onload = () => {
                console.log(`[KefinTweaks Injector] CSS loaded: ${filename}`);
                resolve();
            };
            
            link.onerror = () => {
                console.warn(`[KefinTweaks Injector] Failed to load CSS: ${filename}`);
                reject(new Error(`Failed to load CSS: ${filename}`));
            };
            
            document.head.appendChild(link);
        });
    }
    
    // Load a JavaScript file
    async function loadScript(filename) {
        return new Promise(async (resolve, reject) => {
            const scriptRoot = await getScriptRoot();
            if (!scriptRoot) {
                reject(new Error('kefinTweaksRoot is not configured'));
                return;
            }
            
            // Check if script is already loaded
            const existingScript = document.querySelector(`script[src*="${scriptRoot}${filename}"]`);
            if (existingScript) {
                console.log(`[KefinTweaks Injector] Script already loaded: ${filename}`);
                resolve();
                return;
            }
            
            const script = document.createElement('script');
            script.src = `${scriptRoot}${filename}${urlSuffix}`;
            script.async = true;
            
            script.onload = () => {
                console.log(`[KefinTweaks Injector] Script loaded: ${filename}`);
                resolve();
            };
            
            script.onerror = () => {
                console.error(`[KefinTweaks Injector] Failed to load script: ${filename}`);
                reject(new Error(`Failed to load script: ${filename}`));
            };
            
            document.head.appendChild(script);
        });
    }
    
    // Recursively collect all dependencies for a given script
    function collectAllDependencies(scriptDef, collected = new Set(), visited = new Set()) {
        // Avoid infinite recursion
        if (visited.has(scriptDef.name)) {
            return collected;
        }
        visited.add(scriptDef.name);
        
        // For each dependency
        for (const depName of scriptDef.dependencies) {
            // Only process enabled dependencies
            if (!ENABLED_SCRIPTS[depName]) {
                continue;
            }
            
            const depScript = SCRIPT_DEFINITIONS.find(s => s.name === depName);
            if (!depScript) {
                continue;
            }
            
            // Add to collected if we haven't already
            if (!collected.has(depScript.name)) {
                collected.add(depScript.name);
                // Recursively collect this dependency's dependencies
                collectAllDependencies(depScript, collected, visited);
            }
        }
        
        return collected;
    }
    
    // Load a single script (assumes dependencies are already loaded)
    async function loadScriptSync(scriptDef) {
        const scriptRoot = await getScriptRoot();
        if (!scriptRoot) {
            throw new Error('kefinTweaksRoot is not configured');
        }
        
        // Check if already loaded (match by root and filename, ignore suffix)
        const isAlreadyLoaded = document.querySelector(`script[src*="${scriptRoot}${scriptDef.script}"]`);
        if (isAlreadyLoaded) {
            console.log(`[KefinTweaks Injector] Script already loaded: ${scriptDef.name}`);
            return;
        }
        
        // Load CSS if specified
        if (scriptDef.css) {
            await loadCSS(scriptDef.css);
        }
        
        // Load the script
        await loadScript(scriptDef.script);
        
        console.log(`[KefinTweaks Injector] Successfully loaded: ${scriptDef.name}`);
    }

    async function loadConfigurationJS() {
        const configDependencyNames = ['modal', 'toaster', 'utils', 'homeScreenConfig2', 'ui', 'homeScreen-migration', 'homeScreen-configuration', 'search-configuration', 'seriesEpisodes-configuration', 'seriesInfo-configuration', 'skinManager-configuration', 'customMenuLinks-configuration', 'thumbnailScrubber-configuration', 'apiHelper'];
        for (const depName of configDependencyNames) {
            const depScript = SCRIPT_DEFINITIONS.find(script => script.name === depName);
            if (depScript) {
                try {
                    await loadScriptSync(depScript);
                } catch (error) {
                    console.warn(`[KefinTweaks Injector] Failed to load configuration dependency '${depName}':`, error);
                }
            }
        }
        
        // Load configuration UI so admins can re-enable KefinTweaks
        await loadScript('configuration.js');
        await loadCSS('configuration.css');
    }
    
    // Main initialization function
    async function initialize() {
        console.log(`[KefinTweaks Injector] Starting KefinTweaks initialization...`);
        
        const scriptRoot = await getScriptRoot();
        if (!scriptRoot) {
            console.log('[KefinTweaks Injector] kefinTweaksRoot is not configured. Please configure KefinTweaks using the installer before scripts can be loaded.');
            return;
        }
        
        // Check if KefinTweaks is enabled in config
        const isKefinTweaksEnabled = window.KefinTweaksConfig?.enabled !== false;
        
        if (!isKefinTweaksEnabled) {
            console.log('[KefinTweaks Injector] KefinTweaks is disabled in configuration. Only loading configuration UI requirements for admin access.');
            
            try {
                // Ensure configuration dependencies are loaded so the admin UI works
                await loadConfigurationJS();
                console.log('[KefinTweaks Injector] Configuration script loaded (KefinTweaks is disabled)');
            } catch (error) {
                console.warn('[KefinTweaks Injector] Failed to load configuration UI while disabled:', error);
            }
            return;
        }
        
        // Validate configuration
        if (!validateConfiguration()) {
            console.error('[KefinTweaks Injector] Configuration validation failed. Aborting.');
            return;
        }
        
        // Get enabled scripts
        const enabledScripts = SCRIPT_DEFINITIONS.filter(script => ENABLED_SCRIPTS[script.name]);
        
        // Step 1: Collect all dependencies from all enabled scripts
        const allDependencyNames = new Set();
        for (const script of enabledScripts) {
            const deps = collectAllDependencies(script);
            deps.forEach(dep => allDependencyNames.add(dep));
        }
        
        // Step 2: Separate dependencies from non-dependencies
        const dependencyScripts = SCRIPT_DEFINITIONS.filter(script => 
            allDependencyNames.has(script.name) && ENABLED_SCRIPTS[script.name]
        );
        
        const nonDependencyScripts = enabledScripts.filter(script => 
            !allDependencyNames.has(script.name)
        );
        
        // Step 2.5: Separate priority scripts from regular non-dependency scripts
        const priorityScripts = nonDependencyScripts.filter(script => script.priority === true);
        const regularScripts = nonDependencyScripts.filter(script => !script.priority);
        
        console.log(`[KefinTweaks Injector] Found ${dependencyScripts.length} dependency scripts:`, 
                   dependencyScripts.map(s => s.name));
        console.log(`[KefinTweaks Injector] Found ${priorityScripts.length} priority scripts:`, 
                   priorityScripts.map(s => s.name));
        console.log(`[KefinTweaks Injector] Found ${regularScripts.length} regular scripts:`, 
                   regularScripts.map(s => s.name));
        
        try {
            // Step 3: Load all dependencies first
            console.log('[KefinTweaks Injector] Loading dependencies first...');
            console.log(`[KefinTweaks Injector] Dependency load order:`, dependencyScripts.map(s => s.name));
            
            let dependencyLoadPromises = [];
            dependencyLoadPromises.push(...dependencyScripts.map(script => loadScriptSync(script)));
            await Promise.all(dependencyLoadPromises);
            
            // Step 4: Load priority scripts immediately after dependencies
            if (priorityScripts.length > 0) {
                console.log('[KefinTweaks Injector] Loading priority scripts...');
                console.log(`[KefinTweaks Injector] Priority load order:`, priorityScripts.map(s => s.name));
                let priorityLoadPromises = [];
                priorityLoadPromises.push(...priorityScripts.map(script => loadScriptSync(script)));
                await Promise.all(priorityLoadPromises);
            }
            
            // Step 5: Load regular non-dependencies in parallel (their dependencies are already loaded)
            let loadPromises = [];
            console.log('[KefinTweaks Injector] Loading regular non-dependencies...');
            loadPromises.push(...regularScripts.map(script => loadScriptSync(script)));
            await Promise.all(loadPromises);
            
            console.log('[KefinTweaks Injector] All scripts loaded successfully!');
            
            // Always load configuration.js for admin UI (loads after other scripts)
            console.log('[KefinTweaks Injector] Loading configuration script...');
            try {
                await loadConfigurationJS();
                console.log('[KefinTweaks Injector] Configuration script loaded successfully');
            } catch (error) {
                console.warn('[KefinTweaks Injector] Failed to load configuration script:', error);
            }
            
            // Dispatch custom event when all scripts are loaded
            const event = new CustomEvent('kefinTweaksLoaded', {
                detail: {
                    loadedScripts: enabledScripts.map(s => s.name),
                    timestamp: new Date().toISOString()
                }
            });
            document.dispatchEvent(event);
            
        } catch (error) {
            console.error('[KefinTweaks Injector] Error during initialization:', error);
        }
    }
    
    // Utility functions for debugging and configuration
    window.KefinTweaks = {
        // Get current configuration
        getConfig: () => ({ ...ENABLED_SCRIPTS }),
        
        // Get script definitions
        getScripts: () => [...SCRIPT_DEFINITIONS],
        
        // Check if a script is loaded
        isScriptLoaded: (scriptName) => {
            const scriptDef = SCRIPT_DEFINITIONS.find(s => s.name === scriptName);
            if (!scriptDef) return false;
            
            const scriptElement = document.querySelector(`script[src*="${scriptDef.script}"]`);
            return !!scriptElement;
        },
        
        // Reload all scripts (useful for development)
        reload: () => {
            console.log('[KefinTweaks Injector] Reloading all scripts...');
            initialize();
        },
        
        // Load a specific script (useful for dynamic loading)
        loadScript: async (scriptName) => {
            const scriptDef = SCRIPT_DEFINITIONS.find(s => s.name === scriptName);
            if (!scriptDef) {
                throw new Error(`Script '${scriptName}' not found`);
            }
            
            if (!ENABLED_SCRIPTS[scriptName]) {
                throw new Error(`Script '${scriptName}' is disabled in configuration`);
            }
            
            await loadScriptWithDependencies(scriptDef);
        }
    };
    
    // Check if user is admin (with timeout for login)
    async function checkAdminWithTimeout(maxWaitMs = 5000) {
        const startTime = Date.now();
        const checkInterval = 100; // Check every 100ms
        
        return new Promise((resolve) => {
            const checkAdmin = async () => {
                try {
                    if (window.ApiClient && window.ApiClient.getCurrentUser) {
                        const user = await window.ApiClient.getCurrentUser();
                        if (user && user.Policy && user.Policy.IsAdministrator === true) {
                            console.log('[KefinTweaks Startup] User is admin');
                            resolve(true);
                            return;
                        }
                        // User is logged in but not admin
                        if (user) {
                            console.log('[KefinTweaks Startup] User is not admin');
                            resolve(false);
                            return;
                        }
                    }
                } catch (error) {
                    // User might not be logged in yet, continue waiting
                }
                
                // Check if we've exceeded max wait time
                if (Date.now() - startTime >= maxWaitMs) {
                    console.log('[KefinTweaks Startup] Timeout waiting for user login');
                    resolve(false);
                    return;
                }
                
                // Continue checking
                setTimeout(checkAdmin, checkInterval);
            };
            
            checkAdmin();
        });
    }

    // Find plugin by name
    async function findPlugin(pluginName) {
        try {
            if (!window.ApiClient || !window.ApiClient._serverAddress || !window.ApiClient.accessToken) {
                throw new Error('ApiClient not available');
            }

            const server = ApiClient._serverAddress;
            const token = ApiClient.accessToken();

            const response = await fetch(`${server}/Plugins`, {
                headers: {
                    'X-Emby-Token': token
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const plugins = await response.json();
            const pluginsList = Array.isArray(plugins) ? plugins : (plugins.Items || []);
            
            const plugin = pluginsList.find(p => p.Name === pluginName);
            return plugin ? plugin.Id : null;
        } catch (error) {
            console.error(`[KefinTweaks Startup] Error finding plugin ${pluginName}:`, error);
            return null;
        }
    }

    // Get plugin configuration
    async function getPluginConfig(pluginId) {
        try {
            if (!window.ApiClient || !window.ApiClient._serverAddress || !window.ApiClient.accessToken) {
                throw new Error('ApiClient not available');
            }

            const server = ApiClient._serverAddress;
            const token = ApiClient.accessToken();

            const response = await fetch(`${server}/Plugins/${pluginId}/Configuration`, {
                headers: {
                    'X-Emby-Token': token
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            return await response.json();
        } catch (error) {
            console.error('[KefinTweaks Startup] Error getting plugin config:', error);
            throw error;
        }
    }

    // Save plugin configuration
    async function savePluginConfig(pluginId, config) {
        try {
            if (!window.ApiClient || !window.ApiClient._serverAddress || !window.ApiClient.accessToken) {
                throw new Error('ApiClient not available');
            }

            const server = ApiClient._serverAddress;
            const token = ApiClient.accessToken();

            const response = await fetch(`${server}/Plugins/${pluginId}/Configuration`, {
                method: 'POST',
                headers: {
                    'X-Emby-Token': token,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(config)
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            return true;
        } catch (error) {
            console.error('[KefinTweaks Startup] Error saving plugin config:', error);
            throw error;
        }
    }


    // Ensure Watchlist tab exists in CustomTabs
    async function ensureWatchlistTab() {
        try {
            if (!window.KefinTweaksConfig) {
                console.log('[KefinTweaks Startup] KefinTweaksConfig not found, skipping Watchlist tab check');
                return true;
            }

            // Check if Watchlist is enabled in the configuration and remove it if not
            if (!window.KefinTweaksConfig.scripts.watchlist) {
                console.log('[KefinTweaks Startup] Watchlist is disabled in configuration, removing Watchlist tab');
                const pluginId = await findPlugin('Custom Tabs');
                if (!pluginId) {
                    console.warn('[KefinTweaks Startup] CustomTabs plugin not found');
                    return false;
                }
                const config = await getPluginConfig(pluginId);

                // Filter based on the ContentHtml including div class=\"sections watchlist\"
                let tabs = config.Tabs.filter(tab => tab.ContentHtml !== '<div class="sections watchlist"></div>');

                await savePluginConfig(pluginId, { Tabs: tabs });
                console.log('[KefinTweaks Startup] Removed Watchlist tab from CustomTabs');
                return true;
            }

            console.log('[KefinTweaks Startup] Ensuring Watchlist tab exists in CustomTabs...');
            
            const pluginId = await findPlugin('Custom Tabs');
            if (!pluginId) {
                console.warn('[KefinTweaks Startup] CustomTabs plugin not found');
                return false;
            }

            // Get current CustomTabs config
            const server = ApiClient._serverAddress;
            const token = ApiClient.accessToken();
            
            const response = await fetch(`${server}/CustomTabs/Config`, {
                headers: {
                    'X-Emby-Token': token
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            let tabs = await response.json();
            if (!Array.isArray(tabs)) {
                tabs = [];
            }

            // Find watchlist tab by checking if the ContentHtml includes div class=\"sections watchlist\"
            const watchlistTab = tabs.find(tab => tab.ContentHtml.includes('sections watchlist'));
            
            if (watchlistTab) {
                console.log('[KefinTweaks Startup] Watchlist tab already exists with correct ContentHtml');
                return true;
            }

            // Add Watchlist tab
            tabs.push({
                Title: 'Watchlist',
                ContentHtml: '<div class="sections watchlist"></div>'
            });

            // Save updated config
            await savePluginConfig(pluginId, { Tabs: tabs });
            console.log('[KefinTweaks Startup] Added Watchlist tab to CustomTabs');
            return true;
        } catch (error) {
            console.error('[KefinTweaks Startup] Error ensuring Watchlist tab:', error);
            return false;
        }
    }

    // Startup task - runs only for admin users
    async function startupTask() {
        console.log('[KefinTweaks Startup] Starting startup task...');
        
        // Check if kefinTweaksRoot is configured - startup tasks only run after installation
        if (!window.KefinTweaksConfig?.kefinTweaksRoot || window.KefinTweaksConfig.kefinTweaksRoot === '') {
            console.log('[KefinTweaks Startup] kefinTweaksRoot is not configured, skipping startup tasks');
            return;
        }
        
        // Check if user is admin (wait up to 5s for login)
        const isAdmin = await checkAdminWithTimeout(5000);
        
        if (!isAdmin) {
            console.log('[KefinTweaks Startup] User is not admin or not logged in, skipping startup task');
            return;
        }

        try {
            // Task: Ensure Watchlist tab exists in CustomTabs
            await ensureWatchlistTab();
            
            console.log('[KefinTweaks Startup] Startup task completed successfully');
        } catch (error) {
            console.error('[KefinTweaks Startup] Error in startup task:', error);
        }
    }

    // Start initialization when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', async () => {
            await injectVersionBadgeCSS();
            initialize();
            // Run startup task after a short delay to ensure ApiClient is ready
            setTimeout(startupTask, 1000);
        });
    } else {
        (async () => {
            await injectVersionBadgeCSS();
            initialize();
            // Run startup task after a short delay to ensure ApiClient is ready
            setTimeout(startupTask, 1000);
        })();
    }
    
    console.log('[KefinTweaks Injector] Injector script loaded. Available at window.KefinTweaks');
    
})();
