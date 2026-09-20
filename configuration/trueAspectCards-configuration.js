// KefinTweaks True Aspect Cards Configuration UI
// Settings panel for the True Aspect Poster Cards feature.

(function() {
    'use strict';

    const LOG = (...args) => console.log('[KefinTweaks TrueAspect Config]', ...args);
    const ERR = (...args) => console.error('[KefinTweaks TrueAspect Config]', ...args);

    const MODAL_ID = 'kefin-trueaspect-config';

    async function loadConfig() {
        const config = window.KefinTweaksConfig || {};
        return config.trueAspectCards || {};
    }

    async function saveConfig(next) {
        try {
            if (!window.KefinTweaksConfig) {
                window.KefinTweaksConfig = {};
            }
            window.KefinTweaksConfig.trueAspectCards = next;

            if (window.KefinTweaksUtils && window.KefinTweaksUtils.saveConfigToJavaScriptInjector) {
                await window.KefinTweaksUtils.saveConfigToJavaScriptInjector();
                LOG('Configuration saved to JS Injector');
                return true;
            }
            if (window.KefinTweaksConfiguration && window.KefinTweaksConfiguration.findJavaScriptInjectorPlugin) {
                const pluginId = await window.KefinTweaksConfiguration.findJavaScriptInjectorPlugin();
                if (pluginId) {
                    await window.KefinTweaksConfiguration.saveConfigToJavaScriptInjector(window.KefinTweaksConfig);
                    LOG('Configuration saved to JS Injector (fallback)');
                    return true;
                }
            }
            ERR('saveConfigToJavaScriptInjector not available');
            return false;
        } catch (error) {
            ERR('Error saving config:', error);
            return false;
        }
    }

    function buildConfigHTML(config) {
        const episodeStills = config.episodeStills === true;
        return `
            <div style="max-width: 800px;">
                <div class="listItem" style="border: 1px solid rgba(255,255,255,0.1); border-radius: 4px; padding: 0.75em; margin-bottom: 1em;">
                    <div class="listItemContent">
                        <div class="listItemBodyText" style="margin-bottom: 0.5em;">Episode Cards Use Their Own Still</div>
                        <div class="listItemBodyText secondary" style="margin-bottom: 0.75em; font-size: 0.9em;">
                            Jellyfin draws episodes in Recently Added, Next Up and similar rows as portrait cards
                            carrying the series poster, so every episode of a show looks the same. With this on, the
                            card shows the episode's own 16:9 still and becomes a backdrop-shaped card to match.
                            Episodes with no still of their own keep the series poster.
                        </div>
                        <label class="checkboxContainer" style="display: flex; align-items: center; gap: 0.5em;">
                            <input type="checkbox" id="trueAspectCards_episodeStills" ${episodeStills ? 'checked' : ''}>
                            <span class="listItemBodyText">Enabled</span>
                        </label>
                    </div>
                </div>
            </div>
        `;
    }

    function collectConfig() {
        return {
            episodeStills: document.getElementById('trueAspectCards_episodeStills')?.checked === true
        };
    }

    async function openConfigModal() {
        try {
            const config = await loadConfig();

            const content = document.createElement('div');
            content.innerHTML = buildConfigHTML(config);

            const footer = document.createElement('div');
            footer.style.display = 'flex';
            footer.style.gap = '0.75em';
            footer.style.justifyContent = 'flex-end';
            footer.innerHTML = `
                <button class="emby-button raised" onclick="window.ModalSystem.close('${MODAL_ID}')">Close</button>
                <button class="emby-button raised block button-submit" id="save-trueaspect-config-btn">Save</button>
            `;

            window.ModalSystem.create({
                id: MODAL_ID,
                title: 'True Aspect Poster Cards',
                content: content,
                footer: footer,
                closeOnBackdrop: true,
                closeOnEscape: true,
                showCloseButton: true,
                onOpen: (modal) => {
                    const saveBtn = modal.dialogFooter.querySelector('#save-trueaspect-config-btn');
                    if (saveBtn) {
                        saveBtn.addEventListener('click', async () => {
                            const success = await saveConfig(collectConfig());
                            if (success) {
                                if (window.KefinTweaksToaster && window.KefinTweaksToaster.toast) {
                                    window.KefinTweaksToaster.toast('Configuration saved! Reload to apply.');
                                }
                                window.ModalSystem.close(MODAL_ID);
                            } else {
                                alert('Error saving configuration. Please ensure the JavaScript Injector plugin is installed and you have administrator permissions.');
                            }
                        });
                    }
                }
            });

            LOG('True Aspect Cards configuration modal opened');
        } catch (error) {
            ERR('Error opening true aspect cards config modal:', error);
            alert('Error opening configuration: ' + error.message);
        }
    }

    window.KefinTweaksFeatureConfigs = window.KefinTweaksFeatureConfigs || {};
    window.KefinTweaksFeatureConfigs.trueAspectCards = { openConfigModal };

    console.log('[KefinTweaks TrueAspect Config] Script loaded');

})();
