/**
 * Leaving cleanly. VSCode removes the extension's own storage after an
 * uninstall and nothing else, and uninstalling is also the one moment a user
 * loses voices they recorded: no download brings those back. This flow does
 * the rest in one confirmed step, offering the backup first.
 */

import * as vscode from "vscode";
import { SETTING_KEYS } from "../core/config";
import { formatBytes, removeItems, scanStorage, ScanOptions, StorageItem } from "../platform/storage";
import { clearHistory } from "../speech/spokenHistory";
import { listQwen3Clones } from "../tts/qwen3";
import { cleanClaudeDirectory } from "./uninstallHook";

/**
 * Every claudeCodeTts.* setting back to its default, in both scopes. A
 * machine-scoped setting cannot be written to a workspace, and there is no
 * workspace at all when no folder is open; neither is a reason to abandon the
 * other keys, which is what stopping at the first error used to do.
 */
export async function clearAllSettings(): Promise<void> {
  const c = vscode.workspace.getConfiguration("claudeCodeTts");
  for (const key of SETTING_KEYS) {
    for (const target of [vscode.ConfigurationTarget.Global, vscode.ConfigurationTarget.Workspace]) {
      try {
        await c.update(key, undefined, target);
      } catch {
        // see above
      }
    }
  }
  // The spoken history is the one thing a reset leaves on disk otherwise,
  // and the privacy document says a reset clears it.
  await clearHistory();
}

export interface RemoveEverythingDeps {
  scanOptions: () => ScanOptions;
  voicesDir: string;
  /** Stop speaking and drop the engines, so nothing holds the files about to go. */
  rebuildEngine: () => void;
}

export async function removeEverythingFlow(deps: RemoveEverythingDeps): Promise<void> {
  const voices = listQwen3Clones(deps.voicesDir).length;
  if (voices > 0) {
    const pick = await vscode.window.showWarningMessage(
      `You have ${voices} voice${voices === 1 ? "" : "s"} of your own. Uninstalling deletes them with the extension's storage, and no download brings a recording back. Back them up to a file first?`,
      { modal: true },
      "Back up first",
      "Continue without a backup"
    );
    if (!pick) {
      return;
    }
    if (pick === "Back up first") {
      await vscode.commands.executeCommand("claudeCodeTts.exportVoices");
    }
  }
  const items = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Claude Code TTS: measuring what was added..." },
    () => scanStorage(deps.scanOptions())
  );
  const owned = items.filter((i) => i.removable && i.category !== "voices");
  const advice = items.filter((i) => !i.removable);
  const choice = await vscode.window.showWarningMessage(
    [
      "Remove everything Claude Code TTS added to this machine?",
      "",
      "- The completion-sound hooks and sound choices under ~/.claude",
      `- Downloaded models, runtimes, helpers and logs (${formatBytes(owned.reduce((n, i) => n + i.bytes, 0))})`,
      "- Every claudeCodeTts.* setting and the spoken history",
      "",
      voices > 0 ? "Your voices are kept unless you say otherwise. " : "",
      "Afterwards, uninstall the extension from the Extensions view; VSCode deletes its storage folder on the next start.",
    ].join("\n"),
    { modal: true },
    "Remove",
    ...(voices > 0 ? ["Remove, my voices too"] : [])
  );
  if (!choice) {
    return;
  }
  const chosen: StorageItem[] = choice === "Remove, my voices too" ? items.filter((i) => i.removable) : owned;
  await clearAllSettings();
  deps.rebuildEngine();
  const removed = cleanClaudeDirectory(undefined, true);
  const { freed, errors } = await removeItems(chosen);
  const lines = [
    `Claude Code TTS: removed ${formatBytes(freed)}${removed.length ? ", " + removed.join(", ") : ""}, and reset every setting.`,
    ...(advice.length ? [`Not owned by this extension, so left for you: ${advice.map((i) => i.hint).join("; ")}`] : []),
    ...(errors.length ? [`Could not remove: ${errors.join("; ")}`] : []),
    "Uninstall the extension from the Extensions view to finish.",
  ];
  await vscode.window.showInformationMessage(lines.join(" "), { modal: true }, "OK");
}
