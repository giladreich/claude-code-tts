/**
 * A voice of your own, once it exists: which engine speaks it, which setting
 * holds it, and what has to change around it when it becomes the voice.
 *
 * A profile is not just a setting value. It carries the language it was
 * built for, it is spoken by whichever installed engine can pronounce that,
 * it may need a model this machine has not downloaded, and a mapping made
 * earlier for the same language would silently outrank it. This module knows
 * those rules; the flows that create profiles and the lists that choose them
 * do not.
 */
import * as path from "path";
import * as vscode from "vscode";
import { config } from "../core/config";
import { plannedQwen3Model } from "../setup/setupFlows";
import { engineSpeaks, languageName } from "../language/language";
import { engineForProfileLanguage } from "../setup/onboarding";
import { runtime } from "../core/runtime";
import { ensureChatterboxText, installChatterboxRuntime, setupQwen3Flow } from "../setup/setupFlows";
import { trackEngineReady, watchModelDownload } from "../ui/statusBar";
import { chatterboxReady } from "../tts/chatterbox";
import {
  CloneProfile,
  hfModelSnapshot,
  listQwen3Clones,
  qwen3Checkpoint,
  qwen3VoicesDir,
  resolveQwen3Runtime,
} from "../tts/qwen3";
import { cacheName, hubDir, modelBytes } from "../platform/modelProgress";
import { DIACRITIZED_LANGUAGES } from "../tts/chatterbox";

/** What a voice of your own costs to download on the faster engine, if anything. */
export function qwen3CloneCheckpointReady(): boolean {
  const { qwen3Model, qwen3Runtime } = config().speechConfig;
  const modelRuntime = resolveQwen3Runtime(qwen3Runtime) === "torch" ? "torch" : "mlx";
  return (
    hfModelSnapshot(
      qwen3Checkpoint({ voice: "clone:x", clone: true, modelSize: qwen3Model, runtime: modelRuntime })
    ) !== undefined
  );
}

export const qwen3ModelSize = (): string => (plannedQwen3Model() === "1.7B" ? "~4.2 GB" : "~2.3 GB");

/**
 * Make this voice the one that speaks, in an engine that can pronounce the
 * language it was built for, installing that engine and the text preparation
 * that language needs. Asks nothing: every caller has already asked.
 */
export async function useProfileWithEngineFor(value: string, code: string): Promise<boolean> {
  const storage = runtime.context.globalStorageUri.fsPath;
  const cfg = config().speechConfig;
  const plan = engineForProfileLanguage({
    codes: [code],
    qwen3Ready: resolveQwen3Runtime(cfg.qwen3Runtime) !== undefined,
    chatterboxReady: chatterboxReady(storage),
  });
  if (!plan.installed) {
    watchModelDownload();
    const ok = plan.engine === "chatterbox" ? await installChatterboxRuntime(false) : await setupQwen3Flow();
    if (!ok) {
      return false;
    }
  }
  if (plan.engine === "chatterbox" && DIACRITIZED_LANGUAGES.includes(code)) {
    await ensureChatterboxText(languageName(code), true);
  }
  const c = vscode.workspace.getConfiguration("claudeCodeTts");
  await c.update(
    plan.engine === "chatterbox" ? "chatterbox.voice" : "qwen3.voice",
    value,
    vscode.ConfigurationTarget.Global
  );
  if (cfg.engine !== plan.engine) {
    await c.update("engine", plan.engine, vscode.ConfigurationTarget.Global);
  }
  await dropMappingCoveredBy(value, plan.engine);
  trackEngineReady();
  watchModelDownload(); // the weights arrive with the first sentence, and that wait is worth showing
  return true;
}

/**
 * A voice chosen for a language has to be the voice that language is spoken
 * in, including when an older mapping says otherwise.
 *
 * A mapping outranks the voice setting at speaking time, which is what it is
 * for: it is how a language the engine cannot pronounce gets spoken at all.
 * But it also silently outranked a voice the user had just made FOR that
 * language: a new voice was selected, the mapping still named the old one,
 * and every sentence came out in the previous voice with nothing to explain
 * it. So when the engine speaking this voice can pronounce the language the
 * voice was built for, the mapping has nothing left to do and is removed,
 * out loud.
 */
export async function dropMappingCoveredBy(value: string, engine: "qwen3" | "chatterbox"): Promise<void> {
  const code = profileFor(value)?.language;
  if (!code || !engineSpeaks(engine, code)) {
    return;
  }
  const mappings = { ...(config().speechConfig.languageVoices ?? {}) };
  const mapping = mappings[code];
  if (!mapping) {
    return;
  }
  const previous = mappedVoiceName(mapping);
  delete mappings[code];
  await vscode.workspace
    .getConfiguration("claudeCodeTts")
    .update("languageVoices", mappings, vscode.ConfigurationTarget.Global);
  const name = profileName(value);
  if (previous !== value && previous !== name) {
    vscode.window.showInformationMessage(
      `Claude Code TTS: ${languageName(code)} was set to be read by ${previous}, which would have gone on speaking instead of "${name}". That is undone; ${languageName(code)} is read in the voice you chose. "Languages and Translation" can give it a different one again.`
    );
  }
}

