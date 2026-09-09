/**
 * Pure transforms over a parsed ~/.claude/settings.json for installing and
 * removing the Claude Code TTS notification hooks. No vscode imports, so the
 * logic is testable and reusable outside the extension host.
 */
export type NotifyKind = "stop" | "permission" | "question" | "notification" | "tool" | "subagent" | "prompt";

/** What a hook installation needs to know about the user's sound choices. */
export interface HookPlanInput {
  /** Sound name per kind; an empty or missing one means that event is silent. */
  sounds: Partial<Record<NotifyKind | "waiting", string>>;
  /** Tools whose runs should sound. */
  toolFilter: string[];
}

/**
 * Which hooks to install, given what the user actually wants to hear.
 *
 * Every hook used to be installed unconditionally and the decision left to
 * the script at event time, which reads well until you count the processes:
 * an unmatched PreToolUse entry means Claude Code starts `node notify.js` for
 * every tool call in every session on the machine, reads stdin, parses the
 * payload and almost always exits without a sound. The tool filter belongs in
 * the matcher, where Claude Code applies it without starting anything, and an
 * event with no sound configured needs no hook at all.
 */
export function hookEvents(input: HookPlanInput): { event: string; matcher?: string; kind: NotifyKind }[] {
  const wants = (kind: string): boolean => !!input.sounds[kind as NotifyKind];
  const out: { event: string; matcher?: string; kind: NotifyKind }[] = [];
  if (wants("stop")) {
    out.push({ event: "Stop", kind: "stop" });
  }
  // "notification" self-classifies into permission or waiting from the payload.
  if (wants("permission") || wants("waiting")) {
    out.push({ event: "Notification", kind: "notification" });
  }
  if (wants("permission")) {
    out.push({ event: "PermissionRequest", kind: "permission" });
  }
  if (wants("question")) {
    out.push({ event: "PreToolUse", matcher: "AskUserQuestion", kind: "question" });
  }
  if (wants("tool") && input.toolFilter.length > 0) {
    out.push({ event: "PreToolUse", matcher: toolMatcher(input.toolFilter), kind: "tool" });
  }
  if (wants("subagent")) {
    out.push({ event: "SubagentStop", kind: "subagent" });
  }
  if (wants("prompt")) {
    out.push({ event: "UserPromptSubmit", kind: "prompt" });
  }
  return out;
}

/** An exact-alternatives matcher, so no other tool name can start a process. */
export function toolMatcher(tools: string[]): string {
  const escaped = [...new Set(tools)].map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return `^(${escaped.join("|")})$`;
}

/**
 * Add our hook entries; leaves every other hook untouched. Idempotent.
 *
 * `interpreter` is how the script gets run. It used to be the word "node",
 * which is only right when node is on the PATH that Claude Code's hooks
 * inherit: with a keg-only Homebrew formula, with nvm, or in an editor
 * started from the Dock rather than a shell, the hook failed with "command
 * not found" and the sounds simply stopped, with nothing said anywhere.
 */
export function applyHookInstall(settings: any, scriptPath: string, plan: HookPlanInput, interpreter = "node"): any {
  settings.hooks = settings.hooks ?? {};
  for (const { event, matcher, kind } of hookEvents(plan)) {
    const command = `${interpreter} "${scriptPath}" ${kind}`;
    const list: any[] = (settings.hooks[event] = settings.hooks[event] ?? []);
    // Exact-entry check: one event can carry several of our entries with
    // different matchers (PreToolUse: question + tool). Compare the command
    // field itself; stringified JSON escapes the quotes and never matches.
    const exists = list.some(
      (e) =>
        (e?.matcher ?? undefined) === matcher &&
        (Array.isArray(e?.hooks) ? e.hooks : []).some((h: any) => h?.command === command)
    );
    if (exists) {
      continue;
    }
    const entry: any = { hooks: [{ type: "command", command }] };
    if (matcher) {
      entry.matcher = matcher;
    }
    list.push(entry);
  }
  return settings;
}

/**
 * Bring an existing installation to the current hook layout: strip our
 * entries (old argument names included) and re-add the current set.
 */
export function applyHookNormalize(settings: any, scriptPath: string, plan: HookPlanInput, interpreter = "node"): any {
  return applyHookInstall(applyHookRemove(settings, scriptPath), scriptPath, plan, interpreter);
}

/**
 * Does this hook entry run our script? Compared on the command strings with
 * separators and case normalised: a Windows path inside JSON has doubled
 * backslashes, so a substring test against the raw path never matched and
 * the extension could neither detect nor remove its own hooks there.
 */
const normalizePath = (s: string): string => s.replace(/\\+/g, "/").toLowerCase();

export function entryRunsScript(entry: any, scriptPath: string): boolean {
  const target = normalizePath(scriptPath);
  const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
  return hooks.some((h: any) => typeof h?.command === "string" && normalizePath(h.command).includes(target));
}

/** Are our hooks installed in this settings object? */
export function settingsHaveScript(settings: any, scriptPath: string): boolean {
  const hooks = settings?.hooks ?? {};
  return Object.values(hooks).some((list) => Array.isArray(list) && list.some((e) => entryRunsScript(e, scriptPath)));
}

/** Remove exactly our entries (matched by script path), leaving the rest. */
export function applyHookRemove(settings: any, scriptPath: string): any {
  if (!settings.hooks) {
    return settings;
  }
  for (const event of Object.keys(settings.hooks)) {
    const list = settings.hooks[event];
    if (!Array.isArray(list)) {
      continue;
    }
    settings.hooks[event] = list.filter((entry) => !entryRunsScript(entry, scriptPath));
    if (settings.hooks[event].length === 0) {
      delete settings.hooks[event];
    }
  }
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }
  return settings;
}
