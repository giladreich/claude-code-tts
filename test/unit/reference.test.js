// The reference recording a cloned voice is generated from (assets/reference.py),
// which both Qwen3 daemons pass to the model.
//
// The bug behind it: a pause longer than about half a second inside the
// reference taught the model that silence is followed by the end of speech,
// and four sentences in ten ended after two frames. What matters here is that
// the words survive (the transcript still has to match the audio), that a
// recording with nothing to shorten is handed over untouched, and that a file
// the reader cannot make sense of is never a failure.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawnSync } = require("child_process");
const { ROOT, tmpDir, pythonWithNumpy } = require("../helpers");

const python = pythonWithNumpy();
const skip = !python && "a Python with numpy is required";

/** Build the recordings, condense them, and report what happened, in one process. */
function run(dir) {
  const code = [
    "import json, os, sys, wave",
    "import numpy as np",
    `sys.path.insert(0, ${JSON.stringify(path.join(ROOT, "assets"))})`,
    "from reference import condensed_reference",
    "sr = 16000",
    "burst = lambda s: (np.sin(2*np.pi*220*(np.arange(int(sr*s))/sr)) * 12000).astype('<i2')",
    "hush = lambda s: np.zeros(int(sr*s), dtype='<i2')",
    "def write(name, samples, channels=1, width=2):",
    "    p = os.path.join(sys.argv[1], name)",
    "    with wave.open(p, 'wb') as w:",
    "        w.setnchannels(channels); w.setsampwidth(width); w.setframerate(sr)",
    "        w.writeframes(samples.tobytes())",
    "    return p",
    // A designed voice's passage: long pauses between sentences, silent edges.
    "gappy = write('gappy.wav', np.concatenate([hush(0.5), burst(1.0), hush(0.7), burst(1.0), hush(0.85), burst(1.0), hush(0.6)]))",
    "tight = write('tight.wav', np.concatenate([burst(1.0), hush(0.2), burst(1.0)]))",
    "stereo = write('stereo.wav', np.zeros(sr*2, dtype='<i2'), channels=2)",
    "out, note = condensed_reference(gappy)",
    "with wave.open(out, 'rb') as w:",
    "    shape = [w.getnframes()/sr, w.getnchannels(), w.getsampwidth(), w.getframerate()]",
    "speech = lambda p: float((np.abs(np.frombuffer(wave.open(p,'rb').readframes(10**9), dtype='<i2')) > 2000).sum())/sr",
    "print(json.dumps({",
    "  'source_seconds': 5.65, 'out': out, 'note': note, 'shape': shape,",
    "  'speech_before': speech(gappy), 'speech_after': speech(out),",
    "  'same_file_again': condensed_reference(gappy)[0] == out,",
    "  'tight': condensed_reference(tight), 'stereo': condensed_reference(stereo),",
    "  'missing': condensed_reference(os.path.join(sys.argv[1], 'nothing.wav')),",
    "}))",
  ].join("\n");
  const r = spawnSync(python, ["-c", code, dir], { encoding: "utf8", env: { ...process.env, TMPDIR: dir } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("long pauses are shortened and the edges trimmed, with every word kept", { skip }, () => {
  const dir = tmpDir("cv-ref-");
  const out = run(dir);
  const [seconds, channels, width, rate] = out.shape;
  assert.ok(seconds < 4.4 && seconds > 3.6, `5.65s became ${seconds.toFixed(2)}s`);
  assert.ok(/silence\(s\) shortened/.test(out.note), `the note says what changed: ${out.note}`);
  assert.deepEqual([channels, width, rate], [1, 2, 16000], "still 16-bit mono at the same rate");
  // The words are what the transcript promises the model: none may be lost.
  assert.ok(
    Math.abs(out.speech_after - out.speech_before) < 0.05,
    `speech went from ${out.speech_before.toFixed(2)}s to ${out.speech_after.toFixed(2)}s`
  );
  assert.equal(out.same_file_again, true, "condensed once per file version, not per request");
});

test("a recording with nothing to shorten, and one that cannot be read, are handed over as they are", { skip }, () => {
  const out = run(tmpDir("cv-ref-"));
  for (const [name, [file, note]] of Object.entries({
    tight: out.tight,
    stereo: out.stereo,
    missing: out.missing,
  })) {
    assert.ok(file.endsWith(name === "missing" ? "nothing.wav" : `${name}.wav`), `${name} kept its own path`);
    assert.equal(note, null, `${name} has nothing to report`);
  }
});
