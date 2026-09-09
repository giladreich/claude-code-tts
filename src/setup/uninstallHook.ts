/**
 * What the extension leaves under ~/.claude, and its removal.
 *
 * VSCode deletes an uninstalled extension's own storage on its next start,
 * but nothing it never owned: the completion-sound hook entries written into
 * ~/.claude/settings.json kept pointing at a notify script that no longer
 * existed, so every Claude Code event reported a failing hook, and the sound
 * choices and the window registry stayed behind too. package.json names this
 * file as the "vscode:uninstall" script: VSCode runs it with its own Node on
 * the start after an uninstall, with no vscode module available, so nothing
 * here may import one. "Remove Everything Claude Code TTS Added" runs the same
 * function from inside the extension, before an uninstall.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { applyHookRemove, settingsHaveScript } from "./hooks";

/** The hook entries are recognised by the script they run, wherever it lives. */
export const NOTIFY_SCRIPT_NAME = "claude-code-tts-notify.js";

/**
 * Remove our entries from ~/.claude, leaving everything else as it was.
 * Returns a line per thing removed, for a log or a message. The settings
 * backup this extension made before its first hook edit
 * (settings.json.claude-code-tts-backup) is deliberately kept: it is the user's
 * record, not ours.
 */
export function cleanClaudeDirectory(home = os.homedir(), keepWindowRegistry = false): string[] {
  const claude = path.join(home, ".claude");
  const removed: string[] = [];
  const settingsFile = path.join(claude, "settings.json");
  try {
    const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    if (settingsHaveScript(settings, NOTIFY_SCRIPT_NAME)) {
      fs.writeFileSync(settingsFile, JSON.stringify(applyHookRemove(settings, NOTIFY_SCRIPT_NAME), null, 2) + "\n");
      removed.push("the completion-sound hooks in ~/.claude/settings.json");
    }
  } catch {
    // No settings file, or one this code cannot parse: not ours to rewrite.
  }
  const files: [string, string][] = [
    ["claude-code-tts-notify.json", "the sound choices (~/.claude/claude-code-tts-notify.json)"],
  ];
  if (!keepWindowRegistry) {
    files.push(["claude-code-tts-windows", "the window registry (~/.claude/claude-code-tts-windows)"]);
  }
  for (const [name, what] of files) {
    const target = path.join(claude, name);
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
      removed.push(what);
    }
  }
  return removed;
}

if (require.main === module) {
  const removed = cleanClaudeDirectory();
  console.log(
    removed.length ? `Claude Code TTS removed ${removed.join(", ")}` : "Claude Code TTS left nothing under ~/.claude"
  );
}
