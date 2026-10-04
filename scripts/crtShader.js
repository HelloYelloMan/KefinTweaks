// KefinTweaks CRT Shader
// Runs your mpv retro CRT chain over the web player's video, toggled from a
// button on the video OSD.
//
// ===========================================================================
//  WHAT RUNS
// ===========================================================================
// The mpv files themselves. scripts/crt/ holds byte-for-byte copies of
// ~/.config/mpv/retro.conf and ~/.config/mpv/shaders/retro/*.glsl (refreshed
// by tools/sync-crt-shaders.sh; .txt only because Jellyfin 404s unknown
// extensions). retro.conf supplies the profile: its glsl-shaders list and
// glsl-shader-opts are read at runtime, so a retune in mpv carries over with
// nothing edited here.
//
// To run them, this file is a small reimplementation of the part of
// libplacebo that executes mpv user shaders (src/shaders/custom_mpv.c),
// written against its source rather than the mpv manual:
//
//   - the //! block format: PARAM, TEXTURE (hex payload), HOOK with BIND,
//     SAVE, WIDTH/HEIGHT/WHEN as RPN size expressions (same operators,
//     same lookups: HOOKED, OUTPUT, NATIVE_CROPPED, saved textures, params);
//   - the macros a pass sees: NAME_raw/_pos/_size/_pt/_off/_mul/_rot/_tex/
//     _texOff, HOOKED_* and MAIN_* aliases, frame, random, input_size,
//     target_size, tex_offset;
//   - parameter modes: DYNAMIC and plain become uniforms, CONSTANT becomes a
//     literal, DEFINE a #define;
//   - texture namespaces PER FILE, as in mpv: a SAVE in one glsl-shaders
//     entry is invisible to the next, and only MAIN flows between files;
//   - `frame` advanced once per EXECUTED PASS, per file -- crt-royale-super
//     divides it by its own pass count (royale_true_frame), so this has to
//     be exact, not "one per frame";
//   - linearize()/delinearize() as libplacebo emits them for an SDR BT.1886
//     source: 1000:1 contrast, so black sits at 0.001, not 0;
//   - intermediate textures RGBA16F, sampled bilinear with clamp.
//
// Two things WebGL2 does not have, emulated:
//   - STORAGE textures (imageLoad/imageStore). Both users -- the EHT sag
//     meter (PSU_STATE) and phosphor persistence (PHOSPHOR) -- read and write
//     only the texel they are shading, so a ping-pong pair and a second
//     render target reproduce them exactly. Sized to the pass output rather
//     than the declared SIZE, for the same reason.
//   - dithering to the display. mpv dithers (retro-base sets dither=fruit);
//     the canvas is 8-bit, so the last blit adds an ordered-noise dither.
//
// ===========================================================================
//  WHEN IT RUNS -- the field clock
// ===========================================================================
// mpv feeds the chain one field per 59.94 Hz frame (vf=fps=60000/1001) and
// then uses video-sync=display-resample to lock that to the refresh: at
// 240 Hz, exactly four refreshes per field. A browser cannot resample its
// output clock, so the first version derived the field from wall time; with
// 240/59.94 = 4.004 refreshes per field, one field in every ~250 then lasted
// five refreshes -- a visible hitch in the interlace bob every few seconds.
//
// The field clock here counts REFRESHES instead (rAF timestamps, measured
// period, dropped frames counted by rounding) and, when the refresh rate is
// within 1% of a whole multiple of 59.94, advances the field every N
// refreshes exactly -- 60.000 fields/s on a 240 Hz panel, the same trade
// display-resample makes. Off a multiple (144 Hz, 165 Hz) there is no even
// cadence to lock to and it falls back to time.
//
// MAIN-stage passes run once per field, on the newest video frame -- a frame
// that arrives mid-field waits for the next one, as it does behind mpv's fps
// filter. OUTPUT-stage passes (phosphor persistence, when enabled) run on
// every refresh, as libplacebo runs them after interpolation.
//
// ===========================================================================
//  LAYERING
// ===========================================================================
// The canvas sits directly after the <video>, absolutely positioned over the
// picture (letterbox excluded), opaque, with pointer-events off: clicks reach
// the video; subtitle elements added later (custom, libass, PGS) stay on top.
// Native <track> cues are drawn by the video element itself, so they end up
// under the canvas.
//
// CRT is OFF on every page load: on/off lives only in this page's memory,
// so a refresh always starts disabled (it does carry from one video to the
// next within the page). Engine and subtitle mode are per browser (localStorage).
// Console: KefinTweaksCrt.status(), .setProfile(name), .setEngine('mpv'|'fused').

