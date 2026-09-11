/**
 * Reading the settings, and the handful of decisions that follow directly
 * from them.
 *
 * The settings object the pipeline runs on is assembled here and nowhere
 * else, so every flow reads the same values through the same cache; a flow
 * still reads and writes single keys of its own. The defaults written here
 * are checked against the schema by a contract test, which scans this file
 * and extension.ts together. Nothing here shows anything to the user: it
 * answers what the settings say.
 */
import * as path from "path";
import * as vscode from "vscode";
import { kokoroDaemonScriptOf, kokoroDirOf } from "../setup/kokoroSetup";
import { runtime } from "./runtime";
import { SpeechConfig } from "../speech/speech";
import { NotifyConfig } from "../setup/notifySetup";
import { qwen3VoicesDir } from "../tts/qwen3";
import { SpeedMemory } from "../tts/types";
import { rateFor, withVoiceRate } from "../speech/voiceRates";

/**
 * How fast each engine synthesizes on this machine, kept across sessions.
 * The pipeline learns it within a sentence or two, but every window used to
 * start over from the typical figure, which on a slower machine meant the
 * first sentences were planned too optimistically and underran. Written only
 * when the number moves by a few percent, since it settles quickly.
 */
function speedMemory(): SpeedMemory {
  const key = (k: string) => `claudeCodeTts.rtf.${k}`;
  return {
    get: (k) => {
      const v = runtime.context.globalState.get<number>(key(k));
      return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
    },
    set: (k, rtf) => {
      const known = runtime.context.globalState.get<number>(key(k));
      if (known !== undefined && Math.abs(known - rtf) / known < 0.03) {
        return;
      }
      void runtime.context.globalState.update(key(k), Math.round(rtf * 100) / 100);
    },
  };
}

/** Default delivery instruction for Qwen3 presets (see the qwen3.style setting). */
export const DEFAULT_QWEN3_STYLE =
  "Speak in a calm, natural, steady narration voice, articulating each word clearly, with natural pauses between sentences.";

export const SETTING_KEYS = [
  "enabled",
  "engine",
  "rate",
  "volume",
  "speakText",
  "speakTools",
  "speakErrors",
  "listenTo",
  "speakSubagents",
  "ignoredTools",
  "collapseToolSeconds",
  "interruptOnNew",
  "onlyWhenUnfocused",
  "substitutions",
  "autoLanguage",
  "speakLanguage",
  "languageVoices",
  "keepInSourceLanguage",
  "notifications.enabled",
  "notifications.sounds",
  "notifications.toolFilter",
  "notifications.volume",
  "voice",
  "piper.path",
  "piper.voice",
  "kokoro.voice",
  "qwen3.voice",
  "qwen3.model",
  "qwen3.style",
  "qwen3.runtime",
  "chatterbox.voice",
  "chatterbox.runtime",
  "dynamicRate",
  "pauseScale",
  "idleUnloadMinutes",
  "voiceRates",
  "export.keepMinutes",
];

/**
 * The settings, read once per synchronous burst of work.
 *
 * Reading them means about fifty lookups through the VSCode configuration
 * service, and one transcript line used to do that five to eight times: once
 * in the tailer callback, again in the translation check, again per utterance
 * in speakLine. The cache is cleared on the next microtask, so it can never
 * outlive the burst that filled it and no `await c.update(...)` can be
 * followed by a stale read.
 */
let cachedConfig: ReturnType<typeof readConfig> | undefined;

export function config(): ReturnType<typeof readConfig> {
  if (!cachedConfig) {
    cachedConfig = readConfig();
    queueMicrotask(() => (cachedConfig = undefined));
  }
  return cachedConfig;
}

