// Text preparation for Hebrew and Arabic (assets/diacritize.py), run against
// FAKE nakdimon/num2words modules so the tests need no models and no network.
// What matters here is what must NOT be touched: identifiers, versions and
// file:line references are most of what a coding assistant says, and a number
// expander that mangles them is worse than none.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { ROOT, tmpDir } = require("../helpers");

const python = process.platform === "win32" ? "python" : "python3";

/** Stand-ins that mark what they touched, so the caller can see the reach. */
function fakeModules(dir) {
  fs.writeFileSync(
    path.join(dir, "num2words.py"),
    `def num2words(value, lang="en"):
    return "<%s:%s>" % (lang, value)
`
  );
  fs.mkdirSync(path.join(dir, "nakdimon"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "nakdimon", "__init__.py"),
    `MAIN_MODEL = "fake.onnx"
`
  );
  // predict() marks every Hebrew letter, standing in for vowel points.
  fs.writeFileSync(
    path.join(dir, "nakdimon", "predict.py"),
    `def load_cached_model(path):
    return {"loaded": path}

def predict(text, model, maxlen=10000):
    assert isinstance(model, dict) and model.get("loaded"), "session must be reused"
    assert maxlen < 10000, "must bound maxlen: the default pads to 10000 and costs seconds"
    return "".join(c + "\\u05b7" if "\\u05d0" <= c <= "\\u05ea" else c for c in text)
`
  );
  return dir;
}

/** prepare(text, language) in a subprocess, with whichever modules `dir` holds. */
function prepare(text, language, dir) {
  const r = spawnSync(
    python,
    [
      "-c",
      "import json,sys; sys.path.insert(0, sys.argv[1]); from diacritize import prepare; print(json.dumps(prepare(sys.argv[2], sys.argv[3])))",
      path.join(ROOT, "assets"),
      text,
      language,
    ],
    { encoding: "utf8", env: { ...process.env, PYTHONPATH: dir } }
  );
  assert.equal(r.status, 0, `diacritize failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

test("Hebrew gets vowel points and spoken numbers", () => {
  const dir = fakeModules(tmpDir("cv-dia-"));
  const out = prepare("כל 118 הבדיקות עוברות.", "he", dir);
  assert.match(out, /<he:118>/, "the number is expanded in Hebrew");
  assert.match(out, /ַ/, "the Hebrew letters carry points");
});

test("Arabic gets spoken numbers and is not pointed", () => {
  const dir = fakeModules(tmpDir("cv-dia-"));
  const out = prepare("ثلاثة اختبارات و 118 أخرى.", "ar", dir);
  assert.match(out, /<ar:118>/);
  assert.doesNotMatch(out, /ַ/, "Hebrew niqqud must never appear in Arabic");
});

test("other languages are returned untouched", () => {
  const dir = fakeModules(tmpDir("cv-dia-"));
  const text = "All 118 tests pass now.";
  assert.equal(prepare(text, "en", dir), text);
  assert.equal(prepare(text, "de", dir), text);
});

test("identifiers, versions and file:line references survive intact", () => {
  const dir = fakeModules(tmpDir("cv-dia-"));
  // Every one of these is a number the engine must read as written, inside
  // text that is otherwise Hebrew.
  for (const token of ["src/speech/speech.ts:42", "1.32.2", "mms-tts-heb", "mp3", "v2", "utf8"]) {
    const out = prepare(`הקובץ ${token} נשאר.`, "he", dir);
    assert.ok(out.includes(token), `${token} was rewritten: ${out}`);
    assert.doesNotMatch(out, /<he:/, `${token} was expanded as a number`);
  }
});

test("a standalone number is expanded even at the end of a sentence", () => {
  const dir = fakeModules(tmpDir("cv-dia-"));
  assert.match(prepare("קוד יציאה 1.", "he", dir), /<he:1>/);
  assert.match(prepare("אחרי 3.5 שניות", "he", dir), /<he:3\.5>/, "decimals are one number, not two");
});

test("text that already has vowel points is left alone", () => {
  const dir = fakeModules(tmpDir("cv-dia-"));
  const pointed = "הַבְדִיקוֹת";
  assert.equal(prepare(pointed, "he", dir), pointed, "a second pass must not re-point");
});

test("speech continues when the packages are missing", () => {
  // The whole point of the fallbacks: a missing package costs pronunciation,
  // never speech. An empty directory has neither module.
  const dir = tmpDir("cv-dia-bare-");
  const text = "כל 118 הבדיקות עוברות.";
  assert.equal(prepare(text, "he", dir), text);
  assert.equal(prepare("118 اختبارا.", "ar", dir), "118 اختبارا.");
});
