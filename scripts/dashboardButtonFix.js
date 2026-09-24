// Dashboard Button Fix
// This is a workaround for a bug in the dashboard back button
// The dashboard back button currently leaves the Jellyfin app if the user navigates to the dashboard directly from the URL
// This script sends you to home.html in these scenarios instead of leaving the app
//
// Gated to dashboard routes: the old version ran a document.body observer on
// every page for the whole session just to catch the dashboard mounting — and
// disconnected permanently after the first attach, so a recreated button on a
// later dashboard visit never got the handler. Now the observer only runs
// while the hash is a dashboard route, re-arms on every dashboard entry
// (dashboard subpages are hash changes too, which also covers React
// recreating the button), and stands down entirely everywhere else.

(function () {
    let observer = null;

    function isDashboardRoute() {
        return (window.location.hash || '').toLowerCase().includes('dashboard');
    }

    function tryAttach() {
        const btn = document.querySelector('button.MuiButtonBase-root');
        if (!btn) return false;

        if (btn._backCheckAttached) return true;
        btn._backCheckAttached = true;

        btn.addEventListener('click', function (e) {
            if (window.history.state?.idx === 0) {
                // Stop normal handlers
                e.stopImmediatePropagation();
                e.preventDefault();

                console.log("[KefinTweaks DashboardButtonFix]: No history to go back. Redirecting to home page.");

                // Changes this to the page you'd like to return to by default
                // Jellyfin 12 is '12.x', so the minor part alone no longer tells us.
                const [majorPart, minorPart] = String(ApiClient.serverVersion()).split('.').map(Number);
                const homeUrl = majorPart > 10 || minorPart > 10 ? 'home' : 'home.html';
                Dashboard.navigate(`/${homeUrl}`);
            }
        }, true);

        return true;
    }

    function deactivate() {
        if (observer) {
            observer.disconnect();
            observer = null;
        }
    }

    function activate() {
        if (!isDashboardRoute()) {
            deactivate();
            return;
        }

        if (tryAttach()) {
            // Button present and handled; no need to keep observing until the
            // next hash change re-runs activate().
            deactivate();
            return;
        }

        // Dashboard route but the MUI app hasn't mounted the button yet — watch
        // for it, scoped to this visit only.
        if (!observer) {
            observer = new MutationObserver(() => {
                if (tryAttach()) deactivate();
            });
            observer.observe(document.body, { childList: true, subtree: true });
        }
    }

    window.addEventListener('hashchange', activate);

    // Initial run
    activate();
})();
