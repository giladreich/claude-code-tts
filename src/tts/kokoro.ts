/**
 * Kokoro: current-generation open neural TTS (Apache-2.0), noticeably more
 * natural than Piper. Runs locally through sherpa-onnx, an actively
 * maintained inference runtime with prebuilt CLI binaries, so no Python is
 * needed. The extension downloads runtime + model itself (see kokoroSetup).
 */

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { uvToolPython, uvToolsDir, venvPython } from "../platform/platform";
import { PyTtsDaemon } from "./pyDaemon";
import { StreamTask, SynthTask, synthesizeThenPlayBackend } from "./synthPlay";
import { SYNTH_SPEED_MAX, SYNTH_SPEED_MIN } from "./wavPlayers";

const clampSpeed = (v: number) => Math.min(SYNTH_SPEED_MAX, Math.max(SYNTH_SPEED_MIN, v));
import { Backend } from "./types";

export const SHERPA_VERSION = "1.13.7";

/** Preferred model: Kokoro v1.0 (53 speakers incl. af_heart, better prosody). */
export const KOKORO_MODEL_ID = "kokoro-multi-lang-v1_0";

/** Older English-only model; still used when it's the only one installed. */
export const KOKORO_MODEL_LEGACY = "kokoro-en-v0_19";

/** sherpa-onnx release asset platform suffix for this machine. */
export function sherpaPlatform(): string | undefined {
  const key = `${process.platform}-${process.arch}`;
  const map: Record<string, string> = {
    "darwin-arm64": "osx-arm64-shared",
    "darwin-x64": "osx-x64-shared",
    "linux-x64": "linux-x64-shared",
    "linux-arm64": "linux-aarch64-shared",
    "win32-x64": "win-x64-shared",
  };
  return map[key];
}

interface Speaker {
  name: string;
  sid: number;
  detail: string;
}

const mk = (names: string[], detailFor: (n: string) => string): Speaker[] =>
  names.map((name, sid) => ({ name, sid, detail: detailFor(name) }));

const accent = (n: string): string =>
  ({ af: "US female", am: "US male", bf: "UK female", bm: "UK male" })[n.slice(0, 2)] ?? "";

/** English speakers of kokoro-multi-lang-v1_0 (sids 0-27, per sherpa docs). */
// prettier-ignore
const V1_SPEAKERS: Speaker[] = mk(
  [
    "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore",
    "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
    "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael",
    "am_onyx", "am_puck", "am_santa",
    "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
    "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
  ],
  (n) => (n === "af_heart" ? "US female, the flagship Kokoro voice" : accent(n))
);

/** Speakers of the older kokoro-en-v0_19 pack. */
const V019_SPEAKERS: Speaker[] = mk(
  [
    "af",
    "af_bella",
    "af_nicole",
    "af_sarah",
    "af_sky",
    "am_adam",
    "am_michael",
    "bf_emma",
    "bf_isabella",
    "bm_george",
    "bm_lewis",
  ],
  (n) => accent(n) || "US female (default blend)"
);

export function kokoroPaths(kokoroDir: string) {
  const plat = sherpaPlatform();
  const exe = process.platform === "win32" ? "sherpa-onnx-offline-tts.exe" : "sherpa-onnx-offline-tts";
  // Prefer the v1.0 model when installed; fall back to the legacy pack.
  const v1 = path.join(kokoroDir, KOKORO_MODEL_ID);
  const legacy = path.join(kokoroDir, KOKORO_MODEL_LEGACY);
  const modelDir = fs.existsSync(path.join(v1, "model.onnx")) ? v1 : legacy;
  return {
    binary: plat ? path.join(kokoroDir, `sherpa-onnx-v${SHERPA_VERSION}-${plat}`, "bin", exe) : undefined,
    modelDir,
    speakers: modelDir === v1 ? V1_SPEAKERS : V019_SPEAKERS,
  };
}

