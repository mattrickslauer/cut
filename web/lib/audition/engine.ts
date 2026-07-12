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
import { LINE_MATCH_THRESHOLD, lineSimilarity, parseScript, type ScriptLine } from "./script";
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
  // scripted practice: the parsed sides (teleprompter), the current line pointer, and the
  // on-demand "Line!" prompt. currentLine is -1 when not in a scripted take.
  scriptLines: { i: number; who: "actor" | "costar"; speaker: string; text: string }[];
  currentLine: number;
  linePrompt: string | null;
  scripted: boolean;
  // talking-head compile status
  canCompile: boolean;
  compiling: boolean;
  compiled: boolean;
  prerendered: boolean; // compiled clips shipped with the scene (no on-device compile needed)
  compileProgress: number;
  compileTotal: number;
  // archived takes for side-by-side compare (newest first)
  takes: { id: number; n: number; title: string; url: string; notes: Note[]; stakes: number; lineCount: number }[];
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
    scriptLines: [],
    currentLine: -1,
    linePrompt: null,
    scripted: false,
    canCompile: false,
    compiling: false,
    compiled: false,
    prerendered: false,
    compileProgress: 0,
    compileTotal: 0,
    takes: [],
  };
}

type Cue = { t: number; end: number; text: string; who: string };
type HistoryItem = { who: "actor" | "costar"; text: string };
type TakeRecord = {
  id: number;
  n: number;
  title: string;
  url: string; // own blob URL, held until dispose() (not the shared playback URL)
  dialogue: Turn[];
  notes: Note[];
  stakes: number;
  cues: Cue[];
};

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
  // scripted practice mode
  private parsed: ScriptLine[] = []; // the sides, attributed + ordered
  private ptr = 0; // index of the NEXT line to perform (co-star) or hear (actor)
  private scripted = false; // set at take start when there are parsed lines
  private tries = 0; // failed line-match attempts on the current actor line
  // compiled talking-head co-star: a portrait + one lip-synced clip per co-star line, pre-rendered
  // so the co-star performs as a real face (played into the canvas, mixed into the take), instantly.
  private portrait: string | null = null;
  private clips = new Map<number, string>(); // parsed-line index → video data URI
  private compiled = false;
  private compiling = false;
  private clipActive = false; // drawFrame paints the talking-head clip instead of the text card
  private costarVideo!: HTMLVideoElement; // reusable element the clips play through
  private costarSrc: MediaElementAudioSourceNode | null = null; // its audio, routed into the mix
  private takes: TakeRecord[] = []; // archived takes for compare, each with its own retained blob URL

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
    this.costarVideo = document.createElement("video"); // off-DOM; drawn to canvas, audio via graph
    this.costarVideo.playsInline = true;
    this.costarVideo.preload = "auto";
    this.costarVideo.crossOrigin = "anonymous";
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
    this.reparse();
  }
  // Load a library scene wholesale: swap the scene, pull in its baked-in sides, and bind any
  // pre-rendered ("pre-compiled") talking-head clips that shipped with it so the co-star performs
  // as a real face from the first line — no on-device compile. Used by the carousel picker.
  loadScene(s: Scene) {
    if (this.state !== "idle") return; // don't hot-swap the scene mid-take
    this.scene = s;
    this.script = s.sides ?? "";
    this.parsed = this.currentScript()
      ? parseScript(this.script, this.scene.ai_character, this.scene.human_character)
      : [];
    this.compiled = false;
    this.clips.clear();
    this.portrait = null;
    const hasCostar = this.parsed.some((l) => l.who === "costar");
    // Map the shipped clips onto co-star lines in script order (clips[k] → k-th co-star line).
    const pre = this.scene.costar;
    if (pre && pre.clips.length && hasCostar) {
      this.portrait = pre.portrait || null;
      this.parsed
        .filter((l) => l.who === "costar")
        .forEach((l, k) => {
          const url = pre.clips[k];
          if (url) this.clips.set(l.i, url);
        });
      this.compiled = this.clips.size > 0;
    }
    this.patch({
      scriptLines: this.parsed.map((l) => ({ i: l.i, who: l.who, speaker: l.speaker, text: l.text })),
      currentLine: -1,
      scripted: false,
      linePrompt: null,
      compiled: this.compiled,
      prerendered: this.compiled,
      canCompile: hasCostar && !this.compiling && !this.compiled,
      compileProgress: 0,
      compileTotal: 0,
    });
  }
  setScript(text: string) {
    this.script = text;
    this.reparse();
  }
  private currentScript() {
    return (this.script || "").trim();
  }
  // Re-parse the sides into attributed lines and refresh the teleprompter. Cheap; runs on every
  // edit and on scene change (the co-star's name decides attribution). No-op mid-take.
  private reparse() {
    this.parsed = this.currentScript()
      ? parseScript(this.script, this.scene.ai_character, this.scene.human_character)
      : [];
    if (this.state === "idle") {
      // editing the sides (or switching scene) invalidates any compiled talking-head clips
      this.compiled = false;
      this.clips.clear();
      this.portrait = null;
      this.patch({
        scriptLines: this.parsed.map((l) => ({ i: l.i, who: l.who, speaker: l.speaker, text: l.text })),
        currentLine: -1,
        scripted: false,
        linePrompt: null,
        compiled: false,
        prerendered: false, // editing the sides invalidates any pre-rendered co-star
        canCompile: this.parsed.some((l) => l.who === "costar") && !this.compiling,
        compileProgress: 0,
        compileTotal: 0,
      });
    }
  }
  // The actor's next expected scripted line, or "" when it's not the actor's turn / no script.
  private expectedActorLine(): string {
    const l = this.parsed[this.ptr];
    return l && l.who === "actor" ? l.text : "";
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
    this.costarSrc = this.audioCtx.createMediaElementSource(this.costarVideo);
    this.costarSrc.connect(this.mixDest); // talking-head clip voice → recording
    this.costarSrc.connect(this.audioCtx.destination); // → speakers
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
    if (this.state === "speaking" && this.clipActive && this.costarVideo.videoWidth) {
      // compiled talking-head: the co-star is a real (lip-synced) face in the two-shot
      c.fillStyle = "#000";
      c.fillRect(0, 0, W, H);
      this.coverDraw(c, this.costarVideo, W, H);
      c.textAlign = "center";
      c.fillStyle = "#ffb056";
      c.font = "600 24px system-ui,sans-serif";
      c.fillText((this.costarShot.who || "").toUpperCase(), W / 2, H - bar - 16);
    } else if (this.state === "speaking") {
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
    try {
      this.costarVideo.onended = null;
      this.costarVideo.pause();
    } catch {}
    this.clipActive = false;
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
      this.scripted = false;
      this.meterFill.style.width = "0";
      this.patch({ subtitle: "", whoSpoke: "", recOn: false, currentLine: -1, linePrompt: null, scripted: false });
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
        this.archiveTake(); // keep it for side-by-side compare
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
    this.reparse();
    this.scripted = this.parsed.length > 0;
    this.ptr = 0;
    this.tries = 0;
    if (this.scripted) {
      this.patch({ scripted: true, linePrompt: null });
      this.setPtr(0);
      this.stepScript(); // co-star opens, or hand the first beat to the actor
    } else if (this.currentScript()) {
      this.resumeListening(); // script present but unparseable — you start, improv reader follows
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
  private finishLine(forced = false) {
    if (this.state !== "hearing") return;
    const wav = encodeWav(flatten(this.buffer, this.bufLen), this.srcRate);
    this.resetCapture();
    if (this.scripted && this.ptr < this.parsed.length) this.runScriptedTurn(wav, forced);
    else this.runTurn({ audio: wav }); // improv, or off-script continuation once the sides run out
  }
  manualDone() {
    if (this.state === "hearing") this.finishLine(true); // explicit "done" overrides the line gate
  }

  // ---- scripted practice: current-line pointer drives teleprompter, gating, and "Line!" ----
  private setPtr(n: number) {
    this.ptr = n;
    this.patch({ currentLine: Math.min(n, this.parsed.length) });
  }

  // Perform the beat at the pointer: the co-star speaks its lines; on an actor line we hand off
  // to the mic and let line-gated advance decide when to move on.
  private stepScript() {
    if (this.ptr >= this.parsed.length) return this.scriptComplete();
    const line = this.parsed[this.ptr];
    this.patch({ currentLine: this.ptr, linePrompt: null });
    if (line.who === "costar") {
      this.addTurn("costar", this.scene.ai_character, line.text);
      this.history.push({ who: "costar", text: line.text });
      const advance = () => {
        this.setPtr(this.ptr + 1);
        this.stepScript();
      };
      const clip = this.clips.get(line.i);
      if (this.compiled && clip) this.playClip(this.scene.ai_character, line.text, clip, advance);
      else this.say(this.scene.ai_character, line.text, undefined, advance); // fall back to voice-only
    } else {
      this.tries = 0;
      this.resumeListening(); // your line — deliver it; we advance once you have
    }
  }

  // One scripted actor beat: transcribe what you said and only advance when it matches your
  // expected line "within reason". A manual "done" or repeated near-misses advance anyway so the
  // scene never hard-sticks. Reuses /costar for ASR + the reader's coaching note.
  private async runScriptedTurn(wav: string, forced: boolean) {
    const gen = this.gen;
    const expected = this.expectedActorLine();
    this.setState("thinking");
    const ac = new AbortController();
    this.inflight = ac;
    try {
      const r = await fetch(BACKEND_URL + "/costar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scene: this.sceneForApi(), history: this.history, audio: wav }),
        signal: ac.signal,
      });
      const data = await r.json();
      if (gen !== this.gen) return;
      if (!r.ok) throw new Error(data.error || "HTTP " + r.status);
      const heard = (data.heard && data.heard.text) || "";
      const sim = lineSimilarity(heard, expected);
      const ok = !expected || forced || sim >= LINE_MATCH_THRESHOLD || ++this.tries >= 3;
      if (!ok) {
        this.resumeListening(); // near-miss: hold the pointer, listen for the rest of your line
        this.patch({ pillOverride: "Keep going — finish your line" }); // after setState, which clears it
        return;
      }
      this.tries = 0;
      this.addTurn("actor", "You", heard || expected);
      this.history.push({ who: "actor", text: heard || expected });
      if (data.note) this.addNote(heard || expected, data.note);
      if (data.stakes) this.setStakes(data.stakes);
      this.setPtr(this.ptr + 1);
      this.stepScript(); // deliver the co-star's answering line
    } catch (e) {
      if (gen !== this.gen) return;
      this.patch({ pillKind: "idle", pillOverride: "Reader error: " + (e as Error).message });
      this.beatTimer = setTimeout(() => {
        if (gen === this.gen) this.resumeListening();
      }, 1400);
    }
  }

  private scriptComplete() {
    this.setPtr(this.parsed.length);
    this.patch({ linePrompt: null, pillKind: "idle", pillOverride: "Scene complete — press Stop for your cut" });
    this.state = "listening"; // linger / improv on; Stop makes the cut. finishLine falls to runTurn.
  }

  // "Line!" — surface the actor's current expected line (and softly read it) when they blank. The
  // prompt is spoken through a throwaway element, NOT the recorded mix, so it stays out of the take.
  callLine() {
    const line = this.expectedActorLine();
    if (!line) return;
    this.patch({ linePrompt: line });
    fetch(BACKEND_URL + "/say", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: line, voice: this.scene.voice, tone: "a soft, quick prompter whisper" }),
    })
      .then((r) => r.json())
      .then((d) => d && d.audio && new Audio(d.audio).play().catch(() => {}))
      .catch(() => {});
  }

  // ---- compile: pre-render the co-star as a talking-head (portrait + a lip-synced clip per line) ----
  async compile() {
    if (this.compiling) return;
    this.reparse();
    const lines = this.parsed.filter((l) => l.who === "costar");
    if (!lines.length) return this.patch({ pillOverride: "No co-star lines in the script to compile" });
    this.compiling = true;
    this.compiled = false;
    this.clips.clear();
    this.patch({
      canCompile: false,
      compiling: true,
      compiled: false,
      prerendered: false,
      compileProgress: 0,
      compileTotal: lines.length,
      pillOverride: "Compiling scene partner — generating the co-star's face…",
    });
    try {
      const portrait = await this.postJson("/portrait", {
        character: this.scene.ai_character,
        tone: this.scene.tone,
      });
      if (!portrait.image) throw new Error(portrait.error || "portrait failed");
      this.portrait = portrait.image;
      let done = 0;
      for (const l of lines) {
        this.patch({ pillOverride: `Filming the co-star… line ${done + 1} of ${lines.length}` });
        const said = await this.postJson("/say", { text: l.text, voice: this.scene.voice, tone: this.scene.tone });
        if (!said.audio) throw new Error(said.error || "voice failed");
        const sub = await this.postJson("/avatar", { image: this.portrait, audio: said.audio });
        if (!sub.task_id) throw new Error(sub.error || "avatar submit failed");
        this.clips.set(l.i, await this.pollAvatar(sub.task_id));
        this.patch({ compileProgress: ++done });
      }
      this.compiled = true;
      this.patch({ compiling: false, compiled: true, pillOverride: `Scene partner ready — ${done} shots. Press Start.` });
    } catch (e) {
      this.patch({ compiling: false, pillOverride: "Compile failed: " + (e as Error).message });
    } finally {
      this.compiling = false;
      this.patch({ canCompile: this.parsed.some((l) => l.who === "costar") && !this.compiled });
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private postJson(path: string, body: unknown): Promise<any> {
    return fetch(BACKEND_URL + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json());
  }

  // Poll a talking-head task until the mp4 lands (video is minutes-scale). Best-effort, ~15 min cap.
  private async pollAvatar(taskId: string): Promise<string> {
    for (let i = 0; i < 60; i++) {
      await new Promise((res) => setTimeout(res, 15000));
      const s = await fetch(`${BACKEND_URL}/avatar?task_id=${encodeURIComponent(taskId)}`).then((r) => r.json());
      if (s.status === "SUCCEEDED" && s.video) return s.video as string;
      if (s.error) throw new Error(s.error);
    }
    throw new Error("avatar timed out");
  }

  // Play a pre-rendered talking-head clip as the co-star's turn: painted into the canvas by
  // drawFrame, its audio already routed into the recording. Hands the turn back when it ends.
  private playClip(who: string, line: string, src: string, after: () => void) {
    const gen = this.gen;
    const whoShort = who.split(",")[0];
    this.patch({ subtitle: line, whoSpoke: whoShort });
    this.costarShot = { who: whoShort, line };
    this.setState("speaking");
    const cue: Cue | null = this.recordStart
      ? { t: (performance.now() - this.recordStart) / 1000, end: 0, text: line, who: whoShort }
      : null;
    if (cue) this.cues.push(cue);
    this.clipActive = true;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      this.clipActive = false;
      this.costarVideo.onended = null;
      this.costarVideo.onerror = null;
      if (cue) cue.end = (performance.now() - this.recordStart) / 1000;
      if (gen === this.gen) after();
    };
    // A missing / unplayable pre-rendered clip degrades gracefully: drop the shot and let the
    // co-star deliver this line voice-only, so a not-yet-filmed scene still reads end to end.
    const fallback = () => {
      if (settled) return;
      settled = true;
      this.clipActive = false;
      this.costarVideo.onended = null;
      this.costarVideo.onerror = null;
      if (cue) {
        const ix = this.cues.indexOf(cue);
        if (ix >= 0) this.cues.splice(ix, 1); // say() records its own cue
      }
      if (gen === this.gen) this.say(who, line, undefined, after);
    };
    this.costarVideo.src = src;
    this.costarVideo.onended = finish;
    this.costarVideo.onerror = fallback;
    this.costarVideo.play().catch(fallback);
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
  private async say(who: string, line: string, audioUri?: string, after?: () => void) {
    const gen = this.gen;
    const hand = after || (() => this.resumeListening()); // default: give the turn back to the actor
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
          body: JSON.stringify({ text: line, voice: this.scene.voice, tone: this.scene.tone }),
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
        if (gen === this.gen) hand();
      };
      this.player.play().catch(() => this.beat(line, gen, hand));
    } else this.beat(line, gen, hand);
  }
  private beat(line: string, gen: number, hand: () => void) {
    this.beatTimer = setTimeout(() => {
      if (gen === this.gen) hand();
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

  // ---- takes archive (compare) ----
  // Keep this take for side-by-side compare: its own blob URL (the shared playback URL gets revoked
  // on the next Stop) plus the dialogue, reader notes, stakes, and caption cues it earned.
  private archiveTake() {
    const url = URL.createObjectURL(new Blob(this.chunks, { type: "video/webm" }));
    const rec: TakeRecord = {
      id: this.uid++,
      n: this.takes.length + 1,
      title: this.scene.title,
      url,
      dialogue: [...this.view.dialogue],
      notes: [...this.view.notes],
      stakes: this.view.stakes,
      cues: [...this.cues],
    };
    this.takes = [rec, ...this.takes]; // newest first
    this.patch({
      takes: this.takes.map((t) => ({
        id: t.id,
        n: t.n,
        title: t.title,
        url: t.url,
        notes: t.notes,
        stakes: t.stakes,
        lineCount: t.dialogue.length,
      })),
    });
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
    this.takes.forEach((t) => {
      try {
        URL.revokeObjectURL(t.url);
      } catch {}
    });
  }
}
