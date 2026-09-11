/**
 * Disk usage accounting and pruning. Local speech is not cheap on storage:
 * neural models are gigabytes and they are scattered (the extension's own
 * storage, the Hugging Face cache written by the Python runtimes, the
 * translation models' own directory, and the tool venvs). This module
 * measures all of it, marks what the current settings actually need, and
 * deletes only what is asked for.
 *
 * No vscode import: the scan is pure filesystem work, so it is unit-tested.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { uvToolsDir } from "./platform";

export type StorageCategory = "models" | "voices" | "helpers" | "logs" | "temp" | "external";

export interface StorageItem {
  id: string;
  label: string;
  detail: string;
  bytes: number;
  paths: string[];
  category: StorageCategory;
  /** The current settings need this; removing it means downloading again. */
  inUse: boolean;
  /** False for things this extension does not own (tool venvs): advice only. */
  removable: boolean;
  /** What it costs to get back, or how to remove it by hand. */
  hint: string;
}

export interface ScanOptions {
  storageDir: string;
  tmpDir?: string;
  /**
   * Hugging Face cache, extension versions and Argos data. Required, with no
   * default: this scanner reports what may be DELETED, and a caller that
   * forgot one of these used to fall back to the real home directory. A test
   * fixture that omitted `argosDir` deleted a developer's own translation
   * model. Callers pass defaultHfHome() and friends; the compiler now insists.
   */
  hfHome: string;
  /** The hub cache itself, when HF_HUB_CACHE moves it away from `<hfHome>/hub`. */
  hubDir?: string;
  extensionsDir: string;
  argosDir: string;
  /** Which Chatterbox runtime this machine resolves to, for the "in use" marks. */
  chatterboxRuntime?: "mlx" | "torch";
  /** uv tool root, for the advisory entries. */
  uvToolsDir?: string;
  /** Root of the extension's private uv (binary, tools, managed Python, cache). */
  privateUvDir?: string;
  engine: string;
  qwen3Model: string;
  qwen3Voice: string;
  piperVoice: string;
  kokoroVoice: string;
  /** Which Qwen3 runtime this machine resolves to, so only its checkpoints count as in use. */
  qwen3Runtime?: "mlx" | "torch";
  /** Target speaking language, so the translation models count as in use. */
  speakLanguage?: string;
}

/** Where these live when nothing overrides them. Never applied implicitly. */
export function defaultHfHome(): string {
  return process.env.HF_HOME ?? path.join(os.homedir(), ".cache", "huggingface");
}

export function defaultExtensionsDir(): string {
  return path.join(os.homedir(), ".vscode", "extensions");
}

export function defaultArgosDir(): string {
  return path.join(os.homedir(), ".local", "share", "argos-translate");
}

/**
 * Speech-recognition models this extension downloads itself: the English-only
 * one for English references, the multilingual one for every other language,
 * in the MLX build and the transformers build (assets/transcribe.py picks by
 * what the Python it runs in has). Other Whisper builds on the machine belong
 * to other tools.
 */
const OUR_WHISPER = [
  "mlx-community/whisper-small.en-asr-fp16",
  "mlx-community/whisper-small-asr-fp16",
  "openai/whisper-small.en",
  "openai/whisper-small",
];

/**
 * Chatterbox weights, per runtime. Nearly 6 GB between them and invisible to
 * this screen until now: the MLX and the PyTorch runtime each download their
 * own copy, so a machine that tried both keeps both forever.
 */
const CHATTERBOX_MODELS: Record<"mlx" | "torch", string[]> = {
  mlx: ["mlx-community/chatterbox-multilingual-v3"],
  torch: ["ResembleAI/chatterbox"],
};
const OUR_CHATTERBOX = [...CHATTERBOX_MODELS.mlx, ...CHATTERBOX_MODELS.torch];

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) {
    return `${(n / 1024 ** 3).toFixed(1)} GB`;
  }
  if (n >= 1024 ** 2) {
    return `${Math.round(n / 1024 ** 2)} MB`;
  }
  if (n >= 1024) {
    return `${Math.round(n / 1024)} KB`;
  }
  return `${n} B`;
}

/**
 * Recursive size in bytes; symlinks are counted as their own size, not
 * followed. Asynchronous on purpose: model caches hold tens of thousands of
 * files, and walking them synchronously froze the editor for over a second.
 */
