/**
 * The offers made when a voice or a language changes.
 *
 * Each of these is the same question in different clothes: you have just
 * chosen something, and one more setting would make it work the way you
 * probably meant. They are offers rather than actions because every one of
 * them costs a download, and each is remembered so it is asked once and not
 * again.
 */
import * as vscode from "vscode";
import { config } from "../core/config";
import { engineSpeaks, languageName, profileEnginesFor, TRANSLATION_LANGUAGES } from "../language/language";
import { downloadVoiceForLanguage, SAMPLES } from "../language/languageSupport";
import { engineForProfileLanguage } from "../setup/onboarding";
import { runtime } from "../core/runtime";
import { setupQwen3Flow } from "../setup/setupFlows";
import { trackEngineReady } from "../ui/statusBar";
import { translationAvailable, translationModelMissing } from "../language/translate";
import { ensureTranslationInto, SOURCE_LANGUAGE } from "../language/translationSetup";
import {
  chatterboxReady,
  diacritizerReady,
  DIACRITIZED_LANGUAGES,
  missingTextPackages,
  resolveChatterboxRuntime,
} from "../tts/chatterbox";
import { curatedVoicesFor } from "../tts/piper";
import { isCloneVoice, listQwen3Clones, qwen3VoicesDir, resolveQwen3Runtime } from "../tts/qwen3";
import {
  activateVoiceProfile,
  currentProfileVoice,
  profileActivationNote,
  profileFor,
  qwen3CloneCheckpointReady,
  qwen3ModelSize,
  useProfileWithEngineFor,
} from "./voiceProfiles";

/**
 * Prefix for "this voice was already offered its own language", per voice.
 * Version 2: the first one recorded the question rather than the answer, so a
 * setup that failed halfway (a model that could not be fetched) counted as
 * asked and never came back. Those answers are forgotten once.
 */
const LANGUAGE_OFFER_KEY = "claudeCodeTts.languageOffered.v2";
/** Prefix for "the faster engine was already offered for this language". */
const QWEN3_SUGGESTED_KEY = "claudeCodeTts.fasterEngineOffered";

/**
 * A language mapped to another engine's voice and then re-voiced into yours
 * costs two synthesis passes and sounds worse than the engine that can speak
 * it directly. When one becomes able to, say so once, per language.
 *
 * This was written for a single language, hard-coded, which made it look
 * like that language was the point. The rule is the same for all of them.
 */
export async function offerDirectLanguages(): Promise<void> {
  const storage = runtime.context.globalStorageUri.fsPath;
  const mappings = config().speechConfig.languageVoices ?? {};
  if (!chatterboxReady(storage)) {
    return;
  }
  const profiles = listQwen3Clones(qwen3VoicesDir(storage));

  for (const [code, mapping] of Object.entries(mappings)) {
    if (typeof mapping !== "object" || !mapping.inVoice) {
      continue;
    }
    // Only worth offering where this engine speaks the language itself, and
    // where anything that language needs preparing is installed.
    if (!engineSpeaks("chatterbox", code)) {
      continue;
    }
    if (DIACRITIZED_LANGUAGES.includes(code) && !diacritizerReady(storage, config().speechConfig.chatterboxRuntime)) {
      continue;
    }
    const profile = profiles.find((c) => `clone:${c.slug}` === mapping.inVoice);
    if (!profile) {
      continue;
    }
    const key = `directOffered:${code}`;
    if (runtime.context.globalState.get<boolean>(key)) {
      continue;
    }
    await runtime.context.globalState.update(key, true);

    const name = languageName(code);
    const SWITCH = `Speak ${name} directly`;
    const pick = await vscode.window.showInformationMessage(
      `Claude Code TTS: Chatterbox can now speak ${name} in "${profile.name}" directly. Your current setting has another engine's voice read it and then re-voices that recording, which is slower and harder to understand. Switch?`,
      SWITCH,
      "Keep it as it is"
    );
    if (pick !== SWITCH) {
      continue;
    }
    const rest = { ...config().speechConfig.languageVoices };
    delete rest[code];
    await vscode.workspace
      .getConfiguration("claudeCodeTts")
      .update("languageVoices", rest, vscode.ConfigurationTarget.Global);
    if (config().speechConfig.engine !== "chatterbox") {
      await vscode.workspace
        .getConfiguration("claudeCodeTts")
        .update("engine", "chatterbox", vscode.ConfigurationTarget.Global);
    }
    runtime.speech?.enqueue(SAMPLES[code] ?? `This is your voice speaking ${name}.`);
  }
}

