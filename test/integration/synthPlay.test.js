// synthesizeThenPlayBackend with a FAKE streaming synthesizer and the real
// (silent) player: prewarm reuse, gapless parts, cancel cleanup, hold on
// pause, error surfacing. No models involved.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { hasSwiftc, playerStorageDir, writeWav, sleep, until, tmpDir } = require("../helpers");

// A private temp dir: the backend writes its audio parts to os.tmpdir(), and
// a running Claude Code TTS extension on this machine writes there too, so
// leftover-file checks must not see its in-flight parts.
process.env.TMPDIR = tmpDir("cv-synth-tmp-");

const skip = !hasSwiftc && "macOS with CommandLineTools required";

function fakeStreamEngine(opts = {}) {
  const calls = [];
  const { synthesizeThenPlayBackend } = require("../../out/tts/synthPlay.js");
  const backend = synthesizeThenPlayBackend({
    name: "fake",
    naturalWpm: 175,
    typicalRtf: opts.rtf ?? 0.1,
    synthesizeStream(text, wpm, voice, base, onPart, urgent) {
      const call = { text, voice, urgent, cancelled: false };
      calls.push(call);
      let cancelled = false;
      const promise = (async () => {
        const n = opts.parts ?? 3;
        for (let i = 0; i < n; i++) {
          await sleep(opts.partDelayMs ?? 60);
          if (cancelled) throw new Error("cancelled");
          if (opts.failAt === i) throw new Error("synth exploded");
          const f = writeWav(`${base}.p${i}.wav`, opts.partSecs ?? 0.25);
          onPart(f, i === n - 1);
        }
      })();
      promise.catch(() => {});
      return {
        promise,
        cancel: () => {
          cancelled = true;
          call.cancelled = true;
        },
      };
    },
  });
  return { backend, calls };
}

/** Temp parts written since `since` (other test files may own older ones). */
function tempWavs(since = 0) {
  return fs
    .readdirSync(os.tmpdir())
    .filter((f) => f.startsWith("claude-code-tts-") && f.endsWith(".wav"))
    .filter((f) => fs.statSync(path.join(os.tmpdir(), f)).mtimeMs >= since);
}

test.before(async () => {
  const audio = require("../../out/tts/audio.js");
  audio.initPersistentPlayer(playerStorageDir(), path.join(__dirname, "..", "..", "assets", "wavplayer.swift"), (m) => {
    throw new Error(m);
  });
  // First exec of a freshly copied binary pays a one-time macOS scan (~1s);
  // timing assertions below start after a warm-up play.
  const p = audio.getPersistentPlayer();
  if (p) {
    const warm = writeWav(path.join(os.tmpdir(), `cv-warm-${process.pid}.wav`), 0.05); // not a claude-code-tts-* name
    await p.play(warm, 1, 0).done;
    fs.unlinkSync(warm);
  }
});
test.after(() => require("../../out/tts/audio.js").disposePersistentPlayer());

test("streams parts gaplessly and cleans its temp files", { skip }, async () => {
  const { backend, calls } = fakeStreamEngine({ parts: 4, partSecs: 0.2 });
  let done = false;
  const since = Date.now() - 1000; // for the leftover-file check
  const t0 = Date.now();
  backend.speak(
    { text: "hello", wpm: 175, voice: "v", volume: 0 },
    () => (done = true),
    (m) => {
      throw new Error(m);
    }
  );
  await until(() => done, 5000);
  const took = Date.now() - t0;
  assert.ok(took > 700 && took < 1800, `4x0.2s parts took ${took}ms`);
  assert.equal(calls[0].urgent, true);
  await sleep(100);
  assert.deepEqual(tempWavs(since), [], "no leftover temp wavs");
});

test("prewarm is background priority and is reused by speak", { skip }, async () => {
  const { backend, calls } = fakeStreamEngine({ parts: 2, partSecs: 0.15 });
  backend.prewarm({ text: "next", wpm: 175, voice: "v", volume: 0 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].urgent, false);
  await sleep(200); // parts already produced
  let done = false;
  const t0 = Date.now();
  backend.speak(
    { text: "next", wpm: 175, voice: "v", volume: 0 },
    () => (done = true),
    (m) => {
      throw new Error(m);
    }
  );
  assert.equal(calls.length, 1, "speak attached to the prewarmed session, no new synthesis");
  await until(() => done, 3000);
  assert.ok(Date.now() - t0 < 900, "prewarmed audio starts immediately");
  // Eviction: only two stream prewarms are kept.
  backend.prewarm({ text: "a", wpm: 175, voice: "v", volume: 0 });
  backend.prewarm({ text: "b", wpm: 175, voice: "v", volume: 0 });
  backend.prewarm({ text: "c", wpm: 175, voice: "v", volume: 0 });
  assert.ok(calls.find((c) => c.text === "a").cancelled, "oldest prewarm evicted");
  backend.flush();
  assert.ok(calls.filter((c) => ["b", "c"].includes(c.text)).every((c) => c.cancelled));
});

