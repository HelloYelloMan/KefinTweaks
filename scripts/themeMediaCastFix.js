// Theme Media Cast Fix Script
// Restores theme song / theme video playback in the web client while an mpv-shim
// (or any other remote/cast player) is the selected playback target.
//
// Why: jellyfin-web's themeMediaPlayer.js plays theme media via
// playbackManager.play({ enableRemotePlayers: false }). In playbackmanager.js the
// play() gate does:
//     if (options.enableRemotePlayers === false && !self._currentPlayer.isLocalPlayer)
//         throw new Error('Remote players are disabled');
// So the moment a remote player is the active target, every theme-media request
// throws with no local fallback, and nothing plays. Routing it back through
// playbackManager locally is not viable either: onPlaybackStarted() calls
// setCurrentPlayerInternal(player), which would steal the cast session away from
// the shim. This script therefore plays theme media through its own dedicated
// element, and ONLY while a remote/cast player is selected. When you are local,
// native handles theme media exactly as normal, so there is no doubled audio.
//
// This is a WHOLESALE replacement: it handles theme media itself in all cases
// (local AND casting), with crossfades, a graceful end-fade, cast-safe playback,
// and multi-item playlist support (play through all theme songs/videos, loop the
// playlist, and optionally pause between items showing backdrops).
//
// The "Play Theme Music" / "Play Theme Videos" checkboxes on the Display settings
// page are REPLACED at runtime: this script clones those rows, binds the clones to
// its own userId-scoped localStorage keys, and forces native's own keys off so
// native never plays (no doubled audio, no "Remote players are disabled" throw). The
// checkboxes look and behave the same, but now drive this script instead of native.
// On first run the new keys are seeded from your current native values. CONFIG.enable*
// below is only the fallback default before you have touched the toggles.