/**
 * A voice was just created in a language no cloning engine pronounces, such
 * as Czech or Thai. Its owner recorded it to hear that language in their
 * voice, and there is a way: the Piper voice for the language reads the words
 * and the Chatterbox daemon re-voices them into the new profile. Offered,
 * never assumed; the result is the user's to judge. A language Chatterbox
 * speaks itself never comes here: speaking it directly measured far better
 * than converting it (CER 0.076 against 0.337).
 */
export async function offerReVoicedLanguage(value: string): Promise<void> {
  const storage = runtime.context.globalStorageUri.fsPath;
  const profile = profileFor(value);
  const code = profile?.language;
  if (!code || profileEnginesFor(code).length > 0) {
    return;
  }
  const name = languageName(code);
  const canConvert = resolveChatterboxRuntime(storage) === "mlx";
  const piperFor = curatedVoicesFor(code)[0];
  if (!piperFor) {
    vscode.window.showInformationMessage(
      `Claude Code TTS: no engine speaks ${name} in a cloned voice yet, so "${profile.name}" gives other languages a ${name} accent.`
    );
    return;
  }
  const pick = await vscode.window.showInformationMessage(
    `Claude Code TTS: no engine speaks ${name} in a cloned voice, so "${profile.name}" would only give other languages a ${name} accent. ` +
      (canConvert
        ? `There is a way to hear ${name} in your voice anyway: the Piper ${name} voice reads it and Chatterbox re-voices it into "${profile.name}". Measured: the words survive intact and the result is closer to your voice than to Piper's. Try it?`
        : `${name} itself can be spoken by the Piper ${name} voice. Re-voicing it into your own needs the Chatterbox engine on Apple Silicon.`),
    { modal: true },
    ...(canConvert ? [`Speak ${name} in my voice`, `Use the Piper ${name} voice`] : [`Use the Piper ${name} voice`])
  );
  if (!pick) {
    return;
  }
  // Installs Piper and maps the language to its voice
  if (!(await downloadVoiceForLanguage(code))) {
    return;
  }
  if (!pick.startsWith("Speak")) {
    return;
  }
  const mapping = config().speechConfig.languageVoices[code];
  if (typeof mapping !== "object") {
    return;
  }
  await vscode.workspace
    .getConfiguration("claudeCodeTts")
    .update(
      "languageVoices",
      { ...config().speechConfig.languageVoices, [code]: { ...mapping, inVoice: value } },
      vscode.ConfigurationTarget.Global
    );
  runtime.speech?.enqueue(SAMPLES[code] ?? `This is your voice speaking ${name}.`);
}

/**
 * Offer the faster engine for a language it speaks.
 *
 * Both engines speak the same voice profiles, so for the ten languages they
 * both cover this is the same voice arriving sooner: Qwen3 starts speaking
 * while it generates, Chatterbox only after a whole sentence and at 1.45x
 * slower than realtime. Offered when a language or a voice is chosen and the
 * slower engine is what would say it, once per language, and never for a
 * language Qwen3 cannot pronounce or while another language is being spoken
 * that it cannot pronounce either.
 */
