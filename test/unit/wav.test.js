const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { parseWav, buildWav, wavFileSeconds, trimSilence } = require("../../out/tts/wav.js");
const { tmpDir, writeWav } = require("../helpers");

test("parseWav walks extra chunks (CoreAudio FLLR/JUNK) and reports duration", () => {
  const pcm = Buffer.alloc(24000 * 2);
  const canonical = buildWav(pcm, 24000, 1, 16);
  assert.equal(parseWav(canonical).seconds, 1);
  const junk = Buffer.alloc(8 + 4000);
  junk.write("JUNK", 0);
  junk.writeUInt32LE(4000, 4);
  const withJunk = Buffer.concat([canonical.subarray(0, 36), junk, canonical.subarray(36)]);
  withJunk.writeUInt32LE(withJunk.length - 8, 4);
  const info = parseWav(withJunk);
  assert.equal(info.seconds, 1);
  assert.equal(info.dataOffset, 36 + junk.length + 8);
  assert.equal(parseWav(Buffer.from("not a wav file at all")), undefined);
});

test("wavFileSeconds reads only the header and bounds by real file size", () => {
  const dir = tmpDir();
  const f = writeWav(path.join(dir, "a.wav"), 2.5);
  assert.ok(Math.abs(wavFileSeconds(f) - 2.5) < 0.001);
  fs.truncateSync(f, 44 + 24000 * 2);
  assert.ok(Math.abs(wavFileSeconds(f) - 1) < 0.001);
  assert.equal(wavFileSeconds(path.join(dir, "missing.wav")), undefined);
});

test("trimSilence cuts edges, keeps speech, rewrites canonically", () => {
  const dir = tmpDir();
  const rate = 24000;
  const sil = Buffer.alloc(rate * 2);
  const n = rate * 2;
  const tone = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) tone.writeInt16LE(Math.round(Math.sin(i / 10) * 6000), i * 2);
  const f = path.join(dir, "t.wav");
  fs.writeFileSync(f, buildWav(Buffer.concat([sil, tone, sil]), rate, 1, 16));
  const r = trimSilence(f);
  assert.ok(r.seconds > 2.2 && r.seconds < 2.4, `trimmed to ${r.seconds}s`);
  assert.ok(r.rms > 1000);
  assert.equal(parseWav(fs.readFileSync(f)).dataOffset, 44);
});

const { referenceWindows, extractWav } = require("../../out/tts/wav.js");

test("referenceWindows picks a 6-12s stretch at pause boundaries with the most speech", () => {
  const dir = tmpDir();
  const rate = 24000;
  // 40s: 2s speech / 0.5s pause repeated, then a 6s pause, then denser clearer speech.
  const parts = [];
  const tone = (secs, amp, freq = 200) => {
    const n = Math.round(rate * secs);
    const b = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * amp), i * 2);
    return b;
  };
  const silence = (secs) => Buffer.alloc(Math.round(rate * secs) * 2);
  for (let i = 0; i < 6; i++) parts.push(tone(2, 3000), silence(0.5)); // 15s, 80% speech
  parts.push(silence(6));
  for (let i = 0; i < 4; i++) parts.push(tone(3, 8000), silence(0.3)); // 13.2s, ~91% speech, louder
  parts.push(silence(2));
  const f = path.join(dir, "long.wav");
  fs.writeFileSync(f, buildWav(Buffer.concat(parts), rate, 1, 16));
  const wins = referenceWindows(f);
  assert.ok(wins.length >= 2, `candidates ${wins.length}`);
  const best = wins[0];
  assert.ok(best.seconds >= 6 && best.seconds <= 12, `best ${best.seconds}s`);
  assert.ok(best.start >= 21 && best.start < 22.5, `best starts in the clear section (${best.start.toFixed(2)}s)`);
  assert.ok(best.density > 0.85, `density ${best.density}`);
  // Every candidate starts right after a pause boundary (start of a burst).
  for (const w of wins) {
    const rel = (w.start - 0) % 2.5;
    const inFirst = w.start < 15;
    if (inFirst) assert.ok(rel < 0.05 || rel > 2.45, `starts at a burst boundary: ${w.start.toFixed(2)}`);
  }
  // Extraction yields exactly that stretch.
  const out = path.join(dir, "ref.wav");
  extractWav(f, best.start, best.end, out);
  assert.ok(Math.abs(wavFileSeconds(out) - best.seconds) < 0.01);
  // Short recording: one window covering it all.
  const shortF = path.join(dir, "short.wav");
  fs.writeFileSync(shortF, buildWav(Buffer.concat([tone(4, 3000), silence(0.5), tone(4, 3000)]), rate, 1, 16));
  const sw = referenceWindows(shortF);
  assert.equal(sw.length, 1);
  assert.ok(Math.abs(sw[0].seconds - 8.5) < 0.05);
});