export async function dirSize(p: string): Promise<number> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(p);
  } catch {
    return 0;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return stat.size;
  }
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(p, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const e of entries) {
    total += await dirSize(path.join(p, e.name));
  }
  return total;
}

const sumSizes = async (paths: string[]): Promise<number> => {
  let n = 0;
  for (const p of paths) {
    n += await dirSize(p);
  }
  return n;
};

const exists = (p: string) => {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
};

function hfHubDir(hfHome: string): string {
  return path.join(hfHome, "hub");
}

/** Hugging Face cache directory name -> model id. */
function modelIdOf(dirName: string): string {
  return dirName.replace(/^models--/, "").replace(/--/g, "/");
}

/** Model ids the current settings would load. */
export function activeModelIds(o: ScanOptions): string[] {
  if (o.engine !== "qwen3") {
    return [];
  }
  const size = o.qwen3Model === "1.7B" ? "1.7B" : "0.6B";
  const variant = o.qwen3Voice.startsWith("clone:") ? "Base" : "CustomVoice";
  const mlx = `mlx-community/Qwen3-TTS-12Hz-${size}-${variant}-bf16`;
  const torch = `Qwen/Qwen3-TTS-12Hz-${size}-${variant}`;
  // Only the runtime that actually runs here loads its checkpoint; the other
  // one's copy is dead weight, and saying so is the point of this screen.
  if (o.qwen3Runtime === "mlx") {
    return [mlx];
  }
  if (o.qwen3Runtime === "torch") {
    return [torch];
  }
  return [mlx, torch];
}

