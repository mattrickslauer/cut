// Cut! — Director Control Panel (step 2: webcam + preview + live Qwen-VL perception)
// The <canvas> render loop is where matting / parallax / generated backgrounds plug in later.

// Alibaba Function Compute perception service (scale-to-zero). Holds the DashScope key.
const BACKEND_URL = 'https://cut-perceive-xfdwmitvbk.ap-southeast-1.fcapp.run';
const PERCEIVE_MS = 4000; // how often the director "looks" while a session rolls

const els = {
  cam: document.getElementById('cam'),
  cut: document.getElementById('cut'),
  camPlaceholder: document.getElementById('camPlaceholder'),
  startBtn: document.getElementById('startBtn'),
  toggleBtn: document.getElementById('toggleBtn'),
  snapBtn: document.getElementById('snapBtn'),
  deviceSel: document.getElementById('deviceSel'),
  grades: document.getElementById('grades'),
  bgSel: document.getElementById('bgSel'),
  worldPrompt: document.getElementById('worldPrompt'),
  genWorld: document.getElementById('genWorld'),
  gradeName: document.getElementById('gradeName'),
  rawRes: document.getElementById('rawRes'),
  rawFps: document.getElementById('rawFps'),
  cutFps: document.getElementById('cutFps'),
  recDot: document.getElementById('recDot'),
  sessionTime: document.getElementById('sessionTime'),
  log: document.getElementById('log'),
  stScene: document.getElementById('stScene'),
  stMood: document.getElementById('stMood'),
  stShot: document.getElementById('stShot'),
  cast: document.getElementById('cast'),
  transcript: document.getElementById('transcript'),
  subtitle: document.getElementById('subtitle'),
};

// Cinematic "looks" — canvas filter strings. Stand-ins for the Editor agent's grade decisions.
const GRADES = {
  Neutral:  'none',
  Noir:     'grayscale(1) contrast(1.35) brightness(0.92)',
  'Sci-Fi': 'saturate(1.2) contrast(1.15) hue-rotate(-12deg) brightness(1.02)',
  Golden:   'sepia(0.35) saturate(1.3) contrast(1.05) brightness(1.05)',
  Thriller: 'saturate(0.7) contrast(1.25) hue-rotate(6deg) brightness(0.95)',
};

const state = {
  stream: null,
  ctx: els.cut.getContext('2d'),
  running: false,          // camera on
  session: false,          // "recording" a take
  grade: 'Neutral',
  sessionStart: 0,
  raf: 0,
  frames: 0, cutFrames: 0, lastFpsT: performance.now(),
  // perception
  perceiving: false, prior: null, sceneNum: 0, perceiveTimer: 0, capCanvas: null,
  // matting / background
  bgName: 'None', autoBg: 'Studio', bgCanvas: null, maskCanvas: null, personCanvas: null, maskReady: false,
  // generated worlds (qwen-image via FC)
  worldImg: null, autoUseImg: false, lastSetting: '', genCache: new Map(),
  // audio / transcription (qwen3-asr-flash via FC)
  audioCtx: null, audioSource: null, audioProc: null, pcmChunks: [], pcmLen: 0, srcRate: 48000,
  transcript: [], currentSpeaker: 'none', asrSeq: 0,
  // character detection (MediaPipe FaceDetector)
  faceDetector: null, faceReady: false, faces: [], lastFaceT: 0,
};

// ---------- logging ----------
function log(msg, hot = false) {
  const now = new Date();
  const t = now.toTimeString().slice(0, 8);
  const div = document.createElement('div');
  div.className = 'entry' + (hot ? ' hot' : '');
  div.innerHTML = `<span class="t">${t}</span>${msg}`;
  els.log.prepend(div);
  while (els.log.children.length > 120) els.log.lastChild.remove();
}

