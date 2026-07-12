// Cut! — Audition Room. Hands-free video self-tape with a turn-based AI scene partner.
// No buttons per line: it listens continuously, hears when you speak, auto-endpoints on
// silence, POSTs the turn to the scale-to-zero FC reader, plays the reply, then hands the
// scene back to you. One POST = one acting beat.
//
// State machine:  LISTENING → HEARING(you talk) → THINKING(POST /costar) → SPEAKING(reply) → LISTENING

// Deployed cut-audition FC function (scale-to-zero, ap-southeast-1). For local dev,
// swap to 'http://localhost:8787' and run audition/server/app.py.
const BACKEND_URL = 'https://cut-audition-htjhmbyvbv.ap-southeast-1.fcapp.run';
const ASR_RATE = 16000;        // qwen3-asr-flash wants 16 kHz mono (see research/asr.md)
const START_RMS = 0.020;       // onset threshold (enter HEARING) — low enough for quiet mics
const END_RMS   = 0.011;       // below this counts as silence (hysteresis vs START)
const ONSET_BLK = 2;           // consecutive loud blocks before we believe it's speech
const END_SILENCE_MS = 1200;   // trailing silence that ends your line (waits so a dramatic pause doesn't cut you off)
const MIN_SPEECH_MS  = 400;    // ignore blips shorter than this
const MAX_LINE_MS    = 20000;  // hard cap on one line
const PREROLL = 5;             // blocks of audio kept before onset so the first word isn't clipped
const MEDIA = { video:{ width:{ideal:1280}, height:{ideal:720}, facingMode:'user' },
                audio:{ echoCancellation:true, noiseSuppression:true, autoGainControl:true } };

const SCENES = [
  { id:'diner', title:'The Diner — drama',
    ai_character:'MAYA, an ex who moved on', human_character:'the one who came back',
    premise:'Two former partners collide at a late-night diner a year after a bad breakup. One wants closure; the other has already let go.',
    tone:'restrained, aching, subtext-heavy', voice:'Serena',   // mature female
    opening:"I didn't think you still knew this place existed." },
  { id:'heist', title:'The Job — thriller',
    ai_character:'DELACROIX, a nervous crew lead', human_character:'the specialist they hired',
    premise:'Minutes before a job goes live, the crew lead realizes the plan has a hole and confronts the specialist who swore it was airtight.',
    tone:'tense, clipped, high-stakes', voice:'Ethan',          // male
    opening:"Tell me the third floor is handled. Look at me and tell me." },
  { id:'sitcom', title:'Roommates — comedy',
    ai_character:'SAM, an over-caffeinated roommate', human_character:'the exhausted roommate',
    premise:'One roommate has "improved" the apartment with a baffling new system while the other just wants coffee at 7am.',
    tone:'fast, warm, comedic', voice:'Cherry',                 // bright female
    opening:"Okay before you say anything — the color-coding is going to change your LIFE." },
  { id:'oneword', title:'Cold read — open improv',
    ai_character:'a stranger with a secret', human_character:'yourself',
    premise:'A pure improv two-hander. The AI plays a stranger who clearly knows something you do not. Follow the scene wherever it goes.',
    tone:'natural, grounded, discovery', voice:'Elias',         // measured male
    opening:"You're early. That's either very good or very bad." },
];

const el = id => document.getElementById(id);
const $ = {
  sceneSel:el('sceneSel'), humanChar:el('humanChar'), aiChar:el('aiChar'),
  premise:el('scenePremise'), opening:el('sceneOpening'), scriptBox:el('scriptBox'),
  startBtn:el('startBtn'), stopBtn:el('stopBtn'), newTakeBtn:el('newTakeBtn'), saveBtn:el('saveBtn'),
  cam:el('cam'), camOff:el('camOff'), pill:el('pill'), meterFill:el('meterFill'),
  subtitle:el('subtitle'), whoSpoke:el('whoSpoke'), dialogue:el('dialogue'),
  notesList:el('notesList'), stakes:document.querySelectorAll('.stakes i'),
  recDot:el('recDot'), sessionTime:el('sessionTime'), takeTag:el('takeTag'), player:el('player'),
  playback:el('playback'),
};

