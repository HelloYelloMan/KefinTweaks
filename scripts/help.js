// KefinTweaks Help
// FORK-ONLY: the Help & Tips page (pages/help.html) at #/help, with a Help & Tips entry
// in the user menu. The page explains, for household users, the features this
// server's plugins and KefinTweaks add.
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
            // #/help?topic=watchlist opens that topic. The page's own script does
            // this on its first show; this covers every show after that.
            const m = (window.location.hash || '').match(/[?&]topic=([\w-]+)/);
            const help = page && page.querySelector('.kefin-help');
            if (m && help && typeof help.khOpenTopic === 'function') help.khOpenTopic(m[1]);
        });

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
