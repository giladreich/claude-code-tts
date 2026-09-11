/**
 * Putting played audio back together and writing it to a file.
 *
 * The buffer holds one WAV per utterance at the pace the engine produced it.
 * Hearing it again the way it played means stretching each one by the tempo
 * the player applied (ffmpeg's atempo, pitch-preserving like the player's
 * own time-stretch), putting the pauses between them back within reason, and
 * cutting the stretch that was asked for. WAV needs nothing installed; every
 * compressed format is ffmpeg's job, except that macOS can write AAC itself.
 *
 * Everything here is filesystem and child-process work with no vscode
 * import, so the unit tests run it for real.
 */
import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { commandOnPath, isMac } from "../platform/platform";
import { buildWav, parseWav } from "../tts/wav";
import { PlayedEntry } from "./playedAudio";

export type ExportFormat = "mp3" | "m4a" | "opus" | "flac" | "wav";

export type ExportQuality = "small" | "good" | "best";

export type PauseStyle = "tight" | "natural" | "asHeard";

/** As played (the tempo applied), the engine's own pace, or the audio as it is. */
export type SpeedChoice = "asPlayed" | "natural" | "asIs";

export interface FormatInfo {
  label: string;
  ext: string;
  detail: string;
  /** kbit/s per quality tier; absent for lossless formats. */
  bitrates?: Record<ExportQuality, number>;
}

export const FORMATS: Record<ExportFormat, FormatInfo> = {
  mp3: {
    label: "MP3",
    ext: "mp3",
    detail: "Plays everywhere",
    // MPEG-2 layer III, which is what 22 and 24 kHz speech is, tops out at 160.
    bitrates: { small: 48, good: 96, best: 160 },
  },
  m4a: {
    label: "M4A (AAC)",
    ext: "m4a",
    detail: "Smaller than MP3 at the same quality; phones, browsers and most players",
    bitrates: { small: 32, good: 64, best: 96 },
  },
  opus: {
    label: "Opus",
    ext: "opus",
    detail: "The smallest files for speech; browsers and modern players",
    bitrates: { small: 24, good: 32, best: 48 },
  },
  flac: { label: "FLAC", ext: "flac", detail: "Lossless, about half the size of WAV" },
  wav: { label: "WAV", ext: "wav", detail: "Uncompressed and exact; needs nothing installed" },
};

export const QUALITY_LABEL: Record<ExportQuality, string> = { small: "Small", good: "Good", best: "Best" };

/** The longest pause kept between two utterances, per style, in seconds. */
export const PAUSE_CAP: Record<PauseStyle, number> = { tight: 0.15, natural: 0.6, asHeard: 4 };

export interface Encoders {
  ffmpeg?: string;
  afconvert?: string;
}

/** What this machine can encode with, looked up when the export starts. */
export function findEncoders(): Encoders {
  return {
    ffmpeg: commandOnPath("ffmpeg"),
    afconvert: isMac ? (commandOnPath("afconvert") ?? "/usr/bin/afconvert") : undefined,
  };
}

/** The tool a format needs and this machine lacks, if any. */
export function missingFor(format: ExportFormat, enc: Encoders): "ffmpeg" | undefined {
  if (format === "wav") {
    return undefined;
  }
  if (format === "m4a" && (enc.ffmpeg || enc.afconvert)) {
    return undefined;
  }
  return enc.ffmpeg ? undefined : "ffmpeg";
}

/** Matching the played tempo needs a time-stretch, which only ffmpeg provides here. */
export const canStretch = (enc: Encoders): boolean => !!enc.ffmpeg;

/**
 * The format a chosen file name asks for. Typing ".wav" into the save box
 * means WAV, whatever the sheet said, when this machine can write it; an
 * extension that names nothing this can write keeps the sheet's format and
 * the file gets that format's extension.
 */
export function formatForPath(
  fsPath: string,
  format: ExportFormat,
  enc: Encoders
): { format: ExportFormat; path: string } {
  const ext = path.extname(fsPath).slice(1).toLowerCase();
  if (ext === FORMATS[format].ext) {
    return { format, path: fsPath };
  }
  const named = (Object.keys(FORMATS) as ExportFormat[]).find((f) => FORMATS[f].ext === ext);
  if (named && !missingFor(named, enc)) {
    return { format: named, path: fsPath };
  }
  return { format, path: `${fsPath}.${FORMATS[format].ext}` };
}

/** One utterance placed on the export's own clock. */
export interface Segment {
  entry: PlayedEntry;
  /** Speed factor applied to the stored audio (1 = as stored). */
  stretch: number;
  /** Seconds it occupies in the export. */
  seconds: number;
  t0: number;
  t1: number;
}

