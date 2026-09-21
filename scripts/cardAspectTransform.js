// KefinTweaks: stamp each Jellyfin card with its own aspect ratio, at the source.
//
// WHY THIS EXISTS
//
// jellyfin-web gives a card SET one shape, taken from the median
// PrimaryImageAspectRatio of the set, and builds every card in it with
// `cardPadder-<shape>`. Per-item shape is not something it does. The card markup
// it emits carries data-id, data-type, data-collectiontype -- but not the ratio,
// and neither does the image URL (95 library cards measured produced two
// distinct boxes, 220x314 and 220x330, which is the set's shape, not each
// item's).
//
// So the ratio exists nowhere the client can see it, and True Aspect Cards has
// had to discover it out of band: per-item API lookups, harvesting it out of
// /Items responses, caching what it learned, and measuring the image itself when
// the metadata turned out to be wrong. Every staleness bug in that feature has
// come from that layer -- ratios surviving an artwork change, a cache keyed on
// something that did not identify the card, values persisting past a hard
// refresh.
//
// This removes the need for all of it. The File Transformation plugin rewrites
// jellyfin-web's own files as they are served, and jellyfin-web builds its card
// element as a string with the item in scope:
//
//     ' data-id="'+(r.Id||r.ItemId)+'" data-type="'+r.Type+'"'+ie+oe+...
//
// One substitution there adds the item's own ratio to every card. True Aspect
// Cards reads data-ar when it is present and skips discovery entirely; when it
// is absent it falls back to what it does today, so a Jellyfin update that
// changes the minified identifiers degrades the feature instead of breaking it.
//
// WHAT IT TOUCHES
//
// Only the File Transformation plugin's own configuration, and only the one
// entry it owns (matched on a fixed Id). Other transformations in that list are
// read and written back untouched. It is idempotent: if the entry is already
// present and correct, nothing is written.
//
// Requires administrator rights, because plugin configuration does. Non-admin
// users simply skip it -- the transformation is server-wide once any admin has
// applied it, so there is nothing for them to do.

