// The translation service, driven by a stub daemon: no model downloads, no
// network, and the failure paths are what matter most (speech must continue).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { Translator } = require("../../out/language/translate.js");
const { tmpDir } = require("../helpers");

/** A daemon that speaks the real protocol but "translates" by tagging text. */
function stubDaemon(dir, { failOn = null, failMessage = "no model installed", ready = true } = {}) {
  const script = path.join(dir, "stub_translate.py");
  const failLiteral = failOn === null ? "None" : JSON.stringify(failOn); // Python has no null
  fs.writeFileSync(
    script,
    `import json, sys
${ready ? 'print(json.dumps({"ready": True}), flush=True)' : "pass"}
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = json.loads(line)
    rid = req.get("id")
    op = req.get("op", "translate")
    if op == "packages":
        print(json.dumps({"id": rid, "ok": True, "pairs": ["en>de", "de>en"]}), flush=True)
    elif op == "install":
        print(json.dumps({"id": rid, "ok": True, "pairs": ["en>de", "de>en", req["from"] + ">" + req["to"]]}), flush=True)
    elif ${failLiteral} is not None and ${failLiteral} in req.get("text", ""):
        print(json.dumps({"id": rid, "ok": False, "error": ${JSON.stringify(failMessage)}}), flush=True)
    else:
        print(json.dumps({"id": rid, "ok": True, "text": "[" + req["to"] + "] " + req["text"]}), flush=True)
`
  );
  return script;
}

const python = process.platform === "win32" ? "python" : "python3";

test("translates, caches, and leaves same-language text alone", async () => {
  const dir = tmpDir("cv-tr-");
  const t = new Translator({ daemonScript: stubDaemon(dir), python });
  try {
    assert.equal(t.available, true);
    assert.equal(await t.translate("The tests pass now.", "en", "de"), "[de] The tests pass now.");
    // Same language: untouched, and no daemon round trip.
    assert.equal(await t.translate("Schon deutsch.", "de", "de"), "Schon deutsch.");
    assert.equal(await t.translate("   ", "en", "de"), "   ");
    // Second call for the same text comes from the cache.
    assert.equal(await t.translate("The tests pass now.", "en", "de"), "[de] The tests pass now.");
    assert.deepEqual(await t.pairs(), ["en>de", "de>en"]);
  } finally {
    t.dispose();
  }
});

test("a translation failure speaks the original instead of nothing", async () => {
  const dir = tmpDir("cv-tr-");
  const errors = [];
  const t = new Translator({
    daemonScript: stubDaemon(dir, { failOn: "untranslatable", failMessage: "model crashed" }),
    python,
    onError: (m) => errors.push(m),
  });
  try {
    assert.equal(await t.translate("this is untranslatable text", "en", "de"), "this is untranslatable text");
    assert.match(errors[0], /translation failed: model crashed/);
    // The daemon stays usable for the next line.
    assert.equal(await t.translate("this one is fine", "en", "de"), "[de] this one is fine");
  } finally {
    t.dispose();
  }
});

test("with no runtime installed it reports unavailable and never blocks speech", async () => {
  const t = new Translator({ daemonScript: path.join(tmpDir("cv-tr-"), "missing.py"), python });
  assert.equal(t.available, false);
  assert.equal(await t.translate("anything at all", "en", "de"), "anything at all");
  assert.deepEqual(await t.pairs(), []);
  await assert.rejects(t.install("en", "de"), /not installed/);
  t.dispose();
});

test("the cache is least-recently-used: a hit is kept, the oldest entry goes", async () => {
  // A counting stub: every daemon call increments a number in its output, so
  // a cache hit (same number) and a miss (new number) are told apart.
  const dir = tmpDir("cv-tr-");
  const script = path.join(dir, "count_translate.py");
  fs.writeFileSync(
    script,
    `import json, sys
print(json.dumps({"ready": True}), flush=True)
n = 0
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = json.loads(line)
    n += 1
    print(json.dumps({"id": req["id"], "ok": True, "text": "[%d] %s" % (n, req["text"])}), flush=True)
`
  );
  const t = new Translator({ daemonScript: script, python: "python3" });
  try {
    const first = await t.translate("sentence zero", "en", "de");
    // Fill the cache past its limit, touching entry zero once on the way so it
    // is recent when the eviction happens.
    for (let i = 1; i <= 120; i++) await t.translate(`sentence ${i}`, "en", "de");
    assert.equal(await t.translate("sentence zero", "en", "de"), first, "still cached: a hit");
    for (let i = 121; i <= 205; i++) await t.translate(`sentence ${i}`, "en", "de");
    assert.equal(
      await t.translate("sentence zero", "en", "de"),
      first,
      "touched recently: survived the eviction of older entries"
    );
    const one = await t.translate("sentence 1", "en", "de");
    assert.notEqual(
      one,
      "[2] sentence 1",
      "entry 1 was the least recently used and was evicted, so it was translated again"
    );
  } finally {
    t.dispose();
  }
});

