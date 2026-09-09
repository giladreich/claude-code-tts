/**
 * The lists a voice is chosen from.
 *
 * One per engine, because each engine's voices come from somewhere else: a
 * pack on disk, a downloaded model, the operating system, or the profiles
 * you made. They share what matters: every row is auditioned as it is
 * highlighted, every list says which engine it belongs to and ends with the
 * way to change that, and a row that opens something else comes back to the
 * list afterwards.
 */
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { config, RATE_MAX, RATE_MIN, saveVoiceRate, voiceOf } from "../core/config";
import { kokoroDirOf, setupKokoro } from "../setup/kokoroSetup";
import { languageName } from "../language/language";
import { offerToSpeakProfileLanguage, suggestQwen3For } from "../voices/voiceOffers";
import { cacheName, hubDir, modelBytes } from "../platform/modelProgress";
import { runtime } from "../core/runtime";
import {
  currentRecommendation,
  downloadVoiceFlow,
  ensurePiper,
  offerChatterboxVoice,
  setupChatterboxFlow,
  setupKokoroFlow,
  setupQwen3Flow,
} from "../setup/setupFlows";
import { trackEngineReady } from "./statusBar";
import { chatterboxReady } from "../tts/chatterbox";
import { kokoroReady, kokoroSpeakers } from "../tts/kokoro";
import { listPiperVoices, piperVoicesDir } from "../tts/piper";
import {
  hfModelSnapshot,
  isCloneVoice,
  listQwen3Clones,
  QWEN3_SPEAKERS,
  qwen3Available,
  qwen3Checkpoint,
  qwen3VoicesDir,
  resolveQwen3Runtime,
} from "../tts/qwen3";
import { listSystemVoices } from "../tts/system";
import { BACK, MenuOutcome, inputWithBack, livePreviewPicker, pickWithBack } from "./prompts";
import { dropMappingCoveredBy, profileFor } from "../voices/voiceProfiles";

/** The rows every voice list ends with, and the flows they open. */
const DESIGN_VOICE = "$(wand) Design a new voice (describe it in words)...";
const MANAGE_VOICES = "$(organization) Manage my voices...";
const FILE_CLONE = "$(file-media) Clone my voice from an audio file...";

