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
//
// DOES IT ACTUALLY WORK? NOT ON File Transformation 3.0.1.0 -- measured.
//
// Kept off by default, and the reason is worth writing down so nobody spends
// another evening on it. The rule registers correctly and is live: after a
// restart the plugin logged it at startup, logged "Installing response
// transformation middleware", the pattern matched the request and the search
// text matched the content --
//
//     served bytes 37798 = disk bytes 37798, byte-identical
//     search target present: 1   regex matches: 1   data-ar: 0
//
// Four pattern forms were tried: the exact filename (which the plugin's own UI
// says is supported and checked first), an anchored regex, a loose name, and
// one including the /web/ prefix. None applied.
//
// The discriminating test was whether ANY javascript transformation applies,
// including those other plugins register through the startup callback API:
//
//     home-html.8ce38bc7d6dc073656d4.chunk.js   transformed=False
//     main.jellyfin.bundle.js                   transformed=False
//     24468.50f2991bf78868105780.chunk.js       transformed=False
//
// None. Only index.html comes back changed, and that is explained by the
// JavaScript Injector having a middleware of its own -- its configuration
// carries DisableScriptInjectionMiddleware -- rather than by this plugin. The
// likely mechanism is ordering: Jellyfin serves /web/*.js through the static
// file middleware, which short-circuits the pipeline before the transformation
// middleware runs, while index.html is served specially.
//
// So this stays switched off, and True Aspect Cards keeps discovering ratios
// for itself. If a later plugin version applies configuration rules to static
// assets, switching this on deletes that whole layer -- the client hook in
// trueAspectCards.js already prefers data-ar when it is present.

(function() {
    'use strict';

    const LOG = (...args) => console.log('[KefinTweaks CardAspectTransform]', ...args);
    const WARN = (...args) => console.warn('[KefinTweaks CardAspectTransform]', ...args);
    const ERR = (...args) => console.error('[KefinTweaks CardAspectTransform]', ...args);

    const PLUGIN_ALIASES = ['File Transformation', '5e87cc92-571a-4d8d-8d98-d2d4147f9f90'];

    // Fixed so the entry can be found and updated rather than duplicated.
    const ENTRY_ID = '7ca51d3e-9b24-4f80-a6d1-0c8e5b2f4a91';

    /* The two fields are NOT the same kind of string, which is the whole story
     * of why this took so long.
     *
     *   FilenamePattern IS a regex. NeedsTransformation and RunTransformation
     *     both run it through GetOrCreateRegex(...).IsMatch(path), so `\.` is
     *     right here.
     *
     *   SearchText is NOT a regex. From the plugin source:
     *         currentContent.Replace(transformation.SearchText,
     *                                transformation.ReplaceText)
     *     That is string.Replace -- a plain literal substring replace. Escaping
     *     it turns it into a string that does not occur in the file, and the
     *     transformation silently does nothing.
     *
     * Measured, one rule at a time against the same chunk:
     *     data-type="              applied       (literal, present)
     *     r\.Type                  NOT applied   (literal backslash, absent)
     *     '[+]r[.]Type[+]'         NOT applied   (literal brackets, absent)
     *
     * So the search text goes in exactly as it appears in the minified source.
     * ReplaceText is likewise literal -- no $ substitution to worry about.
     */
    const ENTRY = {
        Id: ENTRY_ID,
        FilenamePattern: String.raw`.*\.chunk\.js`,
        SearchText: `data-type="'+r.Type+'"'`,
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
