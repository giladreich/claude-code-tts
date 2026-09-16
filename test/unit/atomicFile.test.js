// Files that someone else reads while this extension rewrites them (the
// user's Claude Code settings, the window registry, the export index) must
// never be seen half-written or empty, and on Windows a rename over a file
// another process has open is refused for a moment rather than done.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const {
  writeFileAtomicSync,
  replaceFile,
  replaceFileSync,
  sweepStaleTemps,
  tempPathFor,
} = require("../../out/platform/atomicFile.js");
const { tmpDir } = require("../helpers");

/** Runs fn with the first `times` renames refused with `code`, as Windows does while a handle is open. */
function withRenameRefused(times, code, fn) {
  const real = fs.renameSync;
  let calls = 0;
  fs.renameSync = (from, to) => {
    if (calls++ < times) {
      const e = new Error(code);
      e.code = code;
      throw e;
    }
    return real(from, to);
  };
  try {
    fn();
  } finally {
    fs.renameSync = real;
  }
  return calls;
}

test("a write replaces the file whole, creates its directory, and leaves no temporary file behind", () => {
  const dir = path.join(tmpDir("cv-atomic-"), "deep", "er");
  const file = path.join(dir, "settings.json");
  writeFileAtomicSync(file, '{"a":1}');
  assert.equal(fs.readFileSync(file, "utf8"), '{"a":1}');
  writeFileAtomicSync(file, '{"a":2}');
  assert.equal(fs.readFileSync(file, "utf8"), '{"a":2}');
  assert.deepEqual(fs.readdirSync(dir), ["settings.json"]);
});

test("a rename refused while the target is open is retried, and the contents arrive", () => {
  const file = path.join(tmpDir("cv-atomic-"), "f.json");
  fs.writeFileSync(file, "old");
  const calls = withRenameRefused(2, "EPERM", () => writeFileAtomicSync(file, "new"));
  assert.equal(calls, 3, "two refusals, then the rename");
  assert.equal(fs.readFileSync(file, "utf8"), "new");
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["f.json"]);
});

test("a target that stays locked is left as it was and the error says so, unless a copy was asked for", () => {
  // A copy is the truncation this exists to avoid: measured under two
  // processes reading without pause, a reader saw the file empty. So it is
  // only for files whose readers tolerate a half-written moment.
  const file = path.join(tmpDir("cv-atomic-"), "f.json");
  fs.writeFileSync(file, "old");
  assert.throws(() => withRenameRefused(99, "EBUSY", () => writeFileAtomicSync(file, "new")), { code: "EBUSY" });
  assert.equal(fs.readFileSync(file, "utf8"), "old", "the user's settings stay whole");
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["f.json"], "the temporary file is gone");
  withRenameRefused(99, "EBUSY", () => writeFileAtomicSync(file, "new", { copyWhenLocked: true }));
  assert.equal(fs.readFileSync(file, "utf8"), "new", "a heartbeat is worth a copy");
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["f.json"]);
});

test("a failure leaves the target as it was and takes the temporary file with it", () => {
  const file = path.join(tmpDir("cv-atomic-"), "f.json");
  fs.writeFileSync(file, "old");
  const source = path.join(path.dirname(file), "gone.tmp");
  assert.throws(() => replaceFileSync(source, file), { code: "ENOENT" });
  assert.equal(fs.readFileSync(file, "utf8"), "old");
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["f.json"]);
});

test("the asynchronous replace retries the same refusals", async () => {
  const file = path.join(tmpDir("cv-atomic-"), "out.wav");
  const tmp = tempPathFor(file);
  fs.writeFileSync(tmp, "audio");
  const real = fs.promises.rename;
  let calls = 0;
  fs.promises.rename = async (from, to) => {
    if (calls++ < 1) {
      const e = new Error("EACCES");
      e.code = "EACCES";
      throw e;
    }
    return real(from, to);
  };
  try {
    await replaceFile(tmp, file);
  } finally {
    fs.promises.rename = real;
  }
  assert.equal(calls, 2);
  assert.equal(fs.readFileSync(file, "utf8"), "audio");
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["out.wav"]);
});

test("a temporary file left by a process that died mid-write is swept once it is old; a live one is kept", () => {
  const dir = tmpDir("cv-atomic-");
  const file = path.join(dir, "settings.json");
  const stale = `${file}.123.abc.tmp`;
  const live = `${file}.456.def.tmp`;
  fs.writeFileSync(stale, "{");
  fs.writeFileSync(live, "{");
  fs.writeFileSync(path.join(dir, "settings.json.claude-code-tts-backup"), "{}");
  const ago = new Date(Date.now() - 5 * 60_000);
  fs.utimesSync(stale, ago, ago);
  sweepStaleTemps(file);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["settings.json.456.def.tmp", "settings.json.claude-code-tts-backup"]);
  writeFileAtomicSync(file, "{}");
  assert.equal(fs.existsSync(live), true, "another process's write in progress is not ours to remove");
});