export async function selectEngine(back = false): Promise<MenuOutcome> {
  const current = config().speechConfig.engine;
  const recommended = currentRecommendation().engine;
  const mark = (id: string) => (current === id ? "current" : "");
  // Ordered by what someone should install, not by what is cheapest to
  // install: the two engines that can speak as a voice of your own come
  // first, and which of them leads depends on what this user listens to.
  const engines = [
    {
      label: "Qwen3-TTS",
      id: "qwen3",
      detail:
        "The most natural voice here, and the only one that can speak as a voice you record or design. Guided install, then it runs offline; on Apple Silicon it streams faster than realtime.",
    },
    {
      label: "Chatterbox",
      id: "chatterbox",
      detail:
        "Your own voice in 23 languages, a dozen of which no other engine here speaks. Guided install. Slower than realtime, so it speaks calmly to keep up.",
    },
    {
      label: "Kokoro",
      id: "kokoro",
      detail:
        "Natural fixed voices, fast, one guided ~360 MB download and no Python. It cannot speak as a voice of yours.",
    },
    {
      label: "System",
      id: "system",
      detail:
        "The voices this computer already has. Instant, no setup, and it sounds like a computer. This is what you hear until you install one of the others.",
    },
    {
      label: "Piper",
      id: "piper",
      detail:
        "Light neural voices for weak hardware, ~60 MB each. Needs the piper program and one downloaded voice file at a time.",
    },
  ];
  const ordered = [...engines].sort((a, b) => Number(b.id === recommended) - Number(a.id === recommended));
  const picked = await pickWithBack(
    ordered.map((e) => ({
      ...e,
      label: e.id === recommended ? `${e.label} (recommended)` : e.label,
      description: mark(e.id),
    })),
    { placeHolder: "Text-to-runtime.speech engine", title: `Engine (now: ${engineName()})`, matchOnDetail: true },
    back
  );
  if (picked === "back") {
    return "back";
  }
  if (!picked) {
    return "closed";
  }
  if (picked.id === current) {
    return "ran";
  }
  if (picked.id === "chatterbox" && chatterboxReady(runtime.context.globalStorageUri.fsPath)) {
    // Installed but possibly voiceless: this engine cannot fall back to a
    // built-in speaker, so landing on it without a profile is a mute engine.
    await vscode.workspace
      .getConfiguration("claudeCodeTts")
      .update("engine", "chatterbox", vscode.ConfigurationTarget.Global);
    trackEngineReady();
    await offerChatterboxVoice();
    return "ran";
  }
  if (picked.id === "chatterbox" && !chatterboxReady(runtime.context.globalStorageUri.fsPath)) {
    await setupChatterboxFlow();
    return "ran";
  }
  if (picked.id === "qwen3" && !qwen3Available()) {
    await setupQwen3Flow(); // guided install, then switches the engine itself
    return "ran";
  }
  if (picked.id === "piper") {
    // Engine unchanged until piper actually works
    if (!(await ensurePiper())) {
      return "ran";
    }
    if (
      config().speechConfig.voice === "" &&
      listPiperVoices(piperVoicesDir(runtime.context.globalStorageUri.fsPath)).length === 0
    ) {
      await downloadVoiceFlow(); // also sets engine on success
      return "ran";
    }
  }
  if (picked.id === "kokoro" && !kokoroReady(kokoroDirOf(runtime.context))) {
    // Engine unchanged until ready
    if (!(await setupKokoro(runtime.context))) {
      return "ran";
    }
  }
  await vscode.workspace
    .getConfiguration("claudeCodeTts")
    .update("engine", picked.id, vscode.ConfigurationTarget.Global);
  runtime.speech?.enqueue(`Switched to the ${picked.label.split(" ")[0]} engine.`);
  return "ran";
}

/**
 * A recording of a preset speaker, shipped with the extension.
 *
 * The model that speaks the presets is gigabytes, and it is not downloaded
 * until somebody picks one of them, which left the picker unable to play the
 * very voices it was asking about. These are the same nine sentences the
 * picker would have synthesized, rendered once (Qwen3-TTS, Apache-2.0).
 */
export function presetSampleFile(voice: string): string | undefined {
  const file = path.join(runtime.context.extensionPath, "assets", "voice-samples", `${voice.toLowerCase()}.wav`);
  return fs.existsSync(file) ? file : undefined;
}

export async function selectKokoroVoice(back = false): Promise<MenuOutcome> {
  if (!kokoroReady(kokoroDirOf(runtime.context))) {
    await setupKokoroFlow();
    return back ? "back" : "closed";
  }
  const current = config().speechConfig.voice;
  let reopen = false;
  const outcome = await livePreviewPicker({
    items: [
      { label: "Voices", kind: vscode.QuickPickItemKind.Separator },
      ...kokoroSpeakers(kokoroDirOf(runtime.context)).map((s) => ({
        label: s.name,
        description: s.name === current ? "current" : "",
        detail: s.detail,
      })),
      ...engineRow(),
    ],
    placeholder: "Highlight a voice to hear it; Enter selects",
    title: voicePickerTitle(),
    back,
    sample: (item) =>
      item.label === SWITCH_ENGINE
        ? undefined
        : { text: `This is the ${spoken(item.label)} voice.`, voice: item.label },
    accept: async (item) => {
      if (item.label === SWITCH_ENGINE) {
        reopen = true;
        await selectEngine(true);
        return;
      }
      await vscode.workspace
        .getConfiguration("claudeCodeTts")
        .update("kokoro.voice", item.label, vscode.ConfigurationTarget.Global);
      runtime.speech?.enqueue(`This is the ${spoken(item.label)} voice.`);
    },
  });
  // Back from what that row opened belongs in the voice list, not in the
  // menu above it; the engine may have changed, so the dispatcher decides
  // which list that is.
  return reopen ? selectVoice(back) : outcome;
}

