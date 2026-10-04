// KefinTweaks Section Helper
// Discovery source resolution + section load helpers (extracted from homeScreen3).
(function () {
    'use strict';

    const LOG = (...args) => console.log('[KefinTweaks SectionHelper]', ...args);
    const WARN = (...args) => console.warn('[KefinTweaks SectionHelper]', ...args);
    const ERR = (...args) => console.error('[KefinTweaks SectionHelper]', ...args);

    const ApiHelper = window.apiHelper || window.ApiHelper;
    const Config = () => window.KefinHomeConfig2 || window.KefinHomeScreen?.getConfig?.() || {};

    const discoveryState = {
        renderedDiscoveryIds: {
            genres: new Set(),
            genresSeries: new Set(),
            seriesStudios: new Set(),
            seriesStudiosTopRated: new Set(),
            collections: new Set(),
            people: new Set(),
            similar: new Set(),
            watchlist: new Set(),
            customDiscoverySections: new Set()
        },
        /** Session-scoped: discovery template ids whose source pool resolved empty (not incomplete cache). */
        emptyDiscoverySourceTemplates: new Set(),
        currentDiscoveryGenre: null,
        currentDiscoveryStudio: null,
        // Map of pairKey -> Promise resolving to dynamicResult for spotlight pairing
        pairResolvePromises: new Map()
    };

    function getDiscoverySettings() {
        const defaults = window.KefinHomeConfig2?.DISCOVERY_SETTINGS || {};
        const fromHome = window.KefinHomeScreen?.getConfig?.()?.DISCOVERY_SETTINGS;
        const fromUser = window.KefinTweaksConfig?.homeScreenConfig?.DISCOVERY_SETTINGS;
        return {
            ...defaults,
            ...(fromHome || {}),
            ...(fromUser || {})
        };
    }

    function getPairKey(configId) {
        if (configId === 'genreMovies' || configId === 'spotlightGenre') return 'genre-movie';
        if (configId === 'genreSeries' || configId === 'spotlightGenreSeries') return 'genre-series';
        if (configId === 'studioShows' || configId === 'spotlightNetwork') return 'studio-series';
        return null;
    }

    function resetDiscoveryDedupe() {
        const ids = discoveryState.renderedDiscoveryIds;
        Object.keys(ids).forEach((key) => {
            if (ids[key] instanceof Set) ids[key].clear();
        });
        discoveryState.emptyDiscoverySourceTemplates.clear();
        discoveryState.currentDiscoveryGenre = null;
        discoveryState.currentDiscoveryStudio = null;
        discoveryState.pairResolvePromises.clear();
    }

    function getDiscoveryTemplateExclusionKey(configOrId) {
        if (configOrId == null) return '';
        if (typeof configOrId === 'string') {
            const id = configOrId;
            const stamped = id.replace(/-\d{10,}-[a-z0-9]+$/i, '');
            return stamped || id.split('-')[0] || id;
        }
        if (configOrId.discoveryTemplateId) return String(configOrId.discoveryTemplateId);
        return getDiscoveryTemplateExclusionKey(String(configOrId.id || ''));
    }

    function markEmptyDiscoverySourceTemplate(configOrId) {
        const key = getDiscoveryTemplateExclusionKey(configOrId);
        if (!key) return;
        discoveryState.emptyDiscoverySourceTemplates.add(key);
        LOG(`Excluding empty discovery source template for session: ${key}`);
    }

    function isEmptyDiscoverySourceTemplate(configOrId) {
        const key = getDiscoveryTemplateExclusionKey(configOrId);
        return !!key && discoveryState.emptyDiscoverySourceTemplates.has(key);
    }

    /**
     * One-shot: whether this section's dependent Movies/Series/People cache is already complete.
     * Incomplete → skip (do not poll/wait). Missing LibraryCache → treat as ready.
     */
    async function isSectionCacheReady(sectionConfig) {
        if (!window.LibraryCache?.sectionDependsOnIncompleteCache) return true;
        try {
            return (await window.LibraryCache.sectionDependsOnIncompleteCache(sectionConfig)) !== true;
        } catch (_) {
            return true;
        }
    }

    function scheduleViewMoreUrl(sectionConfig) {
        resolveViewMoreUrl(sectionConfig).then((viewMoreUrl) => {
            if (viewMoreUrl) sectionConfig.viewMoreUrl = viewMoreUrl;
        }).catch((err) => {
            WARN(`Failed to resolve viewMoreUrl for ${sectionConfig?.id}:`, err);
        });
    }

    async function loadSectionForRendering(sectionConfig) {
        LOG(`Loading Section for Rendering: ${sectionConfig.id} (${sectionConfig.name})`);

        const loadSectionTimerStart = performance.now();
        const hasStaticItems = sectionConfig.items && sectionConfig.items.length > 0;

        // Sync prep only (viewMore deferred for non-static so it does not block first paint)
        const cardFormat = resolveCardFormat(sectionConfig);
        const sectionName = fillTemplate(sectionConfig.name, sectionConfig.metadata);

        sectionConfig.overflowCard = true;

        if (cardFormat) {
            sectionConfig.cardFormat = cardFormat;
        }
        if (sectionName) {
            sectionConfig.name = sectionName;
        }

        // Check renderMode first (preferred), fallback to spotlight boolean for backward compatibility
        const shouldRenderSpotlight = sectionConfig.renderMode === 'Spotlight' || sectionConfig.renderMode === 'Random' || sectionConfig.spotlight === true;
        if (shouldRenderSpotlight) {
            const spotlightConfig = {
                ...(window.KefinHomeScreen?.getConfig?.()?.SPOTLIGHT_SETTINGS || {}),
                ...sectionConfig.spotlightConfig
            };
            sectionConfig.spotlightConfig = spotlightConfig;
            // Set renderMode if not already set (for backward compatibility)
            if (!sectionConfig.renderMode && sectionConfig.spotlight) {
                sectionConfig.renderMode = 'Spotlight';
            }
        }

        // Static items: normalize and return immediately (no queries, no dataPromise)
        if (hasStaticItems) {
            const viewMoreUrl = await resolveViewMoreUrl(sectionConfig);
            if (viewMoreUrl) {
                sectionConfig.viewMoreUrl = viewMoreUrl;
            }

            const kefinTweaksRoot = window.KefinTweaksConfig?.kefinTweaksRoot || '';
            const serverId = ApiClient.serverId();
            const normalizeTemplate = (value) => (value || '')
                .replace(/\$\{kefinTweaksRoot\}/g, kefinTweaksRoot)
                .replace(/\$\{serverId\}/g, serverId);

            const normalizedItems = sectionConfig.items.map((item, index) => {
                const posterUrl = normalizeTemplate(item.posterUrl);
                const thumbUrl = normalizeTemplate(item.thumbUrl);
                const squareUrl = normalizeTemplate(item.squareUrl);
                const imageUrl = normalizeTemplate(item.imageUrl);
                const cardUrl = normalizeTemplate(item.cardUrl);
                const backdropUrl = normalizeTemplate(item.backdropUrl);
                const bannerUrl = normalizeTemplate(item.bannerUrl);
                const logoUrl = normalizeTemplate(item.logoUrl);

                return {
                    Name: item.Name,
                    Id: item.Id || 'static-' + sectionConfig.id + '-' + index,
                    Type: item.Type || 'Folder',
                    posterUrl: posterUrl,
                    thumbUrl: thumbUrl,
                    squareUrl: squareUrl,
                    imageUrl: imageUrl,
                    cardUrl: cardUrl,
                    backdropUrl: backdropUrl,
                    bannerUrl: bannerUrl,
                    logoUrl: logoUrl,
                    CustomFooterText: item.cardFooter || undefined
                };
            });
            const loadSectionTimerEnd = performance.now();
            const loadSectionDuration = loadSectionTimerEnd - loadSectionTimerStart;
            LOG(`Section ${sectionConfig.id} (static items) loaded for rendering in time: ${loadSectionDuration.toFixed(2)}ms`);
            let postProcessedItems = normalizedItems;
            if (window.cardBuilder.postProcessItems) {
                postProcessedItems = window.cardBuilder.postProcessItems(sectionConfig, normalizedItems);
            }

            return {
                config: sectionConfig,
                result: { data: postProcessedItems }
            };
        }

        // Cache-backed sections only mount once Movies/Series/People cache is complete
        if (!(await isSectionCacheReady(sectionConfig))) {
            LOG(`Skipping section ${sectionConfig.id}: dependent library cache not complete`);
            return null;
        }

        scheduleViewMoreUrl(sectionConfig);

        // External list (MDBList) — progressive for network fetch when caches are already ready
        if (Array.isArray(sectionConfig.externalListUrls) && sectionConfig.externalListUrls.length > 0) {
            if (!window.KefinExternalList?.resolveExternalListItems) {
                WARN(`Section ${sectionConfig.id}: externalListUrls set but KefinExternalList unavailable`);
                return null;
            }

            let mappedDataPromise = null;
            const ensureData = () => {
                if (!mappedDataPromise) {
                    mappedDataPromise = (async () => {
                        if (!(await isSectionCacheReady(sectionConfig))) {
                            return [];
                        }
                        const listResult = await window.KefinExternalList.resolveExternalListItems(sectionConfig);
                        let items = listResult?.Items || [];
                        if (window.cardBuilder.postProcessItems) {
                            items = window.cardBuilder.postProcessItems(sectionConfig, items);
                        }
                        return items;
                    })();
                }
                return mappedDataPromise;
            };

            // Kick off list resolve immediately; first paint may still be empty
            ensureData();

            const result = {
                data: { Items: [] },
                isStale: true,
                ensureData
            };
            Object.defineProperty(result, 'dataPromise', {
                configurable: true,
                enumerable: true,
                get() { return ensureData(); }
            });

            const loadSectionTimerEnd = performance.now();
            LOG(`Section ${sectionConfig.id} (external list) progressive stub in ${(loadSectionTimerEnd - loadSectionTimerStart).toFixed(2)}ms`);
            return {
                config: sectionConfig,
                result
            };
        }

        // Ensure queries array exists when section has no static items
        if (!sectionConfig.queries || !Array.isArray(sectionConfig.queries) || sectionConfig.queries.length === 0) {
            WARN(`Section ${sectionConfig.id} has no queries array and no static items`);
            return null;
        }

        const userId = ApiClient.getCurrentUserId();
        const serverUrl = ApiClient.serverAddress();

        const resolveQueries = window.cardBuilder?.resolveQueriesToLoad;
        const queriesToLoad = typeof resolveQueries === 'function'
            ? resolveQueries(sectionConfig, { initialize: true })
            : (() => {
                if (sectionConfig.queries.length > 1 && sectionConfig.useRandomQuery === true) {
                    const randomIndex = Math.floor(Math.random() * sectionConfig.queries.length);
                    LOG(`Section ${sectionConfig.id}: useRandomQuery — selected query index ${randomIndex}`);
                    return [sectionConfig.queries[randomIndex]];
                }
                return sectionConfig.queries;
            })();

        if (sectionConfig.useMultiQueryPicker === true && sectionConfig.queries.length > 1) {
            const index = sectionConfig._selectedQueryIndex;
            LOG(`Section ${sectionConfig.id}: useMultiQueryPicker — selected query index ${index}`);
        } else if (queriesToLoad.length === 1 && sectionConfig.queries.length > 1 && sectionConfig.useRandomQuery === true) {
            const index = sectionConfig.queries.indexOf(queriesToLoad[0]);
            LOG(`Section ${sectionConfig.id}: useRandomQuery — selected query index ${index}`);
        }

        const postProcess = (cfg, items) => {
            let postProcessedItems = items;
            if (window.cardBuilder.postProcessItems) {
                postProcessedItems = window.cardBuilder.postProcessItems(cfg, items);
            }
            return sortItemsByConfiguredIds(cfg, postProcessedItems);
        };

        // postProcess is synchronous and applySmartFilter is not, so the filter
        // wraps every path data leaves by rather than joining postProcess. A
        // filter that skips the section (null) becomes an empty row, which the
        // progressive renderer already dismisses.
        const needsSmartFilter = !!(sectionConfig.refreshUserData || sectionConfig.postFetchFilter);
        const finish = async (data) => {
            if (!needsSmartFilter) return data;
            return (await applySmartFilter(sectionConfig, data)) ?? [];
        };

        let mappedDataPromise = null;
        const result = {
            data: { Items: [] },
            isStale: true,
            ensureData: null
        };

        const ensureData = () => {
            if (!mappedDataPromise) {
                mappedDataPromise = (async () => {
                    if (!(await isSectionCacheReady(sectionConfig))) {
                        return [];
                    }

                    const results = [];
                    for (const query of queriesToLoad) {
                        let queryResult;

                        if (query.dataSource) {
                            queryResult = await ApiHelper.fetchFromDataSource(
                                query.dataSource,
                                query.queryOptions || {},
                                true,
                                query.dataSourceOptions
                            );
                        } else {
                            const queryUrl = ApiHelper.buildQueryFromSection(query, userId, serverUrl, sectionConfig.renderMode === 'Spotlight', { sectionType: sectionConfig.type });

                            if (typeof queryUrl !== 'string') {
                                WARN(`Invalid query URL for section ${sectionConfig.id}`);
                                continue;
                            }

                            const cacheCfg = Config().CACHE || {};
                            let sectionTtl = cacheCfg.DEFAULT_TTL;
                            if (Number(sectionConfig.ttl) >= 0) {
                                sectionTtl = Number(sectionConfig.ttl);
                            }

                            queryResult = ApiHelper.getQuery(queryUrl, {
                                useCache: true,
                                ttl: sectionTtl
                            });
                        }

                        if (queryResult) results.push(queryResult);
                    }

                    if (!results.length) {
                        return [];
                    }

                    if (results.length > 1) {
                        const merged = ApiHelper.mergeMultiQueryResults(results, sectionConfig);
                        const raw = typeof merged.result?.ensureData === 'function'
                            ? await merged.result.ensureData()
                            : await merged.result?.dataPromise;

                        const hasRefresh = results.some((r) => r && r._refreshPromise);
                        if (hasRefresh) {
                            result.refreshPromise = Promise.all(
                                results.map((r) => r._refreshPromise || Promise.resolve(r.data))
                            ).then((allData) => {
                                const itemsByFreshQuery = [];
                                allData.forEach((data) => {
                                    if (data?.Items) itemsByFreshQuery.push(data.Items);
                                    else if (Array.isArray(data)) itemsByFreshQuery.push(data);
                                });
                                const mergedFresh = window.cardBuilder?.postProcessItemsByQuery
                                    ? window.cardBuilder.postProcessItemsByQuery(sectionConfig, itemsByFreshQuery)
                                    : itemsByFreshQuery.flat();
                                return finish(postProcess(sectionConfig, mergedFresh));
                            });
                        }

                        return finish(postProcess(sectionConfig, raw));
                    }

                    const queryResult = results[0];
                    const raw = typeof queryResult.ensureData === 'function'
                        ? await queryResult.ensureData()
                        : await queryResult.dataPromise;

                    if (queryResult._refreshPromise) {
                        result.refreshPromise = queryResult._refreshPromise.then((fresh) =>
                            finish(postProcess(sectionConfig, fresh))
                        );
                    }

                    return finish(postProcess(sectionConfig, raw));
                })();
            }
            return mappedDataPromise;
        };

        result.ensureData = ensureData;
        Object.defineProperty(result, 'dataPromise', {
            configurable: true,
            enumerable: true,
            get() {
                return ensureData();
            }
        });

        const loadSectionTimerEnd = performance.now();
        LOG(`Section ${sectionConfig.id} progressive stub in ${(loadSectionTimerEnd - loadSectionTimerStart).toFixed(2)}ms`);

        return {
            config: sectionConfig,
            queryUrl: null,
            result
        };
    }

    /**
     * Jellyfin /Items?Ids= does not reliably return items in request order.
     * When queryOptions.Ids is set, re-sort the item list to match that sequence.
     */
    /**
     * Refresh user data and drop watched items, for sections that asked for it.
     * Carried over from the fork, where this lived inline in homeScreen3.js before
     * that code moved here; upstream has no equivalent, and the Smart Suggest
     * sections depend on it. Both hooks it reads -- refreshUserData and
     * postFetchFilter -- are set by buildDiscoverySectionInstance below.
     *
     * Returning null means "skip this section entirely", which is what happens
     * when filtering leaves too few items to be worth a row.
     *
     * @param {Object} sectionConfig - The section being loaded
     * @param {Object|Array} data - Query result, or a bare item array
     * @returns {Promise<Object|Array|null>} Filtered data, or null to skip
     */
    async function applySmartFilter(sectionConfig, data) {
        if (!data) return data;

        let items = data.Items || data;
        if (!Array.isArray(items) || items.length === 0) return data;

        // A cached response carries whatever UserData was true when it was cached,
        // so anything marked played since then would survive the filter below.
        if (sectionConfig.refreshUserData) {
            try {
                const userId = ApiClient.getCurrentUserId();
                const ids = items.map(i => i.Id).filter(Boolean).join(',');
                if (ids) {
                    // RecursiveItemCount is required, not decorative:
                    // Folder.FillUserDataDtoValues only computes
                    // UserData.PlayedPercentage for a Series when the request asks
                    // for it. Without it, in-progress series come back with a null
                    // percentage and pass any threshold.
                    const freshResp = await ApiClient.getJSON(
                        ApiClient.getUrl(`Users/${userId}/Items`, {
                            Ids: ids,
                            Fields: 'RecursiveItemCount'
                        })
                    );
                    if (freshResp?.Items) {
                        const freshMap = new Map(freshResp.Items.map(i => [i.Id, i.UserData]));
                        for (const item of items) {
                            const freshUd = freshMap.get(item.Id);
                            if (freshUd) item.UserData = freshUd;
                        }
                    }
                }
            } catch (e) {
                WARN(`Section ${sectionConfig.id}: could not refresh UserData:`, e);
            }
        }

        if (sectionConfig.postFetchFilter) {
            const filtered = sectionConfig.postFetchFilter(items);
            if (filtered === null) return null;
            if (data.Items) {
                data.Items = filtered;
                data.TotalRecordCount = filtered.length;
            } else {
                data = filtered;
            }
        }

        return data;
    }

    function sortItemsByConfiguredIds(sectionConfig, items) {
        const list = Array.isArray(items) ? items : (items?.Items || []);
        if (!Array.isArray(list) || list.length === 0) return items;

        const rawIds = sectionConfig?.queries?.[0]?.queryOptions?.Ids;
        if (!rawIds) return items;

        const ids = Array.isArray(rawIds)
            ? rawIds.filter(Boolean)
            : String(rawIds).split(',').map((s) => s.trim()).filter(Boolean);
        if (!ids.length) return items;

        const order = new Map(ids.map((id, i) => [String(id), i]));
        const sorted = [...list].sort((a, b) => {
            const ai = order.has(String(a?.Id)) ? order.get(String(a.Id)) : 1e9;
            const bi = order.has(String(b?.Id)) ? order.get(String(b.Id)) : 1e9;
            return ai - bi;
        });

        if (Array.isArray(items)) return sorted;
        if (items && typeof items === 'object' && Array.isArray(items.Items)) {
            return { ...items, Items: sorted };
        }
        return sorted;
    }

    async function getWatchlistUrl() {
        // Resolve it rather than read the cache: a section built before the
        // watchlist script has run would otherwise get #/watchlist even where
        // the Watchlist is a Custom Tabs tab (upstream PR #126).
        return window.KefinTweaksUtils?.getWatchlistUrl
            ? window.KefinTweaksUtils.getWatchlistUrl()
            : (window.KefinTweaksUtils?._watchlistUrl || '#/watchlist');
    }

    /**
     * Resolve view more URL from queryOptions / known section ids
     */
    async function resolveViewMoreUrl(sectionConfig) {
        if (sectionConfig.viewMoreUrl) return sectionConfig.viewMoreUrl;

        const { id } = sectionConfig;

        // Handle specific section IDs
        if (id === 'continueWatching') {
            return `#/tv.html?collectionType=tvshows&tab=1&serverId=${ApiClient.serverId()}`;
        }

        if (id === 'popularTVNetworks') {
            return `#/tv.html?collectionType=tvshows&tab=4&serverId=${ApiClient.serverId()}`;
        }

        if (id === 'upcoming' || id === 'recentlyReleased.episodes') {
            return `#/tv.html?collectionType=tvshows&tab=2&serverId=${ApiClient.serverId()}`;
        }

        if (id === 'nextUp') {
            return `#/list.html?type=nextup&serverId=${ApiClient.serverId()}`;
        }

        if (id === 'watchlist') {
            return await getWatchlistUrl();
        }

        if (id === 'watchAgain') {
            const watchlistUrl = await getWatchlistUrl();

            if (watchlistUrl) {
                return `${watchlistUrl}?pageTab=history`;
            }
            return null;
        }

        // Infer from queries array
        if (sectionConfig.queries && sectionConfig.queries.length > 0) {
            const firstQuery = sectionConfig.queries[0];
            const queryOptions = firstQuery.queryOptions || {};
            const serverId = window.ApiClient ? window.ApiClient.serverId() : '';

            // Check for Tags
            if (queryOptions.Tags) {
                return `#/list.html?type=tag&tag=${encodeURIComponent(queryOptions.Tags)}&serverId=${serverId}`;
            }

            // Check for Genres
            if (queryOptions.Genres) {
                let genreId = queryOptions.Genres;
                if (typeof genreId === 'string' && !genreId.match(/^\d+$/)) {
                    const resolvedId = await ApiHelper.getGenreId(genreId);
                    if (resolvedId) {
                        genreId = resolvedId;
                    }
                }
                return `#/list.html?genreId=${genreId}&serverId=${serverId}`;
            }

            // Check for GenreIds
            if (queryOptions.GenreIds) {
                return `#/list.html?genreId=${queryOptions.GenreIds.join(',')}&serverId=${serverId}`;
            }

            // Check for PersonIds
            if (queryOptions.PersonIds) {
                return `#/details?id=${queryOptions.PersonIds.join(',')}&serverId=${serverId}`;
            }

            // Check for StudioIds
            if (queryOptions.StudioIds) {
                return `#/list.html?studioId=${queryOptions.StudioIds.join(',')}&serverId=${serverId}`;
            }

            // Check for ParentId
            if (queryOptions.ParentId) {
                if (sectionConfig.discoveryType === 'Collection' || sectionConfig.discoveryType === 'Playlist') {
                    return `#/details?id=${queryOptions.ParentId}&serverId=${serverId}`;
                }

                return `#/list.html?parentId=${queryOptions.ParentId}&serverId=${serverId}`;
            }

            // Check for custom path
            if (firstQuery.path) {
                // Derive URL from path if possible
                if (firstQuery.path.includes('NextUp')) {
                    return `#/tv.html?collectionType=tvshows&tab=1`;
                }
                if (firstQuery.path.includes('Upcoming')) {
                    return `#/tv.html?collectionType=tvshows&tab=2`;
                }
                // If query path is Items/itemid/Similar then return the details page for the item
                if (firstQuery.path.includes('Similar')) {
                    const itemId = firstQuery.path.split('/')[2];
                    return `#/details?id=${itemId}&serverId=${serverId}`;
                }
            }
        }

        return null;
    }

    function resolveCardFormat(sectionConfig) {
        return sectionConfig.cardFormat || 'Poster';
    }

    function normalizeDiscoveryConfig(config) {
        const normalized = { ...config };
        normalized.discoveryType = normalized.discoveryType
            || (normalized.source === 'Dynamic' ? normalized.type : null);
        normalized.discoveryPersonType = normalized.discoveryPersonType || normalized.personType || 'Actor';
        normalized.discoveryItemType = normalized.discoveryItemType
            || (Array.isArray(normalized.includeItemTypes) && normalized.includeItemTypes[0])
            || 'Movie';
        if (!normalized.discoverySourceQuery) {
            normalized.discoverySourceQuery = inferLegacyDiscoverySourceQuery(normalized);
        }
        return normalized;
    }

    function inferLegacyDiscoverySourceQuery(config) {
        const itemType = config.discoveryItemType || config.includeItemTypes?.[0] || 'Movie';
        const discoveryType = config.discoveryType;

        if (discoveryType === 'Genre') {
            return {
                path: '/Genres',
                queryOptions: { IncludeItemTypes: [itemType], Limit: 0 }
            };
        }
        if (discoveryType === 'Studio') {
            return {
                path: '/Studios',
                queryOptions: {
                    IncludeItemTypes: [itemType === 'Series' ? 'Series' : 'Movie'],
                    SortBy: 'ChildCount',
                    SortOrder: 'Descending',
                    Limit: 0
                }
            };
        }
        if (discoveryType === 'Collection') {
            return {
                path: '/Items',
                queryOptions: {
                    IncludeItemTypes: ['BoxSet'],
                    Recursive: true,
                    Fields: 'RecursiveItemCount,ChildCount,TotalRecordCount',
                    Limit: 500,
                    SortBy: 'TotalRecordCount'
                }
            };
        }
        if (discoveryType === 'Person') {
            if (config.sourceType && String(config.sourceType).includes('watched')) {
                const poolType = itemType === 'Series' ? 'Episode' : itemType;
                return {
                    path: '/Items',
                    queryOptions: {
                        IncludeItemTypes: [poolType],
                        Recursive: true,
                        Filters: 'IsPlayed',
                        Fields: 'PrimaryImageAspectRatio,UserData,People',
                        SortBy: config.sourceType === 'watched-recent' ? 'DatePlayed' : 'Random',
                        SortOrder: config.sourceType === 'watched-recent' ? 'Descending' : undefined,
                        Limit: config.sourceType === 'watched-recent' ? 5 : 20
                    }
                };
            }
            const role = config.discoveryPersonType || config.personType || 'Actor';
            const method = role === 'Director' ? 'getTopDirectors'
                : role === 'Writer' ? 'getTopWriters'
                    : 'getTopActors';
            return {
                dataSource: `PeopleCache.${method}`,
                dataSourceOptions: { ItemType: itemType },
                queryOptions: { Limit: 100 }
            };
        }
        if (discoveryType === 'Similar' || discoveryType === 'Watchlist') {
            if (config.sourceType === 'liked' || discoveryType === 'Watchlist') {
                return {
                    path: '/Items',
                    queryOptions: {
                        IncludeItemTypes: [itemType === 'Series' ? 'Episode' : itemType],
                        Recursive: true,
                        Filters: discoveryType === 'Watchlist' ? 'Likes' : 'IsFavorite',
                        SortBy: 'Random',
                        Limit: 20,
                        Fields: 'PrimaryImageAspectRatio,UserData,People'
                    }
                };
            }
            if (config.sourceType === 'watched-recent') {
                return {
                    path: '/Items',
                    queryOptions: {
                        IncludeItemTypes: [itemType === 'Series' ? 'Episode' : itemType],
                        Recursive: true,
                        Filters: 'IsPlayed',
                        Fields: 'PrimaryImageAspectRatio,UserData,People',
                        SortBy: 'DatePlayed',
                        SortOrder: 'Descending',
                        Limit: 5
                    }
                };
            }
            if (config.sourceType === 'finished') {
                return {
                    path: '/Items',
                    queryOptions: {
                        IncludeItemTypes: ['Series'],
                        Recursive: true,
                        Filters: 'IsPlayed',
                        SortBy: 'PlayedPercentage',
                        SortOrder: 'Descending',
                        Limit: 5,
                        Fields: 'PrimaryImageAspectRatio,UserData,People'
                    }
                };
            }
            return {
                path: '/Items',
                queryOptions: {
                    IncludeItemTypes: [itemType === 'Series' ? 'Episode' : itemType],
                    Recursive: true,
                    Filters: 'IsPlayed',
                    SortBy: 'Random',
                    Limit: 20,
                    Fields: 'PrimaryImageAspectRatio,UserData,People'
                }
            };
        }
        return null;
    }

    async function unwrapQueryItems(result) {
        if (!result) return [];
        if (Array.isArray(result)) return result;
        if (Array.isArray(result.Items)) return result.Items;
        if (typeof result.ensureData === 'function') {
            const fresh = await result.ensureData();
            if (Array.isArray(fresh)) return fresh;
            return fresh?.Items || [];
        }
        if (result.dataPromise) {
            const fresh = await result.dataPromise;
            if (Array.isArray(fresh)) return fresh;
            return fresh?.Items || [];
        }
        if (Array.isArray(result.data?.Items)) return result.data.Items;
        return [];
    }

    async function fetchDiscoveryPool(sectionConfig) {
        const config = normalizeDiscoveryConfig(sectionConfig);
        const sourceQuery = config.discoverySourceQuery;
        if (!sourceQuery) {
            WARN(`Discovery section ${config.id}: missing discoverySourceQuery`);
            return [];
        }

        if ((await window.LibraryCache?.sectionDependsOnIncompleteCache?.({
            discoverySourceQuery: sourceQuery,
            queries: []
        })) === true) {
            LOG(`Discovery section ${config.id}: skipping pool fetch — incomplete library cache`);
            // null = incomplete cache (do not permanently exclude template)
            return null;
        }

        const cfg = Config();
        const ttl = cfg.CACHE?.DISCOVERY_TTL ?? cfg.CACHE?.LONG_TTL ?? 3600000;
        const userId = ApiClient.getCurrentUserId();
        const serverUrl = ApiClient.serverAddress();
        const built = ApiHelper.buildQueryFromSection(sourceQuery, userId, serverUrl, false);

        if (typeof built === 'object' && built.dataSource) {
            const result = await ApiHelper.fetchFromDataSource(
                built.dataSource,
                built.options || {},
                false,
                built.dataSourceOptions
            );
            return unwrapQueryItems(result);
        }

        if (typeof built !== 'string') return [];
        const stub = ApiHelper.getQuery(built, { useCache: true, ttl });
        const raw = typeof stub.ensureData === 'function' ? await stub.ensureData() : await stub;
        return unwrapQueryItems(raw);
    }

    function shuffleArray(arr) {
        const copy = arr.slice();
        for (let i = copy.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [copy[i], copy[j]] = [copy[j], copy[i]];
        }
        return copy;
    }

    function personDedupeKey(itemType, personType, personId) {
        return `${itemType}:${personType}:${personId}`;
    }

    function isPersonUsed(itemType, personType, personId) {
        return discoveryState.renderedDiscoveryIds.people.has(personDedupeKey(itemType, personType, personId));
    }

    function markPersonUsed(itemType, personType, personId) {
        discoveryState.renderedDiscoveryIds.people.add(personDedupeKey(itemType, personType, personId));
    }

    function getStudioDedupeSet(config) {
        const baseId = String(config.id || '').split('-')[0];
        if (baseId === 'spotlightNetwork' || baseId === 'spotlightNetworkSeries') {
            return discoveryState.renderedDiscoveryIds.seriesStudiosTopRated;
        }
        return discoveryState.renderedDiscoveryIds.seriesStudios;
    }

    function getGenreDedupeSet(itemType) {
        return itemType === 'Series' ? discoveryState.renderedDiscoveryIds.genresSeries : discoveryState.renderedDiscoveryIds.genres;
    }

    function resolveSimilarSourceId(item) {
        if (!item) return null;
        if (item.Type === 'Episode' && item.SeriesId) return item.SeriesId;
        return item.Id;
    }

    function resolveTitleMetadata(item, itemType) {
        const title = item?.SeriesName || item?.Name || '';
        const meta = { Title: title };
        if (itemType === 'Series' || item?.Type === 'Series' || item?.Type === 'Episode') {
            meta.Series = title;
        } else {
            meta.Movie = title;
        }
        return meta;
    }

    function buildPersonMetadata(personName, personType, sourceItem, itemType) {
        const titleMeta = sourceItem ? resolveTitleMetadata(sourceItem, itemType) : {};
        const meta = { Person: personName, ...titleMeta };
        meta[personType] = personName;
        return meta;
    }

    function pickPersonFromHistoryPool(pool, personType, itemType) {
        const shuffled = shuffleArray(pool);
        for (const item of shuffled) {
            if (!item?.People?.length) continue;
            const candidates = item.People.filter((p) => p.Type === personType).slice(0, 10);
            if (!candidates.length) continue;
            const shuffledPeople = shuffleArray(candidates);
            for (const person of shuffledPeople) {
                if (!person?.Id) continue;
                if (isPersonUsed(itemType, personType, person.Id)) continue;
                markPersonUsed(itemType, personType, person.Id);
                return {
                    id: person.Id,
                    name: person.Name,
                    excludeItemId: item.Id,
                    metadata: buildPersonMetadata(person.Name, personType, item, itemType)
                };
            }
        }
        return null;
    }

    function pickPersonFromPeopleCachePool(pool, personType, itemType) {
        const shuffled = shuffleArray(pool);
        for (const person of shuffled) {
            if (!person?.Id) continue;
            if (isPersonUsed(itemType, personType, person.Id)) continue;
            markPersonUsed(itemType, personType, person.Id);
            return {
                id: person.Id,
                name: person.Name,
                metadata: buildPersonMetadata(person.Name, personType, null, itemType)
            };
        }
        return null;
    }

    async function resolveDiscoverySource(rawConfig) {
        const config = normalizeDiscoveryConfig(rawConfig);
        const discoveryType = config.discoveryType;
        const itemType = config.discoveryItemType || 'Movie';
        const personType = config.discoveryPersonType || 'Actor';

        if (!discoveryType || !config.discoverySourceQuery) {
            WARN(`Discovery section misconfigured: ${config.id}`);
            return null;
        }

        let pool = await fetchDiscoveryPool(config);
        // Incomplete library cache — skip this attempt without excluding the template
        if (pool == null) return null;
        if (!pool.length) {
            markEmptyDiscoverySourceTemplate(config);
            return null;
        }

        // "Recently watched" means recently, carried over from the fork. The pool
        // query only sorts by DatePlayed, so on a library with little recent activity
        // it still returns things watched years ago and the row claims otherwise.
        // recentMaxDays <= 0 disables the window.
        if (String(config.sourceType || '').includes('recent')) {
            const recentMaxDays = getDiscoverySettings().recentMaxDays ?? 30;
            if (recentMaxDays > 0) {
                const cutoff = Date.now() - (recentMaxDays * 24 * 60 * 60 * 1000);
                const within = pool.filter((item) => {
                    const last = item?.UserData?.LastPlayedDate;
                    return last ? new Date(last).getTime() >= cutoff : false;
                });
                // Only narrow when something survives: an empty window should fall
                // back to the unfiltered pool rather than silently drop the section.
                if (within.length) pool = within;
            }
        }

        if (discoveryType === 'Genre') {
            const settings = getDiscoverySettings();
            const minCount = itemType === 'Series'
                ? (settings.minGenreSeriesCount ?? settings.minGenreMovieCount ?? 50)
                : (settings.minGenreMovieCount ?? 50);
            const countField = itemType === 'Series' ? 'SeriesCount' : 'MovieCount';
            const dedupe = getGenreDedupeSet(itemType);
            const eligible = pool.filter((g) => !dedupe.has(g.Id) && (g[countField] || 0) > minCount);
            if (!eligible.length) return null;
            const selected = eligible[Math.floor(Math.random() * eligible.length)];
            dedupe.add(selected.Id);
            return {
                id: selected.Id,
                name: selected.Name,
                metadata: { Genre: selected.Name }
            };
        }

        if (discoveryType === 'Studio') {
            const dedupe = getStudioDedupeSet(config);
            /* Pick only a studio that can fill the row. /Studios reports how many
             * series and movies each studio has, and most of this library's 246
             * studios have one to three -- so a random pick usually landed on one
             * too small for the section's Minimum Items, which then hid the row
             * and spent the discovery slot. Counts are the studio's whole
             * catalogue, watched included, so this is a floor, not a guarantee;
             * the rendered row is checked again (enforceMinimumItems). */
            const minimum = parseInt(config.minimumItems, 10) > 1 ? parseInt(config.minimumItems, 10) : 0;
            const countKey = itemType === 'Series' ? 'SeriesCount' : itemType === 'Movie' ? 'MovieCount' : null;
            const eligible = pool.filter((s) => {
                if (!s?.Id || dedupe.has(s.Id)) return false;
                if (!minimum || !countKey || typeof s[countKey] !== 'number') return true;
                return s[countKey] >= minimum;
            });
            if (!eligible.length) return null;
            const selected = eligible[Math.floor(Math.random() * eligible.length)];
            dedupe.add(selected.Id);
            return {
                id: selected.Id,
                name: selected.Name,
                metadata: { Studio: selected.Name }
            };
        }

        if (discoveryType === 'Collection') {
            const minimumItems = config.minimumItems || 3;
            const eligible = pool.filter((c) => {
                if (!c?.Id || discoveryState.renderedDiscoveryIds.collections.has(c.Id)) return false;
                const count = (c.TotalRecordCount ?? c.RecursiveItemCount ?? c.ChildCount ?? 0);
                return count >= minimumItems;
            });
            if (!eligible.length) return null;
            const selected = eligible[Math.floor(Math.random() * eligible.length)];
            discoveryState.renderedDiscoveryIds.collections.add(selected.Id);
            return {
                id: selected.Id,
                name: selected.Name,
                metadata: { Collection: selected.Name, 'Collection Name': selected.Name }
            };
        }

        if (discoveryType === 'Similar' || discoveryType === 'Watchlist') {
            const dedupe = discoveryState.renderedDiscoveryIds.similar;
            const eligible = shuffleArray(pool).filter((item) => {
                const sourceId = resolveSimilarSourceId(item);
                return sourceId && !dedupe.has(sourceId);
            });
            if (!eligible.length) return null;
            const selected = eligible[0];
            const similarSourceId = resolveSimilarSourceId(selected);
            dedupe.add(similarSourceId);
            return {
                id: similarSourceId,
                similarSourceId,
                excludeItemId: selected.Id,
                metadata: resolveTitleMetadata(selected, itemType)
            };
        }

        if (discoveryType === 'Person') {
            const sourceQuery = config.discoverySourceQuery;
            if (sourceQuery.dataSource && String(sourceQuery.dataSource).startsWith('PeopleCache.')) {
                return pickPersonFromPeopleCachePool(pool, personType, itemType);
            }
            return pickPersonFromHistoryPool(pool, personType, itemType);
        }

        WARN(`Unsupported discoveryType: ${discoveryType}`);
        return null;
    }

    function fillTemplate(template, data) {
        if (!data || !template) return template;

        // Support both {Key} and [Key] formats, allowing spaces in keys
        return template.replace(/\{([^}]+)\}|\[([^\]]+)\]/g, (match, key1, key2) => {
            const key = key1 || key2;
            return data[key] || match;
        });
    }

    /**
     * Resolves a dynamic discovery template into a concrete section config with queries.
     * Returns null when no source could be resolved (e.g. no eligible genre/person left).
     * @param {Object} template - Discovery section template
     * @param {Object} [options]
     * @param {boolean} [options.pairSpotlight] - Reuse the paired spotlight source (home render behaviour)
     * @param {boolean} [options.resolveViewMore] - Resolve the "view more" URL (may issue extra requests)
     * @param {string} [options.stubId] - Stable id from progressive stub
     * @param {number} [options.stubOrder] - Stable order from progressive stub
     */
    async function buildDiscoverySectionInstance(template, options = {}) {
        if (!(await isSectionCacheReady(template))) {
            LOG(`Skipping discovery ${template?.id}: dependent library cache not complete`);
            return null;
        }

        const pairSpotlight = options.pairSpotlight !== false;
        const resolveViewMore = options.resolveViewMore !== false;

        const instanceConfig = {
            ...template,
            id: options.stubId || `${template.id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            discoveryTemplateId: template.id,
            type: 'discovery',
        };
        if (options.stubOrder != null) {
            instanceConfig.order = options.stubOrder;
        }
        if (!instanceConfig.discoveryType && template.type
            && !['home', 'seasonal', 'discovery'].includes(String(template.type).toLowerCase())) {
            instanceConfig.discoveryType = template.type;
        }

        const normalized = normalizeDiscoveryConfig(instanceConfig);
        Object.assign(instanceConfig, normalized);

        const baseId = String(template.id || instanceConfig.id || '').split('-')[0];
        const pairKey = (pairSpotlight && getDiscoverySettings().renderSpotlightAboveMatching)
            ? getPairKey(baseId)
            : null;

        let dynamicResult = null;
        if (pairKey) {
            // Sequential partner already finished: reuse stored result (do not resolve again)
            if ((pairKey === 'genre-movie' || pairKey === 'genre-series') && discoveryState.currentDiscoveryGenre) {
                dynamicResult = discoveryState.currentDiscoveryGenre;
                discoveryState.currentDiscoveryGenre = null;
            } else if (pairKey === 'studio-series' && discoveryState.currentDiscoveryStudio) {
                dynamicResult = discoveryState.currentDiscoveryStudio;
                discoveryState.currentDiscoveryStudio = null;
            } else {
                // Parallel partner in-flight (or we are first): share one resolve promise
                if (!discoveryState.pairResolvePromises.has(pairKey)) {
                    const resolvePromise = resolveDiscoverySource(instanceConfig);
                    discoveryState.pairResolvePromises.set(pairKey, resolvePromise);
                    resolvePromise.finally(() => {
                        // Clear after settle so the next discovery group can pick a new entity.
                        // Parallel awaiters already hold this promise reference.
                        setTimeout(() => {
                            if (discoveryState.pairResolvePromises.get(pairKey) === resolvePromise) {
                                discoveryState.pairResolvePromises.delete(pairKey);
                            }
                        }, 0);
                    });
                }
                dynamicResult = await discoveryState.pairResolvePromises.get(pairKey);

                // Leave for a sequential partner that starts after we finish
                if (dynamicResult) {
                    if (pairKey === 'genre-movie' || pairKey === 'genre-series') {
                        if (!discoveryState.currentDiscoveryGenre) {
                            discoveryState.currentDiscoveryGenre = dynamicResult;
                        } else {
                            // Partner (or race twin) already stored/consumed — clear our leave-behind
                            discoveryState.currentDiscoveryGenre = null;
                        }
                    } else if (pairKey === 'studio-series') {
                        if (!discoveryState.currentDiscoveryStudio) {
                            discoveryState.currentDiscoveryStudio = dynamicResult;
                        } else {
                            discoveryState.currentDiscoveryStudio = null;
                        }
                    }
                }
            }
        } else {
            dynamicResult = await resolveDiscoverySource(instanceConfig);

            // Legacy sequential pairing when Map is not used (pairSpotlight off path already skipped)
            if (pairSpotlight && getDiscoverySettings().renderSpotlightAboveMatching) {
                const configId = baseId;
                const genrePairIds = new Set(['genreMovies', 'spotlightGenre', 'genreSeries', 'spotlightGenreSeries']);
                const studioPairIds = new Set(['studioShows', 'spotlightNetwork']);

                if (genrePairIds.has(configId)) {
                    if (discoveryState.currentDiscoveryGenre) {
                        dynamicResult = discoveryState.currentDiscoveryGenre;
                        discoveryState.currentDiscoveryGenre = null;
                    } else if (dynamicResult) {
                        discoveryState.currentDiscoveryGenre = dynamicResult;
                    }
                }
                if (studioPairIds.has(configId)) {
                    if (discoveryState.currentDiscoveryStudio) {
                        dynamicResult = discoveryState.currentDiscoveryStudio;
                        discoveryState.currentDiscoveryStudio = null;
                    } else if (dynamicResult) {
                        discoveryState.currentDiscoveryStudio = dynamicResult;
                    }
                }
            }
        }
        if (!dynamicResult) return null;

        instanceConfig.source = dynamicResult.id || dynamicResult.name;
        instanceConfig.metadata = dynamicResult.metadata;
        instanceConfig.excludeItemId = dynamicResult.excludeItemId;

        const discoveryKind = instanceConfig.discoveryType || instanceConfig.type;
        const resolvedSource = instanceConfig.source;
        const contentTypes = instanceConfig.discoveryItemType
            ? [instanceConfig.discoveryItemType]
            : (instanceConfig.includeItemTypes || ['Movie']);

        const hasTemplateQueries = Array.isArray(instanceConfig.queries) && instanceConfig.queries.length > 0;
        const queryOptions = hasTemplateQueries
            ? { ...(instanceConfig.queries[0].queryOptions || {}) }
            : {
                Recursive: 'true',
                Limit: instanceConfig.itemLimit || 20,
                IncludeItemTypes: contentTypes
            };

        if (!hasTemplateQueries) {
            if (instanceConfig.sortOrder) queryOptions.SortBy = instanceConfig.sortOrder;
            if (instanceConfig.sortOrderDirection) queryOptions.SortOrder = instanceConfig.sortOrderDirection;
        } else if (!queryOptions.IncludeItemTypes?.length) {
            queryOptions.IncludeItemTypes = contentTypes;
        }
        if (!queryOptions.Limit) queryOptions.Limit = instanceConfig.itemLimit || 20;

        /* Similar goes through Jellyfin's own /Items/{id}/Similar. On Jellyfin 12
         * that endpoint hands the item to the library's similar-items providers
         * (LibraryController.GetSimilarItems -> ISimilarItemsManager, with the
         * library's provider list and order), so the SmartSimilar plugin now
         * serves these rows as one of those providers wherever a library selects
         * it. The separate SmartSimilar sections and their direct
         * /SmartSimilar/Items/{id}/Similar client were removed on 2026-09-25. */
        if (discoveryKind === 'Similar' || discoveryKind === 'Watchlist') {
            const similarId = dynamicResult.similarSourceId || resolvedSource;
            instanceConfig.queries = [{
                ...(hasTemplateQueries ? instanceConfig.queries[0] : {}),
                path: `/Items/${similarId}/Similar`,
                queryOptions: {
                    Limit: instanceConfig.itemLimit || 20,
                    Fields: queryOptions.Fields || 'PrimaryImageAspectRatio,DateCreated,Overview,Taglines,ProductionYear,RecursiveItemCount,ChildCount,UserData',
                    IncludeItemTypes: queryOptions.IncludeItemTypes || contentTypes
                }
            }];
        } else {
            switch (discoveryKind) {
                case 'Genre':
                    if (resolvedSource && resolvedSource.match(/^[a-f0-9]{32}$/)) {
                        queryOptions.GenreIds = [resolvedSource];
                    } else if (resolvedSource) {
                        queryOptions.Genres = resolvedSource;
                    }
                    break;
                case 'Tag':
                    if (resolvedSource) queryOptions.Tags = resolvedSource;
                    break;
                case 'Person':
                    if (resolvedSource) queryOptions.PersonIds = [resolvedSource];
                    {
                        const personType = instanceConfig.discoveryPersonType || instanceConfig.personType || 'Actor';
                        queryOptions.PersonTypes = [personType];
                        // Series-scoped person rows: actors → Series; director/writer/guest → Episode
                        const itemScope = instanceConfig.discoveryItemType
                            || (Array.isArray(contentTypes) && contentTypes[0])
                            || 'Movie';
                        if (itemScope === 'Series' && personType !== 'Actor') {
                            queryOptions.IncludeItemTypes = ['Episode'];
                        }
                    }
                    if (instanceConfig.excludeItemId) {
                        queryOptions.ExcludeItemIds = Array.isArray(instanceConfig.excludeItemId)
                            ? instanceConfig.excludeItemId
                            : [instanceConfig.excludeItemId];
                    }
                    break;
                case 'Studio':
                    if (resolvedSource && resolvedSource.match(/^[a-f0-9]{32}$/)) {
                        queryOptions.StudioIds = [resolvedSource];
                    } else if (resolvedSource) {
                        queryOptions.Studios = resolvedSource;
                    }
                    break;
                case 'Collection':
                case 'Parent':
                    if (resolvedSource) queryOptions.ParentId = resolvedSource;
                    break;
            }

            if (instanceConfig.spotlight || instanceConfig.renderMode === 'Spotlight') {
                queryOptions.Fields = queryOptions.Fields || 'PrimaryImageAspectRatio,DateCreated,Overview,Taglines,ProductionYear,RecursiveItemCount,ChildCount,UserData,People,Genres,ParentBackdropImageTags,Studios';
                const spotlightConfig = instanceConfig.spotlightConfig || {};
                const adminSpotlightConfig = window.KefinHomeScreen?.getConfig?.()?.SPOTLIGHT_SETTINGS || {};
                instanceConfig.spotlightConfig = { ...adminSpotlightConfig, ...spotlightConfig };
            } else if (!queryOptions.Fields) {
                queryOptions.Fields = 'PrimaryImageAspectRatio,DateCreated,Overview,Taglines,ProductionYear,RecursiveItemCount,ChildCount,UserData';
            }

            instanceConfig.queries = [{
                ...(hasTemplateQueries ? instanceConfig.queries[0] : {}),
                queryOptions
            }];
        }

        // Generic hideWatched support, carried over from the fork; applies to any
        // section type. Sets the two hooks applySmartFilter reads when the section
        // is loaded. Upstream has no equivalent, and Smart Suggest relies on it.
        if (instanceConfig.hideWatched === true && !instanceConfig.postFetchFilter) {
            const threshold = getDiscoverySettings().smartWatchThreshold ?? 0;
            const finalLimit = instanceConfig.itemLimit || 20;

            // Over-request, because filtering removes items after the query and a
            // short row is worse than a slightly larger fetch.
            if (instanceConfig.queries) {
                for (const q of instanceConfig.queries) {
                    if (q.queryOptions && q.queryOptions.Limit) {
                        q.queryOptions.Limit = q.queryOptions.Limit * 2;
                    } else if (q.queryOptions) {
                        q.queryOptions.Limit = finalLimit * 2;
                    }
                }
            }

            if (threshold >= 0) {
                instanceConfig.postFetchFilter = (items) => {
                    const filtered = items.filter(item => {
                        if (!item.UserData) return true;
                        // Fully played is always excluded. Played and
                        // PlayedPercentage are independent signals: a finished
                        // movie has Played true but its playback position reset,
                        // so no percentage at all.
                        if (item.UserData.Played) return false;
                        // Above zero, also exclude partial progress at or past the
                        // threshold -- playback position for a movie, watched
                        // episodes for a series.
                        if (threshold > 0) {
                            return (item.UserData.PlayedPercentage || 0) < threshold;
                        }
                        return true;
                    });
                    // Too few left to be worth a row; skip the section. The
                    // section's own Minimum Items when it has one, else 3.
                    const minimum = parseInt(instanceConfig.minimumItems, 10) > 0
                        ? parseInt(instanceConfig.minimumItems, 10)
                        : 3;
                    if (filtered.length < minimum) return null;
                    return filtered.slice(0, finalLimit);
                };
            }

            instanceConfig.refreshUserData = true;
        }

        instanceConfig.name = fillTemplate(instanceConfig.name, dynamicResult.metadata);
        if (instanceConfig.caption) {
            instanceConfig.caption = fillTemplate(instanceConfig.caption, dynamicResult.metadata);
            if (dynamicResult.excludeItemId) {
                instanceConfig.captionUrl = `#/details?id=${dynamicResult.excludeItemId}&serverId=${ApiClient.serverId()}`;
            }
        }
        instanceConfig.cardFormat = resolveCardFormat(instanceConfig);
        if (resolveViewMore) {
            instanceConfig.viewMoreUrl = await resolveViewMoreUrl(instanceConfig);
        }

        instanceConfig.discoveryPending = false;
        return instanceConfig;
    }

    /**
     * Progressive discovery: return a stub config + lazy-loading result immediately.
     * Concrete resolve + load runs on first ensureData / dataPromise / isStalePromise access.
     */
    async function buildDiscoverySectionPromise(template, options = {}) {
        // Incomplete library cache: still return a progressive stub; loadConcrete /
        // loadSectionForRendering ensureData waits until caches are ready.

        const pairSpotlight = options.pairSpotlight !== false;
        const order = options.order;
        const uniqueId = `${template.id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        const config = {
            ...template,
            id: uniqueId,
            discoveryTemplateId: template.id,
            type: 'discovery',
            discoveryPending: true,
            order: order != null ? order : template.order,
            overflowCard: true
        };
        if (config.cardFormat) {
            /* keep */
        } else {
            config.cardFormat = resolveCardFormat(config);
        }

        // Shared load: resolve + loadSectionForRendering
        let loadConcretePromise = null;
        const loadConcrete = () => {
            if (!loadConcretePromise) {
                loadConcretePromise = (async () => {
                    const resolved = await buildDiscoverySectionInstance(template, {
                        pairSpotlight,
                        resolveViewMore: true,
                        stubId: uniqueId,
                        stubOrder: config.order
                    });
                    if (!resolved) return null;
                    resolved.discoveryPending = false;
                    // Keep stable id/order for DOM
                    resolved.id = uniqueId;
                    if (config.order != null) resolved.order = config.order;
                    Object.assign(config, resolved);
                    config.discoveryPending = false;
                    const qr = await loadSectionForRendering(resolved);
                    return qr;
                })();
            }
            return loadConcretePromise;
        };

        let concreteRefreshPromise;
        const ensureData = async () => {
            const qr = await loadConcrete();
            if (!qr) return { Items: [] };
            const items = typeof qr.result?.ensureData === 'function'
                ? await qr.result.ensureData()
                : (qr.result?.dataPromise ?? qr.result?.data);
            concreteRefreshPromise = qr.result?.refreshPromise;
            return items;
        };

        const result = {
            data: { Items: [] },
            isStalePromise: loadConcrete().then(async (qr) => {
                if (!qr) return true;
                if (qr.result?.isStalePromise) return await qr.result.isStalePromise;
                return qr.result?.isStale === true;
            }),
            ensureData
        };
        Object.defineProperty(result, 'dataPromise', {
            configurable: true,
            enumerable: true,
            get() { return ensureData(); }
        });
        /* The concrete row's stale-while-revalidate refresh. ensureData hands back
         * the cached snapshot when it has expired, and the fresh response lands on
         * the inner result's refreshPromise. Without passing it up, cardBuilder saw
         * no refresh pending: it painted the snapshot -- which can be weeks old,
         * from whenever this genre/studio/person row last came up -- and never
         * applied the fresh data, so items deleted or re-id'd since (a Radarr
         * upgrade renames the file, and Jellyfin gives it a new id) showed and
         * opened a 404. The inner one is set before its ensureData resolves, so
         * it is in place by the time cardBuilder reads it. */
        Object.defineProperty(result, 'refreshPromise', {
            configurable: true,
            enumerable: true,
            get() { return concreteRefreshPromise; }
        });

        return { config, result };
    }

    window.sectionHelper = {
        loadSectionForRendering,
        buildDiscoverySectionInstance,
        buildDiscoverySectionPromise,
        resolveDiscoverySource,
        fillTemplate,
        resolveCardFormat,
        resolveViewMoreUrl,
        getDiscoverySettings,
        getDiscoveryState: () => discoveryState,
        resetDiscoveryDedupe,
        getDiscoveryTemplateExclusionKey,
        markEmptyDiscoverySourceTemplate,
        isEmptyDiscoverySourceTemplate
    };

    LOG('sectionHelper ready');
})();
