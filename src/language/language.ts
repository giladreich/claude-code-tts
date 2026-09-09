/**
 * Which language is this text in? Claude switches language mid-session, and
 * an English voice reading German (or an English phonemizer reading Chinese)
 * is unintelligible, so each utterance is routed to a voice that can speak
 * it. Detection is local, dependency-free and deliberately conservative: it
 * answers only when it is reasonably sure, and the caller keeps the previous
 * answer otherwise, so a short "Bash: run tests" never flips the voice.
 */
export interface ScriptCounts {
  latin: number;
  han: number;
  kana: number;
  hangul: number;
  cyrillic: number;
  greek: number;
  hebrew: number;
  arabic: number;
  devanagari: number;
  thai: number;
  total: number;
}

export function countScripts(text: string): ScriptCounts {
  // prettier-ignore
  const c: ScriptCounts = {
    latin: 0, han: 0, kana: 0, hangul: 0, cyrillic: 0, greek: 0,
    hebrew: 0, arabic: 0, devanagari: 0, thai: 0, total: 0,
  };
  for (const ch of text) {
    const p = ch.codePointAt(0)!;
    if (/\s|\d|[^\p{L}]/u.test(ch)) {
      continue;
    }
    c.total++;
    if (p >= 0x4e00 && p <= 0x9fff) {
      c.han++;
    } else if ((p >= 0x3040 && p <= 0x30ff) || (p >= 0x31f0 && p <= 0x31ff)) {
      c.kana++;
    } else if (p >= 0xac00 && p <= 0xd7af) {
      c.hangul++;
    } else if (p >= 0x0400 && p <= 0x04ff) {
      c.cyrillic++;
    } else if (p >= 0x0370 && p <= 0x03ff) {
      c.greek++;
    } else if (p >= 0x0590 && p <= 0x05ff) {
      c.hebrew++;
    } else if (p >= 0x0600 && p <= 0x06ff) {
      c.arabic++;
    } else if (p >= 0x0900 && p <= 0x097f) {
      c.devanagari++;
    } else if (p >= 0x0e00 && p <= 0x0e7f) {
      c.thai++;
    } else {
      c.latin++;
    }
  }
  return c;
}

/** Frequent short words, enough to separate the Latin-script languages the engines speak. */
const STOPWORDS: Record<string, string[]> = {
  en: ["the", "and", "is", "to", "of", "in", "that", "it", "for", "with", "you", "this", "are", "was", "not"],
  de: [
    "der",
    "die",
    "das",
    "und",
    "ist",
    "nicht",
    "ich",
    "sie",
    "mit",
    "auf",
    "für",
    "ein",
    "eine",
    "wird",
    "wurde",
    "noch",
  ],
  fr: ["le", "la", "les", "et", "est", "une", "des", "dans", "pour", "que", "pas", "sur", "avec", "vous", "cette"],
  es: ["el", "la", "los", "las", "es", "una", "por", "para", "con", "que", "del", "esta", "como", "pero"],
  it: ["il", "lo", "la", "che", "di", "un", "una", "per", "con", "sono", "non", "questo", "come", "anche", "nella"],
  pt: ["os", "as", "de", "que", "para", "com", "uma", "não", "está", "por", "isso", "mais", "quando", "arquivo"],
  nl: ["de", "het", "een", "en", "van", "is", "niet", "dat", "met", "voor", "op", "zijn", "deze", "wordt", "maar"],
};

/** Words that alone are strong evidence, to break ties on short text. */
const MARKERS: Record<string, RegExp> = {
  de: /\b(nicht|und|ich|über|müssen|können|während|Datei|wurde)\b/i,
  fr: /\b(c'est|n'est|nous|très|être|fichier|déjà)\b/i,
  es: /\b(está|también|archivo|porque|ahora|puede)\b/i,
  it: /\b(perché|questo|adesso|file|puoi|abbiamo)\b/i,
  pt: /\b(está|também|arquivo|porque|agora|você)\b/i,
  nl: /\b(niet|het|zijn|bestand|wordt|kunnen)\b/i,
};

/**
 * Language of the text as a two-letter code, or undefined when the text is
 * too short or too ambiguous to say. Never guesses from a handful of words.
 */
