/**
 * Carry a user's settings across a change in the settings themselves.
 *
 * Renaming or merging a setting is invisible to the person who set it: their
 * value stays in settings.json under a key nothing reads any more, the
 * feature reverts to its default, and VSCode marks the line as an unknown
 * setting. So every removal and merge is written down here, applied once at
 * activation, and covered by a test that starts from a real old settings
 * object.
 *
 * No vscode import: the logic is a pure transform over a small store
 * interface, which is what makes it testable.
 */
/** The part of a VSCode configuration this needs. */
export interface SettingsStore {
  /** Where a value is set, if anywhere. */
  inspect(key: string): { globalValue?: unknown; workspaceValue?: unknown } | undefined;
  update(key: string, value: unknown, global: boolean): Promise<void>;
  /**
   * The same two, against the settings section this extension used to have.
   * Optional: nothing else needs it, and a caller that omits it simply
   * carries nothing across sections.
   */
  previousSection?: {
    inspect(key: string): { globalValue?: unknown; workspaceValue?: unknown } | undefined;
    update(key: string, value: unknown, global: boolean): Promise<void>;
  };
}

/**
 * The extension was published as "Claude Voice" until the Marketplace refused
 * the name (another extension, doing the opposite job, had it), so every
 * setting moved from `claudeVoice.*` to `claudeCodeTts.*`. A rename of the
 * section is invisible to the person who set the values: they stay in
 * settings.json under a name nothing reads, and every feature quietly returns
 * to its default. Each key is carried over once, and the old one cleared.
 */
export const PREVIOUS_SECTION = "claudeVoice";

/**
 * Seven sound settings became one object. The old keys were a wall in the
 * settings UI (ten of the forty-seven settings existed only to be written by
 * one command) and they made "which events sound?" a question with no single
 * answer to read.
 */
export const SOUND_KEY_MAP: Record<string, string> = {
  "notifications.doneSound": "done",
  "notifications.permissionSound": "permission",
  "notifications.questionSound": "question",
  "notifications.waitingSound": "waiting",
  "notifications.toolSound": "tool",
  "notifications.subagentSound": "subagent",
  "notifications.promptSound": "prompt",
};

/**
 * Settings that no longer exist. Each was an engineering constant that had
 * leaked into the user interface; the value that shipped as its default is
 * now the value in the code, so clearing these changes nothing that a user
 * would hear, and it removes the "unknown setting" warnings from their
 * settings.json.
 */
export const REMOVED_SETTINGS = [
  "chatterbox.vocoderSteps",
  "chatterbox.streaming",
  "chatterbox.quantizeBits",
  "maxRate",
  "maxUtteranceChars",
  "qwen3.language",
];

/**
 * Settings that changed name. `scope` said nothing about what it scoped, and
 * its values ("all", "workspace") read as sizes rather than as the choice
 * they represent: whether a session started in a terminal outside this
 * window is spoken.
 */
export const RENAMED_SETTINGS: { from: string; to: string; value: (v: unknown) => unknown }[] = [
  {
    from: "scope",
    to: "listenTo",
    value: (v) => (v === "all" ? "everywhere" : v === "workspace" ? "workspace" : undefined),
  },
];

/** What a migration did, for the log. */
export interface MigrationResult {
  merged: string[];
  cleared: string[];
  renamed: string[];
  /** Keys carried over from the section this extension used to have. */
  moved: string[];
}

/**
 * Fold the old keys into the new ones and clear what is gone. Safe to run on
 * every activation: with nothing old set it does nothing and writes nothing.
 */
export async function migrateSettings(store: SettingsStore, keys: readonly string[] = []): Promise<MigrationResult> {
  const merged: string[] = [];
  const cleared: string[] = [];
  const renamed: string[] = [];
  const moved: string[] = [];

  // The section rename comes first, so everything below sees the values where
  // it expects them. Both the settings that still exist and the ones the
  // steps below fold away or clear are carried, which is why the old keys are
  // taken from the caller's list plus the names this file already knows.
  const previous = store.previousSection;
  if (previous) {
    const everyOldKey = [
      ...new Set([...keys, ...RENAMED_SETTINGS.map((r) => r.from), ...Object.keys(SOUND_KEY_MAP), ...REMOVED_SETTINGS]),
    ];
    for (const key of everyOldKey) {
      const found = previous.inspect(key);
      for (const [held, global] of [
        [found?.globalValue, true],
        [found?.workspaceValue, false],
      ] as [unknown, boolean][]) {
        if (held === undefined) {
          continue;
        }
        const already = global ? store.inspect(key)?.globalValue : store.inspect(key)?.workspaceValue;
        // A value already set under the new name is the more recent choice.
        if (already === undefined) {
          await store.update(key, held, global);
        }
        await previous.update(key, undefined, global);
        moved.push(key);
      }
    }
  }

  for (const { from, to, value } of RENAMED_SETTINGS) {
    const found = store.inspect(from);
    for (const [held, global] of [
      [found?.globalValue, true],
      [found?.workspaceValue, false],
    ] as [unknown, boolean][]) {
      if (held === undefined) {
        continue;
      }
      const mapped = value(held);
      const already = global ? store.inspect(to)?.globalValue : store.inspect(to)?.workspaceValue;
      // A choice already made on the new key is the more recent one.
      if (mapped !== undefined && already === undefined) {
        await store.update(to, mapped, global);
      }
      await store.update(from, undefined, global);
      renamed.push(`${from} -> ${to}`);
    }
  }

  const sounds: Record<string, string> = {};
  let anySound = false;
  for (const [oldKey, kind] of Object.entries(SOUND_KEY_MAP)) {
    const found = store.inspect(oldKey);
    const value = found?.globalValue ?? found?.workspaceValue;
    if (value === undefined) {
      continue;
    }
    anySound = true;
    // An empty string meant "silent" and still does. It has to be carried
    // over as a value rather than dropped: VSCode merges an object setting
    // over the default from package.json, so an event left out of the object
    // takes the default sound back and starts sounding again, which would
    // silently undo the choice this migration exists to preserve.
    if (typeof value === "string") {
      sounds[kind] = value;
    }
    merged.push(oldKey);
  }
  if (anySound) {
    const existing = (store.inspect("notifications.sounds")?.globalValue ?? {}) as Record<string, string>;
    // Anything already set on the new key wins: it is the more recent choice.
    await store.update("notifications.sounds", { ...sounds, ...existing }, true);
    for (const oldKey of merged) {
      await store.update(oldKey, undefined, true);
    }
  }

  for (const key of REMOVED_SETTINGS) {
    const found = store.inspect(key);
    if (found?.globalValue === undefined && found?.workspaceValue === undefined) {
      continue;
    }
    if (found.globalValue !== undefined) {
      await store.update(key, undefined, true);
    }
    if (found.workspaceValue !== undefined) {
      await store.update(key, undefined, false);
    }
    cleared.push(key);
  }

  return { merged, cleared, renamed, moved };
}