const S = {
  scene:null, history:[], take:1, state:'idle',           // idle|listening|hearing|thinking|speaking
  stream:null, audioCtx:null, node:null, source:null, srcRate:48000,
  ring:[], buffer:[], bufLen:0, onset:0, silenceMs:0, speechMs:0, lineMs:0,
  recorder:null, chunks:[], sessionStart:0, timer:0,
  cues:[], recordStart:0, playbackUrl:null,               // co-star caption cues for playback overlay
  mixDest:null, playerSrc:null,                           // Web Audio: mic + reader voice → recording
  canvas:null, cctx:null, rafId:0, costarShot:{who:'',line:''},   // director's-cut compositor
};

// Persistent audio graph. Created once (createMediaElementSource can bind $.player only
// once, ever), reused across takes: mic + the reader's TTS voice are mixed into mixDest,
// whose stream feeds the recorder — so the saved tape actually contains the spoken lines.
function ensureAudioGraph(){
  if (S.audioCtx) return;
  S.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  S.mixDest = S.audioCtx.createMediaStreamDestination();
  S.playerSrc = S.audioCtx.createMediaElementSource($.player);
  S.playerSrc.connect(S.mixDest);              // reader voice → recording
  S.playerSrc.connect(S.audioCtx.destination); // reader voice → speakers
}

// ---- director's-cut compositor -----------------------------------------
// We don't record the raw camera. We record a CANVAS that cuts between your shot
// (camera, on your turns) and the co-star's shot (a card with their line, on their
// turns), letterboxed. The recorder is paused during "thinking" (setState), so the
// AI's latency never enters the video → a tight, coherent edited scene.
function ensureCanvas(){
  if (S.canvas) return;
  S.canvas = document.createElement('canvas'); S.canvas.width = 1280; S.canvas.height = 720;
  S.cctx = S.canvas.getContext('2d');
}
function coverDraw(c, v, W, H){
  const vw=v.videoWidth, vh=v.videoHeight; if (!vw) return;
  const s=Math.max(W/vw, H/vh), dw=vw*s, dh=vh*s;
  c.drawImage(v, (W-dw)/2, (H-dh)/2, dw, dh);
}
function wrapText(c, text, x, y, maxW, lh){
  const words=(text||'').split(' '); const lines=[]; let line='';
  for (const w of words){ const t=line?line+' '+w:w; if (c.measureText(t).width>maxW && line){ lines.push(line); line=w; } else line=t; }
  if (line) lines.push(line);
  let yy = y - (lines.length-1)*lh/2;
  for (const ln of lines){ c.fillText(ln, x, yy); yy+=lh; }
}
function drawFrame(){
  S.rafId = requestAnimationFrame(drawFrame);
  const c=S.cctx; if (!c) return;
  const W=1280, H=720, bar=54;
  if (S.state === 'speaking'){                       // cut to the co-star
    const g=c.createLinearGradient(0,0,W,H); g.addColorStop(0,'#1c1420'); g.addColorStop(1,'#08080f');
    c.fillStyle=g; c.fillRect(0,0,W,H);
    c.textAlign='center';
    c.fillStyle='#ffb056'; c.font='600 30px system-ui,sans-serif';
    c.fillText((S.costarShot.who||'').toUpperCase(), W/2, H*0.30);
    c.fillStyle='#eef0f6'; c.font='italic 42px Georgia,serif';
    wrapText(c, S.costarShot.line||'', W/2, H*0.52, W*0.76, 58);
  } else {                                           // your shot (camera)
    c.fillStyle='#0b0b12'; c.fillRect(0,0,W,H);
    if ($.cam.videoWidth) coverDraw(c, $.cam, W, H);
  }
  c.fillStyle='#000'; c.fillRect(0,0,W,bar); c.fillRect(0,H-bar,W,bar);   // letterbox
}

