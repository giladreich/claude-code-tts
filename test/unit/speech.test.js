const test = require("node:test");
const assert = require("node:assert/strict");
const { SpeechQueue } = require("../../out/speech/speech.js");
const path = require("path");
const { sleep, until } = require("../helpers");

const baseConfig = {
  engine: "system",
  voice: "v1",
  rate: 200,
  maxRate: 300,
  dynamicRate: true,
  volume: 100,
  autoLanguage: false,
  languageVoices: {},
  speakLanguage: "",
  pauseScale: 1,
  maxUtteranceChars: 1500,
  piperPath: "piper",
  kokoroDir: "/x",
  kokoroDaemonScript: "/x",
  qwen3Model: "0.6B",
  qwen3Language: "English",
  qwen3Style: "",
  qwen3Runtime: "auto",
  qwen3DaemonScript: "/x",
  qwen3VoicesDir: "/x",
};

/** Fake engine: each utterance "plays" for durationMs, records events. */
function fakeEngine(durationMs = 80) {
  const events = [];
  const backend = {
    name: "fake",
    canFreeze: true,
    events,
    liveRates: [],
    prewarmed: [],
    prewarmReqs: [],
    disposed: 0,
    speak(req, onDone) {
      const e = {
        text: req.text,
        voice: req.voice,
        wpm: req.wpm,
        language: req.language,
        group: req.group,
        preview: req.preview,
        killed: false,
        frozen: false,
      };
      events.push(e);
      let timer = setTimeout(() => {
        if (!e.killed) onDone();
      }, durationMs);
      return {
        kill() {
          e.killed = true;
          clearTimeout(timer);
        },
        freeze() {
          e.frozen = true;
          clearTimeout(timer);
        },
        unfreeze() {
          e.frozen = false;
          timer = setTimeout(() => {
            if (!e.killed) onDone();
          }, durationMs);
        },
      };
    },
    setLiveRate(w) {
      this.liveRates.push(w);
    },
    prewarm(req) {
      this.prewarmed.push(req.text);
      this.prewarmReqs.push(req);
    },
    flush() {
      this.flushed = (this.flushed ?? 0) + 1;
    },
    dispose() {
      this.disposed++;
    },
  };
  return backend;
}

function make(engine, cfg = {}) {
  const states = [];
  const q = new SpeechQueue(
    { ...baseConfig, ...cfg },
    (m) => {
      throw new Error(m);
    },
    (s) => states.push(s),
    () => engine
  );
  return { q, states };
}

test("utterances play sequentially; short backlog items coalesce", async () => {
  const eng = fakeEngine(50);
  const { q } = make(eng);
  q.enqueue("First sentence.");
  q.enqueue("Bash: run tests");
  q.enqueue("Reading a.ts");
  await until(() => q.pending === 0, 2000);
  assert.equal(eng.events.length, 2);
  assert.equal(eng.events[1].text, "Bash: run tests. Reading a.ts");
});

test("dynamic rate ramps with backlog, live-retunes, and prewarms two ahead", async () => {
  const eng = fakeEngine(200);
  const { q } = make(eng);
  q.enqueue("a".repeat(300));
  for (let i = 0; i < 6; i++) q.enqueue("b".repeat(300) + i);
  assert.equal(eng.events[0].wpm, 200); // rate taken before the backlog existed
  assert.ok(q.currentRate() > 250, `rate ${q.currentRate()}`);
  // Catch-up never retunes the sentence being spoken (that sounds like the
  // voice changing mid-sentence); it applies from the next chunk.
  assert.deepEqual(eng.liveRates, []);
  assert.ok(eng.prewarmed.length >= 2);
  // An explicit rate change does apply live.
  q.setConfig({ ...baseConfig, rate: 240 });
  assert.equal(eng.liveRates.length, 1);
  assert.ok(eng.liveRates[0] >= 240);
  q.stop();
  assert.equal(q.pending, 0);
  assert.equal(eng.flushed, 1);
});

test("skip drops only the current utterance; stop drops everything", async () => {
  const eng = fakeEngine(500);
  const { q } = make(eng);
  q.enqueue("x".repeat(300));
  q.enqueue("y".repeat(300));
  q.enqueue("z".repeat(300));
  q.skip();
  assert.ok(eng.events[0].killed);
  assert.equal(eng.events[1].text, "y".repeat(300));
  q.stop();
  assert.ok(eng.events[1].killed);
  assert.equal(q.pending, 0);
});

