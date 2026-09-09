// The runaway cutoff every Python generator uses (assets/speech_budget.py).
//
// The bug this guards against shipped twice: Chinese, Japanese and Korean are
// written without spaces, so counting whitespace words scores a whole passage
// as one word, the budget collapses to its floor, and the model is cut off
// after a second or two. In the voice designer that surfaced as "the model
// produced almost no speech for that description".
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawnSync } = require("child_process");
const { ROOT } = require("../helpers");

const python = process.platform === "win32" ? "python" : "python3";

/** expected_seconds() for each text, via the module the daemons import. */
function budget(texts) {
  const code = [
    "import json,sys",
    `sys.path.insert(0, ${JSON.stringify(path.join(ROOT, "assets"))})`,
    "from speech_budget import expected_seconds, speech_units",
    "texts = json.loads(sys.argv[1])",
    "print(json.dumps([[expected_seconds(t), speech_units(t)] for t in texts]))",
  ].join("\n");
  const r = spawnSync(python, ["-c", code, JSON.stringify(texts)], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const ENGLISH =
  "Here is a quick note before we begin. I build software most days, reading pull requests and shipping small fixes. When something breaks, I look for the root cause instead of guessing.";
const CHINESE =
  "开始之前先说一段简短的说明。我几乎每天都在写软件，阅读修改，并修复小的错误。出问题的时候，我会寻找根本原因，而不是猜测。";
const JAPANESE =
  "始める前に短いメモです。私はほぼ毎日ソフトウェアを書き、変更を読み、小さな不具合を直します。何かが壊れたときは、推測せずに原因を探します。";
const KOREAN =
  "시작하기 전에 짧은 메모입니다. 저는 거의 매일 소프트웨어를 작성하고 변경 사항을 읽고 작은 오류를 고칩니다. 문제가 생기면 추측하지 않고 원인을 찾습니다.";

test("a space-less script gets a budget matching how long it takes to say", () => {
  const [en, zh, ja, ko] = budget([ENGLISH, CHINESE, JAPANESE, KOREAN]);
  // Each of these passages is written to run about ten seconds aloud, so none
  // of them may be given a budget that would cut it off part-way.
  for (const [name, [seconds]] of [
    ["English", en],
    ["Chinese", zh],
    ["Japanese", ja],
    ["Korean", ko],
  ]) {
    assert.ok(seconds > 10, `${name} would be cut off after ${seconds.toFixed(1)}s`);
  }
});

test("counting by whitespace alone would collapse: that is the bug", () => {
  // The old rule, kept here as the thing being prevented.
  const words = (t) => Math.max(1, t.split(/\s+/).filter(Boolean).length);
  assert.equal(words(CHINESE), 1, "the whole Chinese passage is one whitespace word");
  assert.equal(words(JAPANESE), 1);
  const [, zh] = budget([ENGLISH, CHINESE]);
  assert.ok(zh[1] > 20, `Chinese scored ${zh[1]} units, so its characters are not being counted`);
});

test("short text still gets the overhead that dominates an announcement", () => {
  const [[seconds]] = budget(["Done."]);
  assert.ok(seconds >= 3 && seconds < 6, `a two-word line got ${seconds}s`);
});

test("mixed script counts the Latin words and the dense characters", () => {
  // A Chinese sentence quoting an identifier: both parts must count.
  const [[, units]] = budget(["我修复了 chunkForSpeech 里的错误。"]);
  assert.ok(units > 5, `mixed text scored only ${units} units`);
});
