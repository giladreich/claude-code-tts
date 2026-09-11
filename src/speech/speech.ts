import * as fs from "fs";
import { chatterboxBackend } from "../tts/chatterbox";
import { kokoroBackend } from "../tts/kokoro";
import { piperBackend } from "../tts/piper";
import { qwen3Backend } from "../tts/qwen3";
import { systemBackend } from "../tts/system";
import { detectLanguage, engineSpeaks, LanguageTracker } from "../language/language";
import { Backend, LanguageVoice, SpeakRequest, Speaker, SpeechConfig } from "../tts/types";

export { SpeechConfig } from "../tts/types";

/** Short announcements arriving close together merge into one utterance up to this length. */
const COALESCE_MAX = 280;

/** Engine registry: add a backend file under src/tts/ and one row here. */
const ENGINES: Record<
  SpeechConfig["engine"],
  (config: SpeechConfig, onError: (msg: string) => void) => Backend | undefined
> = {
  system: (_config, onError) => systemBackend(onError),
  piper: (config, onError) => piperBackend(config.piperPath, onError, config.postSynthesis),
  kokoro: (config, onError) =>
    kokoroBackend(config.kokoroDir, config.kokoroDaemonScript, () => config.pauseScale, onError),
  chatterbox: (config, onError) =>
    chatterboxBackend(
      {
        globalStoragePath: config.chatterboxStorage,
        daemonScript: config.chatterboxDaemonScript,
        voice: config.voice,
        voicesDir: config.qwen3VoicesDir,
        speedMemory: config.speedMemory,
        runtime: config.chatterboxRuntime,
        get idleUnloadMinutes() {
          return config.idleUnloadMinutes;
        },
        vocoderSteps: config.chatterboxVocoderSteps,
        streaming: config.chatterboxStreaming,
        quantizeBits: config.chatterboxQuantizeBits,
      },
      onError
    ),
  qwen3: (config, onError) =>
    qwen3Backend(
      {
        modelSize: config.qwen3Model,
        daemonScript: config.qwen3DaemonScript,
        // Live: the daemon decides which checkpoint to load when it starts,
        // and the voice may have changed since this engine was built.
        get voice() {
          return config.voice;
        },
        voicesDir: config.qwen3VoicesDir,
        runtime: config.qwen3Runtime,
        speedMemory: config.speedMemory,
        // Read when a sentence is synthesized, not when the engine is built:
        // these travel with each request, so changing one must not cost a
        // model reload (up to 27 s and 3 GB) to hear the difference.
        get language() {
          return config.qwen3Language;
        },
        get style() {
          return config.qwen3Style;
        },
        get pauseScale() {
          return config.pauseScale;
        },
        get idleUnloadMinutes() {
          return config.idleUnloadMinutes;
        },
      },
      onError
    ),
};

/** Backlog at which speech reaches maxRate: either chars queued... */
const CATCH_UP_FULL_AT_CHARS = 1500;
/** ...or utterances queued, whichever ratio is larger. */
const CATCH_UP_FULL_AT_ITEMS = 5;
/**
 * No catch-up below this backlog. Two sentences waiting is what any answer
 * looks like while it is being read, and speeding up for it made the pace
 * jump between sentences: the log of one session read 1.00, 1.20, 1.00,
 * 1.15, 1.20, 1.10, 1.00, 1.10, and the ones above 1.03 went through the
 * time-stretch and sounded machine-made next to the ones that did not.
 */
const CATCH_UP_START_AT_CHARS = 600;

const CATCH_UP_START_AT_ITEMS = 3;

/**
 * How far the rate may move between one utterance and the next, as a share
 * of the base rate, in either direction. The ear forgives a pace that drifts
 * and notices one that lurches.
 */
const RATE_STEP = 0.04;

/** A queued utterance and the message it came from. */
interface QueueItem {
  text: string;
  /** The message (turn) it belongs to, so what was played can be exported per message. */
  group?: number;
}

/**
 * Sequential text-to-speech queue. One utterance at a time; when the queue
 * falls behind (Claude produced more than is spoken), the rate ramps from
 * `rate` toward `maxRate` proportionally to the backlog.
 */
