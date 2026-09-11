/**
 * Piper: lightweight neural TTS, fully local. The original rhasspy/piper repo
 * is archived; the maintained continuation is OHF-Voice/piper1-gpl, which is
 * what `pip install piper-tts` ships. Both flag dialects are supported below.
 */

import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { commandOnPath, exe, userScriptDirs, uvToolsDirs, venvBin } from "../platform/platform";
import { synthesizeThenPlayBackend } from "./synthPlay";
import { SYNTH_SPEED_MAX, SYNTH_SPEED_MIN } from "./wavPlayers";
import { Backend } from "./types";

// ---------------------------- executable lookup ----------------------------

/**
 * Resolve the Piper executable. The configured value is tried first; when it
 * is the bare default "piper", common install locations are probed too, since
 * pip/uv put it in ~/.local/bin which is often missing from VSCode's PATH.
 */
export function resolvePiperPath(configured: string): string | undefined {
  // Found on disk rather than run: this is asked when the engine is built,
  // which is activation for a Piper user, and starting Piper to ask it for
  // --help cost a Python start-up there (and a console window on Windows).
  const runnable = (p: string): boolean => {
    if (!path.isAbsolute(p) && !p.includes(path.sep)) {
      return commandOnPath(p) !== undefined;
    }
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  const candidates = [configured];
  if (configured === "piper") {
    // pip and uv put console scripts where a GUI-launched editor's PATH
    // often does not reach; the layout differs per platform. A piper the
    // extension installed through its own uv lives in that uv's tool dir.
    candidates.push(...userScriptDirs().map((d) => path.join(d, exe("piper"))));
    candidates.push(...uvToolsDirs().map((d) => path.join(venvBin(path.join(d, "piper-tts")), exe("piper"))));
  }
  return candidates.find(runnable);
}

export function piperAvailable(piperPath: string): boolean {
  return resolvePiperPath(piperPath) !== undefined;
}

// ------------------------------ voice models -------------------------------

/**
 * Curated voices from the official rhasspy/piper-voices repository on
 * Hugging Face. Voice/engine downloads are the only network access in this
 * extension, always user-initiated; models are cached locally and synthesis
 * never touches the network.
 *
 * `license` is the voice's OWN licence, read from its MODEL_CARD, not the
 * repository's. The repository is tagged MIT, but each voice inherits the
 * licence of the speech it was trained on and several are more restrictive:
 * the Hebrew voice comes from a custom non-commercial agreement, the Turkish
 * one is CC BY-NC-SA 4.0, and the Arabic one's training repository carries no
 * licence at all. That is worth knowing before a download, so it is shown.
 */
export const CURATED_VOICES: {
  id: string;
  hfDir: string;
  detail: string;
  mb: number;
  license: string;
}[] = [
  {
    id: "en_US-lessac-medium",
    hfDir: "en/en_US/lessac/medium",
    detail: "English (US), neutral male, good all-rounder",
    mb: 61,
    license: "Blizzard 2013 licence (research and personal use)",
  },
  {
    id: "en_US-amy-medium",
    hfDir: "en/en_US/amy/medium",
    detail: "English (US), female",
    mb: 61,
    license: "CC0",
  },
  {
    id: "en_US-ryan-high",
    hfDir: "en/en_US/ryan/high",
    detail: "English (US), male, highest quality (slower synth)",
    mb: 115,
    license: "CC0",
  },
  {
    id: "en_US-hfc_female-medium",
    hfDir: "en/en_US/hfc_female/medium",
    detail: "English (US), female, crisp",
    mb: 61,
    license: "CC0",
  },
  {
    id: "en_GB-alan-medium",
    hfDir: "en/en_GB/alan/medium",
    detail: "English (UK), male",
    mb: 61,
    license: "CC0",
  },
  {
    id: "en_GB-alba-medium",
    hfDir: "en/en_GB/alba/medium",
    detail: "English (UK), female",
    mb: 61,
    license: "CC0",
  },
  {
    id: "de_DE-thorsten-medium",
    hfDir: "de/de_DE/thorsten/medium",
    detail: "German, male",
    mb: 61,
    license: "CC0",
  },
  {
    id: "de_DE-thorsten-high",
    hfDir: "de/de_DE/thorsten/high",
    detail: "German, male, highest quality",
    mb: 109,
    license: "CC0",
  },
  // Languages the neural engines here cannot speak at all: Piper is the only
  // way to hear them in a natural voice rather than an OS one.
  {
    id: "he_IL-saspeech-medium",
    hfDir: "he/he_IL/saspeech/medium",
    detail: "Hebrew, male (SASPEECH); clearest when the text carries its vowel marks",
    mb: 64,
    license: "custom non-commercial (OpenSLR 134, IPBC terms)",
  },
  {
    id: "ar_JO-kareem-medium",
    hfDir: "ar/ar_JO/kareem/medium",
    detail: "Arabic (Jordanian), male; accurate, and Piper adds the diacritics itself",
    mb: 64,
    license: "no licence stated by the training corpus",
  },
  {
    id: "fa_IR-amir-medium",
    hfDir: "fa/fa_IR/amir/medium",
    detail: "Persian, male",
    mb: 64,
    license: "CC0",
  },
  {
    id: "tr_TR-dfki-medium",
    hfDir: "tr/tr_TR/dfki/medium",
    detail: "Turkish, male",
    mb: 64,
    license: "CC BY-NC-SA 4.0",
  },
];

export const HF_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main";

/**
 * Curated voices that speak a given language. This is what makes a neural
 * voice possible for languages the other engines cannot say at all: one
 * 64 MB download, no Python.
 */
export function curatedVoicesFor(code: string): typeof CURATED_VOICES {
  return CURATED_VOICES.filter((v) => v.id.slice(0, 2).toLowerCase() === code.toLowerCase());
}

/** Where downloaded voice models live, under the extension's global storage. */
export function piperVoicesDir(globalStoragePath: string): string {
  return path.join(globalStoragePath, "piper-voices");
}

/** Language of a Piper voice from its name, e.g. "he_IL-shaul-medium" -> "he". */
export function piperVoiceLanguage(name: string): string | undefined {
  const m = name.match(/^([a-z]{2})[_-]/i);
  return m ? m[1].toLowerCase() : undefined;
}

/** Voice models already downloaded (or placed) in the voices directory. */
export function listPiperVoices(dir: string): { name: string; modelPath: string }[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".onnx"))
      .map((f) => ({
        name: f.replace(/\.onnx$/, ""),
        modelPath: path.join(dir, f),
      }));
  } catch {
    return [];
  }
}