test("kill cancels synthesis and playback; pause holds audio until resume", { skip }, async () => {
  const { backend, calls } = fakeStreamEngine({ parts: 6, partSecs: 0.3, partDelayMs: 80 });
  let done = false;
  const sp = backend.speak(
    { text: "long", wpm: 175, voice: "v", volume: 0 },
    () => (done = true),
    (m) => {
      throw new Error(m);
    }
  );
  await sleep(250);
  sp.kill();
  assert.ok(calls[0].cancelled);
  await sleep(300);
  assert.equal(done, false, "killed utterance never reports done");
  // pause: freeze before any part exists, then resume; done arrives only after resume.
  let done2 = false;
  const t0 = Date.now();
  const sp2 = backend.speak(
    { text: "held", wpm: 175, voice: "v", volume: 0 },
    () => (done2 = true),
    (m) => {
      throw new Error(m);
    }
  );
  sp2.freeze();
  await sleep(1200);
  assert.equal(done2, false, "nothing completes while frozen");
  sp2.unfreeze();
  await until(() => done2, 5000);
  assert.ok(Date.now() - t0 > 1200);
});

test("synthesis failure is reported and the queue moves on", { skip }, async () => {
  const { backend } = fakeStreamEngine({ parts: 3, failAt: 0 });
  const errors = [];
  let done = false;
  backend.speak(
    { text: "boom", wpm: 175, voice: "v", volume: 0 },
    () => (done = true),
    (m) => errors.push(m)
  );
  await until(() => done, 3000);
  assert.match(errors[0], /synth exploded/);
  // Failure after the first part still finishes (partial audio plays out).
  const late = fakeStreamEngine({ parts: 3, failAt: 2, partSecs: 0.15 });
  let done2 = false;
  const errs2 = [];
  late.backend.speak(
    { text: "late", wpm: 175, voice: "v", volume: 0 },
    () => (done2 = true),
    (m) => errs2.push(m)
  );
  await until(() => done2, 4000);
});

test("slow synthesis at high tempo is prebuffered: no underrun, no gaps", { skip }, async () => {
  // 8 parts of 0.4s produced every 0.35s (rtf 0.875) while playing at 1.6x:
  // consumption 0.25s per part vs production 0.35s -> would underrun at
  // every boundary without prebuffering.
  const { backend } = fakeStreamEngine({ parts: 8, partSecs: 0.4, partDelayMs: 350, rtf: 0.875 });
  const storage = playerStorageDir();
  const log = path.join(storage, "player.log");
  const before = fs.readFileSync(log, "utf8").length;
  let done = false;
  const text = "x".repeat(Math.round((3.2 * 175 * 5.5) / 60)); // ~3.2s of speech at 175wpm
  const t0 = Date.now();
  backend.speak(
    { text, wpm: 280, voice: "v", volume: 0 },
    () => (done = true),
    (m) => {
      throw new Error(m);
    }
  );
  await until(() => done, 15000);
  const total = Date.now() - t0;
  const fresh = fs.readFileSync(log, "utf8").slice(before);
  assert.ok(!fresh.includes("underrun"), "player reported an underrun:\n" + fresh);
  // 8 parts arrive over 2.8s; 3.2s of audio at 1.6x plays in 2.0s: total is bounded by production plus a tail.
  assert.ok(total > 2500 && total < 4500, `took ${total}ms`);
});

test(
  "an engine slower than declared is learned: the second utterance is prebuffered enough to avoid underruns",
  { skip },
  async () => {
    // Declared rtf 0.3 (optimistic) but the fake produces 0.4s parts every
    // 0.5s (rtf 1.25) while playing at 1.0x. The first utterance may underrun
    // (nothing measured yet); the second must not.
    const { backend } = fakeStreamEngine({ parts: 6, partSecs: 0.4, partDelayMs: 500, rtf: 0.3 });
    const log = path.join(playerStorageDir(), "player.log");
    const text = "x".repeat(Math.round((2.4 * 175 * 5.5) / 60)); // ~2.4s of speech
    let done = false;
    backend.speak(
      { text, wpm: 175, voice: "v", volume: 0 },
      () => (done = true),
      (m) => {
        throw new Error(m);
      }
    );
    await until(() => done, 15000);
    const mark = fs.readFileSync(log, "utf8").length;
    let done2 = false;
    const t0 = Date.now();
    backend.speak(
      { text, wpm: 175, voice: "v", volume: 0 },
      () => (done2 = true),
      (m) => {
        throw new Error(m);
      }
    );
    await until(() => done2, 15000);
    const fresh = fs.readFileSync(log, "utf8").slice(mark);
    assert.ok(!fresh.includes("underrun"), "second utterance underran despite the learned synthesis speed:\n" + fresh);
    // It buffered before starting: total is bounded by production time (6 x 0.5s) plus the last part.
    const total = Date.now() - t0;
    assert.ok(total > 2800 && total < 5000, `took ${total}ms`);
  }
);

