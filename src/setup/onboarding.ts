/**
 * What a new user is pointed at, and when.
 *
 * The extension speaks from the first minute with the voice the operating
 * system already has. That is why it needs no setup, and it is also why most
 * people never hear what it can do: the good voices are one guided install
 * away, and an install nobody is offered is an install nobody does. So every
 * way in leads to the same place (the first run, the status bar, the
 * walkthrough), and a machine still on the built-in voice after a few real
 * sessions is asked once and never again.
 *
 * Which engine that install lands on is decided here rather than left to the
 * reader of a comparison table.
 */
import * as os from "os";
import { ENGINE_LANGUAGES, ProfileEngine } from "../language/language";

export type RecommendedEngine = "qwen3" | "chatterbox" | "kokoro";

/** What this computer can be asked to do, in the terms the choices need. */
export interface Machine {
  platform: string;
  arch: string;
  cores: number;
  memoryGb: number;
}

export function thisMachine(): Machine {
  return {
    platform: process.platform,
    arch: process.arch,
    cores: os.cpus().length || 1,
    memoryGb: os.totalmem() / 1024 ** 3,
  };
}

/**
 * Apple Silicon runs these models on the GPU through MLX and streams the
 * audio; everywhere else they run on the processor, several times slower and
 * without streaming. It is the single biggest fact about a machine here.
 */
export const usesFastRuntime = (machine: Machine): boolean => machine.platform === "darwin" && machine.arch === "arm64";

/**
 * Too small to enjoy a multi-gigabyte model: it would spend its life swapping
 * and still speak slower than it reads.
 */
export const isLowEnd = (machine: Machine): boolean => machine.memoryGb < 8 || machine.cores <= 2;

export interface Recommendation {
  engine: RecommendedEngine;
  /** One sentence saying why, for the notification that offers it. */
  reason: string;
}

/** Spoken utterances before someone still on the built-in voice is asked. */
export const NUDGE_AFTER = 50;

/** Regional variants are the same language for this purpose. */
export const baseLanguage = (code: string): string => code.trim().toLowerCase().split(/[-_]/)[0];

/**
 * The languages this user actually listens to: what they have configured,
 * plus the editor's own display language, which is the best guess available
 * before they have configured anything.
 */
export function wantedLanguages(input: {
  speakLanguage?: string;
  languageVoices?: Record<string, unknown>;
  displayLanguage?: string;
}): string[] {
  const codes = [input.speakLanguage ?? "", ...Object.keys(input.languageVoices ?? {}), input.displayLanguage ?? ""];
  return [...new Set(codes.map(baseLanguage).filter((code) => code.length > 0))];
}

/**
 * Which engine to install. The expressive one is the answer unless it cannot
 * say what this user listens to: it is the only engine here that can clone a
 * voice or make one from a description, which is the reason to install
 * anything at all. It covers ten languages; the wider engine covers 23 and is
 * slower, so it wins only when it is the one that can speak.
 *
 * A machine that cannot carry either gets the light engine instead, but only
 * when the light engine can say what this user listens to: a fast voice in
 * the wrong language is worse than a slow one in the right language.
 */
export function recommendEngine(languages: string[], machine?: Machine): Recommendation {
  const wanted = languages.map(baseLanguage).filter((code) => code.length > 0);
  const beyondReach = wanted.some(
    (code) => !ENGINE_LANGUAGES.qwen3.includes(code) && ENGINE_LANGUAGES.chatterbox.includes(code)
  );
  if (!beyondReach && machine && isLowEnd(machine) && wanted.every((code) => ENGINE_LANGUAGES.kokoro.includes(code))) {
    return {
      engine: "kokoro",
      reason:
        "It is the natural-sounding engine this machine can run comfortably: one download, no Python, and it keeps up while it speaks.",
    };
  }
  return beyondReach
    ? {
        engine: "chatterbox",
        reason:
          "It speaks the language you listen in, which the faster engine cannot, and it speaks it in a voice you make.",
      }
    : {
        engine: "qwen3",
        reason: "It is the most natural voice here, and the only one that can speak as a voice you record or design.",
      };
}

