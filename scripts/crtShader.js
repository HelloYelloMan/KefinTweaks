// KefinTweaks CRT Shader
// Runs the retro CRT chain over the web player's video, toggled from a button
// on the video OSD.
//
// The shader is crtShader.frag.txt: the mpv [retro-super] chain fused into one
// fragment shader, forked from ~/.config/hypr/shaders/crt-royale-hypr.frag. It
// was written for Hyprland's screen_shader, which is GLSL ES 3.00 -- the same
// language WebGL2 speaks -- so this file only has to be its host: upload each
// video frame to a texture, and draw the shader into a canvas laid exactly
// over the picture. Its header lists the few edits the web copy carries.
//
// LAYERING. The canvas is inserted directly after the <video>, absolutely
// positioned, with pointer-events off:
//   - it paints over the video, which keeps decoding underneath it;
//   - clicks fall through to the video, so click-to-pause and double-click
//     fullscreen still work;
//   - the custom subtitle element, libass and PGS canvases are added to the
//     player container AFTER the video, so they stay on top, unprocessed.
//     Native <track> cues are drawn by the video element itself and so end up
//     UNDER the canvas -- they are not in the frame texImage2D uploads either.
//
// WHEN IT DRAWS. Not every refresh. The picture only changes when a new video
// frame arrives or the field counter (time * 59.94, which drives the interlace
// bob and dot crawl) ticks over, so on a 240 Hz panel this draws about 60
// times a second rather than 240. That is the same field rate mpv gets from
// vf=fps=60000/1001.
//
// The enabled state is per browser (localStorage), like a player setting.

