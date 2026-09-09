// Completion sounds are on by default, which means activation writes hooks
// into Claude Code's settings.
//
// This is the one thing this extension changes outside its own storage, so it
// is worth a test of its own: that it happens without being asked, that it
// says so once rather than every window, and that it never touches anything
// in that file it did not put there.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const { ROOT, tmpDir, until } = require("../helpers");

// A home of our own, before anything reads it.
const home = tmpDir("cv-hooks-home-");
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.TMPDIR = path.join(home, "tmp");
fs.mkdirSync(process.env.TMPDIR, { recursive: true });
fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });

// Nothing may actually run: the hook install is file work only.
const cp = require("child_process");
cp.spawn = () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => true;
  child.unref = () => {};
  setImmediate(() => child.emit("close", 0, null));
  return child;
};
cp.spawnSync = () => ({ status: 1, stdout: "", stderr: "", output: ["", "", ""] });

const { createVscodeStub, installVscodeStub } = require("../helpers/vscodeStub");
// notifications.enabled is deliberately absent: this is the default path.
const harness = createVscodeStub({ settings: { enabled: false, volume: 0, engine: "system" } });
installVscodeStub(harness.stub);

const ext = require(path.resolve(ROOT, "out", "extension.js"));
const context = harness.context(tmpDir("cv-hooks-storage-"));
const settingsPath = path.join(home, ".claude", "settings.json");

// Something of the user's, already there, that must survive.
fs.writeFileSync(
  settingsPath,
  JSON.stringify(
    { model: "opus", hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "their-own-hook" }] }] } },
    null,
    2
  )
);

test("activation installs the completion-sound hooks, and says so once", async () => {
  ext.activate(context);
  try {
    await run();
  } finally {
    // Always: a failed assertion that leaks the tailer and the timers turns a
    // red test into a hung test run, which is how this was found.
    for (const d of context.subscriptions) d.dispose?.();
    ext.deactivate();
  }
});

async function run() {
  await until(() => JSON.parse(fs.readFileSync(settingsPath, "utf8")).hooks.Stop.length > 1, 5000);

  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const commands = Object.values(settings.hooks)
    .flat()
    .flatMap((group) => group.hooks.map((h) => h.command));
  assert.ok(
    commands.some((c) => c.includes("claude-code-tts-notify.js")),
    "the hooks Claude Code runs are how sounds work at all"
  );
  assert.ok(commands.includes("their-own-hook"), "another tool's hook is left alone");
  assert.equal(settings.model, "opus", "the rest of the file is not ours to rewrite");

  // The script and the config it reads are in place, or the hook fires into
  // nothing.
  const storage = context.globalStorageUri.fsPath;
  assert.ok(
    fs.existsSync(path.join(storage, "claude-code-tts-notify.js")),
    "the hook script must be where the hook points"
  );
  const cfg = JSON.parse(fs.readFileSync(path.join(home, ".claude", "claude-code-tts-notify.json"), "utf8"));
  assert.equal(cfg.enabled, true);
  assert.ok(cfg.extensionsDir && cfg.extensionId, "without these the hook cannot tell it has been uninstalled");

  await until(() => harness.shown.some((s) => /sound when Claude finishes/.test(s.message ?? "")), 5000);
  const notices = harness.shown.filter((s) => /sound when Claude finishes/.test(s.message ?? ""));
  assert.equal(notices.length, 1, "editing a file outside the editor is announced, once");
  assert.deepEqual(notices[0].items, ["Sounds off", "Choose sounds"], "the notice offers the way out");
  assert.equal(harness.globalState.get("claudeCodeTts.hooksAnnounced"), true, "so the next window stays quiet");
}
