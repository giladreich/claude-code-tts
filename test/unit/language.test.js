const test = require("node:test");
const assert = require("node:assert/strict");
const {
  detectLanguage,
  countScripts,
  languageName,
  isDenseScript,
  LanguageTracker,
} = require("../../out/language/language.js");

test("scripts decide the language on their own", () => {
  assert.equal(detectLanguage("ファイルを変更しました。テストは通りました。"), "ja");
  assert.equal(detectLanguage("我修改了文件。测试现在通过了，错误已经修复。"), "zh");
  assert.equal(detectLanguage("파일을 변경했습니다. 테스트가 통과했습니다."), "ko");
  assert.equal(detectLanguage("Я изменил файл, тесты теперь проходят."), "ru");
  assert.equal(detectLanguage("لقد قمت بتغيير الملف والاختبارات تعمل"), "ar");
  assert.equal(detectLanguage("मैंने फ़ाइल बदल दी है और परीक्षण पास हो गए"), "hi");
  // Japanese kana wins over the Han characters it is mixed with.
  assert.equal(detectLanguage("私はファイルを修正しました。"), "ja");
});

test("Latin languages are told apart by frequent words", () => {
  assert.equal(detectLanguage("Ich habe die Datei geändert und die Tests laufen jetzt durch."), "de");
  assert.equal(detectLanguage("The tests pass now and the race in the audio player is fixed."), "en");
  assert.equal(detectLanguage("J'ai modifié le fichier et les tests passent maintenant."), "fr");
  assert.equal(detectLanguage("He cambiado el archivo y las pruebas pasan ahora."), "es");
  assert.equal(detectLanguage("Ho modificato il file e adesso i test passano."), "it");
  assert.equal(detectLanguage("Alterei o arquivo e agora os testes passam."), "pt");
  assert.equal(detectLanguage("Ik heb het bestand gewijzigd en de tests slagen nu."), "nl");
});

test("it stays silent when there is not enough evidence", () => {
  assert.equal(detectLanguage("Done."), undefined);
  assert.equal(detectLanguage("Bash: npm test"), undefined);
  assert.equal(detectLanguage(""), undefined);
  assert.equal(detectLanguage("extension.ts"), undefined);
  assert.equal(detectLanguage("a b c d e f"), undefined, "words with no signal are not a language");
});

test("the tracker keeps short utterances in the language around them", () => {
  const t = new LanguageTracker();
  assert.equal(t.update("Ich habe die Datei geändert und die Tests laufen jetzt durch."), "de");
  assert.equal(t.update("Bash: npm test"), "de", "an announcement inherits the surrounding language");
  assert.equal(t.update("The tests pass now and the race in the audio player is fixed."), "en");
  assert.equal(t.language, "en");
  t.reset();
  assert.equal(t.language, undefined);
});

test("script counts and helpers", () => {
  const c = countScripts("abc 漢字 かな");
  assert.equal(c.latin, 3);
  assert.equal(c.han, 2);
  assert.equal(c.kana, 2);
  assert.equal(c.total, 7);
  assert.equal(languageName("de"), "German");
  assert.equal(languageName("xx"), "xx");
  assert.equal(isDenseScript("ja"), true);
  assert.equal(isDenseScript("de"), false);
});

const { engineSpeaks, ENGINE_LANGUAGES } = require("../../out/language/language.js");

test("engine language capabilities reflect what was measured, not what the voices suggest", () => {
  // Kokoro's pack has Japanese voices, but its phonemizer produces the words
  // "Japanese letter" for Japanese text, so it is not claimed.
  assert.equal(engineSpeaks("kokoro", "ja"), false);
  assert.equal(engineSpeaks("kokoro", "de"), false, "German is read with English pronunciation");
  assert.equal(engineSpeaks("kokoro", "zh"), true);
  assert.equal(engineSpeaks("kokoro", "hi"), true);
  assert.equal(engineSpeaks("qwen3", "ja"), true);
  assert.equal(engineSpeaks("qwen3", "de"), true);
  assert.equal(engineSpeaks("qwen3", "th"), false);
  // A voice the user installed for that language settles it.
  assert.equal(engineSpeaks("kokoro", "de", ["de"]), true);
  // Engines whose languages come from installed voices are never nagged about.
  assert.equal(engineSpeaks("system", "th"), true);
  assert.ok(ENGINE_LANGUAGES.qwen3.includes("ko"));
});

const { enginePronounces, suggestEngineFor } = require("../../out/language/language.js");

