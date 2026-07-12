// Cut! — live WebGL2 compositor for the Director's room.
//
// Ports the realism layers from backend/render/composite.py into the live lane so
// the in-browser cutout stops reading as a flat "destination-in" mask. In order of
// impact (research/video-pipeline.md §2, mirrored here):
//
//   temporal EMA (done upstream in main.onSeg — kills SelfieSegmenter's per-frame flicker)
//   (1) refine      — smoothstep the soft confidence ramp (ramp width = feather)
//   (2) light wrap  — blurred bg light bleeds onto the subject's edge band
//   (3) color match — pull the performer's RGB stats toward the world (Reinhard, gentle)
//   (4) spill knock — desaturate/darken the boundary rim (we have no RVM `fgr` live)
//   (5) contact shadow — offset+blurred alpha darkens the ground under the subject
//   (6) premultiplied over
//
// Everything runs in one fragment shader over three uploaded textures (+2 CPU-blurred
// inputs). `uDebug` selects a per-layer visualization so the inspect modal can show
// each stage live. If WebGL2 is unavailable, `.ok` is false and main.js falls back to
// the old 2D-canvas composite — the core app never breaks.

const VERT = `#version 300 es
in vec2 aPos; in vec2 aUv; out vec2 vUv;
void main(){ vUv = aUv; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 frag;
uniform sampler2D uCam, uBg, uMask, uMaskBlur, uBgBlur;
uniform vec3 uFgMean, uFgStd, uBgMean, uBgStd;
uniform float uRefineLo, uRefineHi;
uniform float uColorBlend, uWrapStrength, uSpill, uShadow;
uniform vec2  uShadowOff;
uniform int   uDebug;

float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void main(){
  vec2 uv = vUv;
  vec3 cam    = texture(uCam, uv).rgb;
  vec3 bg     = texture(uBg,  uv).rgb;
  vec3 bgBlur = texture(uBgBlur, uv).rgb;
  float araw  = texture(uMask, uv).a;        // EMA'd confidence (main.onSeg wrote it here)
  float ablur = texture(uMaskBlur, uv).a;    // broad blur of the same mask

  // (1) refine + feather: tighten the fuzzy ramp; ramp width (hi-lo) IS the feather knob
  float a    = smoothstep(uRefineLo, uRefineHi, araw);
  float band = clamp(ablur - a, 0.0, 1.0);   // just outside the subject
  float rim  = 4.0 * a * (1.0 - a);          // smooth hump along the boundary (in+out)

  // (3) color match — shift/scale the FG's RGB stats toward the environment (Reinhard)
  vec3 matched = (cam - uFgMean) / max(uFgStd, vec3(1e-3)) * uBgStd + uBgMean;
  vec3 fg = mix(cam, clamp(matched, 0.0, 1.0), uColorBlend);

  // (4) spill knockdown — the boundary carries the real room's colour (no RVM fgr live),
  //     so desaturate + slightly darken the rim band
  vec3 desat = vec3(luma(fg));
  fg = mix(fg, desat, uSpill * rim * 0.85);
  fg *= (1.0 - uSpill * rim * 0.15);

  // (2) light wrap — blurred bg light spills onto the edge band
  vec3 wrap = bgBlur * (band * uWrapStrength);

  // (5) contact shadow — offset+blurred alpha darkens the bg under the subject
  float sh = texture(uMaskBlur, uv - uShadowOff).a * uShadow;
  vec3 bgSh = bg * (1.0 - sh);

  // (6) premultiplied over
  vec3 outc = (fg + wrap) * a + bgSh * (1.0 - a);

  // ---- per-layer inspection views ----
  if (uDebug == 1) { frag = vec4(cam, 1.0); return; }              // raw camera
  if (uDebug == 2) { frag = vec4(bg, 1.0); return; }               // background plate
  if (uDebug == 3) { frag = vec4(vec3(araw), 1.0); return; }       // EMA'd mask (pre-refine)
  if (uDebug == 4) { frag = vec4(vec3(a), 1.0); return; }          // refined alpha
  if (uDebug == 5) { frag = vec4(vec3(band), 1.0); return; }       // edge band
  if (uDebug == 6) { frag = vec4(wrap, 1.0); return; }             // light wrap only
  if (uDebug == 7) { frag = vec4(fg * a, 1.0); return; }           // matched+de-spilled FG (premult)
  if (uDebug == 8) { frag = vec4(vec3(uSpill * rim), 1.0); return; } // spill rim map
  if (uDebug == 9) { frag = vec4(vec3(sh), 1.0); return; }         // contact shadow
  frag = vec4(clamp(outc, 0.0, 1.0), 1.0);                        // 0 = final
}`;

