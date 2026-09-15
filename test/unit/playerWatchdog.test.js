// The persistent player's stall deadline (src/tts/audio.ts). A false kill
// costs the sentence being spoken and reports a stall that never happened,
// so the budget is checked here rather than by waiting for it.
const test = require("node:test");
const assert = require("node:assert/strict");
const { watchdogBudgetMs } = require("../../out/tts/audio.js");

test("the deadline covers the audio at the slowest tempo, with a grace", () => {
  // 0.5x is the slowest the rate can be changed to mid-playback.
  assert.equal(watchdogBudgetMs(1), 10_000);
  assert.equal(watchdogBudgetMs(10), 28_000);
  assert.ok(watchdogBudgetMs(60) > (60 / 0.5) * 1000, "always more than the audio itself");
});

test("a file whose length is unknown outlasts anything a person would play", () => {
  // A system sound or an MP3 of your own, previewed in the sound picker:
  // wavFileSeconds cannot measure it, and a grace over a length of zero
  // killed a twelve-second sound at eight.
  assert.ok(watchdogBudgetMs(0) >= 60_000, `unknown length got ${watchdogBudgetMs(0)}ms`);
});
