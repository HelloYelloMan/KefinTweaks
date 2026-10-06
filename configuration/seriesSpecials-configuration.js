// KefinTweaks Series & Specials - settings window
//
// Series & Specials is one entry in the feature list standing for several
// tweaks that work together on episode, season and collection pages. Each tweak
// is still its own script with its own switch, config.scripts.<key>, exactly as
// when they were listed separately, so saved choices carry over. This window is
// where those switches are set; scripts/kefinTweaks-loader.js runs a tweak only
// while both its switch and the group's (config.scripts.seriesSpecials) are on.
//
// Loaded with the configuration UI (CONFIG_DEPENDENCY_NAMES), not with the
// feature, so the window opens while the group is switched off too.
//
// SAVING. The feature list's Save writes window.KefinTweaksCurrentConfig - a
// copy it fetched when it opened - not window.KefinTweaksConfig. A change saved
// from here into only one of them would be undone by the next Save of the
// other, so the switches are written into both and the list's copy is what is
// saved.

(function () {
    'use strict';

    const LOG = (...args) => console.log('[KefinTweaks SeriesSpecials Config]', ...args);
    const MODAL_ID = 'kefin-seriesspecials-config';

    // Order is the order shown.
    const TWEAKS = [
        { key: 'episodeTitle', label: 'Episode Title', desc: 'On an episode page, the heading above the episode title names and opens the season - its Original Title - instead of the series, on every show. On a special in one virtual special collection, it names and opens that collection. A season with no Original Title keeps the series name but still opens the season.' },
        { key: 'episodeSeasonTitle', label: 'Episode Logo', desc: 'Makes the header logo a link one level up: on an episode page it opens the season, on a season page it opens the series. On a special in one virtual special collection, it shows that collection\'s logo and opens the collection. Skins that hide the logo on episode pages (ElegantFin) show it under the thumbnail instead of the series name; other skins keep their logo where it is.' },
        { key: 'virtualSpecials', label: 'Virtual Specials Tweaks', desc: 'Fixes to collection pages. Fills in the Studios row, which Jellyfin builds but never populates for a collection. Removes the "Special - " that Jellyfin prepends to the title of every episode in a Specials season, on collection pages only. Gives a virtual special a breadcrumb back to its series. On a special\'s episode page, the breadcrumb goes through its virtual special instead of the Specials season, and a Collections row holding one collection is titled Collection. Also marks a one-item collection so the Virtual Specials Tweaks CSS option can hide its count and Shuffle button.' },
        { key: 'collectionSectionRows', label: 'Collection Sections As Rows', desc: 'Shows each section of a collection page (Episodes, Movies and so on) as a horizontal row of cards, the same as the flat season row on a series page.' },
        { key: 'specialEpisodePrefix', label: 'No "Special - " Prefix', desc: 'Removes the "Special - " that Jellyfin prepends to the title of every episode in season zero, everywhere it appears - cards, season pages and episode pages. The prefix is localized, so the exact wording is learned once from your server rather than assumed, then cached.' },
        { key: 'mediaTags', label: 'Media Tags', desc: 'Adds a Tags row to the details table on item pages, between Genres and Studios, with each tag linking to its items. Jellyfin only shows tags in a separate line under the overview, which some skins (ElegantFin) hide.' }
    ];

    function configs() {
        return [window.KefinTweaksCurrentConfig, window.KefinTweaksConfig]
            .filter((c, i, all) => c && all.indexOf(c) === i);
    }

    function isOn(key) {
        const cfg = configs()[0] || {};
        return !cfg.scripts || cfg.scripts[key] !== false;   // every tweak defaults to on
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function row(tweak) {
        return '<div class="listItem" style="border:1px solid rgba(255,255,255,0.1);border-radius:4px;padding:0.75em;margin-bottom:1em;">'
            + '<div class="listItemContent">'
            + '<div class="listItemBodyText" style="margin-bottom:0.5em;">' + escapeHtml(tweak.label) + '</div>'
            + '<div class="listItemBodyText secondary" style="margin-bottom:0.75em;font-size:0.9em;">' + escapeHtml(tweak.desc) + '</div>'
            + '<label class="checkboxContainer" style="display:flex;align-items:center;gap:0.5em;">'
            + '<input type="checkbox" data-series-specials-key="' + tweak.key + '"' + (isOn(tweak.key) ? ' checked' : '') + '>'
            + '<span class="listItemBodyText">Enabled</span></label>'
            + '</div></div>';
    }

    async function save(modal) {
        const targets = configs();
        if (!targets.length) return false;
        modal.dialogContent.querySelectorAll('[data-series-specials-key]').forEach(box => {
            const key = box.getAttribute('data-series-specials-key');
            targets.forEach(cfg => {
                if (!cfg.scripts) cfg.scripts = {};
                cfg.scripts[key] = box.checked;
            });
        });
        try {
            if (!window.KefinTweaksUtils || !window.KefinTweaksUtils.saveConfigToJavaScriptInjector) return false;
            const result = await window.KefinTweaksUtils.saveConfigToJavaScriptInjector(targets[0]);
            return result === true;
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
        const content = document.createElement('div');
        content.innerHTML = '<div style="max-width:800px;">'
            + '<div class="listItemBodyText secondary" style="margin-bottom:1em;">'
            + 'Each tweak can be switched on its own. Turning Series &amp; Specials off in the feature list turns all of them off and keeps these choices for when it is turned back on.'
            + '</div>'
            + TWEAKS.map(row).join('')
            + '</div>';

        const footer = document.createElement('div');
        footer.style.cssText = 'display:flex;gap:0.75em;justify-content:flex-end;';
        footer.innerHTML = '<button class="emby-button raised" data-series-specials-close>Close</button>'
            + '<button class="emby-button raised block button-submit" data-series-specials-save>Save</button>';

        const modalInstance = window.ModalSystem.create({
            id: MODAL_ID,
            title: 'Series & Specials',
            content: content,
            footer: footer,
            closeOnBackdrop: true,
            closeOnEscape: true,
            showCloseButton: true,
            onOpen: (modal) => {
                modal.dialogFooter.querySelector('[data-series-specials-close]')
                    .addEventListener('click', () => window.ModalSystem.close(MODAL_ID));
                modal.dialogFooter.querySelector('[data-series-specials-save]')
                    .addEventListener('click', async () => {
                        if (await save(modal)) {
                            if (window.KefinTweaksToaster && window.KefinTweaksToaster.toast) {
                                window.KefinTweaksToaster.toast('Series & Specials saved! Reload to apply.');
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
            modalInstance.dialog.style.width = '800px';
            modalInstance.dialog.style.height = 'auto';
        }
    }

    window.KefinTweaksFeatureConfigs = window.KefinTweaksFeatureConfigs || {};
    window.KefinTweaksFeatureConfigs.seriesSpecials = { openConfigModal: openConfigModal };
})();
