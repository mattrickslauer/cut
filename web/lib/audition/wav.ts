// Float32 @ srcRate → 16 kHz mono 16-bit PCM → WAV data URI. qwen3-asr-flash wants 16 kHz mono.
export const ASR_RATE = 16000;

export function flatten(chunks: Float32Array[], len: number): Float32Array {
  const out = new Float32Array(len);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export function downsample(
  buf: Float32Array,
  from: number,
  to: number
): Float32Array {
  if (to >= from) return buf;
  const ratio = from / to;
  const outLen = Math.round(buf.length / ratio);
  const out = new Float32Array(outLen);
  let oi = 0;
  let ii = 0;
  while (oi < outLen) {
    const next = Math.round((oi + 1) * ratio);
    let sum = 0;
    let n = 0;
    for (; ii < next && ii < buf.length; ii++) {
      sum += buf[ii];
      n++;
    }
    out[oi++] = n ? sum / n : 0;
  }
  return out;
}

export function encodeWav(float: Float32Array, srcRate: number): string {
  const pcm = downsample(float, srcRate, ASR_RATE);
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buf);
  const w = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, "RIFF");
  view.setUint32(4, 36 + pcm.length * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, ASR_RATE, true);
  view.setUint32(28, ASR_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  w(36, "data");
  view.setUint32(40, pcm.length * 2, true);
  let off = 44;
  for (let i = 0; i < pcm.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  let bin = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return "data:audio/wav;base64," + btoa(bin);
}
