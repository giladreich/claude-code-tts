import * as fs from "fs";

/**
 * Minimal RIFF/WAVE reader that walks chunks properly. CoreAudio (the mic
 * recorder) writes extra chunks (e.g. a "FLLR" filler) before "data", so the
 * classic "44-byte header" assumption silently misreads such files.
 */
export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Byte offset of the first sample in the file. */
  dataOffset: number;
  /** Data bytes present in the buffer that was parsed. */
  dataLength: number;
  /** Data length declared by the header (may exceed the parsed buffer). */
  declaredDataLength: number;
  seconds: number;
}

export function parseWav(buf: Buffer): WavInfo | undefined {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    return undefined;
  }
  let off = 12;
  let fmt: { rate: number; ch: number; bits: number } | undefined;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const len = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt " && len >= 16) {
      fmt = { ch: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === "data") {
      if (!fmt || !fmt.rate || !fmt.ch || !fmt.bits) {
        return undefined;
      }
      const dataLength = Math.min(len, buf.length - body);
      return {
        sampleRate: fmt.rate,
        channels: fmt.ch,
        bitsPerSample: fmt.bits,
        dataOffset: body,
        dataLength,
        declaredDataLength: len,
        seconds: dataLength / (fmt.rate * fmt.ch * (fmt.bits / 8)),
      };
    }
    off = body + len + (len % 2);
  }
  return undefined;
}

/** Duration in seconds from the file header (chunk-aware); undefined if unreadable. */
export function wavFileSeconds(file: string): number | undefined {
  try {
    const fd = fs.openSync(file, "r");
    const head = Buffer.alloc(8192);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    const size = fs.fstatSync(fd).size;
    fs.closeSync(fd);
    // Walk chunks on the head; compute data length from file size when the
    // data chunk extends past what we read.
    const info = parseWav(head.subarray(0, n));
    if (!info) {
      return undefined;
    }
    // Only the header was read; the data length comes from the declaration,
    // bounded by the real file size (a still-growing or truncated file).
    const dataLen = Math.min(info.declaredDataLength || size - info.dataOffset, size - info.dataOffset);
    return dataLen / (info.sampleRate * info.channels * (info.bitsPerSample / 8));
  } catch {
    return undefined;
  }
}

/** Build a canonical 44-byte-header PCM WAV buffer. */
export function buildWav(pcm: Buffer, sampleRate: number, channels: number, bitsPerSample: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  header.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Trim leading/trailing silence from a 16-bit mono WAV in place and return
 * {seconds, rms}. Silence at the edges wastes reference budget and can
 * confuse the cloner; rms lets us warn about a too-quiet recording.
 */
export function trimSilence(file: string): { seconds: number; rms: number } {
  const buf = fs.readFileSync(file);
  const info = parseWav(buf);
  if (!info || info.bitsPerSample !== 16 || info.channels !== 1) {
    return { seconds: 0, rms: 0 };
  }
  const pcm = buf.subarray(info.dataOffset, info.dataOffset + info.dataLength);
  const n = Math.floor(pcm.length / 2);
  const abs = (i: number) => Math.abs(pcm.readInt16LE(i * 2));
  // Frame-wise energy, 20ms frames.
  const frame = Math.floor(info.sampleRate * 0.02);
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    sumSq += abs(i) ** 2;
  }
  const rms = Math.sqrt(sumSq / Math.max(1, n));
  const threshold = Math.max(150, rms * 0.15);
  const loud = (f: number) => {
    let s = 0;
    for (let i = f * frame; i < Math.min(n, (f + 1) * frame); i++) {
      s += abs(i);
    }
    return s / frame > threshold;
  };
  const frames = Math.floor(n / frame);
  let start = 0;
  while (start < frames && !loud(start)) {
    start++;
  }
  let end = frames - 1;
  while (end > start && !loud(end)) {
    end--;
  }
  const from = Math.max(0, (start - 5) * frame) * 2; // keep 100ms of lead-in
  const to = Math.min(n, (end + 10) * frame) * 2; // and 200ms of tail
  const trimmed = pcm.subarray(from, to);
  // Rewrite canonically (44-byte header): downstream readers and the cloner
  // then see exactly the trimmed speech and nothing else.
  fs.writeFileSync(file, buildWav(Buffer.from(trimmed), info.sampleRate, 1, 16));
  return { seconds: trimmed.length / 2 / info.sampleRate, rms };
}