export async function selectPiperVoice(back = false): Promise<MenuOutcome> {
  const voices = listPiperVoices(piperVoicesDir(runtime.context.globalStorageUri.fsPath));
  const current = config().speechConfig.voice;
  let reopen = false;
  const outcome = await livePreviewPicker({
    items: [
      { label: "Voices", kind: vscode.QuickPickItemKind.Separator },
      ...voices.map((v) => ({
        label: v.name,
        description: v.modelPath === current ? "current" : "",
        detail: v.modelPath,
      })),
      { label: "Add", kind: vscode.QuickPickItemKind.Separator },
      { label: DOWNLOAD_PIPER, detail: "Fetch a curated voice model from Hugging Face (~60-115 MB, cached locally)" },
      ...engineRow(),
    ],
    placeholder: "Highlight a voice to hear it; Enter selects",
    title: voicePickerTitle(),
    back,
    sample: (item) =>
      item.label === DOWNLOAD_PIPER || item.label === SWITCH_ENGINE || !item.detail
        ? undefined
        : { text: `This is the ${item.label} voice.`, voice: item.detail },
    accept: async (item) => {
      if (item.label === SWITCH_ENGINE || item.label === DOWNLOAD_PIPER) {
        reopen = true;
        await (item.label === SWITCH_ENGINE ? selectEngine(true) : downloadVoiceFlow());
        return;
      }
      if (!item.detail) {
        return;
      }
      await vscode.workspace
        .getConfiguration("claudeCodeTts")
        .update("piper.voice", item.detail, vscode.ConfigurationTarget.Global);
      runtime.speech?.enqueue(`This is the ${item.label} voice.`);
    },
  });
  return reopen ? selectVoice(back) : outcome;
}

/**
 * Chatterbox speaks only in a cloned or designed voice: the MLX v3 checkpoint
 * ships no built-in speaker (no conds file), so a profile is required rather
 * than optional. Offer the profiles, and a way to make one when there are none.
 */
export async function selectChatterboxVoice(back = false): Promise<MenuOutcome> {
  const current = config().speechConfig.chatterboxVoice;
  const clones = listQwen3Clones(qwen3VoicesDir(runtime.context.globalStorageUri.fsPath));

  interface Item extends vscode.QuickPickItem {
    value?: string;
  }
  const items: Item[] = [
    { label: "Your voices", kind: vscode.QuickPickItemKind.Separator },
    ...clones.map((c) => ({
      label: `${c.designed ? "$(wand)" : "$(person)"} ${c.name}`,
      value: `clone:${c.slug}`,
      description: `clone:${c.slug}` === current ? "current" : c.designed ? "designed voice" : "cloned voice",
      detail: `${languageName(c.language ?? "en")} accent. Chatterbox speaks its 23 languages in this voice.`,
    })),
    { label: "Make a voice", kind: vscode.QuickPickItemKind.Separator },
    { label: DESIGN_VOICE, detail: "Pick or write a description; a reusable voice profile is rendered locally" },
    { label: RECORD_CLONE, detail: "Read a short passage (~10s); a reusable voice profile of you is created locally" },
    { label: FILE_CLONE, detail: "Use a recording you already have; the clearest ~10s stretch is picked locally" },
    ...(engineRow() as Item[]),
  ];
  let reopen = false;
  const outcome = await livePreviewPicker<Item>({
    items,
    placeholder: clones.length
      ? "Highlight a voice to hear it. Chatterbox needs one of these: it has no built-in voice"
      : "Chatterbox has no built-in voice. Create one to use this engine",
    title: voicePickerTitle(),
    back,
    debounceMs: 400,
    sample: (item) => (item.value ? { text: "This is your cloned voice speaking.", voice: item.value } : undefined),
    accept: async (item) => {
      const byLabel: Record<string, string> = {
        [RECORD_CLONE]: "claudeCodeTts.cloneVoice",
        [FILE_CLONE]: "claudeCodeTts.cloneVoiceFromFile",
        [DESIGN_VOICE]: "claudeCodeTts.designVoice",
      };
      if (item.label === SWITCH_ENGINE) {
        reopen = true;
        await selectEngine(true);
        return;
      }
      const command = byLabel[item.label];
      if (command) {
        reopen = true; // making or managing a voice comes back to this list
        await vscode.commands.executeCommand(command, true);
        return;
      }
      if (!item.value) {
        return;
      }
      await vscode.workspace
        .getConfiguration("claudeCodeTts")
        .update("chatterbox.voice", item.value, vscode.ConfigurationTarget.Global);
      await dropMappingCoveredBy(item.value, "chatterbox");
      if (await offerToSpeakProfileLanguage(item.value)) {
        return;
      }
      runtime.speech?.enqueue("This is your cloned voice speaking.");
      await suggestQwen3For(profileFor(item.value)?.language ?? config().speechConfig.speakLanguage ?? "en");
    },
  });
  return reopen ? selectVoice(back) : outcome;
}

