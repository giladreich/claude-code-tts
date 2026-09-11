import { ChildProcess } from "child_process";

/**
 * How fast an engine synthesizes on this machine, remembered across
 * sessions. Keyed by engine and model. Without it every window starts from
 * the typical figure, which on a slower machine plans the first sentences
 * too optimistically and underruns until the real number is learned.
 */
export interface SpeedMemory {
  get(key: string): number | undefined;
  set(key: string, rtf: number): void;
}

export interface SpeechConfig {
  /** "system" = OS engine; the rest are local neural TTS. */
  engine: "system" | "piper" | "kokoro" | "qwen3" | "chatterbox";
  /** Measured synthesis speeds, per engine and model; optional in tests. */
  speedMemory?: SpeedMemory;
  /**
   * System: voice name. Piper: absolute path to a .onnx voice model.
   * Kokoro: speaker name (e.g. "af_sarah"). Qwen3: preset speaker or
   * "clone:<slug>". Chatterbox: "clone:<slug>" or "default".
   */
  voice: string;
  /** Base rate, words per minute. */
  rate: number;
  /** Ceiling for dynamic catch-up, words per minute. */
  maxRate: number;
  /** Speed up when the queue falls behind Claude. */
  dynamicRate: boolean;
  /** 0-100. */
  volume: number;
  maxUtteranceChars: number;
  /** Piper executable (name on PATH or absolute path). */
  piperPath: string;
  /** Directory holding the Kokoro runtime + model (extension storage). */
  kokoroDir: string;
  /** Path to the bundled kokoro_daemon.py (fast warm-synthesis path). */
  kokoroDaemonScript: string;
  /** Qwen3-TTS model size ("0.6B" | "1.7B"). */
  qwen3Model: string;
  /** "auto" | "mlx" | "torch": inference runtime (MLX is far faster on Apple Silicon). */
  qwen3Runtime: string;
  /** Detect the language of each message and speak it with a matching voice. */
  autoLanguage: boolean;
  /**
   * Language code -> the voice to speak it with. A voice belongs to one
   * engine, so the entry may name it: {"he": {"engine": "piper", "voice":
   * "/path/voice.onnx"}}. A bare string means the engine
   * that was active when it was set, and is resolved on load.
   */
  languageVoices: Record<string, string | LanguageVoice>;
  /** Speak everything in this language, translating locally when needed ("" = off). */
  speakLanguage: string;
  /** Language name Qwen3 synthesizes in ("English") when none was detected. */
  qwen3Language: string;
  /** Delivery instruction for Qwen3 preset speakers ("" = model default). */
  qwen3Style: string;
  /** How long the pauses between sentences are; 1 = a natural reading pace. */
  pauseScale: number;
  /** Path to the bundled qwen3_daemon.py. */
  qwen3DaemonScript: string;
  /** Directory holding cloned Qwen3 voice profiles (extension storage). */
  qwen3VoicesDir: string;
  /** Chatterbox: voice ("clone:<slug>" or "default") and its storage root. */
  chatterboxVoice: string;
  chatterboxStorage: string;
  chatterboxRuntime: string;
  /** Minutes without speech after which a heavyweight synthesis model is unloaded (0 = keep resident). */
  idleUnloadMinutes: number;
  /** Euler steps in the Chatterbox vocoder's ODE solver. Fewer is faster. */
  chatterboxVocoderSteps: number;
  /** Stream Chatterbox audio while the chunk is still being generated. */
  chatterboxStreaming: boolean;
  /** Quantise Chatterbox's token model at load (0 = leave it as shipped). */
  chatterboxQuantizeBits: number;
  chatterboxDaemonScript: string;
  /**
   * Set only by the queue when it builds a backend for a mapping with
   * `inVoice`: applied to each finished WAV before playback. Never persisted.
   */
  postSynthesis?: (wavPath: string) => Promise<void>;
}

/** A voice for one language, together with the engine that owns it. */
export interface LanguageVoice {
  engine: SpeechConfig["engine"];
  voice: string;
  /**
   * A cloned voice ("clone:<slug>") to re-voice the result into, through the
   * Chatterbox daemon. How a language no cloning engine pronounces
   * is heard in the user's own voice: Piper reads it, Chatterbox converts
   * the timbre.
   */
  inVoice?: string;
}