// ---------- grade chips ----------
function buildGrades() {
  for (const name of Object.keys(GRADES)) {
    const b = document.createElement('button');
    b.className = 'chip' + (name === state.grade ? ' active' : '');
    b.textContent = name;
    b.onclick = () => setGrade(name);
    els.grades.appendChild(b);
  }
}
function setGrade(name) {
  state.grade = name;
  els.gradeName.textContent = name;
  [...els.grades.children].forEach(c => c.classList.toggle('active', c.textContent === name));
  els.stMood.textContent = name === 'Neutral' ? '—' : name;
  log(`Editor › grade → <b>${name}</b>`, true);
}

// ---------- devices ----------
async function refreshDevices(selectedId) {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter(d => d.kind === 'videoinput');
  els.deviceSel.innerHTML = '';
  cams.forEach((d, i) => {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || `Camera ${i + 1}`;
    els.deviceSel.appendChild(o);
  });
  if (selectedId) els.deviceSel.value = selectedId;
}

// ---------- camera ----------
async function startCamera(deviceId) {
  try {
    stopTracks();
    const constraints = {
      audio: true,   // for continuous transcription
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
        : { width: { ideal: 1280 }, height: { ideal: 720 } },
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    state.stream = stream;
    els.cam.srcObject = stream;
    await els.cam.play();
    els.camPlaceholder.style.display = 'none';

    const track = stream.getVideoTracks()[0];
    const s = track.getSettings();
    els.rawRes.textContent = `${s.width}×${s.height}`;
    await refreshDevices(s.deviceId);

    state.running = true;
    els.toggleBtn.disabled = false;
    els.snapBtn.disabled = false;
    sizeCanvas();
    startLoop();
    initSegmenter();       // warm up matting in the background so world-swap is instant
    initFaceDetector();    // character detection (A/B)
    startAudio(state.stream);   // continuous transcription
    renderCast();
    log(`Camera live › ${track.label || 'default'} @ ${s.width}×${s.height}`);
  } catch (err) {
    log(`⚠︎ camera error: ${err.name} — ${err.message}`);
    alert(`Could not start camera: ${err.name}\n${err.message}\n\nMake sure you opened this over http://localhost and granted permission.`);
  }
}

function stopTracks() {
  stopAudio();
  if (state.stream) { state.stream.getTracks().forEach(t => t.stop()); state.stream = null; }
}

function sizeCanvas() {
  const w = els.cam.videoWidth || 1280;
  const h = els.cam.videoHeight || 720;
  els.cut.width = w;
  els.cut.height = h;
  buildBg();
}

// ---------- render loop (the future compositing pipeline) ----------
function startLoop() {
  cancelAnimationFrame(state.raf);
  const tick = () => {
    if (state.running && els.cam.readyState >= 2) {
      // character detection (throttled ~5 fps; detectForVideo is synchronous)
      if (state.faceReady) {
        const nowf = performance.now();
        if (nowf - state.lastFaceT > 200) {
          state.lastFaceT = nowf;
          try { updateFaces(state.faceDetector.detectForVideo(els.cam, nowf).detections || []); }
          catch (e) {}
        }
      }
      if (effBg() !== 'None' && segReady) {
        // matted composite: person over a generated world
        if (!segBusy) {
          segBusy = true;
          try { segmenter.segmentForVideo(els.cam, performance.now(), onSeg); }
          catch (e) { segBusy = false; }
        }
        compositeFrame();
        drawFaceLabels(state.ctx, false);   // composite is unmirrored
      } else {
        // plain graded preview (mirrored selfie view)
        const ctx = state.ctx;
        const { width: w, height: h } = els.cut;
        ctx.save();
        ctx.filter = GRADES[state.grade] || 'none';
        ctx.translate(w, 0); ctx.scale(-1, 1);
        ctx.drawImage(els.cam, 0, 0, w, h);
        ctx.restore();
        drawFaceLabels(ctx, true);          // mirror the label x to match
      }
      state.cutFrames++;
    }
    state.frames++;
    const now = performance.now();
    if (now - state.lastFpsT >= 1000) {
      els.rawFps.textContent = state.frames;
      els.cutFps.textContent = state.cutFrames;
      state.frames = 0; state.cutFrames = 0; state.lastFpsT = now;
    }
    state.raf = requestAnimationFrame(tick);
  };
  state.raf = requestAnimationFrame(tick);
}

// ---------- matting + background swap (MediaPipe, in-browser) ----------
const MP_URL   = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/vision_bundle.mjs';
const MP_WASM  = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm';
const SELFIE_MODEL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';

const BG_LIST = ['None', 'Auto', 'Generated', 'Studio', 'Starfield', 'Noir', 'Sunset', 'Void'];
const LOOK_TO_BG = { Noir: 'Noir', 'Sci-Fi': 'Starfield', Golden: 'Sunset', Thriller: 'Void', Neutral: 'Studio' };

// Two setting descriptions name the "same place" if they share a meaningful noun —
// suppresses the perception model's frame-to-frame rewording of one location
// ("bar" → "dim jazz bar" → "smoky bar") so the Auto world tracks the scene, not the phrasing.
const SETTING_STOP = new Set(['a','an','the','of','in','on','at','to','with','and','some','this','that',
  'room','place','area','scene','space','setting','location','interior','exterior','background',
  'dim','dark','bright','small','large','empty','quiet','busy','old','modern']);
function settingWords(s) {
  return new Set((s || '').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 2 && !SETTING_STOP.has(w)));
}
function sameSetting(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const wb = settingWords(b);
  for (const w of settingWords(a)) if (wb.has(w)) return true;
  return false;
}