export async function selectQwen3Voice(back = false): Promise<MenuOutcome> {
  const current = config().speechConfig.voice;
  const currentIsClone = isCloneVoice(current);
  const clones = listQwen3Clones(qwen3VoicesDir(runtime.context.globalStorageUri.fsPath));
  // Presets and voices of your own live in different checkpoints. Auditioning
  // across that line loads the other one, which is only offered when it is
  // already here: a keypress must not start a download. "Here" is asked the
  // way the engine asks it (a usable snapshot, not merely bytes on disk), or
  // the list promises a preview the engine then refuses.
  const { qwen3Model, qwen3Runtime } = config().speechConfig;
  const modelRuntime = resolveQwen3Runtime(qwen3Runtime) === "torch" ? "torch" : "mlx";
  const ready = (clone: boolean) =>
    hfModelSnapshot(qwen3Checkpoint({ voice: "", clone, modelSize: qwen3Model, runtime: modelRuntime })) !== undefined;
  const presetsReady = ready(false);
  const clonesReady = ready(true);
  const download = qwen3Model === "1.7B" ? "~4.2 GB" : "~2.3 GB";

  interface Item extends vscode.QuickPickItem {
    value?: string; // preset name or clone:<slug>
  }
  const items: Item[] = [
    ...(clones.length ? [{ label: "Your voices", kind: vscode.QuickPickItemKind.Separator } as Item] : []),
    ...clones.map((c) => ({
      label: `${c.designed ? "$(wand)" : "$(person)"} ${c.name}`,
      value: `clone:${c.slug}`,
      description: `clone:${c.slug}` === current ? "current" : c.designed ? "designed voice" : "cloned voice",
      detail:
        `${languageName(c.language ?? "en")}. ` +
        (c.designed && c.description
          ? c.description.slice(0, 80)
          : c.refSeconds > 15
            ? `${Math.round(c.refSeconds)}s reference: too long for a clean clone - re-record (new ~10s passage)`
            : !c.usedTranscript && !c.textSource
              ? "Made before the reference text was checked against the audio; if this voice says stray words, re-record it"
              : `${Math.round(c.refSeconds)}s reference`),
    })),
    { label: "Built-in voices", kind: vscode.QuickPickItemKind.Separator },
    ...QWEN3_SPEAKERS.map((s) => ({
      label: s.name,
      value: s.name,
      description: s.name === current ? "current" : "",
      detail: !currentIsClone
        ? s.detail
        : presetsReady
          ? `${s.detail} - first preview loads the preset model (~15s)`
          : `${s.detail} - sample recording; selecting it downloads the preset model (${download}, once)`,
    })),
    { label: "Make a voice", kind: vscode.QuickPickItemKind.Separator },
    {
      label: DESIGN_VOICE,
      detail: "Pick or write a description (e.g. warm American woman); a reusable voice profile is rendered locally",
    },
    { label: MANAGE_VOICES, detail: "Audition, refine from a request, adjust loudness/pace, rename, delete" },
    { label: RECORD_CLONE, detail: "Read a short passage (~10s); a reusable voice profile of you is created locally" },
    {
      label: FILE_CLONE,
      detail: "Use a recording you already have; the clearest ~10s stretch is picked and transcribed locally",
    },
    ...(engineRow() as Item[]),
  ];
  let reopen = false;
  const outcome = await livePreviewPicker<Item>({
    items,
    placeholder: "Highlight a voice to hear it (arrow keys or type to filter); Enter selects",
    title: voicePickerTitle(),
    back,
    // Longer than the other pickers: crossing between presets and voices of
    // your own loads the other checkpoint, so arrowing quickly past one must
    // not start a model load it is about to abandon.
    debounceMs: 700,
    sample: (item) => {
      if (!item.value) {
        return undefined;
      }
      const clone = isCloneVoice(item.value);
      // A preset whose model is not here is still auditioned, from a
      // recording that ships with the extension: choosing a voice you cannot
      // hear is not choosing. Voices of your own have no such recording, so
      // those rows stay silent until their checkpoint is here.
      if (!(clone ? clonesReady : presetsReady)) {
        const file = clone ? undefined : presetSampleFile(item.value);
        return file ? { text: "", voice: item.value, file } : undefined;
      }
      return {
        text: `This is ${clone ? "your cloned" : `the ${spoken(item.value)}`} voice.`,
        voice: item.value,
      };
    },
    accept: async (item) => {
      const byLabel: Record<string, string> = {
        [RECORD_CLONE]: "claudeCodeTts.cloneVoice",
        [FILE_CLONE]: "claudeCodeTts.cloneVoiceFromFile",
        [DESIGN_VOICE]: "claudeCodeTts.designVoice",
        [MANAGE_VOICES]: "claudeCodeTts.manageVoices",
      };
      if (item.label === SWITCH_ENGINE) {
        reopen = true;
        await selectEngine(true);
        return;
      }
      const command = byLabel[item.label];
      if (command) {
        reopen = true; // making or managing a voice comes back to this list
        await vscode.commands.executeCommand(command, true);
        return;
      }
      if (!item.value) {
        return;
      }
      await vscode.workspace
        .getConfiguration("claudeCodeTts")
        .update("qwen3.voice", item.value, vscode.ConfigurationTarget.Global);
      await dropMappingCoveredBy(item.value, "qwen3");
      // A voice of your own is for a language, and this engine may not be
      // the one that speaks it: offered here as well as when it was made.
      if (isCloneVoice(item.value) && (await offerToSpeakProfileLanguage(item.value))) {
        return;
      }
      runtime.speech?.enqueue(
        item.value.startsWith("clone:")
          ? "This is your cloned voice speaking."
          : `This is the ${spoken(item.value)} voice.`
      );
    },
  });
  return reopen ? selectVoice(back) : outcome;
}