test("a missing model is reported once, not asked about per paragraph, and forgotten after an install", async () => {
  // Counting stub: "no model installed" for en>he until an install arrives,
  // and every request bumps a counter written to a file so the test can see
  // which requests reached the daemon at all.
  const dir = tmpDir("cv-tr-");
  const counter = path.join(dir, "requests.txt");
  const script = path.join(dir, "missing_translate.py");
  fs.writeFileSync(
    script,
    `import json, sys
print(json.dumps({"ready": True}), flush=True)
installed = {"en>de"}
n = 0
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = json.loads(line)
    n += 1
    open(${JSON.stringify(counter)}, "w").write(str(n))
    op = req.get("op", "translate")
    if op == "install":
        installed.add(req["from"] + ">" + req["to"])
        print(json.dumps({"id": req["id"], "ok": True, "pairs": sorted(installed)}), flush=True)
    elif req["from"] + ">" + req["to"] not in installed:
        print(json.dumps({"id": req["id"], "ok": False, "error": "no model installed for %s to %s" % (req["from"], req["to"])}), flush=True)
    else:
        print(json.dumps({"id": req["id"], "ok": True, "text": "[" + req["to"] + "] " + req["text"]}), flush=True)
`
  );
  const requests = () => Number(fs.readFileSync(counter, "utf8"));
  const errors = [];
  const missing = [];
  const t = new Translator({
    daemonScript: script,
    python,
    onError: (m) => errors.push(m),
    onMissingModel: (f, to) => missing.push(`${f}>${to}`),
  });
  try {
    assert.equal(await t.translate("first paragraph", "en", "he"), "first paragraph", "the original is spoken");
    assert.deepEqual(missing, ["en>he"]);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /translation skipped: no model installed for en to he/);
    assert.equal(requests(), 1);
    assert.equal(await t.translate("second paragraph", "en", "he"), "second paragraph");
    assert.equal(await t.translate("third paragraph", "en", "he"), "third paragraph");
    assert.equal(requests(), 1, "a direction without a model is not asked about again per paragraph");
    assert.deepEqual(missing, ["en>he"], "reported once");
    assert.equal(errors.length, 1);
    // Another direction is unaffected.
    assert.equal(await t.translate("unaffected", "en", "de"), "[de] unaffected");
    // After the install the direction is asked about again and works.
    await t.install("en", "he");
    assert.equal(await t.translate("fourth paragraph", "en", "he"), "[he] fourth paragraph");
  } finally {
    t.dispose();
  }
});