test("a slow engine never produces a long silence followed by a sprint", { skip }, async () => {
  // The engine produces 0.4s of audio every 0.6s (rtf 1.5) while the user
  // asks for 280 wpm (tempo 1.6). Before the fix the pipeline waited several
  // seconds to prebuffer the whole deficit, then played at 1.6x.
  const { backend } = fakeStreamEngine({ parts: 6, partSecs: 0.4, partDelayMs: 600, rtf: 1.5 });
  const log = path.join(playerStorageDir(), "player.log");
  const mark = fs.readFileSync(log, "utf8").length;
  const text = "y".repeat(Math.round((2.4 * 175 * 5.5) / 60));
  let done = false;
  const t0 = Date.now();
  backend.speak(
    { text, wpm: 280, voice: "v", volume: 0 },
    () => (done = true),
    (m) => {
      throw new Error(m);
    }
  );
  // The first sound must arrive quickly: the prebuffer is capped.
  await until(() => fs.readFileSync(log, "utf8").slice(mark).includes("[node] play"), 4000);
  const waited = Date.now() - t0;
  // Bounded: a couple of seconds of buffering buys continuous speech, and
  // later chunks are prewarmed while the previous one plays, so the wait is
  // paid at most once per burst. What must never happen is the old pattern:
  // many seconds of silence and then a sprint.
  assert.ok(waited < 3400, `first audio after ${waited}ms: the prebuffer must stay bounded`);
  await until(() => done, 20000);
  const fresh = fs.readFileSync(log, "utf8").slice(mark);
  // Playback was slowed to what the engine sustains rather than sprinting.
  const tempo = Number(/tempo=([\d.]+)/.exec(fresh)?.[1]);
  assert.ok(tempo <= 1.05, `played at ${tempo}x; the engine only sustains ~0.6x realtime`);
  assert.ok(!fresh.includes("underrun"), "no underruns:\n" + fresh);
});

test("playback eases off before the buffer runs dry instead of stuttering", { skip }, async () => {
  // Declared fast (rtf 0.3) but actually slower than playback: 0.35s of audio
  // every 0.55s while the user asked for 1.35x. Without the buffer loop this
  // underran at nearly every part boundary.
  const { backend } = fakeStreamEngine({ parts: 10, partSecs: 0.35, partDelayMs: 550, rtf: 0.3 });
  const log = path.join(playerStorageDir(), "player.log");
  const text = "w".repeat(Math.round((3.5 * 175 * 5.5) / 60));
  const speak = async () => {
    let done = false;
    backend.speak(
      { text, wpm: 236, voice: "v", volume: 0 },
      () => (done = true),
      (m) => {
        throw new Error(m);
      }
    );
    await until(() => done, 25000);
  };
  // First utterance: the declared speed is wrong, so it runs dry and the
  // tempo is eased down rather than stuttering to the end.
  await speak();
  const mark = fs.readFileSync(log, "utf8").length;
  // Second: the measured speed is known, so it is buffered and plays clean.
  await speak();
  const fresh = fs.readFileSync(log, "utf8").slice(mark);
  const underruns = (fresh.match(/underrun/g) ?? []).length;
  assert.ok(underruns <= 1, `${underruns} underruns on the second utterance:\n${fresh}`);
});

test("a chunk prepared at one rate is reused when spoken at another", { skip }, async () => {
  // The prewarm key carries the synth speed; when catch-up moved the rate
  // between enqueue and speak, the fallback match by text+voice+language must
  // still find the prepared rendering. Adding language to the key had broken
  // that match silently: every such prewarm was thrown away and re-synthesized.
  const calls = [];
  const { synthesizeThenPlayBackend } = require("../../out/tts/synthPlay.js");
  const backend = synthesizeThenPlayBackend({
    name: "fake-native",
    naturalWpm: 175,
    typicalRtf: 0.1,
    nativeSpeed: true, // synth speed follows the rate, so 200 and 300 wpm are different keys
    synthesizeStream(text, wpm, voice, base, onPart) {
      calls.push({ text, wpm });
      const promise = (async () => {
        await sleep(40);
        onPart(writeWav(`${base}.p0.wav`, 0.25), true);
      })();
      return { promise, cancel() {} };
    },
  });
  backend.prewarm({ text: "same sentence", wpm: 200, voice: "v", volume: 0, language: "de" });
  await sleep(120);
  await new Promise((resolve) =>
    backend.speak({ text: "same sentence", wpm: 300, voice: "v", volume: 0, language: "de" }, resolve, (m) => {
      throw new Error(m);
    })
  );
  assert.equal(calls.length, 1, `synthesized ${calls.length} times: the prepared rendering was not reused`);
  backend.dispose?.();
});

