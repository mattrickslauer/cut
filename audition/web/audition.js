// Cut! — Audition Room. Hands-free video self-tape with a turn-based AI scene partner.
// No buttons per line: it listens continuously, hears when you speak, auto-endpoints on
// silence, POSTs the turn to the scale-to-zero FC reader, plays the reply, then hands the
// scene back to you. One POST = one acting beat.
//
// State machine:  LISTENING → HEARING(you talk) → THINKING(POST /costar) → SPEAKING(reply) → LISTENING

const BACKEND_URL = 'http://localhost:8787';   // cut-audition FC function (or local server)
const ASR_RATE = 16000;        // qwen3-asr-flash wants 16 kHz mono (see research/asr.md)
const START_RMS = 0.028;       // onset threshold (enter HEARING)
const END_RMS   = 0.016;       // below this counts as silence (hysteresis vs START)
const ONSET_BLK = 2;           // consecutive loud blocks before we believe it's speech
const END_SILENCE_MS = 900;    // trailing silence that ends your line
const MIN_SPEECH_MS  = 400;    // ignore blips shorter than this
const MAX_LINE_MS    = 20000;  // hard cap on one line
const PREROLL = 5;             // blocks of audio kept before onset so the first word isn't clipped

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

const el = id => document.getElementById(id);
const $ = {
  sceneSel:el('sceneSel'), humanChar:el('humanChar'), aiChar:el('aiChar'),
  premise:el('scenePremise'), opening:el('sceneOpening'),
  startBtn:el('startBtn'), newTakeBtn:el('newTakeBtn'), saveBtn:el('saveBtn'),
  cam:el('cam'), camOff:el('camOff'), pill:el('pill'), meterFill:el('meterFill'),
  subtitle:el('subtitle'), whoSpoke:el('whoSpoke'), dialogue:el('dialogue'),
  notesList:el('notesList'), stakes:document.querySelectorAll('.stakes i'),
  recDot:el('recDot'), sessionTime:el('sessionTime'), takeTag:el('takeTag'), player:el('player'),
};

const S = {
  scene:null, history:[], take:1, state:'idle',           // idle|listening|hearing|thinking|speaking
  stream:null, audioCtx:null, node:null, source:null, srcRate:48000,
  ring:[], buffer:[], bufLen:0, onset:0, silenceMs:0, speechMs:0, lineMs:0,
  recorder:null, chunks:[], sessionStart:0, timer:0,
};

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
    listening:'🎧 Your turn — just act',
    hearing:'Hearing you…',
    thinking:'Reader responding…',
    speaking: ai + ' is speaking',
  })[st] || st;
  $.recDot.className = 'rec-dot ' + (st==='idle' ? 'off' : 'on');
}

// ---- start --------------------------------------------------------------
$.startBtn.onclick = async () => {
  try {
    setState('idle'); $.pill.textContent = 'Starting camera…';
    fetch(BACKEND_URL + '/warm').catch(()=>{});           // hide FC cold start
    S.stream = await navigator.mediaDevices.getUserMedia({
      video:{ width:{ideal:1280}, height:{ideal:720}, facingMode:'user' },
      audio:{ echoCancellation:true, noiseSuppression:true, autoGainControl:true } });
    $.cam.srcObject = S.stream; $.camOff.style.display = 'none';
    S.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (S.audioCtx.state === 'suspended') await S.audioCtx.resume();
    S.srcRate = S.audioCtx.sampleRate;
    S.source = S.audioCtx.createMediaStreamSource(S.stream);
    S.node = S.audioCtx.createScriptProcessor(4096, 1, 1);
    S.node.onaudioprocess = onAudio;
    S.source.connect(S.node); S.node.connect(S.audioCtx.destination);   // node emits silence (no echo)
    S.recorder = new MediaRecorder(S.stream, pickMime());               // full take (video+audio)
    S.recorder.ondataavailable = e => e.data.size && S.chunks.push(e.data);
    $.startBtn.disabled = true; $.newTakeBtn.disabled = false; $.saveBtn.disabled = false;
    beginTake(true);
  } catch (e) { setState('idle'); $.pill.textContent = 'Camera/mic blocked: ' + e.message; }
};
function pickMime(){ for (const m of ['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm']) if (MediaRecorder.isTypeSupported(m)) return {mimeType:m}; return {}; }