/**
 * Which cloning engine should speak, given the languages that will actually
 * be heard.
 *
 * Both engines speak the same voice profiles, so this is a free choice
 * between them, and the faster one wins it: Qwen3 streams while it generates
 * and runs near realtime, where Chatterbox was measured at 1.45x slower than
 * realtime and cannot start speaking until a whole sentence is finished. It
 * covers ten languages against 23, so the wider engine is for the languages
 * the faster one cannot say, and for nothing else. The engine in use is not
 * an input: it was, under the older rule that kept someone where they were,
 * and leaving it in the signature suggested the answer still depends on it.
 *
 * Every language that will be heard has to be covered, not just the voice's
 * own: a voice recorded in one language, with everything translated into
 * another, needs an engine that says the language being translated into.
 * Preferring the faster engine on the voice's language alone moved someone
 * to an engine that could not pronounce a word of what they were listening
 * to.
 */
export function engineForProfileLanguage(input: {
  /** Languages that must be pronounced: what is spoken, and the voice's own. */
  codes: (string | undefined)[];
  /** Installed and able to speak (a model still to download is fine). */
  qwen3Ready: boolean;
  chatterboxReady: boolean;
}): { engine: ProfileEngine; installed: boolean } {
  const wanted = input.codes.filter((c): c is string => !!c);
  const fits = (engine: ProfileEngine): boolean => wanted.every((code) => ENGINE_LANGUAGES[engine].includes(code));
  const ready = { qwen3: input.qwen3Ready, chatterbox: input.chatterboxReady };
  for (const engine of ["qwen3", "chatterbox"] as ProfileEngine[]) {
    if (fits(engine) && ready[engine]) {
      return { engine, installed: true };
    }
  }
  // Nothing installed can say it: name the one that could, so the caller can
  // install it rather than leave the voice on an engine that stays silent.
  return fits("qwen3") ? { engine: "qwen3", installed: false } : { engine: "chatterbox", installed: false };
}

export interface NudgeState {
  /** The configured engine. */
  engine: string;
  /** Utterances spoken on this machine, all windows and sessions. */
  spoken: number;
  /** Whether this has already been offered once. */
  nudged: boolean;
}

/**
 * Ask only when there is something to improve, and only after it has done
 * enough work to have earned the interruption.
 */
export function shouldNudge(state: NudgeState, after: number = NUDGE_AFTER): boolean {
  return state.engine === "system" && !state.nudged && state.spoken >= after;
}

/**
 * Settings whose right value is a property of the machine rather than a
 * preference. Written once, when the user first sets up an engine, and only
 * over values they have not chosen themselves.
 *
 * The larger checkpoint is the more natural voice, and the slower one: on a
 * current 16 GB laptop it was measured producing 8.4 s of audio in 14.9 s,
 * which cannot keep up with its own natural pace, let alone a faster one, so
 * with it the speaking rate stops being a control at all. The smaller one runs
 * ahead of realtime and can be sped up. It is the default everywhere; the
 * larger one is a choice the picker offers, with that cost stated. Idle
 * unloading follows memory: a small machine should give the model's
 * gigabytes back quickly, a large one keeps it warm and skips the reload.
 */
export function recommendedSettings(machine: Machine): { "qwen3.model": string; idleUnloadMinutes: number } {
  return {
    "qwen3.model": "0.6B",
    idleUnloadMinutes: machine.memoryGb < 16 ? 10 : machine.memoryGb >= 32 ? 90 : 45,
  };
}

/**
 * Whether a machine-chosen default may be written. Two rules, both learned
 * the hard way by other software: never over a value the user set, and never
 * a value identical to the one the extension ships with, which would fill a
 * settings file with lines that change nothing.
 */
export function shouldWriteDefault(
  inspected:
    | { defaultValue?: unknown; globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown }
    | undefined,
  value: unknown
): boolean {
  if (!inspected || inspected.defaultValue === value) {
    return false;
  }
  return (
    inspected.globalValue === undefined &&
    inspected.workspaceValue === undefined &&
    inspected.workspaceFolderValue === undefined
  );
}