/**
 * An engine that streams only when asked to speak now, and prepares ahead of
 * time whole, which is what Chatterbox does: streaming wins the first word
 * but costs more per chunk, so the buffer is built from whole chunks.
 */
function fakeUrgentOnlyEngine() {
  const streams = [];
  const wholes = [];
  const { synthesizeThenPlayBackend } = require("../../out/tts/synthPlay.js");
  const backend = synthesizeThenPlayBackend({
    name: "fake-urgent-only",
    naturalWpm: 175,
    typicalRtf: 0.1,
    synthesize(text, wpm, voice, wavPath) {
      wholes.push(text);
      writeWav(wavPath, 0.25);
      return { promise: Promise.resolve(), cancel() {} };
    },
    synthesizeStream(text, wpm, voice, base, onPart, urgent) {
      if (!urgent) return undefined; // prepared ahead: whole is cheaper
      streams.push(text);
      const promise = (async () => {
        await sleep(40);
        onPart(writeWav(`${base}.p0.wav`, 0.15), false);
        await sleep(40);
        onPart(writeWav(`${base}.p1.wav`, 0.15), true);
      })();
      promise.catch(() => {});
      return { promise, cancel() {} };
    },
  });
  return { backend, streams, wholes };
}

test("a chunk the engine declines to stream is still prepared ahead, whole", { skip }, async () => {
  const { backend, streams, wholes } = fakeUrgentOnlyEngine();
  backend.prewarm({ text: "second sentence", wpm: 175, voice: "v", volume: 0 });
  await until(() => wholes.length === 1, 2000);
  assert.deepEqual(streams, [], "a prewarm never streams on this engine");
  assert.deepEqual(wholes, ["second sentence"], "and is not silently skipped either");
  backend.dispose?.();
});

test("speaking a chunk prepared whole plays it as it is rather than starting a stream", { skip }, async () => {
  const { backend, streams, wholes } = fakeUrgentOnlyEngine();
  backend.prewarm({ text: "second sentence", wpm: 175, voice: "v", volume: 0 });
  await until(() => wholes.length === 1, 2000);
  let done = false;
  backend.speak(
    { text: "second sentence", wpm: 175, voice: "v", volume: 0 },
    () => (done = true),
    (m) => {
      throw new Error(m);
    }
  );
  await until(() => done, 5000);
  assert.deepEqual(streams, [], "the prepared file was used; no second synthesis");
  assert.equal(wholes.length, 1);
  // Nothing prepared for it: the chunk about to play streams.
  let done2 = false;
  backend.speak(
    { text: "first words", wpm: 175, voice: "v", volume: 0 },
    () => (done2 = true),
    (m) => {
      throw new Error(m);
    }
  );
  await until(() => done2, 5000);
  assert.deepEqual(streams, ["first words"]);
  backend.dispose?.();
});

test(
  "a rate change mid-stream is held to what the engine can feed, so it neither stutters nor drifts",
  { skip },
  async () => {
    // Pressing "faster" during a sentence retuned the player straight to the
    // asked-for tempo while the stream was still being synthesized. On an
    // engine slower than that, the buffer emptied within a second (heard as a
    // stutter) and the easing loop then wound the speed back down (heard as
    // the change undoing itself). The stream's own ceiling applies to the
    // change as well.
    const { backend } = fakeStreamEngine({ parts: 10, partSecs: 0.35, partDelayMs: 380, rtf: 1.2 });
    const log = path.join(playerStorageDir(), "player.log");
    const text = "w".repeat(Math.round((3.5 * 175 * 5.5) / 60));
    const mark = fs.readFileSync(log, "utf8").length;
    let done = false;
    backend.speak(
      { text, wpm: 175, voice: "v", volume: 0 },
      () => (done = true),
      (m) => {
        throw new Error(m);
      }
    );
    // Once playback has started and while parts are still arriving: the
    // prebuffer holds the first ~2 s back, and the stream runs ~3.8 s.
    await until(() => backend.currentTempo() !== undefined, 8000);
    await sleep(250);
    backend.setLiveRate(450);
    const tempo = backend.currentTempo();
    assert.ok(
      tempo !== undefined && tempo <= 1.01,
      `the player was told ${tempo}x while the stream could feed 1.0x at most`
    );
    await until(() => done, 25000);
    const fresh = fs.readFileSync(log, "utf8").slice(mark);
    const underruns = (fresh.match(/underrun/g) ?? []).length;
    assert.ok(underruns <= 1, `${underruns} underruns after a rate change mid-stream:\n${fresh}`);
  }
);
