// An export is what was heard: the played tempo, the pauses within reason,
// the range that was asked for, and a size that can be chosen by.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const {
  atempo,
  clock,
  estimateBytes,
  exportAudio,
  findEncoders,
  firstWords,
  messagesOf,
  missingFor,
  parseRange,
  resample,
  sampleRateOf,
  sizeLabel,
  timeline,
  totalSeconds,
} = require("../../out/export/audioExport.js");
const { parseWav, wavFileSeconds } = require("../../out/tts/wav.js");
const { tmpDir, writeWav } = require("../helpers");

let nextId = 1;
/** An entry as the buffer holds it: `seconds` of audio, played at `tempo`, started at `at`. */
function entry(dir, seconds, { tempo = 1, synthSpeed = 1, rate = 24000, at = 0, endedAt, text = "words" } = {}) {
  const id = nextId++;
  const file = writeWav(path.join(dir, `p${id}.wav`), seconds, { rate, freq: 300 + id * 50 });
  return {
    id,
    at,
    endedAt: endedAt ?? at + (seconds / tempo) * 1000,
    text,
    engine: "fake",
    voice: "v",
    wpm: 200,
    tempo,
    synthSpeed,
    seconds,
    sampleRate: rate,
    bytes: fs.statSync(file).size,
    file,
  };
}

