import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { pickManyWithBack, pickWithPreview } from "./prompts";
import { formatBytes, removeItems, ScanOptions, scanStorage, StorageItem } from "../platform/storage";
import { listQwen3Clones, qwen3VoicesDir } from "../tts/qwen3";
import { exportVoices, importVoices, VOICE_PACK_EXT } from "../voices/backup";

/**
 * Disk-space and backup user interface. Kept out of extension.ts so the
 * activation file stays about wiring; everything it needs from the extension
 * arrives through `StorageUiDeps`.
 */
export interface StorageUiDeps {
  context: vscode.ExtensionContext;
  /** What the current settings need, for the "in use" marks. */
  scanOptions: () => ScanOptions;
  /** Restart the engine after its model files were removed. */
  rebuildEngine: () => void;
  log: (msg: string) => void;
  /** Speak a confirmation (used after importing a voice). */
  enqueue: (text: string) => void;
  /** Switch to a voice ("clone:<slug>"). */
  useVoice: (value: string) => Promise<void>;
}

async function confirmRemoval(items: StorageItem[]): Promise<boolean> {
  if (items.length === 0) {
    return false;
  }
  const total = items.reduce((n, i) => n + i.bytes, 0);
  const voices = items.filter((i) => i.category === "voices");
  const inUse = items.filter((i) => i.inUse && i.category !== "voices");
  const lines = [
    `Remove ${items.length} item${items.length > 1 ? "s" : ""} and free ${formatBytes(total)}?`,
    "",
    ...items.slice(0, 12).map((i) => `- ${i.label} (${formatBytes(i.bytes)})`),
    ...(items.length > 12 ? [`- and ${items.length - 12} more`] : []),
  ];
  if (inUse.length > 0) {
    lines.push("", "Some of these are in use: they will be downloaded again on next use, which needs the network.");
  }
  if (voices.length > 0) {
    lines.push(
      "",
      "This includes your cloned and designed voices. They CANNOT be downloaded again. Export them first if you want to keep them."
    );
  }
  const choice = await vscode.window.showWarningMessage(lines.join("\n"), { modal: true }, "Remove");
  return choice === "Remove";
}

export async function storageFlow(deps: StorageUiDeps, back = false): Promise<"back" | "closed"> {
  const items = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Claude Code TTS: measuring disk usage..." },
    async () => await scanStorage(deps.scanOptions())
  );
  const removable = items.filter((i) => i.removable);
  const unused = removable.filter((i) => !i.inUse && i.category !== "voices");
  const total = items.reduce((n, i) => n + i.bytes, 0);
  const models = items.filter((i) => i.category === "models").reduce((n, i) => n + i.bytes, 0);
  const voiceCount = items.find((i) => i.id === "voices");

  const actions: { label: string; description?: string; detail?: string; run: () => Promise<unknown> }[] = [
    {
      label: `$(trash) Free everything not in use`,
      description: formatBytes(unused.reduce((n, i) => n + i.bytes, 0)),
      detail: "Models the current settings do not need, logs, leftover audio. Your voices are kept.",
      run: async () => {
        if (!(await confirmRemoval(unused))) {
          return;
        }
        const { freed, errors } = await removeItems(unused);
        report(deps, freed, errors, unused);
      },
    },
    {
      label: "$(checklist) Choose what to remove...",
      detail: "Every item with its size, including models in use",
      run: async () => {
        const picked = await pickManyWithBack({
          items: items.map((i) => ({
            label: `${formatBytes(i.bytes).padStart(8)}  ${i.label}`,
            description: i.removable ? (i.inUse ? "in use" : "") : "not removable here",
            detail: `${i.detail}. ${i.hint}`,
            item: i,
            picked: false,
          })),
          placeholder: "Select what to remove (space to tick, Enter to confirm)",
          title: "Choose what to remove",
          back: true,
        });
        if (picked === "back") {
          return;
        }
        const chosen = (picked ?? []).map((p) => p.item).filter((i) => i.removable);
        const skipped = (picked ?? []).length - chosen.length;
        if (skipped > 0) {
          vscode.window.showInformationMessage(
            "Claude Code TTS: Python tools and installed extension versions are not removed by this command; the list shows how."
          );
        }
        if (!(await confirmRemoval(chosen))) {
          return;
        }
        const { freed, errors } = await removeItems(chosen);
        report(deps, freed, errors, chosen);
      },
    },
    {
      label: `$(save) Back up my voices...`,
      description: voiceCount ? formatBytes(voiceCount.bytes) : "none yet",
      detail: "Write your cloned and designed voices to a file you can keep or move to another machine",
      run: async () => vscode.commands.executeCommand("claudeCodeTts.exportVoices"),
    },
    {
      label: "$(cloud-download) Import voices from a backup...",
      detail: "Install voices from a file exported here or shared with you",
      run: async () => vscode.commands.executeCommand("claudeCodeTts.importVoices"),
    },
  ];
  const pick = await pickWithPreview({
    items: actions,
    placeholder: `Claude Code TTS uses ${formatBytes(total)} (models ${formatBytes(models)}${voiceCount ? `, voices ${formatBytes(voiceCount.bytes)}` : ""})`,
    title: "Storage and cleanup",
    back,
    preview: () => undefined,
  });
  if (pick === "back") {
    return "back";
  }
  await pick?.run();
  return "closed";
}