test("pause freezes mid-utterance and resume continues; mute-then-unmute unpauses", async () => {
  const eng = fakeEngine(120);
  const { q } = make(eng);
  q.enqueue("p".repeat(300));
  q.pause();
  assert.ok(eng.events[0].frozen);
  assert.ok(q.isPaused);
  await sleep(200);
  assert.equal(q.pending, 1); // still there
  q.resume();
  await until(() => q.pending === 0, 1000);
});

test("preview interrupts, is spoken with the requested voice/rate, and the interrupted utterance is re-queued", async () => {
  const eng = fakeEngine(100);
  const { q } = make(eng);
  q.enqueue("m".repeat(300));
  let done = 0;
  q.preview("This is the sample.", "other-voice", 150, () => done++);
  assert.ok(eng.events[0].killed);
  const pv = eng.events[1];
  assert.equal(pv.text, "This is the sample.");
  assert.equal(pv.voice, "other-voice");
  assert.equal(pv.wpm, 150);
  await until(() => done === 1, 1000);
  await until(() => eng.events.length === 3, 1000);
  assert.equal(eng.events[2].text, "m".repeat(300)); // put back at the front
  // A second preview supersedes the first and releases its spinner.
  let d1 = 0,
    d2 = 0;
  q.preview("one", "v", undefined, () => d1++);
  q.preview("two", "v", undefined, () => d2++);
  assert.equal(d1, 1);
  q.stopPreview();
  assert.equal(d2, 1);
});

test("setConfig rebuilds the engine only when the engine changes; long text is truncated", async () => {
  let built = 0;
  const eng = fakeEngine(10);
  const q = new SpeechQueue(
    baseConfig,
    () => {},
    undefined,
    () => {
      built++;
      return eng;
    }
  );
  q.setConfig({ ...baseConfig, rate: 250 });
  assert.equal(built, 1);
  assert.deepEqual(eng.liveRates, [250]);
  q.setConfig({ ...baseConfig, engine: "kokoro" });
  assert.equal(built, 2);
  assert.equal(eng.disposed, 1);
  // Qwen3 preset -> clone crosses the checkpoint line: rebuild.
  q.setConfig({ ...baseConfig, engine: "qwen3", voice: "Ryan" });
  q.setConfig({ ...baseConfig, engine: "qwen3", voice: "clone:me" });
  assert.equal(built, 4);
  q.setConfig({ ...baseConfig, engine: "qwen3", voice: "clone:me", maxUtteranceChars: 20 });
  q.enqueue("w".repeat(50));
  assert.match(eng.events[eng.events.length - 1].text, /^w{20} \. Message truncated\.$/);
});

test("switching voice mid-sentence restarts that sentence in the new voice, keeping order", async () => {
  const eng = fakeEngine(400);
  const { q } = make(eng);
  q.enqueue("a".repeat(300));
  q.enqueue("b".repeat(300));
  assert.equal(eng.events.length, 1);
  assert.equal(eng.events[0].voice, "v1");
  q.setConfig({ ...baseConfig, voice: "v2" });
  assert.ok(eng.events[0].killed, "the sentence in the old voice is cut");
  assert.equal(eng.flushed, 1, "work prepared for the old voice is dropped");
  const restarted = eng.events[1];
  assert.equal(restarted.text, "a".repeat(300), "the same sentence is spoken again");
  assert.equal(restarted.voice, "v2", "in the new voice");
  await until(() => q.pending === 0, 3000);
  assert.equal(eng.events[2].text, "b".repeat(300), "the queue order is preserved");
  assert.equal(eng.events[2].voice, "v2");
});

test("switching engine mid-sentence re-speaks it on the new engine", async () => {
  const engines = [fakeEngine(400), fakeEngine(50)];
  let built = 0;
  const q = new SpeechQueue(
    baseConfig,
    () => {},
    undefined,
    () => engines[Math.min(built++, 1)]
  );
  q.enqueue("hello there");
  assert.equal(engines[0].events.length, 1);
  q.setConfig({ ...baseConfig, engine: "kokoro" });
  assert.ok(engines[0].events[0].killed);
  assert.equal(engines[0].disposed, 1);
  assert.equal(engines[1].events[0].text, "hello there");
  await until(() => q.pending === 0, 2000);
});

