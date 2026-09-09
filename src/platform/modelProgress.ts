/**
 * How far along a model download is.
 *
 * The engines fetch their weights themselves, inside the Python runtime, so
 * the extension never sees an HTTP response to count bytes from. What it can
 * see is the cache the runtime writes into: one directory per model, a flat
 * `blobs` folder inside it, and a `.incomplete` file for whatever is being
 * fetched right now. Watching that folder grow turns "loading model" into
 * "1.4 of 4.2 GB", which is the difference between a wait somebody tolerates
 * and one they interrupt.
 *
 * Totals come from the file listing the runtime writes into the cache before
 * it fetches anything (see expectedBytes), not from a table here that had to
 * be kept in step with the model hubs. A model whose cache has no listing
 * still reports its bytes, just without a percentage.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const GB = 1024 ** 3;

/**
 * The exact size of a model, read from the cache rather than remembered here.
 *
 * The runtimes fetch the repository's file listing before any weights and
 * write it to `trees/<revision>.json`, one entry per file with its size in
 * bytes. So the total is known from the moment a download starts, for every
 * model, without a network call and without a table in this file to keep in
 * step with what the model hubs publish. Checked against a full cache: every
 * total matches what the finished blobs weigh, to the byte.
 *
 * Undefined when the cache has no listing (an older runtime): the size
 * downloaded so far is still reported, without a percentage, rather than a
 * percentage of a number that was guessed.
 */
export function expectedBytes(hub: string, dirName: string): number | undefined {
  const trees = path.join(hub, dirName, "trees");
  let names: string[];
  try {
    names = fs.readdirSync(trees).filter((n) => n.endsWith(".json"));
  } catch {
    return undefined;
  }
  // The revision being fetched, when the cache says which; otherwise the
  // largest listing, which is the whole model rather than a stale partial one.
  let head: string | undefined;
  try {
    head = `${fs.readFileSync(path.join(hub, dirName, "refs", "main"), "utf8").trim()}.json`;
  } catch {
    /* no ref yet: the listing arrives before it */
  }
  let best: number | undefined;
  // The revision being fetched first, then any other listing in the cache:
  // one that is half-written or in a format this does not know must fall
  // back to a readable one rather than to no total at all.
  const ordered = head && names.includes(head) ? [head, ...names.filter((n) => n !== head)] : names;
  for (const name of ordered) {
    try {
      const tree = JSON.parse(fs.readFileSync(path.join(trees, name), "utf8")) as {
        files?: Record<string, { size?: number }>;
      };
      let total = 0;
      for (const file of Object.values(tree.files ?? {})) {
        if (typeof file.size === "number") {
          total += file.size;
        }
      }
      if (total <= 0) {
        continue;
      }
      if (name === head) {
        return total;
      }
      if (best === undefined || total > best) {
        best = total;
      }
    } catch {
      /* being written, or a format this does not know: the others may serve */
    }
  }
  return best;
}

/**
 * How long a partial file counts as a download in flight.
 *
 * A cancelled or crashed fetch leaves its `.incomplete` file behind for good,
 * and both questions this module answers were reading those: their bytes were
 * added to the progress (which is how "2.7 of 2.3 GB" happened, 0.35 GB of it
 * abandoned five hours earlier) and their presence said a download was still
 * running, so the notification never went away. A file being written to is
 * touched continuously; one nothing is writing to is leftovers.
 */
const PARTIAL_ACTIVE_MS = 120_000;

/** Where the Python runtimes keep their cache. */
export function hubDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  return env.HF_HOME ? path.join(env.HF_HOME, "hub") : path.join(home, ".cache", "huggingface", "hub");
}