// arm a fresh recorder (own chunks array). Records the COMPOSITED canvas + mixed audio
// (your mic + the reader's voice), so the tape is the edited two-shot with the voice in it.
function armRecorder(){
  ensureCanvas();
  const cv = S.canvas.captureStream(30);
  const audio = S.mixDest ? S.mixDest.stream.getAudioTracks() : (S.stream ? S.stream.getAudioTracks() : []);
  const recStream = new MediaStream([ ...cv.getVideoTracks(), ...audio ]);
  const rec = new MediaRecorder(recStream, pickMime());
  const chunks = [];
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  S.recorder = rec; S.chunks = chunks;
  return rec;
}

// ---- scene picker -------------------------------------------------------
function fillScenes(){
  SCENES.forEach((s,i)=>{ const o=document.createElement('option'); o.value=i; o.textContent=s.title; $.sceneSel.appendChild(o); });
  $.sceneSel.onchange = ()=>selectScene(+$.sceneSel.value);
  selectScene(0);
}
function selectScene(i){
  const s = SCENES[i]; S.scene = s;
  $.humanChar.textContent = s.human_character; $.aiChar.textContent = s.ai_character;
  $.premise.textContent = s.premise; $.opening.textContent = '"'+s.opening+'"';
}

// ---- state --------------------------------------------------------------
function setState(st){
  S.state = st;
  const ai = S.scene ? S.scene.ai_character.split(',')[0] : 'Reader';
  $.pill.className = 'pill ' + st;
  $.pill.innerHTML = ({
    idle:'Press <b>Start audition</b>',
    listening:'🎧 Your turn — act (Space / tap when done)',
    hearing:'Hearing you…',
    thinking:'Reader responding…',
    speaking: ai + ' is speaking',
  })[st] || st;
  $.recDot.className = 'rec-dot ' + (st==='idle' ? 'off' : 'on');
  // edit out the AI's latency: don't record the "thinking" gap into the tape
  if (S.recorder){
    if (st === 'thinking' && S.recorder.state === 'recording'){ try { S.recorder.pause(); } catch(_){} }
    else if (st !== 'thinking' && S.recorder.state === 'paused'){ try { S.recorder.resume(); } catch(_){} }
  }
}

// ---- start --------------------------------------------------------------
$.startBtn.onclick = async () => {
  try {
    setState('idle'); $.pill.textContent = 'Starting…';
    try { $.playback.pause(); } catch(_){}                 // leaving playback → back to live
    $.playback.hidden = true; $.cam.style.display = '';
    fetch(BACKEND_URL + '/warm').catch(()=>{});           // hide FC cold start
    if (!S.stream){                                        // grab it now if the preview didn't already
      S.stream = await navigator.mediaDevices.getUserMedia(MEDIA);
      $.cam.srcObject = S.stream; $.camOff.style.display = 'none';
    }
    ensureAudioGraph();
    if (S.audioCtx.state === 'suspended') await S.audioCtx.resume();
    S.srcRate = S.audioCtx.sampleRate;
    S.source = S.audioCtx.createMediaStreamSource(S.stream);
    S.node = S.audioCtx.createScriptProcessor(4096, 1, 1);
    S.node.onaudioprocess = onAudio;
    S.source.connect(S.node); S.node.connect(S.audioCtx.destination);   // VAD/meter tap (silent)
    S.source.connect(S.mixDest);                                        // your mic → recording
    $.startBtn.disabled = true; $.stopBtn.disabled = false;
    $.newTakeBtn.disabled = false; $.saveBtn.disabled = false;
    beginTake(true);
  } catch (e) { setState('idle'); $.pill.textContent = 'Camera/mic blocked: ' + e.message; }
};

