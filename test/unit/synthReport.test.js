// A non-streaming engine never emits parts, so the pipeline can only learn its
// real speed from what the engine reports about each synthesis. Chatterbox
// was measured at 1.45x realtime on an idle machine and 3x on a swapping one;
// the sustainable-rate cap must follow the machine, not the benchmark.
const test = require("node:test");
const assert = require("node:assert/strict");
const { synthesizeThenPlayBackend } = require("../../out/tts/synthPlay.js");
const { playbackTempo, TEMPO_DEADBAND } = require("../../out/tts/wavPlayers.js");
const { writeWav, until } = require("../helpers");

test("a slow synthesis report lowers the sustainable rate to natural pace; a fast one does not raise it above the declared figure", async () => {
  let report = { genSeconds: 30, audioSeconds: 10 }; // 3x realtime
  const backend = synthesizeThenPlayBackend({
    name: "fake-slow",
    naturalWpm: 175,
    typicalRtf: 0.5, // declared faster than realtime, so there is room to fall
    synthesize(text, wpm, voice, wavPath) {
      writeWav(wavPath, 0.3);
      return { promise: Promise.resolve(report), cancel() {} };
    },
  });
  const declared = backend.sustainableWpm();
  assert.ok(Math.abs(declared - 175 / (0.5 * 1.1)) < 1, `declared ${declared}`);
  backend.prewarm({ text: "one", wpm: 175, voice: "v", volume: 0 });
  await until(() => backend.sustainableWpm() < declared - 10, 2000);
  // Streamed playback is never slower than natural pace (it buffers and
  // eases instead), so that is the floor the sustainable rate reports: an
  // engine at 3x realtime still plays at 175, it just waits more first.
  assert.equal(
    backend.sustainableWpm(),
    175,
    `learned 3x: floored at natural pace, not ${backend.sustainableWpm()} wpm`
  );
  // A faster machine cannot talk the cap back above the declared floor.
  report = { genSeconds: 2, audioSeconds: 10 };
  for (let i = 0; i < 12; i++) backend.prewarm({ text: `fast ${i}`, wpm: 175, voice: "v", volume: 0 });
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(backend.sustainableWpm() <= declared + 0.5, `never above the declared figure: ${backend.sustainableWpm()}`);
  backend.dispose?.();
});

test("a post-processing step rewrites the finished WAV before it is used", async () => {
  const processed = [];
  const backend = synthesizeThenPlayBackend({
    name: "fake-post",
    naturalWpm: 175,
    typicalRtf: 0.3,
    synthesize(text, wpm, voice, wavPath) {
      writeWav(wavPath, 0.3, { freq: 200 });
      return { promise: Promise.resolve(), cancel() {} };
    },
    async postProcess(wavPath, voice, language) {
      processed.push({ wavPath, voice, language });
      writeWav(wavPath, 0.6, { freq: 800 }); // "re-voiced": same file, different content
    },
  });
  backend.prewarm({ text: "hello", wpm: 175, voice: "v", volume: 0, language: "he" });
  await until(() => processed.length === 1, 2000);
  assert.equal(processed[0].voice, "v");
  assert.equal(processed[0].language, "he");
  const { parseWav } = require("../../out/tts/wav.js");
  await until(
    () =>
      require("fs").existsSync(processed[0].wavPath) &&
      Math.abs(parseWav(require("fs").readFileSync(processed[0].wavPath)).seconds - 0.6) < 0.01,
    1000
  );
  backend.dispose?.();
});

test(
  "a CLI engine failure reports the engine's own last stderr line",
  { skip: process.platform === "win32" && "POSIX shell" },
  async () => {
    const backend = synthesizeThenPlayBackend({
      name: "fake-cli",
      naturalWpm: 175,
      buildSynth: () => ({ cmd: "sh", args: ["-c", "echo 'ValueError: nothing to phonemize' >&2; exit 1"] }),
    });
    const errors = [];
    await new Promise((resolve) =>
      backend.speak({ text: "x", wpm: 175, voice: "v", volume: 0 }, resolve, (m) => {
        errors.push(m);
      })
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0], /exited with 1: ValueError: nothing to phonemize/);
    backend.dispose?.();
  }
);

test("a rate that changes nothing audible is played at exactly one", () => {
  // 2% is 60ms in a 3s sentence, and buys a phase vocoder over every word.
  assert.equal(playbackTempo(1.02), 1);
  assert.equal(playbackTempo(0.98), 1);
  assert.equal(playbackTempo(1 + TEMPO_DEADBAND / 2), 1);
  // Rates a listener actually asked for are untouched.
  assert.equal(playbackTempo(1.2), 1.2);
  assert.equal(playbackTempo(1 + TEMPO_DEADBAND * 2), 1 + TEMPO_DEADBAND * 2);
  assert.equal(playbackTempo(0.9), 0.9);
  // And the range still bounds it, deadband or not.
  assert.equal(playbackTempo(9), 3);
  assert.equal(playbackTempo(0.01), 0.4);
});
