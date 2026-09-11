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
 * The buffer is bounded by minutes of audio, oldest out first, and holds
 * nothing at all when the setting is 0. It is the one record of what was
 * heard that this extension writes to disk, so the privacy document names
 * it, "Storage and Cleanup" lists it, and a settings reset empties it.
 *
 * No vscode import: the file work is what the unit tests exercise.
 */
import * as fs from "fs";
import * as path from "path";
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
  group?: number;
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

const INDEX = "index.json";

/** However many minutes are asked for, never more than this on disk. */
const MAX_BYTES = 1024 ** 3;

/** Seconds an entry took to hear, at the tempo it played at. */
export const heardSeconds = (e: PlayedEntry): number => e.seconds / (e.tempo || 1);

export class PlayedAudio {
  private entries: PlayedEntry[] = [];
  private nextId = 1;
  /** File work and index writes, one after another. */
  private work: Promise<void> = Promise.resolve();
  /** Renders for engines without files: one at a time, in the background. */
  private renders: Promise<void> = Promise.resolve();
  private saveTimer: NodeJS.Timeout | undefined;
  /** Exports in progress; pruning waits for them. */
  private holds = 0;

  constructor(
    readonly dir: string,
    /** Seconds of audio to keep; 0 keeps nothing. Read live, so a changed setting applies at once. */
    private readonly keepSeconds: () => number
  ) {}

  /** Read back what a previous window kept; entries whose file is gone are dropped. */
  load(): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const raw = JSON.parse(fs.readFileSync(path.join(this.dir, INDEX), "utf8")) as { entries?: PlayedEntry[] };
      this.entries = (raw.entries ?? []).filter((e) => e.file && e.seconds > 0 && fs.existsSync(e.file));
    } catch {
      this.entries = [];
    }
    this.nextId = this.entries.reduce((n, e) => Math.max(n, e.id + 1), 1);
  }

  /**
   * What is here, oldest first. An entry whose file was removed behind our
   * back ("Storage and Cleanup" frees the folder) is dropped rather than
   * offered.
   */
  list(): PlayedEntry[] {
    const gone = this.entries.filter((e) => e.file && !fs.existsSync(e.file));
    if (gone.length > 0) {
      this.entries = this.entries.filter((e) => !gone.includes(e));
      this.save();
    }
    return this.entries.filter((e) => e.file !== undefined && e.seconds > 0);
  }

  has(): boolean {
    return this.list().length > 0;
  }

  /** Something is still being written or rendered. */
  get pending(): number {
    return this.entries.filter((e) => e.file === undefined).length;
  }

  /** Resolves once everything reported so far is on disk. */
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
      id: this.nextId++,
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
    this.entries.push(entry);
    const out = path.join(this.dir, `p${entry.id}.wav`);
    if (parts.length > 0) {
      this.work = this.work.then(() => this.absorb(entry, parts, out)).catch(() => this.drop(entry));
    } else {
      const render = u.render!;
      this.renders = this.renders
        .then(() => {
          fs.mkdirSync(this.dir, { recursive: true });
          return render(out);
        })
        .then(() => (this.work = this.work.then(() => this.absorb(entry, [out], out))))
        .catch(() => this.drop(entry));
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

  /** Forget everything and delete the files. */
  async clear(): Promise<void> {
    await this.ready().catch(() => undefined);
    for (const e of this.entries) {
      if (e.file) {
        fs.rmSync(e.file, { force: true });
      }
    }
    this.entries = [];
    fs.rmSync(path.join(this.dir, INDEX), { force: true });
  }

  /**
   * Join the parts of one utterance into one canonical WAV (16-bit mono) and
   * take the parts away. A file written straight to `out` by a renderer is
   * rewritten in place, which also normalizes whatever the OS engine wrote.
   */
  private async absorb(entry: PlayedEntry, parts: string[], out: string): Promise<void> {
    fs.mkdirSync(this.dir, { recursive: true });
    const pcm: Buffer[] = [];
    let rate = 0;
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
    const data = Buffer.concat(pcm);
    const tmp = `${out}.tmp`;
    await fs.promises.writeFile(tmp, buildWav(data, rate, 1, 16));
    await fs.promises.rename(tmp, out);
    for (const part of parts) {
      if (part !== out) {
        fs.unlink(part, () => {});
      }
    }
    entry.seconds = data.length / 2 / rate;
    entry.sampleRate = rate;
    entry.bytes = data.length + 44;
    entry.file = out;
    this.prune();
    this.save();
  }

  private drop(entry: PlayedEntry): void {
    this.entries = this.entries.filter((e) => e !== entry);
    if (entry.file) {
      fs.rm(entry.file, { force: true }, () => {});
    }
  }

  /** Oldest out until what is kept fits the minutes asked for. */
  private prune(): void {
    if (this.holds > 0) {
      return;
    }
    const keep = this.keepSeconds();
    const done = () => this.entries.filter((e) => e.file);
    let seconds = done().reduce((n, e) => n + e.seconds, 0);
    let bytes = done().reduce((n, e) => n + e.bytes, 0);
    while ((seconds > keep || bytes > MAX_BYTES) && done().length > 1) {
      const oldest = done()[0];
      seconds -= oldest.seconds;
      bytes -= oldest.bytes;
      this.drop(oldest);
    }
  }

  /** The index, written a moment after the last change, atomically. */
  private save(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      const file = path.join(this.dir, INDEX);
      const body = JSON.stringify({ version: 1, entries: this.entries.filter((e) => e.file) });
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(`${file}.tmp`, body);
        fs.renameSync(`${file}.tmp`, file);
      } catch {
        /* the next change writes it again */
      }
    }, 300);
    this.saveTimer.unref?.();
  }

  /** Write the index now rather than in a moment (a window closing). */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
      const file = path.join(this.dir, INDEX);
      try {
        fs.writeFileSync(file, JSON.stringify({ version: 1, entries: this.entries.filter((e) => e.file) }));
      } catch {
        /* nothing to do about it at shutdown */
      }
    }
  }
}

/** Average the channels of interleaved 16-bit PCM down to one. */
function toMono(pcm: Buffer, channels: number): Buffer {
  if (channels <= 1) {
    return Buffer.from(pcm);
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

let active: PlayedAudio | undefined;

/** The buffer this window keeps, created at activation. */
export function initPlayedAudio(dir: string, keepSeconds: () => number): PlayedAudio {
  active = new PlayedAudio(dir, keepSeconds);
  active.load();
  return active;
}

export function playedAudio(): PlayedAudio | undefined {
  return active;
}