/** The cache directory name for a model id, the way the runtimes spell it. */
export const cacheName = (modelId: string): string => "models--" + modelId.replace(/\//g, "--");

/**
 * Bytes on disk for one model. Only the flat `blobs` folder is measured: it
 * holds the weights and the partial downloads, and it costs one readdir
 * rather than a walk of the whole tree.
 */
export function modelBytes(hub: string, dirName: string, now: number = Date.now()): number {
  const blobs = path.join(hub, dirName, "blobs");
  let entries: string[];
  try {
    entries = fs.readdirSync(blobs);
  } catch {
    return 0;
  }
  let total = 0;
  for (const name of entries) {
    try {
      const stat = fs.statSync(path.join(blobs, name));
      // Leftovers from a fetch that was cancelled are not progress towards
      // this one; a partial being written to right now is.
      if (name.endsWith(".incomplete") && now - stat.mtimeMs > PARTIAL_ACTIVE_MS) {
        continue;
      }
      total += stat.size;
    } catch {
      /* vanished mid-scan: it was a temporary file */
    }
  }
  return total;
}

/** Every model in the cache, with what it occupies now. */
export function scanHub(hub: string): Map<string, number> {
  const sizes = new Map<string, number>();
  let names: string[];
  try {
    names = fs.readdirSync(hub);
  } catch {
    return sizes;
  }
  for (const name of names) {
    if (name.startsWith("models--")) {
      sizes.set(name, modelBytes(hub, name));
    }
  }
  return sizes;
}

/** True while a partial file is being written to: a fetch is running now. */
export function isFetching(hub: string, dirName: string, now: number = Date.now()): boolean {
  const blobs = path.join(hub, dirName, "blobs");
  try {
    return fs.readdirSync(blobs).some((f) => {
      if (!f.endsWith(".incomplete")) {
        return false;
      }
      try {
        return now - fs.statSync(path.join(blobs, f)).mtimeMs <= PARTIAL_ACTIVE_MS;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/** Is anything in the cache being fetched right now, by anyone? */
export function anyFetching(hub: string): boolean {
  for (const name of scanHub(hub).keys()) {
    if (isFetching(hub, name)) {
      return true;
    }
  }
  return false;
}

export interface Download {
  /** Cache directory name of the model being fetched. */
  name: string;
  bytes: number;
  /** Total, when the cache carries a file listing to read it from. */
  expected?: number;
}

/**
 * Which model grew between two scans. The largest gain wins, so a model that
 * pulls a companion (a tokenizer, say) reports the one doing the work rather
 * than flickering between them.
 */
export function growingModel(
  hub: string,
  before: Map<string, number>,
  after: Map<string, number>
): Download | undefined {
  let best: Download | undefined;
  let bestGain = 0;
  for (const [name, bytes] of after) {
    const gain = bytes - (before.get(name) ?? 0);
    if (gain > bestGain) {
      bestGain = gain;
      best = { name, bytes, expected: expectedBytes(hub, name) };
    }
  }
  return best;
}

/** Several downloads at once, added up. */
export interface Progress {
  bytes: number;
  /** Undefined when any of them has no known total: no invented percentage. */
  expected?: number;
  /** How many models are in flight. */
  count: number;
}

export function combine(downloads: Download[]): Progress {
  let bytes = 0;
  let expected: number | undefined = 0;
  for (const d of downloads) {
    bytes += d.bytes;
    if (expected === undefined || d.expected === undefined) {
      expected = undefined;
    } else {
      expected += d.expected;
    }
  }
  return { bytes, expected, count: downloads.length };
}

/**
 * The line a user reads while waiting. Two downloads at once is the case that
 * made this necessary: the engine fetching its weights while the voice
 * designer fetches its own, where showing one of them and then the other
 * looks like progress going backwards.
 */
export function progressText(p: Progress): string {
  const gb = (n: number) => `${(n / GB).toFixed(1)} GB`;
  const many = p.count > 1 ? `, ${p.count} models` : "";
  if (!p.expected) {
    return `${gb(p.bytes)}${many}`;
  }
  // Never more than the whole: the bytes count every blob in the cache while
  // the total covers the revision being fetched, so a cache holding more than
  // that must not be reported as "2.7 of 2.3 GB".
  const done = Math.min(p.bytes, p.expected);
  const percent = Math.min(99, Math.round((done / p.expected) * 100));
  return `${(done / GB).toFixed(1)} of ${gb(p.expected)} (${percent}%)${many}`;
}

/** 0 to 1 over everything in flight, or undefined when a total is unknown. */
export function fractionOf(p: Progress): number | undefined {
  return p.expected ? Math.min(1, p.bytes / p.expected) : undefined;
}

/** "1.4 of 4.2 GB (33%)", or "1.4 GB" when the total is not known. */
export function progressLabel(download: Download): string {
  const gb = (n: number) => `${(n / GB).toFixed(1)} GB`;
  if (!download.expected) {
    return gb(download.bytes);
  }
  const done = Math.min(download.bytes, download.expected);
  const percent = Math.min(99, Math.round((done / download.expected) * 100));
  return `${(done / GB).toFixed(1)} of ${gb(download.expected)} (${percent}%)`;
}

/** 0 to 1, or undefined when the total is not known. */
export function fractionDone(download: Download): number | undefined {
  if (!download.expected) {
    return undefined;
  }
  return Math.min(1, download.bytes / download.expected);
}

/** A readable name for the model, for the line the user reads. */
export function modelLabel(dirName: string): string {
  const id = dirName.replace(/^models--/, "").replace(/--/g, "/");
  return id.split("/").pop() ?? id;
}
