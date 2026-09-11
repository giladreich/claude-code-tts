/**
 * Chatterbox Multilingual (Resemble AI, MIT): clones a voice from a short
 * reference and speaks 23 languages, a dozen of which no other engine here
 * covers. It is the only permissively licensed local option for a cloned
 * voice in those languages, and it uses the same voice profiles as Qwen3:
 * a voice recorded or designed once speaks through either engine.
 *
 * Two runtimes, and which one runs matters for both speed and quality:
 *
 *   - MLX (Apple Silicon, preferred): the mlx-audio tool the Qwen3 engine
 *     already installs, running the v3 checkpoint. Measured 1.45x realtime
 *     (median over 20 sustained generations), about 1.7x faster than torch,
 *     and no separate virtualenv.
 *   - torch (everywhere else): its own virtualenv inside the extension's
 *     storage, because it pins torch 2.6 and needs setuptools older than 81
 *     for its watermarker. Measured 2.4x slower than realtime, and the PyPI
 *     package can only load the older v2 weights.
 *
 * Neither runtime keeps up with realtime, so the pipeline caps the speaking
 * rate at what the engine sustains: calm, unhurried speech that stays in
 * sync rather than the rate set in the settings.
 *
 * One family of languages looked unusable here for a while (eight generations
 * on v3, both guidance settings, all mangled on transcription). The cause was
 * the text, not the model: those writing systems leave the vowels out, so the
 * model was guessing them. The daemon restores the vowel marks before it
 * generates, and the same sentences went from CER 0.294 / WER 0.683 to CER
 * 0.076 / WER 0.194 over 24 generations, which beats the dedicated Piper voice
 * for that language (0.117 / 0.299) and comes close to the system voice
 * (0.052 / 0.158), in the user's own voice rather than a stranger's. See
 * assets/diacritize.py. The other non-Latin languages were verified accurate
 * on v3 by transcribing the output.
 */

import * as fs from "fs";
import * as path from "path";
import { ENGINE_LANGUAGES, languageName } from "../language/language";
import { sitePackageExists, uvToolPython, venvPython } from "../platform/platform";
import { PyTtsDaemon } from "./pyDaemon";
import { CloneProfile, listQwen3Clones } from "./qwen3";
import { StreamTask, SynthTask, synthesizeThenPlayBackend } from "./synthPlay";
import { pipelineLog } from "./wavPlayers";
import { Backend, SpeedMemory } from "./types";

export function chatterboxVenv(globalStoragePath: string): string {
  return path.join(globalStoragePath, "chatterbox-venv");
}

/**
 * The venv Python, but only once the engine is actually installed in it.
 *
 * A `uv venv` that succeeded followed by a `pip install` that failed (no
 * network, a wheel that would not build) leaves the interpreter behind, and
 * checking only for that file reported the engine ready forever: the setup
 * flow refused to run again because it thought the work was done, and every
 * synthesis failed inside the daemon instead.
 */
export function chatterboxPython(globalStoragePath: string): string | undefined {
  const venv = chatterboxVenv(globalStoragePath);
  const python = venvPython(venv);
  return fs.existsSync(python) && sitePackageExists(venv, "chatterbox") ? python : undefined;
}

/**
 * A Python with mlx-audio runs Chatterbox natively on Apple Silicon. Only the
 * uv tool install is recognised, and only by looking on disk: the setup flow
 * installs it that way, and probing an arbitrary python3 would mean a
 * synchronous Python start on the activation path. Not memoised: the lookup
 * is a handful of existsSync calls, and a memo went stale whenever the Qwen3
 * setup installed the very same tool.
 */
export function findChatterboxMlxPython(): string | undefined {
  return process.platform === "darwin" && process.arch === "arm64"
    ? uvToolPython("mlx-audio", path.join("mlx_audio", "tts", "models", "chatterbox"))
    : undefined;
}

/**
 * Languages this engine only speaks correctly with the text prepared first
 * (assets/diacritize.py), and the package that does it. Checked on disk: a
 * runtime installed before the diacritizer was added would otherwise speak
 * those languages from guessed vowels, which is what made them unintelligible.
 */
