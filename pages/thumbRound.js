// KefinTweaks Thumbnail Round (FORK-ONLY)
//
// A season the player has watched some of, drawn at random by the AnimePipeline
// plugin, one watched episode at a time: its title in the middle over the
// picture it has now, the providers' stills on two arcs either side. A pick is
// staged; after the last episode every pick is shown on its episode, and Write
// sends them back together.
//
// The writes go to the plugin, which files each still with the pipeline and
// places it from there. A picture saved straight onto an episode would be put
// back by the pipeline's archive guard, so nothing here touches an item's
// images itself.

(function () {
    'use strict';

    const LOG = (...args) => console.log('[KefinTweaks ThumbRound]', ...args);

    // The stills' arcs, as fractions of the stage measured from its centre.
    const ARC_RX = 0.37;
    const ARC_RY = 0.30;
    // Each side arc spans this many degrees either side of the horizontal.
    const SIDE_ARC = 40;
    // How long a pick stays on screen before the round moves on.
    const ADVANCE_MS = 260;
    // How long an armed button waits for its second press.
    const ARM_MS = 4000;

    const $ = (id) => document.getElementById(id);

    const S = {
        round: null,
        i: 0,
        reviewing: false,
        hover: null,
        picks: {},      // itemId -> still
        kept: {},       // itemId -> true
        written: {},    // itemId -> true
        errors: {},     // itemId -> message
        stills: {},     // itemId -> Promise<{stills, note}>
        resolved: {},   // itemId -> {stills, note}
        played: [],     // season ids this session
        writing: false,
        armed: null,
        stamp: Date.now(),
    };

    function client() {
        return window.ApiClient;
    }

    function authHeader() {
        const fromHelper = window.apiHelper?.getAuthHeader?.();
        if (fromHelper) return fromHelper;
        return `MediaBrowser Token="${client().accessToken()}"`;
    }

    async function api(path, params, init) {
        const res = await fetch(client().getUrl(path, params || {}), Object.assign({
            headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
        }, init || {}));
        if (res.status === 204) return null;
        if (res.status === 401 || res.status === 403) throw new Error('Admins only');
        if (!res.ok) throw new Error(`${path}: ${res.status}`);
        return res.json();
    }

    function code(ep) {
        const pad = (n) => String(n ?? 0).padStart(2, '0');
        return `S${pad(ep.parentIndex)}E${pad(ep.index)}`;
    }

    function currentUrl(ep) {
        return client().getUrl(`Items/${ep.id}/Images/Primary`, { maxWidth: 960, quality: 90, v: S.stamp });
    }

    function stillUrl(still) {
        // A plain <img>, so the token rides the query string.
        return client().getUrl('AnimePipeline/Game/Still', { url: still.url, ApiKey: client().accessToken() });
    }

    function stillLabel(still) {
        const size = still.width && still.height ? ` · ${still.width}×${still.height}` : '';
        return (still.provider || 'Still') + size;
    }

    function place(deg) {
        const a = deg * Math.PI / 180;
        return { left: `${50 + ARC_RX * 100 * Math.cos(a)}%`, top: `${50 + ARC_RY * 100 * Math.sin(a)}%` };
    }

    function ep() {
        return S.round?.episodes[S.i] || null;
    }

    // --- Loading ---

    function stillsFor(e) {
        if (!e) return null;
        if (!S.stills[e.id]) {
            S.stills[e.id] = api('AnimePipeline/Game/Stills', { itemId: e.id })
                .then((r) => (S.resolved[e.id] = { stills: r?.stills || [], note: r?.note || '' }))
                .catch((err) => (S.resolved[e.id] = { stills: [], note: String(err.message || err) }));
        }
        return S.stills[e.id];
    }

    async function newRound() {
        Object.assign(S, {
            round: null, i: 0, reviewing: false, hover: null, picks: {}, kept: {},
            written: {}, errors: {}, stills: {}, resolved: {}, armed: null,
        });
        setStatus('Loading…');
        render();
        try {
            const round = await api('AnimePipeline/Game/Round', { exclude: S.played.join(',') });
            if (!round || !round.episodes?.length) {
                setStatus('No watched episode the pipeline knows.');
                return;
            }
            S.round = round;
            S.played.push(round.seasonId);
            setStatus('');
            go(0);
        } catch (err) {
            setStatus(String(err.message || err));
        }
    }

    // --- Moving ---

    function go(i) {
        S.hover = null;
        if (i >= S.round.episodes.length) {
            S.reviewing = true;
            render();
            return;
        }
        S.reviewing = false;
        S.i = Math.max(0, i);
        const centre = $('tro-centre');
        centre.dataset.leaving = '';
        setTimeout(() => { delete centre.dataset.leaving; }, 120);
        render();
        // The next episode's stills, so they are there when it is.
        stillsFor(S.round.episodes[S.i + 1]);
        stillsFor(ep()).then(() => render());
    }

    function next() { go(S.i + 1); }

    function prev() {
        if (S.reviewing) { go(S.round.episodes.length - 1); return; }
        go(S.i - 1);
    }

    function keep() {
        const e = ep();
        if (!e) return;
        delete S.picks[e.id];
        S.kept[e.id] = true;
        next();
    }

    function pick(still) {
        const e = ep();
        if (!e) return;
        S.picks[e.id] = still;
        delete S.kept[e.id];
        delete S.errors[e.id];
        delete S.written[e.id];
        render();
        const at = S.i;
        setTimeout(() => { if (S.i === at && !S.reviewing) next(); }, ADVANCE_MS);
    }

    function clearPick() {
        const e = ep();
        if (!e) return;
        delete S.picks[e.id];
        delete S.kept[e.id];
        render();
    }

    // --- Writing ---

    function pending() {
        return (S.round?.episodes || []).filter((e) => S.picks[e.id]);
    }

    // First press arms, second acts, and the arming lapses on its own.
    function arm(key) {
        if (S.armed === key) { S.armed = null; return true; }
        S.armed = key;
        render();
        setTimeout(() => { if (S.armed === key) { S.armed = null; render(); } }, ARM_MS);
        return false;
    }

    // Unwritten picks are dropped by a new round, so that asks first.
    function again() {
        if (pending().length && !arm('again')) return;
        newRound();
    }

    async function write() {
        const todo = pending();
        if (!todo.length || S.writing) return;
        if (!arm('write')) return;
        S.writing = true;
        render();
        try {
            const results = await api('AnimePipeline/Game/Answers', null, {
                method: 'POST',
                body: JSON.stringify({ answers: todo.map((e) => ({ itemId: e.id, url: S.picks[e.id].url })) }),
            });
            for (const r of results || []) {
                if (r.ok) {
                    S.written[r.itemId] = true;
                    delete S.picks[r.itemId];
                } else {
                    S.errors[r.itemId] = r.error || 'Not written';
                }
            }
        } catch (err) {
            for (const e of todo) S.errors[e.id] = String(err.message || err);
        }
        S.writing = false;
        S.stamp = Date.now();
        render();
    }

    // --- Drawing ---

    function setStatus(text) {
        const el = $('tro-status');
        el.textContent = text;
        el.hidden = !text;
    }

    function stateOf(e) {
        if (S.errors[e.id]) return 'error';
        if (S.written[e.id]) return 'written';
        if (S.picks[e.id]) return 'picked';
        if (S.kept[e.id]) return 'kept';
        return '';
    }

    function renderDots() {
        const dots = $('tro-dots');
        dots.textContent = '';
        (S.round?.episodes || []).forEach((e, k) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'tro-dot';
            b.title = `${code(e)} · ${e.name || ''}${S.errors[e.id] ? ' — ' + S.errors[e.id] : ''}`;
            const st = stateOf(e);
            if (st) b.dataset.state = st;
            if (k === S.i && !S.reviewing) b.dataset.current = '';
            b.addEventListener('click', () => go(k));
            dots.appendChild(b);
        });
    }

    function renderEpisode() {
        const e = ep();
        $('tro-code').textContent = code(e);
        $('tro-name').textContent = e.name || '';

        const shown = S.hover || S.picks[e.id];
        $('tro-shown-img').src = shown ? stillUrl(shown) : currentUrl(e);
        $('tro-shown-label').textContent = shown ? stillLabel(shown) : 'Current';
        if (S.picks[e.id]) $('tro-shown').dataset.picked = '';
        else delete $('tro-shown').dataset.picked;

        const got = S.resolved[e.id];
        $('tro-note').textContent = S.errors[e.id]
            || (!got ? 'Fetching stills…' : (got.stills.length ? '' : (got.note || 'No stills')));

        const tiles = $('tro-tiles');
        tiles.textContent = '';
        const list = got?.stills || [];
        // Alternate right and left, each side spread over its own arc, so the
        // first still is nearest the middle-right and they fan out from there.
        const sides = [Math.ceil(list.length / 2), Math.floor(list.length / 2)];
        list.forEach((still, k) => {
            const right = k % 2 === 0;
            const n = sides[right ? 0 : 1];
            const at = Math.floor(k / 2);
            const t = n === 1 ? 0 : (at / (n - 1)) * 2 - 1;
            const deg = t * SIDE_ARC;
            const pos = place(right ? deg : 180 - deg);

            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'tro-tile';
            b.title = stillLabel(still);
            b.style.left = pos.left;
            b.style.top = pos.top;
            if (S.picks[e.id] === still) b.dataset.picked = '';
            b.innerHTML = '<img alt="" loading="lazy"><span class="tro-tile-num"></span><span class="tro-tile-provider"></span>';
            b.querySelector('img').src = stillUrl(still);
            b.querySelector('.tro-tile-num').textContent = String(k + 1);
            b.querySelector('.tro-tile-provider').textContent = still.provider || '';
            // On pointer MOVEMENT, not entry: after a step the next episode's
            // tiles are drawn under a pointer that has not moved, and the
            // middle should show that episode's own picture until it does.
            b.addEventListener('mousemove', () => {
                if (S.hover !== still) { S.hover = still; renderShown(); }
            });
            b.addEventListener('mouseleave', () => { S.hover = null; renderShown(); });
            b.addEventListener('click', () => pick(still));
            tiles.appendChild(b);
        });
    }

    // Just the middle picture, on hover, without rebuilding the tiles.
    function renderShown() {
        const e = ep();
        if (!e || S.reviewing) return;
        const shown = S.hover || S.picks[e.id];
        $('tro-shown-img').src = shown ? stillUrl(shown) : currentUrl(e);
        $('tro-shown-label').textContent = shown ? stillLabel(shown) : 'Current';
    }

    function renderReview() {
        const grid = $('tro-review-grid');
        grid.textContent = '';
        S.round.episodes.forEach((e, k) => {
            const st = stateOf(e);
            const still = S.picks[e.id];
            const card = document.createElement('button');
            card.type = 'button';
            card.className = 'tro-card';
            if (st) card.dataset.state = st;
            card.innerHTML = '<div class="tro-card-img"><img alt="" loading="lazy"></div>'
                + '<div class="tro-card-body"><div class="tro-card-title"></div><div class="tro-card-sub"></div></div>';
            card.querySelector('img').src = still ? stillUrl(still) : currentUrl(e);
            card.querySelector('.tro-card-title').textContent = `${code(e)} · ${e.name || ''}`;
            const sub = card.querySelector('.tro-card-sub');
            if (st) sub.dataset.state = st;
            sub.textContent = S.errors[e.id] ? S.errors[e.id]
                : S.written[e.id] ? 'Written'
                : still ? stillLabel(still)
                : 'Current';
            card.addEventListener('click', () => go(k));
            grid.appendChild(card);
        });
    }

    function render() {
        const r = S.round;
        $('tro-series').textContent = r?.seriesName || '';
        $('tro-season').textContent = r?.seasonName || '';
        $('tro-count').textContent = r ? `${S.reviewing ? r.episodes.length : S.i + 1}/${r.episodes.length}` : '';
        renderDots();

        $('tro-stage').hidden = !r || S.reviewing;
        $('tro-review').hidden = !r || !S.reviewing;
        if (r && !S.reviewing) renderEpisode();
        if (r && S.reviewing) renderReview();

        const e = ep();
        $('tro-footer').hidden = !r;
        $('tro-prev').disabled = !r || (!S.reviewing && S.i === 0);
        $('tro-clear').hidden = !r || S.reviewing || !(e && S.picks[e.id]);
        $('tro-keep').hidden = !r || S.reviewing;
        $('tro-next').hidden = !r || S.reviewing;

        const n = pending().length;
        const w = $('tro-write');
        w.hidden = !r || !S.reviewing;
        w.disabled = !n || S.writing;
        w.textContent = S.writing ? 'Writing…' : S.armed === 'write' ? `Write ${n}?` : `Write ${n}`;
        if (S.armed === 'write') w.dataset.armed = '';
        else delete w.dataset.armed;
        const a = $('tro-again');
        a.hidden = !r || !S.reviewing || S.writing;
        a.textContent = S.armed === 'again' ? `Drop ${n} picks?` : 'Next season';
        if (S.armed === 'again') a.dataset.armed = '';
        else delete a.dataset.armed;
    }

    // --- Keys: only while this page is the one on screen ---

    function visible() {
        const app = document.querySelector('.tro-app');
        return !!(app && app.offsetParent !== null);
    }

    function onKey(e) {
        if (!S.round || !visible() || e.ctrlKey || e.metaKey || e.altKey) return;
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        const k = e.key;
        if (k === 'ArrowRight') { e.preventDefault(); if (!S.reviewing) next(); return; }
        if (k === 'ArrowLeft') { e.preventDefault(); prev(); return; }
        if (S.reviewing) return;
        if (k === ' ') { e.preventDefault(); keep(); return; }
        if (k === 'Backspace') { e.preventDefault(); clearPick(); return; }
        if (/^[1-9]$/.test(k)) {
            const still = S.resolved[ep()?.id]?.stills?.[Number(k) - 1];
            if (still) { e.preventDefault(); pick(still); }
        }
    }

    function init() {
        if (!client()?.getUrl || !client().accessToken?.()) {
            setTimeout(init, 200);
            return;
        }
        $('tro-prev').addEventListener('click', prev);
        $('tro-next').addEventListener('click', next);
        $('tro-keep').addEventListener('click', keep);
        $('tro-clear').addEventListener('click', clearPick);
        $('tro-write').addEventListener('click', write);
        $('tro-again').addEventListener('click', again);
        document.addEventListener('keydown', onKey);
        LOG('Ready');
        newRound();
    }

    init();
})();
