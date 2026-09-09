// The stdio protocol's failure modes, driven by a fake daemon.
//
// Both of these left the extension permanently silent: a generation
// that hung never settled its promise, so the queue waited on it for the rest
// of the session, and disposing a daemon (every engine or voice switch does)
// dropped its pending requests without settling them, which had the same
// effect on whatever was already in flight.
//
// The fake daemon is a Node script rather than Python: the protocol is the
// thing under test, and this keeps the test instant and dependency-free.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { PyTtsDaemon } = require("../../out/tts/pyDaemon.js");
const { tmpDir } = require("../helpers");

const dir = tmpDir("cv-pydaemon-");

/** A daemon that reports ready and then behaves as `body` says. */
function fakeDaemon(name, body) {
  const file = path.join(dir, `${name}.js`);
  fs.writeFileSync(
    file,
    `process.stdout.write(JSON.stringify({ ready: true }) + "\\n");
const lines = require("readline").createInterface({ input: process.stdin });
lines.on("line", (line) => { const req = JSON.parse(line); ${body} });
setInterval(() => {}, 1 << 30);\n`
  );
  return file;
}

const silent = fakeDaemon("silent", "void req;"); // accepts requests, answers nothing
const chatty = fakeDaemon(
  "chatty",
  `if (req.id) { process.stdout.write(JSON.stringify({ id: req.id, part: "p1.wav", final: false }) + "\\n"); }`
);

function start(script, opts) {
  return new PyTtsDaemon(process.execPath, script, {}, () => {}, opts);
}

test("a request that is never answered rejects instead of hanging forever", async () => {
  const d = start(silent, { requestTimeoutMs: 250 });
  await d.ready;
  const started = Date.now();
  await assert.rejects(d.synthesize({ text: "hello", out: "x.wav" }), /stalled/);
  assert.ok(Date.now() - started < 3000, "the watchdog must fire promptly");
  assert.equal(d.busy, false, "a timed-out request must leave the daemon idle, not busy forever");
  d.dispose();
});

test("streaming progress keeps a long generation alive", async () => {
  // The deadline is on silence, not on total time: a paragraph that is being
  // generated steadily part by part must not be cut off as a hang.
  const d = start(chatty, { requestTimeoutMs: 250 });
  await d.ready;
  const parts = [];
  const call = d.synthesize({ text: "long", out: "x.wav" }, (file) => parts.push(file));
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(parts, ["p1.wav"], "the fake daemon should have reported one part");
  await assert.rejects(call, /stalled/); // it then goes quiet, so it does time out
  d.dispose();
});

test("disposing a daemon settles the requests it was running", async () => {
  const d = start(silent, { requestTimeoutMs: 60_000 });
  await d.ready;
  const call = d.synthesize({ text: "hello", out: "x.wav" });
  await new Promise((r) => setTimeout(r, 50));
  d.dispose();
  await assert.rejects(call, /stopped/, "a dropped request leaves the speech queue waiting on nothing");
});
