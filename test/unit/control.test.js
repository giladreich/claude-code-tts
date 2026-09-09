// One line in a file is a command, for when the user is in a terminal.
//
// Every other control this extension has is a VSCode command, which is no
// help when Claude Code is running in a terminal and the speech should stop
// now. This is the whole interface: a fixed list of verbs, read from a file,
// never written back, so several windows can watch the same file.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { ControlWatcher, parseControl } = require("../../out/session/control.js");
const { tmpDir, until } = require("../helpers");

test("the verbs are recognised however they are typed", () => {
  for (const [text, verb] of [
    ["mute", "mute"],
    ["  UNMUTE  \n", "unmute"],
    ["/skip", "skip"],
    ["Stop\n", "stop"],
    ["toggle", "toggle"],
    ["pause", "pause"],
    ["resume", "resume"],
    ["repeat", "repeat"],
    ["faster", "faster"],
    ["slower", "slower"],
  ]) {
    assert.deepEqual(parseControl(text), { verb }, text);
  }
});

test("a rate can be asked for by number", () => {
  assert.deepEqual(parseControl("rate 260"), { verb: "faster", rate: 260 });
  assert.deepEqual(parseControl("speed 175"), { verb: "faster", rate: 175 });
  assert.equal(parseControl("rate fast"), undefined);
  assert.equal(parseControl("rate -5"), undefined);
});

test("anything that is not a verb does nothing at all", () => {
  // The file is in the user's home directory. It runs nothing, and a line it
  // does not recognise is ignored rather than guessed at.
  for (const text of ["", "   ", "rm -rf /", "say something", "mute; reboot", "42", "muted"]) {
    assert.equal(parseControl(text), undefined, JSON.stringify(text));
  }
});

test("a command is acted on once, when it is written", async () => {
  const dir = tmpDir("cv-control-");
  const file = path.join(dir, "claude-code-tts-control");
  const seen = [];
  const w = new ControlWatcher((c) => seen.push(c.verb), file);
  w.start();
  try {
    fs.writeFileSync(file, "mute\n");
    await until(() => seen.length === 1, 3000);
    assert.deepEqual(seen, ["mute"]);
    w.read();
    w.read();
    assert.deepEqual(seen, ["mute"], "reading again is not another command");

    fs.writeFileSync(file, "skip\n");
    await until(() => seen.length === 2, 3000);
    assert.deepEqual(seen, ["mute", "skip"]);
  } finally {
    w.dispose();
  }
});

test("a command left over from last time is not obeyed at startup", async () => {
  // The file keeps its last line forever: without this, every window that
  // opened would mute itself again because "mute" was still sitting there.
  const dir = tmpDir("cv-control-");
  const file = path.join(dir, "claude-code-tts-control");
  fs.writeFileSync(file, "mute\n");
  const seen = [];
  const w = new ControlWatcher((c) => seen.push(c.verb), file);
  w.start();
  try {
    w.read();
    assert.deepEqual(seen, [], "what was already there is history");
  } finally {
    w.dispose();
  }
});

test("a missing file, and a missing home directory, are not errors", () => {
  const dir = tmpDir("cv-control-");
  const w = new ControlWatcher(() => assert.fail("nothing to report"), path.join(dir, "never-written"));
  w.start();
  w.read();
  w.dispose();
  const nowhere = new ControlWatcher(() => {}, path.join(dir, "\0", "control"));
  nowhere.start();
  nowhere.read();
  nowhere.dispose();
});