export class SpeechQueue {
  private queue: QueueItem[] = [];
  private current: Speaker | undefined;
  /** The catch-up rate last spoken at, so the next one moves from it rather than jumping. */
  private lastEffectiveRate: number | undefined;
  /** Text of the utterance in `current`, so a preview can put it back. */
  private currentText = "";
  private currentGroup: number | undefined;
  private previewSpeaker: Speaker | undefined;
  private previewActive = false;
  private previewDone: (() => void) | undefined;
  private paused = false;
  private backend: Backend | undefined;
  private config: SpeechConfig;

  constructor(
    config: SpeechConfig,
    private onError: (msg: string) => void,
    private onStateChange?: (speaking: boolean) => void,
    /** Tests inject a fake engine here; production uses the registry. */
    private factory: (config: SpeechConfig, onError: (msg: string) => void) => Backend | undefined = (c, e) =>
      ENGINES[c.engine](c, e),
    /** Told once per language when the engine cannot pronounce it. */
    private onLanguageUnsupported?: (language: string) => void,
    /** Told once per language when a mapping sends it to another engine than the active one. */
    private onRouted?: (language: string, engine: SpeechConfig["engine"], voice: string, inVoice?: string) => void
  ) {
    // The engines keep a reference to this object, so per-request settings
    // (delivery style, pause scale, idle unload) can change without a model
    // reload; setConfig updates it in place for the same reason.
    this.config = { ...config };
    this.backend = this.factory(this.config, onError);
  }

  get hasEngine(): boolean {
    return this.backend !== undefined;
  }

  get engineName(): string {
    return this.backend?.name ?? "none";
  }

  /** Resolves when the active engine can synthesize; rejects if it failed. */
  get ready(): Promise<void> {
    return this.backend?.ready ?? Promise.resolve();
  }

  /** Claude has started writing: get the model loading before the first sentence arrives. */
  wake(): void {
    this.backend?.wake?.();
  }

  /**
   * Throw the engine away and build it again, keeping the settings.
   *
   * Needed when something the engine loaded has changed on disk rather than
   * in the settings: a voice profile's loudness, pace or re-recorded
   * reference, or model files that the storage cleanup removed. Callers used
   * to force this by setting a fake value into qwen3Style and immediately
   * setting it back, which worked only for as long as that setting counted
   * as an engine change; it does not any more.
   */
  rebuild(): void {
    this.disposeSecondaries();
    this.backend?.dispose?.();
    this.backend = this.factory(this.config, this.onError);
    this.restartCurrent();
  }

  setConfig(config: SpeechConfig): void {
    // A copy, because the config object itself is updated in place below: the
    // engines hold a reference to it so that a per-request setting takes
    // effect on the next sentence rather than on a rebuilt daemon.
    const prev = { ...this.config };
    // Qwen3 presets and clones live in different checkpoints, so crossing
    // that line needs a daemon restart. Clone to clone does not: the
    // reference travels with each request.
    const qwen3VoiceModeChanged =
      config.engine === "qwen3" && config.voice.startsWith("clone:") !== prev.voice.startsWith("clone:");
    const engineChanged =
      config.engine !== prev.engine ||
      config.piperPath !== prev.piperPath ||
      config.kokoroDir !== prev.kokoroDir ||
      config.qwen3Model !== prev.qwen3Model ||
      config.qwen3Runtime !== prev.qwen3Runtime ||
      config.chatterboxRuntime !== prev.chatterboxRuntime ||
      config.chatterboxVocoderSteps !== prev.chatterboxVocoderSteps ||
      config.chatterboxStreaming !== prev.chatterboxStreaming ||
      config.chatterboxQuantizeBits !== prev.chatterboxQuantizeBits ||
      qwen3VoiceModeChanged;
    const voiceChanged = config.voice !== prev.voice;
    Object.assign(this.config, config);
    if (engineChanged) {
      this.reportedLanguages.clear(); // a different engine speaks different languages
      this.routedNoticed.clear();
      this.disposeSecondaries();
      this.backend?.dispose?.();
      this.backend = this.factory(this.config, this.onError);
      // Whatever was being spoken belongs to the old engine: speak it again
      // on the new one (it starts as soon as the new model is ready) instead
      // of losing the sentence or letting the old voice finish it.
      this.restartCurrent();
      return;
    }
    if (voiceChanged) {
      // Switching voice takes effect on the spot: the sentence being spoken
      // restarts in the new voice, and work prepared for the old one is
      // dropped rather than played later.
      this.backend?.flush?.();
      this.restartCurrent();
    }
    // Interactivity: a rate/volume change retunes what is playing RIGHT NOW
    // (where the engine supports it), not just the next chunk.
    if (config.rate !== prev.rate) {
      this.backend?.setLiveRate?.(this.effectiveRate());
    }
    if (config.volume !== prev.volume) {
      this.backend?.setLiveVolume?.(config.volume);
    }
  }

