// KefinTweaks Help
// FORK-ONLY: the Help & Tips page (pages/help.html) at #/help, with a Help & Tips entry
// in the user menu. The page explains, for household users, the features this
// server's plugins and KefinTweaks add. Vault Tweaks' Characters and Alternate Order
// sections in Settings > Display get a link to their topic.
// Requires: utils.js
//
// Placement of the menu entry can be overridden in KefinTweaksConfig.help:
//   { userMenu: true, sideMenu: false, topNavigation: 'none' | 'main' | 'right', order }
// The default is the user menu only.

(function () {
    'use strict';

    const LOG = (...args) => console.log('[KefinTweaks Help]', ...args);
    const WARN = (...args) => console.warn('[KefinTweaks Help]', ...args);
    const ERR = (...args) => console.error('[KefinTweaks Help]', ...args);

    LOG('Script loaded');

    function getRoot() {
        const raw = window.KefinTweaksConfig?.kefinTweaksRootResolved;
        if (!raw) return null;
        return raw.endsWith('/') ? raw : `${raw}/`;
    }

    /**
     * Build custom-page HTML from a full document: styles + head scripts + body
     * (scripts kept). Rewrites `body {` to a scope class for non-full-page host.
     * Same as games.js, which may be switched off independently.
     */
    function buildContentHtmlFromDocument(htmlString, scopeClass) {
        const doc = new DOMParser().parseFromString(htmlString, 'text/html');
        const chunks = [];

        doc.querySelectorAll('style').forEach((el) => {
            let css = el.textContent || '';
            if (scopeClass) {
                css = css.replace(/(^|})\s*body\s*\{/g, `$1.${scopeClass}{`);
            }
            chunks.push(`<style>${css}</style>`);
        });

        doc.head.querySelectorAll('script').forEach((el) => {
            chunks.push(el.outerHTML);
        });

        const wrap = document.createElement('div');
        const bodyClass = (doc.body && doc.body.className) || '';
        wrap.className = [scopeClass, bodyClass].filter(Boolean).join(' ').trim();

        Array.from(doc.body.childNodes).forEach((node) => {
            if (node.nodeName === 'STYLE') return;
            wrap.appendChild(node.cloneNode(true));
        });
        chunks.push(wrap.outerHTML);

        return chunks.join('\n');
    }

    async function fetchPageHtml(root, relativePath) {
        const url = `${root}${relativePath.replace(/^\//, '')}`;
        const res = await fetch(url, { cache: 'no-cache' });
        if (!res.ok) {
            throw new Error(`Failed to fetch ${url}: ${res.status}`);
        }
        return res.text();
    }

    function getPlacement() {
        const cfg = window.KefinTweaksConfig?.help || {};
        const order = Number(cfg.order);
        return {
            userMenu: cfg.userMenu !== false,
            sideMenu: cfg.sideMenu === true,
            topNavigation: cfg.topNavigation === 'main' || cfg.topNavigation === 'right' ? cfg.topNavigation : 'none',
            order: Number.isFinite(order) ? order : undefined
        };
    }

    /*
     * Backdrops, when the user has them on (Settings > Display > Backdrops).
     *
     * jellyfin-web's autoBackdrops.js shows them on 'pageshow' for a page with the
     * class backdropPage and a data-backdroptype; with the setting off it clears
     * them instead. Custom pages are shown by KefinTweaks, not the view manager,
     * so no pageshow reaches this one: mark the page and send it one. Jellyfin
     * then does exactly what it does for Home, setting included. globalBackdropPage
     * draws from the whole library rather than the top parent in the URL.
     *
     * It is sent once, after the showing settles: #/help is an unknown route to
     * Jellyfin, which renders its fallback page, and that page's own pageshow
     * clears the backdrop; and a navigation shows a custom page several times in
     * a row, each pageshow fetching a fresh random set. libraryMenu's pageshow
     * handler reads e.detail.isRestored, so the event carries a detail; true also
     * stops it scrolling the page to the top.
     *
     * KefinTweaks' custom-page CSS hides the backdrop on custom pages unless the
     * page carries backdropPage (utils.js, kefin-custom-page-backdrop).
     */
    function showBackdrops(page) {
        if (!page) return;
        page.classList.add('backdropPage', 'globalBackdropPage');
        page.setAttribute('data-backdroptype', 'movie,series');
        clearTimeout(page._helpBackdropTimer);
        page._helpBackdropTimer = setTimeout(() => {
            if (page.classList.contains('hide') || !document.body.contains(page)) return;
            page.dispatchEvent(new CustomEvent('pageshow', { bubbles: true, detail: { isRestored: true } }));
        }, 150);
    }

    /*
     * A help link at the top right of the Characters and Alternate Order sections
     * of Settings > Display, opening that topic. Vault Tweaks draws both sections
     * itself, after the page shows (Characters once its saved choices load,
     * Alternate Order after Characters), so they are watched for while that page
     * is open, and the watch ends when it is left.
     */
    const SETTINGS_HELP = [
        { section: '.charactersNamesSetting', topic: 'characters', name: 'Characters' },
        { section: '.alternateOrderSetting', topic: 'alternate-order', name: 'Alternate Order' }
    ];
    const SETTINGS_PATH = '#/mypreferencesdisplay';

    function ensureSettingsHelpStyles() {
        if (document.getElementById('kefin-help-settings-styles')) return;
        const style = document.createElement('style');
        style.id = 'kefin-help-settings-styles';
        style.textContent = `
.kefin-help-settings-heading {
	display: flex;
	align-items: center;
	gap: 0.5em;
}
.kefin-help-settings-link {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	flex-shrink: 0;
	width: 1.6em;
	height: 1.6em;
	margin-left: auto;
	border-radius: 50%;
	color: inherit;
	font-size: 1.5rem;
	opacity: 0.7;
	text-decoration: none;
	transition: opacity 0.15s, background-color 0.15s;
}
.kefin-help-settings-link:hover,
.kefin-help-settings-link:focus-visible {
	opacity: 1;
	background-color: rgba(255, 255, 255, 0.1);
}
.kefin-help-settings-link .material-icons {
	font-size: 1em;
}`;
        document.head.appendChild(style);
    }

    function addSettingsHelpLinks() {
        SETTINGS_HELP.forEach(({ section, topic, name }) => {
            const heading = document.querySelector(`${section} h2`);
            if (!heading || heading.querySelector('.kefin-help-settings-link')) return;
            const link = document.createElement('a');
            link.className = 'kefin-help-settings-link';
            link.href = `#/help?topic=${topic}`;
            link.title = `Help & Tips: ${name}`;
            link.setAttribute('aria-label', `Help & Tips: ${name}`);
            // The ligature, not a class: every skin's icon font has help_outline as a
            // ligature, while class-to-codepoint maps differ between them.
            link.innerHTML = '<span class="material-icons" aria-hidden="true">help_outline</span>';
            heading.classList.add('kefin-help-settings-heading');
            heading.appendChild(link);
        });
    }

    let settingsObserver = null;
    function syncSettingsHelpLinks() {
        const onSettings = (window.location.hash || '').split('?')[0] === SETTINGS_PATH;
        if (!onSettings) {
            if (settingsObserver) {
                settingsObserver.disconnect();
                settingsObserver = null;
            }
            return;
        }
        ensureSettingsHelpStyles();
        addSettingsHelpLinks();
        if (!settingsObserver) {
            settingsObserver = new MutationObserver(addSettingsHelpLinks);
            settingsObserver.observe(document.body, { childList: true, subtree: true });
        }
    }

    function setupSettingsHelpLinks() {
        window.addEventListener('hashchange', syncSettingsHelpLinks);
        if (typeof window.KefinTweaksUtils?.onViewPage === 'function') {
            window.KefinTweaksUtils.onViewPage(() => syncSettingsHelpLinks(), { pages: [] });
        }
        syncSettingsHelpLinks();
    }

    async function registerHelpPage() {
        const utils = window.KefinTweaksUtils;
        const root = getRoot();
        if (!root) {
            WARN('kefinTweaksRoot not configured; cannot register the Help page');
            return false;
        }

        let raw;
        try {
            raw = await fetchPageHtml(root, 'pages/help.html');
        } catch (e) {
            ERR('Could not load the Help page:', e);
            return false;
        }

        utils.addCustomPage('#/help', 'Help & Tips', buildContentHtmlFromDocument(raw, 'kefin-custom-page-help'), (page) => {
            showBackdrops(page);
            // #/help?topic=watchlist opens that topic. The page's own script does
            // this on its first show; this covers every show after that.
            const m = (window.location.hash || '').match(/[?&]topic=([\w-]+)/);
            const help = page && page.querySelector('.kefin-help');
            if (m && help && typeof help.khOpenTopic === 'function') help.khOpenTopic(m[1]);
        });
        setupSettingsHelpLinks();

        const ok = await utils.addCustomMenuLink('Help & Tips', 'help', '#/help', false, getPlacement());
        if (ok) LOG('Help page registered at #/help, with its menu entry');
        else WARN('Help page registered, but its menu entry could not be added');
        return !!ok;
    }

    function waitForUtilsAndInitialize() {
        const ready = () =>
            window.KefinTweaksUtils?.addCustomMenuLink && window.KefinTweaksUtils?.addCustomPage;

        if (ready()) {
            registerHelpPage();
            return;
        }

        LOG('Waiting for KefinTweaksUtils…');
        const checkInterval = setInterval(() => {
            if (ready()) {
                clearInterval(checkInterval);
                registerHelpPage();
            }
        }, 100);

        setTimeout(() => {
            clearInterval(checkInterval);
            if (!ready()) {
                WARN('KefinTweaksUtils not available after 10 seconds');
            }
        }, 10000);
    }

    waitForUtilsAndInitialize();
})();