/** Per-frame (20ms) RMS energies of a 16-bit mono WAV. */
function frameEnergies(pcm: Buffer, sampleRate: number): { frames: number[]; frameLen: number } {
  const frameLen = Math.floor(sampleRate * 0.02);
  const n = Math.floor(pcm.length / 2);
  const frames: number[] = [];
  for (let f = 0; (f + 1) * frameLen <= n; f++) {
    let s = 0;
    for (let i = f * frameLen; i < (f + 1) * frameLen; i++) {
      const v = pcm.readInt16LE(i * 2);
      s += v * v;
    }
    frames.push(Math.sqrt(s / frameLen));
  }
  return { frames, frameLen };
}

export interface ReferenceWindow {
  start: number;
  end: number;
  seconds: number;
  /** 0-1: fraction of frames with speech energy. */
  density: number;
  /** Mean frame energy, which breaks ties between equally dense windows. */
  level: number;
}

/**
 * Choose the stretch of a longer recording that makes the best voice-clone
 * reference: `target` seconds long (bounded by min/max), starting right
 * after a pause (a sentence start, so the transcript lines up) and ending at
 * a pause, with the highest speech density and level. Returns candidates
 * best first, so a user can step to the next one.
 */
export function referenceWindows(
  file: string,
  { target = 10, min = 6, max = 12 }: { target?: number; min?: number; max?: number } = {}
): ReferenceWindow[] {
  const buf = fs.readFileSync(file);
  const info = parseWav(buf);
  if (!info || info.bitsPerSample !== 16 || info.channels !== 1) {
    return [];
  }
  const pcm = buf.subarray(info.dataOffset, info.dataOffset + info.dataLength);
  const { frames, frameLen } = frameEnergies(pcm, info.sampleRate);
  const secPerFrame = frameLen / info.sampleRate;
  const total = frames.length * secPerFrame;
  if (frames.length === 0) {
    return [];
  }
  const sorted = [...frames].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.2)];
  const peakish = sorted[Math.floor(sorted.length * 0.95)];
  const threshold = Math.max(150, floor + (peakish - floor) * 0.15);
  const loud = frames.map((e) => e > threshold);
  // Pause boundaries: runs of >= 250ms below threshold.
  const pauseFrames = Math.round(0.25 / secPerFrame);
  const starts: number[] = [0];
  let quiet = 0;
  for (let f = 0; f < loud.length; f++) {
    if (!loud[f]) {
      quiet++;
    } else {
      if (quiet >= pauseFrames) {
        starts.push(f);
      }
      quiet = 0;
    }
  }
  if (total <= max * 1.15) {
    // Short enough to use whole (a little over the maximum is still fine).
    const density = loud.filter(Boolean).length / loud.length;
    return [
      { start: 0, end: total, seconds: total, density, level: loud.filter(Boolean).length / Math.max(1, loud.length) },
    ];
  }
  const out: ReferenceWindow[] = [];
  for (const s of starts) {
    const startSec = s * secPerFrame;
    if (startSec + min > total) {
      break;
    }
    // End: the last pause boundary within [min, max] after the start, else max.
    let endSec = Math.min(total, startSec + max);
    let bestEnd: number | undefined;
    for (const e of starts) {
      const eSec = e * secPerFrame;
      // Last one wins: closest to max
      if (eSec > startSec + min && eSec <= startSec + max) {
        bestEnd = eSec;
      }
      if (eSec > startSec + max) {
        break;
      }
    }
    if (bestEnd !== undefined) {
      // Prefer the boundary nearest the target length.
      let nearest = bestEnd;
      for (const e of starts) {
        const eSec = e * secPerFrame;
        if (
          eSec > startSec + min &&
          eSec <= startSec + max &&
          Math.abs(eSec - startSec - target) < Math.abs(nearest - startSec - target)
        ) {
          nearest = eSec;
        }
      }
      endSec = nearest;
    }
    const f0 = s,
      f1 = Math.min(loud.length, Math.round(endSec / secPerFrame));
    let voiced = 0,
      energy = 0;
    for (let f = f0; f < f1; f++) {
      if (loud[f]) {
        voiced++;
      }
      energy += frames[f];
    }
    const density = voiced / Math.max(1, f1 - f0);
    out.push({
      start: startSec,
      end: endSec,
      seconds: endSec - startSec,
      density,
      level: energy / Math.max(1, f1 - f0),
    });
  }
  // Rank: speech density first (fewer long pauses), then level (clearer).
  return out
    .filter((w) => w.seconds >= min)
    .sort((a, b) => b.density - a.density || b.level - a.level)
    .map(({ start, end, seconds, density, level }) => ({ start, end, seconds, density, level }));
}