(function() {
    'use strict';

    const LOG = (...args) => console.log('[KefinTweaks CardAspectTransform]', ...args);
    const WARN = (...args) => console.warn('[KefinTweaks CardAspectTransform]', ...args);
    const ERR = (...args) => console.error('[KefinTweaks CardAspectTransform]', ...args);

    const PLUGIN_ALIASES = ['File Transformation', '5e87cc92-571a-4d8d-8d98-d2d4147f9f90'];

    // Fixed so the entry can be found and updated rather than duplicated.
    const ENTRY_ID = '7ca51d3e-9b24-4f80-a6d1-0c8e5b2f4a91';

    /* SearchText is a REGEX -- the plugin compiles it (Regex.Replace), so the
       metacharacters in the minified source have to be escaped. ReplaceText is a
       .NET replacement string, where only `$` is special; there is none here, so
       it goes in literally. Backticks avoid a second layer of escaping for the
       quotes the source itself contains.

       Verified against the deployed chunk offline: exactly one match, 46 bytes
       added, and the patched file still parses. */
    const ENTRY = {
        Id: ENTRY_ID,
        FilenamePattern: String.raw`.*\.chunk\.js`,
        SearchText: String.raw`data-type="'\+r\.Type\+'"'`,
        ReplaceText: `data-type="'+r.Type+'" data-ar="'+(r.PrimaryImageAspectRatio||'')+'"'`
    };

    /* Jellyfin stores a GUID without dashes, so the value read back is not the
       string that was written. Comparing them naively meant this never
       recognised its own entry and appended a fresh copy on every run --
       observed, three of them. Normalise before comparing anything. */
    function normId(id) {
        return String(id || '').replace(/-/g, '').toLowerCase();
    }

    function isOurs(entry) {
        if (!entry) return false;
        if (normId(entry.Id) === normId(ENTRY_ID)) return true;
        /* Also claim an entry that does the same job under another id. A hand
           written attempt at this rule is easy to get wrong -- SearchText is a
           regex, so the `+` characters in the minified source have to be
           escaped, and unescaped they quietly match nothing -- and leaving a
           broken duplicate behind would be worse than adopting it. */
        return entry.ReplaceText === ENTRY.ReplaceText;
    }

    function sameEntry(a, b) {
        return !!a
            && a.FilenamePattern === b.FilenamePattern
            && a.SearchText === b.SearchText
            && a.ReplaceText === b.ReplaceText;
    }

    async function isAdministrator() {
        try {
            const user = await ApiClient.getCurrentUser();
            return user?.Policy?.IsAdministrator === true;
        } catch (e) {
            return false;
        }
    }

    async function readConfig(pluginId) {
        // ApiClient knows how to authenticate; prefer it over hand-rolling a header.
        if (typeof ApiClient.getPluginConfiguration === 'function') {
            return ApiClient.getPluginConfiguration(pluginId);
        }
        return window.KefinTweaksUtils.getPluginConfiguration(pluginId);
    }

    async function writeConfig(pluginId, config) {
        if (typeof ApiClient.updatePluginConfiguration === 'function') {
            return ApiClient.updatePluginConfiguration(pluginId, config);
        }
        throw new Error('ApiClient.updatePluginConfiguration is not available');
    }

    /* One run at a time. initialize() and a manual call can overlap, and two
       read-modify-writes against the same list both append. */
    let inFlight = null;
    function ensureTransformation() {
        if (!inFlight) {
            inFlight = ensureTransformationOnce().finally(() => { inFlight = null; });
        }
        return inFlight;
    }

    async function ensureTransformationOnce() {
        if (!window.KefinTweaksUtils?.resolvePluginId) {
            WARN('KefinTweaksUtils is not available yet');
            return false;
        }

        const pluginId = await window.KefinTweaksUtils.resolvePluginId(PLUGIN_ALIASES);
        if (!pluginId) {
            WARN('The File Transformation plugin is not installed - nothing to do. '
                + 'True Aspect Cards keeps working from its own lookups.');
            return false;
        }

        const config = await readConfig(pluginId);
        const list = Array.isArray(config?.Transformations) ? config.Transformations : [];

        const mine = list.filter(isOurs);
        if (mine.length === 1 && sameEntry(mine[0], ENTRY)) {
            LOG('Card aspect-ratio transformation already registered');
            return true;
        }

        // Preserve every other transformation exactly as it was. Every copy of
        // ours is dropped first, so duplicates collapse back to one.
        const next = list.filter((t) => t && !isOurs(t));
        next.push({ ...ENTRY });
        if (mine.length > 1) {
            LOG(`Collapsed ${mine.length} copies of the rule into one`);
        }

        await writeConfig(pluginId, { ...config, Transformations: next });
        LOG(mine.length
            ? 'Card aspect-ratio transformation updated'
            : 'Card aspect-ratio transformation registered');
        LOG('Reload the page (and hard-refresh) for jellyfin-web to be served patched.');
        return true;
    }

    async function initialize(attempt = 0) {
        if (typeof ApiClient === 'undefined' || !ApiClient || !window.KefinTweaksUtils) {
            if (attempt < 40) {
                setTimeout(() => initialize(attempt + 1), 250);
                return;
            }
            WARN('Dependencies not available, giving up');
            return;
        }

        if (!(await isAdministrator())) {
            // Not an error: the transformation is server-wide, so a non-admin
            // sees the benefit without being able -- or needing -- to apply it.
            return;
        }

        try {
            await ensureTransformation();
        } catch (error) {
            ERR('Could not register the transformation:', error);
        }
    }

    window.KefinTweaksCardAspectTransform = { ensureTransformation };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => initialize());
    } else {
        initialize();
    }
})();