export async function selectVoice(back = false): Promise<MenuOutcome> {
  const engine = config().speechConfig.engine;
  if (engine === "piper") {
    return selectPiperVoice(back);
  }
  if (engine === "kokoro") {
    return selectKokoroVoice(back);
  }
  if (engine === "qwen3") {
    return selectQwen3Voice(back);
  }
  if (engine === "chatterbox") {
    return selectChatterboxVoice(back);
  }
  const voices = await listSystemVoices();
  if (voices.length === 0) {
    vscode.window.showWarningMessage("Claude Code TTS: could not list voices for this platform's TTS engine.");
    return back ? "back" : "closed";
  }
  const current = config().speechConfig.voice;
  const DEFAULT_VOICE = "(system default)";
  const nameOf = (item: vscode.QuickPickItem) => (item.label === DEFAULT_VOICE ? "" : item.label);
  const sampleFor = (name: string) => (name ? `This is the ${name} voice.` : "This is the system default voice.");
  let reopen = false;
  const outcome = await livePreviewPicker({
    items: [
      { label: "Voices", kind: vscode.QuickPickItemKind.Separator },
      { label: DEFAULT_VOICE, description: current === "" ? "current" : "" },
      ...voices.map((v) => ({
        label: v.name,
        description: v.name === current ? "current" : "",
        detail: v.detail,
      })),
      ...engineRow(),
    ],
    placeholder: "Highlight a voice to hear it (arrow keys or type to filter); Enter selects",
    title: voicePickerTitle(),
    back,
    matchOnDetail: true,
    sample: (item) =>
      item.label === SWITCH_ENGINE ? undefined : { text: sampleFor(nameOf(item)), voice: nameOf(item) },
    accept: async (item) => {
      if (item.label === SWITCH_ENGINE) {
        reopen = true;
        await selectEngine(true);
        return;
      }
      const name = nameOf(item);
      await vscode.workspace.getConfiguration("claudeCodeTts").update("voice", name, vscode.ConfigurationTarget.Global);
      runtime.speech?.enqueue(sampleFor(name));
    },
  });
  return reopen ? selectVoice(back) : outcome;
}

