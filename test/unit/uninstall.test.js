const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { tmpDir } = require("../helpers");
const { cleanClaudeDirectory } = require("../../out/setup/uninstallHook.js");

test("uninstalling removes exactly what the extension put under ~/.claude", () => {
  // VSCode deletes the extension's storage after an uninstall and nothing
  // else: the hook entries in ~/.claude/settings.json kept pointing at a
  // script that was gone, so every Claude Code event reported a failing
  // hook, and the sound choices and window registry stayed behind.
  const home = tmpDir("cv-home-");
  const claude = path.join(home, ".claude");
  fs.mkdirSync(path.join(claude, "claude-code-tts-windows"), { recursive: true });
  fs.writeFileSync(path.join(claude, "claude-code-tts-windows", "w1.json"), "{}");
  fs.writeFileSync(path.join(claude, "claude-code-tts-notify.json"), "{}");
  fs.writeFileSync(path.join(claude, "claude-code-tts-control"), "mute\n"); // the user's own file
  const ours = {
    type: "command",
    command: "/opt/node /x/globalStorage/giladreich.claude-code-tts/claude-code-tts-notify.js stop",
  };
  const theirs = { type: "command", command: "say done" };
  fs.writeFileSync(
    path.join(claude, "settings.json"),
    JSON.stringify(
      {
        model: "opus",
        hooks: {
          Stop: [{ hooks: [ours] }, { hooks: [theirs] }],
          PreToolUse: [{ matcher: "AskUserQuestion", hooks: [ours] }],
        },
      },
      null,
      2
    )
  );

  const removed = cleanClaudeDirectory(home);
  assert.equal(removed.length, 3, removed.join("; "));
  const settings = JSON.parse(fs.readFileSync(path.join(claude, "settings.json"), "utf8"));
  assert.equal(settings.model, "opus", "other settings untouched");
  assert.deepEqual(
    settings.hooks,
    { Stop: [{ hooks: [theirs] }] },
    "only our entries go, an emptied event goes with them"
  );
  assert.ok(!fs.existsSync(path.join(claude, "claude-code-tts-notify.json")));
  assert.ok(!fs.existsSync(path.join(claude, "claude-code-tts-windows")));
  assert.ok(fs.existsSync(path.join(claude, "claude-code-tts-control")), "a file the user made stays");

  // Nothing of ours left: nothing rewritten (a second run is a no-op).
  const before = fs.statSync(path.join(claude, "settings.json")).mtimeMs;
  assert.deepEqual(cleanClaudeDirectory(home), []);
  assert.equal(fs.statSync(path.join(claude, "settings.json")).mtimeMs, before);

  // A home without ~/.claude at all is fine too.
  assert.deepEqual(cleanClaudeDirectory(tmpDir("cv-empty-")), []);
});

test("the uninstall hook is declared, ships, and imports nothing from vscode", () => {
  const root = path.join(__dirname, "..", "..");
  const pkg = require(path.join(root, "package.json"));
  assert.equal(pkg.scripts["vscode:uninstall"], "node ./out/setup/uninstallHook.js");
  const source = fs.readFileSync(path.join(root, "src", "setup", "uninstallHook.ts"), "utf8");
  assert.doesNotMatch(source, /from "vscode"/, "VSCode runs it outside the extension host");
  const hooks = fs.readFileSync(path.join(root, "src", "setup", "hooks.ts"), "utf8");
  assert.doesNotMatch(hooks, /from "vscode"/, "and so must what it imports");
  const ignore = fs.readFileSync(path.join(root, ".vscodeignore"), "utf8");
  assert.doesNotMatch(ignore, /^out\b/m, "out/ ships in the .vsix");
});

test("a settings file with a byte order mark is read, and its hooks are removed like any other", () => {
  // An editor on Windows can leave a byte order mark in front of the JSON;
  // JSON.parse refuses it, and the uninstall used to leave the hooks behind.
  const os = require("os");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cv-bom-"));
  const claude = path.join(home, ".claude");
  fs.mkdirSync(claude, { recursive: true });
  const ours = { type: "command", command: "node /x/claude-code-tts-notify.js stop" };
  fs.writeFileSync(
    path.join(claude, "settings.json"),
    "﻿" + JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [ours] }] } }, null, 2)
  );
  const removed = cleanClaudeDirectory(home);
  assert.equal(removed.length, 1, removed.join("; "));
  const settings = JSON.parse(fs.readFileSync(path.join(claude, "settings.json"), "utf8"));
  assert.equal(settings.model, "opus");
  assert.equal(settings.hooks, undefined);
  fs.rmSync(home, { recursive: true, force: true });
});
