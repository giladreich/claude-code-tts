/**
 * Qwen3-TTS (Apache-2.0, open-weights since Jan 2026): currently the most
 * expressive local option, run through the official `qwen-tts` Python
 * package via our daemon. On Apple Silicon the MLX runtime (`uv tool install
 * mlx-audio`) is auto-selected: faster than realtime and streaming. Elsewhere
 * `uv tool install qwen-tts` provides the PyTorch runtime. Models (~1.4GB)
 * download from Hugging Face on first use.
 */

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { uvToolPython } from "../platform/platform";
import { PyTtsDaemon } from "./pyDaemon";
import { pipelineLog, StreamTask, SynthTask, synthesizeThenPlayBackend } from "./synthPlay";
import { SpeedMemory, Backend } from "./types";
import { trimSilence, wavFileSeconds } from "./wav";

/**
 * Qwen3's built-in speakers. Only Ryan and Aiden are native English voices
 * (both male); the others are Chinese/Japanese/Korean speakers who read
 * English with an accent. For a female English voice, design one
 * ("Design a Voice") or clone one.
 */
export const QWEN3_SPEAKERS: { name: string; detail: string }[] = [
  { name: "Ryan", detail: "Male, native English, energetic" },
  { name: "Aiden", detail: "Male, native English, calm" },
  { name: "Vivian", detail: "Female, Chinese speaker (accented English)" },
  { name: "Serena", detail: "Female, Chinese speaker (accented English)" },
  { name: "Ono_Anna", detail: "Female, Japanese speaker (accented English)" },
  { name: "Sohee", detail: "Female, Korean speaker (accented English)" },
  { name: "Eric", detail: "Male, Sichuan Chinese speaker" },
  { name: "Dylan", detail: "Male, Beijing Chinese speaker" },
  { name: "Uncle_Fu", detail: "Male, older timbre, Chinese speaker" },
];

/** Detected code -> the name Qwen3 expects. */
export const QWEN3_LANGUAGE_BY_CODE: Record<string, string> = {
  en: "English",
  zh: "Chinese",
  ja: "Japanese",
  ko: "Korean",
  de: "German",
  fr: "French",
  ru: "Russian",
  pt: "Portuguese",
  es: "Spanish",
  it: "Italian",
};

export // prettier-ignore
const QWEN3_LANGUAGES = [
  "English", "Chinese", "Japanese", "Korean", "German",
  "French", "Russian", "Portuguese", "Spanish", "Italian",
];

// ------------------------------ cloned voices ------------------------------

/** Cloned voices are stored as "clone:<slug>" in the voice setting. */
export function isCloneVoice(voice: string): boolean {
  return voice.startsWith("clone:");
}

export function qwen3VoicesDir(globalStoragePath: string): string {
  return path.join(globalStoragePath, "qwen3-voices");
}

export interface CloneProfile {
  slug: string;
  name: string;
  refWav: string;
  refText: string;
  /** Reference length; Qwen3 clones best from ~5-12s, long refs babble. */
  refSeconds: number;
  /** Reference text was derived from a transcript of the recording. */
  usedTranscript: boolean;
  /**
   * Where the reference text came from: a local transcription of the audio,
   * the passage the reader had on screen, or text they typed. Absent on
   * profiles made before this was recorded, which is what the voice picker
   * warns about.
   */
  textSource?: "transcript" | "passage" | "typed";
  /** Made with "Design a Voice" (VoiceDesign model) rather than a mic recording. */
  designed: boolean;
  /** The description a designed voice was rendered from. */
  description?: string;
  /**
   * Language the reference was recorded or rendered in. A voice built from
   * an English passage speaks other languages with an English accent, so
   * this is what makes "a German voice" mean anything.
   */
  language?: string;
  /** Output loudness multiplier (1 = as generated), applied in the daemon. */
  gain: number;
  /** Pace factor (1 = as generated; 1.1 = 10% faster), applied as tempo. */
  pace: number;
  createdAt?: string;
}

/** Read a profile's meta.json (missing/invalid -> {}). */
export function readProfileMeta(profileDir: string): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(path.join(profileDir, "meta.json"), "utf8"));
  } catch {
    return {};
  }
}

