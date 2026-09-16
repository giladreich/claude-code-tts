// The built-in Windows voice through its persistent host: no process per
// sentence, so no gap between sentences, and a cancel or a pause that lands
// at once. Runs on Windows only; volume 0 throughout.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { systemBackend } = require("../../out/tts/system.js");
const { setPlayedSink } = require("../../out/tts/played.js");
const { parseWav } = require("../../out/tts/wav.js");
const { ROOT, tmpDir, until } = require("../helpers");

const onWindows = process.platform === "win32";
const HOST = path.join(ROOT, "assets", "sapi_host.ps1");

const req = (text, over = {}) => ({ text, wpm: 200, voice: "", volume: 0, ...over });

/** Speak and resolve with how long it took, in ms. */
function spoken(backend, text, over = {}) {
  const errors = [];
  const t0 = Date.now();
  let speaker;
  const done = new Promise((resolve) => {
    speaker = backend.speak(
      req(text, over),
      () => resolve(Date.now() - t0),
      (m) => errors.push(m)
    );
  });
  return { done, speaker, errors };
}

test(
  "sentences follow each other without a process start between them",
  { skip: !onWindows && "Windows only" },
  async () => {
    const backend = systemBackend(() => {}, HOST);
    try {
      const first = await spoken(backend, "One.").done; // pays for the host starting
      const marks = [];
      for (const text of ["Two.", "Three.", "Four."]) {
        const t = Date.now();
        await spoken(backend, text).done;
        marks.push(Date.now() - t);
      }
      // Each is one short word: a process per sentence cost a second or more
      // of startup on top; the host answers in the time the word takes.
      for (const ms of marks) {
        assert.ok(ms < first + 200, `a later sentence (${ms}ms) took no longer than the first (${first}ms)`);
        assert.ok(ms < 2500, `${ms}ms for one word`);
      }
    } finally {
      backend.dispose();
    }
  }
);

test(
  "a cancel stops the sentence at once, and a pause holds it mid-word",
  { skip: !onWindows && "Windows only" },
  async () => {
    const backend = systemBackend(() => {}, HOST);
    try {
      await spoken(backend, "Ready.").done;
      const long =
        "A long sentence that will be cut off well before it can finish, so its ending is never heard at all.";
      const { done, speaker } = spoken(backend, long);
      await new Promise((r) => setTimeout(r, 300));
      const t = Date.now();
      speaker.kill();
      await done;
      assert.ok(Date.now() - t < 1000, "the queue is not kept waiting for the cut sentence");
      // Paused for a second: the sentence takes that much longer.
      const plain = await spoken(backend, "Pause and resume test, a few words long.").done;
      const paused = spoken(backend, "Pause and resume test, a few words long.");
      setTimeout(() => paused.speaker.freeze(), 200);
      setTimeout(() => paused.speaker.unfreeze(), 1200);
      const withPause = await paused.done;
      // The audio already handed to the device plays out before the pause is heard, so less than the full second shows.
      assert.ok(withPause > plain + 300, `paused ${withPause}ms against ${plain}ms unpaused`);
      assert.deepEqual(paused.errors, []);
    } finally {
      backend.dispose();
    }
  }
);

test(
  "what was spoken is offered for export, rendered through the host in the voice's format",
  { skip: !onWindows && "Windows only" },
  async () => {
    const backend = systemBackend(() => {}, HOST);
    const offered = [];
    setPlayedSink((u) => {
      offered.push(u);
      return false;
    });
    try {
      await spoken(backend, "Kept for the export.").done;
      await until(() => offered.length === 1, 5000);
      const out = path.join(tmpDir("cv-sapi-"), "render.wav");
      await offered[0].render(out);
      const info = parseWav(fs.readFileSync(out));
      assert.ok(info && info.bitsPerSample === 16 && info.sampleRate >= 8000, "a PCM WAV in the voice's own format");
      assert.ok(info.dataLength > info.sampleRate, "more than half a second of audio");
      // An audition is never offered.
      await spoken(backend, "Just a preview.", { preview: true }).done;
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(offered.length, 1);
    } finally {
      setPlayedSink(undefined);
      backend.dispose();
    }
  }
);

test(
  "a host that cannot start is replaced by a process per sentence, and the sentence is still spoken",
  { skip: !onWindows && "Windows only" },
  async () => {
    const broken = path.join(tmpDir("cv-sapi-"), "broken.ps1");
    fs.writeFileSync(broken, "exit 3\n");
    const errors = [];
    const backend = systemBackend(() => {}, broken);
    try {
      const t0 = Date.now();
      await new Promise((resolve) => backend.speak(req("Spoken the old way."), resolve, (m) => errors.push(m)));
      assert.ok(Date.now() - t0 < 15000);
      assert.equal(errors.length, 1);
      assert.match(errors[0], /speech host did not start/);
      // The next sentence goes straight to a process, with no second complaint.
      await new Promise((resolve) => backend.speak(req("And again."), resolve, (m) => errors.push(m)));
      assert.equal(errors.length, 1);
    } finally {
      backend.dispose();
    }
  }
);