export function readConfig() {
  const c = vscode.workspace.getConfiguration("claudeCodeTts");
  return {
    enabled: c.get<boolean>("enabled", true),
    speakText: c.get<boolean>("speakText", true),
    speakTools: c.get<boolean>("speakTools", true),
    speakErrors: c.get<boolean>("speakErrors", true),
    speakSubagents: c.get<boolean>("speakSubagents", false),
    ignoredTools: c.get<string[]>("ignoredTools", []),
    collapseToolSeconds: c.get<number>("collapseToolSeconds", 90),
    interruptOnNew: c.get<boolean>("interruptOnNew", false),
    onlyWhenUnfocused: c.get<boolean>("onlyWhenUnfocused", false),
    substitutions: c.get<Record<string, string>>("substitutions", {}),
    listenTo: c.get<string>("listenTo", "everywhere"),
    /** Minutes of spoken audio kept on disk for "Export Spoken Audio to a File"; 0 keeps nothing. */
    exportKeepMinutes: c.get<number>("export.keepMinutes", 30),
    notifications: {
      enabled: c.get<boolean>("notifications.enabled", true),
      volume: c.get<number>("notifications.volume", 70),
      sounds: soundsOf(c.get<Record<string, string>>("notifications.sounds", DEFAULT_SOUNDS)),
      toolFilter: c.get<string[]>("notifications.toolFilter", ["Bash"]),
    },
    speechConfig: {
      engine: c.get<SpeechConfig["engine"]>("engine", "system"),
      voice: voiceOf(c, c.get<string>("engine", "system")),
      rate: voiceRate(c),
      maxRate: catchUpCeiling(voiceRate(c)),
      dynamicRate: c.get<boolean>("dynamicRate", true),
      volume: c.get<number>("volume", 100),
      maxUtteranceChars: TUNING.maxUtteranceChars,
      piperPath: c.get<string>("piper.path", "piper"),
      kokoroDir: kokoroDirOf(runtime.context),
      kokoroDaemonScript: kokoroDaemonScriptOf(runtime.context),
      qwen3Model: c.get<string>("qwen3.model", "0.6B"),
      qwen3Language: TUNING.qwen3Language,
      qwen3Style: c.get<string>("qwen3.style", DEFAULT_QWEN3_STYLE),
      pauseScale: c.get<number>("pauseScale", 1),
      qwen3Runtime: c.get<string>("qwen3.runtime", "auto"),
      speedMemory: runtime.context ? speedMemory() : undefined,
      autoLanguage: c.get<boolean>("autoLanguage", true),
      speakLanguage: c.get<string>("speakLanguage", ""),
      languageVoices: c.get<Record<string, string>>("languageVoices", {}),
      qwen3DaemonScript: path.join(runtime.context.extensionPath, "assets", "qwen3_daemon.py"),
      qwen3VoicesDir: qwen3VoicesDir(runtime.context.globalStorageUri.fsPath),
      chatterboxVoice: c.get<string>("chatterbox.voice", "default"),
      chatterboxRuntime: c.get<string>("chatterbox.runtime", "auto"),
      idleUnloadMinutes: c.get<number>("idleUnloadMinutes", 45),
      chatterboxVocoderSteps: TUNING.chatterboxVocoderSteps,
      chatterboxStreaming: TUNING.chatterboxStreaming,
      chatterboxQuantizeBits: TUNING.chatterboxQuantizeBits,
      chatterboxStorage: runtime.context.globalStorageUri.fsPath,
      chatterboxDaemonScript: path.join(runtime.context.extensionPath, "assets", "chatterbox_daemon.py"),
    } as SpeechConfig,
  };
}

/** Rate bounds, matching the setting and what the pipeline can deliver. */
export const RATE_MIN = 70;

export const RATE_MAX = 450;

/**
 * Settings that used to be settings.
 *
 * Each of these was an engineering constant that had leaked into the user
 * interface: a listener should not be asked how many Euler steps the vocoder
 * spends, and every one of them shipped at the value measured to be right.
 * They stay here, with the measurement that chose them, so the reasoning is
 * not lost and a future change has a number to argue with.
 */
export const TUNING = {
  /** Vocoder steps for Chatterbox: 4 measured identical to 10 in error rate and speaker similarity, and 23% faster. */
  chatterboxVocoderSteps: 4,
  /** Stream the first words of the chunk about to play: 2.5 s to first audio instead of 5.7 s. */
  chatterboxStreaming: true,
  /** 8-bit token model: 3 to 4 times faster generation, 1.5 GB less memory, CER 0.058 to 0.073. */
  chatterboxQuantizeBits: 8,
  /** Longest single utterance; longer text is chunked long before this. */
  maxUtteranceChars: 1500,
  /** Language hint for Qwen3 when detection cannot decide and the voice has no language of its own. */
  qwen3Language: "English",
} as const;

/**
 * The ceiling dynamic catch-up may reach, derived from the rate the user
 * asked for rather than set separately. Two independent numbers could be
 * ordered wrongly (a maxRate below rate silently disabled catch-up), and the
 * second one was never a decision anybody wanted to make.
 */
export function catchUpCeiling(rate: number): number {
  return Math.min(RATE_MAX, Math.max(Math.round(rate * 1.35), rate + 60));
}

/**
 * The rate the voice in use should speak at. Rates are remembered per voice
 * (see src/speech/voiceRates.ts), because a pace that suits one voice is wrong for
 * the next; `rate` is the default for voices nobody has tuned.
 */
