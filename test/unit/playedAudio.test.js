// What was played is kept for export: one file per utterance, bounded by
// minutes, with the engines offering their audio rather than deleting it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { PlayedAudio } = require("../../out/export/playedAudio.js");
const { reportPlayed, setPlayedSink } = require("../../out/tts/played.js");
const { synthesizeThenPlayBackend } = require("../../out/tts/synthPlay.js");
const { parseWav } = require("../../out/tts/wav.js");
const { tmpDir, writeWav, until } = require("../helpers");

const utterance = (over = {}) => ({
  text: "hello there",
  engine: "fake",
  voice: "v",
  wpm: 200,
  tempo: 1,
  synthSpeed: 1,
  startedAt: Date.now() - 500,
  endedAt: Date.now(),
  ...over,
});

test("what an engine played is kept as one file per utterance, and the parts are taken away", async () => {
  const dir = path.join(tmpDir(), "played");
  const buffer = new PlayedAudio(dir, () => 600);
  buffer.load();
  const parts = [writeWav(path.join(tmpDir(), "a.p0.wav"), 0.4), writeWav(path.join(tmpDir(), "a.p1.wav"), 0.6)];
  assert.equal(buffer.retain(utterance({ parts, group: "m3", tempo: 1.2 })), true, "the files are taken");
  await buffer.ready();
  const [entry] = buffer.list();
  assert.ok(entry.file && fs.existsSync(entry.file), "one file in the buffer directory");
  assert.ok(Math.abs(entry.seconds - 1.0) < 0.01, `the parts joined: ${entry.seconds}s`);
  assert.equal(entry.sampleRate, 24000);
  assert.equal(entry.group, "m3");
  assert.equal(entry.tempo, 1.2);
  assert.deepEqual(
    parts.map((p) => fs.existsSync(p)),
    [false, false],
    "the parts are gone from the temp directory"
  );
  const info = parseWav(fs.readFileSync(entry.file));
  assert.equal(info.channels, 1);
  assert.equal(info.bitsPerSample, 16);
  // A new window reads it back.
  await until(() => fs.existsSync(path.join(dir, `index-${buffer.token}.json`)), 2000);
  const again = new PlayedAudio(dir, () => 600);
  again.load();
  assert.equal(again.list().length, 1);
  assert.equal(again.list()[0].text, "hello there");
  // ...and drops what was removed behind its back.
  fs.rmSync(entry.file);
  assert.equal(again.list().length, 0);
});

test("an engine that speaks without a file has its utterance rendered later, and a failed render leaves nothing", async () => {
  const buffer = new PlayedAudio(path.join(tmpDir(), "played"), () => 600);
  buffer.load();
  const rendered = [];
  const render = async (out) => {
    rendered.push(out);
    writeWav(out, 0.5, { rate: 22050 });
  };
  assert.equal(buffer.retain(utterance({ render })), true);
  assert.equal(buffer.pending, 1, "not there yet");
  buffer.retain(utterance({ text: "gone", render: () => Promise.reject(new Error("no such voice")) }));
  await buffer.ready();
  assert.equal(rendered.length, 1);
  assert.equal(buffer.pending, 0);
  const listed = buffer.list();
  assert.equal(listed.length, 1, "the failed one is not offered");
  assert.equal(listed[0].sampleRate, 22050);
  assert.ok(Math.abs(listed[0].seconds - 0.5) < 0.01);
});

test("nothing is kept when the setting is 0, and the oldest goes first once the minutes are full", async () => {
  let keep = 0;
  const buffer = new PlayedAudio(path.join(tmpDir(), "played"), () => keep);
  buffer.load();
  const part = writeWav(path.join(tmpDir(), "x.wav"), 0.2);
  assert.equal(buffer.retain(utterance({ parts: [part] })), false, "off: the engine keeps its file");
  assert.ok(fs.existsSync(part));
  keep = 1.0; // one second of audio
  for (let i = 0; i < 3; i++) {
    buffer.retain(
      utterance({ text: `s${i}`, parts: [writeWav(path.join(tmpDir(), `p${i}.wav`), 0.5)], startedAt: i * 1000 })
    );
  }
  await buffer.ready();
  assert.deepEqual(
    buffer.list().map((e) => e.text),
    ["s1", "s2"],
    "1.5 s asked to fit in 1 s: the oldest went"
  );
  // An export in progress holds every file in place until it is done.
  const release = buffer.hold();
  buffer.retain(utterance({ text: "s3", parts: [writeWav(path.join(tmpDir(), "p3.wav"), 0.5)] }));
  await buffer.ready();
  assert.equal(buffer.list().length, 3, "nothing pruned while held");
  release();
  assert.deepEqual(
    buffer.list().map((e) => e.text),
    ["s2", "s3"]
  );
  const files = buffer.list().map((e) => e.file);
  await buffer.clear();
  assert.equal(buffer.list().length, 0);
  assert.deepEqual(
    files.map((f) => fs.existsSync(f)),
    [false, false]
  );
});

