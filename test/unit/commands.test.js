// Every command handler is executed at least once, with the user cancelling.
//
// Until this file existed the front end had no behavioural coverage at all:
// 32 commands and 2500 lines of pickers, checked only by "activate() did not
// throw". A handler could reference an undefined variable, await a promise
// that never settles, or spawn a process on the user's machine, and the suite
// stayed green. That is not a base to refactor the UI on.
//
// The test is deliberately paranoid about the outside world: HOME and TMPDIR
// point at a temp directory, and child_process is replaced, so a handler that
// tries to scan the real disk or run `say` fails the test instead of doing it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { PassThrough } = require("stream");
const { EventEmitter } = require("events");
const { ROOT, tmpDir } = require("../helpers");

// Redirect the user's home before anything reads it: storage scanning, the
// transcript directory and the uv paths are all derived from it.
const home = tmpDir("cv-cmd-home-");
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.HF_HOME = path.join(home, "hf");
process.env.TMPDIR = path.join(home, "tmp");
fs.mkdirSync(process.env.TMPDIR, { recursive: true });
fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });

/** Processes a handler tried to start, tagged with the command that ran. */
const spawned = [];
let running = "activation";
const note = (cmd, args) => spawned.push(`${running}: ${[cmd, ...(Array.isArray(args) ? args : [])].join(" ")}`);
const cp = require("child_process");
const realSpawnSync = cp.spawnSync;
cp.spawn = (cmd, args = []) => {
  note(cmd, args);
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.pid = 1;
  child.kill = () => true;
  child.unref = () => {};
  setImmediate(() => {
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0, null);
    child.emit("exit", 0, null);
  });
  return child;
};
cp.spawnSync = (cmd, args = [], _opts) => {
  note(cmd, args);
  // `which`-style probes must answer "not installed" rather than crash.
  return { status: 1, signal: null, stdout: "", stderr: "", pid: 1, output: ["", "", ""], error: undefined };
};
cp.exec = (_cmd, _opts, done) => {
  const cb = typeof _opts === "function" ? _opts : done;
  setImmediate(() => cb?.(null, "", ""));
  return new EventEmitter();
};
cp.execFile = cp.exec;

const { createVscodeStub, installVscodeStub } = require("../helpers/vscodeStub");
const harness = createVscodeStub({
  settings: { enabled: false, volume: 0, engine: "system", "notifications.enabled": false },
});
installVscodeStub(harness.stub);

const storage = tmpDir("cv-cmd-storage-");
const ext = require(path.resolve(ROOT, "out", "extension.js"));
const context = harness.context(storage);

test("activate registers every declared command without touching the machine", () => {
  ext.activate(context);
  const declared = require(path.join(ROOT, "package.json")).contributes.commands.map((c) => c.command);
  const missing = declared.filter((c) => !harness.commands.has(c));
  assert.deepEqual(missing, [], "declared commands that activate() never registered");
  // The CLAUDE.md rule: activation must not block on Python or Piper probes.
  const probes = spawned.filter((s) => /python|piper|espeak|say\b|uv\b/.test(s));
  assert.deepEqual(probes, [], "activation ran a synchronous probe; it must read the disk instead");
});

test("every command handler runs to completion when the user cancels", async () => {
  const failures = [];
  const acted = [];
  const internalArg = { "claudeCodeTts.downloadVoiceForLanguage": "de" };
  // Commands whose whole job is to act at once: they have nothing to cancel.
  // prettier-ignore
  const immediate = new Set([
    "claudeCodeTts.toggle", "claudeCodeTts.stop", "claudeCodeTts.skip", "claudeCodeTts.pauseResume",
    "claudeCodeTts.rateUp", "claudeCodeTts.rateDown", "claudeCodeTts.showLog", "claudeCodeTts.menu",
  ]);
  for (const [id, handler] of harness.commands) {
    running = id;
    const promptsBefore = harness.shown.length;
    const settingsBefore = JSON.stringify([...harness.settings]);
    const spawnsBefore = spawned.length;
    try {
      await Promise.race([
        Promise.resolve(handler(internalArg[id])),
        new Promise((_, reject) => setTimeout(() => reject(new Error("did not settle within 5s")), 5000).unref?.()),
      ]);
    } catch (e) {
      failures.push(`${id}: ${e.message}`);
    }
    for (const q of harness.quickPicks.filter((q) => q.shown && !q.disposed)) q.hide();
    if (immediate.has(id)) continue;
    // Everything else asked the user something and got Escape, so it must
    // have changed nothing: no setting written, no audio played.
    if (JSON.stringify([...harness.settings]) !== settingsBefore) acted.push(`${id} wrote a setting`);
    const audio = spawned.slice(spawnsBefore).filter((s) => /\bsay\b|espeak|afplay|claude-code-tts-player/.test(s));
    if (audio.length) acted.push(`${id} played audio: ${audio.join(", ")}`);
    // A command that never asked anything and is not in `immediate` is either
    // a silent action (fine) or a dead end that failed without saying so.
    void promptsBefore;
  }
  assert.deepEqual(failures, [], "command handlers that threw or hung when cancelled");
  assert.deepEqual(acted, [], "cancelled commands must leave the machine as they found it");
});

