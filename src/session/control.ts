/**
 * Controlling the voice from a terminal.
 *
 * Everything else this extension offers is a VSCode command, which is fine
 * until you are working in a terminal with Claude Code and want the speech
 * to stop: reaching the keyboard shortcut means leaving what you are doing
 * and finding a VSCode window. So one line written to a file is also a
 * command:
 *
 *     echo mute > ~/.claude/claude-code-tts-control
 *
 * Deliberately small. It is a fixed list of verbs, nothing is executed, and
 * the file is only ever read, never written back: several windows watch it
 * and each acts on what it can (muting applies to all of them; skipping only
 * matters in the one that is speaking).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const CONTROL_FILE = path.join(os.homedir(), ".claude", "claude-code-tts-control");

export type ControlVerb =
  "mute" | "unmute" | "toggle" | "pause" | "resume" | "skip" | "stop" | "repeat" | "faster" | "slower";

export interface ControlCommand {
  verb: ControlVerb;
  /** For "rate", the words per minute asked for. */
  rate?: number;
}

const VERBS: ControlVerb[] = [
  "mute",
  "unmute",
  "toggle",
  "pause",
  "resume",
  "skip",
  "stop",
  "repeat",
  "faster",
  "slower",
];

/**
 * The command in a line, or undefined for anything else. Whitespace, case
 * and a leading slash are all forgiven, because people will type what a
 * chat command looks like.
 */
export function parseControl(text: string): ControlCommand | undefined {
  const line = (text.split("\n").find((l) => l.trim()) ?? "").trim().toLowerCase().replace(/^\/+/, "");
  if (!line) {
    return undefined;
  }
  const [word, argument] = line.split(/\s+/);
  if ((VERBS as string[]).includes(word)) {
    return { verb: word as ControlVerb };
  }
  if (word === "rate" || word === "speed") {
    const rate = Number(argument);
    return Number.isFinite(rate) && rate > 0 ? { verb: "faster", rate: Math.round(rate) } : undefined;
  }
  return undefined;
}

/**
 * Watches the control file and reports each new command once.
 *
 * Watching the directory rather than the file: an editor that writes by
 * replacing the file (most of them) breaks a watch on the file itself, and
 * `echo >` truncates in a way that can fire before the content lands.
 */
export class ControlWatcher {
  private watcher: fs.FSWatcher | undefined;
  private lastAt = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private onCommand: (command: ControlCommand) => void,
    private file: string = CONTROL_FILE
  ) {}

  start(): void {
    const dir = path.dirname(this.file);
    const name = path.basename(this.file);
    // Anything already in the file predates this window: read its stamp so
    // an old command is not obeyed at every startup.
    try {
      this.lastAt = fs.statSync(this.file).mtimeMs;
    } catch {
      this.lastAt = 0;
    }
    // The directory is Claude Code's, not ours: watch it if it is there, and
    // do not create it if it is not. A machine without Claude Code has
    // nothing for this extension to say anyway.
    if (!fs.existsSync(dir)) {
      return;
    }
    try {
      this.watcher = fs.watch(dir, (_event, changed) => {
        if (changed && changed.toString() !== name) {
          return;
        }
        // A write can arrive in pieces; settle first, and coalesce the burst
        // of events one write produces.
        if (this.timer) {
          clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => this.read(), 60);
        this.timer.unref?.();
      });
      this.watcher.on("error", () => this.dispose());
    } catch {
      /* no home directory to watch: the commands simply are not available */
    }
  }

  dispose(): void {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = undefined;
  }

  /** Read the file and report a command if it is new. Exposed for tests. */
  read(): void {
    let text: string;
    let at: number;
    try {
      at = fs.statSync(this.file).mtimeMs;
      // The same command, reported already
      if (at === this.lastAt) {
        return;
      }
      text = fs.readFileSync(this.file, "utf8");
    } catch {
      return; // removed, or not readable
    }
    this.lastAt = at;
    const command = parseControl(text);
    if (command) {
      this.onCommand(command);
    }
  }
}