/** Merge fields into a profile's meta.json. */
export function updateProfileMeta(profileDir: string, fields: Record<string, unknown>): void {
  const meta = { ...readProfileMeta(profileDir), ...fields };
  fs.writeFileSync(path.join(profileDir, "meta.json"), JSON.stringify(meta, null, 2));
}

export function profileDirOf(voicesDir: string, slug: string): string {
  return path.join(voicesDir, slug);
}

/**
 * Deleting a voice is not undoable by any download: a profile is moved into
 * a trash folder next to the others and can be restored until it is emptied
 * (which "Storage and Cleanup" offers explicitly).
 */
export const TRASH_DIR = ".trash";

export interface TrashedProfile {
  /** Directory name inside the trash: "<slug>-<timestamp>". */
  entry: string;
  name: string;
  deletedAt: string;
}

export function trashProfile(voicesDir: string, slug: string): string {
  const trash = path.join(voicesDir, TRASH_DIR);
  fs.mkdirSync(trash, { recursive: true });
  const entry = `${slug}-${Date.now()}`;
  fs.renameSync(path.join(voicesDir, slug), path.join(trash, entry));
  return entry;
}

export function listTrashedProfiles(voicesDir: string): TrashedProfile[] {
  const trash = path.join(voicesDir, TRASH_DIR);
  try {
    return fs
      .readdirSync(trash)
      .filter((e) => fs.existsSync(path.join(trash, e, "ref.wav")))
      .map((entry) => {
        const meta = readProfileMeta(path.join(trash, entry));
        const stamp = Number(entry.slice(entry.lastIndexOf("-") + 1));
        return {
          entry,
          name: String(meta.name ?? entry),
          deletedAt: Number.isFinite(stamp) ? new Date(stamp).toLocaleString() : "",
        };
      })
      .sort((a, b) => b.entry.localeCompare(a.entry));
  } catch {
    return [];
  }
}

/** Put a trashed profile back; returns its new slug. */
export function restoreProfile(voicesDir: string, entry: string): string {
  const from = path.join(voicesDir, TRASH_DIR, entry);
  const meta = readProfileMeta(from);
  const slug = newProfileSlug(voicesDir, String(meta.name ?? entry.slice(0, entry.lastIndexOf("-"))));
  fs.renameSync(from, path.join(voicesDir, slug));
  return slug;
}

/** Unique slug for a new profile name. */
export function newProfileSlug(voicesDir: string, name: string): string {
  let slug =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "voice";
  while (fs.existsSync(path.join(voicesDir, slug))) {
    slug += "-2";
  }
  return slug;
}

