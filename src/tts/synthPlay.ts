import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getPersistentPlayer } from "./audio";
import { hasCommand } from "../platform/platform";
import { Backend, killProcess } from "./types";
import { wavFileSeconds } from "./wav";

/**
 * Shared machinery for engines that synthesize an utterance to a WAV file and
 * then play it (Piper, Kokoro, ...). Provides gapless playback by prewarming
 * queued utterances while one plays, pause/live-rate via the persistent
 * player, and temp-file cleanup. An engine only supplies how to build its
 * synthesis command.
 *
 * Speed model: where the player can time-stretch (macOS persistent player,
 * afplay, ffplay, sox), audio is synthesized at the engine's NATURAL pace -
 * best prosody, and one cache entry per text no matter how often the user
 * changes speed - and the user's rate is applied as pitch-preserving playback
 * tempo, computed from the LATEST rate at playback start and adjustable
 * mid-play. Only rates outside tempo range (TEMPO_MIN to TEMPO_MAX) bake the
 * excess into synthesis.
 */
export interface SynthCommand {
  cmd: string;
  /** Must write the WAV to the path given to buildSynth. */
  args: string[];
  /** Text is passed here when the tool reads stdin instead of argv. */
  stdinText?: string;
}

/** What a non-streaming engine may report about a finished synthesis. */
export interface SynthReport {
  /** Wall seconds the engine spent generating (queue wait excluded). */
  genSeconds?: number;
  audioSeconds?: number;
}

/** An in-flight synthesis produced by a custom synthesizer (e.g. a daemon). */
export interface SynthTask {
  promise: Promise<void | SynthReport>;
  cancel: () => void;
}

/** Streaming synthesis: parts arrive via onPart as they are produced. */
export interface StreamTask {
  /** Resolves after the final part has been delivered. */
  promise: Promise<void>;
  cancel: () => void;
}

interface Synthesis {
  promise: Promise<string>; // resolves to wav path
  cancel: () => void;
  /** Speed baked into the synthesized audio itself (vs natural pace). */
  synthSpeed: number;
}

