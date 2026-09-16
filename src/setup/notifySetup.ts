/**
 * Notification sounds via Claude Code hooks. Independent of the speech
 * pipeline: the bundled notify.js is installed as a hook in
 * ~/.claude/settings.json, so it fires for terminal sessions and even when
 * VSCode is closed. The hooks are written by default (installHooksNow, which
 * the sounds flow announces once); installHooks asks first, where a flow
 * needs that consent. Every write is backed up and only ever touches entries
 * pointing at our own script.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { applyHookNormalize, applyHookRemove, HookPlanInput, settingsHaveScript } from "./hooks";
import { runtime } from "../core/runtime";
import { writeFileAtomicSync } from "../platform/atomicFile";
import { resolveNodeCommand } from "../platform/platform";

const CLAUDE_SETTINGS = path.join(os.homedir(), ".claude", "settings.json");
const NOTIFY_CONFIG = path.join(os.homedir(), ".claude", "claude-code-tts-notify.json");
const SCRIPT_NAME = "claude-code-tts-notify.js";

/** Version-stable script location; extension install paths change on update. */
export function notifyScriptPath(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, SCRIPT_NAME);
}

export interface NotifyConfig {
  enabled: boolean;
  volume: number;
  /** Where the extension's own sounds are copied for the hook (version-stable, like the script). */
  soundsDir?: string;
  /** Per-category sound name; empty string turns that category off. */
  sounds: {
    stop: string;
    permission: string;
    question: string;
    waiting: string;
    tool: string;
    subagent: string;
    prompt: string;
  };
  /** Tool names that trigger the "tool" category (auto-approve watching). */
  toolFilter: string[];
}

/**
 * The sounds the extension ships (assets/sounds), the same on every
 * platform: a system sound library differs per platform, is quiet on
 * Windows, and a name synced from another machine names nothing here.
 * Values in the setting are "builtin/<name>"; an absolute path is a file of
 * the user's own; anything else is a system sound name.
 */
export interface BuiltinSound {
  /** The setting's value: "builtin/<file stem>". */
  value: string;
  label: string;
  detail: string;
  /** Where it sits in the picker: the event it was made for ("Done", "Question", ...). */
  group: string;
  /** The event it was made for, on the two per event that were. */
  event?: string;
}

/** The seven defaults, in case index.json cannot be read: the hook falls back to these files by event. */
// prettier-ignore
const DEFAULT_CATALOG: BuiltinSound[] = [
  { value: "builtin/done", event: "done", label: "Done: the default", detail: "two rising tones", group: "Done" },
  { value: "builtin/question", event: "question", label: "Question: the default", detail: "two notes rising", group: "Question" },
  { value: "builtin/permission", event: "permission", label: "Permission: the default", detail: "a warm double bell", group: "Permission" },
  { value: "builtin/waiting", event: "waiting", label: "Waiting: the default", detail: "one soft mellow tone", group: "Waiting" },
  { value: "builtin/tool", event: "tool", label: "Tool: the default", detail: "a soft typewriter click", group: "Tool" },
  { value: "builtin/prompt", event: "prompt", label: "Prompt: the default", detail: "a plucked harp note", group: "Prompt" },
  { value: "builtin/subagent", event: "subagent", label: "Subagent: the default", detail: "two quiet marimba notes", group: "Subagent" },
];

let catalog: BuiltinSound[] | undefined;

/**
 * The sounds the extension ships (assets/sounds, listed by its index.json;
 * generated with Stable Audio Open from the prompts in prompts.json there,
 * scripts/sounds/generate.py renders them again), the same on every
 * platform: a system sound library differs per platform, is quiet on
 * Windows, and a name synced from another machine names nothing here.
 * Values in the setting are "builtin/<name>"; an absolute path is a file
 * of the user's own; anything else is a system sound name.
 */
export function builtinSounds(context: vscode.ExtensionContext | undefined = runtime.context): BuiltinSound[] {
  if (catalog) {
    return catalog;
  }
  try {
    const raw = fs.readFileSync(path.join(context.extensionPath, "assets", "sounds", "index.json"), "utf8");
    const parsed = JSON.parse(raw) as BuiltinSound[];
    if (Array.isArray(parsed) && parsed.length >= DEFAULT_CATALOG.length) {
      catalog = parsed;
      return catalog;
    }
  } catch {
    /* the defaults below */
  }
  return DEFAULT_CATALOG;
}

/** The version-stable copy of the shipped sounds; the extension's own path changes with every update. */
export function bundledSoundsDir(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, "sounds");
}

/** Whether a setting value is one of the shipped sounds. */
export function isBuiltinSound(name: string): boolean {
  return builtinSounds().some((s) => s.value === name);
}

/**
 * The shipped sounds go next to the hook script for the same reason it
 * does: the hook plays them after an update has moved the extension, and
 * with VSCode closed. Copied only where the copy is missing or differs in
 * size, and a sound an earlier version shipped is removed: this runs at
 * every activation, and the set is sixty files.
 */