export const DIACRITIZED_LANGUAGES = ["he"];

/** How many chunks ahead this engine prepares; see the note on the backend. */
const CHATTERBOX_LOOKAHEAD = 6;

/**
 * Text preparation the daemons import (assets/diacritize.py). Pinned, because
 * an unpinned install would pull a future release into the user's
 * environment. Nakdimon (MIT) restores the vowel marks that some writing
 * systems leave out, without which the model guesses them and says other
 * words; num2words (LGPL-2.1, used unmodified in its own process) turns
 * digits into spoken numbers, without which "118" came back as "1028".
 * Together they cost about 50 ms per sentence against 1.4 seconds of
 * synthesis.
 */
export const CHATTERBOX_TEXT_PACKAGES: { spec: string; module: string }[] = [
  { spec: "nakdimon==0.2.1", module: "nakdimon" },
  { spec: "num2words>=0.5.14", module: "num2words" },
];

/** Is this module importable in the runtime Chatterbox resolves to here? */
function runtimeHasModule(globalStoragePath: string, pref: string, module: string): boolean {
  const runtime = resolveChatterboxRuntime(globalStoragePath, pref);
  if (runtime === "mlx") {
    return uvToolPython("mlx-audio", module) !== undefined;
  }
  if (runtime === "torch") {
    return sitePackageExists(chatterboxVenv(globalStoragePath), module);
  }
  return false;
}

export function diacritizerReady(globalStoragePath: string, pref = "auto"): boolean {
  return runtimeHasModule(globalStoragePath, pref, "nakdimon");
}

/**
 * Which of those packages this install still lacks.
 *
 * Not the same question as "is Chatterbox set up": on Apple Silicon the
 * runtime IS the mlx-audio tool the Qwen3 setup installs, so a machine that
 * set Qwen3 up first and then designed a voice arrives here with a working
 * engine and no text preparation at all, and never passes through the setup
 * flow that would have added it. That is exactly how a writing system whose
 * vowels are not written came out as other words. Empty when no runtime is
 * installed: there is nothing to add them to yet.
 */
export function missingTextPackages(globalStoragePath: string, pref = "auto"): string[] {
  if (!resolveChatterboxRuntime(globalStoragePath, pref)) {
    return [];
  }
  return CHATTERBOX_TEXT_PACKAGES.filter((p) => !runtimeHasModule(globalStoragePath, pref, p.module)).map(
    (p) => p.spec
  );
}

/** The interpreter of the runtime resolved here, to install into. */
export function chatterboxRuntimePython(globalStoragePath: string, pref = "auto"): string | undefined {
  const runtime = resolveChatterboxRuntime(globalStoragePath, pref);
  if (runtime === "mlx") {
    return findChatterboxMlxPython();
  }
  if (runtime === "torch") {
    return chatterboxPython(globalStoragePath);
  }
  return undefined;
}

/**
 * Marks the one engine error the extension can repair by installing
 * something, so the notification can offer to do it rather than name a
 * command. Without the marks the words are not merely worse, they are other
 * words, which sounds like a broken voice rather than a missing package.
 */
export const TEXT_PREP_NEEDED = "Text preparation is missing: ";

/** Which runtime a given preference resolves to on this machine. */
export function resolveChatterboxRuntime(globalStoragePath: string, pref = "auto"): "mlx" | "torch" | undefined {
  if (pref === "mlx") {
    return findChatterboxMlxPython() ? "mlx" : undefined;
  }
  if (pref === "torch") {
    return chatterboxPython(globalStoragePath) ? "torch" : undefined;
  }
  if (findChatterboxMlxPython()) {
    return "mlx";
  }
  if (chatterboxPython(globalStoragePath)) {
    return "torch";
  }
  return undefined;
}

export function chatterboxReady(globalStoragePath: string): boolean {
  return resolveChatterboxRuntime(globalStoragePath) !== undefined;
}

