/**
 * Words that should reach the ear in the language they were written in.
 *
 * Machine translation renders technical English literally, and a developer
 * hears nonsense. Measured with the translation models this extension
 * installs: "commit" came back as a moral commitment, "build" as a building,
 * "the function" as the role, and JSON as the name Jason. None of those is
 * what a developer says; they say the English word, inside a sentence in
 * their own language.
 *
 * So the terms are hidden behind placeholders before translation and put back
 * afterwards. The placeholder has to survive a neural translation model: of
 * the schemes tried against the real en-to-he model, "@@0@@" and "§0§" were
 * mangled every time, while a bare letter-and-digit token came through all
 * four times, with the target language's definite article correctly attached
 * to it. Hence this shape.
 *
 * The list is a setting, not a fixed rule: the default covers software
 * vocabulary, and anyone can add their own field's terms or empty it.
 */
/** Survives translation intact; no natural text contains it. */
const MARK = (i: number) => `ZQX${i}`;
const MARK_PATTERN = /ZQX(\d+)/g;

/**
 * Software terms an engineer says in English whatever language the sentence
 * is in. Kept deliberately short: every entry is a word whose everyday
 * translation means something else in a technical sentence.
 */
// prettier-ignore
export const DEFAULT_KEEP_IN_SOURCE = [
  "commit", "branch", "merge", "rebase", "pull request", "push",
  "build", "deploy", "deployment", "rollback", "release",
  "bug", "patch", "diff", "stack trace", "log",
  "repository", "repo", "backend", "frontend", "server", "client", "endpoint", "API",
  "database", "query", "queries", "cache", "token", "framework", "library", "libraries",
  "package", "dependency", "dependencies",
  "function", "class", "method", "variable", "parameter", "type", "interface",
  "test", "unit test", "linter", "compiler", "parser", "runtime",
  "file", "folder", "path", "script", "config", "setting", "flag",
];

/**
 * Text with the protected terms replaced by placeholders, plus what to put
 * back. Matching is case-insensitive but the original spelling is restored,
 * so "API" and "Api" both come back as they were written.
 */
export interface Masked {
  text: string;
  terms: string[];
}

/** Longest first, so "pull request" wins over "request" and "unit test" over "test". */
function termPattern(terms: string[]): RegExp | undefined {
  const cleaned = [...new Set(terms.map((t) => t.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (cleaned.length === 0) {
    return undefined;
  }
  const escaped = cleaned.map((t) => {
    const body = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    // A plain plural should not need its own entry: "cache" covers "caches",
    // "branch" covers "branches" and "pull request" covers "pull requests".
    return `${body}(?:e?s)?`;
  });
  // Word boundaries keep "log" out of "logic" and "type" out of "typescript".
  return new RegExp(`\\b(?:${escaped.join("|")})\\b`, "gi");
}

/**
 * Identifiers, versions and the like: no list can name them, and translating
 * them is always wrong. A token qualifies when it carries a mark no ordinary
 * word does, which is what separates "cache" (a word, and only protected when
 * the glossary says so) from "cacheKey", "cache_key", "cache.ts" and "CACHE".
 *
 * A hyphen alone does NOT qualify: English is full of hyphenated words, and an
 * earlier version of this pattern kept "well-known" and "state-of-the-art" in
 * English inside translated sentences. A dot, slash or underscore is required, or
 * inner capitals, or an all-caps acronym.
 */
const CODE_LIKE = new RegExp(
  [
    "[A-Za-z][A-Za-z0-9-]*[._/][A-Za-z0-9._/-]*[A-Za-z0-9]", // src/speech/speech.ts, package.json
    "[A-Za-z]+_[A-Za-z0-9_]+", // snake_case
    "[a-z]+[A-Z][A-Za-z0-9]*", // camelCase
    // Not followed by another letter or digit, so this cannot swallow the
    // "ZQX" of a placeholder this function has already written and turn
    // ZQX0 into ZQX10, which corrupted the restoration.
    "[A-Z]{2,8}s?(?![A-Za-z0-9])", // JSON, API, URLs
  ]
    .map((p) => `(?:${p})`)
    .join("|"),
  "g"
);

/**
 * The label this extension puts in front of a tool announcement, as in
 * "Bash: run the tests". It is our own interface text, not something Claude
 * wrote, and translating it produces nonsense that changes from sentence to
 * sentence: one of these models rendered "Bash" as a bare letter, as "a tag"
 * and as "the next" in three different announcements. The description after
 * the colon is prose and is translated as usual.
 */
const LEADING_LABEL = /^[A-Z][A-Za-z0-9+#.]{1,20}:(?=\s)/;

export function maskTerms(text: string, terms: string[]): Masked {
  const kept: string[] = [];
  const hide = (match: string): string => {
    kept.push(match);
    return MARK(kept.length - 1);
  };
  // The announcement label first, so it is hidden whole and keeps its colon.
  let out = text.replace(LEADING_LABEL, hide);
  // Then code-like tokens: they may contain a glossary word ("test_runner"),
  // and hiding the whole token keeps it in one piece.
  out = out.replace(CODE_LIKE, hide);
  const pattern = termPattern(terms);
  if (pattern) {
    out = out.replace(pattern, hide);
  }
  return { text: out, terms: kept };
}

/**
 * The translated text with the original terms back in place. A placeholder
 * the model dropped simply leaves nothing behind, which is better than
 * printing "ZQX3" at the reader; a placeholder it duplicated is restored
 * twice, which is harmless.
 */
export function restoreTerms(translated: string, terms: string[]): string {
  return translated.replace(MARK_PATTERN, (whole, index: string) => {
    const term = terms[Number(index)];
    return term === undefined ? whole : term;
  });
}

/** The text without any placeholders, for judging how much of it is words. */
export function stripMarks(text: string): string {
  return text.replace(MARK_PATTERN, " ");
}

/** How many of the placeholders came back, for deciding whether to trust the result. */
export function survivingMarks(translated: string, count: number): number {
  const seen = new Set<number>();
  for (const m of translated.matchAll(MARK_PATTERN)) {
    const i = Number(m[1]);
    if (i < count) {
      seen.add(i);
    }
  }
  return seen.size;
}