let segmenter = null, segReady = false, segBusy = false, segLoading = false;

function effBg() { return state.bgName === 'Auto' ? (state.autoBg || 'Studio') : state.bgName; }

async function initSegmenter() {
  if (segReady || segLoading) return;
  segLoading = true;
  log('Loading matting model…');
  try {
    const { ImageSegmenter, FilesetResolver } = await import(MP_URL);   // dynamic: never breaks the core app
    const vision = await FilesetResolver.forVisionTasks(MP_WASM);
    const make = (delegate) => ImageSegmenter.createFromOptions(vision, {
      baseOptions: { modelAssetPath: SELFIE_MODEL, delegate },
      runningMode: 'VIDEO', outputConfidenceMasks: true, outputCategoryMask: false,
    });
    try { segmenter = await make('GPU'); } catch { segmenter = await make('CPU'); }
    segReady = true;
    log('Matting ready ✓ — background swap live');
  } catch (e) {
    log(`⚠︎ matting unavailable: ${e.message || e} — real background only`);
  } finally {
    segLoading = false;
  }
}

function onSeg(result) {
  try {
    const mask = result.confidenceMasks && result.confidenceMasks[0];
    if (mask) {
      const mw = mask.width, mh = mask.height, f = mask.getAsFloat32Array();
      const mc = state.maskCanvas || (state.maskCanvas = document.createElement('canvas'));
      if (mc.width !== mw || mc.height !== mh) { mc.width = mw; mc.height = mh; }
      const mctx = mc.getContext('2d');
      const img = mctx.createImageData(mw, mh), d = img.data;
      for (let i = 0; i < f.length; i++) { const j = i << 2; d[j] = d[j+1] = d[j+2] = 255; d[j+3] = f[i] * 255; }
      mctx.putImageData(img, 0, 0);
      state.maskReady = true;
      if (mask.close) mask.close();
    }
  } catch (e) { /* keep rolling */ }
  segBusy = false;
}

