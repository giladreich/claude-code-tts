/**
 * Offline translation, so speech can be heard in a language other than the
 * one Claude wrote in. Argos Translate runs OpenNMT models locally; like the
 * speech models, they are downloaded once on request and used offline after
 * that. Nothing is sent to a service ([docs/PRIVACY.md](../../docs/PRIVACY.md)).
 *
 * Translation is best effort: if the model is missing or the daemon fails,
 * the original text is spoken rather than nothing.
 */

import * as fs from "fs";
import * as path from "path";
import { splitSentences } from "../speech/format";
import { maskTerms, restoreTerms, stripMarks, survivingMarks } from "./glossary";
import { uvToolPython } from "../platform/platform";
import { PyTtsDaemon } from "../tts/pyDaemon";

export function findTranslatePython(): string | undefined {
  return uvToolPython("argostranslate", "argostranslate") ?? uvToolPython("argos-translate", "argostranslate");
}

export function translationAvailable(): boolean {
  return findTranslatePython() !== undefined;
}

export interface TranslatorOptions {
  daemonScript: string;
  logFile?: string;
  onError?: (msg: string) => void;
  /**
   * The model for a direction is not installed. Called once per direction
   * (again after an install), so the extension can offer the download
   * instead of logging a failure per paragraph.
   */
  onMissingModel?: (from: string, to: string) => void;
  /**
   * Terms to leave in the source language (see glossary.ts). Read per call so
   * a change to the setting takes effect without a restart.
   */
  keepTerms?: () => string[];
  /** Injected in tests. */
  python?: string;
}

/**
 * A sentence has to be at least this long, and carry this many ordinary
 * words, before coming back unchanged is taken as evidence of anything: a
 * short line, or one that is mostly identifiers, can legitimately survive a
 * translation as it was written.
 */
const COPY_MIN_CHARS = 24;
const COPY_MIN_WORDS = 4;

/**
 * Sentences the model handed back exactly as they were sent.
 *
 * This is a real failure mode, not a theory: measured against the installed
 * en-to-ar model, ten of twelve technical sentences carrying glossary
 * placeholders came back either copied verbatim or with placeholders
 * missing, while the same sentences with only identifiers hidden translated
 * cleanly. A copied sentence is the visible half of that: a paragraph read in
 * the target language with one sentence still in English in the middle of it.
 */
export function copiedSentences(sent: string, received: string): string[] {
  return splitSentences(sent)
    .map((s) => s.trim())
    .filter(
      (s) =>
        s.length >= COPY_MIN_CHARS &&
        stripMarks(s)
          .split(/\s+/)
          .filter((w) => /\p{L}/u.test(w)).length >= COPY_MIN_WORDS &&
        received.includes(s)
    );
}

/**
 * Does speaking in one language from another need a model fetched first?
 *
 * A language is never translated into itself, and no such model is published:
 * asking for one is what made choosing the language Claude already writes in
 * report a failed download.
 */
export function translationModelMissing(pairs: string[], from: string, to: string): boolean {
  return from !== to && !pairs.includes(`${from}>${to}`);
}

/** What a model did to the placeholders it was given. */
type Damage = "copied" | "dropped";

/** One translation and how well it came back. */
interface Attempt {
  text: string;
  damage?: Damage;
  /** Placeholders returned, of those sent. */
  kept: number;
  total: number;
}

/** How long a direction with no model is left alone before the daemon is asked again. */
const MISSING_RETRY_MS = 30_000;

export class Translator {
  private daemon: PyTtsDaemon | undefined;
  private starts = 0;
  private readonly python: string | undefined;
  /** Recent results (least recently used first), so a repeated line is not translated twice. */
  private cache = new Map<string, string>();
  private static readonly CACHE_MAX = 200;
  /** Directions the daemon reported no model for, with when to ask again. */
  private missingUntil = new Map<string, number>();
  private reportedMissing = new Set<string>();
  /** Directions whose model mangles the placeholders; those keep identifiers only. */
  private marksHurt = new Set<string>();

  constructor(private opts: TranslatorOptions) {
    this.python = opts.python ?? findTranslatePython();
  }

  get available(): boolean {
    return this.python !== undefined && fs.existsSync(this.opts.daemonScript);
  }

  private connect(): PyTtsDaemon | undefined {
    if (!this.available) {
      return undefined;
    }
    if (this.daemon?.alive) {
      return this.daemon;
    }
    // Repeated crashes: speak the original
    if (this.starts >= 2) {
      return undefined;
    }
    this.starts++;
    this.daemon = new PyTtsDaemon(this.python!, this.opts.daemonScript, {}, this.opts.onError ?? (() => {}), {
      readyTimeoutMs: 120_000,
      logFile: this.opts.logFile,
    });
    return this.daemon;
  }

  /** Language pairs with a model installed, as "en>de". */
  async pairs(): Promise<string[]> {
    const d = this.connect();
    if (!d) {
      return [];
    }
    try {
      const msg = await d.request({ op: "packages" }).promise;
      return Array.isArray(msg?.pairs) ? msg.pairs : [];
    } catch {
      return [];
    }
  }