/**
 * Voices in the model beyond the named ones. The multi-language pack holds
 * 53 voices (Spanish, French, Hindi, Italian, Japanese, Portuguese and
 * Chinese besides English), but their names are not recorded in the model
 * file, so the extra ones are offered by index and auditioned: previewing
 * one says which language and voice it is far better than a guessed label.
 */
function extraSpeakers(named: number, total: number): Speaker[] {
  const out: Speaker[] = [];
  for (let sid = named; sid < total; sid++) {
    out.push({
      name: `voice ${sid}`,
      sid,
      detail:
        "Other language in the multi-language pack (Spanish, French, Hindi, Italian, Japanese, Portuguese, Chinese) - listen to identify it",
    });
  }
  return out;
}

/** Speakers the installed model actually has, named ones first. */
export function kokoroSpeakers(kokoroDir: string): Speaker[] {
  const { speakers, modelDir } = kokoroPaths(kokoroDir);
  const total = modelSpeakerCount(modelDir);
  return total > speakers.length ? [...speakers, ...extraSpeakers(speakers.length, total)] : speakers;
}

/**
 * How many voices the model holds, from the size of voices.bin: each voice
 * is a style matrix of 511 frames x 256 floats.
 */
function modelSpeakerCount(modelDir: string): number {
  try {
    const bytes = fs.statSync(path.join(modelDir, "voices.bin")).size;
    const perVoice = 511 * 256 * 4;
    const n = Math.round(bytes / perVoice);
    return n > 0 && n < 500 ? n : 0;
  } catch {
    return 0;
  }
}

/** Both the runtime binary and a voice model are in place. */
export function kokoroReady(kokoroDir: string): boolean {
  const { binary, modelDir } = kokoroPaths(kokoroDir);
  return !!binary && fs.existsSync(binary) && fs.existsSync(path.join(modelDir, "model.onnx"));
}

/** A Python that can import sherpa_onnx hosts the fast synthesis daemon. */
export function findKokoroPython(): string | undefined {
  // Cheap path first: a uv tool venv with the package on disk. Spawning a
  // Python to import sherpa_onnx costs ~0.5s and blocks the extension host.
  const fromUv = uvToolPython("sherpa-onnx", "sherpa_onnx");
  if (fromUv) {
    return fromUv;
  }
  const candidates = [venvPython(path.join(uvToolsDir(), "sherpa-onnx")), "python3", "python"];
  return candidates.find((p) => {
    try {
      return spawnSync(p, ["-c", "import sherpa_onnx"], { stdio: "ignore", timeout: 15000 }).status === 0;
    } catch {
      return false;
    }
  });
}