function drawProc(ctx, name, w, h) {
  const rg = (x, y, r0, r1) => ctx.createRadialGradient(x, y, r0, x, y, r1);
  if (name === 'Studio') {
    ctx.fillStyle = '#0aa07a'; ctx.fillRect(0, 0, w, h);
    const g = rg(w/2, h*0.4, 10, Math.max(w, h)); g.addColorStop(0, 'rgba(255,255,255,.15)'); g.addColorStop(1, 'rgba(0,0,0,.28)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  } else if (name === 'Starfield') {
    const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#05080f'); g.addColorStop(1, '#0b1430');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 220; i++) { ctx.globalAlpha = 0.4 + Math.random()*0.6; ctx.fillStyle = '#dfe8ff';
      ctx.beginPath(); ctx.arc(Math.random()*w, Math.random()*h, Math.random()*1.6, 0, 7); ctx.fill(); }
    ctx.globalAlpha = 1;
    const n = rg(w*0.7, h*0.3, 10, w*0.5); n.addColorStop(0, 'rgba(80,120,255,.25)'); n.addColorStop(1, 'rgba(80,120,255,0)');
    ctx.fillStyle = n; ctx.fillRect(0, 0, w, h);
  } else if (name === 'Noir') {
    ctx.fillStyle = '#0a0a0c'; ctx.fillRect(0, 0, w, h);
    const g = rg(w*0.5, h*0.15, 10, h*0.9); g.addColorStop(0, 'rgba(255,230,180,.30)'); g.addColorStop(0.4, 'rgba(120,100,70,.10)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 0.06; ctx.fillStyle = '#000';
    for (let y = 0; y < h; y += Math.max(8, h/40)) ctx.fillRect(0, y, w, Math.max(3, h/120));
    ctx.globalAlpha = 1;
  } else if (name === 'Sunset') {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#2a1a4a'); g.addColorStop(0.5, '#e0632f'); g.addColorStop(0.75, '#f4a13c'); g.addColorStop(1, '#3a1e2a');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    const s = rg(w*0.5, h*0.7, 10, w*0.4); s.addColorStop(0, 'rgba(255,240,200,.9)'); s.addColorStop(1, 'rgba(255,240,200,0)');
    ctx.fillStyle = s; ctx.fillRect(0, 0, w, h);
  } else { // Void
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    const g = rg(w/2, h/2, 10, Math.max(w, h)*0.7); g.addColorStop(0, 'rgba(30,30,40,1)'); g.addColorStop(1, '#000');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  }
}

function drawCover(ctx, img, w, h) {
  const ir = img.width / img.height, r = w / h;
  let dw, dh, dx, dy;
  if (ir > r) { dh = h; dw = h * ir; dx = (w - dw) / 2; dy = 0; }
  else { dw = w; dh = w / ir; dx = 0; dy = (h - dh) / 2; }
  ctx.drawImage(img, dx, dy, dw, dh);
}

// Generate an environment from text via the FC qwen-image endpoint (cached by prompt).
async function generateWorld(prompt, forAuto = false) {
  prompt = (prompt || '').trim();
  if (!prompt) return;
  const key = prompt.toLowerCase();
  if (state.genCache.has(key)) { setWorldImg(state.genCache.get(key), forAuto); return; }
  if (!segReady) initSegmenter();
  log(`Generating world › “${prompt}” …`, true);
  els.genWorld.disabled = true;
  const img = new Image();
  img.crossOrigin = 'anonymous';                 // FC sends ACAO:* → no canvas taint
  img.onload = () => { state.genCache.set(key, img); setWorldImg(img, forAuto); els.genWorld.disabled = false; log(`World ready ✓ — ${prompt}`); };
  img.onerror = () => { els.genWorld.disabled = false; log(`⚠︎ world gen failed: ${prompt}`); };
  img.src = `${BACKEND_URL}/background?prompt=${encodeURIComponent(prompt)}`;
}

function setWorldImg(img, forAuto) {
  state.worldImg = img;
  if (forAuto) state.autoUseImg = true;
  buildBg();
}

function buildBg() {
  const name = effBg();
  if (name === 'None') { state.bgCanvas = null; return; }
  const w = els.cut.width || 1280, h = els.cut.height || 720;
  const c = state.bgCanvas || (state.bgCanvas = document.createElement('canvas'));
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const useImg = state.worldImg && (state.bgName === 'Generated' || (state.bgName === 'Auto' && state.autoUseImg));
  if (useImg) drawCover(ctx, state.worldImg, w, h);
  else if (state.bgName === 'Generated') drawProc(ctx, 'Void', w, h);   // placeholder while generating
  else drawProc(ctx, name === 'Auto' ? state.autoBg : name, w, h);
}

function compositeFrame() {
  const ctx = state.ctx, w = els.cut.width, h = els.cut.height;
  if (!state.bgCanvas) buildBg();
  ctx.filter = GRADES[state.grade] || 'none';         // grade the whole world for cohesion
  if (state.bgCanvas) ctx.drawImage(state.bgCanvas, 0, 0, w, h);
  else { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h); }
  // build the masked performer
  const pc = state.personCanvas || (state.personCanvas = document.createElement('canvas'));
  if (pc.width !== w || pc.height !== h) { pc.width = w; pc.height = h; }
  const p = pc.getContext('2d');
  p.globalCompositeOperation = 'source-over'; p.clearRect(0, 0, w, h);
  p.drawImage(els.cam, 0, 0, w, h);
  if (state.maskReady && state.maskCanvas) {
    p.globalCompositeOperation = 'destination-in';
    p.drawImage(state.maskCanvas, 0, 0, w, h);        // scaled → soft edges
    p.globalCompositeOperation = 'source-over';
  }
  ctx.drawImage(pc, 0, 0, w, h);
  ctx.filter = 'none';
}

