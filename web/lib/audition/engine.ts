// Cut! — Audition Room engine. Hands-free video self-tape with a turn-based AI scene partner.
// It listens continuously, hears when you speak, auto-endpoints on silence, POSTs the turn to
// the scale-to-zero FC reader, plays the reply, then hands the scene back. One POST = one beat.
//
//   LISTENING → HEARING(you talk) → THINKING(POST /costar) → SPEAKING(reply) → LISTENING
//
// This is the imperative real-time engine: getUserMedia, a persistent Web Audio graph that mixes
// mic + reader voice into the recording, an energy-VAD, a director's-cut canvas compositor, and a
// MediaRecorder paused during "thinking". React owns the declarative UI and drives this via refs.

import { AUDITION_URL } from "@/lib/config";
import type { Scene } from "./scenes";
import { ASR_RATE, encodeWav, flatten } from "./wav";

const BACKEND_URL = AUDITION_URL;
const START_RMS = 0.02; // onset threshold (enter HEARING)
const END_RMS = 0.011; // below this counts as silence (hysteresis vs START)
const ONSET_BLK = 2; // consecutive loud blocks before we believe it's speech
const END_SILENCE_MS = 1200; // trailing silence that ends your line
const MIN_SPEECH_MS = 400; // ignore blips shorter than this
const MAX_LINE_MS = 20000; // hard cap on one line
const PREROLL = 5; // blocks kept before onset so the first word isn't clipped

export const MEDIA: MediaStreamConstraints = {
  video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
};

export type PillKind = "idle" | "listening" | "hearing" | "thinking" | "speaking";
export type Turn = {
  id: number;
  kind: "actor" | "costar";
  who: string;
  text: string;
  thinking?: boolean;
};
export type Note = { id: number; line: string; note: string };

export type AuditionView = {
  pillKind: PillKind;
  pillOverride: string | null; // dynamic messages (Starting…, errors, playback) beat the default label
  recOn: boolean;
  sessionTime: string;
  subtitle: string;
  whoSpoke: string;
  takeLabel: string;
  dialogue: Turn[];
  notes: Note[];
  stakes: number;
  camOff: boolean;
  camOffText: string;
  playbackVisible: boolean;
  canStart: boolean;
  canStop: boolean;
  canNewTake: boolean;
  canSave: boolean;
};

export function initialView(): AuditionView {
  return {
    pillKind: "idle",
    pillOverride: null,
    recOn: false,
    sessionTime: "00:00",
    subtitle: "",
    whoSpoke: "",
    takeLabel: "take 1",
    dialogue: [],
    notes: [],
    stakes: 0,
    camOff: true,
    camOffText: "Camera off",
    playbackVisible: false,
    canStart: true,
    canStop: false,
    canNewTake: false,
    canSave: false,
  };
}

type Cue = { t: number; end: number; text: string; who: string };
type HistoryItem = { who: "actor" | "costar"; text: string };

export class AuditionEngine {
  private cam: HTMLVideoElement;
  private playback: HTMLVideoElement;
  private player: HTMLAudioElement;
  private meterFill: HTMLElement;
  private onChange: (v: AuditionView) => void;

  private view = initialView();
  private scene: Scene;
  private script = "";
  private uid = 1;