(function () {
    'use strict';

    const LOG  = (...args) => console.log('[KefinTweaks CRT]', ...args);
    const WARN = (...args) => console.warn('[KefinTweaks CRT]', ...args);
    const ERR  = (...args) => console.error('[KefinTweaks CRT]', ...args);

    const STORAGE_KEY = 'kefinTweaks_crtShader';
    const PROFILE_KEY = 'kefinTweaks_crtProfile';
    const ENGINE_KEY  = 'kefinTweaks_crtEngine';
    const SUBTITLE_MODE_KEY = 'kefinTweaks_crtSubtitles';
    const CRT_DIR     = 'scripts/crt/';
    const CONF_FILE   = 'retro.conf.txt';
    const FUSED_FILE  = 'crt-royale-hypr.frag.txt';
    const DEFAULT_PROFILE = 'retro-super';
    const DEFAULT_ENGINE  = 'mpv';
    const FIELD_RATE  = 60000 / 1001;
    const BUTTON_CLASS = 'btnKefinCrt';

    // ======================================================================
    //  PREFERENCES
    // ======================================================================

    function readPref(key, fallback) {
        try { return localStorage.getItem(key) ?? fallback; } catch (e) { return fallback; }
    }

    function writePref(key, value) {
        try { localStorage.setItem(key, value); } catch (e) { /* private window */ }
    }

    // Never restored: every page load starts with CRT off. The key earlier
    // versions stored is removed so nothing stale lingers.
    let enabled = false;
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* private window */ }
    let profileName = readPref(PROFILE_KEY, DEFAULT_PROFILE);
    let engineName = readPref(ENGINE_KEY, DEFAULT_ENGINE);
    // 'burn': the server burns them in (the default). 'composite': Jellyfin
    // renders subtitles as usual and they are blended into the frame before
    // the chain. Compositing read as choppier line changes on 2026-10-03, so
    // burn-in is the default while the two are compared.
    let subtitleMode = readPref(SUBTITLE_MODE_KEY, 'burn') === 'composite' ? 'composite' : 'burn';

    function notify(message) {
        window.KefinTweaksToaster?.toast?.(message);
    }

    function getRoot() {
        const cfg = window.KefinTweaksConfig || {};
        const raw = cfg.kefinTweaksRootResolved || cfg.kefinTweaksRoot || '';
        if (!raw) return null;
        return raw.endsWith('/') ? raw : `${raw}/`;
    }

    const textCache = new Map();
    function fetchText(path) {
        if (!textCache.has(path)) {
            const root = getRoot();
            if (!root) return Promise.reject(new Error('kefinTweaksRoot is not set'));
            const p = fetch(root + path, { cache: 'no-cache' }).then((res) => {
                if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
                return res.text();
            });
            p.catch(() => textCache.delete(path));
            textCache.set(path, p);
        }
        return textCache.get(path);
    }

    // ======================================================================
    //  FIELD CLOCK
    // ======================================================================

    function createFieldClock() {
        const MEASURE = 240;       // deltas to measure (~1 s at 240 Hz)
        let lastNow = 0;
        let t0 = 0;
        let period = 0;            // refresh period, ms (tracked after the lock)
        let lockN = 0;             // refreshes per field, 0 = timed fallback
        let samples = [];
        let refreshes = 0;         // refreshes counted since the lock
        let timedMs = 0;           // same, as time, for the timed fallback
        let fieldBase = 0;         // field index at the lock
        let lastField = 0;
        let fastRun = 0;           // consecutive frames well under the period

        function startMeasuring(now) {
            period = 0;
            lockN = 0;
            samples = [];
            fieldBase = lastField + 1;
            t0 = now;
        }

        return {
            get periodMs() { return period; },
            get locked() { return lockN; },
            reset(now) {
                lastNow = now;
                lastField = -1;
                fastRun = 0;
                startMeasuring(now);
            },
            // Called once per rAF; returns the field index for this refresh.
            tick(now) {
                const d = now - lastNow;
                lastNow = now;

                if (!period) {
                    // Measuring: plain time meanwhile.
                    if (d > 0 && d < 100) samples.push(d);
                    if (samples.length >= MEASURE) {
                        // Total time over refreshes counted, not a typical
                        // interval: Firefox and Zen round rAF timestamps to
                        // whole milliseconds, so at 240 Hz every interval
                        // reads 4 or 5 ms and the median says 250 Hz. The
                        // median only sizes a refresh for counting (so a
                        // dropped frame counts as two); the period is the
                        // elapsed time over that count, where the rounding
                        // averages out.
                        const sorted = samples.slice().sort((a, b) => a - b);
                        const rough = sorted[sorted.length >> 1];
                        let total = 0, count = 0;
                        for (const s of samples) {
                            total += s;
                            count += Math.max(1, Math.round(s / rough));
                        }
                        period = total / count;
                        const ratio = (1000 / period) / FIELD_RATE;
                        const n = Math.round(ratio);
                        lockN = n >= 1 && Math.abs(ratio - n) < 0.015 * n ? n : 0;
                        refreshes = 0;
                        timedMs = 0;
                        fieldBase = lastField + 1;
                        LOG(`Refresh ${(1000 / period).toFixed(2)} Hz; fields `
                            + (lockN ? `locked to every ${lockN} refreshes` : 'timed (not a whole multiple of 59.94)'));
                    }
                    lastField = fieldBase + Math.floor((now - t0) / 1000 * FIELD_RATE);
                    return lastField;
                }

                // A run of frames much shorter than the period means the
                // refresh rate went UP (window moved to a faster monitor):
                // rounding would count each as one long refresh. Re-measure.
                if (d < 0.6 * period) {
                    if (++fastRun > 10) {
                        fastRun = 0;
                        startMeasuring(now);
                        return lastField;
                    }
                } else {
                    fastRun = 0;
                }

                // Whole refreshes since the last rAF, so a dropped frame still
                // counts. Rounding absorbs timestamp jitter.
                const steps = Math.max(1, Math.round(d / period));
                refreshes += steps;
                timedMs += steps * period;
                // Drift is tracked from single-refresh steps only, with no
                // tighter gate: with Firefox's whole-millisecond timestamps a
                // 4.165 ms refresh reads as 4 or 5, and gating out the 5s as
                // outliers would walk the estimate down to 4.000 (250 Hz).
                if (steps === 1) period += (d - period) * 0.005;

                lastField = fieldBase + (lockN ? Math.floor(refreshes / lockN)
                                               : Math.floor(timedMs / 1000 * FIELD_RATE));
                return lastField;
            }
        };
    }

    // ======================================================================
    //  GL HELPERS
    // ======================================================================

    // Full-screen triangle from gl_VertexID. kt_pos runs 0..1 with y = 0 at
    // gl_FragCoord.y = 0 -- in our render targets that row is the TOP of the
    // picture (the video is uploaded without a flip), which is libplacebo's
    // own orientation, so shaders that read gl_FragCoord see what they see
    // in mpv. Only the final blit to the canvas flips.
    const VS_PASS = `#version 300 es
out vec2 kt_pos;
void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    kt_pos = p;
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

    const VS_PRESENT = `#version 300 es
out vec2 kt_pos;
void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    kt_pos = vec2(p.x, 1.0 - p.y);
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

    // Last step to the 8-bit canvas: flip, clamp, dither. The noise is
    // interleaved gradient noise, static per pixel like mpv's fruit.
    const FS_PRESENT = `#version 300 es
precision highp float;
in vec2 kt_pos;
uniform sampler2D kt_src;
out vec4 kt_out;
float kt_ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
    vec3 c = textureLod(kt_src, kt_pos, 0.0).rgb;
    c += (kt_ign(gl_FragCoord.xy) - 0.5) / 255.0;
    kt_out = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

    // Plain bilinear copy, for the rare chain whose MAIN does not end at the
    // output size: mpv would scale it there before the OUTPUT stage.
    const FS_COPY = `#version 300 es
precision highp float;
in vec2 kt_pos;
uniform sampler2D kt_src;
out vec4 kt_out;
void main() { kt_out = textureLod(kt_src, kt_pos, 0.0); }`;

    function compile(gl, type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        return shader;
    }

    // Starts compiling and linking WITHOUT waiting. Status is read in
    // finishPrograms(), after KHR_parallel_shader_compile says the driver is
    // done, because reading it earlier is what blocks the main thread.
    function startProgram(gl, vsSource, fsSource, label) {
        const vs = compile(gl, gl.VERTEX_SHADER, vsSource);
        const fs = compile(gl, gl.FRAGMENT_SHADER, fsSource);
        const program = gl.createProgram();
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        return { program, vs, fs, label, fsSource };
    }

    async function finishPrograms(gl, pending) {
        const ext = gl.getExtension('KHR_parallel_shader_compile');
        if (ext) {
            await new Promise((resolve) => {
                const poll = () => {
                    if (gl.isContextLost()) { resolve(); return; }
                    if (pending.every((p) => gl.getProgramParameter(p.program, ext.COMPLETION_STATUS_KHR))) resolve();
                    else setTimeout(poll, 30);
                };
                poll();
            });
        }
        if (gl.isContextLost()) throw new Error('WebGL context lost while compiling');
        for (const p of pending) {
            if (!gl.getProgramParameter(p.program, gl.LINK_STATUS)) {
                const log = gl.getShaderInfoLog(p.fs) || gl.getShaderInfoLog(p.vs) || gl.getProgramInfoLog(p.program) || 'unknown error';
                const err = new Error(`${p.label}: ${log.trim().split('\n').slice(0, 12).join('\n')}`);
                err.fsSource = p.fsSource;
                throw err;
            }
            gl.deleteShader(p.vs);
            gl.deleteShader(p.fs);
        }
        return pending.map((p) => p.program);
    }

    function makeTexture(gl, filter, wrap) {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
        return tex;
    }

    // A render target that reallocates itself when the size changes.
    function createTarget(gl, filter) {
        const t = { tex: null, fbo: gl.createFramebuffer(), w: 0, h: 0 };
        t.ensure = (w, h) => {
            if (t.tex && t.w === w && t.h === h) return;
            if (t.tex) gl.deleteTexture(t.tex);
            t.tex = makeTexture(gl, filter, gl.CLAMP_TO_EDGE);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
            t.w = w;
            t.h = h;
        };
        return t;
    }

    // ======================================================================
    //  retro.conf
    // ======================================================================

    // Reads the mpv profiles the way mpv would for these keys: glsl-shaders
    // as a ':' list of paths (basename kept), glsl-shader-opts as a ','
    // list, and the -append forms adding one entry each.
    function parseRetroConf(text) {
        const profiles = {};
        let cur = null;
        const parseOpt = (pair, into) => {
            const eq = pair.indexOf('=');
            if (eq > 0) into[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
        };
        for (const raw of text.split('\n')) {
            const line = raw.replace(/#.*$/, '').trim();
            if (!line) continue;
            const section = /^\[(.+)\]$/.exec(line);
            if (section) {
                cur = profiles[section[1]] = { shaders: null, opts: {} };
                continue;
            }
            if (!cur) continue;
            const eq = line.indexOf('=');
            if (eq < 0) continue;
            const key = line.slice(0, eq).trim();
            const val = line.slice(eq + 1).trim();
            const base = (p) => p.split('/').pop();
            if (key === 'glsl-shaders') cur.shaders = val ? val.split(':').map(base).filter(Boolean) : [];
            else if (key === 'glsl-shaders-append') (cur.shaders = cur.shaders || []).push(base(val));
            else if (key === 'glsl-shader-opts') { cur.opts = {}; val.split(',').forEach((p) => parseOpt(p, cur.opts)); }
            else if (key === 'glsl-shader-opts-append') parseOpt(val, cur.opts);
        }
        return profiles;
    }

    // ======================================================================
    //  mpv USER SHADER PARSER  (libplacebo custom_mpv.c)
    // ======================================================================

    function parseRpn(line) {
        const out = [];
        for (const word of line.split(' ')) {
            if (!word) continue;
            let m;
            if ((m = /^(.*)\.(w|width)$/.exec(word))) { out.push({ t: 'texw', name: m[1] }); continue; }
            if ((m = /^(.*)\.(h|height)$/.exec(word))) { out.push({ t: 'texh', name: m[1] }); continue; }
            // As in libplacebo, an operator is recognised by its FIRST
            // character -- so "-1" is the minus operator, not a number.
            if ('+-*/%><='.includes(word[0])) { out.push({ t: 'op2', op: word[0] }); continue; }
            if (word[0] === '!') { out.push({ t: 'not' }); continue; }
            if (word[0] >= '0' && word[0] <= '9') { out.push({ t: 'num', v: parseFloat(word) }); continue; }
            out.push({ t: 'var', name: word });
        }
        return out;
    }

    function evalRpn(expr, lookupTex, lookupVar) {
        const stack = [];
        for (const e of expr) {
            switch (e.t) {
                case 'num': stack.push(e.v); break;
                case 'not': stack.push(stack.pop() ? 0 : 1); break;
                case 'texw':
                case 'texh': {
                    const size = lookupTex(e.name);
                    if (!size) return null;
                    stack.push(e.t === 'texw' ? size[0] : size[1]);
                    break;
                }
                case 'var': {
                    const v = lookupVar(e.name);
                    if (v === undefined) return null;
                    stack.push(v);
                    break;
                }
                case 'op2': {
                    const b = stack.pop();
                    const a = stack.pop();
                    let r;
                    switch (e.op) {
                        case '+': r = a + b; break;
                        case '-': r = a - b; break;
                        case '*': r = a * b; break;
                        case '/': r = a / b; break;
                        case '%': r = a % b; break;
                        case '>': r = a > b ? 1 : 0; break;
                        case '<': r = a < b ? 1 : 0; break;
                        case '=': r = Math.abs(a - b) <= 1e-6 * Math.max(a, b) ? 1 : 0; break;
                    }
                    if (!Number.isFinite(r)) return null;
                    stack.push(r);
                    break;
                }
            }
        }
        return stack.length === 1 ? stack[0] : null;
    }

    // Splits a file into blocks exactly as split_magic() does: a block's
    // headers are the consecutive "//!" lines it starts with, and its body
    // runs up to the next "//!" anywhere.
    function parseHookFile(text, fileName) {
        const file = { name: fileName, params: [], textures: [], passes: [] };
        let pos = text.indexOf('//!');
        if (pos < 0) throw new Error(`${fileName}: no //! headers`);
        let line = 1 + countNewlines(text, 0, pos);

        while (pos < text.length) {
            const headers = [];
            while (pos < text.length) {
                const nl = text.indexOf('\n', pos);
                const end = nl < 0 ? text.length : nl;
                const l = text.slice(pos, end).trim();
                if (!l.startsWith('//!')) break;
                headers.push(l.slice(3).trim());
                pos = end + 1;
                line++;
            }
            let next = text.indexOf('//!', pos);
            if (next < 0) next = text.length;
            const body = text.slice(pos, next);
            const bodyLine = line;
            line += countNewlines(text, pos, next);
            pos = next;

            const kind = headers[0].split(/\s+/)[0];
            if (kind === 'PARAM') file.params.push(parseParam(headers, body, fileName));
            else if (kind === 'TEXTURE') file.textures.push(parseTexture(headers, body, fileName));
            else if (kind === 'BUFFER') throw new Error(`${fileName}: //!BUFFER is not supported`);
            else file.passes.push(parsePass(headers, body, bodyLine, fileName));
        }
        return file;
    }

    function countNewlines(text, from, to) {
        let n = 0;
        for (let i = text.indexOf('\n', from); i >= 0 && i < to; i = text.indexOf('\n', i + 1)) n++;
        return n;
    }

    function parseParam(headers, body, fileName) {
        const p = { name: null, mode: 'variable', type: 'float', value: 0 };
        for (const h of headers) {
            const [cmd, ...rest] = h.split(/\s+/);
            if (cmd === 'PARAM') p.name = rest[0];
            else if (cmd === 'TYPE') {
                for (const word of rest) {
                    if (word === 'DYNAMIC') p.mode = 'dynamic';
                    else if (word === 'CONSTANT') p.mode = 'constant';
                    else if (word === 'DEFINE') { p.mode = 'define'; p.type = 'int'; }
                    else if (word === 'ENUM') p.mode = 'enum';
                    else p.type = word;
                }
            }
        }
        if (p.mode === 'enum') throw new Error(`${fileName}: ENUM param ${p.name} is not supported`);
        p.value = parseFloat(body.trim());
        if (!Number.isFinite(p.value)) throw new Error(`${fileName}: param ${p.name} has no default`);
        return p;
    }

    const TEXTURE_FORMATS = {
        r8:      ['R8', 'RED', 'UNSIGNED_BYTE', 1, Uint8Array],
        rg8:     ['RG8', 'RG', 'UNSIGNED_BYTE', 2, Uint8Array],
        rgba8:   ['RGBA8', 'RGBA', 'UNSIGNED_BYTE', 4, Uint8Array],
        r16f:    ['R16F', 'RED', 'HALF_FLOAT', 1, Uint16Array],
        rg16f:   ['RG16F', 'RG', 'HALF_FLOAT', 2, Uint16Array],
        rgba16f: ['RGBA16F', 'RGBA', 'HALF_FLOAT', 4, Uint16Array],
        rgba16hf:['RGBA16F', 'RGBA', 'HALF_FLOAT', 4, Uint16Array],
        r32f:    ['R32F', 'RED', 'FLOAT', 1, Float32Array],
        rgba32f: ['RGBA32F', 'RGBA', 'FLOAT', 4, Float32Array]
    };

    function parseTexture(headers, body, fileName) {
        const t = { name: null, w: 1, h: 1, format: 'rgba8', filter: 'LINEAR', border: 'CLAMP', storage: false, hex: '' };
        for (const h of headers) {
            const [cmd, ...rest] = h.split(/\s+/);
            if (cmd === 'TEXTURE') t.name = rest[0];
            else if (cmd === 'SIZE') { t.w = parseInt(rest[0], 10); t.h = parseInt(rest[1] || '1', 10); if (rest[2]) throw new Error(`${fileName}: 3D texture ${t.name}`); }
            else if (cmd === 'FORMAT') t.format = rest[0];
            else if (cmd === 'FILTER') t.filter = rest[0];
            else if (cmd === 'BORDER') t.border = rest[0];
            else if (cmd === 'STORAGE') t.storage = true;
        }
        if (!TEXTURE_FORMATS[t.format]) throw new Error(`${fileName}: texture ${t.name} has unsupported FORMAT ${t.format}`);
        t.hex = body.replace(/\s+/g, '');
        return t;
    }

    function parsePass(headers, body, bodyLine, fileName) {
        const p = {
            file: fileName, desc: 'unknown user shader', hooks: [], binds: [], save: null,
            width: [{ t: 'texw', name: 'HOOKED' }], height: [{ t: 'texh', name: 'HOOKED' }],
            when: [{ t: 'num', v: 1 }], body, bodyLine
        };
        for (const h of headers) {
            const sp = h.indexOf(' ');
            const cmd = sp < 0 ? h : h.slice(0, sp);
            const arg = sp < 0 ? '' : h.slice(sp + 1).trim();
            if (cmd === 'HOOK') p.hooks.push(arg);
            else if (cmd === 'BIND') p.binds.push(arg);
            else if (cmd === 'SAVE') p.save = arg;
            else if (cmd === 'DESC') p.desc = arg;
            else if (cmd === 'WIDTH') p.width = parseRpn(arg);
            else if (cmd === 'HEIGHT') p.height = parseRpn(arg);
            else if (cmd === 'WHEN') p.when = parseRpn(arg);
            else if (cmd === 'COMPUTE') throw new Error(`${fileName}: COMPUTE pass "${p.desc}" is not supported in WebGL2`);
            else if (cmd === 'OFFSET' && arg !== '0 0') WARN(`${fileName}: OFFSET ${arg} ignored`);
        }
        // SAVE HOOKED means "replace the hooked texture", like no SAVE at all.
        if (p.save === 'HOOKED') p.save = null;
        p.stage = p.hooks.includes('OUTPUT') ? 'OUTPUT' : 'MAIN';
        if (p.hooks.some((h) => h !== 'MAIN' && h !== 'MAINPRESUB' && h !== 'OUTPUT')) {
            WARN(`${fileName}: "${p.desc}" hooks ${p.hooks.join(',')}; only MAIN and OUTPUT are run`);
        }
        return p;
    }

    function hexToTyped(hex, Ctor) {
        const bytes = new Uint8Array(hex.length >> 1);
        for (let i = 0; i < bytes.length; i++) {
            const a = hex.charCodeAt(2 * i);
            const b = hex.charCodeAt(2 * i + 1);
            bytes[i] = (((a & 0xf) + (a >> 6) * 9) << 4) | ((b & 0xf) + (b >> 6) * 9);
        }
        return Ctor === Uint8Array ? bytes : new Ctor(bytes.buffer);
    }

    // ----------------------------------------------------------------------
    //  GLSL ES compatibility: global initializers
    // ----------------------------------------------------------------------
    // The slang conversions declare globals initialized from uniforms and
    // varyings -- `vec2 TexCoord = HOOKED_pos;`, `params = _params_(...)`.
    // Desktop GLSL (which libplacebo compiles for mpv) runs those before
    // main(); GLSL ES only allows constant expressions there. So each
    // non-const global initializer is cut out of its declaration and replayed,
    // in order, by kt_init_globals() at the top of main(). That is exactly
    // what a desktop compiler does with them.
    //
    // Line numbers are preserved (the initializer's newlines stay), and each
    // replayed assignment is wrapped in the #if/#elif/#else context its
    // declaration sat in, so a declaration in an inactive branch is not
    // assigned to.
    function hoistGlobalInitializers(src) {
        const out = [];
        const inits = [];
        const cond = [];            // open preprocessor conditionals, as lines
        let depth = 0;
        let paren = 0;
        let stmt = '';              // current top-level statement, code only
        let stmtOut = '';           // same span as emitted (comments kept)
        let i = 0;
        let atLineStart = true;

        const flushStatement = () => {
            const eq = findTopLevelAssign(stmt);
            const trimmed = stmt.trim();
            if (eq >= 0 && !/^(const|uniform|in|out|layout|precision)\b/.test(trimmed)) {
                // stmt and stmtOut are index-aligned (comments and
                // directives are blanked to spaces in stmt), so one offset
                // serves both.
                const init = stmt.slice(eq + 1, stmt.length - 1);      // drop ';'
                const name = declaredName(stmt.slice(0, eq));
                if (name && !hasTopLevelComma(init)) {
                    inits.push({ cond: cond.map((g) => g.slice()), code: `${name} = ${init.trim()};` });
                    out.push(stmtOut.slice(0, eq) + ';' + stmtOut.slice(eq + 1, stmtOut.length - 1).replace(/[^\n]/g, ''));
                    stmt = stmtOut = '';
                    return;
                }
            }
            out.push(stmtOut);
            stmt = stmtOut = '';
        };

        while (i < src.length) {
            const c = src[i];

            if (atLineStart && /[ \t]/.test(c)) { stmtOut += c; stmt += c; i++; continue; }
            if (atLineStart && c === '#') {
                // Preprocessor line, with continuations. Emitted where it is;
                // conditionals are tracked for the replayed initializers.
                let end = i;
                while (true) {
                    const nl = src.indexOf('\n', end);
                    if (nl < 0) { end = src.length; break; }
                    if (src[nl - 1] === '\\') { end = nl + 1; continue; }
                    end = nl;
                    break;
                }
                const line = src.slice(i, end);
                const d = /^#\s*(\w+)/.exec(line)?.[1];
                if (d === 'if' || d === 'ifdef' || d === 'ifndef') cond.push([line]);
                else if ((d === 'elif' || d === 'else') && cond.length) cond[cond.length - 1].push(line);
                else if (d === 'endif') cond.pop();
                // A directive splits nothing: keep it inside the statement's
                // emitted text so ordering is preserved.
                stmtOut += line;
                stmt += line.replace(/[^\n]/g, ' ');
                i = end;
                atLineStart = false;
                continue;
            }
            atLineStart = false;

            if (c === '/' && src[i + 1] === '/') {
                const nl = src.indexOf('\n', i);
                const end = nl < 0 ? src.length : nl;
                stmtOut += src.slice(i, end);
                stmt += ' '.repeat(end - i);
                i = end;
                continue;
            }
            if (c === '/' && src[i + 1] === '*') {
                const close = src.indexOf('*/', i + 2);
                const end = close < 0 ? src.length : close + 2;
                const chunk = src.slice(i, end);
                stmtOut += chunk;
                stmt += chunk.replace(/[^\n]/g, ' ');
                i = end;
                continue;
            }

            stmtOut += c;
            stmt += c;
            i++;
            if (c === '\n') { atLineStart = true; continue; }
            if (c === '(') paren++;
            else if (c === ')') paren--;
            else if (c === '{') depth++;
            else if (c === '}') {
                depth--;
                // End of a function body: a top-level statement with no ';'.
                if (depth === 0 && paren === 0) {
                    const head = stmt.slice(0, stmt.indexOf('{'));
                    if (!/\bstruct\b/.test(head) && /\)\s*$/.test(head)) { out.push(stmtOut); stmt = stmtOut = ''; }
                }
            } else if (c === ';' && depth === 0 && paren === 0) {
                flushStatement();
            }
        }
        out.push(stmtOut);

        const initLines = ['void kt_init_globals() {'];
        for (const { cond: stack, code } of inits) {
            stack.forEach((group) => initLines.push(...group));
            initLines.push(`    ${code}`);
            stack.forEach(() => initLines.push('#endif'));
        }
        initLines.push('}');
        return { body: out.join(''), init: initLines.join('\n'), count: inits.length };
    }

    // The '=' that starts a declaration's initializer: at nesting depth 0,
    // and not part of ==, <=, >= or !=.
    function findTopLevelAssign(s) {
        let d = 0;
        for (let i = 0; i < s.length; i++) {
            const c = s[i];
            if (c === '(' || c === '{' || c === '[') d++;
            else if (c === ')' || c === '}' || c === ']') d--;
            else if (c === '=' && d === 0 && s[i + 1] !== '=' && !'=<>!'.includes(s[i - 1])) return i;
        }
        return -1;
    }

    function hasTopLevelComma(s) {
        let d = 0;
        for (const c of s) {
            if (c === '(' || c === '{' || c === '[') d++;
            else if (c === ')' || c === '}' || c === ']') d--;
            else if (c === ',' && d === 0) return true;
        }
        return false;
    }

    // `vec2 TexCoord`, `float w[3]`, `struct S { ... } params` -> the name.
    function declaredName(decl) {
        const tail = decl.slice(decl.lastIndexOf('}') + 1);
        const m = /([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*$/.exec(tail);
        return m ? m[1] : null;
    }

    // `0..xxxx` is a swizzle of the scalar literal `0.` -- legal in desktop
    // GLSL 4.20+, not in GLSL ES. It is a splat, so vecN(literal).
    function splatScalarSwizzles(src) {
        return src.replace(/(^|[^\w.])(\d+\.\d*|\.\d+)\.([xyzwrgbastpq]{1,4})\b/g, (m, pre, num, sw) =>
            `${pre}${sw.length === 1 ? 'float' : 'vec' + sw.length}(${num})`);
    }

    function glslFloat(v) {
        if (!Number.isFinite(v)) return '0.0';
        const s = String(v);
        return `(${/[.eE]/.test(s) ? s : s + '.0'})`;
    }

    // ======================================================================
    //  mpv PIPELINE
    // ======================================================================

    // BT.1886 with libplacebo's SDR defaults: black at 1/1000 of white.
    const BT1886_LB = Math.pow(0.001, 1 / 2.4);
    const BT1886_A = Math.pow(1 - BT1886_LB, 2.4);
    const BT1886_B = BT1886_LB / (1 - BT1886_LB);

    // `target` is 'es' for WebGL2, or 'desktop' for the offline translation
    // (tools/build-crt-shaders.mjs), which compiles the pass the way
    // libplacebo does -- desktop GLSL through glslang -- and has SPIRV-Cross
    // write it back out as GLSL ES.
    const passPrelude = (target) => `${target === 'desktop' ? '#version 450' : '#version 300 es'}
precision highp float;
precision highp int;
precision highp sampler2D;
in vec2 kt_pos;
layout(location = 0) out vec4 kt_out;
uniform int kt_frame;
uniform float kt_random;
uniform vec2 kt_input_size;
uniform vec2 kt_target_size;
uniform vec2 kt_tex_offset;
#define frame kt_frame
#define random kt_random
#define input_size kt_input_size
#define target_size kt_target_size
#define tex_offset kt_tex_offset
vec4 kt_linearize(vec4 color) {
    color.rgb = max(color.rgb, 0.0);
    color.rgb = ${glslFloat(BT1886_A)} * pow(color.rgb + vec3(${glslFloat(BT1886_B)}), vec3(2.4));
    return color;
}
vec4 kt_delinearize(vec4 color) {
    color.rgb = max(color.rgb, 0.0);
    color.rgb = pow(${glslFloat(1 / BT1886_A)} * color.rgb, vec3(1.0 / 2.4)) - vec3(${glslFloat(BT1886_B)});
    return color;
}
#define linearize kt_linearize
#define delinearize kt_delinearize
`;

    // The macros libplacebo's bind_pass_tex() defines for a bound texture.
    function passTextureMacros(name, unit) {
        return [
            `uniform sampler2D kt_b${unit};`,
            `uniform vec2 kt_pt${unit};`,
            `#define ${name}_raw kt_b${unit}`,
            `#define ${name}_pos kt_pos`,
            `#define ${name}_size vec2(textureSize(kt_b${unit}, 0))`,
            `#define ${name}_pt kt_pt${unit}`,
            `#define ${name}_off vec2(0.0)`,
            `#define ${name}_mul 1.0`,
            `#define ${name}_rot mat2(1.0, 0.0, 0.0, 1.0)`,
            `#define ${name}_tex(pos) (1.0 * vec4(textureLod(kt_b${unit}, pos, 0.0)))`,
            `#define ${name}_texOff(off) (${name}_tex(kt_pos + kt_pt${unit} * vec2(off)))`
        ];
    }

    const ALIAS_SUFFIXES = ['raw', 'pos', 'size', 'pt', 'off', 'mul', 'rot', 'tex', 'texOff'];

    // Builds the fragment source for one pass and the plan the runtime
    // follows to feed it. Returns null if a BIND names nothing this file can
    // ever provide -- libplacebo silently skips such a pass, and so do we.
    function buildPass(file, pass, savedBefore, target = 'es') {
        const lines = [passPrelude(target)];
        const binds = [];
        let body = pass.body;
        let storageIndex = 0;

        pass.binds.forEach((name, unit) => {
            const isStage = name === 'HOOKED' || name === pass.stage
                || (pass.stage === 'MAIN' && (name === 'MAIN' || name === 'MAINPRESUB'));
            const embedded = file.textures.find((t) => t.name === name);
            if (isStage) {
                // libplacebo's name for the MAIN stage is MAINPRESUB, with
                // MAIN_* and (when bound as HOOKED) HOOKED_* aliased onto it.
                let macroName = name === 'HOOKED' ? pass.stage : name;
                if (macroName === 'MAIN') macroName = 'MAINPRESUB';
                lines.push(...passTextureMacros(macroName, unit));
                if (name === 'HOOKED') ALIAS_SUFFIXES.forEach((s) => lines.push(`#define HOOKED_${s} ${macroName}_${s}`));
                if (macroName === 'MAINPRESUB') ALIAS_SUFFIXES.forEach((s) => lines.push(`#define MAIN_${s} MAINPRESUB_${s}`));
                binds.push({ kind: 'stage', unit });
            } else if (embedded && embedded.storage) {
                const k = storageIndex++;
                lines.push(`uniform sampler2D kt_b${unit};`);
                lines.push(`layout(location = ${1 + k}) out vec4 kt_store${k};`);
                lines.push(`vec4 kt_imageLoad${k}(ivec2 p) { return texelFetch(kt_b${unit}, p, 0); }`);
                lines.push(`void kt_imageStore${k}(ivec2 p, vec4 v) { kt_store${k} = v; }`);
                const re = (fn) => new RegExp(`\\b${fn}\\s*\\(\\s*${name}\\s*,`, 'g');
                body = body.replace(re('imageLoad'), `kt_imageLoad${k}(`)
                           .replace(re('imageStore'), `kt_imageStore${k}(`)
                           .replace(new RegExp(`\\bimageSize\\s*\\(\\s*${name}\\s*\\)`, 'g'), `textureSize(kt_b${unit}, 0)`);
                binds.push({ kind: 'storage', unit, texture: embedded, slot: k });
            } else if (embedded) {
                lines.push(`uniform sampler2D kt_b${unit};`);
                lines.push(`#define ${name} kt_b${unit}`);
                lines.push(`#define ${name}_tex(pos) (textureLod(kt_b${unit}, pos, 0.0))`);
                binds.push({ kind: 'embedded', unit, texture: embedded });
            } else if (savedBefore.has(name)) {
                lines.push(...passTextureMacros(name, unit));
                binds.push({ kind: 'saved', unit, name });
            } else {
                return;   // handled below
            }
        });
        if (binds.length !== pass.binds.length) {
            const missing = pass.binds.filter((n, i) => !binds.some((b) => b.unit === i));
            WARN(`${file.name}: skipping "${pass.desc}" -- no texture named ${missing.join(', ')}`);
            return null;
        }

        for (const p of file.params) {
            if (p.mode === 'constant') {
                // An identifier, as libplacebo's sh_const() gives, not a
                // literal: the slang conversions reuse param names as struct
                // member names, which a literal would turn into a syntax error.
                const lit = p.type === 'float' ? glslFloat(p.value) : `${Math.trunc(p.value)}${p.type === 'uint' ? 'u' : ''}`;
                lines.push(`const ${p.type} kt_c_${p.name} = ${lit};`);
                lines.push(`#define ${p.name} kt_c_${p.name}`);
            } else if (p.mode === 'define') {
                lines.push(`#define ${p.name} ${Math.trunc(p.value)}`);
            } else {
                lines.push(`uniform ${p.type} kt_p_${p.name};`);
                lines.push(`#define ${p.name} kt_p_${p.name}`);
            }
        }

        const storages = binds.filter((b) => b.kind === 'storage');
        const hoisted = target === 'desktop'
            ? { body, init: 'void kt_init_globals() {}' }
            : hoistGlobalInitializers(splatScalarSwizzles(body));
        lines.push(`#line ${pass.bodyLine}`);
        lines.push(hoisted.body);
        lines.push(hoisted.init);
        lines.push('void main() {');
        lines.push('    kt_init_globals();');
        storages.forEach((b) => lines.push(`    kt_store${b.slot} = texelFetch(kt_b${b.unit}, ivec2(gl_FragCoord.xy), 0);`));
        lines.push('    vec4 color = hook();');
        lines.push('    kt_out = color;');
        lines.push('}');
        return { source: lines.join('\n'), binds };
    }

    // ----------------------------------------------------------------------
    //  Display-dependent parameters
    // ----------------------------------------------------------------------
    // retro.conf is tuned on a 3840x2160, 240 Hz panel, and two parameters
    // carry that panel in their units:
    //
    //   mask_triad_size_desired  phosphor triad width in OUTPUT pixels, i.e.
    //                            panel pixels (3 for super, 4 for kurozumi:
    //                            1280 / 960 triads across a 4K panel). Scaled
    //                            by panel lines / 2160, so any panel holds the
    //                            same number of triads across its width. Never
    //                            below crt-royale's mask_min_allowed_triad_size
    //                            of 2 -- a 1080p panel cannot resolve finer.
    //                            Pixel-sized triads are right WITHIN a panel:
    //                            a smaller window is a smaller TV, with fewer.
    //   persist_tick_ms          milliseconds per OUTPUT run, 4.167 at 240 Hz:
    //                            the measured refresh period, except within 1%
    //                            of 240 Hz, where the tuned value is used as is.
    //
    // Both are CONSTANT in the shader, i.e. baked into each compiled pass, so
    // they are promoted to uniforms here: a value that follows the display
    // cannot be compiled in. tools/build-crt-shaders.mjs generates the same
    // uniforms, since it runs this generator.
    const DISPLAY_REF_LINES = 2160;
    const DISPLAY_REF_HZ = 240;
    const DISPLAY_PARAMS = {
        mask_triad_size_desired: (base, d) => Math.max(2, base * d.panelLines / DISPLAY_REF_LINES),
        // Within 1% of the tuned 240 Hz, the tuned value exactly.
        persist_tick_ms: (base, d) => (d.refreshMs && Math.abs(1000 / d.refreshMs - DISPLAY_REF_HZ) > 0.01 * DISPLAY_REF_HZ ? d.refreshMs : base)
    };

    // Everything that does not need a GL context: profile, parsed files,
    // parameter values and each pass's generated source.
    async function loadMpvProfile(profileKey, target = 'es') {
        const conf = parseRetroConf(await fetchText(CRT_DIR + CONF_FILE));
        const profile = conf[profileKey];
        if (!profile || !profile.shaders) {
            throw new Error(`retro.conf has no glsl-shaders for [${profileKey}] (profiles: ${Object.keys(conf).filter((k) => conf[k].shaders).join(', ')})`);
        }

        const texts = await Promise.all(profile.shaders.map((f) => fetchText(CRT_DIR + f + '.txt')));
        const files = texts.map((text, i) => parseHookFile(text, profile.shaders[i]));

        // glsl-shader-opts is one list for the whole chain: a key applies to
        // every file that declares it, and is inert where none does.
        const declared = new Set();
        for (const file of files) {
            file.values = {};
            for (const p of file.params) {
                declared.add(p.name);
                if (Object.prototype.hasOwnProperty.call(profile.opts, p.name)) {
                    const v = parseFloat(profile.opts[p.name]);
                    if (Number.isFinite(v)) p.value = v;
                }
                file.values[p.name] = p.value;
            }
        }
        // The tuned value is kept as the base the display scaling works from.
        for (const file of files) {
            for (const p of file.params) {
                if (!DISPLAY_PARAMS[p.name]) continue;
                p.base = p.value;
                if (p.mode === 'constant') p.mode = 'dynamic';
            }
        }

        const inert = Object.keys(profile.opts).filter((k) => !declared.has(k));
        if (inert.length) LOG(`[${profileKey}] opts no loaded shader declares (inert in mpv too): ${inert.join(', ')}`);

        const passes = [];
        for (const file of files) {
            const saved = new Set();
            for (const pass of file.passes) {
                const built = buildPass(file, pass, saved, target);
                if (pass.save) saved.add(pass.save);
                if (!built) continue;
                pass.plan = built.binds;
                pass.source = built.source;
                if (target !== 'es') pass.esSource = buildPass(file, pass, new Set([...saved, ...pass.binds]), 'es').source;
                pass.fileRef = file;
                passes.push(pass);
            }
        }
        if (target === 'es') await applyTranslations(profileKey, passes);
        return { files, passes };
    }

    // FNV-1a plus length: the key tools/build-crt-shaders.mjs files each
    // translated pass under. It hashes the GLSL ES this file generates for the
    // pass, so any change to the mpv files, retro.conf or the generator gives
    // a different key and a stale build is detected rather than run.
    function sourceKey(s) {
        let h = 0x811c9dc5;
        for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
        return `${(h >>> 0).toString(16)}-${s.length}`;
    }

    // Swaps in the glslang + SPIRV-Cross translation of each pass. The
    // generated source compiles as written only where it happens to be valid
    // GLSL ES; most of crt-royale is not, so a stale build is reported loudly.
    async function applyTranslations(profileKey, passes) {
        let build = null;
        try {
            build = JSON.parse(await fetchText(`${CRT_DIR}build/${profileKey}.json`));
        } catch (e) {
            WARN(`No GLSL ES build for [${profileKey}] (${e.message})`);
        }
        let hits = 0;
        for (const pass of passes) {
            const translated = build?.passes?.[sourceKey(pass.source)];
            if (translated) {
                pass.source = translated;
                hits++;
            }
        }
        if (hits < passes.length) {
            WARN(`[${profileKey}] ${passes.length - hits} of ${passes.length} passes have no matching GLSL ES translation; `
                + 'the build is stale (run tools/build-crt-shaders.mjs after tools/sync-crt-shaders.sh). Compiling them as written.');
        }
    }

    async function createMpvPipeline(gl, profileKey) {
        if (!gl.getExtension('EXT_color_buffer_float')) {
            throw new Error('EXT_color_buffer_float is unavailable, so float render targets cannot be used');
        }
        const { files, passes } = await loadMpvProfile(profileKey);

        // Embedded textures.
        for (const file of files) {
            for (const t of file.textures) {
                const [ifmt, fmt, type, comps, Ctor] = TEXTURE_FORMATS[t.format];
                if (t.storage) {
                    t.pair = [createTarget(gl, gl.NEAREST), createTarget(gl, gl.NEAREST)];
                    t.read = 0;
                    continue;
                }
                const filter = t.filter === 'NEAREST' ? gl.NEAREST : gl.LINEAR;
                const wrap = t.border === 'REPEAT' ? gl.REPEAT : t.border === 'MIRROR' ? gl.MIRRORED_REPEAT : gl.CLAMP_TO_EDGE;
                t.tex = makeTexture(gl, filter, wrap);
                const data = hexToTyped(t.hex, Ctor);
                if (data.length !== t.w * t.h * comps) throw new Error(`${file.name}: texture ${t.name} payload is ${data.length} values, expected ${t.w * t.h * comps}`);
                gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl[ifmt], t.w, t.h, 0, gl[fmt], gl[type], data);
                t.hex = null;
            }
        }

        // Programs: every pass of every file, compiled in parallel.
        files.forEach((file) => { file.frameCount = 0; });
        const pending = passes.map((pass) => {
            pass.target = createTarget(gl, gl.LINEAR);
            return startProgram(gl, VS_PASS, pass.source, `${pass.file}: ${pass.desc}`);
        });
        const presentP = startProgram(gl, VS_PRESENT, FS_PRESENT, 'present');
        const copyP = startProgram(gl, VS_PASS, FS_COPY, 'copy');
        const started = performance.now();
        const programs = await finishPrograms(gl, [...pending, presentP, copyP]);
        LOG(`[${profileKey}] ${passes.length} passes from ${files.length} files compiled in ${Math.round(performance.now() - started)} ms`);

        passes.forEach((pass, i) => {
            const program = programs[i];
            const loc = (n) => gl.getUniformLocation(program, n);
            pass.program = program;
            pass.loc = {
                frame: loc('kt_frame'), random: loc('kt_random'), input: loc('kt_input_size'),
                target: loc('kt_target_size'), offset: loc('kt_tex_offset'),
                samplers: pass.plan.map((b) => loc(`kt_b${b.unit}`)),
                pts: pass.plan.map((b) => loc(`kt_pt${b.unit}`))
            };
            const file = pass.fileRef;
            pass.paramLocs = file.params.filter((p) => p.mode === 'variable' || p.mode === 'dynamic')
                .map((p) => ({ p, loc: loc(`kt_p_${p.name}`) })).filter((x) => x.loc);
        });
        const presentProgram = programs[programs.length - 2];
        const copyProgram = programs[programs.length - 1];
        const outputTarget = createTarget(gl, gl.LINEAR);
        let mainResult = null;
        const tmpFbo = gl.createFramebuffer();

        function runPass(pass, hooked, saved, sizes) {
            const file = pass.fileRef;
            const lookupTex = (name) => {
                if (name === 'HOOKED' || name === pass.stage || (pass.stage === 'MAIN' && (name === 'MAIN' || name === 'MAINPRESUB'))) return [hooked.w, hooked.h];
                if (name === 'OUTPUT') return sizes.out;
                if (name === 'NATIVE_CROPPED') return sizes.src;
                const s = saved.get(name);
                return s ? [s.w, s.h] : null;
            };
            const lookupVar = (name) => file.values[name];

            const run = evalRpn(pass.when, lookupTex, lookupVar);
            if (!run) return null;

            // A bind whose texture was not produced this frame (its pass was
            // skipped) skips this pass too, as in libplacebo.
            const inputs = [];
            for (const b of pass.plan) {
                if (b.kind === 'stage') inputs.push(hooked);
                else if (b.kind === 'saved') {
                    const s = saved.get(b.name);
                    if (!s) return null;
                    inputs.push(s);
                } else if (b.kind === 'embedded') inputs.push({ tex: b.texture.tex, w: b.texture.w, h: b.texture.h });
                else inputs.push(null);
            }

            const w = Math.round(evalRpn(pass.width, lookupTex, lookupVar) ?? 0);
            const h = Math.round(evalRpn(pass.height, lookupTex, lookupVar) ?? 0);
            const max = gl.getParameter(gl.MAX_TEXTURE_SIZE);
            if (!(w >= 1 && h >= 1 && w <= max && h <= max)) {
                WARN(`${file.name}: "${pass.desc}" has size ${w}x${h}; skipped`);
                return null;
            }

            // libplacebo bumps the file's counter after the binds resolve and
            // before dispatch; `frame` is that new value.
            file.frameCount++;

            pass.target.ensure(w, h);
            gl.bindFramebuffer(gl.FRAMEBUFFER, pass.target.fbo);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, pass.target.tex, 0);
            const drawBuffers = [gl.COLOR_ATTACHMENT0];
            gl.useProgram(pass.program);

            pass.plan.forEach((b, i) => {
                gl.activeTexture(gl.TEXTURE0 + i);
                if (b.kind === 'storage') {
                    const t = b.texture;
                    t.pair[0].ensure(w, h);
                    t.pair[1].ensure(w, h);
                    gl.bindTexture(gl.TEXTURE_2D, t.pair[t.read].tex);
                    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1 + b.slot, gl.TEXTURE_2D, t.pair[1 - t.read].tex, 0);
                    drawBuffers.push(gl.COLOR_ATTACHMENT1 + b.slot);
                } else {
                    gl.bindTexture(gl.TEXTURE_2D, inputs[i].tex);
                    if (pass.loc.pts[i]) gl.uniform2f(pass.loc.pts[i], 1 / inputs[i].w, 1 / inputs[i].h);
                }
                gl.uniform1i(pass.loc.samplers[i], i);
            });
            gl.drawBuffers(drawBuffers);

            gl.uniform1i(pass.loc.frame, file.frameCount);
            gl.uniform1f(pass.loc.random, Math.random());
            gl.uniform2f(pass.loc.input, sizes.src[0], sizes.src[1]);
            gl.uniform2f(pass.loc.target, sizes.out[0], sizes.out[1]);
            gl.uniform2f(pass.loc.offset, 0, 0);
            for (const { p, loc } of pass.paramLocs) {
                const v = file.values[p.name];
                if (p.type === 'int') gl.uniform1i(loc, Math.trunc(v));
                else if (p.type === 'uint') gl.uniform1ui(loc, Math.max(0, Math.trunc(v)));
                else gl.uniform1f(loc, v);
            }

            gl.viewport(0, 0, w, h);
            gl.drawArrays(gl.TRIANGLES, 0, 3);

            for (const b of pass.plan) {
                if (b.kind === 'storage') {
                    b.texture.read = 1 - b.texture.read;
                    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1 + b.slot, gl.TEXTURE_2D, null, 0);
                }
            }
            return { tex: pass.target.tex, w, h };
        }

        function runStage(stage, input, sizes) {
            let hooked = input;
            for (const file of files) {
                const saved = new Map();
                for (const pass of file.passes) {
                    if (pass.stage !== stage || !pass.program) continue;
                    const out = runPass(pass, hooked, saved, sizes);
                    if (!out) continue;
                    if (pass.save && pass.save !== stage && !(stage === 'MAIN' && (pass.save === 'MAIN' || pass.save === 'MAINPRESUB'))) {
                        saved.set(pass.save, out);
                    } else {
                        hooked = out;
                    }
                }
            }
            return hooked;
        }

        function blit(program, src, w, h, fbo) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
            gl.useProgram(program);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, src.tex);
            gl.uniform1i(gl.getUniformLocation(program, 'kt_src'), 0);
            gl.viewport(0, 0, w, h);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
        }

        const outputPasses = passes.filter((p) => p.stage === 'OUTPUT');

        return {
            engine: 'mpv',
            profile: profileKey,
            passCount: passes.length,

            // Whether anything must run every refresh: an OUTPUT-stage pass
            // whose WHEN currently holds (persist_initial > 0, for phosphor).
            get outputActive() {
                return outputPasses.some((pass) => evalRpn(pass.when, () => [1, 1], (n) => pass.fileRef.values[n]));
            },

            setHostParam(name, value) {
                for (const file of files) if (name in file.values) file.values[name] = value;
            },

            // Re-derive the display-dependent parameters from their tuned base.
            setDisplay(display) {
                for (const file of files) {
                    for (const p of file.params) {
                        const rule = DISPLAY_PARAMS[p.name];
                        if (rule) file.values[p.name] = rule(p.base, display);
                    }
                }
            },

            // One field: the MAIN chain on the current source frame.
            runMain(source, outW, outH) {
                const sizes = { src: [source.w, source.h], out: [outW, outH] };
                let result = runStage('MAIN', source, sizes);
                // mpv scales MAIN to the output rectangle before OUTPUT hooks.
                // crt-royale ends at OUTPUT size, so this is normally skipped.
                if (result.w !== outW || result.h !== outH) {
                    outputTarget.ensure(outW, outH);
                    gl.bindFramebuffer(gl.FRAMEBUFFER, outputTarget.fbo);
                    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outputTarget.tex, 0);
                    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
                    blit(copyProgram, result, outW, outH, outputTarget.fbo);
                    result = { tex: outputTarget.tex, w: outW, h: outH };
                }
                mainResult = { result, sizes };
            },

            // One refresh: OUTPUT-stage passes, then dither to the canvas.
            present(canvasW, canvasH) {
                if (!mainResult) return;
                let out = mainResult.result;
                if (outputPasses.length) out = runStage('OUTPUT', out, mainResult.sizes);
                blit(presentProgram, out, canvasW, canvasH, null);
            },

            dispose() {
                for (const pass of passes) {
                    gl.deleteProgram(pass.program);
                    if (pass.target.tex) gl.deleteTexture(pass.target.tex);
                    gl.deleteFramebuffer(pass.target.fbo);
                }
                for (const file of files) for (const t of file.textures) {
                    if (t.tex) gl.deleteTexture(t.tex);
                    if (t.pair) t.pair.forEach((x) => { if (x.tex) gl.deleteTexture(x.tex); gl.deleteFramebuffer(x.fbo); });
                }
                gl.deleteProgram(presentProgram);
                gl.deleteProgram(copyProgram);
                gl.deleteFramebuffer(tmpFbo);
            }
        };
    }

    // ======================================================================
    //  FUSED PIPELINE  (the single-pass Hyprland port, kept for A/B)
    // ======================================================================

    const VS_FUSED = `#version 300 es
out vec2 v_texcoord;
void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    v_texcoord = vec2(p.x, 1.0 - p.y);
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

    async function createFusedPipeline(gl) {
        const source = await fetchText(CRT_DIR + FUSED_FILE);
        const [program] = await finishPrograms(gl, [startProgram(gl, VS_FUSED, source, FUSED_FILE)]);
        const loc = (n) => gl.getUniformLocation(program, n);
        const u = { tex: loc('tex'), fullSize: loc('fullSize'), srcSize: loc('srcSize'), time: loc('time') };
        let pending = null;
        return {
            engine: 'fused',
            profile: 'retro-super (fused)',
            passCount: 1,
            outputActive: false,
            setHostParam() {},
            setDisplay() {},
            runMain(source, outW, outH, field) { pending = { source, outW, outH, field }; },
            present(canvasW, canvasH) {
                if (!pending) return;
                const { source, field } = pending;
                gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                gl.useProgram(program);
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, source.tex);
                gl.uniform1i(u.tex, 0);
                gl.uniform2f(u.fullSize, canvasW, canvasH);
                gl.uniform2f(u.srcSize, source.w, source.h);
                // The shader derives its field as floor(time * 59.94), so
                // hand it the middle of the clock's field.
                gl.uniform1f(u.time, (field + 0.5) / FIELD_RATE);
                gl.viewport(0, 0, canvasW, canvasH);
                gl.drawArrays(gl.TRIANGLES, 0, 3);
            },
            dispose() { gl.deleteProgram(program); }
        };
    }

    // ======================================================================
    //  SUBTITLES (1 of 2): server burn-in, requested per stream, never stored
    // ======================================================================
    // mpv puts subtitles INTO the picture (retro-base's vf=sub), so they go
    // through the tube. The web player draws them as layers over the video,
    // which the CRT canvas covers. Two ways to get them into the frame:
    // having the server burn them in with libass, the renderer mpv uses (the
    // default, this section), or compositing them in the browser (subtitle
    // mode 'composite' -- see SUBTITLES 2 of 2).
    //
    // HOW, without touching any setting. Jellyfin's own "Burn subtitles: All"
    // is a localStorage value (appSettings 'subtitleburnin'), and writing it
    // would outlive the session. Instead, every PlaybackInfo request leaving
    // this page while CRT is enabled has its device profile's SubtitleProfiles
    // emptied in flight: a client that can render no subtitle format is one
    // the server must burn them in for. It is the exact effect of that
    // setting -- browserDeviceProfile.js builds the same empty list for
    // 'all' -- held only in this page's memory. Nothing is written, so
    // closing the browser mid-stream leaves nothing behind.
    //
    // Requests go through the SDK's axios (XHR) on Jellyfin 12 and the
    // legacy apiclient's fetch on 10.11, so both are wrapped.
    //
    // SWITCHING MID-STREAM. A stream already negotiated keeps its delivery
    // until it is renegotiated. Jellyfin renegotiates in place -- same
    // position, same tracks, through changeStream() -- when this session is
    // told to set its audio track to the one it has: Firefox, Zen and Chrome
    // cannot switch audio tracks in the element, so the web player always
    // takes that path. The command is sent to our own session through the
    // server's remote-control API, which is what delivers it to the player.

    const burnIn = {
        lastBurned: null,       // did the last PlaybackInfo we sent ask for burn-in?
        renegotiating: false,
        lastCheck: 0,
        offTimer: 0             // pending hand-back after CRT was turned off
    };

    // How long CRT has to stay off before the stream is handed back to the
    // web player's own subtitles. The button cycles kurozumi -> off -> super,
    // so passing through off on the way to super must not restart the stream
    // twice; the burned-in stream simply carries on if CRT comes back on in
    // time.
    const BURN_HANDBACK_DELAY_MS = 4000;

    const PLAYBACK_INFO_RE = /\/Items\/[^/?#]+\/PlaybackInfo(?:[?#]|$)/i;

    function rewritePlaybackInfo(body) {
        if (!enabled || subtitleMode !== 'burn' || typeof body !== 'string') {
            burnIn.lastBurned = false;
            return body;
        }
        try {
            const dto = JSON.parse(body);
            if (!dto || !dto.DeviceProfile) {
                burnIn.lastBurned = false;
                return body;
            }
            dto.DeviceProfile.SubtitleProfiles = [];
            dto.AlwaysBurnInSubtitleWhenTranscoding = true;
            burnIn.lastBurned = true;
            LOG('CRT is on: asked the server to burn in subtitles for this stream');
            return JSON.stringify(dto);
        } catch (e) {
            burnIn.lastBurned = false;
            return body;
        }
    }

    function installPlaybackInfoHook() {
        if (window.__kefinCrtHooked || typeof XMLHttpRequest === 'undefined') return;   // not a browser (the build tool)
        window.__kefinCrtHooked = true;

        const xhrOpen = XMLHttpRequest.prototype.open;
        const xhrSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (method, url, ...rest) {
            this.__kefinCrtPlaybackInfo = /^post$/i.test(method) && PLAYBACK_INFO_RE.test(String(url));
            return xhrOpen.call(this, method, url, ...rest);
        };
        XMLHttpRequest.prototype.send = function (body) {
            return xhrSend.call(this, this.__kefinCrtPlaybackInfo ? rewritePlaybackInfo(body) : body);
        };

        const origFetch = window.fetch;
        window.fetch = function (input, init) {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            if (init && /^post$/i.test(init.method || '') && PLAYBACK_INFO_RE.test(url)) {
                init = Object.assign({}, init, { body: rewritePlaybackInfo(init.body) });
            }
            return origFetch.call(this, input, init);
        };
    }

    // Is the web player drawing subtitles itself right now? Then they are
    // under the canvas and the stream needs burn-in.
    function clientSubtitlesShowing() {
        if (!video) return false;
        if (Array.from(video.textTracks || []).some((t) => t.mode === 'showing')) return true;
        const container = video.parentNode;
        if (!container) return false;
        if (container.querySelector('.videoSubtitlesInner, .videoSecondarySubtitlesInner')) return true;
        // libass (ASS/SSA) and libbitsub (PGS) draw into canvases of their own.
        return !!container.querySelector('canvas:not(.kefinCrtCanvas)');
    }

    async function ownSession() {
        const api = window.ApiClient;
        if (!api || typeof api.getSessions !== 'function') return null;
        const sessions = await api.getSessions({ deviceId: api.deviceId() });
        return (sessions || []).find((s) => s.NowPlayingItem) || null;
    }

    // Re-negotiates the current stream in place, so a change of CRT state
    // reaches the server's subtitle delivery. Only when subtitles are on.
    async function renegotiateStream(reason) {
        if (burnIn.renegotiating) return;
        burnIn.renegotiating = true;
        try {
            const api = window.ApiClient;
            const session = await ownSession();
            const state = session?.PlayState || {};
            if (!session || state.SubtitleStreamIndex == null || state.SubtitleStreamIndex < 0) return;
            if (state.AudioStreamIndex == null) {
                WARN('Cannot renegotiate the stream: it has no audio track to re-select');
                return;
            }
            LOG(`Renegotiating the stream (${reason})`);
            await api.ajax({
                type: 'POST',
                url: api.getUrl(`Sessions/${session.Id}/Command`),
                data: JSON.stringify({ Name: 'SetAudioStreamIndex', Arguments: { Index: String(state.AudioStreamIndex) } }),
                contentType: 'application/json'
            });
        } catch (err) {
            WARN('Could not renegotiate the stream:', err);
        } finally {
            // Leave time for the new PlaybackInfo to go out before checking again.
            setTimeout(() => { burnIn.renegotiating = false; }, 5000);
        }
    }

    // Called from the render loop about once a second while CRT runs, so the
    // stream's delivery follows the subtitle mode. In 'burn', a subtitle
    // track switched on mid-stream arrives as a client layer, under the
    // canvas, until the stream is renegotiated with burn-in. In 'composite',
    // a stream still carrying burned-in subtitles (from 'burn', or from before
    // the switch) goes back to direct play so they can be composited.
    function checkSubtitleDelivery(now) {
        if (now - burnIn.lastCheck < 1000) return;
        burnIn.lastCheck = now;
        if (subtitleMode === 'burn') {
            if (!burnIn.lastBurned && clientSubtitlesShowing()) renegotiateStream('subtitles are showing client-side under the CRT layer');
        } else if (burnIn.lastBurned) {
            renegotiateStream('subtitle mode is composite; back to client-side subtitles');
        }
    }

    installPlaybackInfoHook();

    // ======================================================================
    //  SUBTITLES (2 of 2): composited into the frame in the browser
    // ======================================================================
    // The stream stays direct play and Jellyfin renders subtitles exactly as
    // it always does -- libass (SubtitlesOctopus) for ASS/SSA, libbitsub for
    // PGS, the text track or its own element for SRT/VTT. Those layers are
    // made invisible (opacity, so they keep rendering) and, each field, what
    // they show is drawn onto a frame-sized overlay and blended into the video
    // frame BEFORE the chain: retro-base's vf=sub, in the same place.
    //
    // ORDER matches mpv's vf chain: autocrop measures the raw frame (its
    // cropdetect sits at the head), subtitles are blended in, then the crop
    // is taken. So subtitles are laid out on the full frame, as libass lays
    // them out in mpv, and none of the burn-in gating is needed.
    //
    // CANVAS RENDERERS (libass, PGS) draw over the video's on-screen picture;
    // their canvas is mapped back to frame pixels through the video's
    // content rectangle. They render at display resolution, which is at least
    // the frame's on a 4K screen, and the chain downscales to 480 lines anyway.
    //
    // TEXT (SRT/VTT) has no canvas, so it is drawn here, in mpv's default
    // subtitle style -- which is what mpv would use for it, since mpv.conf
    // sets no sub-* options: sans-serif, font size 38 at 720 lines scaled to
    // the frame, a 3 px black border, 22 px bottom margin, 25 px side
    // margins with word wrap. A secondary track goes at the top.

    const MPV_SUB_STYLE = { fontSize: 38, border: 3, marginY: 22, marginX: 25, lineSpacing: 1.2, refHeight: 720 };

    const FS_SUB_BLEND = `#version 300 es