export async function scanStorage(o: ScanOptions): Promise<StorageItem[]> {
  const items: StorageItem[] = [];
  const add = (i: StorageItem) => {
    if (i.bytes > 0) {
      items.push(i);
    }
  };

  // --- Kokoro runtime and models (extension storage)
  const kokoro = path.join(o.storageDir, "kokoro");
  for (const name of safeList(kokoro)) {
    const full = path.join(kokoro, name);
    const isRuntime = name.startsWith("sherpa-onnx");
    const isLegacy = /v0_19/.test(name);
    add({
      id: `kokoro:${name}`,
      label: isRuntime ? "Kokoro runtime (sherpa-onnx)" : `Kokoro model ${name}`,
      detail: isLegacy
        ? "Older model kept from a previous version; nothing uses it"
        : o.engine === "kokoro"
          ? 'Downloaded by "Set Up Kokoro Engine"'
          : `Kokoro is set up but the active engine is ${o.engine}`,
      bytes: await dirSize(full),
      paths: [full],
      category: "models",
      inUse: o.engine === "kokoro" && !isLegacy,
      removable: true,
      hint: isLegacy ? "Safe to remove" : 'Re-downloaded by "Set Up Kokoro Engine"',
    });
  }

  // --- Piper voices
  const piperDir = path.join(o.storageDir, "piper-voices");
  for (const f of safeList(piperDir).filter((f) => f.endsWith(".onnx"))) {
    const full = path.join(piperDir, f);
    const paths = [full, `${full}.json`].filter(exists);
    add({
      id: `piper:${f}`,
      label: `Piper voice ${f.replace(/\.onnx$/, "")}`,
      detail:
        o.engine === "piper"
          ? "Voice model downloaded from Hugging Face"
          : `Piper voice; the active engine is ${o.engine}`,
      bytes: await sumSizes(paths),
      paths,
      category: "models",
      inUse: o.engine === "piper" && o.piperVoice === full,
      removable: true,
      hint: 'Re-downloaded by "Download Piper Voice"',
    });
  }

  // --- Hugging Face cache (Qwen3 and Whisper), written by the Python runtimes
  const hub = o.hubDir ?? hfHubDir(o.hfHome);
  const active = new Set(activeModelIds(o));
  for (const name of safeList(hub).filter((n) => n.startsWith("models--"))) {
    const id = modelIdOf(name);
    const isTts = /Qwen3-TTS/i.test(id);
    const isWhisper = OUR_WHISPER.includes(id); // other Whisper builds belong to other tools
    const isChatterbox = OUR_CHATTERBOX.includes(id);
    if (!isTts && !isWhisper && !isChatterbox) {
      continue;
    }
    const full = path.join(hub, name);
    add({
      id: `hf:${name}`,
      label: id,
      detail: isChatterbox
        ? `Chatterbox weights for the ${CHATTERBOX_MODELS.mlx.includes(id) ? "MLX" : "PyTorch"} runtime`
        : isWhisper
          ? "Transcribes your reference during a voice clone; downloaded again when you next clone"
          : /VoiceDesign/.test(id)
            ? "Renders a voice from a description (used only while designing)"
            : /Base/.test(id)
              ? "Speaks your cloned and designed voices"
              : "Qwen3 preset speakers",
      bytes: await dirSize(full),
      paths: [full],
      category: "models",
      inUse:
        active.has(id) ||
        (isChatterbox && o.engine === "chatterbox" && CHATTERBOX_MODELS[o.chatterboxRuntime ?? "mlx"].includes(id)),
      removable: true,
      hint: "Downloaded again on next use (needs the network)",
    });
  }

  // --- Chatterbox PyTorch virtualenv (the extension's own, off Apple Silicon)
  const cbVenv = path.join(o.storageDir, "chatterbox-venv");
  if (exists(cbVenv)) {
    add({
      id: "chatterbox-venv",
      label: "Chatterbox runtime (PyTorch virtualenv)",
      detail:
        o.engine === "chatterbox" && o.chatterboxRuntime === "torch"
          ? "The runtime speaking your voice right now"
          : 'Installed by "Set Up Chatterbox Engine"; the active engine does not need it',
      bytes: await dirSize(cbVenv),
      paths: [cbVenv],
      category: "helpers",
      inUse: o.engine === "chatterbox" && o.chatterboxRuntime === "torch",
      removable: true,
      hint: 'Re-created by "Set Up Chatterbox Engine"',
    });
  }

  // --- Voice profiles: precious, listed so their size is visible
  const voicesDir = path.join(o.storageDir, "qwen3-voices");
  const voiceDirs = safeList(voicesDir).filter((d) => exists(path.join(voicesDir, d, "ref.wav")));
  const trashDir = path.join(voicesDir, ".trash");
  const trashed = safeList(trashDir).filter((d) => exists(path.join(trashDir, d, "ref.wav")));
  if (trashed.length > 0) {
    add({
      id: "voices-trash",
      label: `Deleted voices (${trashed.length}, still restorable)`,
      detail: 'Voices you deleted, kept so they can be restored from "Manage Voices"',
      bytes: await dirSize(trashDir),
      paths: [trashDir],
      category: "voices",
      inUse: false,
      removable: true,
      hint: "Removing them is permanent",
    });
  }
  if (voiceDirs.length > 0) {
    add({
      id: "voices",
      label: `Your voices (${voiceDirs.length})`,
      detail: "Cloned and designed voice profiles: reference audio and settings",
      bytes: await sumSizes(voiceDirs.map((d) => path.join(voicesDir, d))),
      paths: voiceDirs.map((d) => path.join(voicesDir, d)),
      category: "voices",
      inUse: o.engine === "qwen3" && o.qwen3Voice.startsWith("clone:"),
      removable: true,
      hint: "Cannot be downloaded again: export them first",
    });
  }

  // --- Compiled helpers, logs, temp parts
  const bin = path.join(o.storageDir, "bin");
  add({
    id: "helpers",
    label: "Compiled helpers",
    detail: "Audio player, recorder and extractor built from the bundled Swift sources",
    bytes: await dirSize(bin),
    paths: [bin],
    category: "helpers",
    inUse: true,
    removable: true,
    hint: "Rebuilt automatically within seconds",
  });
  const logs = safeList(o.storageDir)
    .filter((f) => f.endsWith(".log"))
    .map((f) => path.join(o.storageDir, f));
  add({
    id: "logs",
    label: "Diagnostic logs",
    detail: "Playback timings and daemon output; no transcript text",
    bytes: await sumSizes(logs),
    paths: logs,
    category: "logs",
    inUse: false,
    removable: true,
    hint: "Recreated as needed",
  });
  const tmp = o.tmpDir ?? os.tmpdir();
  const parts = safeList(tmp)
    .filter((f) => f.startsWith("claude-code-tts-") && f.endsWith(".wav"))
    .map((f) => path.join(tmp, f));
  add({
    id: "temp",
    label: "Leftover audio parts",
    detail: "Synthesized audio in the temp directory, normally deleted after playback",
    bytes: await sumSizes(parts),
    paths: parts,
    category: "temp",
    inUse: false,
    removable: true,
    hint: "Safe to remove",
  });
  // What was played recently, kept so it can be exported to a file.
  const played = path.join(o.storageDir, "played");
  add({
    id: "played",
    label: "Spoken audio kept for export",
    detail: 'The last minutes of speech, kept for "Export Spoken Audio to a File" (the export.keepMinutes setting)',
    bytes: await dirSize(played),
    paths: [played],
    category: "temp",
    inUse: false,
    removable: true,
    hint: "Replaced by newer speech on its own; safe to remove",
  });

  // --- The private uv and everything it installed: owned by the extension,
  // one folder, removable as a whole. Re-running an engine's setup brings it
  // back. In use while any Python engine or translation is configured.
  const privateUv = o.privateUvDir ?? path.join(o.storageDir, "uv");
  if (fs.existsSync(privateUv)) {
    add({
      id: "uv:private",
      label: "Bundled Python runtime (uv, tools, Python)",
      detail:
        "Installed by Claude Code TTS into its own storage so no command had to be run; engines set up this way run from here",
      bytes: await dirSize(privateUv),
      paths: [privateUv],
      category: "helpers",
      inUse: o.engine === "qwen3" || o.engine === "chatterbox" || o.engine === "piper" || o.speakLanguage !== "",
      removable: true,
      hint: "Removing it uninstalls every engine set up through it; their setup commands install it again",
    });
  }

  // --- Advisory: things this extension does not own
  const uv = o.uvToolsDir ?? uvToolsDir();
  for (const tool of ["qwen-tts", "mlx-audio", "sherpa-onnx", "piper-tts", "argostranslate"]) {
    const full = path.join(uv, tool);
    add({
      id: `uv:${tool}`,
      label: `Python tool ${tool}`,
      detail: "Installed by you with uv; the extension only runs it",
      bytes: await dirSize(full),
      paths: [full],
      category: "external",
      inUse:
        ((tool === "mlx-audio" || tool === "qwen-tts") && o.engine === "qwen3") ||
        (tool === "argostranslate" && o.speakLanguage !== ""),
      removable: false,
      hint: `Remove with: uv tool uninstall ${tool}`,
    });
  }
  // Translation models, downloaded per language pair.
  const argos = o.argosDir;
  const argosSize = await dirSize(argos);
  if (argosSize > 0) {
    add({
      id: "argos-models",
      label: "Translation models",
      detail: "Offline language models used to speak in another language",
      bytes: argosSize,
      paths: [argos],
      category: "models",
      inUse: (o.speakLanguage ?? "") !== "",
      removable: true,
      hint: 'Downloaded again by "Set Up Translation"',
    });
  }

  const extDir = o.extensionsDir;
  const olderVersions = safeList(extDir).filter((d) => d.startsWith("giladreich.claude-code-tts-"));
  if (olderVersions.length > 1) {
    add({
      id: "old-versions",
      label: `Installed extension versions (${olderVersions.length})`,
      detail: "VSCode keeps previous versions until it cleans them up on restart",
      bytes: await sumSizes(olderVersions.map((d) => path.join(extDir, d))),
      paths: olderVersions.map((d) => path.join(extDir, d)),
      category: "external",
      inUse: true,
      removable: false,
      hint: "VSCode removes obsolete versions itself; deleting the running one breaks the session",
    });
  }
  return items.sort((a, b) => b.bytes - a.bytes);
}

/** Delete the given items' paths. Returns bytes freed and any failures. */
export async function removeItems(items: StorageItem[]): Promise<{ freed: number; errors: string[] }> {
  let freed = 0;
  const errors: string[] = [];
  for (const item of items) {
    if (!item.removable) {
      continue;
    }
    for (const p of item.paths) {
      const before = await dirSize(p);
      try {
        await fs.promises.rm(p, { recursive: true, force: true });
        freed += before;
      } catch (e) {
        errors.push(`${path.basename(p)}: ${(e as Error).message}`);
      }
    }
  }
  return { freed, errors };
}

function safeList(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
