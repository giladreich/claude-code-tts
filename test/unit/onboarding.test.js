// Who gets pushed towards which engine, and when they get asked at all.
//
// The extension works with no setup, which is why most people would never
// install the engines that make it worth using: the built-in voice is good
// enough to ignore and bad enough to turn off. So the recommendation is a
// decision the extension makes, and it has to be the right one for someone
// who listens in a language the expressive engine cannot say.
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  NUDGE_AFTER,
  engineForProfileLanguage,
  baseLanguage,
  recommendEngine,
  recommendedSettings,
  shouldNudge,
  shouldWriteDefault,
  thisMachine,
  usesFastRuntime,
  wantedLanguages,
} = require("../../out/setup/onboarding.js");
const { ENGINE_LANGUAGES } = require("../../out/language/language.js");

test("the expressive engine is the default recommendation", () => {
  // It is the only one that can speak as a voice you record or design, which
  // is the reason to install anything at all.
  assert.equal(recommendEngine([]).engine, "qwen3");
  assert.equal(recommendEngine(["en"]).engine, "qwen3");
  for (const code of ENGINE_LANGUAGES.qwen3) {
    assert.equal(recommendEngine([code]).engine, "qwen3", `${code} is covered, so nothing heavier is needed`);
  }
});

test("someone who listens in a language it cannot say gets the wider engine", () => {
  const wider = ENGINE_LANGUAGES.chatterbox.filter((c) => !ENGINE_LANGUAGES.qwen3.includes(c));
  assert.ok(wider.length > 0, "the whole point is that one engine covers more");
  for (const code of wider) {
    assert.equal(recommendEngine([code]).engine, "chatterbox", `${code} has only one engine that speaks it`);
    // Mixed with a covered language it still wins: the uncovered one would
    // otherwise be read by a voice that cannot pronounce it.
    assert.equal(recommendEngine(["en", code]).engine, "chatterbox");
  }
});

test("a language no engine here speaks does not change the recommendation", () => {
  // Recommending the slower engine for a language it cannot say either would
  // cost 2.5 GB and fix nothing.
  assert.equal(recommendEngine(["xx"]).engine, "qwen3");
});

test("the recommendation carries a reason, and names no language", () => {
  for (const languages of [[], ["ar"]]) {
    const { reason } = recommendEngine(languages);
    assert.ok(reason.length > 20, "the notification has to say why");
    assert.doesNotMatch(reason, /English|Arabic|Chinese|German|Hebrew/i, "engines are described by what they do");
  }
});

test("regional variants are the language they are a variant of", () => {
  assert.equal(baseLanguage("pt-BR"), "pt");
  assert.equal(baseLanguage("zh_CN"), "zh");
  assert.equal(baseLanguage("  EN  "), "en");
  assert.equal(recommendEngine(["sv-SE"]).engine, "chatterbox", "a variant must not slip past the coverage check");
});

test("what the user listens to comes from their settings and their editor", () => {
  assert.deepEqual(
    wantedLanguages({ speakLanguage: "de", languageVoices: { fr: {}, "pt-BR": {} }, displayLanguage: "en-US" }),
    ["de", "fr", "pt", "en"]
  );
  assert.deepEqual(wantedLanguages({}), [], "nothing configured is not a language");
  assert.deepEqual(wantedLanguages({ speakLanguage: "", displayLanguage: "en" }), ["en"]);
  assert.deepEqual(wantedLanguages({ speakLanguage: "de", displayLanguage: "de" }), ["de"], "asked twice is once");
});

test("the offer comes once, late, and only while it would help", () => {
  const base = { engine: "system", spoken: NUDGE_AFTER, nudged: false };
  assert.equal(shouldNudge(base), true);
  assert.equal(shouldNudge({ ...base, spoken: NUDGE_AFTER - 1 }), false, "not before it has done some work");
  assert.equal(shouldNudge({ ...base, nudged: true }), false, "asked once, ever");
  assert.equal(shouldNudge({ ...base, engine: "qwen3" }), false, "nothing to offer someone who took it");
  assert.equal(shouldNudge({ ...base, engine: "kokoro" }), false, "or someone who chose another engine");
  assert.ok(NUDGE_AFTER >= 20, "interrupting after a handful of sentences is nagging");
});

test("the smaller checkpoint is the default on every machine", () => {
  // The larger one was measured on a current 16 GB laptop producing 8.4 s
  // of speech in 14.9 s: slower than its own natural pace, so the speaking rate
  // stopped being a control. It stays a choice in the picker, never the
  // default, whatever the hardware looks like on paper.
  for (const machine of [
    { platform: "darwin", arch: "arm64", cores: 8, memoryGb: 16 },
    { platform: "darwin", arch: "arm64", cores: 16, memoryGb: 128 },
    { platform: "linux", arch: "x64", cores: 32, memoryGb: 256 },
    { platform: "darwin", arch: "arm64", cores: 8, memoryGb: 8 },
  ]) {
    assert.equal(recommendedSettings(machine)["qwen3.model"], "0.6B", JSON.stringify(machine));
  }
});

