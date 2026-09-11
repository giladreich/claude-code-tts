/**
 * The WAV players this platform has, the speed range they cover, and the
 * diagnostic log the playback pipeline writes to.
 *
 * Playback goes through the bundled Swift player on macOS (src/tts/audio.ts)
 * and through whichever of these is installed elsewhere; the rate an engine
 * cannot synthesize at is carried by the player's time-stretch where it has
 * one. Nothing here knows about engines: synthPlay.ts decides what is
 * stretched and what is baked in.
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { hasCommand } from "../platform/platform";
import { killProcess } from "./types";

export interface WavPlayer {
  cmd: string;
  /** Whether the player can time-stretch without pitch shift. */
  supportsTempo: boolean;
  args: (file: string, volume: number, tempo: number) => string[];
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The speed range, defined once. The player time-stretches without pitch
 * shift across all of it, and engines with their own speed control
 * synthesize across it too, so every rate the setting allows (70 to 450 wpm
 * around a natural pace of 175) is actually reachable instead of quietly
 * stopping at 2x.
 */
export const TEMPO_MIN = 0.4;

export const TEMPO_MAX = 3;

/**
 * Rates this close to 1 are played untouched.
 *
 * The player's time-stretch is a phase vocoder, and a phase vocoder is never
 * free: measured on a cloned voice at 1.02x, where the retiming itself is
 * inaudible (30ms in a 3s sentence), it smeared the transients and overshot
 * a full-scale utterance to 1.36 (+2.7 dB), which the output then clipped,
 * first at 0.19s in. That is the harsh, robotic edge on the first syllable.
 * A rate inside the deadband is snapped to exactly 1, which the player
 * bypasses.
 */
export const TEMPO_DEADBAND = 0.03;

/** The rate to actually play at: the deadband, then the range. */
export function playbackTempo(tempo: number): number {
  const inRange = clamp(tempo, TEMPO_MIN, TEMPO_MAX);
  return Math.abs(inRange - 1) <= TEMPO_DEADBAND ? 1 : inRange;
}

/** What an engine's own speed control accepts (Kokoro speed, Piper length scale). */
export const SYNTH_SPEED_MIN = 0.4;

export const SYNTH_SPEED_MAX = 2.6;

/** atempo accepts 0.5-2.0; a chain of two covers the rest of the range. */
function atempoChain(tempo: number): string {
  if (tempo <= 2) {
    return `atempo=${tempo.toFixed(2)}`;
  }
  const half = Math.sqrt(tempo);
  return `atempo=${half.toFixed(2)},atempo=${half.toFixed(2)}`;
}

/**
 * Find a WAV player once. macOS has afplay; elsewhere ffplay (part of
 * ffmpeg) is preferred because it is the only widely available player that
 * offers both pitch-preserving tempo and volume, which is what keeps speed
 * control identical across platforms. sox, PulseAudio/ALSA and PowerShell
 * follow as fallbacks with fewer capabilities.
 */
export function findWavPlayer(): WavPlayer | undefined {
  if (process.platform === "darwin") {
    return {
      cmd: "afplay",
      supportsTempo: true,
      args: (f, vol, tempo) => [
        ...(tempo !== 1 ? ["-q", "1", "-r", tempo.toFixed(2)] : []),
        ...(vol < 100 ? ["-v", (vol / 100).toFixed(2)] : []),
        f,
      ],
    };
  }
  if (hasCommand("ffplay")) {
    return {
      cmd: "ffplay",
      supportsTempo: true,
      args: (f, vol, tempo) => {
        const filters = [
          // ffmpeg's atempo takes 0.5-2.0 per instance, so beyond that it is chained.
          ...(tempo !== 1 ? [atempoChain(clamp(tempo, TEMPO_MIN, TEMPO_MAX))] : []),
          ...(vol < 100 ? [`volume=${(vol / 100).toFixed(2)}`] : []),
        ];
        return ["-nodisp", "-autoexit", "-loglevel", "quiet", ...(filters.length ? ["-af", filters.join(",")] : []), f];
      },
    };
  }
  if (process.platform === "win32") {
    return {
      cmd: "powershell",
      supportsTempo: false,
      // prettier-ignore
      args: (f) => [
        "-NoProfile", "-NonInteractive",
        "-Command", `(New-Object Media.SoundPlayer '${f.replace(/'/g, "''")}').PlaySync()`,
      ],
    };
  }
  const has = hasCommand;
  if (has("play")) {
    // sox: "tempo" time-stretches without pitch shift, "vol" scales level
    return {
      cmd: "play",
      supportsTempo: true,
      args: (f, vol, tempo) => [
        "-q",
        f,
        ...(tempo !== 1 ? ["tempo", tempo.toFixed(2)] : []),
        ...(vol < 100 ? ["vol", (vol / 100).toFixed(2)] : []),
      ],
    };
  }
  if (has("paplay")) {
    // PulseAudio volume is 0-65536 (linear).
    return {
      cmd: "paplay",
      supportsTempo: false,
      args: (f, vol) => [...(vol < 100 ? [`--volume=${Math.round((vol / 100) * 65536)}`] : []), f],
    };
  }
  if (has("aplay")) {
    return { cmd: "aplay", supportsTempo: false, args: (f) => ["-q", f] };
  }
  return undefined;
}

/**
 * Remove synthesized WAVs orphaned by a crashed session (normal operation
 * unlinks each file right after playback). Call once at activation.
 */
export function cleanupStaleTempFiles(): void {
  const dir = os.tmpdir();
  fs.readdir(dir, (err, files) => {
    if (err) {
      return;
    }
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const f of files) {
      if (!f.startsWith("claude-code-tts-") || !f.endsWith(".wav")) {
        continue;
      }
      const full = path.join(dir, f);
      fs.stat(full, (e, st) => {
        if (!e && st.mtimeMs < cutoff) {
          fs.unlink(full, () => {});
        }
      });
    }
  });
}

/** Diagnostic sink for pipeline decisions (set by the extension to its log). */
let logRtf: (msg: string) => void = () => {};

export function setPipelineLogger(fn: (msg: string) => void): void {
  logRtf = fn;
}

/** Engines report lifecycle decisions (model unloaded, reloaded) to the same log. */
export function pipelineLog(msg: string): void {
  logRtf(msg);
}

/** What playback on this machine can do, for "Check Setup". */
export function audioSupport(): { player: string; tempo: boolean } {
  const p = findWavPlayer();
  return { player: p?.cmd ?? "none", tempo: p?.supportsTempo ?? false };
}

/**
 * Play one WAV outside the speech queue (voice auditions in the cloning and
 * design flows). Uses the platform's player, so it works wherever the
 * extension does; the persistent player is reserved for the queue.
 */
export function playWavFile(file: string, volumePercent: number): { stop: () => void; playing: boolean } {
  const p = findWavPlayer();
  if (!p) {
    logRtf("no audio player found: install ffmpeg (ffplay), sox or pulseaudio-utils to hear auditions");
    return { stop: () => {}, playing: false };
  }
  const proc = spawn(p.cmd, p.args(file, volumePercent, 1), { stdio: "ignore", windowsHide: true });
  proc.on("error", () => {});
  return { stop: () => killProcess(proc), playing: true };
}