export function detectLanguage(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length < 8) {
    return undefined;
  }
  const s = countScripts(trimmed);
  if (s.total === 0) {
    return undefined;
  }
  const share = (n: number) => n / s.total;
  // A non-Latin script is decisive: no Latin language uses it.
  if (share(s.kana) > 0.05) {
    return "ja";
  }
  if (share(s.hangul) > 0.1) {
    return "ko";
  }
  if (share(s.han) > 0.1) {
    return "zh";
  }
  if (share(s.cyrillic) > 0.2) {
    return "ru";
  }
  if (share(s.greek) > 0.2) {
    return "el";
  }
  if (share(s.hebrew) > 0.2) {
    return "he";
  }
  if (share(s.arabic) > 0.2) {
    return "ar";
  }
  if (share(s.devanagari) > 0.2) {
    return "hi";
  }
  if (share(s.thai) > 0.2) {
    return "th";
  }

  // Single letters ("a", "o", "e") are common in several languages and in
  // prose about code, so they carry no signal and are left out.
  const words = (trimmed.toLowerCase().match(/[\p{L}']+/gu) ?? []).filter((w) => w.length > 1);
  if (words.length < 4) {
    return undefined;
  }
  const scores: Record<string, number> = {};
  for (const [code, list] of Object.entries(STOPWORDS)) {
    scores[code] = words.filter((w) => list.includes(w)).length / words.length;
  }
  for (const [code, marker] of Object.entries(MARKERS)) {
    // A distinctive word carries weight
    if (marker.test(trimmed)) {
      scores[code] += 0.08;
    }
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [best, bestScore] = ranked[0];
  const runnerUp = ranked[1]?.[1] ?? 0;
  // Enough evidence, and clearly ahead of the alternative.
  if (bestScore < 0.06 || bestScore < runnerUp * 1.5) {
    return undefined;
  }
  return best;
}

// prettier-ignore
const NAMES: Record<string, string> = {
  en: "English", de: "German", fr: "French", es: "Spanish", it: "Italian", pt: "Portuguese",
  nl: "Dutch", ja: "Japanese", zh: "Chinese", ko: "Korean", ru: "Russian", el: "Greek",
  he: "Hebrew", ar: "Arabic", hi: "Hindi", th: "Thai",
  // The rest of what Chatterbox speaks. Without these the pickers showed a
  // bare two-letter code where a language name belongs.
  da: "Danish", fi: "Finnish", ms: "Malay", no: "Norwegian", pl: "Polish",
  sv: "Swedish", sw: "Swahili", tr: "Turkish",
};

/**
 * Languages the translator can speak everything in. One list: the two flows
 * that offer it and the `speakLanguage` setting's enum all read this, because
 * they were three hand-written lists and had already drifted apart (the
 * setting rejected he, ar, hi, th and el, which the extension itself writes).
 */
// prettier-ignore
export const TRANSLATION_LANGUAGES: readonly string[] = [
  "en", "de", "fr", "es", "it", "pt", "nl", "ru", "ja", "zh", "ko", "he", "ar", "hi", "el", "th",
];

export function languageName(code: string): string {
  return NAMES[code] ?? code;
}

/** Languages whose writing has no spaces, so text length maps differently to speech. */
export function isDenseScript(code: string | undefined): boolean {
  return code === "zh" || code === "ja" || code === "th";
}

/**
 * Keeps the language stable across a message: short utterances (a tool
 * announcement, "Done.") inherit what the prose around them was in.
 */
export class LanguageTracker {
  private current: string | undefined;

  /** The language to speak this text in, or undefined to leave the voice alone. */
  update(text: string): string | undefined {
    const detected = detectLanguage(text);
    if (detected) {
      this.current = detected;
    }
    return this.current;
  }

  get language(): string | undefined {
    return this.current;
  }

  reset(): void {
    this.current = undefined;
  }
}

/**
 * Which languages an engine can actually pronounce, measured rather than
 * assumed. Kokoro's sherpa pack contains voices for many languages, but its
 * phonemizer only handles some of them: synthesized samples transcribed back
 * with Whisper came out as correct Chinese, Hindi and Korean, as English
 * read of German/French/Spanish text ("Ich habe die Datei" became "I creep
 * die that a gender"), and as literal character names for Japanese. So a
 * voice existing is not the same as a language being speakable.
 */
export const ENGINE_LANGUAGES: Record<string, string[]> = {
  // English plus the scripts the pack has lexicons or espeak data for.
  kokoro: ["en", "zh", "hi", "ko"],
  // Qwen3-TTS documents these ten and speaks them with any voice, cloned ones included.
  qwen3: ["en", "zh", "ja", "ko", "de", "fr", "ru", "pt", "es", "it"],
  // All 23 the model documents. A few were excluded here for a while because
  // they came out garbled, but the cause was the text, not the model: their
  // writing systems leave the vowels out and the model guessed at them. The
  // daemon restores the vowel marks first, which took the same sentences from
  // CER 0.294 to 0.076 (assets/diacritize.py).
  chatterbox: [
    "ar",
    "da",
    "de",
    "el",
    "en",
    "es",
    "fi",
    "fr",
    "he",
    "hi",
    "it",
    "ja",
    "ko",
    "ms",
    "nl",
    "no",
    "pl",
    "pt",
    "ru",
    "sv",
    "sw",
    "tr",
    "zh",
  ],
};

/**
 * Can this engine pronounce this language? For engines whose languages come
 * from the installed voices (system, Piper), pass what is available.
 */
export function engineSpeaks(engine: string, code: string, voiceLanguages: string[] = []): boolean {
  if (voiceLanguages.includes(code)) {
    return true;
  }
  const known = ENGINE_LANGUAGES[engine];
  return known ? known.includes(code) : true; // unknown engine: do not nag
}

/**
 * Languages the running setup can pronounce, per engine. Kokoro's and
 * Qwen3's are fixed properties of the model (measured, see ENGINE_LANGUAGES);
 * the system engine and Piper depend on what is installed, so those are
 * passed in.
 */
export interface InstalledVoiceLanguages {
  system: string[];
  piper: string[];
  /** Languages with a curated Piper voice that can be downloaded on request. */
  piperDownloadable?: string[];
  /** Chatterbox is installed and has a voice profile to speak with. */
  chatterbox?: boolean;
  /** Qwen3 is installed (either runtime). */
  qwen3?: boolean;
}

/**
 * Voice profiles (a recorded or designed reference) are shared by the two
 * engines that clone, Qwen3 and Chatterbox. The reference's language sets
 * the ACCENT; which languages the voice can then SPEAK is whatever those
 * engines pronounce, cross-language: a reference in one language speaks the
 * others through Chatterbox (measured word-for-word), with its own accent.
 */
export type ProfileEngine = "qwen3" | "chatterbox";

export function profileEnginesFor(code: string): ProfileEngine[] {
  const out: ProfileEngine[] = [];
  if (engineSpeaks("qwen3", code)) {
    out.push("qwen3");
  }
  if (engineSpeaks("chatterbox", code)) {
    out.push("chatterbox");
  }
  return out;
}

/**
 * Languages a designed reference can be rendered in. Qwen3 VoiceDesign is the
 * renderer, so this is Qwen3's list even though the voice will later speak
 * everything Chatterbox does: the choice sets the accent, not the reach.
 */
export const DESIGNABLE_LANGUAGES: readonly string[] = ENGINE_LANGUAGES.qwen3;

/**
 * Languages a designed voice can be made FOR. Wider than the set the designer
 * can render: the renderer only speaks Qwen3's ten, but Chatterbox speaks the
 * finished voice in all of its own, so a voice meant for a language the
 * designer cannot read is designed from an English passage and then speaks
 * that language.
 *
 * That is not a compromise on the words. Measured over eight sentences in one
 * such language, transcribed back with whisper-large-v3-turbo, Chatterbox
 * speaking it from an English reference scored CER 0.044 / WER 0.093,
 * slightly ahead of the same engine reading from a native recording
 * (0.076 / 0.194).
 * What the reference language carries is the accent, not the vocabulary.
 */
export function designTargetLanguages(): string[] {
  const speakable = new Set<string>([...DESIGNABLE_LANGUAGES, ...ENGINE_LANGUAGES.chatterbox]);
  return [...speakable].sort((a, b) => languageName(a).localeCompare(languageName(b)));
}

/** Can the designer render a passage in this language itself, or must it borrow English? */
export function designRendersNatively(code: string): boolean {
  return DESIGNABLE_LANGUAGES.includes(code);
}

/**
 * One honest sentence for a language picker in the design, record and
 * import flows: what building the reference in this language gets you.
 */
export function profileLanguageNote(code: string, chatterboxReady: boolean): string {
  const name = languageName(code);
  const engines = profileEnginesFor(code);
  if (engines.length === 2) {
    return `Qwen3 and Chatterbox both speak ${name} in this voice`;
  }
  if (engines.includes("chatterbox")) {
    return chatterboxReady
      ? `Chatterbox speaks ${name} in this voice (Qwen3 does not)`
      : `Only Chatterbox speaks ${name} in a voice of yours; set it up first`;
  }
  return `No engine speaks ${name} in a voice of yours: it gives other languages a ${name} accent. For ${name} itself use the Piper ${name} voice`;
}

export function enginePronounces(engine: string, code: string, installed: InstalledVoiceLanguages): boolean {
  if (engine === "system") {
    return installed.system.includes(code);
  }
  if (engine === "piper") {
    return installed.piper.includes(code);
  }
  return engineSpeaks(engine, code);
}

/**
 * What has to happen to the voice for a language to be heard properly.
 *
 * "This engine speaks German" and "the voice you are listening to speaks
 * German" are different facts, and only the first was ever checked: choosing
 * to hear everything in German with an English system voice selected left
 * German text read by an English voice, one word at a time. System and Piper
 * voices each speak one language, so there the voice has to change with the
 * language; the neural engines speak every language they cover in whatever
 * voice you picked, so there is nothing to change.
 */
export type LanguageVoiceChoice =
  /** The voice in use already says it; nothing to do. */
  | { kind: "already" }
  /** Write this value to this setting and the language is spoken properly. */
  | { kind: "switch"; setting: string; value: string; name: string }
  /** Nothing installed here says it. */
  | { kind: "none" };

/**
 * The voice this setup should speak a language with, given what is installed.
 * Pure: the caller passes the voices it found, so this can be tested without
 * a machine that has any.
 */
export function voiceChangeForLanguage(input: {
  code: string;
  engine: string;
  /** The engine's current voice: a system voice name, or a Piper model path. */
  currentVoice: string;
  systemVoices: { name: string; language?: string }[];
  piperVoices: { name: string; modelPath: string }[];
  /** Two-letter code of a Piper voice's file name, e.g. "de_DE-thorsten-medium" is "de". */
  piperLanguage: (name: string) => string | undefined;
}): LanguageVoiceChoice {
  if (input.engine === "system") {
    const current = input.systemVoices.find((v) => v.name === input.currentVoice);
    if (current?.language === input.code) {
      return { kind: "already" };
    }
    const match = input.systemVoices.find((v) => v.language === input.code);
    return match ? { kind: "switch", setting: "voice", value: match.name, name: match.name } : { kind: "none" };
  }
  if (input.engine === "piper") {
    const current = input.piperVoices.find((v) => v.modelPath === input.currentVoice);
    if (current && input.piperLanguage(current.name) === input.code) {
      return { kind: "already" };
    }
    const match = input.piperVoices.find((v) => input.piperLanguage(v.name) === input.code);
    return match
      ? { kind: "switch", setting: "piper.voice", value: match.modelPath, name: match.name }
      : { kind: "none" };
  }
  // The neural engines carry the language in the text, not in the voice.
  return engineSpeaks(input.engine, input.code) ? { kind: "already" } : { kind: "none" };
}

/** What a suggestion can name; the order they are preferred in is in suggestEngineFor below. */
export type EngineSuggestion = "system" | "piper" | "piper-download" | "qwen3" | "chatterbox";

/**
 * Which engine to suggest for a language this one cannot say. A neural voice
 * is preferred over an OS one where a real model exists: Piper has voices for
 * several languages none of the other engines here can speak at all.
 */
export function suggestEngineFor(code: string, installed: InstalledVoiceLanguages): EngineSuggestion | undefined {
  // What is already here comes first: an installed voice beats an install.
  if (installed.piper.includes(code)) {
    return "piper";
  }
  if (installed.qwen3 && engineSpeaks("qwen3", code)) {
    return "qwen3";
  }
  // Your own voice in one of those languages beats downloading a fixed
  // voice, when Chatterbox is already there to do it.
  if (installed.chatterbox && engineSpeaks("chatterbox", code)) {
    return "chatterbox";
  }
  if ((installed.piperDownloadable ?? []).includes(code)) {
    return "piper-download";
  }
  if (installed.system.includes(code)) {
    return "system";
  }
  // Nothing installed speaks it: suggest the install that would.
  if (engineSpeaks("qwen3", code)) {
    return "qwen3";
  }
  return undefined;
}