test("a rate or volume change does not restart the sentence being spoken", async () => {
  const eng = fakeEngine(300);
  const { q } = make(eng);
  q.enqueue("steady sentence");
  q.setConfig({ ...baseConfig, rate: 250, volume: 50 });
  assert.equal(eng.events.length, 1);
  assert.equal(eng.events[0].killed, false);
  await until(() => q.pending === 0, 2000);
});

test("catch-up never asks for more speed than the engine can produce", async () => {
  const eng = fakeEngine(50);
  eng.sustainableWpm = () => 190; // a slow engine, e.g. Qwen3 1.7B
  const { q } = make(eng, { rate: 210, maxRate: 300 });
  for (let i = 0; i < 8; i++) q.enqueue("z".repeat(300) + i);
  // Backlog is deep, but asking for 300 wpm would only drain the buffer and
  // produce the "silence, then sprint" pattern; the user's base rate stands.
  assert.equal(q.currentRate(), 210);
  // A faster engine is allowed to ramp.
  const fast = fakeEngine(50);
  fast.sustainableWpm = () => 600;
  const { q: q2 } = make(fast, { rate: 210, maxRate: 300 });
  for (let i = 0; i < 8; i++) q2.enqueue("z".repeat(300) + i);
  assert.equal(q2.currentRate(), 300);
  // An engine that reports nothing keeps the old behaviour.
  const plain = fakeEngine(50);
  const { q: q3 } = make(plain, { rate: 210, maxRate: 300 });
  for (let i = 0; i < 8; i++) q3.enqueue("z".repeat(300) + i);
  assert.equal(q3.currentRate(), 300);
});

test("the rate range reaches both ends and reports what will actually be heard", async () => {
  const eng = fakeEngine(30);
  const { q } = make(eng, { rate: 440, maxRate: 440 });
  q.enqueue("fast text");
  assert.equal(eng.events[0].wpm, 440, "a high rate reaches the engine unchanged");
  const slow = fakeEngine(30);
  const { q: q2 } = make(slow, { rate: 70, maxRate: 70 });
  q2.enqueue("slow text");
  assert.equal(slow.events[0].wpm, 70);
  // With no ceiling reported, asked and audible agree.
  assert.equal(q.currentRate(), 440);
  assert.equal(q.audibleRate(), 440);
  // An engine that cannot keep up reports the rate it will really speak. It
  // used to be floored at 75% of the request, which read as a flattering
  // number nothing obeyed: a 450 in the settings, a 337 in the status bar,
  // and 175 in the ear.
  const limited = fakeEngine(30);
  limited.sustainableWpm = () => 200;
  const { q: q3 } = make(limited, { rate: 320, maxRate: 320 });
  assert.equal(q3.currentRate(), 320, "the user's setting is not rewritten");
  assert.equal(q3.audibleRate(), 200, "but the audible rate is exactly what the engine will play");
});

test("applyRateNow retunes the playing audio before the setting round trip", async () => {
  const eng = fakeEngine(400);
  const { q } = make(eng, { rate: 210, maxRate: 210 });
  q.enqueue("a sentence being spoken");
  assert.deepEqual(eng.liveRates, []);
  q.applyRateNow(260);
  assert.deepEqual(eng.liveRates, [260], "the change is applied to the current utterance immediately");
  assert.equal(q.currentRate(), 260);
  assert.equal(eng.events.length, 1, "and it does not restart the sentence");
});