(function() {
    'use strict';

    const LOG = (...args) => console.log('[KefinTweaks ThemeMediaCastFix]', ...args);

    // Defaults merged with (not replaced by) any user config, so a partial
    // KefinTweaksConfig.themeMediaCastFix (e.g. just the button toggles written by
    // the config UI) still keeps every other default.
    const CONFIG = Object.assign({
        volume: 0.5,               // 0.0 - 1.0
        fadeMs: 600,               // fade in / out duration
        loop: false,               // loop a SINGLE theme item (conflicts with playlist advancement)
        enableThemeSongs: true,    // play theme songs (video takes precedence when present)
        enableThemeVideos: true,   // play theme videos (with audio) when present
        videoOpacity: 1.0,         // backdrop video opacity
        videoZIndex: null,         // null = auto (native behaviour); set a number only if an opaque skin layer covers it
        showMuteButton: true,      // show the mute button on theme videos
        showVolumeSlider: true,    // show the volume slider on theme videos
        showFullscreenButton: true,// show the fullscreen button on theme videos
        pseudoFullscreen: 'auto',  // 'auto' (detect webapp mode), true (force), false (disable)
        playCount: -1,             // how many theme items to play before stopping (-1 = all items in the result)
        loopPlaylist: false,       // after the last item, wrap to the first and keep going forever
        betweenItemsDelaySec: 0    // seconds between items: fade out, show backdrops, then fade in the next
    }, window.KefinTweaksConfig?.themeMediaCastFix || {});

    LOG('Script loaded - JS Injector mode');

    // Suppress the benign native throw (native themeMediaPlayer keeps trying to play
    // theme media through the cast target and fails). We handle theme media ourselves.
    window.addEventListener('unhandledrejection', (e) => {
        if (e && e.reason && e.reason.message === 'Remote players are disabled') {
            e.preventDefault();
        }
    });

    // KefinTweaks-owned theme toggles (userId-scoped). The Display-page checkboxes are
    // cloned and re-bound to THESE keys; native's own keys are forced off so native
    // never plays (no doubled audio, no "Remote players are disabled" throw).
    function tmKey(which) {
        let uid = '';
        try { uid = ApiClient.getCurrentUserId() || ''; } catch (e) { /* noop */ }
        return 'kefinThemeMedia_' + which + '_' + uid;
    }
    function tmGet(which, dflt) {
        const v = localStorage.getItem(tmKey(which));
        return v === 'true' ? true : v === 'false' ? false : dflt;
    }
    function tmSet(which, val) {
        try { localStorage.setItem(tmKey(which), val ? 'true' : 'false'); } catch (e) { /* noop */ }
    }
    function tmGetNum(which, dflt) {
        const v = parseFloat(localStorage.getItem(tmKey(which)));
        return isNaN(v) ? dflt : v;
    }
    function tmSetNum(which, val) {
        try { localStorage.setItem(tmKey(which), String(val)); } catch (e) { /* noop */ }
    }
    // User-adjustable, persisted across themes/navigation.
    let userVolume = tmGetNum('volume', CONFIG.volume);
    let userMuted = tmGet('muted', false);
    const enableThemeSongs = () => tmGet('songs', CONFIG.enableThemeSongs !== false);
    const enableThemeVideos = () => tmGet('videos', CONFIG.enableThemeVideos !== false);

    function nativeKey(which) {
        let uid = '';
        try { uid = ApiClient.getCurrentUserId() || ''; } catch (e) { /* noop */ }
        return uid + '-enableTheme' + (which === 'songs' ? 'Songs' : 'Videos');
    }
    function forceNativeThemeOff() {
        try {
            if (!ApiClient.getCurrentUserId()) return;
            localStorage.setItem(nativeKey('songs'), 'false');
            localStorage.setItem(nativeKey('videos'), 'false');
        } catch (e) { /* noop */ }
    }

    // One-time init: seed our keys from the user's current native values (so the
    // replaced checkboxes start where native left off), then force native off.
    let nativeInitDone = false;
    function initThemeSettings() {
        if (nativeInitDone) { forceNativeThemeOff(); return; }
        let uid;
        try { uid = ApiClient.getCurrentUserId(); } catch (e) { /* noop */ }
        if (!uid) return; // ApiClient not ready yet; retry on next viewshow
        ['songs', 'videos'].forEach((which) => {
            if (localStorage.getItem(tmKey(which)) == null) {
                const nv = localStorage.getItem(nativeKey(which));
                if (nv === 'true' || nv === 'false') tmSet(which, nv === 'true');
            }
        });
        forceNativeThemeOff();
        nativeInitDone = true;
        LOG('theme toggles migrated; native theme playback disabled');
    }

    // Replace the native theme checkboxes on the Display settings page with clones
    // bound to our keys (the clone inherits emby-checkbox styling). The originals are
    // hidden and left unchecked so native's own save also writes false.
    function rebindThemeRow(nativeRow, which) {
        const nativeChk = nativeRow.querySelector('input[type="checkbox"]');
        if (nativeChk) nativeChk.checked = false;
        nativeRow.style.display = 'none';

        const clone = nativeRow.cloneNode(true);
        clone.style.display = '';
        clone.classList.add('kefinThemeToggle');
        const chk = clone.querySelector('input[type="checkbox"]');
        if (chk) {
            chk.id = 'chkKefinTheme_' + which;
            chk.checked = which === 'videos' ? enableThemeVideos() : enableThemeSongs();
            chk.addEventListener('change', () => {
                tmSet(which, chk.checked);
                LOG('theme ' + which + ' set to', chk.checked);
            });
        }
        nativeRow.parentNode.insertBefore(clone, nativeRow.nextSibling);
    }
    function customizeThemeSettings() {
        const songRow = document.querySelector('.fldThemeSong');
        const videoRow = document.querySelector('.fldThemeVideo');
        if (!songRow && !videoRow) return false;
        if (document.querySelector('.kefinThemeToggle')) return true; // already applied
        if (songRow) rebindThemeRow(songRow, 'songs');
        if (videoRow) rebindThemeRow(videoRow, 'videos');
        LOG('replaced native theme toggles on Display settings');
        return true;
    }
    function ensureThemeSettingsCustomized() {
        if (customizeThemeSettings()) return;
        const obs = new MutationObserver(() => {
            if (customizeThemeSettings()) obs.disconnect();
        });
        obs.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => obs.disconnect(), 5000);
    }

    let currentOwnerId = null;
    let el = null;      // active <audio> or <video>
    let fadeTimer = null;
    let loadSeq = 0;    // guards against overlapping viewshow -> loadTheme calls

    // ---- Playlist state ----
    // When a theme media result contains multiple items (e.g. several theme songs
    // or videos for a series), we shuffle them and play through the list. This
    // tracks where we are and how many we've played so far.
    let playlist = null;           // array of theme items (shuffled)
    let playlistIndex = 0;         // index of the currently-playing item
    let playlistIsVideo = false;   // true = video playlist, false = song playlist
    let playCountPlayed = 0;       // how many items have been played so far
    let betweenDelayTimer = null;  // timer for the gap between consecutive items

    // Detect whether the client is actually playing something (local OR remote/shim),
    // so our theme never plays over real media. Two independent signals, because the
    // nowPlayingBar alone proved unreliable:
    //  1. The nowPlayingBar being VISIBLE. Jellyfin hides it with TWO classes:
    //     `nowPlayingBar-hidden` (set immediately on slideDown) and `hide` (added only
    //     after the slide transition finishes). The old check looked at `hide` alone,
    //     so it missed the pre-transition window and any state where only the other
    //     class is present. We treat either hiding class — or a zero-height/off-screen
    //     bar — as "not playing", so it works regardless of the class timing.
    //  2. A locally-playing <video> that isn't our own theme video (covers native
    //     local playback directly, without relying on the bar at all).
    function barIsVisible(bar) {
        if (!bar) return false;
        if (bar.classList.contains('hide') || bar.classList.contains('nowPlayingBar-hidden')) return false;
        const cs = getComputedStyle(bar);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        const rect = bar.getBoundingClientRect();
        return rect.height > 4 && rect.top < window.innerHeight; // slid into view
    }
    // Our own theme elements, which must never count as "real playback".
    function isOurMedia(node) {
        return !!node && (node === el
            || node.classList.contains('kefin-theme-video')
            || node.classList.contains('kefin-theme-audio'));
    }

    // ANY other <video>/<audio> on the page that is actually rolling — covers the web
    // player, trailers, and any other page audio source, without relying on the bar.
    function otherMediaPlaying() {
        const nodes = document.querySelectorAll('video, audio');
        for (let i = 0; i < nodes.length; i++) {
            const m = nodes[i];
            if (isOurMedia(m)) continue;
            if (!m.paused && !m.ended && m.readyState >= 2) return true;
        }
        return false;
    }
    function isRealPlaybackActive() {
        return barIsVisible(document.querySelector('.nowPlayingBar')) || otherMediaPlaying();
    }

    // Most aggressive local signal: a capture-phase listener catches the `play`/`playing`
    // events of EVERY media element on the page. Media events don't bubble, but capture
    // still traverses down to the target, so this sees elements that don't exist yet and
    // ones that start via autoplay — no polling latency, no monkey-patching.
    function onAnyMediaPlay(e) {
        if (!el || isOurMedia(e.target)) return;
        LOG('other media started playing - stopping theme', e.target.tagName);
        stopTheme();
    }
    ['play', 'playing'].forEach((ev) => document.addEventListener(ev, onAnyMediaPlay, true));

    // Backstop poll: the events above cover local media, but a remote/cast target
    // (mpv-shim) plays nothing locally — its only local signal is the nowPlayingBar,
    // and an attribute observer on it can miss the transition or point at a stale bar
    // if it's recreated. So while a theme is playing we also re-check every 250ms.
    // Runs ONLY while a theme element exists, so it's bounded and self-cancels.
    let playbackWatch = null;
    function startPlaybackWatch() {
        if (playbackWatch) return;
        playbackWatch = setInterval(() => {
            if (!el) { stopPlaybackWatch(); return; }
            if (isRealPlaybackActive()) stopTheme();
        }, 250);
    }
    function stopPlaybackWatch() {
        if (playbackWatch) { clearInterval(playbackWatch); playbackWatch = null; }
    }

    function clearFade() {
        if (fadeTimer) {
            clearInterval(fadeTimer);
            fadeTimer = null;
        }
    }

    function clearBetweenDelay() {
        if (betweenDelayTimer) {
            clearTimeout(betweenDelayTimer);
            betweenDelayTimer = null;
        }
    }

    // Video visibility is binary and instant (never tied to the audio fade): the
    // backdrop shows the moment playback starts and hides the moment we start tearing
    // it down, so a fading-out theme is audio-only and never lingers on screen.
    function showVideo(node) {
        const c = node._kefinContainer;
        if (c) c.style.opacity = String(CONFIG.videoOpacity);
    }
    function hideVideo(node) {
        const c = node._kefinContainer;
        if (c) c.style.opacity = '0';
    }

    // Fade a specific node's audio to `target` (fade-in). Captures the node so a
    // later transition can't retarget an in-flight fade at the wrong element.
    function fadeTo(node, target) {
        clearFade();
        const start = node.volume;
        const steps = Math.max(1, Math.round(CONFIG.fadeMs / 30));
        let i = 0;
        fadeTimer = setInterval(() => {
            i++;
            node.volume = Math.min(1, Math.max(0, start + (target - start) * (i / steps)));
            if (i >= steps) clearFade();
        }, 30);
    }

    function removeMediaEl(node) {
        try { node.pause(); } catch (e) { /* noop */ }
        node.removeAttribute('src');
        try { node.load(); } catch (e) { /* noop */ }
        
        if (inPseudoFs) exitPseudoFs();
        
        // Theme torn down while fullscreen (e.g. navigation): leave fullscreen and
        // drop the host along with everything else.
        if (fsHost && fsHost.contains(node)) {
            exitFs();
            fsHost.remove();
            fsHost = null;
        }
        node.remove();
        if (node._kefinContainer) node._kefinContainer.remove();
    }

    // Fade a node out over fadeMs, then remove it. Uses its own timer so several can
    // overlap (e.g. crossfade between two themed pages).
    function fadeOutAndRemove(node) {
        if (!node) return;
        hideVideo(node); // video vanishes immediately; only the audio fades out
        const start = node.volume;
        const steps = Math.max(1, Math.round(CONFIG.fadeMs / 30));
        let i = 0;
        const t = setInterval(() => {
            i++;
            node.volume = Math.max(0, start * (1 - i / steps));
            if (i >= steps) {
                clearInterval(t);
                removeMediaEl(node);
            }
        }, 30);
    }

    // Hard teardown (no fade): natural end / error paths where fading is pointless.
    function destroyEl() {
        clearFade();
        clearBetweenDelay();
        stopPlaybackWatch();
        if (el) {
            removeMediaEl(el);
            el = null;
        }
    }

    // Fade out the current theme and detach it, then clear ownership and playlist.
    function stopTheme() {
        currentOwnerId = null;
        playlist = null;
        playlistIndex = 0;
        playCountPlayed = 0;
        playlistIsVideo = false;
        clearBetweenDelay();
        stopPlaybackWatch();
        hideHeaderControls();
        if (!el) return;
        const dying = el;
        el = null;
        clearFade();
        fadeOutAndRemove(dying);
    }

    // For non-looping media: begin a fade-out so it lands at ~0 exactly as the file
    // ends, instead of hard-cutting. onended then detaches the (already silent) node.
    function armEndFade(node) {
        if (CONFIG.loop) return;
        node.addEventListener('timeupdate', () => {
            if (node !== el || node._endFading) return;
            const d = node.duration;
            if (!d || !isFinite(d)) return;
            if (d - node.currentTime <= CONFIG.fadeMs / 1000) {
                node._endFading = true;
                fadeTo(node, 0);
            }
        });
    }

    // ---- Playlist advancement ----
    // Called when the current theme item ends naturally (onended). Decides whether
    // to play the next item, stop, or wait showing backdrops — based on playCount,
    // loopPlaylist, and betweenItemsDelaySec.
    function advancePlaylist() {
        if (!playlist || !playlist.length) {
            hideHeaderControls();
            destroyEl();
            return;
        }

        playCountPlayed++;

        // Check playCount limit (only when not looping the playlist).
        // playCount <= 0 means "all items" (no limit).
        const limit = CONFIG.playCount;
        if (!CONFIG.loopPlaylist && limit > 0 && playCountPlayed >= limit) {
            LOG('playCount limit reached (' + limit + '), stopping theme');
            stopTheme();
            return;
        }

        // Advance to next index.
        playlistIndex++;
        if (playlistIndex >= playlist.length) {
            if (CONFIG.loopPlaylist) {
                playlistIndex = 0;
                LOG('playlist wrapped (loopPlaylist), restarting from first item');
            } else {
                LOG('reached end of playlist (' + playlist.length + ' items), stopping theme');
                stopTheme();
                return;
            }
        }

        const nextItem = playlist[playlistIndex];
        const delayMs = Math.max(0, CONFIG.betweenItemsDelaySec) * 1000;

        if (delayMs > 0) {
            // Delay mode: fade out current item, hide player (backdrops show through),
            // wait, then fade in the next item.
            LOG('between-items delay: ' + CONFIG.betweenItemsDelaySec + 's, showing backdrops');
            const dying = el;
            el = null;
            clearFade();
            fadeOutAndRemove(dying);
            hideHeaderControls();
            betweenDelayTimer = setTimeout(() => {
                betweenDelayTimer = null;
                if (currentOwnerId == null) return; // stopped during delay
                // The poll stopped itself when el went null, and the play listeners
                // bail without an el, so nothing watched for playback during the gap.
                if (isRealPlaybackActive()) { stopTheme(); return; }
                playItem(nextItem, playlistIsVideo);
                startPlaybackWatch();
            }, delayMs);
        } else {
            // No delay: play next immediately (playItem crossfades the outgoing item).
            playItem(nextItem, playlistIsVideo);
        }
    }

    // Web-safe sets for a bare <video>/<audio> element (Firefox/Zen: no native HLS,
    // no HEVC). Anything outside these gets a forced h264/aac transcode.
    const WEB_CONTAINERS = ['mp4', 'm4v', 'mov', 'webm', 'ogv', 'ogg'];
    const WEB_VCODECS = ['h264', 'avc', 'avc1', 'vp8', 'vp9', 'av1'];
    const WEB_ACODECS = ['aac', 'mp3', 'opus', 'vorbis', 'flac'];

    function audioDirectUrl(itemId) {
        return ApiClient.getUrl('Audio/' + itemId + '/stream', {
            static: true,
            api_key: ApiClient.accessToken(),
            deviceId: ApiClient.deviceId()
        });
    }

    function audioTranscodeUrl(itemId) {
        // Forced mp3 transcode - always decodable in a bare <audio>.
        return ApiClient.getUrl('Audio/' + itemId + '/stream.mp3', {
            audioCodec: 'mp3',
            api_key: ApiClient.accessToken(),
            deviceId: ApiClient.deviceId()
        });
    }

    function directVideoUrl(itemId, source) {
        const container = (source.Container || 'mp4').toLowerCase().split(',')[0];
        return ApiClient.getUrl('Videos/' + itemId + '/stream.' + container, {
            static: true,
            mediaSourceId: source.Id || itemId,
            tag: source.ETag,
            api_key: ApiClient.accessToken(),
            deviceId: ApiClient.deviceId()
        });
    }

    function transcodeVideoUrl(itemId, source) {
        // Forced progressive h264/aac mp4 — always playable in a bare <video>.
        return ApiClient.getUrl('Videos/' + itemId + '/stream.mp4', {
            mediaSourceId: (source && source.Id) || itemId,
            videoCodec: 'h264',
            audioCodec: 'aac',
            maxWidth: 1920,
            api_key: ApiClient.accessToken(),
            deviceId: ApiClient.deviceId()
        });
    }

    // Returns { url, transcoded } for a theme video item, picking direct play when
    // the source is something the browser can actually decode, else a transcode.
    async function resolveVideoSource(itemId) {
        let source = null;
        try {
            const item = await ApiClient.getItem(ApiClient.getCurrentUserId(), itemId);
            source = item && item.MediaSources && item.MediaSources[0];
        } catch (e) {
            LOG('getItem failed for', itemId, '- will transcode', e);
        }
        if (source && Array.isArray(source.MediaStreams)) {
            const v = source.MediaStreams.find(s => s.Type === 'Video');
            const a = source.MediaStreams.find(s => s.Type === 'Audio');
            const container = (source.Container || '').toLowerCase().split(',')[0];
            const vCodec = (v && v.Codec || '').toLowerCase();
            const aCodec = (a && a.Codec || '').toLowerCase();
            const canDirect = WEB_CONTAINERS.includes(container)
                && WEB_VCODECS.includes(vCodec)
                && (!a || WEB_ACODECS.includes(aCodec));
            LOG('theme video source', { container, vCodec, aCodec, canDirect });
            if (canDirect) {
                return { url: directVideoUrl(itemId, source), transcoded: false };
            }
        }
        return { url: transcodeVideoUrl(itemId, source), transcoded: true };
    }

    // Container replicates native .videoPlayerContainer WITHOUT reusing that class
    // (native createMediaElement() would otherwise hijack our element for real
    // playback). No z-index by default -> z-index:auto at body.firstChild, exactly
    // like native theme video: sits behind the (transparent) page content. Override
    // CONFIG.videoZIndex only if your skin paints an opaque layer over it.
    function ensureVideoCss() {
        if (document.getElementById('kefin-theme-video-style')) return;
        const style = document.createElement('style');
        style.id = 'kefin-theme-video-style';
        style.textContent =
            '.kefin-theme-video-container{position:fixed;top:0;left:0;right:0;bottom:0;'
            + 'display:flex;align-items:center;justify-content:center;background:#000;'
            + 'pointer-events:none;}'
            // In-page variant (mobile): absolute-fills the page's .itemBackdrop, so it
            // paints exactly where the backdrop image shows and inherits the skin's
            // sticky positioning / mask fade on that element.
            + '.kefin-theme-video-container.kefin-theme-inpage{position:absolute;}'
            + '.kefin-theme-video{width:100%;height:100%;object-fit:cover;}'
            + '.kefin-theme-fs-host{background:#000;}'
            + '.kefin-theme-fs-host .kefin-theme-video{object-fit:contain;}'
            // position:fixed !important: pseudo-fs re-parents the container to <body>,
            // and the in-page variant's position:absolute must not win there.
            + '.kefin-theme-pseudo-fs{position:fixed !important;z-index:99999 !important;opacity:1 !important;pointer-events:auto !important;background:#000 !important;cursor:pointer;-webkit-mask:none !important;mask:none !important;}'
            + '.kefin-theme-pseudo-fs .kefin-theme-video{object-fit:contain;}';
        document.head.appendChild(style);
    }

    function attachMediaDiagnostics(node, url, kind, transcoded) {
        node.addEventListener('loadeddata', () => {
            LOG(kind + ' loadeddata', {
                transcoded,
                dims: kind === 'theme video' ? node.videoWidth + 'x' + node.videoHeight : undefined,
                readyState: node.readyState
            });
        });
        node.addEventListener('playing', () => LOG(kind + ' playing'));
        node.addEventListener('stalled', () => LOG(kind + ' stalled', 'url:', url));
        node.addEventListener('error', () => {
            const err = node.error;
            LOG(kind + ' error', err ? { code: err.code, message: err.message } : 'unknown', 'url:', url);
        });
    }

    // ---- Header controls (mute / volume / fullscreen) ----
    // Placed in the header's right cluster next to cast/profile; they hide with the
    // header automatically (headroom) and only show while a theme is playing.
    let headerCtl = null; // { wrap, muteBtn, slider, fsBtn }

    function ensureControlStyles() {
        if (document.getElementById('kefin-theme-ctl-style')) return;
        const style = document.createElement('style');
        style.id = 'kefin-theme-ctl-style';
        style.textContent =
            // Fixed to the viewport just under the header's right cluster (so the header
            // can't clip it), faint until hovered, positioned/shown via JS.
            // z-index 1001: one above Jellyfin's default .skinHeader (1000). A bare
            // 1000 ties with the header, and since Jellyfin recreates the header on
            // navigation it can land later in the DOM than this wrap and win the tie,
            // painting the header buttons over the controls. Sitting one level up
            // decides it by stacking level, independent of DOM order.
            //
            // Visibility is a fade: the wrap is always display:flex so opacity can
            // transition. Default = faded out + non-interactive; JS adds
            // .kefin-theme-hctl--visible to fade it in (and lets pointer events
            // through) only while a theme plays AND the page is scrolled near the top.
            '.kefin-theme-hctl{display:flex;position:fixed;align-items:center;gap:.1em;'
            + 'opacity:0;pointer-events:none;transition:opacity .3s ease;z-index:1001;max-width:96vw;}'
            + '.kefin-theme-hctl.kefin-theme-hctl--visible{opacity:.14;pointer-events:auto;}'
            + '.kefin-theme-hctl.kefin-theme-hctl--visible:hover{opacity:1;}'
            // Touch devices have no hover to reveal the controls; rest brighter there.
            + '@media (hover:none){.kefin-theme-hctl.kefin-theme-hctl--visible{opacity:.55;}}'
            + '.kefin-theme-hctl .kefin-theme-hbtn{width:2.2em;height:2.2em;flex:none;}'
            + '.kefin-theme-hctl .kefin-theme-hbtn .material-icons{font-size:1.3em;}'
            + '.kefin-theme-hvol{width:4.5em;max-width:30vw;accent-color:currentColor;'
            + 'cursor:pointer;vertical-align:middle;margin:0 .2em;}';
        document.head.appendChild(style);
    }

    function headerIconBtn(icon, title) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'headerButton headerButtonRight paper-icon-button-light kefin-theme-hbtn';
        b.title = title;
        b.innerHTML = '<span class="material-icons" aria-hidden="true">' + icon + '</span>';
        return b;
    }

    function syncMuteIcon() {
        if (headerCtl && headerCtl.muteBtn) {
            headerCtl.muteBtn.querySelector('.material-icons').textContent = userMuted ? 'volume_off' : 'volume_up';
        }
    }

    function buildHeaderControls() {
        ensureControlStyles();
        const wrap = document.createElement('div');
        wrap.className = 'kefin-theme-hctl';
        const ctl = { wrap: wrap, muteBtn: null, slider: null, fsBtn: null };

        if (CONFIG.showMuteButton !== false) {
            ctl.muteBtn = headerIconBtn(userMuted ? 'volume_off' : 'volume_up', 'Mute theme');
            ctl.muteBtn.addEventListener('click', () => {
                userMuted = !userMuted;
                tmSet('muted', userMuted);
                if (el) el.muted = userMuted;
                syncMuteIcon();
            });
            wrap.appendChild(ctl.muteBtn);
        }
        if (CONFIG.showVolumeSlider !== false) {
            ctl.slider = document.createElement('input');
            ctl.slider.type = 'range';
            ctl.slider.min = '0';
            ctl.slider.max = '100';
            ctl.slider.value = String(Math.round(userVolume * 100));
            ctl.slider.className = 'kefin-theme-hvol';
            ctl.slider.title = 'Theme volume';
            ctl.slider.addEventListener('input', () => {
                userVolume = Number(ctl.slider.value) / 100;
                tmSetNum('volume', userVolume);
                clearFade();               // stop any in-flight fade so the drag wins
                if (el) el.volume = userVolume;
            });
            wrap.appendChild(ctl.slider);
        }
        if (CONFIG.showFullscreenButton !== false) {
            ctl.fsBtn = headerIconBtn('fullscreen', 'Fullscreen theme');
            ctl.fsBtn.addEventListener('click', toggleFullscreen);
            wrap.appendChild(ctl.fsBtn);
        }
        return ctl;
    }

    function fsElement() {
        return document.fullscreenElement || document.webkitFullscreenElement || null;
    }
    function exitFs() {
        const fn = document.exitFullscreen || document.webkitExitFullscreen;
        if (fn) { try { fn.call(document); } catch (e) { /* noop */ } }
    }
    function enterFs(node) {
        const fn = node.requestFullscreen || node.webkitRequestFullscreen || node.webkitEnterFullscreen;
        if (fn) { try { const r = fn.call(node); if (r && r.catch) r.catch(() => {}); } catch (e) { /* noop */ } }
    }

    // ---- Fullscreen / Pseudo-Fullscreen Logic ----
    let fsHost = null;
    let inPseudoFs = false;

    function shouldUsePseudoFs() {
        if (CONFIG.pseudoFullscreen === true) return true;
        if (CONFIG.pseudoFullscreen === false) return false;
        // NativeShell = Jellyfin's app WebView wrappers (Android app etc.), where the
        // real Fullscreen API is unreliable; standalone = installed PWA / --app mode.
        return !!window.NativeShell
            || window.navigator.standalone === true
            || window.matchMedia('(display-mode: standalone)').matches;
    }

    // Pseudo-fs must re-parent the container to <body>: on mobile it lives inside the
    // page's .itemBackdrop, whose stacking context (sticky + mask, under page chrome)
    // traps any z-index — 99999 inside a buried context still paints behind the page.
    function enterPseudoFs() {
        if (!el || !el._kefinContainer) return;
        const c = el._kefinContainer;
        inPseudoFs = true;
        c._kefinFsRestore = { parent: c.parentNode, next: c.nextSibling };
        document.body.appendChild(c);
        c.classList.add('kefin-theme-pseudo-fs');
        c.addEventListener('click', exitPseudoFs); // Click/tap to exit
        syncFsIcon();
    }

    function exitPseudoFs() {
        inPseudoFs = false;
        if (el && el._kefinContainer) {
            const c = el._kefinContainer;
            c.classList.remove('kefin-theme-pseudo-fs');
            c.removeEventListener('click', exitPseudoFs);
            const r = c._kefinFsRestore;
            c._kefinFsRestore = null;
            // Restore the original mount; if it's gone (page navigated away while
            // fullscreen), leave the container on <body> — teardown removes it anyway.
            if (r && r.parent && r.parent.isConnected) {
                r.parent.insertBefore(c, r.next && r.next.parentNode === r.parent ? r.next : null);
            }
        }
        syncFsIcon();
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && inPseudoFs) {
            exitPseudoFs();
        }
    });

    function teardownFsHost() {
        if (!fsHost) return;
        const host = fsHost;
        fsHost = null;
        const video = host.querySelector('video');
        if (video && video === el && el._kefinContainer && document.body.contains(el._kefinContainer)) {
            el._kefinContainer.appendChild(video);
            if (!video.paused || video._played) video.play().catch(() => { /* noop */ });
        }
        host.remove();
    }

    function toggleFullscreen() {
        if (shouldUsePseudoFs()) {
            if (inPseudoFs) {
                exitPseudoFs();
            } else if (el && el._kefinContainer) {
                enterPseudoFs();
            }
            return;
        }

        if (fsElement()) {
            exitFs();                       // clicking again (or Escape) leaves fullscreen
        } else if (el && el._kefinContainer) {
            const host = document.createElement('div');
            host.className = 'kefin-theme-fs-host';
            host.appendChild(el);           // move the video out of the backdrop
            document.body.appendChild(host);
            fsHost = host;
            enterFs(host);
            // If the request is denied, put everything back immediately.
            setTimeout(() => { if (fsHost === host && !fsElement()) teardownFsHost(); }, 400);
        }
    }

    function syncFsIcon() {
        const inFs = !!fsElement() || inPseudoFs;
        if (headerCtl && headerCtl.fsBtn) {
            headerCtl.fsBtn.querySelector('.material-icons').textContent = inFs ? 'fullscreen_exit' : 'fullscreen';
        }
        // Left native fullscreen: move the video home and destroy the host.
        if (!inFs && fsHost) teardownFsHost();
    }

    document.addEventListener('fullscreenchange', syncFsIcon);
    document.addEventListener('webkitfullscreenchange', syncFsIcon);

    let hdrCtlListeners = false;
    let headroomObserver = null;
    let observedHeader = null;
    let themeControlsActive = false; // true between show/hideHeaderControls (theme playing)

    // The mobile header hides/shows via the headroom library: it toggles
    // .headroom--unpinned/.headroom--pinned on .skinHeader and animates a translateY
    // over 0.5s (`.headroom{transition:transform .5s}`). Two consequences drive this
    // code: (1) the header's VERTICAL position during that animation is a transform,
    // so getBoundingClientRect().bottom is unreliable mid-slide — we must use
    // offsetHeight (transform-immune) for the vertical anchor; (2) the class is set
    // at the START of the animation and reflects the final state, so we read the
    // class, not the live rect, to decide shown/hidden. That makes a scroll event
    // that lands mid-animation (or a fast flick) produce the correct resting position
    // instead of anchoring to a half-slid header or hiding and never recovering.
    function ensureHeadroomObserver() {
        const header = document.querySelector('.skinHeader');
        if (!header || header === observedHeader) return;
        if (headroomObserver) headroomObserver.disconnect();
        observedHeader = header;
        headroomObserver = new MutationObserver(positionHeaderControls);
        headroomObserver.observe(header, { attributes: true, attributeFilter: ['class'] });
    }

    // Controls are shown only while a theme is playing AND the page is scrolled to
    // (near) the top — the hero zone where the theme video / logo / title live.
    // Past this much scroll they fade out, so they never float over page content.
    const CONTROLS_TOP_WIGGLE = 96; // px of scroll wiggle room from the very top

    function setControlsVisible(v) {
        if (headerCtl) headerCtl.wrap.classList.toggle('kefin-theme-hctl--visible', v);
    }

    // Position + decide visibility. Visibility is a CSS-class fade, not display, so
    // hiding/showing animates. Every "hide" path just drops the --visible class.
    function positionHeaderControls() {
        if (!headerCtl) return;
        if (!themeControlsActive) { setControlsVisible(false); return; }

        const header = document.querySelector('.skinHeader');
        const right = document.querySelector('.headerRight');
        if (!header || !right) { setControlsVisible(false); return; }

        // Hide once scrolled past the wiggle room. Window-level scroll on these pages
        // (matches infiniteScroll/homeScreen); transform-immune, so no animation race.
        const scrollTop = window.scrollY || document.documentElement.scrollTop || 0;
        if (scrollTop > CONTROLS_TOP_WIGGLE) { setControlsVisible(false); return; }

        // Header hidden state from the headroom class (final intent), not the animated
        // rect. .headroom--unpinned only actually hides the header at mobile widths —
        // ElegantFin overrides it to translateY(0) in a min-width media query — so
        // gate on layout-mobile. (Near the top the header is normally pinned anyway,
        // but this covers the brief window during a fast upward flick.)
        const mobile = document.documentElement.classList.contains('layout-mobile');
        if (mobile && header.classList.contains('headroom--unpinned')) {
            setControlsVisible(false);
            return;
        }

        // Vertical: the header is fixed at top:0, so its resting bottom edge is just
        // its offsetHeight — which the headroom translateY does not affect, so this
        // is correct even while the header is mid-slide (rect.top would not be).
        const headerBottom = header.offsetHeight;
        // Horizontal: the translateY doesn't move things sideways, so the right
        // cluster's rect.right is safe to read live.
        const rightEdge = right.getBoundingClientRect().right;
        headerCtl.wrap.style.top = (headerBottom + 3) + 'px';
        headerCtl.wrap.style.right = Math.max(4, Math.round(window.innerWidth - rightEdge)) + 'px';
        setControlsVisible(true);
    }

    function ensureHeaderControls() {
        if (headerCtl && document.body.contains(headerCtl.wrap)) { ensureHeadroomObserver(); return headerCtl; }
        if (!document.querySelector('.headerRight')) { headerCtl = null; return null; }
        headerCtl = buildHeaderControls();
        document.body.appendChild(headerCtl.wrap); // fixed, so parent doesn't matter
        ensureHeadroomObserver();
        if (!hdrCtlListeners) {
            hdrCtlListeners = true;
            window.addEventListener('scroll', positionHeaderControls, true); // capture: inner scrollers too
            window.addEventListener('resize', positionHeaderControls);
        }
        return headerCtl;
    }

    function showHeaderControls(isVideo) {
        const hc = ensureHeaderControls();
        if (!hc) return;
        syncMuteIcon();
        if (hc.slider) hc.slider.value = String(Math.round(userVolume * 100));
        if (hc.fsBtn) hc.fsBtn.style.display = isVideo ? '' : 'none';
        themeControlsActive = true;
        positionHeaderControls(); // fades in if scrolled near the top
    }

    function hideHeaderControls() {
        themeControlsActive = false;
        setControlsVisible(false); // fade out; element stays in the DOM
    }

    // ---- Playback with autoplay-policy fallback ----
    // On a fresh page load / refresh there is no user gesture yet, so play() with
    // sound is blocked (NotAllowedError) and the video freezes on frame 1. We then
    // play muted and unmute on the first user interaction.
    function armUnmuteOnGesture(node) {
        if (userMuted) return;
        const handler = () => {
            if (node === el && !userMuted) node.muted = false;
            ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => document.removeEventListener(ev, handler, true));
        };
        ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, handler, true));
    }

    function onPlaySuccess(node, isVideo) {
        if (node !== el) return;
        node._played = true;
        if (isVideo) showVideo(node);
        fadeTo(node, userVolume);
        showHeaderControls(isVideo);
    }

    function hasUserActivation() {
        // On a fresh load / refresh there's no activation yet, so audible autoplay is
        // blocked (a few frames may show, then it pauses). Muted autoplay is always
        // allowed, so start muted when there's been no interaction and unmute later.
        try {
            return !navigator.userActivation || navigator.userActivation.hasBeenActive;
        } catch (e) {
            return true;
        }
    }

    function tryPlay(node, item, isVideo, triedTranscode) {
        node._tmTried = node._tmTried || triedTranscode;

        const forcedMute = !userMuted && !hasUserActivation();
        if (forcedMute) node.muted = true;

        node.play().then(() => {
            onPlaySuccess(node, isVideo);
            if (forcedMute) armUnmuteOnGesture(node);
        }).catch((e) => {
            if (!e || e.name === 'AbortError') return; // benign / superseded
            if (e.name === 'NotAllowedError') {
                node.muted = true; // backstop if the activation check was wrong
                node.play().then(() => {
                    onPlaySuccess(node, isVideo);
                    armUnmuteOnGesture(node);
                }).catch(() => { if (node === el) destroyEl(); });
                return;
            }
            LOG(isVideo ? 'theme video play() rejected' : 'theme song play() rejected', e.name);
            if (!node._tmTried && !node._played && node === el) {
                node._tmTried = true;
                node.src = isVideo ? transcodeVideoUrl(item.Id, null) : audioTranscodeUrl(item.Id);
                LOG('retrying via transcode', node.src);
                tryPlay(node, item, isVideo, true);
            } else if (node === el) {
                destroyEl();
            }
        });
    }

    function makeVideoElement() {
        ensureVideoCss();
        const container = document.createElement('div');
        container.className = 'kefin-theme-video-container';
        if (CONFIG.videoZIndex != null) container.style.zIndex = String(CONFIG.videoZIndex);
        container.style.opacity = '0'; // fade-in ramps up to CONFIG.videoOpacity
        const video = document.createElement('video');
        video.className = 'kefin-theme-video';
        video.playsInline = true;
        // Attributes (not just the property) are required for iOS/mobile to composite
        // the video inline; without them it plays audio but shows nothing.
        video.setAttribute('playsinline', '');
        video.setAttribute('webkit-playsinline', '');
        video.setAttribute('x5-playsinline', '');
        video.setAttribute('disablepictureinpicture', '');
        video.preload = 'auto';
        video.muted = userMuted;
        container.appendChild(video);

        // Mobile: the backdrop the user sees is NOT the global .backdropContainer
        // layer. jellyfin-web only feeds that layer on wide screens; under 1000px it
        // clears it, .backgroundContainer never gets .withBackdrop, and the skin
        // paints it opaque — so anything mounted in .backdropContainer is behind a
        // permanently opaque wall. What actually shows on a mobile detail page is
        // the in-page .itemBackdrop element (sticky, mask-faded by ElegantFin).
        // Mount the video absolute-filling THAT, so it appears exactly where the
        // backdrop image is and is torn down with the page.
        // Desktop keeps the proven body.firstChild path.
        const inPageHost = document.documentElement.classList.contains('layout-mobile')
            ? (document.querySelector('.page:not(.hide) .itemBackdrop')
                || document.querySelector('.itemBackdrop'))
            : null;
        if (inPageHost) {
            // Absolute children need a positioned ancestor; ElegantFin makes
            // .itemBackdrop sticky, but guard for stock CSS where it may be static.
            if (getComputedStyle(inPageHost).position === 'static') {
                inPageHost.style.position = 'relative';
            }
            container.classList.add('kefin-theme-inpage');
            inPageHost.appendChild(container);
            LOG('theme video mounted inside .itemBackdrop (mobile)');
        } else {
            document.body.insertBefore(container, document.body.firstChild);
        }
        video._kefinContainer = container;
        return video;
    }

    // `node === el` guards ensure a superseded element's async callbacks never tear
    // down the element a newer call has since installed. AbortError is benign: it
    // just means play() was interrupted by a deliberate pause()/load().
    async function playItem(item, isVideo) {
        // Crossfade: fade the outgoing theme out rather than hard-cutting it.
        if (el) {
            clearFade();
            const dying = el;
            el = null;
            fadeOutAndRemove(dying);
        }

        if (isVideo) {
            const node = makeVideoElement();
            el = node;
            node.loop = CONFIG.loop;
            node.volume = 0;
            node.muted = userMuted;
            armEndFade(node);
            if (!CONFIG.loop) node.onended = () => {
                if (node !== el) return;
                advancePlaylist();
            };
            node.onerror = () => {
                if (node !== el || node._tmTried || node._played) return;
                node._tmTried = true;
                LOG('theme video media error, retrying via transcode');
                node.src = transcodeVideoUrl(item.Id, null);
                tryPlay(node, item, true, true);
            };

            let src;
            try {
                src = await resolveVideoSource(item.Id);
            } catch (e) {
                LOG('failed to resolve theme video source', e);
                if (node === el) destroyEl();
                return;
            }
            if (node !== el) return; // superseded while resolving

            attachMediaDiagnostics(node, src.url, 'theme video', src.transcoded);
            LOG('theme video url', src.url);
            node.src = src.url;
            tryPlay(node, item, true, src.transcoded);
            return;
        }

        // Theme song
        const node = document.createElement('audio');
        node.className = 'kefin-theme-audio'; // marks it ours, so playback detection skips it
        node.style.display = 'none';
        document.body.appendChild(node); // in-DOM: avoids some autoplay edge cases
        el = node;
        node.loop = CONFIG.loop;
        node.volume = 0;
        node.muted = userMuted;
        armEndFade(node);
        if (!CONFIG.loop) node.onended = () => {
            if (node !== el) return;
            advancePlaylist();
        };
        node.onerror = () => {
            if (node !== el || node._tmTried || node._played) return;
            node._tmTried = true;
            LOG('theme song media error, retrying via transcode');
            node.src = audioTranscodeUrl(item.Id);
            tryPlay(node, item, false, true);
        };

        const directUrl = audioDirectUrl(item.Id);
        attachMediaDiagnostics(node, directUrl, 'theme song', false);
        LOG('theme song url', directUrl);
        node.src = directUrl;
        tryPlay(node, item, false, false);
    }

    // Fisher-Yates shuffle so the playlist order varies each visit.
    function shuffleArray(arr) {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const tmp = arr[i];
            arr[i] = arr[j];
            arr[j] = tmp;
        }
        return arr;
    }

    async function loadTheme(itemId) {
        if (typeof ApiClient === 'undefined' || !ApiClient) return;

        // Sole handler: both toggles off -> nothing to do.
        if (!enableThemeSongs() && !enableThemeVideos()) {
            stopTheme();
            return;
        }
        // Never let a theme run alongside real playback (local OR shim). Checked
        // unconditionally: the old version skipped this while we were already the
        // theme owner, which let a theme survive navigation within a series even
        // after media started. If something is playing, stop and stay stopped.
        if (isRealPlaybackActive()) {
            stopTheme();
            return;
        }

        // viewshow can fire multiple times per page; only the newest call may play.
        const seq = ++loadSeq;

        let result;
        try {
            const media = await ApiClient.getThemeMedia(ApiClient.getCurrentUserId(), itemId, true);
            const videos = media && media.ThemeVideosResult;
            const songs = media && media.ThemeSongsResult;
            // Mirror native: theme video when enabled AND present, else theme song.
            if (enableThemeVideos() && videos && videos.Items && videos.Items.length) {
                result = videos;
                result._isVideo = true;
            } else if (enableThemeSongs() && songs && songs.Items && songs.Items.length) {
                result = songs;
                result._isVideo = false;
            } else {
                result = null;
            }
        } catch (e) {
            if (seq === loadSeq) stopTheme();
            return;
        }

        if (seq !== loadSeq) return; // superseded by a newer viewshow

        if (!result || !result.Items || !result.Items.length) {
            stopTheme();
            return;
        }
        if (result.OwnerId && result.OwnerId === currentOwnerId) {
            return; // already playing this theme (same owner)
        }

        // Build the playlist: shuffle all items so the order varies each visit.
        const items = shuffleArray(result.Items.slice());
        playlist = items;
        playlistIndex = 0;
        playlistIsVideo = !!result._isVideo;
        playCountPlayed = 0;
        clearBetweenDelay();
        currentOwnerId = result.OwnerId || items[0].Id;

        LOG('Playing theme', playlistIsVideo ? 'video' : 'song', 'playlist of', items.length,
            'item(s) for owner', currentOwnerId,
            '(playCount=' + CONFIG.playCount + ', loopPlaylist=' + CONFIG.loopPlaylist + ', delay=' + CONFIG.betweenItemsDelaySec + 's)');

        startPlaybackWatch(); // stop the theme the moment real playback begins
        playItem(items[0], playlistIsVideo);
    }

    document.addEventListener('viewshow', (e) => {
        initThemeSettings();
        if ((window.location.hash || '').toLowerCase().indexOf('display') !== -1) {
            ensureThemeSettingsCustomized();
        }
        const params = (e.detail && e.detail.params) || {};
        if (params.id) {
            void loadTheme(params.id);
            return;
        }
        const opts = (e.detail && e.detail.options) || {};
        if (!opts.supportsThemeMedia) {
            loadSeq++; // cancel a loadTheme still in flight for the page we just left
            stopTheme();
        }
    }, true);

    initThemeSettings(); // also attempt immediately at load

    // Instant-response observer: stop our theme the moment the bar changes into a
    // visible/playing state (local OR shim). This is the low-latency path; the 400ms
    // playbackWatch poll is the backstop for anything this misses (stale bar, missed
    // transition). Watches class AND style, and re-checks with the robust predicate.
    let observedBar = null;
    function attachStateObserver() {
        const bar = document.querySelector('.nowPlayingBar');
        if (!bar || bar === observedBar) return !!bar;
        observedBar = bar;
        new MutationObserver(() => {
            if (el && isRealPlaybackActive()) stopTheme();
        }).observe(bar, { attributes: true, attributeFilter: ['class', 'style'] });
        return true;
    }

    if (!attachStateObserver()) {
        const bootObserver = new MutationObserver(() => {
            if (attachStateObserver()) bootObserver.disconnect();
        });
        bootObserver.observe(document.body, { childList: true, subtree: true });
    }

    // ---- Feature configuration modal (the "Configure" button on the KefinTweaks
    // feature card). Mirrors the fork's *-configuration.js pattern: ModalSystem +
    // KefinTweaksUtils.saveConfigToJavaScriptInjector. Changes apply on next reload. ----
    (function registerConfigModal() {
        const MODAL_ID = 'kefin-thememedia-config';

        function checkRow(id, checked, label, desc) {
            return '<div class="listItem" style="border:1px solid rgba(255,255,255,0.1);border-radius:4px;padding:0.75em;margin-bottom:1em;">'
                + '<div class="listItemContent">'
                + '<div class="listItemBodyText" style="margin-bottom:0.5em;">' + label + '</div>'
                + '<div class="listItemBodyText secondary" style="margin-bottom:0.75em;font-size:0.9em;">' + desc + '</div>'
                + '<label class="checkboxContainer" style="display:flex;align-items:center;gap:0.5em;">'
                + '<input type="checkbox" id="' + id + '"' + (checked ? ' checked' : '') + '>'
                + '<span class="listItemBodyText">Enabled</span></label>'
                + '</div></div>';
        }

        function selectRow(id, value, label, desc, options) {
            let optsHtml = '';
            for (let i = 0; i < options.length; i++) {
                optsHtml += '<option value="' + options[i].value + '"' + (options[i].value === String(value) ? ' selected' : '') + '>' + options[i].label + '</option>';
            }
            return '<div class="listItem" style="border:1px solid rgba(255,255,255,0.1);border-radius:4px;padding:0.75em;margin-bottom:1em;">'
                + '<div class="listItemContent">'
                + '<div class="listItemBodyText" style="margin-bottom:0.5em;">' + label + '</div>'
                + '<div class="listItemBodyText secondary" style="margin-bottom:0.75em;font-size:0.9em;">' + desc + '</div>'
                + '<select id="' + id + '" style="background:var(--theme-background);color:var(--theme-text-color);padding:.5em;border:1px solid rgba(255,255,255,0.2);border-radius:4px;width:100%;font-size:inherit;">' + optsHtml + '</select>'
                + '</div></div>';
        }

        function numberRow(id, value, label, desc, min, step) {
            return '<div class="listItem" style="border:1px solid rgba(255,255,255,0.1);border-radius:4px;padding:0.75em;margin-bottom:1em;">'
                + '<div class="listItemContent">'
                + '<div class="listItemBodyText" style="margin-bottom:0.5em;">' + label + '</div>'
                + '<div class="listItemBodyText secondary" style="margin-bottom:0.75em;font-size:0.9em;">' + desc + '</div>'
                + '<input type="number" id="' + id + '" value="' + value + '"'
                + (min !== undefined ? ' min="' + min + '"' : '')
                + (step !== undefined ? ' step="' + step + '"' : '')
                + ' style="background:var(--theme-background);color:var(--theme-text-color);padding:.5em;border:1px solid rgba(255,255,255,0.2);border-radius:4px;width:100%;font-size:inherit;">'
                + '</div></div>';
        }

        function buildConfigHTML(cfg) {
            return '<div style="max-width:800px;">'
                + selectRow('themeMediaCastFix_pseudoFullscreen', cfg.pseudoFullscreen === undefined ? 'auto' : cfg.pseudoFullscreen, 'Pseudo-Fullscreen Mode',
                    'Bypass native fullscreen API and use a CSS viewport fill. Fixes fullscreen lockups in standalone/app modes.',
                    [{value: 'auto', label: 'Auto (Detect WebApp)'}, {value: 'true', label: 'Force On'}, {value: 'false', label: 'Force Off'}])
                + checkRow('themeMediaCastFix_showMuteButton', cfg.showMuteButton !== false, 'Show Mute Button',
                    'Adds a mute button to the header while a theme song or video is playing.')
                + checkRow('themeMediaCastFix_showVolumeSlider', cfg.showVolumeSlider !== false, 'Show Volume Slider',
                    'Adds a volume slider to the header while a theme is playing.')
                + checkRow('themeMediaCastFix_showFullscreenButton', cfg.showFullscreenButton !== false, 'Show Fullscreen Button',
                    'Adds a fullscreen button to the header while a theme video is playing.')
                + '<div style="margin:1.5em 0 0.5em;font-weight:bold;font-size:1.1em;">Playlist Options</div>'
                + numberRow('themeMediaCastFix_playCount', cfg.playCount === undefined ? -1 : cfg.playCount, 'Play Count',
                    'How many theme items to play before stopping and returning to backdrops. Use -1 to play all items in the theme media result.',
                    -1, 1)
                + checkRow('themeMediaCastFix_loopPlaylist', cfg.loopPlaylist === true, 'Loop Playlist',
                    'After the last theme item finishes, wrap back to the first and continue forever. This overrides the Play Count limit.')
                + numberRow('themeMediaCastFix_betweenItemsDelaySec', cfg.betweenItemsDelaySec === undefined ? 0 : cfg.betweenItemsDelaySec, 'Between-Items Delay (seconds)',
                    'Seconds to wait between consecutive theme items. The player fades out, backdrops are shown for this duration, then the next item fades in. Set to 0 for seamless crossfades.',
                    0, 1)
                + '</div>';
        }

        function collectConfig() {
            const base = (window.KefinTweaksConfig && window.KefinTweaksConfig.themeMediaCastFix) || {};
            
            let pfVal = document.getElementById('themeMediaCastFix_pseudoFullscreen') ? document.getElementById('themeMediaCastFix_pseudoFullscreen').value : 'auto';
            if (pfVal === 'true') pfVal = true;
            if (pfVal === 'false') pfVal = false;

            const playCountEl = document.getElementById('themeMediaCastFix_playCount');
            const playCountVal = playCountEl ? parseInt(playCountEl.value, 10) : -1;

            const delayEl = document.getElementById('themeMediaCastFix_betweenItemsDelaySec');
            const delayVal = delayEl ? Math.max(0, parseFloat(delayEl.value) || 0) : 0;

            return Object.assign({}, base, {
                pseudoFullscreen: pfVal,
                showMuteButton: document.getElementById('themeMediaCastFix_showMuteButton') && document.getElementById('themeMediaCastFix_showMuteButton').checked,
                showVolumeSlider: document.getElementById('themeMediaCastFix_showVolumeSlider') && document.getElementById('themeMediaCastFix_showVolumeSlider').checked,
                showFullscreenButton: document.getElementById('themeMediaCastFix_showFullscreenButton') && document.getElementById('themeMediaCastFix_showFullscreenButton').checked,
                playCount: isNaN(playCountVal) ? -1 : playCountVal,
                loopPlaylist: document.getElementById('themeMediaCastFix_loopPlaylist') && document.getElementById('themeMediaCastFix_loopPlaylist').checked,
                betweenItemsDelaySec: delayVal
            });
        }

        async function saveConfig(newCfg) {
            try {
                if (!window.KefinTweaksConfig) window.KefinTweaksConfig = {};
                window.KefinTweaksConfig.themeMediaCastFix = newCfg;
                if (window.KefinTweaksUtils && window.KefinTweaksUtils.saveConfigToJavaScriptInjector) {
                    await window.KefinTweaksUtils.saveConfigToJavaScriptInjector();
                    return true;
                }
                return false;
            } catch (e) {
                LOG('config save error', e);
                return false;
            }
        }

        async function openConfigModal() {
            try {
                if (!window.ModalSystem || !window.ModalSystem.create) {
                    alert('KefinTweaks modal system unavailable.');
                    return;
                }
                const cfg = (window.KefinTweaksConfig && window.KefinTweaksConfig.themeMediaCastFix) || {};
                const content = document.createElement('div');
                content.innerHTML = buildConfigHTML(cfg);

                const footer = document.createElement('div');
                footer.style.cssText = 'display:flex;gap:0.75em;justify-content:flex-end;';
                footer.innerHTML = '<button class="emby-button raised" onclick="window.ModalSystem.close(\'' + MODAL_ID + '\')">Close</button>'
                    + '<button class="emby-button raised block button-submit" id="save-thememedia-config-btn">Save</button>';

                const modalInstance = window.ModalSystem.create({
                    id: MODAL_ID,
                    title: 'Theme Media Configuration',
                    content: content,
                    footer: footer,
                    closeOnBackdrop: true,
                    closeOnEscape: true,
                    showCloseButton: true,
                    onOpen: (modal) => {
                        const saveBtn = modal.dialogFooter.querySelector('#save-thememedia-config-btn');
                        if (saveBtn) {
                            saveBtn.addEventListener('click', async () => {
                                const ok = await saveConfig(collectConfig());
                                if (ok) {
                                    if (window.KefinTweaksToaster && window.KefinTweaksToaster.toast) {
                                        window.KefinTweaksToaster.toast('Theme Media configuration saved! Reload to apply.');
                                    }
                                    window.ModalSystem.close(MODAL_ID);
                                } else {
                                    alert('Error saving configuration. Ensure the JavaScript Injector plugin is installed and you have administrator permissions.');
                                }
                            });
                        }
                    }
                });
                if (modalInstance && modalInstance.dialog) {
                    modalInstance.dialog.style.maxWidth = '90vw';
                    modalInstance.dialog.style.width = '800px';
                    modalInstance.dialog.style.height = 'auto';
                }
            } catch (e) {
                LOG('error opening config modal', e);
                alert('Error opening configuration: ' + e.message);
            }
        }

        window.KefinTweaksFeatureConfigs = window.KefinTweaksFeatureConfigs || {};
        window.KefinTweaksFeatureConfigs.themeMediaCastFix = { openConfigModal: openConfigModal };
    })();

    LOG('Theme media cast fix functionality initialized');
})();