// The nine inspectable layers, in pipeline order. Shared with the modal in main.js.
export const LAYERS = [
  { id: 0, name: 'Final composite' },
  { id: 3, name: 'Mask · EMA' },
  { id: 4, name: 'Alpha · refined' },
  { id: 5, name: 'Edge band' },
  { id: 6, name: 'Light wrap' },
  { id: 7, name: 'FG · matched + de-spilled' },
  { id: 8, name: 'Spill rim' },
  { id: 9, name: 'Contact shadow' },
  { id: 1, name: 'Camera · raw' },
  { id: 2, name: 'Background' },
];

export class GLCompositor {
  constructor() {
    this.ok = false;
    this.canvas = document.createElement('canvas');
    this.gl = null;
    this._w = 0; this._h = 0;
    // CPU-side scratch: blurred inputs (half-res) + a tiny sampler for Reinhard stats
    this._maskBlur = document.createElement('canvas');
    this._bgBlur = document.createElement('canvas');
    this._samp = document.createElement('canvas');
    this._samp.width = 96; this._samp.height = 54;
    // 1x1 opaque-white-alpha stand-in used until the first mask lands
    this._white = document.createElement('canvas');
    this._white.width = this._white.height = 1;
    const wc = this._white.getContext('2d');
    wc.fillStyle = '#fff'; wc.fillRect(0, 0, 1, 1);
    try { this._initGL(); } catch (e) { this.ok = false; }
  }