export function stretchOf(entry: PlayedEntry, speed: SpeedChoice): number {
  if (speed === "asPlayed") {
    return entry.tempo || 1;
  }
  if (speed === "natural") {
    return 1 / (entry.synthSpeed || 1);
  }
  return 1;
}

/**
 * Lay the entries out in order, each stretched as asked, with the pause that
 * was heard between them kept up to the style's cap: a wait for synthesis
 * or for Claude's next paragraph was silence at the time, but it is not
 * something anyone wants in a recording.
 */
export function timeline(entries: PlayedEntry[], speed: SpeedChoice, pauses: PauseStyle): Segment[] {
  const cap = PAUSE_CAP[pauses];
  const out: Segment[] = [];
  let cursor = 0;
  let previous: PlayedEntry | undefined;
  for (const entry of entries) {
    if (!entry.file || entry.seconds <= 0) {
      continue;
    }
    const stretch = stretchOf(entry, speed);
    const seconds = entry.seconds / stretch;
    const heardGap = previous ? (entry.at - previous.endedAt) / 1000 : 0;
    const gap = Math.min(cap, Math.max(0, heardGap));
    const t0 = cursor + gap;
    out.push({ entry, stretch, seconds, t0, t1: t0 + seconds });
    cursor = t0 + seconds;
    previous = entry;
  }
  return out;
}

export const totalSeconds = (segments: Segment[]): number => (segments.length ? segments[segments.length - 1].t1 : 0);

/** A message as the picker offers it: the consecutive entries of one group. */
export interface PlayedMessage {
  entries: PlayedEntry[];
  group?: string;
}

/**
 * Consecutive entries that belong to one message, in order. Announcements of
 * the extension's own carry no group and run together as one.
 */
export function messagesOf(entries: PlayedEntry[]): PlayedMessage[] {
  const out: PlayedMessage[] = [];
  for (const e of entries) {
    const last = out[out.length - 1];
    if (last && last.group === e.group) {
      last.entries.push(e);
    } else {
      out.push({ entries: [e], group: e.group });
    }
  }
  return out;
}

/** The opening words of a text, cut at a word, for a row or a title. */
export function firstWords(text: string, max = 60): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) {
    return clean;
  }
  const cut = clean.slice(0, max);
  return `${cut.slice(0, Math.max(20, cut.lastIndexOf(" "))).trimEnd()}...`;
}

/** The sample rate most of the audio is at; mixed rates are resampled to it. */
export function sampleRateOf(segments: Segment[]): number {
  const count = new Map<number, number>();
  for (const s of segments) {
    count.set(s.entry.sampleRate, (count.get(s.entry.sampleRate) ?? 0) + s.seconds);
  }
  let best = 24000;
  let most = -1;
  for (const [rate, secs] of count) {
    if (secs > most) {
      most = secs;
      best = rate;
    }
  }
  return best;
}

/** Bytes the file will be, near enough to choose by. */
export function estimateBytes(
  format: ExportFormat,
  quality: ExportQuality,
  seconds: number,
  sampleRate: number
): number {
  const pcm = seconds * sampleRate * 2;
  const bitrate = FORMATS[format].bitrates?.[quality];
  if (bitrate) {
    return Math.round((bitrate * 1000 * seconds) / 8) + 4096;
  }
  return format === "flac" ? Math.round(pcm * 0.55) : Math.round(pcm) + 44;
}

/** "1:05" for 65 seconds; "12:03.5" is never shown, the export deals in whole seconds. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function sizeLabel(bytes: number): string {
  if (bytes >= 1024 ** 2) {
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * "0:10-1:30", "10-90", "0:10 to 1:30", "0:10" (to the end), "-1:30" (from
 * the start). Empty means all of it; a string is the reason it is wrong.
 */
export function parseRange(text: string, total: number): { start: number; end: number } | undefined | string {
  const t = text.trim();
  if (!t) {
    return undefined;
  }
  const toSecs = (s: string): number | undefined => {
    const m = s.trim().match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
    if (!m) {
      return undefined;
    }
    if (m[1] && parseFloat(m[2]) >= 60) {
      return undefined;
    }
    return (m[1] ? parseInt(m[1], 10) * 60 : 0) + parseFloat(m[2]);
  };
  const m = t.match(/^([\d:.]*)\s*(?:-|to)\s*([\d:.]*)$/i) ?? (toSecs(t) !== undefined ? [t, t, ""] : null);
  if (!m) {
    return "Use a range like 0:10-1:30 or 10-90 (minutes:seconds or seconds)";
  }
  const start = m[1] ? toSecs(m[1]) : 0;
  const end = m[2] ? toSecs(m[2]) : total;
  if (start === undefined || end === undefined) {
    return "Times look like 1:20 or 80 (seconds)";
  }
  if (start >= total) {
    return `The audio ends at ${clock(total)}`;
  }
  const e = Math.min(end, total);
  if (e - start < 1) {
    return "The range must cover at least a second";
  }
  return { start, end: e };
}

