// Dashboard Button Fix
// This is a workaround for a bug in the dashboard back button
// The dashboard back button currently leaves the Jellyfin app if the user navigates to the dashboard directly from the URL
// This script sends you to home.html in these scenarios instead of leaving the app
//
// Gated to dashboard routes: the old version ran a document.body observer on
// every page for the whole session just to catch the dashboard mounting — and
// disconnected permanently after the first attach, so a recreated button on a
// later dashboard visit never got the handler. Upstream's onViewPage arming now
// does the re-arm on every dashboard entry; the direct-load run below keeps the
// route check so a MUI button on some other page is never given the redirect.

(function () {
    'use strict';

    function isDashboardRoute() {
        const hash = (window.location.hash || '').toLowerCase();
        return hash.includes('dashboard') || hash.includes('configurationpage');
    }

    function attachHandler(btn) {
        // No button yet is "not attached": returning true here would tell
        // armForDashboard there is nothing to wait for.
        if (!btn) return false;
        if (btn._backCheckAttached) return true;
        btn._backCheckAttached = true;

        btn.addEventListener('click', function (e) {
            if (window.history.state?.idx === 0) {
                e.stopImmediatePropagation();
                e.preventDefault();

                console.log('[KefinTweaks DashboardButtonFix]: No history to go back. Redirecting to home page.');

                // Jellyfin 12 is '12.x', so the minor part alone no longer tells us.
                const [majorPart, minorPart] = String(ApiClient.serverVersion()).split('.').map(Number);
                const homeUrl = majorPart > 10 || minorPart > 10 ? 'home' : 'home.html';
                Dashboard.navigate(`/${homeUrl}`);
            }
        }, true);
        return true;
    }

    function tryAttach() {
        const btn = document.querySelector('button.MuiButtonBase-root');
        return attachHandler(btn);
    }

    function armForDashboard() {
        if (tryAttach()) return;

        const utils = window.KefinTweaksUtils;
        if (utils?.waitForElement) {
            utils.waitForElement('button.MuiButtonBase-root', {
                timeout: 15000,
                quiet: true,
                predicate: (el) => !el._backCheckAttached
            }).then((btn) => {
                if (btn) attachHandler(btn);
            });
            return;
        }
        if (utils?.pollUntil) {
            utils.pollUntil(() => (tryAttach() ? true : null), { intervalMs: 200, timeoutMs: 15000 });
            return;
        }
        setTimeout(armForDashboard, 500);
    }

    function start() {
        const utils = window.KefinTweaksUtils;
        if (!utils?.onViewPage) {
            setTimeout(start, 500);
            return;
        }
        utils.onViewPage(() => {
            armForDashboard();
        }, { pages: ['dashboard', 'configurationpage'] });
        // Also try immediately (direct load), but only on a dashboard route.
        if (isDashboardRoute()) armForDashboard();
    }

    start();
})();