export async function suggestQwen3For(code: string): Promise<void> {
  const cfg = config().speechConfig;
  if (cfg.engine !== "chatterbox") {
    return;
  }
  for (const wanted of [code, cfg.speakLanguage]) {
    if (wanted && !engineSpeaks("qwen3", wanted)) {
      return;
    }
  }
  const key = `${QWEN3_SUGGESTED_KEY}.${code}`;
  if (runtime.context.globalState.get<boolean>(key)) {
    return;
  }
  const installed = resolveQwen3Runtime(cfg.qwen3Runtime) !== undefined;
  const cost = installed
    ? qwen3CloneCheckpointReady()
      ? " Everything it needs is already here."
      : ` It downloads its voice model (${qwen3ModelSize()}, once).`
    : ` It installs the engine and downloads its voice model (${qwen3ModelSize()}, once).`;
  const SWITCH = "Use Qwen3";
  const pick = await vscode.window.showInformationMessage(
    `Claude Code TTS: Qwen3 speaks ${languageName(code)} too, in the same voice, and it is the faster of the two: it starts speaking while it generates rather than after the sentence is finished.${cost} Switch?`,
    SWITCH,
    "Stay on Chatterbox"
  );
  // Dismissed rather than answered: ask again another time
  if (pick === undefined) {
    return;
  }
  await runtime.context.globalState.update(key, true);
  if (pick !== SWITCH) {
    return;
  }
  const voice = currentProfileVoice();
  // Its own flow installs and switches
  if (!installed && !(await setupQwen3Flow())) {
    return;
  }
  const c = vscode.workspace.getConfiguration("claudeCodeTts");
  if (isCloneVoice(voice)) {
    await c.update("qwen3.voice", voice, vscode.ConfigurationTarget.Global);
  }
  await c.update("engine", "qwen3", vscode.ConfigurationTarget.Global);
  trackEngineReady();
  vscode.window.showInformationMessage(profileActivationNote("qwen3", "Qwen3 is speaking now"));
}

/**
 * Everything that has to be true for a voice built for a language to
 * actually be heard speaking it: an engine that pronounces that language,
 * this voice selected in it, the text preparation that language needs, and
 * translation into it turned on.
 *
 * Every one of those was a separate menu, and the two that matter most were
 * the two nobody found: a voice designed for another language was selected
 * into an engine that cannot say it, read English text, and sounded broken.
 * So it is one question with everything it will download named in it, and
 * then it runs, with a progress notification per download. Answering no
 * leaves the voice selected and nothing else touched.
 *
 * Returns true when it took over, so the caller does not also announce the
 * voice in a second notification.
 */
