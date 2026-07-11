// Cut! — Audition Room. Turn-based scene partner on the scale-to-zero FC reader.
// Loop per beat: capture your line (Web Audio -> 16kHz mono WAV) -> POST /costar
// -> {heard, line, note, stakes, audio} -> render + speak. One POST = one acting beat.

// Same Alibaba Function Compute reader the director panel uses (holds the DashScope key).
const BACKEND_URL = 'https://cut-perceive-xfdwmitvbk.ap-southeast-1.fcapp.run';
const ASR_RATE = 16000;          // qwen3-asr-flash wants 16 kHz mono (see research/asr.md)
const SILENCE_MS = 1200;         // auto-end your line after this much trailing silence
const MAX_LINE_MS = 20000;       // hard cap on a single delivered line

// Built-in sides. Each: who the AI plays, who you play, the premise, its voice, an opener.
const SCENES = [
  { id:'diner', title:'The Diner — drama',
    ai_character:'MAYA, an ex who moved on', human_character:'the one who came back',
    premise:'Two former partners collide at a late-night diner a year after a bad breakup. One wants closure; the other has already let go.',
    tone:'restrained, aching, subtext-heavy', voice:'Cherry',
    opening:"I didn't think you still knew this place existed." },
  { id:'heist', title:'The Job — thriller',
    ai_character:'DELACROIX, a nervous crew lead', human_character:'the specialist they hired',
    premise:'Minutes before a job goes live, the crew lead realizes the plan has a hole and confronts the specialist who swore it was airtight.',
    tone:'tense, clipped, high-stakes', voice:'Ethan',
    opening:"Tell me the third floor is handled. Look at me and tell me." },
  { id:'sitcom', title:'Roommates — comedy',
    ai_character:'SAM, an over-caffeinated roommate', human_character:'the exhausted roommate',
    premise:'One roommate has "improved" the apartment with a baffling new system while the other just wants coffee at 7am.',
    tone:'fast, warm, comedic', voice:'Chelsie',
    opening:"Okay before you say anything — the color-coding is going to change your LIFE." },
  { id:'oneword', title:'Cold read — open improv',
    ai_character:'a stranger with a secret', human_character:'yourself',
    premise:'A pure improv two-hander. The AI plays a stranger who clearly knows something you do not. Follow the scene wherever it goes.',
    tone:'natural, grounded, discovery', voice:'Serena',
    opening:"You're early. That's either very good or very bad." },
];

const els = id => document.getElementById(id);
const $ = {
  sceneSel:els('sceneSel'), humanChar:els('humanChar'), aiChar:els('aiChar'),
  premise:els('scenePremise'), opening:els('sceneOpening'),
  startBtn:els('startBtn'), lineBtn:els('lineBtn'), newTakeBtn:els('newTakeBtn'), saveBtn:els('saveBtn'),
  status:els('status'), dialogue:els('dialogue'), subtitle:els('subtitle'),
  notesList:els('notesList'), stakes:document.querySelectorAll('.stakes i'),
  recDot:els('recDot'), sessionTime:els('sessionTime'), takeTag:els('takeTag'), player:els('player'),
};

const state = {
  scene:null, history:[], take:1, started:false, busy:false,
  micStream:null, audioCtx:null, node:null, source:null,
  capturing:false, buffers:[], captureLen:0, srcRate:48000,
  speechSeen:false, silenceRun:0, capStart:0,
  recorder:null, sessionChunks:[], sessionStart:0, timer:0,
};

// ---- scene picker -------------------------------------------------------
function fillScenes(){
  SCENES.forEach((s,i)=>{ const o=document.createElement('option'); o.value=i; o.textContent=s.title; $.sceneSel.appendChild(o); });
  $.sceneSel.onchange = ()=>selectScene(+$.sceneSel.value);
  selectScene(0);
}
function selectScene(i){
  const s = SCENES[i];
  state.scene = s;
  $.humanChar.textContent = s.human_character;
  $.aiChar.textContent = s.ai_character;
  $.premise.textContent = s.premise;
  $.opening.textContent = '"'+s.opening+'"';
}

// ---- start / warm -------------------------------------------------------
$.startBtn.onclick = async () => {
  try {
    setStatus('Warming the reader…');
    fetch(BACKEND_URL + '/warm').catch(()=>{});     // fire-and-forget cold-start hider
    state.micStream = await navigator.mediaDevices.getUserMedia({ audio:{ echoCancellation:true, noiseSuppression:true } });
    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    state.srcRate = state.audioCtx.sampleRate;
    // full-take recorder (for Save take)
    state.recorder = new MediaRecorder(state.micStream);
    state.recorder.ondataavailable = e => e.data.size && state.sessionChunks.push(e.data);
    state.started = true;
    $.startBtn.disabled = true; $.lineBtn.disabled = false;
    $.newTakeBtn.disabled = false; $.saveBtn.disabled = false;
    beginTake(true);
    setStatus('You’re rolling. Press “Deliver your line”, say it, and stop talking — the reader replies.');
  } catch (e) {
    setStatus('Mic access failed: ' + e.message);
  }
};

