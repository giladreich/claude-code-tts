const test = require("node:test");
const assert = require("node:assert/strict");
const { chatterboxLanguageFor } = require("../../out/tts/chatterbox.js");

test("the language tag sent to Chatterbox names a language it actually speaks", () => {
  assert.equal(chatterboxLanguageFor("ar", "en"), "ar");
  // Hebrew was excluded while the daemon sent it unvocalized text and it came
  // out garbled; with the vowel marks restored first it is the best
  // measured here, so it is spoken as Hebrew rather than read under another
  // language (see assets/diacritize.py).
  assert.equal(chatterboxLanguageFor("he", "de"), "he");
  assert.equal(chatterboxLanguageFor(undefined, "tr"), "tr", "undetected text is most likely in the voice's language");
  assert.equal(chatterboxLanguageFor(undefined, "he"), "he");
  assert.equal(
    chatterboxLanguageFor("cs", "de"),
    "de",
    "a language it does not speak still falls back to the voice's own"
  );
  assert.equal(chatterboxLanguageFor(undefined, undefined), "en");
});

const fs = require("fs");
const path = require("path");
const { ROOT, tmpDir, writeWav, pythonWithNumpy, until } = require("../helpers");
const appleSilicon = process.platform === "darwin" && process.arch === "arm64";
const python = pythonWithNumpy();

/**
 * A fake uv tool install of mlx-audio whose python is the real one (with
 * numpy). A wrapper script rather than a symlink: a virtualenv interpreter
 * finds its site-packages relative to the executable's real location, so a
 * symlinked copy would run bare and lose numpy.
 */