test("a voice mapped from another engine is spoken by that engine, not handed to the wrong one", async () => {
  // The reported failure: a Piper Hebrew model mapped for "he" while Qwen3
  // was active, so Qwen3 was asked to speak a .onnx file path.
  const engines = {};
  const build = (cfg) => {
    const e = fakeEngine(20);
    e.engine = cfg.engine;
    engines[cfg.engine] = e;
    return e;
  };
  const q = new SpeechQueue(
    {
      ...baseConfig,
      engine: "qwen3",
      voice: "Ryan",
      autoLanguage: true,
      languageVoices: { he: { engine: "piper", voice: "/models/he_IL-saspeech-medium.onnx" } },
    },
    (m) => {
      throw new Error(m);
    },
    undefined,
    build
  );
  q.enqueue("הבדיקות עוברות עכשיו. תיקנתי את השגיאה בנגן האודיו.");
  await until(() => engines.piper !== undefined, 1000);
  assert.equal(engines.piper.events[0].voice, "/models/he_IL-saspeech-medium.onnx", "Piper speaks it");
  assert.equal(engines.piper.events[0].language, "he");
  assert.equal(engines.qwen3.events.length, 0, "the Qwen3 backend is never handed a Piper model");
  await until(() => q.pending === 0, 2000);
  // English still goes to the configured engine and voice.
  q.enqueue("The tests pass now and the race in the audio player is fixed.");
  await until(() => engines.qwen3.events.length === 1, 1000);
  assert.equal(engines.qwen3.events[0].voice, "Ryan");
  q.dispose();
});

test("an old-style mapping (a bare voice name) still works with the current engine", async () => {
  const eng = fakeEngine(20);
  const { q } = make(eng, { autoLanguage: true, voice: "af_heart", languageVoices: { de: "bf_emma" } });
  q.enqueue("Ich habe die Datei geändert und die Tests laufen jetzt durch.");
  await until(() => eng.events.length === 1, 1000);
  assert.equal(eng.events[0].voice, "bf_emma");
  assert.equal(eng.events[0].language, "de");
});

test("a queued chunk is prewarmed in its own language and mapped voice", async () => {
  // Prewarm used to pass the configured voice and no language at all, so a
  // chunk in another language was prepared as if it were the configured one.
  // With the language left out of the cache key that rendering could then be
  // replayed for the language-mapped request.
  const engine = fakeEngine(400);
  const q = new SpeechQueue(
    { ...baseConfig, autoLanguage: true, languageVoices: { de: "Anna" } },
    (m) => {
      throw new Error(m);
    },
    undefined,
    () => engine
  );
  q.enqueue("This English sentence keeps the queue busy for a while.");
  q.enqueue("Ich habe die Datei gelesen und die fehlerhafte Funktion gefunden.");
  await until(() => engine.prewarmReqs.length > 0, 2000);
  const german = engine.prewarmReqs.find((r) => r.text.startsWith("Ich habe"));
  assert.ok(german, `German chunk was never prewarmed: ${JSON.stringify(engine.prewarmed)}`);
  assert.equal(german.language, "de");
  assert.equal(german.voice, "Anna");
  q.stop();
});

test("a language mapped to another engine is spoken by that engine's backend with the mapped voice", async () => {
  const built = [];
  const engines = {};
  const factory = (cfg) => {
    built.push(cfg.engine);
    return (engines[cfg.engine] ??= fakeEngine(120));
  };
  const q = new SpeechQueue(
    {
      ...baseConfig,
      engine: "kokoro",
      voice: "af_heart",
      autoLanguage: true,
      languageVoices: { ar: { engine: "chatterbox", voice: "clone:me" } },
    },
    (m) => {
      throw new Error(m);
    },
    undefined,
    factory
  );
  assert.deepEqual(built, ["kokoro"], "the mapped engine is not built until it is needed");
  q.enqueue("The build is green and the tests pass on every platform.");
  q.enqueue("لقد قرأت الملف ووجدت الدالة التي تسبب الخطأ في الإعدادات.");
  await until(() => (engines.chatterbox?.events.length ?? 0) > 0, 3000);
  assert.deepEqual(built, ["kokoro", "chatterbox"]);
  const ar = engines.chatterbox.events[0];
  assert.equal(ar.voice, "clone:me", "the mapped voice, not Kokoro's");
  assert.equal(ar.language, "ar");
  assert.equal(engines.kokoro.events[0].voice, "af_heart", "English stays on the configured engine and voice");
  q.stop();
});