  // pipeline state
  private state: PillKind = "idle";
  private history: HistoryItem[] = [];
  private take = 1;
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private node: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private srcRate = 48000;
  private ring: Float32Array[] = [];
  private buffer: Float32Array[] = [];
  private bufLen = 0;
  private onset = 0;
  private silenceMs = 0;
  private speechMs = 0;
  private lineMs = 0;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private sessionStart = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private cues: Cue[] = [];
  private recordStart = 0;
  private playbackUrl: string | null = null;
  private mixDest: MediaStreamAudioDestinationNode | null = null;
  private playerSrc: MediaElementAudioSourceNode | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private cctx: CanvasRenderingContext2D | null = null;
  private rafId = 0;
  private costarShot: { who: string; line: string } = { who: "", line: "" };
  // Cutting the take invalidates any reader response still in flight. Every async beat
  // captures `gen` and bails if it no longer matches; stop()/beginTake() bump it, abort
  // the pending fetch, and clear the pending timer so nothing plays or re-arms after Cut.
  private gen = 0;
  private inflight: AbortController | null = null;
  private beatTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: {
    cam: HTMLVideoElement;
    playback: HTMLVideoElement;
    player: HTMLAudioElement;
    meterFill: HTMLElement;
    scene: Scene;
    onChange: (v: AuditionView) => void;
  }) {
    this.cam = opts.cam;
    this.playback = opts.playback;
    this.player = opts.player;
    this.meterFill = opts.meterFill;
    this.scene = opts.scene;
    this.onChange = opts.onChange;
  }

  // ---- view plumbing ----
  private emit() {
    this.onChange({ ...this.view, dialogue: [...this.view.dialogue], notes: [...this.view.notes] });
  }
  private patch(p: Partial<AuditionView>) {
    this.view = { ...this.view, ...p };
    this.emit();
  }

  // ---- scene / script setters (React-controlled inputs) ----
  setScene(s: Scene) {
    this.scene = s;
  }
  setScript(text: string) {
    this.script = text;
  }
  private currentScript() {
    return (this.script || "").trim();
  }

  // ---- persistent audio graph (created once; player source binds once, ever) ----
  private ensureAudioGraph() {
    if (this.audioCtx) return;
    const AC =
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.audioCtx = new AC();
    this.mixDest = this.audioCtx.createMediaStreamDestination();
    this.playerSrc = this.audioCtx.createMediaElementSource(this.player);
    this.playerSrc.connect(this.mixDest); // reader voice → recording
    this.playerSrc.connect(this.audioCtx.destination); // reader voice → speakers
  }

  // ---- director's-cut compositor ----
  private ensureCanvas() {
    if (this.canvas) return;
    this.canvas = document.createElement("canvas");
    this.canvas.width = 1280;
    this.canvas.height = 720;
    this.cctx = this.canvas.getContext("2d");
  }
  private coverDraw(c: CanvasRenderingContext2D, v: HTMLVideoElement, W: number, H: number) {
    const vw = v.videoWidth,
      vh = v.videoHeight;
    if (!vw) return;
    const s = Math.max(W / vw, H / vh),
      dw = vw * s,
      dh = vh * s;
    c.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }
  private wrapText(c: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, lh: number) {
    const words = (text || "").split(" ");
    const lines: string[] = [];
    let line = "";
    for (const w of words) {
      const t = line ? line + " " + w : w;
      if (c.measureText(t).width > maxW && line) {
        lines.push(line);
        line = w;
      } else line = t;
    }
    if (line) lines.push(line);
    let yy = y - ((lines.length - 1) * lh) / 2;
    for (const ln of lines) {
      c.fillText(ln, x, yy);
      yy += lh;
    }
  }
  private drawFrame = () => {
    this.rafId = requestAnimationFrame(this.drawFrame);
    const c = this.cctx;
    if (!c) return;
    const W = 1280,
      H = 720,
      bar = 54;
    if (this.state === "speaking") {
      const g = c.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, "#1c1420");
      g.addColorStop(1, "#08080f");
      c.fillStyle = g;
      c.fillRect(0, 0, W, H);
      c.textAlign = "center";
      c.fillStyle = "#ffb056";
      c.font = "600 30px system-ui,sans-serif";
      c.fillText((this.costarShot.who || "").toUpperCase(), W / 2, H * 0.3);
      c.fillStyle = "#eef0f6";
      c.font = "italic 42px Georgia,serif";
      this.wrapText(c, this.costarShot.line || "", W / 2, H * 0.52, W * 0.76, 58);
    } else {
      c.fillStyle = "#0b0b12";
      c.fillRect(0, 0, W, H);
      if (this.cam.videoWidth) this.coverDraw(c, this.cam, W, H);
    }
    c.fillStyle = "#000";
    c.fillRect(0, 0, W, bar);
    c.fillRect(0, H - bar, W, bar);
  };

  private pickMime(): MediaRecorderOptions {
    for (const m of ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"])
      if (MediaRecorder.isTypeSupported(m)) return { mimeType: m };
    return {};
  }

  // arm a fresh recorder: records the COMPOSITED canvas + mixed audio (mic + reader voice)
  private armRecorder() {
    this.ensureCanvas();
    const cv = this.canvas!.captureStream(30);
    const audio = this.mixDest
      ? this.mixDest.stream.getAudioTracks()
      : this.stream
        ? this.stream.getAudioTracks()
        : [];
    const recStream = new MediaStream([...cv.getVideoTracks(), ...audio]);
    const rec = new MediaRecorder(recStream, this.pickMime());
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    this.recorder = rec;
    this.chunks = chunks;
    return rec;
  }

  // ---- state ----
  private setState(st: PillKind) {
    this.state = st;
    this.patch({
      pillKind: st,
      pillOverride: null,
      recOn: st !== "idle",
    });
    // edit out the AI's latency: don't record the "thinking" gap into the tape
    if (this.recorder) {
      if (st === "thinking" && this.recorder.state === "recording") {
        try {
          this.recorder.pause();
        } catch {}
      } else if (st !== "thinking" && this.recorder.state === "paused") {
        try {
          this.recorder.resume();
        } catch {}
      }
    }
  }

  // ---- camera preview on load ----
  async initCamera() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia(MEDIA);
      this.cam.srcObject = this.stream;
      this.patch({ camOff: false });
    } catch {
      this.patch({ camOff: true, camOffText: "Camera blocked — allow it, then press Start" });
    }
  }

  // ---- start ----
  async start() {
    try {
      this.setState("idle");
      this.patch({ pillOverride: "Starting…" });
      try {
        this.playback.pause();
      } catch {}
      this.patch({ playbackVisible: false });
      this.cam.style.display = "";
      fetch(BACKEND_URL + "/warm").catch(() => {}); // hide FC cold start
      if (!this.stream) {
        this.stream = await navigator.mediaDevices.getUserMedia(MEDIA);
        this.cam.srcObject = this.stream;
        this.patch({ camOff: false });
      }
      this.ensureAudioGraph();
      if (this.audioCtx!.state === "suspended") await this.audioCtx!.resume();
      this.srcRate = this.audioCtx!.sampleRate;
      this.source = this.audioCtx!.createMediaStreamSource(this.stream);
      this.node = this.audioCtx!.createScriptProcessor(4096, 1, 1);
      this.node.onaudioprocess = this.onAudio;
      this.source.connect(this.node);
      this.node.connect(this.audioCtx!.destination); // VAD/meter tap (silent)
      this.source.connect(this.mixDest!); // your mic → recording
      this.patch({ canStart: false, canStop: true, canNewTake: true, canSave: true });
      this.beginTake(true);
    } catch (e) {
      this.setState("idle");
      this.patch({ pillOverride: "Camera/mic blocked: " + (e as Error).message });
    }
  }

  // invalidate any reader response still in flight (thinking/speaking beat): bump the
  // generation so late resolutions bail, abort the pending fetch, drop the pending timer,
  // and unhook onended so finished playback can't re-arm the mic.
  private cutPending() {
    this.gen++;
    try {
      this.inflight?.abort();
    } catch {}
    this.inflight = null;
    if (this.beatTimer) {
      clearTimeout(this.beatTimer);
      this.beatTimer = null;
    }
    this.player.onended = null;
  }

  // stop the audition, then play back the take you just recorded
  stop() {
    this.cutPending(); // drop any reader response still in flight — nothing speaks after Cut
    try {
      this.player.pause();
    } catch {}
    if (this.timer) clearInterval(this.timer);
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    const finish = () => {
      try {
        this.node?.disconnect();
        this.source?.disconnect();
      } catch {}
      try {
        this.stream?.getTracks().forEach((t) => t.stop());
      } catch {}
      this.stream = this.node = this.source = null;
      this.state = "idle";
      this.meterFill.style.width = "0";
      this.patch({ subtitle: "", whoSpoke: "", recOn: false });
      if (this.chunks && this.chunks.length) {
        if (this.playbackUrl) URL.revokeObjectURL(this.playbackUrl);
        this.playbackUrl = URL.createObjectURL(new Blob(this.chunks, { type: "video/webm" }));
        this.cam.style.display = "none";
        this.playback.src = this.playbackUrl;
        this.playback.ontimeupdate = null;
        this.patch({
          camOff: false,
          playbackVisible: true,
          pillKind: "idle",
          pillOverride: `▶ Take ${this.take} — director's cut`,
          canSave: true,
        });
        this.playback.play().catch(() => {});
      } else {
        this.cam.srcObject = null;
        this.patch({ camOff: true });
        this.setState("idle");
        this.patch({ canSave: false });
      }
      this.patch({ canStart: true, canStop: false, canNewTake: false });
    };
    if (this.recorder && this.recorder.state !== "inactive") {
      this.recorder.onstop = finish;
      try {
        this.recorder.stop();
      } catch {
        finish();
      }
    } else finish();
  }

  private beginTake(first: boolean) {
    this.cutPending(); // a fresh take invalidates any reader beat left over from the last one
    try {
      this.player.pause();
    } catch {}
    this.history = [];
    this.take = first ? 1 : this.take + 1;
    this.patch({
      takeLabel: "take " + this.take,
      dialogue: [],
      notes: [],
      stakes: 0,
    });
    this.ensureCanvas();
    if (!this.rafId) this.rafId = requestAnimationFrame(this.drawFrame);
    try {
      if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    } catch {}
    this.armRecorder();
    this.cues = [];
    try {
      this.recorder!.start();
    } catch {}
    this.recordStart = performance.now();
    this.sessionStart = performance.now();
    this.startTimer();
    this.resetCapture();
    if (this.currentScript()) {
      this.resumeListening(); // scripted: you start
    } else {
      this.addTurn("costar", this.scene.ai_character, this.scene.opening);
      this.history.push({ who: "costar", text: this.scene.opening });
      this.say(this.scene.ai_character, this.scene.opening);
    }
  }

  newTake() {
    if (this.state === "thinking") return;
    this.beginTake(false);
  }

  // ---- turn detection (energy-VAD on our own mic stream) ----
  private resetCapture() {
    this.buffer = [];
    this.bufLen = 0;
    this.onset = 0;
    this.silenceMs = 0;
    this.speechMs = 0;
    this.lineMs = 0;
  }
  private resumeListening() {
    this.resetCapture();
    this.setState("listening");
  }
  private finishLine() {
    if (this.state !== "hearing") return;
    const wav = encodeWav(flatten(this.buffer, this.bufLen), this.srcRate);
    this.resetCapture();
    this.runTurn({ audio: wav });
  }
  manualDone() {
    if (this.state === "hearing") this.finishLine();
  }

  private onAudio = (e: AudioProcessingEvent) => {
    const blk = e.inputBuffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < blk.length; i++) sum += blk[i] * blk[i];
    const rms = Math.sqrt(sum / blk.length);
    this.meterFill.style.width = Math.min(100, rms * 450) + "%";
    const ms = (blk.length / this.srcRate) * 1000;
    if (this.state !== "listening" && this.state !== "hearing") return;
    this.ring.push(new Float32Array(blk));
    if (this.ring.length > PREROLL) this.ring.shift();
    if (this.state === "listening") {
      if (rms > START_RMS) {
        if (++this.onset >= ONSET_BLK) {
          this.setState("hearing");
          this.buffer = this.ring.slice();
          this.bufLen = this.buffer.reduce((n, b) => n + b.length, 0);
          this.silenceMs = 0;
          this.speechMs = 0;
          this.lineMs = 0;
        }
      } else this.onset = 0;
      return;
    }
    this.buffer.push(new Float32Array(blk));
    this.bufLen += blk.length;
    this.lineMs += ms;
    if (rms < END_RMS) this.silenceMs += ms;
    else {
      this.silenceMs = 0;
      this.speechMs += ms;
    }
    if (this.silenceMs >= END_SILENCE_MS || this.lineMs >= MAX_LINE_MS) {
      if (this.speechMs < MIN_SPEECH_MS) {
        this.resetCapture();
        this.setState("listening");
        return;
      }
      this.finishLine();
    }
  };

  // ---- one beat: POST /costar → render → reader speaks → resume ----
  private async runTurn(extra: { audio?: string; text?: string }) {
    const gen = this.gen;
    this.setState("thinking");
    const thinkingId = this.addTurn("costar", this.scene.ai_character, "…", true);
    const ac = new AbortController();
    this.inflight = ac;
    try {
      const r = await fetch(BACKEND_URL + "/costar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.assign({ scene: this.sceneForApi(), history: this.history }, extra)),
        signal: ac.signal,
      });
      const data = await r.json();
      if (gen !== this.gen) return this.removeTurn(thinkingId); // cut while thinking — drop it
      if (!r.ok) throw new Error(data.error || "HTTP " + r.status);
      this.removeTurn(thinkingId);
      const heard = (data.heard && data.heard.text) || extra.text || "(unclear)";
      this.addTurn("actor", "You", heard);
      this.history.push({ who: "actor", text: heard });
      this.addTurn("costar", this.scene.ai_character, data.line);
      this.history.push({ who: "costar", text: data.line });
      if (data.note) this.addNote(heard, data.note);
      if (data.stakes) this.setStakes(data.stakes);
      this.say(this.scene.ai_character, data.line, data.audio);
    } catch (e) {
      if (gen !== this.gen) return this.removeTurn(thinkingId); // aborted by Cut — stay quiet
      this.removeTurn(thinkingId);
      this.patch({ pillKind: "idle", pillOverride: "Reader error: " + (e as Error).message });
      this.beatTimer = setTimeout(() => {
        if (gen === this.gen) this.resumeListening();
      }, 1400);
    }
  }

  // speak a co-star line, then hand the turn back
  private async say(who: string, line: string, audioUri?: string) {
    const gen = this.gen;
    const whoShort = who.split(",")[0];
    this.patch({ subtitle: line, whoSpoke: whoShort });
    this.costarShot = { who: whoShort, line };
    this.setState("speaking");
    const cue: Cue | null = this.recordStart
      ? { t: (performance.now() - this.recordStart) / 1000, end: 0, text: line, who: whoShort }
      : null;
    if (cue) {
      cue.end = cue.t + Math.min(6, Math.max(2, line.length * 0.06));
      this.cues.push(cue);
    }
    const done = () => {
      if (cue) cue.end = (performance.now() - this.recordStart) / 1000;
    };
    if (!audioUri) {
      const ac = new AbortController();
      this.inflight = ac;
      try {
        const r = await fetch(BACKEND_URL + "/say", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: line, voice: this.scene.voice }),
          signal: ac.signal,
        });
        const d = await r.json();
        if (r.ok && d.audio) audioUri = d.audio;
      } catch {
        /* fall through to a timed beat */
      }
    }
    if (gen !== this.gen) return; // cut while generating/speaking — don't play, don't re-arm
    if (audioUri) {
      this.player.src = audioUri;
      this.player.onended = () => {
        done();
        if (gen === this.gen) this.resumeListening();
      };
      this.player.play().catch(() => this.beat(line, gen));
    } else this.beat(line, gen);
  }
  private beat(line: string, gen: number) {
    this.beatTimer = setTimeout(() => {
      if (gen === this.gen) this.resumeListening();
    }, Math.min(4500, 900 + line.length * 45));
  }

  private sceneForApi() {
    const s = this.scene;
    return {
      ai_character: s.ai_character,
      human_character: s.human_character,
      premise: s.premise,
      tone: s.tone,
      voice: s.voice,
      opening: s.opening,
      language: "en",
      script: this.currentScript(),
    };
  }

  // ---- dialogue / notes / stakes (view model) ----
  private addTurn(kind: "actor" | "costar", who: string, text: string, thinking = false) {
    const id = this.uid++;
    this.view.dialogue = [...this.view.dialogue, { id, kind, who, text, thinking }];
    this.emit();
    return id;
  }
  private removeTurn(id: number) {
    this.view.dialogue = this.view.dialogue.filter((t) => t.id !== id);
    this.emit();
  }
  private addNote(line: string, note: string) {
    this.view.notes = [...this.view.notes, { id: this.uid++, line, note }];
    this.emit();
  }
  private setStakes(v: number) {
    this.patch({ stakes: v });
  }

  // ---- save take ----
  save() {
    const stop = () =>
      new Promise<void>((res) => {
        if (!this.recorder || this.recorder.state === "inactive") return res();
        this.recorder.onstop = () => res();
        this.recorder.stop();
      });
    stop().then(() => {
      const blob = new Blob(this.chunks, { type: "video/webm" });
      this.dl(URL.createObjectURL(blob), `audition-${this.scene.id}-take${this.take}.webm`);
      this.dl(
        "data:application/json," +
          encodeURIComponent(
            JSON.stringify(
              { scene: this.scene.title, take: this.take, dialogue: this.history, captions: this.cues },
              null,
              2
            )
          ),
        `audition-${this.scene.id}-take${this.take}.json`
      );
      if (this.stream && this.stream.active) {
        this.armRecorder();
        try {
          this.recorder!.start();
          this.recordStart = performance.now();
          this.cues = [];
        } catch {}
      }
    });
  }
  private dl(href: string, name: string) {
    const a = document.createElement("a");
    a.href = href;
    a.download = name;
    a.click();
  }

  // ---- session timer ----
  private startTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      const s = Math.floor((performance.now() - this.sessionStart) / 1000);
      this.patch({
        sessionTime:
          String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0"),
      });
    }, 500);
  }

  // ---- teardown ----
  dispose() {
    this.cutPending();
    try {
      if (this.timer) clearInterval(this.timer);
      cancelAnimationFrame(this.rafId);
      this.player.pause();
      this.recorder && this.recorder.state !== "inactive" && this.recorder.stop();
      this.node?.disconnect();
      this.source?.disconnect();
      this.stream?.getTracks().forEach((t) => t.stop());
      this.audioCtx?.close();
    } catch {}
    if (this.playbackUrl) URL.revokeObjectURL(this.playbackUrl);
  }
}