export function kokoroBackend(
  kokoroDir: string,
  daemonScript: string,
  pauseScale: () => number,
  onError: (msg: string) => void
): Backend {
  const { binary, modelDir, speakers } = kokoroPaths(kokoroDir);
  if (!binary || !fs.existsSync(binary)) {
    onError("Kokoro is not set up. Run 'Claude Code TTS: Set Up Kokoro Engine' to download it.");
  }
  // Every lexicon the pack ships is passed, not just the American English
  // one: without lexicon-zh.txt (and the jieba dictionary) Chinese text is
  // phonemized as if it were English, which is unintelligible.
  const lexicons = ["lexicon-us-en.txt", "lexicon-gb-en.txt", "lexicon-zh.txt"]
    .map((f) => path.join(modelDir, f))
    .filter((f) => fs.existsSync(f));
  const lexicon = lexicons.join(",");
  const dict = path.join(modelDir, "dict");
  const extraArgs: string[] = [];
  if (lexicon) {
    extraArgs.push(`--kokoro-lexicon=${lexicon}`);
  }
  if (fs.existsSync(dict)) {
    extraArgs.push(`--kokoro-dict-dir=${dict}`);
  }

  // Fast path: a persistent daemon keeps the model warm. Started eagerly so
  // the one-time model load happens before the first message, not during it.
  const modelReady = fs.existsSync(path.join(modelDir, "model.onnx"));
  const python = modelReady && fs.existsSync(daemonScript) ? findKokoroPython() : undefined;
  let daemon: PyTtsDaemon | undefined;
  let daemonStarts = 0;
  const getDaemon = (): PyTtsDaemon | undefined => {
    if (!python) {
      return undefined;
    }
    if (daemon?.alive) {
      return daemon;
    }
    // Repeated crashes: stay on CLI
    if (daemonStarts >= 2) {
      return undefined;
    }
    daemonStarts++;
    daemon = new PyTtsDaemon(
      python,
      daemonScript,
      {
        model: path.join(modelDir, "model.onnx"),
        voices: path.join(modelDir, "voices.bin"),
        tokens: path.join(modelDir, "tokens.txt"),
        data_dir: path.join(modelDir, "espeak-ng-data"),
        lexicon,
        dict_dir: fs.existsSync(dict) ? dict : "",
        num_threads: Math.min(8, os.cpus().length),
      },
      onError,
      { readyTimeoutMs: 90_000, logFile: path.join(path.dirname(kokoroDir), "kokoro-daemon.log") }
    );
    return daemon;
  };
  getDaemon();

  const base = synthesizeThenPlayBackend({
    name: "kokoro",
    naturalWpm: 175,
    // Kokoro's own speed control is not proportional: measured on this
    // model, asking for 1.2x produced 1.08x and 2.4x produced 1.89x, so a
    // requested rate would land 10-25% off. The player's time-stretch is
    // exact and pitch-preserving, so the rate is carried there and the model
    // always synthesizes at its natural pace (which also keeps prepared
    // audio valid when the rate changes).
    typicalRtf: 0.3,
    synthesize(text, wpm, voice, wavPath, urgent): SynthTask | undefined {
      const d = getDaemon();
      // Spawn the CLI via buildSynth instead
      if (!d) {
        return undefined;
      }
      const sid = speakers.find((s) => s.name === voice)?.sid ?? 0;
      const speed = clampSpeed(wpm / 175);
      let cancelled = false;
      const r = d.request({ text, sid, speed, out: wavPath, pause_scale: pauseScale(), priority: urgent ? 1 : 0 });
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
          r.cancel(); // the daemon drops it from its queue or aborts generation
        },
      };
    },
    synthesizeStream(text, wpm, voice, wavPathBase, onPart, urgent): StreamTask | undefined {
      const d = getDaemon();
      if (!d) {
        return undefined;
      }
      const sid = speakers.find((s) => s.name === voice)?.sid ?? 0;
      const speed = clampSpeed(wpm / 175);
      let cancelled = false;
      const r = d.request(
        {
          text,
          sid,
          speed,
          out: `${wavPathBase}.wav`,
          stream: true,
          pause_scale: pauseScale(),
          priority: urgent ? 1 : 0,
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
          r.cancel();
        },
      };
    },
    buildSynth(text, wpm, voice, wavPath) {
      const sid = speakers.find((s) => s.name === voice)?.sid ?? 0;
      // Length scale is inverse speed around the model's natural pace.
      const scale = clampSpeed(175 / wpm).toFixed(2);
      return {
        cmd: binary ?? "sherpa-onnx-offline-tts",
        args: [
          `--kokoro-model=${path.join(modelDir, "model.onnx")}`,
          `--kokoro-voices=${path.join(modelDir, "voices.bin")}`,
          `--kokoro-tokens=${path.join(modelDir, "tokens.txt")}`,
          `--kokoro-data-dir=${path.join(modelDir, "espeak-ng-data")}`,
          ...extraArgs,
          `--kokoro-length-scale=${scale}`,
          `--sid=${sid}`,
          `--output-filename=${wavPath}`,
          text,
        ],
      };
    },
  });

  return {
    ...base,
    get ready() {
      return daemon?.ready ?? Promise.resolve();
    },
    dispose() {
      base.dispose?.();
      daemon?.dispose();
    },
  };
}