  /** Download a model for a pair. Explicit, user-initiated, ~100 MB. */
  async install(from: string, to: string): Promise<void> {
    const d = this.connect();
    if (!d) {
      throw new Error("the translation runtime is not installed");
    }
    await d.request({ op: "install", from, to }).promise;
    this.missingUntil.delete(`${from}>${to}`);
    this.reportedMissing.delete(`${from}>${to}`);
  }

  /**
   * Translate, or return the original when that is not possible. Text that
   * is already in the target language is returned untouched.
   */
  async translate(text: string, from: string, to: string): Promise<string> {
    if (!text.trim() || from === to) {
      return text;
    }
    const key = `${from}>${to}|${text}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) {
      this.cache.delete(key); // re-insert: a Map keeps insertion order, so the oldest entry stays first
      this.cache.set(key, hit);
      return hit;
    }
    const pair = `${from}>${to}`;
    // A direction without a model is not asked about per paragraph: the
    // original is spoken, and the daemon is consulted again after a pause in
    // case the model has been installed meanwhile (possibly by another window).
    const retryAt = this.missingUntil.get(pair);
    if (retryAt !== undefined) {
      if (Date.now() < retryAt) {
        return text;
      }
      this.missingUntil.delete(pair);
    }
    const d = this.connect();
    if (!d) {
      return text;
    }
    try {
      // Technical terms and identifiers go behind placeholders, so the model
      // translates the sentence around them and they arrive as written. Not
      // every model can carry that many, so what comes back is checked and
      // the demands are lowered a step at a time.
      const glossary = this.marksHurt.has(pair) ? [] : (this.opts.keepTerms?.() ?? []);
      let result = await this.attempt(d, text, from, to, glossary);
      if (result.damage && glossary.length > 0) {
        // Hiding the vocabulary costs this direction more than it saves.
        // Identifiers stay hidden (translating one is always wrong); the
        // words are let through to be translated like any others.
        this.marksHurt.add(pair);
        this.opts.onError?.(
          `translation: ${pair} came back ${result.damage === "copied" ? "with whole sentences untranslated" : "with terms missing"}, so from now on only identifiers are kept in the source language for it`
        );
        result = await this.attempt(d, text, from, to, []);
      }
      if (result.damage === "copied") {
        // These models handle a short input differently from a paragraph, so
        // whatever came back in the language it was written in is asked for
        // again, one sentence at a time.
        result = await this.sentenceBySentence(d, text, from, to);
      }
      // Holes are worse than English: a translation missing most of its
      // terms is not a sentence about the same thing.
      const out = result.total > 0 && result.kept < result.total / 2 ? text : result.text;
      if (this.cache.size >= Translator.CACHE_MAX) {
        this.cache.delete(this.cache.keys().next().value!);
      }
      this.cache.set(key, out);
      return out;
    } catch (e) {
      const message = (e as Error).message;
      if (/no model installed/i.test(message)) {
        this.missingUntil.set(pair, Date.now() + MISSING_RETRY_MS);
        if (!this.reportedMissing.has(pair)) {
          this.reportedMissing.add(pair);
          this.opts.onError?.(`translation skipped: ${message}`);
          this.opts.onMissingModel?.(from, to);
        }
        return text;
      }
      this.opts.onError?.(`translation failed: ${message}`);
      return text;
    }
  }

  /**
   * One translation of the whole text with a given glossary, and what came
   * back: the placeholders that survived, and whether any sentence was
   * handed back in the language it was written in.
   */
  private async attempt(d: PyTtsDaemon, text: string, from: string, to: string, glossary: string[]): Promise<Attempt> {
    const masked = maskTerms(text, glossary);
    const msg = await d.request({ text: masked.text, from, to }).promise;
    const raw = typeof msg?.text === "string" && msg.text.trim() ? msg.text : masked.text;
    const kept = survivingMarks(raw, masked.terms.length);
    const damage: Damage | undefined = copiedSentences(masked.text, raw).length
      ? "copied"
      : kept < masked.terms.length
        ? "dropped"
        : undefined;
    return { text: restoreTerms(raw, masked.terms), damage, kept, total: masked.terms.length };
  }

  /**
   * The last resort before speaking English: every sentence translated on its
   * own, identifiers hidden and nothing else. A sentence that still comes
   * back as it was sent is kept as it is, so one stubborn sentence costs its
   * own words rather than the whole paragraph's.
   */
  private async sentenceBySentence(d: PyTtsDaemon, text: string, from: string, to: string): Promise<Attempt> {
    const out: string[] = [];
    for (const sentence of splitSentences(text)) {
      try {
        const one = await this.attempt(d, sentence, from, to, []);
        out.push(one.damage === "copied" || one.kept < one.total / 2 ? sentence : one.text);
      } catch {
        out.push(sentence); // this sentence stays as written; the rest still speaks
      }
    }
    return { text: out.join(" ").replace(/\s+/g, " ").trim(), kept: 0, total: 0 };
  }

  /**
   * Load the model before it is needed: the first translation pays about
   * four seconds for that, which would otherwise be heard as a delay on the
   * first thing Claude says.
   */
  prewarm(target: string): void {
    if (!this.available || !target) {
      return;
    }
    this.translate("Ready.", "en", target).catch(() => {});
  }

  dispose(): void {
    this.daemon?.dispose();
    this.daemon = undefined;
  }
}

export function translateDaemonScript(extensionPath: string): string {
  return path.join(extensionPath, "assets", "translate_daemon.py");
}