/**
 * The language tag sent with a request. The detected language when this
 * engine speaks it; otherwise the voice's own language, because text whose
 * language could not be detected is most likely in the language the user
 * built their voice for; English as the last resort. A language this engine
 * has not been verified on never gets through here: it is read under the
 * voice's own language rather than fed to a path known to babble.
 */
export function chatterboxLanguageFor(detected: string | undefined, profileLanguage: string | undefined): string {
  const speaks = (code: string | undefined): code is string => !!code && ENGINE_LANGUAGES.chatterbox.includes(code);
  if (speaks(detected)) {
    return detected;
  }
  if (speaks(profileLanguage)) {
    return profileLanguage;
  }
  return "en";
}

/** How long a listing of the voice profiles is trusted before it is re-read. */
const PROFILE_CACHE_MS = 1500;

/**
 * One utterance to a file, with a short-lived daemon. Used when designing a
 * voice for a language the designer cannot read: Qwen3 renders the timbre from
 * an English passage, and this speaks the language's own passage in that
 * timbre, so what gets stored as the reference is speech in that language.
 * A reference in the wrong language is exactly what gives a voice a foreign
 * accent, which is the thing being avoided.
 */
export async function renderWithChatterbox(opts: {
  globalStoragePath: string;
  daemonScript: string;
  runtime?: string;
  text: string;
  language: string;
  refWav: string;
  outWav: string;
  onError?: (msg: string) => void;
}): Promise<boolean> {
  const runtime = resolveChatterboxRuntime(opts.globalStoragePath, opts.runtime ?? "auto");
  const python = runtime === "mlx" ? findChatterboxMlxPython() : chatterboxPython(opts.globalStoragePath);
  if (!python || !runtime) {
    return false;
  }
  const daemonScript =
    runtime === "mlx" ? path.join(path.dirname(opts.daemonScript), "chatterbox_mlx_daemon.py") : opts.daemonScript;
  if (!fs.existsSync(daemonScript)) {
    return false;
  }
  const daemon = new PyTtsDaemon(python, daemonScript, { ref_audio: opts.refWav }, opts.onError ?? (() => {}), {
    readyTimeoutMs: 1_800_000,
    logFile: path.join(opts.globalStoragePath, "chatterbox-daemon.log"),
  });
  try {
    await daemon.ready;
    await daemon.request({
      text: opts.text,
      language: opts.language,
      ref_audio: opts.refWav,
      out: opts.outWav,
      priority: 1,
    }).promise;
    return fs.existsSync(opts.outWav);
  } catch (e) {
    opts.onError?.(`Chatterbox could not speak the reference passage: ${(e as Error).message}`);
    return false;
  } finally {
    daemon.dispose();
  }
}

/**
 * Whether a request streams. Only the chunk about to play does: that is where
 * the wait for the first word is. A chunk generated ahead is not waited for,
 * and whole it costs about 0.65x realtime against 1.1x streamed (each window
 * re-vocodes a second of context), so ahead-of-time work stays whole and the
 * buffer keeps building. Only the MLX daemon streams.
 */
export function chatterboxStreams(opts: { streaming: boolean; runtime: string | undefined; urgent: boolean }): boolean {
  return opts.streaming && opts.runtime === "mlx" && opts.urgent;
}