// stop the audition, then play back the take you just recorded.
$.stopBtn.onclick = () => {
  stopSR();
  try { $.player.pause(); } catch(_){}
  clearInterval(S.timer);
  cancelAnimationFrame(S.rafId); S.rafId = 0;              // stop compositing
  const finish = () => {                                   // runs once the recording is flushed
    try { S.node && S.node.disconnect(); S.source && S.source.disconnect(); } catch(_){}
    try { S.stream && S.stream.getTracks().forEach(t => t.stop()); } catch(_){}
    S.stream = S.node = S.source = null; S.state = 'idle';  // keep audioCtx/mixDest/playerSrc for next take
    $.subtitle.textContent = ''; $.whoSpoke.textContent = ''; $.meterFill.style.width = '0';
    $.recDot.className = 'rec-dot off';
    if (S.chunks && S.chunks.length){                       // play back the director's cut
      if (S.playbackUrl) URL.revokeObjectURL(S.playbackUrl);
      S.playbackUrl = URL.createObjectURL(new Blob(S.chunks, { type:'video/webm' }));
      $.cam.style.display = 'none'; $.camOff.style.display = 'none';
      $.playback.src = S.playbackUrl; $.playback.hidden = false; $.playback.ontimeupdate = null;
      $.pill.className = 'pill idle'; $.pill.innerHTML = '▶ Take ' + S.take + ' — director’s cut';
      $.playback.play().catch(()=>{});                      // the cut already has the shots, captions + voice baked in
      $.saveBtn.disabled = false;                           // let them keep the take
    } else {
      $.cam.srcObject = null; $.camOff.style.display = ''; setState('idle'); $.saveBtn.disabled = true;
    }
    $.startBtn.disabled = false; $.stopBtn.disabled = true; $.newTakeBtn.disabled = true;
  };
  if (S.recorder && S.recorder.state !== 'inactive'){ S.recorder.onstop = finish; try { S.recorder.stop(); } catch(_){ finish(); } }
  else finish();
};
function pickMime(){ for (const m of ['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm']) if (MediaRecorder.isTypeSupported(m)) return {mimeType:m}; return {}; }

function beginTake(first){
  stopSR(); try { $.player.pause(); } catch(_){}      // cancel any in-flight turn from the previous take
  S.history = []; S.take = first ? 1 : S.take + 1;
  $.takeTag.textContent = 'take ' + S.take;
  $.dialogue.innerHTML = ''; setStakes(0);
  $.notesList.innerHTML = '<p class="muted">Notes on your delivery appear here after each line.</p>';
  // start a clean recording for this take (t=0): composite canvas + mixed audio
  ensureCanvas(); if (!S.rafId) S.rafId = requestAnimationFrame(drawFrame);
  try { S.recorder && S.recorder.state !== 'inactive' && S.recorder.stop(); } catch(_){}
  armRecorder(); S.cues = [];
  try { S.recorder.start(); } catch(_){}
  S.recordStart = performance.now();
  S.sessionStart = performance.now(); startTimer();
  resetCapture();
  if (currentScript()){                                                 // scripted: you start from the sides
    resumeListening();
  } else {                                                              // improv: the reader opens
    addTurn('costar', S.scene.ai_character, S.scene.opening);
    S.history.push({ who:'costar', text:S.scene.opening });
    say(S.scene.ai_character, S.scene.opening);
  }
}
function currentScript(){ return ($.scriptBox.value || '').trim(); }
$.newTakeBtn.onclick = () => { if (S.state==='thinking') return; beginTake(false); };

// ---- turn detection -----------------------------------------------------
// Primary: the browser's SpeechRecognition — it transcribes as you talk, so the
// transcript is ready the instant you stop. We POST *text*, and the reader only does
// reply + TTS (~3s) instead of ASR + reply + TTS (~6s). Fallback: the energy-VAD below
// uploads audio for server ASR (browsers without SpeechRecognition, e.g. Firefox).
const SR_CLASS = window.SpeechRecognition || window.webkitSpeechRecognition;
// SpeechRecognition contends with the camera/mic capture in Chrome — it gets no audio and
// stalls in "listening". Default OFF: use the reliable energy-VAD on our own mic stream,
// with a manual "done" fallback. (Set true only if you drop the recorder/Web-Audio mic use.)
const USE_SR = false;

