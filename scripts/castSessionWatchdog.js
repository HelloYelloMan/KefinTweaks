// Cast Session Watchdog
// Keeps the `Sessions` WebSocket feed alive while a remote/cast player (mpv-shim,
// another browser, a TV app) is the selected playback target.
//
// The bug this fixes: the now playing bar stays on screen, showing a frozen seek
// bar, long after the cast target stopped playing. The server is not at fault —
// its session correctly reports NowPlayingItem: null. The web client simply never
// hears about it.
//
// How jellyfin-web gets that news:
//   - sessionPlayer subscribes with sendMessage('SessionsStart', '100,800'), and
//     the server then pushes a `Sessions` message every 800ms.
//   - Each push runs the bar's onStateChanged, which hides the bar the moment a
//     state arrives without a NowPlayingItem.
// So while the feed is live the bar cannot go stale. A stale bar means the feed
// is dead.
//
// Why it dies: `Sessions` is ONE subscription per WebSocket connection, but two
// unrelated consumers share it, and both tear it down with an unqualified stop
// that carries no subscriber identity:
//   - sessionPlayer.endPlayerUpdates()  -> sendMessage('SessionsStop')
//   - the dashboard devices widget      -> sendMessage(SessionsStop, null) on
//                                          React cleanup
// Either one unmounting silences the other, and nothing re-subscribes. The poll
// fallback in sessionPlayer cannot save it either: it only fires when
// `!isMessageChannelOpen()`, so a socket that is open but unsubscribed gets
// neither pushes nor polls. That dead zone lasts until you reload the page.
//
// The fix here is deliberately small: notice the feed has gone quiet while the
// bar depends on it, and re-send SessionsStart. Everything after that is native —
// the server resumes pushing and jellyfin-web hides its own bar. We never touch
// the bar's DOM, because a bar hidden behind playbackManager's back is re-shown
// from stale data on the next `viewbeforeshow`.

(function() {
    'use strict';

    const LOG  = (...args) => console.log('[KefinTweaks CastSessionWatchdog]', ...args);
    const WARN = (...args) => console.warn('[KefinTweaks CastSessionWatchdog]', ...args);

    const CONFIG = Object.assign({
        checkIntervalMs: 2000,       // how often to test the invariant
        staleAfterMs: 6000,          // silence this long => the subscription is gone
        minResubscribeGapMs: 10000,  // floor between re-subscribe attempts
        maxAttemptsPerStall: 3,      // give up rather than re-send forever
        subscribeArgs: '100,800'     // must match sessionPlayer's own SessionsStart
    }, window.KefinTweaksConfig?.castSessionWatchdog || {});

    LOG('Script loaded - JS Injector mode');

    let lastSessionsMessage = Date.now();
    let lastResubscribe = 0;
    let attempts = 0;
    let gaveUpLogged = false;
    let hookedSocket = null;

    // ---------------------------------------------------------------------
    // Watch the feed
    // ---------------------------------------------------------------------

    // Chained rather than replaced, so this coexists with websocketHelper and
    // with Jellyfin's own handler regardless of which attaches first. Re-attaches
    // when the socket object changes, which is how a reconnect presents itself.
    function hookSocket() {
        const api = window.ApiClient;
        const socket = api && (api.webSocket || api._webSocket);
        if (!socket || socket === hookedSocket) return;

        const previous = socket.onmessage;
        socket.onmessage = function(event) {
            if (previous) previous.call(this, event);
            try {
                const raw = event.Data || event.data;
                const msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
                if (msg && msg.MessageType === 'Sessions') lastSessionsMessage = Date.now();
            } catch (err) { /* malformed frame is not ours to report */ }
        };

        hookedSocket = socket;
        // A new socket carries a new subscription state; the old socket's traffic
        // says nothing about it, so start the clock fresh instead of firing
        // immediately on a reconnect.
        lastSessionsMessage = Date.now();
        attempts = 0;
        gaveUpLogged = false;
        LOG('Attached to WebSocket');
    }

    // ---------------------------------------------------------------------
    // Test the invariant: a visible bar that is not local playback needs the feed
    // ---------------------------------------------------------------------

    function barIsVisible() {
        const bar = document.querySelector('.nowPlayingBar');
        return !!bar
            && !bar.classList.contains('hide')
            && !bar.classList.contains('nowPlayingBar-hidden');
    }

    // Local audio keeps the bar up with no Sessions subscription at all — the
    // local player has no beginPlayerUpdates — so it must not read as a stall.
    // KefinTweaks' own theme-media elements are marked kefin-* and are not
    // playback.
    function localMediaPlaying() {
        return Array.from(document.querySelectorAll('video, audio')).some((el) => {
            if (String(el.className || '').indexOf('kefin-') !== -1) return false;
            return !el.paused && !el.ended;
        });
    }

    function tick() {
        hookSocket();

        const api = window.ApiClient;
        if (!api || typeof api.sendMessage !== 'function') return;

        if (!barIsVisible() || localMediaPlaying()) {
            attempts = 0;
            gaveUpLogged = false;
            return;
        }

        const now = Date.now();
        const silentFor = now - lastSessionsMessage;

        if (silentFor < CONFIG.staleAfterMs) {
            attempts = 0;
            gaveUpLogged = false;
            return;
        }

        // Nothing to re-subscribe over. sessionPlayer's own 5s poll covers a
        // closed channel, so leave that case alone.
        if (typeof api.isMessageChannelOpen === 'function' && !api.isMessageChannelOpen()) return;

        if (attempts >= CONFIG.maxAttemptsPerStall) {
            if (!gaveUpLogged) {
                gaveUpLogged = true;
                WARN('Re-subscribed ' + attempts + ' times without the feed recovering. ' +
                     'Giving up until it does — reload the page to clear the bar.');
            }
            return;
        }

        if (now - lastResubscribe < CONFIG.minResubscribeGapMs) return;

        lastResubscribe = now;
        attempts++;
        WARN('Sessions feed silent for ' + Math.round(silentFor / 1000) + 's while the now ' +
             'playing bar is up — re-sending SessionsStart (attempt ' + attempts + ')');
        try {
            api.sendMessage('SessionsStart', CONFIG.subscribeArgs);
        } catch (err) {
            WARN('SessionsStart failed:', err);
        }
    }

    setInterval(tick, CONFIG.checkIntervalMs);
    hookSocket();

    // Escape hatch for diagnosing this from the console.
    window.kefinCastWatchdog = {
        status: () => ({
            barVisible: barIsVisible(),
            localMediaPlaying: localMediaPlaying(),
            silentForMs: Date.now() - lastSessionsMessage,
            attemptsThisStall: attempts,
            socketHooked: !!hookedSocket
        }),
        resubscribe: () => {
            window.ApiClient.sendMessage('SessionsStart', CONFIG.subscribeArgs);
            LOG('SessionsStart sent manually');
        }
    };

    LOG('Cast session watchdog initialized');
})();