function beginTake(first){
  state.history = [];
  state.take = first ? 1 : state.take + 1;
  $.takeTag.textContent = 'take ' + state.take;
  $.dialogue.innerHTML = '';
  $.subtitle.textContent = '';
  setStakes(0);
  // the reader opens the scene (their character speaks first)
  addTurn('costar', state.scene.ai_character, state.scene.opening);
  state.history.push({ who:'costar', text: state.scene.opening });
  $.subtitle.textContent = state.scene.opening;
  // start a fresh full-session recording
  state.sessionChunks = [];
  try { state.recorder && state.recorder.state==='inactive' && state.recorder.start(); } catch(_){}
  state.sessionStart = performance.now();
  startTimer();
}

$.newTakeBtn.onclick = () => { if (state.busy) return; stopCapture(true); beginTake(false); setStatus('Fresh take — same scene, new choices.'); };

// ---- deliver-a-line capture (Web Audio) --------------------------------
$.lineBtn.onclick = () => { state.capturing ? stopCapture() : startCapture(); };

function startCapture(){
  if (state.busy || !state.started) return;
  state.capturing = true; state.buffers = []; state.captureLen = 0;
  state.speechSeen = false; state.silenceRun = 0; state.capStart = performance.now();
  state.source = state.audioCtx.createMediaStreamSource(state.micStream);
  state.node = state.audioCtx.createScriptProcessor(4096, 1, 1);
  state.node.onaudioprocess = onAudio;
  state.source.connect(state.node); state.node.connect(state.audioCtx.destination);
  $.lineBtn.classList.add('recording'); $.lineBtn.textContent = '● Listening… (stop when done)';
  $.recDot.className = 'rec-dot on';
}

function onAudio(e){
  const buf = e.inputBuffer.getChannelData(0);
  state.buffers.push(new Float32Array(buf)); state.captureLen += buf.length;
  // crude energy VAD for auto-endpointing
  let sum=0; for (let i=0;i<buf.length;i++) sum += buf[i]*buf[i];
  const rms = Math.sqrt(sum/buf.length);
  const blockMs = (buf.length / state.srcRate) * 1000;
  if (rms > 0.02) { state.speechSeen = true; state.silenceRun = 0; }
  else if (state.speechSeen) { state.silenceRun += blockMs; }
  const elapsed = performance.now() - state.capStart;
  if ((state.speechSeen && state.silenceRun >= SILENCE_MS) || elapsed >= MAX_LINE_MS) stopCapture();
}

function stopCapture(silent){
  if (!state.capturing) return;
  state.capturing = false;
  try { state.node.disconnect(); state.source.disconnect(); } catch(_){}
  $.lineBtn.classList.remove('recording'); $.lineBtn.textContent = '🎙 Deliver your line';
  $.recDot.className = 'rec-dot off';
  if (silent) return;                              // aborted (e.g. New take) — don't send
  if (!state.speechSeen || state.captureLen < state.srcRate * 0.3) {
    setStatus('Didn’t catch a line — try again, a little louder.'); return;
  }
  sendLine(encodeWav(flatten(state.buffers, state.captureLen), state.srcRate));
}

// ---- the beat: POST /costar --------------------------------------------
async function sendLine(wavDataUri){
  state.busy = true; $.lineBtn.disabled = true;
  const thinking = addTurn('costar', state.scene.ai_character, '…', true);
  setStatus('Reader is listening and responding…');
  try {
    const r = await fetch(BACKEND_URL + '/costar', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ scene: sceneForApi(), history: state.history, audio: wavDataUri }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    // your line (as heard)
    const heard = (data.heard && data.heard.text) || '(unclear)';
    addTurn('actor', 'You', heard); state.history.push({ who:'actor', text: heard });
    // reader's line
    thinking.remove();
    addTurn('costar', state.scene.ai_character, data.line);
    state.history.push({ who:'costar', text: data.line });
    $.subtitle.textContent = data.line;
    if (data.note) addNote(heard, data.note);
    if (data.stakes) setStakes(data.stakes);
    if (data.audio) { $.player.src = data.audio; $.player.play().catch(()=>{}); }
    setStatus('Your line back to them.');
  } catch (e) {
    thinking.remove();
    setStatus('Reader error: ' + e.message);
  } finally {
    state.busy = false; $.lineBtn.disabled = false;
  }
}

