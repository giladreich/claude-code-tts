/**
 * The path a line takes from the transcript to the speakers.
 *
 * Clean the prose, decide the language, translate it when a language is
 * configured, split it into chunks the engine reads well, and queue them in
 * order. The order is the hard part: translation is asynchronous, so the
 * chunks of one paragraph are chained rather than raced, and a paragraph
 * that fails to translate is spoken as it was written rather than not at all.
 */
import * as vscode from "vscode";
import { chunkPlanFor, config } from "../core/config";
import { chunkForSpeech, cleanTextForSpeech } from "./format";
import { countScripts, detectLanguage } from "../language/language";
import { resolveSpeakTarget, SpeakTarget } from "../session/selection";
import { runtime } from "../core/runtime";
import { newToolStreak } from "./utteranceFilter";

/**
 * Whether prose is translated before it is spoken. When it is, prose reaches
 * speakLine() as whole blocks rather than chunks: one translation per block
 * costs about half of one per chunk (measured 226 ms versus 443 ms per
 * sentence with Argos en>de), reads better because the translator sees the
 * paragraph, and the chunking then follows the sentence boundaries of the
 * translated text rather than the original's.
 */
export function translating(): boolean {
  return !!config().speechConfig.speakLanguage && !!runtime.translator?.available;
}

/** Chunk a block for the current engine and queue the pieces in order. */
export function enqueueChunked(text: string, group?: number): void {
  const { engine, qwen3Model } = config().speechConfig;
  for (const chunk of chunkForSpeech(text, chunkPlanFor(engine, qwen3Model), (runtime.speech?.pending ?? 0) === 0)) {
    runtime.speech?.enqueue(chunk, group);
  }
}

/**
 * Which message an utterance belongs to, so that an export can offer "the
 * last message" rather than a stretch of minutes. A message starts at each
 * prompt a session receives, and everything spoken for that session until
 * the next prompt is Claude's answer to it. Sessions are counted apart, so
 * two answers arriving at once do not share one.
 */
let lastGroup = 0;
const groupBySession = new Map<string, number>();

/** A fresh message of its own: a repeated message, a spoken selection. */
export function newSpeechGroup(): number {
  return ++lastGroup;
}

/** The message a session is on; `startsNew` when its transcript just received a prompt. */
export function speechGroupFor(session: string, startsNew: boolean): number {
  if (startsNew || !groupBySession.has(session)) {
    groupBySession.set(session, newSpeechGroup());
  }
  return groupBySession.get(session)!;
}

/**
 * A transcript line that starts a turn: a prompt from the user. A tool
 * result is written as a user line too, and so are meta lines; neither is
 * something the user said.
 */
export function isPromptLine(line: string): boolean {
  return line.includes('"type":"user"') && !line.includes('"tool_result"') && !line.includes('"isMeta":true');
}

export function speakLine(text: string, group?: number): void {
  if (!translating()) {
    runtime.speech?.enqueue(text, group);
    return;
  }
  const target = config().speechConfig.speakLanguage;
  speakChain = speakChain
    .then(async () => {
      // Short Latin-script lines (tool announcements, identifiers) are too
      // short for detection. Left untranslated they were then read by the
      // target language's voice as foreign gibberish; Claude Code writes them
      // in English, so that is what they are taken to be. Text in another
      // script is decided by the script itself.
      //
      // countScripts counts every letter into its script AND into `total`, so
      // this compares against `total` directly: summing the whole object
      // counted every letter twice, the comparison never held, and the
      // fallback it guards never once fired.
      const scripts = countScripts(text);
      const from = detectLanguage(text) ?? (scripts.latin > 0 && scripts.latin === scripts.total ? "en" : undefined);
      if (!from || from === target || !runtime.translator?.available) {
        enqueueChunked(text, group);
        return;
      }
      const translated = await runtime.translator.translate(text, from, target);
      if (translated !== text) {
        runtime.output.appendLine(`[translated ${from} to ${target}] ${translated}`);
      }
      enqueueChunked(translated, group);
    })
    .catch(() => enqueueChunked(text, group));
}

/** Speak a resolved selection, or explain why there is nothing to speak. */
export function speakTarget(target: SpeakTarget, emptyHint: string): void {
  const cleaned = cleanTextForSpeech(target.text);
  if (!cleaned) {
    runtime.output.appendLine(`[speak selection] nothing speakable (source: ${target.source})`);
    vscode.window.showInformationMessage(`Claude Code TTS: ${emptyHint}`);
    return;
  }
  if (target.source === "clipboard") {
    vscode.window.setStatusBarMessage("Claude Code TTS: speaking the clipboard", 3000);
  }
  runtime.speech?.stop();
  const group = newSpeechGroup();
  // Translating: the whole selection goes as one block (one translation, and
  // the chunking follows the translated sentences); otherwise chunk it here.
  if (translating()) {
    speakLine(cleaned, group);
    return;
  }
  for (const chunk of chunkForSpeech(
    cleaned,
    chunkPlanFor(config().speechConfig.engine, config().speechConfig.qwen3Model)
  )) {
    speakLine(chunk, group);
  }
}

/**
 * Speak the selection, wherever it is. Editors give it to us directly;
 * Claude's chat panel and terminals render in views whose selection the API
 * cannot read, so the workbench's own copy command is used and the clipboard
 * restored afterwards; failing both, the clipboard is spoken as it is.
 */
export async function speakSelectionOrClipboard(): Promise<void> {
  const target = await resolveSpeakTarget({
    editorSelection: () => {
      const editor = vscode.window.activeTextEditor;
      return editor?.document.getText(editor.selection) ?? "";
    },
    readClipboard: () => Promise.resolve(vscode.env.clipboard.readText()),
    writeClipboard: (t) => Promise.resolve(vscode.env.clipboard.writeText(t)),
    copyCommands: () => Promise.resolve(vscode.commands.getCommands(true)),
    runCommand: (id) => Promise.resolve(vscode.commands.executeCommand(id)),
    log: (m) => runtime.output.appendLine(`[speak selection] ${m}`),
  });
  speakTarget(
    target,
    // Panels such as Claude's chat render in a sandboxed iframe, and VSCode
    // gives extensions no way to read or copy what is selected inside one.
    // Copying by hand puts it within reach.
    "Nothing to speak. In Claude's chat panel, copy the text first (cmd+C / ctrl+C), then run this again."
  );
}

/** tool_use id -> tool name, so errors can be attributed across lines. */
export const toolNames = new Map<string, string>();
/** The project of the last thing spoken, so a switch can be announced. */
let lastSpokenProject = "";

/** Note which project was spoken last, and whether it changed. */
export function projectChanged(project: string): { changed: boolean; previous: string } {
  const previous = lastSpokenProject;
  if (project !== previous) {
    lastSpokenProject = project;
  }
  return { changed: project !== previous, previous };
}

/** Last announced tool activity, to silence repeats until it changes. */
export const lastTool = newToolStreak();
/**
 * Everything spoken goes through here, in order. When a target language is
 * set and the text is in another one, it is translated locally first; the
 * chain keeps utterances in order even though translation is asynchronous,
 * and a failure speaks the original rather than nothing.
 */
let speakChain: Promise<void> = Promise.resolve();
