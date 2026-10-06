// KefinTweaks Loader — shared catalog, load plan, and KefinTweaks-injector script builder
(function () {
    'use strict';

    const LOG = (...args) => console.log('[KefinTweaks Loader]', ...args);
    const WARN = (...args) => console.warn('[KefinTweaks Loader]', ...args);

    const KEFIN_INJECTOR_ENTRY_NAME = 'KefinTweaks-injector';
    const KEFIN_CONFIG_ENTRY_NAME = 'KefinTweaks-Config';

    const DEFAULT_ENABLED_SCRIPTS = {
        watchlist: true,
        homeScreen: true,
        search: true,
        headerTabs: true,
        customMenuLinks: true,
        hamburgerMenu: false,
        updoot: false,
        backdropLeakFix: true,
        dashboardButtonFix: true,
        infiniteScroll: true,
        removeContinue: true,
        subtitleSearch: true,
        playlist: true,
        itemDetailsCollections: true,
        flattenSingleSeasonShows: true,
        seriesInfo: true,
        versionPreferences: true,
        collections: true,
        skinManager: true,
        thumbnailScrubber: false,
        watchTogether: false,
        userManager: false,
        games: true,

        // ================================================================
        // FORK-ONLY FEATURES
        // Grouped at the end so an upstream merge lands their additions above
        // this line and ours below it, rather than interleaved.
        //
        // Upstream moved this registry out of injector.js into this file, which
        // is what the installer loads. These ten have no upstream entry, so
        // without them the scripts ship but never run -- and nothing errors,
        // which is why it went unnoticed after the merge.
        castSessionWatchdog: true, // Re-subscribe the Sessions feed when a stale now playing bar shows a dead cast target
        elegantfinHaspatch: true, // ElegantFin :has() hotfix marker classes (needs the local ElegantFin build)
        seriesSpecials: true,     // Series & Specials group: the five tweaks marked group: 'seriesSpecials' run only while this is on
        seriesSpecialsData: true, // Series & Specials: shared virtual-special lookup (a dependency, no switch in the window)
        episodeTitle: true,       // Series & Specials: episode heading names/opens the season or virtual special
        episodeSeasonTitle: true, // Episode Logo: header logo links up (episode -> season -> series)
        jeSidebarMemo: true,      // Memoise Jellyfin Enhanced's getSidebarContainer (forced style flush on every DOM mutation)
        jeSpoilerGuardScope: true, // Scope Jellyfin Enhanced's Spoiler Guard image refresh to the item that changed
        mediaTags: true,          // Add a Tags row to the item-details metadata table
        specialEpisodePrefix: true, // Drop the "Special - " prefix from season-zero episode titles
        posterAspect: false,   // Size poster cards to their own aspect ratio; CSS-sized from a ratio class, height measured before the cards exist
        osdLogo: true,            // Media logo/ClearArt on the video OSD
        pauseScreen: true,        // Rich pause screen overlay (logo, plot, artwork, progress)
        themeMediaCastFix: true,  // Theme media playback while a remote/cast target is connected
        virtualSpecials: true,    // Collection pages: Studios row, no "Special - " prefix, breadcrumbs
        collectionSectionRows: true, // Collection pages: sections as rows, like the flat season row
        crtShader: true,          // CRT toggle on the video OSD: the mpv retro chain in WebGL2 (off until clicked)
    };

    const THIRD_PARTY_SCRIPTS = {
        pickr: {
            js: [
                'thirdparty/pickr/pickr.min.js'
            ],
            css: [
                'thirdparty/pickr/pickr-nano.min.css'
            ]
        },
        chartjs: {
            js: [
                'thirdparty/chartjs/chart.js'
            ],
            css: []
        }
    };

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
            name: 'homeScreen-user-configuration',
            script: '../configuration/homeScreen-user-configuration.js',
            css: null,
            dependencies: ['ui', 'utils'],
            description: 'User home screen section preferences and bulk order editor'
        },
        {
            name: 'homeScreenSectionConfigure',
            script: 'homeScreenSectionConfigure.js',
            css: null,
            dependencies: ['homeScreen-user-configuration', 'modal', 'ui', 'cardBuilder'],
            thirdParty: ['pickr'],
            description: 'Inline configure popover for user home screen sections'
        },
        {
            name: 'homeScreenPin',
            script: 'homeScreenPin.js',
            css: null,
            dependencies: ['homeScreen-user-configuration', 'modal', 'utils'],
            description: 'Pin items to the home screen from context menus'
        },
        {
            name: 'homeScreenCustomItemsEditor',
            script: '../configuration/homeScreenCustomItemsEditor.js',
            css: null,
            dependencies: [],
            description: 'Shared custom items editor (wizard + advanced)'
        },
        {
            name: 'homeScreenSectionEditor',
            script: '../configuration/homeScreenSectionEditor.js',
            css: '../configuration/homeScreenSectionEditor.css',
            dependencies: ['modal', 'toaster', 'utils', 'cardBuilder', 'ui', 'homeScreenCustomItemsEditor', 'homeScreenAdvancedEditor'],
            description: 'Home screen section editor (wizard + advanced)'
        },
        {
            name: 'homeScreenEditorProfiles',
            script: '../configuration/homeScreenEditorProfiles.js',
            css: null,
            dependencies: [],
            description: 'Editor profile registry for home screen section editor'
        },
        {
            name: 'homeScreenAdvancedEditor',
            script: '../configuration/homeScreenAdvancedEditor.js',
            css: '../configuration/homeScreenAdvancedEditor.css',
            dependencies: ['ui', 'homeScreenCustomItemsEditor', 'homeScreenEditorProfiles'],
            thirdParty: ['pickr'],
            description: 'Advanced section editor UI for custom sections'
        },
        {
            name: 'homescreenBenchmark',
            script: '../configuration/homescreenBenchmark.js',
            css: null,
            dependencies: ['apiHelper'],
            description: 'Home screen section query benchmarks for admin config'
        },
        {
            name: 'homeScreen-configuration',
            script: '../configuration/homeScreen-configuration.js',
            css: '../configuration/homeScreen-configuration.css',
            dependencies: ['modal', 'toaster', 'utils', 'cardBuilder', 'ui', 'homeScreenCustomItemsEditor', 'homeScreenSectionEditor', 'homescreenBenchmark', 'sectionHelper'],
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
            name: 'versionPreferences-configuration',
            script: '../configuration/versionPreferences-configuration.js',
            css: null,
            dependencies: ['modal', 'toaster', 'utils'],
            description: 'Item version preferences configuration for KefinTweaks'
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
            dependencies: ['libraryCacheUtils', 'userHelper', 'moviesCache', 'seriesCache', 'indexedDBCache', 'apiHelper'],
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
            name: 'libraryCacheUtils',
            script: 'libraryCacheUtils.js',
            css: null,
            dependencies: [],
            description: 'Shared strip/provider helpers for library caches'
        },
        {
            name: 'moviesCache',
            script: 'moviesCache.js',
            css: null,
            dependencies: ['libraryCacheUtils', 'userHelper', 'indexedDBCache', 'apiHelper'],
            description: 'Movies library cache for KefinTweaks'
        },
        {
            name: 'seriesCache',
            script: 'seriesCache.js',
            css: null,
            dependencies: ['libraryCacheUtils', 'userHelper', 'indexedDBCache', 'apiHelper'],
            description: 'Series library cache for KefinTweaks'
        },
        {
            name: 'libraryCache',
            script: 'libraryCache.js',
            css: null,
            dependencies: ['moviesCache', 'seriesCache'],
            description: 'Library cache facade for KefinTweaks'
        },
        {
            name: 'externalList',
            script: 'externalList.js',
            css: null,
            dependencies: ['libraryCache', 'libraryCacheUtils', 'apiHelper'],
            description: 'MDBList external list matching for home sections'
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
            name: 'sectionHelper',
            script: 'sectionHelper.js',
            css: null,
            dependencies: ['apiHelper', 'cardBuilder', 'peopleCache', 'studiosCache', 'moviesCache', 'seriesCache', 'libraryCache', 'homeScreenConfig2', 'dataHelper'],
            description: 'Section loading and progressive discovery resolve helpers'
        },
        {
            name: 'cardBuilder',
            script: 'cardBuilder.js',
            css: 'cardBuilder.css',
            dependencies: ['apiHelper', 'userHelper', 'websocketHelper'],
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
            name: 'watchTogether-configuration',
            script: '../configuration/watchTogether-configuration.js',
            css: null,
            dependencies: ['modal', 'ui'],
            description: 'Configuration UI for Watch Together'
        },
        {
            name: 'watchTogether',
            script: 'watchTogether.js',
            css: null,
            dependencies: ['utils', 'modal', 'apiHelper', 'userHelper', 'websocketHelper', 'ui', 'watchTogether-configuration'],
            description: 'Watch Together: sync watched/in-progress state to selected group accounts'
        },
        {
            name: 'userManager-configuration',
            script: '../configuration/userManager-configuration.js',
            css: null,
            dependencies: ['modal', 'toaster', 'utils', 'apiHelper', 'ui'],
            description: 'Configuration UI for User Manager templates'
        },
        {
            name: 'userManager',
            script: 'userManager.js',
            css: 'userManager.css',
            dependencies: ['utils', 'modal', 'apiHelper', 'userHelper', 'toaster', 'userManager-configuration'],
            description: 'User Manager: apply policy templates on new user creation and bulk-edit existing users'
        },
        {
            name: 'toaster',
            script: 'toaster.js',
            css: null,
            dependencies: [],
            description: 'Toast notification system using Jellyfin\'s existing toast functionality'
        },
        {
            name: 'statistics',
            script: 'statistics.js',
            css: null,
            dependencies: [],
            description: 'Watchlist statistics charts and activity analytics'
        },
        {
            name: 'watchlist-configuration',
            script: '../configuration/watchlist-configuration.js',
            css: null,
            dependencies: ['modal', 'ui'],
            description: 'Configuration UI for Watchlist menu placements'
        },
        {
            name: 'watchlist',
            script: 'watchlist.js',
            css: 'watchlist.css',
            dependencies: ['cardBuilder', 'localStorageCache', 'modal', 'utils', 'statistics', 'watchlist-configuration'],
            thirdParty: ['chartjs'],
            description: 'Adds watchlist functionality throughout Jellyfin interface'
        },
        {
            name: 'homeScreen',
            script: 'homeScreen3.js',
            css: 'homeScreen.css',
            dependencies: ['cardBuilder', 'localStorageCache', 'utils', 'userHelper', 'homeScreenConfig2', 'homeScreen-configuration', 'peopleCache', 'studiosCache', 'moviesCache', 'seriesCache', 'libraryCache', 'libraryCacheUtils', 'externalList', 'indexedDBCache', 'homeScreenConfigCommunity', 'dataHelper', 'apiHelper', 'sectionHelper', 'homeScreen-migration', 'homeScreen-user-configuration', 'homeScreenSectionConfigure', 'homeScreenPin', 'websocketHelper'],
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
            name: 'hamburgerMenu',
            script: 'hamburgerMenu.js',
            css: null,
            dependencies: ['utils'],
            versions: [12],
            description: 'Desktop hamburger button that opens a v12-style left navigation drawer'
        },
        {
            name: 'games',
            script: 'games.js',
            css: null,
            dependencies: ['utils'],
            description: 'Adds a Games sidebar link to the games hub page'
        },
        {
            name: 'backdropLeakFix',
            script: 'backdropLeakFix.js',
            css: null,
            dependencies: [],
            versions: [10, 11],
            description: 'Fixes issue that causes backdrop images to be continuously added to the page if the tab isn\'t focused.'
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
            versions: [10, 11],
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
            versions: [10, 11],
            description: 'Adds related collections to item details pages showing which collections contain the current item'
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
            name: 'versionPreferences',
            script: 'versionPreferences.js',
            css: null,
            dependencies: ['utils'],
            description: 'Reorders and sanitizes media source version/edition options on item details pages'
        },
        {
            name: 'collections',
            script: 'collections.js',
            css: null,
            dependencies: ['utils', 'modal'],
            description: 'Adds sorting functionality to collection pages'
        },

        // ================================================================
        // FORK-ONLY FEATURES -- matching the block in the defaults above
        // ================================================================
        {
            name: 'castSessionWatchdog',
            script: 'castSessionWatchdog.js',
            css: null,
            dependencies: [],
            description: 'Re-subscribes the Sessions WebSocket feed when it goes silent while the now playing bar is up, so a cast target that stopped playing cannot leave a frozen seek bar on screen.'
        },
        {
            name: 'elegantfinHaspatch',
            script: 'elegantfin-haspatch.js',
            css: null,
            dependencies: ['utils'],
            description: 'Maintains the .ef-* marker classes that replace the Chromium-hot :has() selectors in the local ElegantFin build.'
        },
        {
            name: 'episodeSeasonTitle',
            group: 'seriesSpecials',
            script: 'episodeSeasonTitle.js',
            css: null,
            dependencies: ['utils', 'seriesSpecialsData'],
            description: "Header logo that links up a level: episode to season, season to series. Shown under the thumbnail on ElegantFin episode pages."
        },
        {
            name: 'jeSidebarMemo',
            script: 'jeSidebarMemo.js',
            css: null,
            dependencies: [],
            description: "Memoises Jellyfin Enhanced's getSidebarContainer(), which reads offsetParent (a forced full-document style flush) on every body mutation. Measured at 3.2s of style recalc across 104 calls when navigating into a series page. No-ops if Jellyfin Enhanced is absent."
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
            name: 'mediaTags',
            group: 'seriesSpecials',
            script: 'mediaTags.js',
            css: null,
            dependencies: ['utils'],
            description: 'Adds a Tags row to the item-details metadata table, matching the Genres/Studios rows.'
        },
        {
            name: 'specialEpisodePrefix',
            group: 'seriesSpecials',
            script: 'specialEpisodePrefix.js',
            css: null,
            dependencies: ['utils'],
            description: 'Removes the "Special - " prefix Jellyfin puts on the title of every season-zero episode, everywhere it appears. The prefix is localized, so the wording is learned once from the server rather than assumed.'
        },
        {
            name: 'posterAspect',
            script: 'posterAspect.js',
            css: 'posterAspect.css',
            dependencies: ['utils', 'userHelper'],
            description: 'Sizes each poster card to its own image instead of cropping everything to one shape. The ratio arrives as a class in the card markup (via the File Transformation plugin) so CSS sizes each card as it is parsed, and the row height is measured once per container BEFORE its cards exist. Cards are correct in the first painted frame, with no correction afterwards.'
        },
        {
            name: 'osdLogo',
            script: 'osdLogo.js',
            css: null,
            dependencies: [],
            description: 'Shows the media\'s logo (or ClearArt) on the video OSD while playback controls are visible, with optional transparency trimming and OSD shadows.'
        },
        {
            name: 'pauseScreen',
            script: 'pauseScreen.js',
            css: null,
            dependencies: [],
            description: 'Shows a rich overlay (logo, plot, details, disc/clear art, progress) when playback is paused for a few seconds. Supports the HTML5 player and external players (mpv-shim etc.).'
        },
        {
            name: 'themeMediaCastFix',
            script: 'themeMediaCastFix.js',
            css: null,
            dependencies: [],
            description: 'Restores theme song/video playback in the web client while a remote/cast player (e.g. mpv-shim) is the selected target.'
        },
        {
            name: 'crtShader',
            script: 'crtShader.js',
            css: null,
            dependencies: ['utils', 'toaster'],
            description: "Adds a CRT button to the video OSD. When on, the playing video runs through the mpv retro CRT chain itself (scripts/crt/: retro.conf profiles and the .glsl files, translated to GLSL ES by tools/build-crt-shaders.mjs) in WebGL2, one field per 59.94 Hz locked to the refresh rate. Per browser; web player only."
        },
        {
            name: 'collectionSectionRows',
            group: 'seriesSpecials',
            script: 'collectionSectionRows.js',
            css: null,
            dependencies: ['utils', 'cardBuilder'],
            description: "Collection pages: each section (Episodes, Movies...) as a horizontal row of cards, built the way the flat season row on a series page is. The original grid stays in the page, hidden, so collection sorting still applies."
        },
        {
            name: 'virtualSpecials',
            group: 'seriesSpecials',
            script: 'virtualSpecials.js',
            css: null,
            dependencies: ['utils', 'seriesSpecialsData'],
            description: "Fixes to the collection (BoxSet) detail page. Fills in the Studios row, which renderStudio refuses to render for a BoxSet. Removes the \"Special - \" prefix jellyfin-web prepends to every season-0 episode title, on collection pages only. Gives a virtual special breadcrumbs back to its series, and sets the single-item marker collectionSingleItem.css reads."
        },
        {
            name: 'seriesSpecialsData',
            group: 'seriesSpecials',
            script: 'seriesSpecialsData.js',
            css: null,
            dependencies: ['utils'],
            description: "Shared lookup of a special episode's virtual special collection (stock /Items/{id}/Collections), asked once per page for Episode Title, Episode Logo and Virtual Specials."
        },
        {
            name: 'episodeTitle',
            group: 'seriesSpecials',
            script: 'episodeTitle.js',
            css: null,
            dependencies: ['utils', 'seriesSpecialsData'],
            description: "Episode heading names and opens the season (its Original Title), or a special's virtual special collection."
        },
        // Series & Specials. A group switch with no script of its own: the
        // definitions above that carry group: 'seriesSpecials' run only while
        // this is on (see mergeEnabledScripts), and each keeps its own switch,
        // set from the group's settings window instead of the feature list.
        {
            name: 'seriesSpecials',
            script: null,
            css: null,
            dependencies: [],
            description: 'Series & Specials: the related episode, season and collection-page tweaks, each switched from one settings window.'
        },
        {
            name: 'seriesSpecials-configuration',
            script: '../configuration/seriesSpecials-configuration.js',
            css: null,
            dependencies: ['modal', 'toaster', 'utils'],
            description: 'Settings window for the Series & Specials group'
        }
    ];

    const CONFIG_DEPENDENCY_NAMES = [
        'modal', 'toaster', 'utils', 'homeScreenConfig2', 'ui', 'homeScreen-migration',
        'homeScreen-configuration', 'search-configuration', 'seriesEpisodes-configuration',
        'seriesInfo-configuration',
        'versionPreferences-configuration', 'skinManager-configuration',
        'customMenuLinks-configuration', 'thumbnailScrubber-configuration',
        'watchTogether-configuration', 'watchlist-configuration', 'userManager-configuration', 'apiHelper',
        'sectionHelper', 'seriesSpecials-configuration'
    ];

    const CONFIGURATION_FILES = { script: 'configuration.js', css: 'configuration.css' };

    function parseMajorVersion(version) {
        if (!version || typeof version !== 'string') return null;
        const versionParts = version.split('.');
        if (versionParts[0] !== '10') {
            const majorVersion = parseInt(versionParts[0], 10);
            return Number.isNaN(majorVersion) ? null : majorVersion;
        }
        if (versionParts.length >= 2) {
            const majorVersion = parseInt(versionParts[1], 10);
            if (!Number.isNaN(majorVersion)) return majorVersion;
        }
        return null;
    }

    function isScriptCompatible(scriptDef, majorVersion) {
        if (!scriptDef || !scriptDef.versions || !scriptDef.versions.length) return true;
        if (majorVersion == null) return false;
        return scriptDef.versions.includes(majorVersion);
    }

    function definitionsByName() {
        const map = new Map();
        SCRIPT_DEFINITIONS.forEach((d) => map.set(d.name, d));
        return map;
    }

    function mergeEnabledScripts(config) {
        const enabled = Object.assign({}, DEFAULT_ENABLED_SCRIPTS, (config && config.scripts) || {});
        // A grouped script runs only while its group is on. Its own flag is left
        // as saved in the config, so switching the group back on restores
        // exactly the tweaks that were on before; it is only this merged view
        // that turns it off. Done before dependencies are resolved, so a
        // disabled tweak does not pull its dependencies in either.
        SCRIPT_DEFINITIONS.forEach((script) => {
            if (script.group && !enabled[script.group]) enabled[script.name] = false;
        });
        let iterations = 0;
        while (iterations < 10) {
            let changed = false;
            SCRIPT_DEFINITIONS.forEach((script) => {
                if (!enabled[script.name]) return;
                (script.dependencies || []).forEach((dep) => {
                    if (!enabled[dep]) {
                        enabled[dep] = true;
                        changed = true;
                    }
                });
            });
            if (!changed) break;
            iterations++;
        }
        return enabled;
    }

    function collectAllDependencies(scriptDef, enabled, byName, collected, visited) {
        collected = collected || new Set();
        visited = visited || new Set();
        if (visited.has(scriptDef.name)) return collected;
        visited.add(scriptDef.name);
        for (const depName of scriptDef.dependencies || []) {
            if (!enabled[depName]) continue;
            const depScript = byName.get(depName);
            if (!depScript) continue;
            if (!collected.has(depScript.name)) {
                collected.add(depScript.name);
                collectAllDependencies(depScript, enabled, byName, collected, visited);
            }
        }
        return collected;
    }

    function topoSortScriptNames(names, byName) {
        const nameSet = new Set(names);
        const indegree = new Map();
        const edges = new Map();
        names.forEach((n) => {
            indegree.set(n, 0);
            edges.set(n, []);
        });
        names.forEach((n) => {
            const def = byName.get(n);
            (def && def.dependencies || []).forEach((dep) => {
                if (!nameSet.has(dep)) return;
                edges.get(dep).push(n);
                indegree.set(n, (indegree.get(n) || 0) + 1);
            });
        });
        const orderIndex = new Map(names.map((n, i) => [n, i]));
        const queue = names.filter((n) => (indegree.get(n) || 0) === 0);
        queue.sort((a, b) => orderIndex.get(a) - orderIndex.get(b));
        const result = [];
        while (queue.length) {
            const n = queue.shift();
            result.push(n);
            const nexts = edges.get(n) || [];
            nexts.sort((a, b) => orderIndex.get(a) - orderIndex.get(b));
            nexts.forEach((m) => {
                indegree.set(m, indegree.get(m) - 1);
                if (indegree.get(m) === 0) queue.push(m);
            });
            queue.sort((a, b) => orderIndex.get(a) - orderIndex.get(b));
        }
        if (result.length !== names.length) {
            WARN('Topo sort incomplete; appending remaining names');
            names.forEach((n) => { if (!result.includes(n)) result.push(n); });
        }
        return result;
    }

    function normalizeRoot(root) {
        if (!root || typeof root !== 'string') return '';
        return root.endsWith('/') ? root : root + '/';
    }

    /**
     * Prefer kefinTweaksRootResolved (commit SHA / verified URL); fall back to symbolic kefinTweaksRoot.
     */
    function getResolvedKefinRoot(config) {
        const cfg = config || {};
        return normalizeRoot(cfg.kefinTweaksRootResolved || cfg.kefinTweaksRoot || '');
    }

    /* Version token for our own files: ?v=<config.assetVersion>.
     *
     * The web root serves our scripts and sheets with an ETag but no
     * Cache-Control, so a browser may reuse a copy for as long as its
     * heuristics allow -- days, for a file that has not changed in weeks --
     * and a deploy reached people only when their copies happened to expire.
     * tools/deploy.py sets assetVersion in KefinTweaks-Config on every deploy.
     * That entry arrives in JS Injector's public.js, which is never cached, so a
     * new token is in every browser on its next load, and with it new URLs that
     * no stale copy answers. With no assetVersion set, nothing is appended. */
    function assetVersionSuffix(config) {
        const v = config && config.assetVersion;
        return v ? '?v=' + encodeURIComponent(String(v)) : '';
    }

    /* For code that loads one of our files by hand rather than through the
       load plan. Defined here and in the baked KefinTweaks-injector, whichever
       runs first. Leaves a URL that already has a query alone. */
    if (typeof window !== 'undefined' && typeof window.KefinTweaksAssetUrl !== 'function') {
        window.KefinTweaksAssetUrl = function (url) {
            const suffix = assetVersionSuffix(window.KefinTweaksConfig);
            return (url && suffix && url.indexOf('?') === -1) ? url + suffix : url;
        };
    }

    function resolveAssetUrl(root, relativePath) {
        if (!relativePath) return null;
        if (/^https?:\/\//i.test(relativePath)) return relativePath;

        const normalizedRoot = normalizeRoot(root);
        const base = normalizedRoot + 'scripts/';
        const joined = (base + relativePath).replace(/\\/g, '/');

        // Absolute http(s) root — use URL so .. segments resolve correctly
        if (/^https?:\/\//i.test(normalizedRoot)) {
            try {
                return new URL(relativePath, base).href;
            } catch (e) {
                /* fall through */
            }
        }

        // Site-absolute or relative path — collapse . / .. while preserving a leading "/"
        const isSiteAbsolute = joined.charAt(0) === '/';
        const parts = joined.split('/');
        const stack = [];
        for (const p of parts) {
            if (!p || p === '.') continue;
            if (p === '..') {
                stack.pop();
                continue;
            }
            stack.push(p);
        }
        const resolved = stack.join('/');
        return isSiteAbsolute ? '/' + resolved : resolved;
    }

    function expandScriptToAssets(scriptDef, root, urlSuffix, thirdParty) {
        const assets = [];
        const suffix = urlSuffix || '';
        const pushRel = (kind, relativePath, name) => {
            if (!relativePath) return;
            if (/^https?:\/\//i.test(relativePath)) {
                assets.push({ kind: kind, url: relativePath, name: name });
                return;
            }
            const url = resolveAssetUrl(root, relativePath);
            if (!url) return;
            assets.push({
                kind: kind,
                url: url + suffix,
                path: relativePath,
                name: name
            });
        };
        for (const tpName of scriptDef.thirdParty || []) {
            const tp = thirdParty[tpName];
            if (!tp) continue;
            (tp.css || []).forEach((css) => pushRel('css', css, tpName));
            (tp.js || []).forEach((js) => pushRel('js', js, tpName));
        }
        if (scriptDef.css) pushRel('css', scriptDef.css, scriptDef.name);
        if (scriptDef.script) pushRel('js', scriptDef.script, scriptDef.name);
        return assets;
    }

    function buildOrderedScriptList(enabled, majorVersion, byName) {
        const enabledScripts = SCRIPT_DEFINITIONS.filter(
            (s) => enabled[s.name] && isScriptCompatible(s, majorVersion)
        );
        const allDependencyNames = new Set();
        enabledScripts.forEach((script) => {
            collectAllDependencies(script, enabled, byName).forEach((d) => allDependencyNames.add(d));
        });
        const dependencyNames = topoSortScriptNames(
            SCRIPT_DEFINITIONS.map((s) => s.name).filter((n) => allDependencyNames.has(n) && enabled[n]),
            byName
        );
        const nonDeps = enabledScripts.filter((s) => !allDependencyNames.has(s.name));
        const priority = nonDeps.filter((s) => s.priority === true).map((s) => s.name);
        const regular = nonDeps.filter((s) => !s.priority).map((s) => s.name);
        return dependencyNames.concat(priority, regular);
    }

    function buildConfigScriptList(enabled, majorVersion, byName) {
        const names = CONFIG_DEPENDENCY_NAMES.filter((n) => {
            const def = byName.get(n);
            if (!def) return false;
            return isScriptCompatible(def, majorVersion);
        });
        let changed = true;
        while (changed) {
            changed = false;
            names.slice().forEach((n) => {
                const def = byName.get(n);
                (def && def.dependencies || []).forEach((dep) => {
                    if (!names.includes(dep) && byName.has(dep) && isScriptCompatible(byName.get(dep), majorVersion)) {
                        names.push(dep);
                        changed = true;
                    }
                });
            });
        }
        return topoSortScriptNames(names, byName);
    }

    function buildLoadPlan(config, majorVersion, options) {
        options = options || {};
        const root = normalizeRoot(
            options.root
            || getResolvedKefinRoot(config)
            || ''
        );
        if (!root) throw new Error('kefinTweaksRoot is required to build load plan');
        const urlSuffix = options.urlSuffix || assetVersionSuffix(config);
        const byName = definitionsByName();
        const enabled = mergeEnabledScripts(config);
        const featuresDisabled = (config && config.enabled === false) || options.configOnly === true;

        let scriptNames;
        if (featuresDisabled) {
            scriptNames = buildConfigScriptList(enabled, majorVersion, byName);
        } else {
            scriptNames = buildOrderedScriptList(enabled, majorVersion, byName);
            const configNames = buildConfigScriptList(enabled, majorVersion, byName);
            configNames.forEach((n) => {
                if (!scriptNames.includes(n)) scriptNames.push(n);
            });
        }

        const assets = [];
        const seen = new Set();
        const pushAssets = (list) => {
            list.forEach((a) => {
                const key = a.kind + '|' + (a.url || a.path || '');
                if (seen.has(key)) return;
                seen.add(key);
                assets.push(a);
            });
        };

        scriptNames.forEach((name) => {
            const def = byName.get(name);
            if (!def) return;
            pushAssets(expandScriptToAssets(def, root, urlSuffix, THIRD_PARTY_SCRIPTS));
        });

        pushAssets([
            {
                kind: 'css',
                url: resolveAssetUrl(root, CONFIGURATION_FILES.css) + urlSuffix,
                path: CONFIGURATION_FILES.css,
                name: 'configuration'
            },
            {
                kind: 'js',
                url: resolveAssetUrl(root, CONFIGURATION_FILES.script) + urlSuffix,
                path: CONFIGURATION_FILES.script,
                name: 'configuration'
            }
        ]);

        const stamp = [
            // Generator version. The stamp decides whether the stored entry is
            // rewritten, so bump this whenever buildInjectorScript's output changes
            // or existing installs keep running the old script. g2: console gate.
            // g3: Jellyfin 12's URI-encoded app name in version detection.
            // g4: our files carry ?v=<config.assetVersion>.
            'g4',
            root,
            String(majorVersion == null ? 'unknown' : majorVersion),
            featuresDisabled ? 'config-only' : 'full',
            scriptNames.join(',')
        ].join('|');

        return {
            assets,
            stamp,
            scriptNames,
            definitions: SCRIPT_DEFINITIONS,
            root,
            majorVersion
        };
    }

    function ensureKefinTweaksApi(definitions) {
        const defs = definitions || SCRIPT_DEFINITIONS;
        const existing = window.KefinTweaks || {};
        window.KefinTweaks = {
            _jellyfinMajorVersion: existing._jellyfinMajorVersion != null ? existing._jellyfinMajorVersion : null,
            parseMajorVersion: parseMajorVersion,
            getJellyfinMajorVersion: async function getJellyfinMajorVersion() {
                try {
                    if (window.KefinTweaks._jellyfinMajorVersion != null) {
                        return window.KefinTweaks._jellyfinMajorVersion;
                    }
                    if (!window.ApiClient || (!window.ApiClient._appVersion && !window.ApiClient._serverVersion)) {
                        const startTime = Date.now();
                        while (Date.now() - startTime < 5000) {
                            if (window.ApiClient && (window.ApiClient._appVersion || window.ApiClient._serverVersion)) break;
                            await new Promise((r) => setTimeout(r, 200));
                        }
                    }
                    if (!window.ApiClient) return null;
                    // Jellyfin 12 stores the app name URI-encoded ('Jellyfin%20Web').
                    if (String(window.ApiClient._appName).replace(/%20/g, ' ') === 'Jellyfin Web' && window.ApiClient._appVersion) {
                        window.KefinTweaks._jellyfinMajorVersion = parseMajorVersion(window.ApiClient._appVersion);
                        return window.KefinTweaks._jellyfinMajorVersion;
                    }
                    if (!window.ApiClient._serverVersion) {
                        const startTime = Date.now();
                        while (Date.now() - startTime < 10000) {
                            if (window.ApiClient._serverVersion) break;
                            await new Promise((r) => setTimeout(r, 500));
                        }
                    }
                    window.KefinTweaks._jellyfinMajorVersion = parseMajorVersion(window.ApiClient._serverVersion);
                    return window.KefinTweaks._jellyfinMajorVersion;
                } catch (e) {
                    WARN('getJellyfinMajorVersion failed:', e);
                    return null;
                }
            },
            getScripts: function () { return defs.slice(); }
        };
        return window.KefinTweaks;
    }

    /* Is this file already on the page, under any token?
     *
     * Matched on the resolved address without its query. The baked
     * KefinTweaks-injector and this live plan normally name a file identically,
     * but not while the stored entry predates the token (it is rebuilt on the
     * next admin page load): an exact-attribute match then misses, and every
     * script would run twice. */
    function bareUrl(url) {
        try { return new URL(url, document.baseURI).href.split('?')[0]; } catch (e) { return String(url).split('?')[0]; }
    }

    function assetOnPage(kind, url) {
        const want = bareUrl(url);
        const nodes = kind === 'css'
            ? document.querySelectorAll('link[rel="stylesheet"][href]')
            : document.querySelectorAll('script[src]');
        for (const n of nodes) {
            if (bareUrl(kind === 'css' ? n.href : n.src) === want) return true;
        }
        return false;
    }

    function applyAssetsToDocument(assets) {
        (assets || []).forEach((a) => {
            if (!a || !a.url) return;
            if (a.kind === 'css') {
                if (assetOnPage('css', a.url)) return;
                const l = document.createElement('link');
                l.rel = 'stylesheet';
                l.type = 'text/css';
                l.href = a.url;
                document.head.appendChild(l);
            } else {
                if (assetOnPage('js', a.url)) return;
                const s = document.createElement('script');
                s.src = a.url;
                s.async = false;
                document.head.appendChild(s);
            }
        });
    }

    function extractInjectorStamp(scriptText) {
        if (typeof scriptText === 'string' && scriptText) {
            const marker = scriptText.match(/\/\/\s*kefinTweaksInjectorStamp=(.+)/);
            if (marker && marker[1]) {
                return String(marker[1]).trim();
            }
            const winAssign = scriptText.match(/window\.KefinTweaksInjectorStamp\s*=\s*("(?:\\.|[^"\\])*")/);
            if (winAssign && winAssign[1]) {
                try {
                    return JSON.parse(winAssign[1]);
                } catch (e) { /* ignore */ }
            }
            const eventStamp = scriptText.match(/stamp:\s*("(?:\\.|[^"\\])*")/);
            if (eventStamp && eventStamp[1]) {
                try {
                    return JSON.parse(eventStamp[1]);
                } catch (e) { /* ignore */ }
            }
        }
        if (typeof window !== 'undefined' && window.KefinTweaksInjectorStamp != null) {
            return String(window.KefinTweaksInjectorStamp);
        }
        return null;
    }

    function isExperimentalKefinRoot(root) {
        return /@experimental(\/|$)/i.test(String(root || ''));
    }

    function isOfficialJsDelivrKefinRoot(root) {
        return /cdn\.jsdelivr\.net\/gh\/ranaldsgift\/KefinTweaks@/i.test(String(root || ''));
    }

    /**
     * Whether baked KefinTweaks-injector should inject assets for this root.
     * Allow Experimental and self-host/custom; no-op for official jsDelivr Latest/Dev/version/SHA.
     */
    function allowsKefinInjectorPreload(root) {
        const r = String(root || '').trim();
        if (!r) return false;
        if (isExperimentalKefinRoot(r)) return true;
        if (!isOfficialJsDelivrKefinRoot(r)) return true;
        return false;
    }

    function buildInjectorScript(loadPlan) {
        // Bake relative paths (and absolute http urls); join with resolved root at runtime
        const bakeAssets = (loadPlan.assets || []).map((a) => {
            if (!a) return null;
            if (a.url && /^https?:\/\//i.test(a.url) && !a.path) {
                return { kind: a.kind, url: a.url, name: a.name };
            }
            if (a.path) {
                return { kind: a.kind, path: a.path, name: a.name };
            }
            if (a.url) {
                return { kind: a.kind, url: a.url, name: a.name };
            }
            return null;
        }).filter(Boolean);

        const assetsJson = JSON.stringify(bakeAssets);
        const defsJson = JSON.stringify(loadPlan.definitions || SCRIPT_DEFINITIONS);
        const stamp = loadPlan.stamp || '';
        const stampJson = JSON.stringify(stamp);
        return [
            '// KefinTweaks-injector — auto-generated; do not edit',
            '// kefinTweaksInjectorStamp=' + stamp,
            '(function () {',
            '  if (window.KefinTweaksScriptsPreloaded) return;',
            '  var cfg = window.KefinTweaksConfig || {};',
            '  if (cfg.enabled !== true) return;',
            // Same console gate as injector.js and kefinTweaks-plugin.js. This
            // entry runs first, and without it a console skipped only injector.js
            // while every feature script and skin still loaded from here.
            '  try {',
            "    if (localStorage.getItem('kefinTweaks.allowConsole') !== '1' && cfg.disableOnConsoles !== false) {",
            "      if (/\\bXbox\\b|PlayStation|PLAYSTATION|\\bNintendo\\b|WiiU|NintendoBrowser/i.test(navigator.userAgent || '')) return;",
            '    }',
            '  } catch (e) {}',
            '  var symbolicRoot = cfg.kefinTweaksRoot || \'\';',
            '  var isExperimental = /@experimental(\\/|$)/i.test(String(symbolicRoot));',
            '  var isOfficialCdn = /cdn\\.jsdelivr\\.net\\/gh\\/ranaldsgift\\/KefinTweaks@/i.test(String(symbolicRoot));',
            '  if (!String(symbolicRoot).trim()) return;',
            '  if (!isExperimental && isOfficialCdn) return;',
            '  var resolvedRoot = String(cfg.kefinTweaksRootResolved || cfg.kefinTweaksRoot || \'\').trim();',
            '  if (!resolvedRoot) return;',
            '  if (resolvedRoot.charAt(resolvedRoot.length - 1) !== \'/\') resolvedRoot += \'/\';',
            // Read from the config at run time, not baked: a deploy changes the
            // token without rebuilding this entry, and the live plan reads the
            // same value, so both name each file identically.
            '  var assetSuffix = cfg.assetVersion ? \'?v=\' + encodeURIComponent(String(cfg.assetVersion)) : \'\';',
            '  window.KefinTweaksAssetUrl = function (url) { return (url && assetSuffix && url.indexOf(\'?\') === -1) ? url + assetSuffix : url; };',
            '  function joinAssetUrl(relativePath) {',
            '    if (!relativePath) return null;',
            '    if (/^https?:\\/\\//i.test(relativePath)) return relativePath;',
            '    var base = resolvedRoot + \'scripts/\';',
            '    try { return new URL(relativePath, base).href + assetSuffix; } catch (e) { return base + relativePath + assetSuffix; }',
            '  }',
            '  window.KefinTweaksScriptsPreloaded = true;',
            '  window.KefinTweaksInjectorStamp = ' + stampJson + ';',
            '  var SCRIPT_DEFINITIONS_BAKED = ' + defsJson + ';',
            '  function parseMajorVersion(version) {',
            "    if (!version || typeof version !== 'string') return null;",
            "    var versionParts = version.split('.');",
            "    if (versionParts[0] !== '10') {",
            '      var majorVersion = parseInt(versionParts[0], 10);',
            '      return isNaN(majorVersion) ? null : majorVersion;',
            '    }',
            '    if (versionParts.length >= 2) {',
            '      var majorVersion2 = parseInt(versionParts[1], 10);',
            '      if (!isNaN(majorVersion2)) return majorVersion2;',
            '    }',
            '    return null;',
            '  }',
            '  window.KefinTweaks = {',
            '    _jellyfinMajorVersion: null,',
            '    parseMajorVersion: parseMajorVersion,',
            '    getJellyfinMajorVersion: async function () {',
            '      try {',
            '        if (window.KefinTweaks._jellyfinMajorVersion != null) return window.KefinTweaks._jellyfinMajorVersion;',
            '        if (!window.ApiClient || (!window.ApiClient._appVersion && !window.ApiClient._serverVersion)) {',
            '          var start = Date.now();',
            '          while (Date.now() - start < 5000) {',
            '            if (window.ApiClient && (window.ApiClient._appVersion || window.ApiClient._serverVersion)) break;',
            '            await new Promise(function (r) { setTimeout(r, 200); });',
            '          }',
            '        }',
            '        if (!window.ApiClient) return null;',
            "        if (String(window.ApiClient._appName).replace(/%20/g, ' ') === 'Jellyfin Web' && window.ApiClient._appVersion) {",
            '          window.KefinTweaks._jellyfinMajorVersion = parseMajorVersion(window.ApiClient._appVersion);',
            '          return window.KefinTweaks._jellyfinMajorVersion;',
            '        }',
            '        if (!window.ApiClient._serverVersion) {',
            '          var start2 = Date.now();',
            '          while (Date.now() - start2 < 10000) {',
            '            if (window.ApiClient._serverVersion) break;',
            '            await new Promise(function (r) { setTimeout(r, 500); });',
            '          }',
            '        }',
            '        window.KefinTweaks._jellyfinMajorVersion = parseMajorVersion(window.ApiClient._serverVersion);',
            '        return window.KefinTweaks._jellyfinMajorVersion;',
            '      } catch (e) { return null; }',
            '    },',
            '    getScripts: function () { return SCRIPT_DEFINITIONS_BAKED.slice(); }',
            '  };',
            '  window.KefinTweaks.getJellyfinMajorVersion();',
            '  var assets = ' + assetsJson + ';',
            '  for (var i = 0; i < assets.length; i++) {',
            '    var a = assets[i];',
            '    if (!a) continue;',
            '    var href = a.url || joinAssetUrl(a.path);',
            '    if (!href) continue;',
            '    if (a.kind === \'css\') {',
            '      if (document.querySelector(\'link[href="\' + href + \'"]\')) continue;',
            '      var l = document.createElement(\'link\');',
            '      l.rel = \'stylesheet\';',
            '      l.type = \'text/css\';',
            '      l.href = href;',
            '      document.head.appendChild(l);',
            '    } else {',
            '      if (document.querySelector(\'script[src="\' + href + \'"]\')) continue;',
            '      var s = document.createElement(\'script\');',
            '      s.src = href;',
            '      s.async = false;',
            '      document.head.appendChild(s);',
            '    }',
            '  }',
            '  try {',
            '    document.dispatchEvent(new CustomEvent(\'kefinTweaksLoaded\', {',
            '      detail: { stamp: ' + stampJson + ', timestamp: new Date().toISOString() }',
            '    }));',
            '  } catch (e) {}',
            '})();'
        ].join('\n');
    }

    function upsertInjectorEntries(customJavaScripts, opts) {
        opts = opts || {};
        const list = Array.isArray(customJavaScripts) ? customJavaScripts.slice() : [];
        const upsert = (name, scriptContent) => {
            const idx = list.findIndex((s) => s.Name === name);
            const entry = {
                Name: name,
                Script: scriptContent,
                Enabled: true,
                RequiresAuthentication: false
            };
            if (idx !== -1) list[idx] = Object.assign({}, list[idx], entry);
            else list.push(entry);
        };
        if (opts.configScriptContent != null) upsert(KEFIN_CONFIG_ENTRY_NAME, opts.configScriptContent);
        if (opts.injectorScriptContent != null) upsert(KEFIN_INJECTOR_ENTRY_NAME, opts.injectorScriptContent);

        const configIdx = list.findIndex((s) => s.Name === KEFIN_CONFIG_ENTRY_NAME);
        const injIdx = list.findIndex((s) => s.Name === KEFIN_INJECTOR_ENTRY_NAME);
        if (configIdx !== -1 && injIdx !== -1 && configIdx > injIdx) {
            const cfg = list.splice(configIdx, 1)[0];
            const newInjIdx = list.findIndex((s) => s.Name === KEFIN_INJECTOR_ENTRY_NAME);
            list.splice(newInjIdx, 0, cfg);
        }
        return list;
    }

    function hasEnabledInjectorEntry(customJavaScripts) {
        const list = Array.isArray(customJavaScripts) ? customJavaScripts : [];
        const entry = list.find((s) => s.Name === KEFIN_INJECTOR_ENTRY_NAME);
        return !!(entry && entry.Enabled !== false);
    }

    // Jellyfin 12 URI-encodes these when it creates the ApiClient, so deviceId() and
    // friends come back already encoded; the server decodes the header once. Decode
    // first, as jellyfin-web does, or a doubly encoded DeviceId registers these
    // requests as a separate device and session.
    function encodeAuthParam(value) {
        let decoded = String(value);
        try { decoded = decodeURIComponent(decoded); } catch (e) { /* not encoded */ }
        return encodeURIComponent(decoded);
    }

    function getInjectorAuthHeader() {
        const token = window.ApiClient && typeof window.ApiClient.accessToken === 'function'
            ? window.ApiClient.accessToken()
            : '';
        if (!token) return null;
        const client = typeof window.ApiClient.applicationName === 'function'
            ? window.ApiClient.applicationName()
            : 'Jellyfin Web';
        const device = typeof window.ApiClient.deviceName === 'function'
            ? window.ApiClient.deviceName()
            : 'Browser';
        const deviceId = typeof window.ApiClient.deviceId === 'function'
            ? window.ApiClient.deviceId()
            : '';
        const version = window.ApiClient._appVersion || window.ApiClient._serverVersion || '';
        return 'MediaBrowser Client="' + encodeAuthParam(client)
            + '", Device="' + encodeAuthParam(device)
            + '", DeviceId="' + encodeAuthParam(deviceId)
            + '", Version="' + encodeAuthParam(version)
            + '", Token="' + encodeAuthParam(token) + '"';
    }

    function isLoggedInForInjectorSync() {
        try {
            return !!(window.ApiClient
                && window.ApiClient._loggedIn
                && typeof window.ApiClient.accessToken === 'function'
                && window.ApiClient.accessToken()
                && window.ApiClient._serverAddress);
        } catch (e) {
            return false;
        }
    }

    async function isAdminForInjectorSync() {
        try {
            if (!window.ApiClient || typeof window.ApiClient.getCurrentUser !== 'function') return false;
            const user = await window.ApiClient.getCurrentUser();
            return !!(user && user.Policy && user.Policy.IsAdministrator === true);
        } catch (e) {
            return false;
        }
    }

    async function findJavaScriptInjectorPluginId() {
        const server = window.ApiClient && window.ApiClient._serverAddress;
        const auth = getInjectorAuthHeader();
        if (!server || !auth) return null;
        const response = await fetch(server + '/Plugins', {
            headers: { Authorization: auth }
        });
        if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + response.statusText);
        const plugins = await response.json();
        const list = Array.isArray(plugins) ? plugins : (plugins.Items || []);
        const plugin = list.find((p) => p.Name === 'JavaScript Injector' || p.Name === 'JS Injector');
        return plugin ? plugin.Id : null;
    }

    /**
     * Rewrite baked KefinTweaks-injector when live plan stamp differs.
     * Admin + logged-in only. Leaves KefinTweaks-Config unchanged.
     * @param {{ stamp?: string, assets?: Array, definitions?: Array }} loadPlan
     * @returns {Promise<{ synced: boolean, reason?: string, stamp?: string }>}
     */
    async function syncKefinTweaksInjector(loadPlan) {
        if (!loadPlan || !loadPlan.stamp) {
            return { synced: false, reason: 'no load plan stamp' };
        }
        if (!isLoggedInForInjectorSync()) {
            return { synced: false, reason: 'not logged in' };
        }
        if (!(await isAdminForInjectorSync())) {
            return { synced: false, reason: 'not admin' };
        }

        try {
            const pluginId = await findJavaScriptInjectorPluginId();
            if (!pluginId) {
                return { synced: false, reason: 'JavaScript Injector plugin not found' };
            }

            const server = window.ApiClient._serverAddress;
            const auth = getInjectorAuthHeader();
            const configUrl = server + '/Plugins/' + pluginId + '/Configuration';
            const getResponse = await fetch(configUrl, {
                headers: { Authorization: auth }
            });
            if (!getResponse.ok) {
                return { synced: false, reason: 'GET failed HTTP ' + getResponse.status };
            }

            const injectorConfig = await getResponse.json();
            if (!injectorConfig.CustomJavaScripts) {
                injectorConfig.CustomJavaScripts = [];
            }

            const existing = (injectorConfig.CustomJavaScripts || []).find(
                (s) => s.Name === KEFIN_INJECTOR_ENTRY_NAME
            );
            const existingStamp = existing ? extractInjectorStamp(existing.Script) : null;
            if (existingStamp && existingStamp === loadPlan.stamp) {
                LOG('KefinTweaks-injector stamp up to date:', loadPlan.stamp);
                return { synced: false, reason: 'stamp match', stamp: loadPlan.stamp };
            }

            const injectorScriptContent = buildInjectorScript(loadPlan);
            injectorConfig.CustomJavaScripts = upsertInjectorEntries(
                injectorConfig.CustomJavaScripts,
                { injectorScriptContent }
            );

            const postResponse = await fetch(configUrl, {
                method: 'POST',
                headers: {
                    Authorization: auth,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(injectorConfig)
            });
            if (!postResponse.ok) {
                return {
                    synced: false,
                    reason: 'POST failed HTTP ' + postResponse.status + ': ' + postResponse.statusText
                };
            }

            window.KefinTweaksInjectorStamp = loadPlan.stamp;
            LOG(
                'Synced KefinTweaks-injector (',
                (loadPlan.assets && loadPlan.assets.length) || 0,
                'assets). stamp:',
                existingStamp || '(none)',
                '->',
                loadPlan.stamp
            );
            return { synced: true, stamp: loadPlan.stamp };
        } catch (err) {
            WARN('syncKefinTweaksInjector failed:', err);
            return { synced: false, reason: String(err && err.message ? err.message : err) };
        }
    }

    window.KefinTweaksLoader = {
        KEFIN_INJECTOR_ENTRY_NAME: KEFIN_INJECTOR_ENTRY_NAME,
        KEFIN_CONFIG_ENTRY_NAME: KEFIN_CONFIG_ENTRY_NAME,
        SCRIPT_DEFINITIONS: SCRIPT_DEFINITIONS,
        DEFAULT_ENABLED_SCRIPTS: DEFAULT_ENABLED_SCRIPTS,
        THIRD_PARTY_SCRIPTS: THIRD_PARTY_SCRIPTS,
        CONFIG_DEPENDENCY_NAMES: CONFIG_DEPENDENCY_NAMES,
        parseMajorVersion: parseMajorVersion,
        isScriptCompatible: isScriptCompatible,
        mergeEnabledScripts: mergeEnabledScripts,
        normalizeRoot: normalizeRoot,
        getResolvedKefinRoot: getResolvedKefinRoot,
        resolveAssetUrl: resolveAssetUrl,
        buildLoadPlan: buildLoadPlan,
        buildInjectorScript: buildInjectorScript,
        isExperimentalKefinRoot: isExperimentalKefinRoot,
        isOfficialJsDelivrKefinRoot: isOfficialJsDelivrKefinRoot,
        allowsKefinInjectorPreload: allowsKefinInjectorPreload,
        extractInjectorStamp: extractInjectorStamp,
        syncKefinTweaksInjector: syncKefinTweaksInjector,
        ensureKefinTweaksApi: ensureKefinTweaksApi,
        applyAssetsToDocument: applyAssetsToDocument,
        upsertInjectorEntries: upsertInjectorEntries,
        hasEnabledInjectorEntry: hasEnabledInjectorEntry
    };

    LOG('Module loaded (' + SCRIPT_DEFINITIONS.length + ' script definitions)');
})();