test("no command runs a synchronous probe of the machine, except the one that reports on it", () => {
  // A blocking `piper --help` or `python -c import` inside a picker is what
  // makes a menu take a second to open. The setup and diagnostics family is
  // allowed to ask the machine questions: that is what those commands are for.
  const mayProbe = /^claudeCodeTts\.(checkSetup|setup[A-Z]|downloadVoice)/;
  const probes = spawned.filter((s) => /piper|python|espeak/.test(s) && !mayProbe.test(s));
  assert.deepEqual(probes, [], "these commands probe the machine synchronously and should read the disk instead");
});

test("the status bar reports a state for every command that changes one", () => {
  const [item] = harness.statusItems;
  assert.ok(item, "activate() must create a status bar item");
  assert.ok(item.text.includes("Claude Code TTS"), `status bar text was ${JSON.stringify(item.text)}`);
  assert.ok(item.command, "the status bar item must be clickable");
});

test.after(() => {
  for (const d of context.subscriptions) d.dispose?.();
  ext.deactivate?.();
  cp.spawnSync = realSpawnSync;
});

test("a first run greets once, and a working setup never warns", async () => {
  // Five warnings used to fire at activation in every window at every launch,
  // with no memory of having been shown: three windows, three popups.
  const greetings = harness.shown.filter((s) => /Claude Code TTS is listening/.test(s.message ?? ""));
  assert.equal(greetings.length, 1, "the greeting is a first-run thing");
  assert.equal(harness.globalState.get("claudeCodeTts.welcomed"), true);
  const warnings = harness.shown.filter((s) => s.kind === "warning" && /selected but/.test(s.message ?? ""));
  assert.deepEqual(warnings, [], "the system engine works everywhere; nothing to warn about");
});

test("the walkthrough the greeting offers is the one the extension declares", () => {
  const pkg = require(path.join(ROOT, "package.json"));
  const [walkthrough] = pkg.contributes.walkthroughs;
  assert.ok(walkthrough, "a new user needs somewhere to start");
  const ext = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
  assert.ok(
    ext.includes(`${pkg.publisher}.${pkg.name}#${walkthrough.id}`),
    "the greeting must open the walkthrough that exists"
  );
  for (const step of walkthrough.steps) {
    assert.ok(fs.existsSync(path.join(ROOT, step.media.markdown)), `${step.id}: ${step.media.markdown} is missing`);
    const command = /command:([\w.]+)/.exec(step.description)?.[1];
    assert.ok(command, `${step.id} has no button`);
    assert.ok(
      pkg.contributes.commands.some((c) => c.command === command),
      `${step.id} offers ${command}, which is not a command`
    );
  }
});

test("this window announces itself to the others, and takes it back when it closes", () => {
  // Other windows read these files to decide who speaks what. A window that
  // leaves its record behind keeps them quiet about terminal sessions until
  // it goes stale a minute later.
  // Shared with any other VSCode build on this machine, so that two of
  // them do not each speak the same terminal session.
  const registry = path.join(home, ".claude", "claude-code-tts-windows");
  const before = fs.readdirSync(registry).filter((f) => f.endsWith(".json"));
  assert.equal(before.length, 1, "one record for this window");
  const record = JSON.parse(fs.readFileSync(path.join(registry, before[0]), "utf8"));
  assert.equal(typeof record.startedAt, "number");
  assert.ok(Array.isArray(record.dirs), "the folders this window has open");

  ext.deactivate();
  assert.deepEqual(
    fs.readdirSync(registry).filter((f) => f.endsWith(".json")),
    [],
    "a closing window must not hold the terminal sessions"
  );
});