function sceneForApi(){
  const s = state.scene;
  return { ai_character:s.ai_character, human_character:s.human_character,
           premise:s.premise, tone:s.tone, voice:s.voice, opening:s.opening, language:'en' };
}

// ---- rendering ----------------------------------------------------------
function addTurn(kind, who, text, thinking){
  const d = document.createElement('div');
  d.className = 'turn ' + kind + (thinking ? ' thinking' : '');
  d.innerHTML = '<div class="who"></div><div class="txt"></div>';
  d.querySelector('.who').textContent = who;
  d.querySelector('.txt').textContent = text;
  $.dialogue.appendChild(d); $.dialogue.scrollTop = $.dialogue.scrollHeight;
  return d;
}
function addNote(line, note){
  const first = $.notesList.querySelector('.muted'); if (first) first.remove();
  const n = document.createElement('div'); n.className = 'note';
  n.innerHTML = '<div class="n-line"></div><div class="n-note"></div>';
  n.querySelector('.n-line').textContent = '“' + line + '”';
  n.querySelector('.n-note').textContent = note;
  $.notesList.appendChild(n); $.notesList.scrollTop = $.notesList.scrollHeight;
}
function setStakes(v){ $.stakes.forEach((i,ix)=> i.classList.toggle('on', ix < v)); }
function setStatus(t){ $.status.textContent = t; }

// ---- save take ----------------------------------------------------------
$.saveBtn.onclick = () => {
  // Full-session mic capture + transcript. NEXT: POST to FC /sign -> PUT to OSS (oss2)
  // so takes live in the cloud and become the self-tape casting reviews.
  const stop = () => new Promise(res => {
    if (!state.recorder || state.recorder.state === 'inactive') return res();
    state.recorder.onstop = res; state.recorder.stop();
  });
  stop().then(() => {
    const blob = new Blob(state.sessionChunks, { type:'audio/webm' });
    dl(URL.createObjectURL(blob), `audition-${state.scene.id}-take${state.take}.webm`);
    const transcript = { scene: state.scene.title, take: state.take, dialogue: state.history };
    dl('data:application/json,' + encodeURIComponent(JSON.stringify(transcript, null, 2)),
       `audition-${state.scene.id}-take${state.take}.json`);
    setStatus('Take saved (audio + transcript). Cloud save to OSS is the next wire-up.');
    try { state.recorder.start(); } catch(_){}   // resume for the next take
  });
};
function dl(href, name){ const a=document.createElement('a'); a.href=href; a.download=name; a.click(); }

// ---- session timer ------------------------------------------------------
function startTimer(){
  clearInterval(state.timer);
  state.timer = setInterval(()=>{
    const s = Math.floor((performance.now() - state.sessionStart)/1000);
    $.sessionTime.textContent = String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');
  }, 500);
}

// ---- WAV encode (Float32 @ srcRate -> 16 kHz mono 16-bit PCM -> data URI) --
function flatten(chunks, len){ const out=new Float32Array(len); let o=0; for (const c of chunks){ out.set(c,o); o+=c.length; } return out; }
function downsample(buf, from, to){
  if (to >= from) return buf;
  const ratio = from/to, outLen = Math.round(buf.length/ratio), out = new Float32Array(outLen);
  let oi=0, ii=0;
  while (oi < outLen){ const next = Math.round((oi+1)*ratio); let sum=0,n=0;
    for (; ii<next && ii<buf.length; ii++){ sum+=buf[ii]; n++; } out[oi++] = n? sum/n : 0; }
  return out;
}
function encodeWav(float, srcRate){
  const pcm = downsample(float, srcRate, ASR_RATE);
  const buf = new ArrayBuffer(44 + pcm.length*2), view = new DataView(buf);
  const w = (o,s)=>{ for (let i=0;i<s.length;i++) view.setUint8(o+i, s.charCodeAt(i)); };
  w(0,'RIFF'); view.setUint32(4, 36 + pcm.length*2, true); w(8,'WAVE'); w(12,'fmt ');
  view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true);
  view.setUint32(24,ASR_RATE,true); view.setUint32(28,ASR_RATE*2,true);
  view.setUint16(32,2,true); view.setUint16(34,16,true); w(36,'data'); view.setUint32(40,pcm.length*2,true);
  let off=44; for (let i=0;i<pcm.length;i++,off+=2){ const s=Math.max(-1,Math.min(1,pcm[i])); view.setInt16(off, s<0? s*0x8000 : s*0x7FFF, true); }
  // base64 the bytes
  let bin=''; const bytes=new Uint8Array(buf); for (let i=0;i<bytes.length;i++) bin+=String.fromCharCode(bytes[i]);
  return 'data:audio/wav;base64,' + btoa(bin);
}

fillScenes();
