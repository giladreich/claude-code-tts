/**
 * Which language is spoken, and which voice speaks it.
 *
 * Two settings decide that between them: everything can be translated into
 * one language before it is read, and any one language can be given a voice
 * of its own. Both need models fetched and engines that pronounce the
 * language. The two menus and the two notices live here; the offers made
 * after a voice or a language changes are in voices/voiceOffers.ts.
 */
import * as vscode from "vscode";
import { config } from "../core/config";
import { suggestQwen3For } from "../voices/voiceOffers";
import { downloadVoiceForLanguage, SAMPLES, systemVoiceFor, voiceChoices, voiceLanguages } from "./languageSupport";
import { ensureTranslationInto } from "./translationSetup";
import {
  enginePronounces,
  engineSpeaks,
  languageName,
  profileEnginesFor,
  suggestEngineFor,
  TRANSLATION_LANGUAGES,
} from "./language";
import { designVoiceFlow } from "../voices/design";
import { engineForProfileLanguage } from "../setup/onboarding";
import { runtime } from "../core/runtime";
import { prepareTextFor, setupChatterboxFlow, setupQwen3Flow } from "../setup/setupFlows";
import { SpeechConfig } from "../speech/speech";
import { watchModelDownload } from "../ui/statusBar";
import { chatterboxReady, resolveChatterboxRuntime } from "../tts/chatterbox";
import {
  CloneProfile,
  QWEN3_SPEAKERS,
  isCloneVoice,
  listQwen3Clones,
  qwen3VoicesDir,
  resolveQwen3Runtime,
} from "../tts/qwen3";
import { listSystemVoices } from "../tts/system";
import { curatedVoicesFor, listPiperVoices, piperVoiceLanguage, piperVoicesDir } from "../tts/piper";
import { kokoroDirOf } from "../setup/kokoroSetup";
import { kokoroSpeakers } from "../tts/kokoro";
import { livePreviewPicker, MenuOutcome, pickWithBack } from "../ui/prompts";
import {
  activateVoiceProfile,
  currentProfileVoice,
  mappedVoiceName,
  profileName,
  useProfileWithEngineFor,
} from "../voices/voiceProfiles";

/**
 * The user selected one voice and a language is being spoken by another
 * engine's voice because of a mapping: say so the first time, with the
 * reason, so another engine's voice reading a language is not mistaken for
 * a broken clone.
 */
export function notifyRouted(language: string, engine: SpeechConfig["engine"], voice: string, inVoice?: string): void {
  const name = languageName(language);
  const label = mappedVoiceName({ engine, voice, inVoice });
  const active = config().speechConfig.engine;
  runtime.output.appendLine(
    `[route] ${name} -> ${label} (${engine}); the ${active} engine ${engineSpeaks(active, language) ? "was not chosen for it" : "cannot pronounce it"}`
  );
  const why = engineSpeaks(active, language)
    ? `you mapped ${name} to it`
    : `the ${active} engine cannot pronounce ${name}${profileEnginesFor(language).length === 0 ? ", and no engine speaks it in a cloned voice yet" : ""}`;
  vscode.window
    .showInformationMessage(
      `Claude Code TTS: ${name} is spoken by ${label}, because ${why}. Your selected voice speaks the other languages.`,
      "Change the voice for it"
    )
    .then((pick) => pick && setLanguageVoice());
}

/**
 * Claude answered in a language this engine cannot pronounce. Said once per
 * language, with the two ways out: an engine that speaks it, or a voice of
 * your own choosing for it.
 */
