// Settings a user already set must survive the settings being reorganised.
//
// Without this, merging the seven notification sound keys into one object
// would have silently turned every customised sound back to its default,
// left the old keys in settings.json marked as unknown, and given no clue
// why the sounds changed.
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  migrateSettings,
  PREVIOUS_SECTION,
  REMOVED_SETTINGS,
  RENAMED_SETTINGS,
  SOUND_KEY_MAP,
} = require("../../out/core/settingsMigration.js");

/** A settings.json stand-in: what is set globally, what per workspace. */
function store(globalValues = {}, workspaceValues = {}) {
  const writes = [];
  return {
    writes,
    globalValues,
    workspaceValues,
    inspect: (key) => ({ globalValue: globalValues[key], workspaceValue: workspaceValues[key] }),
    update: async (key, value, global) => {
      writes.push([key, value, global ? "global" : "workspace"]);
      const target = global ? globalValues : workspaceValues;
      if (value === undefined) delete target[key];
      else target[key] = value;
    },
  };
}

test("customised sounds move into the one object and the old keys go away", async () => {
  const s = store({
    "notifications.doneSound": "Submarine",
    "notifications.permissionSound": "Funk",
    "notifications.toolSound": "Pop",
    "notifications.subagentSound": "", // explicitly silenced
  });
  const result = await migrateSettings(s);
  assert.deepEqual(
    s.globalValues["notifications.sounds"],
    {
      done: "Submarine",
      permission: "Funk",
      tool: "Pop",
      subagent: "",
    },
    "a deliberately silenced event must stay silent"
  );
  for (const old of Object.keys(SOUND_KEY_MAP)) {
    assert.equal(s.globalValues[old], undefined, `${old} was left behind`);
  }
  assert.deepEqual(result.merged.sort(), [
    "notifications.doneSound",
    "notifications.permissionSound",
    "notifications.subagentSound",
    "notifications.toolSound",
  ]);
});

test("a settings file with nothing old in it is not written to at all", async () => {
  const s = store({ rate: 240 });
  const result = await migrateSettings(s);
  assert.deepEqual(s.writes, [], "migration must be silent when there is nothing to carry");
  assert.deepEqual(result, { merged: [], cleared: [], renamed: [], moved: [] });
  assert.equal(s.globalValues.rate, 240);
});

test("silence survives the merge, because VSCode would put the default back", async () => {
  // An object setting is merged key by key over the default in package.json,
  // so an event left out of the object takes its default sound back. Silence
  // has to be a value, not an absence, or a user who turned a sound off in
  // an earlier build hears it again after the upgrade.
  const s = store({ "notifications.doneSound": "", "notifications.questionSound": "" });
  await migrateSettings(s);
  assert.deepEqual(s.globalValues["notifications.sounds"], { done: "", question: "" });
  const pkg = require("../../package.json");
  const spec = pkg.contributes.configuration
    .flatMap((sec) => Object.entries(sec.properties))
    .find(([k]) => k === "claudeCodeTts.notifications.sounds")[1];
  assert.ok(Object.keys(spec.default).length > 0, "the default is what makes absence unusable as silence");
  assert.match(spec.markdownDescription, /empty string/, "the setting must document how to silence an event");
});

test("a choice already made on the new key wins over the old one", async () => {
  const s = store({
    "notifications.doneSound": "Submarine",
    "notifications.sounds": { done: "Blow", question: "Ping" },
  });
  await migrateSettings(s);
  assert.deepEqual(s.globalValues["notifications.sounds"], { done: "Blow", question: "Ping" });
});

test("settings that no longer exist are cleared, in both places they can be set", async () => {
  // They were engineering constants; the shipped default is now the value in
  // the code, so clearing them changes nothing a user would hear and removes
  // the "unknown setting" warnings from their settings.json.
  const s = store({ "chatterbox.quantizeBits": 4, maxRate: 260 }, { maxUtteranceChars: 900 });
  const result = await migrateSettings(s);
  assert.deepEqual(result.cleared.sort(), ["chatterbox.quantizeBits", "maxRate", "maxUtteranceChars"]);
  assert.equal(s.globalValues["chatterbox.quantizeBits"], undefined);
  assert.equal(s.globalValues.maxRate, undefined);
  assert.equal(s.workspaceValues.maxUtteranceChars, undefined);
});