(function () {
    'use strict';

    const LOG  = (...args) => console.log('[KefinTweaks CRT]', ...args);
    const WARN = (...args) => console.warn('[KefinTweaks CRT]', ...args);
    const ERR  = (...args) => console.error('[KefinTweaks CRT]', ...args);

    const STORAGE_KEY = 'kefinTweaks_crtShader';
    const SHADER_PATH = 'scripts/crtShader.frag.txt';
    const FIELD_RATE  = 59.9400598;       // must match the shader's FIELD_RATE
    const BUTTON_CLASS = 'btnKefinCrt';

    // A full-screen triangle from gl_VertexID, so there is no vertex buffer.
    // v_texcoord runs 0..1 with v = 0 at the TOP of the canvas, matching the
    // texture: texImage2D without UNPACK_FLIP_Y puts the video's top row at
    // v = 0, and the shader samples tex with the same coordinates it uses for
    // geometry, so the two only have to agree with each other.
    const VERTEX_SOURCE = `#version 300 es
out vec2 v_texcoord;
void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    v_texcoord = vec2(p.x, 1.0 - p.y);
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

    let enabled = readEnabled();
    let fragmentSourcePromise = null;

    // GL state lives for the page, not for one playback: the fragment shader
    // is ~2000 lines and slow to compile, so the canvas and program are kept
    // and re-attached to the next video rather than rebuilt.
    let canvas = null;
    let gl = null;
    let program = null;
    let programPromise = null;
    let texture = null;
    let uniforms = null;
    let texW = 0;
    let texH = 0;

    // Per-playback state.
    let video = null;
    let rafId = 0;
    let vfcId = 0;
    let resizeObserver = null;
    let frameDirty = true;
    let layoutDirty = true;
    let lastField = -1;
    let lastObjectFit = null;
    let t0 = 0;
    let startToken = 0;

    // --------------------------------------------------
    //  PREFERENCE
    // --------------------------------------------------

    function readEnabled() {
        try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch (e) { return false; }
    }

    function writeEnabled(value) {
        try { localStorage.setItem(STORAGE_KEY, value ? '1' : '0'); } catch (e) { /* private window */ }
    }

    function notify(message) {
        window.KefinTweaksToaster?.toast?.(message);
    }

    // --------------------------------------------------
    //  SHADER SOURCE + PROGRAM
    // --------------------------------------------------

    function getRoot() {
        const cfg = window.KefinTweaksConfig || {};
        const raw = cfg.kefinTweaksRootResolved || cfg.kefinTweaksRoot || '';
        if (!raw) return null;
        return raw.endsWith('/') ? raw : `${raw}/`;
    }

    function loadFragmentSource() {
        if (!fragmentSourcePromise) {
            const root = getRoot();
            if (!root) return Promise.reject(new Error('kefinTweaksRoot is not set'));
            fragmentSourcePromise = fetch(root + SHADER_PATH, { cache: 'no-cache' })
                .then((res) => {
                    if (!res.ok) throw new Error(`shader fetch ${res.status}`);
                    return res.text();
                })
                .catch((err) => {
                    fragmentSourcePromise = null;   // let the next toggle retry
                    throw err;
                });
        }
        return fragmentSourcePromise;
    }

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
        return true;
    }

    function dropContext() {
        if (canvas) canvas.remove();
        canvas = null;
        gl = null;
        program = null;
        programPromise = null;
        texture = null;
        uniforms = null;
        texW = texH = 0;
    }

    function compileShader(type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        return shader;
    }

    // Compiles and links WITHOUT blocking on the result where the browser
    // allows it. KHR_parallel_shader_compile lets us poll COMPLETION_STATUS
    // instead of stalling the main thread -- with this shader, a stall long
    // enough to freeze the OSD. Status and logs are read only after it reports
    // complete, because reading them is what forces the wait.
    function buildProgram() {
        if (programPromise) return programPromise;
        const glAtStart = gl;

        programPromise = loadFragmentSource().then((fragSource) => new Promise((resolve, reject) => {
            if (gl !== glAtStart) { reject(new Error('context replaced during load')); return; }

            const started = performance.now();
            const vs = compileShader(gl.VERTEX_SHADER, VERTEX_SOURCE);
            const fs = compileShader(gl.FRAGMENT_SHADER, fragSource);
            const prog = gl.createProgram();
            gl.attachShader(prog, vs);
            gl.attachShader(prog, fs);
            gl.linkProgram(prog);

            const parallel = gl.getExtension('KHR_parallel_shader_compile');

            const finish = () => {
                if (gl !== glAtStart) { reject(new Error('context replaced during compile')); return; }
                if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
                    const log = gl.getShaderInfoLog(fs) || gl.getShaderInfoLog(vs) || gl.getProgramInfoLog(prog) || 'unknown error';
                    reject(new Error(log));
                    return;
                }
                gl.deleteShader(vs);
                gl.deleteShader(fs);

                program = prog;
                gl.useProgram(program);
                uniforms = {
                    tex: gl.getUniformLocation(program, 'tex'),
                    fullSize: gl.getUniformLocation(program, 'fullSize'),
                    srcSize: gl.getUniformLocation(program, 'srcSize'),
                    time: gl.getUniformLocation(program, 'time')
                };
                gl.uniform1i(uniforms.tex, 0);

                texture = gl.createTexture();
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, texture);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
                gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

                LOG(`Shader ready in ${Math.round(performance.now() - started)} ms`
                    + (parallel ? ' (compiled off the main thread)' : ''));
                resolve(program);
            };

            if (!parallel) { finish(); return; }
            const poll = () => {
                if (gl !== glAtStart) { reject(new Error('context replaced during compile')); return; }
                if (gl.getProgramParameter(prog, parallel.COMPLETION_STATUS_KHR)) finish();
                else setTimeout(poll, 50);
            };
            poll();
        })).catch((err) => {
            programPromise = null;
            throw err;
        });

        return programPromise;
    }

    // --------------------------------------------------
    //  LAYOUT
    // --------------------------------------------------

    // The canvas covers the PICTURE, not the element: under the default
    // object-fit (contain) that excludes the letterbox, so the tube's curvature
    // and border sit on the video's own edges the way mpv's do. Sizes are
    // snapped to whole device pixels -- fullSize is the canvas's backing size,
    // and the phosphor mask is laid out in those pixels, so a fractional CSS
    // size would resample the triads and blur them.
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

        // Rounded OUTWARD, never to nearest: the video is still painting under
        // the canvas, so a canvas even half a pixel short of the picture leaves
        // a bright one-pixel seam of raw video along that edge.
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

        gl.viewport(0, 0, pw, ph);
        gl.uniform2f(uniforms.fullSize, pw, ph);
        lastObjectFit = video.style.objectFit;
        return true;
    }

    // --------------------------------------------------
    //  RENDER LOOP
    // --------------------------------------------------

    function uploadFrame() {
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (w !== texW || h !== texH) {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, video);
            texW = w;
            texH = h;
            gl.uniform2f(uniforms.srcSize, w, h);
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
        if (!video || !canvas) return;
        if (!video.isConnected) {
            LOG('Video element removed; CRT layer detached');
            stop();
            return;
        }
        rafId = requestAnimationFrame(tick);

        // HAVE_CURRENT_DATA: there is a frame to upload.
        if (video.readyState < 2 || !video.videoWidth) return;

        // Jellyfin's aspect-ratio setting is an inline object-fit, so a string
        // compare catches it without a style recalc.
        if (video.style.objectFit !== lastObjectFit) layoutDirty = true;

        // Without requestVideoFrameCallback there is no frame signal, so a
        // playing video re-uploads every draw.
        if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype) && !video.paused) frameDirty = true;

        const field = Math.floor((now - t0) / 1000 * FIELD_RATE);
        if (!frameDirty && !layoutDirty && field === lastField) return;

        if (layoutDirty) {
            if (!updateLayout()) return;
            layoutDirty = false;
        }
        if (frameDirty || !texW) {
            try {
                uploadFrame();
            } catch (err) {
                // A SecurityError here means the frame is cross-origin.
                ERR('Could not read the video frame:', err);
                notify('CRT: this video cannot be read by WebGL');
                stop();
                return;
            }
            frameDirty = false;
        }

        lastField = field;
        gl.uniform1f(uniforms.time, (now - t0) / 1000);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
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
            await buildProgram();
        } catch (err) {
            ERR('Shader failed to build:', err.message || err);
            notify('CRT: the shader failed to build (details in the console)');
            dropContext();
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
        texW = texH = 0;            // force a texImage2D for the new element
        t0 = performance.now();

        resizeObserver = new ResizeObserver(() => { layoutDirty = true; });
        resizeObserver.observe(video);
        video.addEventListener('resize', onVideoResize);
        window.addEventListener('resize', onVideoResize);

        rafId = requestAnimationFrame(tick);
        if ('requestVideoFrameCallback' in video) vfcId = video.requestVideoFrameCallback(onVideoFrame);
        updateButtons();
        LOG('CRT layer on');
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
        writeEnabled(value);
        if (value) start();
        else stop();
        updateButtons();
    }

    // --------------------------------------------------
    //  OSD BUTTON
    // --------------------------------------------------

    function updateButtons(state) {
        document.querySelectorAll(`.${BUTTON_CLASS}`).forEach((btn) => {
            const icon = btn.querySelector('.material-icons');
            if (icon) {
                icon.classList.toggle('tv', enabled);
                icon.classList.toggle('tv_off', !enabled);
            }
            btn.classList.toggle('kefinCrtLoading', state === 'loading');
            btn.title = state === 'loading' ? 'CRT (compiling shader...)' : (enabled ? 'CRT: on' : 'CRT: off');
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

    // --------------------------------------------------
    //  INIT
    // --------------------------------------------------

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
        LOG(`Initialized (CRT ${enabled ? 'on' : 'off'} on this browser)`);
    }

    // Console handle, for checking what the layer is doing without the OSD.
    window.KefinTweaksCrt = {
        enable: () => setEnabled(true),
        disable: () => setEnabled(false),
        status: () => ({
            enabled,
            attached: !!(video && canvas && canvas.isConnected),
            canvas: canvas ? `${canvas.width}x${canvas.height}` : null,
            source: texW ? `${texW}x${texH}` : null
        })
    };

    init();
})();
