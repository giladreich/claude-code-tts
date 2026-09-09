/**
 * Cloning a voice from audio the user already has. Any audio or video file is
 * decoded to the WAV the cloners want, an optional part of a long file is
 * taken, and the clearest 6-12s stretches between pauses are prepared so each
 * can be heard before one becomes the reference. Nothing leaves the machine.
 */

import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { qwen3VoicesDir } from "../tts/qwen3";
import { extractWav, normalizeReference, parseWav, referenceWindows, trimSilence, wavFileSeconds } from "../tts/wav";
import { playSample } from "./design";
import { BACK, inputWithBack, offerCommand, pickWithPreview } from "../ui/prompts";
import { hasCommand } from "../platform/platform";
import { ensureCloneConsent } from "./consent";
import {
  ensureProfileEngine,
  ensureSwiftHelper,
  pickCloneLanguage,
  saveCloneProfile,
  transcribeRecording,
} from "./clone";

const EXTRACT_BIN = "claude-code-tts-extract-v1";

/** "1:20" for 80 seconds. */
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/**
 * Convert any audio file to 24kHz mono 16-bit WAV, which is what the cloner
 * (and our WAV tooling) wants. macOS: afconvert (built in). Elsewhere:
 * ffmpeg when present. A WAV already in that format is copied as is.
 */
export function convertToCloneWav(
  input: string,
  out: string,
  opts: { extractor?: string; start?: number; end?: number } = {}
): Promise<void> {
  const ranged = (opts.start ?? 0) > 0 || (opts.end ?? 0) > 0;
  return new Promise((resolve, reject) => {
    if (!ranged) {
      try {
        const head = Buffer.alloc(8192);
        const fd = fs.openSync(input, "r");
        const n = fs.readSync(fd, head, 0, head.length, 0);
        fs.closeSync(fd);
        const info = parseWav(head.subarray(0, n));
        if (info && info.sampleRate === 24000 && info.channels === 1 && info.bitsPerSample === 16) {
          fs.copyFileSync(input, out);
          return resolve();
        }
      } catch {
        /* fall through to conversion */
      }
    }
    const has = hasCommand;
    const done = (err: Error | null) => (err ? reject(err) : resolve());
    const rangeArgs = ranged ? [String(opts.start ?? 0), String(opts.end ?? 0)] : [];
    if (opts.extractor && fs.existsSync(opts.extractor)) {
      // AVFoundation: video containers and every audio format CoreAudio reads.
      execFile(opts.extractor, [input, out, ...rangeArgs], { timeout: 300_000 }, (err, stdout) => {
        let msg: any = {};
        try {
          msg = JSON.parse(String(stdout).trim().split("\n").pop() ?? "{}");
        } catch {}
        done(msg.ok === true ? null : new Error(String(msg.error ?? err?.message ?? "extraction failed")));
      });
    } else if (process.platform === "darwin" && has("afconvert") && !ranged) {
      execFile(
        "afconvert",
        ["-f", "WAVE", "-d", "LEI16@24000", "-c", "1", input, out],
        { timeout: 120_000 },
        (err, _o, stderr) =>
          done(
            err
              ? new Error(
                  `afconvert failed: ${String(stderr || err.message)
                    .trim()
                    .slice(0, 200)}`
                )
              : null
          )
      );
    } else if (has("ffmpeg")) {
      const range = ranged
        ? ["-ss", String(opts.start ?? 0), ...((opts.end ?? 0) > 0 ? ["-to", String(opts.end)] : [])]
        : [];
      execFile(
        "ffmpeg",
        ["-y", ...range, "-i", input, "-ac", "1", "-ar", "24000", "-sample_fmt", "s16", "-vn", out],
        { timeout: 300_000 },
        (err, _o, stderr) =>
          done(
            err
              ? new Error(
                  `ffmpeg failed: ${String(stderr || err.message)
                    .trim()
                    .slice(-200)}`
                )
              : null
          )
      );
    } else {
      reject(
        new Error(
          process.platform === "darwin"
            ? "audio helper unavailable"
            : "ffmpeg is needed to read audio/video files (install it, or provide a 24kHz mono 16-bit WAV)"
        )
      );
    }
  });
}