precision highp float;
uniform highp sampler2D kt_frame;
uniform highp sampler2D kt_overlay;
out vec4 kt_out;
void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec4 f = texelFetch(kt_frame, p, 0);
    vec4 s = texelFetch(kt_overlay, p, 0);      // premultiplied
    kt_out = vec4(f.rgb * (1.0 - s.a) + s.rgb, 1.0);
}`;

    function createSubtitleCompositor() {
        let ctx = null;
        const overlay = document.createElement('canvas');
        const g = overlay.getContext('2d');
        let lastSources = 0;

        function ensureGL(gl) {
            if (ctx && ctx.gl === gl) return ctx;
            const vs = compile(gl, gl.VERTEX_SHADER, VS_PASS);
            const fs = compile(gl, gl.FRAGMENT_SHADER, FS_SUB_BLEND);
            const prog = gl.createProgram();
            gl.attachShader(prog, vs);
            gl.attachShader(prog, fs);
            gl.linkProgram(prog);
            if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('subtitle blend: ' + gl.getShaderInfoLog(fs));
            ctx = {
                gl, prog,
                overlayTex: makeTexture(gl, gl.NEAREST, gl.CLAMP_TO_EDGE),
                fbo: gl.createFramebuffer(),
                outTex: null, w: 0, h: 0
            };
            return ctx;
        }

        // The video's on-screen picture rectangle, uncropped, in CSS pixels.
        function contentRect(v) {
            const r = v.getBoundingClientRect();
            const vw = v.videoWidth, vh = v.videoHeight;
            const fit = v.style.objectFit || 'contain';
            if (fit === 'fill' || !vw || !vh) return r;
            const s = fit === 'cover' ? Math.max(r.width / vw, r.height / vh) : Math.min(r.width / vw, r.height / vh);
            const w = vw * s, h = vh * s;
            return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, width: w, height: h };
        }

        // Text of the subtitles Jellyfin is showing, primary first.
        function textSources(v) {
            const out = [];
            const container = v.parentNode;
            for (const sel of ['.videoSubtitlesInner', '.videoSecondarySubtitlesInner']) {
                const el = container && container.querySelector(sel);
                const text = el && el.innerText.trim();
                if (text) {
                    const italic = !!el.querySelector('i') && el.innerText.trim() === (el.querySelector('i').innerText || '').trim();
                    out.push({ lines: text.split('\n').map((t) => ({ text: t, italic })), top: sel.includes('Secondary') });
                }
            }
            if (out.length) return out;
            const showing = Array.from(v.textTracks || []).filter((t) => t.mode === 'showing');
            showing.forEach((t, i) => {
                const cues = Array.from(t.activeCues || []);
                if (!cues.length) return;
                const raw = cues.map((c) => c.text || '').join('\n');
                // Italics per line: a line is italic while an <i> is open,
                // which can carry across a line break.
                let open = false;
                const lines = [];
                for (const l of raw.split(/\n|<br\s*\/?>/i)) {
                    const startsOpen = open;
                    const tags = l.match(/<\/?i>/gi) || [];
                    tags.forEach((t) => { open = !t.startsWith('</'); });
                    const text = l.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
                    if (text.trim()) lines.push({ text, italic: startsOpen || /^\s*<i>/i.test(l) });
                }
                if (lines.length) out.push({ lines, top: i > 0 });
            });
            return out;
        }

        function wrap(text, maxWidth) {
            const words = text.split(/\s+/);
            const lines = [];
            let cur = '';
            for (const w of words) {
                const next = cur ? `${cur} ${w}` : w;
                if (cur && g.measureText(next).width > maxWidth) { lines.push(cur); cur = w; } else cur = next;
            }
            if (cur) lines.push(cur);
            return lines;
        }

        function drawText(src, W, H) {
            const k = H / MPV_SUB_STYLE.refHeight;
            const size = MPV_SUB_STYLE.fontSize * k;
            const font = (italic) => `${italic ? 'italic ' : ''}${size}px sans-serif`;
            g.textAlign = 'center';
            g.textBaseline = 'alphabetic';
            g.lineJoin = 'round';
            g.lineWidth = 2 * MPV_SUB_STYLE.border * k;      // a 3 px border each side of the glyph edge
            g.strokeStyle = '#000';
            g.fillStyle = '#fff';
            const maxWidth = W - 2 * MPV_SUB_STYLE.marginX * k;
            const lines = src.lines.flatMap((l) => {
                g.font = font(l.italic);
                return wrap(l.text, maxWidth).map((text) => ({ text, italic: l.italic }));
            });
            const step = size * MPV_SUB_STYLE.lineSpacing;
            const marginY = MPV_SUB_STYLE.marginY * k;
            lines.forEach((line, i) => {
                const y = src.top
                    ? marginY + size * 0.95 + i * step
                    : H - marginY - size * 0.25 - (lines.length - 1 - i) * step;
                g.font = font(line.italic);
                g.strokeText(line.text, W / 2, y);
                g.fillText(line.text, W / 2, y);
            });
        }

        return {
            get sources() { return lastSources; },

            // The frame with subtitles blended in, or the frame untouched when
            // nothing is showing.
            composite(gl, v, frame) {
                const container = v.parentNode;
                const canvases = container
                    ? Array.from(container.querySelectorAll('canvas:not(.kefinCrtCanvas)')).filter((c) => c.width && c.height)
                    : [];
                const texts = textSources(v);
                lastSources = canvases.length + texts.length;
                if (!lastSources) return frame;

                const W = frame.w, H = frame.h;
                if (overlay.width !== W || overlay.height !== H) {
                    overlay.width = W;
                    overlay.height = H;
                }
                g.clearRect(0, 0, W, H);
                if (canvases.length) {
                    const cr = contentRect(v);
                    const sx = W / cr.width, sy = H / cr.height;
                    for (const c of canvases) {
                        const r = c.getBoundingClientRect();
                        if (!r.width || !r.height) continue;
                        g.drawImage(c, 0, 0, c.width, c.height,
                            (r.left - cr.left) * sx, (r.top - cr.top) * sy, r.width * sx, r.height * sy);
                    }
                }
                texts.forEach((t) => drawText(t, W, H));

                const c = ensureGL(gl);
                gl.activeTexture(gl.TEXTURE1);
                gl.bindTexture(gl.TEXTURE_2D, c.overlayTex);
                gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
                gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
                gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, overlay);
                gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

                if (!c.outTex || c.w !== W || c.h !== H) {
                    if (c.outTex) gl.deleteTexture(c.outTex);
                    c.outTex = makeTexture(gl, gl.LINEAR, gl.CLAMP_TO_EDGE);
                    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
                    c.w = W;
                    c.h = H;
                }
                gl.bindFramebuffer(gl.FRAMEBUFFER, c.fbo);
                gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, c.outTex, 0);
                gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
                gl.useProgram(c.prog);
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, frame.tex);
                gl.uniform1i(gl.getUniformLocation(c.prog, 'kt_frame'), 0);
                gl.activeTexture(gl.TEXTURE1);
                gl.bindTexture(gl.TEXTURE_2D, c.overlayTex);
                gl.uniform1i(gl.getUniformLocation(c.prog, 'kt_overlay'), 1);
                gl.viewport(0, 0, W, H);
                gl.drawArrays(gl.TRIANGLES, 0, 3);
                gl.activeTexture(gl.TEXTURE0);
                return { tex: c.outTex, w: W, h: H };
            },

            dropGL() { ctx = null; }
        };
    }

    const subtitleCompositor = typeof document !== 'undefined' ? createSubtitleCompositor() : null;

    // ======================================================================
    //  AUTOCROP  (~/.config/mpv/scripts/autocrop-fast.lua, ported)
    // ======================================================================
    // mpv crops baked-in black bars before the chain (retro-base's @autocrop
    // filter), so the tube is fitted to the PICTURE rather than to a 16:9
    // frame with a film inside it. This is that script, with the same options
    // and the same rules, and ffmpeg's cropdetect in place of the filter:
    //
    //   DETECT   a GPU pass marks every row and column of the frame as black
    //            or not -- cropdetect's test exactly: the line's integer
    //            average luma (limited range, so black is 16) above `limit`.
    //            A few KB come back through a PBO and a fence, never a
    //            stalling readPixels. Extents accumulate across frames, as
    //            cropdetect does with reset=0, and the rectangle is rounded
    //            the way cropdetect rounds it.
    //   DECIDE   autocrop-fast's state machine: readings snapped to full
    //            within min_crop, rejected below min_ratio, folded into a
    //            candidate that only grows; committed once it has held still
    //            for settle_time in wall AND playback time; detect_timeout
    //            takes the newest sane reading; then watch_seconds of watching
    //            for wider picture, re-committing on grow_threshold or on the
    //            last tick.
    //   APPLY    the crop is copied out of the frame before the chain, and the
    //            canvas takes the cropped shape, so the tube hugs the picture.
    //            A black matte covers the uncropped video underneath.
    //
    // ONE DIFFERENCE, forced by burn-in: mpv runs cropdetect BEFORE subtitles
    // are burned in, because text in a letterbox bar reads as picture. Here
    // the server burns them in, so the detector skips frames while a subtitle
    // event is on screen, using the event times from Jellyfin's subtitle
    // stream. Gated time does not count toward settling or the deadlines. For
    // image subtitles (PGS), which have no event list, letterbox and pillarbox
    // crops are made symmetric instead, so a subtitle can only make the crop
    // smaller, never off-centre.
    //
    // A result is kept per item, so a stream renegotiation (CRT toggled with
    // subtitles on) does not re-detect.

    const AUTOCROP = {
        limit: 24,              // cropdetect limit=24/255, in 8-bit luma
        round: 2,
        minRatio: 0.5,
        minCrop: 16,
        pollInterval: 0.05,     // s between detector readings
        settleTime: 0.4,
        detectTimeout: 8,
        keepWatching: true,
        watchSeconds: 15,
        growThreshold: 4,
        subtitleMargin: 0.25    // s either side of a subtitle event to skip
    };

    const FS_CROPDETECT = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D kt_src;
uniform ivec2 kt_size;
uniform float kt_limit;
out vec4 kt_out;
// Limited-range luma, as cropdetect reads it from the Y plane: the browser
// has expanded the video to full-range RGB, so map it back.
float kt_y(vec3 c) { return 16.0 + 219.0 * dot(c, vec3(0.2126, 0.7152, 0.0722)); }
void main() {
    int i = int(gl_FragCoord.x);
    bool cols = int(gl_FragCoord.y) == 0;
    int len = cols ? kt_size.y : kt_size.x;
    if (i >= (cols ? kt_size.x : kt_size.y)) { kt_out = vec4(0.0); return; }
    float total = 0.0;
    for (int k = 0; k < len; k++) {
        ivec2 p = cols ? ivec2(i, k) : ivec2(k, i);
        total += floor(kt_y(texelFetch(kt_src, p, 0).rgb) + 0.5);
    }
    // cropdetect: checkline() returns total / len in integer arithmetic.
    kt_out = vec4(floor(total / float(len)) > kt_limit ? 1.0 : 0.0, 0.0, 0.0, 1.0);
}`;

    const FS_CROP_COPY = `#version 300 es
precision highp float;
uniform highp sampler2D kt_src;
uniform ivec2 kt_off;
out vec4 kt_out;
void main() { kt_out = texelFetch(kt_src, ivec2(gl_FragCoord.xy) + kt_off, 0); }`;

    function createAutocrop() {
        let ctx = null;          // GL objects, per context
        const st = { key: null };

        const rectEq = (a, b) => a && b && a.w === b.w && a.h === b.h && a.x === b.x && a.y === b.y;
        const rectStr = (r) => `${r.w}x${r.h}+${r.x}+${r.y}`;

        function align(r) {
            if (AUTOCROP.round > 1) {
                r.w = Math.min(Math.ceil(r.w / AUTOCROP.round) * AUTOCROP.round, st.sw);
                r.h = Math.min(Math.ceil(r.h / AUTOCROP.round) * AUTOCROP.round, st.sh);
            }
            r.x = Math.max(0, Math.min(r.x, st.sw - r.w));
            r.y = Math.max(0, Math.min(r.y, st.sh - r.h));
            return r;
        }

        function rectUnion(a, b) {
            if (!a) return b;
            if (!b) return a;
            const x1 = Math.min(a.x, b.x);
            const y1 = Math.min(a.y, b.y);
            return align({ x: x1, y: y1, w: Math.max(a.x + a.w, b.x + b.w) - x1, h: Math.max(a.y + a.h, b.y + b.h) - y1 });
        }

        const isFull = (r) => r && r.w >= st.sw && r.h >= st.sh;

        function snapToFull(r) {
            if (st.sw - r.w < AUTOCROP.minCrop) { r.w = st.sw; r.x = 0; }
            if (st.sh - r.h < AUTOCROP.minCrop) { r.h = st.sh; r.y = 0; }
            return r;
        }

        function isSane(r) {
            if (r.w < st.sw * AUTOCROP.minRatio || r.h < st.sh * AUTOCROP.minRatio) return false;
            return r.x >= 0 && r.y >= 0 && r.x + r.w <= st.sw && r.y + r.h <= st.sh;
        }

        // cropdetect's rectangle from the accumulated extents, rounded the
        // way it rounds: shrink to a multiple of `round`, offset to even.
        function readDetection() {
            const d = st.det;
            if (!d) return null;
            let w = d.x2 - d.x1 + 1;
            let h = d.y2 - d.y1 + 1;
            if (w <= 0 || h <= 0) return null;
            const round = AUTOCROP.round <= 1 ? 16 : (AUTOCROP.round % 2 ? AUTOCROP.round * 2 : AUTOCROP.round);
            let shrink = w % round;
            w -= shrink;
            let x = (d.x1 + ((shrink >> 1) + 1)) & ~1;
            shrink = h % round;
            h -= shrink;
            let y = (d.y1 + ((shrink >> 1) + 1)) & ~1;
            let r = { x, y, w, h };
            if (st.symmetric) {
                const bx = Math.min(r.x, st.sw - (r.x + r.w));
                const by = Math.min(r.y, st.sh - (r.y + r.h));
                r = { x: bx, y: by, w: st.sw - 2 * bx, h: st.sh - 2 * by };
            }
            return snapToFull(r);
        }

        function noteReading(r, now, pt) {
            r = rectUnion(st.cand, r);
            if (rectEq(r, st.cand)) {
                if (pt != null && (st.candPlay == null || pt < st.candPlay)) st.candPlay = pt;
                return;
            }
            st.cand = r;
            st.candWall = now;
            st.candPlay = pt;
        }

        function settled(now, pt, paused) {
            if (!st.cand) return false;
            if (now - st.candWall < AUTOCROP.settleTime) return false;
            if (!paused) {
                const played = (pt != null && st.candPlay != null) ? pt - st.candPlay : 0;
                if (played < AUTOCROP.settleTime * 0.8) return false;
            }
            return true;
        }

        function apply(r) {
            const prev = st.result;
            st.result = { ...r };
            if (!rectEq(prev, st.result)) {
                st.changed = true;
                LOG(isFull(r) ? 'Autocrop: no bars, full frame' : `Autocrop: ${rectStr(r)} of ${st.sw}x${st.sh}`);
            }
            return true;
        }

        function stopWatching() {
            st.phase = 'done';
        }

        function beginWatching(now) {
            if (!AUTOCROP.keepWatching || isFull(st.result)) { stopWatching(); return; }
            st.phase = 'watching';
            st.watchUntil = now + AUTOCROP.watchSeconds;
        }

        function decide(now, pt, paused) {
            if (st.phase === 'detecting') {
                if (settled(now, pt, paused)) {
                    apply(st.cand);
                    beginWatching(now);
                } else if (now > st.deadline) {
                    if (st.cand) {
                        WARN('Autocrop: detection never settled; using the newest sane reading');
                        apply(st.cand);
                        beginWatching(now);
                    } else {
                        WARN(`Autocrop: no usable crop within ${AUTOCROP.detectTimeout}s; leaving the frame uncropped`);
                        stopWatching();
                    }
                }
                return;
            }
            if (st.phase !== 'watching') return;
            const cur = st.result;
            const expired = !st.watchUntil || now > st.watchUntil;
            if (st.cand && cur && !rectEq(st.cand, cur)) {
                const grew = st.cand.w >= cur.w + AUTOCROP.growThreshold || st.cand.h >= cur.h + AUTOCROP.growThreshold;
                if ((grew && settled(now, pt, paused)) || expired) {
                    LOG(`Autocrop: picture grew, widening ${rectStr(cur)} -> ${rectStr(st.cand)}`);
                    apply(st.cand);
                    if (isFull(st.cand)) { stopWatching(); return; }
                }
            }
            if (expired) stopWatching();
        }

        // Subtitle event times for the burned-in track, so frames carrying a
        // subtitle can be skipped. null = no list (image subtitles): symmetric.
        async function loadSubtitleEvents(forKey) {
            st.events = undefined;
            st.symmetric = false;
            try {
                const session = await ownSession();
                const ps = session?.PlayState;
                if (st.key !== forKey) return;
                if (!session || ps.SubtitleStreamIndex == null || ps.SubtitleStreamIndex < 0) { st.events = []; return; }
                const api = window.ApiClient;
                const url = api.getUrl(`Videos/${session.NowPlayingItem.Id}/${ps.MediaSourceId}/Subtitles/${ps.SubtitleStreamIndex}/0/Stream.js`);
                const data = await api.getJSON(url);
                if (st.key !== forKey) return;
                st.events = (data?.TrackEvents || [])
                    .map((e) => [e.StartPositionTicks / 1e7 - AUTOCROP.subtitleMargin, e.EndPositionTicks / 1e7 + AUTOCROP.subtitleMargin])
                    .sort((a, b) => a[0] - b[0]);
                LOG(`Autocrop: skipping frames under ${st.events.length} subtitle events`);
            } catch (e) {
                if (st.key !== forKey) return;
                st.events = null;
                st.symmetric = true;
                LOG('Autocrop: no subtitle timing for this track (image subtitles?); crops will be symmetric');
            }
        }

        function subtitleOnScreen(pt) {
            const ev = st.events;
            if (!ev || !ev.length || pt == null) return false;
            let lo = 0, hi = ev.length - 1, idx = -1;
            while (lo <= hi) {                       // last event starting at or before pt
                const mid = (lo + hi) >> 1;
                if (ev[mid][0] <= pt) { idx = mid; lo = mid + 1; } else hi = mid - 1;
            }
            // Events can overlap; look back a little for a long one still on.
            for (let i = idx; i >= 0 && i > idx - 8; i--) if (ev[i][1] >= pt) return true;
            return false;
        }

        function ensureGL(gl) {
            if (ctx && ctx.gl === gl) return ctx;
            const prog = (fs) => {
                const vs = compile(gl, gl.VERTEX_SHADER, VS_PASS);
                const f = compile(gl, gl.FRAGMENT_SHADER, fs);
                const p = gl.createProgram();
                gl.attachShader(p, vs);
                gl.attachShader(p, f);
                gl.linkProgram(p);
                if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('autocrop: ' + (gl.getShaderInfoLog(f) || gl.getProgramInfoLog(p)));
                return p;
            };
            ctx = {
                gl,
                detect: prog(FS_CROPDETECT),
                copy: prog(FS_CROP_COPY),
                detectFbo: gl.createFramebuffer(),
                detectTex: null,
                detectLen: 0,
                pbo: gl.createBuffer(),
                cropFbo: gl.createFramebuffer(),
                cropTex: null,
                cropW: 0,
                cropH: 0
            };
            return ctx;
        }

        return {
            get result() { return st.result && !isFull(st.result) ? st.result : null; },
            get phase() { return st.phase || null; },
            get symmetric() { return !!st.symmetric; },

            // Start over for a new item (or on request).
            reset(key, sw, sh, now, burned) {
                Object.assign(st, {
                    key, sw, sh, det: null, cand: null, candWall: 0, candPlay: null,
                    result: null, phase: 'detecting', deadline: now + AUTOCROP.detectTimeout,
                    watchUntil: 0, lastDetect: 0, pending: null, changed: true,
                    events: [], symmetric: false, burnedFor: burned, lastNow: now, lastPt: null
                });
                if (burned) loadSubtitleEvents(key);
            },

            needsReset(key, sw, sh) {
                return key !== st.key || sw !== st.sw || sh !== st.sh;
            },

            // The OSD's item id often arrives after playback starts, when a
            // duration key is already in use: same frame size means the same
            // item, so keep everything detected so far.
            adoptKey(key, sw, sh) {
                if (st.key && st.key.startsWith('dur:') && !key.startsWith('dur:') && sw === st.sw && sh === st.sh) {
                    st.key = key;
                    return true;
                }
                return false;
            },

            // Burn-in can begin mid-file (subtitles switched on): fetch timings then.
            noteBurnState(burned) {
                if (burned && !st.burnedFor && st.phase !== 'done') {
                    st.burnedFor = true;
                    loadSubtitleEvents(st.key);
                }
            },

            takeChanged() {
                const c = !!st.changed;
                st.changed = false;
                return c;
            },

            // Every tick: collect a finished readback, account for skipped
            // time, and run the decision rules.
            update(gl, now, pt, paused) {
                if (!st.key || st.phase === 'done') return;
                const dt = Math.max(0, now - st.lastNow);
                const dpt = (pt != null && st.lastPt != null) ? Math.max(0, pt - st.lastPt) : 0;
                st.lastNow = now;
                st.lastPt = pt;

                // Time spent unable to look -- waiting for the subtitle list,
                // or a subtitle on screen -- proves nothing about the picture,
                // so it counts toward neither settling nor the deadlines.
                if (st.burnedFor && (st.events === undefined || subtitleOnScreen(pt))) {
                    st.candWall += dt;
                    if (st.candPlay != null) st.candPlay += dpt;
                    st.deadline += dt;
                    if (st.watchUntil) st.watchUntil += dt;
                    st.gated = true;
                } else {
                    st.gated = false;
                }

                if (st.pending && ctx) {
                    const status = gl.clientWaitSync(st.pending.fence, 0, 0);
                    if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) {
                        const { fence, len, w, h, pt: framePt } = st.pending;
                        st.pending = null;
                        gl.deleteSync(fence);
                        const bytes = new Uint8Array(len * 2 * 4);
                        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, ctx.pbo);
                        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, bytes);
                        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
                        if (w === st.sw && h === st.sh) this._ingest(bytes, len, w, h, now, framePt);
                    }
                }
                decide(now, pt, paused);
            },

            _ingest(bytes, len, w, h, now, pt) {
                // Row 0 of the readback is the columns, row 1 the rows; a
                // texel's R is 255 where that line is picture.
                const col = (x) => bytes[x * 4] > 127;
                const row = (y) => bytes[(len + y) * 4] > 127;
                let x1 = -1, x2 = -1, y1 = -1, y2 = -1;
                for (let x = 0; x < w; x++) if (col(x)) { x1 = x; break; }
                for (let x = w - 1; x >= 0; x--) if (col(x)) { x2 = x; break; }
                for (let y = 0; y < h; y++) if (row(y)) { y1 = y; break; }
                for (let y = h - 1; y >= 0; y--) if (row(y)) { y2 = y; break; }
                if (x1 >= 0 && y1 >= 0) {
                    // cropdetect reset=0: the extents only ever widen.
                    const d = st.det;
                    st.det = d ? { x1: Math.min(d.x1, x1), x2: Math.max(d.x2, x2), y1: Math.min(d.y1, y1), y2: Math.max(d.y2, y2) }
                               : { x1, x2, y1, y2 };
                }
                const r = readDetection();
                if (r && isSane(r)) noteReading(r, now, pt);
            },

            // After a new frame is uploaded: measure it, unless one is in
            // flight, it is too soon, or a subtitle is on screen.
            afterUpload(gl, srcTex, w, h, now, pt) {
                if (!st.key || st.phase === 'done' || st.pending || st.gated) return;
                if (now - st.lastDetect < AUTOCROP.pollInterval) return;
                st.lastDetect = now;
                const c = ensureGL(gl);
                const len = Math.max(w, h);
                if (c.detectLen !== len) {
                    if (c.detectTex) gl.deleteTexture(c.detectTex);
                    c.detectTex = makeTexture(gl, gl.NEAREST, gl.CLAMP_TO_EDGE);
                    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, len, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
                    c.detectLen = len;
                    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, c.pbo);
                    gl.bufferData(gl.PIXEL_PACK_BUFFER, len * 2 * 4, gl.STREAM_READ);
                    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
                }
                gl.bindFramebuffer(gl.FRAMEBUFFER, c.detectFbo);
                gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, c.detectTex, 0);
                gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
                gl.useProgram(c.detect);
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, srcTex);
                gl.uniform1i(gl.getUniformLocation(c.detect, 'kt_src'), 0);
                gl.uniform2i(gl.getUniformLocation(c.detect, 'kt_size'), w, h);
                gl.uniform1f(gl.getUniformLocation(c.detect, 'kt_limit'), AUTOCROP.limit);
                gl.viewport(0, 0, len, 2);
                gl.drawArrays(gl.TRIANGLES, 0, 3);
                gl.bindBuffer(gl.PIXEL_PACK_BUFFER, c.pbo);
                gl.readPixels(0, 0, len, 2, gl.RGBA, gl.UNSIGNED_BYTE, 0);
                gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
                st.pending = { fence: gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0), len, w, h, pt };
                gl.flush();
            },

            // The frame the chain sees: the crop copied out, or the frame.
            source(gl, frame) {
                const r = this.result;
                if (!r) return frame;
                const c = ensureGL(gl);
                if (!c.cropTex || c.cropW !== r.w || c.cropH !== r.h) {
                    if (c.cropTex) gl.deleteTexture(c.cropTex);
                    c.cropTex = makeTexture(gl, gl.LINEAR, gl.CLAMP_TO_EDGE);
                    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, r.w, r.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
                    c.cropW = r.w;
                    c.cropH = r.h;
                }
                gl.bindFramebuffer(gl.FRAMEBUFFER, c.cropFbo);
                gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, c.cropTex, 0);
                gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
                gl.useProgram(c.copy);
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, frame.tex);
                gl.uniform1i(gl.getUniformLocation(c.copy, 'kt_src'), 0);
                gl.uniform2i(gl.getUniformLocation(c.copy, 'kt_off'), r.x, r.y);
                gl.viewport(0, 0, r.w, r.h);
                gl.drawArrays(gl.TRIANGLES, 0, 3);
                return { tex: c.cropTex, w: r.w, h: r.h };
            },

            dropGL() {
                ctx = null;
                st.pending = null;
            },

            clear() {
                st.result = null;
                st.phase = 'done';
                st.changed = true;
            }
        };
    }

    const autocrop = createAutocrop();

    // Which item is playing, so a result survives a stream renegotiation but
    // not the next episode. The OSD carries the item id on its rating button;
    // the duration stands in until it does.
    function currentItemKey() {
        const id = document.querySelector('#videoOsdPage .btnUserRating[data-id]')?.getAttribute('data-id');
        return id || (video && Number.isFinite(video.duration) ? `dur:${Math.round(video.duration)}` : null);
    }

    // ======================================================================
    //  HOST: canvas, video, render loop
    // ======================================================================

    let canvas = null;
    let matte = null;       // black backdrop over the uncropped video
    let gl = null;
    let pipeline = null;
    let pipelineKey = null;
    let pipelinePromise = null;
    let srcTex = null;
    let srcW = 0;
    let srcH = 0;

    let video = null;
    let rafId = 0;
    let vfcId = 0;
    let resizeObserver = null;
    let frameDirty = true;
    let layoutDirty = true;
    let lastField = -1;
    let lastObjectFit = null;
    let startToken = 0;
    const clock = createFieldClock();
    const hasVfc = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

    function ensureContext() {
        if (gl && !gl.isContextLost()) return true;

        canvas = document.createElement('canvas');
        canvas.className = 'kefinCrtCanvas';
        canvas.style.cssText = 'position:absolute;pointer-events:none;display:block;margin:0;padding:0;';
        canvas.addEventListener('webglcontextlost', (e) => {
            e.preventDefault();
            WARN('WebGL context lost; switching the CRT layer off for this video');
            dropContext();
            stop();
        });

        gl = canvas.getContext('webgl2', {
            alpha: false,
            antialias: false,
            depth: false,
            stencil: false,
            premultipliedAlpha: false,
            preserveDrawingBuffer: false,
            powerPreference: 'high-performance'
        });
        if (!gl) {
            canvas = null;
            return false;
        }
        srcTex = makeTexture(gl, gl.LINEAR, gl.CLAMP_TO_EDGE);
        autocrop.dropGL();
        if (subtitleCompositor) subtitleCompositor.dropGL();

        // Under the canvas, over the video: with a crop the canvas no longer
        // covers the whole picture, and the video's own bars -- with any
        // burned-in subtitle sitting in them -- would show around the tube.
        matte = document.createElement('div');
        matte.className = 'kefinCrtMatte';
        matte.style.cssText = 'position:absolute;inset:0;background:#000;pointer-events:none;';
        return true;
    }

    function dropContext() {
        if (canvas) canvas.remove();
        if (matte) matte.remove();
        canvas = null;
        matte = null;
        autocrop.dropGL();
        gl = null;
        pipeline = null;
        pipelineKey = null;
        pipelinePromise = null;
        srcTex = null;
        srcW = srcH = 0;
    }

    function wantedKey() {
        return engineName === 'fused' ? 'fused' : `mpv:${profileName}`;
    }

    function ensurePipeline() {
        const key = wantedKey();
        if (pipeline && pipelineKey === key) return Promise.resolve(pipeline);
        if (pipelinePromise && pipelinePromise.key === key) return pipelinePromise;

        const glAtStart = gl;
        const p = (key === 'fused' ? createFusedPipeline(gl) : createMpvPipeline(gl, profileName)).then((pl) => {
            if (gl !== glAtStart) throw new Error('WebGL context replaced while building');
            if (pipeline) pipeline.dispose();
            pipeline = pl;
            pipelineKey = key;
            return pl;
        }).finally(() => {
            if (pipelinePromise === p) pipelinePromise = null;
        });
        p.key = key;
        pipelinePromise = p;
        return p;
    }

    // The canvas covers the PICTURE, not the element: under the default
    // object-fit (contain) that excludes the letterbox, so the tube's
    // curvature and border sit on the video's own edges, like mpv's OUTPUT
    // rectangle. Rounded OUTWARD to whole device pixels -- the shader lays
    // the phosphor mask out in those pixels, and the video still paints under
    // the canvas, so a canvas even half a pixel short leaves a seam of raw
    // video along that edge.
    function updateLayout() {
        // The picture is the crop when there is one: its shape is fitted to
        // the element, as mpv fits the cropped video to the window.
        const crop = autocrop.result;
        const vw = crop ? crop.w : video.videoWidth;
        const vh = crop ? crop.h : video.videoHeight;
        const ew = video.clientWidth;
        const eh = video.clientHeight;
        if (!vw || !vh || !ew || !eh) return false;

        const fit = video.style.objectFit || 'contain';
        let w, h;
        if (fit === 'fill') {
            w = ew; h = eh;
        } else {
            const s = fit === 'cover' ? Math.max(ew / vw, eh / vh) : Math.min(ew / vw, eh / vh);
            w = vw * s; h = vh * s;
        }

        const dpr = window.devicePixelRatio || 1;
        let x0 = Math.floor((video.offsetLeft + (ew - w) / 2) * dpr);
        let y0 = Math.floor((video.offsetTop + (eh - h) / 2) * dpr);
        let pw = Math.max(1, Math.ceil((video.offsetLeft + (ew + w) / 2) * dpr) - x0);
        let ph = Math.max(1, Math.ceil((video.offsetTop + (eh + h) / 2) * dpr) - y0);

        // Up to a multiple of 16, centred. crt-royale sizes its mask-resize
        // buffers at OUTPUT * 0.0625 and tiles them assuming that is a whole
        // number; when it is not, the size rounds and every tile boundary
        // shows as a dark seam (measured: 633 px tall seams every 40 px, 640
        // is clean). mpv does the same at such sizes. A 3840x2160 picture is
        // already a multiple, so fullscreen 16:9 at 4K is untouched; anywhere
        // else the canvas overhangs the picture by at most 8 px a side.
        const cw = Math.ceil(pw / 16) * 16;
        const ch = Math.ceil(ph / 16) * 16;
        x0 -= (cw - pw) >> 1;
        y0 -= (ch - ph) >> 1;
        pw = cw;
        ph = ch;

        canvas.style.left = `${x0 / dpr}px`;
        canvas.style.top = `${y0 / dpr}px`;
        canvas.style.width = `${pw / dpr}px`;
        canvas.style.height = `${ph / dpr}px`;
        if (canvas.width !== pw) canvas.width = pw;
        if (canvas.height !== ph) canvas.height = ph;
        lastObjectFit = video.style.objectFit;
        return true;
    }

    // The decoded frame as MAIN sees it in mpv: code values at the video's
    // own size. UNPACK_COLORSPACE_CONVERSION is off so the browser does not
    // remap the transfer function on the way in -- the chain linearizes it
    // itself, as BT.1886.
    function uploadFrame() {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, srcTex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (w !== srcW || h !== srcH) {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, video);
            srcW = w;
            srcH = h;
        } else {
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, video);
        }
    }

    function onVideoFrame() {
        frameDirty = true;
        if (video && rafId) vfcId = video.requestVideoFrameCallback(onVideoFrame);
    }

    function tick(now) {
        rafId = 0;
        if (!video || !canvas || !pipeline) return;
        if (!video.isConnected) {
            LOG('Video element removed; CRT layer detached');
            stop();
            return;
        }
        rafId = requestAnimationFrame(tick);

        const field = clock.tick(now);
        updateDisplay();
        checkSubtitleDelivery(now);

        // HAVE_CURRENT_DATA: there is a frame to upload.
        if (video.readyState < 2 || !video.videoWidth) return;

        // Autocrop: a new item (or size) starts detection over; readings and
        // decisions run every tick, timed in seconds.
        const nowS = now / 1000;
        const pt = Number.isFinite(video.currentTime) ? video.currentTime : null;
        const key = currentItemKey();
        if (key && autocrop.needsReset(key, video.videoWidth, video.videoHeight)) {
            if (!autocrop.adoptKey(key, video.videoWidth, video.videoHeight)) {
                autocrop.reset(key, video.videoWidth, video.videoHeight, nowS, !!burnIn.lastBurned);
            }
        }
        autocrop.noteBurnState(!!burnIn.lastBurned);
        autocrop.update(gl, nowS, pt, video.paused);
        if (autocrop.takeChanged()) layoutDirty = true;

        // Jellyfin's aspect-ratio setting is an inline object-fit, so a string
        // compare catches it without a style recalc.
        if (video.style.objectFit !== lastObjectFit) layoutDirty = true;
        if (!hasVfc && !video.paused) frameDirty = true;

        let ranMain = false;
        if (field !== lastField || layoutDirty || !srcW) {
            if (layoutDirty) {
                if (!updateLayout()) return;
                layoutDirty = false;
            }
            if (frameDirty || !srcW) {
                try {
                    uploadFrame();
                } catch (err) {
                    ERR('Could not read the video frame:', err);
                    notify('CRT: this video cannot be read by WebGL');
                    stop();
                    return;
                }
                frameDirty = false;
                autocrop.afterUpload(gl, srcTex, srcW, srcH, nowS, pt);
            }
            let frame = { tex: srcTex, w: srcW, h: srcH };
            if (subtitleMode === 'composite' && subtitleCompositor) frame = subtitleCompositor.composite(gl, video, frame);
            const source = autocrop.source(gl, frame);
            pipeline.runMain(source, canvas.width, canvas.height, field);
            lastField = field;
            ranMain = true;
        }
        if (ranMain || pipeline.outputActive) pipeline.present(canvas.width, canvas.height);
    }

    function findVideo() {
        return document.querySelector('.videoPlayerContainer video.htmlvideoplayer');
    }

    // The video element can turn up a moment after the #/video page shows, so
    // look for it for a few seconds before giving up.
    function waitForVideo(token) {
        return new Promise((resolve) => {
            const deadline = performance.now() + 10000;
            const look = () => {
                if (token !== startToken) { resolve(null); return; }
                const el = findVideo();
                if (el) { resolve(el); return; }
                if (performance.now() > deadline) { resolve(null); return; }
                setTimeout(look, 250);
            };
            look();
        });
    }

    async function start() {
        const token = ++startToken;
        if (video && rafId) return;

        const el = await waitForVideo(token);
        if (!el || token !== startToken || !enabled) return;

        if (!ensureContext()) {
            ERR('WebGL2 is not available in this browser');
            notify('CRT: WebGL2 is not available in this browser');
            setEnabled(false);
            return;
        }

        updateButtons('loading');
        try {
            await ensurePipeline();
        } catch (err) {
            ERR('Shader failed to build:', err.message || err);
            if (err.fsSource) window.KefinTweaksCrt._lastFailedSource = err.fsSource;
            notify('CRT: the shader failed to build (details in the console)');
            if (gl && gl.isContextLost()) dropContext();
            setEnabled(false);
            return;
        }
        if (token !== startToken || !enabled || !el.isConnected) { updateButtons(); return; }

        video = el;
        video.after(matte);
        matte.after(canvas);
        setCompositingClass();
        frameDirty = true;
        layoutDirty = true;
        lastField = -1;
        lastObjectFit = null;
        srcW = srcH = 0;            // force a texImage2D for the new element
        clock.reset(performance.now());
        lastDisplayKey = '';

        resizeObserver = new ResizeObserver(() => { layoutDirty = true; });
        resizeObserver.observe(video);
        video.addEventListener('resize', onVideoResize);
        window.addEventListener('resize', onVideoResize);

        rafId = requestAnimationFrame(tick);
        if (hasVfc) vfcId = video.requestVideoFrameCallback(onVideoFrame);
        updateButtons();
        LOG(`CRT layer on: ${pipeline.profile}, ${pipeline.passCount} passes`);
    }

    function onVideoResize() {
        layoutDirty = true;
    }

    // The panel the window is on, in device pixels, and its refresh period.
    // screen.* follows the window to another monitor, and devicePixelRatio
    // turns its CSS size into real pixels (fractional scaling included).
    let lastDisplayKey = '';
    function currentDisplay() {
        const dpr = window.devicePixelRatio || 1;
        return {
            panelLines: Math.round((window.screen?.height || 2160) * dpr),
            panelWidth: Math.round((window.screen?.width || 3840) * dpr),
            refreshMs: clock.periodMs || 0
        };
    }

    function updateDisplay() {
        const d = currentDisplay();
        const key = `${d.panelWidth}x${d.panelLines}@${d.refreshMs.toFixed(2)}`;
        if (key === lastDisplayKey) return;
        const panelChanged = !lastDisplayKey.startsWith(`${d.panelWidth}x${d.panelLines}@`);
        lastDisplayKey = key;
        pipeline.setDisplay(d);
        if (panelChanged) LOG(`Panel ${d.panelWidth}x${d.panelLines}: phosphor triads scaled by ${(d.panelLines / DISPLAY_REF_LINES).toFixed(3)} from the 2160-line tuning`);
    }

    function stop() {
        startToken++;
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
        if (video) {
            if (vfcId && 'cancelVideoFrameCallback' in video) video.cancelVideoFrameCallback(vfcId);
            video.removeEventListener('resize', onVideoResize);
        }
        vfcId = 0;
        window.removeEventListener('resize', onVideoResize);
        if (resizeObserver) resizeObserver.disconnect();
        resizeObserver = null;
        if (canvas) canvas.remove();
        if (matte) matte.remove();
        if (video && video.parentNode) video.parentNode.classList.remove('kefinCrtCompositing');
        video = null;
        updateButtons();
    }

    // Jellyfin's own subtitle layers are hidden while they are composited:
    // opacity rather than display, so they keep rendering and keep their
    // on-screen geometry for the mapping.
    function setCompositingClass() {
        if (video && video.parentNode) video.parentNode.classList.toggle('kefinCrtCompositing', subtitleMode === 'composite');
    }

    function setEnabled(value) {
        const burningVideo = burnIn.lastBurned ? findVideo() : null;
        enabled = value;
        if (value) start();
        else stop();
        updateButtons();
        // Turning on is handled by the render loop once the layer is up (it
        // sees the client subtitles). Turning off has no loop left to do it,
        // so hand the stream back to client-side subtitles -- after a grace
        // period, cancelled if CRT comes back on first.
        clearTimeout(burnIn.offTimer);
        burnIn.offTimer = 0;
        if (!value && burningVideo) {
            burnIn.offTimer = setTimeout(() => {
                burnIn.offTimer = 0;
                // Still off, still the same video, and its stream still burned in.
                if (enabled || !burnIn.lastBurned || findVideo() !== burningVideo) return;
                renegotiateStream('CRT turned off; subtitles back to the web player');
            }, BURN_HANDBACK_DELAY_MS);
        }
    }

    // Switching engine or profile rebuilds on the running video.
    function restartIfRunning() {
        if (!enabled) return;
        stop();
        start();
    }

    // The OSD button cycles these, as retro-toggle.lua does on ctrl+r in mpv:
    // off -> retro-super -> retro-kurozumi-super -> off. Off is the default,
    // and coming back from off always starts at retro-super.
    const CRT_MODES = ['off', 'retro-super', 'retro-kurozumi-super'];
    const MODE_LABELS = { 'off': 'off', 'retro-super': 'super', 'retro-kurozumi-super': 'kurozumi' };
    const MODE_ICONS = { 'off': 'tv_off', 'retro-super': 'tv', 'retro-kurozumi-super': 'live_tv' };

    function currentMode() {
        return enabled ? profileName : 'off';
    }

    function setMode(mode) {
        if (mode === 'off') {
            setEnabled(false);
            return;
        }
        const changed = profileName !== mode;
        profileName = mode;
        writePref(PROFILE_KEY, mode);
        if (!enabled) setEnabled(true);
        else if (changed) restartIfRunning();
        updateButtons();
    }

    function cycleMode() {
        // A profile set from the console that is not in the cycle goes to off.
        const i = CRT_MODES.indexOf(currentMode());
        setMode(CRT_MODES[i < 0 ? 0 : (i + 1) % CRT_MODES.length]);
    }

    // ======================================================================
    //  OSD BUTTON
    // ======================================================================

    function updateButtons(state) {
        document.querySelectorAll(`.${BUTTON_CLASS}`).forEach((btn) => {
            const mode = currentMode();
            const icon = btn.querySelector('.material-icons');
            if (icon) {
                Object.values(MODE_ICONS).forEach((c) => icon.classList.remove(c));
                icon.classList.add(MODE_ICONS[mode] || 'tv');
            }
            btn.classList.toggle('kefinCrtLoading', state === 'loading');
            btn.title = state === 'loading'
                ? `CRT: ${MODE_LABELS[mode] || mode} (compiling shaders...)`
                : `CRT: ${MODE_LABELS[mode] || mode}`;
        });
    }

    function ensureButton(attempt = 0) {
        const container = document.querySelector('#videoOsdPage:not(.hide) .osdControls > .buttons')
            || document.querySelector('.videoOsdBottom .osdControls > .buttons');
        if (!container) {
            if (attempt < 20) setTimeout(() => ensureButton(attempt + 1), 250);
            return;
        }
        if (container.querySelector(`.${BUTTON_CLASS}`)) { updateButtons(); return; }

        const button = document.createElement('button');
        button.setAttribute('is', 'paper-icon-button-light');
        button.className = `${BUTTON_CLASS} autoSize paper-icon-button-light`;
        const icon = document.createElement('span');
        icon.className = 'xlargePaperIconButton material-icons';
        icon.setAttribute('aria-hidden', 'true');
        button.appendChild(icon);
        button.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            cycleMode();
        });

        const settings = container.querySelector('.btnVideoOsdSettings');
        if (settings) container.insertBefore(button, settings);
        else container.appendChild(button);
        updateButtons();
    }

    function injectStyles() {
        if (document.getElementById('kefin-crt-styles')) return;
        const style = document.createElement('style');
        style.id = 'kefin-crt-styles';
        style.textContent = `
            .${BUTTON_CLASS}.kefinCrtLoading .material-icons {
                animation: kefinCrtPulse 1s ease-in-out infinite alternate;
            }
            @keyframes kefinCrtPulse { from { opacity: 1; } to { opacity: 0.35; } }
            .kefinCrtCompositing .videoSubtitles,
            .kefinCrtCompositing .libassjs-canvas-parent,
            .kefinCrtCompositing > canvas:not(.kefinCrtCanvas),
            .kefinCrtCompositing > div > canvas:not(.kefinCrtCanvas) {
                opacity: 0 !important;
            }
        `;
        document.head.appendChild(style);
    }

    // ======================================================================
    //  INIT
    // ======================================================================

    function onVideoPage() {
        ensureButton();
        if (enabled) start();
    }

    function init() {
        if (!window.KefinTweaksUtils?.onViewPage) {
            setTimeout(init, 500);
            return;
        }
        injectStyles();
        window.KefinTweaksUtils.onViewPage((view, element, hash) => {
            if (hash && hash.includes('#/video')) onVideoPage();
        }, { pages: ['video'] });
        LOG(`Initialized (CRT ${enabled ? 'on' : 'off'} on this browser; ${engineName === 'fused' ? 'fused' : profileName})`);
    }

    window.KefinTweaksCrt = {
        enable: () => setEnabled(true),
        disable: () => setEnabled(false),
        setProfile(name) {
            profileName = name;
            writePref(PROFILE_KEY, name);
            restartIfRunning();
            updateButtons();
            return name;
        },
        cycle: () => { cycleMode(); return currentMode(); },
        setEngine(name) {
            if (name !== 'mpv' && name !== 'fused') throw new Error("engine is 'mpv' or 'fused'");
            engineName = name;
            writePref(ENGINE_KEY, name);
            restartIfRunning();
            return name;
        },
        status: () => ({
            enabled,
            engine: pipeline?.engine ?? null,
            profile: pipeline?.profile ?? null,
            passes: pipeline?.passCount ?? null,
            attached: !!(video && canvas && canvas.isConnected),
            canvas: canvas ? `${canvas.width}x${canvas.height}` : null,
            source: srcW ? `${srcW}x${srcH}` : null,
            refreshHz: clock.periodMs ? +(1000 / clock.periodMs).toFixed(2) : null,
            panel: lastDisplayKey.split('@')[0] || null,
            fieldsLockedTo: clock.locked || null,
            outputStageActive: pipeline ? !!pipeline.outputActive : null,
            subtitleMode,
            subtitleSources: subtitleCompositor ? subtitleCompositor.sources : null,
            subtitlesBurnedIn: burnIn.lastBurned,
            autocrop: autocrop.result ? `${autocrop.result.w}x${autocrop.result.h}+${autocrop.result.x}+${autocrop.result.y}` : 'none',
            autocropPhase: autocrop.phase,
            autocropSymmetric: autocrop.symmetric
        }),
        // shift+C / shift+X in autocrop-fast.lua
        redetectCrop() {
            if (video) autocrop.reset(currentItemKey(), video.videoWidth, video.videoHeight, performance.now() / 1000, !!burnIn.lastBurned);
        },
        clearCrop() { autocrop.clear(); },
        // 'burn' (default) or 'composite'. The render loop renegotiates the
        // stream when the current delivery does not match.
        setSubtitleMode(mode) {
            if (mode !== 'composite' && mode !== 'burn') throw new Error("subtitle mode is 'composite' or 'burn'");
            subtitleMode = mode;
            writePref(SUBTITLE_MODE_KEY, mode);
            setCompositingClass();
            burnIn.lastCheck = 0;
            return mode;
        },
        // For tests: build a pipeline on any WebGL2 context.
        _createPipeline: (ctx, engine, profile) => (engine === 'fused' ? createFusedPipeline(ctx) : createMpvPipeline(ctx, profile || DEFAULT_PROFILE)),
        _createFieldClock: createFieldClock,
        _loadMpvProfile: loadMpvProfile,
        _sourceKey: sourceKey,
        _parseRetroConf: parseRetroConf
    };

    init();
})();
