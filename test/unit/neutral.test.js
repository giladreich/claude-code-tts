// No language is singled out on the pages and prompts a user reads.
//
// The extension speaks 23 languages and translates into 16, and the work
// that went into any one of them is nobody's business but the maintainer's.
// Naming a few of them in the store page, the engine descriptions or the
// setup prompts reads as "this is a tool for those languages", which is both
// wrong and off-putting to everyone else.
//
// The rule: outside per-language data (the names, the passages, the voice
// starters, the per-language setting descriptions), user-facing text names
// no language except English, which is the language the interface itself is
// written in.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { ROOT } = require("../helpers");

const pkg = require(path.join(ROOT, "package.json"));

/** Every language this extension can speak or translate into, bar English. */
function languageNames() {
  const src = fs.readFileSync(path.join(ROOT, "src", "language", "language.ts"), "utf8");
  const block = src.slice(src.indexOf("const NAMES"), src.indexOf("export function languageName"));
  return [...block.matchAll(/"([A-Z][a-z]+)"/g)].map((m) => m[1]).filter((n) => n !== "English");
}

const NAMES = languageNames();
const mentions = (text) => NAMES.filter((n) => new RegExp(`\\b${n}\\b`).test(text));

test("the documentation a user reads names no particular language", () => {
  // ARCHITECTURE is for contributors and
  // PRIVACY has to name the packages it downloads, so both are exempt.
  for (const doc of [
    "README.md",
    "docs/GUIDE.md",
    "docs/REFERENCE.md",
    "docs/walkthrough/hear.md",
    "docs/walkthrough/voice.md",
    "docs/walkthrough/own.md",
    "docs/walkthrough/languages.md",
    "CHANGELOG.md",
  ]) {
    const body = fs.readFileSync(path.join(ROOT, doc), "utf8");
    assert.deepEqual(mentions(body), [], `${doc} singles out a language`);
  }
});

test("the settings a user browses name a language only where every language gets one", () => {
  const sections = Array.isArray(pkg.contributes.configuration)
    ? pkg.contributes.configuration
    : [pkg.contributes.configuration];
  for (const section of sections) {
    for (const [key, spec] of Object.entries(section.properties)) {
      const text = `${spec.description ?? ""} ${spec.markdownDescription ?? ""}`;
      assert.deepEqual(mentions(text), [], `${key}'s description singles out a language`);
      // enumDescriptions are per value: speakLanguage has one for each
      // language, which is the opposite of singling one out. Only a list
      // that names some languages and not others is a problem.
      const named = (spec.enumDescriptions ?? []).flatMap((d) => mentions(d));
      const perValue = (spec.enum ?? []).length === (spec.enumDescriptions ?? []).length;
      if (!perValue) assert.deepEqual(named, [], `${key} names languages outside a per-language list`);
    }
  }
});

test("commands and the walkthrough name no particular language", () => {
  for (const c of pkg.contributes.commands) {
    assert.deepEqual(mentions(c.title), [], `the command ${c.command} names a language`);
  }
  for (const w of pkg.contributes.walkthroughs ?? []) {
    assert.deepEqual(mentions(`${w.title} ${w.description}`), [], "the walkthrough names a language");
    for (const step of w.steps) {
      assert.deepEqual(
        mentions(`${step.title} ${step.description}`),
        [],
        `walkthrough step ${step.id} names a language`
      );
    }
  }
});

test("no source file is written up around one language", () => {
  // Comments too, not only the text a user sees: a maintainer opening the
  // source should not find one language argued for as the project's cause.
  //
  // A flat ban would be wrong. Naming what an engine covers, or handling the
  // writing systems that have no spaces, treats those languages as facts of
  // the job, and the files that are catalogues (the names and script ranges,
  // the design starters, the passages, the two engines' voice lists, the
  // text preparation) have to name them. What is not allowed is one language
  // recurring through a file: that is advocacy, and it is how this codebase
  // read before, with one language named eight times in a single engine file
  // and thirty times across the tree.
  const catalogues = new Set([
    "language/language.ts",
    "voices/starters.ts",
    "voices/passages.ts",
    "tts/piper.ts",
    "tts/qwen3.ts",
  ]);
  const MAX_PER_FILE = 4;
  const offenders = [];
  const check = (file, label) => {
    const body = fs.readFileSync(file, "utf8");
    for (const name of NAMES) {
      const count = (body.match(new RegExp(`\\b${name}\\b`, "g")) ?? []).length;
      if (count > MAX_PER_FILE) offenders.push(`${label}: ${name} ${count} times`);
    }
  };
  const walk = (dir, prefix = "") => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix + e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), `${rel}/`);
      else if (e.name.endsWith(".ts") && !catalogues.has(rel)) check(path.join(dir, e.name), `src/${rel}`);
    }
  };
  walk(path.join(ROOT, "src"));
  for (const f of fs.readdirSync(path.join(ROOT, "assets"))) {
    if (/\.(py|js|swift)$/.test(f) && f !== "diacritize.py") check(path.join(ROOT, "assets", f), `assets/${f}`);
  }
  assert.deepEqual(offenders, [], "source files that dwell on one language");
});

test("prompts and messages name a language only when it is the one being acted on", () => {
  // A message may say "German will be spoken by ..." when the user just
  // picked German: that is the language they chose, not one the extension
  // advertises. What it may not do is list favourites in a prompt that is
  // not about a specific language, so this checks for literal names in
  // quoted strings rather than interpolated ones.
  const files = [
    "extension.ts",
    "setup/diagnostics.ts",
    "voices/design.ts",
    "voices/clone.ts",
    "voices/cloneFromFile.ts",
    "ui/voiceManager.ts",
    "ui/storageUi.ts",
    "setup/notifySetup.ts",
    "ui/prompts.ts",
  ];
  const offenders = [];
  for (const file of files) {
    const body = fs.readFileSync(path.join(ROOT, "src", file), "utf8");
    for (const line of body.split("\n")) {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue; // comments are for maintainers
      for (const m of line.matchAll(/"([^"]{12,})"|`([^`]{12,})`/g)) {
        const text = m[1] ?? m[2];
        const named = mentions(text);
        if (named.length) offenders.push(`src/${file}: ${named.join(", ")} in ${JSON.stringify(text.slice(0, 90))}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "user-facing strings that single out a language");
});