function beginTake(first){
  S.history = []; S.take = first ? 1 : S.take + 1;
  $.takeTag.textContent = 'take ' + S.take;
  $.dialogue.innerHTML = ''; setStakes(0);
  $.notesList.innerHTML = '<p class="muted">Notes on your delivery appear here after each line.</p>';
  addTurn('costar', S.scene.ai_character, S.scene.opening);              // reader opens; you respond
  S.history.push({ who:'costar', text:S.scene.opening });
  say(S.scene.ai_character, S.scene.opening);
  S.chunks = []; try { S.recorder && S.recorder.state==='inactive' && S.recorder.start(); } catch(_){}
  S.sessionStart = performance.now(); startTimer();
  resetCapture();
}
$.newTakeBtn.onclick = () => { if (S.state==='thinking') return; beginTake(false); };

// ---- continuous capture + VAD ------------------------------------------
function resetCapture(){ S.buffer=[]; S.bufLen=0; S.onset=0; S.silenceMs=0; S.speechMs=0; S.lineMs=0; }

function onAudio(e){
  const blk = e.inputBuffer.getChannelData(0);
  let sum=0; for (let i=0;i<blk.length;i++) sum += blk[i]*blk[i];
  const rms = Math.sqrt(sum/blk.length);
  const ms = (blk.length / S.srcRate) * 1000;
  $.meterFill.style.width = Math.min(100, rms*450) + '%';        // live level

  if (S.state !== 'listening' && S.state !== 'hearing') return;  // ignore mic while reader talks
  S.ring.push(new Float32Array(blk)); if (S.ring.length > PREROLL) S.ring.shift();

  if (S.state === 'listening'){
    if (rms > START_RMS){ if (++S.onset >= ONSET_BLK){          // speech onset
      setState('hearing'); S.buffer = S.ring.slice(); S.bufLen = S.buffer.reduce((n,b)=>n+b.length,0);
      S.silenceMs=0; S.speechMs=0; S.lineMs=0; } }
    else S.onset = 0;
    return;
  }
  // HEARING: accumulate + watch for end of line
  S.buffer.push(new Float32Array(blk)); S.bufLen += blk.length; S.lineMs += ms;
  if (rms < END_RMS) S.silenceMs += ms; else { S.silenceMs = 0; S.speechMs += ms; }
  if ((S.speechMs >= MIN_SPEECH_MS && S.silenceMs >= END_SILENCE_MS) || S.lineMs >= MAX_LINE_MS){
    if (S.speechMs < MIN_SPEECH_MS){ resetCapture(); setState('listening'); return; }
    endLine();
  }
}

function endLine(){
  setState('thinking');
  const wav = encodeWav(flatten(S.buffer, S.bufLen), S.srcRate);
  resetCapture();
  sendLine(wav);
}

// ---- the beat: POST /costar --------------------------------------------
async function sendLine(wavDataUri){
  const thinking = addTurn('costar', S.scene.ai_character, '…', true);
  try {
    const r = await fetch(BACKEND_URL + '/costar', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ scene: sceneForApi(), history: S.history, audio: wavDataUri }) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || ('HTTP '+r.status));
    thinking.remove();
    const heard = (data.heard && data.heard.text) || '(unclear)';
    addTurn('actor', 'You', heard); S.history.push({ who:'actor', text:heard });
    addTurn('costar', S.scene.ai_character, data.line); S.history.push({ who:'costar', text:data.line });
    if (data.note) addNote(heard, data.note);
    if (data.stakes) setStakes(data.stakes);
    say(S.scene.ai_character, data.line, data.audio);      // speak, then resume listening
  } catch (e) {
    thinking.remove();
    $.pill.textContent = 'Reader error: ' + e.message; $.pill.className = 'pill idle';
    setTimeout(()=>setState('listening'), 1400);          // recover, keep the scene alive
  }
}

// speak a co-star line (audio if we have it), then hand the turn back
function say(who, line, audioUri){
  $.subtitle.textContent = line;
  $.whoSpoke.textContent = who.split(',')[0];
  if (audioUri){
    setState('speaking'); $.player.src = audioUri;
    $.player.onended = () => setState('listening');
    $.player.play().catch(()=>{ setState('listening'); });
  } else {
    setState('speaking');                                  // opening or no TTS — beat to read, then listen
    const beat = Math.min(4500, 900 + line.length * 45);
    setTimeout(()=>setState('listening'), beat);
  }
}

function sceneForApi(){ const s=S.scene; return {
  ai_character:s.ai_character, human_character:s.human_character,
  premise:s.premise, tone:s.tone, voice:s.voice, opening:s.opening, language:'en' }; }

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
        { scene:S.scene.title, take:S.take, dialogue:S.history }, null, 2)),
       `audition-${S.scene.id}-take${S.take}.json`);
    try { S.recorder.start(); } catch(_){}
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

fillScenes();