test("every setting the migration mentions is really gone from the schema", () => {
  // The list and the schema must not drift: a key left in both would be
  // cleared on every activation, silently resetting whoever set it.
  const pkg = require("../../package.json");
  const declared = new Set(
    pkg.contributes.configuration
      .flatMap((s) => Object.keys(s.properties))
      .map((k) => k.replace(/^claudeCodeTts\./, ""))
  );
  for (const key of [...REMOVED_SETTINGS, ...Object.keys(SOUND_KEY_MAP)]) {
    assert.ok(!declared.has(key), `${key} is still a setting, so the migration would wipe it`);
  }
  assert.ok(declared.has("notifications.sounds"), "the key the sounds are merged into must exist");
});

test("a renamed setting keeps its meaning, in both places it can be set", async () => {
  // "scope" said nothing about what it scoped, and its values read as sizes
  // rather than as the choice they are: whether a session started in a
  // terminal outside this window gets spoken.
  const s = store({ scope: "all" }, { scope: "workspace" });
  const result = await migrateSettings(s);
  assert.equal(s.globalValues.listenTo, "everywhere");
  assert.equal(s.workspaceValues.listenTo, "workspace");
  assert.equal(s.globalValues.scope, undefined, "the old key is cleared");
  assert.equal(s.workspaceValues.scope, undefined);
  assert.deepEqual(result.renamed, ["scope -> listenTo", "scope -> listenTo"]);
});

test("a rename does not overwrite a choice already made on the new key", async () => {
  const s = store({ scope: "all", listenTo: "workspace" });
  await migrateSettings(s);
  assert.equal(s.globalValues.listenTo, "workspace", "the newer key wins");
  assert.equal(s.globalValues.scope, undefined);
});

test("the settings the migration renames are gone from the schema, and their targets exist", () => {
  const pkg = require("../../package.json");
  const declared = new Set(
    pkg.contributes.configuration
      .flatMap((s) => Object.keys(s.properties))
      .map((k) => k.replace(/^claudeCodeTts\./, ""))
  );
  for (const { from, to } of RENAMED_SETTINGS) {
    assert.ok(!declared.has(from), `${from} is still a setting, so the migration would keep clearing it`);
    assert.ok(declared.has(to), `${from} is renamed to ${to}, which does not exist`);
  }
});

test("settings set under the extension's previous name are carried into the new one", () => {
  // The Marketplace refused the name "claude-voice" (another extension, doing
  // the opposite job, has it), so the settings section became claudeCodeTts.
  // Renaming a section is invisible to whoever set the values: they sit in
  // settings.json under a name nothing reads, and every feature quietly
  // returns to its default.
  assert.equal(PREVIOUS_SECTION, "claudeVoice");
  return (async () => {
    const now = store({ rate: 240 });
    const before = store({ voice: "clone:elon", rate: 999, "notifications.doneSound": "Glass" }, { engine: "kokoro" });
    const result = await migrateSettings({ ...now, previousSection: before }, ["voice", "rate", "engine"]);

    assert.equal(now.globalValues.voice, "clone:elon", "a value only the old section had is carried");
    assert.equal(now.workspaceValues.engine, "kokoro", "in both scopes");
    assert.equal(now.globalValues.rate, 240, "a value already set under the new name is the more recent choice");
    assert.deepEqual(before.globalValues, {}, "and the old section is left empty");
    assert.deepEqual(before.workspaceValues, {});
    assert.ok(result.moved.includes("voice"), `moved: ${result.moved.join(", ")}`);
    // The sound key came over and then went through the merge that folds the
    // seven old sound settings into one object, in the same pass.
    assert.equal(now.globalValues["notifications.sounds"]?.done, "Glass", "carried, then merged");
  })();
});

test("nothing is written when the previous section is empty, or absent", () => {
  return (async () => {
    const now = store({ rate: 240 });
    const before = store();
    const result = await migrateSettings({ ...now, previousSection: before }, ["rate", "voice"]);
    assert.deepEqual(result.moved, []);
    assert.deepEqual(now.writes, [], "an activation with nothing old to carry writes nothing");
    const alone = store({ rate: 240 });
    assert.deepEqual((await migrateSettings(alone, ["rate"])).moved, [], "a caller may omit the old section");
  })();
});
