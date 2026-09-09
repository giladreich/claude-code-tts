// Audio extraction from video and audio containers via the bundled
// AVFoundation helper (macOS): full file and time range.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { ROOT, hasSwiftc, tmpDir } = require("../helpers");
const { parseWav } = require("../../out/tts/wav.js");

const skip = !hasSwiftc && "macOS with CommandLineTools required";

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

function build(src, out) {
  const r = spawnSync("swiftc", ["-O", "-o", out, src], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`swiftc failed: ${r.stderr.slice(-400)}`);
}

test("extracts 24kHz mono WAV from a video (whole and a time range) and from AAC", { skip }, async () => {
  const { convertToCloneWav } = require("../../out/voices/cloneFromFile.js");
  const dir = tmpDir("cv-extract-");
  const extractor = path.join(dir, "extractaudio");
  const makevideo = path.join(dir, "makevideo");
  build(path.join(ROOT, "assets", "extractaudio.swift"), extractor);
  build(path.join(ROOT, "test", "helpers", "makevideo.swift"), makevideo);
  // 12s source: a 440Hz tone for 0-6s, an 880Hz tone for 6-12s (so a range can be told apart).
  const rate = 24000,
    n = rate * 12;
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++)
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * (i < rate * 6 ? 440 : 880) * i) / rate) * 8000), i * 2);
  const { buildWav } = require("../../out/tts/wav.js");
  const src = path.join(dir, "src.wav");
  fs.writeFileSync(src, buildWav(pcm, rate, 1, 16));
  const mov = path.join(dir, "clip.mov");
  const mk = spawnSync(makevideo, [src, mov], { encoding: "utf8", timeout: 120000 });
  assert.match(mk.stdout, /ok/, mk.stdout + mk.stderr);
  assert.ok(fs.statSync(mov).size > 10000);

  const whole = path.join(dir, "whole.wav");
  await convertToCloneWav(mov, whole, { extractor });
  let info = parseWav(fs.readFileSync(whole));
  assert.equal(info.sampleRate, 24000);
  assert.equal(info.channels, 1);
  assert.equal(info.bitsPerSample, 16);
  assert.ok(Math.abs(info.seconds - 12) < 0.3, `whole ${info.seconds}s`);

  const ranged = path.join(dir, "range.wav");
  await convertToCloneWav(mov, ranged, { extractor, start: 7, end: 11 });
  info = parseWav(fs.readFileSync(ranged));
  assert.ok(Math.abs(info.seconds - 4) < 0.3, `range ${info.seconds}s`);
  // Dominant frequency of the ranged part must be the 880Hz half: count zero crossings.
  const body = fs.readFileSync(ranged).subarray(info.dataOffset);
  let crossings = 0;
  for (let i = 1; i < body.length / 2; i++)
    if (body.readInt16LE(i * 2) >= 0 !== body.readInt16LE((i - 1) * 2) >= 0) crossings++;
  const hz = crossings / 2 / info.seconds;
  assert.ok(hz > 800 && hz < 960, `ranged audio should be the 880Hz half, got ~${Math.round(hz)}Hz`);

  // AAC audio file through the same helper.
  const m4a = path.join(dir, "a.m4a");
  spawnSync("afconvert", ["-f", "m4af", "-d", "aac", src, m4a]);
  const fromAac = path.join(dir, "aac.wav");
  await convertToCloneWav(m4a, fromAac, { extractor });
  info = parseWav(fs.readFileSync(fromAac));
  assert.ok(Math.abs(info.seconds - 12) < 0.3);

  // Bad input: a clear error, no hang.
  fs.writeFileSync(path.join(dir, "junk.mp4"), "not media");
  await assert.rejects(
    convertToCloneWav(path.join(dir, "junk.mp4"), path.join(dir, "x.wav"), { extractor }),
    /no audio track|cannot|decode|failed/
  );
});