test("only a load-time setting rebuilds the engine; the rest reach the next sentence live", () => {
  // A rebuild means unloading and reloading a model: up to 27 s and 3 GB for
  // Chatterbox. Delivery style, pause scale and the idle-unload period all
  // travel with each request, so they used to buy that reload for nothing.
  let built = 0;
  let seen;
  const q = new SpeechQueue(
    { ...baseConfig, engine: "chatterbox", chatterboxRuntime: "auto" },
    () => {},
    undefined,
    (cfg) => {
      built++;
      seen = cfg;
      return fakeEngine(10);
    }
  );
  const chatterbox = (over) => ({ ...baseConfig, engine: "chatterbox", chatterboxRuntime: "torch", ...over });
  q.setConfig(chatterbox());
  assert.equal(built, 2, "a different runtime is a different daemon");
  q.setConfig(chatterbox({ rate: 250 }));
  assert.equal(built, 2, "a rate change is not");
  q.setConfig(chatterbox({ rate: 250, idleUnloadMinutes: 5, pauseScale: 1.4, qwen3Style: "brisk" }));
  assert.equal(built, 2, "nor is a per-request setting");
  // The engine holds the live config object, so it reads the new values on
  // the next sentence rather than needing to be built again.
  assert.equal(seen.idleUnloadMinutes, 5);
  assert.equal(seen.pauseScale, 1.4);
  assert.equal(seen.qwen3Style, "brisk");
});

test("the queue tail is not prewarmed while short announcements can still merge into it", async () => {
  // Every merge rewrote the tail and started a new synthesis of it; on an
  // engine that cannot abort a running generation each version cost seconds.
  const eng = fakeEngine(600);
  const { q } = make(eng);
  q.enqueue("a".repeat(300)); // plays now
  q.enqueue("b".repeat(300)); // queue[0]: prepared
  q.enqueue("Bash: run tests"); // queue[1], short and still growing: not yet
  assert.ok(eng.prewarmed.includes("b".repeat(300)));
  assert.ok(!eng.prewarmed.includes("Bash: run tests"), "a short tail is not prepared yet");
  q.enqueue("Reading a.ts"); // merges into the tail
  assert.ok(!eng.prewarmed.some((t) => t.startsWith("Bash: run tests")), "the merged tail is still not prepared");
  q.enqueue("c".repeat(300)); // now the announcement is no longer the tail
  assert.ok(
    eng.prewarmed.includes("Bash: run tests. Reading a.ts"),
    `tail prepared once it can no longer grow: ${JSON.stringify(eng.prewarmed)}`
  );
  q.stop();
});

test("a preview names the engine that owns the voice, so a Piper voice is not handed to Chatterbox", async () => {
  const engines = {};
  const q = new SpeechQueue(
    { ...baseConfig, engine: "chatterbox", voice: "clone:me" },
    () => {},
    undefined,
    (cfg) => (engines[cfg.engine] ??= fakeEngine(50))
  );
  let done = 0;
  q.preview("שלום", "/models/he_IL.onnx", undefined, () => done++, "piper");
  await until(() => done === 1, 1000);
  assert.equal(engines.piper.events.length, 1, "spoken by the Piper backend");
  assert.equal(engines.piper.events[0].voice, "/models/he_IL.onnx");
  assert.equal(engines.chatterbox.events.length, 0, "the main engine never saw the Piper path");
});

test("a mapping with inVoice builds a re-voicing Piper backend that converts through Chatterbox", async () => {
  const fs = require("fs");
  const built = [];
  const converted = [];
  const factory = (cfg) => {
    const eng = fakeEngine(120);
    eng.postSynthesis = cfg.postSynthesis; // what the Piper backend would apply to each finished WAV
    if (cfg.engine === "chatterbox") {
      eng.convertVoice = async (src, out, voice) => {
        converted.push({ src, out, voice });
        fs.writeFileSync(out, "re-voiced");
      };
    }
    built.push({ engine: cfg.engine, eng });
    return eng;
  };
  const q = new SpeechQueue(
    {
      ...baseConfig,
      engine: "chatterbox",
      voice: "clone:me",
      autoLanguage: true,
      languageVoices: { he: { engine: "piper", voice: "/m/he.onnx", inVoice: "clone:me" } },
    },
    (m) => {
      throw new Error(m);
    },
    undefined,
    factory
  );
  q.enqueue("שלום, הבדיקות עוברות עכשיו ואני ממשיך לעבוד על הקוד.");
  await until(() => built.some((b) => b.engine === "piper"), 2000);
  const piper = built.find((b) => b.engine === "piper").eng;
  assert.equal(typeof piper.postSynthesis, "function", "the Piper backend was given the re-voicing step");
  assert.equal(piper.events[0]?.voice, "/m/he.onnx", "Piper still reads with its own Hebrew model");
  // The step converts through the Chatterbox backend into the mapped clone and
  // leaves the result under the original path.
  const wav = path.join(require("os").tmpdir(), `cv-vc-${Date.now()}.wav`);
  fs.writeFileSync(wav, "piper audio");
  await piper.postSynthesis(wav);
  assert.deepEqual(
    converted.map((c) => c.voice),
    ["clone:me"]
  );
  assert.equal(converted[0].src, wav);
  assert.equal(fs.readFileSync(wav, "utf8"), "re-voiced", "the converted audio replaced the source in place");
  assert.ok(!fs.existsSync(converted[0].out), "no stray intermediate file");
  fs.unlinkSync(wav);
  q.stop();
});