test("the daemon finds a model installed by another process", async () => {
  // Argos memoises get_installed_languages() for the life of the process; the
  // fake does the same, reading a packages folder only when its memo is empty.
  // The daemon must drop the memo on a miss so a model installed by a second
  // editor window's daemon (or by hand) is found without a restart.
  const { PyTtsDaemon } = require("../../out/tts/pyDaemon.js");
  const { ROOT } = require("../helpers");
  const dir = tmpDir("cv-tr-");
  const packages = path.join(dir, "packages");
  fs.mkdirSync(path.join(dir, "argostranslate"), { recursive: true });
  fs.mkdirSync(packages);
  fs.writeFileSync(path.join(dir, "argostranslate", "__init__.py"), "");
  fs.writeFileSync(
    path.join(dir, "argostranslate", "package.py"),
    `def update_package_index(): pass
def get_available_packages(): return []
def install_from_path(p): raise RuntimeError("not used")
`
  );
  fs.writeFileSync(
    path.join(dir, "argostranslate", "translate.py"),
    `import functools, os
PACKAGES = ${JSON.stringify(packages)}
class _T:
    def __init__(self, to): self.to = to
    def translate(self, text): return "[" + self.to + "] " + text
class Language:
    def __init__(self, code, targets): self.code = code; self.targets = targets
    def get_translation(self, other): return _T(other.code) if other.code in self.targets else None
@functools.lru_cache()
def get_installed_languages():
    pairs = [f.split("_") for f in os.listdir(PACKAGES)]  # files named "en_he"
    codes = sorted({c for p in pairs for c in p})
    return [Language(c, {t for f, t in pairs if f == c}) for c in codes]
`
  );
  const errors = [];
  const d = new PyTtsDaemon(python, path.join(ROOT, "assets", "translate_daemon.py"), {}, (m) => errors.push(m), {
    readyTimeoutMs: 20000,
    env: { PYTHONPATH: dir },
  });
  try {
    await d.ready;
    await assert.rejects(d.request({ text: "hello", from: "en", to: "he" }).promise, /no model installed for en to he/);
    // Warms the memo with an empty listing, exactly the state a daemon that
    // started before the model was installed is in.
    fs.writeFileSync(path.join(packages, "en_he"), "");
    const msg = await d.request({ text: "hello", from: "en", to: "he" }).promise;
    assert.equal(msg.text, "[he] hello");
    // Once found, the direction is cached inside the daemon and stays usable.
    assert.equal((await d.request({ text: "again", from: "en", to: "he" }).promise).text, "[he] again");
    assert.deepEqual((await d.request({ op: "packages" }).promise).pairs, ["en>he"]);
  } finally {
    d.dispose();
  }
  assert.deepEqual(errors, []);
});

test("protected terms come back in English, and a mangled translation falls back to the original", async () => {
  // A stub that "translates" by tagging, so the placeholders pass through
  // exactly as the real model was measured to do.
  const dir = tmpDir("cv-tr-");
  const t = new Translator({
    daemonScript: stubDaemon(dir),
    python,
    keepTerms: () => ["commit", "branch"],
  });
  try {
    const out = await t.translate("I pushed a commit to the branch.", "en", "de");
    assert.match(out, /commit/, "the term is restored, not translated");
    assert.match(out, /branch/);
    assert.doesNotMatch(out, /ZQX/, "no placeholder is left for the listener");
  } finally {
    t.dispose();
  }

  // A daemon that drops the placeholders stands for a model that mangled the
  // sentence: speaking the original is better than a translation with holes.
  const dir2 = tmpDir("cv-tr-");
  const script = path.join(dir2, "drop.py");
  fs.writeFileSync(
    script,
    `import json, re, sys
print(json.dumps({"ready": True}), flush=True)
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = json.loads(line)
    print(json.dumps({"id": req["id"], "ok": True, "text": re.sub(r"ZQX\\d+", "", req["text"])}), flush=True)
`
  );
  const t2 = new Translator({ daemonScript: script, python, keepTerms: () => ["commit", "branch"] });
  try {
    const original = "I pushed a commit to the branch.";
    assert.equal(await t2.translate(original, "en", "de"), original);
  } finally {
    t2.dispose();
  }
});

// A model that cannot carry the placeholders. Measured, not imagined: the
// installed en-to-ar model handed back ten of twelve technical sentences
// either copied verbatim or with terms missing, which is how a paragraph was
// read aloud in one language with an English sentence in the middle of it.
//
// It "translates" by reversing the word order, so a translated sentence never
// contains the sentence it came from: that is what tells a real translation
// apart from a source sentence handed straight back.
function fragileDaemon(dir, { mode = "copy", limit = 2, counter } = {}) {
  const script = path.join(dir, `fragile_${mode}.py`);
  fs.writeFileSync(
    script,
    `import json, re, sys
print(json.dumps({"ready": True}), flush=True)
n = 0
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = json.loads(line)
    n += 1
    ${counter ? `open(${JSON.stringify(counter)}, "w").write(str(n))` : "pass"}
    text = req.get("text", "")
    marks = set(re.findall(r"ZQX\\d+", text))
    flip = lambda t: " ".join(reversed(t.split()))
    if len(marks) >= ${limit}:
        # Too many placeholders: this model either echoes the source back or
        # translates the sentence and loses them.
        out = text if ${JSON.stringify(mode)} == "copy" else "[" + req["to"] + "] " + flip(re.sub(r"ZQX\\d+ ?", "", text))
    else:
        out = "[" + req["to"] + "] " + flip(text)
    print(json.dumps({"id": req["id"], "ok": True, "text": out}), flush=True)
`
  );
  return script;
}

