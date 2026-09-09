/**
 * Guided setup for the Qwen3 engine, one of the two that can clone or design
 * a voice. Without this, using it meant reading the README, knowing which of
 * two Python packages applies to your machine, and running the right command
 * in the right shell. Here the extension picks the package, installs it with
 * progress and cancellation, verifies the result, and hands over to the
 * first model download. Nothing is installed without an explicit yes.
 */

import * as vscode from "vscode";
import { isMac, isWindows } from "../platform/platform";
import { qwen3Available, resetQwen3Lookups, resolveQwen3Runtime } from "../tts/qwen3";

/** The package this machine should use, and why. */
export function qwen3Package(): { pkg: string; reason: string } {
  if (isMac && process.arch === "arm64") {
    return {
      pkg: "mlx-audio",
      reason: "Apple Silicon: the MLX runtime streams speech faster than realtime",
    };
  }
  return {
    pkg: "qwen-tts",
    reason: isMac ? "Intel Mac: the PyTorch runtime" : `${isWindows ? "Windows" : "Linux"}: the PyTorch runtime`,
  };
}

export interface Qwen3SetupDeps {
  log: (line: string) => void;
  showLog: () => void;
  /** Install a Python tool through uv (the user's, or the extension's private copy); true on success. */
  installTool: (pkg: string) => Promise<boolean>;
  /** Switch the extension to Qwen3 and warm the model. */
  activate: () => Promise<void>;
  /** The checkpoint this machine will download, described in words. */
  modelDownload?: string;
}

/** Returns true when Qwen3 is usable afterwards. */
export async function setupQwen3(deps: Qwen3SetupDeps): Promise<boolean> {
  if (qwen3Available()) {
    const runtime = resolveQwen3Runtime("auto");
    const go = await vscode.window.showInformationMessage(
      `Claude Code TTS: Qwen3 is already installed (${runtime === "mlx" ? "MLX" : "PyTorch"} runtime). Switch to it now? The voice model (${deps.modelDownload ?? "~2.3 GB"}) downloads on first use and then runs offline.`,
      { modal: true },
      "Use Qwen3"
    );
    if (go !== "Use Qwen3") {
      return false;
    }
    await deps.activate();
    return true;
  }

  const { pkg, reason } = qwen3Package();
  const consent = await vscode.window.showInformationMessage(
    `Set up Qwen3-TTS? This installs the ${pkg} package (${reason}) into an isolated Python environment; ` +
      `nothing else on this machine is touched. The voice model (${deps.modelDownload ?? "~2.3 GB"}) downloads from Hugging Face on first use and everything runs offline afterwards.`,
    { modal: true },
    "Install"
  );
  if (consent !== "Install") {
    return false;
  }

  const ok = await deps.installTool(pkg);
  resetQwen3Lookups(); // the memoised probes must see the new install
  if (!ok || !qwen3Available()) {
    if (ok) {
      const pick = await vscode.window.showErrorMessage(
        `Claude Code TTS: ${pkg} installed but is still not usable (see the log).`,
        "Show log"
      );
      if (pick === "Show log") {
        deps.showLog();
      }
    }
    return false;
  }
  await deps.activate();
  return true;
}
