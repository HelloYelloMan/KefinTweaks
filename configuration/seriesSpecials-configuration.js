// KefinTweaks Item Page Tweaks - settings window
//
// (Named Series & Specials at first; the key, seriesSpecials, and the file
// names keep that name so saved settings still match.)
//
// Item Page Tweaks is one entry in the feature list standing for many small
// tweaks to episode, season and collection pages. Each tweak has its own switch
// here, stored in config.itemPageTweaks.<key>. Several tweaks live in one
// script, so each script also keeps its own flag, config.scripts.<script>, and
// this window keeps that in step: a script's flag is on when any of its tweaks
// is. The loader reads those flags, so a script whose tweaks are all off is not
// loaded at all; the scripts read the tweak switches themselves (tweakOn).
// scripts/kefinTweaks-loader.js runs any of them only while the group's own flag
// (config.scripts.seriesSpecials) is on.
//
// A tweak with no saved switch falls back to its script's flag - what it was
// before the switches existed - so nothing changes until a box is unticked.
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

    const LOG = (...args) => console.log('[KefinTweaks ItemPageTweaks Config]', ...args);
    const MODAL_ID = 'kefin-seriesspecials-config';

    // Order is the order shown. script: the file whose flag this tweak keeps on.
    const SECTIONS = [
        {
            title: 'Episode pages',
            tweaks: [
                { key: 'episodeHeadingToSeason', script: 'episodeTitle',
                    label: 'Heading names and opens the season',
                    desc: 'The heading above the episode title shows the season\'s Original Title and opens the season, instead of the series - on every show, single-season ones too. A season with no Original Title keeps the series name but still opens the season.' },
                { key: 'episodeLogoToSeason', script: 'episodeSeasonTitle',
                    label: 'Logo opens the season',
                    desc: 'Clicking the header logo opens the episode\'s season.' },
                { key: 'specialHeadingToCollection', script: 'episodeTitle',
                    label: 'Special: heading names and opens its virtual special',
                    desc: 'On a special that belongs to exactly one virtual special collection, the heading shows that collection\'s name and opens it.' },
                { key: 'specialLogoFromCollection', script: 'episodeSeasonTitle',
                    label: 'Special: logo is its virtual special\'s, and opens it',
                    desc: 'On a special that belongs to exactly one virtual special collection, the header logo is that collection\'s own logo and opens the collection.' },
                { key: 'specialBreadcrumb', script: 'virtualSpecials',
                    label: 'Special: breadcrumb goes through its virtual special',
                    desc: 'A special\'s breadcrumb trail goes Shows > series > virtual special > episode, instead of through the Specials season. With several virtual specials, that crumb opens a list of them.' },
                { key: 'specialCollectionsRowTitle', script: 'virtualSpecials',
                    label: 'Special: one collection is titled "Collection"',
                    desc: 'Jellyfin titles the Collections row in the plural however many it holds; with one, it reads "Collection".' },
                { key: 'elegantfinEpisodeLogo', script: 'episodeSeasonTitle',
                    label: 'ElegantFin: logo under the thumbnail',
                    desc: 'ElegantFin hides the logo on episode pages. This shows it under the thumbnail, in place of the series name. Other skins keep their logo where it is either way.' }
            ]
        },
        {
            title: 'Season pages',
            tweaks: [
                { key: 'seasonLogoToSeries', script: 'episodeSeasonTitle',
                    label: 'Logo opens the series',
                    desc: 'Clicking the header logo on a season page opens its series.' }
            ]
        },
        {
            title: 'Collection pages',
            tweaks: [
                { key: 'collectionLogoToSeries', script: 'episodeSeasonTitle',
                    label: 'Virtual special: logo opens the series',
                    desc: 'On a virtual special\'s page, clicking the header logo opens the series its episodes come from - when they all come from one.' },
                { key: 'collectionBreadcrumb', script: 'virtualSpecials',
                    label: 'Virtual special: breadcrumb back to the series',
                    desc: 'A virtual special\'s page gets the trail Shows > series > collection, which Jellyfin gives a collection none of.' },
                { key: 'collectionStudios', script: 'virtualSpecials',
                    label: 'Studios row filled in',
                    desc: 'Jellyfin builds a collection\'s Studios row but never fills it in. Any collection.' },
                { key: 'collectionSectionRows', script: 'collectionSectionRows',
                    label: 'Sections as rows',
                    desc: 'Each section of a collection page (Episodes, Movies and so on) shows as a horizontal row of cards, like the season row on a series page. Any collection.' },
                { key: 'singleItemCollection', script: 'virtualSpecials',
                    label: 'One-item collections: no count or Shuffle',
                    desc: 'A collection of one hides its "1 items" count and its Shuffle button, which could only shuffle one thing. Play stays. Any collection.' }
            ]
        },
        {
            title: 'Everywhere',
            tweaks: [
                { key: 'noSpecialPrefix', script: 'specialEpisodePrefix',
                    label: 'No "Special - " prefix',
                    desc: 'Removes the "Special - " Jellyfin puts before the title of every episode in a Specials season - cards, season pages and episode pages. The wording is localized, so it is learned once from your server rather than assumed.' },
                { key: 'mediaTags', script: 'mediaTags',
                    label: 'Tags row',
                    desc: 'ElegantFin only. Adds a Tags row to the details table on item pages, between Genres and Studios, each tag linking to its items.' }
            ]
        }
    ];

    const ALL_TWEAKS = SECTIONS.reduce((all, section) => all.concat(section.tweaks), []);

    function configs() {
        return [window.KefinTweaksCurrentConfig, window.KefinTweaksConfig]
            .filter((c, i, all) => c && all.indexOf(c) === i);
    }

    function isOn(tweak) {
        const cfg = configs()[0] || {};
        const saved = cfg.itemPageTweaks && cfg.itemPageTweaks[tweak.key];
        if (typeof saved === 'boolean') return saved;
        return !cfg.scripts || cfg.scripts[tweak.script] !== false;   // before the switches existed
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function row(tweak) {
        return '<div class="listItem" style="border:1px solid rgba(255,255,255,0.1);border-radius:4px;padding:0.75em;margin-bottom:0.75em;">'
            + '<div class="listItemContent">'
            + '<label class="checkboxContainer" style="display:flex;align-items:center;gap:0.5em;margin-bottom:0.4em;">'
            + '<input type="checkbox" data-item-page-tweak="' + tweak.key + '"' + (isOn(tweak) ? ' checked' : '') + '>'
            + '<span class="listItemBodyText">' + escapeHtml(tweak.label) + '</span></label>'
            + '<div class="listItemBodyText secondary" style="font-size:0.9em;">' + escapeHtml(tweak.desc) + '</div>'
            + '</div></div>';
    }

    function section(sec) {
        return '<div style="margin:1.25em 0 0.5em;font-weight:bold;font-size:1.1em;">' + escapeHtml(sec.title) + '</div>'
            + sec.tweaks.map(row).join('');
    }

    async function save(modal) {
        const targets = configs();
        if (!targets.length) return false;
        const chosen = {};
        modal.dialogContent.querySelectorAll('[data-item-page-tweak]').forEach(box => {
            chosen[box.getAttribute('data-item-page-tweak')] = box.checked;
        });
        // A script stays loaded while any of its tweaks is on.
        const scriptsOn = {};
        ALL_TWEAKS.forEach(t => { scriptsOn[t.script] = scriptsOn[t.script] || chosen[t.key] === true; });

        targets.forEach(cfg => {
            cfg.itemPageTweaks = Object.assign({}, cfg.itemPageTweaks || {}, chosen);
            if (!cfg.scripts) cfg.scripts = {};
            Object.keys(scriptsOn).forEach(name => { cfg.scripts[name] = scriptsOn[name]; });
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
            + '<div class="listItemBodyText secondary" style="margin-bottom:0.5em;">'
            + 'Each tweak can be switched on its own. Turning Item Page Tweaks off in the feature list turns all of them off and keeps these choices for when it is turned back on.'
            + '</div>'
            + SECTIONS.map(section).join('')
            + '</div>';

        const footer = document.createElement('div');
        footer.style.cssText = 'display:flex;gap:0.75em;justify-content:flex-end;';
        footer.innerHTML = '<button class="emby-button raised" data-item-page-tweaks-close>Close</button>'
            + '<button class="emby-button raised block button-submit" data-item-page-tweaks-save>Save</button>';

        const modalInstance = window.ModalSystem.create({
            id: MODAL_ID,
            title: 'Item Page Tweaks',
            content: content,
            footer: footer,
            closeOnBackdrop: true,
            closeOnEscape: true,
            showCloseButton: true,
            onOpen: (modal) => {
                modal.dialogFooter.querySelector('[data-item-page-tweaks-close]')
                    .addEventListener('click', () => window.ModalSystem.close(MODAL_ID));
                modal.dialogFooter.querySelector('[data-item-page-tweaks-save]')
                    .addEventListener('click', async () => {
                        if (await save(modal)) {
                            if (window.KefinTweaksToaster && window.KefinTweaksToaster.toast) {
                                window.KefinTweaksToaster.toast('Item Page Tweaks saved! Reload to apply.');
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
