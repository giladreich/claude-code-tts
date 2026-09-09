/**
 * Turning translation on, and keeping it able to work.
 *
 * Everything Claude writes can be read in another language, which needs a
 * runtime installed, a model per direction downloaded, and a setting that
 * says which language. This module owns those three; what is then done with
 * a translated sentence, and which voice reads it, is somebody else's
 * question.
 */
import * as path from "path";
import * as vscode from "vscode";
import { DEFAULT_KEEP_IN_SOURCE } from "./glossary";
import { languageName } from "./language";
import { runtime } from "../core/runtime";
import { installTool } from "../setup/setupFlows";
import { translateDaemonScript, Translator, translationAvailable, translationModelMissing } from "./translate";

/** The language Claude Code writes in, and so the one nothing is translated from. */
export const SOURCE_LANGUAGE = "en";

/** Download one direction's model with progress; false (and a message) if it failed. */
export async function downloadTranslationModel(from: string, to: string): Promise<boolean> {
  const ok = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Claude Code TTS: downloading the ${languageName(from)} to ${languageName(to)} model...`,
    },
    async () => {
      try {
        await runtime.translator!.install(from, to);
        return true;
      } catch (e) {
        runtime.output.appendLine(`[translation] ${(e as Error).message}`);
        return false;
      }
    }
  );
  if (!ok) {
    vscode.window
      .showErrorMessage(
        `Claude Code TTS: could not download that model (see the log). Other pairs may still work.`,
        "Show log"
      )
      .then((p) => p && runtime.output.show());
  }
  return ok;
}

/**
 * Translation into the configured language is on, but the model for this
 * direction is not on disk (the setting was synced from another machine, the
 * model was removed, or the download was skipped). Offer it once; until it is
 * installed the original text is spoken, which the log says per paragraph.
 */
export async function offerTranslationModel(from: string, to: string): Promise<void> {
  const DOWNLOAD = "Download";
  const STOP = "Stop translating";
  const pick = await vscode.window.showWarningMessage(
    `Claude Code TTS: speaking in ${languageName(to)} needs the ${languageName(from)} to ${languageName(to)} translation model (about 100 MB, downloaded once, runs offline). Until then the original text is spoken.`,
    DOWNLOAD,
    STOP,
    "Show log"
  );
  if (pick === DOWNLOAD) {
    if (await downloadTranslationModel(from, to)) {
      runtime.translator?.prewarm(to);
      vscode.window.showInformationMessage(`Claude Code TTS: everything will be spoken in ${languageName(to)}.`);
    }
  } else if (pick === STOP) {
    await vscode.workspace
      .getConfiguration("claudeCodeTts")
      .update("speakLanguage", "", vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage("Claude Code TTS: speaking each message in its own language again.");
  } else if (pick === "Show log") {
    runtime.output.show();
  }
}

/** The translator, wired to the log and to the missing-model offer. */
export function newTranslator(): Translator {
  return new Translator({
    daemonScript: translateDaemonScript(runtime.context.extensionPath),
    logFile: path.join(runtime.context.globalStorageUri.fsPath, "translate-daemon.log"),
    onError: runtime.onError,
    onMissingModel: (from, to) => void offerTranslationModel(from, to),
    // An empty setting means "use the built-in glossary"; a list of one's own
    // replaces it entirely, so a user's field can take the place of software.
    keepTerms: () => {
      const own = vscode.workspace.getConfiguration("claudeCodeTts").get<string[]>("keepInSourceLanguage", []);
      return own.length ? own : DEFAULT_KEEP_IN_SOURCE;
    },
  });
}

/**
 * Everything needed to hear messages in one language: the offline runtime,
 * the model for that direction, and the setting. `ask` states the network
 * steps first; the flow that sets a voice, its engine and its language up in
 * one confirmation passes false, because it already asked for all of them
 * and a chain of modals is what people abandon halfway.
 */
export async function ensureTranslationInto(code: string, ask: boolean): Promise<boolean> {
  const c = vscode.workspace.getConfiguration("claudeCodeTts");
  // Nothing is translated from the language Claude writes in into itself, so
  // there is no runtime to install and no model to fetch: asking for either
  // is what made choosing it report a failed download.
  if (code === SOURCE_LANGUAGE) {
    await c.update("speakLanguage", code, vscode.ConfigurationTarget.Global);
    return true;
  }
  if (!translationAvailable()) {
    if (ask) {
      const go = await vscode.window.showInformationMessage(
        `Speaking in ${languageName(code)} needs a local translation engine (Argos Translate). Install it? Translation then runs offline, and nothing is sent to a service.`,
        { modal: true },
        "Install"
      );
      if (go !== "Install") {
        return false;
      }
    }
    const ok = await installTool("argostranslate", "Translation");
    if (!ok || !translationAvailable()) {
      if (ok) {
        vscode.window.showErrorMessage(
          "Claude Code TTS: the translation engine installed but could not be found afterwards (see the log)."
        );
      }
      return false;
    }
    runtime.translator?.dispose();
    runtime.translator = newTranslator();
  }
  // Models are per direction, and English is the source Claude writes in.
  if (translationModelMissing(await runtime.translator!.pairs(), "en", code)) {
    if (ask) {
      const go = await vscode.window.showInformationMessage(
        `Download the English to ${languageName(code)} translation model? About 100 MB, once, from the Argos model index; it runs offline afterwards.`,
        { modal: true },
        "Download"
      );
      if (go !== "Download") {
        return false;
      }
    }
    if (!(await downloadTranslationModel("en", code))) {
      return false;
    }
  }
  await c.update("speakLanguage", code, vscode.ConfigurationTarget.Global);
  runtime.translator?.prewarm(code);
  return true;
}
