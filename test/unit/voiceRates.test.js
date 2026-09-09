// A speaking rate belongs to the voice it was set on.
//
// One global rate meant retuning by hand on every voice change: a preset
// that already talks quickly and a slow cloned voice do not want the same
// number. The rule has to be exactly this, or it surprises: switching away
// gives the default, switching back gives yours.
const test = require("node:test");
const assert = require("node:assert/strict");
const { rateFor, voiceRateKey, withVoiceRate } = require("../../out/speech/voiceRates.js");

test("a voice with no rate of its own speaks at the default", () => {
  assert.equal(rateFor(210, {}, "kokoro", "af_heart"), 210);
  assert.equal(rateFor(210, undefined, "kokoro", "af_heart"), 210);
  assert.equal(rateFor(240, { "kokoro:af_bella": 300 }, "kokoro", "af_heart"), 240);
});

test("the rate set on a voice comes back for that voice only", () => {
  const rates = withVoiceRate({}, "kokoro", "af_heart", 280, 210);
  assert.equal(rateFor(210, rates, "kokoro", "af_heart"), 280);
  assert.equal(rateFor(210, rates, "kokoro", "af_bella"), 210, "another voice is untouched");
  assert.equal(rateFor(210, rates, "qwen3", "af_heart"), 210, "the same name on another engine is another voice");
});

test("setting a voice back to the default forgets it rather than recording it", () => {
  let rates = withVoiceRate({}, "piper", "/voices/a.onnx", 300, 210);
  assert.deepEqual(Object.keys(rates), ["piper:/voices/a.onnx"]);
  rates = withVoiceRate(rates, "piper", "/voices/a.onnx", 210, 210);
  assert.deepEqual(rates, {}, "an entry that says nothing about the pace is worth nothing");
});

test("rates survive alongside each other, and a nonsense entry is ignored", () => {
  let rates = {};
  for (const [engine, voice, rate] of [
    ["kokoro", "af_heart", 260],
    ["qwen3", "clone:me", 175],
    ["system", "", 320],
  ]) {
    rates = withVoiceRate(rates, engine, voice, rate, 210);
  }
  assert.equal(rateFor(210, rates, "kokoro", "af_heart"), 260);
  assert.equal(rateFor(210, rates, "qwen3", "clone:me"), 175);
  assert.equal(rateFor(210, rates, "system", ""), 320, "the system engine's empty voice name is still a voice");
  assert.equal(rateFor(210, { "kokoro:af_heart": "fast" }, "kokoro", "af_heart"), 210, "a bad value falls back");
  assert.equal(rateFor(210, { "kokoro:af_heart": NaN }, "kokoro", "af_heart"), 210);
});

test("the key is the engine and the voice, and only a voice name may contain a colon", () => {
  // "chatterbox:clone:my-voice" is unambiguous only because no engine name
  // contains a colon: the first one always separates engine from voice.
  assert.equal(voiceRateKey("chatterbox", "clone:my-voice"), "chatterbox:clone:my-voice");
  const engines = require("../../package.json")
    .contributes.configuration.flatMap((s) => Object.entries(s.properties))
    .find(([k]) => k === "claudeCodeTts.engine")[1].enum;
  for (const engine of engines) assert.ok(!engine.includes(":"), `${engine} would make the key ambiguous`);
});