test("without a converting engine the mapped voice is spoken as it is, and the user is told once", async () => {
  const errors = [];
  const built = [];
  const q = new SpeechQueue(
    {
      ...baseConfig,
      engine: "kokoro",
      voice: "af_heart",
      autoLanguage: true,
      languageVoices: { he: { engine: "piper", voice: "/m/he.onnx", inVoice: "clone:me" } },
    },
    (m) => errors.push(m),
    undefined,
    (cfg) => {
      built.push(cfg);
      return fakeEngine(50);
    } // no convertVoice anywhere
  );
  q.enqueue("שלום, הבדיקות עוברות עכשיו ואני ממשיך לעבוד על הקוד.");
  q.enqueue("שלום שוב, עוד משפט בעברית שמגיע אחרי הראשון.");
  await until(() => built.some((c) => c.engine === "piper"), 2000);
  assert.equal(
    built.filter((c) => c.engine === "piper")[0].postSynthesis,
    undefined,
    "no re-voicing step without a converter"
  );
  assert.equal(
    errors.filter((e) => /needs the Chatterbox MLX runtime/.test(e)).length,
    1,
    `told once: ${JSON.stringify(errors)}`
  );
  q.stop();
});

test("an utterance with nothing to pronounce is dropped before it reaches an engine", async () => {
  const eng = fakeEngine(50);
  const { q } = make(eng);
  q.enqueue("→");
  q.enqueue("...");
  q.enqueue("‏");
  assert.equal(eng.events.length, 0, "nothing was spoken");
  q.enqueue("Real words.");
  assert.equal(eng.events.length, 1);
  q.stop();
});