export async function offerToSpeakProfileLanguage(value: string): Promise<boolean> {
  const storage = runtime.context.globalStorageUri.fsPath;
  const profile = profileFor(value);
  const code = profile?.language;
  const cfg = config().speechConfig;
  // Already what is spoken
  if (!code || code === cfg.speakLanguage) {
    return false;
  }
  // Nothing to translate: it is already read in English
  if (code === "en" && !cfg.speakLanguage) {
    return false;
  }
  // Nothing here translates into it
  if (!TRANSLATION_LANGUAGES.includes(code)) {
    return false;
  }
  // No engine says it at all: offerReVoicedLanguage's case
  if (profileEnginesFor(code).length === 0) {
    return false;
  }
  // Asked once per voice: a voice that was declined stays declined, and the
  // same question every time that voice is picked is nagging, not help. The
  // answer is what is remembered, so a setup that failed can be tried again.
  const askedKey = `${LANGUAGE_OFFER_KEY}.${value}`;
  if (runtime.context.globalState.get<boolean>(askedKey)) {
    return false;
  }

  const name = languageName(code);
  // The language Claude writes in is a special case. Choosing a voice for it
  // while everything is being translated into another language is a
  // contradiction, and there is nothing to download to resolve it, so it is
  // resolved rather than asked about: translation stops, and the message
  // offers it straight back.
  if (code === SOURCE_LANGUAGE && cfg.speakLanguage && cfg.speakLanguage !== code) {
    const previous = cfg.speakLanguage;
    // The voice is already the one in use (every caller selects it first) and
    // every engine here pronounces this language, so nothing is installed and
    // no engine is changed for it: only the translation stops.
    await vscode.workspace
      .getConfiguration("claudeCodeTts")
      .update("speakLanguage", code, vscode.ConfigurationTarget.Global);
    const UNDO = `Keep translating into ${languageName(previous)}`;
    void vscode.window
      .showInformationMessage(
        `Claude Code TTS: "${profile.name}" speaks ${name}, which is what Claude writes, so messages are no longer translated into ${languageName(previous)}.`,
        UNDO
      )
      .then(async (pick) => {
        if (pick !== UNDO) {
          return;
        }
        await vscode.workspace
          .getConfiguration("claudeCodeTts")
          .update("speakLanguage", previous, vscode.ConfigurationTarget.Global);
        runtime.translator?.prewarm(previous);
        vscode.window.setStatusBarMessage(`Claude Code TTS: translating into ${languageName(previous)} again`, 4000);
      });
    runtime.speech?.enqueue(SAMPLES[code] ?? "This voice reads messages as Claude writes them.");
    return true;
  }
  const plan = engineForProfileLanguage({
    codes: [code],
    qwen3Ready: resolveQwen3Runtime(cfg.qwen3Runtime) !== undefined,
    chatterboxReady: chatterboxReady(storage),
  });
  const downloads: string[] = [];
  if (!plan.installed) {
    downloads.push(plan.engine === "chatterbox" ? "the engine that speaks it (~3 GB)" : "the engine that speaks it");
  }
  if (plan.engine === "qwen3" && !qwen3CloneCheckpointReady()) {
    downloads.push(`its voice model (${qwen3ModelSize()})`);
  }
  if (
    DIACRITIZED_LANGUAGES.includes(code) &&
    plan.installed &&
    missingTextPackages(storage, cfg.chatterboxRuntime).length > 0
  ) {
    downloads.push("the text preparation this writing system needs (~50 MB)");
  }
  if (!translationAvailable()) {
    downloads.push("the offline translation engine");
  } else if (translationModelMissing(await runtime.translator!.pairs(), "en", code)) {
    downloads.push(`the ${name} translation model (~100 MB)`);
  }
  const cost = downloads.length
    ? ` It downloads ${downloads.join(", ")}, once, and everything stays on this machine.`
    : " Everything it needs is already here.";
  const SET_UP = `Speak everything in ${name}`;
  const pick = await vscode.window.showInformationMessage(
    `Claude Code TTS: "${profile.name}" is a ${name} voice. Read everything in ${name} with it, translated on this machine?${cost}`,
    { modal: true },
    SET_UP,
    "Just use the voice"
  );
  await runtime.context.globalState.update(askedKey, true);
  if (pick !== SET_UP) {
    return false;
  }

  // The engine first: without one that speaks the language there is nothing
  // for the translation to be read by.
  if (!(await useProfileWithEngineFor(value, code))) {
    await runtime.context.globalState.update(askedKey, false); // it can be tried again
    vscode.window.showWarningMessage(
      `Claude Code TTS: "${profile.name}" is selected, but the engine that speaks ${name} did not install.`
    );
    return true;
  }

  if (!(await ensureTranslationInto(code, false))) {
    await runtime.context.globalState.update(askedKey, false); // half-done is not an answer: offer it again
    vscode.window.showWarningMessage(
      `Claude Code TTS: "${profile.name}" now speaks through the engine that says ${name}, but translation into it is not set up, so messages are read as they are written. Choosing the voice again offers it once more.`
    );
    return true;
  }
  vscode.window.showInformationMessage(`Claude Code TTS: everything will be spoken in ${name}, in "${profile.name}".`);
  runtime.speech?.enqueue(SAMPLES[code] ?? `This is your voice speaking ${name}.`);
  return true;
}

/**
 * A voice that was just created: selected, announced, and offered the rest of
 * what it needs to be heard in its own language.
 */
export async function useNewProfile(value: string, what: string, sample: string): Promise<void> {
  const engine = await activateVoiceProfile(value);
  // It said what happened, and spoke
  if (await offerToSpeakProfileLanguage(value)) {
    return;
  }
  vscode.window.showInformationMessage(profileActivationNote(engine, what));
  runtime.speech?.enqueue(sample);
  await offerReVoicedLanguage(value);
}