export function chatterboxBackend(
  opts: {
    globalStoragePath: string;
    daemonScript: string;
    voice: string;
    voicesDir: string;
    runtime?: string;
    /** Unload the model after this many minutes without a request (0 = never). */
    idleUnloadMinutes?: number;
    /** Euler steps in the vocoder's ODE solver; fewer is faster (see the daemon). */
    vocoderSteps?: number;
    /** Stream audio while a chunk is still being generated (MLX only). */
    streaming?: boolean;
    /** Quantise the token model at load to this many bits (0 = leave bf16). */
    quantizeBits?: number;
    /** Measured speeds on this machine, kept across sessions. */
    speedMemory?: SpeedMemory;
  },
  onError: (msg: string) => void
): Backend {
  const runtime = resolveChatterboxRuntime(opts.globalStoragePath, opts.runtime ?? "auto");
  const python = runtime === "mlx" ? findChatterboxMlxPython() : chatterboxPython(opts.globalStoragePath);
  if (!python) {
    onError('Chatterbox is not set up. Run "Claude Code TTS: Set Up Chatterbox Engine".');
  }
  const vocoderSteps = opts.vocoderSteps ?? 4;
  const quantizeBits = opts.quantizeBits ?? 8;
  const streaming = opts.streaming ?? true;
  // The MLX daemon lives next to the torch one in the extension's assets.
  const daemonScript =
    runtime === "mlx" ? path.join(path.dirname(opts.daemonScript), "chatterbox_mlx_daemon.py") : opts.daemonScript;

  // Listing profiles reads every meta.json and WAV header in the voices
  // folder. It is consulted per request (the reference travels with each
  // one), so the listing is held briefly rather than re-read per sentence;
  // a slug that is not in it triggers one immediate re-read, which is how a
  // voice created a moment ago is found.
  let listing: { at: number; profiles: CloneProfile[]; missed?: string } | undefined;
  const profiles = (): CloneProfile[] => {
    const now = Date.now();
    if (!listing || now - listing.at > PROFILE_CACHE_MS) {
      listing = { at: now, profiles: listQwen3Clones(opts.voicesDir) };
    }
    return listing.profiles;
  };
  const profileFor = (voice: string): CloneProfile | undefined => {
    if (!voice.startsWith("clone:")) {
      return undefined;
    }
    const slug = voice.slice("clone:".length);
    let hit = profiles().find((c) => c.slug === slug);
    // A slug that is not listed gets ONE immediate re-read (a voice created a
    // moment ago); a slug that is still missing afterwards (deleted while
    // selected) is remembered, or every sentence would re-read the folder.
    if (!hit && listing?.missed !== slug) {
      const fresh: { at: number; profiles: CloneProfile[]; missed?: string } = {
        at: Date.now(),
        profiles: listQwen3Clones(opts.voicesDir),
      };
      hit = fresh.profiles.find((c) => c.slug === slug);
      if (!hit) {
        fresh.missed = slug;
      }
      listing = fresh;
    }
    return hit;
  };
  const refFor = (voice: string): { ref_audio?: string; gain?: number; language?: string } => {
    const p = profileFor(voice);
    return p ? { ref_audio: p.refWav, gain: p.gain, language: p.language } : {};
  };

  // The MLX v3 checkpoint ships no conds file, so it has no built-in speaker:
  // every request must carry a reference. Without one mlx-audio raises on each
  // generation, so refuse up front (and before loading 3 GB of weights) with
  // one actionable message rather than failing silently per sentence.
  const needsReference = runtime === "mlx";
  let warnedNoReference = false;
  let warnedNoDiacritizer = false;
  /**
   * Checked per request, not once at construction: a voice change does not
   * rebuild the backend (SpeechQueue.setConfig only flushes and restarts the
   * sentence), so gating on the voice captured here would keep the engine
   * silent even after the user picked a voice that works.
   */
  const missingReference = (voice: string): boolean => needsReference && !refFor(voice).ref_audio;

  let daemon: PyTtsDaemon | undefined;
  let starts = 0;
  let lastStart = 0;
  const name = runtime === "mlx" ? "chatterbox (mlx)" : "chatterbox";

  // The loaded model holds 2-3 GB of unified memory for as long as the daemon
  // lives. Speech comes in bursts with long quiet stretches between them, and
  // on a 16 GB machine a resident model was measured to push the rest of the
  // system into swap (synthesis itself slowed 2x). After a quiet period the
  // daemon is dropped; the next sentence starts it again from the local cache.
  // Read per use, not captured: the setting is live now, and a captured
  // value meant changing it did nothing until the window was reloaded.
  const idleMs = () => Math.max(0, opts.idleUnloadMinutes ?? 0) * 60_000;
  let idleTimer: NodeJS.Timeout | undefined;
  const unloadIfIdle = (): void => {
    if (!daemon?.alive) {
      return;
    }
    // Work in flight: look again later
    if (daemon.busy) {
      return void touch();
    }
    pipelineLog(
      `${name}: model unloaded after ${opts.idleUnloadMinutes} min without speech; it reloads on the next sentence`
    );
    daemon.dispose();
    daemon = undefined;
    starts = 0; // a deliberate unload is not a crash
  };
  const touch = (): void => {
    const ms = idleMs();
    if (!ms) {
      return;
    }
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(unloadIfIdle, ms);
  };

  const getDaemon = (forVoice?: string): PyTtsDaemon | undefined => {
    if (!python || !fs.existsSync(daemonScript)) {
      return undefined;
    }
    touch();
    if (daemon?.alive) {
      return daemon;
    }
    if (starts >= 2 && Date.now() - lastStart < 120_000) {
      return undefined;
    }
    if (Date.now() - lastStart >= 120_000) {
      starts = 0;
    }
    starts++;
    lastStart = Date.now();
    const ref = refFor(forVoice ?? opts.voice);
    daemon = new PyTtsDaemon(
      python,
      daemonScript,
      // Warm up on the voice that actually triggered the start: the one
      // captured at construction may since have been replaced.
      {
        ...(ref.ref_audio ? { ref_audio: ref.ref_audio, gain: ref.gain } : {}),
        vocoder_steps: vocoderSteps,
        quantize_bits: quantizeBits,
      },
      onError,
      {
        // The first start downloads about 3 GB of weights.
        readyTimeoutMs: 1_800_000,
        logFile: path.join(path.dirname(opts.voicesDir), "chatterbox-daemon.log"),
      }
    );
    return daemon;
  };
  // Eager start so the model load happens before the first message, but not
  // when this runtime has no usable voice: that would spend 3 GB and a minute
  // on a daemon whose every request is going to be refused below.
  if (!missingReference(opts.voice)) {
    getDaemon();
  }

  /**
   * The checks every request needs, once: a usable voice (the v3 checkpoint
   * has no built-in speaker, so without a reference every request would
   * fail) and, for the languages that need it, the diacritizer (without it
   * the words are not merely worse, they are other words). Said once each,
   * not per sentence.
   */
  const prepareRequest = (
    voice: string,
    language?: string
  ): { d: PyTtsDaemon; ref: ReturnType<typeof refFor> } | undefined => {
    const ref = refFor(voice);
    if (needsReference && !ref.ref_audio) {
      if (!warnedNoReference) {
        warnedNoReference = true;
        onError(
          'Chatterbox has no built-in voice: choose or create a cloned voice with "Claude Code TTS: Select Voice".'
        );
      }
      return undefined;
    }
    warnedNoReference = false; // a usable voice arrived; warn again if it goes away
    if (
      language &&
      DIACRITIZED_LANGUAGES.includes(language) &&
      !diacritizerReady(opts.globalStoragePath, opts.runtime ?? "auto")
    ) {
      if (!warnedNoDiacritizer) {
        warnedNoDiacritizer = true;
        onError(
          `${TEXT_PREP_NEEDED}${languageName(language)} needs its vowel marks restored before it can be spoken, and the package that does it is not installed, so the words being said are not the words that were written.`
        );
      }
    }
    const d = getDaemon(voice);
    return d ? { d, ref } : undefined;
  };

  const base = synthesizeThenPlayBackend({
    name,
    naturalWpm: 175,
    // Matches the `lookahead` below, so the pipeline keeps room for every
    // chunk the queue prepares instead of cancelling the one about to play.
    lookahead: CHATTERBOX_LOOKAHEAD,
    // Measured on Apple Silicon: MLX spends about 1.45s of compute per second
    // of speech (median 1.43, p90 1.59 over 20 sustained runs), torch-on-Metal
    // 2.4s. This engine does not stream, so observedRtf never updates and this
    // declared number is the pipeline's only input for sizing the prebuffer
    // and capping catch-up: an optimistic value here underruns at every chunk
    // boundary, which is the silence-then-sprint failure.
    typicalRtf: runtime === "mlx" ? 1.5 : 2.4,
    rememberedRtf: opts.speedMemory?.get(`chatterbox:${runtime}`),
    onRtf: (rtf) => opts.speedMemory?.set(`chatterbox:${runtime}`, rtf),
    synthesize(text, _wpm, voice, wavPath, urgent, language): SynthTask | undefined {
      const prepared = prepareRequest(voice, language);
      if (!prepared) {
        return undefined;
      }
      const { d, ref } = prepared;
      let cancelled = false;
      // ref_audio is always stated, null included: a daemon that fell back to
      // the reference it was started with would keep speaking the old voice
      // after the user switched back to the engine's built-in one.
      const r = d.request({
        text,
        language: chatterboxLanguageFor(language, ref.language),
        out: wavPath,
        priority: urgent ? 1 : 0,
        ref_audio: ref.ref_audio ?? null,
        ...(ref.gain !== undefined ? { gain: ref.gain } : {}),
      });
      const promise = r.promise.then((msg: { gen_s?: number; audio_s?: number }) => {
        if (cancelled) {
          fs.unlink(wavPath, () => {});
          throw new Error("cancelled");
        }
        // The daemon times its own generation; the pipeline learns the real
        // speed of this machine from it (see SynthReport).
        return { genSeconds: msg?.gen_s, audioSeconds: msg?.audio_s };
      });
      return {
        promise,
        cancel: () => {
          cancelled = true;
          r.cancel();
        },
      };
    },
    synthesizeStream(text, _wpm, voice, wavPathBase, onPart, urgent, language): StreamTask | undefined {
      // SynthPlay then takes the whole-chunk path
      if (!chatterboxStreams({ streaming, runtime, urgent })) {
        return undefined;
      }
      const prepared = prepareRequest(voice, language);
      if (!prepared) {
        return undefined;
      }
      const { d, ref } = prepared;
      let cancelled = false;
      const r = d.request(
        {
          text,
          language: chatterboxLanguageFor(language, ref.language),
          out: `${wavPathBase}.wav`,
          stream: true,
          priority: urgent ? 1 : 0,
          ref_audio: ref.ref_audio ?? null,
          ...(ref.gain !== undefined ? { gain: ref.gain } : {}),
        },
        (file, final) => {
          if (!cancelled) {
            onPart(file, final);
          } else {
            fs.unlink(file, () => {});
          }
        }
      );
      return {
        promise: r.promise,
        cancel: () => {
          cancelled = true;
          r.cancel(); // a streaming generation stops at its next token
        },
      };
    },
  });

  return {
    ...base,
    name,
    // This engine spends about 1.75s of compute per second of speech on a
    // machine under memory pressure, so within a message it can only fall
    // further behind. What it can do is work through the pauses between
    // messages: with six chunks queued it keeps generating while Claude
    // thinks, and the buffer that builds up is what removes the long silences.
    lookahead: CHATTERBOX_LOOKAHEAD,
    wake() {
      // Nothing to warm without a usable voice: that daemon would only refuse.
      if (!missingReference(opts.voice)) {
        getDaemon();
      }
    },
    get ready() {
      return daemon?.ready ?? Promise.resolve();
    },
    /** A request is in flight, so this engine must not be disposed yet. */
    get busy() {
      return daemon?.busy ?? false;
    },
    // Voice conversion: only the MLX daemon implements it. Used by the queue
    // to re-voice a Piper utterance (a language this model cannot pronounce)
    // into the user's cloned voice.
    ...(runtime === "mlx"
      ? {
          convertVoice(src: string, out: string, voice: string): Promise<void> {
            const ref = refFor(voice);
            if (!ref.ref_audio) {
              return Promise.reject(new Error(`no reference for ${voice}`));
            }
            const d = getDaemon(voice);
            if (!d) {
              return Promise.reject(new Error("the Chatterbox daemon is unavailable"));
            }
            return d
              .request({
                convert: src,
                out,
                priority: 1,
                ref_audio: ref.ref_audio,
                ...(ref.gain !== undefined ? { gain: ref.gain } : {}),
              })
              .promise.then(() => undefined);
          },
        }
      : {}),
    dispose() {
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      base.dispose?.();
      daemon?.dispose();
    },
  };
}
