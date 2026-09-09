// The persistent macOS player (Swift + node side), exercised silently.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { hasSwiftc, playerStorageDir, tmpDir, writeWav, sleep } = require("../helpers");

const skip = !hasSwiftc && "macOS with CommandLineTools required";

function setup() {
  const audio = require("../../out/tts/audio.js");
  const storage = playerStorageDir();
  const errors = [];
  audio.initPersistentPlayer(storage, path.join(__dirname, "..", "..", "assets", "wavplayer.swift"), (m) =>
    errors.push(m)
  );
  const p = audio.getPersistentPlayer();
  assert.ok(p, "player binary should be available");
  const dir = tmpDir("cv-audio-");
  return { p, errors, dir, log: path.join(storage, "player.log"), audio };
}

/** First exec of a freshly copied binary pays a one-time macOS scan (~1s);
 *  timing assertions start after a warm-up play. */
async function warm(p, dir) {
  await p.play(writeWav(path.join(dir, "warm.wav"), 0.05), 1, 0).done;
}

test("plays, reports done at the right time, appends parts gaplessly", { skip }, async () => {
  const { p, errors, dir, audio } = setup();
  await warm(p, dir);
  const a = writeWav(path.join(dir, "a.wav"), 0.5),
    b = writeWav(path.join(dir, "b.wav"), 0.5);
  const t0 = Date.now();
  const pb = p.play(a, 1, 0, false);
  pb.append(b, true);
  await pb.done;
  const took = Date.now() - t0;
  assert.ok(took > 900 && took < 1600, `two 0.5s parts took ${took}ms`);
  assert.deepEqual(errors, []);
  audio.disposePersistentPlayer();
});

test("stop-then-play never completes the new stream early (id attribution)", { skip }, async () => {
  const { p, errors, dir, log, audio } = setup();
  const long = writeWav(path.join(dir, "long.wav"), 3),
    short = writeWav(path.join(dir, "short.wav"), 0.6);
  for (let i = 0; i < 6; i++) {
    const pa = p.play(long, 1, 0);
    await sleep(30 + i * 90);
    pa.cancel();
    const t = Date.now();
    const pb = p.play(short, 1, 0);
    await Promise.race([
      pb.done,
      sleep(4000).then(() => {
        throw new Error("hang");
      }),
    ]);
    const took = Date.now() - t;
    assert.ok(took > 450 && took < 2000, `iteration ${i}: ${took}ms`);
  }
  assert.ok(!fs.readFileSync(log, "utf8").includes("WATCHDOG"));
  assert.deepEqual(errors, []);
  audio.disposePersistentPlayer();
});

test("pause holds the deadline; live rate and volume apply; watchdog stays quiet", { skip }, async () => {
  const { p, errors, dir, log, audio } = setup();
  const f = writeWav(path.join(dir, "f.wav"), 2);
  const t0 = Date.now();
  const pb = p.play(f, 1, 0);
  setTimeout(() => pb.freeze(), 200);
  setTimeout(() => pb.unfreeze(), 2700); // paused longer than the file itself
  setTimeout(() => p.setRate(2), 2800);
  setTimeout(() => p.setVolume(0), 2900);
  await pb.done;
  const took = Date.now() - t0;
  assert.ok(took > 3300 && took < 4300, `took ${took}ms`);
  assert.ok(!fs.readFileSync(log, "utf8").includes("WATCHDOG"));
  assert.deepEqual(errors, []);
  audio.disposePersistentPlayer();
});

test("an unreadable file fails the playback instead of hanging", { skip }, async () => {
  const { p, errors, dir, audio } = setup();
  const bad = path.join(dir, "bad.wav");
  fs.writeFileSync(bad, "not audio");
  const pb = p.play(bad, 1, 0);
  await assert.rejects(pb.done, /cannot open|playback failed/);
  const ok = writeWav(path.join(dir, "ok.wav"), 0.3);
  await p.play(ok, 1, 0).done; // still healthy afterwards
  assert.deepEqual(errors, []);
  audio.disposePersistentPlayer();
});

test("unity rate leaves the time-stretch out of the path entirely", { skip }, async () => {
  // A phase vocoder colours what it processes even when it retimes nothing:
  // at 1.02x it overshot a full-scale utterance to 1.36 and the output
  // clipped, first at 0.19s in, which is heard as a metallic first syllable.
  // The extension snaps near-unity rates to exactly 1 (playbackTempo); the
  // player answers that by bypassing the unit rather than running it at 1.
  const { p, errors, dir, log, audio } = setup();
  await warm(p, dir);
  const f = writeWav(path.join(dir, "u.wav"), 0.3);
  await p.play(f, 1, 0).done;
  await p.play(f, 1.4, 0).done;
  const played = fs
    .readFileSync(log, "utf8")
    .split("\n")
    .filter((l) => l.includes("[player] play"))
    .slice(-2);
  assert.match(played[0], /stretch=off/, "rate 1 must bypass the time-pitch unit");
  assert.match(played[1], /stretch=on/, "a real rate change must still stretch");
  assert.deepEqual(errors, []);
  audio.disposePersistentPlayer();
});