/**
 * "1:20-2:05", "80-125", "0:45 to 1:30", "1:20" (to the end), "-2:05"
 * (from the start). Returns seconds; undefined when empty; an Error message
 * string when invalid.
 */
export function parseTimeRange(text: string, total: number): { start: number; end: number } | undefined | string {
  const t = text.trim();
  if (!t) {
    return undefined;
  }
  const toSecs = (s: string): number | undefined => {
    const m = s.trim().match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
    if (!m) {
      return undefined;
    }
    const secs = (m[1] ? parseInt(m[1], 10) * 60 : 0) + parseFloat(m[2]);
    return m[1] && parseFloat(m[2]) >= 60 ? undefined : secs;
  };
  const m = t.match(/^([\d:.]*)\s*(?:-|to|–)\s*([\d:.]*)$/i) ?? (toSecs(t) !== undefined ? [t, t, ""] : null);
  if (!m) {
    return "Use a range like 1:20-2:05 or 80-125 (minutes:seconds or seconds)";
  }
  const start = m[1] ? toSecs(m[1]) : 0;
  const end = m[2] ? toSecs(m[2]) : total;
  if (start === undefined || end === undefined) {
    return "Times look like 1:20 or 80 (seconds)";
  }
  if (start >= total) {
    return `Start is past the end of the recording (${Math.floor(total / 60)}:${String(Math.floor(total % 60)).padStart(2, "0")})`;
  }
  const e = Math.min(end, total);
  if (e - start < 4) {
    return "The range must cover at least 4 seconds";
  }
  return { start, end: e };
}

/** A stretch of the file, cut out and prepared: trimmed, levelled, ready to hear. */
interface Stretch {
  start: number;
  end: number;
  seconds: number;
  density: number;
  wav: string;
  asked: boolean;
}

/**
 * Cut one stretch out and prepare it exactly as it would be saved, so what
 * the user hears in the list is what the cloner would get. Returns undefined
 * when what came out is too quiet or too short to clone from.
 */
export function prepareStretch(
  full: string,
  dir: string,
  w: { start: number; end: number; density: number },
  asked = false
): Stretch | undefined {
  const wav = path.join(dir, `.import-ref-${Date.now()}-${Math.round(w.start * 100)}.wav`);
  try {
    extractWav(full, w.start, w.end, wav);
    const { seconds, rms } = trimSilence(wav);
    if (seconds < 3 || rms < 200) {
      fs.rmSync(wav, { force: true });
      return undefined;
    }
    normalizeReference(wav);
    return { start: w.start, end: w.end, seconds, density: w.density, wav, asked };
  } catch {
    fs.rmSync(wav, { force: true });
    return undefined;
  }
}

interface StretchRow extends vscode.QuickPickItem {
  stretch?: Stretch;
  action?: "range" | "part";
}

// A reference longer than this makes the cloner recite it before the text it
// was asked for; shorter than four seconds carries too little of the voice.
const RANGE_MIN = 4;
const RANGE_MAX = 20;

// How many stretches are offered, and how many are cut out looking for them.
const CANDIDATES = 8;
const CANDIDATE_TRIES = 40;

/**
 * Which stretch becomes the reference. Every candidate is prepared before the
 * list opens, so moving through it plays what would be cloned rather than a
 * description of it: the old flow played one candidate at a time behind a
 * modal offering "Use it" or "Next candidate", which could only go forwards
 * and lost everything already heard.
 */