test(
  "convertToCloneWav produces 24kHz mono 16-bit from other formats",
  {
    skip:
      process.platform !== "darwin" &&
      !require("../../out/platform/platform.js").hasCommand("ffmpeg") &&
      "needs afconvert (macOS) or ffmpeg",
  },
  async () => {
    const Module = require("module");
    const origResolve = Module._resolveFilename;
    Module._resolveFilename = function (request, ...rest) {
      if (request === "vscode") return "vscode-stub";
      return origResolve.call(this, request, ...rest);
    };
    require.cache["vscode-stub"] = {
      id: "vscode-stub",
      filename: "vscode-stub",
      loaded: true,
      exports: { window: {}, workspace: {}, commands: {}, ProgressLocation: {} },
    };
    const { convertToCloneWav } = require("../../out/voices/cloneFromFile.js");
    const dir = tmpDir();
    // 48kHz stereo source
    const rate = 48000,
      n = rate * 2;
    const pcm = Buffer.alloc(n * 4);
    for (let i = 0; i < n; i++) {
      const v = Math.round(Math.sin(i / 20) * 6000);
      pcm.writeInt16LE(v, i * 4);
      pcm.writeInt16LE(v, i * 4 + 2);
    }
    const src = path.join(dir, "src.wav");
    fs.writeFileSync(src, buildWav(pcm, rate, 2, 16));
    const out = path.join(dir, "out.wav");
    await convertToCloneWav(src, out);
    const info = parseWav(fs.readFileSync(out));
    assert.equal(info.sampleRate, 24000);
    assert.equal(info.channels, 1);
    assert.equal(info.bitsPerSample, 16);
    assert.ok(Math.abs(info.seconds - 2) < 0.05);
    // Already-conforming WAV is copied as is.
    const same = path.join(dir, "same.wav");
    await convertToCloneWav(out, same);
    assert.equal(fs.statSync(same).size, fs.statSync(out).size);
    await assert.rejects(
      convertToCloneWav(path.join(dir, "missing.m4a"), path.join(dir, "x.wav")),
      /afconvert|ffmpeg|audio helper/
    );
  }
);

const { normalizeReference } = require("../../out/tts/wav.js");

test("normalizeReference removes DC offset and levels a quiet reference to about -3 dBFS", () => {
  const dir = tmpDir();
  const rate = 24000,
    n = rate * 2;
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 15) * 4000 + 800), i * 2); // quiet, with +800 DC
  const f = path.join(dir, "q.wav");
  fs.writeFileSync(f, buildWav(pcm, rate, 1, 16));
  const r = normalizeReference(f);
  assert.ok(Math.abs(r.gain - (32767 * 0.7079) / 4000) < 0.3, `gain ${r.gain}`);
  const out = fs.readFileSync(f);
  const info = parseWav(out);
  const body = out.subarray(info.dataOffset);
  let sum = 0,
    peak = 0;
  for (let i = 0; i < n; i++) {
    const v = body.readInt16LE(i * 2);
    sum += v;
    peak = Math.max(peak, Math.abs(v));
  }
  assert.ok(Math.abs(sum / n) < 50, `dc ${sum / n}`);
  assert.ok(peak > 32767 * 0.6 && peak <= 32767, `peak ${peak}`);
  // Already-loud audio is left roughly alone (gain near 1) and never clipped.
  const loud = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) loud.writeInt16LE(Math.round(Math.sin(i / 15) * 23000), i * 2);
  const g = path.join(dir, "l.wav");
  fs.writeFileSync(g, buildWav(loud, rate, 1, 16));
  const r2 = normalizeReference(g);
  assert.ok(Math.abs(r2.gain - 1) < 0.05, `gain ${r2.gain}`);
  // Near-silence is left untouched.
  const sil = path.join(dir, "s.wav");
  fs.writeFileSync(sil, buildWav(Buffer.alloc(n * 2), rate, 1, 16));
  assert.equal(normalizeReference(sil).gain, 1);
});
