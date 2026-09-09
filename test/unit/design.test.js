// The description a designed voice starts from. A language with no entry of
// its own silently fell back to the American English wording, so asking for a
// Hebrew voice produced "a warm American woman speaking her native English"
// and the voice sounded exactly like that.
const test = require("node:test");
const assert = require("node:assert/strict");
const { designTargetLanguages, languageName } = require("../../out/language/language.js");
const { startersFor } = require("../../out/voices/starters.js");
const { passageFor, PASSAGES } = require("../../out/voices/passages.js");

test("every language a voice can be designed for has a name, not a bare code", () => {
  for (const code of designTargetLanguages()) {
    assert.notEqual(languageName(code), code, `${code} would be shown as a two-letter code`);
  }
});

test("the starters describe a speaker of the language asked for", () => {
  const hebrew = startersFor("he");
  assert.ok(hebrew.length > 0);
  for (const s of hebrew) {
    assert.match(s.instruct, /Israeli|Hebrew/, `Hebrew starter does not describe a Hebrew speaker: ${s.instruct}`);
    assert.doesNotMatch(
      s.instruct,
      /American|native English/,
      `Hebrew starter describes an English speaker: ${s.instruct}`
    );
  }
  assert.match(startersFor("ar")[0].instruct, /Arabic/);
  assert.match(startersFor("tr")[0].instruct, /Turkish/);
  assert.match(startersFor("de")[0].instruct, /German/);
});

test("no design language falls back to the English wording", () => {
  for (const code of designTargetLanguages()) {
    if (code === "en") continue;
    const first = startersFor(code)[0].instruct;
    assert.doesNotMatch(first, /American/, `${languageName(code)} fell back to the American English starter`);
  }
});

test("every language a voice can be designed for has its own passage", () => {
  // passageFor() falls back to English for an unknown language, and the
  // designer then re-recorded ENGLISH text under, say, a Turkish tag: asking
  // for a Turkish voice produced a voice reading English.
  const english = passageFor("en");
  for (const code of designTargetLanguages()) {
    if (code === "en") continue;
    assert.notEqual(passageFor(code), english, `${languageName(code)} falls back to the English passage`);
    assert.ok(PASSAGES[code], `${languageName(code)} has no passage of its own`);
  }
});

test("passages are plain prose of a usable length", () => {
  for (const [code, text] of Object.entries(PASSAGES)) {
    assert.doesNotMatch(text, /[0-9]/, `${code} passage contains digits, which speech models read badly`);
    assert.doesNotMatch(text, /["`<>{}]/, `${code} passage contains markup or quotes`);
    // Roughly 10 seconds of speech. Dense scripts pack more per character.
    const min = ["zh", "ja", "ko", "hi"].includes(code) ? 30 : 90;
    assert.ok(text.length >= min, `${code} passage is too short to clone from (${text.length} chars)`);
    assert.ok(text.length <= 320, `${code} passage is too long (${text.length} chars)`);
  }
});