export async function notifyLanguageUnsupported(language: string): Promise<void> {
  const name = languageName(language);
  const engine = config().speechConfig.engine;
  const installed = await voiceLanguages();
  const suggestion = suggestEngineFor(language, installed);
  runtime.output.appendLine(`[language] ${name} detected; the ${engine} engine cannot pronounce it`);
  if (!suggestion || suggestion === engine) {
    vscode.window
      .showInformationMessage(
        profileEnginesFor(language).length
          ? `Claude Code TTS: this message is in ${name}, which no engine set up here pronounces. A system voice for ${name} (installed from your OS language settings) would fix it, or a voice of yours through ${profileEnginesFor(language).includes("qwen3") ? "Qwen3" : "Chatterbox"}.`
          : `Claude Code TTS: this message is in ${name}, which no engine set up here pronounces. A system voice for ${name} (installed from your OS language settings) would fix it; no cloned voice speaks ${name} yet.`,
        "Pick a voice for it"
      )
      .then((p) => {
        if (p === "Pick a voice for it") {
          void setLanguageVoice();
        }
      });
    return;
  }
  const voice = suggestion === "system" ? await systemVoiceFor(language) : undefined;
  const downloadable = curatedVoicesFor(language)[0];
  const how =
    suggestion === "piper-download"
      ? `A neural ${name} voice can be downloaded (${downloadable?.detail ?? "Piper"}, ${downloadable?.mb ?? 64} MB).`
      : suggestion === "system"
        ? `Your system voice ${voice ?? "for that language"} speaks it.`
        : suggestion === "qwen3"
          ? "Qwen3 speaks it."
          : suggestion === "chatterbox"
            ? "Chatterbox speaks it in a voice of yours."
            : "A Piper voice you installed speaks it.";
  const useIt =
    suggestion === "piper-download"
      ? `Download a ${name} voice`
      : suggestion === "chatterbox"
        ? "Use my own voice"
        : suggestion === "piper"
          ? "Use the Piper voice"
          : `Use ${voice ?? suggestion}`;
  const pick = await vscode.window.showInformationMessage(
    `Claude Code TTS: this message is in ${name}, which the ${engine} engine does not pronounce correctly. ${how}`,
    useIt,
    "Pick a voice for it",
    "Not now"
  );
  if (pick === useIt) {
    const c = vscode.workspace.getConfiguration("claudeCodeTts");
    if (suggestion === "piper-download") {
      await downloadVoiceForLanguage(language);
    } else if (suggestion === "system" && voice) {
      // Map it for this language rather than switching wholesale: English
      // keeps the voice you chose for it.
      await c.update(
        "languageVoices",
        { ...config().speechConfig.languageVoices, [language]: { engine: "system", voice } },
        vscode.ConfigurationTarget.Global
      );
      runtime.speech?.enqueue(`${languageName(language)} will be spoken by ${voice}.`);
    } else if (suggestion === "qwen3") {
      await setupQwen3Flow();
    } else if (suggestion === "chatterbox") {
      // Map the language to a profile through Chatterbox, keeping the
      // engine you chose for everything else.
      const profiles = listQwen3Clones(qwen3VoicesDir(runtime.context.globalStorageUri.fsPath));
      const chosen = config().speechConfig.chatterboxVoice;
      const voice = profiles.some((p) => `clone:${p.slug}` === chosen) ? chosen : `clone:${profiles[0].slug}`;
      await c.update(
        "languageVoices",
        { ...config().speechConfig.languageVoices, [language]: { engine: "chatterbox", voice } },
        vscode.ConfigurationTarget.Global
      );
      runtime.speech?.enqueue(`${languageName(language)} will be spoken in your own voice.`);
    } else {
      // A Piper voice for this language is installed: map it, keeping the
      // engine you chose for everything else.
      const model = listPiperVoices(piperVoicesDir(runtime.context.globalStorageUri.fsPath)).find(
        (v) => piperVoiceLanguage(v.name) === language
      )?.modelPath;
      if (!model) {
        return void (await setLanguageVoice());
      }
      await c.update(
        "languageVoices",
        { ...config().speechConfig.languageVoices, [language]: { engine: "piper", voice: model } },
        vscode.ConfigurationTarget.Global
      );
      runtime.speech?.enqueue(`${languageName(language)} will be spoken by the Piper voice.`);
    }
  } else if (pick === "Pick a voice for it") {
    await setLanguageVoice();
  }
}

/**
 * Install the offline translation runtime and the model for the language you
 * want to hear, then turn the setting on. Everything stays local; the model
 * download is the only network step and it is stated before it happens.
 */