function buildBgSelect() {
  els.bgSel.innerHTML = '';
  for (const n of BG_LIST) {
    const o = document.createElement('option');
    o.value = n;
    o.textContent = n === 'Auto' ? 'Auto (director)' : n === 'None' ? 'None (real)' : n;
    els.bgSel.appendChild(o);
  }
  els.bgSel.value = state.bgName;
}

// ---------- character detection (MediaPipe FaceDetector, in-browser) ----------
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite';
const CHAR_COLOR = { A: '#ffb02e', B: '#3ec6ff' };

async function initFaceDetector() {
  if (state.faceReady || state.faceDetector) return;
  try {
    const { FaceDetector, FilesetResolver } = await import(MP_URL);
    const vision = await FilesetResolver.forVisionTasks(MP_WASM);
    const make = (delegate) => FaceDetector.createFromOptions(vision, {
      baseOptions: { modelAssetPath: FACE_MODEL, delegate }, runningMode: 'VIDEO',
    });
    try { state.faceDetector = await make('GPU'); } catch { state.faceDetector = await make('CPU'); }
    state.faceReady = true;
    log('Character detection ready ✓ — A = left, B = right');
  } catch (e) { log(`⚠︎ character detection unavailable: ${e.message || e}`); }
}

function updateFaces(dets) {
  const boxes = dets.map(d => d.boundingBox).filter(Boolean)
    .sort((a, b) => a.originX - b.originX).slice(0, 2);       // leftmost = A, next = B
  state.faces = boxes.map((box, i) => ({ label: i === 0 ? 'A' : 'B', box }));
  renderCast();
}

function drawFaceLabels(ctx, mirrored) {
  const w = els.cut.width;
  const fs = Math.max(13, Math.round(w * 0.018));
  ctx.save();
  ctx.font = `600 ${fs}px system-ui, sans-serif`;
  for (const f of state.faces) {
    let x = f.box.originX; const y = f.box.originY, bw = f.box.width;
    if (mirrored) x = w - (x + bw);
    const label = `Character ${f.label}`, tw = ctx.measureText(label).width, pad = 6;
    const bh = fs + 8, ly = Math.max(0, y - bh - 4);
    ctx.globalAlpha = 0.9; ctx.fillStyle = CHAR_COLOR[f.label];
    ctx.fillRect(x, ly, tw + pad * 2, bh);
    ctx.globalAlpha = 1; ctx.fillStyle = '#0b0d10';
    ctx.fillText(label, x + pad, ly + fs);
  }
  ctx.restore();
}