export function voiceRate(c: vscode.WorkspaceConfiguration): number {
  const engine = c.get<string>("engine", "system");
  return rateFor(
    c.get<number>("rate", 210),
    c.get<Record<string, number>>("voiceRates", {}),
    engine,
    voiceOf(c, engine)
  );
}

/** The voice setting that belongs to an engine. One place, so they cannot drift. */
export function voiceOf(c: vscode.WorkspaceConfiguration, engine: string): string {
  return (
    {
      system: c.get<string>("voice", ""),
      piper: c.get<string>("piper.voice", ""),
      kokoro: c.get<string>("kokoro.voice", "af_heart"),
      qwen3: c.get<string>("qwen3.voice", "Ryan"),
      chatterbox: c.get<string>("chatterbox.voice", "default"),
    }[engine] ?? ""
  );
}

/** Record a rate for the voice in use, leaving every other voice alone. */
export async function saveVoiceRate(rate: number): Promise<void> {
  const c = vscode.workspace.getConfiguration("claudeCodeTts");
  const { engine, voice } = config().speechConfig;
  await c.update(
    "voiceRates",
    withVoiceRate(c.get<Record<string, number>>("voiceRates", {}), engine, voice, rate, c.get<number>("rate", 210)),
    vscode.ConfigurationTarget.Global
  );
}

/** Events that sound out of the box; anything absent is silent. */
export const DEFAULT_SOUNDS: Record<string, string> = {
  done: "Glass",
  permission: "Funk",
  question: "Ping",
  waiting: "Purr",
};

/**
 * The settings object as the hook script wants it. The setting says "done"
 * because that is the event a person recognises; the hook that carries it is
 * Claude Code's "Stop".
 */
export function soundsOf(s: Record<string, string>): NotifyConfig["sounds"] {
  const at = (k: string) => s[k] ?? "";
  return {
    stop: at("done"),
    permission: at("permission"),
    question: at("question"),
    waiting: at("waiting"),
    tool: at("tool"),
    subagent: at("subagent"),
    prompt: at("prompt"),
  };
}

/**
 * Prose chunk sizes per engine. Neural engines ramp small-to-large for fast
 * first audio with good prosody; the sizes per engine, and the measurements
 * behind them, are in the body.
 */
export function chunkPlanFor(engine: SpeechConfig["engine"], qwen3Model = "0.6B"): number | number[] {
  if (engine === "system") {
    return 260;
  }
  // Qwen3 renders a whole chunk as one sequence, so prosody carries across
  // its sentences: after a small first chunk (fast start), chunks are large
  // for the most natural reading; streaming keeps the latency unchanged.
  // The 1.7B model runs at about realtime, so each chunk must be partly
  // buffered before it plays: smaller chunks keep that wait short.
  if (engine === "qwen3") {
    return qwen3Model === "1.7B" ? [110, 260, 420] : [110, 380, 750];
  }
  // Chatterbox has no streaming: a chunk stays silent until the whole thing
  // is generated, so the first chunk sets the time to the first word, and a
  // long chunk blocks everything queued behind it (a generation cannot be
  // aborted). Fitted over 95 real generations from the daemon log:
  //
  //     generation seconds = 1.50 fixed + 1.25 x seconds of speech
  //
  // so a 300-character chunk is about 19s of speech and costs 25s
  // before a word is heard, and the next chunk then waits behind it: waits of
  // 34s were logged. Capping a chunk near 10s of speech keeps the worst gap
  // around 4s. The opener is short so the first word arrives in about 5s;
  // trimming it further buys little against the 1.5s fixed cost and makes the
  // opening sound clipped.
  //
  // The gap a listener hears is (generation of the next chunk) minus (playback
  // of this one), so it grows with chunk length: from the log, a 13.5s chunk
  // took 23.9s to generate while only 6.5s was playing, which is a 17s silence.
  // Around 6s of speech per chunk the same arithmetic gives about 3s. Shorter
  // chunks spend more of the 1.5s fixed cost in total (about 9s more over a
  // minute of speech) and buy evenly spread short gaps instead of one long
  // one, which is what sounds like speech rather than buffering.
  //
  // That arithmetic assumed generation slower than speech. With the token
  // model quantised the whole-chunk path measured 0.6-0.7x realtime, so a
  // chunk generated ahead is ready before its turn and its length no longer
  // sets a gap; and the first chunk of a message streams, so its length no
  // longer sets the wait for the first word either. Chunks can therefore be
  // longer again, which spends less of the fixed cost and reads better
  // across sentences. The top is still bounded: a whole-chunk generation
  // cannot be aborted, so it is what a skip or stop has to wait for.
  if (engine === "chatterbox") {
    return [45, 130, 180];
  }
  return [150, 350, 600];
}
