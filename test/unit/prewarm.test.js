// What a skipped or superseded utterance leaves in the temp directory.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const { synthesizeThenPlayBackend } = require("../../out/tts/synthPlay.js");
const { writeWav, sleep } = require("../helpers");

test("a prepared utterance that is evicted or flushed leaves no file, whether its synthesis finished or was cut short", async () => {
  // Cleanup used to be attached to the synthesis resolving; a cancelled
  // synthesis rejects, so every eviction of work in progress left a WAV.
  const written = [];
  const backend = synthesizeThenPlayBackend({
    name: "fake",
    naturalWpm: 175,
    lookahead: 2, // room for three
    synthesize(text, wpm, voice, wavPath) {
      written.push(wavPath);
      let cancelled = false;
      const slow = text.startsWith("slow");
      const promise = new Promise((resolve, reject) =>
        setTimeout(
          () => {
            // A daemon that had already written the file when the cancel landed.
            writeWav(wavPath, 0.1);
            if (cancelled) {
              return reject(new Error("cancelled"));
            }
            resolve();
          },
          slow ? 200 : 0
        )
      );
      promise.catch(() => {});
      return {
        promise,
        cancel() {
          cancelled = true;
        },
      };
    },
  });
  const req = (text) => ({ text, wpm: 175, voice: "v", volume: 0 });
  backend.prewarm(req("slow one"));
  backend.prewarm(req("two"));
  backend.prewarm(req("three"));
  await sleep(50); // two and three are on disk; slow one is still being made
  backend.prewarm(req("four")); // evicts "slow one" while its synthesis runs
  backend.flush(); // and drops the rest
  await sleep(400);
  assert.equal(written.length, 4);
  assert.deepEqual(
    written.filter((f) => fs.existsSync(f)),
    [],
    "nothing is left in the temp directory"
  );
  backend.dispose();
});