function renderCast() {
  const present = new Set(state.faces.map(f => f.label));
  const active = state.currentSpeaker;
  els.cast.innerHTML = '';
  for (const c of ['A', 'B']) {
    const speaking = active === c || active === 'both';
    const el = document.createElement('div');
    el.className = 'cast-chip c' + c + (speaking ? ' on' : (present.has(c) ? ' detected' : ''));
    el.textContent = `Character ${c}` + (speaking ? ' 🎤' : '');
    els.cast.appendChild(el);
  }
}

// ---------- continuous transcription (qwen3-asr-flash via Alibaba FC) ----------
// VAD endpointing: flush the moment the speaker pauses → low latency + clean word boundaries.
const VAD_START = 0.012, VAD_END = 0.008, VAD_SILENCE_MS = 380, VAD_MIN_MS = 400, VAD_MAX_MS = 5000;
let vadSilenceMs = 0, vadChunkMs = 0, vadHadSpeech = false;

function startAudio(stream) {
  const track = stream.getAudioTracks()[0];
  if (!track) { log('⚠︎ no microphone — transcription off'); return; }
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    state.audioCtx = ctx; state.srcRate = ctx.sampleRate;
    const source = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    vadSilenceMs = 0; vadChunkMs = 0; vadHadSpeech = false;
    proc.onaudioprocess = (e) => {
      const ch = e.inputBuffer.getChannelData(0);
      let s = 0; for (let i = 0; i < ch.length; i += 2) s += ch[i] * ch[i];
      const rms = Math.sqrt(s / (ch.length / 2));
      const blockMs = (ch.length / state.srcRate) * 1000;
      state.pcmChunks.push(new Float32Array(ch));
      state.pcmLen += ch.length;
      vadChunkMs += blockMs;
      if (rms > VAD_START) { vadHadSpeech = true; vadSilenceMs = 0; }
      else if (vadHadSpeech && rms < VAD_END) { vadSilenceMs += blockMs; }
      // drop leading dead air so a chunk starts near the first word
      if (!vadHadSpeech && vadChunkMs > 700) {
        const last = state.pcmChunks[state.pcmChunks.length - 1];
        state.pcmChunks = [last]; state.pcmLen = last.length; vadChunkMs = blockMs;
      }
      const endpoint = vadHadSpeech && vadSilenceMs >= VAD_SILENCE_MS && vadChunkMs >= VAD_MIN_MS;
      if (endpoint || (vadHadSpeech && vadChunkMs >= VAD_MAX_MS)) {
        vadSilenceMs = 0; vadChunkMs = 0; vadHadSpeech = false;
        flushAudio();   // send the instant they pause
      }
    };
    const sink = ctx.createGain(); sink.gain.value = 0;    // silent sink → no feedback, processor still runs
    source.connect(proc); proc.connect(sink); sink.connect(ctx.destination);
    state.audioSource = source; state.audioProc = proc;
    if (ctx.state === 'suspended') ctx.resume();
    log('Transcription live — listening (voice-activated)…');
  } catch (e) { log(`⚠︎ audio capture failed: ${e.message}`); }
}

function stopAudio() {
  vadSilenceMs = 0; vadChunkMs = 0; vadHadSpeech = false;
  try { state.audioProc && state.audioProc.disconnect(); } catch {}
  try { state.audioSource && state.audioSource.disconnect(); } catch {}
  try { state.audioCtx && state.audioCtx.close(); } catch {}
  state.audioCtx = state.audioProc = state.audioSource = null;
  state.pcmChunks = []; state.pcmLen = 0;
}

function downsampleTo16k(f32, srcRate) {
  if (srcRate === 16000) return f32;
  const ratio = srcRate / 16000, outLen = Math.floor(f32.length / ratio), out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const s = Math.floor(i * ratio), e = Math.floor((i + 1) * ratio);
    let sum = 0, c = 0;
    for (let j = s; j < e && j < f32.length; j++) { sum += f32[j]; c++; }
    out[i] = c ? sum / c : 0;
  }
  return out;
}

