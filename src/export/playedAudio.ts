/**
 * The audio that was played, kept for a while so it can be exported.
 *
 * Every finished utterance is reported by its engine (src/tts/played.ts) with
 * the files it was played from, or with a way to render it again for the
 * engines that speak without a file. The files are moved here, one WAV per
 * utterance, with what is needed to put them back together the way they were
 * heard: when each one started and ended, the tempo the player applied, the
 * message it belonged to, and the text as it was synthesized (translated and
 * substituted, so an export in another language is the audio that played).
 *
 * Several windows share this directory, and each of them speaks its own
 * sessions, so each window writes its own index and names its files after
 * its own token; listing merges every window's index, and the audio of a
 * window that has closed is adopted by the next one to look, so nothing is
 * stranded. The buffer is bounded by minutes of audio, oldest out first, and
 * holds nothing at all when the setting is 0. It is the one record of what
 * was heard that this extension writes to disk, so the privacy document
 * names it, "Storage and Cleanup" lists it, and a settings reset empties it.
 *
 * No vscode import: the file work is what the unit tests exercise.
 */
import * as fs from "fs";
import * as path from "path";
import { removeFile, replaceFile, tempPathFor, writeFileAtomicSync } from "../platform/atomicFile";
import { PlayedUtterance } from "../tts/played";
import { buildWav, parseWav } from "../tts/wav";

export interface PlayedEntry {
  id: number;
  /** When playback started and ended, wall clock. */
  at: number;
  endedAt: number;
  text: string;
  engine: string;
  voice: string;
  wpm: number;
  language?: string;
  /** The message this belongs to, as the queue was told; absent for announcements of the extension's own. */
  group?: string;
  /** The tempo the player applied; 1 when the audio played as it was. */
  tempo: number;
  /** The speed the engine baked in; 1 at its natural pace. */
  synthSpeed: number;
  /** Seconds of audio at the pace the engine produced it; 0 until the file is here. */
  seconds: number;
  sampleRate: number;
  bytes: number;
  /** The WAV in the buffer directory, once the audio is here. */
  file?: string;
}

/** However many minutes are asked for, never more than this on disk per window. */
const MAX_BYTES = 1024 ** 3;

/** A file no index claims is left alone this long: another window may be about to claim it. */
const ORPHAN_GRACE_MS = 60_000;

/** Other windows' indexes are read again at most this often: a listing and a few small files. */
const FOREIGN_REFRESH_MS = 250;

/** Seconds an entry took to hear, at the tempo it played at. */
export const heardSeconds = (e: PlayedEntry): number => e.seconds / (e.tempo || 1);

export interface PlayedAudioOptions {
  /** This window's name, unique across windows and restarts; its files and index carry it. */
  token?: string;
  /** Whether the window that wrote an index is still open; a closed one's audio is adopted. */
  isLive?: (token: string) => boolean;
}

const INDEX_NAME = /^index-(.+)\.json$/;

export class PlayedAudio {
  /** This window's entries, oldest first. */
  private own: PlayedEntry[] = [];
  /** Other open windows' entries, by their token, as last read. */
  private foreign = new Map<string, PlayedEntry[]>();
  private foreignReadAt = 0;
  private counter = 0;
  /** File work and index writes, one after another. */
  private work: Promise<void> = Promise.resolve();
  /** Renders for engines without files: one at a time, in the background. */
  private renders: Promise<void> = Promise.resolve();
  private saveTimer: NodeJS.Timeout | undefined;
  /** Exports in progress; pruning waits for them. */
  private holds = 0;
  readonly token: string;
  private readonly isLive: (token: string) => boolean;

