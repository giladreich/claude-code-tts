const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { tmpDir, writeWav } = require("../helpers");
const { listQwen3Clones, newProfileSlug, updateProfileMeta, readProfileMeta } = require("../../out/tts/qwen3.js");

// voiceManager imports vscode; load its pure helper through a stub.
const Module = require("module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "vscode") return "vscode-stub";
  return origResolve.call(this, request, ...rest);
};
require.cache["vscode-stub"] = {
  id: "vscode-stub",
  filename: "vscode-stub",
  loaded: true,
  exports: { window: {}, workspace: {}, commands: {} },
};
const { parseAdjustments } = require("../../out/ui/voiceManager.js");

test("parseAdjustments turns loudness/pace words into settings and leaves the rest for the model", () => {
  let a = parseAdjustments("Please make the voice a bit louder, more natural, pronounce the words better");
  assert.equal(a.gainFactor, 1.1);
  assert.equal(a.paceFactor, undefined);
  assert.match(a.rest, /more natural, pronounce the words better/);
  assert.ok(!/louder/.test(a.rest));
  a = parseAdjustments("much slower and quieter");
  assert.equal(a.paceFactor, 0.7);
  assert.equal(a.gainFactor, 0.7);
  assert.equal(a.rest, "");
  a = parseAdjustments("warmer");
  assert.deepEqual([a.gainFactor, a.paceFactor, a.rest], [undefined, undefined, "warmer"]);
  a = parseAdjustments("speed it up a little");
  assert.equal(a.paceFactor, 1.1);
});

test("profiles: listing reads gain/pace/designed, meta updates merge, slugs are unique", () => {
  const dir = tmpDir("cv-voices-");
  const slug = newProfileSlug(dir, "My Voice!");
  assert.equal(slug, "my-voice");
  const pd = path.join(dir, slug);
  fs.mkdirSync(pd);
  writeWav(path.join(pd, "ref.wav"), 3);
  fs.writeFileSync(
    path.join(pd, "meta.json"),
    JSON.stringify({ name: "My Voice", refText: "hi", designed: true, description: "warm", usedTranscript: true })
  );
  assert.equal(newProfileSlug(dir, "My Voice"), "my-voice-2");
  let [p] = listQwen3Clones(dir);
  assert.equal(p.gain, 1);
  assert.equal(p.pace, 1);
  assert.equal(p.designed, true);
  assert.ok(Math.abs(p.refSeconds - 3) < 0.01);
  updateProfileMeta(pd, { gain: 1.3, pace: 5 }); // pace out of range -> clamped on read
  [p] = listQwen3Clones(dir);
  assert.equal(p.gain, 1.3);
  assert.equal(p.pace, 1.4);
  assert.equal(readProfileMeta(pd).name, "My Voice");
  assert.deepEqual(readProfileMeta(path.join(dir, "nope")), {});
  // A profile without ref.wav is not listed.
  fs.mkdirSync(path.join(dir, "broken"));
  fs.writeFileSync(path.join(dir, "broken", "meta.json"), "{}");
  assert.equal(listQwen3Clones(dir).length, 1);
});

const { trashProfile, listTrashedProfiles, restoreProfile } = require("../../out/tts/qwen3.js");

test("deleting a voice is recoverable: it moves to the trash and can be restored", () => {
  const dir = tmpDir("cv-trash-");
  const make = (slug, name) => {
    fs.mkdirSync(path.join(dir, slug), { recursive: true });
    writeWav(path.join(dir, slug, "ref.wav"), 2);
    fs.writeFileSync(path.join(dir, slug, "meta.json"), JSON.stringify({ name, refText: "hi there" }));
  };
  make("keeper", "Keeper");
  make("goner", "Goner");
  const entry = trashProfile(dir, "goner");
  // Gone from the listing, still on disk, and not mistaken for a profile.
  assert.deepEqual(
    listQwen3Clones(dir).map((c) => c.slug),
    ["keeper"]
  );
  assert.ok(fs.existsSync(path.join(dir, ".trash", entry, "ref.wav")));
  const trashed = listTrashedProfiles(dir);
  assert.equal(trashed.length, 1);
  assert.equal(trashed[0].name, "Goner");
  // Restoring brings it back under a fresh slug, keeping its reference text.
  const slug = restoreProfile(dir, entry);
  const back = listQwen3Clones(dir).find((c) => c.slug === slug);
  assert.equal(back.name, "Goner");
  assert.equal(back.refText, "hi there");
  assert.deepEqual(listTrashedProfiles(dir), []);
  // A restore that collides with an existing name does not overwrite it.
  trashProfile(dir, slug);
  make(slug, "Goner");
  const second = restoreProfile(dir, listTrashedProfiles(dir)[0].entry);
  assert.notEqual(second, slug);
  assert.equal(listQwen3Clones(dir).length, 3);
});

const { passageFor, PASSAGES, PASSAGE_LANGUAGES } = require("../../out/voices/passages.js");

test("a voice profile records the language it was built in, and every language has a passage", () => {
  // The passage is what fixes a voice's accent, so one must exist per language.
  assert.ok(PASSAGE_LANGUAGES.length >= 10);
  const { isDenseScript } = require("../../out/language/language.js");
  for (const code of PASSAGE_LANGUAGES) {
    const p = PASSAGES[code];
    // A character of Chinese or Japanese is worth several of English, so the
    // bar for "about ten seconds of speech" differs by script.
    const min = isDenseScript(code) ? 30 : 60;
    assert.ok(p.length > min, `${code} passage is too short to clone from (${p.length} chars)`);
    // Devanagari ends a sentence with the danda, not a full stop.
    assert.ok(/[.。!?！？\u0964\u0965]/.test(p), `${code} passage has no sentence end`);
  }
  // A writing system whose vowels are not written needs them written HERE:
  // this passage is what a designed voice is rendered from, and the engine
  // that renders it guesses the vowels when they are missing, which stores
  // mispronounced speech as the voice itself. The daemon's diacritizer is
  // the fallback, not the plan (it is a package that may not be installed).
  const { DIACRITIZED_LANGUAGES } = require("../../out/tts/chatterbox.js");
  for (const code of DIACRITIZED_LANGUAGES) {
    assert.match(PASSAGES[code], /[\u0591-\u05c7]/, `${code} passage ships without its vowel marks`);
  }

  assert.equal(passageFor("de"), PASSAGES.de);
  assert.equal(passageFor(undefined), PASSAGES.en, "unknown language falls back to English");
  assert.equal(passageFor("xx"), PASSAGES.en);
  assert.notEqual(PASSAGES.de, PASSAGES.en, "each language has its own text");

  const dir = tmpDir("cv-lang-voices-");
  const make = (slug, meta) => {
    fs.mkdirSync(path.join(dir, slug), { recursive: true });
    writeWav(path.join(dir, slug, "ref.wav"), 3);
    fs.writeFileSync(path.join(dir, slug, "meta.json"), JSON.stringify(meta));
  };
  make("german", { name: "Anke", refText: PASSAGES.de, language: "de", designed: true });
  make("legacy", { name: "Old", refText: PASSAGES.en }); // recorded before languages existed
  const profiles = listQwen3Clones(dir);
  assert.equal(profiles.find((p) => p.slug === "german").language, "de");
  assert.equal(profiles.find((p) => p.slug === "legacy").language, undefined, "older profiles are treated as English");
});