  _initGL() {
    const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: false, antialias: false });
    if (!gl) return;
    const prog = this._link(gl, VERT, FRAG);
    if (!prog) return;
    this.gl = gl; this.prog = prog;

    // full-screen quad; uv chosen so texImage2D (FLIP_Y off) renders upright to the canvas
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 0, 1,   1, -1, 1, 1,   -1, 1, 0, 0,   1, 1, 1, 0,
    ]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    const aUv = gl.getAttribLocation(prog, 'aUv');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(aUv);
    gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8);

    // texture units 0..4 → the five samplers
    this._units = ['uCam', 'uBg', 'uMask', 'uMaskBlur', 'uBgBlur'];
    this._tex = this._units.map((name, i) => {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      return t;
    });
    gl.useProgram(prog);
    this._u = {};
    for (const n of ['uFgMean', 'uFgStd', 'uBgMean', 'uBgStd', 'uRefineLo', 'uRefineHi',
      'uColorBlend', 'uWrapStrength', 'uSpill', 'uShadow', 'uShadowOff', 'uDebug', ...this._units]) {
      this._u[n] = gl.getUniformLocation(prog, n);
    }
    this._units.forEach((n, i) => gl.uniform1i(this._u[n], i));
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    this.ok = true;
  }

  _link(gl, vs, fs) {
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.warn('[composite_gl] shader:', gl.getShaderInfoLog(s)); return null;
      }
      return s;
    };
    const v = sh(gl.VERTEX_SHADER, vs), f = sh(gl.FRAGMENT_SHADER, fs);
    if (!v || !f) return null;
    const p = gl.createProgram();
    gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.warn('[composite_gl] link:', gl.getProgramInfoLog(p)); return null;
    }
    return p;
  }

  _resize(w, h) {
    if (this._w === w && this._h === h) return;
    this._w = w; this._h = h;
    this.canvas.width = w; this.canvas.height = h;
    const bw = Math.max(1, w >> 1), bh = Math.max(1, h >> 1);   // blur at half-res — it's all low-freq
    this._maskBlur.width = bw; this._maskBlur.height = bh;
    this._bgBlur.width = bw; this._bgBlur.height = bh;
    this.gl.viewport(0, 0, w, h);
  }

  // Weighted RGB mean/std of the camera under the mask (FG) + global stats of the bg (Reinhard inputs).
  _stats(camEl, maskCanvas, bgCanvas) {
    const s = this._samp, sw = s.width, sh = s.height, ctx = s.getContext('2d', { willReadFrequently: true });
    const zero = { fgMean: [0, 0, 0], fgStd: [1, 1, 1], bgMean: [0, 0, 0], bgStd: [1, 1, 1] };
    try {
      ctx.clearRect(0, 0, sw, sh); ctx.drawImage(camEl, 0, 0, sw, sh);
      const cam = ctx.getImageData(0, 0, sw, sh).data;
      let mask = null;
      if (maskCanvas) { ctx.clearRect(0, 0, sw, sh); ctx.drawImage(maskCanvas, 0, 0, sw, sh); mask = ctx.getImageData(0, 0, sw, sh).data; }
      ctx.clearRect(0, 0, sw, sh); ctx.drawImage(bgCanvas, 0, 0, sw, sh);
      const bg = ctx.getImageData(0, 0, sw, sh).data;

      const n = sw * sh;
      let wsum = 0; const fm = [0, 0, 0], fv = [0, 0, 0], bm = [0, 0, 0], bv = [0, 0, 0];
      for (let i = 0; i < n; i++) {
        const j = i << 2;
        const wgt = mask ? mask[j + 3] / 255 : 1;
        wsum += wgt;
        fm[0] += cam[j] * wgt; fm[1] += cam[j + 1] * wgt; fm[2] += cam[j + 2] * wgt;
        bm[0] += bg[j]; bm[1] += bg[j + 1]; bm[2] += bg[j + 2];
      }
      if (wsum < 1) return zero;
      for (let c = 0; c < 3; c++) { fm[c] /= wsum; bm[c] /= n; }
      for (let i = 0; i < n; i++) {
        const j = i << 2, wgt = mask ? mask[j + 3] / 255 : 1;
        for (let c = 0; c < 3; c++) {
          fv[c] += (cam[j + c] - fm[c]) ** 2 * wgt;
          bv[c] += (bg[j + c] - bm[c]) ** 2;
        }
      }
      const norm = (v) => v / 255;
      return {
        fgMean: fm.map(norm),
        fgStd: fv.map((v) => Math.sqrt(v / wsum) / 255 + 1e-3),
        bgMean: bm.map(norm),
        bgStd: bv.map((v) => Math.sqrt(v / n) / 255 + 1e-3),
      };
    } catch (e) {
      return zero;   // tainted canvas or transient decode — skip the colour match this frame
    }
  }

  _blur(dst, src, px) {
    const c = dst.getContext('2d');
    c.clearRect(0, 0, dst.width, dst.height);
    c.filter = `blur(${Math.max(0.01, px * 0.5)}px)`;   // dst is half-res, so half the sigma
    c.drawImage(src, 0, 0, dst.width, dst.height);
    c.filter = 'none';
  }

  _upload(unit, src) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this._tex[unit]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  }

  _setUniforms(p, st) {
    const gl = this.gl, u = this._u;
    gl.uniform3fv(u.uFgMean, st.fgMean); gl.uniform3fv(u.uFgStd, st.fgStd);
    gl.uniform3fv(u.uBgMean, st.bgMean); gl.uniform3fv(u.uBgStd, st.bgStd);
    gl.uniform1f(u.uRefineLo, p.refineLo); gl.uniform1f(u.uRefineHi, p.refineHi);
    gl.uniform1f(u.uColorBlend, p.colorBlend); gl.uniform1f(u.uWrapStrength, p.wrapStrength);
    gl.uniform1f(u.uSpill, p.spill); gl.uniform1f(u.uShadow, p.shadow);
    gl.uniform2f(u.uShadowOff, p.shadowDx, p.shadowDy);
  }

  // Upload this frame's inputs, compute stats/blurs, and render `debug` (0 = final).
  // Returns the GL canvas, or null if unusable (caller falls back to 2D).
  frame(camEl, bgCanvas, maskCanvas, p, debug = 0) {
    if (!this.ok || !bgCanvas) return null;
    const gl = this.gl;
    this._resize(bgCanvas.width, bgCanvas.height);
    const mask = maskCanvas || this._white;
    this._blur(this._maskBlur, mask, p.wrapPx);
    this._blur(this._bgBlur, bgCanvas, p.wrapPx);
    const st = this._stats(camEl, maskCanvas, bgCanvas);

    gl.useProgram(this.prog);
    this._upload(0, camEl); this._upload(1, bgCanvas); this._upload(2, mask);
    this._upload(3, this._maskBlur); this._upload(4, this._bgBlur);
    this._setUniforms(p, st);
    this._lastStats = st; this._lastParams = p;   // let view() re-render other layers cheaply
    this._draw(debug);
    return this.canvas;
  }

  // Re-render an already-uploaded frame under a different debug view (for the modal).
  view(debug) {
    if (!this.ok || !this._lastParams) return null;
    this.gl.useProgram(this.prog);
    this._setUniforms(this._lastParams, this._lastStats);
    this._draw(debug);
    return this.canvas;
  }

  _draw(debug) {
    const gl = this.gl;
    gl.uniform1i(this._u.uDebug, debug | 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
