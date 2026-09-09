const test = require("node:test");
const assert = require("node:assert/strict");
const {
  applyHookInstall,
  applyHookRemove,
  applyHookNormalize,
  hookEvents,
  toolMatcher,
} = require("../../out/setup/hooks.js");

const SCRIPT = "/home/u/.vscode/storage/claude-code-tts-notify.js";
/** The shipped defaults: four events sound, tool runs and the rest are silent. */
const PLAN = {
  sounds: { stop: "Glass", permission: "Funk", question: "Ping", waiting: "Purr" },
  toolFilter: ["Bash"],
};

test("install is idempotent and leaves foreign hooks alone", () => {
  const settings = { hooks: { Stop: [{ hooks: [{ type: "command", command: "echo other" }] }] }, other: 1 };
  const once = applyHookInstall(JSON.parse(JSON.stringify(settings)), SCRIPT, PLAN);
  const twice = applyHookInstall(JSON.parse(JSON.stringify(once)), SCRIPT, PLAN);
  assert.deepEqual(once, twice);
  assert.equal(once.hooks.Stop.length, 2);
  assert.ok(once.hooks.PreToolUse.some((e) => e.matcher === "AskUserQuestion"));
  assert.equal(once.other, 1);
  assert.equal(Object.keys(once.hooks).length, new Set(hookEvents(PLAN).map((h) => h.event)).size);
});

test("remove strips only our entries; normalize migrates old layouts", () => {
  const installed = applyHookInstall(
    { hooks: { Stop: [{ hooks: [{ type: "command", command: "echo other" }] }] } },
    SCRIPT,
    PLAN
  );
  const removed = applyHookRemove(installed, SCRIPT);
  assert.deepEqual(removed, { hooks: { Stop: [{ hooks: [{ type: "command", command: "echo other" }] }] } });
  assert.deepEqual(applyHookRemove({}, SCRIPT), {});
  const old = { hooks: { Notification: [{ hooks: [{ type: "command", command: `node "${SCRIPT}" attention` }] }] } };
  const norm = applyHookNormalize(old, SCRIPT, PLAN);
  assert.ok(!JSON.stringify(norm).includes(" attention"));
  assert.ok(norm.hooks.Notification.some((e) => e.hooks[0].command === `node "${SCRIPT}" notification`));
});

test("an event with no sound installs no hook, so nothing is started for it", () => {
  // Every hook used to be installed and the decision left to the script at
  // event time. An unmatched PreToolUse entry means Claude Code starts a node
  // process for every tool call in every session on the machine, which then
  // reads stdin, parses the payload and exits without a sound.
  const events = (plan) => hookEvents(plan).map((h) => `${h.event}${h.matcher ? `:${h.matcher}` : ""}`);
  assert.deepEqual(events({ sounds: {}, toolFilter: ["Bash"] }), [], "nothing configured, nothing installed");
  assert.deepEqual(events(PLAN), ["Stop", "Notification", "PermissionRequest", "PreToolUse:AskUserQuestion"]);
  assert.ok(!events(PLAN).some((e) => e === "PreToolUse"), "an unmatched PreToolUse hook fires on every tool call");
  assert.deepEqual(events({ sounds: { subagent: "Pop" }, toolFilter: [] }), ["SubagentStop"]);
  assert.deepEqual(events({ sounds: { prompt: "Tink" }, toolFilter: [] }), ["UserPromptSubmit"]);
});

test("the tools that should sound are named in the matcher, not tested afterwards", () => {
  const plan = { sounds: { tool: "Pop" }, toolFilter: ["Bash", "Edit"] };
  const [hook] = hookEvents(plan).filter((h) => h.kind === "tool");
  assert.equal(hook.event, "PreToolUse");
  assert.equal(hook.matcher, "^(Bash|Edit)$");
  // Anchored and escaped: a matcher must not catch a tool nobody asked for.
  const re = new RegExp(hook.matcher);
  assert.ok(re.test("Bash") && re.test("Edit"));
  assert.ok(!re.test("BashOutput"), "a prefix match would start a process for another tool");
  assert.equal(toolMatcher(["a.b", "c+d"]), "^(a\\.b|c\\+d)$");
  // With the sound off, the hook is absent however many tools are listed.
  assert.deepEqual(hookEvents({ sounds: {}, toolFilter: ["Bash", "Edit"] }), []);
});

// What runs the hook script. This is the whole of a bug that silenced the
// sounds with nothing in any log: the command said "node", and the PATH a
// hook inherits had no node on it (a keg-only Homebrew formula, nvm, or an
// editor started from the Dock), so Claude Code ran "command not found"
// several times a minute and the user simply stopped hearing anything.
const { resolveNodeCommand } = require("../../out/platform/platform.js");

test("the hook names an interpreter that exists rather than hoping for one on the PATH", () => {
  const plan = { sounds: { stop: "Glass" }, toolFilter: [] };
  const withNode = resolveNodeCommand({
    path: "/nowhere:/opt/homebrew/opt/node@22/bin",
    electron: "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
    platform: "darwin",
    exists: (c) => c === "/opt/homebrew/opt/node@22/bin/node",
  });
  assert.equal(withNode, "/opt/homebrew/opt/node@22/bin/node");
  const command = applyHookInstall({}, "/storage/claude-code-tts-notify.js", plan, withNode).hooks.Stop[0].hooks[0]
    .command;
  assert.equal(command, '/opt/homebrew/opt/node@22/bin/node "/storage/claude-code-tts-notify.js" stop');

  // A Windows PATH is answered the Windows way, whatever machine asks: the
  // delimiter and the separator come from the platform in the question, not
  // from the one running the test, which is how the Windows CI came to be
  // told that a macOS PATH contained no node at all.
  const onWindows = resolveNodeCommand({
    path: "C:\\nowhere;C:\\Program Files\\nodejs",
    electron: "C:\\Code\\Code.exe",
    platform: "win32",
    exists: (c) => c === "C:\\Program Files\\nodejs\\node.exe",
  });
  assert.equal(
    onWindows,
    '"C:\\Program Files\\nodejs\\node.exe"',
    "quoted for the spaces, and not escaped: cmd.exe has no backslash escape"
  );
  assert.equal(
    resolveNodeCommand({ path: "C:\\nowhere", electron: "C:\\Code\\Code.exe", platform: "win32", exists: () => false }),
    "node",
    "and its fallback is the bare name, since a shell there cannot carry the variable"
  );

  // Nothing on the PATH: the editor's own runtime is always there and can run
  // a script as node, and its path has spaces, so it has to be quoted.
  const fallback = resolveNodeCommand({
    path: "/nowhere",
    electron: "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
    platform: "darwin",
    exists: () => false,
  });
  assert.equal(fallback, 'ELECTRON_RUN_AS_NODE=1 "/Applications/Visual Studio Code.app/Contents/MacOS/Electron"');

  // The usual places are searched even when they are not on the PATH, which
  // is the case in a hook's environment more often than not.
  assert.equal(
    resolveNodeCommand({ path: "", electron: "/e", platform: "darwin", exists: (c) => c === "/usr/local/bin/node" }),
    "/usr/local/bin/node"
  );
  // A shell there cannot carry the variable in front of the command.
  assert.equal(
    resolveNodeCommand({ path: "", electron: "C:\\Code\\Code.exe", platform: "win32", exists: () => false }),
    "node"
  );
});
