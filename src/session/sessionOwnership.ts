/**
 * Which VSCode window speaks a given Claude Code session.
 *
 * Claude Code writes the same transcripts whether it runs in VSCode's
 * terminal, in a native terminal, or over ssh, so this extension can speak
 * all of them. The catch is that it is a VSCode extension: every open window
 * runs its own copy, they all watch the same directory, and if they all
 * decide to speak a session you hear it two or three times at once.
 *
 * One rule: a session is spoken by the oldest live window that has its
 * folder open, and if no window has it open, by the oldest live window there
 * is. That covers all three cases at once, and none of them twice: the
 * window you are working in reads its own project, another window's project
 * is not yours to read, and a session started in a terminal (in a folder
 * nobody has open) is read by exactly one window rather than by all of them.
 *
 * Oldest rather than newest so that opening a window never takes the voice
 * away from the one already talking. Two windows on the same folder are the
 * case that made the rule one line instead of three: the older one speaks.
 *
 * Windows announce themselves in a directory of small files and refresh them
 * on a heartbeat; one that stops (closed, crashed, machine slept) goes stale
 * and stops counting, and the next oldest takes over the terminal sessions.
 * The filesystem is the only coordination primitive available: extension
 * hosts cannot talk to each other.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface WindowRecord {
  id: string;
  pid: number;
  /** When this window started, so ownership does not move to newcomers. */
  startedAt: number;
  /** Last heartbeat. */
  at: number;
  /** Encoded project directory names this window has open. */
  dirs: string[];
}

/** How often a window refreshes its record. */
export const HEARTBEAT_MS = 15_000;

/** A record older than this is from a window that is gone. */
export const STALE_MS = 60_000;
/** How long a reading of the registry is reused, to keep the hot path cheap. */
const SNAPSHOT_MS = 3_000;
/** Records older than this are deleted on sight (a crash leaves them behind). */
const SWEEP_MS = 24 * 60 * 60 * 1000;

/**
 * Where windows announce themselves.
 *
 * Next to the transcripts rather than in the extension's own storage,
 * because VSCode and VSCode Insiders (and any other build) keep separate
 * storage directories: two registries would not see each other and both
 * builds would speak the same terminal session. On a machine with no
 * ~/.claude there is nothing to speak anyway, and the extension's storage is
 * used rather than creating a directory that belongs to another tool.
 */
export function registryDir(storageDir: string): string {
  const claude = path.join(os.homedir(), ".claude");
  return fs.existsSync(claude) ? path.join(claude, "claude-code-tts-windows") : path.join(storageDir, "windows");
}

/** Windows compare project directories case-insensitively (see tailer.ts). */
const normalize = (dir: string): string => (process.platform === "win32" ? dir.toLowerCase() : dir);

export interface OwnershipOptions {
  /** Directory holding one file per live window. */
  dir: string;
  /** This window's open project directories, read fresh on every heartbeat. */
  dirs: () => string[];
  /** Injected in tests. */
  now?: () => number;
  id?: string;
  pid?: number;
  /** When this window started; defaults to now. Injected in tests. */
  startedAt?: number;
}

export class SessionOwnership {
  private readonly dir: string;
  private readonly now: () => number;
  readonly id: string;
  private readonly pid: number;
  private readonly startedAt: number;
  private timer: NodeJS.Timeout | undefined;
  private snapshot: { at: number; records: WindowRecord[] } | undefined;

  constructor(private opts: OwnershipOptions) {
    this.dir = opts.dir;
    this.now = opts.now ?? Date.now;
    this.id = opts.id ?? `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    this.pid = opts.pid ?? process.pid;
    this.startedAt = opts.startedAt ?? this.now();
  }

  /** Announce this window and keep announcing it. */
  start(): void {
    this.write();
    this.timer = setInterval(() => this.write(), HEARTBEAT_MS);
    this.timer.unref?.();
  }

  /** Re-announce now, after the open folders changed. */
  refresh(): void {
    this.write();
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.timer = undefined;
    try {
      fs.rmSync(this.recordPath(this.id), { force: true });
    } catch {
      /* another window will see it go stale */
    }
  }

  /** Does this window speak sessions from that project directory? */
  owns(projectDir: string): boolean {
    const wanted = normalize(projectDir);
    const records = this.live();
    if (!records.some((r) => r.id === this.id)) {
      // Our own record is missing (storage unwritable, or just swept): speak
      // our own folders, and everything if the registry is empty altogether.
      // Silence is the worse failure, because nothing explains it.
      return this.opts.dirs().map(normalize).includes(wanted) || records.length === 0;
    }
    const holders = records.filter((r) => r.dirs.includes(wanted));
    return oldestOf(holders.length > 0 ? holders : records)?.id === this.id;
  }

  /** Is this the window that speaks sessions no window has open? */
  isTerminalOwner(records: WindowRecord[] = this.live()): boolean {
    // No records at all means the write failed (a read-only or missing
    // storage directory): speak rather than fall silent over bookkeeping.
    return records.length === 0 || oldestOf(records)?.id === this.id;
  }

  /** How many windows are participating, this one included. */
  windowCount(): number {
    return this.live().length;
  }

  private recordPath(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private write(): void {
    const record: WindowRecord = {
      id: this.id,
      pid: this.pid,
      startedAt: this.startedAt,
      at: this.now(),
      dirs: this.opts.dirs().map(normalize),
    };
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      // Written aside and renamed: another window must never read half a file.
      const tmp = `${this.recordPath(this.id)}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(record));
      fs.renameSync(tmp, this.recordPath(this.id));
      this.snapshot = undefined; // our own entry changed
    } catch {
      /* storage unavailable: owns() then falls back to speaking */
    }
  }

  /** Live windows, from a reading that is at most a few seconds old. */
  private live(): WindowRecord[] {
    const now = this.now();
    if (this.snapshot && now - this.snapshot.at < SNAPSHOT_MS) {
      return this.snapshot.records;
    }
    const records: WindowRecord[] = [];
    let entries: string[];
    try {
      entries = fs.readdirSync(this.dir);
    } catch {
      // No registry directory yet: this window is the only one there is.
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const file = path.join(this.dir, entry);
      try {
        const record = JSON.parse(fs.readFileSync(file, "utf8")) as WindowRecord;
        if (typeof record?.id !== "string" || typeof record.at !== "number") {
          continue;
        }
        if (now - record.at <= STALE_MS) {
          records.push({ ...record, dirs: Array.isArray(record.dirs) ? record.dirs : [] });
        } else if (now - record.at > SWEEP_MS) {
          fs.rmSync(file, { force: true }); // a crash left this behind long ago
        }
      } catch {
        /* half-written or not ours */
      }
    }
    this.snapshot = { at: now, records };
    return records;
  }
}

/** The window that has been running longest, ties broken by id. */
function oldestOf(records: WindowRecord[]): WindowRecord | undefined {
  return [...records].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))[0];
}

/**
 * The last path segment of an encoded project directory, for saying which
 * session a message came from. Claude Code encodes a cwd by replacing every
 * non-alphanumeric character with "-", so the segments are what is left.
 */
export function projectLabel(encodedDir: string): string {
  const parts = encodedDir.split("-").filter(Boolean);
  return parts[parts.length - 1] ?? encodedDir;
}