function report(deps: StorageUiDeps, freed: number, errors: string[], removed: StorageItem[]): void {
  if (removed.some((i) => i.inUse && i.category !== "voices")) {
    deps.rebuildEngine();
  }
  const msg = `Claude Code TTS: freed ${formatBytes(freed)}.${errors.length ? ` ${errors.length} item(s) could not be removed.` : ""}`;
  if (errors.length) {
    deps.log(`[storage] ${errors.join("; ")}`);
    vscode.window
      .showWarningMessage(msg, "Show log")
      .then((p) => p && vscode.commands.executeCommand("claudeCodeTts.showLog"));
  } else {
    vscode.window.showInformationMessage(msg);
  }
}

export async function exportVoicesFlow(deps: StorageUiDeps): Promise<void> {
  const dir = qwen3VoicesDir(deps.context.globalStorageUri.fsPath);
  const profiles = listQwen3Clones(dir);
  if (profiles.length === 0) {
    vscode.window.showInformationMessage("Claude Code TTS: no cloned or designed voices to export yet.");
    return;
  }
  const picked = await pickManyWithBack({
    items: profiles.map((p) => ({
      label: p.name,
      description: p.designed ? "designed" : "cloned",
      slug: p.slug,
      picked: true,
    })),
    placeholder: "Which voices to include in the backup?",
    title: "Back up voices",
    back: true,
  });
  if (!picked || picked === "back" || picked.length === 0) {
    return;
  }
  const stamp = new Date().toISOString().slice(0, 10);
  const target = await vscode.window.showSaveDialog({
    title: "Save voice backup",
    defaultUri: vscode.Uri.file(path.join(os.homedir(), `claude-code-tts-voices-${stamp}.${VOICE_PACK_EXT}`)),
    filters: { "Voice backup": [VOICE_PACK_EXT, "tgz", "gz"] },
  });
  if (!target) {
    return;
  }
  try {
    const n = await exportVoices(
      dir,
      picked.map((p) => p.slug),
      target.fsPath
    );
    const choice = await vscode.window.showInformationMessage(
      `Claude Code TTS: ${n} voice${n > 1 ? "s" : ""} written to ${path.basename(target.fsPath)}. It contains recordings of a real voice: share it only with the speaker's agreement.`,
      "Show in folder",
      "Read the guidance"
    );
    if (choice === "Show in folder") {
      vscode.commands.executeCommand("revealFileInOS", target);
    }
    if (choice === "Read the guidance") {
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(path.join(deps.context.extensionPath, "docs", "RESPONSIBLE-USE.md"))
      );
      await vscode.window.showTextDocument(doc, { preview: true });
    }
  } catch (e) {
    vscode.window.showErrorMessage(`Claude Code TTS: export failed: ${(e as Error).message}`);
  }
}

export async function importVoicesFlow(deps: StorageUiDeps): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: "Import voices",
    title: "Choose a voice backup",
    filters: { "Voice backup": [VOICE_PACK_EXT, "tgz", "gz", "tar"] },
  });
  const file = picked?.[0]?.fsPath;
  if (!file) {
    return;
  }
  try {
    const imported = await importVoices(qwen3VoicesDir(deps.context.globalStorageUri.fsPath), file);
    const renamed = imported.filter((i) => i.renamed).length;
    const first = imported[0];
    const choice = await vscode.window.showInformationMessage(
      `Claude Code TTS: imported ${imported.map((i) => i.name).join(", ")}${renamed ? ` (${renamed} renamed to avoid overwriting)` : ""}.`,
      "Use " + first.name,
      "Later"
    );
    if (choice === `Use ${first.name}`) {
      await deps.useVoice(`clone:${first.slug}`);
    }
  } catch (e) {
    vscode.window.showErrorMessage(`Claude Code TTS: import failed: ${(e as Error).message}`);
  }
}