/** Write [start, end) seconds of a 16-bit mono WAV to a new canonical file. */
export function extractWav(file: string, start: number, end: number, out: string): void {
  const buf = fs.readFileSync(file);
  const info = parseWav(buf);
  if (!info) {
    throw new Error("not a PCM WAV");
  }
  const bytesPerSec = info.sampleRate * info.channels * (info.bitsPerSample / 8);
  const align = info.channels * (info.bitsPerSample / 8);
  const from = Math.floor((start * bytesPerSec) / align) * align;
  const to = Math.min(info.dataLength, Math.floor((end * bytesPerSec) / align) * align);
  fs.writeFileSync(
    out,
    buildWav(
      Buffer.from(buf.subarray(info.dataOffset + from, info.dataOffset + to)),
      info.sampleRate,
      info.channels,
      info.bitsPerSample
    )
  );
}

/**
 * Normalize a 16-bit mono WAV reference in place: remove DC offset and scale
 * so the loudest 0.5% of samples sit near -3 dBFS. Cloning copies the
 * reference's level and tonal balance; a consistently leveled, un-clipped
 * reference gives every profile the same starting point and keeps quiet
 * recordings from producing quiet, thin clones. Returns the applied gain.
 */
export function normalizeReference(file: string): { gain: number; peak: number } {
  const buf = fs.readFileSync(file);
  const info = parseWav(buf);
  if (!info || info.bitsPerSample !== 16 || info.channels !== 1) {
    return { gain: 1, peak: 0 };
  }
  const pcm = buf.subarray(info.dataOffset, info.dataOffset + info.dataLength);
  const n = Math.floor(pcm.length / 2);
  if (n === 0) {
    return { gain: 1, peak: 0 };
  }
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += pcm.readInt16LE(i * 2);
  }
  const dc = sum / n;
  const mags = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    mags[i] = Math.abs(pcm.readInt16LE(i * 2) - dc);
  }
  const sorted = Int32Array.from(mags).sort();
  const peak = sorted[Math.max(0, Math.floor(n * 0.995) - 1)]; // robust peak: ignores clicks
  if (peak < 50) {
    return { gain: 1, peak };
  }
  const target = 32767 * 0.7079; // -3 dBFS
  const gain = Math.min(8, Math.max(0.25, target / peak));
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.round((pcm.readInt16LE(i * 2) - dc) * gain);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2);
  }
  fs.writeFileSync(file, buildWav(out, info.sampleRate, 1, 16));
  return { gain, peak: peak / 32767 };
}