function encodeWav(f32, rate) {
  const len = f32.length, buf = new ArrayBuffer(44 + len * 2), dv = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + len * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  w(36, 'data'); dv.setUint32(40, len * 2, true);
  let o = 44;
  for (let i = 0; i < len; i++) { const s = Math.max(-1, Math.min(1, f32[i])); dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
  return new Blob([buf], { type: 'audio/wav' });
}

function blobToDataURL(blob) {
  return new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
}

async function flushAudio() {
  if (!state.pcmLen) return;
  // capture + clear synchronously (before any await) so no audio is lost or double-sent
  const merged = new Float32Array(state.pcmLen);
  let off = 0; for (const c of state.pcmChunks) { merged.set(c, off); off += c.length; }
  state.pcmChunks = []; state.pcmLen = 0;
  if (merged.length < state.srcRate * 0.35) return;   // too short to be a word
  const seq = ++state.asrSeq;                         // preserve display order across concurrent calls
  const dataUrl = await blobToDataURL(encodeWav(downsampleTo16k(merged, state.srcRate), 16000));
  try {
    const res = await fetch(BACKEND_URL + '/transcribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio: dataUrl }),
    });
    const r = await res.json();
    if (r.text) addTranscript(r.text, seq);
  } catch (e) { /* quiet — keep listening */ }
}

function addTranscript(text, seq = 0) {
  text = text.trim();
  if (!text) return;
  const s = state.currentSpeaker;
  const who = (s === 'A' || s === 'B') ? s : (s === 'both' ? 'both' : 'x');
  const entry = { who, text, seq };
  // insert keeping ascending seq (handles rare out-of-order concurrent responses)
  const t = state.transcript;
  let i = t.length;
  while (i > 0 && t[i - 1].seq > seq) i--;
  t.splice(i, 0, entry);
  renderTranscript();
  setSubtitle(who, text);
}

function renderTranscript() {
  els.transcript.innerHTML = '';
  for (const l of state.transcript.slice(-40)) {
    const tag = l.who === 'A' ? 'A' : l.who === 'B' ? 'B' : 'x';
    const label = l.who === 'A' ? 'A' : l.who === 'B' ? 'B' : (l.who === 'both' ? 'A+B' : '·');
    const div = document.createElement('div');
    div.className = 'line';
    div.innerHTML = `<span class="who ${tag}">${label}</span>${l.text}`;
    els.transcript.appendChild(div);
  }
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

let subtitleTimer = 0;
function setSubtitle(who, text) {
  const cls = who === 'A' ? 'A' : who === 'B' ? 'B' : '';
  const label = (who === 'A' || who === 'B') ? `<span class="who ${cls}">${who}:</span> ` : '';
  els.subtitle.innerHTML = label + text;
  els.subtitle.classList.add('show');
  clearTimeout(subtitleTimer);
  subtitleTimer = setTimeout(() => els.subtitle.classList.remove('show'), 4000);
}

// ---------- perception (Qwen-VL director's eye, via Alibaba FC) ----------
function captureFrame() {
  if (!state.running || els.cam.readyState < 2) return null;
  const cap = state.capCanvas || (state.capCanvas = document.createElement('canvas'));
  const vw = els.cam.videoWidth, vh = els.cam.videoHeight;
  const w = 480, h = Math.round((vh * w) / vw) || 320;
  cap.width = w; cap.height = h;
  cap.getContext('2d').drawImage(els.cam, 0, 0, w, h);
  return cap.toDataURL('image/jpeg', 0.6);
}

async function perceiveOnce() {
  if (!state.session || state.perceiving) return;
  const frame = captureFrame();
  if (!frame) return;
  state.perceiving = true;
  try {
    const res = await fetch(BACKEND_URL + '/perceive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: frame, prior: state.prior }),
    });
    const r = await res.json();
    if (r.error) { log(`⚠︎ perceive: ${r.error}`); return; }
    applyPerception(r);
  } catch (e) {
    log(`⚠︎ perceive failed: ${e.message}`);
  } finally {
    state.perceiving = false;
  }
}

