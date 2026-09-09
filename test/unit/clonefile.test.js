const test = require("node:test");
const assert = require("node:assert/strict");
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
const { parseTimeRange, prepareStretch } = require("../../out/voices/cloneFromFile.js");

test("parseTimeRange accepts mm:ss and seconds, open ends, and rejects nonsense", () => {
  const total = 600;
  assert.deepEqual(parseTimeRange("1:20-2:05", total), { start: 80, end: 125 });
  assert.deepEqual(parseTimeRange("80-125", total), { start: 80, end: 125 });
  assert.deepEqual(parseTimeRange("0:45 to 1:30", total), { start: 45, end: 90 });
  assert.deepEqual(parseTimeRange("1:20-", total), { start: 80, end: 600 });
  assert.deepEqual(parseTimeRange("-0:30", total), { start: 0, end: 30 });
  assert.deepEqual(parseTimeRange("1:20", total), { start: 80, end: 600 });
  assert.deepEqual(parseTimeRange("9:00-20:00", total), { start: 540, end: 600 }); // clamped to the end
  assert.equal(parseTimeRange("", total), undefined);
  assert.equal(parseTimeRange("   ", total), undefined);
  assert.equal(typeof parseTimeRange("abc", total), "string");
  assert.equal(typeof parseTimeRange("1:75-2:00", total), "string"); // 75 seconds is not a mm:ss value
  assert.equal(typeof parseTimeRange("2:00-2:02", total), "string"); // under 4s
  assert.equal(typeof parseTimeRange("11:00-12:00", total), "string"); // past the end
});

test("a candidate stretch is prepared as it would be saved, and a silent one is refused", () => {
  // The list plays what the cloner would get, so the cutting, trimming and
  // levelling happen before the row is shown, not after it is chosen: a
  // candidate that is silence never reaches the list at all.
  const fs = require("fs");
  const path = require("path");
  const { buildWav, parseWav } = require("../../out/tts/wav.js");
  const { tmpDir } = require("../helpers");
  const dir = tmpDir();
  const rate = 24000;
  const tone = (secs, amp) => {
    const n = Math.round(rate * secs);
    const b = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) {
      b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * amp), i * 2);
    }
    return b;
  };
  const silence = (secs) => Buffer.alloc(Math.round(rate * secs) * 2);
  const file = path.join(dir, "source.wav");
  fs.writeFileSync(file, buildWav(Buffer.concat([silence(1), tone(8, 4000), silence(3)]), rate, 1, 16));

  const kept = prepareStretch(file, dir, { start: 0, end: 10, density: 0.8 });
  assert.ok(kept, "eight seconds of speech is a usable stretch");
  assert.ok(kept.seconds > 7.5 && kept.seconds < 8.8, `trimmed to the speech: ${kept.seconds}s`);
  assert.ok(fs.existsSync(kept.wav));
  const info = parseWav(fs.readFileSync(kept.wav));
  const pcm = fs.readFileSync(kept.wav).subarray(info.dataOffset);
  let peak = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
  }
  assert.ok(peak > 20000, `levelled towards full scale, not left at ${peak}`);

  const quiet = prepareStretch(file, dir, { start: 9.2, end: 13, density: 0 });
  assert.equal(quiet, undefined, "silence is not a reference");
  const left = fs.readdirSync(dir).filter((f) => f.startsWith(".import-ref"));
  assert.deepEqual(left, [path.basename(kept.wav)], "a refused candidate leaves no file behind");
});

test("every step of cloning from a file can be walked back through", () => {
  // It used to be one modal per candidate offering "Use it" or "Next
  // candidate": no way back to a stretch already heard, none to the part of
  // the file the candidates came from, and no way to name an exact range.
  const fs = require("fs");
  const path = require("path");
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "src", "voices", "cloneFromFile.ts"), "utf8");
  const code = source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
  assert.ok(code.includes("pickWithPreview"), "the candidates are one list that plays what is highlighted");
  assert.doesNotMatch(code, /Next candidate/, "no forward-only audition");
  for (const back of ['step = "part"', 'step = "stretch"', 'step = "transcript"']) {
    assert.ok(code.includes(back), `a step returns to ${back}`);
  }
});

test("a recorded voice's reference text can be corrected after the fact", () => {
  // A transcription that got one word wrong ("multi-plan" for "multi-planet")
  // is read along with the recording by the cloner, so the mismatch is heard
  // in every sentence. Until now the only way out was to clone again.
  const fs = require("fs");
  const path = require("path");
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "src", "ui", "voiceManager.ts"), "utf8");
  const start = source.indexOf("Reference text...");
  assert.ok(start > 0, "My Voices offers the reference text");
  const action = source.slice(start, source.indexOf("Rename...", start));
  assert.match(action, /value: p\.refText/, "prefilled with what the profile has");
  assert.match(action, /updateProfileMeta\([^)]*refText: text\.trim\(\)/, "written back to the profile");
  assert.match(action, /textSource: "typed"/, "and recorded as the user's own words");
  assert.match(action, /deps\.refreshEngine\(\)/, "the engine restarts, or the old text keeps being read");
  const guard = source.lastIndexOf("p.designed", start);
  assert.ok(guard > 0 && start - guard < 400, "not offered for a designed voice, whose text is what was rendered");
});