test("a model is kept in memory for as long as the memory allows", () => {
  const at = (memoryGb) =>
    recommendedSettings({ platform: "darwin", arch: "arm64", cores: 8, memoryGb }).idleUnloadMinutes;
  assert.equal(at(8), 10, "a small machine gets its gigabytes back quickly");
  assert.equal(at(16), 45);
  assert.equal(at(64), 90, "a large one skips the reload pause");
});

test("a machine too small for the heavy engines is sent to the light one", () => {
  const small = { platform: "linux", arch: "x64", cores: 4, memoryGb: 4 };
  assert.equal(recommendEngine(["en"], small).engine, "kokoro");
  assert.equal(recommendEngine([], small).engine, "kokoro");
  // But only when it can say what this user listens to, and never over the
  // engine that is the only one for a language.
  const beyondKokoro = ENGINE_LANGUAGES.qwen3.find((c) => !ENGINE_LANGUAGES.kokoro.includes(c));
  assert.equal(recommendEngine([beyondKokoro], small).engine, "qwen3");
  const beyondQwen3 = ENGINE_LANGUAGES.chatterbox.find((c) => !ENGINE_LANGUAGES.qwen3.includes(c));
  assert.equal(recommendEngine([beyondQwen3], small).engine, "chatterbox");
  // A capable machine is never sent there.
  assert.equal(recommendEngine(["en"], { platform: "darwin", arch: "arm64", cores: 10, memoryGb: 16 }).engine, "qwen3");
});

test("this machine can be described without asking it anything expensive", () => {
  const m = thisMachine();
  assert.ok(m.cores >= 1 && m.memoryGb > 0, "the numbers have to be real");
  assert.equal(typeof usesFastRuntime(m), "boolean");
  assert.equal(usesFastRuntime({ platform: "darwin", arch: "arm64", cores: 8, memoryGb: 16 }), true);
  assert.equal(usesFastRuntime({ platform: "win32", arch: "x64", cores: 8, memoryGb: 16 }), false);
});

test("a machine-chosen default never lands on top of a choice or a no-op", () => {
  const at = (v) => ({ defaultValue: "0.6B", ...v });
  assert.equal(shouldWriteDefault(at({}), "1.7B"), true, "untouched, and different: write it");
  assert.equal(shouldWriteDefault(at({}), "0.6B"), false, "identical to the shipped default: write nothing");
  assert.equal(shouldWriteDefault(at({ globalValue: "0.6B" }), "1.7B"), false, "the user chose the small one");
  assert.equal(shouldWriteDefault(at({ workspaceValue: "1.7B" }), "1.7B"), false, "a workspace value is a choice too");
  assert.equal(shouldWriteDefault(at({ workspaceFolderValue: "0.6B" }), "1.7B"), false);
  assert.equal(shouldWriteDefault(undefined, "1.7B"), false, "an unknown setting is not ours to write");
});

test("the faster engine wins wherever it can say what is being spoken", () => {
  // Both engines speak the same voice profiles, so this is a free choice
  // between them and speed decides it: Qwen3 streams while it generates,
  // Chatterbox speaks only after a whole sentence and slower than realtime.
  const both = { qwen3Ready: true, chatterboxReady: true };
  const beyondQwen3 = ENGINE_LANGUAGES.chatterbox.find((c) => !ENGINE_LANGUAGES.qwen3.includes(c));
  assert.deepEqual(engineForProfileLanguage({ codes: ["de"], ...both }), {
    engine: "qwen3",
    installed: true,
  });
  assert.deepEqual(engineForProfileLanguage({ codes: ["de"], ...both }), {
    engine: "qwen3",
    installed: true,
  });
  // Only where it can say the language: this one it cannot.
  assert.deepEqual(engineForProfileLanguage({ codes: [beyondQwen3], ...both }), {
    engine: "chatterbox",
    installed: true,
  });

  // Every language that will be heard counts, not just the voice's own. A
  // voice recorded in one language while everything is spoken in another was
  // moved to an engine that could not pronounce a word of what was playing.
  assert.deepEqual(engineForProfileLanguage({ codes: ["en", beyondQwen3], ...both }), {
    engine: "chatterbox",
    installed: true,
  });
  assert.deepEqual(engineForProfileLanguage({ codes: [undefined, "de"], ...both }), {
    engine: "qwen3",
    installed: true,
  });

  // Installed beats preferred, and what is not installed is named so the
  // caller can install it rather than leave the voice unable to speak.
  assert.deepEqual(engineForProfileLanguage({ codes: ["de"], qwen3Ready: false, chatterboxReady: true }), {
    engine: "chatterbox",
    installed: true,
  });
  assert.deepEqual(engineForProfileLanguage({ codes: [beyondQwen3], qwen3Ready: true, chatterboxReady: false }), {
    engine: "chatterbox",
    installed: false,
  });
  assert.deepEqual(
    engineForProfileLanguage({ codes: [], qwen3Ready: false, chatterboxReady: false }),
    { engine: "qwen3", installed: false },
    "no language named does not constrain the choice"
  );
});