test("what an engine can pronounce depends on the voices installed here", () => {
  const installed = { system: ["en", "de", "he", "ar"], piper: ["en", "de"] };
  // Kokoro's coverage is a property of the model, measured: it reads Hebrew
  // as the names of the letters, so it is not offered for Hebrew.
  assert.equal(enginePronounces("kokoro", "he", installed), false);
  assert.equal(enginePronounces("kokoro", "zh", installed), true);
  // The system engine is exactly as capable as the voices the OS has.
  assert.equal(enginePronounces("system", "he", installed), true);
  assert.equal(enginePronounces("system", "th", installed), false);
  assert.equal(enginePronounces("piper", "de", installed), true);
  assert.equal(enginePronounces("piper", "he", installed), false);
  assert.equal(enginePronounces("qwen3", "ja", installed), true);

  // Suggestions prefer what actually exists on this machine.
  assert.equal(suggestEngineFor("he", installed), "system");
  assert.equal(suggestEngineFor("ja", installed), "qwen3", "no system voice: the engine that speaks it");
  assert.equal(suggestEngineFor("th", installed), undefined, "nothing here speaks Thai");
  assert.equal(suggestEngineFor("th", { system: ["th"], piper: [] }), "system");
});

const { curatedVoicesFor } = require("../../out/tts/piper.js");

test("a downloadable neural voice is preferred over an OS voice for languages nothing else speaks", () => {
  const installed = { system: ["en", "he"], piper: ["en"], piperDownloadable: ["en", "de", "he", "ar", "fa", "tr"] };
  // Hebrew: no engine here pronounces it, but a neural Piper voice exists.
  assert.equal(suggestEngineFor("he", installed), "piper-download");
  // Arabic likewise, and there is no system voice for it in this fixture.
  assert.equal(suggestEngineFor("ar", installed), "piper-download");
  // Languages an engine already speaks do not trigger a download.
  assert.equal(suggestEngineFor("ja", installed), "qwen3");
  assert.equal(suggestEngineFor("en", { ...installed, piper: ["en"] }), "piper");
  // Nothing anywhere: no suggestion rather than a wrong one.
  assert.equal(suggestEngineFor("th", { system: [], piper: [], piperDownloadable: [] }), undefined);
  // The curated list really has the voices those suggestions promise.
  for (const code of ["he", "ar", "fa", "tr", "de"]) {
    const voices = curatedVoicesFor(code);
    assert.ok(voices.length > 0, `no curated voice for ${code}`);
    assert.match(voices[0].hfDir, new RegExp(`^${code}/`), `${code} voice points at the wrong repo path`);
    assert.ok(voices[0].mb > 10 && voices[0].mb < 200);
  }
});

const {
  profileEnginesFor,
  DESIGNABLE_LANGUAGES,
  designRendersNatively,
  designTargetLanguages,
  profileLanguageNote,
} = require("../../out/language/language.js");

test("voice profiles: which engine speaks which language, and which languages can be designed", () => {
  assert.deepEqual(profileEnginesFor("de"), ["qwen3", "chatterbox"]);
  assert.deepEqual(profileEnginesFor("ar"), ["chatterbox"]);
  // Hebrew was in neither engine's list while Chatterbox was fed unvocalized
  // text and garbled it. With the vowel points restored first it is the most
  // intelligible Hebrew measured here, so a cloned voice does speak it.
  assert.deepEqual(profileEnginesFor("he"), ["chatterbox"]);
  assert.deepEqual(profileEnginesFor("cs"), [], "a language neither engine speaks");
  // The designer is Qwen3 VoiceDesign, so a designable reference is exactly
  // a Qwen3 language: offering Hebrew or Arabic here rendered noise.
  assert.deepEqual([...DESIGNABLE_LANGUAGES].sort(), [...ENGINE_LANGUAGES.qwen3].sort());
  assert.ok(!DESIGNABLE_LANGUAGES.includes("he") && !DESIGNABLE_LANGUAGES.includes("ar"));
  // A voice can be designed FOR a language the renderer cannot read: the
  // reference is rendered in English and Chatterbox speaks the language with
  // it, which measured as accurate as a native reference.
  assert.ok(designTargetLanguages().includes("he") && designTargetLanguages().includes("ar"));
  assert.ok(designTargetLanguages().includes("tr"), "and every other language Chatterbox speaks");
  assert.ok(!designTargetLanguages().includes("cs"), "but not one nothing can speak");
  assert.equal(designRendersNatively("de"), true);
  assert.equal(designRendersNatively("he"), false, "the renderer borrows English for Hebrew");
  for (const code of designTargetLanguages()) {
    assert.ok(profileEnginesFor(code).length > 0, `${code} is offered but no engine speaks it`);
  }
  assert.match(profileLanguageNote("he", true), /Chatterbox speaks Hebrew/);
  assert.match(profileLanguageNote("cs", true), /use the Piper/, "a language nothing clones still points at Piper");
  assert.match(profileLanguageNote("ar", false), /set it up first/);
  assert.match(profileLanguageNote("ar", true), /Chatterbox speaks Arabic/);
  assert.match(profileLanguageNote("de", true), /both speak German/);
});

