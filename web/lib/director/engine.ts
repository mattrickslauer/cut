// Cut! — Director Control Panel engine. Webcam → a directed <canvas> cut, with an AI director's
// eye (Qwen-VL via FC) that calls the look, conjures a generated world, detects characters
// (MediaPipe FaceDetector), and captions the room (qwen3-asr-flash) — all in the browser.
// React owns the declarative UI; this class owns the imperative real-time pipeline via refs.

import { PERCEIVE_URL } from "@/lib/config";
import { GRADES } from "./grades";
import { BG_LIST, LOOK_TO_BG, drawCover, drawProc, sameSetting } from "./backgrounds";
import { blobToDataURL, downsampleTo16k, encodeWav } from "./wav";

const BACKEND_URL = PERCEIVE_URL;
const PERCEIVE_MS = 4000; // how often the director "looks" while a session rolls

const MP_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/vision_bundle.mjs";
const MP_WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm";
const SELFIE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite";
const FACE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite";
const CHAR_COLOR: Record<string, string> = { A: "#ffb02e", B: "#3ec6ff" };

// dynamic import of the MediaPipe ESM bundle straight from the CDN (never bundled by the app)
function loadMediaPipe(): Promise<any> {
  return import(/* webpackIgnore: true */ /* turbopackIgnore: true */ MP_URL);
}

// VAD endpointing for continuous transcription: flush the moment the speaker pauses.
const VAD_START = 0.012,
  VAD_END = 0.008,
  VAD_SILENCE_MS = 380,
  VAD_MIN_MS = 400,
  VAD_MAX_MS = 5000;

export type CastState = "off" | "detected" | "on";
export type LogEntry = { id: number; t: string; text: string; hot: boolean };
export type TranscriptLine = { who: "A" | "B" | "both" | "x"; text: string; seq: number };
export type DeviceOpt = { id: string; label: string };

export type DirectorView = {
  running: boolean;
  session: boolean;
  sessionTime: string;
  rawRes: string;
  rawFps: number;
  cutFps: number;
  grade: string;
  bgName: string;
  genBusy: boolean;
  scene: string;
  mood: string;
  shot: string;
  cast: { label: "A" | "B"; state: CastState }[];
  transcript: TranscriptLine[];
  log: LogEntry[];
  subtitleWho: "A" | "B" | null;
  subtitleText: string;
  subtitleShow: boolean;
  camPlaceholder: boolean;
  canToggle: boolean;
  canSnap: boolean;
  toggleLabel: string;
  devices: DeviceOpt[];
  selectedDevice: string;
};

export function initialView(): DirectorView {
  return {
    running: false,
    session: false,
    sessionTime: "00:00",
    rawRes: "—",
    rawFps: 0,
    cutFps: 0,
    grade: "Neutral",
    bgName: "None",
    genBusy: false,
    scene: "—",
    mood: "—",
    shot: "—",
    cast: [
      { label: "A", state: "off" },
      { label: "B", state: "off" },
    ],
    transcript: [],
    log: [],
    subtitleWho: null,
    subtitleText: "",
    subtitleShow: false,
    camPlaceholder: true,
    canToggle: false,
    canSnap: false,
    toggleLabel: "Start session",
    devices: [],
    selectedDevice: "",
  };
}

type Face = { label: "A" | "B"; box: { originX: number; originY: number; width: number; height: number } };
type Prior = { setting?: string; shot?: string; look?: string; scene: number } | null;

export class DirectorEngine {
  private cam: HTMLVideoElement;
  private cut: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private onChange: (v: DirectorView) => void;
  private view = initialView();
  private uid = 1;

