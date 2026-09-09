const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { ROOT, tmpDir } = require("../helpers");

// The hook script decides from ~/.claude/claude-code-tts-notify.json which sound
// (if any) to play. We point HOME at a temp dir and inspect the dedupe state
// file it writes right before playing, which is exactly the "will play"
// decision; the sound itself is played at volume 0.
/** The dedupe state file is per user, so it is found by prefix. */
function stateFiles(tmp) {
  return fs.readdirSync(tmp).filter((f) => f.startsWith("claude-code-tts-notify") && f.endsWith(".last"));
}

function runHook(home, kind, payload, tmp) {
  for (const f of stateFiles(tmp)) fs.rmSync(path.join(tmp, f), { force: true });
  const r = spawnSync("node", [path.join(ROOT, "assets", "notify.js"), kind], {
    input: payload ? JSON.stringify(payload) : "",
    // HOME on POSIX, USERPROFILE on Windows: os.homedir() reads both.
    env: { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: tmp, TEMP: tmp, TMP: tmp },
    timeout: 5000,
  });
  assert.equal(r.status, 0, String(r.stderr));
  const [state] = stateFiles(tmp);
  return state ? JSON.parse(fs.readFileSync(path.join(tmp, state), "utf8")).kind : undefined;
}

test("notify.js classifies events and honours per-category config", () => {
  const home = tmpDir("cv-home-");
  const tmp = tmpDir("cv-tmp-");
  fs.mkdirSync(path.join(home, ".claude"));
  const write = (cfg) =>
    fs.writeFileSync(path.join(home, ".claude", "claude-code-tts-notify.json"), JSON.stringify(cfg));
  write({
    enabled: true,
    volume: 0,
    sounds: {
      stop: "Glass",
      permission: "Funk",
      question: "Ping",
      waiting: "Purr",
      tool: "Pop",
      subagent: "",
      prompt: "",
    },
    toolFilter: ["Bash"],
  });
  assert.equal(runHook(home, "stop", null, tmp), "stop");
  assert.equal(
    runHook(home, "notification", { message: "Claude needs your permission to run Bash" }, tmp),
    "permission"
  );
  assert.equal(runHook(home, "notification", { message: "Claude is waiting for your input" }, tmp), "waiting");
  assert.equal(runHook(home, "tool", { tool_name: "Bash" }, tmp), "tool");
  assert.equal(runHook(home, "tool", { tool_name: "Read" }, tmp), undefined); // filtered out
  assert.equal(runHook(home, "subagent", null, tmp), undefined); // category off
  write({ enabled: false, volume: 0, sounds: { stop: "Glass" } });
  assert.equal(runHook(home, "stop", null, tmp), undefined); // globally off
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("the hook removes itself when the extension it belongs to is gone", () => {
  // VSCode runs nothing on uninstall, so this script is the only thing that
  // can clean up: without it, Claude Code keeps starting a process for a
  // feature that no longer exists, forever.
  const home = tmpDir("cv-home-");
  const tmp = tmpDir("cv-tmp-");
  const extensions = tmpDir("cv-ext-");
  fs.mkdirSync(path.join(home, ".claude"));
  const settingsPath = path.join(home, ".claude", "settings.json");
  const notifyPath = path.join(home, ".claude", "claude-code-tts-notify.json");
  const script = "/somewhere/globalStorage/giladreich.claude-code-tts/claude-code-tts-notify.js";
  const settings = {
    model: "opus",
    hooks: {
      Stop: [{ matcher: "", hooks: [{ type: "command", command: `node "${script}" stop` }] }],
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: `node "${script}" tool` }] },
        { matcher: "Write", hooks: [{ type: "command", command: "somebody-elses-hook" }] },
      ],
    },
  };
  const cfg = {
    enabled: true,
    volume: 0,
    sounds: { stop: "Glass" },
    extensionsDir: extensions,
    extensionId: "giladreich.claude-code-tts",
  };
  const write = () => {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    fs.writeFileSync(notifyPath, JSON.stringify(cfg));
  };

  // While a version of the extension is installed, nothing is touched.
  fs.mkdirSync(path.join(extensions, "giladreich.claude-code-tts-1.0.0"));
  write();
  assert.equal(runHook(home, "stop", null, tmp), "stop", "an installed extension still plays sounds");
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf8")), settings, "nothing was rewritten");

  // The extension is uninstalled: the next event cleans up and stays silent.
  fs.rmSync(path.join(extensions, "giladreich.claude-code-tts-1.0.0"), { recursive: true });
  assert.equal(runHook(home, "stop", null, tmp), undefined, "no sound once the extension is gone");
  const after = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.equal(after.model, "opus", "the rest of the user's settings survive");
  assert.equal(after.hooks.Stop, undefined, "an event with only our hook is removed entirely");
  assert.deepEqual(
    after.hooks.PreToolUse.map((g) => g.matcher),
    ["Write"],
    "somebody else's hook is left exactly where it was"
  );
  assert.equal(fs.existsSync(notifyPath), false, "the config it read goes too");
});

test("an unreadable extensions directory is never taken as an uninstall", () => {
  // A machine where the path is wrong, or a portable install: guessing wrong
  // here would silently disable a working feature.
  const home = tmpDir("cv-home-");
  const tmp = tmpDir("cv-tmp-");
  fs.mkdirSync(path.join(home, ".claude"));
  fs.writeFileSync(
    path.join(home, ".claude", "settings.json"),
    JSON.stringify({
      hooks: {
        Stop: [{ matcher: "", hooks: [{ type: "command", command: 'node "x/claude-code-tts-notify.js" stop' }] }],
      },
    })
  );
  for (const cfg of [
    { enabled: true, volume: 0, sounds: { stop: "Glass" } }, // an older config, no marker at all
    {
      enabled: true,
      volume: 0,
      sounds: { stop: "Glass" },
      extensionsDir: "/no/such/dir",
      extensionId: "giladreich.claude-code-tts",
    },
  ]) {
    fs.writeFileSync(path.join(home, ".claude", "claude-code-tts-notify.json"), JSON.stringify(cfg));
    assert.equal(runHook(home, "stop", null, tmp), "stop", "it still works, and removes nothing");
    assert.match(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"), /claude-code-tts-notify/);
  }
});
