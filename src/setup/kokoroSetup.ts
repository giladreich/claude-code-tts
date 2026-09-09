import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { KOKORO_MODEL_ID, kokoroReady, SHERPA_VERSION, sherpaPlatform } from "../tts/kokoro";
import { download } from "../tts/net";

const RUNTIME_MB = 25;
const MODEL_MB = 335;

function extractTarBz2(archive: string, destDir: string): Promise<void> {
  // bsdtar ships with macOS and Windows 10+; GNU tar covers Linux.
  return new Promise((resolve, reject) => {
    const proc = spawn("tar", ["xjf", archive, "-C", destDir], { stdio: "ignore", windowsHide: true });
    proc.on("error", reject);
    proc.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`tar exited with ${code}`))));
  });
}

export function kokoroDirOf(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, "kokoro");
}

export function kokoroDaemonScriptOf(context: vscode.ExtensionContext): string {
  return path.join(context.extensionPath, "assets", "kokoro_daemon.py");
}

/**
 * One-command Kokoro setup: downloads the sherpa-onnx runtime for this
 * platform plus the Kokoro voice model (~330 MB total, one-time), extracts
 * both into the extension's storage, and returns true when ready. No Python,
 * no PATH, nothing outside the extension's own storage directory.
 */
export async function setupKokoro(context: vscode.ExtensionContext): Promise<boolean> {
  const dir = kokoroDirOf(context);
  if (kokoroReady(dir)) {
    return true;
  }

  const plat = sherpaPlatform();
  if (!plat) {
    vscode.window.showErrorMessage(
      `Claude Code TTS: no prebuilt Kokoro runtime for ${process.platform}-${process.arch}.`
    );
    return false;
  }
  const consent = await vscode.window.showInformationMessage(
    `Set up the Kokoro engine? This downloads the sherpa-onnx runtime (~${RUNTIME_MB} MB) and the Kokoro voice model (~${MODEL_MB} MB) once, then everything runs offline.`,
    { modal: true },
    "Download"
  );
  if (consent !== "Download") {
    return false;
  }

  fs.mkdirSync(dir, { recursive: true });
  const runtimeUrl = `https://github.com/k2-fsa/sherpa-onnx/releases/download/v${SHERPA_VERSION}/sherpa-onnx-v${SHERPA_VERSION}-${plat}.tar.bz2`;
  const modelUrl = `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${KOKORO_MODEL_ID}.tar.bz2`;
  const totalBytes = (RUNTIME_MB + MODEL_MB) * 1024 * 1024;

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Claude Code TTS: setting up Kokoro",
        cancellable: false,
      },
      async (progress) => {
        let got = 0;
        const onBytes = (n: number) => {
          got += n;
          progress.report({ increment: (n / totalBytes) * 100, message: `${Math.round(got / 1024 / 1024)} MB` });
        };
        for (const [url, name] of [
          [runtimeUrl, "runtime.tar.bz2"],
          [modelUrl, "model.tar.bz2"],
        ] as const) {
          const archive = path.join(dir, name);
          await download(url, archive, onBytes);
          progress.report({ message: `extracting ${name}...` });
          await extractTarBz2(archive, dir);
          fs.rmSync(archive, { force: true });
        }
      }
    );
  } catch (e) {
    vscode.window.showErrorMessage(`Claude Code TTS: Kokoro setup failed: ${(e as Error).message}`);
    return false;
  }
  if (!kokoroReady(dir)) {
    vscode.window.showErrorMessage("Claude Code TTS: Kokoro setup finished but the runtime or model is missing.");
    return false;
  }
  return true;
}
