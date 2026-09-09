/**
 * "Speak Selection" has to work for more than text editors: Claude's chat
 * lives in a webview, and VSCode gives extensions no way to read a webview's
 * (or a terminal's) selection. What does work everywhere is the workbench's
 * own copy command, so when there is no editor selection we copy the focused
 * selection to the clipboard, use that, and put the clipboard back.
 *
 * Kept free of the vscode module so the decision logic is unit-testable.
 */
export interface SelectionDeps {
  /** Selected text in the active text editor, if any. */
  editorSelection: () => string;
  readClipboard: () => Promise<string>;
  writeClipboard: (text: string) => Promise<void>;
  /** Command ids the workbench actually offers (order = preference). */
  copyCommands: () => Promise<string[]>;
  runCommand: (id: string) => Promise<unknown>;
  /** Diagnostics, shown in the "Claude Code TTS" output channel. */
  log?: (msg: string) => void;
}

export interface SpeakTarget {
  text: string;
  /** Where it came from, for the status message. */
  source: "editor" | "selection" | "clipboard" | "none";
}

/**
 * Copy commands worth trying, best first. None of them can reach inside
 * another extension's webview (Claude's chat panel renders in a sandboxed
 * iframe, and only that iframe may copy its own selection), so for panels the
 * clipboard route below is the one that works: the user presses the copy key,
 * we speak what lands there.
 */
const COPY_COMMANDS = ["execCopy", "editor.action.clipboardCopyAction", "workbench.action.terminal.copySelection"];

export async function resolveSpeakTarget(deps: SelectionDeps): Promise<SpeakTarget> {
  const log = deps.log ?? (() => {});
  const inEditor = deps.editorSelection();
  if (inEditor.trim()) {
    log(`selection: ${inEditor.length} chars from the active editor`);
    return { text: inEditor, source: "editor" };
  }

  const available = new Set(await deps.copyCommands());
  const candidates = COPY_COMMANDS.filter((c) => available.has(c));
  const before = await deps.readClipboard();
  for (const copy of candidates) {
    try {
      await deps.runCommand(copy);
    } catch (e) {
      log(`selection: ${copy} failed (${(e as Error).message})`);
      continue;
    }
    const after = await deps.readClipboard();
    if (after.trim() && after !== before) {
      // Leave the user's clipboard as we found it: they did not ask for a copy.
      await deps.writeClipboard(before).catch(() => {});
      log(`selection: ${copy} captured ${after.length} chars`);
      return { text: after, source: "selection" };
    }
    log(`selection: ${copy} copied nothing (the focused view keeps its selection to itself)`);
  }
  if (before.trim()) {
    log(`selection: nothing selected here, speaking the clipboard (${before.length} chars)`);
    return { text: before, source: "clipboard" };
  }
  log("selection: no editor selection and an empty clipboard");
  return { text: "", source: "none" };
}

/** Read the clipboard only: the reliable route for webview panels. */
export async function clipboardTarget(deps: Pick<SelectionDeps, "readClipboard">): Promise<SpeakTarget> {
  const text = await deps.readClipboard();
  return text.trim() ? { text, source: "clipboard" } : { text: "", source: "none" };
}