export async function selectRate(back = false): Promise<MenuOutcome> {
  const { voice, rate: current } = config().speechConfig;
  const CUSTOM = "Custom...";
  // What this engine can keep up with, so rates beyond it are marked rather
  // than silently capped.
  const sustainable = Math.round(runtime.speech?.audibleRate ? runtime.speech.audibleRate() : 0);
  return livePreviewPicker({
    title: "Speech rate",
    back,
    items: [
      ...[90, 120, 150, 180, 210, 240, 280, 320, 380, 440].map((r) => ({
        label: `${r} wpm`,
        description:
          r === current
            ? "current"
            : sustainable > 0 && r > sustainable + 5
              ? `beyond ${runtime.speech?.engineName}`
              : "",
        detail:
          r === 150
            ? "unhurried"
            : r === 210
              ? "a natural reading pace"
              : r === 280
                ? "brisk, still easy to follow"
                : r === 380
                  ? "skimming"
                  : undefined,
      })),
      { label: CUSTOM, description: `enter a number (${RATE_MIN}-${RATE_MAX})` },
    ],
    placeholder:
      sustainable > 0 && sustainable < 400
        ? `Highlight a rate to hear it (current ${current} wpm; ${runtime.speech?.engineName} sustains about ${sustainable})`
        : `Highlight a rate to hear it; Enter selects (current: ${current} wpm)`,
    sample: (item) =>
      item.label === CUSTOM
        ? undefined
        : {
            text: `${parseInt(item.label, 10)} words per minute sounds like this.`,
            voice,
            rate: parseInt(item.label, 10),
          },
    accept: async (item) => {
      let rate: number;
      if (item.label === CUSTOM) {
        const input = await inputWithBack(
          {
            prompt: `Base rate in words per minute (${RATE_MIN}-${RATE_MAX})`,
            title: "Speech rate",
            value: String(current),
            validateInput: (v) =>
              /^\d+$/.test(v) && +v >= RATE_MIN && +v <= RATE_MAX
                ? undefined
                : `Enter a number between ${RATE_MIN} and ${RATE_MAX}`,
          },
          true
        );
        if (!input || input === BACK) {
          return;
        }
        rate = +input;
      } else {
        rate = parseInt(item.label, 10);
      }
      await saveVoiceRate(rate);
      runtime.speech?.enqueue(`Speaking at ${rate} words per minute.`);
    },
  });
}

