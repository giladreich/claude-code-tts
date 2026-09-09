// What gets said, out of what a transcript line offers. This logic lived
// inside activate()'s closure and had no test at all, while being the part a
// listener notices most: an ignored tool that still speaks, or the same
// announcement repeated every few seconds.
const test = require("node:test");
const assert = require("node:assert/strict");
const { filterUtterances, newToolStreak } = require("../../out/speech/utteranceFilter.js");

const tool = (text, name = "Bash") => ({ kind: "tool", tool: name, text });
const prose = (text) => ({ kind: "text", text });
const spoken = (utterances, filters, streak, now) =>
  filterUtterances(utterances, filters, streak, now).map((u) => u.text);

const DEFAULTS = { ignoredTools: [], collapseToolSeconds: 90 };

test("an ignored tool is never announced, and its neighbours still are", () => {
  const out = spoken(
    [tool("Reading speech.ts", "Read"), prose("Here is what I found."), tool("Running the tests", "Bash")],
    { ...DEFAULTS, ignoredTools: ["Read"] },
    newToolStreak(),
    0
  );
  assert.deepEqual(out, ["Here is what I found.", "Running the tests"]);
});

test("the same activity is announced once, then again only after the reminder time", () => {
  const streak = newToolStreak();
  const at = (t, text) => spoken([tool(text)], DEFAULTS, streak, t);
  assert.deepEqual(at(0, "Running the tests"), ["Running the tests"]);
  assert.deepEqual(at(10_000, "Running the tests"), [], "ten seconds later it is the same activity");
  assert.deepEqual(at(89_000, "Running the tests"), [], "still inside the 90 second window");
  assert.deepEqual(at(90_000, "Running the tests"), ["Still running the tests"], "a long task must not go dead");
  assert.deepEqual(at(120_000, "Running the tests"), [], "and the window restarts from the reminder");
  assert.deepEqual(at(180_000, "Running the tests"), ["Still running the tests"]);
});

test("a reminder time of zero means never repeat", () => {
  const streak = newToolStreak();
  const filters = { ...DEFAULTS, collapseToolSeconds: 0 };
  assert.deepEqual(spoken([tool("Running the tests")], filters, streak, 0), ["Running the tests"]);
  assert.deepEqual(spoken([tool("Running the tests")], filters, streak, 10 ** 9), []);
});

test("prose between two identical announcements makes the second one new again", () => {
  const streak = newToolStreak();
  assert.deepEqual(spoken([tool("Editing app.ts")], DEFAULTS, streak, 0), ["Editing app.ts"]);
  assert.deepEqual(
    spoken([prose("That did not work, trying again."), tool("Editing app.ts")], DEFAULTS, streak, 1000),
    ["That did not work, trying again.", "Editing app.ts"],
    "a repeat after prose is a new step of the task"
  );
});

test("a different announcement is always spoken, however fast it follows", () => {
  const streak = newToolStreak();
  assert.deepEqual(
    spoken([tool("Reading a.ts"), tool("Reading b.ts"), tool("Reading b.ts")], DEFAULTS, streak, 0),
    ["Reading a.ts", "Reading b.ts"],
    "only the immediate repeat is dropped"
  );
});

test("errors are never collapsed: a failure repeated is a failure repeated", () => {
  const streak = newToolStreak();
  const err = { kind: "error", tool: "Bash", text: "Bash error: command not found" };
  assert.deepEqual(spoken([err, err], DEFAULTS, streak, 0), [err.text, err.text]);
});
