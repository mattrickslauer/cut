// Float32 @ srcRate → 16 kHz mono 16-bit PCM WAV Blob → data URL, for qwen3-asr-flash.

export function downsampleTo16k(f32: Float32Array, srcRate: number): Float32Array {
  if (srcRate === 16000) return f32;
  const ratio = srcRate / 16000,
    outLen = Math.floor(f32.length / ratio),
    out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const s = Math.floor(i * ratio),
      e = Math.floor((i + 1) * ratio);
    let sum = 0,
      c = 0;
    for (let j = s; j < e && j < f32.length; j++) {
      sum += f32[j];
      c++;
    }
    out[i] = c ? sum / c : 0;
  }
  return out;
}

export function encodeWav(f32: Float32Array, rate: number): Blob {
  const len = f32.length,
    buf = new ArrayBuffer(44 + len * 2),
    dv = new DataView(buf);
  const w = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, "RIFF");
  dv.setUint32(4, 36 + len * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  w(36, "data");
  dv.setUint32(40, len * 2, true);
  let o = 44;
  for (let i = 0; i < len; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    o += 2;
  }
  return new Blob([buf], { type: "audio/wav" });
}

export function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((res) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result as string);
    fr.readAsDataURL(blob);
  });
}
