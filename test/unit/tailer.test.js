const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { TranscriptTailer, encodeProjectDir } = require("../../out/session/tailer.js");
const { tmpDir, until, sleep } = require("../helpers");

test("encodeProjectDir matches Claude Code's folder naming", () => {
  assert.equal(encodeProjectDir("/Users/me/dev/proj"), "-Users-me-dev-proj");
});

test("tails appended lines, skips history, respects scope, handles partial writes and truncation", async () => {
  const root = tmpDir("cv-tail-");
  const inScope = path.join(root, "-in-scope");
  const outScope = path.join(root, "-out-of-scope");
  fs.mkdirSync(inScope);
  fs.mkdirSync(outScope);
  const f = path.join(inScope, "s.jsonl");
  fs.writeFileSync(f, '{"old":1}\n'); // history: must not be replayed
  const lines = [];
  const t = new TranscriptTailer(
    (l, file) => lines.push([l, path.basename(file)]),
    (e) => {
      throw new Error(e);
    },
    (d) => d === "-in-scope",
    root
  );
  t.start();
  try {
    await sleep(50);
    fs.appendFileSync(f, '{"a":1}\n{"b":');
    await until(() => lines.length === 1, 3000);
    assert.deepEqual(lines[0], ['{"a":1}', "s.jsonl"]);
    fs.appendFileSync(f, "2}\n");
    await until(() => lines.length === 2, 3000);
    assert.equal(lines[1][0], '{"b":2}');
    // New file in a new project dir that is in scope.
    const f2 = path.join(inScope, "new.jsonl");
    fs.writeFileSync(f2, '{"c":3}\n');
    await until(() => lines.length === 3, 3000);
    assert.equal(lines[2][0], '{"c":3}');
    // Out-of-scope dir: never delivered.
    fs.writeFileSync(path.join(outScope, "x.jsonl"), '{"d":4}\n');
    await sleep(400);
    assert.equal(lines.length, 3);
    // Truncation: only what is written after the rewrite counts.
    fs.writeFileSync(f, "");
    await sleep(300);
    fs.appendFileSync(f, '{"e":5}\n');
    await until(() => lines.length === 4, 3000);
    assert.equal(lines[3][0], '{"e":5}');
  } finally {
    t.dispose(); // an open watcher would keep the test process alive
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("missing root reports an error instead of throwing", () => {
  const errors = [];
  const t = new TranscriptTailer(
    () => {},
    (e) => errors.push(e),
    () => true,
    "/nonexistent/claude-code-tts-root"
  );
  t.start();
  assert.equal(errors.length, 1);
  t.dispose();
});

test("subagent transcripts are seeded, scoped by their project and not replayed", async () => {
  // Subagent transcripts live several folders down inside a project. A
  // one-level scan never saw them, so the first line one wrote arrived for a
  // file with no offset: the whole file was read and spoken from the start,
  // and the scope check compared the wrong folder name and rejected it.
  const root = tmpDir("cv-tail-nested-");
  const project = path.join(root, "-in-scope");
  const nested = path.join(project, "subagents", "workflows", "wf_1");
  fs.mkdirSync(nested, { recursive: true });
  const existing = path.join(nested, "agent-1.jsonl");
  fs.writeFileSync(existing, '{"old":1}\n'); // history: must not be replayed
  const outNested = path.join(root, "-out-of-scope", "subagents");
  fs.mkdirSync(outNested, { recursive: true });

  const lines = [];
  const t = new TranscriptTailer(
    (l) => lines.push(l),
    (e) => {
      throw new Error(e);
    },
    (d) => d === "-in-scope",
    root
  );
  t.start();
  try {
    await sleep(50);
    fs.appendFileSync(existing, '{"new":1}\n');
    await until(() => lines.length === 1, 3000);
    assert.deepEqual(lines, ['{"new":1}'], "the pre-existing line was replayed");

    // A subagent that starts now is read from its first line.
    fs.writeFileSync(path.join(nested, "agent-2.jsonl"), '{"fresh":1}\n');
    await until(() => lines.length === 2, 3000);
    assert.equal(lines[1], '{"fresh":1}');

    // The same thing under another project stays silent.
    fs.writeFileSync(path.join(outNested, "agent-3.jsonl"), '{"other":1}\n');
    await sleep(400);
    assert.equal(lines.length, 2, "an out-of-scope subagent was spoken");
  } finally {
    t.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a large file seen for the first time is not read from the beginning", async () => {
  // A session that was running before this window opened must not be spoken
  // from its start: that is minutes of audio nobody asked for.
  const root = tmpDir("cv-tail-big-");
  const project = path.join(root, "-in-scope");
  fs.mkdirSync(project, { recursive: true });
  const lines = [];
  const t = new TranscriptTailer(
    (l) => lines.push(l),
    (e) => {
      throw new Error(e);
    },
    () => true,
    root
  );
  t.start();
  try {
    await sleep(50);
    const big = path.join(project, "long.jsonl");
    fs.writeFileSync(big, `{"pad":"${"x".repeat(300)}"}\n`.repeat(1200));
    assert.ok(fs.statSync(big).size > 256 * 1024, "fixture must exceed the new-file limit");
    await sleep(500);
    assert.deepEqual(lines, [], "history was replayed");
    fs.appendFileSync(big, '{"live":1}\n');
    await until(() => lines.length === 1, 3000);
    assert.equal(lines[0], '{"live":1}', "the line written after we noticed the file must still be spoken");
  } finally {
    t.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("widening the scope does not replay what was out of scope before", async () => {
  // The scope setting can change from "this workspace" to "every session".
  // A file that was skipped without recording its position would then be
  // spoken from its beginning: minutes of audio from a past session.
  const root = tmpDir("cv-tail-scope-");
  const other = path.join(root, "-other-project");
  fs.mkdirSync(other, { recursive: true });
  const f = path.join(other, "s.jsonl");
  fs.writeFileSync(f, '{"old":1}\n');
  const lines = [];
  let everything = false;
  const t = new TranscriptTailer(
    (l) => lines.push(l),
    (e) => {
      throw new Error(e);
    },
    () => everything,
    root
  );
  t.start();
  try {
    await sleep(50);
    fs.appendFileSync(f, '{"while-out-of-scope":1}\n');
    await sleep(400);
    assert.deepEqual(lines, [], "nothing is spoken while out of scope");
    everything = true; // the user switches to "every session on this machine"
    fs.appendFileSync(f, '{"after":1}\n');
    await until(() => lines.length > 0, 3000);
    assert.deepEqual(lines, ['{"after":1}'], "only what was written after the switch");
  } finally {
    t.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a scope that widens while the position is being moved does not swallow the next line", async () => {
  // Out of scope, the position is moved to the end of the file by an async
  // stat. On a loaded machine that callback lands late: by then the user may
  // have switched to "every session" and the session written its next line,
  // and moving the position now steps over it, so it is never spoken. The CI
  // saw this as the test above timing out; here the interleaving is forced
  // rather than waited for.
  const root = tmpDir("cv-tail-widen-");
  const other = path.join(root, "-other-project");
  fs.mkdirSync(other, { recursive: true });
  const f = path.join(other, "s.jsonl");
  fs.writeFileSync(f, '{"old":1}\n');
  const lines = [];
  let wide = false;
  let armed = true;
  const t = new TranscriptTailer(
    (l) => lines.push(l),
    (e) => {
      throw new Error(e);
    },
    () => {
      // This call is the tailer deciding the file is out of scope. Everything
      // that happens next models the microsecond after that decision: the
      // user widens the scope and the session writes a line, both before the
      // stat behind the decision has come back.
      if (armed) {
        armed = false;
        wide = true;
        fs.appendFileSync(f, '{"after":1}\n');
        return false;
      }
      return wide;
    },
    root
  );
  t.start();
  try {
    await until(() => lines.length > 0, 3000);
    assert.deepEqual(lines, ['{"after":1}'], "the line written as the scope widened is still spoken");
  } finally {
    t.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