export interface VoiceInfo {
  name: string;
  detail?: string;
  /** Two-letter language code this voice speaks, when the OS reports it. */
  language?: string;
}

/** Everything an engine needs to voice one utterance. */
export interface SpeakRequest {
  text: string;
  wpm: number;
  voice: string;
  /** 0-100. */
  volume: number;
  /** Two-letter code of the language detected in this text, when known. */
  language?: string;
  /** An audition from a picker, not something Claude said: never kept for export. */
  preview?: boolean;
  /** The message this belongs to (see speaking.ts), so an export can offer messages. */
  group?: string;
}

/** One utterance in flight. */
export interface Speaker {
  kill(): void;
  /** Freeze audio mid-word (SIGSTOP); undefined when the engine can't. */
  freeze?(): void;
  unfreeze?(): void;
}

/**
 * A text-to-speech engine. To add one: implement this in a new file under
 * src/tts/ and register it in the ENGINES table in src/speech/speech.ts.
 */
export interface Backend {
  /**
   * How many queued chunks to start synthesising before their turn. Two is
   * enough for an engine that keeps up with speech. One that does not (a
   * whole-chunk engine at 1.75x realtime) can only close its gaps by working
   * during the pauses between messages, which needs a deeper queue.
   */
  lookahead?: number;
  name: string;
  /** Whether utterances can freeze mid-word (for pause semantics). */
  canFreeze: boolean;
  speak(req: SpeakRequest, onDone: () => void, onError: (msg: string) => void): Speaker;
  /** Resolves once the engine can synthesize (e.g. daemon model loaded). */
  readonly ready?: Promise<void>;
  /**
   * Work is in flight. A backend kept for one mapped language is released
   * when it goes unused, and this is what stops that release landing in the
   * middle of a synthesis it is still running.
   */
  readonly busy?: boolean;
  /** The playback tempo the player is at right now, when something is playing. */
  currentTempo?(): number | undefined;
  /** Retune the CURRENTLY PLAYING audio to a new wpm, where supported. */
  setLiveRate?(wpm: number): void;
  /**
   * Fastest rate this engine can actually feed on this machine. Asking for
   * more than this cannot make speech arrive sooner: it only empties the
   * buffer, which is heard as a silence followed by a sprint.
   */
  sustainableWpm?(): number;
  /** Adjust the currently playing audio's volume (0-100), where supported. */
  setLiveVolume?(volume: number): void;
  /** Optionally start preparing the next utterance while one plays. */
  prewarm?(req: SpeakRequest): void;
  /**
   * Start loading the model if it is not loaded, without synthesising
   * anything. Called when Claude begins writing, so that on an engine whose
   * cold start is measured at 16 seconds the load overlaps Claude's own
   * thinking instead of following the first sentence.
   */
  wake?(): void;
  /** Drop prepared-but-unused work (queue was flushed). */
  flush?(): void;
  /** Engine-wide silence for engines that daemonize (spd-say). */
  cancel?(): void;
  /** Re-voice `src` into the cloned voice, writing `out` (Chatterbox MLX only). */
  convertVoice?(src: string, out: string, voice: string): Promise<void>;
  dispose?(): void;
}

export function killProcess(child: ChildProcess): void {
  try {
    // A SIGSTOPped process won't act on SIGTERM until continued.
    if (process.platform !== "win32") {
      child.kill("SIGCONT");
    }
    child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
}

/** Adapt a single child process (spawn -> audio -> exit) into a Speaker. */
export function wrapProcess(
  child: ChildProcess,
  canFreeze: boolean,
  name: string,
  onDone: () => void,
  onError: (msg: string) => void
): Speaker {
  let finished = false;
  const finish = () => {
    if (!finished) {
      finished = true;
      onDone();
    }
  };
  child.on("error", (e) => {
    onError(`${name} failed: ${e.message}`);
    finish();
  });
  child.on("exit", finish);
  return {
    kill: () => killProcess(child),
    freeze: canFreeze ? () => child.kill("SIGSTOP") : undefined,
    unfreeze: canFreeze ? () => child.kill("SIGCONT") : undefined,
  };
}