async function chooseStretch(
  full: string,
  dir: string,
  volume: number,
  canChoosePart: boolean
): Promise<Stretch | "back" | undefined> {
  const total = wavFileSeconds(full) ?? 0;
  const prepared: Stretch[] = [];
  // referenceWindows returns one window per pause boundary, ranked, so a long
  // recording offers hundreds of them and most overlap the one above. A list
  // is only useful if its rows are different from each other, and each row
  // costs a cut file on disk, so take the best few that do not sit on top of
  // one another and stop looking after a while.
  let tried = 0;
  for (const w of referenceWindows(full)) {
    if (prepared.length >= CANDIDATES || tried >= CANDIDATE_TRIES) {
      break;
    }
    const overlapping = prepared.some(
      (p) => Math.min(p.end, w.end) - Math.max(p.start, w.start) > (w.end - w.start) / 2
    );
    if (overlapping) {
      continue;
    }
    tried++;
    const s = prepareStretch(full, dir, w);
    if (s) {
      prepared.push(s);
    }
  }
  if (prepared.length === 0) {
    vscode.window.showErrorMessage(
      canChoosePart
        ? "Claude Code TTS: no stretch of that part is loud enough or long enough to clone from. Try another part of the file."
        : "Claude Code TTS: that recording is too quiet or too short to clone from."
    );
    return canChoosePart ? "back" : undefined;
  }
  const discard = (keep?: Stretch) => {
    for (const s of prepared) {
      if (s !== keep) {
        fs.rmSync(s.wav, { force: true });
      }
    }
  };
  for (;;) {
    const rows: StretchRow[] = prepared.map((s, i) => ({
      label: `${fmt(s.start)} to ${fmt(s.end)}`,
      description: `${Math.round(s.seconds)}s, ${Math.round(s.density * 100)}% speech`,
      detail: s.asked ? "the range you asked for" : i === 0 ? "the clearest stretch found" : "",
      stretch: s,
    }));
    rows.push(
      { label: "", kind: vscode.QuickPickItemKind.Separator },
      {
        label: "Use an exact time range...",
        detail: `Any ${RANGE_MIN} to ${RANGE_MAX} seconds of this audio`,
        action: "range",
      }
    );
    if (canChoosePart) {
      rows.push({
        label: "Choose a different part of the file...",
        detail: "Back to the time range of the whole file",
        action: "part",
      });
    }
    const picked = await pickWithPreview<StretchRow>({
      items: rows,
      placeholder: `${prepared.length} candidate${prepared.length === 1 ? "" : "s"}: move through them to hear each one, Enter keeps it`,
      title: "Clone from a file: which stretch",
      back: true,
      preview: (row) => (row.stretch ? playSample(row.stretch.wav, volume) : undefined),
    });
    if (picked === "back" || (picked?.action === "part" && canChoosePart)) {
      discard();
      return canChoosePart ? "back" : undefined;
    }
    if (!picked) {
      discard();
      return undefined;
    }
    if (picked.action === "range") {
      const asked = await askExactRange(total);
      if (asked === undefined) {
        discard();
        return undefined;
      }
      if (asked !== BACK) {
        const stretch = prepareStretch(full, dir, { ...asked, density: 1 }, true);
        if (stretch) {
          prepared.unshift(stretch);
        } else {
          vscode.window.showWarningMessage(
            `Claude Code TTS: ${fmt(asked.start)} to ${fmt(asked.end)} is too quiet to clone from; the candidates below are what this recording offers.`
          );
        }
      }
      continue;
    }
    if (picked.stretch) {
      discard(picked.stretch);
      return picked.stretch;
    }
  }
}

/** An exact stretch, typed. Undefined means the flow was left, BACK the list. */
async function askExactRange(total: number): Promise<{ start: number; end: number } | typeof BACK | undefined> {
  const text = await inputWithBack({
    prompt: `Which seconds to clone from? The audio is ${fmt(total)} long. A range like 0:12-0:22 (${RANGE_MIN} to ${RANGE_MAX} seconds; about 10 is ideal).`,
    title: "Clone from a file: exact range",
    placeHolder: `0:00-${fmt(Math.min(total, 10))}`,
    validateInput: (v) => {
      const r = parseTimeRange(v, total);
      if (typeof r === "string") {
        return r;
      }
      if (!r) {
        return "Enter a range like 0:12-0:22";
      }
      return r.end - r.start > RANGE_MAX
        ? `Keep it under ${RANGE_MAX} seconds; the cloner recites a long reference`
        : undefined;
    },
  });
  if (text === undefined) {
    return undefined;
  }
  if (text === BACK) {
    return BACK;
  }
  const range = parseTimeRange(text, total);
  return range && typeof range === "object" ? range : BACK;
}