/**
 * Which checkpoint the expressive engine runs.
 *
 * It is the biggest quality-for-speed trade in the extension and the biggest
 * download, and it lived only in the settings editor, where the people it
 * matters to were never going to find it. Setup picks one to suit the
 * machine; this is how anyone changes their mind.
 */
export async function selectQwen3Model(back = false): Promise<MenuOutcome> {
  const { qwen3Model, qwen3Runtime } = config().speechConfig;
  const modelRuntime = resolveQwen3Runtime(qwen3Runtime) === "torch" ? "torch" : "mlx";
  // Presets and clones load different checkpoints of the same size, so the
  // "downloaded" mark has to name the one this voice will actually ask for.
  const variant = voiceOf(vscode.workspace.getConfiguration("claudeCodeTts"), "qwen3").startsWith("clone:")
    ? "Base"
    : "CustomVoice";
  const modelId = (size: string) =>
    modelRuntime === "mlx"
      ? `mlx-community/Qwen3-TTS-12Hz-${size}-${variant}-bf16`
      : `Qwen/Qwen3-TTS-12Hz-${size}-${variant}`;
  // A gigabyte of blobs means it is really there, not a stub or a half-fetch.
  const onDisk = (size: string) => modelBytes(hubDir(), cacheName(modelId(size))) > 1024 ** 3;
  const state = (size: string) =>
    qwen3Model === size ? "current" : onDisk(size) ? "downloaded" : `${size === "1.7B" ? "4.2" : "2.3"} GB to download`;

  const picked = await pickWithBack(
    [
      {
        label: "Smaller and faster",
        description: state("0.6B"),
        detail:
          "Runs ahead of realtime on Apple Silicon, so the speaking rate is yours to set and long answers keep up. 2.3 GB.",
        size: "0.6B",
      },
      {
        label: "Larger and more natural",
        description: state("1.7B"),
        detail:
          "Closer to the voice it is cloning. Slower than realtime on most machines (measured making 8 s of runtime.speech in 15 s), so it cannot be sped up past its natural pace. 4.2 GB.",
        size: "1.7B",
      },
    ],
    { placeHolder: "Which model speaks", title: `Voice model (now: ${qwen3Model})`, matchOnDetail: true },
    back
  );
  if (picked === "back") {
    return "back";
  }
  if (!picked) {
    return "closed";
  }
  if (picked.size === qwen3Model) {
    return "ran";
  }
  await vscode.workspace
    .getConfiguration("claudeCodeTts")
    .update("qwen3.model", picked.size, vscode.ConfigurationTarget.Global);
  if (!onDisk(picked.size)) {
    vscode.window.showInformationMessage(
      `Claude Code TTS: the ${picked.size} model downloads on the next sentence (${picked.size === "1.7B" ? "~4.2 GB" : "~2.3 GB"}, once). The status bar shows how far along it is.`
    );
  }
  runtime.speech?.enqueue(`This is the ${picked.size} model.`);
  return "ran";
}
const spoken = (name: string) => name.replace(/_/g, " ");

export const engineName = (): string => runtime.speech?.engineName ?? config().speechConfig.engine;
const voicePickerTitle = (): string => `Voice: ${engineName()} engine`;
const engineRow = (): vscode.QuickPickItem[] => [
  { label: "Engine", kind: vscode.QuickPickItemKind.Separator },
  { label: SWITCH_ENGINE, detail: `Now: ${engineName()}. Each engine has its own voices, speed and languages` },
];
/**
 * Every voice picker says which engine's voices it is showing and ends with
 * the way to change that: the engine decides what the list can contain, and
 * looking for a voice that is not in it is how someone learns their engine
 * is the wrong one. The row leads to the engine picker rather than repeating
 * it here.
 */
const SWITCH_ENGINE = "$(chip) Use a different engine...";
const DOWNLOAD_PIPER = "$(cloud-download) Download a new voice...";
const RECORD_CLONE = "$(mic) Record & clone my voice...";