export async function setupTranslationFlow(back = false): Promise<MenuOutcome> {
  // Translating into a language nothing here can pronounce is pointless, so
  // each option says whether the current setup can speak it, and with what.
  const CODES = TRANSLATION_LANGUAGES;
  const engine = config().speechConfig.engine;
  const installed = await voiceLanguages();
  const mapped = config().speechConfig.languageVoices ?? {};
  // What each row would actually do if you picked it, including the voice.
  const choiceFor = await voiceChoices();
  const describe = async (code: string): Promise<string> => {
    if (mapped[code]) {
      return `spoken by ${mappedVoiceName(mapped[code])}, which you mapped for it`;
    }
    const choice = choiceFor(code);
    if (choice.kind === "already") {
      return "the voice you are using says it";
    }
    if (choice.kind === "switch") {
      return `the voice becomes ${choice.name}, which says it`;
    }
    const other = suggestEngineFor(code, installed);
    if (other === "system") {
      const voice = (await listSystemVoices()).find((v) => v.language === code)?.name;
      return `needs a voice change: your system voice ${voice ?? "for it"} speaks it`;
    }
    if (other) {
      return `needs a voice change: the ${other} engine speaks it`;
    }
    return "nothing set up here pronounces it yet";
  };
  const items = [
    { label: "$(circle-slash) Off", detail: "Speak each message in the language it was written in", code: "" },
    ...(await Promise.all(
      CODES.map(async (code) => ({
        label: languageName(code),
        description: mapped[code] || choiceFor(code).kind !== "none" ? "ready" : "",
        detail: `Translate everything into ${languageName(code)}; ${await describe(code)}`,
        code,
      }))
    )),
  ];
  const target = await pickWithBack(
    items,
    {
      placeHolder: "Which language should Claude Code TTS speak?",
      title: `Spoken language (engine: ${engine})`,
      matchOnDetail: true,
    },
    back
  );
  if (target === "back") {
    return "back";
  }
  if (!target) {
    return "closed";
  }
  const c = vscode.workspace.getConfiguration("claudeCodeTts");
  if (!target.code) {
    await c.update("speakLanguage", "", vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage("Claude Code TTS: speaking each message in its own language again.");
    return "ran";
  }

  if (!(await ensureTranslationInto(target.code, true))) {
    return "ran";
  }
  // A voice of your own built for that language answers the "which voice
  // says it" question outright, and moving to the engine that pronounces it
  // is the same one step: that pair of menus (a language here, a voice
  // there, an engine somewhere else) is what made this confusing.
  // Choosing a language is choosing a voice for it: doing only the first left
  // German text read aloud by an English voice, and the voice was a second
  // menu away. What costs nothing to apply is applied here and said out loud,
  // and "Select Voice" overrides it like any other choice.
  const CHANGE = "Use a different voice";
  const spoken = (name: string): Promise<MenuOutcome> => {
    void vscode.window
      .showInformationMessage(
        `Claude Code TTS: everything will be spoken in ${languageName(target.code)}, by ${name}.`,
        CHANGE
      )
      .then((pick) => (pick === CHANGE ? vscode.commands.executeCommand("claudeCodeTts.selectVoice") : undefined));
    runtime.speech?.enqueue(SAMPLES[target.code] ?? `This is your voice speaking ${languageName(target.code)}.`);
    return Promise.resolve("ran" as MenuOutcome);
  };

  // A voice you made for this language is the answer to "which voice", so it
  // is taken when the engine that speaks it is already installed. When it
  // would mean a download, it stays an offer.
  const own = listQwen3Clones(qwen3VoicesDir(runtime.storagePath)).find((p) => p.language === target.code);
  if (own && `clone:${own.slug}` !== currentProfileVoice()) {
    const cfg = config().speechConfig;
    const plan = engineForProfileLanguage({
      codes: [target.code],
      qwen3Ready: resolveQwen3Runtime(cfg.qwen3Runtime) !== undefined,
      chatterboxReady: chatterboxReady(runtime.storagePath),
    });
    const take =
      plan.installed ||
      (await vscode.window.showInformationMessage(
        `Claude Code TTS: "${own.name}" is your ${languageName(target.code)} voice, and the engine that speaks it is not installed yet. Set it up?`,
        "Set it up",
        "Not now"
      )) === "Set it up";
    if (take && (await useProfileWithEngineFor(`clone:${own.slug}`, target.code))) {
      const outcome = await spoken(`"${own.name}"`);
      await suggestQwen3For(target.code);
      return outcome;
    }
  }

  if (mapped[target.code]) {
    return spoken(mappedVoiceName(mapped[target.code]));
  }
  // The engine in use may speak the language while the voice in use does not:
  // system and Piper voices each say one language.
  const choice = choiceFor(target.code);
  if (choice.kind === "switch") {
    await c.update(choice.setting, choice.value, vscode.ConfigurationTarget.Global);
    return spoken(choice.name);
  }
  if (choice.kind === "already") {
    vscode.window.showInformationMessage(`Claude Code TTS: everything will be spoken in ${languageName(target.code)}.`);
    runtime.speech?.enqueue(SAMPLES[target.code] ?? `This is your voice speaking ${languageName(target.code)}.`);
    await suggestQwen3For(target.code);
    return "ran";
  }
  const suggestion = suggestEngineFor(target.code, installed);
  const voice =
    suggestion === "system" ? (await listSystemVoices()).find((v) => v.language === target.code)?.name : undefined;
  const useIt = voice
    ? `Use ${voice}`
    : suggestion === "piper-download"
      ? `Download a ${languageName(target.code)} voice`
      : suggestion === "chatterbox"
        ? "Use my own voice"
        : suggestion === "piper"
          ? "Use the Piper voice"
          : suggestion === "qwen3"
            ? "Set up Qwen3"
            : undefined;
  const next = await vscode.window.showInformationMessage(
    `Claude Code TTS: translating into ${languageName(target.code)}, but the ${engine} engine does not pronounce it.` +
      (useIt ? "" : ` Pick or create a voice that speaks ${languageName(target.code)}.`),
    ...(useIt ? [useIt, "Pick a voice", "Later"] : ["Pick a voice", "Later"])
  );
  if (next === useIt && voice) {
    await c.update(
      "languageVoices",
      { ...mapped, [target.code]: { engine: "system", voice } },
      vscode.ConfigurationTarget.Global
    );
    runtime.speech?.enqueue(`${languageName(target.code)} will be spoken by ${voice}.`);
  } else if (next === useIt && suggestion === "qwen3") {
    await setupQwen3Flow();
  } else if (next === useIt && suggestion === "piper-download") {
    await downloadVoiceForLanguage(target.code);
  } else if (next === useIt && (suggestion === "chatterbox" || suggestion === "piper")) {
    const storage = runtime.context.globalStorageUri.fsPath;
    const mappedVoice =
      suggestion === "chatterbox"
        ? (() => {
            const profiles = listQwen3Clones(qwen3VoicesDir(storage));
            const chosen = config().speechConfig.chatterboxVoice;
            return profiles.some((p) => `clone:${p.slug}` === chosen) ? chosen : `clone:${profiles[0].slug}`;
          })()
        : listPiperVoices(piperVoicesDir(storage)).find((v) => piperVoiceLanguage(v.name) === target.code)?.modelPath;
    if (!mappedVoice) {
      return setLanguageVoice(back);
    }
    await c.update(
      "languageVoices",
      { ...mapped, [target.code]: { engine: suggestion, voice: mappedVoice } },
      vscode.ConfigurationTarget.Global
    );
    runtime.speech?.enqueue(
      `${languageName(target.code)} will be spoken ${suggestion === "chatterbox" ? "in your own voice" : "by the Piper voice"}.`
    );
  } else if (next === "Pick a voice") {
    await setLanguageVoice();
  }
  return "ran";
}

export async function setLanguageVoice(back = false): Promise<MenuOutcome> {
  for (;;) {
    const outcome = await setLanguageVoiceOnce(back);
    if (outcome !== "ran") {
      return outcome;
    }
  }
}

async function setLanguageVoiceOnce(back: boolean): Promise<MenuOutcome> {
  const cfg = config();
  const engine = cfg.speechConfig.engine;
  const current = cfg.speechConfig.languageVoices ?? {};
  const CODES = TRANSLATION_LANGUAGES;
  const installed = await voiceLanguages();
  const language = await pickWithBack(
    CODES.map((code) => ({
      label: languageName(code),
      description: current[code]
        ? mappedVoiceName(current[code])
        : enginePronounces(engine, code, installed)
          ? ""
          : "not spoken by this engine",
      detail: current[code]
        ? "mapped"
        : enginePronounces(engine, code, installed)
          ? `Text detected as ${languageName(code)} uses the configured voice`
          : `The ${engine} engine cannot pronounce ${languageName(code)}; pick a voice that can`,
      code,
    })),
    {
      placeHolder: "Which language should get its own voice?",
      title: `Voice per language (engine: ${engine})`,
      matchOnDetail: true,
    },
    back
  );
  if (language === "back") {
    return "back";
  }
  if (!language) {
    return "closed";
  }

  const CLEAR = "$(circle-slash) Use the configured voice";
  const DESIGN_HERE = "$(wand) Design a voice for this language...";
  const name = languageName(language.code);
  const storage = runtime.context.globalStorageUri.fsPath;
  type Item = { label: string; value?: string; detail?: string; engine?: SpeechConfig["engine"]; inVoice?: string };
  /** The cloned voice that a Piper utterance could be re-voiced into, when that is possible here. */
  const reVoice = ((): string | undefined => {
    const active =
      engine === "chatterbox"
        ? cfg.speechConfig.chatterboxVoice
        : engine === "qwen3"
          ? cfg.speechConfig.voice
          : cfg.speechConfig.chatterboxVoice;
    const usable =
      isCloneVoice(active) && listQwen3Clones(qwen3VoicesDir(storage)).some((p) => `clone:${p.slug}` === active);
    return usable && resolveChatterboxRuntime(storage) === "mlx" ? active : undefined;
  })();
  // `engine` lets an item be owned by another engine than the active one: a
  // language the active engine cannot pronounce has to be mapped to one that
  // can, and the mapping then routes to that engine's backend.
  const voices: Item[] = [{ label: CLEAR, detail: "Remove the mapping for this language" }];

  /** Your voice profiles, split into those built in this language and the rest. */
  const profileItems = (owner: "qwen3" | "chatterbox"): { native: Item[]; accented: Item[] } => {
    const clones = listQwen3Clones(qwen3VoicesDir(storage));
    const via = owner === engine ? "" : ` (through ${owner === "qwen3" ? "Qwen3" : "Chatterbox"})`;
    const item = (c: CloneProfile, detail: string): Item => ({
      label: `${c.designed ? "$(wand)" : "$(person)"} ${c.name}`,
      value: `clone:${c.slug}`,
      engine: owner,
      detail,
    });
    return {
      native: clones
        .filter((c) => (c.language ?? "en") === language.code)
        .map((c) => item(c, `Your ${name} voice${via}`)),
      accented: clones
        .filter((c) => (c.language ?? "en") !== language.code)
        .map((c) => item(c, `Your ${languageName(c.language ?? "en")} voice, speaking ${name} with that accent${via}`)),
    };
  };
  /** Installed Piper voices for the language, then the curated ones to download. */
  const piperItems = (): Item[] => {
    const installedVoices = listPiperVoices(piperVoicesDir(storage));
    const forLang = installedVoices.filter((v) => piperVoiceLanguage(v.name) === language.code);
    const items: Item[] = [];
    for (const v of forLang) {
      if (reVoice) {
        // Piper reads it, Chatterbox re-voices it: the words of a voice that
        // speaks the language, in the timbre of the user's own.
        items.push({
          label: `$(person) ${profileName(reVoice)} (${v.name}, re-voiced)`,
          value: v.modelPath,
          engine: "piper" as const,
          inVoice: reVoice,
          detail: `${name} read by ${v.name} and re-voiced as ${profileName(reVoice)}: your voice, its pronunciation`,
        });
      }
      items.push({
        label: v.name,
        value: v.modelPath,
        engine: "piper" as const,
        detail: `Neural ${name} voice (Piper)`,
      });
    }
    for (const v of curatedVoicesFor(language.code)) {
      if (installedVoices.some((i) => i.name === v.id)) {
        continue;
      }
      items.push({ label: `$(cloud-download) ${v.id}`, detail: `${v.detail} - ${v.mb} MB download` });
    }
    return items;
  };
  const systemItems = async (): Promise<Item[]> =>
    (await listSystemVoices())
      .filter((v) => v.language === language.code)
      .map((v) => ({ label: v.name, value: v.name, engine: "system" as const, detail: `System ${name} voice` }));

  const owners = profileEnginesFor(language.code);
  if (!enginePronounces(engine, language.code, installed)) {
    // The active engine cannot say this language. Offer everything here that
    // can, your own voice first when a cloning engine that speaks it is set up.
    if (owners.includes("chatterbox") && installed.chatterbox) {
      const p = profileItems("chatterbox");
      voices.push(...p.native, ...p.accented);
    } else if (owners.includes("qwen3") && installed.qwen3) {
      const p = profileItems("qwen3");
      voices.push(...p.native, ...p.accented);
    }
    voices.push(...piperItems(), ...(await systemItems()));
    if (owners.includes("chatterbox") && listQwen3Clones(qwen3VoicesDir(storage)).length === 0) {
      voices.push({
        label: DESIGN_HERE,
        detail: `Chatterbox speaks ${name} in a voice you create${installed.chatterbox ? "" : " (it needs setting up first)"}`,
      });
    }
    if (voices.length === 1) {
      voices.push({
        label: "$(info) Nothing installed here speaks this language",
        detail:
          process.platform === "darwin"
            ? "Add a system voice in System Settings > Accessibility > Spoken Content > System Voice > Manage Voices"
            : "Install a voice for this language in your operating system's speech settings",
      });
    }
  } else if (engine === "kokoro") {
    voices.push(
      ...kokoroSpeakers(kokoroDirOf(runtime.context)).map((s) => ({ label: s.name, value: s.name, detail: s.detail }))
    );
  } else if (engine === "piper") {
    const installedVoices = listPiperVoices(piperVoicesDir(storage));
    voices.push(
      ...installedVoices
        .filter((v) => piperVoiceLanguage(v.name) === language.code)
        .map((v) => ({ label: v.name, value: v.modelPath, detail: `Speaks ${name}` })),
      ...installedVoices
        .filter((v) => piperVoiceLanguage(v.name) !== language.code)
        .map((v) => ({ label: v.name, value: v.modelPath, detail: v.modelPath }))
    );
    for (const v of curatedVoicesFor(language.code)) {
      if (installedVoices.some((i) => i.name === v.id)) {
        continue;
      }
      voices.push({ label: `$(cloud-download) ${v.id}`, detail: `${v.detail} - ${v.mb} MB download` });
    }
  } else if (engine === "chatterbox" || engine === "qwen3") {
    // Voices built in this language come first: they are the ones that sound
    // native. Qwen3 also has presets, which speak it with their own accent.
    const p = profileItems(engine);
    voices.push(...p.native);
    if (engine === "qwen3") {
      voices.push(
        ...QWEN3_SPEAKERS.map((sp) => ({
          label: sp.name,
          value: sp.name,
          detail: `${sp.detail}. Speaks ${name} with its own accent`,
        }))
      );
    }
    voices.push(...p.accented);
    if (p.native.length === 0) {
      voices.push({
        label: DESIGN_HERE,
        detail:
          engine === "chatterbox" && p.accented.length === 0
            ? `Chatterbox speaks ${name}, but only in a voice you create`
            : `No voice of yours speaks ${name} natively yet; create one that does`,
      });
    }
  } else {
    const system = await listSystemVoices();
    // The OS knows which language each voice speaks: those come first.
    const matching = system.filter((v) => v.language === language.code);
    const rest = system.filter((v) => v.language !== language.code);
    voices.push(
      ...[...matching, ...rest].map((v) => ({
        label: v.name,
        value: v.name,
        detail:
          v.language === language.code
            ? `Speaks ${name} natively. ${v.detail ?? ""}`
            : `${v.detail ?? ""} - not a ${name} voice`,
      }))
    );
    if (matching.length === 0) {
      voices.push({
        label: "$(info) No system voice for this language is installed",
        detail:
          process.platform === "darwin"
            ? "Add one in System Settings > Accessibility > Spoken Content > System Voice > Manage Voices"
            : "Install a voice for this language in your operating system's speech settings",
      });
    }
  }

  const c = vscode.workspace.getConfiguration("claudeCodeTts");
  /** Record the mapping, confirm it, and let the language be heard right away. */
  const mapTo = async (
    owner: SpeechConfig["engine"],
    voice: string,
    label: string,
    inVoice?: string
  ): Promise<void> => {
    await c.update(
      "languageVoices",
      { ...current, [language.code]: { engine: owner, voice, ...(inVoice ? { inVoice } : {}) } },
      vscode.ConfigurationTarget.Global
    );
    vscode.window.setStatusBarMessage(`Claude Code TTS: ${name} will be spoken by ${label}`, 4000);
    runtime.speech?.enqueue(SAMPLES[language.code] ?? `This is the ${label} voice.`);
  };
  return livePreviewPicker({
    items: voices,
    placeholder: `Voice for ${name} (highlight to hear it; Enter selects)`,
    title: `${name}: which voice reads it`,
    back: true, // the list of languages is behind this one
    matchOnDetail: true,
    sample: (item) =>
      item.value
        ? {
            text: SAMPLES[language.code] ?? `This is the ${item.label} voice.`,
            voice: item.value,
            engine: item.engine,
            inVoice: item.inVoice,
          }
        : undefined,
    accept: async (item) => {
      // Advice, not a choice
      if (item.label.startsWith("$(info)")) {
        return;
      }
      if (item.label.startsWith("$(cloud-download) ")) {
        await downloadVoiceForLanguage(language.code);
        return;
      }
      if (item.label === DESIGN_HERE) {
        watchModelDownload(); // it fetches its own model, and that is a wait worth showing
        const value = await designVoiceFlow(
          runtime.context,
          config().speechConfig.volume,
          language.code,
          prepareTextFor
        );
        // Cancelled, or explained why it cannot be done
        if (!value) {
          return;
        }
        // The new profile is mapped to this language through an engine that
        // speaks it, and, on a cloning engine that had no usable voice, made
        // its voice too, so the engine is not left mute with a profile on disk.
        const owner: SpeechConfig["engine"] = owners.includes(engine as "qwen3" | "chatterbox")
          ? engine
          : owners.includes("chatterbox")
            ? "chatterbox"
            : "qwen3";
        const profileName =
          listQwen3Clones(qwen3VoicesDir(storage)).find((p) => `clone:${p.slug}` === value)?.name ?? "your new voice";
        if (owner === engine) {
          // The engine in use speaks this language and now speaks it in this
          // voice, so a mapping would only be a second place to keep the same
          // answer, and the one that wins when they disagree.
          await activateVoiceProfile(value);
          runtime.speech?.enqueue(SAMPLES[language.code] ?? `This is your voice speaking ${name}.`);
          vscode.window.showInformationMessage(`Claude Code TTS: ${name} is read in "${profileName}" now.`);
          return;
        }
        await mapTo(owner, value, profileName);
        if (owner === "chatterbox" && !chatterboxReady(storage)) {
          const go = await vscode.window.showInformationMessage(
            `Claude Code TTS: ${name} is mapped to ${profileName} through Chatterbox, which is not set up yet.`,
            "Set up Chatterbox"
          );
          if (go) {
            await setupChatterboxFlow();
          }
        }
        return;
      }
      if (item.value) {
        await mapTo(item.engine ?? engine, item.value, item.label, item.inVoice);
        return;
      }
      const next = { ...current };
      delete next[language.code];
      await c.update("languageVoices", next, vscode.ConfigurationTarget.Global);
      vscode.window.setStatusBarMessage(`Claude Code TTS: ${name} uses the configured voice again`, 4000);
    },
  });
}