test("a cloned voice never asks the preset checkpoint to speak it", () => {
  // The failure this prevents: designing a voice selected it while the engine
  // was still loaded with the preset checkpoint, and every sentence after
  // that came back "CustomVoice model requires 'voice' (speaker name)".
  const { qwen3Checkpoint } = require("../../out/tts/qwen3.js");
  const preset = qwen3Checkpoint({ voice: "Ryan", clone: false, modelSize: "1.7B", runtime: "mlx" });
  const cloned = qwen3Checkpoint({ voice: "clone:mine", clone: true, modelSize: "1.7B", runtime: "mlx" });
  assert.match(preset, /CustomVoice/);
  assert.match(cloned, /-Base-/);
  assert.notEqual(preset, cloned, "they are different downloads, and mixing them is the bug");

  // The size follows the setting, and an unknown size is the small one.
  assert.match(qwen3Checkpoint({ voice: "Ryan", clone: false, modelSize: "0.6B", runtime: "mlx" }), /0\.6B/);
  assert.match(qwen3Checkpoint({ voice: "Ryan", clone: false, modelSize: "nonsense", runtime: "mlx" }), /0\.6B/);
  // Each runtime has its own repository for the same weights.
  assert.match(qwen3Checkpoint({ voice: "clone:mine", clone: true, modelSize: "1.7B", runtime: "torch" }), /^Qwen\//);
  assert.match(cloned, /^mlx-community\//);
});

test("a rate the user chooses is the rate they hear, backlog or not", async () => {
  // Speech speeds up toward a ceiling while it is behind. That made an
  // explicit change look broken: pressing "faster" during a long answer set a
  // number below what was already playing, so the voice appeared to speed up
  // and then drift back down on its own.
  const eng = fakeEngine(60);
  const long = `Sentence. ${"word ".repeat(120)}`;
  const { q } = make(eng, { rate: 210, maxRate: 300, dynamicRate: true });
  for (let i = 0; i < 6; i++) q.enqueue(`${i} ${long}`);
  await until(() => eng.events.length >= 2, 2000);
  const caughtUp = eng.events[1].wpm;
  assert.ok(caughtUp > 210, `catching up should raise the rate, saw ${caughtUp}`);

  q.applyRateNow(265);
  const spokenBefore = eng.events.length;
  await until(() => eng.events.length >= spokenBefore + 2, 3000);
  const after = eng.events.slice(spokenBefore).map((e) => e.wpm);
  assert.deepEqual(
    after.filter((w) => w !== 265),
    [],
    `every utterance after the change must be 265, saw ${after.join(", ")}`
  );
  assert.equal(eng.liveRates.at(-1), 265, "and the sentence already playing is retuned to it");

  // Once the backlog is gone, catching up is allowed again: the choice was
  // about this burst, not a permanent ban on keeping up.
  await until(() => q.pending === 0, 5000);
  eng.events.length = 0;
  for (let i = 0; i < 6; i++) q.enqueue(`later ${i} ${long}`);
  await until(() => eng.events.length >= 2, 3000);
  assert.ok(eng.events[1].wpm > 265, `a new burst may catch up again, saw ${eng.events[1].wpm}`);
});

test("catch-up starts only for a real backlog and moves the pace a step at a time", async () => {
  // One session's player log read 1.00, 1.20, 1.00, 1.15, 1.20, 1.10, 1.00:
  // the rate followed the queue length on every sentence, so an answer being
  // read at its natural pace lurched into a stretched one and back. Two
  // sentences waiting is not a backlog; five is, and the way up and the way
  // down are both taken in steps.
  const eng = fakeEngine(40);
  const { q } = make(eng, { rate: 200, maxRate: 300, dynamicRate: true });
  const long = (tag) => `${tag} ${"word ".repeat(48)}`; // a long sentence: too big to be coalesced with the next
  q.enqueue(long("one")); // playing
  q.enqueue(long("two"));
  q.enqueue(long("three"));
  await until(() => eng.events.length >= 3, 2000);
  assert.deepEqual(
    eng.events.slice(0, 3).map((e) => e.wpm),
    [200, 200, 200],
    "two sentences waiting are spoken at the base rate"
  );
  const eng2 = fakeEngine(40);
  const { q: q2 } = make(eng2, { rate: 200, maxRate: 300, dynamicRate: true });
  for (let i = 0; i < 9; i++) q2.enqueue(long(`s${i}`));
  await until(() => eng2.events.length >= 9, 4000);
  const rates = eng2.events.map((e) => e.wpm);
  for (let i = 1; i < rates.length; i++) {
    assert.ok(
      Math.abs(rates[i] - rates[i - 1]) <= 8,
      `step ${i}: ${rates[i - 1]} to ${rates[i]} is more than 4% of 200`
    );
  }
  assert.ok(Math.max(...rates) > 200, `a real backlog does speed up: ${rates.join(" ")}`);
  assert.equal(rates[rates.length - 1] < Math.max(...rates), true, "and eases back down as the queue drains");
});

test("an utterance carries the message it belongs to through coalescing, and an audition says it is one", async () => {
  // The export offers "the last message", which is only possible if each
  // utterance knows which message it came from, all the way to the engine.
  const eng = fakeEngine(30);
  const q = new SpeechQueue(
    baseConfig,
    () => {},
    undefined,
    () => eng
  );
  q.enqueue("First sentence of the answer.", 7);
  q.enqueue("Bash: run tests.", 7);
  q.enqueue("Read: file.", 8); // short: merges into the queued announcement, which keeps its message
  await until(() => eng.events.length === 2, 2000);
  assert.deepEqual(
    eng.events.map((e) => [e.text, e.group]),
    [
      ["First sentence of the answer.", 7],
      ["Bash: run tests. Read: file.", 7],
    ]
  );
  await sleep(60);
  q.preview("sample", "v2");
  await until(() => eng.events.length === 3, 2000);
  assert.equal(eng.events[2].preview, true, "an audition is marked, so it is never kept for export");
  assert.equal(eng.events[2].group, undefined);
  q.stop();
  q.dispose();
});
