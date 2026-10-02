// KefinTweaks Thumbnail Round (FORK-ONLY)
//
// A season the player has watched some of, drawn at random by the AnimePipeline
// plugin, one watched episode at a time: its title in the middle over the
// picture it has now, the providers' stills on two arcs either side. A pick is
// staged; after the last episode every pick is shown on its episode, and Submit
// sends the picks and the keeps back together. The pipeline remembers every
// episode decided on, here or in its viewer, and those are not drawn again.
//
// The writes go to the plugin, which files each still with the pipeline and
// places it from there. A picture saved straight onto an episode would be put
// back by the pipeline's archive guard, so nothing here touches an item's
// images itself.

(function () {
    'use strict';

    const LOG = (...args) => console.log('[KefinTweaks ThumbRound]', ...args);

    // The middle and the stills are sized from the stage, not fixed: the
    // middle as large as the height allows up to a share of the width, and
    // the stills either side as large as fits. A side with many stills splits
    // into two or three columns when that gives bigger tiles than one tall
    // one; a single column is bowed outward so it wraps around the middle.
    const CENTRE_MAX_SHARE = 0.46;  // the middle's width at most, as a share of the stage
    const CENTRE_ALONE_SHARE = 0.6; // the same, for an episode with no stills
    const PICTURE_MAX_HEIGHT = 0.6; // its picture at most this share of the stage's height
    const SIDE_MARGIN = 24;         // px between the middle, the tiles and the edges
    const TILE_GAP = 14;            // px between tiles
    const TILE_MAX_HEIGHT = 0.32;   // a lone still is at most this share of the stage's height
    const MAX_SIDE_COLUMNS = 3;
    const STAGE_MIN_HEIGHT = 416;   // px
    const STAGE_BOTTOM_ROOM = 28;   // px under the footer
    const CARD_MAX_SHARE = 0.4;     // a review card at most this share of the width
    // How long a pick stays on screen before the round moves on.
    const ADVANCE_MS = 260;
    // How long an armed button waits for its second press.
    const ARM_MS = 4000;

    const $ = (id) => document.getElementById(id);

    const S = {
        intro: true,    // the start screen is up
        round: null,
        i: 0,
        reviewing: false,
        hover: null,
        picks: {},      // itemId -> still
        kept: {},       // itemId -> true
        written: {},    // itemId -> true: a pick, filed and placed
        recorded: {},   // itemId -> true: a keep, recorded as reviewed
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

    // A plain <img>, so the token rides the query string. The preview unless
    // asked for the original: TheMovieDB's original can be 4K, and a round of
    // those held the browser's few connections to the server long enough that
    // the episode's own picture, queued behind them, never arrived.
    function stillUrl(still, full) {
        const url = full ? still.url : (still.preview_url || still.url);
        return client().getUrl('AnimePipeline/Game/Still', { url, ApiKey: client().accessToken() });
    }

    // The middle picture: the preview at once, the original once it is in --
    // and only if the middle is still showing that still by then.
    function showInMiddle(still) {
        const img = $('tro-shown-img');
        if (!still) {
            img.src = currentUrl(ep());
            return;
        }
        img.src = stillUrl(still);
        const full = stillUrl(still, true);
        if (full === img.src) return;
        const loader = new Image();
        loader.onload = () => {
            if ((S.hover || S.picks[ep()?.id]) === still) img.src = full;
        };
        loader.src = full;
    }

    // The plot as Jellyfin holds it: HTML, with <details> spoilers that stay
    // closed until clicked, as they do on the episode page. Anything that could
    // run is taken out first.
    function setPlot(el, html) {
        const t = document.createElement('template');
        t.innerHTML = html || '';
        t.content.querySelectorAll('script, style, iframe, object, embed, link').forEach((n) => n.remove());
        t.content.querySelectorAll('*').forEach((n) => {
            for (const a of [...n.attributes]) {
                if (/^on/i.test(a.name) || /^\s*javascript:/i.test(a.value)) n.removeAttribute(a.name);
            }
        });
        el.replaceChildren(t.content);
        el.scrollTop = 0;
    }

    function stillLabel(still) {
        const size = still.width && still.height ? ` · ${still.width}×${still.height}` : '';
        return (still.provider || 'Still') + size;
    }

    // The middle's width, and every tile's position and size, from the stage
    // as it is now. Right takes the odd numbers and left the even, row by row
    // from the top, so 1 is nearest the top right. A phone lays it all out in
    // CSS instead.
    function layoutTiles() {
        const stage = $('tro-stage');
        const centre = $('tro-centre');
        const tiles = [...$('tro-tiles').children];
        if (stage.hidden || window.matchMedia('(max-width: 700px)').matches) {
            stage.style.height = '';
            centre.style.width = '';
            tiles.forEach((t) => { t.style.left = t.style.top = t.style.width = ''; });
            return;
        }
        // The stage takes what is left of the window under the header and
        // above the footer, which both scale with the window's text.
        const top = stage.getBoundingClientRect().top + window.scrollY;
        const below = $('tro-footer').offsetHeight + STAGE_BOTTOM_ROOM;
        stage.style.height = `${Math.max(STAGE_MIN_HEIGHT, window.innerHeight - top - below)}px`;
        const W = stage.clientWidth;
        const H = stage.clientHeight;
        const share = tiles.length ? CENTRE_MAX_SHARE : CENTRE_ALONE_SHARE;
        const centreW = Math.min(W * share, H * PICTURE_MAX_HEIGHT * 16 / 9);
        centre.style.width = `${centreW}px`;
        if (!tiles.length) return;

        const side = (W - centreW) / 2 - SIDE_MARGIN * 2;
        const counts = [Math.ceil(tiles.length / 2), Math.floor(tiles.length / 2)];
        // The column count that gives the larger side its biggest tiles; the
        // other side uses the same size so the two match.
        let w = 0;
        let cols = 1;
        for (let c = 1; c <= MAX_SIDE_COLUMNS; c++) {
            const rows = Math.ceil(counts[0] / c);
            const byHeight = ((H * 0.96 - TILE_GAP * (rows - 1)) / rows) * 16 / 9;
            const byWidth = (side - TILE_GAP * (c - 1)) / c;
            const fit = Math.min(byHeight, byWidth, H * TILE_MAX_HEIGHT * 16 / 9);
            if (fit > w + 1) { w = fit; cols = c; }
        }
        w = Math.max(80, w);
        const h = w * 9 / 16;
        const sideCentre = centreW / 2 + SIDE_MARGIN + side / 2;     // from the stage's middle
        tiles.forEach((t, k) => {
            const right = k % 2 === 0;
            const n = counts[right ? 0 : 1];
            const at = Math.floor(k / 2);
            const c = Math.min(cols, n);
            const rows = Math.ceil(n / c);
            const row = Math.floor(at / c);
            const col = at % c;
            const gridW = c * w + (c - 1) * TILE_GAP;
            const gridH = rows * h + (rows - 1) * TILE_GAP;
            let dx = sideCentre - gridW / 2 + col * (w + TILE_GAP) + w / 2;
            // A single column bows: its middle sits furthest out and its ends
            // come back in, never past the column's own share of the side.
            if (c === 1 && n > 1) {
                const u = (at / (n - 1)) * 2 - 1;
                dx += ((side - w) / 2) * (1 - u * u);
            }
            t.style.width = `${w}px`;
            t.style.left = `${W / 2 + (right ? dx : -dx)}px`;
            t.style.top = `${(H - gridH) / 2 + row * (h + TILE_GAP) + h / 2}px`;
        });
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
            written: {}, recorded: {}, errors: {}, stills: {}, resolved: {}, armed: null,
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

    // Everything decided and not yet sent: the picks, and the keeps -- a keep
    // is a review too, and is what stops the episode coming up again.
    function pending() {
        return (S.round?.episodes || []).filter((e) => S.picks[e.id] || (S.kept[e.id] && !S.recorded[e.id]));
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
        const picked = todo.filter((e) => S.picks[e.id]);
        const kept = todo.filter((e) => !S.picks[e.id]);
        try {
            const results = await api('AnimePipeline/Game/Answers', null, {
                method: 'POST',
                body: JSON.stringify({
                    answers: picked.map((e) => ({ itemId: e.id, url: S.picks[e.id].url })),
                    kept: kept.map((e) => e.id),
                }),
            });
            for (const r of results || []) {
                if (r.ok && S.picks[r.itemId]) {
                    S.written[r.itemId] = true;
                    delete S.picks[r.itemId];
                } else if (r.ok) {
                    S.recorded[r.itemId] = true;
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

    function start() {
        S.intro = false;
        if (S.round) render();
        else newRound();
    }

    function showRules() {
        S.intro = true;
        S.hover = null;
        setStatus('');
        render();
        window.scrollTo(0, 0);
    }

    function setStatus(text) {
        const el = $('tro-status');
        el.textContent = text;
        el.hidden = !text;
    }

    function stateOf(e) {
        if (S.errors[e.id]) return 'error';
        if (S.written[e.id] || S.recorded[e.id]) return 'written';
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
        if ($('tro-plot').dataset.for !== e.id) {
            setPlot($('tro-plot'), e.overview);
            $('tro-plot').dataset.for = e.id;
        }

        const shown = S.hover || S.picks[e.id];
        showInMiddle(shown);
        $('tro-shown-label').textContent = shown ? stillLabel(shown) : 'Current';
        if (S.picks[e.id]) $('tro-shown').dataset.picked = '';
        else delete $('tro-shown').dataset.picked;

        const got = S.resolved[e.id];
        $('tro-note').textContent = S.errors[e.id]
            || (!got ? 'Fetching stills…' : (got.stills.length ? '' : (got.note || 'No stills')));

        const tiles = $('tro-tiles');
        tiles.textContent = '';
        const list = got?.stills || [];
        list.forEach((still, k) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'tro-tile';
            b.title = stillLabel(still);
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
        layoutTiles();
    }

    // Just the middle picture, on hover, without rebuilding the tiles.
    function renderShown() {
        const e = ep();
        if (!e || S.reviewing) return;
        const shown = S.hover || S.picks[e.id];
        showInMiddle(shown);
        $('tro-shown-label').textContent = shown ? stillLabel(shown) : 'Current';
    }

    // The review's cards: the column count that makes them largest while the
    // whole season fits above the footer.
    function layoutReview() {
        const grid = $('tro-review-grid');
        const cards = [...grid.children];
        if (!cards.length || $('tro-review').hidden || window.matchMedia('(max-width: 700px)').matches) {
            grid.style.gridTemplateColumns = '';
            return;
        }
        const gap = parseFloat(getComputedStyle(grid).columnGap) || 16;
        const body = cards[0].querySelector('.tro-card-body').offsetHeight;
        const W = grid.clientWidth;
        const H = window.innerHeight - (grid.getBoundingClientRect().top + window.scrollY)
            - $('tro-footer').offsetHeight - STAGE_BOTTOM_ROOM - 12;
        const n = cards.length;
        let best = 0;
        let cols = 1;
        for (let c = 1; c <= n; c++) {
            const rows = Math.ceil(n / c);
            const byWidth = (W - gap * (c - 1)) / c;
            const byHeight = ((H - gap * (rows - 1)) / rows - body) * 16 / 9;
            const w = Math.min(byWidth, byHeight, W * CARD_MAX_SHARE);
            if (w > best + 1) { best = w; cols = c; }
        }
        grid.style.gridTemplateColumns = `repeat(${cols}, ${Math.max(160, best)}px)`;
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
                : S.recorded[e.id] ? 'Kept'
                : still ? stillLabel(still)
                : 'Current';
            card.addEventListener('click', () => go(k));
            grid.appendChild(card);
        });
        layoutReview();
    }

    function render() {
        $('tro-intro').hidden = !S.intro;
        $('tro-rules').hidden = S.intro;
        $('tro-start').textContent = S.round ? 'Back to the round' : 'Start';
        if (S.intro) {
            $('tro-stage').hidden = true;
            $('tro-review').hidden = true;
            $('tro-footer').hidden = true;
            $('tro-dots').hidden = true;
            $('tro-count').hidden = true;
            return;
        }
        $('tro-dots').hidden = false;
        $('tro-count').hidden = false;

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
        w.textContent = S.writing ? 'Submitting…' : S.armed === 'write' ? `Submit ${n}?` : `Submit ${n}`;
        if (S.armed === 'write') w.dataset.armed = '';
        else delete w.dataset.armed;
        const a = $('tro-again');
        a.hidden = !r || !S.reviewing || S.writing;
        a.textContent = S.armed === 'again' ? `Drop ${n} unsubmitted?` : 'Next season';
        if (S.armed === 'again') a.dataset.armed = '';
        else delete a.dataset.armed;
    }

    // --- Keys: only while this page is the one on screen ---

    function visible() {
        const app = document.querySelector('.tro-app');
        return !!(app && app.offsetParent !== null);
    }

    function onKey(e) {
        if (S.intro || !S.round || !visible() || e.ctrlKey || e.metaKey || e.altKey) return;
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
        $('tro-start').addEventListener('click', start);
        $('tro-rules').addEventListener('click', showRules);
        document.addEventListener('keydown', onKey);
        window.addEventListener('resize', () => { if (visible()) { layoutTiles(); layoutReview(); } });
        LOG('Ready');
        render();
    }

    init();
})();