/**
 * Which part of a long file the candidates are looked for in. The answer is
 * kept when the user comes back to it, so narrowing a two-hour recording is a
 * correction rather than a retype.
 */
async function askPart(wholeSecs: number, previous: string): Promise<string | typeof BACK | undefined> {
  return inputWithBack({
    prompt: `Which part to use? The file is ${fmt(wholeSecs)} long. Enter a range like 1:20-2:05 (or leave empty for the whole file); the clearest stretches inside it are offered next.`,
    title: "Clone from a file: which part",
    placeHolder: `0:00-${fmt(wholeSecs)}`,
    value: previous,
    validateInput: (v) => {
      const r = parseTimeRange(v, wholeSecs);
      return typeof r === "string" ? r : undefined;
    },
  });
}

/**
 * Clone from a recording the user already has: the part of a long file, then
 * the stretch inside it, then the words it contains, each of which can be
 * returned to from the step after it.
 */
export async function cloneFromFileFlow(context: vscode.ExtensionContext, volume: number): Promise<string | undefined> {
  // Off macOS the decoding is ffmpeg's job; say so before a file is picked.
  if (process.platform !== "darwin" && !hasCommand("ffmpeg")) {
    await offerCommand(
      "Claude Code TTS: reading audio and video files needs ffmpeg (a 24 kHz mono WAV works without it).",
      process.platform === "win32" ? "winget install Gyan.FFmpeg" : "sudo apt install ffmpeg"
    );
    return undefined;
  }
  if (!(await ensureProfileEngine(context))) {
    return undefined;
  }
  if (!(await ensureCloneConsent(context))) {
    return undefined;
  }
  const code = await pickCloneLanguage(context.globalStorageUri.fsPath);
  if (!code) {
    return undefined;
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: "Use this file",
    filters: {
      "Audio or video": [
        "wav",
        "mp3",
        "m4a",
        "aac",
        "aiff",
        "aif",
        "flac",
        "ogg",
        "opus",
        "caf",
        "mp4",
        "mov",
        "m4v",
        "3gp",
        "webm",
        "mkv",
      ],
      Audio: ["wav", "mp3", "m4a", "aac", "aiff", "aif", "flac", "ogg", "opus", "caf"],
      Video: ["mp4", "mov", "m4v", "3gp", "webm", "mkv"],
    },
    title: "Choose a recording or video of your voice (clear speech, no music)",
  });
  const input = picked?.[0]?.fsPath;
  if (!input) {
    return undefined;
  }

  const dir = qwen3VoicesDir(context.globalStorageUri.fsPath);
  fs.mkdirSync(dir, { recursive: true });
  // The AVFoundation helper reads video containers and every audio format
  // macOS can decode; afconvert/ffmpeg remain as fallbacks.
  const extractor =
    process.platform === "darwin"
      ? await ensureSwiftHelper(context, EXTRACT_BIN, "extractaudio.swift", "the audio extractor")
      : undefined;
  const whole = path.join(dir, `.import-${Date.now()}.wav`);
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Claude Code TTS: reading the audio..." },
      () => convertToCloneWav(input, whole, { extractor })
    );
  } catch (e) {
    fs.rmSync(whole, { force: true });
    const msg = (e as Error).message;
    const hint = /no audio track|cannot read|decode/.test(msg)
      ? " If the file plays elsewhere, its codec is one macOS cannot decode; install ffmpeg (brew install ffmpeg) and try again."
      : "";
    vscode.window.showErrorMessage(`Claude Code TTS: could not read that file: ${msg}.${hint}`);
    return undefined;
  }
  const wholeSecs = wavFileSeconds(whole) ?? 0;
  if (wholeSecs < 4) {
    fs.rmSync(whole, { force: true });
    vscode.window.showErrorMessage(
      `Claude Code TTS: the recording is only ${wholeSecs.toFixed(1)}s; at least 4 seconds of speech are needed (10 is ideal).`
    );
    return undefined;
  }

  // A long file usually has one part where the voice is clean, so it is
  // narrowed first and the candidates are looked for inside it.
  const long = wholeSecs > 15;
  let step: "part" | "stretch" | "transcript" | "name" = long ? "part" : "stretch";
  let rangeText = "";
  let part = whole;
  let chosen: Stretch | undefined;
  let refText = "";
  let typedText = "";
  // Transcribing takes seconds and a stretch does not change while the user
  // walks back and forth over the last two questions.
  const transcripts = new Map<string, string>();
  const dropPart = () => {
    if (part !== whole) {
      fs.rmSync(part, { force: true });
      part = whole;
    }
  };
  const leave = (): undefined => {
    dropPart();
    fs.rmSync(whole, { force: true });
    if (chosen) {
      fs.rmSync(chosen.wav, { force: true });
    }
    return undefined;
  };

  for (;;) {
    if (step === "part") {
      const answer = await askPart(wholeSecs, rangeText);
      if (answer === undefined || answer === BACK) {
        return leave();
      }
      rangeText = answer;
      dropPart();
      const range = parseTimeRange(rangeText, wholeSecs);
      if (range && typeof range === "object") {
        part = path.join(dir, `.import-range-${Date.now()}.wav`);
        extractWav(whole, range.start, range.end, part);
      }
      step = "stretch";
      continue;
    }
    if (step === "stretch") {
      if (chosen) {
        fs.rmSync(chosen.wav, { force: true });
        chosen = undefined;
      }
      const got = await chooseStretch(part, dir, volume, long);
      if (got === "back") {
        step = "part";
        continue;
      }
      if (!got) {
        return leave();
      }
      chosen = got;
      step = "transcript";
      continue;
    }
    if (!chosen) {
      step = "stretch";
      continue;
    }
    if (step === "transcript") {
      const key = `${chosen.start}-${chosen.end}`;
      if (!transcripts.has(key)) {
        // The cloner needs the words in the reference. Whisper when
        // available, otherwise the user types them (they know what was said).
        transcripts.set(key, (await transcribeRecording(context, chosen.wav, code)) ?? "");
      }
      refText = transcripts.get(key) ?? "";
      const typed = await inputWithBack({
        prompt: refText
          ? "Transcript of the chosen stretch (correct it if a word is wrong; it must match the audio)"
          : "Type exactly what is said in the chosen stretch (needed for a clean clone)",
        title: "Clone from a file: transcript",
        value: typedText || refText,
        validateInput: (v) => (v.trim().split(/\s+/).length >= 4 ? undefined : "At least a few words"),
      });
      if (typed === undefined) {
        return leave();
      }
      if (typed === BACK) {
        typedText = "";
        step = "stretch";
        continue;
      }
      typedText = typed.trim();
      step = "name";
      continue;
    }
    const name = await inputWithBack({
      prompt: "Name this voice profile",
      title: "Clone from a file: name",
      value: path.basename(input).replace(/\.[^.]+$/, "") || "My voice",
      validateInput: (v) => (v.trim() ? undefined : "Enter a name"),
    });
    if (name === undefined) {
      return leave();
    }
    if (name === BACK) {
      step = "transcript";
      continue;
    }
    dropPart();
    fs.rmSync(whole, { force: true });
    return saveCloneProfile(dir, name, chosen.wav, {
      refText: typedText,
      transcript: typedText,
      language: code,
      // User-verified text is as good as a transcript.
      usedTranscript: true,
      textSource: refText ? "transcript" : "typed",
      source: "file",
      sourceFile: path.basename(input),
    });
  }
}