const { DEFAULT_KEEP_IN_SOURCE } = require("../../out/language/glossary.js");
const { copiedSentences, translationModelMissing } = require("../../out/language/translate.js");

test("a sentence handed back in the language it was written in is asked for again", () => {
  const sent = "The ZQX0 script reads a ZQX1 file and pushes the release. Fine.";
  const received = "[ar] the first part. The ZQX0 script reads a ZQX1 file and pushes the release.";
  assert.deepEqual(copiedSentences(sent, received), ["The ZQX0 script reads a ZQX1 file and pushes the release."]);
  assert.deepEqual(
    copiedSentences("Short one.", "Short one."),
    [],
    "a short line can survive a translation as written"
  );
  assert.deepEqual(
    copiedSentences("ZQX0 ZQX1 ZQX2 ZQX3 done.", "ZQX0 ZQX1 ZQX2 ZQX3 done."),
    [],
    "a line that is mostly identifiers proves nothing"
  );
  assert.deepEqual(copiedSentences("The deploy script reads a config file today.", "[de] etwas anderes"), []);
});

test("a model that cannot carry the glossary gives up the glossary, not the sentence", async () => {
  const dir = tmpDir("cv-tr-");
  const counter = path.join(dir, "requests.txt");
  const errors = [];
  const t = new Translator({
    daemonScript: fragileDaemon(dir, { mode: "copy", counter }),
    python,
    keepTerms: () => DEFAULT_KEEP_IN_SOURCE,
    onError: (m) => errors.push(m),
  });
  const requests = () => Number(fs.readFileSync(counter, "utf8"));
  try {
    const text =
      "The deploy script reads a config file and pushes the release to the server. Nothing else happens here.";
    const out = await t.translate(text, "en", "ar");
    assert.ok(!out.includes("The deploy script reads"), "no sentence is left in the language it was written in");
    assert.doesNotMatch(out, /ZQX/, "and no placeholder reaches the ear");
    for (const word of ["deploy", "config", "release", "server"]) {
      assert.ok(out.includes(word), `${word} is still in the sentence, translated rather than deleted`);
    }
    assert.equal(requests(), 2, "one attempt with the glossary, one without");
    assert.equal(errors.length, 1, "said once, in the log");
    assert.match(errors[0], /en>ar came back with whole sentences untranslated/);
    assert.match(errors[0], /only identifiers/);

    // The direction is remembered, so the next paragraph costs one request.
    await t.translate("The build passed and the test suite is green again.", "en", "ar");
    assert.equal(requests(), 3, "no second attempt once the direction is known");
    assert.equal(errors.length, 1, "and it is not said again");

    // Another direction is untouched: its model carries them, so its terms
    // stay in the source language.
    const german = await t.translate("Read the diff before you commit.", "en", "de");
    assert.match(german, /\bdiff\b/);
    assert.match(german, /\bcommit\b/);
  } finally {
    t.dispose();
  }
});

test("terms the model swallowed are treated as damage too, and the sentence survives", async () => {
  const dir = tmpDir("cv-tr-");
  const errors = [];
  const t = new Translator({
    daemonScript: fragileDaemon(dir, { mode: "drop" }),
    python,
    keepTerms: () => DEFAULT_KEEP_IN_SOURCE,
    onError: (m) => errors.push(m),
  });
  try {
    const text = "Every query goes through the cache, so the database only sees the misses.";
    const out = await t.translate(text, "en", "ar");
    for (const word of ["query", "cache", "database"]) {
      assert.ok(out.includes(word), `${word} is back in the sentence rather than deleted from it`);
    }
    assert.match(errors[0], /with terms missing/);
  } finally {
    t.dispose();
  }
});

test("choosing the language Claude already writes in downloads nothing", () => {
  // There is no en>en model, and none is published: asking for one reported
  // "could not download that model" to someone who had asked for English.
  assert.equal(translationModelMissing(["en>de"], "en", "en"), false);
  assert.equal(translationModelMissing([], "en", "en"), false);
  assert.equal(translationModelMissing(["en>de"], "en", "he"), true);
  assert.equal(translationModelMissing(["en>de", "en>he"], "en", "he"), false);
});