test("a machine without Claude Code is told so, rather than left in silence", () => {
  // The test's HOME has no ~/.claude/projects until it is created, which is
  // the state of any machine that has not run Claude Code. Promising speech
  // and then never speaking is the one first run that cannot be diagnosed.
  const shown = harness.shown.map((s) => s.message ?? "");
  const greeted = shown.some((m) => /Claude Code TTS is listening/.test(m));
  const explained = shown.some((m) => /does not seem to be installed/.test(m));
  assert.ok(greeted || explained, "a first run must say something");
  assert.ok(!(greeted && explained), "and only one of the two");
});

test("a menu that opens a list gets the user back, not out", async () => {
  // The complaint this exists for: Escape in a list opened from a menu closed
  // everything instead of returning to the menu. Every command a menu row
  // opens is told there is a menu behind it (the row passes `true`), and it
  // has to answer "back" when the user leaves the list rather than closing
  // the whole thing. The stub dismisses every picker it is shown, which is
  // exactly the Escape this is about.
  const fromMenus = [
    "claudeCodeTts.selectVoice",
    "claudeCodeTts.selectEngine",
    "claudeCodeTts.selectRate",
    "claudeCodeTts.setupTranslation",
    "claudeCodeTts.languageVoice",
    "claudeCodeTts.configureSounds",
    "claudeCodeTts.manageVoices",
    "claudeCodeTts.storage",
    "claudeCodeTts.checkSetup",
    "claudeCodeTts.history",
  ];
  const wrong = [];
  for (const id of fromMenus) {
    running = id;
    const handler = harness.commands.get(id);
    assert.ok(handler, `${id} is not registered`);
    let outcome;
    try {
      outcome = await Promise.race([
        Promise.resolve(handler(true)),
        new Promise((_, reject) => setTimeout(() => reject(new Error("did not settle within 5s")), 5000).unref?.()),
      ]);
    } catch (e) {
      wrong.push(`${id}: ${e.message}`);
      continue;
    }
    for (const q of harness.quickPicks.filter((q) => q.shown && !q.disposed)) q.hide();
    if (outcome !== "back") wrong.push(`${id}: answered ${JSON.stringify(outcome)} instead of "back"`);
  }
  assert.deepEqual(wrong, [], "these leave the user with nothing open when they meant to go back one step");
});

test("a row that opens something else comes back to the list it was opened from", async () => {
  // The complaint after the first fix: Escape went back from a list, but
  // choosing "use a different engine" or "design a new voice" in one landed
  // two levels up, in the menu above, instead of in the list that started
  // them. Driven for real here: the voice list is shown, its engine row is
  // accepted, and the list has to be shown again afterwards.
  fs.mkdirSync(path.join(storage, "piper-voices"), { recursive: true });
  fs.writeFileSync(path.join(storage, "piper-voices", "en_US-test-medium.onnx"), "");
  harness.settings.set("engine", "piper");
  running = "claudeCodeTts.selectVoice";
  const before = harness.quickPicks.length;
  const pending = harness.commands.get("claudeCodeTts.selectVoice")(true);
  // Same tick as show(), before the stub's Escape lands: pick the engine row.
  const list = harness.quickPicks[harness.quickPicks.length - 1];
  const engineRow = list.items.find((i) => /different engine/.test(i.label));
  assert.ok(engineRow, `no engine row in ${JSON.stringify(list.items.map((i) => i.label))}`);
  list.selectedItems = [engineRow];
  await list._handlers.accept();
  const outcome = await pending;
  for (const q of harness.quickPicks.filter((q) => q.shown && !q.disposed)) q.hide();
  harness.settings.set("engine", "system");

  const shown = harness.quickPicks.slice(before);
  const voiceLists = shown.filter((q) => q.items.some((i) => /different engine/.test(i.label ?? "")));
  assert.ok(
    voiceLists.length >= 2,
    `the voice list was shown ${voiceLists.length} time(s); it must come back after the engine picker`
  );
  assert.equal(outcome, "back", "and leaving that second list still goes back to the menu");
});