test("the sink answers whether it took the files; without one, or when it fails, the engine keeps its file", () => {
  setPlayedSink(undefined);
  assert.equal(reportPlayed(utterance({ parts: ["x"] })), false);
  const seen = [];
  setPlayedSink((u) => {
    seen.push(u);
    return u.text === "keep";
  });
  assert.equal(reportPlayed(utterance({ text: "keep", parts: ["x"] })), true);
  assert.equal(reportPlayed(utterance({ text: "drop", parts: ["x"] })), false);
  setPlayedSink(() => {
    throw new Error("boom");
  });
  assert.equal(reportPlayed(utterance({ parts: ["x"] })), false, "a failing sink never costs the engine its file");
  setPlayedSink(undefined);
  assert.equal(seen.length, 2);
});

test(
  "a synth-then-play engine offers the file it played, keeps an audition to itself, and deletes what nobody took",
  { skip: process.platform === "win32" && "the fake player is a shell script" },
  async () => {
    // A player that plays nothing: the engine spawns whatever afplay or
    // ffplay is first on PATH, so a script that exits at once stands in.
    const fakeBin = tmpDir("cv-fakeplayer-");
    for (const name of ["afplay", "ffplay"]) {
      fs.writeFileSync(path.join(fakeBin, name), "#!/bin/sh\nexit 0\n");
      fs.chmodSync(path.join(fakeBin, name), 0o755);
    }
    const realPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${path.delimiter}${realPath}`;
    const taken = [];
    let take = true;
    setPlayedSink((u) => {
      taken.push(u);
      return take;
    });
    try {
      const backend = synthesizeThenPlayBackend({
        name: "fake",
        naturalWpm: 175,
        typicalRtf: 0.3,
        synthesize(text, wpm, voice, wavPath) {
          writeWav(wavPath, 0.2, { silence: true });
          return { promise: Promise.resolve(), cancel() {} };
        },
      });
      const speak = (req) =>
        new Promise((resolve, reject) =>
          backend.speak({ wpm: 175, voice: "v", volume: 0, ...req }, resolve, (m) => reject(new Error(m)))
        );
      await speak({ text: "said", group: "m4" });
      await speak({ text: "audition", preview: true });
      take = false;
      await speak({ text: "unwanted" });
      assert.deepEqual(
        taken.map((u) => u.text),
        ["said", "unwanted"],
        "the audition was never offered"
      );
      assert.equal(taken[0].group, "m4");
      assert.equal(taken[0].tempo, 1);
      assert.equal(taken[0].engine, "fake");
      assert.ok(taken[0].endedAt >= taken[0].startedAt);
      assert.ok(fs.existsSync(taken[0].parts[0]), "the file was left for the sink that took it");
      await until(() => !fs.existsSync(taken[1].parts[0]), 2000); // nobody took it: deleted as always
      fs.rmSync(taken[0].parts[0], { force: true });
      backend.dispose();
    } finally {
      setPlayedSink(undefined);
      process.env.PATH = realPath;
    }
  }
);

test("windows sharing the directory see each other's audio, and a closed window's audio is adopted", async () => {
  const dir = path.join(tmpDir(), "played");
  const live = new Set(["a", "b"]);
  const isLive = (t) => live.has(t);
  const a = new PlayedAudio(dir, () => 600, { token: "a", isLive });
  const b = new PlayedAudio(dir, () => 600, { token: "b", isLive });
  a.load();
  b.load();
  const say = (buffer, text, at) =>
    buffer.retain(
      utterance({ text, parts: [writeWav(path.join(tmpDir(), `${text}.wav`), 0.2)], startedAt: at, endedAt: at + 200 })
    );
  say(a, "a1", 1000);
  say(b, "b1", 2000);
  say(a, "a2", 3000);
  await Promise.all([a.ready(), b.ready()]);
  await until(
    () => fs.existsSync(path.join(dir, "index-a.json")) && fs.existsSync(path.join(dir, "index-b.json")),
    2000
  );
  await new Promise((r) => setTimeout(r, 300)); // other windows' indexes are re-read every quarter second
  const names = (buffer) => buffer.list().map((e) => e.text);
  assert.deepEqual(names(a), ["a1", "b1", "a2"], "in the order they played, whichever window played them");
  assert.deepEqual(names(b), ["a1", "b1", "a2"]);
  assert.ok(
    a.list().every((e) => /\/p(a|b)-\d+\.wav$/.test(e.file)),
    "files are named after the window that wrote them"
  );
  // Window b closes: the next window to look adopts what it kept.
  live.delete("b");
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(names(a), ["a1", "b1", "a2"]);
  assert.ok(!fs.existsSync(path.join(dir, "index-b.json")), "b's index is gone; its entries are a's now");
  await until(() => JSON.parse(fs.readFileSync(path.join(dir, "index-a.json"), "utf8")).entries.length === 3, 2000);
  // A third window starting later finds it all in one index, with b's files still there.
  const c = new PlayedAudio(dir, () => 600, { token: "c", isLive });
  c.load();
  assert.deepEqual(names(c), ["a1", "b1", "a2"]);
  await c.clear();
  assert.deepEqual(names(c), []);
  assert.deepEqual(
    fs.readdirSync(dir).filter((f) => f.endsWith(".wav")),
    [],
    "a reset removes every window's audio"
  );
});

test("audio no index claims is swept once it is old, and a shorter setting is applied on the spot", async () => {
  const dir = path.join(tmpDir(), "played");
  fs.mkdirSync(dir, { recursive: true });
  const old = writeWav(path.join(dir, "pz-1.wav"), 0.1);
  const stale = `${path.join(dir, "pz-2.wav")}.tmp`;
  fs.writeFileSync(stale, "half");
  const ago = new Date(Date.now() - 5 * 60_000);
  fs.utimesSync(old, ago, ago);
  fs.utimesSync(stale, ago, ago);
  const fresh = writeWav(path.join(dir, "pz-3.wav"), 0.1); // another window may be about to claim this one
  let keep = 600;
  const buffer = new PlayedAudio(dir, () => keep, { token: "w" });
  buffer.load();
  assert.deepEqual(
    [old, stale, fresh].map((f) => fs.existsSync(f)),
    [false, false, true]
  );
  for (let i = 0; i < 3; i++) {
    buffer.retain(utterance({ text: `s${i}`, parts: [writeWav(path.join(tmpDir(), `q${i}.wav`), 0.5)] }));
  }
  await buffer.ready();
  assert.equal(buffer.list().length, 3);
  keep = 1.0;
  buffer.enforce();
  assert.deepEqual(
    buffer.list().map((e) => e.text),
    ["s1", "s2"],
    "the setting was lowered: the oldest went at once"
  );
  keep = 0;
  buffer.enforce();
  await until(() => buffer.list().length === 0, 2000);
  assert.deepEqual(
    fs.readdirSync(dir).filter((f) => /^pw-/.test(f)),
    [],
    "0 keeps nothing, including what was there"
  );
});

test("a closed window adopted by two windows at once is listed once", async () => {
  const dir = path.join(tmpDir(), "played");
  fs.mkdirSync(dir, { recursive: true });
  // The index a window left behind when it closed, with one sentence.
  const file = writeWav(path.join(dir, "pd-1.wav"), 0.2);
  const entry = {
    ...utterance({ text: "left behind" }),
    id: 1,
    at: 1000,
    seconds: 0.2,
    sampleRate: 24000,
    bytes: 9644,
    file,
  };
  delete entry.startedAt;
  const dead = JSON.stringify({ version: 2, token: "d", entries: [entry] });
  fs.writeFileSync(path.join(dir, "index-d.json"), dead);
  const live = new Set(["a", "b"]);
  const a = new PlayedAudio(dir, () => 600, { token: "a", isLive: (t) => live.has(t) });
  const b = new PlayedAudio(dir, () => 600, { token: "b", isLive: (t) => live.has(t) });
  a.load();
  // Two windows starting at the same moment both read the index before
  // either removes it: the second reading is replayed here.
  fs.writeFileSync(path.join(dir, "index-d.json"), dead);
  b.load();
  await until(
    () => fs.existsSync(path.join(dir, "index-a.json")) && fs.existsSync(path.join(dir, "index-b.json")),
    2000
  );
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(
    b.list().map((e) => e.text),
    ["left behind"],
    "one sentence, however many indexes name it"
  );
  assert.ok(!fs.existsSync(path.join(dir, "index-d.json")));
  // A window with nothing of its own writes no index.
  const c = new PlayedAudio(dir, () => 600, { token: "c", isLive: (t) => live.has(t) });
  c.load();
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(!fs.existsSync(path.join(dir, "index-c.json")), "nothing to list, no index");
});
