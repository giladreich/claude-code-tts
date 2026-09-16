/**
 * Replacing a file without ever leaving it half-written.
 *
 * Three files this extension writes are read by someone else while it writes
 * them: ~/.claude/settings.json (the user's own, read by Claude Code and by
 * every other window), the heartbeat records that decide which window speaks,
 * and the index of what was played. A plain writeFileSync truncates first and
 * writes second, so a crash or a second writer in between leaves an empty
 * file; here the bytes go to a sibling temporary file, are flushed, and the
 * temporary file is renamed over the target, which the filesystem does as one
 * step.
 *
 * On Windows that last step can fail for a moment: a rename over a file that
 * another process has open (a reader in another window, an indexer, a virus
 * scanner) answers EPERM, EBUSY or EACCES until the handle closes. The rename
 * is retried with a short backoff, and when it still fails the contents are
 * copied over the target instead, which is not atomic but never lost.
 *
 * No vscode import: the uninstall hook runs this without one.
 */
import * as fs from "fs";
import * as path from "path";

/** Errors Windows answers while another handle is open on the target. */
const TRANSIENT = new Set(["EPERM", "EBUSY", "EACCES"]);

/** Backoff between rename attempts, in ms; about 1.6 s in all before the copy, which is not atomic. */
const BACKOFFS_MS = [25, 50, 100, 200, 300, 400, 500];

/** A temporary file older than this belongs to a process that died mid-write. */
const STALE_TMP_MS = 60_000;

/** Whether a filesystem error is one that goes away once another process lets go of the file. */
export function transientFsError(e: unknown): boolean {
  return TRANSIENT.has(String((e as NodeJS.ErrnoException)?.code));
}

/** Sleep without leaving the synchronous path: the callers are synchronous. */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** A name next to the target that no other process or attempt will pick. */
export function tempPathFor(file: string): string {
  return `${file}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.tmp`;
}

/**
 * Move `from` over `to`, retrying the transient Windows errors. When the
 * target stays locked past the retries, `copyWhenLocked` decides: a copy
 * lands the contents but is not atomic (a reader at that moment sees the
 * file empty or half-written, measured under two processes reading it
 * without pause), so it is for files whose readers tolerate that, the
 * heartbeats and the export index; the user's settings are left as they
 * were instead, and the error says why. `from` is gone afterwards whichever
 * way it went.
 */
export function replaceFileSync(from: string, to: string, copyWhenLocked = false): void {
  let lastError: unknown;
  for (let attempt = 0; attempt <= BACKOFFS_MS.length; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      lastError = e;
      if (!transientFsError(e)) {
        break;
      }
      if (attempt < BACKOFFS_MS.length) {
        sleepSync(BACKOFFS_MS[attempt]);
      }
    }
  }
  try {
    if (!copyWhenLocked) {
      throw lastError;
    }
    fs.copyFileSync(from, to);
  } catch {
    throw lastError;
  } finally {
    fs.rmSync(from, { force: true });
  }
}

/** The asynchronous twin of replaceFileSync, for callers already off the main path. */
export async function replaceFile(from: string, to: string, copyWhenLocked = false): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= BACKOFFS_MS.length; attempt++) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (e) {
      lastError = e;
      if (!transientFsError(e)) {
        break;
      }
      if (attempt < BACKOFFS_MS.length) {
        await new Promise((r) => setTimeout(r, BACKOFFS_MS[attempt]));
      }
    }
  }
  try {
    if (!copyWhenLocked) {
      throw lastError;
    }
    await fs.promises.copyFile(from, to);
  } catch {
    throw lastError;
  } finally {
    await fs.promises.rm(from, { force: true });
  }
}

/**
 * Remove a file that another process may still hold for a moment (on
 * Windows, the one that just wrote it), retrying the same transient errors;
 * a file that is already gone is no error, and one that stays locked past
 * the retries is left for the next sweep rather than reported.
 */
export async function removeFile(file: string): Promise<void> {
  for (let attempt = 0; attempt <= BACKOFFS_MS.length; attempt++) {
    try {
      await fs.promises.rm(file, { force: true });
      return;
    } catch (e) {
      if (!transientFsError(e) || attempt === BACKOFFS_MS.length) {
        return;
      }
      await new Promise((r) => setTimeout(r, BACKOFFS_MS[attempt]));
    }
  }
}

export interface AtomicWriteOptions {
  /** Flush to the disk before the rename (default true); off for records that are rewritten every few seconds. */
  fsync?: boolean;
  /** Copy over a target that stays locked (not atomic), rather than give up and keep the old file. */
  copyWhenLocked?: boolean;
}

/**
 * Write `data` to `file` so that the file is, at every instant, either its
 * previous contents or the new ones in full. The directory is created when
 * missing, and temporary files left by an earlier crash next to this one
 * are removed.
 */
export function writeFileAtomicSync(file: string, data: string | Buffer, opts: AtomicWriteOptions = {}): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  sweepStaleTemps(file);
  const tmp = tempPathFor(file);
  try {
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeFileSync(fd, data);
      if (opts.fsync !== false) {
        fs.fsyncSync(fd);
      }
    } finally {
      fs.closeSync(fd);
    }
    replaceFileSync(tmp, file, opts.copyWhenLocked === true);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * Remove `<file>.<anything>.tmp` siblings that are old enough to be nobody's
 * work in progress: a process that died between the write and the rename
 * leaves one behind, and nothing else would ever pick it up.
 */
export function sweepStaleTemps(file: string, now = Date.now()): void {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.`;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".tmp")) {
      continue;
    }
    const full = path.join(dir, name);
    try {
      if (now - fs.statSync(full).mtimeMs > STALE_TMP_MS) {
        fs.rmSync(full, { force: true });
      }
    } catch {
      /* gone already, or another process's live write */
    }
  }
}
