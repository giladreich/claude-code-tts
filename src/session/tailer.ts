import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

/** Claude Code encodes a session's cwd as a directory name under ~/.claude/projects. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Compare two encoded project directory names. On Windows the same folder
 * can be spelled with either drive-letter case ("C--Users-me" from Claude
 * Code's cwd, "c--Users-me" from VSCode's Uri.fsPath), and comparing them
 * literally meant the workspace scope (`listenTo: workspace`) never matched:
 * nothing was ever spoken.
 */
export function sameProjectDir(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * The project folder a transcript belongs to: the first directory under the
 * root, not the file's immediate parent. A subagent transcript sits several
 * levels down, so the parent folder name never matched a workspace and the
 * scope check rejected every one of them.
 */
export function projectDirName(file: string, root: string = PROJECTS_DIR): string {
  const rel = path.relative(root, file);
  return rel.split(path.sep)[0] ?? "";
}

interface FileState {
  offset: number;
  partial: string;
  /** When this file last grew; recently-active files are polled. */
  lastGrowth: number;
}

/** Poll files this recently active (ms). fs.watch still covers the rest. */
const HOT_WINDOW_MS = 120_000;
const POLL_INTERVAL_MS = 150;
/**
 * Without a recursive watch (Linux before Node 20, or a machine out of
 * inotify watches), the tree is walked this often for new files and for
 * files that grew after going quiet. A walk is one stat per transcript.
 */
const RESCAN_INTERVAL_MS = 2000;
/**
 * How deep under the root transcripts are looked for. A project's own
 * transcripts sit one level down; a subagent's are nested by kind and run id,
 * and a workflow's one deeper still. Six leaves room for the next layer,
 * and the cost of an extra level is one readdir of a small directory.
 */
const MAX_DEPTH = 6;
/**
 * A never-seen file bigger than this is treated as history rather than as a
 * session that just started, and is seeded to its end instead of being read.
 */
const NEW_FILE_MAX = 256 * 1024;

/**
 * Tails every *.jsonl transcript under ~/.claude/projects and emits complete
 * new lines. Existing content at startup is skipped: only what Claude writes
 * from now on gets spoken.
 */
export class TranscriptTailer {
  private watcher: fs.FSWatcher | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private rescanTimer: NodeJS.Timeout | undefined;
  private files = new Map<string, FileState>();
  private reading = new Set<string>();
  private dirty = new Set<string>();

  constructor(
    private onLine: (line: string, file: string) => void,
    private onError: (msg: string) => void,
    /** Return true if this transcript (by its project dir name) is in scope. */
    private inScope: (projectDirName: string) => boolean,
    /** Directory holding the per-project transcript folders (tests override). */
    private root: string = PROJECTS_DIR
  ) {}

  start(): void {
    if (!fs.existsSync(this.root)) {
      this.onError(`Claude Code projects directory not found: ${this.root}`);
      return;
    }
    // Seed offsets so history is not replayed. mtime seeds lastGrowth so an
    // already-running session is polled from the first second.
    for (const file of this.listTranscripts()) {
      try {
        const stat = fs.statSync(file);
        this.files.set(file, { offset: stat.size, partial: "", lastGrowth: stat.mtimeMs });
      } catch {
        /* file vanished between list and stat */
      }
    }
    this.watch();
    // Low-latency path: watch events can lag by seconds, so recently-active
    // files are also polled. A no-growth poll is a single stat(), cheap.
    this.pollTimer = setInterval(() => {
      const now = Date.now();
      for (const [file, state] of this.files) {
        if (now - state.lastGrowth < HOT_WINDOW_MS) {
          this.readAppended(file);
        }
      }
    }, POLL_INTERVAL_MS);
  }

  /**
   * A recursive watch where the platform has one (FSEvents on macOS,
   * ReadDirectoryChangesW on Windows, inotify per directory on Linux from
   * Node 20): it is what notices a brand-new session file and a file that
   * grows after going quiet. Where it cannot be had, Linux under the Node 18
   * of older editors refuses the recursive option outright and a machine out
   * of inotify watches fails later with ENOSPC, the tree is walked instead;
   * without that, nothing said in a new session would ever have been spoken.
   */
  private watch(): void {
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (_event, filename) => {
        if (!filename || !filename.toString().endsWith(".jsonl")) {
          return;
        }
        this.readAppended(path.join(this.root, filename.toString()));
      });
    } catch (e) {
      this.onError(
        `watching the transcripts is not possible here (${(e as Error).message}); scanning for them instead`
      );
      this.rescanInstead();
      return;
    }
    this.watcher.on("error", (err) => {
      this.onError(`watch failed (${err.message}); scanning for transcripts instead`);
      this.watcher?.close();
      this.watcher = undefined;
      this.rescanInstead();
    });
  }

  private rescanInstead(): void {
    if (this.rescanTimer) {
      return;
    }
    this.rescanTimer = setInterval(() => this.rescan(), RESCAN_INTERVAL_MS);
  }

  /** New files are read from their start; known ones that grew are read from where they were left. */
  private rescan(): void {
    for (const file of this.listTranscripts()) {
      const known = this.files.get(file);
      if (!known) {
        this.readAppended(file);
        continue;
      }
      try {
        if (fs.statSync(file).size !== known.offset) {
          this.readAppended(file);
        }
      } catch {
        /* vanished between list and stat */
      }
    }
  }

  dispose(): void {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
    this.pollTimer = undefined;
    if (this.rescanTimer) {
      clearInterval(this.rescanTimer);
    }
    this.rescanTimer = undefined;
    this.files.clear();
  }

  /**
   * Every transcript under the root, at any depth.
   *
   * Subagent transcripts live in nested folders (a project's `subagents/...`
   * tree), and a one-level scan never saw them. The recursive watch did, so
   * the first line a subagent wrote arrived for a file with no recorded
   * offset and the whole file, however large, was read into the extension
   * host and spoken from the beginning. Seeding them here is what makes
   * `speakSubagents` work at all.
   */
  private listTranscripts(dir: string = this.root, depth = 0): string[] {
    const out: string[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return out; // vanished, or not a directory
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH && !e.name.startsWith(".")) {
          out.push(...this.listTranscripts(full, depth + 1));
        }
      } else if (e.name.endsWith(".jsonl")) {
        out.push(full);
      }
    }
    return out;
  }

  private projectDirOf(file: string): string {
    return projectDirName(file, this.root);
  }

  private readAppended(file: string): void {
    if (this.reading.has(file)) {
      // A read is in flight; remember to re-check when it finishes.
      this.dirty.add(file);
      return;
    }
    this.reading.add(file);

    // Out of scope: never read it. The scope check used to run after the file
    // had been read, so every transcript on the machine was pulled through
    // the extension host to decide it was not wanted. Its position is still
    // recorded, because the scope can widen ("speak every session") and a
    // file with no recorded position would then be spoken from its start.
    if (!this.inScope(this.projectDirOf(file))) {
      // Move the recorded position to the end without reading anything, for
      // known and unknown files alike: whatever was written while this
      // session was out of scope is history, not something to speak if the
      // scope widens a minute later.
      fs.stat(file, (err, stat) => {
        // The scope can widen while this stat is in flight, and the session
        // can write its next line in the same instant. Advancing the position
        // then steps over that line and nothing ever speaks it, so the widened
        // scope is checked again here, against the size that was just read:
        // leave the position where it was and read the file properly instead.
        if (this.inScope(this.projectDirOf(file))) {
          this.dirty.add(file);
        } else if (!err) {
          const known = this.files.get(file);
          if (known) {
            known.offset = stat.size;
            known.partial = "";
          } else {
            this.files.set(file, { offset: stat.size, partial: "", lastGrowth: stat.mtimeMs });
          }
        }
        this.finishRead(file);
      });
      return;
    }

    let state = this.files.get(file);
    const unknown = !state;
    if (!state) {
      state = { offset: 0, partial: "", lastGrowth: Date.now() };
      this.files.set(file, state);
    }

    fs.stat(file, (err, stat) => {
      if (err || stat.size <= state.offset) {
        if (err && err.code === "ENOENT") {
          this.files.delete(file); // session removed; stop tracking
        } else if (!err && stat.size < state.offset) {
          // Truncated/rewritten file: start over from the end.
          state.offset = stat.size;
          state.partial = "";
        }
        this.finishRead(file);
        return;
      }
      state.lastGrowth = Date.now();
      // A file we have never seen is normally a session that just started, so
      // it is read from the top. One that is already large is not: it existed
      // before this window did, and replaying it would speak an entire past
      // session. Seed to the end instead.
      if (unknown && stat.size > NEW_FILE_MAX) {
        state.offset = stat.size;
        this.finishRead(file);
        return;
      }
      const stream = fs.createReadStream(file, { start: state.offset, end: stat.size - 1 });
      let buf = "";
      stream.on("data", (chunk) => (buf += chunk.toString("utf8")));
      stream.on("error", () => this.finishRead(file));
      stream.on("end", () => {
        state.offset = stat.size;
        const text = state.partial + buf;
        const lines = text.split("\n");
        state.partial = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) {
            this.onLine(line, file);
          }
        }
        this.finishRead(file);
      });
    });
  }

  private finishRead(file: string): void {
    this.reading.delete(file);
    if (this.dirty.delete(file)) {
      this.readAppended(file);
    }
  }
}
