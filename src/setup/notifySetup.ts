/**
 * Completion sounds via Claude Code hooks. Independent of the speech
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

/** Absolute path of a named system sound, if it exists. */
export function soundPath(name: string): string | undefined {
  if (!name) {
    return undefined;
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

/** The interpreter for this machine, as the hook command will spell it. */
function hookInterpreter(): string {
  return resolveNodeCommand({
    path: process.env.PATH,
    electron: process.execPath,
    platform: process.platform,
    exists: (candidate) => {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    },
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
  // None of ours in this file
  if (!settingsHaveScript(settings, script)) {
    return;
  }
  const before = JSON.stringify(settings);
  const updated = applyHookNormalize(settings, script, hookPlan(cfg), hookInterpreter());
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
    fs.mkdirSync(path.dirname(NOTIFY_CONFIG), { recursive: true });
    // Written for the hook script, not for this process: it runs under Claude
    // Code long after VSCode has closed, and this is how it knows whether the
    // extension that installed it still exists.
    const extensionsDir = path.dirname(context.extensionPath);
    const extensionId = path.basename(context.extensionPath).replace(/-\d+\.\d+\.\d+.*$/, "");
    fs.writeFileSync(NOTIFY_CONFIG, JSON.stringify({ ...cfg, extensionsDir, extensionId }, null, 2));
  } catch (e) {
    onError(`notification setup failed: ${(e as Error).message}`);
  }
}

function loadClaudeSettings(): any {
  try {
    return JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, "utf8"));
  } catch {
    return {};
  }
}

function saveClaudeSettings(settings: any): void {
  // One-time backup before our first ever write.
  const backup = CLAUDE_SETTINGS + ".claude-code-tts-backup";
  if (fs.existsSync(CLAUDE_SETTINGS) && !fs.existsSync(backup)) {
    fs.copyFileSync(CLAUDE_SETTINGS, backup);
  }
  fs.mkdirSync(path.dirname(CLAUDE_SETTINGS), { recursive: true });
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + "\n");
}

export function hooksInstalled(context: vscode.ExtensionContext): boolean {
  return settingsHaveScript(loadClaudeSettings(), notifyScriptPath(context));
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
  saveClaudeSettings(
    applyHookNormalize(loadClaudeSettings(), notifyScriptPath(context), hookPlan(cfg), hookInterpreter())
  );
}

export async function installHooks(context: vscode.ExtensionContext, cfg: NotifyConfig): Promise<boolean> {
  const consent = await vscode.window.showInformationMessage(
    "Enable completion sounds? This installs Claude Code hooks in ~/.claude/settings.json (a backup is kept, removal is one command). Sounds then play when Claude finishes or needs you - in terminal sessions too, even with VSCode closed.",
    { modal: true },
    "Install hooks"
  );
  if (consent !== "Install hooks") {
    return false;
  }
  installHooksNow(context, cfg);
  return true;
}

export function removeHooks(context: vscode.ExtensionContext): void {
  saveClaudeSettings(applyHookRemove(loadClaudeSettings(), notifyScriptPath(context)));
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