interface WavPlayer {
  cmd: string;
  /** Whether the player can time-stretch without pitch shift. */
  supportsTempo: boolean;
  args: (file: string, volume: number, tempo: number) => string[];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

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
function findWavPlayer(): WavPlayer | undefined {
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

export function synthesizeThenPlayBackend(params: {
  name: string;
  /** The engine's pace at its neutral speed setting, words per minute. */
  naturalWpm?: number;
  /**
   * The engine has a real speed knob (Kokoro, Piper): the requested rate is
   * synthesized natively, which sounds far better than time-stretching, and
   * playback tempo only carries live adjustments. Engines without one
   * (Qwen3) are synthesized at natural pace and time-stretched.
   */
  nativeSpeed?: boolean;
  /** Typical synthesis speed as a fraction of realtime (0.7 = 1s of audio per 0.7s). */
  typicalRtf?: number;
  /** What was measured last time on this machine, so the first sentence is planned right. */
  rememberedRtf?: number;
  /** Called as the measurement settles, for remembering it. */
  onRtf?: (rtf: number) => void;
  /** CLI fallback; engines that only have a daemon may omit it. */
  buildSynth?: (text: string, wpm: number, voice: string, wavPath: string) => SynthCommand;
  /**
   * Applied to the finished WAV before it is played or cached, in place.
   * Used to re-voice a Piper utterance into a cloned voice through the
   * Chatterbox daemon; a failure here fails the utterance like any other.
   */
  postProcess?: (wavPath: string, voice: string, language?: string) => Promise<void>;
  /**
   * Optional faster path (e.g. a warm daemon). Returning undefined falls
   * back to spawning buildSynth's command for that utterance.
   */
  synthesize?: (
    text: string,
    wpm: number,
    voice: string,
    wavPath: string,
    urgent: boolean,
    language?: string
  ) => SynthTask | undefined;
  /**
   * Optional streaming path: emit audio parts progressively via onPart so
   * playback starts before the whole utterance is synthesized. Used only
   * for utterances that were not prewarmed and when the gapless persistent
   * player is available.
   */
  synthesizeStream?: (
    text: string,
    wpm: number,
    voice: string,
    wavPathBase: string,
    onPart: (file: string, final: boolean) => void,
    /** The user is waiting on this now (vs. look-ahead prewarm). */
    urgent: boolean,
    /** Language detected in this text, when known. */
    language?: string
  ) => StreamTask | undefined;
  /** How many utterances ahead the queue prepares for this engine. */
  lookahead?: number;
}): Backend {
  const prewarmed = new Map<string, Synthesis>();
  /**
   * Room for everything the queue is asked to prepare, plus one.
   *
   * This was a fixed 3 while Chatterbox asked for 6 ahead, so preparing the
   * sixth chunk evicted and cancelled the first: the queue paid for work on
   * the chunk it was about to play and then threw it away, every time.
   */
  const maxPrepared = Math.max(3, (params.lookahead ?? 2) + 1);
  /**
   * Synthesis speed actually observed on this machine (wall seconds per
   * second of audio), learned from streamed parts. The declared typicalRtf
   * is a floor; a loaded machine or a bigger model is slower, and playback
   * planned on the optimistic number underruns at every part boundary.
   */
  let observedRtf: number | undefined = params.rememberedRtf;
  const effectiveRtf = () => Math.max(params.typicalRtf ?? 0.3, observedRtf ?? 0) * 1.1;
  const learn = (rtf: number) => {
    observedRtf = observedRtf === undefined ? rtf : observedRtf * 0.6 + rtf * 0.4;
    params.onRtf?.(observedRtf);
  };
  /**
   * Playing faster than the engine synthesizes drains the buffer, so the
   * next utterance has to wait for a bigger prebuffer, which grows the
   * backlog, which raises the catch-up rate again: silence, sprint, repeat.
   * Playback is therefore never asked to run faster than production, and
   * the queue is told the same ceiling so catch-up stops chasing it.
   */
  const sustainableTempo = () => 1 / effectiveRtf();
  const player = findWavPlayer();
  const naturalWpm = params.naturalWpm ?? 175;
  const tempoCapable = player?.supportsTempo ?? false;
  /** synthSpeed of the playback currently on the persistent player. */
  let liveSynthSpeed: number | undefined;
  /**
   * How to retune the playback in progress, when it is a stream still being
   * synthesized. A stream can be played no faster than the engine feeds it,
   * so a rate change while one is playing goes through here and is held to
   * the same ceiling the stream started under; retuning the player directly
   * outran the buffer and was heard as a stutter, then as the easing loop
   * winding the speed back down.
   */
  let retuneStream: ((wpm: number) => void) | undefined;
  /** The tempo the player was last told, so a test can hold it to the ceiling. */
  let playerTempo: number | undefined;
  const setPlayerRate = (tempo: number): void => {
    playerTempo = tempo;
    getPersistentPlayer()?.setRate(tempo);
  };
  /** Latest requested rate; playback tempo always derives from this. */
  let lastWpm = naturalWpm;

  const wantedOf = (wpm: number) => wpm / naturalWpm;
  const splitSynthSpeed = (wanted: number): number => {
    // Native speed: quantize so small catch-up steps share a cache entry.
    if (!tempoCapable || params.nativeSpeed) {
      return clamp(Math.round(wanted * 20) / 20, SYNTH_SPEED_MIN, SYNTH_SPEED_MAX);
    }
    // Time-stretched engines: only what the player cannot cover is baked in.
    if (wanted < TEMPO_MIN) {
      return clamp(wanted / TEMPO_MIN, SYNTH_SPEED_MIN, 1);
    }
    if (wanted > TEMPO_MAX) {
      return clamp(wanted / TEMPO_MAX, 1, SYNTH_SPEED_MAX);
    }
    return 1; // natural synthesis; tempo carries the whole rate
  };
  /** A prepared entry for the same text/voice at another synth speed still
   *  serves (tempo corrects the difference) - better than re-synthesizing. */
  const findByText = <T>(
    map: Map<string, T>,
    text: string,
    voice: string,
    language?: string
  ): [string, T] | undefined => {
    // Must mirror key(): everything after the synth speed.
    const suffix = `|${voice}|${language ?? ""}|${text}`;
    for (const [k, v] of map) {
      if (k.endsWith(suffix)) {
        return [k, v];
      }
    }
    return undefined;
  };
  // Language is part of the identity: the same text in the same voice is a
  // DIFFERENT rendering per language, so leaving it out let a chunk prepared
  // without a language hint be replayed for one that had it.
  const key = (text: string, voice: string, synthSpeed: number, language?: string) =>
    `${synthSpeed.toFixed(2)}|${voice}|${language ?? ""}|${text}`;

  function synth(text: string, voice: string, synthSpeed: number, urgent: boolean, language?: string): Synthesis {
    const wav = path.join(os.tmpdir(), `claude-code-tts-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
    const synthWpm = Math.round(naturalWpm * synthSpeed);

    const post = (p: Promise<string>): Promise<string> =>
      params.postProcess ? p.then(async (w) => (await params.postProcess!(w, voice, language), w)) : p;
    const task = params.synthesize?.(text, synthWpm, voice, wav, urgent, language);
    if (task) {
      const promise = post(
        task.promise.then((report) => {
          // A non-streaming engine never emits parts, so this report is the
          // only way the pipeline learns how fast it really is on this
          // machine (memory pressure alone was measured to double it).
          if (report && report.genSeconds && report.audioSeconds && report.audioSeconds > 0.5) {
            learn(report.genSeconds / report.audioSeconds);
          }
          return wav;
        })
      );
      promise.catch(() => {});
      return { promise, cancel: task.cancel, synthSpeed };
    }

    if (!params.buildSynth) {
      const promise = Promise.reject<string>(new Error("engine daemon unavailable and no CLI fallback exists"));
      promise.catch(() => {});
      return { promise, cancel: () => {}, synthSpeed };
    }
    const { cmd, args, stdinText } = params.buildSynth(text, synthWpm, voice, wav);
    // stderr is kept (last few hundred characters): "exited with 1" alone
    // told nobody that Piper had thrown on an unpronounceable input.
    const proc = spawn(cmd, args, {
      stdio: [stdinText !== undefined ? "pipe" : "ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    proc.stderr?.on("data", (d) => (stderr = (stderr + String(d)).slice(-400)));
    if (stdinText !== undefined) {
      proc.stdin?.end(stdinText);
    }
    const promise = post(
      new Promise<string>((res, rej) => {
        proc.on("error", rej);
        proc.on("exit", (code) => {
          if (code === 0) {
            return res(wav);
          }
          const reason = stderr.trim().split("\n").filter(Boolean).pop() ?? "";
          rej(new Error(`${params.name} exited with ${code}${reason ? `: ${reason.slice(0, 200)}` : ""}`));
        });
      })
    );
    promise.catch(() => {}); // avoid unhandled rejection when nobody awaits yet
    return {
      promise,
      cancel: () => {
        try {
          proc.kill("SIGKILL");
        } catch {}
      },
      synthSpeed,
    };
  }

  /**
   * A streaming synthesis in progress (or complete): parts accumulate as the
   * engine produces them. Created by prewarm() ahead of time or by speak()
   * on demand; speak() attaches to it and feeds the persistent player.
   */
  interface StreamSession {
    parts: { file: string; final: boolean }[];
    /** Parts the daemon has written so far; `parts` is drained by playback. */
    emitted: number;
    finished: boolean; // all parts delivered (or failed)
    error?: Error;
    listener?: (file: string, final: boolean) => void;
    onFinished?: () => void;
    cancel: () => void;
  }
  const streamSessions = new Map<string, StreamSession>();

  function startStream(
    text: string,
    voice: string,
    synthSpeed: number,
    urgent: boolean,
    language?: string
  ): StreamSession | undefined {
    const base = path.join(os.tmpdir(), `claude-code-tts-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const session: StreamSession = { parts: [], emitted: 0, finished: false, cancel: () => {} };
    let tFirst = 0;
    let audioSinceFirst = 0;
    const task = params.synthesizeStream!(
      text,
      Math.round(naturalWpm * synthSpeed),
      voice,
      base,
      (file, final) => {
        // Measure production speed from the first part on (before it, the
        // request may have been queued behind other work in the daemon).
        const secs = wavFileSeconds(file) ?? 0;
        if (tFirst === 0) {
          tFirst = Date.now();
        } else {
          audioSinceFirst += secs;
        }
        // Updated as parts arrive, not only at the end: a chunk that starts
        // slowly must not let the next one plan with the old, rosier number.
        if (audioSinceFirst > 1.0) {
          learn((Date.now() - tFirst) / 1000 / audioSinceFirst);
        }
        session.parts.push({ file, final });
        session.emitted++;
        session.listener?.(file, final);
      },
      urgent,
      language
    );
    if (!task) {
      return undefined;
    }
    const removeAllParts = () => {
      for (const p of session.parts) {
        fs.unlink(p.file, () => {});
      }
      const seen = session.emitted;
      session.parts = [];
      // The daemon checks for a cancel between tokens, so it can still be
      // finishing the part it was on. Those are named by index, so a few
      // targeted unlinks cover it. Listing the directory instead meant
      // reading the whole shared temp directory on every skip or stop, and
      // the extension's own stale-file sweep at activation is the backstop
      // for anything a crash leaves behind.
      for (let i = seen; i < seen + 3; i++) {
        fs.unlink(`${base}.p${i}.wav`, () => {});
      }
    };
    session.cancel = () => {
      task.cancel();
      removeAllParts();
    };
    task.promise.then(
      () => {
        // Non-streaming daemons answer with the whole file and no parts.
        const whole = `${base}.wav`;
        if (session.parts.length === 0 && fs.existsSync(whole)) {
          session.parts.push({ file: whole, final: true });
          session.listener?.(whole, true);
        } else if (session.parts.length === 0) {
          session.error = new Error(`${params.name} produced no audio`);
        }
        session.finished = true;
        session.onFinished?.();
      },
      (e: Error) => {
        session.error = e;
        session.finished = true;
        session.onFinished?.();
      }
    );
    return session;
  }

  /** Feed a stream session into the persistent player as one gapless stream. */
  function speakStreaming(
    session: StreamSession,
    synthSpeed: number,
    volume: number,
    onDone: () => void,
    onError: (msg: string) => void,
    textLength: number
  ) {
    const persistent = getPersistentPlayer()!;
    let killed = false;
    let frozen = false;
    let pb: ReturnType<typeof persistent.play> | undefined;
    let sawFinal = false;
    const cleanup = () => {
      for (const p of session.parts) {
        fs.unlink(p.file, () => {});
      }
      session.parts = [];
    };
    const finish = () => {
      liveSynthSpeed = undefined;
      retuneStream = undefined;
      playerTempo = undefined;
      cleanup();
      if (!killed) {
        onDone();
      }
    };
    // Never faster than the engine can produce, and never slower than the
    // engine's natural pace (slow-motion speech is not an improvement).
    const ceiling = () => clamp(Math.max(1, sustainableTempo()), TEMPO_MIN, TEMPO_MAX);
    const requested = clamp(wantedOf(lastWpm) / synthSpeed, TEMPO_MIN, TEMPO_MAX);
    const tempo = playbackTempo(Math.min(requested, ceiling()));
    if (tempo < requested - 0.02) {
      logRtf(
        `playing at ${tempo.toFixed(2)}x instead of ${requested.toFixed(2)}x: the engine synthesizes at ${(1 / effectiveRtf()).toFixed(2)}x realtime`
      );
    }
    // Prebuffer: playback must not outrun synthesis or every part boundary
    // becomes a stutter. Audio is consumed at `tempo` seconds of audio per
    // wall second and produced at 1/rtf; over an utterance of L audio
    // seconds the shortfall is L * (tempo * rtf - 1), which must be in the
    // buffer before playback starts. Fast engines start at once.
    const rtf = effectiveRtf();
    const audioSecs = ((textLength / 5.5 / naturalWpm) * 60) / synthSpeed; // ~5.5 chars per word
    const deficit = Math.max(0, audioSecs * (tempo * rtf - 1)) * 1.1;
    // Waiting is only worth it up to a point. Within this bound, buffering
    // buys continuous speech; beyond it the wait itself becomes the problem
    // (and prewarming the next chunk hides most of it anyway).
    const MAX_PREBUFFER_SECONDS = 2;
    const prebufferSecs = Math.min(audioSecs, MAX_PREBUFFER_SECONDS, (rtf > 0.5 ? 0.4 : 0.1) + deficit);
    if (deficit > 0.5) {
      logRtf(
        `prebuffering ${prebufferSecs.toFixed(1)}s (synthesis ${rtf.toFixed(2)}x realtime, tempo ${tempo.toFixed(2)}, sustainable ${sustainableTempo().toFixed(2)})`
      );
    }
    let buffered = 0;
    /** Audio handed to the player, and when playback started, so the buffer
     *  lead can be computed: fed - consumed. */
    let fedSecs = 0;
    let playStartedAt = 0;
    let liveTempo = 0;
    const queued: { file: string; final: boolean }[] = [];
    const start = () => {
      for (const q of queued) {
        push(q.file, q.final);
      }
      queued.length = 0;
    };
    /**
     * Playback consumes `tempo` seconds of audio per second. When the lead
     * shrinks toward zero the player is about to run dry, which is heard as
     * a stutter at every part boundary; easing the tempo back to what the
     * engine actually produces keeps the voice continuous instead.
     */
    const keepAhead = (final: boolean) => {
      if (final || !pb || playStartedAt === 0) {
        return;
      }
      const lead = fedSecs - ((Date.now() - playStartedAt) / 1000) * liveTempo;
      if (lead < 0.35 && liveTempo > 0.82) {
        // Down to 0.8x if it must: speech that flows a little slowly is far
        // easier to follow than speech that stops at every part boundary.
        liveTempo = Math.max(0.8, liveTempo * 0.85);
        setPlayerRate(liveTempo);
        logRtf(`buffer down to ${lead.toFixed(2)}s: easing playback to ${liveTempo.toFixed(2)}x to stay continuous`);
      }
    };
    const push = (file: string, final: boolean) => {
      fedSecs += wavFileSeconds(file) ?? 0;
      // All audio is here: any tempo is safe now
      if (final) {
        retuneStream = undefined;
      }
      if (!pb) {
        liveSynthSpeed = synthSpeed;
        liveTempo = tempo;
        playerTempo = tempo;
        playStartedAt = Date.now();
        // A rate change mid-stream is held to the same ceiling this stream
        // started under, and the easing loop keeps measuring against the
        // tempo actually set, so it neither starves nor undoes the change.
        retuneStream = final
          ? undefined
          : (wpm) => {
              const asked = clamp(wantedOf(wpm) / synthSpeed, TEMPO_MIN, TEMPO_MAX);
              liveTempo = Math.min(asked, ceiling());
              if (liveTempo < asked - 0.02) {
                logRtf(
                  `rate change mid-stream: ${liveTempo.toFixed(2)}x, not ${asked.toFixed(2)}x: the engine feeds no faster`
                );
              }
              setPlayerRate(liveTempo);
            };
        pb = persistent.play(file, tempo, volume / 100, final);
        pb.done.then(finish, (e: Error) => {
          if (!killed) {
            onError(`audio playback failed: ${e.message}`);
          }
          finish();
        });
        if (frozen) {
          pb.freeze();
        }
      } else {
        pb.append(file, final);
      }
      keepAhead(final);
    };
    const feed = (file: string, final: boolean) => {
      if (killed) {
        return;
      }
      if (final) {
        sawFinal = true;
      }
      if (pb) {
        return push(file, final);
      }
      queued.push({ file, final });
      buffered += wavFileSeconds(file) ?? 0;
      if (final || buffered >= prebufferSecs) {
        start();
      }
    };
    const closeOnFailure = () => {
      if (killed) {
        return;
      }
      if (session.error && !pb) {
        onError(`${params.name} synthesis failed: ${session.error.message}`);
        cleanup();
        onDone();
      } else if (session.error && !sawFinal) {
        // Play what arrived
        if (!pb) {
          start();
        }
        // Let "done" fire
        if (pb) {
          pb.append(session.parts[session.parts.length - 1].file, true);
        }
      }
    };
    // Replay parts that arrived before we attached (prewarmed), then live ones.
    for (const p of session.parts) {
      feed(p.file, p.final);
    }
    session.listener = feed;
    session.onFinished = closeOnFailure;
    if (session.finished) {
      closeOnFailure();
    }

    const canFreeze = process.platform !== "win32";
    return {
      kill() {
        killed = true;
        session.cancel();
        pb?.cancel();
        cleanup();
      },
      freeze: canFreeze
        ? () => {
            frozen = true;
            pb?.freeze();
          }
        : undefined,
      unfreeze: canFreeze
        ? () => {
            frozen = false;
            pb?.unfreeze();
          }
        : undefined,
    };
  }

  return {
    name: params.name,
    canFreeze: process.platform !== "win32",
    speak({ text, wpm, voice, volume, language }, onDone, onError) {
      let killed = false;
      let frozen = false;
      lastWpm = wpm;
      /** Unified handle over persistent-player and spawned-player playback. */
      let playing: { cancel(): void; freeze(): void; unfreeze(): void } | undefined;
      /** WAV that finished synthesizing while frozen; played on unfreeze. */
      let heldWav: string | undefined;
      const synthSpeed = splitSynthSpeed(wantedOf(wpm));
      const k = key(text, voice, synthSpeed, language);
      const streaming = params.synthesizeStream && tempoCapable && getPersistentPlayer();
      if (streaming) {
        let session = streamSessions.get(k);
        let sessionSpeed = synthSpeed;
        if (session) {
          streamSessions.delete(k);
        } else {
          const other = findByText(streamSessions, text, voice, language);
          if (other) {
            streamSessions.delete(other[0]);
            session = other[1];
            sessionSpeed = parseFloat(other[0]);
          } else if (!prewarmed.has(k) && !findByText(prewarmed, text, voice, language)) {
            // Nothing prepared for it: stream, so the first word is not made
            // to wait for the whole chunk. A whole file prepared ahead of time
            // is played as it is rather than synthesised a second time.
            session = startStream(text, voice, synthSpeed, true, language);
          }
        }
        if (session) {
          return speakStreaming(session, sessionSpeed, volume, onDone, onError, text.length);
        }
      }
      let pre = prewarmed.get(k);
      if (pre) {
        prewarmed.delete(k);
      } else {
        const other = findByText(prewarmed, text, voice, language);
        if (other) {
          prewarmed.delete(other[0]);
          pre = other[1];
        }
      }
      const s = pre ?? synth(text, voice, synthSpeed, true, language);

      const startPlayback = (wav: string) => {
        const finish = () => {
          liveSynthSpeed = undefined;
          fs.unlink(wav, () => {});
          if (!killed) {
            onDone();
          }
        };
        // Tempo reflects the rate as of NOW, not as of synthesis time.
        const tempo = tempoCapable ? playbackTempo(wantedOf(lastWpm) / s.synthSpeed) : 1;
        const persistent = getPersistentPlayer();
        if (persistent) {
          liveSynthSpeed = s.synthSpeed;
          const pb = persistent.play(wav, tempo, volume / 100);
          playing = pb;
          pb.done.then(finish, (e: Error) => {
            if (!killed) {
              onError(`audio playback failed: ${e.message}`);
            }
            finish();
          });
          return;
        }
        const proc = spawn(player!.cmd, player!.args(wav, volume, tempo), { stdio: "ignore", windowsHide: true });
        playing = {
          cancel: () => killProcess(proc),
          freeze: () => proc.kill("SIGSTOP"),
          unfreeze: () => proc.kill("SIGCONT"),
        };
        proc.on("error", (e) => {
          onError(`audio playback failed: ${e.message}`);
          finish();
        });
        proc.on("exit", finish);
      };

      s.promise
        .then((wav) => {
          const canPlay = player !== undefined || getPersistentPlayer() !== undefined;
          if (killed || !canPlay) {
            fs.unlink(wav, () => {});
            if (!killed && !canPlay) {
              onError("no WAV player found (aplay/paplay/play)");
            }
            if (!killed) {
              onDone();
            }
            return;
          }
          if (frozen) {
            // Paused while still synthesizing: hold the audio for unfreeze
            // instead of playing into the pause.
            heldWav = wav;
            return;
          }
          startPlayback(wav);
        })
        .catch((e: Error) => {
          if (!killed) {
            onError(`${params.name} synthesis failed: ${e.message} (voice: ${voice || "none configured"})`);
            onDone();
          }
        });

      const canFreeze = process.platform !== "win32";
      return {
        kill() {
          killed = true;
          s.cancel();
          if (heldWav) {
            fs.unlink(heldWav, () => {});
          }
          heldWav = undefined;
          playing?.cancel();
        },
        freeze: canFreeze
          ? () => {
              frozen = true;
              playing?.freeze();
            }
          : undefined,
        unfreeze: canFreeze
          ? () => {
              frozen = false;
              if (playing) {
                playing.unfreeze();
              } else if (heldWav && !killed) {
                const wav = heldWav;
                heldWav = undefined;
                startPlayback(wav);
              }
            }
          : undefined,
      };
    },
    setLiveRate(wpm) {
      lastWpm = wpm;
      if (liveSynthSpeed === undefined) {
        return;
      }
      if (retuneStream) {
        return retuneStream(wpm);
      }
      // No sustainability cap here. This is only ever reached from an explicit
      // rate change, and the queue has already limited that wpm to what the
      // engine sustains while honouring the rate the user chose. Capping again
      // at 1.0 (which is what max(1, sustainableTempo()) collapses to for an
      // engine slower than realtime) made pressing speed-up audibly SLOW the
      // sentence down, and disagreed with the uncapped tempo used at the start
      // of playback for the very same utterance.
      const requested = wantedOf(wpm) / liveSynthSpeed;
      setPlayerRate(playbackTempo(requested));
    },
    currentTempo() {
      return playerTempo;
    },
    sustainableWpm() {
      // Streamed playback is floored at natural pace and capped at what the
      // engine feeds, so this is the rate that will be heard, not a raw ratio.
      return naturalWpm * Math.max(1, sustainableTempo());
    },
    setLiveVolume(volume) {
      getPersistentPlayer()?.setVolume(clamp(volume / 100, 0, 1));
    },
    prewarm({ text, wpm, voice, language }) {
      const synthSpeed = splitSynthSpeed(wantedOf(wpm));
      const k = key(text, voice, synthSpeed, language);
      if (params.synthesizeStream && tempoCapable && getPersistentPlayer()) {
        if (streamSessions.has(k)) {
          return;
        }
        if (streamSessions.size >= 2) {
          const [oldKey, old] = streamSessions.entries().next().value!;
          streamSessions.delete(oldKey);
          old.cancel();
        }
        const session = startStream(text, voice, synthSpeed, false, language);
        if (session) {
          streamSessions.set(k, session);
          return;
        }
        // The engine declined to stream this one (Chatterbox streams only the
        // chunk about to play: generating ahead is faster whole). Prepare it
        // whole below rather than not at all.
      }
      if (prewarmed.has(k)) {
        return;
      }
      // Evict the oldest when full: stale entries (voice changed, chunk was
      // merged) must not permanently block prewarming.
      if (prewarmed.size >= maxPrepared) {
        const [oldestKey, oldest] = prewarmed.entries().next().value!;
        prewarmed.delete(oldestKey);
        oldest.cancel();
        oldest.promise.then((wav) => fs.unlink(wav, () => {})).catch(() => {});
      }
      prewarmed.set(k, synth(text, voice, synthSpeed, false, language));
    },
    flush() {
      for (const session of streamSessions.values()) {
        session.cancel();
      }
      streamSessions.clear();
      for (const s of prewarmed.values()) {
        s.cancel();
        s.promise.then((wav) => fs.unlink(wav, () => {})).catch(() => {});
      }
      prewarmed.clear();
    },
    dispose() {
      this.flush?.();
    },
  };
}