test("what is installed is suggested before what would have to be installed", () => {
  const installed = { system: [], piper: [], piperDownloadable: ["ar", "he"], chatterbox: true };
  assert.equal(suggestEngineFor("ar", installed), "chatterbox", "your own voice beats a download of a fixed one");
  assert.equal(suggestEngineFor("ja", installed), "chatterbox", "Qwen3 is not installed here, Chatterbox is");
  assert.equal(
    suggestEngineFor("ja", { ...installed, qwen3: true }),
    "qwen3",
    "both installed: Qwen3 is faster and streams"
  );
  assert.equal(
    suggestEngineFor("ja", { system: [], piper: [] }),
    "qwen3",
    "nothing installed: the install that would speak it"
  );
  assert.equal(suggestEngineFor("he", installed), "chatterbox", "Chatterbox speaks Hebrew once the text is prepared");
  assert.equal(
    suggestEngineFor("cs", installed),
    undefined,
    "a language nothing here speaks and no curated voice covers"
  );
  assert.equal(suggestEngineFor("cs", { ...installed, piperDownloadable: ["cs"] }), "piper-download");
  assert.equal(suggestEngineFor("ar", { ...installed, chatterbox: false }), "piper-download");
});

test("choosing a language chooses the voice that can say it", () => {
  // The bug this exists for: "the system engine speaks German" was checked,
  // and nothing was done about it, so German text was read aloud by whichever
  // English voice happened to be selected. The engine speaking a language and
  // the VOICE speaking it are different facts.
  const { voiceChangeForLanguage } = require("../../out/language/language.js");
  const systemVoices = [
    { name: "Samantha", language: "en" },
    { name: "Anna", language: "de" },
    { name: "Alice", language: "it" },
  ];
  const piperVoices = [
    { name: "en_US-amy-medium", modelPath: "/v/en_US-amy-medium.onnx" },
    { name: "de_DE-thorsten-medium", modelPath: "/v/de_DE-thorsten-medium.onnx" },
  ];
  const piperLanguage = (name) => name.slice(0, 2);
  const at = (over) => voiceChangeForLanguage({ systemVoices, piperVoices, piperLanguage, ...over });

  assert.deepEqual(at({ code: "de", engine: "system", currentVoice: "Samantha" }), {
    kind: "switch",
    setting: "voice",
    value: "Anna",
    name: "Anna",
  });
  assert.deepEqual(at({ code: "de", engine: "system", currentVoice: "Anna" }), { kind: "already" }, "no churn");
  assert.deepEqual(at({ code: "ja", engine: "system", currentVoice: "Samantha" }), { kind: "none" }, "nothing says it");

  assert.deepEqual(at({ code: "de", engine: "piper", currentVoice: "/v/en_US-amy-medium.onnx" }), {
    kind: "switch",
    setting: "piper.voice",
    value: "/v/de_DE-thorsten-medium.onnx",
    name: "de_DE-thorsten-medium",
  });
  assert.deepEqual(at({ code: "de", engine: "piper", currentVoice: "/v/de_DE-thorsten-medium.onnx" }), {
    kind: "already",
  });

  // The neural engines carry the language in the text, so the voice you chose
  // keeps speaking and only its coverage decides.
  assert.deepEqual(at({ code: "de", engine: "qwen3", currentVoice: "clone:me" }), { kind: "already" });
  assert.deepEqual(at({ code: "sw", engine: "qwen3", currentVoice: "clone:me" }), { kind: "none" });
  assert.deepEqual(at({ code: "sw", engine: "chatterbox", currentVoice: "clone:me" }), { kind: "already" });
  assert.deepEqual(at({ code: "de", engine: "kokoro", currentVoice: "af_heart" }), { kind: "none" }, "Kokoro's four");
});