export interface ExportRequest {
  segments: Segment[];
  range?: { start: number; end: number };
  format: ExportFormat;
  quality: ExportQuality;
  encoders: Encoders;
  out: string;
  /** Scratch directory for the assembled WAV and stretched parts; the caller removes it. */
  workDir: string;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

/** How many segments are prepared ahead of the one being written: ffmpeg's start-up costs overlap. */
const PREPARE_AHEAD = 3;

export interface ExportResult {
  seconds: number;
  bytes: number;
}

/** Assemble the range and encode it. Throws with a readable message. */
export async function exportAudio(req: ExportRequest): Promise<ExportResult> {
  const start = req.range?.start ?? 0;
  const end = req.range?.end ?? totalSeconds(req.segments);
  const chosen = req.segments.filter((s) => s.t1 > start && s.t0 < end);
  if (chosen.length === 0) {
    throw new Error("nothing was played in that range");
  }
  const rate = sampleRateOf(chosen);
  // The timeline was laid out with a stretch; applying it is ffmpeg's job,
  // and cutting a range on a timeline the audio does not follow would be a
  // wrong file rather than a slower one. The sheet never asks for this.
  if (!req.encoders.ffmpeg && chosen.some((s) => Math.abs(s.stretch - 1) > 0.005)) {
    throw new Error("matching the playback speed needs ffmpeg");
  }
  if (req.signal?.aborted) {
    throw new Error("cancelled");
  }
  fs.mkdirSync(req.workDir, { recursive: true });
  const assembled = path.join(req.workDir, "assembled.wav");
  const fd = fs.openSync(assembled, "w");
  let written = 0;
  const put = (buf: Buffer) => {
    fs.writeSync(fd, buf);
    written += buf.length;
  };
  const silence = (seconds: number) => Buffer.alloc(Math.max(0, Math.round(seconds * rate)) * 2);
  // Segments are prepared a few ahead of the one being written, so the
  // stretching (one ffmpeg each) runs alongside the file work rather than
  // in front of it; the writer still consumes them in order.
  const prepared = new Map<number, Promise<Buffer>>();
  const prepare = (i: number) => {
    if (i < chosen.length && !prepared.has(i)) {
      const p = pcmFor(chosen[i], rate, req);
      p.catch(() => undefined); // failures surface when the writer reaches it
      prepared.set(i, p);
    }
  };
  try {
    put(Buffer.alloc(44)); // header comes last, once the length is known
    let cursor = start;
    for (let i = 0; i < chosen.length; i++) {
      if (req.signal?.aborted) {
        throw new Error("cancelled");
      }
      for (let j = i; j <= i + PREPARE_AHEAD; j++) {
        prepare(j);
      }
      const seg = chosen[i];
      const pcm = await prepared.get(i)!;
      prepared.delete(i);
      if (seg.t0 > cursor) {
        put(silence(seg.t0 - cursor));
        cursor = seg.t0;
      }
      const from = Math.max(0, cursor - seg.t0);
      const to = Math.min(end - seg.t0, pcm.length / 2 / rate);
      if (to > from) {
        put(pcm.subarray(Math.round(from * rate) * 2, Math.round(to * rate) * 2));
        cursor = seg.t0 + to;
      }
      req.onProgress?.((i + 1) / (chosen.length + 1));
    }
    const data = written - 44;
    const header = buildWav(Buffer.alloc(0), rate, 1, 16);
    header.writeUInt32LE(36 + data, 4);
    header.writeUInt32LE(data, 40);
    fs.writeSync(fd, header, 0, 44, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (req.signal?.aborted) {
    throw new Error("cancelled");
  }
  // Encoded beside the assembly and moved into place last, so a failure or
  // a cancellation leaves whatever was at the destination untouched.
  const encoded = path.join(req.workDir, `export.${FORMATS[req.format].ext}`);
  await encode(assembled, encoded, req, firstWords(chosen[0].entry.text, 60));
  moveInto(encoded, req.out);
  req.onProgress?.(1);
  const bytes = fs.statSync(req.out).size;
  return { seconds: (written - 44) / 2 / rate, bytes };
}

/** Rename where the destination is on the same volume, copy where it is not. */
function moveInto(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch {
    fs.copyFileSync(from, to);
    fs.rmSync(from, { force: true });
  }
}

/** The 16-bit mono PCM of one segment at the export's rate, stretched as the timeline says. */
async function pcmFor(seg: Segment, rate: number, req: ExportRequest): Promise<Buffer> {
  const file = seg.entry.file!;
  const needsStretch = Math.abs(seg.stretch - 1) > 0.005;
  const needsRate = seg.entry.sampleRate !== rate;
  if ((needsStretch || needsRate) && req.encoders.ffmpeg) {
    const out = path.join(req.workDir, `${path.basename(file, ".wav")}.${rate}.wav`);
    const filters = needsStretch ? atempo(seg.stretch) : [];
    // prettier-ignore
    await run(req.encoders.ffmpeg, [
      "-y", "-nostdin", "-loglevel", "error",
      "-i", file,
      ...(filters.length ? ["-af", filters.join(",")] : []),
      "-ar", String(rate), "-ac", "1", "-sample_fmt", "s16", "-f", "wav",
      out,
    ], req.signal);
    return readPcm(out);
  }
  const pcm = readPcm(file);
  return needsRate ? resample(pcm, seg.entry.sampleRate, rate) : pcm;
}

/** atempo takes 0.5 to 2 per instance; two of the square root cover the rest. */
export function atempo(stretch: number): string[] {
  if (stretch >= 0.5 && stretch <= 2) {
    return [`atempo=${stretch.toFixed(3)}`];
  }
  const half = Math.sqrt(stretch).toFixed(3);
  return [`atempo=${half}`, `atempo=${half}`];
}

function readPcm(file: string): Buffer {
  const buf = fs.readFileSync(file);
  const info = parseWav(buf);
  if (!info || info.bitsPerSample !== 16 || info.channels !== 1) {
    throw new Error(`${path.basename(file)} is not 16-bit mono PCM`);
  }
  return buf.subarray(info.dataOffset, info.dataOffset + info.dataLength);
}

/** Linear interpolation: only reached when engines at different rates met and ffmpeg is absent. */
export function resample(pcm: Buffer, from: number, to: number): Buffer {
  const n = Math.floor(pcm.length / 2);
  const m = Math.round((n * to) / from);
  const out = Buffer.alloc(m * 2);
  for (let i = 0; i < m; i++) {
    const pos = (i * from) / to;
    const j = Math.floor(pos);
    const a = pcm.readInt16LE(Math.min(n - 1, j) * 2);
    const b = pcm.readInt16LE(Math.min(n - 1, j + 1) * 2);
    out.writeInt16LE(Math.round(a + (b - a) * (pos - j)), i * 2);
  }
  return out;
}

async function encode(wav: string, out: string, req: ExportRequest, title: string): Promise<void> {
  const { format, quality, encoders } = req;
  const bitrate = FORMATS[format].bitrates?.[quality];
  if (format === "wav") {
    fs.renameSync(wav, out);
    return;
  }
  if (format === "m4a" && !encoders.ffmpeg && encoders.afconvert) {
    await run(encoders.afconvert, ["-f", "m4af", "-d", "aac", "-b", String(bitrate! * 1000), wav, out], req.signal);
    return;
  }
  if (!encoders.ffmpeg) {
    throw new Error(`${FORMATS[format].label} needs ffmpeg`);
  }
  const codec: Record<Exclude<ExportFormat, "wav">, string[]> = {
    mp3: ["-c:a", "libmp3lame", "-b:a", `${bitrate}k`],
    m4a: ["-c:a", "aac", "-b:a", `${bitrate}k`, "-movflags", "+faststart"],
    opus: ["-c:a", "libopus", "-b:a", `${bitrate}k`],
    flac: ["-c:a", "flac"],
  };
  const meta = title ? ["-metadata", `title=${title}`] : [];
  try {
    // prettier-ignore
    await run(encoders.ffmpeg, [
      "-y", "-nostdin", "-loglevel", "error",
      "-i", wav,
      ...codec[format], ...meta,
      "-metadata", "comment=Exported by Claude Code TTS",
      out,
    ], req.signal);
  } catch (e) {
    if (/unknown encoder|encoder .* not found/i.test((e as Error).message)) {
      throw new Error(`this ffmpeg was built without a ${FORMATS[format].label} encoder`, { cause: e });
    }
    throw e;
  }
}

function run(cmd: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 600_000, maxBuffer: 1024 * 1024, signal }, (err, _stdout, stderr) => {
      if (!err) {
        return resolve();
      }
      if (signal?.aborted) {
        return reject(new Error("cancelled"));
      }
      const reason = String(stderr || err.message)
        .trim()
        .split("\n")
        .filter(Boolean)
        .pop();
      reject(new Error(`${path.basename(cmd)} failed: ${(reason ?? "").slice(0, 200)}`));
    });
  });
}