function copyBundledSounds(context: vscode.ExtensionContext): void {
  const from = path.join(context.extensionPath, "assets", "sounds");
  const to = bundledSoundsDir(context);
  fs.mkdirSync(to, { recursive: true });
  const shipped = fs.readdirSync(from).filter((f) => f.endsWith(".wav"));
  for (const stale of fs.readdirSync(to)) {
    if (stale.endsWith(".wav") && !shipped.includes(stale)) {
      fs.rmSync(path.join(to, stale), { force: true });
    }
  }
  for (const f of shipped) {
    const source = path.join(from, f);
    const copy = path.join(to, f);
    let size: number | undefined;
    try {
      size = fs.statSync(copy).size;
    } catch {
      /* not there yet */
    }
    if (size !== fs.statSync(source).size) {
      fs.copyFileSync(source, copy);
    }
  }
}

/** Where this platform keeps its system sounds, and which files count. */
export function soundLibrary(): { dir: string; extensions: string[] } {
  if (process.platform === "darwin") {
    return { dir: "/System/Library/Sounds", extensions: [".aiff"] };
  }
  if (process.platform === "win32") {
    return { dir: "C:\\Windows\\Media", extensions: [".wav"] };
  }
  return { dir: "/usr/share/sounds/freedesktop/stereo", extensions: [".oga", ".ogg", ".wav"] };
}

/** System sounds available for the picker, on any platform. */
export function listSystemSounds(): string[] {
  const { dir, extensions } = soundLibrary();
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => extensions.some((e) => f.endsWith(e)))
      .map((f) => f.replace(/\.[^.]+$/, ""))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Absolute path of a sound as the setting names it: one of the shipped
 * sounds (from their copy in storage, else from the extension itself), a
 * file of the user's own, or a system sound; undefined when it is not here.
 */
export function soundPath(
  name: string,
  context: vscode.ExtensionContext | undefined = runtime.context
): string | undefined {
  if (!name) {
    return undefined;
  }
  const own = /^builtin\/([a-z0-9-]+)$/.exec(name);
  if (own) {
    const candidates = context
      ? [
          path.join(bundledSoundsDir(context), `${own[1]}.wav`),
          path.join(context.extensionPath, "assets", "sounds", `${own[1]}.wav`),
        ]
      : [];
    return candidates.find((f) => fs.existsSync(f));
  }
  if (path.isAbsolute(name)) {
    return fs.existsSync(name) ? name : undefined;
  }
  const { dir, extensions } = soundLibrary();
  for (const e of extensions) {
    const full = path.join(dir, `${name}${e}`);
    if (fs.existsSync(full)) {
      return full;
    }
  }
  return undefined;
}

/**
 * On Windows, the batch file that runs the editor's own binary as node, for
 * a machine with no node of its own (most of them). Written next to the
 * hook script by syncNotifyRuntime; the hook command names it as the
 * interpreter, and cmd, PowerShell and Git Bash all run a .cmd file.
 */
export function notifyWrapperPath(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, "claude-code-tts-notify.cmd");
}

/** The interpreter for this machine, as the hook command will spell it. */
function hookInterpreter(context: vscode.ExtensionContext): string {
  const exists = (candidate: string): boolean => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  };
  const wrapper = notifyWrapperPath(context);
  return resolveNodeCommand({
    path: process.env.PATH,
    electron: process.execPath,
    platform: process.platform,
    exists,
    wrapper: process.platform === "win32" && exists(wrapper) ? wrapper : undefined,
  });
}

/**
 * Extension updates can add new hook events. When our script is already in
 * the settings (the marker that this machine has them, however they got
 * there), add any missing entries silently; never touch anything without
 * that marker.
 */
export function ensureHooksCurrent(context: vscode.ExtensionContext, cfg: NotifyConfig): void {
  const settings = loadClaudeSettings();
  const script = notifyScriptPath(context);
  // None of ours in this file, or a file we must not rewrite
  if (settings === undefined || !settingsHaveScript(settings, script)) {
    return;
  }
  const before = JSON.stringify(settings);
  const updated = applyHookNormalize(settings, script, hookPlan(cfg), hookInterpreter(context));
  if (JSON.stringify(updated) !== before) {
    saveClaudeSettings(updated);
  }
}

/**
 * The hooks this configuration needs. Silent events install no hook, so
 * Claude Code never starts a process for them, and the tools that should
 * sound are named in the matcher rather than tested after the fact.
 */
export function hookPlan(cfg: NotifyConfig): HookPlanInput {
  return { sounds: cfg.sounds ?? {}, toolFilter: cfg.toolFilter ?? [] };
}

/** Copy the hook script fresh (it may have changed with an update) and write
 *  the config file the script reads at every event. */
