import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { pickWithPreview } from "../ui/prompts";
import { download } from "../tts/net";
import { CURATED_VOICES, HF_BASE, listPiperVoices, piperVoicesDir } from "../tts/piper";

/** Fetch one curated voice model; returns its local path. */
export async function fetchCuratedVoice(
  context: vscode.ExtensionContext,
  voice: (typeof CURATED_VOICES)[number]
): Promise<string | undefined> {
  const dir = piperVoicesDir(context.globalStorageUri.fsPath);
  const modelPath = path.join(dir, `${voice.id}.onnx`);
  if (fs.existsSync(modelPath)) {
    return modelPath;
  }
  fs.mkdirSync(dir, { recursive: true });
  const totalBytes = voice.mb * 1024 * 1024;
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Claude Code TTS: downloading ${voice.id}`,
        cancellable: false,
      },
      async (progress) => {
        let got = 0;
        const onBytes = (n: number) => {
          got += n;
          progress.report({ increment: (n / totalBytes) * 100, message: `${Math.round(got / 1024 / 1024)} MB` });
        };
        await download(`${HF_BASE}/${voice.hfDir}/${voice.id}.onnx.json`, `${modelPath}.json`, () => {});
        await download(`${HF_BASE}/${voice.hfDir}/${voice.id}.onnx`, modelPath, onBytes);
      }
    );
    return modelPath;
  } catch (e) {
    // A partial model file would make piper fail confusingly later.
    fs.rmSync(modelPath, { force: true });
    fs.rmSync(`${modelPath}.json`, { force: true });
    vscode.window.showErrorMessage(`Claude Code TTS: voice download failed: ${(e as Error).message}`);
    return undefined;
  }
}

/**
 * Pick a curated voice, download its model (~60-115MB) plus config from
 * Hugging Face with progress, and return the local model path. Returns
 * undefined if the user cancelled or the download failed.
 */
export async function downloadPiperVoice(context: vscode.ExtensionContext): Promise<string | undefined> {
  const dir = piperVoicesDir(context.globalStorageUri.fsPath);
  const existing = new Set(listPiperVoices(dir).map((v) => v.name));
  const picked = await pickWithPreview({
    items: CURATED_VOICES.map((v) => ({
      label: v.id,
      description: existing.has(v.id) ? "downloaded" : `${v.mb} MB`,
      detail: v.detail,
    })),
    placeholder: "Voice model to download from Hugging Face (stored locally, used offline)",
    title: "Download a voice",
    back: true,
    preview: () => undefined,
  });
  if (!picked || picked === "back") {
    return undefined;
  }
  const voice = CURATED_VOICES.find((v) => v.id === picked.label)!;
  return fetchCuratedVoice(context, voice);
}