const clampNum = (v: unknown, lo: number, hi: number, dflt: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;

function wavSeconds(file: string): number {
  return wavFileSeconds(file) ?? 0;
}

export function listQwen3Clones(dir: string): CloneProfile[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((slug) => slug !== TRASH_DIR)
      .flatMap((slug) => {
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(dir, slug, "meta.json"), "utf8"));
          const refWav = path.join(dir, slug, "ref.wav");
          if (!fs.existsSync(refWav)) {
            return [];
          }
          return [
            {
              slug,
              name: String(meta.name ?? slug),
              refWav,
              refText: String(meta.refText ?? ""),
              refSeconds: wavSeconds(refWav),
              usedTranscript: meta.usedTranscript === true,
              textSource:
                typeof meta.textSource === "string" ? (meta.textSource as CloneProfile["textSource"]) : undefined,
              designed: meta.designed === true,
              description: typeof meta.description === "string" ? meta.description : undefined,
              language: typeof meta.language === "string" ? meta.language : undefined,
              gain: clampNum(meta.gain, 0.5, 2, 1),
              pace: clampNum(meta.pace, 0.7, 1.4, 1),
              createdAt: typeof meta.createdAt === "string" ? meta.createdAt : undefined,
            },
          ];
        } catch {
          return [];
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * Which checkpoint a voice needs. Presets speak from the CustomVoice model
 * and cloned or designed voices from the Base one, and asking the wrong one
 * fails with "CustomVoice model requires 'voice'" rather than anything a user
 * could act on. Exported so the rule is tested rather than inferred.
 */
export function qwen3Checkpoint(o: { voice: string; clone: boolean; modelSize: string; runtime: string }): string {
  const size = o.modelSize === "1.7B" ? "1.7B" : "0.6B";
  const variant = o.clone ? "Base" : "CustomVoice";
  return o.runtime === "mlx"
    ? `mlx-community/Qwen3-TTS-12Hz-${size}-${variant}-bf16`
    : `Qwen/Qwen3-TTS-12Hz-${size}-${variant}`;
}

/**
 * Local snapshot directory of a cached Hugging Face model, if any. Loading
 * from the directory bypasses every hub network call; a stalled hub request
 * inside from_pretrained otherwise leaves the daemon silently hung.
 */
export function hfModelSnapshot(modelId: string): string | undefined {
  const hub = process.env.HF_HOME
    ? path.join(process.env.HF_HOME, "hub")
    : path.join(os.homedir(), ".cache", "huggingface", "hub");
  const snapshots = path.join(hub, "models--" + modelId.replace("/", "--"), "snapshots");
  try {
    const dirs = fs
      .readdirSync(snapshots)
      .map((d) => path.join(snapshots, d))
      .filter((d) => fs.existsSync(path.join(d, "config.json")))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return dirs[0];
  } catch {
    return undefined;
  }
}

let pythonLookup: { value: string | undefined } | undefined;
let mlxLookup: { value: string | undefined } | undefined;

/** A Python with mlx-audio (`uv tool install mlx-audio`) runs Qwen3 natively
 *  on Apple Silicon, several times faster than torch-on-Metal. */
export function findQwen3MlxPython(): string | undefined {
  if (mlxLookup) {
    return mlxLookup.value;
  }
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    return (mlxLookup = { value: undefined }).value;
  }
  const fast = uvToolPython("mlx-audio", path.join("mlx_audio", "tts", "models", "qwen3_tts"));
  const value =
    fast ??
    ["python3"].find((p) => {
      try {
        return (
          spawnSync(p, ["-c", "import mlx_audio.tts.models.qwen3_tts"], { stdio: "ignore", timeout: 10000 }).status ===
          0
        );
      } catch {
        return false;
      }
    });
  mlxLookup = { value };
  return value;
}

/** A Python that can import qwen_tts hosts the synthesis daemon. The probe
 *  imports torch (seconds), so the result is memoized per session. */
export function findQwen3Python(): string | undefined {
  if (pythonLookup) {
    return pythonLookup.value;
  }
  const fast = uvToolPython("qwen-tts", "qwen_tts");
  const value =
    fast ??
    ["python3", "python"].find((p) => {
      try {
        return spawnSync(p, ["-c", "import qwen_tts"], { stdio: "ignore", timeout: 10000 }).status === 0;
      } catch {
        return false;
      }
    });
  pythonLookup = { value };
  return value;
}

/** Forget the memoised probes (after installing a runtime). */
export function resetQwen3Lookups(): void {
  pythonLookup = undefined;
  mlxLookup = undefined;
}

export function qwen3Available(): boolean {
  return findQwen3MlxPython() !== undefined || findQwen3Python() !== undefined;
}

/** Which runtime a given preference resolves to on this machine. */
export function resolveQwen3Runtime(pref: string): "mlx" | "torch" | undefined {
  if (pref === "mlx") {
    return findQwen3MlxPython() ? "mlx" : undefined;
  }
  if (pref === "torch") {
    return findQwen3Python() ? "torch" : undefined;
  }
  if (findQwen3MlxPython()) {
    return "mlx";
  }
  if (findQwen3Python()) {
    return "torch";
  }
  return undefined;
}

export function qwen3Backend(
  opts: {
    modelSize: string;
    language: string;
    style: string;
    pauseScale: number;
    daemonScript: string;
    voice: string;
    voicesDir: string;
    runtime: string;
    /** Unload the model after this many minutes without a request (0 = never). */
    idleUnloadMinutes?: number;
    /** Measured speeds on this machine, kept across sessions. */
    speedMemory?: SpeedMemory;
  },
  onError: (msg: string) => void
): Backend {
  const { modelSize, voicesDir } = opts;
  const configuredLanguage = () => opts.language;
  // Qwen3 takes the language per request, so a detected one is used directly
  // and the setting is the fallback for text too short to judge.
  const languageFor = (detected: string | undefined, voice: string): string => {
    if (detected) {
      return QWEN3_LANGUAGE_BY_CODE[detected] ?? configuredLanguage();
    }
    // Too short to detect: a cloned voice speaks the language it was built
    // in, which beats the global setting for a German voice saying "Fertig."
    const own = isCloneVoice(voice) ? profileFor(voice)?.language : undefined;
    return (own && QWEN3_LANGUAGE_BY_CODE[own]) || configuredLanguage();
  };
  // Presets accept a delivery instruction; it steadies the occasionally
  // theatrical default delivery. Clones ignore it (the Base model has no
  // instruct input).
  const style = () => opts.style.trim();
  const runtime = resolveQwen3Runtime(opts.runtime);
  // MLX daemon lives next to the torch one in the extension's assets folder.
  const daemonScript =
    runtime === "mlx" ? path.join(path.dirname(opts.daemonScript), "qwen3_mlx_daemon.py") : opts.daemonScript;
  const python =
    runtime && fs.existsSync(daemonScript) ? (runtime === "mlx" ? findQwen3MlxPython() : findQwen3Python()) : undefined;
  if (!python) {
    onError(
      "Qwen3-TTS is not set up. On Apple Silicon run `uv tool install mlx-audio` (fastest); elsewhere `uv tool install qwen-tts`."
    );
  }
  // Presets and clones live in different checkpoints. Which one is needed is
  // decided when the daemon starts rather than when the backend is built:
  // designing a voice writes the profile and selects it in the same instant,
  // and a build-time lookup that missed it loaded the preset checkpoint and
  // then answered every clone request with "requires a speaker name".
  /** Trim a reference recorded before chunk-aware trimming. Once, in place. */
  const trimOnce = (clone: CloneProfile): void => {
    try {
      const metaPath = path.join(path.dirname(clone.refWav), "meta.json");
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      if (meta.trimmed) {
        return;
      }
      const backup = path.join(path.dirname(clone.refWav), "ref.original.wav");
      if (!fs.existsSync(backup)) {
        fs.copyFileSync(clone.refWav, backup);
      }
      const r = trimSilence(clone.refWav);
      fs.writeFileSync(metaPath, JSON.stringify({ ...meta, trimmed: true, trimmedSeconds: r.seconds }, null, 2));
      clone.refSeconds = r.seconds;
    } catch {
      /* best effort */
    }
  };
  /**
   * Any cloned or designed voice on the Base checkpoint can be synthesized by
   * the same daemon: the reference travels with the request. That is what
   * makes auditioning another cloned voice (and switching to it) instant
   * instead of a model reload. Only crossing preset <-> clone changes the
   * checkpoint. The list is cached and refreshed when an unknown slug appears
   * (a profile created or edited while the engine was running).
   */
  let profiles: CloneProfile[] | undefined;
  const profileFor = (v: string): CloneProfile | undefined => {
    const slug = v.slice("clone:".length);
    let hit = (profiles ??= listQwen3Clones(voicesDir)).find((c) => c.slug === slug);
    if (!hit) {
      profiles = listQwen3Clones(voicesDir);
      hit = profiles.find((c) => c.slug === slug);
    }
    return hit;
  };
  /** Reference fields for a clone request; empty for the daemon's own clone. */
  const refFields = (v: string): Record<string, unknown> => {
    const p = profileFor(v);
    if (!p || p.slug === daemonClone?.slug) {
      return {};
    }
    return { ref_audio: p.refWav, ref_text: p.refText, gain: p.gain };
  };

  const size = modelSize === "1.7B" ? "1.7B" : "0.6B";
  /** The profile the current voice names, looked up now (the list refreshes). */
  const activeClone = (): CloneProfile | undefined => (isCloneVoice(opts.voice) ? profileFor(opts.voice) : undefined);
  const modelIdFor = (clone: CloneProfile | undefined): string =>
    qwen3Checkpoint({ voice: opts.voice, clone: clone !== undefined, modelSize: size, runtime: runtime ?? "mlx" });

  let daemon: PyTtsDaemon | undefined;
  /** Why the last request could not be served, when there is something to say. */
  let refusal: string | undefined;
  /** What the running daemon loaded, so a voice needing another one restarts it. */
  let daemonModelId: string | undefined;
  let daemonClone: CloneProfile | undefined;
  let daemonStarts = 0;
  let lastDaemonStart = 0;
  // See chatterbox.ts: a resident model holds gigabytes through long quiet
  // stretches; after one it is dropped and reloads on the next sentence.
  // Read per use, not captured: the setting is live now, and a captured
  // value meant changing it did nothing until the window was reloaded.
  const idleMs = () => Math.max(0, opts.idleUnloadMinutes ?? 0) * 60_000;
  let idleTimer: NodeJS.Timeout | undefined;
  const unloadIfIdle = (): void => {
    if (!daemon?.alive) {
      return;
    }
    if (daemon.busy) {
      return void touch();
    }
    pipelineLog(
      `qwen3: model unloaded after ${opts.idleUnloadMinutes} min without speech; it reloads on the next sentence`
    );
    daemon.dispose();
    daemon = undefined;
    daemonStarts = 0; // a deliberate unload is not a crash
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

  const getDaemon = (wanted$voice?: string): PyTtsDaemon | undefined => {
    refusal = undefined;
    if (!python) {
      return undefined;
    }
    touch();
    // The voice being spoken decides the checkpoint, not only the configured
    // one: auditioning a preset while a cloned voice is active is exactly how
    // someone chooses a voice, and it used to be silent.
    const voice = wanted$voice ?? opts.voice;
    const clone = isCloneVoice(voice) ? profileFor(voice) : undefined;
    if (isCloneVoice(voice) && !clone) {
      onError(`cloned voice profile not found: ${voice}`);
      return undefined; // better silent than a preset checkpoint asked to clone
    }
    if (clone) {
      trimOnce(clone);
    }
    const wanted = modelIdFor(clone);
    // Auditioning a voice must never start a multi-gigabyte download: that is
    // a decision, and highlighting a row in a list is not one. The configured
    // voice may fetch what it needs; anything else waits until it is here.
    if (voice !== opts.voice && !hfModelSnapshot(wanted)) {
      pipelineLog(`qwen3: not auditioning ${voice}; ${wanted} is not downloaded`);
      refusal = isCloneVoice(voice)
        ? "voices of your own speak from a model that is not downloaded yet; select one to fetch it"
        : "the preset voices speak from a model that is not downloaded yet; select one to fetch it";
      return undefined;
    }
    if (daemon?.alive && daemonModelId !== wanted) {
      // The voice needs the other checkpoint, and nothing else can serve it.
      // Only while the daemon is idle: swapping models mid-turn would stop
      // the sentence being spoken to load gigabytes for one preview.
      if (daemon.busy) {
        refusal = "this voice needs the other model, which loads when the engine is idle";
        return undefined;
      }
      pipelineLog(`qwen3: switching model to ${wanted}`);
      daemon.dispose();
      daemon = undefined;
      daemonStarts = 0; // a deliberate switch is not a crash
    }
    if (daemon?.alive) {
      return daemon;
    }
    // Crash budget: two quick restarts, then back off; a restart is allowed
    // again after two minutes so a transient failure never mutes the engine
    // for the whole session.
    if (daemonStarts >= 2 && Date.now() - lastDaemonStart < 120_000) {
      return undefined;
    }
    if (Date.now() - lastDaemonStart >= 120_000) {
      daemonStarts = 0;
    }
    daemonStarts++;
    lastDaemonStart = Date.now();
    // First start loads from the local snapshot when cached (no network at
    // all); a retry after a failure falls back to the hub id online.
    const snapshot = daemonStarts === 1 ? hfModelSnapshot(wanted) : undefined;
    daemonModelId = wanted;
    daemonClone = clone;
    pipelineLog(`qwen3: loading ${wanted}${snapshot ? " (cached)" : " (downloading)"}`);
    daemon = new PyTtsDaemon(
      python,
      daemonScript,
      {
        model_id: snapshot ?? wanted,
        ...(clone ? { clone: { ref_audio: clone.refWav, ref_text: clone.refText, gain: clone.gain } } : {}),
      },
      onError,
      {
        readyTimeoutMs: snapshot ? 600_000 : 1_800_000,
        logFile: path.join(path.dirname(voicesDir), "qwen3-daemon.log"),
      }
    );
    return daemon;
  };
  // Not started here: constructing the engine happens during VSCode
  // activation, and this loads gigabytes and can start a first-run download.
  // The queue calls wake() when Claude begins writing, which is early enough
  // to hide the load and does not spend it on a window that stays quiet.

  /** A refusal the user can act on, in place of "daemon unavailable". */
  const reason = (): SynthTask | undefined => {
    if (!refusal) {
      return undefined;
    }
    const promise = Promise.reject<void>(new Error(refusal));
    promise.catch(() => {});
    return { promise, cancel: () => {} };
  };

  const base = synthesizeThenPlayBackend({
    name: "qwen3",
    // Clones may speak faster or slower than the presets; a per-profile pace
    // factor (Manage Voices) shifts what "natural" means for that voice.
    naturalWpm: 175 / (activeClone()?.pace ?? 1),
    // Measured on Apple Silicon (MLX): 0.6B ~0.7x realtime, 1.7B ~1.0x idle
    // and slower under load. The pipeline learns the real value as it goes,
    // and keeps it: a machine that measured slower last week is still slower.
    typicalRtf: size === "1.7B" ? 1.15 : 0.75,
    rememberedRtf: opts.speedMemory?.get(`qwen3:${size}:${runtime ?? "mlx"}`),
    onRtf: (rtf) => opts.speedMemory?.set(`qwen3:${size}:${runtime ?? "mlx"}`, rtf),
    synthesize(text, _wpm, voice, wavPath, urgent, language): SynthTask | undefined {
      // Qwen has no speed knob; our playback tempo carries the user's rate.
      const d = getDaemon(voice);
      if (!d) {
        return reason() ?? undefined;
      }
      // It can still be the wrong one: a switch is refused while the daemon
      // is speaking, and this voice cannot be served by what is loaded.
      if (isCloneVoice(voice) !== (daemonClone !== undefined)) {
        const promise = Promise.reject<void>(
          new Error("this voice needs the other model; it loads when the engine is idle")
        );
        promise.catch(() => {});
        return { promise, cancel: () => {} };
      }
      let cancelled = false;
      const payload = {
        ...(isCloneVoice(voice)
          ? { text, language: languageFor(language, voice), ...refFields(voice) }
          : { text, voice, language: languageFor(language, voice), style: style() }),
        out: wavPath,
        pause_scale: opts.pauseScale,
        priority: urgent ? 1 : 0,
      };
      const r = d.request(payload);
      const promise = r.promise.then(() => {
        if (cancelled) {
          fs.unlink(wavPath, () => {});
          throw new Error("cancelled");
        }
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
      const d = getDaemon(voice);
      if (!d) {
        return undefined;
      }
      if (isCloneVoice(voice) !== (daemonClone !== undefined)) {
        return undefined;
      }
      let cancelled = false;
      const payload = {
        ...(isCloneVoice(voice)
          ? { text, language: languageFor(language, voice), ...refFields(voice) }
          : { text, voice, language: languageFor(language, voice), style: style() }),
        out: `${wavPathBase}.wav`,
        stream: true,
        pause_scale: opts.pauseScale,
        priority: urgent ? 1 : 0,
      };
      const r = d.request(payload, (file, final) => {
        if (!cancelled) {
          onPart(file, final);
        } else {
          fs.unlink(file, () => {});
        }
      });
      return {
        promise: r.promise,
        cancel: () => {
          cancelled = true;
          r.cancel();
        },
      };
    },
  });

  return {
    ...base,
    name: runtime === "mlx" ? "qwen3 (mlx)" : "qwen3",
    // Claude has started writing: load the model now, while it is still
    // thinking, instead of when the first sentence is already waiting.
    wake() {
      getDaemon();
    },
    get ready() {
      return daemon?.ready ?? Promise.resolve();
    },
    /** A request is in flight, so this engine must not be disposed yet. */
    get busy() {
      return daemon?.busy ?? false;
    },
    dispose() {
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      base.dispose?.();
      daemon?.dispose();
    },
  };
}