const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} is not within ${tol} of ${b}`);

test("the timeline keeps the heard pauses up to the style's cap and stretches by the tempo that played", () => {
  const dir = tmpDir();
  const a = entry(dir, 2, { at: 0 });
  const b = entry(dir, 1, { at: a.endedAt + 3000, tempo: 2 }); // a 3 s wait, then played at 2x
  const c = entry(dir, 1, { at: 0 });
  c.at = b.endedAt - 200; // clocks skew: a negative gap is no gap
  c.endedAt = c.at + 1000;
  const natural = timeline([a, b, c], "asPlayed", "natural");
  assert.deepEqual(
    natural.map((s) => [Math.round(s.t0 * 1000) / 1000, s.seconds]),
    [
      [0, 2],
      [2.6, 0.5],
      [3.1, 1],
    ]
  );
  near(totalSeconds(natural), 4.1, 1e-9, "total");
  assert.equal(timeline([a, b, c], "asPlayed", "asHeard")[1].t0, 5, "as heard keeps the 3 s wait");
  near(timeline([a, b, c], "asPlayed", "tight")[1].t0, 2.15, 1e-9, "tight");
  // The voice's own pace undoes what the engine baked in, not what the player did.
  const own = timeline([entry(dir, 1, { tempo: 1.5, synthSpeed: 1.25 })], "natural", "natural");
  assert.equal(own[0].seconds, 1.25);
  assert.equal(timeline([entry(dir, 1, { tempo: 1.5 })], "asIs", "natural")[0].seconds, 1);
  // An entry without audio is not on the timeline.
  assert.equal(timeline([{ ...a, file: undefined }], "asPlayed", "natural").length, 0);
  // The sample rate is the one most of the audio is at.
  assert.equal(sampleRateOf(timeline([a, entry(dir, 0.5, { rate: 22050 })], "asIs", "natural")), 24000);
});

test("sizes follow the bitrate, ranges read the way a person types them, and the helpers agree with themselves", () => {
  near(estimateBytes("mp3", "good", 60, 24000), (96000 * 60) / 8 + 4096, 1, "mp3 good, a minute");
  assert.equal(estimateBytes("wav", "best", 60, 24000), 60 * 24000 * 2 + 44);
  assert.ok(estimateBytes("flac", "good", 60, 24000) < estimateBytes("wav", "good", 60, 24000));
  assert.ok(estimateBytes("opus", "small", 60, 24000) < estimateBytes("mp3", "small", 60, 24000));
  assert.equal(sizeLabel(700 * 1024), "700 KB");
  assert.equal(sizeLabel(1.25 * 1024 * 1024), "1.3 MB");
  assert.equal(clock(65), "1:05");
  assert.equal(clock(0), "0:00");
  assert.equal(clock(600), "10:00");
  assert.deepEqual(atempo(1.5), ["atempo=1.500"]);
  assert.deepEqual(atempo(3), ["atempo=1.732", "atempo=1.732"]);
  assert.deepEqual(atempo(0.4), ["atempo=0.632", "atempo=0.632"]);
  assert.equal(resample(Buffer.alloc(22050 * 2), 22050, 24000).length, 24000 * 2);

  assert.deepEqual(parseRange("0:10-1:30", 600), { start: 10, end: 90 });
  assert.deepEqual(parseRange("10-90", 600), { start: 10, end: 90 });
  assert.deepEqual(parseRange("0:10 to 1:30", 600), { start: 10, end: 90 });
  assert.deepEqual(parseRange("1:20", 600), { start: 80, end: 600 });
  assert.deepEqual(parseRange("-0:30", 600), { start: 0, end: 30 });
  assert.deepEqual(parseRange("9:00-20:00", 600), { start: 540, end: 600 });
  assert.equal(parseRange("", 600), undefined);
  assert.equal(typeof parseRange("abc", 600), "string");
  assert.equal(typeof parseRange("1:75-2:00", 600), "string");
  assert.equal(typeof parseRange("2:00-2:00.5", 600), "string", "under a second");
  assert.equal(typeof parseRange("11:00-12:00", 600), "string", "past the end");

  assert.equal(missingFor("wav", {}), undefined);
  assert.equal(missingFor("mp3", {}), "ffmpeg");
  assert.equal(missingFor("m4a", { afconvert: "/usr/bin/afconvert" }), undefined);
  assert.equal(missingFor("opus", { afconvert: "/usr/bin/afconvert" }), "ffmpeg");
  assert.equal(typeof findEncoders(), "object");

  assert.equal(
    firstWords("  one   two three four five six seven eight nine ten eleven twelve  ", 30),
    "one two three four five six..."
  );
  assert.equal(firstWords("short", 30), "short");
  const groups = messagesOf([
    { group: 1 },
    { group: 1 },
    { group: 2 },
    { group: undefined },
    { group: undefined },
    { group: 2 },
  ]);
  assert.deepEqual(
    groups.map((m) => [m.group, m.entries.length]),
    [
      [1, 2],
      [2, 1],
      [undefined, 2],
      [2, 1],
    ]
  );
});

test("without ffmpeg the export is exact PCM: pauses inserted, the range cut, a second sample rate resampled", async () => {
  const dir = tmpDir();
  const a = entry(dir, 1, { at: 0 });
  const b = entry(dir, 0.5, { at: a.endedAt + 400, rate: 22050 }); // a 0.4 s pause, and another rate
  const segments = timeline([a, b], "asIs", "natural");
  const out = path.join(dir, "out.wav");
  const whole = await exportAudio({
    segments,
    format: "wav",
    quality: "good",
    encoders: {},
    out,
    workDir: path.join(dir, "w1"),
  });
  near(whole.seconds, 1.9, 0.002, "1 + 0.4 + 0.5");
  const info = parseWav(fs.readFileSync(out));
  assert.equal(info.sampleRate, 24000);
  assert.equal(info.channels, 1);
  near(info.seconds, 1.9, 0.002, "the file");
  assert.equal(whole.bytes, fs.statSync(out).size);

  const part = await exportAudio({
    segments,
    range: { start: 0.5, end: 1.6 },
    format: "wav",
    quality: "good",
    encoders: {},
    out,
    workDir: path.join(dir, "w2"),
  });
  near(part.seconds, 1.1, 0.002, "the range");

  // A timeline laid out with a stretch that cannot be applied is refused,
  // rather than cut on a clock the audio does not follow. (The sheet lays
  // the timeline out without a stretch when ffmpeg is absent.)
  const fast = timeline([entry(dir, 1, { tempo: 2 })], "asPlayed", "natural");
  await assert.rejects(
    exportAudio({ segments: fast, format: "wav", quality: "good", encoders: {}, out, workDir: path.join(dir, "w3") }),
    /needs ffmpeg/
  );
  const asIs = timeline([entry(dir, 1, { tempo: 2 })], "asIs", "natural");
  const plain = await exportAudio({
    segments: asIs,
    format: "wav",
    quality: "good",
    encoders: {},
    out,
    workDir: path.join(dir, "w3"),
  });
  near(plain.seconds, 1, 0.002, "as produced");

  await assert.rejects(
    exportAudio({
      segments,
      range: { start: 5, end: 6 },
      format: "wav",
      quality: "good",
      encoders: {},
      out,
      workDir: path.join(dir, "w4"),
    }),
    /nothing was played/
  );
  await assert.rejects(
    exportAudio({ segments, format: "mp3", quality: "good", encoders: {}, out, workDir: path.join(dir, "w5") }),
    /needs ffmpeg/
  );
});

test(
  "with ffmpeg the played tempo is applied and the file is the format asked for, at about the size promised",
  { skip: !findEncoders().ffmpeg && "ffmpeg is not installed here" },
  async () => {
    const dir = tmpDir();
    const encoders = findEncoders();
    const fast = timeline(
      [entry(dir, 2, { tempo: 2 }), entry(dir, 4, { tempo: 1.25, at: 1200 })],
      "asPlayed",
      "natural"
    );
    near(totalSeconds(fast), 4.2 + Math.min(0.6, 0.2), 1e-9, "1 + 3.2 plus the 0.2 s pause");
    const wav = path.join(dir, "fast.wav");
    const r = await exportAudio({
      segments: fast,
      format: "wav",
      quality: "good",
      encoders,
      out: wav,
      workDir: path.join(dir, "w1"),
    });
    near(r.seconds, 4.4, 0.06, "stretched to the played pace");
    near(wavFileSeconds(wav), 4.4, 0.06, "the file");

    const mp3 = path.join(dir, "out.mp3");
    const m = await exportAudio({
      segments: fast,
      format: "mp3",
      quality: "good",
      encoders,
      out: mp3,
      workDir: path.join(dir, "w2"),
      title: "a title",
    });
    const promised = estimateBytes("mp3", "good", 4.4, 24000);
    assert.ok(Math.abs(m.bytes - promised) / promised < 0.25, `promised ${promised}, wrote ${m.bytes}`);
    assert.equal(fs.readFileSync(mp3).subarray(0, 3).toString("latin1"), "ID3", "an MP3 with its title tag");

    const m4a = path.join(dir, "out.m4a");
    const aac = await exportAudio({
      segments: fast,
      format: "m4a",
      quality: "small",
      encoders,
      out: m4a,
      workDir: path.join(dir, "w3"),
    });
    assert.ok(
      aac.bytes > 1000 && aac.bytes < m.bytes,
      `AAC at 32 kbit/s is smaller than MP3 at 96: ${aac.bytes} vs ${m.bytes}`
    );

    // Cancelled: no file is left.
    const controller = new globalThis.AbortController();
    controller.abort();
    await assert.rejects(
      exportAudio({
        segments: fast,
        format: "wav",
        quality: "good",
        encoders,
        out: wav,
        workDir: path.join(dir, "w4"),
        signal: controller.signal,
      }),
      /cancelled/
    );
  }
);