function resetCapture(){ S.buffer=[]; S.bufLen=0; S.onset=0; S.silenceMs=0; S.speechMs=0; S.lineMs=0; }

// hand the scene back to the actor
function resumeListening(){ resetCapture(); setState('listening'); if (USE_SR) startSR(); }

// send the buffered line — called by auto-endpoint AND the manual "done" (space / tap video)
function finishLine(){
  if (S.state !== 'hearing') return;                     // only when you've actually started talking
  const wav = encodeWav(flatten(S.buffer, S.bufLen), S.srcRate);
  resetCapture();
  runTurn({ audio: wav });
}
function manualDone(){ if (S.state === 'hearing') finishLine(); }

function startSR(){
  if (!USE_SR || S.state !== 'listening') return;
  const rec = new SR_CLASS();
  rec.lang = 'en-US'; rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
  S.recog = rec; let finalText = '';
  rec.onresult = e => {
    let interim=''; finalText='';
    for (const res of e.results){ res.isFinal ? (finalText += res[0].transcript) : (interim += res[0].transcript); }
    if ((interim || finalText) && S.state === 'listening') setState('hearing');   // you started talking
  };
  rec.onend = () => {
    if (S.state !== 'listening' && S.state !== 'hearing') return;   // stopped / already in a turn
    const t = finalText.trim();
    if (t) runTurn({ text: t });                                    // your line is ready → reply
    else startSR();                                                 // heard nothing → keep listening
  };
  rec.onerror = ev => {
    if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') return;
    if (S.state === 'listening' || S.state === 'hearing') setTimeout(startSR, 250);
  };
  try { rec.start(); } catch(_){}
}
function stopSR(){ try { if (S.recog){ S.recog.onend = S.recog.onerror = null; S.recog.abort(); S.recog = null; } } catch(_){} }

// energy-VAD fallback (also drives the live level meter in both modes)
function onAudio(e){
  const blk = e.inputBuffer.getChannelData(0);
  let sum=0; for (let i=0;i<blk.length;i++) sum += blk[i]*blk[i];
  const rms = Math.sqrt(sum/blk.length);
  $.meterFill.style.width = Math.min(100, rms*450) + '%';          // live level (always)
  if (USE_SR) return;                                              // SR drives turns; audio only feeds the meter
  const ms = (blk.length / S.srcRate) * 1000;
  if (S.state !== 'listening' && S.state !== 'hearing') return;
  S.ring.push(new Float32Array(blk)); if (S.ring.length > PREROLL) S.ring.shift();
  if (S.state === 'listening'){
    if (rms > START_RMS){ if (++S.onset >= ONSET_BLK){
      setState('hearing'); S.buffer = S.ring.slice(); S.bufLen = S.buffer.reduce((n,b)=>n+b.length,0);
      S.silenceMs=0; S.speechMs=0; S.lineMs=0; } }
    else S.onset = 0;
    return;
  }
  S.buffer.push(new Float32Array(blk)); S.bufLen += blk.length; S.lineMs += ms;
  if (rms < END_RMS) S.silenceMs += ms; else { S.silenceMs = 0; S.speechMs += ms; }
  if (S.silenceMs >= END_SILENCE_MS || S.lineMs >= MAX_LINE_MS){
    if (S.speechMs < MIN_SPEECH_MS){ resetCapture(); setState('listening'); return; }  // false trigger — keep listening
    finishLine();
  }
}

