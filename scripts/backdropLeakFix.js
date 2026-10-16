// Backdrop Leak Fix Script
// Fixes issue that causes backdrop images to be continuously added to the page if the tab isn't focused

(function() {
    'use strict';
    
    // Common logging function
    const LOG = (...args) => console.log('[KefinTweaks BackdropLeakFix]', ...args);
    
    LOG('Script loaded - JS Injector mode');

    // Step 1: watch for .backdropContainer to appear
    const waitForContainer = new MutationObserver(() => {
        const container = document.querySelector('.backdropContainer');
        if (!container) return;

        LOG('Found .backdropContainer, attaching prune observer');
        waitForContainer.disconnect();

        // Step 2: prune children as needed
        const pruneObserver = new MutationObserver(() => {
            LOG('Mutation detected, checking children count:', container.children.length);
            // Only count/remove Jellyfin's own backdrop children — never other
            // scripts' mounts (e.g. Vault Tweaks' Theme Media video container).
            const prunable = () => Array.from(container.children)
                .filter((c) => !c.classList.contains('kefin-theme-video-container'));
            let victims = prunable();
            while (victims.length > 2) {
                LOG('Too many children (' + victims.length + '), removing oldest');
                container.removeChild(victims[0]);
                victims = prunable();
            }
        });

        pruneObserver.observe(container, { childList: true });
        LOG('Prune observer is now active');
    });

    waitForContainer.observe(document.body, {
        childList: true,
        subtree: true
    });

    LOG('Waiting for .backdropContainer to appear...');
    LOG('Backdrop leak fix functionality initialized');
})();
