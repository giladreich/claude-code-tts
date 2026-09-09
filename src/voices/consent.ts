/**
 * One-time acknowledgement before the first voice clone on this machine.
 * Cloning a voice is only acceptable for a voice you own or have permission
 * to use; the dialog states that, and the answer is stored locally (nothing
 * is reported anywhere). Kept to a single modal so the flows stay quick:
 * once acknowledged, cloning proceeds without further prompts.
 */

import * as path from "path";
import * as vscode from "vscode";

const KEY = "claudeCodeTts.cloneConsentAt";

export const CLONE_CONSENT_TEXT =
  "Voice cloning: only clone a voice you own, or one whose speaker has given you informed permission. " +
  "Do not use a cloned voice to impersonate anyone, for fraud or voice-based identity checks, or to pass synthetic speech off as a real recording. " +
  "Disclose synthetic speech when you share it. The recording and the voice profile stay on this machine.";

export function hasCloneConsent(context: vscode.ExtensionContext): boolean {
  return typeof context.globalState.get(KEY) === "string";
}

/** Returns true when cloning may proceed. */
export async function ensureCloneConsent(context: vscode.ExtensionContext): Promise<boolean> {
  if (hasCloneConsent(context)) {
    return true;
  }
  const DETAILS = "Read the guidance";
  const AGREE = "I have the right to use this voice";
  for (;;) {
    const choice = await vscode.window.showWarningMessage(CLONE_CONSENT_TEXT, { modal: true }, AGREE, DETAILS);
    if (choice === DETAILS) {
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(path.join(context.extensionPath, "docs", "RESPONSIBLE-USE.md"))
      );
      await vscode.window.showTextDocument(doc, { preview: true });
      continue; // ask again after they have read it
    }
    if (choice !== AGREE) {
      return false;
    }
    await context.globalState.update(KEY, new Date().toISOString());
    return true;
  }
}