  constructor(
    readonly dir: string,
    /** Seconds of audio to keep; 0 keeps nothing. Read live, so a changed setting applies at once. */
    private readonly keepSeconds: () => number,
    opts: PlayedAudioOptions = {}
  ) {
    this.token = opts.token ?? `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    this.isLive = opts.isLive ?? (() => false);
  }

  private indexFile(token = this.token): string {
    return path.join(this.dir, `index-${token}.json`);
  }

  /**
   * Read back what was kept: this window's own index, the indexes of windows
   * that have closed (adopted), and those of windows still open (merged into
   * the listing). Files no index claims are removed once they are old enough
   * to be nobody's work in progress.
   */
  load(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    this.own = [];
    this.foreign.clear();
    const claimed = new Set<string>();
    for (const name of safeList(this.dir)) {
      const m = INDEX_NAME.exec(name) ?? (name === "index.json" ? [name, ""] : null);
      if (!m) {
        continue;
      }
      const owner = m[1];
      const entries = this.readIndex(path.join(this.dir, name));
      for (const e of entries) {
        claimed.add(e.file!);
      }
      if (owner && owner !== this.token && this.isLive(owner)) {
        this.foreign.set(owner, entries);
      } else {
        this.own.push(...entries);
        if (owner !== this.token) {
          fs.rmSync(path.join(this.dir, name), { force: true });
        }
      }
    }
    this.foreignReadAt = Date.now();
    for (const name of safeList(this.dir)) {
      const full = path.join(this.dir, name);
      if (!/^(p|raw-).+\.wav(\.(.*\.)?tmp)?$/.test(name) || claimed.has(full)) {
        continue;
      }
      try {
        if (Date.now() - fs.statSync(full).mtimeMs > ORPHAN_GRACE_MS) {
          fs.rmSync(full, { force: true });
        }
      } catch {
        /* gone already */
      }
    }
    this.own.sort((a, b) => a.at - b.at);
    const mine = new RegExp(`^p${escapeRegExp(this.token)}-(\\d+)\\.wav$`);
    this.counter = this.own.reduce((n, e) => Math.max(n, Number(mine.exec(path.basename(e.file!))?.[1] ?? 0)), 0);
    if (this.own.length > 0) {
      this.save(); // adopted entries now belong to this index
    }
  }

  /** The valid entries of an index file: audio on disk, or nothing. */
  private readIndex(file: string): PlayedEntry[] {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { entries?: PlayedEntry[] };
      return (raw.entries ?? []).filter(
        (e) => typeof e.file === "string" && e.seconds > 0 && e.at > 0 && fs.existsSync(e.file)
      );
    } catch {
      return [];
    }
  }

  /** Other windows' indexes, read again now and then; a window that closed since is adopted. */
  private refreshForeign(): void {
    if (Date.now() - this.foreignReadAt < FOREIGN_REFRESH_MS) {
      return;
    }
    this.foreignReadAt = Date.now();
    const seen = new Set<string>();
    let adopted = false;
    for (const name of safeList(this.dir)) {
      const m = INDEX_NAME.exec(name);
      if (!m || m[1] === this.token) {
        continue;
      }
      const owner = m[1];
      seen.add(owner);
      const entries = this.readIndex(path.join(this.dir, name));
      if (this.isLive(owner)) {
        this.foreign.set(owner, entries);
      } else {
        this.own.push(...entries);
        this.foreign.delete(owner);
        fs.rmSync(path.join(this.dir, name), { force: true });
        adopted = true;
      }
    }
    for (const owner of [...this.foreign.keys()]) {
      if (!seen.has(owner)) {
        this.foreign.delete(owner);
      }
    }
    if (adopted) {
      this.own.sort((a, b) => a.at - b.at);
      this.save();
    }
  }

  /**
   * Everything kept, by every open window, oldest first. An entry whose file
   * was removed behind our back ("Storage and Cleanup" frees the folder) is
   * dropped rather than offered.
   */
  list(): PlayedEntry[] {
    const gone = this.own.filter((e) => e.file && !fs.existsSync(e.file));
    if (gone.length > 0) {
      this.own = this.own.filter((e) => !gone.includes(e));
      this.save();
    }
    this.refreshForeign();
    // By file, own entries first: two windows that adopted the same closed
    // window at the same moment both list its audio, and it is one audio.
    const byFile = new Map<string, PlayedEntry>();
    for (const e of this.own) {
      if (e.file !== undefined && e.seconds > 0) {
        byFile.set(e.file, e);
      }
    }
    for (const e of [...this.foreign.values()].flat()) {
      if (e.file && !byFile.has(e.file) && fs.existsSync(e.file)) {
        byFile.set(e.file, e);
      }
    }
    return [...byFile.values()].sort((a, b) => a.at - b.at);
  }

  has(): boolean {
    return this.list().length > 0;
  }

  /** Something this window played is still being written or rendered. */
  get pending(): number {
    return this.own.filter((e) => e.file === undefined).length;
  }

  /** Resolves once everything this window reported so far is on disk. */
  ready(): Promise<void> {
    return Promise.all([this.work, this.renders]).then(() => undefined);
  }

  /**
   * Keep what an engine just played. Answers at once whether the files are
   * taken (the engine must then leave them alone); the work happens after.
   */
  retain(u: PlayedUtterance): boolean {
    if (this.keepSeconds() <= 0) {
      return false;
    }
    const parts = (u.parts ?? []).filter(Boolean);
    if (parts.length === 0 && !u.render) {
      return false;
    }
    const entry: PlayedEntry = {
      id: ++this.counter,
      at: u.startedAt,
      endedAt: u.endedAt,
      text: u.text,
      engine: u.engine,
      voice: u.voice,
      wpm: u.wpm,
      language: u.language,
      group: u.group,
      tempo: u.tempo || 1,
      synthSpeed: u.synthSpeed || 1,
      seconds: 0,
      sampleRate: 0,
      bytes: 0,
    };
    this.own.push(entry);
    const out = path.join(this.dir, `p${this.token}-${entry.id}.wav`);
    if (parts.length > 0) {
      this.work = this.work.then(() => this.absorb(entry, parts, out)).catch(() => this.drop(entry));
    } else {
      // Rendered to its own file and absorbed from there like any other part,
      // never rendered onto `out` itself: on Windows the OS voice's process
      // can still hold the file it wrote for a moment after it exits, and a
      // rename over it then fails and lost the entry.
      const render = u.render!;
      const raw = path.join(this.dir, `raw-${this.token}-${entry.id}.wav`);
      this.renders = this.renders
        .then(() => {
          fs.mkdirSync(this.dir, { recursive: true });
          return render(raw);
        })
        .then(
          // Every link of `work` settles: a rejected one would skip the next
          // entry's absorb and drop that entry instead.
          () => (this.work = this.work.then(() => this.absorb(entry, [raw], out)).catch(() => this.drop(entry, raw))),
          () => this.drop(entry, raw)
        );
    }
    return true;
  }

  /** Keep every file in place until the export reading them is done. */
  hold(): () => void {
    this.holds++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.holds--;
        this.prune();
        this.save();
      }
    };
  }

  /** The setting changed: apply it now rather than at the next sentence. */
  enforce(): void {
    if (this.keepSeconds() <= 0) {
      void this.clear(false);
      return;
    }
    this.prune();
    this.save();
  }

  /**
   * Forget everything and delete the files: this window's, and with `all`
   * every window's (a settings reset is global; a window still open notices
   * its files are gone the next time it lists them).
   */
  async clear(all = true): Promise<void> {
    await this.ready().catch(() => undefined);
    const doomed = all ? [...this.own, ...[...this.foreign.values()].flat()] : this.own;
    for (const e of doomed) {
      if (e.file) {
        fs.rmSync(e.file, { force: true });
      }
    }
    this.own = [];
    if (all) {
      for (const owner of this.foreign.keys()) {
        fs.rmSync(this.indexFile(owner), { force: true });
      }
      this.foreign.clear();
    }
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    fs.rmSync(this.indexFile(), { force: true });
  }

  /**
   * Join the parts of one utterance into one canonical WAV (16-bit mono) and
   * take the parts away; this also normalizes whatever an OS engine wrote.
   */
  private async absorb(entry: PlayedEntry, parts: string[], out: string): Promise<void> {
    fs.mkdirSync(this.dir, { recursive: true });
    const pcm: Buffer[] = [];
    let rate = 0;
    let data: Buffer;
    try {
      for (const part of parts) {
        const buf = await fs.promises.readFile(part);
        const info = parseWav(buf);
        if (!info || info.bitsPerSample !== 16) {
          throw new Error(`${path.basename(part)}: not 16-bit PCM`);
        }
        if (rate && info.sampleRate !== rate) {
          throw new Error("parts of one utterance at different sample rates");
        }
        rate = info.sampleRate;
        pcm.push(toMono(buf.subarray(info.dataOffset, info.dataOffset + info.dataLength), info.channels));
      }
      data = Buffer.concat(pcm);
      const tmp = tempPathFor(out);
      try {
        await fs.promises.writeFile(tmp, buildWav(data, rate, 1, 16));
        await replaceFile(tmp, out, true);
      } catch (e) {
        await fs.promises.rm(tmp, { force: true });
        throw e;
      }
    } finally {
      // The parts were handed over, whatever became of them; waited for, so
      // ready() means they are gone. A renderer's process can hold its file
      // for a moment after it exits, so the removal retries.
      await Promise.all(parts.map((part) => removeFile(part)));
    }
    entry.seconds = data.length / 2 / rate;
    entry.sampleRate = rate;
    entry.bytes = data.length + 44;
    entry.file = out;
    this.prune();
    this.save();
  }

  /** Forget an entry and remove its audio, and whatever else it left behind. */
  private drop(entry: PlayedEntry, ...leftovers: string[]): void {
    this.own = this.own.filter((e) => e !== entry);
    for (const file of [entry.file, ...leftovers]) {
      if (file) {
        fs.rm(file, { force: true }, () => {});
      }
    }
  }

  /** Oldest out until what this window keeps fits the minutes asked for. */
  private prune(): void {
    if (this.holds > 0) {
      return;
    }
    const keep = this.keepSeconds();
    const done = () => this.own.filter((e) => e.file);
    let seconds = done().reduce((n, e) => n + e.seconds, 0);
    let bytes = done().reduce((n, e) => n + e.bytes, 0);
    while ((seconds > keep || bytes > MAX_BYTES) && done().length > 1) {
      const oldest = done()[0];
      seconds -= oldest.seconds;
      bytes -= oldest.bytes;
      this.drop(oldest);
    }
  }

  private indexBody(): string {
    return JSON.stringify({ version: 2, token: this.token, entries: this.own.filter((e) => e.file) });
  }

  /** The index, written a moment after the last change, atomically. */
  private save(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.writeIndex();
    }, 300);
    this.saveTimer.unref?.();
  }

  private writeIndex(): void {
    const file = this.indexFile();
    try {
      if (!this.own.some((e) => e.file)) {
        fs.rmSync(file, { force: true }); // nothing to list: no index to read
        return;
      }
      writeFileAtomicSync(file, this.indexBody(), { fsync: false, copyWhenLocked: true });
    } catch {
      /* the next change writes it again */
    }
  }

  /** Write the index now rather than in a moment (a window closing). */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
      this.writeIndex();
    }
  }
}

/** Average the channels of interleaved 16-bit PCM down to one. */
function toMono(pcm: Buffer, channels: number): Buffer {
  if (channels <= 1) {
    return pcm;
  }
  const frames = Math.floor(pcm.length / 2 / channels);
  const out = Buffer.alloc(frames * 2);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      sum += pcm.readInt16LE((f * channels + c) * 2);
    }
    out.writeInt16LE(Math.round(sum / channels), f * 2);
  }
  return out;
}

function safeList(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

let active: PlayedAudio | undefined;

/** The buffer this window keeps, created at activation. */
export function initPlayedAudio(dir: string, keepSeconds: () => number, opts: PlayedAudioOptions = {}): PlayedAudio {
  active = new PlayedAudio(dir, keepSeconds, opts);
  active.load();
  return active;
}

export function playedAudio(): PlayedAudio | undefined {
  return active;
}
