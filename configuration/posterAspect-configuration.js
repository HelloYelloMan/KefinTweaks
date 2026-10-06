// KefinTweaks Poster Aspect - settings window
//
// One option so far, config.posterAspect.coverFullHeight: whether an item page's
// cover may widen into the empty room between it and the text, so more art keeps
// the skin's height (see posterAspect.css, "An item page's cover keeps the SKIN'S
// HEIGHT", and posterAspect.js, coverRoom). Off by default; the text never moves.
//
// Loaded with the configuration UI (CONFIG_DEPENDENCY_NAMES), so it opens while
// the feature is off too. Saved into both window.KefinTweaksCurrentConfig (the
// feature list's copy) and window.KefinTweaksConfig, as the Item Page Tweaks
// window does, so neither Save undoes the other.

(function () {
    'use strict';

    const LOG = (...args) => console.log('[KefinTweaks PosterAspect Config]', ...args);
    const MODAL_ID = 'kefin-posteraspect-config';

    function configs() {
        return [window.KefinTweaksCurrentConfig, window.KefinTweaksConfig]
            .filter((c, i, all) => c && all.indexOf(c) === i);
    }

    function current() {
        const cfg = configs()[0] || {};
        return Object.assign({ coverFullHeight: false }, cfg.posterAspect || {});
    }

    async function save(modal) {
        const targets = configs();
        if (!targets.length) return false;
        const box = modal.dialogContent.querySelector('[data-poster-aspect-option="coverFullHeight"]');
        targets.forEach(cfg => {
            cfg.posterAspect = Object.assign({}, cfg.posterAspect || {}, { coverFullHeight: !!(box && box.checked) });
        });
        try {
            if (!window.KefinTweaksUtils || !window.KefinTweaksUtils.saveConfigToJavaScriptInjector) return false;
            return (await window.KefinTweaksUtils.saveConfigToJavaScriptInjector(targets[0])) === true;
        } catch (e) {
            LOG('save failed', e);
            return false;
        }
    }

    function openConfigModal() {
        if (!window.ModalSystem || !window.ModalSystem.create) {
            alert('KefinTweaks modal system unavailable.');
            return;
        }
        const cfg = current();
        const content = document.createElement('div');
        content.innerHTML = '<div style="max-width:800px;">'
            + '<div class="listItem" style="border:1px solid rgba(255,255,255,0.1);border-radius:4px;padding:0.75em;">'
            + '<div class="listItemContent">'
            + '<label class="checkboxContainer" style="display:flex;align-items:center;gap:0.5em;margin-bottom:0.4em;">'
            + '<input type="checkbox" data-poster-aspect-option="coverFullHeight"' + (cfg.coverFullHeight ? ' checked' : '') + '>'
            + '<span class="listItemBodyText">Item page covers: use the room beside them</span></label>'
            + '<div class="listItemBodyText secondary" style="font-size:0.9em;">'
            + 'An item page\'s cover keeps the height the skin draws it at, and its width follows the picture. '
            + 'Off: it may only be as wide as the space the skin gives the cover, so a wider picture comes out a little shorter. '
            + 'On: it may also use the empty room between the cover and the text, so more pictures keep the full height. The text never moves. '
            + 'Portrait and square covers, on desktop and TV; skins that fix the cover\'s size themselves (ElegantFin) are not affected.'
            + '</div></div></div></div>';

        const footer = document.createElement('div');
        footer.style.cssText = 'display:flex;gap:0.75em;justify-content:flex-end;';
        footer.innerHTML = '<button class="emby-button raised" data-poster-aspect-close>Close</button>'
            + '<button class="emby-button raised block button-submit" data-poster-aspect-save>Save</button>';

        const modalInstance = window.ModalSystem.create({
            id: MODAL_ID,
            title: 'Poster Aspect Cards',
            content: content,
            footer: footer,
            closeOnBackdrop: true,
            closeOnEscape: true,
            showCloseButton: true,
            onOpen: (modal) => {
                modal.dialogFooter.querySelector('[data-poster-aspect-close]')
                    .addEventListener('click', () => window.ModalSystem.close(MODAL_ID));
                modal.dialogFooter.querySelector('[data-poster-aspect-save]')
                    .addEventListener('click', async () => {
                        if (await save(modal)) {
                            if (window.KefinTweaksToaster && window.KefinTweaksToaster.toast) {
                                window.KefinTweaksToaster.toast('Poster Aspect saved! Reload to apply.');
                            }
                            window.ModalSystem.close(MODAL_ID);
                        } else {
                            alert('Error saving configuration. Ensure the JavaScript Injector plugin is installed and you have administrator permissions.');
                        }
                    });
            }
        });
        if (modalInstance && modalInstance.dialog) {
            modalInstance.dialog.style.maxWidth = '90vw';
            modalInstance.dialog.style.width = '700px';
            modalInstance.dialog.style.height = 'auto';
        }
    }

    window.KefinTweaksFeatureConfigs = window.KefinTweaksFeatureConfigs || {};
    window.KefinTweaksFeatureConfigs.posterAspect = { openConfigModal: openConfigModal };
})();