// ---- one beat: POST /costar (text or audio) → render → reader speaks → resume ----
async function runTurn(extra){
  setState('thinking');
  const thinking = addTurn('costar', S.scene.ai_character, '…', true);
  try {
    const r = await fetch(BACKEND_URL + '/costar', { method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(Object.assign({ scene: sceneForApi(), history: S.history }, extra)) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || ('HTTP '+r.status));
    thinking.remove();
    const heard = (data.heard && data.heard.text) || extra.text || '(unclear)';
    addTurn('actor', 'You', heard); S.history.push({ who:'actor', text:heard });
    addTurn('costar', S.scene.ai_character, data.line); S.history.push({ who:'costar', text:data.line });
    if (data.note) addNote(heard, data.note);
    if (data.stakes) setStakes(data.stakes);
    say(S.scene.ai_character, data.line, data.audio);      // speak, then resume listening
  } catch (e) {
    thinking.remove();
    $.pill.textContent = 'Reader error: ' + e.message; $.pill.className = 'pill idle';
    setTimeout(resumeListening, 1400);                     // recover, keep the scene alive
  }
}

// speak a co-star line, then hand the turn back. If we weren't handed audio
// (e.g. the opening line), synthesize it via /say so the whole scene is voiced.
async function say(who, line, audioUri){
  $.subtitle.textContent = line;
  $.whoSpoke.textContent = who.split(',')[0];
  S.costarShot = { who: who.split(',')[0], line };         // what the co-star's canvas shot shows
  setState('speaking');
  // timestamp this co-star line against the recording, for the playback overlay
  const cue = S.recordStart ? { t:(performance.now()-S.recordStart)/1000, end:0, text:line, who:who.split(',')[0] } : null;
  if (cue){ cue.end = cue.t + Math.min(6, Math.max(2, line.length*0.06)); S.cues.push(cue); }  // estimate; refined on 'ended'
  const done = () => { if (cue) cue.end = (performance.now()-S.recordStart)/1000; };
  if (!audioUri){
    try {
      const r = await fetch(BACKEND_URL + '/say', { method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ text: line, voice: S.scene.voice }) });
      const d = await r.json();
      if (r.ok && d.audio) audioUri = d.audio;
    } catch(_){ /* fall through to a timed beat */ }
  }
  if (audioUri){
    $.player.src = audioUri;
    $.player.onended = () => { done(); resumeListening(); };
    $.player.play().catch(()=>beat(line));
  } else beat(line);                                       // no audio available — read-beat then listen
}
function beat(line){ setTimeout(resumeListening, Math.min(4500, 900 + line.length * 45)); }

function sceneForApi(){ const s=S.scene; return {
  ai_character:s.ai_character, human_character:s.human_character,
  premise:s.premise, tone:s.tone, voice:s.voice, opening:s.opening, language:'en',
  script: currentScript() }; }

// ---- rendering ----------------------------------------------------------
function addTurn(kind, who, text, thinking){
  const d = document.createElement('div');
  d.className = 'turn ' + kind + (thinking ? ' thinking' : '');
  d.innerHTML = '<div class="who"></div><div class="txt"></div>';
  d.querySelector('.who').textContent = who; d.querySelector('.txt').textContent = text;
  $.dialogue.appendChild(d); $.dialogue.scrollTop = $.dialogue.scrollHeight; return d;
}
function addNote(line, note){
  const m = $.notesList.querySelector('.muted'); if (m) m.remove();
  const n = document.createElement('div'); n.className='note';
  n.innerHTML = '<div class="n-line"></div><div class="n-note"></div>';
  n.querySelector('.n-line').textContent = '“'+line+'”';
  n.querySelector('.n-note').textContent = note;
  $.notesList.appendChild(n); $.notesList.scrollTop = $.notesList.scrollHeight;
}
function setStakes(v){ $.stakes.forEach((i,ix)=> i.classList.toggle('on', ix < v)); }