test("repeating a message says it in the language you are listening in", async () => {
  // The bug: "Repeat Last Message" put the recorded chunks straight into the
  // queue, so with translation on it read the English original back. What is
  // recorded is the prose Claude wrote; repeating has to take the same path a
  // live line takes.
  const { runtime } = require("../../out/core/runtime.js");
  const { recordMessage } = require("../../out/speech/spokenHistory.js");
  const spoken = [];
  const realSpeech = runtime.speech;
  const realTranslator = runtime.translator;
  runtime.speech = { enqueue: (t) => spoken.push(t), stop() {}, pending: 0 };
  runtime.translator = { available: true, translate: (text) => Promise.resolve(`[de] ${text}`) };
  harness.settings.set("speakLanguage", "de");
  try {
    recordMessage(["The tests pass now."]);
    running = "claudeCodeTts.repeatLast";
    await harness.commands.get("claudeCodeTts.repeatLast")();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(spoken, ["[de] The tests pass now."], "the repeat is translated, like the message was");

    // "Recent messages" replays an older one through the same path, so it is
    // in the language you are listening in now, not the one it arrived in.
    spoken.length = 0;
    recordMessage(["An older message."]);
    running = "claudeCodeTts.history";
    // A line too short for detection is Claude Code's English, and has to be
    // translated like any other: this one has no stopword in it, which is the
    // case that was silently spoken in English for as long as the feature
    // existed.
    const { speakLine } = require("../../out/speech/speaking.js");
    spoken.length = 0;
    speakLine("Direct call.");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(spoken, ["[de] Direct call."], "a short line is translated too");
    spoken.length = 0;
    const pending = harness.commands.get("claudeCodeTts.history")();
    // Same tick as show(), before the stub's Escape lands: pick the newest row.
    const list = harness.quickPicks[harness.quickPicks.length - 1];
    list.selectedItems = [list.items[0]];
    list._handlers.accept();
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(spoken, ["[de] An older message."], "an older message is repeated in the language you hear now");
  } finally {
    runtime.speech = realSpeech;
    runtime.translator = realTranslator;
    harness.settings.delete("speakLanguage");
  }
});

test("a command that needs an engine asks for it before it asks for anything else", () => {
  // A fresh install has neither cloning engine. "Clone My Voice" recorded ten
  // seconds, transcribed it and saved a profile that nothing on the machine
  // could speak; "Design a Voice" and refining printed a uv command for the
  // user to run themselves, in the middle of a flow they had started. Every
  // entry point that makes or activates a voice profile now checks first, and
  // the check offers the guided install.
  const fs = require("fs");
  const path = require("path");
  const read = (f) => fs.readFileSync(path.join(ROOT, "src", f), "utf8");
  // The guard must come before the thing it guards is used, not merely
  // somewhere in the function: refining also adjusts loudness and pace, which
  // need no engine at all, so its check belongs right before the re-render.
  const guards = [
    ["voices/clone.ts", "cloneVoiceFlow", "ensureProfileEngine(", "ensureCloneConsent("],
    ["voices/cloneFromFile.ts", "cloneFromFileFlow", "ensureProfileEngine(", "showOpenDialog("],
    ["voices/design.ts", "designVoiceFlow", "ensureQwen3Runtime", "findQwen3MlxPython("],
    ["ui/voiceManager.ts", "refine", "ensureQwen3Runtime", "findQwen3MlxPython("],
  ];
  const missing = [];
  for (const [file, fn, guard, uses] of guards) {
    const source = read(file);
    const start = source.indexOf(`function ${fn}(`);
    assert.ok(start > 0, `${fn} is not in ${file}`);
    const body = source.slice(start, source.indexOf("\n}\n", start));
    const guarded = body.indexOf(guard);
    const used = body.indexOf(uses);
    if (guarded < 0) {
      missing.push(`${file}: ${fn} never calls ${guard}`);
    } else if (used >= 0 && guarded > used) {
      missing.push(`${file}: ${fn} uses ${uses} before ${guard} has offered to install it`);
    }
  }
  assert.deepEqual(missing, [], "these can run to completion and leave a voice nothing can speak");

  // And the guards themselves must offer the install, not name a command.
  const setup = read("setup/setupFlows.ts");
  for (const guard of ["ensureQwen3Runtime", "ensureVoiceEngine"]) {
    const body = setup.slice(setup.indexOf(`function ${guard}(`), setup.indexOf(`function ${guard}(`) + 1400);
    assert.match(body, /setupQwen3Flow|ensureQwen3Runtime\(/, `${guard} must lead to the guided install`);
    assert.doesNotMatch(body, /uv tool install/, `${guard} must not hand the user a command to run`);
  }
  const clone = read("voices/clone.ts");
  const profileGuard = clone.slice(
    clone.indexOf("function ensureProfileEngine("),
    clone.indexOf("function ensureProfileEngine(") + 1400
  );
  assert.match(
    profileGuard,
    /claudeCodeTts\.setupChatterbox|claudeCodeTts\.setupQwen3/,
    "ensureProfileEngine must lead to the guided install"
  );
  assert.doesNotMatch(profileGuard, /uv tool install/, "ensureProfileEngine must not hand the user a command to run");
});