  get pending(): number {
    return this.queue.length + (this.current ? 1 : 0);
  }

  /** The rate the next utterance would use, for status display. */
  currentRate(): number {
    return this.effectiveRate();
  }

  /**
   * The rate that will actually be heard. It differs from `currentRate()`
   * only when the engine cannot synthesize that fast: speaking faster than
   * the engine produces would stall, so the pipeline holds it here. Shown in
   * the status bar so a rate that cannot be met is visible rather than
   * silently ignored.
   */
  audibleRate(): number {
    const wanted = this.effectiveRate();
    const ceiling = this.backend?.sustainableWpm?.();
    return ceiling === undefined ? wanted : Math.round(Math.min(wanted, ceiling));
  }

  /**
   * Set while an explicit rate change is being honoured: catching up must not
   * argue with somebody who has just told the extension how fast to speak.
   * Cleared when the backlog it applied to has been spoken.
   */
  private rateChosen = false;

  /**
   * Apply a rate immediately, before the settings round trip. Pressing the
   * speed shortcut should be heard at once, not after the configuration
   * change has been written and read back.
   */
  applyRateNow(rate: number): void {
    // Whatever the backlog says, this is the rate that was asked for: hearing
    // the change is the whole point of pressing the key.
    this.rateChosen = true;
    // In place: the engines hold a reference to this object so that a
    // per-request setting reaches the next sentence. Replacing it would
    // leave them reading the values as they were at this moment, for good.
    this.config.rate = rate;
    this.backend?.setLiveRate?.(this.effectiveRate());
  }

  /** Language of the message being spoken, kept across short utterances. */
  private languages = new LanguageTracker();

  enqueue(text: string, group?: number): void {
    // Last line of defence for every path into the queue (translation,
    // selection, tests): an utterance with nothing to pronounce is dropped
    // rather than handed to an engine that crashes on it.
    if (!/[\p{L}\p{N}]/u.test(text)) {
      return;
    }
    const max = this.config.maxUtteranceChars;
    if (max > 0 && text.length > max) {
      text = text.slice(0, max) + " . Message truncated.";
    }
    // Coalesce small backlogged utterances (bursts of tool announcements):
    // one synthesis + one playback instead of paying per-utterance overhead.
    const last = this.queue[this.queue.length - 1];
    if (last !== undefined && last.text.length + text.length + 2 <= COALESCE_MAX) {
      const sep = /[.!?]$/.test(last.text.trimEnd()) ? " " : ". ";
      last.text = last.text + sep + text; // the merged utterance keeps the first one's message
    } else {
      this.queue.push({ text, group });
    }
    this.pump();
    // A chunk arriving WHILE something plays must start synthesizing now,
    // not when its turn comes - otherwise its synthesis time is heard as
    // silence between chunks.
    if (this.current) {
      this.prewarmAhead();
      // Catch-up is applied at chunk boundaries only: retuning a sentence
      // while it is being spoken is exactly the "voice changes mid-sentence"
      // effect users hear as unnatural. An explicit rate change (setConfig)
      // still applies live, because the user asked for it right now.
    }
  }

  /** Kill the current utterance only; the queue continues with the next one. */
  skip(): void {
    if (this.current) {
      this.killCurrent();
    }
  }