/** The voice profile behind a "clone:<slug>" setting value, if it is one. */
export function profileFor(value: string): CloneProfile | undefined {
  return listQwen3Clones(qwen3VoicesDir(runtime.context.globalStorageUri.fsPath)).find(
    (p) => `clone:${p.slug}` === value
  );
}

/**
 * Activate a voice profile that was just created or chosen. Chatterbox uses
 * the same profiles as Qwen3, so the engine is whichever of them is installed
 * and can pronounce what will be heard, the faster one first. That keeps a
 * Chatterbox user who has no Qwen3 on Chatterbox: it is the engine that
 * cannot fall back to a built-in voice, and the one they just set up.
 */
export async function activateVoiceProfile(value: string): Promise<"chatterbox" | "qwen3"> {
  const c = vscode.workspace.getConfiguration("claudeCodeTts");
  const engine = c.get<string>("engine", "system");
  // The profile's own language decides this, not the engine in use: a voice
  // built for a language the engine in use cannot pronounce was left with
  // that engine, which is a voice that cannot say the thing it was made for.
  // See engineForProfileLanguage for the order.
  const { engine: target } = engineForProfileLanguage({
    codes: [profileFor(value)?.language, config().speechConfig.speakLanguage],
    qwen3Ready: resolveQwen3Runtime(config().speechConfig.qwen3Runtime) !== undefined,
    chatterboxReady: chatterboxReady(runtime.context.globalStorageUri.fsPath),
  });
  await c.update(
    target === "chatterbox" ? "chatterbox.voice" : "qwen3.voice",
    value,
    vscode.ConfigurationTarget.Global
  );
  if (engine !== target) {
    await c.update("engine", target, vscode.ConfigurationTarget.Global);
  }
  await dropMappingCoveredBy(value, target);
  return target;
}

/**
 * What happens next, said accurately. A cloned or designed voice speaks from
 * a different checkpoint than the presets, so the first sentence in it may
 * cost a multi-gigabyte download rather than the model swap the message used
 * to promise. Starts the watcher too, so the wait is visible.
 */
export function profileActivationNote(engine: "chatterbox" | "qwen3", what: string): string {
  if (engine === "chatterbox") {
    return `Claude Code TTS: ${what}. Chatterbox will speak in it from the next sentence.`;
  }
  const { qwen3Model, qwen3Runtime } = config().speechConfig;
  const checkpoint = qwen3Checkpoint({
    voice: "clone:x",
    clone: true,
    modelSize: qwen3Model,
    runtime: resolveQwen3Runtime(qwen3Runtime) === "torch" ? "torch" : "mlx",
  });
  const onDisk = modelBytes(hubDir(), cacheName(checkpoint)) > 1024 ** 3;
  if (onDisk) {
    return `Claude Code TTS: ${what}. The model is switching now (~15s); Claude will speak in this voice from the next sentence.`;
  }
  watchModelDownload();
  return (
    `Claude Code TTS: ${what}. Voices of your own speak from a different model than the built-in ones, ` +
    `so the next sentence fetches it (${qwen3Model === "1.7B" ? "~4.2 GB" : "~2.3 GB"}, once). The status bar counts it down.`
  );
}

/** The voice setting that the active engine actually reads. */
export function currentProfileVoice(): string {
  const c = vscode.workspace.getConfiguration("claudeCodeTts");
  return c.get<string>("engine", "system") === "chatterbox"
    ? c.get<string>("chatterbox.voice", "default")
    : c.get<string>("qwen3.voice", "Ryan");
}

/** Display name of a "clone:<slug>" profile (the slug when it is gone). */
export function profileName(value: string): string {
  const slug = value.replace(/^clone:/, "");
  return (
    listQwen3Clones(qwen3VoicesDir(runtime.context.globalStorageUri.fsPath)).find((p) => p.slug === slug)?.name ?? slug
  );
}

/** A mapping is either a bare voice or {engine, voice}; show the voice. */
export function mappedVoiceName(
  entry: string | { engine: string; voice: string; inVoice?: string } | undefined
): string {
  if (!entry) {
    return "";
  }
  const voice = typeof entry === "string" ? entry : entry.voice;
  const base = voice.endsWith(".onnx") ? path.basename(voice, ".onnx") : voice;
  const inVoice = typeof entry === "string" ? undefined : entry.inVoice;
  return inVoice ? `${base}, re-voiced as ${profileName(inVoice)}` : base;
}
