// package.json and the code must agree about what this extension contributes.
//
// Every drift this file checks for was found in a real build: a command
// registered but never declared (so it existed and was unreachable), a default
// that differed between the schema and the code that reads it (maxRate 260 in
// package.json, 300 in config()), and a hand-maintained list of setting keys
// that reset-to-defaults walks, with nothing to keep it in step with the
// schema it is supposed to mirror.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { ROOT } = require("../helpers");

const pkg = require(path.join(ROOT, "package.json"));
const extSource = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
const configSource = fs.readFileSync(path.join(ROOT, "src", "core", "config.ts"), "utf8");
/** Every source file, for questions like "is this command referenced anywhere?". */
const allSource = (function read(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? read(full) : e.name.endsWith(".ts") ? [fs.readFileSync(full, "utf8")] : [];
  });
})(path.join(ROOT, "src")).join("\n");

const declared = pkg.contributes.commands.map((c) => c.command);
const settingKeys = Object.keys(configurationProperties());

/** The configuration schema, whether it is one section or several. */
function configurationProperties() {
  const c = pkg.contributes.configuration;
  const sections = Array.isArray(c) ? c : [c];
  return Object.assign({}, ...sections.map((s) => s.properties));
}

test("every declared command is registered, and every registered command is declared", () => {
  const registered = [...extSource.matchAll(/registerCommand\(\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    declared.filter((c) => !registered.includes(c)),
    [],
    "declared in package.json but never registered: the palette would show a command that does nothing"
  );
  // A command may be internal (invoked with arguments from a picker, never
  // shown in the palette), but that has to be deliberate and listed.
  const { INTERNAL_COMMANDS: internal } = require(path.join(ROOT, "out", "core", "commandCatalogue.js"));
  assert.deepEqual(
    registered.filter((c) => !declared.includes(c) && !internal.includes(c)),
    [],
    "registered but neither declared nor listed in INTERNAL_COMMANDS"
  );
  assert.deepEqual(
    internal.filter((c) => !registered.includes(c)),
    [],
    "INTERNAL_COMMANDS names a command nobody registers"
  );
});

test("every keybinding and menu entry points at a declared command", () => {
  for (const k of pkg.contributes.keybindings ?? []) {
    assert.ok(declared.includes(k.command), `keybinding ${k.key} runs undeclared command ${k.command}`);
  }
  for (const [menu, entries] of Object.entries(pkg.contributes.menus ?? {})) {
    for (const e of entries) {
      assert.ok(declared.includes(e.command), `menu ${menu} references undeclared command ${e.command}`);
    }
  }
});

test("command titles are formatted the one way, so the palette groups them", () => {
  // VS Code renders "<category>: <title>". A title that repeats the category
  // shows as "Claude Code TTS: Claude Code TTS: Stop Speaking".
  const wrong = pkg.contributes.commands.filter(
    (c) => c.category !== "Claude Code TTS" || /^Claude Code TTS:/.test(c.title)
  );
  assert.deepEqual(
    wrong.map((c) => `${c.command}: ${c.title}`),
    [],
    'every command needs "category": "Claude Code TTS" and a title that does not repeat it'
  );
});

test("SETTING_KEYS covers exactly the settings the schema declares", () => {
  // Reset-to-defaults walks this list; a key missing from it silently survives
  // a reset, and a stale key clears something that no longer exists.
  const block = configSource.match(/const SETTING_KEYS = \[([\s\S]*?)\];/);
  assert.ok(block, "SETTING_KEYS not found in src/core/config.ts");
  const listed = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const short = settingKeys.map((k) => k.replace(/^claudeCodeTts\./, ""));
  assert.deepEqual(
    short.filter((k) => !listed.includes(k)),
    [],
    "settings the reset command would not reset"
  );
  assert.deepEqual(
    listed.filter((k) => !short.includes(k)),
    [],
    "SETTING_KEYS entries that are no longer settings"
  );
});

test("the fallback in every config() read equals the schema default", () => {
  const props = configurationProperties();
  const mismatches = [];
  // c.get<T>("key", fallback) with a literal fallback; expressions are skipped.
  // readConfig() lives in config.ts and extension.ts still reads a few keys of
  // its own, so both are scanned: after the split, extension.ts alone went blind.
  const reads = `${extSource}\n${configSource}`;
  for (const m of reads.matchAll(/\.get<[^>]*>\(\s*"([^"]+)"\s*,\s*([^)]+?)\)/g)) {
    const [, key, raw] = m;
    const spec = props[`claudeCodeTts.${key}`];
    if (!spec) continue; // reads of another extension's settings, if any
    let fallback;
    try {
      fallback = JSON.parse(raw.trim().replace(/'/g, '"'));
    } catch {
      continue; // a constant or expression: not comparable here
    }
    if (JSON.stringify(fallback) !== JSON.stringify(spec.default)) {
      mismatches.push(
        `${key}: code says ${JSON.stringify(fallback)}, package.json says ${JSON.stringify(spec.default)}`
      );
    }
  }
  assert.deepEqual(mismatches, [], "a setting left at its default behaves differently from the schema");
});

test("every enum setting accepts the values the extension itself writes", () => {
  const props = configurationProperties();
  // A value the extension writes but the schema rejects shows a red squiggle
  // in the user's settings.json and can be dropped on the next write.
  const engineEnum = props["claudeCodeTts.engine"].enum;
  const registryEngines = [
    ...fs.readFileSync(path.join(ROOT, "src", "speech", "speech.ts"), "utf8").matchAll(/^\s{2}(\w+):\s*\(/gm),
  ].map((m) => m[1]);
  assert.deepEqual(
    registryEngines.filter((e) => !engineEnum.includes(e)),
    [],
    "an engine in the ENGINES registry that the engine setting will not accept"
  );
  assert.equal(
    props["claudeCodeTts.engine"].enumDescriptions?.length,
    engineEnum.length,
    "every engine needs a description in the settings UI"
  );

  const langSource = fs.readFileSync(path.join(ROOT, "src", "language", "language.ts"), "utf8");
  const speakEnum = props["claudeCodeTts.speakLanguage"].enum.filter(Boolean);
  const known = [...langSource.matchAll(/(?:"([a-z]{2})"|\b([a-z]{2})):\s*"/g)].map((m) => m[1] ?? m[2]);
  assert.deepEqual(
    speakEnum.filter((c) => !known.includes(c)),
    [],
    "speakLanguage offers a language the extension has no name for"
  );
});

test("the speakLanguage enum is exactly what the translator offers", () => {
  // Three hand-written copies of this list had drifted: the setting rejected
  // he, ar, hi, th and el while the translation flow was writing them.
  const langSource = fs.readFileSync(path.join(ROOT, "src", "language", "language.ts"), "utf8");
  const block = langSource.match(/TRANSLATION_LANGUAGES: readonly string\[\] = \[([\s\S]*?)\];/);
  assert.ok(block, "TRANSLATION_LANGUAGES not found in src/language/language.ts");
  const codes = [...block[1].matchAll(/"([a-z]{2})"/g)].map((m) => m[1]);
  const props = configurationProperties();
  assert.deepEqual(props["claudeCodeTts.speakLanguage"].enum, ["", ...codes]);
  assert.equal(props["claudeCodeTts.speakLanguage"].enumDescriptions.length, codes.length + 1);
  const flowSource = fs.readFileSync(path.join(ROOT, "src", "language", "languageFlows.ts"), "utf8");
  assert.equal(
    (flowSource.match(/const CODES = TRANSLATION_LANGUAGES;/g) ?? []).length,
    2,
    "both translation flows must read the shared list, not their own copy"
  );
});

test("languageVoices accepts every engine and the fields the extension writes", () => {
  const props = configurationProperties();
  const shape = props["claudeCodeTts.languageVoices"].additionalProperties.anyOf.find((a) => a.type === "object");
  assert.deepEqual(shape.properties.engine.enum, props["claudeCodeTts.engine"].enum);
  assert.ok(shape.properties.inVoice, "the extension writes inVoice; the schema must document it");
});

test("settings are grouped, ordered and explained", () => {
  // 47 settings in one flat block is what made this extension look like a
  // control panel. Sections give the Settings UI something to group by, and
  // "advanced" keeps the engineering knobs out of a new user's way.
  const sections = pkg.contributes.configuration;
  assert.ok(Array.isArray(sections), "configuration must be a list of sections");
  for (const [i, section] of sections.entries()) {
    assert.match(section.title, /^Claude Code TTS/, "a section title must say whose settings these are");
    assert.equal(section.order, i + 1, `${section.title} is out of order`);
    for (const [key, spec] of Object.entries(section.properties)) {
      assert.ok(spec.description || spec.markdownDescription, `${key} has no description`);
      assert.ok(typeof spec.order === "number", `${key} has no order within its section`);
    }
  }
  const advanced = sections
    .flatMap((s) => Object.entries(s.properties))
    .filter(([, spec]) => (spec.tags ?? []).includes("advanced"));
  assert.ok(advanced.length >= 10, "the engineering settings should be tagged advanced");
  const plain = Object.keys(configurationProperties()).length - advanced.length;
  assert.ok(plain <= 24, `${plain} settings face a new user; that is a wall again`);
});

test("a workspace cannot choose what the extension executes or loads", () => {
  // claudeCodeTts.piper.path is spawned as a program. Left workspace-settable,
  // any repository could put a path in .vscode/settings.json and have the
  // extension run it. Machine scope keeps these in the user's own settings,
  // and workspace trust covers the ones that name a file to load.
  const props = configurationProperties();
  // "machine" for anything that names a program to run or a model file to
  // load; "machine-overridable" for the rest, which a workspace may choose
  // but an untrusted one may not.
  for (const key of [
    "claudeCodeTts.piper.path",
    "claudeCodeTts.piper.voice",
    "claudeCodeTts.qwen3.runtime",
    "claudeCodeTts.chatterbox.runtime",
  ]) {
    assert.equal(props[key].scope, "machine", `${key} must not be settable per workspace`);
  }
  for (const key of [
    "claudeCodeTts.notifications.enabled",
    "claudeCodeTts.kokoro.voice",
    "claudeCodeTts.idleUnloadMinutes",
  ]) {
    assert.equal(props[key].scope, "machine-overridable", `${key} should stay settable per workspace`);
  }
  const restricted = pkg.capabilities?.untrustedWorkspaces?.restrictedConfigurations ?? [];
  assert.equal(pkg.capabilities.untrustedWorkspaces.supported, "limited");
  for (const key of [
    "claudeCodeTts.piper.path",
    "claudeCodeTts.piper.voice",
    "claudeCodeTts.languageVoices",
    "claudeCodeTts.substitutions",
  ]) {
    assert.ok(restricted.includes(key), `${key} must be restricted in an untrusted workspace`);
  }
});

test("the command palette shows one entry per job, not one per code path", () => {
  // 32 entries, twenty of which were second doors into a flow that already
  // offered them, is the complaint this whole change answers. Everything
  // stays registered (a user's keybinding, and every executeCommand call
  // site, keeps working); the palette just stops listing all of it.
  const hidden = new Set(
    (pkg.contributes.menus?.commandPalette ?? []).filter((m) => m.when === "false").map((m) => m.command)
  );
  const visible = declared.filter((c) => !hidden.has(c));
  // Sixteen: fifteen, plus exporting spoken audio, which is a job of its own
  // and one a person will type into the palette rather than hunt for.
  assert.ok(visible.length <= 16, `${visible.length} commands in the palette`);
  for (const must of [
    "claudeCodeTts.menu",
    "claudeCodeTts.toggle",
    "claudeCodeTts.speak",
    "claudeCodeTts.checkSetup",
  ]) {
    assert.ok(visible.includes(must), `${must} must stay findable in the palette`);
  }
  // A hidden command has to be reachable some other way, or it is dead: a
  // menu row, another flow that runs it, or a listed compatibility alias.
  const { LEGACY_COMMANDS: legacy } = require(path.join(ROOT, "out", "core", "commandCatalogue.js"));
  // The registration site is not evidence of reachability: every command has
  // one. Strip those first, or this assertion can never fail.
  const beyondRegistration = allSource.replace(/registerCommand\(\s*"[^"]+"/g, "");
  for (const command of hidden) {
    if (legacy.includes(command)) continue;
    assert.ok(
      beyondRegistration.includes(`"${command}"`),
      `${command} is hidden from the palette and offered nowhere else`
    );
  }
});

test("the default keybindings are few, and do not collide with AltGr", () => {
  // Ctrl+Alt is AltGr on most non-US Windows and Linux layouts, where these
  // bindings silently eat characters the user is trying to type.
  const keys = pkg.contributes.keybindings;
  assert.ok(keys.length <= 7, `${keys.length} default keybindings is more than a user asked for`);
  for (const k of keys) {
    assert.match(k.key, /^ctrl\+shift\+alt\+/, `${k.command} uses ${k.key} on Windows and Linux`);
    assert.match(k.mac, /^ctrl\+alt\+/, `${k.command} should keep the short chord on macOS`);
  }
});

test("no flow writes settings through a configuration handed to it", () => {
  // A WorkspaceConfiguration is a snapshot of the settings as they were when
  // it was taken. A function that receives one and writes through it builds
  // its new value from stale data: choosing a second completion sound
  // dropped the first, and the list that came back showed the sound just
  // chosen as "off". Reading through a passed-in configuration is fine; the
  // pair of receiving one and calling update on it is the bug.
  const fs = require("fs");
  const path = require("path");
  const dir = path.join(ROOT, "src");
  const offenders = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) {
        const source = fs.readFileSync(full, "utf8");
        // Each function that names a configuration parameter, with its body
        // up to the next top-level function.
        for (const match of source.matchAll(/function (\w+)\(([^)]*WorkspaceConfiguration[^)]*)\)/g)) {
          const body = source.slice(match.index, source.indexOf("\n}", match.index));
          const name = match[2].match(/(\w+):\s*vscode\.WorkspaceConfiguration/)?.[1];
          if (name && new RegExp(`\\b${name}\\.update\\(`).test(body)) offenders.push(`${entry.name}: ${match[1]}`);
        }
      }
    }
  };
  walk(dir);
  assert.deepEqual(offenders, [], "these write settings through a configuration they did not fetch themselves");
});

test("every list and every question can be left the way it was entered", () => {
  // The extension is menus inside menus: a voice picker opens a design flow
  // that asks three questions in a row. Without a way back, reconsidering
  // step three means closing everything and starting from the status bar.
  // vscode.window.showQuickPick and showInputBox cannot carry a back button,
  // so the wrappers in src/ui/prompts.ts (and the pickers built on them) are the only
  // way this extension asks anything.
  const fs = require("fs");
  const path = require("path");
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && entry.name !== "ui.ts") {
        const source = fs.readFileSync(full, "utf8");
        for (const api of ["showQuickPick", "showInputBox"]) {
          if (source.includes(`window.${api}(`)) offenders.push(`${path.relative(ROOT, full)}: ${api}`);
        }
      }
    }
  };
  walk(path.join(ROOT, "src"));
  assert.deepEqual(offenders, [], "these ask a question that cannot be left with the back arrow");
});

test("no source file grows into a program of its own", () => {
  // extension.ts reached 4,142 lines: activation, menus, installs, pickers,
  // translation, the speaking path and the status bar in one file, where
  // every one of them changed for a different reason. The limit is not
  // beautiful, it is a tripwire: a file over it has stopped being about one
  // thing, and the fix is to move a responsibility out, not to raise this.
  // (It moved from 900 when braces became required on every branch: that
  // adds two lines per guard clause and says nothing about structure.)
  const fs = require("fs");
  const path = require("path");
  const LIMIT = 1000;
  const oversized = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) {
        const lines = fs.readFileSync(full, "utf8").split("\n").length;
        if (lines > LIMIT) oversized.push(`${path.relative(ROOT, full)}: ${lines} lines`);
      }
    }
  };
  walk(path.join(ROOT, "src"));
  assert.deepEqual(oversized, [], `over ${LIMIT} lines; split by responsibility rather than raising the limit`);
});