  /** Kill the current utterance and drop everything queued. */
  stop(): void {
    this.queue = [];
    this.paused = false;
    if (this.current) {
      this.killCurrent();
    }
    this.backend?.flush?.();
    for (const b of this.secondary.values()) {
      b?.flush?.();
    }
    this.stopPreview();
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /**
   * Hold speech in place: the backlog is kept and, where the engine allows,
   * the current utterance freezes mid-word via SIGSTOP. Engines that can't
   * freeze finish the current sentence and hold.
   */
  pause(): void {
    if (this.paused) {
      return;
    }
    this.paused = true;
    this.current?.freeze?.();
  }

  /** Continue exactly where pause() left off. */
  resume(): void {
    if (!this.paused) {
      return;
    }
    this.paused = false;
    if (this.current) {
      this.current.unfreeze?.();
    } else {
      this.pump();
    }
  }

  /**
   * Speak a sample with a specific voice (and optionally rate) immediately,
   * outside the queue. The queue pauses (current utterance is cut) and
   * resumes when the preview ends or stopPreview() is called. Repeated
   * calls interrupt the previous preview, so arrowing through a picker
   * list stays snappy.
   */
  preview(
    text: string,
    voice: string,
    rate?: number,
    onDone?: () => void,
    engine?: SpeechConfig["engine"],
    inVoice?: string
  ): void {
    // A voice owned by another engine (a Piper model auditioned while
    // Chatterbox is active) has to be spoken by that engine, or the main one
    // is handed a voice it cannot resolve. An audition of a re-voiced mapping
    // is re-voiced too, so it sounds like what will be heard.
    const backend = (engine ? this.backendFor(engine, inVoice) : undefined) ?? this.backend;
    if (!backend) {
      onDone?.();
      return;
    }
    this.previewActive = true;
    if (this.previewSpeaker) {
      this.previewSpeaker.kill();
      this.previewSpeaker = undefined;
      this.previewDone?.(); // superseded: release the old caller's spinner
    }
    this.previewDone = onDone;
    if (this.current) {
      // The interrupted utterance goes back to the front of the queue so
      // nothing Claude said is lost to an audition.
      const interrupted = this.currentText;
      const group = this.currentGroup;
      this.killCurrent(); // killCurrent pumps, but previewActive gates it
      if (interrupted) {
        this.queue.unshift({ text: interrupted, group });
      }
    }

    const req: SpeakRequest = {
      text,
      wpm: rate ?? this.config.rate,
      voice,
      volume: this.config.volume,
      preview: true,
    };
    const speaker: Speaker = backend.speak(
      req,
      () => {
        // Superseded by a newer preview
        if (this.previewSpeaker !== speaker) {
          return;
        }
        this.previewSpeaker = undefined;
        this.previewActive = false;
        this.previewDone?.();
        this.previewDone = undefined;
        this.pump();
        this.onStateChange?.(this.current !== undefined);
      },
      (msg) => this.onError(`preview: ${msg}`)
    );
    this.previewSpeaker = speaker;
    this.onStateChange?.(true);
  }

  /** End any preview and let the main queue continue. */
  stopPreview(): void {
    if (!this.previewActive && !this.previewSpeaker) {
      return;
    }
    const speaker = this.previewSpeaker;
    this.previewSpeaker = undefined;
    this.previewActive = false;
    this.previewDone?.();
    this.previewDone = undefined;
    speaker?.kill();
    this.backend?.cancel?.();
    this.pump();
    this.onStateChange?.(this.current !== undefined);
  }

  dispose(): void {
    this.stop();
    this.disposeSecondaries();
    this.backend?.dispose?.();
  }

  /**
   * Kill the utterance in progress and put its text back at the front of the
   * queue, then continue. Used when the voice or engine changes mid-sentence:
   * the chunk is spoken again from its start in the new voice.
   */
  private restartCurrent(): void {
    if (!this.current) {
      this.pump();
      return;
    }
    const text = this.currentText;
    const group = this.currentGroup;
    const speaker = this.current;
    this.current = undefined; // cleared first so its onDone becomes a no-op
    this.currentText = "";
    this.currentGroup = undefined;
    speaker.kill();
    this.backend?.cancel?.();
    if (text) {
      this.queue.unshift({ text, group });
    }
    this.pump();
    this.onStateChange?.(this.current !== undefined);
  }

  private killCurrent(): void {
    const speaker = this.current;
    this.current = undefined; // cleared first so its onDone becomes a no-op
    this.currentText = "";
    speaker?.kill();
    this.backend?.cancel?.();
    // The killed speaker's onDone won't pump (identity check), so continue
    // the queue here; pump() is gated by previewActive/paused as needed.
    this.pump();
    this.onStateChange?.(this.current !== undefined);
  }

  /** Report once per language that this engine cannot pronounce it. */
  private reportedLanguages = new Set<string>();
  private routedNoticed = new Set<string>();

  private checkLanguageSupport(language: string): void {
    if (this.reportedLanguages.has(language)) {
      return;
    }
    // A voice mapped by the user is their decision; do not second-guess it.
    if (this.config.languageVoices?.[language]) {
      return;
    }
    if (engineSpeaks(this.config.engine, language)) {
      return;
    }
    this.reportedLanguages.add(language);
    this.onLanguageUnsupported?.(language);
  }

  /**
   * The voice to speak a language in, and the engine that owns it: the one
   * the user mapped for it, else the configured voice. A German sentence
   * spoken by an English voice is hard to follow, so the mapping is what
   * makes a multilingual session usable; without an entry nothing changes.
   * A voice belongs to exactly one engine (a Piper model file means nothing
   * to Qwen3), so a mapping made for another engine is spoken by a second
   * backend rather than handed to the wrong one, which used to fail with
   * "this voice needs a model switch".
   */
  private voiceFor(language: string | undefined): LanguageVoice {
    const fallback: LanguageVoice = { voice: this.config.voice, engine: this.config.engine };
    if (!language || !this.config.autoLanguage) {
      return fallback;
    }
    const mapped = this.config.languageVoices?.[language];
    if (!mapped) {
      return fallback;
    }
    const entry: LanguageVoice = typeof mapped === "string" ? { engine: this.config.engine, voice: mapped } : mapped;
    return entry.voice ? entry : fallback;
  }

  /**
   * The backend for an engine other than the configured one, built on first
   * use and kept for the session. A second Qwen3 would mean loading its
   * gigabytes twice for the same languages the main one speaks, so a Qwen3
   * voice mapped while another engine is active stays with the main backend.
   * Chatterbox is as heavy, but it is allowed: a language mapped to it in
   * your own voice is one no other engine here can speak, so the cost of a
   * second model is the price of honouring the mapping at all.
   */
  private secondary = new Map<string, Backend | undefined>();
  private convertWarned = false;
  /** When each secondary engine last spoke, so an unused one can be released. */
  private secondaryUsed = new Map<string, number>();
  private secondarySweep: NodeJS.Timeout | undefined;

  /**
   * Drop secondary engines nothing has used for a while.
   *
   * A language mapped to another engine builds a second backend, and it used
   * to live until the engine changed or the window closed: two Python daemons
   * with a model each, gigabytes resident, for one sentence an hour
   * ago. The active engine is never swept, and disposing a secondary costs
   * only the reload if that language comes back.
   */
  private sweepSecondaries(): void {
    const idleMs = Math.max(0, this.config.idleUnloadMinutes ?? 0) * 60_000;
    if (idleMs === 0) {
      return;
    }
    const now = Date.now();
    for (const [key, backend] of this.secondary) {
      if (now - (this.secondaryUsed.get(key) ?? now) < idleMs) {
        continue;
      }
      // Busy means a synthesis is in flight (a re-voicing conversion, for
      // instance, which runs long after the language that needed it was
      // last routed): disposing it there would fail that utterance.
      if (backend?.busy) {
        this.secondaryUsed.set(key, now);
        continue;
      }
      backend?.dispose?.();
      this.secondary.delete(key);
      this.secondaryUsed.delete(key);
    }
    if (this.secondary.size === 0 && this.secondarySweep) {
      clearInterval(this.secondarySweep);
      this.secondarySweep = undefined;
    }
  }

  private backendFor(engine: SpeechConfig["engine"], inVoice?: string): Backend | undefined {
    if (!inVoice && (engine === this.config.engine || engine === "qwen3")) {
      return this.backend;
    }
    const key = `${engine}|${inVoice ?? ""}`;
    this.secondaryUsed.set(key, Date.now());
    if (!this.secondary.has(key)) {
      let postSynthesis: SpeechConfig["postSynthesis"];
      if (inVoice) {
        // Re-voicing needs the Chatterbox MLX daemon: the active one when
        // Chatterbox is the engine, otherwise a secondary. Without it the
        // mapped voice is spoken as it is, and the user is told once.
        const converter = this.config.engine === "chatterbox" ? this.backend : this.backendFor("chatterbox");
        if (converter?.convertVoice) {
          const convert = converter.convertVoice.bind(converter);
          postSynthesis = async (wav) => {
            const out = `${wav}.voiced.wav`;
            await convert(wav, out, inVoice);
            fs.renameSync(out, wav);
          };
        } else if (!this.convertWarned) {
          this.convertWarned = true;
          this.onError(
            "speaking in your own voice needs the Chatterbox MLX runtime; the mapped voice is used as it is"
          );
        }
      }
      // Object.create, not a spread: reads of anything not overridden here
      // fall through to the live config, so a per-request setting reaches a
      // mapped language too.
      const secondaryConfig: SpeechConfig = Object.create(this.config);
      secondaryConfig.engine = engine;
      secondaryConfig.postSynthesis = postSynthesis;
      this.secondary.set(key, this.factory(secondaryConfig, this.onError));
      // Checked once a minute; the engine itself is the judge of how long it
      // may stay resident (idleUnloadMinutes).
      this.secondarySweep ??= setInterval(() => this.sweepSecondaries(), 60_000);
      this.secondarySweep.unref?.();
    }
    return this.secondary.get(key) ?? this.backend;
  }

  private disposeSecondaries(): void {
    for (const b of this.secondary.values()) {
      b?.dispose?.();
    }
    this.secondary.clear();
    this.secondaryUsed.clear();
    if (this.secondarySweep) {
      clearInterval(this.secondarySweep);
    }
    this.secondarySweep = undefined;
  }

  private effectiveRate(): number {
    const { rate, maxRate, dynamicRate } = this.config;
    // An explicit choice outranks catch-up until the backlog it was made for
    // has drained: otherwise pressing "faster" during a long answer changes a
    // number nobody hears, and the speed appears to revert on its own.
    if (this.rateChosen || !dynamicRate || maxRate <= rate) {
      return rate;
    }
    const backlogChars = this.queue.reduce((n, t) => n + t.text.length, 0);
    const ramp = (have: number, start: number, full: number) => Math.max(0, have - start) / (full - start);
    const factor = Math.min(
      1,
      Math.max(
        ramp(backlogChars, CATCH_UP_START_AT_CHARS, CATCH_UP_FULL_AT_CHARS),
        ramp(this.queue.length, CATCH_UP_START_AT_ITEMS, CATCH_UP_FULL_AT_ITEMS)
      )
    );
    const wanted = rate + (maxRate - rate) * factor;
    // Catching up is pointless past what the engine can synthesize: asking
    // for more only buys silence before each chunk and a sprint after it.
    // The user's own base rate is always honoured.
    const ceiling = this.backend?.sustainableWpm?.() ?? Infinity;
    return Math.round(Math.min(wanted, Math.max(rate, ceiling)));
  }

  /**
   * The rate the next utterance is spoken at: one step from the last one
   * towards what the backlog asks for, up or down. Stepping happens here
   * and not in effectiveRate(), which the status bar and tests read freely.
   */
  private steppedRate(): number {
    const target = this.effectiveRate();
    // An explicit choice is heard at once: the ramp is for catch-up alone.
    if (this.rateChosen || !this.config.dynamicRate) {
      this.lastEffectiveRate = undefined;
      return target;
    }
    if (this.lastEffectiveRate === undefined) {
      this.lastEffectiveRate = target === this.config.rate ? target : this.config.rate;
    }
    const step = this.config.rate * RATE_STEP;
    const next = Math.round(Math.min(this.lastEffectiveRate + step, Math.max(this.lastEffectiveRate - step, target)));
    this.lastEffectiveRate = next;
    return next;
  }

  private pump(): void {
    if (this.current || this.previewActive || this.paused || !this.backend) {
      return;
    }
    const item = this.queue.shift();
    if (item === undefined) {
      // Nothing left to catch up on: a later burst may speed up again.
      this.rateChosen = false;
      this.lastEffectiveRate = undefined;
      return;
    }
    const text = item.text;

    // Rate reflects what is still waiting behind this utterance.
    const language = this.config.autoLanguage ? this.languages.update(text) : undefined;
    if (language) {
      this.checkLanguageSupport(language);
    }
    const chosen = this.voiceFor(language);
    const backend = this.backendFor(chosen.engine, chosen.inVoice) ?? this.backend;
    if (
      language &&
      (chosen.engine !== this.config.engine || chosen.inVoice) &&
      backend !== this.backend &&
      !this.routedNoticed.has(language)
    ) {
      // The user picked one voice and hears another: say which, and why, once.
      this.routedNoticed.add(language);
      this.onRouted?.(language, chosen.engine, chosen.voice, chosen.inVoice);
    }
    const req: SpeakRequest = {
      text,
      wpm: this.steppedRate(),
      voice: chosen.engine === this.config.engine || backend !== this.backend ? chosen.voice : this.config.voice,
      volume: this.config.volume,
      language,
      group: item.group,
    };
    const speaker: Speaker = backend.speak(
      req,
      () => {
        // Killed/superseded
        if (this.current !== speaker) {
          return;
        }
        this.current = undefined;
        this.currentText = "";
        this.currentGroup = undefined;
        this.pump();
        this.onStateChange?.(this.current !== undefined);
      },
      this.onError
    );
    this.current = speaker;
    this.currentText = text;
    this.currentGroup = item.group;
    this.onStateChange?.(true);

    // Engines with synthesis latency start on the next chunks right away.
    this.prewarmAhead();
  }

  /**
   * The backend, voice and language a queued chunk WILL be spoken with,
   * decided exactly as pump() decides, without moving the language tracker
   * (detectLanguage is pure, .language is a getter). Preparing a chunk on the
   * current chunk's engine or language was wrong whenever they differed.
   */
  private planFor(text: string): { backend: Backend | undefined; voice: string; language: string | undefined } {
    const language = this.config.autoLanguage ? (detectLanguage(text) ?? this.languages.language) : undefined;
    const chosen = this.voiceFor(language);
    const backend = this.backendFor(chosen.engine, chosen.inVoice) ?? this.backend;
    const voice = chosen.engine === this.config.engine || backend !== this.backend ? chosen.voice : this.config.voice;
    return { backend, voice, language };
  }

  /**
   * Start synthesis of the chunks after this one, so their latency is not
   * heard. How many is the backend's call: an engine slower than speech never
   * catches up within a message, and its only chance to get ahead is the
   * quiet between messages, which it can only use if the work is queued.
   */
  private prewarmAhead(): void {
    const ahead = this.queue.slice(0, Math.max(1, this.backend?.lookahead ?? 2));
    ahead.forEach((next, i) => {
      // The last queued item is still being appended to: short announcements
      // coalesce into it, and every intermediate version would start a new
      // synthesis. On an engine that cannot abort a running generation each
      // one costs seconds, so the tail waits until it can no longer grow.
      // queue[0] is always prepared: it plays next.
      if (i > 0 && i === this.queue.length - 1 && next.text.length + 3 <= COALESCE_MAX) {
        return;
      }
      const plan = this.planFor(next.text);
      plan.backend?.prewarm?.({
        text: next.text,
        wpm: this.effectiveRate(),
        voice: plan.voice,
        volume: this.config.volume,
        language: plan.language,
      });
    });
  }
}