function applyPerception(r) {
  state.prior = { setting: r.setting, shot: r.suggested_shot, look: r.suggested_look, scene: state.sceneNum };
  if (r.scene_change) {
    state.sceneNum++;
    els.stScene.textContent = `Scene ${state.sceneNum}`;
    log(`Director › NEW SCENE — ${r.setting || '?'}`, true);
  }
  els.stMood.textContent = r.emotion || '—';
  els.stShot.textContent = (r.suggested_shot || '—') + (r.action ? ` · ${r.action}` : '');
  state.currentSpeaker = r.speaker || 'none';
  renderCast();
  // The director chooses the look → auto-apply it (the "AI directs" moment)
  if (r.suggested_look && GRADES[r.suggested_look] && r.suggested_look !== state.grade) {
    setGrade(r.suggested_look);
  }
  // When the world is on Auto, the director conjures the actual place it describes
  if (state.bgName === 'Auto') {
    state.autoBg = LOOK_TO_BG[r.suggested_look] || 'Studio';   // procedural placeholder look
    if (r.setting && r.setting.toLowerCase() !== state.lastSetting) {
      state.lastSetting = r.setting.toLowerCase();
      state.autoUseImg = false; buildBg();                     // show placeholder until image lands
      log(`Director › WORLD → ${r.setting}`, true);
      generateWorld(r.setting, true);                          // generate the described environment
    } else {
      buildBg();
    }
  }
  if (r.director_note) log(`Director › ${r.director_note}`, true);
}

// ---------- session (take) ----------
function toggleSession() {
  state.session = !state.session;
  els.recDot.className = 'rec-dot ' + (state.session ? 'on' : 'off');
  els.toggleBtn.textContent = state.session ? 'Stop session' : 'Start session';
  els.toggleBtn.classList.toggle('primary', !state.session);
  if (state.session) {
    state.sessionStart = Date.now();
    state.sceneNum = 1;
    state.prior = null;
    els.stScene.textContent = 'Scene 1';
    els.stShot.textContent = 'WIDE · establishing';
    log('● SESSION START — rolling. Director is watching…', true);
    perceiveOnce();                                   // look immediately
    state.perceiveTimer = setInterval(perceiveOnce, PERCEIVE_MS);
  } else {
    clearInterval(state.perceiveTimer); state.perceiveTimer = 0;
    els.stScene.textContent = els.stShot.textContent = '—';
    state.currentSpeaker = 'none'; renderCast();
    log('■ SESSION STOP');
  }
}

function tickTimer() {
  if (state.session) {
    const s = Math.floor((Date.now() - state.sessionStart) / 1000);
    els.sessionTime.textContent =
      String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }
}

// ---------- snapshot ----------
function snapshot() {
  const url = els.cut.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = url;
  a.download = `cut-frame-${Date.now()}.png`;
  a.click();
  log('Snapshot saved (director\'s cut frame)');
}

// ---------- wire up ----------
els.startBtn.onclick = () => startCamera(els.deviceSel.value || undefined);
els.toggleBtn.onclick = toggleSession;
els.snapBtn.onclick = snapshot;
els.deviceSel.onchange = () => { if (state.running) startCamera(els.deviceSel.value); };
els.bgSel.onchange = () => {
  state.bgName = els.bgSel.value;
  if (state.bgName !== 'None') initSegmenter();
  buildBg();
  log(`World › ${state.bgName === 'None' ? 'real background' : state.bgName}`);
};
els.genWorld.onclick = () => {
  const p = els.worldPrompt.value.trim();
  if (!p) return;
  state.bgName = 'Generated'; els.bgSel.value = 'Generated';
  state.worldImg = null; buildBg();          // show placeholder immediately
  generateWorld(p, false);
};
els.worldPrompt.onkeydown = (e) => { if (e.key === 'Enter') els.genWorld.onclick(); };

buildGrades();
buildBgSelect();
renderCast();
setInterval(tickTimer, 250);
navigator.mediaDevices?.enumerateDevices().then(() => refreshDevices()).catch(() => {});
log('Control panel ready. Click “Start camera”.');