// -------------------------------- the engine -------------------------------

export function piperBackend(
  configuredPath: string,
  /**
   * Unused here, and kept so every engine is built the same way: a synthesis
   * or playback failure is reported per utterance by the shared pipeline
   * below, which receives the queue's own error callback.
   */
  _onError: (msg: string) => void,
  /** Re-voice each finished utterance (a mapping with `inVoice`). */
  postProcess?: (wavPath: string) => Promise<void>
): Backend {
  const piperPath = resolvePiperPath(configuredPath) ?? configuredPath;
  // Piper >=1.7 renamed --length_scale to --length-scale; probe once, in the
  // background (a synchronous probe here stalled activation for piper users).
  let lengthFlag = "--length-scale";
  try {
    execFile(piperPath, ["--help"], { encoding: "utf8", timeout: 5000, windowsHide: true }, (_err, stdout) => {
      const help = String(stdout ?? "");
      if (help && !help.includes("--length-scale") && help.includes("--length_scale")) {
        lengthFlag = "--length_scale";
      }
    });
  } catch {
    /* keep modern default */
  }

  return synthesizeThenPlayBackend({
    name: postProcess ? "piper, re-voiced" : "piper",
    nativeSpeed: true,
    // Conversion roughly triples the work (measured 0.66-1.0x realtime for
    // the s3gen pass alone), still around realtime in total.
    typicalRtf: postProcess ? 1.1 : 0.3,
    postProcess: postProcess ? (wav) => postProcess(wav) : undefined,
    buildSynth(text, wpm, voice, wavPath) {
      // Piper's natural pace is ~175 wpm; length scale is its inverse speed.
      const scale = Math.min(SYNTH_SPEED_MAX, Math.max(SYNTH_SPEED_MIN, 175 / wpm)).toFixed(2);
      return {
        cmd: piperPath,
        args: ["-m", voice, "-f", wavPath, lengthFlag, scale],
        stdinText: text,
      };
    },
  });
}