  // core
  private stream: MediaStream | null = null;
  private running = false;
  private session = false;
  private grade = "Neutral";
  private sessionStart = 0;
  private raf = 0;
  private frames = 0;
  private cutFrames = 0;
  private lastFpsT = 0;
  // perception
  private perceiving = false;
  private prior: Prior = null;
  private sceneNum = 0;
  private perceiveTimer: ReturnType<typeof setInterval> | null = null;
  private capCanvas: HTMLCanvasElement | null = null;
  // matting / background
  private bgName = "None";
  private autoBg = "Studio";
  private bgCanvas: HTMLCanvasElement | null = null;
  private maskCanvas: HTMLCanvasElement | null = null;
  private personCanvas: HTMLCanvasElement | null = null;
  private maskReady = false;
  // generated worlds
  private worldImg: HTMLImageElement | null = null;
  private autoUseImg = false;
  private lastSetting = "";
  private genCache = new Map<string, HTMLImageElement>();
  // audio / transcription
  private audioCtx: AudioContext | null = null;
  private audioSource: MediaStreamAudioSourceNode | null = null;
  private audioProc: ScriptProcessorNode | null = null;
  private pcmChunks: Float32Array[] = [];
  private pcmLen = 0;
  private srcRate = 48000;
  private transcript: TranscriptLine[] = [];
  private currentSpeaker = "none";
  private asrSeq = 0;
  private vadSilenceMs = 0;
  private vadChunkMs = 0;
  private vadHadSpeech = false;
  // character detection
  private faceDetector: any = null;
  private faceReady = false;
  private faces: Face[] = [];
  private lastFaceT = 0;
  // segmenter
  private segmenter: any = null;
  private segReady = false;
  private segBusy = false;
  private segLoading = false;
  // timers
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private subtitleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: {
    cam: HTMLVideoElement;
    cut: HTMLCanvasElement;
    onChange: (v: DirectorView) => void;
  }) {
    this.cam = opts.cam;
    this.cut = opts.cut;
    this.ctx = opts.cut.getContext("2d")!;
    this.onChange = opts.onChange;
  }

  // ---- view plumbing ----
  private emit() {
    this.onChange({
      ...this.view,
      cast: this.view.cast.map((c) => ({ ...c })),
      transcript: [...this.view.transcript],
      log: [...this.view.log],
      devices: [...this.view.devices],
    });
  }
  private patch(p: Partial<DirectorView>) {
    this.view = { ...this.view, ...p };
    this.emit();
  }

  // ---- logging ----
  private log(text: string, hot = false) {
    const now = new Date();
    const t = now.toTimeString().slice(0, 8);
    const entry: LogEntry = { id: this.uid++, t, text, hot };
    const log = [entry, ...this.view.log].slice(0, 120);
    this.patch({ log });
  }

  // ---- grade ----
  setGrade(name: string) {
    this.grade = name;
    this.patch({ grade: name, mood: name === "Neutral" ? "—" : name });
    this.log(`Editor › grade → ${name}`, true);
  }

  // ---- init / lifecycle ----
  async init() {
    this.lastFpsT = performance.now();
    this.renderCast();
    this.tickInterval = setInterval(() => this.tickTimer(), 250);
    try {
      await navigator.mediaDevices?.enumerateDevices();
      await this.refreshDevices();
    } catch {}
    this.log('Control panel ready. Click "Start camera".');
  }

  // ---- devices ----
  private async refreshDevices(selectedId?: string) {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter((d) => d.kind === "videoinput");
    const list: DeviceOpt[] = cams.map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }));
    this.patch({
      devices: list,
      selectedDevice: selectedId ?? this.view.selectedDevice ?? (list[0]?.id || ""),
    });
  }
  setDevice(id: string) {
    this.patch({ selectedDevice: id });
    if (this.running) this.startCamera(id);
  }

  // ---- camera ----
  async startCamera(deviceId?: string) {
    try {
      this.stopTracks();
      const constraints: MediaStreamConstraints = {
        audio: true,
        video: deviceId
          ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
          : { width: { ideal: 1280 }, height: { ideal: 720 } },
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      this.stream = stream;
      this.cam.srcObject = stream;
      await this.cam.play();
      this.patch({ camPlaceholder: false });

      const track = stream.getVideoTracks()[0];
      const s = track.getSettings();
      this.patch({ rawRes: `${s.width}×${s.height}` });
      await this.refreshDevices(s.deviceId);

      this.running = true;
      this.patch({ running: true, canToggle: true, canSnap: true });
      this.sizeCanvas();
      this.startLoop();
      this.initSegmenter();
      this.initFaceDetector();
      this.startAudio(stream);
      this.renderCast();
      this.log(`Camera live › ${track.label || "default"} @ ${s.width}×${s.height}`);
    } catch (err) {
      const e = err as Error;
      this.log(`⚠︎ camera error: ${e.name} — ${e.message}`);
    }
  }

  private stopTracks() {
    this.stopAudio();
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  }

  private sizeCanvas() {
    const w = this.cam.videoWidth || 1280;
    const h = this.cam.videoHeight || 720;
    this.cut.width = w;
    this.cut.height = h;
    this.buildBg();
  }

  private effBg() {
    return this.bgName === "Auto" ? this.autoBg || "Studio" : this.bgName;
  }

  // ---- render loop ----
  private startLoop() {
    cancelAnimationFrame(this.raf);
    const tick = () => {
      if (this.running && this.cam.readyState >= 2) {
        if (this.faceReady) {
          const nowf = performance.now();
          if (nowf - this.lastFaceT > 200) {
            this.lastFaceT = nowf;
            try {
              this.updateFaces(this.faceDetector.detectForVideo(this.cam, nowf).detections || []);
            } catch {}
          }
        }
        if (this.effBg() !== "None" && this.segReady) {
          if (!this.segBusy) {
            this.segBusy = true;
            try {
              this.segmenter.segmentForVideo(this.cam, performance.now(), (r: any) => this.onSeg(r));
            } catch {
              this.segBusy = false;
            }
          }
          this.compositeFrame();
          this.drawFaceLabels(this.ctx, false);
        } else {
          const ctx = this.ctx;
          const w = this.cut.width,
            h = this.cut.height;
          ctx.save();
          ctx.filter = GRADES[this.grade] || "none";
          ctx.translate(w, 0);
          ctx.scale(-1, 1);
          ctx.drawImage(this.cam, 0, 0, w, h);
          ctx.restore();
          this.drawFaceLabels(ctx, true);
        }
        this.cutFrames++;
      }
      this.frames++;
      const now = performance.now();
      if (now - this.lastFpsT >= 1000) {
        this.patch({ rawFps: this.frames, cutFps: this.cutFrames });
        this.frames = 0;
        this.cutFrames = 0;
        this.lastFpsT = now;
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  // ---- matting ----
  private async initSegmenter() {
    if (this.segReady || this.segLoading) return;
    this.segLoading = true;
    this.log("Loading matting model…");
    try {
      const { ImageSegmenter, FilesetResolver } = await loadMediaPipe();
      const vision = await FilesetResolver.forVisionTasks(MP_WASM);
      const make = (delegate: string) =>
        ImageSegmenter.createFromOptions(vision, {
          baseOptions: { modelAssetPath: SELFIE_MODEL, delegate },
          runningMode: "VIDEO",
          outputConfidenceMasks: true,
          outputCategoryMask: false,
        });
      try {
        this.segmenter = await make("GPU");
      } catch {
        this.segmenter = await make("CPU");
      }
      this.segReady = true;
      this.log("Matting ready ✓ — background swap live");
    } catch (e) {
      this.log(`⚠︎ matting unavailable: ${(e as Error).message || e} — real background only`);
    } finally {
      this.segLoading = false;
    }
  }

  private onSeg(result: any) {
    try {
      const mask = result.confidenceMasks && result.confidenceMasks[0];
      if (mask) {
        const mw = mask.width,
          mh = mask.height,
          f = mask.getAsFloat32Array();
        const mc = this.maskCanvas || (this.maskCanvas = document.createElement("canvas"));
        if (mc.width !== mw || mc.height !== mh) {
          mc.width = mw;
          mc.height = mh;
        }
        const mctx = mc.getContext("2d")!;
        const img = mctx.createImageData(mw, mh),
          d = img.data;
        for (let i = 0; i < f.length; i++) {
          const j = i << 2;
          d[j] = d[j + 1] = d[j + 2] = 255;
          d[j + 3] = f[i] * 255;
        }
        mctx.putImageData(img, 0, 0);
        this.maskReady = true;
        if (mask.close) mask.close();
      }
    } catch {}
    this.segBusy = false;
  }

  // ---- generated world ----
  private generateWorld(prompt: string, forAuto = false) {
    prompt = (prompt || "").trim();
    if (!prompt) return;
    const key = prompt.toLowerCase();
    if (this.genCache.has(key)) {
      this.setWorldImg(this.genCache.get(key)!, forAuto);
      return;
    }
    if (!this.segReady) this.initSegmenter();
    this.log(`Generating world › "${prompt}" …`, true);
    this.patch({ genBusy: true });
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      this.genCache.set(key, img);
      this.setWorldImg(img, forAuto);
      this.patch({ genBusy: false });
      this.log(`World ready ✓ — ${prompt}`);
    };
    img.onerror = () => {
      this.patch({ genBusy: false });
      this.log(`⚠︎ world gen failed: ${prompt}`);
    };
    img.src = `${BACKEND_URL}/background?prompt=${encodeURIComponent(prompt)}`;
  }

  private setWorldImg(img: HTMLImageElement, forAuto: boolean) {
    this.worldImg = img;
    if (forAuto) this.autoUseImg = true;
    this.buildBg();
  }

  private buildBg() {
    const name = this.effBg();
    if (name === "None") {
      this.bgCanvas = null;
      return;
    }
    const w = this.cut.width || 1280,
      h = this.cut.height || 720;
    const c = this.bgCanvas || (this.bgCanvas = document.createElement("canvas"));
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d")!;
    const useImg =
      this.worldImg && (this.bgName === "Generated" || (this.bgName === "Auto" && this.autoUseImg));
    if (useImg) drawCover(ctx, this.worldImg!, w, h);
    else if (this.bgName === "Generated") drawProc(ctx, "Void", w, h);
    else drawProc(ctx, name === "Auto" ? this.autoBg : name, w, h);
  }

  private compositeFrame() {
    const ctx = this.ctx,
      w = this.cut.width,
      h = this.cut.height;
    if (!this.bgCanvas) this.buildBg();
    ctx.filter = GRADES[this.grade] || "none";
    if (this.bgCanvas) ctx.drawImage(this.bgCanvas, 0, 0, w, h);
    else {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, w, h);
    }
    const pc = this.personCanvas || (this.personCanvas = document.createElement("canvas"));
    if (pc.width !== w || pc.height !== h) {
      pc.width = w;
      pc.height = h;
    }
    const p = pc.getContext("2d")!;
    p.globalCompositeOperation = "source-over";
    p.clearRect(0, 0, w, h);
    p.drawImage(this.cam, 0, 0, w, h);
    if (this.maskReady && this.maskCanvas) {
      p.globalCompositeOperation = "destination-in";
      p.drawImage(this.maskCanvas, 0, 0, w, h);
      p.globalCompositeOperation = "source-over";
    }
    ctx.drawImage(pc, 0, 0, w, h);
    ctx.filter = "none";
  }

  // ---- background select ----
  setBg(name: string) {
    this.bgName = name;
    this.patch({ bgName: name });
    if (name !== "None") this.initSegmenter();
    this.buildBg();
    this.log(`World › ${name === "None" ? "real background" : name}`);
  }
  generateFromPrompt(prompt: string) {
    prompt = prompt.trim();
    if (!prompt) return;
    this.bgName = "Generated";
    this.patch({ bgName: "Generated" });
    this.worldImg = null;
    this.buildBg();
    this.generateWorld(prompt, false);
  }

  // ---- character detection ----
  private async initFaceDetector() {
    if (this.faceReady || this.faceDetector) return;
    try {
      const { FaceDetector, FilesetResolver } = await loadMediaPipe();
      const vision = await FilesetResolver.forVisionTasks(MP_WASM);
      const make = (delegate: string) =>
        FaceDetector.createFromOptions(vision, {
          baseOptions: { modelAssetPath: FACE_MODEL, delegate },
          runningMode: "VIDEO",
        });
      try {
        this.faceDetector = await make("GPU");
      } catch {
        this.faceDetector = await make("CPU");
      }
      this.faceReady = true;
      this.log("Character detection ready ✓ — A = left, B = right");
    } catch (e) {
      this.log(`⚠︎ character detection unavailable: ${(e as Error).message || e}`);
    }
  }

  private updateFaces(dets: any[]) {
    const boxes = dets
      .map((d) => d.boundingBox)
      .filter(Boolean)
      .sort((a: any, b: any) => a.originX - b.originX)
      .slice(0, 2);
    this.faces = boxes.map((box: any, i: number) => ({ label: i === 0 ? "A" : "B", box }));
    this.renderCast();
  }

  private drawFaceLabels(ctx: CanvasRenderingContext2D, mirrored: boolean) {
    const w = this.cut.width;
    const fs = Math.max(13, Math.round(w * 0.018));
    ctx.save();
    ctx.font = `600 ${fs}px system-ui, sans-serif`;
    for (const f of this.faces) {
      let x = f.box.originX;
      const y = f.box.originY,
        bw = f.box.width;
      if (mirrored) x = w - (x + bw);
      const label = `Character ${f.label}`,
        tw = ctx.measureText(label).width,
        pad = 6;
      const bh = fs + 8,
        ly = Math.max(0, y - bh - 4);
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = CHAR_COLOR[f.label];
      ctx.fillRect(x, ly, tw + pad * 2, bh);
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#0b0d10";
      ctx.fillText(label, x + pad, ly + fs);
    }
    ctx.restore();
  }

  private renderCast() {
    const present = new Set(this.faces.map((f) => f.label));
    const active = this.currentSpeaker;
    const cast = (["A", "B"] as const).map((c) => {
      const speaking = active === c || active === "both";
      const state: CastState = speaking ? "on" : present.has(c) ? "detected" : "off";
      return { label: c, state };
    });
    // only emit if the cast actually changed (face detection ticks ~5×/s)
    if (JSON.stringify(cast) !== JSON.stringify(this.view.cast)) this.patch({ cast });
  }

  // ---- continuous transcription ----
  private startAudio(stream: MediaStream) {
    const track = stream.getAudioTracks()[0];
    if (!track) {
      this.log("⚠︎ no microphone — transcription off");
      return;
    }
    try {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AC();
      this.audioCtx = ctx;
      this.srcRate = ctx.sampleRate;
      const source = ctx.createMediaStreamSource(stream);
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      this.vadSilenceMs = 0;
      this.vadChunkMs = 0;
      this.vadHadSpeech = false;
      proc.onaudioprocess = (e) => {
        const ch = e.inputBuffer.getChannelData(0);
        let s = 0;
        for (let i = 0; i < ch.length; i += 2) s += ch[i] * ch[i];
        const rms = Math.sqrt(s / (ch.length / 2));
        const blockMs = (ch.length / this.srcRate) * 1000;
        this.pcmChunks.push(new Float32Array(ch));
        this.pcmLen += ch.length;
        this.vadChunkMs += blockMs;
        if (rms > VAD_START) {
          this.vadHadSpeech = true;
          this.vadSilenceMs = 0;
        } else if (this.vadHadSpeech && rms < VAD_END) {
          this.vadSilenceMs += blockMs;
        }
        if (!this.vadHadSpeech && this.vadChunkMs > 700) {
          const last = this.pcmChunks[this.pcmChunks.length - 1];
          this.pcmChunks = [last];
          this.pcmLen = last.length;
          this.vadChunkMs = blockMs;
        }
        const endpoint =
          this.vadHadSpeech && this.vadSilenceMs >= VAD_SILENCE_MS && this.vadChunkMs >= VAD_MIN_MS;
        if (endpoint || (this.vadHadSpeech && this.vadChunkMs >= VAD_MAX_MS)) {
          this.vadSilenceMs = 0;
          this.vadChunkMs = 0;
          this.vadHadSpeech = false;
          this.flushAudio();
        }
      };
      const sink = ctx.createGain();
      sink.gain.value = 0;
      source.connect(proc);
      proc.connect(sink);
      sink.connect(ctx.destination);
      this.audioSource = source;
      this.audioProc = proc;
      if (ctx.state === "suspended") ctx.resume();
      this.log("Transcription live — listening (voice-activated)…");
    } catch (e) {
      this.log(`⚠︎ audio capture failed: ${(e as Error).message}`);
    }
  }

  private stopAudio() {
    this.vadSilenceMs = 0;
    this.vadChunkMs = 0;
    this.vadHadSpeech = false;
    try {
      this.audioProc?.disconnect();
    } catch {}
    try {
      this.audioSource?.disconnect();
    } catch {}
    try {
      this.audioCtx?.close();
    } catch {}
    this.audioCtx = this.audioProc = this.audioSource = null;
    this.pcmChunks = [];
    this.pcmLen = 0;
  }

  private async flushAudio() {
    if (!this.pcmLen) return;
    const merged = new Float32Array(this.pcmLen);
    let off = 0;
    for (const c of this.pcmChunks) {
      merged.set(c, off);
      off += c.length;
    }
    this.pcmChunks = [];
    this.pcmLen = 0;
    if (merged.length < this.srcRate * 0.35) return;
    const seq = ++this.asrSeq;
    const dataUrl = await blobToDataURL(encodeWav(downsampleTo16k(merged, this.srcRate), 16000));
    try {
      const res = await fetch(BACKEND_URL + "/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio: dataUrl }),
      });
      const r = await res.json();
      if (r.text) this.addTranscript(r.text, seq);
    } catch {}
  }

  private addTranscript(text: string, seq = 0) {
    text = text.trim();
    if (!text) return;
    const s = this.currentSpeaker;
    const who: TranscriptLine["who"] =
      s === "A" || s === "B" ? (s as "A" | "B") : s === "both" ? "both" : "x";
    const entry: TranscriptLine = { who, text, seq };
    const t = this.transcript;
    let i = t.length;
    while (i > 0 && t[i - 1].seq > seq) i--;
    t.splice(i, 0, entry);
    this.patch({ transcript: t.slice(-40) });
    this.setSubtitle(who, text);
  }

  private setSubtitle(who: TranscriptLine["who"], text: string) {
    const subWho = who === "A" || who === "B" ? who : null;
    this.patch({ subtitleWho: subWho, subtitleText: text, subtitleShow: true });
    if (this.subtitleTimer) clearTimeout(this.subtitleTimer);
    this.subtitleTimer = setTimeout(() => this.patch({ subtitleShow: false }), 4000);
  }

  // ---- perception ----
  private captureFrame(): string | null {
    if (!this.running || this.cam.readyState < 2) return null;
    const cap = this.capCanvas || (this.capCanvas = document.createElement("canvas"));
    const vw = this.cam.videoWidth,
      vh = this.cam.videoHeight;
    const w = 480,
      h = Math.round((vh * w) / vw) || 320;
    cap.width = w;
    cap.height = h;
    cap.getContext("2d")!.drawImage(this.cam, 0, 0, w, h);
    return cap.toDataURL("image/jpeg", 0.6);
  }

  private async perceiveOnce() {
    if (!this.session || this.perceiving) return;
    const frame = this.captureFrame();
    if (!frame) return;
    this.perceiving = true;
    try {
      const res = await fetch(BACKEND_URL + "/perceive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: frame, prior: this.prior }),
      });
      const r = await res.json();
      if (r.error) {
        this.log(`⚠︎ perceive: ${r.error}`);
        return;
      }
      this.applyPerception(r);
    } catch (e) {
      this.log(`⚠︎ perceive failed: ${(e as Error).message}`);
    } finally {
      this.perceiving = false;
    }
  }

  private applyPerception(r: any) {
    this.prior = { setting: r.setting, shot: r.suggested_shot, look: r.suggested_look, scene: this.sceneNum };
    if (r.scene_change) {
      this.sceneNum++;
      this.patch({ scene: `Scene ${this.sceneNum}` });
      this.log(`Director › NEW SCENE — ${r.setting || "?"}`, true);
    }
    this.patch({
      mood: r.emotion || "—",
      shot: (r.suggested_shot || "—") + (r.action ? ` · ${r.action}` : ""),
    });
    this.currentSpeaker = r.speaker || "none";
    this.renderCast();
    if (r.suggested_look && GRADES[r.suggested_look] && r.suggested_look !== this.grade) {
      this.setGrade(r.suggested_look);
    }
    if (this.bgName === "Auto") {
      this.autoBg = LOOK_TO_BG[r.suggested_look] || "Studio";
      const setting = (r.setting || "").trim();
      const norm = setting.toLowerCase();
      const newScene = !this.lastSetting || r.scene_change === true || !sameSetting(norm, this.lastSetting);
      if (setting && newScene) {
        this.lastSetting = norm;
        this.autoUseImg = false;
        this.buildBg();
        this.log(`Director › WORLD → ${setting}`, true);
        this.generateWorld(setting, true);
      } else {
        this.buildBg();
      }
    }
    if (r.director_note) this.log(`Director › ${r.director_note}`, true);
  }

  // ---- session ----
  toggleSession() {
    this.session = !this.session;
    this.patch({
      session: this.session,
      toggleLabel: this.session ? "Stop session" : "Start session",
    });
    if (this.session) {
      this.sessionStart = Date.now();
      this.sceneNum = 1;
      this.prior = null;
      this.patch({ scene: "Scene 1", shot: "WIDE · establishing" });
      this.log("● SESSION START — rolling. Director is watching…", true);
      this.perceiveOnce();
      this.perceiveTimer = setInterval(() => this.perceiveOnce(), PERCEIVE_MS);
    } else {
      if (this.perceiveTimer) clearInterval(this.perceiveTimer);
      this.perceiveTimer = null;
      this.patch({ scene: "—", shot: "—" });
      this.currentSpeaker = "none";
      this.renderCast();
      this.log("■ SESSION STOP");
    }
  }

  private tickTimer() {
    if (this.session) {
      const s = Math.floor((Date.now() - this.sessionStart) / 1000);
      this.patch({
        sessionTime:
          String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0"),
      });
    }
  }

  // ---- snapshot ----
  snapshot() {
    const url = this.cut.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = url;
    a.download = `cut-frame-${Date.now()}.png`;
    a.click();
    this.log("Snapshot saved (director's cut frame)");
  }

  // ---- teardown ----
  dispose() {
    try {
      cancelAnimationFrame(this.raf);
      if (this.tickInterval) clearInterval(this.tickInterval);
      if (this.perceiveTimer) clearInterval(this.perceiveTimer);
      if (this.subtitleTimer) clearTimeout(this.subtitleTimer);
      this.stopTracks();
      this.segmenter?.close?.();
      this.faceDetector?.close?.();
    } catch {}
  }
}