export function syncNotifyRuntime(
  context: vscode.ExtensionContext,
  cfg: NotifyConfig,
  onError: (m: string) => void
): void {
  try {
    fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
    fs.copyFileSync(path.join(context.extensionPath, "assets", "notify.js"), notifyScriptPath(context));
    copyBundledSounds(context);
    if (process.platform === "win32") {
      // The editor's binary is node with a flag; a batch file is what every
      // shell a hook may run under (cmd, PowerShell, Git Bash) can start.
      // Rewritten at every sync: the editor's path changes with an update.
      fs.writeFileSync(
        notifyWrapperPath(context),
        `@set ELECTRON_RUN_AS_NODE=1\r\n@"${process.execPath.replace(/"/g, "")}" %*\r\n`
      );
    }
    fs.mkdirSync(path.dirname(NOTIFY_CONFIG), { recursive: true });
    // Written for the hook script, not for this process: it runs under Claude
    // Code long after VSCode has closed, and this is how it knows whether the
    // extension that installed it still exists.
    const extensionsDir = path.dirname(context.extensionPath);
    const extensionId = path.basename(context.extensionPath).replace(/-\d+\.\d+\.\d+.*$/, "");
    fs.writeFileSync(
      NOTIFY_CONFIG,
      JSON.stringify({ ...cfg, soundsDir: bundledSoundsDir(context), extensionsDir, extensionId }, null, 2)
    );
  } catch (e) {
    onError(`notification setup failed: ${(e as Error).message}`);
  }
}

/**
 * The user's Claude Code settings: an empty object when the file does not
 * exist, undefined when it exists but is not JSON we can read. The
 * difference matters: a file that failed to parse (a byte order mark from an
 * editor on Windows, a comma too many) used to come back as {}, and the next
 * save then replaced everything the user had in it with our hooks alone.
 */
function loadClaudeSettings(): any {
  let text: string;
  try {
    text = fs.readFileSync(CLAUDE_SETTINGS, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The one reason a settings write is refused, for the person to fix. */
const UNREADABLE =
  "~/.claude/settings.json is not valid JSON, so it is left untouched; fix it and enable the sounds again";

/**
 * Written aside and renamed into place, never truncated first: this file
 * holds the user's API keys and every other Claude Code setting, and a
 * crash or a second window writing at the same moment used to be able to
 * leave it empty.
 */
function saveClaudeSettings(settings: any): void {
  // One-time backup before our first ever write.
  const backup = CLAUDE_SETTINGS + ".claude-code-tts-backup";
  if (fs.existsSync(CLAUDE_SETTINGS) && !fs.existsSync(backup)) {
    fs.copyFileSync(CLAUDE_SETTINGS, backup);
  }
  writeFileAtomicSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + "\n");
}

export function hooksInstalled(context: vscode.ExtensionContext): boolean {
  const settings = loadClaudeSettings();
  return settings !== undefined && settingsHaveScript(settings, notifyScriptPath(context));
}

/**
 * Write the hooks without asking. This is the default path: sounds are part
 * of what this extension is, and a modal on first activation about a file the
 * user has never opened teaches nothing. The one-time notice that follows
 * says what happened and offers the off switch, and uninstalling the
 * extension takes the hooks with it (assets/notify.js removes them when it
 * finds the extension gone).
 */
export function installHooksNow(context: vscode.ExtensionContext, cfg: NotifyConfig): void {
  const settings = loadClaudeSettings();
  if (settings === undefined) {
    throw new Error(UNREADABLE);
  }
  saveClaudeSettings(applyHookNormalize(settings, notifyScriptPath(context), hookPlan(cfg), hookInterpreter(context)));
}

export async function installHooks(context: vscode.ExtensionContext, cfg: NotifyConfig): Promise<boolean> {
  const consent = await vscode.window.showInformationMessage(
    "Enable notification sounds? This installs Claude Code hooks in ~/.claude/settings.json (a backup is kept, removal is one command). Sounds then play when Claude finishes or needs you - in terminal sessions too, even with VSCode closed.",
    { modal: true },
    "Install hooks"
  );
  if (consent !== "Install hooks") {
    return false;
  }
  try {
    installHooksNow(context, cfg);
  } catch (e) {
    vscode.window.showErrorMessage(`Claude Code TTS: ${(e as Error).message}`);
    return false;
  }
  return true;
}

export function removeHooks(context: vscode.ExtensionContext): void {
  const settings = loadClaudeSettings();
  if (settings !== undefined) {
    saveClaudeSettings(applyHookRemove(settings, notifyScriptPath(context)));
  }
  // The sound choices exist for the hooks; without them the file is litter.
  fs.rmSync(NOTIFY_CONFIG, { force: true });
}

/** Play a sample so enabling gives immediate feedback. */
export function demoSound(context: vscode.ExtensionContext): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded here so activation never pays for it
  const { spawn } = require("child_process") as typeof import("child_process");
  // VSCode's own Node runs the script: a GUI-launched editor often has no
  // "node" on PATH, and an unhandled spawn error would surface as an
  // extension-host exception.
  const proc = spawn(process.execPath, [notifyScriptPath(context), "stop"], {
    stdio: "ignore",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  proc.on("error", () => {});
}
