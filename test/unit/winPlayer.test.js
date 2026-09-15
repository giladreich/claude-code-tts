// The Windows persistent player (assets/wav_host.ps1), driven through the
// same code as the macOS player: one PowerShell for the session instead of
// one per file, with pause, cancel and streamed parts. Windows only; volume
// 0 throughout.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const audio = require("../../out/tts/audio.js");
const { ROOT, tmpDir, writeWav } = require("../helpers");

const onWindows = process.platform === "win32";
const SWIFT = path.join(ROOT, "assets", "wavplayer.swift"); // the host script is found next to it

test(
  "the Windows host plays whole files, streams parts, cancels and pauses",
  { skip: !onWindows && "Windows only" },
  async () => {
    const storage = tmpDir("cv-winplayer-");
    audio.initPersistentPlayer(storage, SWIFT, (m) => {
      throw new Error(m);
    });
    const player = audio.getPersistentPlayer();
    assert.ok(player, "a persistent player exists on Windows without ffplay");
    assert.equal(player.supportsTempo, false, "it does not stretch time, and says so");
    const dir = tmpDir("cv-winplayer-wavs-");
    const parts = [0.5, 0.4, 0.6].map((secs, i) => writeWav(path.join(dir, `p${i}.wav`), secs));
    try {
      // A whole file: done in about its length once the host is warm.
      await player.play(parts[0], 1, 0).done;
      const t = Date.now();
      await player.play(parts[0], 1, 0).done;
      const whole = Date.now() - t;
      assert.ok(whole < 1500, `0.5 s of audio took ${whole} ms`);
      // Three parts as one utterance, the last arriving late.
      const t2 = Date.now();
      const pb = player.play(parts[0], 1, 0, false);
      pb.append(parts[1], false);
      setTimeout(() => pb.append(parts[2], true), 300);
      await pb.done;
      const streamed = Date.now() - t2;
      assert.ok(streamed >= 1400 && streamed < 3000, `1.5 s of parts took ${streamed} ms`);
      // A cancel settles at once.
      const cut = player.play(parts[2], 1, 0);
      await new Promise((r) => setTimeout(r, 150));
      const t3 = Date.now();
      cut.cancel();
      await cut.done;
      assert.ok(Date.now() - t3 < 300, "cancel does not wait for the file to end");
      // A pause holds the sound.
      const paused = player.play(parts[2], 1, 0);
      const t4 = Date.now();
      setTimeout(() => paused.freeze(), 100);
      setTimeout(() => paused.unfreeze(), 700);
      await paused.done;
      assert.ok(Date.now() - t4 > 1100, "the pause added its length");
      // A file that is not audio is reported, not waited for forever.
      const bad = path.join(dir, "bad.wav");
      fs.writeFileSync(bad, "not audio");
      await assert.rejects(player.play(bad, 1, 0).done, /cannot open/);
    } finally {
      audio.disposePersistentPlayer();
    }
    assert.equal(fs.existsSync(path.join(storage, "player.log")), true);
  }
);
