// Terms that must survive translation untranslated. The failure this guards
// against is real and was measured with the Argos en-to-he model: "commit"
// came back as "התחייבות" (a moral commitment) and "build" as "בניין" (a
// building), which is not what a Hebrew-speaking developer says.
const test = require("node:test");
const assert = require("node:assert/strict");
const { maskTerms, restoreTerms, survivingMarks, DEFAULT_KEEP_IN_SOURCE } = require("../../out/language/glossary.js");

test("a protected term goes out masked and comes back as it was written", () => {
  const m = maskTerms("I pushed a commit to the main branch.", DEFAULT_KEEP_IN_SOURCE);
  assert.doesNotMatch(m.text, /commit|branch/, "the model must not see the terms");
  // A translation keeps the marks and reorders the words around them.
  const translated = m.text.replace("I pushed a", "דחפתי").replace("to the main", "ל");
  const out = restoreTerms(translated, m.terms);
  assert.match(out, /commit/);
  assert.match(out, /branch/);
});

test("the plural of a term needs no entry of its own", () => {
  const m = maskTerms("The server caches the queries and logs the branches.", DEFAULT_KEEP_IN_SOURCE);
  assert.deepEqual(m.terms, ["server", "caches", "queries", "logs", "branches"]);
  assert.deepEqual(maskTerms("I opened two pull requests.", DEFAULT_KEEP_IN_SOURCE).terms, ["pull requests"]);
});

test("a term inside a longer word is left alone", () => {
  // "log" must not swallow "logic", nor "type" "typescript": those are
  // ordinary words and translating them is correct.
  const m = maskTerms("The logic of typescript is fine.", DEFAULT_KEEP_IN_SOURCE);
  assert.deepEqual(m.terms, []);
  assert.equal(m.text, "The logic of typescript is fine.");
});

test("the longest term wins, so a compound is kept whole", () => {
  assert.deepEqual(maskTerms("I added a unit test.", DEFAULT_KEEP_IN_SOURCE).terms, ["unit test"]);
  assert.deepEqual(maskTerms("I opened a pull request.", DEFAULT_KEEP_IN_SOURCE).terms, ["pull request"]);
});

test("identifiers, paths, versions and acronyms are protected without any list", () => {
  const m = maskTerms("Reading src/speech/speech.ts, chunkForSpeech and MAX_CHARS returned JSON.", []);
  assert.deepEqual(m.terms, ["src/speech/speech.ts", "chunkForSpeech", "MAX_CHARS", "JSON"]);
  assert.doesNotMatch(m.text, /speech|chunkForSpeech|JSON/);
  assert.equal(
    restoreTerms(m.text, m.terms),
    "Reading src/speech/speech.ts, chunkForSpeech and MAX_CHARS returned JSON."
  );
});

test("hyphenated English words are translated like any other word", () => {
  // An earlier pattern treated any hyphen as a sign of code, which left
  // "well-known" and "state-of-the-art" in English inside Hebrew sentences.
  for (const text of ["This is a well-known state-of-the-art approach.", "I re-ran the user-facing check."]) {
    assert.deepEqual(maskTerms(text, []).terms, [], text);
  }
});

test("a bare number is left for the number expander, not masked", () => {
  // Masking it would hide it from the step that says it as a word.
  assert.deepEqual(maskTerms("All 118 tests pass in 3.5 seconds.", []).terms, []);
});

test("an ordinary sentence is untouched, so nothing is hidden from the translator needlessly", () => {
  const text = "I looked at the change and it seems right to me.";
  const m = maskTerms(text, DEFAULT_KEEP_IN_SOURCE);
  assert.deepEqual(m.terms, []);
  assert.equal(m.text, text);
});

test("a mark the model dropped leaves no debris, and a stray mark is left alone", () => {
  const m = maskTerms("The build failed.", DEFAULT_KEEP_IN_SOURCE);
  assert.equal(restoreTerms("נכשל.", m.terms), "נכשל.", "a dropped term must not print a placeholder");
  assert.equal(restoreTerms("ZQX9 נשאר", []), "ZQX9 נשאר", "an index with no term stays as it is");
});

test("survivingMarks counts what came back, which is how a mangled translation is caught", () => {
  const m = maskTerms("The build failed, so I reverted the merge.", DEFAULT_KEEP_IN_SOURCE);
  assert.equal(m.terms.length, 2);
  assert.equal(survivingMarks(m.text, m.terms.length), 2);
  assert.equal(survivingMarks("ZQX0 נכשל", m.terms.length), 1);
  assert.equal(survivingMarks("הכל נכשל", m.terms.length), 0);
  assert.equal(survivingMarks("ZQX7 only", m.terms.length), 0, "marks beyond the count are not ours");
});

test("a user's own list replaces the software glossary", () => {
  const mine = ["Grundschutz", "Wirkungsgrad"];
  const m = maskTerms("The Grundschutz report mentions the commit.", mine);
  assert.deepEqual(m.terms, ["Grundschutz"], "their terms are protected, the built-in ones are not");
});

test("a tool announcement keeps its label and translates its description", () => {
  // "Bash: run the tests" is this extension's own label, not Claude's prose.
  // The Argos English-to-Hebrew model rendered "Bash" as a bare letter, as
  // "a tag" and as "the next" in three different sentences.
  const m = maskTerms("Bash: Wait for the suite", DEFAULT_KEEP_IN_SOURCE);
  assert.deepEqual(m.terms, ["Bash:"], "the label, colon included, is hidden");
  assert.equal(m.text, "ZQX0 Wait for the suite", "the description still goes to the translator");
  assert.equal(restoreTerms(m.text, m.terms), "Bash: Wait for the suite");
});

test("a label is only a label at the start, and only when it is one word", () => {
  // "Claude asks:" reads correctly in Hebrew, so it is left to the translator.
  assert.deepEqual(maskTerms("Claude asks: which engine?", []).terms, []);
  // A colon inside a sentence is punctuation, not a label.
  assert.deepEqual(maskTerms("I checked this: it works.", []).terms, []);
  // A lowercase opener is prose.
  assert.deepEqual(maskTerms("bash: run it", []).terms, []);
});

test("a placeholder is never masked again", () => {
  // The acronym rule matched the "ZQX" of a mark this function had just
  // written, turning ZQX0 into ZQX10 and corrupting the restoration.
  const m = maskTerms("Bash: check the JSON API", DEFAULT_KEEP_IN_SOURCE);
  assert.equal(restoreTerms(m.text, m.terms), "Bash: check the JSON API");
  assert.ok(!/ZQX\d\d/.test(m.text), `a mark was masked again: ${m.text}`);
  for (const [i] of m.terms.entries()) {
    assert.ok(m.text.includes(`ZQX${i}`), `mark ${i} is missing from ${m.text}`);
  }
});
