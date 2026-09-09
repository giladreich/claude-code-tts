/**
 * The handful of things a running extension has exactly one of.
 *
 * A VSCode extension activates once and lives as a set of singletons: the
 * output channel, the speech queue, the status bar item, the translator, the
 * context whose globalStorage everything is written into. Every flow needs
 * some of them, which is why they all used to live in one 4,000-line file
 * together with the flows themselves: splitting that file means the pieces
 * need somewhere to find these.
 *
 * They are gathered here rather than passed through every signature: the
 * flows are user interface, they run one at a time, and threading eleven
 * objects through forty functions would be a bigger change than the one this
 * makes safe. Nothing here imports a flow, so this module is a leaf: the
 * dependency arrows point at it, never out of it.
 *
 * `activate()` fills these in; `deactivate()` clears what has to be cleared.
 */
import type * as vscode from "vscode";
import type { SpeechQueue } from "../speech/speech";
import type { TranscriptTailer } from "../session/tailer";
import type { Translator } from "../language/translate";
import type { SessionOwnership } from "../session/sessionOwnership";
import type { ControlWatcher } from "../session/control";

/** What the extension is made of while it runs. Undefined before activation. */
class Runtime {
  /** The activation context: storage paths, global state, subscriptions. */
  context!: vscode.ExtensionContext;
  /** The "Claude Code TTS" output channel, which is also the log. */
  output!: vscode.OutputChannel;
  /** The status bar entry, and the door to the menu. */
  statusItem!: vscode.StatusBarItem;
  /** The speaking pipeline. Absent when no engine could be built. */
  speech: SpeechQueue | undefined;
  /** The transcript reader. */
  tailer: TranscriptTailer | undefined;
  /** Offline translation, built when a spoken language is configured. */
  translator: Translator | undefined;
  /** Which window speaks which session when several are open. */
  ownership: SessionOwnership | undefined;
  /** One-word commands from a terminal. */
  control: ControlWatcher | undefined;
  /**
   * Where an engine failure goes. Set during activation; the flows that live
   * outside it report through this rather than throwing into the void.
   */
  onError: (message: string) => void = () => {};

  /** Everything the extension writes to disk lives under this. */
  get storagePath(): string {
    return this.context.globalStorageUri.fsPath;
  }

  /** Read a value remembered across windows and reloads. */
  remembered<T>(key: string): T | undefined {
    return this.context.globalState.get<T>(key);
  }

  /** Remember a value across windows and reloads. */
  remember(key: string, value: unknown): Thenable<void> {
    return this.context.globalState.update(key, value);
  }

  /** One line in the log. */
  log(line: string): void {
    this.output.appendLine(line);
  }
}

export const runtime = new Runtime();