// ---- save take ----------------------------------------------------------
$.saveBtn.onclick = () => {
  // Full self-tape (video+audio) + transcript. NEXT: POST to FC /sign -> PUT to OSS (oss2).
  const stop = () => new Promise(res => {
    if (!S.recorder || S.recorder.state==='inactive') return res();
    S.recorder.onstop = res; S.recorder.stop(); });
  stop().then(()=>{
    const blob = new Blob(S.chunks, { type:'video/webm' });
    dl(URL.createObjectURL(blob), `audition-${S.scene.id}-take${S.take}.webm`);
    dl('data:application/json,'+encodeURIComponent(JSON.stringify(
        { scene:S.scene.title, take:S.take, dialogue:S.history, captions:S.cues }, null, 2)),
       `audition-${S.scene.id}-take${S.take}.json`);
    if (S.stream && S.stream.active){ armRecorder(); try { S.recorder.start(); S.recordStart = performance.now(); S.cues = []; } catch(_){} }
  });
};
function dl(href, name){ const a=document.createElement('a'); a.href=href; a.download=name; a.click(); }

// ---- session timer ------------------------------------------------------
function startTimer(){
  clearInterval(S.timer);
  S.timer = setInterval(()=>{ const s=Math.floor((performance.now()-S.sessionStart)/1000);
    $.sessionTime.textContent = String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0'); }, 500);
}

// ---- WAV encode (Float32 @ srcRate → 16 kHz mono 16-bit PCM → data URI) --
function flatten(chunks, len){ const out=new Float32Array(len); let o=0; for (const c of chunks){ out.set(c,o); o+=c.length; } return out; }
function downsample(buf, from, to){
  if (to >= from) return buf;
  const ratio=from/to, outLen=Math.round(buf.length/ratio), out=new Float32Array(outLen);
  let oi=0, ii=0;
  while (oi < outLen){ const next=Math.round((oi+1)*ratio); let sum=0,n=0;
    for (; ii<next && ii<buf.length; ii++){ sum+=buf[ii]; n++; } out[oi++] = n? sum/n : 0; }
  return out;
}
function encodeWav(float, srcRate){
  const pcm = downsample(float, srcRate, ASR_RATE);
  const buf = new ArrayBuffer(44 + pcm.length*2), view = new DataView(buf);
  const w=(o,s)=>{ for (let i=0;i<s.length;i++) view.setUint8(o+i, s.charCodeAt(i)); };
  w(0,'RIFF'); view.setUint32(4,36+pcm.length*2,true); w(8,'WAVE'); w(12,'fmt ');
  view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true);
  view.setUint32(24,ASR_RATE,true); view.setUint32(28,ASR_RATE*2,true);
  view.setUint16(32,2,true); view.setUint16(34,16,true); w(36,'data'); view.setUint32(40,pcm.length*2,true);
  let off=44; for (let i=0;i<pcm.length;i++,off+=2){ const s=Math.max(-1,Math.min(1,pcm[i])); view.setInt16(off, s<0? s*0x8000 : s*0x7FFF, true); }
  let bin=''; const bytes=new Uint8Array(buf); for (let i=0;i<bytes.length;i++) bin+=String.fromCharCode(bytes[i]);
  return 'data:audio/wav;base64,' + btoa(bin);
}

// ---- camera preview on load + manual "done" -----------------------------
async function initCamera(){                 // show the webcam immediately — don't wait for Start
  try {
    S.stream = await navigator.mediaDevices.getUserMedia(MEDIA);
    $.cam.srcObject = S.stream; $.camOff.style.display = 'none';
  } catch(e){
    const p = $.camOff.querySelector('p'); if (p) p.textContent = 'Camera blocked — allow it, then press Start';
  }
}
// never get stuck if auto-detect misjudges: press Space or tap the video to end your line
document.addEventListener('keydown', e => {
  if (e.code === 'Space' && (S.state === 'hearing' || S.state === 'listening')){ e.preventDefault(); manualDone(); }
});
document.querySelector('.video-wrap').addEventListener('click', manualDone);

fillScenes();
initCamera();
