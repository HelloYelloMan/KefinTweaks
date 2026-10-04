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
// The enabled state, engine and profile are per browser (localStorage).
// Console: KefinTweaksCrt.status(), .setProfile(name), .setEngine('mpv'|'fused').

(function () {
    'use strict';

    const LOG  = (...args) => console.log('[KefinTweaks CRT]', ...args);
    const WARN = (...args) => console.warn('[KefinTweaks CRT]', ...args);
    const ERR  = (...args) => console.error('[KefinTweaks CRT]', ...args);

    const STORAGE_KEY = 'kefinTweaks_crtShader';
    const PROFILE_KEY = 'kefinTweaks_crtProfile';
    const ENGINE_KEY  = 'kefinTweaks_crtEngine';
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

    let enabled = readPref(STORAGE_KEY, '0') === '1';
    let profileName = readPref(PROFILE_KEY, DEFAULT_PROFILE);
    let engineName = readPref(ENGINE_KEY, DEFAULT_ENGINE);

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
        const MEASURE = 90;        // deltas to measure (~0.4 s at 240 Hz)
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
                        // Mean of the middle half: robust to jitter and to the
                        // odd dropped frame.
                        const sorted = samples.slice().sort((a, b) => a - b);
                        const mid = sorted.slice(MEASURE >> 2, MEASURE - (MEASURE >> 2));
                        period = mid.reduce((a, b) => a + b, 0) / mid.length;
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
                if (steps === 1 && Math.abs(d - period) < 0.2 * period) period += (d - period) * 0.01;

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
    //  HOST: canvas, video, render loop
    // ======================================================================

    let canvas = null;
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
        return true;
    }

    function dropContext() {
        if (canvas) canvas.remove();
        canvas = null;
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
        const vw = video.videoWidth;
        const vh = video.videoHeight;
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
        const x0 = Math.floor((video.offsetLeft + (ew - w) / 2) * dpr);
        const y0 = Math.floor((video.offsetTop + (eh - h) / 2) * dpr);
        const pw = Math.max(1, Math.ceil((video.offsetLeft + (ew + w) / 2) * dpr) - x0);
        const ph = Math.max(1, Math.ceil((video.offsetTop + (eh + h) / 2) * dpr) - y0);

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
        if (clock.periodMs) pipeline.setHostParam('persist_tick_ms', clock.periodMs);

        // HAVE_CURRENT_DATA: there is a frame to upload.
        if (video.readyState < 2 || !video.videoWidth) return;

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
            }
            pipeline.runMain({ tex: srcTex, w: srcW, h: srcH }, canvas.width, canvas.height, field);
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
        video.after(canvas);
        frameDirty = true;
        layoutDirty = true;
        lastField = -1;
        lastObjectFit = null;
        srcW = srcH = 0;            // force a texImage2D for the new element
        clock.reset(performance.now());

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
        video = null;
        updateButtons();
    }

    function setEnabled(value) {
        enabled = value;
        writePref(STORAGE_KEY, value ? '1' : '0');
        if (value) start();
        else stop();
        updateButtons();
    }

    // Switching engine or profile rebuilds on the running video.
    function restartIfRunning() {
        if (!enabled) return;
        stop();
        start();
    }

    // ======================================================================
    //  OSD BUTTON
    // ======================================================================

    function updateButtons(state) {
        document.querySelectorAll(`.${BUTTON_CLASS}`).forEach((btn) => {
            const icon = btn.querySelector('.material-icons');
            if (icon) {
                icon.classList.toggle('tv', enabled);
                icon.classList.toggle('tv_off', !enabled);
            }
            btn.classList.toggle('kefinCrtLoading', state === 'loading');
            btn.title = state === 'loading' ? 'CRT (compiling shaders...)' : (enabled ? 'CRT: on' : 'CRT: off');
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
            setEnabled(!enabled);
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
            return name;
        },
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
            fieldsLockedTo: clock.locked || null,
            outputStageActive: pipeline ? !!pipeline.outputActive : null
        }),
        // For tests: build a pipeline on any WebGL2 context.
        _createPipeline: (ctx, engine, profile) => (engine === 'fused' ? createFusedPipeline(ctx) : createMpvPipeline(ctx, profile || DEFAULT_PROFILE)),
        _createFieldClock: createFieldClock,
        _loadMpvProfile: loadMpvProfile,
        _sourceKey: sourceKey,
        _parseRetroConf: parseRetroConf
    };

    init();
})();