function fakeUvTools(realPython) {
  const dataHome = tmpDir("cv-xdg-");
  const venv = path.join(dataHome, "uv", "tools", "mlx-audio");
  fs.mkdirSync(path.join(venv, "bin"), { recursive: true });
  fs.writeFileSync(path.join(venv, "bin", "python"), `#!/bin/sh\nexec "${realPython}" "$@"\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(venv, "lib", "python3.12", "site-packages", "mlx_audio", "tts", "models", "chatterbox"), {
    recursive: true,
  });
  return dataHome;
}

/** A fake mlx_audio on PYTHONPATH: generate() records what it was asked to do. */
function fakeMlxAudio(markFile) {
  const dir = tmpDir("cv-fakemlx-");
  fs.mkdirSync(path.join(dir, "mlx_audio", "tts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "mlx_audio", "__init__.py"), "");
  fs.writeFileSync(path.join(dir, "mlx_audio", "tts", "__init__.py"), "");
  fs.writeFileSync(
    path.join(dir, "mlx_audio", "utils.py"),
    `
import numpy as np, wave
def load_audio(path, sample_rate=24000, **kw):
    with wave.open(path) as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
`
  );
  fs.writeFileSync(
    path.join(dir, "mlx_audio", "tts", "utils.py"),
    `
import json, numpy as np
class _R:
    def __init__(self, a): self.audio = a; self.sample_rate = 24000
class _Model:
    def prepare_conditionals(self, wav, sr, exaggeration=0.5): return ("conds", int(np.asarray(wav).size))
    def generate(self, text="", lang_code="en", conds=None, **kw):
        with open(${JSON.stringify(markFile)}, "a", encoding="utf-8") as f:
            f.write(json.dumps({"text": text, "lang": lang_code, "ref_samples": conds[1] if conds else None}, ensure_ascii=False) + "\\n")
        t = np.arange(int(24000 * (0.2 * len(text.split()) + 0.4))) / 24000.0
        yield _R((0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32))
def load_model(model_id):
    with open(${JSON.stringify(markFile)}, "a", encoding="utf-8") as f:
        f.write(json.dumps({"event": "load"}) + "\\n")
    return _Model()
`
  );
  return dir;
}

test(
  "runtime resolution: preference rules against what is on disk",
  { skip: !appleSilicon && "Apple Silicon only" },
  () => {
    const { resolveChatterboxRuntime } = require("../../out/tts/chatterbox.js");
    const saved = process.env.XDG_DATA_HOME;
    const storage = tmpDir("cv-storage-");
    try {
      process.env.XDG_DATA_HOME = tmpDir("cv-xdg-empty-");
      assert.equal(resolveChatterboxRuntime(storage), undefined, "nothing installed");
      process.env.XDG_DATA_HOME = fakeUvTools(python ?? process.execPath);
      assert.equal(resolveChatterboxRuntime(storage), "mlx");
      assert.equal(resolveChatterboxRuntime(storage, "torch"), undefined, "torch asked for, only MLX present");
      // A venv with an interpreter but no engine in it is a failed install, and
      // used to report ready forever: the setup flow then refused to run again
      // because it believed the work was done, and every synthesis failed
      // inside the daemon instead.
      const venv = path.join(storage, "chatterbox-venv");
      fs.mkdirSync(path.join(venv, "bin"), { recursive: true });
      fs.writeFileSync(path.join(venv, "bin", "python"), "");
      assert.equal(resolveChatterboxRuntime(storage, "torch"), undefined, "half-installed venv must not count");
      const site = path.join(venv, "lib", "python3.11", "site-packages", "chatterbox");
      fs.mkdirSync(site, { recursive: true });
      assert.equal(resolveChatterboxRuntime(storage, "auto"), "mlx", "auto prefers MLX when both exist");
      assert.equal(resolveChatterboxRuntime(storage, "torch"), "torch");
      assert.equal(resolveChatterboxRuntime(storage, "mlx"), "mlx");
    } finally {
      if (saved === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = saved;
    }
  }
);

test(
  "an engine installed by another flow is found to be missing its text preparation",
  { skip: !appleSilicon && "Apple Silicon only" },
  () => {
    // The bug this exists for: the MLX runtime IS the mlx-audio tool the Qwen3
    // setup installs, so a machine that set Qwen3 up first and then designed a
    // voice had a working engine, no text preparation, and every sentence in a
    // writing system whose vowels are not written came out as other words.
    // "Installed" and "can read this" are separate questions from here on.
    const {
      CHATTERBOX_TEXT_PACKAGES,
      chatterboxRuntimePython,
      diacritizerReady,
      missingTextPackages,
    } = require("../../out/tts/chatterbox.js");
    const saved = process.env.XDG_DATA_HOME;
    const storage = tmpDir("cv-storage-text-");
    try {
      process.env.XDG_DATA_HOME = tmpDir("cv-xdg-empty-");
      assert.deepEqual(missingTextPackages(storage), [], "nothing installed: nothing to add them to");

      const dataHome = fakeUvTools(python ?? process.execPath);
      process.env.XDG_DATA_HOME = dataHome;
      assert.deepEqual(
        missingTextPackages(storage),
        CHATTERBOX_TEXT_PACKAGES.map((p) => p.spec),
        "a runtime installed by the other setup carries none of them"
      );
      assert.equal(diacritizerReady(storage), false);
      assert.ok(chatterboxRuntimePython(storage), "the repair needs the interpreter to install into");

      const site = path.join(dataHome, "uv", "tools", "mlx-audio", "lib", "python3.12", "site-packages");
      fs.mkdirSync(path.join(site, "num2words"), { recursive: true });
      assert.deepEqual(missingTextPackages(storage), ["nakdimon==0.2.1"], "one present, one still missing");
      fs.mkdirSync(path.join(site, "nakdimon"), { recursive: true });
      assert.deepEqual(missingTextPackages(storage), []);
      assert.equal(diacritizerReady(storage), true);
    } finally {
      if (saved === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = saved;
    }
  }
);

test(
  "backend: refuses once without a voice, then speaks a voice chosen later in its language",
  { skip: (!appleSilicon && "Apple Silicon only") || (!python && "no python with numpy") },
  async () => {
    const { chatterboxBackend } = require("../../out/tts/chatterbox.js");
    const savedXdg = process.env.XDG_DATA_HOME;
    const savedPy = process.env.PYTHONPATH;
    const mark = path.join(tmpDir("cv-mark-"), "generate.jsonl");
    const voicesDir = path.join(tmpDir("cv-voices-"), "qwen3-voices");
    fs.mkdirSync(path.join(voicesDir, "tr-voice"), { recursive: true });
    writeWav(path.join(voicesDir, "tr-voice", "ref.wav"), 1.0);
    fs.writeFileSync(
      path.join(voicesDir, "tr-voice", "meta.json"),
      JSON.stringify({ name: "Turkish voice", refText: "x", language: "tr", usedTranscript: true })
    );
    process.env.XDG_DATA_HOME = fakeUvTools(python);
    process.env.PYTHONPATH = fakeMlxAudio(mark);
    const errors = [];
    let backend;
    try {
      backend = chatterboxBackend(
        {
          globalStoragePath: tmpDir("cv-storage-"),
          daemonScript: path.join(ROOT, "assets", "chatterbox_daemon.py"),
          voice: "default",
          voicesDir,
          runtime: "auto",
        },
        (m) => errors.push(m)
      );
      assert.equal(backend.name, "chatterbox (mlx)");
      backend.prewarm({ text: "Nobody can speak this.", wpm: 175, voice: "default", volume: 0 });
      backend.prewarm({ text: "Still nobody.", wpm: 175, voice: "default", volume: 0 });
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(errors.length, 1, `one actionable warning, not one per sentence: ${JSON.stringify(errors)}`);
      assert.match(errors[0], /no built-in voice/);
      assert.ok(!fs.existsSync(mark), "no daemon was started for a voice that cannot work");
      // The user picks a voice. Same backend instance; no rebuild happens in the app.
      backend.prewarm({
        text: "Merhaba dünya, testler geçiyor.",
        wpm: 175,
        voice: "clone:tr-voice",
        volume: 0,
        language: "tr",
      });
      try {
        await until(() => fs.existsSync(mark) && fs.readFileSync(mark, "utf8").includes("Merhaba"), 20000);
      } catch (e) {
        const log = path.join(path.dirname(voicesDir), "chatterbox-daemon.log");
        throw new Error(
          `${e.message}; errors=${JSON.stringify(errors)}; mark=${fs.existsSync(mark) ? fs.readFileSync(mark, "utf8") : "(none)"}; log=${fs.existsSync(log) ? fs.readFileSync(log, "utf8").slice(-800) : "(none)"}`,
          { cause: e }
        );
      }
      const lines = fs
        .readFileSync(mark, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      const req = lines.find((l) => l.text && l.text.startsWith("Merhaba"));
      assert.equal(req.lang, "tr", "the detected language, which Chatterbox speaks");
      assert.equal(req.ref_samples, 24000, "the request carried the profile's reference (1s at 24kHz)");
      // The language is spoken as itself, and the daemon restores its vowel marks on
      // the way (which is why the recorded text is compared without them: the
      // marks are there whenever the diacritizer is installed).
      const unpointed = (s) => s.replace(/[\u0591-\u05c7]/g, "");
      backend.prewarm({ text: "שלום עולם", wpm: 175, voice: "clone:tr-voice", volume: 0, language: "he" });
      await until(() => unpointed(fs.readFileSync(mark, "utf8")).includes("שלום עולם"), 10000);
      const he = fs
        .readFileSync(mark, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
        .find((l) => l.text && unpointed(l.text).startsWith("שלום"));
      assert.equal(he.lang, "he");
      // This fake install has no diacritizer package, so that language draws
      // exactly one more warning: without the vowel marks the output is not
      // merely worse, it is other words, and that has to be said rather than
      // left to sound like a broken voice.
      assert.equal(errors.length, 2, `one warning per problem, not per sentence: ${JSON.stringify(errors)}`);
      assert.match(errors[1], /vowel marks/);
      backend.prewarm({ text: "עוד משפט בעברית", wpm: 175, voice: "clone:tr-voice", volume: 0, language: "he" });
      await until(() => unpointed(fs.readFileSync(mark, "utf8")).includes("עוד משפט"), 10000);
      assert.equal(errors.length, 2, "the diacritizer warning is not repeated per sentence");
    } finally {
      backend?.dispose?.();
      if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = savedXdg;
      if (savedPy === undefined) delete process.env.PYTHONPATH;
      else process.env.PYTHONPATH = savedPy;
    }
  }
);

test(
  "backend: the model is unloaded after a quiet period and reloaded by the next sentence",
  { skip: (!appleSilicon && "Apple Silicon only") || (!python && "no python with numpy") },
  async () => {
    const { chatterboxBackend } = require("../../out/tts/chatterbox.js");
    const { setPipelineLogger } = require("../../out/tts/wavPlayers.js");
    const savedXdg = process.env.XDG_DATA_HOME;
    const savedPy = process.env.PYTHONPATH;
    const mark = path.join(tmpDir("cv-mark-"), "generate.jsonl");
    const voicesDir = path.join(tmpDir("cv-voices-"), "qwen3-voices");
    fs.mkdirSync(path.join(voicesDir, "v"), { recursive: true });
    writeWav(path.join(voicesDir, "v", "ref.wav"), 1.0);
    fs.writeFileSync(
      path.join(voicesDir, "v", "meta.json"),
      JSON.stringify({ name: "V", refText: "x", language: "en", usedTranscript: true })
    );
    process.env.XDG_DATA_HOME = fakeUvTools(python);
    process.env.PYTHONPATH = fakeMlxAudio(mark);
    const logged = [];
    setPipelineLogger((m) => logged.push(m));
    const events = () =>
      fs.existsSync(mark)
        ? fs
            .readFileSync(mark, "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l))
        : [];
    const loads = () => events().filter((e) => e.event === "load").length;
    let backend;
    try {
      backend = chatterboxBackend(
        {
          globalStoragePath: tmpDir("cv-storage-"),
          daemonScript: path.join(ROOT, "assets", "chatterbox_daemon.py"),
          voice: "clone:v",
          voicesDir,
          runtime: "auto",
          idleUnloadMinutes: 0.02,
        },
        (m) => {
          throw new Error(m);
        }
      );
      backend.prewarm({ text: "First sentence.", wpm: 175, voice: "clone:v", volume: 0, language: "en" });
      await until(() => events().some((e) => e.text === "First sentence."), 20000);
      assert.equal(loads(), 1);
      // 0.02 min = 1.2 s of quiet: the daemon must be gone and the log must say so.
      await until(() => logged.some((m) => /unloaded after 0.02 min/.test(m)), 6000);
      backend.prewarm({ text: "Second sentence.", wpm: 175, voice: "clone:v", volume: 0, language: "en" });
      await until(() => events().some((e) => e.text === "Second sentence."), 20000);
      assert.equal(loads(), 2, "a fresh daemon loaded the model again for the next sentence");
    } finally {
      setPipelineLogger(() => {});
      backend?.dispose?.();
      if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = savedXdg;
      if (savedPy === undefined) delete process.env.PYTHONPATH;
      else process.env.PYTHONPATH = savedPy;
    }
  }
);

test(
  "backend: wake() loads the model without speaking, and not for a voice that cannot work",
  { skip: (!appleSilicon && "Apple Silicon only") || (!python && "no python with numpy") },
  async () => {
    // Claude starting to write is the cue: a 16 s cold start should overlap
    // Claude's thinking, not follow the first sentence.
    const { chatterboxBackend } = require("../../out/tts/chatterbox.js");
    const savedXdg = process.env.XDG_DATA_HOME;
    const savedPy = process.env.PYTHONPATH;
    const mark = path.join(tmpDir("cv-mark-"), "generate.jsonl");
    const voicesDir = path.join(tmpDir("cv-voices-"), "qwen3-voices");
    fs.mkdirSync(path.join(voicesDir, "v"), { recursive: true });
    writeWav(path.join(voicesDir, "v", "ref.wav"), 1.0);
    fs.writeFileSync(
      path.join(voicesDir, "v", "meta.json"),
      JSON.stringify({ name: "V", refText: "x", language: "en", usedTranscript: true })
    );
    process.env.XDG_DATA_HOME = fakeUvTools(python);
    process.env.PYTHONPATH = fakeMlxAudio(mark);
    const events = () =>
      fs.existsSync(mark)
        ? fs
            .readFileSync(mark, "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l))
        : [];
    let idle, usable;
    try {
      // Without a usable voice, waking must not spend 3 GB on a daemon that
      // would refuse every request.
      idle = chatterboxBackend(
        {
          globalStoragePath: tmpDir("cv-storage-"),
          daemonScript: path.join(ROOT, "assets", "chatterbox_daemon.py"),
          voice: "default",
          voicesDir,
          runtime: "auto",
        },
        () => {}
      );
      idle.wake();
      await new Promise((r) => setTimeout(r, 400));
      assert.ok(!fs.existsSync(mark), "no daemon started for a voice that cannot work");
      // With one, waking loads the model and synthesises nothing.
      usable = chatterboxBackend(
        {
          globalStoragePath: tmpDir("cv-storage-"),
          daemonScript: path.join(ROOT, "assets", "chatterbox_daemon.py"),
          voice: "clone:v",
          voicesDir,
          runtime: "auto",
          idleUnloadMinutes: 0,
        },
        (m) => {
          throw new Error(m);
        }
      );
      usable.wake();
      await until(() => events().some((e) => e.event === "load"), 20000);
      await new Promise((r) => setTimeout(r, 300));
      assert.ok(
        !events().some((e) => e.text && e.text !== "Ready."),
        `waking must not speak: ${JSON.stringify(events())}`
      );
    } finally {
      idle?.dispose?.();
      usable?.dispose?.();
      if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = savedXdg;
      if (savedPy === undefined) delete process.env.PYTHONPATH;
      else process.env.PYTHONPATH = savedPy;
    }
  }
);

test("only the chunk about to play streams; ahead-of-time chunks, the torch runtime and the switch decline", () => {
  const { chatterboxStreams } = require("../../out/tts/chatterbox.js");
  assert.equal(chatterboxStreams({ streaming: true, runtime: "mlx", urgent: true }), true, "the chunk about to play");
  assert.equal(
    chatterboxStreams({ streaming: true, runtime: "mlx", urgent: false }),
    false,
    "prepared ahead: whole is faster"
  );
  assert.equal(
    chatterboxStreams({ streaming: true, runtime: "torch", urgent: true }),
    false,
    "the torch daemon has no streaming"
  );
  assert.equal(chatterboxStreams({ streaming: false, runtime: "mlx", urgent: true }), false, "switched off");
});

test("the pipeline keeps room for every chunk the queue is told to prepare", () => {
  // The engine asks the queue to prepare six chunks ahead while the pipeline
  // held three, so preparing the sixth cancelled the first: work on the chunk
  // about to play was paid for and thrown away, every time.
  const src = fs.readFileSync(path.join(ROOT, "src", "tts", "chatterbox.ts"), "utf8");
  const uses = (src.match(/lookahead: CHATTERBOX_LOOKAHEAD/g) ?? []).length;
  assert.equal(uses, 2, "the pipeline and the backend must be told the same number");
  const pipeline = fs.readFileSync(path.join(ROOT, "src", "tts", "synthPlay.ts"), "utf8");
  assert.match(pipeline, /maxPrepared = Math\.max\(3, \(params\.lookahead \?\? 2\) \+ 1\)/);
  assert.match(pipeline, /prewarmed\.size >= maxPrepared/);
});
